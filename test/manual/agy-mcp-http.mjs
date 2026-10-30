// Real AGY + real HTTP/session tool round trip, restricted proof adapter only.
import { readFile, writeFile, mkdir, appendFile, realpath } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { buildServer } from '../../dist/index.js';
import { AgyRunner } from '../../dist/providers/agy-runner.js';
import { AgyWorkspaceRegistry } from '../../dist/agy-workspaces.js';
import { AgyMcpWorkspaceRegistry } from '../../dist/agy-mcp-workspaces.js';
import { readConfig, authenticate, executionContext, SERVER_ROOT } from '../../dist/config.js';

const manifest = JSON.parse(await readFile(join(SERVER_ROOT, '.tmp/agy-stage22.json'), 'utf8'));
const rel = relative(await realpath(tmpdir()), manifest.root);
if (isAbsolute(rel) || rel.startsWith('..') || await realpath(manifest.root) !== manifest.root) throw Error('Unsafe fixture');
const root = join(manifest.root, 'mcp-http'); if (existsSync(root)) throw Error('Existing evidence; do not overwrite');
await mkdir(root); const evidence = join(root, 'evidence'); await mkdir(evidence);
const hash = value => createHash('sha256').update(value).digest('hex');
const log = event => appendFile(join(evidence, 'events.ndjson'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
const binary = 'C:/Users/fedet/AppData/Local/agy/bin/agy.exe';
const stable = () => { if (hash(readFileSync(binary)).toLowerCase() !== manifest.binarySha256.toLowerCase()) throw Error('AGY changed; abort'); }; stable();
const key = randomBytes(32).toString('hex'), nonce = randomBytes(12).toString('hex');
const config = readConfig({ PROXY_API_KEY: key, PROXY_WORKSPACES: JSON.stringify({ fixture: root }), PROXY_DEFAULT_WORKSPACE: 'fixture', APPROVAL_TIMEOUT_MS: '240000', AGY_ATTESTATION_TIMEOUT_MS: '240000' });
// Internal fixture injection, intentionally impossible through readConfig in production.
config.profiles.agy.tools = 'client';
const context = executionContext(config, authenticate(config, `Bearer ${key}`), 'fixture', 'agy', 'agy/gemini-3.8-flash-medium');
const registry = new AgyWorkspaceRegistry(join(manifest.root, 'mcp-http-hooks'));
const mcpRegistry = new AgyMcpWorkspaceRegistry(join(manifest.root, 'mcp-http-registry'));
class ProofRunner extends AgyRunner {
  clientToolsReady = true;
  assertExternalHookSupport() { stable(); registry.verify(context); mcpRegistry.verify(context); }
  assertClientToolSupport(options) { if (options.context?.workspaceRoot !== root || options.tools?.length !== 1 || options.tools[0].function.name !== 'echo_fixture') throw Error('Wrong proof session'); this.assertExternalHookSupport(); }
  async *run(options) {
    yield* super.run({ ...options, onPhase: phase => { void log({ event: 'phase', phase }); options.onPhase?.(phase); }, onApproval: async action => {
      let args; try { args = JSON.parse(action.action.slice(action.action.indexOf('\n') + 1)); } catch { return false; }
      let argumentsValue = args.Arguments; if (typeof argumentsValue === 'string') { try { argumentsValue = JSON.parse(argumentsValue); } catch { return false; } }
      if (!action.action.startsWith('call_mcp_tool\n') || args.ServerName !== 'obsidian-cli-proxy-tools' || args.ToolName !== 'echo_fixture' || argumentsValue?.nonce !== nonce || Object.keys(argumentsValue).length !== 1) return false;
      await log({ event: 'human-approval-pending', actionHash: hash(action.action) });
      const decision = await options.onApproval(action); await log({ event: 'human-decision', approved: decision }); return decision;
    } });
  }
}
const result = { outcome: 'BLOCKED', proofAdapter: true, productionGateUnchanged: true, nonce };
let app, hooksInstalled = false, mcpInstalled = false, monitor;
try {
  await registry.install(context, registry.planInstall(context).consent); hooksInstalled = true;
  await mcpRegistry.install(context, mcpRegistry.planInstall(context).consent); mcpInstalled = true;
  app = await buildServer({ logger: false, config, providers: { agy: new ProofRunner({ executable: binary, agyRegistry: registry, agyMcpRegistry: mcpRegistry }), codex: { async *run() { throw Error('Not used'); } } } });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const post = async body => { const response = await fetch(url + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-proxy-workspace': 'fixture', 'x-proxy-profile': 'agy' }, body: JSON.stringify(body), signal: AbortSignal.timeout(480000) }); return { status: response.status, value: await response.json() }; };
  const body = { model: 'agy/gemini-3.8-flash-medium', messages: [{ role: 'user', content: `Use echo_fixture from obsidian-cli-proxy-tools exactly once with arguments {"nonce":"${nonce}"}. The client will return a fixture string. After receiving the result respond with exactly that string. No files, shell, browser, artifacts, other tools or retries. Wait for human permission; stop on denial or error.` }], tools: [{ type: 'function', function: { name: 'echo_fixture', description: 'Harmless in-memory client fixture. No file or process access.', parameters: { type: 'object', properties: { nonce: { type: 'string', const: nonce } }, required: ['nonce'], additionalProperties: false } } }] };
  monitor = setInterval(() => { try { stable(); } catch { result.binaryChanged = true; void app.close(); } }, 2000);
  const first = await post(body), assistant = first.value.choices?.[0]?.message;
  if (first.status !== 200 || !assistant?.content?.includes('cli-proxy-approval:') || !assistant.content.includes(nonce)) throw Error('No scoped pending human approval');
  console.log(JSON.stringify({ HUMAN_MCP_HTTP_APPROVAL_REQUIRED: true, workspace: root, server: 'obsidian-cli-proxy-tools', tool: 'echo_fixture', arguments: { nonce }, effect: 'Client test returns CLIENT_HTTP_ECHO:' + nonce + '; no files or commands', channel: 'real HTTP AgentSession approval' }));
  const decision = await new Promise(resolve => { let text = ''; const timeout = setTimeout(() => finish('negar'), 180000); function receive(c) { text += c; if (text.includes('\n')) finish(text.trim() === 'aprovar' ? 'aprovar' : 'negar'); } function finish(value) { clearTimeout(timeout); process.stdin.off('data', receive); process.stdin.pause(); resolve(value); } process.stdin.on('data', receive); process.stdin.resume(); });
  result.humanApproved = decision === 'aprovar';
  const continued = { ...body, messages: [...body.messages, assistant, { role: 'user', content: decision }] };
  const pending = await post(continued), toolAssistant = pending.value.choices?.[0]?.message;
  const call = toolAssistant?.tool_calls?.[0];
  result.toolCallsFinishReason = pending.value.choices?.[0]?.finish_reason === 'tool_calls';
  if (!result.humanApproved || !result.toolCallsFinishReason || call?.function.name !== 'echo_fixture' || JSON.parse(call.function.arguments).nonce !== nonce) throw Error('No exact client tool request');
  await log({ event: 'openai-tool-call-received', callHash: hash(call.id), tool: call.function.name, exactNonce: true });
  const content = 'CLIENT_HTTP_ECHO:' + nonce;
  const reply = { ...body, messages: [...continued.messages, toolAssistant, { role: 'tool', tool_call_id: call.id, content }] };
  const invalid = structuredClone(reply); invalid.messages.at(-1).tool_call_id = 'invalid_fixture_id'; result.foreignIdRejected = (await post(invalid)).status === 410;
  await log({ event: 'client-role-tool-submitted', callHash: hash(call.id) });
  const final = await post(reply);
  result.nativeContinued = final.status === 200 && final.value.choices?.[0]?.finish_reason === 'stop' && final.value.choices?.[0]?.message?.content?.includes(content);
  result.replayRejected = (await post(reply)).status === 410;
  result.noResidualSession = (await (await fetch(url + '/health')).json()).active_sessions === 0;
  result.outcome = result.humanApproved && result.toolCallsFinishReason && result.foreignIdRejected && result.nativeContinued && result.replayRejected ? 'PASS' : 'BLOCKED';
} catch (error) { result.errorCode = error.code ?? 'http_mcp_incomplete'; }
finally {
  clearInterval(monitor); await app?.close();
  if (mcpInstalled) await mcpRegistry.remove(context, mcpRegistry.planRemove(context).consent);
  if (hooksInstalled) await registry.remove(context, registry.planRemove(context).consent);
  stable(); result.cleaned = !existsSync(join(root, '.agents/hooks.json')) && !existsSync(join(root, '.agents/mcp_config.json'));
  await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
}
