import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { buildServer, TEST_KEY } from './helpers.js';
import { AgyRunner } from '../src/providers/agy-runner.js';
import { CodexRunner } from '../src/providers/codex-runner.js';
import { AGY_FALLBACK_MODELS, ModelCatalog, parseAgyModels } from '../src/models.js';
import { APPROVAL_TOOL, approvalDecision } from '../src/sessions.js';
import type { ChatCompletionRequest, ChatMessage, OpenAITool } from '../src/types.js';
import type { CliRunner } from '../src/providers/base.js';

const fixture = fileURLToPath(new URL('./fixtures/cli.mjs', import.meta.url));
const config = { executable: process.execPath, prefixArgs: [fixture] };
const providers = { codex: new CodexRunner(config), agy: new AgyRunner(config) };
const expectedCodexIds = ['codex/gpt-6.1-sol', 'codex/gpt-6-astra', 'codex/gpt-6-sol', 'codex/gpt-6-luna', 'codex/gpt-5.6-sol', 'codex/gpt-5.6-terra', 'codex/gpt-5.6-luna'];
const post = (app: Awaited<ReturnType<typeof buildServer>>, body: ChatCompletionRequest, authorization = `Bearer ${TEST_KEY}`) => app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization }, payload: body });
const request = (model: string, text: string, stream = false): ChatCompletionRequest => ({ model, messages: [{ role: 'user', content: text }], stream });
const assistantFrom = (body: string, stream: boolean): ChatMessage => {
  if (!stream) return JSON.parse(body).choices[0].message;
  const events = body.split('\n\n').filter(frame => frame.startsWith('data: {')).map(frame => JSON.parse(frame.slice(6)));
  return { role: 'assistant', content: events.map(event => event.choices?.[0].delta.content ?? '').join('') };
};

test('model table parser ignores diagnostics/headers and deduplicates IDs', () => {
  assert.deepEqual(parseAgyModels('\x20Model ID Display Name\nFetching available models...\nmodel-id   Name\ngemini-4-argon-high    Gemini 4 Argon (High)\r\nclaude-opus-5-5-low\tClaude Opus\ngemini-4-argon-high   Duplicate\n---\nError: failed\n'), ['gemini-4-argon-high', 'claude-opus-5-5-low']);
});

test('native AGY_BIN discovery parses stdout and sends the models subcommand', async () => {
  assert.deepEqual(await providers.agy.listModels(AbortSignal.timeout(2000)), ['gemini-4-argon-high', 'claude-opus-5-5-medium']);
});

test('catalog coalesces requests, uses TTL and retains PROXY_MODELS extras', async () => {
  let calls = 0;
  const runner: CliRunner = { async *run() {}, async listModels() { calls++; await delay(10); return ['custom-discovered']; } };
  const catalog = new ModelCatalog(runner, ['codex/my-custom', 'agy/default'], 20);
  const results = await Promise.all([catalog.list(), catalog.list(), catalog.list()]);
  assert.equal(calls, 1);
  assert.ok(results.every(ids => ids.includes('agy/custom-discovered') && ids.includes('codex/my-custom')));
  assert.equal(results[0]!.filter(id => id === 'agy/default').length, 1);
  await catalog.list();
  assert.equal(calls, 1);
  await delay(30);
  await catalog.list();
  assert.equal(calls, 2);
  catalog.close();
});

test('discovery failure, unavailable CLI and empty output fall back to all 13 AGY models', async t => {
  for (const agy of [
    { async *run() {}, async listModels() { throw new Error('not authenticated'); } },
    { async *run() {}, async listModels() { return []; } },
    new AgyRunner({ executable: 'missing-agy-model-discovery-12345' }),
  ]) {
    const app = await buildServer({ logger: false, providers: { ...providers, agy } });
    t.after(() => app.close());
    const result = await app.inject('/v1/models');
    assert.equal(result.statusCode, 200);
    const ids = result.json().data.map((model: { id: string }) => model.id);
    for (const id of [...expectedCodexIds, ...AGY_FALLBACK_MODELS.map(id => `agy/${id}`)]) assert.ok(ids.includes(id), id);
    assert.equal(ids.filter((id: string) => id.startsWith('codex/')).length, 8);
    assert.equal(ids.filter((id: string) => id.startsWith('agy/')).length, 14);
  }
});

