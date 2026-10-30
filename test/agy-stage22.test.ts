import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { readConfig, executionContext, authenticate, SERVER_ROOT } from '../src/config.js';
import { AgyLifecycle, type ExecutionPhase } from '../src/providers/agy-lifecycle.js';
import { SpawnRunner, waitForShutdown, type RunOptions } from '../src/providers/base.js';
import { createAgyMcpBridge, MCP_SERVER_NAME } from '../src/providers/agy-mcp-bridge.js';
import { AgyMcpWorkspaceRegistry, MCP_LAUNCHER } from '../src/agy-mcp-workspaces.js';
import { serveMcp } from '../src/mcp-stdio.js';
import { TEST_KEY } from './helpers.js';
import { formatPrompt } from '../src/utils/prompt-formatter.js';
import type { OpenAITool } from '../src/types.js';
import { buildServer } from '../src/index.js';
import { AgyDecoder } from '../src/providers/agy-runner.js';
import { AgyRunner } from '../src/providers/agy-runner.js';
import { AgyWorkspaceRegistry } from '../src/agy-workspaces.js';
import { fileURLToPath } from 'node:url';
import { createAgyApprovalBridge } from '../src/providers/agy-approval-bridge.js';
import { mcpPeer, fixtureProcessWitness } from './mcp-client.js';

const tools: OpenAITool[] = [{ type: 'function', function: { name: 'echo_fixture', description: 'Echo fixture', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } } }];
async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'agy-stage22-test-'));
  const workspace = join(root, 'space and Unicode 世界'); await mkdir(workspace);
  const config = readConfig({ PROXY_API_KEY: TEST_KEY, PROXY_WORKSPACES: JSON.stringify({ fixture: workspace }), PROXY_DEFAULT_WORKSPACE: 'fixture' });
  const context = executionContext(config, authenticate(config, `Bearer ${TEST_KEY}`), 'fixture', 'agy', 'agy/default');
  const controller = new AbortController();
  const options: RunOptions = { sessionId: randomUUID(), context, model: 'default', prompt: '', signal: controller.signal, tools, onToolCall: async call => JSON.parse(call.function.arguments).value };
  t.after(async () => { controller.abort(); await rm(root, { recursive: true, force: true }); });
  return { root, workspace, context, controller, options };
}
async function bridge(t: TestContext, change?: (options: RunOptions) => void) {
  const s = await setup(t); change?.(s.options);
  const events: Record<string, unknown>[] = [];
  const b = await createAgyMcpBridge(s.options, () => {}, event => events.push(event), undefined, fixtureProcessWitness);
  b.bindProcess(process.pid);
  t.after(() => b.close());
  const conversation = randomUUID();
  const peer = mcpPeer(b.env, s.workspace, conversation), post = peer.post;
  const grant = async (value: string) => { await peer.attach(); b.recordDecision({ conversationId: conversation, workspacePaths: [s.workspace], toolCall: { name: 'call_mcp_tool', args: { ServerName: MCP_SERVER_NAME, ToolName: 'echo_fixture', Arguments: { value } } } }, true); };
  return { ...s, b, conversation, post, events, grant };
}

