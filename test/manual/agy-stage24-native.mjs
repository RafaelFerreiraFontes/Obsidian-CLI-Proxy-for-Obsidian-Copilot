// Opt-in native HTTP proof. No automatic positive decision; only explicit operator records.
import { mkdtemp, mkdir, writeFile, readFile, appendFile, realpath, readdir, copyFile } from 'node:fs/promises';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { buildServer } from '../../dist/index.js';
import { AgyRunner } from '../../dist/providers/agy-runner.js';
import { AgyWorkspaceRegistry } from '../../dist/agy-workspaces.js';
import { AgyMcpWorkspaceRegistry } from '../../dist/agy-mcp-workspaces.js';
import { SERVER_ROOT, readConfig, authenticate, executionContext } from '../../dist/config.js';
import { pinFixtureExecutable } from './agy-stage24-pin.mjs';

const mode = process.argv[2] ?? 'single';
if (!['single', 'same', 'different', 'same-cancel', 'different-cancel'].includes(mode)) throw Error('Invalid mode');
const root = await realpath(await mkdtemp(join(tmpdir(), 'agy-stage24-')));
const evidence = join(root, 'evidence'); await mkdir(evidence);
await mkdir(join(SERVER_ROOT, '.tmp'), { recursive: true });
await writeFile(join(SERVER_ROOT, '.tmp/agy-stage24-current.json'), JSON.stringify({ root, mode }));
await appendFile(join(SERVER_ROOT, '.tmp/agy-stage24-runs.ndjson'), JSON.stringify({ root, mode, at: new Date().toISOString() }) + '\n');
const hash = value => createHash('sha256').update(value).digest('hex');
const log = event => appendFileSync(join(evidence, 'events.ndjson'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
const installDirectory = 'C:/Users/fedet/AppData/Local/agy/bin';
// Proof-only fingerprint, observed after the installed CLI changed to 1.4.11.
// Does not change AGY_REVIEWED_CLI or authorize production execution.
const binaryHash = 'b3a033afb92b3ffbb31e81e4897e0e3f5730a327fcd9a8c2920c6711715d9408';
// Freeze the already-reviewed executable in this disposable experiment. An
// unrelated update of the installed executable cannot change a running proof.
// Never restore/replace the installation or modify its update preferences.
const candidates = ['agy.exe', ...(await readdir(installDirectory)).filter(name => /^agy\.exe\.\d+\.old$/.test(name))];
const source = candidates.map(name => join(installDirectory, name)).find(path => hash(readFileSync(path)) === binaryHash);
if (!source) throw Error('Reviewed proof binary unavailable; no compatibility fallback');
const runtime = join(root, 'runtime'); await mkdir(runtime);
const binary = join(runtime, 'agy.exe'); await copyFile(source, binary, 1);
const executableLease = await pinFixtureExecutable(binary);
const pinned = new Map([[binary, binaryHash]]);
for (const entry of await readdir(join(SERVER_ROOT, 'dist'), { recursive: true })) {
  if (entry.endsWith('.js')) { const path = join(SERVER_ROOT, 'dist', entry); pinned.set(path, hash(readFileSync(path))); }
}
const stable = () => { for (const [path, digest] of pinned) if (hash(readFileSync(path)) !== digest) throw Error('Pinned binary/handler changed; evidence invalid'); };
stable();
const workspaceA = join(root, 'workspace-A'), workspaceB = mode.startsWith('different') ? join(root, 'workspace-B') : workspaceA;
await mkdir(workspaceA); if (workspaceB !== workspaceA) await mkdir(workspaceB);
const wrapper = join(root, 'observed-mcp.mjs');
await writeFile(wrapper, `import { Transform } from 'node:stream';import { appendFileSync } from 'node:fs';import { randomUUID,createHash } from 'node:crypto';import { serveMcp as core } from ${JSON.stringify(pathToFileURL(join(SERVER_ROOT, 'dist/mcp-stdio.js')).href)};
export async function serveMcp(){const worker=randomUUID(),h=v=>createHash('sha256').update(String(v)).digest('hex'),sessionHash=h(process.env.CLI_PROXY_MCP_SESSION);const log=e=>appendFileSync(${JSON.stringify(join(evidence, 'workers.ndjson'))},JSON.stringify({at:new Date().toISOString(),worker,sessionHash,...e})+'\\n');log({event:'worker-start',pid:process.pid,parent:process.ppid});
function tracker(direction){let buffered='';const stream=new Transform({transform(chunk,encoding,cb){buffered+=chunk;const lines=buffered.split('\\n');buffered=lines.pop()??'';for(const line of lines){try{const m=JSON.parse(line),cid=m.params?._meta?.['antigravity.google/conversation_id'],root=m.params?._meta?.['antigravity.google/root_conversation_id'];log({event:direction==='in'?'mcp-input':'mcp-output',method:m.method,rpcHash:m.id===undefined?null:h(JSON.stringify([typeof m.id,m.id])),tool:direction==='in'&&m.method==='tools/call'?m.params?.name:undefined,paramKeys:Object.keys(m.params??{}),metaKeys:Object.keys(m.params?._meta??{}),nativeConversationHash:typeof cid==='string'?h(cid):null,nativeRootConversationHash:typeof root==='string'?h(root):null,errorCode:m.error?.code,resultHash:m.result?h(JSON.stringify(m.result)):undefined,catalog:m.result?.tools?.map(t=>({name:t.name,inputSchema:t.inputSchema}))});}catch{}}cb(null,chunk);}});stream.setEncoding('utf8');return stream;}
const input=tracker('in'),output=tracker('out');process.stdin.setEncoding('utf8');process.stdin.pipe(input);output.pipe(process.stdout);try{await core(input,output);}finally{output.end();log({event:'worker-end',pid:process.pid});}}
`);
const labels = mode === 'single' ? ['A'] : ['A','B'];
const keys = Object.fromEntries(labels.map(label => [label, randomBytes(32).toString('hex')]));
const config = readConfig({ PROXY_CLIENTS: JSON.stringify(Object.fromEntries(labels.map(label => [label, { key: keys[label], profiles: ['agy'], workspaces: labels }]))), PROXY_WORKSPACES: JSON.stringify({ A: workspaceA, B: workspaceB }), APPROVAL_TIMEOUT_MS: '580000', AGY_ATTESTATION_TIMEOUT_MS: '240000' });
config.profiles.agy.tools = 'client'; // Proof injection only. Production parser/guards remain closed.
const hooks = new AgyWorkspaceRegistry(join(root, 'hook-state'));
const mcp = new AgyMcpWorkspaceRegistry(join(root, 'mcp-state'), wrapper);
const result = { mode, binarySha256: binaryHash, privateExecutableCopy: true, executableLeasePid: executableLease.pid, model: 'gemini-3.8-flash-medium', productionEnabled: false, outcome: 'BLOCKED', sessions: {} };
const sessions = labels.map(label => ({ label, context: executionContext(config, authenticate(config, `Bearer ${keys[label]}`), label, 'agy', 'agy/gemini-3.8-flash-medium'), expected: `SESSION_${label}_RESULT`, controller: new AbortController(), state: result.sessions[label] = {}, ended: false }));
const pendingOperators = new Map();
const installed = []; let app, url, monitor;
const tool = { type: 'function', function: { name: 'echo_fixture', description: 'Harmless in-memory fixture. Returns a fixed string; no file access, commands or network.', parameters: { type: 'object', properties: {}, additionalProperties: false } } };
const post = async (s, body, workspace = s.label, signal = s.controller.signal) => {
  const response = await fetch(url + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${keys[s.label]}`, 'content-type': 'application/json', 'x-proxy-workspace': workspace, 'x-proxy-profile': 'agy' }, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(400000)]) });
  return { status: response.status, value: await response.json() };
};
async function operator(s) {
  // Observed native dispatcher stops waiting around five minutes even with a
  // longer hook timeout. Deny explicitly before that boundary; never extend or
  // recycle a decision after the native caller has ended.
  const requestId = randomUUID(), deadline = Date.now() + 240000;
  pendingOperators.set(requestId, s);
  const request = { requestId, session: s.label, authenticatedSessionHash: s.state.openaiSessionHash, conversationHash: s.state.conversationHash, workspace: s.context.workspaceRoot, tool: 'echo_fixture', arguments: {}, schema: tool.function.parameters, effect: `Return only ${s.expected} in memory`, requestedAt: new Date().toISOString(), deadline: new Date(deadline).toISOString(), decisionFile: join(root, 'operator-decisions.ndjson') };
  log({ event: 'operator-request', ...request, workspace: `<WORKSPACE_${s.label}>`, decisionFile: '<TEMP_OPERATOR_FILE>' });
  console.log(JSON.stringify({ HUMAN_APPROVAL_REQUIRED: true, ...request }));
  await writeFile(join(evidence, `pending-${s.label}.json`), JSON.stringify(request, null, 2));
  let approved = false, source = 'expired';
  try {
    while (Date.now() < deadline && !s.ended && !s.controller.signal.aborted) {
      let lines = ''; try { lines = await readFile(join(root, 'operator-decisions.ndjson'), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      for (const line of lines.split('\n').filter(Boolean)) {
        let value; try { value = JSON.parse(line); } catch { continue; }
        if (value.requestId === requestId && ['approve','deny'].includes(value.decision) && Object.keys(value).length === 2) { approved = value.decision === 'approve'; source = 'explicit-operator'; return approved; }
      }
      await delay(250);
    }
    if (s.ended || s.controller.signal.aborted) source = 'session-ended';
    return false;
  } finally { pendingOperators.delete(requestId); log({ event: 'operator-decision', session: s.label, requestId, approved, source }); s.state.decision = { approved, source }; }
}
function runnerFor(s) {
  class ProofRunner extends AgyRunner {
    clientToolsReady = true;
    assertExternalHookSupport() { stable(); hooks.verify(s.context); mcp.verify(s.context); }
    assertClientToolSupport(options) {
      if (options.context?.identity !== s.context.identity || options.context.workspaceRoot !== s.context.workspaceRoot || JSON.stringify(options.tools) !== JSON.stringify([tool])) throw Error('Wrong proof scope');
      this.assertExternalHookSupport();
    }
    async *run(options) {
      s.state.openaiSessionHash = hash(options.sessionId);
      log({ event: 'http-session', session: s.label, identity: s.context.identity, openaiSessionHash: s.state.openaiSessionHash });
      try {
        yield* super.run({ ...options, signal: AbortSignal.any([options.signal, s.controller.signal]),
          onPhase: phase => { log({ event: 'phase', session: s.label, phase }); options.onPhase?.(phase); },
          onApproval: async action => {
            let args; try { args = JSON.parse(action.action.slice(action.action.indexOf('\n') + 1)); } catch { return false; }
            let value = args.Arguments; try { if (typeof value === 'string') value = JSON.parse(value); } catch { return false; }
            if (!action.action.startsWith('call_mcp_tool\n') || args.ServerName !== 'obsidian-cli-proxy-tools' || args.ToolName !== 'echo_fixture' || !value || Object.keys(value).length) { log({ event: 'unexpected-action-denied', session: s.label }); return false; }
            log({ event: 'approval-pending', session: s.label, actionHash: hash(action.action) });
            const approved = await options.onApproval(action);
            log({ event: 'client-decision', session: s.label, approved }); return approved;
          },
          onToolCall: call => { s.mcpCall = call; log({ event: 'mcp-client-call', session: s.label, requestHash: hash(call.id.slice(4)), mcpCallHash: hash(call.id), tool: call.function.name }); return options.onToolCall(call); },
        });
      } finally { s.ended = true; log({ event: 'native-runner-ended', session: s.label }); }
    }
  }
  return new ProofRunner({ executable: binary, agyRegistry: hooks, agyMcpRegistry: mcp, agyMcpObserver: event => { if (event.conversationHash) s.state.conversationHash = event.conversationHash; s.state.agyPid = event.processId; if (event.workerPid) s.state.workerPid = event.workerPid; log({ session: s.label, ...event }); } });
}
let arrived = 0, releaseBarrier;
const barrier = new Promise(resolve => { releaseBarrier = resolve; });
async function exercise(s) {
  const body = { model: 'agy/gemini-3.8-flash-medium', conversation_id: 'stage24-' + randomUUID(), tools: [tool], messages: [{ role: 'user', content: 'Disposable MCP test. Call echo_fixture from obsidian-cli-proxy-tools exactly once with arguments {}. It returns a fixed string unknown to you. No files, shell, network, browser, artifacts or other tools. Wait for human permission, stop on denial/error. Return only the exact tool result; never invent it.' }] };
  s.body = body;
  try {
    const first = await post(s, body), assistant = first.value.choices?.[0]?.message;
    s.state.initialStatus = first.status;
    if (!assistant?.content?.includes('cli-proxy-approval:')) { s.state.blocker = first.value.error?.code ?? 'no-pending-approval'; return; }
    if (sessions.length > 1) {
      const foreign = sessions.find(other => other !== s);
      s.state.foreignApprovalStatus = (await post(foreign, { ...body, messages: [...body.messages, assistant, { role: 'user', content: 'aprovar' }] })).status;
    }
    const approved = await operator(s);
    if (s.ended) { s.state.blocker = 'native-ended-before-decision'; return; }
    const continued = { ...body, messages: [...body.messages, assistant, { role: 'user', content: approved ? 'aprovar' : 'negar' }] };
    const pending = await post(s, continued), toolAssistant = pending.value.choices?.[0]?.message, call = toolAssistant?.tool_calls?.[0];
    s.state.decisionStatus = pending.status;
    if (!approved || pending.value.choices?.[0]?.finish_reason !== 'tool_calls' || call?.function.name !== 'echo_fixture' || call.function.arguments !== '{}') { s.state.blocker = approved ? 'no-native-tools-call-after-approval' : 'denied-or-expired'; return; }
    s.state.toolCall = true;
    s.reply = { ...body, messages: [...continued.messages, toolAssistant, { role: 'tool', tool_call_id: call.id, content: s.expected }] };
    log({ event: 'openai-tool-call', session: s.label, callHash: hash(call.id), requestHash: hash(s.mcpCall.id.slice(4)), mcpCallHash: hash(s.mcpCall.id) });
    const invalid = structuredClone(s.reply); invalid.messages.at(-1).tool_call_id = 'foreign_fixture_id';
    s.state.invalidIdStatus = (await post(s, invalid)).status;
    s.state.modelChangeStatus = (await post(s, { ...s.reply, model: 'agy/other' })).status;
    if (sessions.length > 1) {
      const foreign = sessions.find(other => other !== s);
      s.state.foreignResultStatus = (await post(foreign, s.reply)).status;
      s.state.workspaceChangeStatus = (await post(s, s.reply, foreign.label)).status;
    }
    s.state.consumedApprovalStatus = (await post(s, continued)).status;
    if (++arrived === sessions.length) releaseBarrier();
    await Promise.race([barrier, delay(270000, undefined, { ref: false }).then(() => { throw Error('Peer never reached MCP pending'); })]);
    if (mode.endsWith('cancel') && s.label === 'A') { s.controller.abort(new Error('Explicit fixture cancellation of A only')); s.state.cancelled = true; return; }
    log({ event: 'client-role-tool', session: s.label, callHash: hash(call.id), resultHash: hash(s.expected) });
    const final = await post(s, s.reply), text = final.value.choices?.[0]?.message?.content ?? '';
    s.state.finalStatus = final.status; s.state.finalErrorCode = final.value.error?.code; s.state.continued = final.value.choices?.[0]?.finish_reason === 'stop' && text.includes(s.expected);
    s.state.foreignResultObserved = sessions.some(other => other !== s && text.includes(other.expected));
    s.state.replayStatus = (await post(s, s.reply)).status;
  } catch (error) { s.state.errorCode = error.code ?? 'native-proof-incomplete'; }
}
try {
  for (const s of sessions) if (!installed.some(context => context.workspaceRoot === s.context.workspaceRoot)) { await hooks.install(s.context, hooks.planInstall(s.context).consent); await mcp.install(s.context, mcp.planInstall(s.context).consent); installed.push(s.context); }
  const runners = new Map(sessions.map(s => [s.context.identity, runnerFor(s)]));
  const provider = { clientToolsReady: true, phasedTimeouts: true, run(options) { const runner = runners.get(options.context?.identity); if (!runner) throw Error('Unknown proof identity'); return runner.run(options); } };
  app = await buildServer({ logger: false, config, providers: { agy: provider, codex: { async *run() { throw Error('No fallback'); } } } });
  url = await app.listen({ host: '127.0.0.1', port: 0 });
  monitor = setInterval(() => { try { stable(); } catch { result.binaryChanged = true; for (const s of sessions) s.controller.abort(); void app.close(); } }, 5000);
  console.log(JSON.stringify({ started: true, root, mode, model: result.model }));
  await Promise.all(sessions.map(exercise));
  result.outcome = sessions.every(s => (mode.endsWith('cancel') && s.label === 'A' ? s.state.cancelled : s.state.continued) && !s.state.foreignResultObserved) ? 'PASS' : 'BLOCKED';
} finally {
  clearInterval(monitor);
  const nativeEndDeadline = Date.now() + 6000;
  for (const s of sessions) if (s.reply) {
    while (!s.ended && Date.now() < nativeEndDeadline) await delay(20);
    if (!s.ended) { s.state.nativeEndNotVerified = true; if (result.outcome === 'PASS') result.outcome = 'BLOCKED'; }
  }
  for (const s of sessions) if (s.reply && s.ended) {
    try {
      s.state.lateResultStatus = (await post(s, s.reply, s.label, AbortSignal.timeout(10000))).status;
      s.state.lateResultCheckedAfterNativeEnd = true;
      log({ event: 'late-result-after-native-end', session: s.label, status: s.state.lateResultStatus });
      if (result.outcome === 'PASS' && s.state.lateResultStatus !== 410) result.outcome = 'FAIL';
    } catch { s.state.lateResultNotVerified = true; if (result.outcome === 'PASS') result.outcome = 'BLOCKED'; }
  }
  if (result.outcome === 'PASS' && sessions.some(s => s.state.invalidIdStatus !== 410 || s.state.modelChangeStatus !== 410 || s.state.consumedApprovalStatus !== 409 || (sessions.length > 1 && (s.state.foreignApprovalStatus !== 409 || s.state.foreignResultStatus !== 410 || s.state.workspaceChangeStatus !== 409)))) result.outcome = 'FAIL';
  await app?.close();
  for (const context of installed.reverse()) { await mcp.remove(context, mcp.planRemove(context).consent); await hooks.remove(context, hooks.planRemove(context).consent); }
  try { stable(); } catch { result.binaryChanged = true; result.outcome = 'BLOCKED'; }
  result.cleaned = installed.every(c => !existsSync(join(c.workspaceRoot, '.agents/hooks.json')) && !existsSync(join(c.workspaceRoot, '.agents/mcp_config.json')));
  await executableLease.close(); result.executableLeaseClosed = true;
  await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
}
