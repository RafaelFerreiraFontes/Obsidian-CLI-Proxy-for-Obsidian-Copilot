import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildServer } from '../src/index.js';
import { readConfig, authenticate, executionContext } from '../src/config.js';
import { AgyDecoder } from '../src/providers/agy-runner.js';
import { createAgyMcpBridge, MCP_SERVER_NAME } from '../src/providers/agy-mcp-bridge.js';
import type { RunOptions } from '../src/providers/base.js';
import { mcpPeer, fixtureProcessWitness } from './mcp-client.js';
import { TEST_KEY } from './helpers.js';
import { ProxyError } from '../src/types.js';
import type { ProcessWitness } from '../src/providers/agy-process-witness.js';
import { setTimeout as delay } from 'node:timers/promises';

// These are protocol fixtures with explicit test decisions, not human/native evidence.
const tool = { type: 'function' as const, function: { name: 'echo_fixture', parameters: { type: 'object', properties: {}, additionalProperties: false } } };
for (const same of [true, false]) for (const stream of [false, true]) test(`HTTP/MCP fixture keeps concurrent approval and result sessions separate (${same ? 'same' : 'different'} workspace, ${stream ? 'SSE' : 'JSON'})`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'agy-stage24-test-'));
  const one = join(root, 'one'), two = same ? one : join(root, 'two'); await mkdir(one); if (!same) await mkdir(two);
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = readConfig({ PROXY_CLIENTS: JSON.stringify({ A: { key: TEST_KEY + 'A', workspaces: ['A','B'], profiles: ['agy'] }, B: { key: TEST_KEY + 'B', workspaces: ['A','B'], profiles: ['agy'] } }), PROXY_WORKSPACES: JSON.stringify({ A: one, B: two }) });
  config.profiles.agy!.tools = 'client'; // Production parser still refuses this.
  const events: Record<string, unknown>[] = [], mcpResults: Record<string, string> = {};
  const runner = { clientToolsReady: true, phasedTimeouts: true, async *run(options: RunOptions) {
    const bridge = await createAgyMcpBridge(options, () => {}, e => events.push(e), undefined, fixtureProcessWitness);
    try {
      const cid = randomUUID(); bridge.bindProcess(process.pid); bridge.bindNative(cid, options.context!.workspaceRoot);
      const peer = mcpPeer(bridge.env, options.context!.workspaceRoot, cid); await peer.attach();
      const input = { conversationId: cid, workspacePaths: [options.context!.workspaceRoot], toolCall: { name: 'call_mcp_tool', args: { ServerName: MCP_SERVER_NAME, ToolName: 'echo_fixture', Arguments: {} } } };
      const approved = await options.onApproval!({ action: 'echo_fixture({})', cwd: options.context!.workspaceRoot });
      bridge.recordDecision(input, approved);
      if (!approved) { yield 'DENIED'; return; }
      const response = await peer.post('call', { requestId: randomUUID(), name: 'echo_fixture', arguments: {} }); assert.equal(response.status, 200);
      const text = (await response.json() as any).content[0].text;
      mcpResults[options.context!.identity] = text;
      yield text;
    } finally { await bridge.close(); }
  } };
  const app = await buildServer({ logger: false, config, providers: { agy: runner, codex: { async *run() { throw Error('No fallback'); } } } }); t.after(() => app.close());
  const post = (label: string, body: any, workspace = label) => app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${TEST_KEY + label}`, 'x-proxy-workspace': workspace, 'x-proxy-profile': 'agy' }, payload: body });
  const bodies = ['A','B'].map(label => ({ model: 'agy/default', conversation_id: label, tools: [tool], messages: [{ role: 'user', content: 'fixture' }] }));
  const initial = await Promise.all(bodies.map((body, i) => post(i ? 'B' : 'A', body)));
  const approvals = initial.map(response => { assert.equal(response.statusCode, 200); return response.json().choices[0].message; });
  const continued = bodies.map((body, i) => ({ ...body, stream, messages: [...body.messages, approvals[i], { role: 'user', content: 'aprovar' }] }));
  // Adversarial attempts must not consume either real pending test decision.
  assert.equal((await post('B', continued[0], 'A')).statusCode, 409);
  const pending = await Promise.all(continued.map((body, i) => post(i ? 'B' : 'A', body)));
  const assistants = pending.map(response => {
    assert.equal(response.statusCode, 200, response.body);
    if (!stream) { const value = response.json(); assert.equal(value.choices[0].finish_reason, 'tool_calls'); return value.choices[0].message; }
    const chunks = response.body.split('\n\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
    assert.ok(chunks.some(chunk => chunk.choices[0].finish_reason === 'tool_calls'));
    const call = chunks.flatMap(chunk => chunk.choices[0].delta.tool_calls ?? [])[0]; return { role: 'assistant', tool_calls: [call] };
  });
  const replies = continued.map((body, i) => ({ ...body, messages: [...body.messages, assistants[i], { role: 'tool', tool_call_id: assistants[i].tool_calls[0].id, content: i ? 'SESSION_B_RESULT' : 'SESSION_A_RESULT' }] }));
  assert.notEqual(assistants[0].tool_calls[0].id, assistants[1].tool_calls[0].id);
  assert.equal((await post('B', replies[0], 'A')).statusCode, 410);
  assert.equal((await post('A', { ...replies[0], model: 'agy/other' })).statusCode, 410);
  assert.equal((await post('A', replies[0], 'B')).statusCode, 409);
  assert.equal((await post('A', continued[0])).statusCode, 409);
  const finals = await Promise.all(replies.map((body, i) => post(i ? 'B' : 'A', body)));
  for (const [i, final] of finals.entries()) { assert.equal(final.statusCode, 200); assert.match(final.body, new RegExp(i ? 'SESSION_B_RESULT' : 'SESSION_A_RESULT')); assert.ok(!final.body.includes(i ? 'SESSION_A_RESULT' : 'SESSION_B_RESULT')); }
  assert.deepEqual(mcpResults, { 'client:A': 'SESSION_A_RESULT', 'client:B': 'SESSION_B_RESULT' });
  assert.equal((await post('A', replies[0])).statusCode, 410); assert.equal((await post('B', replies[1])).statusCode, 410);
  const calls = events.filter(event => event.event === 'mcp_tool_pending'); assert.equal(calls.length, 2);
  for (const field of ['sessionHash','openaiSessionHash','conversationHash','peerHash','leaseHash']) assert.notEqual(calls[0]![field], calls[1]![field]);
  assert.ok(!JSON.stringify(events).includes('SESSION_A_RESULT')); assert.ok(!JSON.stringify(events).includes(TEST_KEY));
});

test('native decoder audit exposes tool inventory and status without prompts, arguments or result text', () => {
  const events: Record<string, unknown>[] = [], decoder = new AgyDecoder(undefined, event => events.push(event));
  decoder.push(JSON.stringify({ event: 'init', conversation_id: 'private-conversation', init: { cwd: 'private-root', tools: ['read_file','call_mcp_tool','private secret', { name: 'untrusted' }] }, prompt: 'private-prompt' }) + '\n');
  decoder.push(JSON.stringify({ event: 'step_update', step_update: { step_type: 'tool', state: 'ERROR', args: { secret: 'private-argument' } } }) + '\n');
  decoder.push(JSON.stringify({ event: 'step_update', step_update: { step_type: 'tool', state: 'private-unexpected-state' } }) + '\n');
  decoder.push(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'private-result' } }) + '\n');
  assert.deepEqual(events, [{ event: 'agy_native_tools', tools: ['read_file','call_mcp_tool'] }, { event: 'agy_native_tool_state', state: 'ERROR' }, { event: 'agy_native_tool_state', state: null }, { event: 'agy_native_result', status: 'SUCCESS' }]);
  assert.ok(!JSON.stringify(events).includes('private'));
});

async function scoped(t: TestContext, change?: (options: RunOptions) => void, witness = fixtureProcessWitness) {
  const root = await mkdtemp(join(tmpdir(), 'agy-stage24-binding-'));
  const config = readConfig({ PROXY_API_KEY: TEST_KEY, PROXY_WORKSPACES: JSON.stringify({ fixture: root }), PROXY_DEFAULT_WORKSPACE: 'fixture' });
  const context = executionContext(config, authenticate(config, `Bearer ${TEST_KEY}`), 'fixture', 'agy', 'agy/default');
  const controller = new AbortController(), cid = randomUUID(), events: Record<string, unknown>[] = [];
  let calls = 0;
  const options: RunOptions = { sessionId: randomUUID(), context, model: 'default', prompt: '', signal: controller.signal, tools: [tool], onToolCall: async () => { calls++; return 'FIXTURE_RESULT'; } };
  change?.(options);
  const bridge = await createAgyMcpBridge(options, () => {}, event => events.push(event), undefined, witness);
  bridge.bindProcess(process.pid); bridge.bindNative(cid, root);
  t.after(async () => { controller.abort(); await bridge.close(); await rm(root, { recursive: true, force: true }); });
  const peer = mcpPeer(bridge.env, root, cid); await peer.attach();
  bridge.recordDecision({ conversationId: cid, workspacePaths: [root], toolCall: { name: 'call_mcp_tool', args: { ServerName: MCP_SERVER_NAME, ToolName: 'echo_fixture', Arguments: {} } } }, true);
  const call = (overrides = {}) => peer.post('call', { name: 'echo_fixture', arguments: {}, requestId: randomUUID(), ...overrides });
  return { bridge, peer, cid, events, call, calls: () => calls, options };
}

test('tools/call requires native conversation AND root identity even with valid process, lease and approval', async t => {
  const s = await scoped(t);
  for (const overrides of [
    { nativeConversationId: undefined }, { nativeRootConversationId: undefined },
    { nativeConversationId: randomUUID() }, { nativeRootConversationId: randomUUID() },
    { nativeConversationId: [s.cid] }, { nativeRootConversationId: 1 },
  ]) { assert.equal((await s.call(overrides)).status, 409); assert.equal(s.calls(), 0); }
  assert.equal((await s.call()).status, 200); assert.equal(s.calls(), 1);
  const resolved = s.events.find(event => event.event === 'mcp_tool_resolved')!;
  assert.equal(resolved.nativeConversationHash, resolved.conversationHash); assert.equal(resolved.nativeRootConversationHash, resolved.conversationHash);
  assert.equal((await s.call()).status, 409);
});

test('same-process workers cannot substitute another native session in tools/call metadata', async t => {
  const a = await scoped(t), b = await scoped(t);
  assert.equal((await a.call({ nativeConversationId: b.cid, nativeRootConversationId: b.cid })).status, 409);
  assert.equal(a.calls(), 0); assert.equal(b.calls(), 0);
  assert.equal((await a.call()).status, 200); assert.equal((await b.call()).status, 200);
});

test('failed post-result OS witness never publishes output and reports only a sanitized reason', async t => {
  let outputReturned = false;
  const witness: ProcessWitness = async () => async () => { if (outputReturned) throw new ProxyError('private-process-diagnostic', 503, 'mcp_process_unverified'); };
  const s = await scoped(t, options => { options.onToolCall = async () => { outputReturned = true; return 'private-client-result'; }; }, witness);
  assert.equal((await s.call()).status, 409);
  assert.ok(!s.events.some(event => event.event === 'mcp_tool_resolved'));
  assert.ok(s.events.some(event => event.event === 'mcp_action_rejected' && event.stage === 'process-after' && event.code === 'mcp_process_unverified'));
  assert.ok(!JSON.stringify(s.events).includes('private'));
  assert.equal((await s.call()).status, 409);
});

test('peer disconnect during post-result process verification cannot publish a resolved MCP event', async t => {
  let outputReturned = false, release: (() => void) | undefined;
  const witness: ProcessWitness = async () => async () => { if (outputReturned) await new Promise<void>(resolve => { release = resolve; }); };
  const s = await scoped(t, options => { options.onToolCall = async () => { outputReturned = true; return 'DISCONNECTED_RESULT'; }; }, witness);
  const connection = new AbortController();
  const pending = s.peer.post('call', { name: 'echo_fixture', arguments: {}, requestId: randomUUID() }, s.bridge.env.CLI_PROXY_MCP_TOKEN, connection.signal).catch(() => undefined);
  while (!release) await delay(1);
  connection.abort(); await pending; await delay(20); release(); await delay(20);
  assert.ok(!s.events.some(event => event.event === 'mcp_tool_resolved'));
  assert.equal((await s.call()).status, 409);
});

for (const field of ['model','workspace']) test(`changing ${field} after a client result revokes the MCP invocation`, async t => {
  const s = await scoped(t, options => { options.onToolCall = async () => { if (field === 'model') options.model = 'other'; else options.context!.workspaceId = 'other'; return 'STALE_RESULT'; }; });
  assert.equal((await s.call()).status, 409); assert.equal((await s.call()).status, 409);
  assert.ok(!s.events.some(event => event.event === 'mcp_tool_resolved'));
});

for (const stream of [false,true]) test(`continuation deadline after role:tool fails without successful stop (${stream ? 'SSE' : 'JSON'} fixture)`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'agy-stage24-continuation-')); t.after(() => rm(root, { recursive: true, force: true }));
  const config = readConfig({ PROXY_API_KEY: TEST_KEY, PROXY_WORKSPACES: JSON.stringify({ fixture: root }), PROXY_DEFAULT_WORKSPACE: 'fixture', CLI_TIMEOUT_MS: '40' });
  let received = '';
  const runner = { phasedTimeouts: true, async *run(options: RunOptions) {
    received = await options.onToolCall!({ id: 'fixture-only', type: 'function', function: { name: 'echo_fixture', arguments: '{}' } });
    options.onPhase?.('active');
    await new Promise((_, reject) => { const abort = () => reject(options.signal.reason); options.signal.addEventListener('abort', abort, { once: true }); if (options.signal.aborted) abort(); });
    yield 'UNREACHABLE_SUCCESS';
  } };
  const app = await buildServer({ logger: false, config, providers: { codex: runner, agy: { async *run() { throw Error('Not used'); } } } }); t.after(() => app.close());
  const post = (body: any) => app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${TEST_KEY}` }, payload: body });
  const body = { model: 'codex/default', tools: [tool], messages: [{ role: 'user', content: 'fixture' }] };
  const assistant = (await post(body)).json().choices[0].message;
  const final = await post({ ...body, stream, messages: [...body.messages, assistant, { role: 'tool', tool_call_id: assistant.tool_calls[0].id, content: 'FIXTURE_RESULT' }] });
  assert.equal(received, 'FIXTURE_RESULT'); assert.match(final.body, /cli_timeout/); assert.ok(!final.body.includes('UNREACHABLE_SUCCESS')); assert.ok(!final.body.includes('"finish_reason":"stop"'));
  assert.equal((await app.inject('/health')).json().active_sessions, 0);
});