test('PROXY_MODELS environment remains supported', async t => {
  const prior = process.env.PROXY_MODELS;
  process.env.PROXY_MODELS = 'codex/env-custom,agy/env-custom';
  t.after(() => { if (prior === undefined) delete process.env.PROXY_MODELS; else process.env.PROXY_MODELS = prior; });
  const app = await buildServer({ logger: false, providers });
  t.after(() => app.close());
  const ids = (await app.inject('/v1/models')).json().data.map((model: { id: string }) => model.id);
  assert.ok(ids.includes('codex/env-custom') && ids.includes('agy/env-custom'));
});

test('unlisted IDs pass through unchanged; advertised Codex IDs normalize case', async t => {
  const app = await buildServer({ logger: false, providers });
  t.after(() => app.close());
  for (const [model, expected] of [['codex/unlisted-model', 'unlisted-model'], ['agy/CaseSensitive-Custom', 'CaseSensitive-Custom'], ['codex/GPT-6.1-Sol', 'gpt-6.1-sol']]) {
    const response = await post(app, request(model!, 'hello'));
    assert.equal(response.statusCode, 200);
    assert.match(response.json().choices[0].message.content, new RegExp(expected!));
  }
});

for (const provider of ['codex', 'agy']) {
  test(`${provider}: rejected model maps to model_not_found for JSON and SSE`, async t => {
    const app = await buildServer({ logger: false, providers });
    t.after(() => app.close());
    for (const stream of [false, true]) {
      const response = await post(app, request(`${provider}/invalid-model`, 'hello', stream));
      assert.equal(response.statusCode, stream ? 200 : 404);
      assert.match(response.body, /model_not_found/);
      if (!stream) assert.equal(response.json().error.param, 'model');
      else assert.ok(response.body.endsWith('data: [DONE]\n\n') && !response.body.includes('"finish_reason":"stop"'));
    }
  });
  for (const stream of [false, true]) {
    for (const decision of ['aprovar', 'negar']) {
      test(`${provider}: ${stream ? 'SSE' : 'JSON'} approval -> ${decision} -> one scoped result`, async t => {
        const directory = await mkdtemp(join(tmpdir(), 'proxy-approval-'));
        const marker = join(directory, 'executed.txt');
        const app = await buildServer({ logger: false, providers });
        t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
        const original = request(`${provider}/default`, `approval:${marker}`, stream);
        const first = await post(app, original);
        assert.equal(first.statusCode, 200);
        const assistant = assistantFrom(first.body, stream);
        assert.match(String(assistant.content), /Solicitação de Permissão de Execução/);
        assert.match(String(assistant.content), /echo approved/);
        await assert.rejects(readFile(marker), /ENOENT/);
        const continuation = { ...original, messages: [...original.messages, assistant, { role: 'user', content: decision } as ChatMessage] };
        const response = await post(app, continuation);
        assert.equal(response.statusCode, 200);
        assert.match(String(assistantFrom(response.body, stream).content), decision === 'aprovar' ? /Executed approved action/ : /Action denied/);
        if (decision === 'aprovar') assert.equal(await readFile(marker, 'utf8'), 'executed');
        else await assert.rejects(readFile(marker), /ENOENT/);
        const replay = await post(app, { ...continuation, stream: false });
        assert.equal(replay.statusCode, 410);
      });
    }
  }
}

