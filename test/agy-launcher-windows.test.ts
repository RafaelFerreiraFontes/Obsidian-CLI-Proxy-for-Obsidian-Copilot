import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgyApprovalBridge } from '../src/providers/agy-approval-bridge.js';
import { AgyWorkspaceRegistry, AGY_LAUNCHER, agyLauncherCommand } from '../src/agy-workspaces.js';
import { readConfig, authenticate, executionContext, SERVER_ROOT } from '../src/config.js';
import { TEST_KEY } from './helpers.js';

async function fixture(t: import('node:test').TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'agy-211-regression-'));
  const root = join(base, 'space Unicode 世界'); await mkdir(root);
  const config = readConfig({ PROXY_API_KEY: TEST_KEY, PROXY_WORKSPACES: JSON.stringify({ test: root }) });
  const context = executionContext(config, authenticate(config, `Bearer ${TEST_KEY}`), 'test', 'agy', 'agy/default');
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, root, context };
}

function invoke(executable: string, args: string[], cwd: string, input: string, env: NodeJS.ProcessEnv = {}, verbatim = false): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: { ...process.env, ...env }, shell: false, windowsHide: true, windowsVerbatimArguments: verbatim });
    let out = '', err = ''; child.stdout.on('data', c => out += c); child.stderr.on('data', c => err += c);
    child.once('error', reject); child.once('close', code => resolve({ code, out, err })); child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}

test('relative and absolute launcher paths preserve spaces, Unicode and quoted fixture arguments without a shell', async t => {
  const s = await fixture(t); const registry = new AgyWorkspaceRegistry(join(s.base, 'state'));
  await registry.install(s.context, registry.planInstall(s.context).consent);
  const cwd = join(s.root, '.agents');
  const probe = join(cwd, 'argv-probe.mjs');
  await writeFile(probe, "import {writeFile} from 'node:fs/promises'; await writeFile(new URL('./argv.json',import.meta.url),JSON.stringify(process.argv.slice(2)));\n");
  const quoted = 'literal "quotes" 世界';
  for (const path of [AGY_LAUNCHER, join(cwd, AGY_LAUNCHER)]) {
    const result = await invoke(process.execPath, ['--import', pathToFileURL(probe).href, path, quoted], cwd, '{invalid', { CLI_PROXY_REQUIRE_LEASE: '1' });
    assert.equal(result.code, 0); assert.equal(JSON.parse(result.out).decision, 'deny'); assert.equal(result.err, '');
    assert.deepEqual(JSON.parse(await readFile(join(cwd, 'argv.json'), 'utf8')), [quoted]);
  }
});

test('Windows registration uses a pinned unquoted executable and rejects Node paths requiring shell quoting', () => {
  assert.equal(agyLauncherCommand('C:\\Node\\node.exe', 'win32'), `C:/Node/node.exe ${AGY_LAUNCHER}`);
  for (const path of ['C:/Program Files/node.exe', 'C:/世界/node.exe', '"C:/Node/node.exe"', "'C:/Node/node.exe'", 'C:/Node/node.exe & echo x', 'node.exe']) assert.throws(() => agyLauncherCommand(path, 'win32'), /requires canonical Node/);
});

test('legacy quoted registrations require explicit consented migration and remain removable', async t => {
  const s = await fixture(t); const state = join(s.base, 'state');
  const current = new AgyWorkspaceRegistry(state); const legacy = new AgyWorkspaceRegistry(state);
  const entry = current.planInstall(s.context).entry;
  const node = realpathSync(process.execPath).replaceAll('\\', '/');
  entry.SessionStart[0]!.command = `"${node}" ${AGY_LAUNCHER} --ready`;
  entry.PreInvocation[0]!.command = `"${node}" ${AGY_LAUNCHER} --ready`;
  entry.PreToolUse[0]!.hooks[0]!.command = `"${node}" ${AGY_LAUNCHER}`;
  Object.defineProperty(legacy, 'entry', { value: () => entry });
  await legacy.install(s.context, legacy.planInstall(s.context).consent);
  if (process.platform === 'win32') assert.throws(() => current.verify(s.context), /migration/);
  await current.remove(s.context, current.planRemove(s.context).consent);
  await current.install(s.context, current.planInstall(s.context).consent); current.verify(s.context);
});

test('cmd reproduces the observed escaped executable quotes; unquoted pinned Node starts from .agents', { skip: process.platform !== 'win32' }, async t => {
  const s = await fixture(t); const cwd = join(s.root, '.agents'); await mkdir(cwd);
  await writeFile(join(cwd, 'probe.mjs'), 'console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}))');
  const node = realpathSync(process.execPath).replaceAll('\\', '/');
  assert.match(node, /^[A-Za-z]:\/[A-Za-z0-9_./-]+$/);
  const bad = await invoke('cmd.exe', ['/d', '/s', '/c', `\\"${node}\\" probe.mjs`], cwd, '', {}, true);
  assert.notEqual(bad.code, 0); assert.equal(bad.out, ''); assert.ok(bad.err.length > 0);
  const good = await invoke('cmd.exe', ['/d', '/s', '/c', `${node} probe.mjs fixture`], cwd, '', {}, true);
  assert.equal(good.code, 0, good.err); assert.deepEqual(JSON.parse(good.out), { cwd, args: ['fixture'] });
});

