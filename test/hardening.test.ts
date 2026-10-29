import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, rename, symlink, readFile, writeFile, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { buildServer } from '../src/index.js';
import { readConfig, SERVER_ROOT, authenticate, executionContext, validateExecution, cliEnvironment } from '../src/config.js';
import { CodexRunner } from '../src/providers/codex-runner.js';
import { AgyRunner } from '../src/providers/agy-runner.js';
import { killProcessTree } from '../src/providers/base.js';
import { createAgyApprovalBridge } from '../src/providers/agy-approval-bridge.js';
import { TEST_KEY } from './helpers.js';
import { fileURLToPath, pathToFileURL } from 'node:url';

const otherKey = 'second-test-key-01234567890123456789';
const fixture = fileURLToPath(new URL('./fixtures/cli.mjs', import.meta.url));
const providers = { codex: new CodexRunner({ executable: process.execPath, prefixArgs: [fixture] }), agy: new AgyRunner({ executable: process.execPath, prefixArgs: [fixture] }) };
const body = (text = 'context') => ({ model: 'codex/default', messages: [{ role: 'user', content: text }] });
const headers = { authorization: `Bearer ${TEST_KEY}` };
const makeConfig = (workspaces: Record<string, string>, extra: NodeJS.ProcessEnv = {}) => readConfig({ PROXY_API_KEY: TEST_KEY, PROXY_WORKSPACES: JSON.stringify(workspaces), PROXY_DEFAULT_WORKSPACE: Object.keys(workspaces)[0], ...extra });
async function directories(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'proxy-isolation-'));
  const first = join(root, 'worktree with spaces 世界');
  const second = join(root, 'other-worktree');
  await mkdir(first); await mkdir(second);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, first, second };
}

test('configuration rejects malformed, unsafe and secret-bearing values without echoing them', () => {
  for (const env of [ { PORT: '0' }, { CLI_TIMEOUT_MS: 'NaN' }, { APPROVAL_TIMEOUT_MS: '600000' }, { HOST: '0.0.0.0' }, { HOST: '0.0.0.0', ALLOW_REMOTE: 'true' },
    { CORS_ORIGINS: '*' }, { PROXY_WORKSPACES: '{secret-marker' }, { PROXY_WORKSPACES: '{"x":"../escape"}' }, { PROXY_API_KEY: 'secret-marker' },
    { PROXY_PROFILES: '{"bad":{"provider":"agy","policy":"read-only"}}' }, { PROXY_DEFAULT_WORKSPACE: 'missing' } ]) {
    assert.throws(() => readConfig(env), error => error instanceof Error && !error.message.includes('secret-marker'));
  }
  assert.equal(readConfig({}).host, '127.0.0.1');
  assert.equal(readConfig({ HOST: '0.0.0.0', ALLOW_REMOTE: 'true', PROXY_API_KEY: TEST_KEY }).host, '0.0.0.0');
});

test('HTTP execution requires real authentication; CORS and model inventory grant no access', async t => {
  const app = await buildServer({ logger: false, providers, config: makeConfig({ proxy: SERVER_ROOT }) });
  t.after(() => app.close());
  for (const authorization of ['', 'Bearer placeholder']) {
    const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization }, payload: body() });
    assert.equal(response.statusCode, 401);
  }
  assert.equal((await app.inject('/health')).statusCode, 200);
  assert.equal((await app.inject('/v1/models')).statusCode, 401);
  const cors = await app.inject({ url: '/health', headers: { origin: 'https://untrusted.example' } });
  assert.equal(cors.headers['access-control-allow-origin'], undefined);
  const capabilities = await app.inject({ url: '/v1/capabilities', headers });
  assert.equal(capabilities.json().providers.agy.client_tools, false);
  assert.ok(!capabilities.body.includes(TEST_KEY));
});

