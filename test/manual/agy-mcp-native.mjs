// Opt-in discovery/correlation probe. Never run by npm test. No production activation.
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, unlink, lstat, realpath } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { cliEnvironment, SERVER_ROOT } from '../../dist/config.js';

const manifest = JSON.parse(await readFile(join(SERVER_ROOT, '.tmp/agy-stage22.json'), 'utf8'));
const root = manifest.root, executable = 'C:/Users/fedet/AppData/Local/agy/bin/agy.exe';
const hash = data => createHash('sha256').update(data).digest('hex');
const rel = relative(await realpath(tmpdir()), root);
if (isAbsolute(rel) || rel.startsWith('..') || !root.includes('agy-stage22-') || (await lstat(root)).isSymbolicLink() || await realpath(root) !== root) throw Error('Unsafe fixture');
const label = process.argv[2] ?? 'inheritance';
if (!/^[a-z-]+$/.test(label)) throw Error('Invalid label');
const evidence = join(root, 'evidence'); await mkdir(evidence, { recursive: true });
const output = join(evidence, `${label}.json`), log = join(evidence, `${label}.ndjson`);
if (existsSync(output)) throw Error('Attempt already recorded');
async function stable() { if (hash(await readFile(executable)).toLowerCase() !== manifest.binarySha256.toLowerCase()) throw Error('AGY binary changed; stop experiment'); }
await stable();
const agents = join(root, '.agents'); await mkdir(agents, { recursive: true });
const config = join(agents, 'mcp_config.json'), hooks = join(agents, 'hooks.json');
if (existsSync(config) || existsSync(hooks)) throw Error('Existing configuration; inspect instead of replacing');
const token = randomBytes(32).toString('hex'), nonce = randomBytes(12).toString('hex');
const credential = join(SERVER_ROOT, '.tmp', `mcp-native-${nonce}.json`);
await writeFile(credential, JSON.stringify({ token }), { flag: 'wx', mode: 0o600 });
const serverPath = join(root, `echo-${label}.mjs`);
await writeFile(serverPath, `import {readFileSync,appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {timingSafeEqual,createHash} from 'node:crypto';
const expected=JSON.parse(readFileSync(${JSON.stringify(credential)},'utf8')).token;
const digest=x=>createHash('sha256').update(x).digest();
const authenticated=timingSafeEqual(digest(process.env.CLI_PROXY_MCP_POC_TOKEN??''),digest(expected));
const log=x=>appendFileSync(${JSON.stringify(log)},JSON.stringify({at:new Date().toISOString(),...x})+'\\n');
log({phase:'mcp-start',pid:process.pid,parent:process.ppid,cwd:process.cwd(),credentialInherited:authenticated});
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of lines){try{const m=JSON.parse(line);log({phase:'mcp-request',method:m.method,paramKeys:Object.keys(m.params??{}),metaKeys:Object.keys(m.params?._meta??{}),clientName:m.method==='initialize'?m.params?.clientInfo?.name:null});if(m.id===undefined)continue;
let result;
if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,serverInfo:{name:'proxy-echo-fixture',version:'1.0.0'},capabilities:{tools:{}}};
else if(m.method==='ping')result={};
else if(m.method==='tools/list')result={tools:authenticated?[{name:'echo_fixture',description:'Return a harmless fixture nonce. No filesystem or process access.',annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},inputSchema:{type:'object',properties:{nonce:{type:'string'}},required:['nonce'],additionalProperties:false}}]:[]};
else if(m.method==='tools/call'&&authenticated&&m.params?.name==='echo_fixture'&&m.params?.arguments?.nonce===${JSON.stringify(nonce)}){log({phase:'echo-called',nonceMatches:true,metaKeys:Object.keys(m.params?._meta??{})});result={content:[{type:'text',text:'ECHO:'+m.params.arguments.nonce}],isError:false};}
else{console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Unauthorized or unsupported fixture operation'}}));continue;}
console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));}catch{log({phase:'invalid-json'});}}
`);
const hookPath = join(agents, 'deny-native.mjs');
await writeFile(hookPath, `import {appendFileSync} from 'node:fs';let raw='';let allowed=false;for await(const c of process.stdin)raw+=c;try{const p=JSON.parse(raw),a=p.toolCall?.args??{};let args=a.Arguments;try{if(typeof args==='string')args=JSON.parse(args);}catch{}allowed=['roundtrip','readonly'].includes(${JSON.stringify(label)})&&p.toolCall?.name==='call_mcp_tool'&&a.ServerName==='proxy-echo-fixture'&&a.ToolName==='echo_fixture'&&args?.nonce===${JSON.stringify(nonce)}&&Object.keys(args).length===1;appendFileSync(${JSON.stringify(log)},JSON.stringify({phase:'native-pretool',name:p.toolCall?.name,argKeys:Object.keys(a),argumentType:typeof a.Arguments,workspaceCount:p.workspacePaths?.length,exactFixtureValidated:allowed})+'\\n');}catch{}console.log(JSON.stringify({decision:allowed?'allow':'deny'}));`);
await writeFile(config, JSON.stringify({ mcpServers: { 'proxy-echo-fixture': { command: realpathSync(process.execPath), args: [serverPath], cwd: root, timeoutSeconds: 30 } } }, null, 2));
await writeFile(hooks, JSON.stringify({ 'proxy-poc-deny': { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: `${realpathSync(process.execPath).replaceAll('\\', '/')} deny-native.mjs`, timeout: 10 }] }] } }, null, 2));
let child, timer, monitor, raw = '', chain = Promise.resolve();
const result = { label, binarySha256: manifest.binarySha256, events: [], stderrBytes: 0, nonce, configurationContainsToken: (await readFile(config, 'utf8')).includes(token), outcome: 'BLOCKED' };
try {
  const rawLog = join(evidence, `${label}.raw.log`);
  child = spawn(executable, ['--add-dir', root, '--model', 'gemini-3.8-flash-medium', '--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands', '--log-file', rawLog], { cwd: root, env: { ...cliEnvironment('agy'), CLI_PROXY_MCP_POC_TOKEN: token }, shell: false, windowsHide: true });
  const kill = () => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  timer = setTimeout(() => { result.timeout = true; kill(); }, 240000);
  monitor = setInterval(() => { void stable().catch(() => { result.binaryChanged = true; kill(); }); }, 2000);
  child.stdout.on('data', c => { raw += c; const lines = raw.split('\n'); raw = lines.pop() ?? ''; for (const line of lines) chain = chain.then(async () => { let e; try { e = JSON.parse(line); } catch { return; } if (e.event === 'init') result.events.push({ event: 'init', cwdMatches: resolve(e.init?.cwd ?? '') === root, tools: e.init?.tools, conversationHash: hash(e.conversation_id ?? '') }); if (e.event === 'step_update' && e.step_update?.step_type === 'tool') result.events.push({ event: 'tool', name: e.step_update.tool_name, state: e.step_update.state, errorFlags: Object.fromEntries(['permission','denied','approval','not found','disconnected','timeout','hook','not connected','unsupported'].map(word=>[word,JSON.stringify(e.step_update.tool_info??{}).toLowerCase().includes(word)])) }); if (e.event === 'result') { result.events.push({ event: 'result', status: e.result?.status, echoInResponse: String(e.result?.response).includes('ECHO:' + nonce) }); child.stdin.end(); } }); });
  child.stderr.on('data', c => result.stderrBytes += c.length); child.stdin.on('error', () => {});
  child.stdin.write(JSON.stringify({ event: 'user', message: { content: `Controlled disposable test: call the MCP tool echo_fixture from proxy-echo-fixture exactly once with nonce ${nonce}. Use no file, shell, browser, artifacts or other tools. Stop on a denial. Report only the exact returned result. Do not invent a result if the tool is unavailable.` } }) + '\n');
  result.exit = await new Promise(r => { child.on('error', e => r({ error: e.code })); child.on('close', code => r({ code })); }); await chain;
  let nativeLog = ''; try { nativeLog = await readFile(rawLog, 'utf8'); } catch {}
  result.versions = [...new Set([...nativeLog.matchAll(/Language server version:\s*([\d.]+)/g)].map(x => x[1]))];
  result.mcpLogFlags = { discovered: /proxy-echo-fixture/.test(nativeLog), mcpError: /(?:error|failed).*mcp|mcp.*(?:error|failed)/i.test(nativeLog) };
  if (existsSync(rawLog)) await unlink(rawLog);
  const records = existsSync(log) ? (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse) : [];
  result.authenticatedMcp = records.some(r => r.phase === 'mcp-start' && r.credentialInherited);
  result.toolsListed = records.some(r => r.method === 'tools/list');
  result.echoCalled = records.some(r => r.phase === 'echo-called' && r.nonceMatches);
  result.outcome = result.authenticatedMcp && result.toolsListed && result.echoCalled && result.events.some(e => e.echoInResponse) ? 'PASS' : 'BLOCKED';
} finally {
  clearTimeout(timer); clearInterval(monitor);
  for (const path of [config, hooks, credential]) if (existsSync(path)) await unlink(path);
  await stable(); result.cleaned = !existsSync(config) && !existsSync(hooks) && !existsSync(credential);
  await writeFile(output, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
}