test('missing compiled handler and unreachable bridge deny from the real compiled launcher', async t => {
  const s = await fixture(t); const handler = join(s.base, 'private-handler.mjs');
  await writeFile(handler, await readFile(join(SERVER_ROOT, 'dist/approval-hook.js')));
  const registry = new AgyWorkspaceRegistry(join(s.base, 'state'), handler);
  await registry.install(s.context, registry.planInstall(s.context).consent);
  await rm(handler); assert.throws(() => registry.verify(s.context));
  const result = await invoke(process.execPath, [AGY_LAUNCHER], join(s.root, '.agents'), '{}');
  assert.equal(result.code, 1); assert.equal(JSON.parse(result.out).decision, 'deny');
  const unreachable = await invoke(process.execPath, [join(SERVER_ROOT, 'dist/approval-hook.js')], s.root, JSON.stringify({ toolCall: { name: 'read_file', args: { Path: join(s.root, 'sample') } } }), { CLI_PROXY_REQUIRE_LEASE: '0', CLI_PROXY_HOOK_URL: 'http://127.0.0.1:1/approve', CLI_PROXY_HOOK_TOKEN: 'fixture-only', CLI_PROXY_APPROVAL_TIMEOUT_MS: '1' });
  assert.equal(JSON.parse(unreachable.out).decision, 'deny');
});

test('real native Path contracts preserve original arguments and deny missing/unknown/outside/redirected paths', async t => {
  const s = await fixture(t); const actions: string[] = [];
  const bridge = await createAgyApprovalBridge({ context: s.context, model: 'default', prompt: '', signal: new AbortController().signal, onApproval: async a => { actions.push(a.action); assert.equal(a.cwd, s.root); return false; } });
  t.after(() => bridge.close());
  const post = async (toolCall: unknown, workspacePaths = [s.root]) => (await fetch(bridge.env.CLI_PROXY_HOOK_URL!, { method: 'POST', headers: { authorization: `Bearer ${bridge.env.CLI_PROXY_HOOK_TOKEN}` }, body: JSON.stringify({ conversationId: randomUUID(), workspacePaths, toolCall }) })).json();
  for (const name of ['read_file', 'write_file']) {
    const args = { Path: join(s.root, 'argument 世界.txt'), Content: 'literal "content" 世界', Overwrite: false };
    assert.deepEqual(await post({ name, args }), { approved: false });
    assert.equal(actions.at(-1), `${name}\n${JSON.stringify(args, null, 2)}`);
  }
  const count = actions.length;
  for (const tool of [{ name: 'read_file', args: { AbsolutePath: s.root } }, { name: 'write_file', args: {} }, { name: 'unknown', args: { Path: s.root } }, { name: 'run_command', args: { CommandLine: 'echo test' } }, { name: 'read_file', args: { Path: join(s.base, 'outside') } }, { name: 'read_file', args: { Path: 'relative' } }, { name: 'read_file', args: [] }]) assert.deepEqual(await post(tool), { approved: false });
  await symlink(s.base, join(s.root, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await post({ name: 'write_file', args: { Path: join(s.root, 'redirect/outside.txt') } }), { approved: false });
  assert.deepEqual(await post({ name: 'read_file', args: { Path: s.root } }, [s.base]), { approved: false });
  assert.equal(actions.length, count);
});

for (const failure of ['cancellation', 'integrity']) test(`${failure} after a pending approval prevents authorization`, async t => {
  const s = await fixture(t); const controller = new AbortController(); let release!: (v: boolean) => void;
  let entered!: () => void; const pending = new Promise<void>(r => entered = r);
  let intact = true;
  const bridge = await createAgyApprovalBridge({ context: s.context, model: 'default', prompt: '', signal: controller.signal, onApproval: async () => { entered(); return new Promise<boolean>(r => release = r); } }, () => { if (!intact) throw Error('Fixture integrity changed'); });
  t.after(() => bridge.close());
  const request = fetch(bridge.env.CLI_PROXY_HOOK_URL!, { method: 'POST', headers: { authorization: `Bearer ${bridge.env.CLI_PROXY_HOOK_TOKEN}` }, body: JSON.stringify({ workspacePaths: [s.root], toolCall: { name: 'write_file', args: { Path: join(s.root, 'sentinel') } } }) });
  await pending; if (failure === 'cancellation') controller.abort(); else intact = false; release(true);
  assert.deepEqual(await (await request).json(), { approved: false });
});