test('Codex receives the authorized canonical workspace concurrently in spawn and thread/start', async t => {
  const { first, second } = await directories(t);
  const app = await buildServer({ logger: false, providers, config: makeConfig({ first, second }) });
  t.after(() => app.close());
  const responses = await Promise.all(['first', 'second'].map(id => app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { ...headers, 'x-proxy-workspace': id }, payload: body() })));
  for (const [index, response] of responses.entries()) {
    assert.equal(response.statusCode, 200, response.body);
    const result = JSON.parse(response.json().choices[0].message.content);
    assert.equal(result.cwd, index === 0 ? first : second);
    assert.equal(result.thread.cwd, result.cwd);
    assert.equal(result.thread.allowProviderModelFallback, false);
    assert.equal(result.thread.sandbox, 'read-only');
    assert.equal(result.apiKey, null);
    assert.equal(result.nodeOptions, null);
    assert.notEqual(result.cwd, SERVER_ROOT);
  }
});

test('workspace IDs reject paths, traversal, missing directories and ungranted roots', async t => {
  const { first, second, root } = await directories(t);
  const config = makeConfig({ first, second, missing: join(root, 'missing') }, { PROXY_CLIENTS: JSON.stringify({ limited: { key: otherKey, workspaces: ['first'], profiles: ['codex'] } }) });
  const app = await buildServer({ logger: false, providers, config });
  t.after(() => app.close());
  for (const id of ['../first', first, 'unregistered', 'constructor']) {
    const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { ...headers, 'x-proxy-workspace': id }, payload: body() });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, 'workspace_not_authorized');
  }
  assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { ...headers, 'x-proxy-workspace': 'missing' }, payload: body() })).json().error.code, 'workspace_not_found');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: `Bearer ${otherKey}`, 'x-proxy-workspace': 'second' }, payload: body() })).statusCode, 403);
});

test('junction/symlink roots are pinned and cannot be retargeted during server lifetime', async t => {
  const { root, first, second } = await directories(t);
  const alias = join(root, 'authorized-alias');
  await symlink(first, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const config = makeConfig({ alias });
  const auth = authenticate(config, `Bearer ${TEST_KEY}`);
  const context = executionContext(config, auth, 'alias', 'codex', 'codex/default');
  assert.equal(context.workspaceRoot, first);
  validateExecution(context);
  await rm(alias); await symlink(second, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => validateExecution(context), /Workspace changed/);
  assert.throws(() => executionContext(config, auth, 'alias', 'codex', 'codex/default'), /Workspace changed/);
});

test('directory rename invalidates a pinned session', async t => {
  const { first, root } = await directories(t);
  const config = makeConfig({ first });
  const context = executionContext(config, authenticate(config, `Bearer ${TEST_KEY}`), 'first', 'codex', 'codex/default');
  await rename(first, join(root, 'renamed'));
  assert.throws(() => validateExecution(context), /Workspace changed/);
});

test('pending sessions reject workspace, identity, profile and tools changes; original decision still works', async t => {
  const { first, second } = await directories(t);
  const config = makeConfig({ first, second }, { PROXY_CLIENTS: JSON.stringify({ other: { key: otherKey, workspaces: ['first', 'second'], profiles: ['codex'] } }) });
  config.profiles.another = { ...config.profiles.codex! };
  const app = await buildServer({ logger: false, providers, config });
  t.after(() => app.close());
  const initial = body('approval');
  const assistant = (await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: initial })).json().choices[0].message;
  const continuation = { ...initial, messages: [...initial.messages, assistant, { role: 'user', content: 'negar' }] };
  for (const extra of [{ 'x-proxy-workspace': 'second' }, { authorization: `Bearer ${otherKey}` }, { 'x-proxy-profile': 'another' }]) {
    const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { ...headers, ...extra }, payload: continuation });
    assert.equal(response.statusCode, 409);
  }
  const changed = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: { ...continuation, tools: [{ type: 'function', function: { name: 'injected' } }] } });
  assert.equal(changed.statusCode, 409);
  assert.match((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: continuation })).body, /denied/);
});

