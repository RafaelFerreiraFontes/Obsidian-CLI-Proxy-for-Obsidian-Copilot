// Opt-in Windows/native experiment; never invoked by npm test. No production bypass.
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { readFile, writeFile, appendFile, mkdir, mkdtemp, lstat, unlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgyWorkspaceRegistry } from '../../dist/agy-workspaces.js';
import { HookCredentialLease } from '../../dist/hook-credentials.js';
import { createAgyApprovalBridge } from '../../dist/providers/agy-approval-bridge.js';
import { readConfig, authenticate, executionContext, cliEnvironment, SERVER_ROOT } from '../../dist/config.js';

const pointer = join(SERVER_ROOT, '.tmp/agy-launcher-211.json');
const hash = data => createHash('sha256').update(data).digest('hex');
const binary = 'C:\\Users\\fedet\\AppData\\Local\\agy\\bin\\agy.exe';
const operation = process.argv[2];
const node = realpathSync(process.execPath).replaceAll('\\', '/');
if (!/^[A-Za-z]:\/[A-Za-z0-9_./-]+$/.test(node)) throw Error('Experiment requires canonical Node without shell characters');
if (operation === 'prepare') {
  const base = realpathSync(await mkdtemp(join(realpathSync(tmpdir()), 'agy-launcher-211-')));
  const root = join(base, 'workspace com espaços 世界');
  for (const dir of [root, join(root, '.agents'), join(root, 'fixture'), join(base, 'evidence')]) await mkdir(dir);
  await writeFile(join(root, 'fixture/sample.txt'), 'AGY_211_DISPOSABLE');
  const m = { id: randomUUID(), base, root, binary, binarySha256: hash(await readFile(binary)), node, created: new Date().toISOString() };
  await mkdir(join(SERVER_ROOT, '.tmp'), { recursive: true });
  await writeFile(pointer, JSON.stringify(m, null, 2));
  await writeFile(join(base, 'evidence/manifest.json'), JSON.stringify(m, null, 2));
  console.log(JSON.stringify(m));
  process.exit(0);
}
const m = JSON.parse(await readFile(pointer, 'utf8'));
const rel = relative(realpathSync(tmpdir()), m.base);
if (isAbsolute(rel) || rel.startsWith('..') || !m.base.includes('agy-launcher-211-') || (await lstat(m.base)).isSymbolicLink() || realpathSync(m.root) !== m.root) throw Error('Unsafe fixture');
const evidence = join(m.base, 'evidence');
const configPath = join(m.root, '.agents/hooks.json');
async function stable() { if (existsSync(join(evidence, 'VERSION_CHANGED.json'))) throw Error('AGY version changed; experiment invalidated'); if (hash(await readFile(binary)) !== m.binarySha256) { await writeFile(join(evidence, 'BINARY_CHANGED.json'), JSON.stringify({ at: new Date().toISOString(), expected: m.binarySha256, actual: hash(await readFile(binary)) })); throw Error('AGY binary changed; experiment invalidated'); } }
await stable();
if (existsSync(join(evidence, 'BINARY_CHANGED.json'))) throw Error('Invalidated experiment');
if (operation === 'pin-version') {
  if (!/^\d+\.\d+\.\d+$/.test(process.argv[3] ?? '') || m.version) throw Error('Version must be observed once in the interactive banner');
  m.version = process.argv[3];
  await writeFile(pointer, JSON.stringify(m, null, 2)); await writeFile(join(evidence, 'manifest.json'), JSON.stringify(m, null, 2));
  await writeFile(join(evidence, 'interactive-observation.json'), JSON.stringify({ version: m.version, model: 'gemini-3.8-flash-medium', hookTypes: 5, workspaceHookDiscovered: 'agy-211-diagnostic', preToolUseHooks: 1, togglesOrEdits: false, credentialsOmitted: true }, null, 2));
  process.exit(0);
}
if (operation === 'summarize') {
  const load = async name => JSON.parse(await readFile(join(evidence, `${name}.json`), 'utf8'));
  const rows = [];
  for (const name of ['quoted-node-auth', 'relative', 'absolute', 'single-quoted', 'absolute-spaces', 'backslashes']) {
    const r = await load(name);
    const log = (await readFile(join(evidence, `${name}.ndjson`), 'utf8')).trim().split('\n').map(JSON.parse);
    const native = log.slice(log.findIndex(x => x.phase === 'direct-end') + 1);
    rows.push({ name, command: r.command, nativeLauncherStarted: native.some(x => x.phase === 'launcher-start'), nativeInputCorrelated: native.some(x => x.phase === 'stdin-json' && x.conversationHash === r.events.find(e => e.event === 'init')?.conversationHash), hookDenied: r.events.some(e => e.hookDenied), hookFailed: r.events.some(e => e.hookFailed), code: r.exit.code });
  }
  const permutations = keys => keys.length ? keys.flatMap((key, i) => permutations(keys.filter((_, j) => j !== i)).map(rest => [key, ...rest])) : [[]];
  function expectedRequest(request, name, content) {
    return [join(m.root, 'fixture', name), join(m.root, 'fixture', name).replaceAll('\\', '/')].some(Path => [ { Content: content, Path }, { Content: content, Overwrite: false, Path } ].some(args => permutations(Object.keys(args)).some(order => hash('write_file\n' + JSON.stringify(Object.fromEntries(order.map(k => [k, args[k]])), null, 2)) === request?.actionHash)));
  }
  const c = await load('c-native');
  const cLog = (await readFile(join(evidence, 'c-native.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  const conversation = c.native.events.find(e => e.event === 'init')?.conversationHash;
  const correlated = cLog.some(x => x.phase === 'stdin-json' && x.tool === 'write_file' && x.conversationHash === conversation && x.workspaceMatches) && cLog.some(x => x.phase === 'bridge-attempt' && x.endpoint === '/approve') && cLog.some(x => x.phase === 'approval-received');
  const d1 = correlated && c.ready && c.requests.length === 1 && c.requests[0].decision === 'deny' && c.requests[0].workspaceMatches && expectedRequest(c.requests[0], 'denied-native.txt', 'AGY_211_DENIED') && !existsSync(join(m.root, 'fixture/denied-native.txt')) && c.cleaned;
  const d2 = existsSync(join(evidence, 'd2-native.json')) ? await load('d2-native') : null;
  const d2Pass = d2?.requests.length === 2 && d2.requests[0].decision === 'approve' && d2.requests[0].sentinelAbsentBeforeDecision && d2.requests[0].sentinelAbsentAtDecision && d2.sentinelObserved?.approved && !d2.sentinelObserved?.decisionPending && d2.approvedContentMatches && !d2.secondSentinelExists && d2.requests[1].decision === 'deny' && expectedRequest(d2.requests[0], 'approved-native.txt', 'AGY_211_HUMAN_APPROVED') && expectedRequest(d2.requests[1], 'second-native.txt', 'AGY_211_SECOND_DENIED');
  const summary = { experiment: m.id, binaryVersion: m.version, binarySha256: m.binarySha256, rows, gates: { C: correlated && c.ready ? 'PASS' : 'BLOCKED', D1: d1 ? 'PASS' : 'BLOCKED', D2: d2Pass ? 'PASS' : 'BLOCKED' }, d1ExpectedActionHashMatched: expectedRequest(c.requests[0], 'denied-native.txt', 'AGY_211_DENIED'), productionExternalStillBlocked: true, openAITools: 'BLOCKED', sampleIntact: await readFile(join(m.root, 'fixture/sample.txt'), 'utf8') === 'AGY_211_DISPOSABLE', noActiveWorkspaceHooks: !existsSync(configPath), noManagedLauncher: !existsSync(join(m.root, '.agents/obsidian-cli-proxy-launcher.mjs')), rawLogs: (await readdir(evidence)).filter(n => n.endsWith('.raw.log')) };
  await writeFile(join(evidence, 'summary.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary, null, 2)); process.exit(0);
}
if (operation === 'interactive') {
  const child = spawn(binary, ['--add-dir', m.root, '--model', 'gemini-3.8-flash-medium'], { cwd: m.root, env: { ...cliEnvironment('agy'), TERM: 'xterm-256color' }, stdio: 'inherit', shell: false, windowsHide: true });
  const timer = setTimeout(() => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {}), 120000);
  const monitor = setInterval(() => { void stable().catch(() => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})); }, 2000);
  await new Promise(r => child.on('close', r)); clearTimeout(timer); clearInterval(monitor); await stable(); process.exit(0);
}
if (operation === 'matrix-rest') {
  for (const name of ['absolute', 'single-quoted', 'absolute-spaces', 'backslashes']) {
    await stable();
    const child = spawn(process.execPath, [resolve('test/manual/agy-launcher-windows.mjs'), 'matrix', name], { stdio: 'inherit', windowsHide: true, shell: false });
    const code = await new Promise(r => child.on('close', r));
    if (code !== 0) throw Error('Matrix case failed to complete');
  }
  process.exit(0);
}
const label = process.argv[4] ?? process.argv[3] ?? operation;
if (!/^[a-z0-9-]+$/.test(label)) throw Error('Unsafe label');
const resultPath = join(evidence, `${label}.json`);
if (existsSync(resultPath)) throw Error('Attempt already recorded');
const logPath = join(evidence, `${label}.ndjson`);
const record = value => appendFile(logPath, JSON.stringify({ at: new Date().toISOString(), test: label, ...value }) + '\n');
// Instrumentation is generated only inside this disposable workspace. No raw payloads.
const observer = `import {appendFileSync,existsSync,realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const log=${JSON.stringify(logPath)};
const digest=x=>createHash('sha256').update(x).digest('hex');
const record=x=>appendFileSync(log,JSON.stringify({at:new Date().toISOString(),test:${JSON.stringify(label)},...x})+'\\n');
record({phase:'launcher-start',node:process.version,execPath:process.execPath,cwd:process.cwd(),argv:process.argv.slice(1),parentPid:process.ppid,handlerFound:existsSync(${JSON.stringify(join(SERVER_ROOT, 'dist/approval-hook.js'))})});
try{const p=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command','Get-CimInstance Win32_Process -Filter "ProcessId = '+process.ppid+'" | Select-Object Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress'],{encoding:'utf8',windowsHide:true}));record({phase:'dispatcher-parent',name:p.Name,executable:p.ExecutablePath,cmdSlashC:/\\/c\\b/i.test(p.CommandLine??'')});}catch{record({phase:'dispatcher-parent',category:'unavailable'});}
const iterate=process.stdin[Symbol.asyncIterator].bind(process.stdin);
process.stdin[Symbol.asyncIterator]=async function*(){let raw='';for await(const chunk of {[Symbol.asyncIterator]:iterate}){raw+=chunk;yield chunk;}try{const p=JSON.parse(raw);record({phase:'stdin-json',valid:true,tool:p.toolCall?.name??null,argKeys:Object.keys(p.toolCall?.args??{}),argsHash:digest(JSON.stringify(p.toolCall?.args??{})),conversationHash:digest(p.conversationId??''),workspaceMatches:Array.isArray(p.workspacePaths)&&p.workspacePaths.length===1&&realpathSync(p.workspacePaths[0])===${JSON.stringify(m.root)}});}catch{record({phase:'stdin-json',valid:false});}};
const fetchOriginal=globalThis.fetch;
globalThis.fetch=async function(url,options){record({phase:'bridge-attempt',endpoint:new URL(url).pathname});try{const response=await fetchOriginal(url,options);let outcome={};try{const body=await response.clone().json();outcome={approved:body.approved===true?true:body.approved===false?false:null,ready:body.ready===true};}catch{}record({phase:'bridge-response',status:response.status,...outcome});return response;}catch(e){record({phase:'bridge-failure',category:e.cause?.code??e.name});throw e;}};
`;
async function runNode(args, payload, env = {}) {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(node, args, { cwd: join(m.root, '.agents'), env: { ...cliEnvironment('agy'), ...env }, shell: false, windowsHide: true });
    let out = '', err = ''; child.stdout.on('data', c => out += c); child.stderr.on('data', c => err += c);
    child.on('error', reject); child.on('close', code => resolveRun({ code, stdout: out.trim(), stderrBytes: Buffer.byteLength(err) }));
    child.stdin.end(payload);
  });
}
async function native(prompt, onInit = async () => {}) {
  await stable();
  const rawLog = join(evidence, `${label}.raw.log`);
  const args = ['--add-dir', m.root, '--model', 'gemini-3.8-flash-medium', '--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands', '--log-file', rawLog];
  const child = spawn(binary, args, { cwd: m.root, env: cliEnvironment('agy'), shell: false, windowsHide: true });
  await record({ phase: 'native-spawn', pid: child.pid, cwd: m.root, model: 'gemini-3.8-flash-medium' });
  const result = { args, processCwd: m.root, events: [], stderrBytes: 0, timedOut: false, binaryChanged: false };
  const kill = () => new Promise(r => execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => r()));
  let pending = '', processing = Promise.resolve();
  const timer = setTimeout(() => { result.timedOut = true; void kill(); }, operation === 'human' ? 540000 : 210000);
  const monitor = setInterval(() => { void stable().catch(() => { result.binaryChanged = true; void kill(); }); }, 2000);
  async function line(raw) {
    let e; try { e = JSON.parse(raw); } catch { return; }
    if (e.event === 'init') { const init = { event: 'init', cwd: e.init?.cwd, model: e.init?.model, version: e.init?.version, conversationHash: hash(e.conversation_id ?? '') }; result.events.push(init); await record({ phase: 'native-init', ...init }); await onInit(e.conversation_id, e.init?.cwd); }
    if (e.event === 'step_update' && e.step_update?.step_type === 'tool') {
      const info = JSON.stringify(e.step_update.tool_info ?? {});
      result.events.push({ event: 'tool', name: e.step_update.tool_name, state: e.step_update.state, hookDenied: /denied|deny/i.test(info), hookFailed: /hook.*failed|exit status/i.test(info), quotedExecutableFailed: /reconhecido|not recognized/i.test(info) });
      await record({ phase: 'native-tool', ...result.events.at(-1) });
    }
    if (e.event === 'result') { result.events.push({ event: 'result', status: e.result?.status, responseChars: e.result?.response?.length ?? 0 }); child.stdin.end(); }
  }
  child.stdout.on('data', c => { pending += c; const lines = pending.split('\n'); pending = lines.pop() ?? ''; for (const l of lines) processing = processing.then(() => line(l)); processing.catch(() => { result.protocolError = true; void kill(); }); });
  child.stderr.on('data', c => { result.stderrBytes += c.length; });
  child.stdin.on('error', () => {});
  child.stdin.write(JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n');
  result.exit = await new Promise(r => { child.on('error', e => r({ error: e.code })); child.on('close', (code, signal) => r({ code, signal })); });
  clearTimeout(timer); clearInterval(monitor); await processing;
  let raw = ''; try { raw = await readFile(rawLog, 'utf8'); } catch {}
  result.nativeLog = [...new Set(raw.split(/\r?\n/).flatMap(l => {
    const version = l.match(/Language server version:\s*([\d.]+)/); if (version) return [`version:${version[1]}`];
    const loaded = l.match(/loaded (\d+) named hooks from (\d+) hooks.json file/); if (loaded) return [`loaded:${loaded[1]}:${loaded[2]}`];
    if (/hooks_manager|hook.*(?:failed|error)/i.test(l)) return [`hook:${l.match(/([\w-]+\.go:\d+)\]/)?.[1] ?? 'unknown'}:${/failed|error/i.test(l) ? 'failure' : 'observed'}`];
    if (/not logged into Antigravity|Authentication required/i.test(l)) return ['authentication-unavailable'];
    return [];
  }))];
  if (existsSync(rawLog)) await unlink(rawLog);
  const versions = result.nativeLog.filter(x => x.startsWith('version:')).map(x => x.slice(8));
  if (m.version && versions.some(v => v !== m.version)) await writeFile(join(evidence, 'VERSION_CHANGED.json'), JSON.stringify({ at: new Date().toISOString(), expected: m.version, observed: versions }));
  await stable();
  return result;
}
if (operation === 'matrix') {
  const script = join(m.root, '.agents/diagnostic.mjs');
  await writeFile(script, observer + `let raw='';for await(const chunk of process.stdin)raw+=chunk;console.log(JSON.stringify({decision:'deny'}));`);
  const simple = join(m.base, 'diagnostic-absolute.mjs');
  await writeFile(simple, await readFile(script));
  const commands = {
    'quoted-node': `"${node}" diagnostic.mjs`,
    'relative': `${node} diagnostic.mjs`,
    'single-quoted': `'${node}' diagnostic.mjs`,
    'absolute': `${node} ${simple.replaceAll('\\', '/')}`,
    'absolute-spaces': `${node} "${script.replaceAll('\\', '/')}"`,
    'backslashes': `${node.replaceAll('/', '\\')} diagnostic.mjs`,
  };
  const command = commands[process.argv[3]];
  if (!command) throw Error('Unknown matrix case');
  await writeFile(configPath, JSON.stringify({ 'agy-211-diagnostic': { enabled: true, PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command, timeout: 10 }] }] } }, null, 2));
  try {
    const direct = await runNode(['diagnostic.mjs', 'fixture "quoted" argument'], JSON.stringify({ conversationId: randomUUID(), workspacePaths: [m.root], toolCall: { name: 'read_file', args: { Path: join(m.root, 'fixture/sample.txt') } } }));
    await record({ phase: 'direct-end' });
    const result = await native(`Controlled disposable test. Attempt exactly one real view_file call for ${JSON.stringify(join(m.root, 'fixture/sample.txt'))}. No shell, other tools, artifacts, external paths, retries or bypass. On hook denial or error stop immediately and report it.`);
    await writeFile(resultPath, JSON.stringify({ command, direct, ...result }, null, 2));
    console.log(JSON.stringify({ label, ...result }));
  } finally { await unlink(configPath); }
} else if (operation === 'proof' || operation === 'direct' || operation === 'human') {
  if (existsSync(configPath)) throw Error('Existing hook config; inspect first');
  const key = randomBytes(32).toString('hex');
  const config = readConfig({ PROXY_API_KEY: key, PROXY_WORKSPACES: JSON.stringify({ smoke: m.root }) });
  const context = executionContext(config, authenticate(config, `Bearer ${key}`), 'smoke', 'agy', 'agy/gemini-3.8-flash-medium');
  class DiagnosticRegistry extends AgyWorkspaceRegistry {
    launcher() { return observer + `record({phase:'handler-invoke'});\n` + super.launcher() + `\nrecord({phase:'handler-imported'});\n`; }
  }
  const registry = new DiagnosticRegistry(join(m.base, 'private-registry'));
  const controller = new AbortController(); let bridge, lease, installed = false;
  const result = { productionGuardUnchanged: true, requests: [] };
  let decisionPending = false;
  async function approval(action) {
    const r = { tool: action.action.split('\n')[0], actionHash: hash(action.action), workspaceMatches: action.cwd === m.root, decision: 'deny' };
    result.requests.push(r); await record({ phase: 'approval-received', ...r });
    if (operation !== 'human' || result.requests.length !== 1) return false;
    const args = JSON.parse(action.action.slice(action.action.indexOf('\n') + 1));
    const target = join(m.root, 'fixture/approved-native.txt');
    if (r.tool !== 'write_file' || !r.workspaceMatches || typeof args.Path !== 'string' || resolve(args.Path) !== target || args.Content !== 'AGY_211_HUMAN_APPROVED' || existsSync(target)) throw Error('Unexpected operation; operator approval unavailable');
    r.sentinelAbsentBeforeDecision = true; decisionPending = true;
    console.log(JSON.stringify({ HUMAN_APPROVAL_REQUIRED: true, actionHash: r.actionHash, tool: r.tool, workspace: m.root, target, content: args.Content, overwrite: args.Overwrite ?? null, pending: true }));
    const approved = await new Promise(resolveDecision => {
      const timer = setTimeout(() => finish(false, 'approval-timeout'), 240000);
      let input = '';
      const receive = chunk => { input += chunk; if (input.includes('\n')) finish(input.trim() === `approve:${r.actionHash}`, 'operator-stdin'); };
      function finish(value, source) { r.decisionSource = source; clearTimeout(timer); process.stdin.off('data', receive); process.stdin.pause(); resolveDecision(value); }
      process.stdin.on('data', receive); process.stdin.resume();
    });
    decisionPending = false; r.decision = approved ? 'approve' : 'deny'; r.decidedAt = new Date().toISOString();
    r.sentinelAbsentAtDecision = !existsSync(target);
    await record({ phase: 'operator-decision', ...r });
    return approved === true && r.sentinelAbsentAtDecision;
  }
  let watch;
  try {
    const plan = registry.planInstall(context); await writeFile(join(evidence, `${label}-plan.json`), JSON.stringify(plan, null, 2));
    await registry.install(context, plan.consent); installed = true; registry.verify(context);
    result.hooks = JSON.parse(await readFile(configPath, 'utf8')); result.integrityVerified = true;
    result.fingerprints = {};
    for (const [name, path] of Object.entries({ handler: registry.handlerPath, readyHandler: registry.readyHandlerPath, credentials: join(SERVER_ROOT, 'dist/hook-credentials.js'), launcher: join(m.root, '.agents/obsidian-cli-proxy-launcher.mjs') })) result.fingerprints[name] = hash(await readFile(path));
    bridge = await createAgyApprovalBridge({ model: 'gemini-3.8-flash-medium', prompt: '', context, signal: controller.signal, onApproval: approval }, () => registry.verify(context), true);
    lease = new HookCredentialLease(context, { url: bridge.env.CLI_PROXY_HOOK_URL, token: bridge.env.CLI_PROXY_HOOK_TOKEN });
    result.bridgeAccessible = (await fetch(bridge.env.CLI_PROXY_HOOK_URL, { method: 'POST', body: '{}' })).status === 403;
    if ((await readFile(configPath, 'utf8')).includes(bridge.env.CLI_PROXY_HOOK_TOKEN)) throw Error('Token in workspace config');
    result.noWorkspaceTokens = true;
    if (operation === 'direct') {
      const id = randomUUID(); await lease.register(id, m.root);
      const payload = { conversationId: id, workspacePaths: [m.root], toolCall: { name: 'write_file', args: { Path: join(m.root, 'fixture/denied-direct.txt'), Content: 'AGY_211_DIRECT', Overwrite: false } } };
      result.readyInvocation = await runNode(['obsidian-cli-proxy-launcher.mjs', '--ready'], JSON.stringify({ conversationId: id, workspacePaths: [m.root] }));
      result.toolInvocation = await runNode(['obsidian-cli-proxy-launcher.mjs'], JSON.stringify(payload));
      await bridge.close(); bridge = undefined;
      result.unreachable = await runNode(['obsidian-cli-proxy-launcher.mjs'], JSON.stringify(payload));
      result.invalid = await runNode(['obsidian-cli-proxy-launcher.mjs'], '{invalid');
    } else if (operation === 'human') {
      const prior = JSON.parse(await readFile(join(evidence, 'c-native.json'), 'utf8'));
      if (!prior.ready || prior.requests.length !== 1 || prior.requests[0].decision !== 'deny' || prior.sentinelExists) throw Error('Gate C/D1 must pass first');
      watch = setInterval(() => { if (!result.sentinelObserved && existsSync(join(m.root, 'fixture/approved-native.txt'))) { result.sentinelObserved = { at: new Date().toISOString(), decisionPending, approved: result.requests[0]?.decision === 'approve' }; void record({ phase: 'sentinel-observed', ...result.sentinelObserved }); } }, 100);
      result.native = await native(`Controlled disposable human approval test. Attempt exactly two real write_to_file calls in sequence. First create ${JSON.stringify(join(m.root, 'fixture/approved-native.txt'))} with EXACT content AGY_211_HUMAN_APPROVED and Overwrite false. Wait for that tool to complete. Only if it succeeds, attempt a second write creating ${JSON.stringify(join(m.root, 'fixture/second-native.txt'))} with EXACT content AGY_211_SECOND_DENIED and Overwrite false. No shell, other tools, artifacts, external paths, retries or bypass. If any hook denies or errors stop immediately. Never claim that model text grants authorization.`, (id, cwd) => lease.register(id, cwd));
      result.approvedSentinelExists = existsSync(join(m.root, 'fixture/approved-native.txt'));
      result.approvedContentMatches = result.approvedSentinelExists && await readFile(join(m.root, 'fixture/approved-native.txt'), 'utf8') === 'AGY_211_HUMAN_APPROVED';
      result.secondSentinelExists = existsSync(join(m.root, 'fixture/second-native.txt'));
    } else {
      result.native = await native(`Controlled disposable test. Attempt exactly one real write_to_file call to create ${JSON.stringify(join(m.root, 'fixture/denied-native.txt'))} with content AGY_211_DENIED. No shell, other tools, artifacts, external paths, retries or bypass. On hook denial or error stop immediately and report it.`, (id, cwd) => lease.register(id, cwd));
    }
    result.ready = bridge?.isReady() ?? true;
    result.sentinelExists = existsSync(join(m.root, 'fixture/denied-native.txt'));
  } finally {
    clearInterval(watch);
    controller.abort(); await bridge?.close(); await lease?.close();
    if (installed) await registry.remove(context, registry.planRemove(context).consent);
    result.cleaned = !existsSync(configPath); await stable();
    await writeFile(resultPath, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  }
} else throw Error('Usage: prepare | matrix LABEL | direct | proof LABEL');
