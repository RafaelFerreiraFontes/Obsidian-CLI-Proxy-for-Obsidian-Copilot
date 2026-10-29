import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, rm, readFile, writeFile, copyFile, rename, symlink, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { AgyWorkspaceRegistry, AGY_LAUNCHER } from '../src/agy-workspaces.js';
import { readConfig, executionContext, authenticate, SERVER_ROOT } from '../src/config.js';
import { buildServer } from '../src/index.js';
import { AgyRunner } from '../src/providers/agy-runner.js';
import { AgyDecoder } from '../src/providers/agy-runner.js';
import { CodexRunner } from '../src/providers/codex-runner.js';
import { TEST_KEY } from './helpers.js';
import { randomUUID } from 'node:crypto';
import { createAgyApprovalBridge } from '../src/providers/agy-approval-bridge.js';

const fixture = fileURLToPath(new URL('./fixtures/cli.mjs', import.meta.url));
// The fixture implements the hook contract explicitly; this is not evidence
// about native AGY. Production retains its pre-spawn capability block.
class FixtureAgyRunner extends AgyRunner {
  protected override assertExternalHookSupport(): void {}
}
async function setup(t: TestContext, env: NodeJS.ProcessEnv = {}, useServerHandler = true) {
  const root = await mkdtemp(join(tmpdir(), 'agy-registration-'));
  const first = join(root, 'vault with spaces 世界'); const second = join(root, 'worktree two');
  await mkdir(first); await mkdir(second);
  const handler = join(root, 'handler.mjs'); await copyFile(join(SERVER_ROOT, 'dist/approval-hook.js'), handler);
  const config = readConfig({ PROXY_API_KEY: TEST_KEY, PROXY_WORKSPACES: JSON.stringify({ first, second }), PROXY_DEFAULT_WORKSPACE: 'first', ...env });
  const auth = authenticate(config, `Bearer ${TEST_KEY}`);
  const context = (id = 'first') => executionContext(config, auth, id, 'agy', 'agy/gemini-3.8-flash-medium');
  const registry = new AgyWorkspaceRegistry(join(root, 'private-registry'), useServerHandler ? join(SERVER_ROOT, 'dist/approval-hook.js') : handler);
  const app = await buildServer({ logger: false, config, providers: { codex: new CodexRunner({ executable: process.execPath, prefixArgs: [fixture] }), agy: new FixtureAgyRunner({ executable: process.execPath, prefixArgs: [fixture], agyRegistry: registry }) } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const install = async (id = 'first') => { const ctx = context(id); await registry.install(ctx, registry.planInstall(ctx).consent); };
  const post = (payload: Record<string, unknown>, id = 'first') => app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${TEST_KEY}`, 'x-proxy-workspace': id }, payload });
  const request = (content: string, stream = false) => ({ model: 'agy/gemini-3.8-flash-medium', messages: [{ role: 'user', content }], stream });
  return { root, first, second, handler, context, registry, app, install, post, request };
}

test('production blocks external execution before spawn even with intact registered hooks', async t => {
  const s = await setup(t); await s.install();
  const runner = new AgyRunner({ executable: join(s.root, 'must-not-start.exe'), agyRegistry: s.registry });
  await assert.rejects(async () => {
    for await (const _ of runner.run({ model: 'gemini-3.8-flash-medium', prompt: 'hello', context: s.context(), signal: new AbortController().signal, onApproval: async () => false })) {}
  }, (error: unknown) => error instanceof Error && error.message.includes('native hook loading has not been verified'));
});

test('planning and HTTP never install files; install requires consent for the current plan', async t => {
  const s = await setup(t);
  const plan = s.registry.planInstall(s.context());
  assert.match(plan.consent, /^[a-f0-9]{64}$/);
  assert.deepEqual(await readdir(s.first), []);
  assert.equal((await s.post(s.request('hello'))).json().error.code, 'approval_hook_missing');
  assert.deepEqual(await readdir(s.first), []);
  await assert.rejects(s.registry.install(s.context(), 'not-consent'), /Consent/);
  assert.deepEqual(await readdir(s.first), []);
  await mkdir(join(s.first, '.agents')); await writeFile(join(s.first, '.agents/hooks.json'), '{}');
  await assert.rejects(s.registry.install(s.context(), plan.consent), /Consent/);
  assert.equal(existsSync(join(s.first, '.agents', AGY_LAUNCHER)), false);
});

test('external registration preserves third-party hooks and restores original bytes on removal', async t => {
  const s = await setup(t); const hooks = join(s.first, '.agents/hooks.json');
  await mkdir(join(s.first, '.agents'));
  const original = '\uFEFF{\r\n  "third-party": {"PostToolUse": []}\r\n}\r\n'; await writeFile(hooks, original);
  await s.install(); s.registry.verify(s.context());
  assert.deepEqual(JSON.parse(await readFile(hooks, 'utf8'))['third-party'], { PostToolUse: [] });
  const launcher = await readFile(join(s.first, '.agents', AGY_LAUNCHER), 'utf8');
  assert.ok(!launcher.includes(TEST_KEY)); assert.ok(!launcher.includes('CLI_PROXY_HOOK_TOKEN='));
  const response = await s.post(s.request('hello'));
  assert.equal(response.statusCode, 200, response.body);
  assert.match(response.body, /gemini-3.8-flash-medium/);
  await s.registry.remove(s.context(), s.registry.planRemove(s.context()).consent);
  assert.equal(await readFile(hooks, 'utf8'), original);
  assert.equal(existsSync(join(s.first, '.agents', AGY_LAUNCHER)), false);
  assert.throws(() => s.registry.verify(s.context()), /registration/);
});

test('removal retains later third-party additions instead of restoring an obsolete backup', async t => {
  const s = await setup(t); await s.install(); const hooks = join(s.first, '.agents/hooks.json');
  const data = JSON.parse(await readFile(hooks, 'utf8')); data['new-third-party'] = { PreInvocation: [] };
  await writeFile(hooks, JSON.stringify(data));
  await s.registry.remove(s.context(), s.registry.planRemove(s.context()).consent);
  assert.deepEqual(JSON.parse(await readFile(hooks, 'utf8')), { 'new-third-party': { PreInvocation: [] } });
});

test('registration refuses conflicting hooks and existing launchers without overwriting them', async t => {
  const s = await setup(t); await mkdir(join(s.first, '.agents'));
  const hooks = join(s.first, '.agents/hooks.json');
  await writeFile(hooks, '{"obsidian-cli-proxy-approval":{"enabled":false}}');
  assert.throws(() => s.registry.planInstall(s.context()), /conflicting/);
  await writeFile(hooks, '{}');
  await writeFile(join(s.first, '.agents', AGY_LAUNCHER), 'third-party');
  assert.throws(() => s.registry.planInstall(s.context()), /already exists/);
  assert.equal(await readFile(hooks, 'utf8'), '{}');
});

test('overlapping third-party PreToolUse hooks require manual conflict resolution', async t => {
  const s = await setup(t); await mkdir(join(s.first, '.agents'));
  const hooks = join(s.first, '.agents/hooks.json');
  await writeFile(hooks, JSON.stringify({ existing: { PreToolUse: [{ matcher: 'run_command', hooks: [{ command: 'third-party' }] }] } }));
  assert.throws(() => s.registry.planInstall(s.context()), /overlaps/);
  const original = await readFile(hooks, 'utf8');
  assert.ok(!existsSync(join(s.first, '.agents', AGY_LAUNCHER)));
  assert.equal(await readFile(hooks, 'utf8'), original);
});

for (const change of ['disabled', 'altered-hook', 'missing-hook', 'missing-launcher', 'altered-launcher', 'replaced-launcher', 'altered-handler']) test(`external execution fails closed: ${change}`, async t => {
  const s = await setup(t, {}, change !== 'altered-handler'); await s.install();
  const hooks = join(s.first, '.agents/hooks.json'); const launcher = join(s.first, '.agents', AGY_LAUNCHER);
  if (change === 'disabled' || change === 'altered-hook') {
    const data = JSON.parse(await readFile(hooks, 'utf8'));
    if (change === 'disabled') data['obsidian-cli-proxy-approval'].enabled = false;
    else data['obsidian-cli-proxy-approval'].PreToolUse[0].hooks[0].command = 'node different.mjs';
    await writeFile(hooks, JSON.stringify(data));
  } else if (change === 'missing-hook') await rm(hooks);
  else if (change === 'missing-launcher') await rm(launcher);
  else if (change === 'altered-handler') await writeFile(s.handler, 'invalid javascript !');
  else if (change === 'altered-launcher') await writeFile(launcher, 'invalid javascript !');
  else { const identical = await readFile(launcher); await rename(launcher, `${launcher}.old`); await writeFile(launcher, identical); }
  const response = await s.post(s.request('hello'));
  assert.equal(response.statusCode, 503);
  assert.match(response.json().error.code, /^approval_hook_(missing|failed)$/);
});

test('junctions cannot redirect .agents resources or the authorized workspace', async t => {
  const s = await setup(t); const external = join(s.root, 'external-hooks'); await mkdir(external);
  await symlink(external, join(s.first, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => s.registry.planInstall(s.context()), /canonical/);
  await rm(join(s.first, '.agents')); await s.install();
  await rename(s.first, `${s.first}-old`); await symlink(s.second, s.first, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await s.post(s.request('hello'))).json().error.code, 'session_conflict');
});

test('unregistered and unauthorized workspace requests cannot reuse a different registration', async t => {
  const s = await setup(t); await s.install();
  assert.equal((await s.post(s.request('hello'), 'second')).json().error.code, 'approval_hook_missing');
  assert.equal((await s.post(s.request('hello'), '../first')).json().error.code, 'workspace_not_authorized');
});

test('two external workspaces maintain independent pending approvals and single-action decisions', async t => {
  const s = await setup(t); await s.install(); await s.install('second');
  const marker1 = join(s.first, 'approved.txt'); const marker2 = join(s.second, 'denied.txt');
  const requests = [s.request(`approval:${marker1}`), s.request(`approval:${marker2}`)];
  const replies = await Promise.all(requests.map(async (body, i) => (await s.post(body, i ? 'second' : 'first')).json().choices[0].message));
  assert.match(replies[0].content, /vault with spaces/); assert.match(replies[1].content, /worktree two/);
  for (const i of [0, 1]) {
    const response = await s.post({ ...requests[i], messages: [...requests[i]!.messages, replies[i], { role: 'user', content: i ? 'negar' : 'aprovar' }] }, i ? 'second' : 'first');
    assert.equal(response.statusCode, 200, response.body);
  }
  assert.equal(await readFile(marker1, 'utf8'), 'executed'); assert.equal(existsSync(marker2), false);
});

test('hook modifications while an approval is pending deny the original action', async t => {
  const s = await setup(t); await s.install(); const marker = join(s.first, 'must-not-execute');
  const request = s.request(`approval:${marker}`);
  const assistant = (await s.post(request)).json().choices[0].message;
  await writeFile(join(s.first, '.agents', AGY_LAUNCHER), '// changed');
  const response = await s.post({ ...request, messages: [...request.messages, assistant, { role: 'user', content: 'aprovar' }] });
  assert.match(response.body, /denied/); assert.equal(existsSync(marker), false);
});

test('expiry and shutdown cancel external pending approvals without executing the action', async t => {
  const s = await setup(t, { APPROVAL_TIMEOUT_MS: '100' }); await s.install();
  const marker = join(s.first, 'never-written'); const request = s.request(`approval:${marker}`);
  const assistant = (await s.post(request)).json().choices[0].message;
  await delay(250);
  assert.equal((await s.post({ ...request, messages: [...request.messages, assistant, { role: 'user', content: 'aprovar' }] })).statusCode, 410);
  await s.post(request); await s.app.close(); assert.equal(existsSync(marker), false);
});

test('AGY client tools remain explicitly unavailable without a proven real MCP round trip', async t => {
  const s = await setup(t); await s.install();
  const response = await s.post({ ...s.request('hello'), tools: [{ type: 'function', function: { name: 'read_note', parameters: { type: 'object' } } }] });
  assert.equal(response.statusCode, 400); assert.equal(response.json().error.code, 'tool_not_supported');
});

test('headless stdin remains open until the result event, rather than cancelling the active turn', async t => {
  const s = await setup(t); await s.install();
  const response = await s.post(s.request('stdin-lifecycle'));
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().choices[0].message.content, 'input kept open');
});

test('an empty SUCCESS envelope does not count as a functional assistant response', () => {
  const decoder = new AgyDecoder();
  decoder.push('{"event":"result","result":{"status":"SUCCESS","response":""}}\n');
  assert.throws(() => decoder.finish(), /without an assistant response/);
});

test('a CLI that ignores SessionStart cannot return a successful external response', async t => {
  const s = await setup(t); await s.install();
  const response = await s.post(s.request('skip-readiness'));
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(response.json().error.code, 'approval_hook_failed');
});

test('PreInvocation can attest loading before inference when SessionStart is unavailable', async t => {
  const s = await setup(t); await s.install();
  assert.equal((await s.post(s.request('only-pre-invocation'))).statusCode, 200);
});

test('native conversation ID correlates hooks without inherited custom environment and cleans runtime credentials', async t => {
  const s = await setup(t, {}, true); await s.install();
  const marker = join(s.first, 'native-action'); const request = s.request(`native-init:approval:${marker}`);
  const response = await s.post(request);
  assert.equal(response.statusCode, 200, response.body);
  const assistant = response.json().choices[0].message;
  assert.match(assistant.content, /Solicitação/);
  assert.equal(existsSync(marker), false);
  assert.equal((await readdir(join(s.first, '.agents'))).length, 2);
  const denied = await s.post({ ...request, messages: [...request.messages, assistant, { role: 'user', content: 'negar' }] });
  assert.match(denied.body, /denied/);
});

test('readiness is authenticated and workspace-bound; tools remain denied until attestation', async t => {
  const s = await setup(t); await s.install();
  let decisions = 0;
  const bridge = await createAgyApprovalBridge({ context: s.context(), model: 'default', prompt: '', signal: new AbortController().signal, onApproval: async () => { decisions++; return false; } }, () => s.registry.verify(s.context()), true);
  t.after(() => bridge.close());
  const headers = { authorization: `Bearer ${bridge.env.CLI_PROXY_HOOK_TOKEN}`, 'content-type': 'application/json' };
  const ready = bridge.env.CLI_PROXY_HOOK_URL!.replace('/approve', '/ready');
  const conversationId = randomUUID();
  assert.equal((await fetch(ready, { method: 'POST', body: '{}' })).status, 403);
  await fetch(ready, { method: 'POST', headers, body: JSON.stringify({ workspacePaths: [s.second] }) });
  assert.equal(bridge.isReady(), false);
  const action = JSON.stringify({ conversationId, workspacePaths: [s.first], toolCall: { name: 'view_file', args: { AbsolutePath: join(s.first, 'sample.txt') } } });
  assert.deepEqual(await (await fetch(bridge.env.CLI_PROXY_HOOK_URL!, { method: 'POST', headers, body: action })).json(), { approved: false });
  assert.equal(decisions, 0);
  assert.deepEqual(await (await fetch(ready, { method: 'POST', headers, body: JSON.stringify({ conversationId, workspacePaths: [s.first] }) })).json(), { ready: true });
  assert.equal(bridge.isReady(), true);
  await fetch(bridge.env.CLI_PROXY_HOOK_URL!, { method: 'POST', headers, body: action });
  assert.equal(decisions, 1);
});

test('external execution timeout terminates the fixture process and its descendant', async t => {
  const s = await setup(t, { CLI_TIMEOUT_MS: '1500' }); await s.install();
  const marker = join(s.first, 'pids.json');
  const response = await s.post(s.request(`sleep:${marker}`));
  assert.equal(response.statusCode, 504, response.body);
  assert.equal(response.json().error.code, 'cli_timeout');
  const pids = JSON.parse(await readFile(marker, 'utf8')) as { parent: number; descendant: number };
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  t.after(() => { for (const pid of [pids.parent, pids.descendant]) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
  for (let i = 0; i < 100 && (alive(pids.parent) || alive(pids.descendant)); i++) await delay(30);
  assert.equal(alive(pids.parent), false); assert.equal(alive(pids.descendant), false);
});

test('external Gemini SSE preserves the OpenAI stream contract without client tools', async t => {
  const s = await setup(t); await s.install();
  const response = await s.post(s.request('hello', true));
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.ok(response.body.endsWith('data: [DONE]\n\n'));
  assert.match(response.body, /gemini-3.8-flash-medium/);
  assert.match(response.body, /"finish_reason":"stop"/);
});
