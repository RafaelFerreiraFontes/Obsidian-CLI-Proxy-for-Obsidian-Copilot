// Real OpenCode client against a local HTTP fixture, NOT a Gemini/MCP acceptance test.
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { SERVER_ROOT, cliEnvironment } from '../../dist/config.js';

const manifest = JSON.parse(await readFile(join(SERVER_ROOT, '.tmp/agy-stage22.json'), 'utf8'));
const rel = relative(await realpath(tmpdir()), manifest.root);
if (isAbsolute(rel) || rel.startsWith('..') || await realpath(manifest.root) !== manifest.root) throw Error('Unsafe fixture');
const label = process.argv[2] ?? 'stdin-retry'; if (!/^[a-z-]+$/.test(label)) throw Error('Invalid label');
const root = join(manifest.root, 'opencode-provider', label); if (existsSync(root)) throw Error('Existing evidence'); await mkdir(root, { recursive: true });
const readMode = label.startsWith('read-'), fixturePath = join(root, 'fixture.txt');
const fixtureContent = 'OPENCODE_READ_' + randomBytes(12).toString('hex');
if (readMode) await writeFile(fixturePath, fixtureContent);
const evidence = { fixtureOnly: true, nativeGemini: false, requests: [], outcome: 'BLOCKED' };
const key = randomBytes(32).toString('hex');
const server = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) { raw += chunk; if (raw.length > 4 * 1024 * 1024) { response.writeHead(413).end(); return; } }
  if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
  let body; try { body = JSON.parse(raw); } catch { response.writeHead(400).end(); return; }
  const returned = body.messages?.find(m => m.role === 'tool' && m.tool_call_id === 'fixture_read_call');
  evidence.requests.push({ authorizationMatches: request.headers.authorization === `Bearer ${key}`, workspaceMatches: request.headers['x-proxy-workspace'] === 'fixture', profileMatches: request.headers['x-proxy-profile'] === 'agy', modelMatches: body.model === 'agy/gemini-3.8-flash-medium', toolCount: body.tools?.length ?? 0, toolSchemas: body.tools?.map(t => ({ name: t.function?.name, argumentKeys: Object.keys(t.function?.parameters?.properties ?? {}) })), toolResultReceived: Boolean(returned), exactFixtureRead: Boolean(returned && JSON.stringify(returned.content).includes(fixtureContent)) });
  // Observed OpenCode 2.2.0 contract: read uses path (not filePath).
  const readTool = body.tools?.find(t => t.function?.name === 'read' && t.function.parameters?.properties?.path?.type === 'string');
  // Only the optional read probe can ask for a tool: the exact disposable file.
  const callRead = readMode && readTool && !returned;
  const delta = callRead ? { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture_read_call', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: fixturePath }) } }] } : { role: 'assistant', content: 'PROVIDER_FIXTURE_OK' };
  const chunk = { id: 'fixture_response', object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: body.model, choices: [{ index: 0, delta, finish_reason: null }] };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: callRead ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const config = { $schema: 'https://opencode.ai/config.json', autoupdate: false, provider: { 'antigravity-cli-proxy': { npm: '@ai-sdk/openai-compatible', name: 'Disposable proxy fixture', options: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: '{env:LOCAL_PROXY_KEY}', headers: { 'X-Proxy-Workspace': 'fixture', 'X-Proxy-Profile': 'agy' } }, models: { 'agy/gemini-3.8-flash-medium': { name: 'Gemini proxy fixture' } } } } };
const configFile = join(root, 'opencode.json'); await writeFile(configFile, JSON.stringify(config, null, 2));
let child, timer;
try {
  child = spawn('C:/Users/fedet/.opencode/bin/opencode.exe', ['run', '--standalone', '--model', 'antigravity-cli-proxy/agy/gemini-3.8-flash-medium', '--format', 'json', readMode ? `Read only ${fixturePath}. Do not write files or execute commands.` : 'Return the fixture greeting. Do not use any tools.'], { cwd: root, shell: false, windowsHide: true, env: { ...cliEnvironment(), OPENCODE_CONFIG: configFile, LOCAL_PROXY_KEY: key, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache') } });
  child.stdin.end(); // OpenCode consumes piped input through EOF before running.
  let output = '', stderr = '';
  child.stdout.on('data', c => { output = (output + c).slice(-65536); }); child.stderr.on('data', c => { stderr = (stderr + c).slice(-65536); });
  timer = setTimeout(() => { evidence.timeout = true; execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {}); }, 90000);
  evidence.exitCode = await new Promise(resolve => { child.once('error', e => resolve(e.code)); child.once('close', resolve); });
  evidence.outputMatched = output.includes('PROVIDER_FIXTURE_OK'); evidence.stderrBytes = Buffer.byteLength(stderr);
  evidence.configError = /invalid.*config|unrecognized|unknown.*(?:provider|npm)|configuration.*error/i.test(stderr);
  evidence.outcome = evidence.outputMatched && evidence.requests.some(r => r.authorizationMatches && r.workspaceMatches && r.profileMatches && r.modelMatches) && (!readMode || evidence.requests.some(r => r.exactFixtureRead)) ? 'PASS' : 'BLOCKED';
} finally { clearTimeout(timer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await writeFile(join(root, 'result.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2)); }