for (const [phase, code] of Object.entries({ spawning: 'cli_spawn_timeout', initializing: 'cli_init_timeout', attesting: 'approval_attestation_timeout', active: 'cli_timeout', waiting_approval: 'approval_timeout', waiting_tool: 'tool_timeout' })) {
  test(`independent ${phase} deadline reports ${code}`, async () => {
    const failures: string[] = [];
    const clock = new AgyLifecycle({ spawnTimeoutMs: 10, initTimeoutMs: 10, attestationTimeoutMs: 10, timeoutMs: 10, approvalTimeoutMs: 10, toolTimeoutMs: 10 }, e => failures.push(e.code));
    clock.phase(phase as ExecutionPhase); await delay(30); clock.close();
    assert.deepEqual(failures, [code]);
  });
}
test('attestation and human wait do not consume the active inference deadline; closing cancels timers', async () => {
  const failures: string[] = [], phases: string[] = [];
  const clock = new AgyLifecycle({ timeoutMs: 10, attestationTimeoutMs: 200, approvalTimeoutMs: 200 }, e => failures.push(e.code), p => phases.push(p));
  clock.init(); await delay(30); assert.deepEqual(failures, []);
  clock.ready(); clock.phase('waiting_approval'); await delay(30); assert.deepEqual(failures, []);
  clock.phase('active'); clock.close(); clock.ready(); await delay(30); assert.deepEqual(failures, []);
  assert.deepEqual(phases, ['attesting', 'active', 'waiting_approval', 'active']);
});
test('shutdown deadline is bounded independently of initialization', async () => {
  await assert.rejects(waitForShutdown(new Promise(() => {}), 10), { code: 'cli_shutdown_timeout' });
  assert.equal(await waitForShutdown(Promise.resolve('closed'), 10), 'closed');
});
test('cancellation remains effective after stdout closes while the child process stays alive', { timeout: 10000 }, async t => {
  const s = await setup(t), script = join(s.root, 'close-stdout.mjs'), marker = join(s.root, 'stdout-closed');
  await writeFile(script, `import {writeFileSync} from 'node:fs';process.stdout.end(()=>writeFileSync(${JSON.stringify(marker)},'closed'));setInterval(()=>{},1000);`);
  class Runner extends SpawnRunner { protected command() { return { executable: process.execPath, args: [script], input: '' }; } }
  const job = (async () => { for await (const _ of new Runner().run(s.options)) {} })();
  const stopped = assert.rejects(job, /cancel stdout/);
  for (let i = 0; i < 200 && !existsSync(marker); i++) await delay(5);
  assert.equal(existsSync(marker), true); await delay(10);
  s.controller.abort(new Error('cancel stdout')); await stopped;
});
test('profile deadlines reject zero and excessive values', () => {
  for (const [key, value] of [['AGY_ATTESTATION_TIMEOUT_MS', '600001'], ['CLI_SPAWN_TIMEOUT_MS', '0'], ['CLI_SHUTDOWN_TIMEOUT_MS', '30001'], ['TOOL_TIMEOUT_MS', '580001']]) assert.throws(() => readConfig({ [key!]: value }));
});
test('phase-aware decoding rejects responses before init and duplicate native init', async () => {
  const decoder = new AgyDecoder(async () => {});
  assert.throws(() => decoder.push('{"event":"result","result":{"status":"SUCCESS","response":"unsafe"}}\n'), { code: 'cli_protocol_error' });
  const init = JSON.stringify({ event: 'init', conversation_id: randomUUID(), init: { cwd: SERVER_ROOT } }) + '\n';
  decoder.push(init); await decoder.beforeOutput();
  assert.throws(() => decoder.push(init), { code: 'cli_protocol_error' });
});