test('operator write-enabled profile maps only to workspace-write; HTTP flags do not override it', async t => {
  const { first } = await directories(t);
  const config = makeConfig({ first });
  config.profiles.writer = { ...config.profiles.codex!, policy: 'write-enabled', models: ['pinned'] };
  const app = await buildServer({ logger: false, providers, config });
  t.after(() => app.close());
  const selected = { ...headers, 'x-proxy-profile': 'writer' };
  assert.equal((await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: selected, payload: body() })).statusCode, 403);
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: selected, payload: { ...body(), model: 'codex/pinned', sandbox: 'danger-full-access', flags: ['--dangerously-bypass-approvals-and-sandbox'] } });
  const result = JSON.parse(response.json().choices[0].message.content);
  assert.equal(result.thread.model, 'pinned');
  assert.equal(result.thread.sandbox, 'workspace-write');
  assert.equal(result.thread.approvalPolicy, 'untrusted');
});

test('shared key and a client named local remain distinct authenticated identities', () => {
  const config = makeConfig({ proxy: SERVER_ROOT }, { PROXY_CLIENTS: JSON.stringify({ local: { key: otherKey, workspaces: ['proxy'], profiles: ['codex'] } }) });
  assert.notEqual(authenticate(config, `Bearer ${TEST_KEY}`).identity, authenticate(config, `Bearer ${otherKey}`).identity);
});

test('reserved approval function is never exposed to the model as a dynamic tool', async t => {
  const app = await buildServer({ logger: false, providers, config: makeConfig({ proxy: SERVER_ROOT }) });
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: { ...body(), tools: [
    { type: 'function', function: { name: 'proxy_approve_action' } }, { type: 'function', function: { name: 'read_note', parameters: { type: 'object' } } },
  ] } });
  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.json().choices[0].message.content);
  assert.deepEqual(result.thread.dynamicTools.map((tool: any) => tool.name), ['read_note']);
});

test('concurrent tool sessions preserve schemas and reject foreign IDs and invalid results', async t => {
  const { first, second } = await directories(t);
  const app = await buildServer({ logger: false, providers, config: makeConfig({ first, second }) });
  t.after(() => app.close());
  const tools = [{ type: 'function', function: { name: 'read_note', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }];
  const initial = { ...body('tool'), tools };
  const send = (workspace: string, payload: any) => app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { ...headers, 'x-proxy-workspace': workspace }, payload });
  const replies = await Promise.all(['first', 'second'].map(async workspace => (await send(workspace, initial)).json().choices[0].message));
  assert.notEqual(replies[0].tool_calls[0].id, replies[1].tool_calls[0].id);
  const continuation = (assistant: any, content: unknown) => ({ ...initial, messages: [...initial.messages, assistant, { role: 'tool', tool_call_id: assistant.tool_calls[0].id, content }] });
  assert.equal((await send('second', continuation(replies[0], 'foreign'))).statusCode, 409);
  assert.equal((await send('first', continuation(replies[0], 123))).statusCode, 400);
  for (const [index, workspace] of ['first', 'second'].entries()) {
    const response = await send(workspace, continuation(replies[index], `result-${workspace}`));
    assert.match(response.body, new RegExp(`result-${workspace}`));
  }
});

test('hook launcher resolves its handler in paths with spaces and Unicode and fails closed when missing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hook path 世界 '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.agents')); await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await cp(join(SERVER_ROOT, '.agents/approval-launcher.mjs'), join(root, '.agents/approval-launcher.mjs'));
  const run = async () => {
    const child = spawn(process.execPath, ['approval-launcher.mjs'], { cwd: join(root, '.agents'), env: cliEnvironment(), windowsHide: true });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stdin.end('{}');
    const [code] = await once(child, 'close'); return { code, result: JSON.parse(output) };
  };
  const missing = await run(); assert.equal(missing.code, 1); assert.equal(missing.result.decision, 'deny');
  await cp(join(SERVER_ROOT, 'dist/approval-hook.js'), join(root, 'dist/approval-hook.js'));
  const noToken = await run(); assert.equal(noToken.code, 0); assert.equal(noToken.result.decision, 'deny');
  await writeFile(join(root, 'dist/approval-hook.js'), 'invalid javascript !');
  assert.equal((await run()).result.decision, 'deny');
});

