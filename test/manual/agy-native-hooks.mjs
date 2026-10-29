// Opt-in native integration experiment. Never run by npm test.
import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, lstat, realpath, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliEnvironment } from '../../dist/config.js';

const server = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
const pointer = join(server, '.tmp', 'agy-hook-smoke-latest.json');
const hash = data => createHash('sha256').update(data).digest('hex');
const inside = (parent, child) => { const r = relative(parent, child); return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)); };
async function manifest() {
  const m = JSON.parse(await readFile(pointer, 'utf8'));
  if (inside(server, m.root) || !inside(await realpath(tmpdir()), m.root) || !(await lstat(m.root)).isDirectory() || (await lstat(m.root)).isSymbolicLink() || await realpath(m.root) !== m.root || !m.root.includes('agy-hook-smoke-')) throw new Error('Unsafe experiment root');
  if (JSON.parse(await readFile(join(m.root, 'evidence', 'manifest.json'), 'utf8')).experiment !== m.experiment) throw new Error('Experiment identity mismatch');
  return m;
}
const operation = process.argv[2];
async function sanitizeNativeLog(path) {
  let text; try { text=await readFile(path,'utf8'); } catch { return []; }
  const observations=[];
  for(const line of text.split(/\r?\n/)) {
    const version=line.match(/Language server version:\s*([\d.]+)/); if(version)observations.push({languageServerVersion:version[1]});
    const hooks=line.match(/loaded (\d+) named hooks from (\d+) hooks.json file/); if(hooks)observations.push({loadedNamedHooks:Number(hooks[1]),hookConfigFiles:Number(hooks[2])});
    if(/hooks_manager|hook.*(?:failed|error)|(?:failed|error).*hook/i.test(line))observations.push({hookDiagnostic:true,source:line.match(/([\w-]+\.go:\d+)\]/)?.[1]??null,failed:/failed|error/i.test(line)});
    if(/not logged into Antigravity|Authentication required/i.test(line))observations.push({authenticationUnavailable:true});
    if(/Access is denied|forbidden by its access permissions/i.test(line))observations.push({sandboxAccessDenied:true});
  }
  const unique=[...new Map(observations.map(value=>[JSON.stringify(value),value])).values()];
  await writeFile(path.replace('.raw.log','.sanitized.json'),JSON.stringify(unique,null,2));
  await unlink(path);
  return unique;
}
if (operation === 'prepare') {
  const executable = await realpath(process.argv[3]);
  const root = await realpath(await mkdtemp(join(await realpath(tmpdir()), 'agy-hook-smoke-')));
  if (inside(server, root) || (await lstat(root)).isSymbolicLink()) throw new Error('Root must be external and canonical');
  for (const name of ['.agents', 'fixture', 'evidence']) await mkdir(join(root, name));
  await writeFile(join(root, 'fixture', 'sample.txt'), 'STARLIGHT_AGY_HOOK_TEST');
  const handler = `import {appendFile,lstat,realpath} from 'node:fs/promises';
import {dirname,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
try {
 const root=await realpath(join(dirname(fileURLToPath(import.meta.url)),'..'));
 const evidence=join(root,'evidence');
 if((await lstat(evidence)).isSymbolicLink() || await realpath(evidence)!==evidence) throw Error();
 const log=join(evidence,'hook-invocations.ndjson');
 try { if((await lstat(log)).isSymbolicLink()) throw Error(); } catch(e) { if(e.code!=='ENOENT') throw e; }
 let raw=''; for await(const chunk of process.stdin){raw+=chunk; if(raw.length>1048576) throw Error();}
 const input=JSON.parse(raw), tool=input.toolCall;
 const args=tool?.args;
 const target=args?.AbsolutePath??args?.TargetFile??args?.Cwd??args?.Path;
 const rel=typeof target==='string'?relative(root,target):null;
 const targetInside=rel!==null&&!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+(process.platform==='win32'?'\\\\':'/'));
 const record={at:new Date().toISOString(),event:tool?'PreToolUse':'lifecycle',toolName:typeof tool?.name==='string'&&/^[a-zA-Z0-9_.-]{1,100}$/.test(tool.name)?tool.name:null,argKeys:args&&typeof args==='object'?Object.keys(args).filter(k=>/^[a-zA-Z0-9_]{1,100}$/.test(k)).sort():[],argsSha256:args?createHash('sha256').update(JSON.stringify(args)).digest('hex'):null,targetInside,relativeTarget:targetInside?rel:null,handlerCwd:process.cwd(),workspaceMatches:Array.isArray(input.workspacePaths)&&input.workspacePaths.length===1&&await realpath(input.workspacePaths[0])===root,conversationHash:typeof input.conversationId==='string'?createHash('sha256').update(input.conversationId).digest('hex'):null,decision:'deny'};
 await appendFile(log,JSON.stringify(record)+String.fromCharCode(10),{mode:0o600});
} catch {}
console.log(JSON.stringify({decision:'deny'}));
`;
  await writeFile(join(root, '.agents', 'diagnostic-deny.mjs'), handler);
  const command = `"${(await realpath(process.execPath)).replaceAll('\\','/')}" diagnostic-deny.mjs`;
  const hooks = { 'agy-native-smoke-deny': { enabled: true, PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command, timeout: 10 }] }] } };
  const config = JSON.stringify(hooks, null, 2) + '\n';
  await writeFile(join(root, '.agents', 'hooks.json'), config);
  const m = { experiment: randomUUID(), created: new Date().toISOString(), root, realpath: root, external: !inside(server, root), executable, binarySha256: hash(await readFile(executable)), version: null, node: process.version, hookSha256: hash(config), sampleSha256: hash('STARLIGHT_AGY_HOOK_TEST'), hooks };
  await mkdir(dirname(pointer), { recursive: true });
  await writeFile(pointer, JSON.stringify(m, null, 2));
  await writeFile(join(root, 'evidence', 'manifest.json'), JSON.stringify(m, null, 2));
  console.log(JSON.stringify(m, null, 2));
} else if (operation === 'repair-diagnostic') {
  const m=await manifest();
  const node=(await realpath(process.execPath)).replaceAll('\\','/');
  const handlerPath=join(m.root,'.agents','diagnostic-deny.mjs');
  const script=handlerPath.replaceAll('\\','/');
  if(!/^[A-Za-z]:\/[A-Za-z0-9_./-]+$/.test(node) || !/^[A-Za-z]:\/[A-Za-z0-9_./-]+$/.test(script))throw new Error('This diagnostic workaround requires paths without spaces or shell characters');
  const previous=await readFile(join(m.root,'.agents','hooks.json'),'utf8');
  await writeFile(join(m.root,'evidence','hooks-before-repair.json'),previous,{flag:'wx'});
  const source=await readFile(handlerPath,'utf8');
  const repaired=source.replace("JSON.stringify(record)+'\\\\n'","JSON.stringify(record)+String.fromCharCode(10)");
  await writeFile(handlerPath,repaired);
  const hooks={'agy-native-smoke-deny':{enabled:true,PreToolUse:[{matcher:'.*',hooks:[{type:'command',command:`${node} ${script}`,timeout:10}]}]}};
  const config=JSON.stringify(hooks,null,2)+'\n';
  await writeFile(join(m.root,'.agents','hooks.json'),config);
  const revision={at:new Date().toISOString(),previousHash:hash(previous),currentHash:hash(config),hooks,reason:'Native Windows shell rejected quoted executable. Only disposable fixture changed; no production patch.'};
  await writeFile(join(m.root,'evidence','hook-revision.json'),JSON.stringify(revision,null,2));
  m.hookSha256=hash(config);m.hooks=hooks;
  await writeFile(pointer,JSON.stringify(m,null,2));await writeFile(join(m.root,'evidence','manifest.json'),JSON.stringify(m,null,2));
  console.log(JSON.stringify(revision,null,2));
} else if (operation === 'repair-evidence') {
  const m=await manifest(); const path=join(m.root,'.agents','diagnostic-deny.mjs');
  const before=await readFile(path,'utf8');
  const after=before.replace('args?.AbsolutePath??args?.TargetFile??args?.Cwd;', 'args?.AbsolutePath??args?.TargetFile??args?.Cwd??args?.Path;').split('\n').map(line=>line.includes('await appendFile(log,')?' await appendFile(log,JSON.stringify(record)+String.fromCharCode(10),{mode:0o600});':line).join('\n');
  await writeFile(path,after);
  await writeFile(join(m.root,'evidence','handler-evidence-revision.json'),JSON.stringify({at:new Date().toISOString(),before:hash(before),after:hash(after),reason:'Record native Path argument as well as documented AbsolutePath; normalize evidence newline. Deny decision unchanged.'},null,2));
  console.log(JSON.stringify({evidenceInstrumentationOnly:true,decision:'deny'}));
} else if (operation === 'headless') {
  const m = await manifest();
  const label = process.argv[3];
  if (!['A1','A2','B'].includes(label)) throw new Error('Unknown gate');
  if (existsSync(join(m.root,'evidence',`${label}.json`))) throw new Error('Attempt already recorded; never silently rerun inference');
  const target = join(m.root, 'fixture', label === 'B' ? 'should-not-exist.txt' : 'sample.txt');
  const prompt = label === 'B'
    ? `Controlled disposable workspace test. Use exactly one write_to_file tool call to create ${JSON.stringify(target)} with content AGY_DENY_SENTINEL. Do not use terminal, shell, artifacts, external paths or other tools. If denied, stop immediately and report denial; never retry or bypass it.`
    : `Controlled disposable workspace test. You MUST attempt exactly one real view_file tool call with AbsolutePath ${JSON.stringify(target)}. Do not guess or infer its content. Do not use terminal, shell, search, artifacts, external paths or other tools. If denied, stop immediately and report denial; never retry or bypass it.${label === 'A2' ? ' This is the second and final attempt: invoke the actual view_file tool, not a textual description or simulated tool call.' : ''}`;
  const rawLog=join(m.root,'evidence',`${label}-cli.raw.log`);
  const args = ['--add-dir',m.root,'--model','gemini-3.8-flash-medium','--print',prompt,'--print-timeout','180s','--output-format','stream-json','--log-file',rawLog];
  const events = [], steps = {}, stderrFlags = new Set(); let pending='', stderrBytes=0, resultSeen=false, timedOut=false;
  const start = Date.now();
  const child = spawn(m.executable,args,{cwd:m.root,env:cliEnvironment('agy'),shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const pid=child.pid;
  const line = raw => {
    let e; try { e=JSON.parse(raw); } catch { return; }
    const record={event:typeof e.event==='string'?e.event:'unknown',keys:Object.keys(e)};
    if(e.event==='init') {
      record.initKeys=Object.keys(e.init??{}); record.cwd=e.init?.cwd; record.cwdMatches=e.init?.cwd===m.root;
      record.permissionMode=e.init?.permission_mode??e.permission_mode??null;
      record.tools=Array.isArray(e.init?.tools)?e.init.tools.map(t=>typeof t==='string'?t:t?.name).filter(Boolean):null;
      record.model=e.init?.model??null;
      record.conversationHash=typeof e.conversation_id==='string'?hash(e.conversation_id):null;
      record.version=e.init?.version??null;
    }
    if(e.event==='step_update') { const type=e.step_update?.step_type??'unknown'; steps[type]=(steps[type]??0)+1; record.stepType=type; record.stepKeys=Object.keys(e.step_update??{}); if(type==='tool'){record.toolName=e.step_update.tool_name;record.toolState=e.step_update.state;record.toolInfoKeys=Object.keys(e.step_update.tool_info??{});const toolText=JSON.stringify(e.step_update.tool_info??{});record.hookDenied=/denied|deny/i.test(toolText);record.hookFailed=/hook.*failed|exit status 1/i.test(toolText);record.quotedExecutableFailed=/reconhecido|not recognized/i.test(toolText);} }
    if(e.event==='result') { resultSeen=true; record.status=e.result?.status; record.responseChars=typeof e.result?.response==='string'?e.result.response.length:0; record.usage=e.result?.usage??null; record.resultKeys=Object.keys(e.result??{}); record.errorPresent=!!e.result?.error; }
    if(events.length<3000) events.push(record);
  };
  child.stdout.on('data',chunk=>{pending+=chunk;const lines=pending.split('\n');pending=lines.pop()??'';for(const l of lines)line(l);});
  child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;const s=chunk.toString();for(const flag of ['permission','denied','hook','authentication','model','error','timeout'])if(s.toLowerCase().includes(flag))stderrFlags.add(flag);});
  const kill = () => new Promise(resolveKill=>execFile('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true},()=>resolveKill()));
  const timer=setTimeout(()=>{timedOut=true;void kill();},210000);
  const result = await new Promise(resolveExit=>{child.once('error',e=>resolveExit({spawnError:e.code}));child.once('close',(code,signal)=>resolveExit({code,signal}));});
  clearTimeout(timer); if(pending.trim())line(pending);
  let hookCalls=[];try{hookCalls=(await readFile(join(m.root,'evidence','hook-invocations.ndjson'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch{}
  const evidence={experiment:m.experiment,label,processCwd:m.root,cliSha256AtEnd:hash(await readFile(m.executable)),hookSha256:hash(await readFile(join(m.root,'.agents','hooks.json'))),args:args.map((a,i)=>i===5?'<fixture-only prompt>':a),pid,...result,timedOut,durationMs:Date.now()-start,resultSeen,steps,stderrBytes,stderrFlags:[...stderrFlags],nativeLog:await sanitizeNativeLog(rawLog),events,hookCalls,sampleIntact:hash(await readFile(join(m.root,'fixture','sample.txt')))===m.sampleSha256,sentinelExists:existsSync(join(m.root,'fixture','should-not-exist.txt'))};
  await writeFile(join(m.root,'evidence',`${label}.json`),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence,null,2));
} else if(operation==='interactive') {
  const m=await manifest();
  const rawLog=join(m.root,'evidence',`interactive-${Date.now()}-cli.raw.log`);
  const args=['--add-dir',m.root,'--model','gemini-3.8-flash-medium','--log-file',rawLog];
  if(process.argv[3]==='read')args.push('--prompt-interactive',`Controlled disposable workspace test. Attempt exactly one real file-reading tool for ${join(m.root,'fixture','sample.txt')}. Do not use shell, other tools, artifacts or external paths. If denied stop and report denial. Do not guess contents.`);
  const child=spawn(m.executable,args,{cwd:m.root,env:{...cliEnvironment('agy'),TERM:'xterm-256color'},shell:false,windowsHide:true,stdio:'inherit'});
  const timer=setTimeout(()=>execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>{}),180000);
  child.once('close',async()=>{clearTimeout(timer);await sanitizeNativeLog(rawLog);});
} else if(operation==='summarize') {
  const m=await manifest();
  const a=JSON.parse(await readFile(join(m.root,'evidence','A2.json'),'utf8'));
  const conversation=a.events.find(e=>e.event==='init')?.conversationHash;
  const calls=a.hookCalls.filter(c=>c.conversationHash===conversation&&c.toolName==='read_file'&&c.decision==='deny');
  const path=join(m.root,'fixture','sample.txt');
  const expected=[path,path.replaceAll('\\','/')].map(Path=>hash(JSON.stringify({Path})));
  const summary={gate:'A',interactiveDiscovery:existsSync(join(m.root,'evidence','interactive-discovery.json')),headlessCwdMatches:a.events.find(e=>e.event==='init')?.cwdMatches,permissionMode:a.events.find(e=>e.event==='init')?.permissionMode,matchingNativeCalls:calls,expectedTargetHashMatched:calls.length>0&&calls.every(c=>expected.includes(c.argsSha256)),toolErrors:a.events.filter(e=>e.stepType==='tool'),sampleIntact:a.sampleIntact};
  await writeFile(join(m.root,'evidence','gate-A-summary.json'),JSON.stringify(summary,null,2));
  console.log(JSON.stringify(summary,null,2));
} else if(operation==='status') {
  const m=await manifest();
  const hookPresent=existsSync(join(m.root,'.agents','hooks.json'));
  console.log(JSON.stringify({root:m.root,external:!inside(server,m.root),canonical:await realpath(m.root)===m.root,notSymlink:!(await lstat(m.root)).isSymbolicLink(),hookPresent,hookHashMatches:hookPresent?hash(await readFile(join(m.root,'.agents','hooks.json')))===m.hookSha256:null,sampleIntact:hash(await readFile(join(m.root,'fixture','sample.txt')))===m.sampleSha256,sentinelExists:existsSync(join(m.root,'fixture','should-not-exist.txt')),evidence:await readdir(join(m.root,'evidence'))},null,2));
} else throw new Error('Usage: prepare ABSOLUTE_AGY_PATH | interactive | headless A1|A2|B | status');