test('MCP registration needs separate current consent and preserves original third-party bytes', async t => {
  const s = await setup(t), directory = join(s.workspace, '.agents'); await mkdir(directory);
  const file = join(directory, 'mcp_config.json'), original = '\uFEFF{\r\n "mcpServers":{"third":{"command":"third.exe"}},"other":true\r\n}\r\n';
  await writeFile(file, original);
  const registry = new AgyMcpWorkspaceRegistry(join(s.root, 'private'), join(SERVER_ROOT, 'dist/mcp-stdio.js'));
  const plan = registry.planInstall(s.context);
  await assert.rejects(registry.install(s.context, 'wrong'), { code: 'operator_consent_required' });
  assert.equal(await readFile(file, 'utf8'), original);
  await registry.install(s.context, plan.consent); registry.verify(s.context);
  const installed = await readFile(file, 'utf8'); assert.ok(!installed.includes(TEST_KEY)); assert.ok(!installed.includes('TOKEN'));
  assert.deepEqual(JSON.parse(installed).mcpServers.third, { command: 'third.exe' });
  assert.ok(Array.isArray(JSON.parse(installed).mcpServers[MCP_SERVER_NAME].args));
  await registry.remove(s.context, registry.planRemove(s.context).consent);
  assert.equal(await readFile(file, 'utf8'), original); assert.equal(existsSync(join(directory, MCP_LAUNCHER)), false);
});
test('MCP registration detects conflicts, integrity changes, and retains later third-party additions on removal', async t => {
  const s = await setup(t), registry = new AgyMcpWorkspaceRegistry(join(s.root, 'private'));
  await registry.install(s.context, registry.planInstall(s.context).consent);
  const file = join(s.workspace, '.agents/mcp_config.json'), value = JSON.parse(await readFile(file, 'utf8'));
  value.mcpServers.later = { command: 'later.exe' }; await writeFile(file, JSON.stringify(value));
  assert.throws(() => registry.verify(s.context));
  await assert.rejects(registry.install(s.context, 'anything'));
  await registry.remove(s.context, registry.planRemove(s.context).consent);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).mcpServers, { later: { command: 'later.exe' } });
  await writeFile(file, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { command: 'other.exe' } } }));
  assert.throws(() => registry.planInstall(s.context), /Conflicting/);
});
test('MCP registration rejects redirected directories and changed launchers during removal', async t => {
  const s = await setup(t), registry = new AgyMcpWorkspaceRegistry(join(s.root, 'private'));
  const outside = join(s.root, 'outside'); await mkdir(outside);
  await symlink(outside, join(s.workspace, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => registry.planInstall(s.context), /canonical/);
  await rm(join(s.workspace, '.agents')); await registry.install(s.context, registry.planInstall(s.context).consent);
  await writeFile(join(s.workspace, '.agents', MCP_LAUNCHER), '// changed');
  assert.throws(() => registry.verify(s.context)); assert.throws(() => registry.planRemove(s.context));
});
test('MCP list is authenticated, workspace-bound, unavailable before native init, and schemas are preserved', async t => {
  const s = await bridge(t, options => { options.context!.profile.initTimeoutMs = 20; });
  assert.equal((await s.post('list')).status, 409);
  s.b.bindNative(s.conversation, s.workspace);
  assert.equal((await s.post('list', {}, 'wrong')).status, 403);
  assert.equal((await s.post('list', { workspace: s.root })).status, 409);
  assert.deepEqual((await (await s.post('list')).json()).tools[0].inputSchema, tools[0]!.function.parameters);
  assert.throws(() => s.b.bindNative(randomUUID(), s.workspace));
});
test('MCP calls validate arguments, forward structured results, exclude reserved approval, and reject replay', async t => {
  const s = await bridge(t, o => { o.tools = [...tools, { type: 'function', function: { name: 'proxy_approve_action', parameters: { type: 'object' } } }]; });
  s.b.bindNative(s.conversation, s.workspace);
  const requestId = randomUUID();
  assert.equal((await s.post('call', { requestId: '-'.repeat(36), name: 'echo_fixture', arguments: { value: 'bad ID' } })).status, 409);
  assert.equal((await s.post('call', { requestId, name: 'echo_fixture', arguments: { value: 12 } })).status, 409);
  assert.equal((await s.post('call', { requestId, name: 'proxy_approve_action', arguments: {} })).status, 409);
  await s.grant('fixture result');
  const response = await s.post('call', { requestId, name: 'echo_fixture', arguments: { value: 'fixture result' } });
  assert.deepEqual(await response.json(), { content: [{ type: 'text', text: 'fixture result' }], isError: false });
  assert.equal((await s.post('call', { requestId, name: 'echo_fixture', arguments: { value: 'again' } })).status, 409);
  assert.ok(!JSON.stringify(s.events).includes('fixture result'));
});
test('MCP sessions cannot share credentials, catalogs, workspaces, or an outstanding action', async t => {
  let release!: (value: string) => void;
  const a = await bridge(t, o => { o.onToolCall = () => new Promise(resolve => { release = resolve; }); });
  const b = await bridge(t); a.b.bindNative(a.conversation, a.workspace); b.b.bindNative(b.conversation, b.workspace);
  assert.equal((await a.post('list', {}, b.b.env.CLI_PROXY_MCP_TOKEN)).status, 403);
  assert.equal((await a.post('list', { sessionId: b.b.env.CLI_PROXY_MCP_SESSION })).status, 409);
  await a.grant('one');
  const first = a.post('call', { requestId: randomUUID(), name: 'echo_fixture', arguments: { value: 'one' } });
  while (!release) await delay(1);
  assert.equal((await a.post('call', { requestId: randomUUID(), name: 'echo_fixture', arguments: { value: 'two' } })).status, 409);
  await b.grant('separate'); const independent = await b.post('call', { requestId: randomUUID(), name: 'echo_fixture', arguments: { value: 'separate' } }); assert.equal(independent.status, 200);
  release('one'); assert.equal((await first).status, 200);
});
test('MCP timeout and cancellation reject a pending call without awaiting an unresponsive client', async t => {
  const a = await bridge(t, o => { o.context!.profile.toolTimeoutMs = 20; o.onToolCall = () => new Promise(() => {}); });
  a.b.bindNative(a.conversation, a.workspace);
  await a.grant('timeout');
  assert.equal((await a.post('call', { requestId: randomUUID(), name: 'echo_fixture', arguments: { value: 'timeout' } })).status, 409);
  const b = await bridge(t, o => { o.onToolCall = () => new Promise(() => {}); }); b.b.bindNative(b.conversation, b.workspace);
  await b.grant('cancel'); const pending = b.post('call', { requestId: randomUUID(), name: 'echo_fixture', arguments: { value: 'cancel' } });
  await delay(10); b.controller.abort(); assert.equal((await pending).status, 409);
});
test('MCP integrity failure denies calls and a lost peer cancels the pending session', async t => {
  const s = await setup(t); let intact = true, fatal = false, started = false;
  s.options.onToolCall = () => { started = true; return new Promise(() => {}); };
  const b = await createAgyMcpBridge(s.options, () => { if (!intact) throw Error('Integrity failure'); }, undefined, () => { fatal = true; }, fixtureProcessWitness); t.after(() => b.close());
  b.bindProcess(process.pid);
  const conversation = randomUUID(); b.bindNative(conversation, s.workspace);
  const peer = mcpPeer(b.env, s.workspace, conversation); await peer.attach();
  b.recordDecision({ conversationId: conversation, workspacePaths: [s.workspace], toolCall: { name: 'call_mcp_tool', args: { ServerName: MCP_SERVER_NAME, ToolName: 'echo_fixture', Arguments: { value: 'fixture' } } } }, true);
  const post = (signal?: AbortSignal) => peer.post('call', { requestId: randomUUID(), name: 'echo_fixture', arguments: { value: 'fixture' } }, b.env.CLI_PROXY_MCP_TOKEN, signal);
  intact = false; assert.equal((await post()).status, 409); assert.equal(started, false); intact = true;
  const connection = new AbortController(), request = post(connection.signal).catch(() => undefined);
  while (!started) await delay(1); connection.abort(); await request;
  for (let i = 0; i < 100 && !fatal; i++) await delay(5); assert.equal(fatal, true);
});
test('stdio adapter performs initialize, list and call against the scoped bridge and cleans up at EOF', async t => {
  const s = await bridge(t); s.b.bindNative(s.conversation, s.workspace);
  const input = new PassThrough(), output = new PassThrough(); let raw = '';
  output.on('data', chunk => { raw += chunk; });
  const job = serveMcp(input, output, { ...s.b.env, CLI_PROXY_MCP_WORKSPACE: s.workspace });
  const send = (id: number, method: string, params: unknown = {}) => input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  const wait = async (id: number) => { for (let i = 0; i < 200; i++) { const found = raw.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).find(m => m.id === id); if (found) return found; await delay(5); } throw Error('No MCP response'); };
  send(1, 'initialize', { protocolVersion: '2025-11-25' }); assert.equal((await wait(1)).result.serverInfo.name, MCP_SERVER_NAME);
  send(2, 'tools/list'); assert.equal((await wait(2)).result.tools[0].name, 'echo_fixture');
  s.b.recordDecision({ conversationId: s.conversation, workspacePaths: [s.workspace], toolCall: { name: 'call_mcp_tool', args: { ServerName: MCP_SERVER_NAME, ToolName: 'echo_fixture', Arguments: { value: 'stdio result' } } } }, true);
  send(3, 'tools/call', { name: 'echo_fixture', arguments: { value: 'stdio result' }, _meta: { 'antigravity.google/conversation_id': s.conversation, 'antigravity.google/root_conversation_id': s.conversation } }); assert.equal((await wait(3)).result.content[0].text, 'stdio result');
  input.end(); await job; assert.ok(!raw.includes(s.b.env.CLI_PROXY_MCP_TOKEN));
});
test('changing the model during a pending MCP action invalidates its result', async t => {
  let release!: (value: string) => void;
  const s = await bridge(t, o => { o.onToolCall = () => new Promise(resolve => { release = resolve; }); });
  s.b.bindNative(s.conversation, s.workspace);
  await s.grant('one'); const response = s.post('call', { requestId: randomUUID(), name: 'echo_fixture', arguments: { value: 'one' } });
  while (!release) await delay(1);
  s.options.model = 'other'; release('old result'); assert.equal((await response).status, 409);
});
test('client MCP validation cannot authorize a native action without a separate approval decision', async t => {
  const s = await setup(t); let decisions = 0, approved = false;
  const b = await createAgyApprovalBridge({ ...s.options, onApproval: async () => { decisions++; return approved; } }, () => {}, false, () => true);
  t.after(() => b.close());
  const post = async (name: string, server = MCP_SERVER_NAME) => {
    const response = await fetch(b.env.CLI_PROXY_HOOK_URL, { method: 'POST', headers: { authorization: `Bearer ${b.env.CLI_PROXY_HOOK_TOKEN}` }, body: JSON.stringify({ toolCall: { name, args: { ServerName: server, ToolName: 'echo_fixture', Arguments: { value: 'fixture' } } }, workspacePaths: [s.workspace] }) }); return response.json() as Promise<{ approved: boolean }>;
  };
  assert.equal((await post('call_mcp_tool')).approved, false); assert.equal(decisions, 1);
  approved = true; assert.equal((await post('call_mcp_tool')).approved, true); assert.equal(decisions, 2);
  assert.equal((await post('write_file')).approved, false); assert.equal(decisions, 2);
  assert.equal((await post('call_mcp_tool', 'foreign-server')).approved, false); assert.equal(decisions, 2);
});
for (const stream of [false, true]) test(`fixture MCP -> AgentSession -> OpenAI ${stream ? 'SSE' : 'JSON'} tool_calls -> role:tool -> MCP result`, async t => {
  const s = await setup(t);
  const config = readConfig({ PROXY_API_KEY: TEST_KEY, PROXY_WORKSPACES: JSON.stringify({ fixture: s.workspace }), PROXY_DEFAULT_WORKSPACE: 'fixture' });
  // Uses an injectable Codex test adapter to exercise the existing HTTP contract.
  // Production AGY guards are deliberately unchanged; this is not a native AGY test.
  let mcpResult = '';
  const adapter = { async *run(options: RunOptions) {
    const b = await createAgyMcpBridge(options, () => {}, undefined, undefined, fixtureProcessWitness);
    try {
      b.bindProcess(process.pid);
      const conversation = randomUUID(); b.bindNative(conversation, s.workspace);
      const peer = mcpPeer(b.env, s.workspace, conversation); await peer.attach();
      b.recordDecision({ conversationId: conversation, workspacePaths: [s.workspace], toolCall: { name: 'call_mcp_tool', args: { ServerName: MCP_SERVER_NAME, ToolName: 'echo_fixture', Arguments: { value: 'request from fixture MCP' } } } }, true);
      const response = await peer.post('call', { requestId: randomUUID(), name: 'echo_fixture', arguments: { value: 'request from fixture MCP' } });
      assert.equal(response.status, 200); const result: any = await response.json();
      mcpResult = result.content[0].text; yield `Continued with ${mcpResult}`;
    } finally { await b.close(); }
  } };
  const app = await buildServer({ logger: false, config, providers: { codex: adapter, agy: { async *run() { throw Error('AGY remains gated'); } } } }); t.after(() => app.close());
  const post = (body: Record<string, unknown>) => app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${TEST_KEY}` }, payload: body });
  const body = { model: 'codex/default', tools, messages: [{ role: 'user', content: 'Fixture structured forwarding' }], stream };
  const first = await post(body); assert.equal(first.statusCode, 200);
  let assistant: any;
  if (!stream) { const value = first.json(); assert.equal(value.choices[0].finish_reason, 'tool_calls'); assistant = value.choices[0].message; }
  else {
    const events = first.body.split('\n\n').filter(x => x.startsWith('data: {')).map(x => JSON.parse(x.slice(6)));
    assert.ok(events.some(x => x.choices?.[0].finish_reason === 'tool_calls'));
    const call = events.flatMap(x => x.choices?.[0].delta.tool_calls ?? [])[0];
    assistant = { role: 'assistant', tool_calls: [{ id: call.id, type: 'function', function: call.function }] };
  }
  const call = assistant.tool_calls[0]; assert.equal(call.function.name, 'echo_fixture');
  const continuation = { ...body, messages: [...body.messages, assistant, { role: 'tool', tool_call_id: call.id, content: 'CLIENT_EXACT_RESULT' }] };
  assert.equal((await post({ ...continuation, model: 'codex/other' })).statusCode, 410);
  const final = await post(continuation); assert.equal(final.statusCode, 200); assert.match(final.body, /Continued with CLIENT_EXACT_RESULT/);
  assert.equal(mcpResult, 'CLIENT_EXACT_RESULT'); assert.equal((await post(continuation)).statusCode, 410);
});
for (const stream of [false, true]) test(`AGY runner wiring preserves separate native approval and client tool waits (${stream ? 'SSE' : 'JSON'} fixture)`, async t => {
  const s = await setup(t);
  const config = readConfig({ PROXY_API_KEY: TEST_KEY, PROXY_WORKSPACES: JSON.stringify({ fixture: s.workspace }), PROXY_DEFAULT_WORKSPACE: 'fixture' });
  config.profiles.agy!.tools = 'client'; // Fixture injection; readConfig rejects this in production.
  const context = executionContext(config, authenticate(config, `Bearer ${TEST_KEY}`), 'fixture', 'agy', 'agy/default');
  const hooks = new AgyWorkspaceRegistry(join(s.root, 'hooks')), mcp = new AgyMcpWorkspaceRegistry(join(s.root, 'mcp'));
  await hooks.install(context, hooks.planInstall(context).consent); await mcp.install(context, mcp.planInstall(context).consent);
  class FixtureRunner extends AgyRunner {
    override readonly clientToolsReady = true;
    protected override assertClientToolSupport() {}
    protected override assertExternalHookSupport() {}
  }
  const app = await buildServer({ logger: false, config, providers: { agy: new FixtureRunner({ executable: process.execPath, prefixArgs: [fileURLToPath(new URL('./fixtures/cli.mjs', import.meta.url))], agyRegistry: hooks, agyMcpRegistry: mcp }), codex: { async *run() {} } } }); t.after(() => app.close());
  const post = (body: Record<string, unknown>) => app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${TEST_KEY}` }, payload: body });
  const body = { model: 'agy/default', tools, messages: [{ role: 'user', content: 'mcp-fixture' }] };
  const first = await post(body); assert.equal(first.statusCode, 200, first.body);
  const approval = first.json().choices[0].message; assert.match(approval.content, /call_mcp_tool/);
  const continued = { ...body, stream, messages: [...body.messages, approval, { role: 'user', content: 'aprovar' }] };
  const pending = await post(continued); assert.equal(pending.statusCode, 200, pending.body);
  let assistant: any;
  if (!stream) { assert.equal(pending.json().choices[0].finish_reason, 'tool_calls'); assistant = pending.json().choices[0].message; }
  else {
    const events = pending.body.split('\n\n').filter(x => x.startsWith('data: {')).map(x => JSON.parse(x.slice(6)));
    assert.ok(events.some(x => x.choices?.[0].finish_reason === 'tool_calls'));
    const call = events.flatMap(x => x.choices?.[0].delta.tool_calls ?? [])[0]; assistant = { role: 'assistant', tool_calls: [{ id: call.id, type: 'function', function: call.function }] };
  }
  const call = assistant.tool_calls[0]; assert.equal(call.function.name, 'echo_fixture');
  const response = await post({ ...continued, messages: [...continued.messages, assistant, { role: 'tool', tool_call_id: call.id, content: 'CLIENT_AGY_FIXTURE' }] });
  assert.equal(response.statusCode, 200, response.body); assert.match(response.body, /CLIENT_AGY_FIXTURE/);
});
for (const [message, code] of [['phase-wait-init', 'cli_init_timeout'], ['phase-wait-attestation', 'approval_attestation_timeout']]) test(`AGY runner enforces ${code} without spending the active budget`, async t => {
  const s = await setup(t); s.context.profile.initTimeoutMs = 500; s.context.profile.attestationTimeoutMs = 500; s.context.profile.timeoutMs = 5000;
  const hooks = new AgyWorkspaceRegistry(join(s.root, 'hooks')); await hooks.install(s.context, hooks.planInstall(s.context).consent);
  class FixtureRunner extends AgyRunner { protected override assertExternalHookSupport() {} }
  const runner = new FixtureRunner({ executable: process.execPath, prefixArgs: [fileURLToPath(new URL('./fixtures/cli.mjs', import.meta.url))], agyRegistry: hooks });
  await assert.rejects(async () => { for await (const _ of runner.run({ context: s.context, model: 'default', prompt: formatPrompt([{ role: 'user', content: message! }]), signal: s.controller.signal, onApproval: async () => false })) {} }, { code });
});