test('Antigravity external workspace fails closed without starting in the server directory', async t => {
  const { first } = await directories(t);
  const app = await buildServer({ logger: false, providers, config: makeConfig({ first }) });
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers, payload: { ...body('hello'), model: 'agy/default' } });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'approval_hook_missing');
});

test('approval bridge denies malformed or unauthenticated payloads and binds the displayed workspace', async t => {
  const { first } = await directories(t);
  const config = makeConfig({ first });
  let calls = 0;
  const bridge = await createAgyApprovalBridge({ model: 'default', prompt: '', signal: new AbortController().signal,
    context: executionContext(config, authenticate(config, `Bearer ${TEST_KEY}`), 'first', 'codex', 'codex/default'),
    onApproval: async request => { calls++; assert.equal(request.cwd, first); return false; } });
  t.after(() => bridge.close());
  const url = bridge.env.CLI_PROXY_HOOK_URL!;
  const auth = { authorization: `Bearer ${bridge.env.CLI_PROXY_HOOK_TOKEN}` };
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 403);
  assert.deepEqual(await (await fetch(url, { method: 'POST', headers: auth, body: '{"toolCall":{"name":"x","args":[]}}' })).json(), { approved: false });
  assert.deepEqual(await (await fetch(url, { method: 'POST', headers: auth, body: '{"toolCall":{"name":"run_command","args":{"Cwd":"untrusted"}}}' })).json(), { approved: false });
  assert.equal(calls, 0, 'An unvalidated path must not fall back to the authorized workspace.');
  assert.deepEqual(await (await fetch(url, { method: 'POST', headers: auth, body: JSON.stringify({ workspacePaths: [first], toolCall: { name: 'run_command', args: { Cwd: first, CommandLine: 'echo fixture' } } }) })).json(), { approved: false });
  assert.equal(calls, 1);
});

test('subprocess environment excludes local API keys, unrelated secrets and Node injection', () => {
  const prior = { ...process.env };
  try {
    process.env.PROXY_API_KEY = TEST_KEY; process.env.UNRELATED_SECRET = 'do-not-inherit'; process.env.NODE_OPTIONS = '--inspect';
    const env = cliEnvironment();
    assert.equal(env.PROXY_API_KEY, undefined); assert.equal(env.UNRELATED_SECRET, undefined); assert.equal(env.NODE_OPTIONS, undefined);
    assert.ok(env.PATH ?? env.Path);
  } finally { delete process.env.UNRELATED_SECRET; for (const name of ['PROXY_API_KEY', 'NODE_OPTIONS']) { if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name]; } }
});

test('request and session limits bound authenticated execution', async t => {
  const config = makeConfig({ proxy: SERVER_ROOT }, { MAX_REQUESTS_PER_MINUTE: '1', MAX_SESSIONS: '1' });
  const app = await buildServer({ logger: false, providers, config });
  t.after(() => app.close());
  assert.equal((await app.inject({ url: '/v1/capabilities', headers })).statusCode, 200);
  assert.equal((await app.inject({ url: '/v1/capabilities', headers })).statusCode, 429);
  config.maxRequestsPerMinute = 100;
  const request = { method: 'POST' as const, url: '/v1/chat/completions', headers, payload: body('approval') };
  assert.equal((await app.inject(request)).statusCode, 200);
  assert.equal((await app.inject(request)).json().error.code, 'session_limit');
});

test('diagnostics check executable availability without claiming account/model access', async t => {
  const config = makeConfig({ proxy: SERVER_ROOT }, { DIAGNOSTICS: 'true' });
  const app = await buildServer({ logger: false, config, providers: { ...providers, agy: new AgyRunner({ executable: 'missing-diagnostic-cli-123456' }) } });
  t.after(() => app.close());
  const result = (await app.inject({ url: '/v1/diagnostics', headers })).json();
  assert.equal(result.providers.codex.available, true);
  assert.equal(result.providers.codex.authentication_verified, false);
  assert.equal(result.providers.agy.code, 'cli_not_found');
});

