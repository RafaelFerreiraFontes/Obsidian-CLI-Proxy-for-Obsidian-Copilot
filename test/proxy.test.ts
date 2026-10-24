import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildServer } from '../src/index.js';
import { CodexRunner } from '../src/providers/codex-runner.js';
import { AgyRunner, AgyDecoder } from '../src/providers/agy-runner.js';
import { formatPrompt } from '../src/utils/prompt-formatter.js';
import { CODEX_MODELS } from '../src/models.js';

const fixture = fileURLToPath(new URL('./fixtures/cli.mjs', import.meta.url));
const config = { executable: process.execPath, prefixArgs: [fixture] };
const providers = { codex: new CodexRunner(config), agy: new AgyRunner(config) };
const payload = (model: string, stream = false, content = 'hello') => ({ model, stream, messages: [{ role: 'user', content }] });

test('models, health and Obsidian CORS preflight', async t => {
  const app = await buildServer({ logger: false, providers, modelIds: ['agy/example'] });
  t.after(() => app.close());
  const models = await app.inject({ url: '/v1/models', headers: { origin: 'app://obsidian.md' } });
  assert.equal(models.statusCode, 200);
  assert.equal(models.headers['access-control-allow-origin'], '*');
  const ids = models.json().data.map((m: { id: string }) => m.id);
  for (const id of ['codex/default', 'agy/default', 'agy/example', ...CODEX_MODELS.map(id => `codex/${id}`), 'agy/gemini-4-argon-high']) assert.ok(ids.includes(id));
  const preflight = await app.inject({ method: 'OPTIONS', url: '/v1/chat/completions', headers: {
    origin: 'app://obsidian.md', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type,x-stainless-runtime',
  } });
  assert.equal(preflight.statusCode, 204);
  assert.match(String(preflight.headers['access-control-allow-headers']), /Authorization/i);
  assert.match(String(preflight.headers['access-control-allow-headers']), /x-stainless-runtime/i);
  assert.equal((await app.inject('/health')).json().status, 'ok');
});

for (const provider of ['codex', 'agy']) {
  for (const stream of [false, true]) {
    test(`${provider}: native spawn, stdin, model selection, ${stream ? 'SSE' : 'JSON'}`, async t => {
      const app = await buildServer({ logger: false, providers });
      t.after(() => app.close());
      const result = await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { origin: 'app://obsidian.md' }, payload: payload(`${provider}/example`, stream) });
      assert.equal(result.statusCode, 200);
      assert.equal(result.headers['access-control-allow-origin'], '*');
      const expected = provider === 'codex' ? 'Hello (example) 世界' : 'Hello 世界 (example)';
      if (!stream) {
        const completion = result.json();
        assert.equal(completion.object, 'chat.completion');
        assert.equal(completion.model, `${provider}/example`);
        assert.equal(completion.choices[0].message.content, expected);
        assert.equal(completion.choices[0].finish_reason, 'stop');
      } else {
        assert.equal(result.headers['content-type'], 'text/event-stream; charset=utf-8');
        const frames = result.body.trim().split('\n\n').map(line => line.slice(6));
        assert.equal(frames.pop(), '[DONE]');
        const chunks = frames.map(frame => JSON.parse(frame));
        assert.equal(chunks[0].choices[0].delta.role, 'assistant');
        assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
        assert.equal(chunks.map(chunk => chunk.choices[0].delta.content ?? '').join(''), expected);
        assert.ok(chunks.every(chunk => chunk.id === chunks[0].id && chunk.object === 'chat.completion.chunk'));
      }
    });
  }
}

test('invalid input is rejected before spawning; compatible extra options accepted', async t => {
  const app = await buildServer({ logger: false, providers });
  t.after(() => app.close());
  for (const body of [
    payload('unknown/default'), { ...payload('codex/default'), messages: [] },
    { ...payload('codex/default'), stream: 'true' },
    { ...payload('codex/default'), messages: [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }] },
    { ...payload('codex/default'), tools: [{ type: 'function' }] },
  ]) {
    const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: body });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.type, 'invalid_request_error');
  }
  const good = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: {
    ...payload('agy/default'), temperature: 0.3, max_tokens: 100, stream_options: { include_usage: true },
    messages: [{ role: 'developer', content: 'Be brief' }, { role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  } });
  assert.equal(good.statusCode, 200);
});