test('file-edit authorization includes the proposed diff before allowing execution', async t => {
  const app = await buildServer({ logger: false, providers });
  t.after(() => app.close());
  const body = request('codex/default', 'edit-approval');
  const first = await post(app, body);
  assert.match(first.json().choices[0].message.content, /note.md/);
  assert.match(first.json().choices[0].message.content, /updated text/);
  const response = await post(app, { ...body, messages: [...body.messages, first.json().choices[0].message, { role: 'user', content: 'não' }] });
  assert.match(response.json().choices[0].message.content, /denied/);
});

test('approval aliases are exact, accent-insensitive, and never inferred from prose', () => {
  for (const text of ['aprovar', ' ALLOW ', 'y', 'sim']) assert.equal(approvalDecision(text), true);
  for (const text of ['negar', 'deny', 'n', 'não', 'nao']) assert.equal(approvalDecision(text), false);
  for (const text of ['yes please', 'sim; rm -rf', 'true', 'approve everything']) assert.equal(approvalDecision(text), undefined);
});

test('pending sessions reject cross-conversation/model/identity approvals and can repeat the prompt', async t => {
  const app = await buildServer({ logger: false, providers });
  t.after(() => app.close());
  const body = request('codex/default', 'approval');
  const first = (await post(app, body)).json().choices[0].message;
  const reply: ChatCompletionRequest = { ...body, messages: [...body.messages, first, { role: 'user', content: 'sim' }] };
  assert.equal((await post(app, { ...reply, model: 'codex/other' })).statusCode, 409);
  assert.equal((await post(app, reply, 'Bearer unrelated')).statusCode, 401);
  assert.equal((await post(app, { ...reply, messages: [{ role: 'user', content: 'different conversation' }, first, { role: 'user', content: 'sim' }] })).statusCode, 409);
  const undecided: ChatCompletionRequest = { ...body, messages: [...body.messages, first, { role: 'user', content: 'Explain that?' }] };
  const reminder = (await post(app, undecided)).json().choices[0].message;
  assert.match(reminder.content, /Solicitação/);
  const denied = await post(app, { ...body, messages: [...undecided.messages, reminder, { role: 'user', content: 'deny' }] });
  assert.match(denied.json().choices[0].message.content, /denied/);
  assert.equal((await post(app, request('codex/default', 'sim'))).statusCode, 409);
});

test('pending approvals expire without running the action; shutdown cleans held processes', async t => {
  const app = await buildServer({ logger: false, providers, approvalTimeoutMs: 50 });
  t.after(() => app.close());
  const body = request('codex/default', 'approval');
  const first = (await post(app, body)).json().choices[0].message;
  await delay(150);
  const response = await post(app, { ...body, messages: [...body.messages, first, { role: 'user', content: 'aprovar' }] });
  assert.equal(response.statusCode, 410);
  await app.close();
});

