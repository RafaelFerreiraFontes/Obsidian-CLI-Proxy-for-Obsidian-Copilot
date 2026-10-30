// Native MCP proof with the real approval bridge. No production feature is enabled.
import { readFile, writeFile, mkdir, appendFile, realpath } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { SpawnRunner } from '../../dist/providers/base.js';
import { AgyDecoder } from '../../dist/providers/agy-runner.js';
import { AgyLifecycle } from '../../dist/providers/agy-lifecycle.js';
import { createAgyApprovalBridge } from '../../dist/providers/agy-approval-bridge.js';
import { createAgyMcpBridge } from '../../dist/providers/agy-mcp-bridge.js';
import { AgyWorkspaceRegistry } from '../../dist/agy-workspaces.js';
import { AgyMcpWorkspaceRegistry } from '../../dist/agy-mcp-workspaces.js';
import { HookCredentialLease } from '../../dist/hook-credentials.js';
import { readConfig, authenticate, executionContext, SERVER_ROOT } from '../../dist/config.js';

const manifest = JSON.parse(await readFile(join(SERVER_ROOT, '.tmp/agy-stage22.json'), 'utf8'));
const rel = relative(await realpath(tmpdir()), manifest.root);
if (isAbsolute(rel) || rel.startsWith('..') || await realpath(manifest.root) !== manifest.root) throw Error('Unsafe fixture');
const root = join(manifest.root, 'mcp-human');
if (existsSync(root)) throw Error('Existing experiment; do not overwrite evidence');
await mkdir(root);
const evidence = join(root, 'evidence'); await mkdir(evidence);
const log = event => appendFile(join(evidence, 'events.ndjson'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
const binary = 'C:/Users/fedet/AppData/Local/agy/bin/agy.exe';
const hash = value => createHash('sha256').update(value).digest('hex');
const stable = () => { if (hash(readFileSync(binary)).toLowerCase() !== manifest.binarySha256.toLowerCase()) throw Error('AGY changed; stop'); };
stable();
const key = randomBytes(32).toString('hex'), nonce = randomBytes(12).toString('hex');
const config = readConfig({ PROXY_API_KEY: key, PROXY_WORKSPACES: JSON.stringify({ fixture: root }), PROXY_DEFAULT_WORKSPACE: 'fixture', APPROVAL_TIMEOUT_MS: '240000', AGY_ATTESTATION_TIMEOUT_MS: '240000' });
const context = executionContext(config, authenticate(config, `Bearer ${key}`), 'fixture', 'agy', 'agy/gemini-3.8-flash-medium');
const registry = new AgyWorkspaceRegistry(join(manifest.root, 'mcp-human-hooks'));
const mcpRegistry = new AgyMcpWorkspaceRegistry(join(manifest.root, 'mcp-human-registry'));
const controller = new AbortController();
const result = { outcome: 'BLOCKED', proofAdapter: true, productionGateUnchanged: true, nonce, humanApproved: false, clientCallReceived: false, finalContainsResult: false };
const verify = () => { stable(); registry.verify(context); mcpRegistry.verify(context); };
let hookInstalled = false, mcpInstalled = false, mcp, approvals, lease, monitor;
const clock = new AgyLifecycle(context.profile, error => controller.abort(error), phase => { void log({ event: 'phase', phase }); });
try {
  await registry.install(context, registry.planInstall(context).consent); hookInstalled = true;
  await mcpRegistry.install(context, mcpRegistry.planInstall(context).consent); mcpInstalled = true;
  const options = { sessionId: 'native-proof-' + randomBytes(16).toString('hex'), context, model: 'gemini-3.8-flash-medium', signal: controller.signal, prompt: `In this disposable workspace call echo_fixture from obsidian-cli-proxy-tools exactly once, arguments {"nonce":"${nonce}"}. Use no file, shell, browser, artifacts or other tools. Wait for the human decision. Stop on denial. Return only the exact tool result; never invent a result.`, tools: [{ type: 'function', function: { name: 'echo_fixture', description: 'Harmless fixture echo; no filesystem or subprocess access.', parameters: { type: 'object', properties: { nonce: { type: 'string', const: nonce } }, required: ['nonce'], additionalProperties: false } } }],
    onToolCall: async call => {
      if (call.function.name !== 'echo_fixture' || JSON.parse(call.function.arguments).nonce !== nonce) throw Error('Wrong fixture action');
      result.clientCallReceived = true; await log({ event: 'client-echo-called', exactNonce: true });
      return 'ECHO:' + nonce; // Test client implements only this harmless fixture.
    }, onApproval: async action => {
      clock.phase('waiting_approval'); await log({ event: 'human-approval-pending', actionHash: hash(action.action) });
      console.log(JSON.stringify({ HUMAN_MCP_APPROVAL_REQUIRED: true, workspace: root, server: 'obsidian-cli-proxy-tools', tool: 'echo_fixture', arguments: { nonce }, effect: 'Return ECHO:' + nonce + '; no file or command access' }));
      const approved = await new Promise(resolve => {
        let text = ''; const timeout = setTimeout(() => finish(false), 180000);
        function receive(chunk) { text += chunk; if (text.includes('\n')) finish(text.trim() === 'aprovar'); }
        function finish(value) { clearTimeout(timeout); process.stdin.off('data', receive); process.stdin.pause(); resolve(value); }
        process.stdin.on('data', receive); process.stdin.resume();
      });
      result.humanApproved = approved; await log({ event: 'human-decision', approved }); clock.phase('active'); return approved;
    }, approvalTimeoutMs: 240000 };
  mcp = await createAgyMcpBridge(options, verify, event => { void log(event); }, error => controller.abort(error));
  approvals = await createAgyApprovalBridge(options, verify, true, input => mcp.validateInvocation(input), (input, approved) => mcp.recordDecision(input, approved));
  lease = new HookCredentialLease(context, { url: approvals.env.CLI_PROXY_HOOK_URL, token: approvals.env.CLI_PROXY_HOOK_TOKEN });
  void approvals.ready.then(() => clock.ready());
  class NativeProof extends SpawnRunner {
    command() { return { provider: 'agy', executable: binary, args: ['--add-dir', root, '--model', options.model, '--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands'], input: JSON.stringify({ event: 'user', message: { content: options.prompt } }) + '\n', keepStdinOpen: true, managesStartup: true, onSpawn: pid => { mcp.bindProcess(pid); clock.spawned(); }, env: { ...approvals.env, ...mcp.env }, decoder: new AgyDecoder(async (id, cwd) => { await lease.register(id, cwd); mcp.bindNative(id, cwd); clock.init(); }) }; }
  }
  monitor = setInterval(() => { try { stable(); } catch (error) { result.binaryChanged = true; controller.abort(error); } }, 2000);
  clock.phase('spawning'); let output = '';
  for await (const part of new NativeProof({ cwd: root }).run(options)) output += part;
  result.finalContainsResult = output.includes('ECHO:' + nonce);
  result.ready = approvals.isReady();
  result.outcome = result.humanApproved && result.clientCallReceived && result.finalContainsResult && result.ready ? 'PASS' : 'BLOCKED';
} catch (error) { result.errorCode = error.code ?? 'native_mcp_incomplete'; }
finally {
  clearInterval(monitor); clock.close(); controller.abort(); await mcp?.close(); await approvals?.close(); await lease?.close();
  if (mcpInstalled) await mcpRegistry.remove(context, mcpRegistry.planRemove(context).consent);
  if (hookInstalled) await registry.remove(context, registry.planRemove(context).consent);
  stable(); result.cleaned = !existsSync(join(root, '.agents/hooks.json')) && !existsSync(join(root, '.agents/mcp_config.json'));
  await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
}