test('CLI failures become JSON/SSE errors without a successful stop chunk', async t => {
  const app = await buildServer({ logger: false, providers });
  t.after(() => app.close());
  for (const stream of [false, true]) {
    const result = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: payload('codex/default', stream, 'fail') });
    assert.equal(result.statusCode, stream ? 200 : 502);
    assert.match(result.body, /Authentication expired/);
    assert.ok(!result.body.includes('\u001b'));
    if (stream) {
      assert.ok(result.body.endsWith('data: [DONE]\n\n'));
      assert.ok(!result.body.includes('"finish_reason":"stop"'));
    }
  }
});

test('missing executable gives a meaningful 503', async t => {
  const app = await buildServer({ logger: false, providers: { ...providers, codex: new CodexRunner({ executable: 'missing-proxy-cli-123456' }) } });
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: payload('codex/default') });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, 'cli_not_found');
});

test('Antigravity parser handles fragmented events and rejects failed/truncated results', () => {
  const decoder = new AgyDecoder();
  assert.deepEqual(decoder.push('{"event":"res'), []);
  assert.deepEqual(decoder.push('ult","result":{"status":"SUCCESS","response":"hello"}}'), []);
  assert.deepEqual(decoder.finish(), ['hello']);
  assert.throws(() => new AgyDecoder().finish(), /without a result/);
  assert.throws(() => new AgyDecoder().push('{"event":"result","result":{"status":"ERROR","error":"login required"}}\n'), /login required/);
  assert.throws(() => new AgyDecoder().push('invalid\n'), /invalid stream-json/);
  assert.match(formatPrompt([{ role: 'user', content: 'literal </user>\n"quoted"' }]), /literal <\/user>/);
});

test('Antigravity interactive login fallback fails promptly', async t => {
  const app = await buildServer({ logger: false, providers, timeoutMs: 2000 });
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: payload('agy/default', false, 'auth-wait') });
  assert.equal(response.statusCode, 502);
  assert.equal(response.json().error.code, 'cli_authentication_error');
  assert.match(response.json().error.message, /Run agy interactively/);
});

async function waitForPids(path: string): Promise<{ parent: number; descendant: number }> {
  for (let i = 0; i < 100; i++) {
    try { return JSON.parse(await readFile(path, 'utf8')); } catch { await delay(30); }
  }
  throw new Error('Fixture did not start');
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function assertDead(pids: { parent: number; descendant: number }) {
  for (let i = 0; i < 100 && (alive(pids.parent) || alive(pids.descendant)); i++) await delay(30);
  assert.equal(alive(pids.parent), false, 'CLI parent is still alive');
  assert.equal(alive(pids.descendant), false, 'CLI descendant is still alive');
}

for (const mode of ['disconnect', 'timeout', 'shutdown']) {
  test(`${mode} kills the spawned CLI and its descendant`, { timeout: 15000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'cli-proxy-test-'));
    const marker = join(directory, 'pids.json');
    const app = await buildServer({ logger: false, providers, timeoutMs: mode === 'timeout' ? 1000 : 10_000 });
    let pids: { parent: number; descendant: number } | undefined;
    const abort = new AbortController();
    t.after(async () => {
      abort.abort();
      await app.close();
      if (pids) for (const pid of [pids.descendant, pids.parent]) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      await rm(directory, { recursive: true, force: true });
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const pending = fetch(`${address}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload('codex/default', mode !== 'timeout', `sleep:${marker}`)), signal: abort.signal,
    });
    // Attach a handler before cancelling fetch to avoid unhandled rejection races.
    void pending.catch(() => {});
    pids = await waitForPids(marker);
    if (mode === 'disconnect') {
      const response = await pending;
      assert.equal(response.status, 200);
      abort.abort();
    } else if (mode === 'shutdown') {
      const response = await pending;
      const body = response.text();
      await app.close();
      assert.match(await body, /server_shutdown/);
    } else {
      const response = await pending;
      assert.equal(response.status, 504);
      assert.equal((await response.json()).error.code, 'cli_timeout');
    }
    await assertDead(pids);
  });
}