const tools: OpenAITool[] = [{ type: 'function', function: { name: 'read_note', description: 'Read an Obsidian note', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];
test('Codex tools are accepted and unsupported Antigravity tools fail explicitly', async t => {
  const app = await buildServer({ logger: false, providers });
  t.after(() => app.close());
  for (const provider of ['codex', 'agy']) {
    assert.equal((await post(app, { ...request(`${provider}/default`, 'hello'), tools })).statusCode, provider === 'codex' ? 200 : 400);
  }
});

test('Codex dynamic tool call -> OpenAI tool_calls -> role:tool -> continued output', async t => {
  const app = await buildServer({ logger: false, providers });
  t.after(() => app.close());
  const body = { ...request('codex/default', 'tool'), tools };
  const first = (await post(app, body)).json();
  assert.equal(first.choices[0].finish_reason, 'tool_calls');
  const assistant = first.choices[0].message;
  const call = assistant.tool_calls[0];
  assert.equal(call.function.name, 'read_note');
  assert.deepEqual(JSON.parse(call.function.arguments), { path: 'note.md' });
  const response = await post(app, { ...body, messages: [...body.messages, assistant, { role: 'tool', tool_call_id: call.id, content: 'Note contents' }] });
  assert.match(response.json().choices[0].message.content, /Tool returned: Note contents/);
});

test('native approval tool returns tool_calls and requires an explicit approved boolean', async t => {
  const app = await buildServer({ logger: false, providers });
  t.after(() => app.close());
  const approvalTool: OpenAITool = { type: 'function', function: { name: APPROVAL_TOOL, parameters: { type: 'object' } } };
  const body = { ...request('codex/default', 'approval'), tools: [approvalTool] };
  const first = (await post(app, body)).json();
  assert.equal(first.choices[0].finish_reason, 'tool_calls');
  const assistant = first.choices[0].message;
  const call = assistant.tool_calls[0];
  const response = await post(app, { ...body, messages: [...body.messages, assistant, { role: 'tool', tool_call_id: call.id, content: '{"approved":false}' }] });
  assert.match(response.json().choices[0].message.content, /Action denied/);
});

test('approval hook denies when bridge credentials are absent', async () => {
  const hook = fileURLToPath(new URL('../src/approval-hook.js', import.meta.url));
  const child = spawn(process.execPath, [hook], { windowsHide: true, env: { ...process.env, CLI_PROXY_HOOK_URL: '', CLI_PROXY_HOOK_TOKEN: '' } });
  child.stdin.end('{}');
  let output = '';
  for await (const chunk of child.stdout) output += chunk.toString();
  assert.equal(JSON.parse(output).decision, 'deny');
});

test('approval applies to exactly one action; the next command needs a new decision', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'proxy-two-approvals-'));
  const marker = join(directory, 'action');
  const app = await buildServer({ logger: false, providers });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const body = request('codex/default', `approval-two:${marker}`);
  const first = (await post(app, body)).json().choices[0].message;
  const approval: ChatCompletionRequest = { ...body, messages: [...body.messages, first, { role: 'user', content: 'aprovar' }] };
  const second = (await post(app, approval)).json().choices[0].message;
  assert.equal(await readFile(`${marker}-1`, 'utf8'), 'executed');
  await assert.rejects(readFile(`${marker}-2`), /ENOENT/);
  assert.match(second.content, /echo second command/);
  await post(app, { ...body, messages: [...approval.messages, second, { role: 'user', content: 'negar' }] });
  await assert.rejects(readFile(`${marker}-2`), /ENOENT/);
});

test('SSE tool_calls round trip accepts assistant tool messages without content', async t => {
  const app = await buildServer({ logger: false, providers });
  t.after(() => app.close());
  const body = { ...request('codex/default', 'tool', true), tools };
  const first = await post(app, body);
  const chunks = first.body.split('\n\n').filter(frame => frame.startsWith('data: {')).map(frame => JSON.parse(frame.slice(6)));
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
  const delta = chunks.find(chunk => chunk.choices[0].delta.tool_calls)?.choices[0].delta.tool_calls[0];
  assert.ok(delta);
  const { index: _index, ...call } = delta;
  const response = await post(app, { ...body, stream: false, messages: [...body.messages, { role: 'assistant', tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: 'SSE tool result' }] });
  assert.equal(response.statusCode, 200);
  assert.match(response.json().choices[0].message.content, /SSE tool result/);
});

test('an unreachable approval bridge denies instead of granting access', async () => {
  const hook = fileURLToPath(new URL('../src/approval-hook.js', import.meta.url));
  const child = spawn(process.execPath, [hook], { windowsHide: true, env: { ...process.env, CLI_PROXY_HOOK_URL: 'http://127.0.0.1:1/approve', CLI_PROXY_HOOK_TOKEN: 'invalid-test-token' } });
  child.stdin.end('{}');
  let output = '';
  for await (const chunk of child.stdout) output += chunk.toString();
  assert.equal(JSON.parse(output).decision, 'deny');
});