test('missing server .env uses defaults; invalid .env fails with a redacted configuration diagnostic', async t => {
  const root = await mkdtemp(join(tmpdir(), 'proxy-env-optional-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await cp(join(SERVER_ROOT, 'dist/config.js'), join(root, 'config.js'));
  await cp(join(SERVER_ROOT, 'dist/types.js'), join(root, 'types.js'));
  const script = `import {loadServerEnv, readConfig} from ${JSON.stringify(pathToFileURL(join(root, 'config.js')).href)}; loadServerEnv(); console.log(readConfig().host);`;
  const run = async () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env: cliEnvironment(), windowsHide: true });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    const [code] = await once(child, 'close'); return { code, output };
  };
  assert.deepEqual(await run(), { code: 0, output: '127.0.0.1\n' });
  await writeFile(join(root, '.env'), 'PORT=secret-marker\n');
  const invalid = await run();
  assert.equal(invalid.code, 1); assert.match(invalid.output, /PORT must be/); assert.ok(!invalid.output.includes('secret-marker'));
});

async function freePort(): Promise<number> {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
for (const mode of ['start', 'dev']) test(`npm run ${mode} loads only server .env, preserves system precedence, and omits secrets`, { timeout: 25_000 }, async t => {
  const parent = join(SERVER_ROOT, '.tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'env-launch-'));
  const outside = await mkdtemp(join(tmpdir(), 'external-cwd-'));
  let child: ReturnType<typeof spawn> | undefined;
  t.after(async () => {
    if (child && child.exitCode === null) { const closed = once(child, 'close'); killProcessTree(child); await closed; }
    await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true });
  });
  await cp(join(SERVER_ROOT, 'src'), join(root, 'src'), { recursive: true });
  await cp(join(SERVER_ROOT, 'dist'), join(root, 'dist'), { recursive: true });
  const pkg = JSON.parse(await readFile(join(SERVER_ROOT, 'package.json'), 'utf8'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: pkg.scripts }));
  const port = await freePort();
  // PORT in .env is intentionally invalid: an explicit system value must win.
  await writeFile(join(root, '.env'), `HOST=127.0.0.1\nPORT=invalid\nPROXY_API_KEY=${TEST_KEY}\n`);
  await writeFile(join(outside, '.env'), 'HOST=0.0.0.0\nPORT=invalid\n');
  assert.ok(process.env.npm_execpath, 'Run integration tests through npm test.');
  const env = { ...process.env, PORT: String(port), PROXY_API_KEY: undefined, PROXY_WORKSPACES: undefined, PROXY_CLIENTS: undefined, PROXY_PROFILES: undefined, PROXY_DEFAULT_WORKSPACE: undefined, HOST: undefined };
  child = spawn(process.execPath, [process.env.npm_execpath!, '--prefix', root, 'run', mode], { cwd: outside, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout!.on('data', chunk => { output += chunk; }); child.stderr!.on('data', chunk => { output += chunk; });
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try { ready = (await fetch(`${url}/health`)).ok; if (ready) break; } catch {}
    if (child.exitCode !== null) break;
    await delay(100);
  }
  assert.ok(ready, output);
  assert.equal((await fetch(`${url}/v1/capabilities`, { headers })).status, 200, 'key must come from server .env');
  assert.ok(!output.includes(TEST_KEY));
  if (mode === 'dev') {
    const index = join(root, 'src/index.ts');
    await writeFile(index, (await readFile(index, 'utf8')).replace("status: 'ok'", "status: 'reloaded'"));
    // Health is defined in routes.ts, so change that watched module too.
    const routes = join(root, 'src/routes.ts');
    await writeFile(routes, (await readFile(routes, 'utf8')).replace("status: 'ok'", "status: 'reloaded'"));
    let reloaded = false;
    for (let i = 0; i < 80; i++) { try { reloaded = (await (await fetch(`${url}/health`)).json() as any).status === 'reloaded'; if (reloaded) break; } catch {} await delay(100); }
    assert.ok(reloaded, 'tsx must reload changed modules');
  }
});