for (const same of [true,false]) for (const fault of ['restart','orphan','cancel','unregistered']) test(`two authenticated MCP fixtures isolate ${fault} (${same ? 'same' : 'different'} workspace)`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'agy-stage24-faults-')), one = join(root, 'one'), two = same ? one : join(root, 'two');
  await mkdir(one); if (!same) await mkdir(two); t.after(() => rm(root, { recursive: true, force: true }));
  const config = readConfig({ PROXY_CLIENTS: JSON.stringify({ A: { key: TEST_KEY + 'A', workspaces: ['A'], profiles: ['agy'] }, B: { key: TEST_KEY + 'B', workspaces: ['B'], profiles: ['agy'] } }), PROXY_WORKSPACES: JSON.stringify({ A: one, B: two }) });
  let releaseA: ((value: string) => void) | undefined, aCalls = 0;
  const make = async (label: 'A'|'B') => {
    const context = executionContext(config, authenticate(config, `Bearer ${TEST_KEY + label}`), label, 'agy', 'agy/default');
    const controller = new AbortController(), cid = randomUUID(), events: Record<string, unknown>[] = [];
    const options: RunOptions = { sessionId: randomUUID(), context, model: 'default', prompt: '', signal: controller.signal, tools: [tool], onToolCall: async () => {
      if (label === 'B') return 'SESSION_B_RESULT'; aCalls++; return new Promise<string>(resolve => { releaseA = resolve; });
    } };
    const bridge = await createAgyMcpBridge(options, () => {}, event => events.push(event), undefined, fixtureProcessWitness);
    bridge.bindProcess(process.pid); bridge.bindNative(cid, context.workspaceRoot);
    const peer = mcpPeer(bridge.env, context.workspaceRoot, cid); await peer.attach();
    t.after(async () => { controller.abort(); await bridge.close(); });
    const admit = () => bridge.recordDecision({ conversationId: cid, workspacePaths: [context.workspaceRoot], toolCall: { name: 'call_mcp_tool', args: { ServerName: MCP_SERVER_NAME, ToolName: 'echo_fixture', Arguments: {} } } }, true);
    const call = (name = 'echo_fixture') => peer.post('call', { requestId: randomUUID(), name, arguments: {} });
    return { bridge, peer, controller, cid, context, events, admit, call };
  };
  const [a,b] = await Promise.all([make('A'),make('B')]);
  assert.notEqual(a.context.identity, b.context.identity); a.admit();
  if (fault === 'unregistered') { assert.equal((await a.call('not_registered')).status, 409); assert.equal(aCalls, 0); }
  const aPending = a.call(); while (!releaseA) await delay(1);
  if (fault === 'restart') await assert.rejects(mcpPeer(a.bridge.env, a.context.workspaceRoot, a.cid).attach());
  if (fault === 'orphan') { assert.throws(() => a.bridge.assertIdle(), { code: 'mcp_orphaned_call' }); assert.equal((await a.peer.post('detach')).status, 200); }
  if (fault === 'cancel') a.controller.abort(new Error('Fixture cancels A only'));
  if (fault === 'unregistered') { releaseA('SESSION_A_RESULT'); assert.equal((await (await aPending).json() as any).content[0].text, 'SESSION_A_RESULT'); }
  else { assert.equal((await aPending).status, 409); releaseA('LATE_SESSION_A_RESULT'); assert.equal((await a.call()).status, 409); }
  b.admit(); assert.equal((await (await b.call()).json() as any).content[0].text, 'SESSION_B_RESULT');
  assert.equal(aCalls, 1); assert.equal(a.events.some(event => event.event === 'mcp_tool_resolved'), fault === 'unregistered');
  assert.equal(b.events.filter(event => event.event === 'mcp_tool_resolved').length, 1);
});
