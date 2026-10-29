// Gate C only. Uses real registry/bridge/handler without removing the production guard.
import { readFile, writeFile, unlink, mkdir, realpath, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { AgyWorkspaceRegistry } from '../../dist/agy-workspaces.js';
import { HookCredentialLease } from '../../dist/hook-credentials.js';
import { createAgyApprovalBridge } from '../../dist/providers/agy-approval-bridge.js';
import { readConfig, authenticate, executionContext, cliEnvironment } from '../../dist/config.js';

const server=await realpath(join(dirname(fileURLToPath(import.meta.url)),'../..'));
const m=JSON.parse(await readFile(join(server,'.tmp/agy-hook-smoke-latest.json'),'utf8'));
const under=(parent,child)=>{const r=relative(parent,child);return r===''||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+(process.platform==='win32'?'\\':'/')));};
if(under(server,m.root)||!under(await realpath(tmpdir()),m.root)||(await lstat(m.root)).isSymbolicLink()||await realpath(m.root)!==m.root)throw Error('Unsafe fixture');
const evidence=join(m.root,'evidence');
if(existsSync(join(evidence,'C.json')))throw Error('Gate C already recorded');
const a=JSON.parse(await readFile(join(evidence,'gate-A-summary.json'),'utf8'));
const b=JSON.parse(await readFile(join(evidence,'B.json'),'utf8'));
const bConversation=b.events.find(e=>e.event==='init')?.conversationHash;
const bCalls=b.hookCalls.filter(c=>c.conversationHash===bConversation&&/write/.test(c.toolName??'')&&c.decision==='deny'&&c.targetInside&&c.relativeTarget.replaceAll('\\','/')==='fixture/should-not-exist.txt');
if(!a.expectedTargetHashMatched||!a.matchingNativeCalls.length||!a.toolErrors.some(e=>e.hookDenied)||b.sentinelExists||!b.sampleIntact||!bCalls.length||!b.events.some(e=>e.stepType==='tool'&&e.toolState==='ERROR'&&e.hookDenied))throw Error('Gates A and B must pass natively before Gate C');
const hash=data=>createHash('sha256').update(data).digest('hex');
const configPath=join(m.root,'.agents/hooks.json');
const diagnostic=await readFile(configPath,'utf8');
if(hash(diagnostic)!==m.hookSha256||Object.keys(JSON.parse(diagnostic)).join()!=='agy-native-smoke-deny')throw Error('Diagnostic configuration changed');
await writeFile(join(evidence,'diagnostic-hooks-final.json'),diagnostic,{flag:'wx'});
const key=randomBytes(32).toString('hex');
const config=readConfig({PROXY_API_KEY:key,PROXY_WORKSPACES:JSON.stringify({smoke:m.root}),PROXY_DEFAULT_WORKSPACE:'smoke'});
const context=executionContext(config,authenticate(config,`Bearer ${key}`),'smoke','agy','agy/gemini-3.8-flash-medium');
const registry=new AgyWorkspaceRegistry(join(server,'.tmp',`agy-native-registration-${m.experiment}`));
const controller=new AbortController();let bridge,lease,child,registered=false,timer;
const result={experiment:m.experiment,isolatedProof:true,productionGuardUnchanged:true,workspace:m.root,identity:'temporary-authenticated-test',bridgeRequests:[],events:[],ready:false,quotedExecutableFailed:false,sentinelExists:false};
let processing=Promise.resolve(),pending='';
try {
  await unlink(configPath); // Exactly the diagnostic entry created by this experiment.
  const plan=registry.planInstall(context);
  await writeFile(join(evidence,'proxy-install-plan.json'),JSON.stringify(plan,null,2));
  await registry.install(context,plan.consent);registered=true;registry.verify(context);
  const installed=await readFile(configPath,'utf8');
  result.hookSha256=hash(installed);result.integrityVerified=true;result.registeredEntry=JSON.parse(installed);
  bridge=await createAgyApprovalBridge({model:'gemini-3.8-flash-medium',prompt:'fixture read',context,signal:controller.signal,approvalTimeoutMs:30000,onApproval:async action=>{result.bridgeRequests.push({toolName:action.action.split('\n')[0],actionHash:hash(action.action),workspaceMatches:action.cwd===context.workingDirectory,decision:'deny'});return false;}},()=>registry.verify(context),true);
  if(installed.includes(bridge.env.CLI_PROXY_HOOK_TOKEN)||installed.includes(key))throw Error('Credential persisted in workspace');
  result.noWorkspaceTokens=true;
  lease=new HookCredentialLease(context,{url:bridge.env.CLI_PROXY_HOOK_URL,token:bridge.env.CLI_PROXY_HOOK_TOKEN});
  const args=['--add-dir',m.root,'--model','gemini-3.8-flash-medium','--input-format','stream-json','--output-format','stream-json','--disable-slash-commands'];
  child=spawn(m.executable,args,{cwd:m.root,env:{...cliEnvironment('agy'),...bridge.env},shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
  result.pid=child.pid;result.args=args;
  const kill=()=>new Promise(resolveKill=>execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true},()=>resolveKill()));
  timer=setTimeout(()=>{if(!bridge.isReady()){result.startupTimeout=true;controller.abort();void kill();}},45000);
  const onLine=async raw=>{
    let e;try{e=JSON.parse(raw);}catch{return;}
    if(e.event==='init'){result.events.push({event:'init',cwd:e.init?.cwd,cwdMatches:e.init?.cwd===m.root,permissionMode:e.init?.permission_mode,conversationHash:hash(e.conversation_id)});await lease.register(e.conversation_id,e.init?.cwd);}
    if(e.event==='step_update'&&e.step_update?.step_type==='tool'){const info=JSON.stringify(e.step_update.tool_info??{});result.events.push({event:'tool',toolName:e.step_update.tool_name,state:e.step_update.state,hookDenied:/denied|deny/i.test(info),quotedExecutableFailed:/reconhecido|not recognized/i.test(info)});}
    if(e.event==='result'){result.events.push({event:'result',status:e.result?.status,responseChars:e.result?.response?.length??0});child.stdin.end();}
  };
  child.stdout.on('data',chunk=>{pending+=chunk;const lines=pending.split('\n');pending=lines.pop()??'';for(const line of lines)processing=processing.then(()=>onLine(line));processing.catch(()=>{result.protocolValidationFailed=true;controller.abort();void kill();});});
  child.stderr.on('data',chunk=>{const text=chunk.toString();if(/reconhecido|not recognized/i.test(text))result.quotedExecutableFailed=true;result.stderrBytes=(result.stderrBytes??0)+chunk.length;});
  child.stdin.on('error',()=>{});
  child.stdin.write(JSON.stringify({event:'user',message:{content:`Controlled disposable workspace test. Attempt exactly one real file read for ${join(m.root,'fixture','sample.txt')}. Do not use shell, other tools, artifacts or external paths. If denied stop; never bypass the hook.`}})+'\n');
  result.exit=await new Promise(resolveExit=>{child.once('error',e=>resolveExit({error:e.code}));child.once('close',(code,signal)=>resolveExit({code,signal}));});
  await processing;
  result.ready=bridge.isReady();
  result.outcome=result.ready&&result.bridgeRequests.length?'PASS':'BLOCKED';
} catch(error) { result.outcome='BLOCKED';result.errorCode=error.code??'experiment_error'; }
finally {
  clearTimeout(timer);controller.abort();
  try{await bridge?.close();}finally{await lease?.close();}
  if(registered){await registry.remove(context,registry.planRemove(context).consent);result.registrationRemoved=true;}
  else if(!existsSync(configPath))await writeFile(configPath,diagnostic);
  result.sentinelExists=existsSync(join(m.root,'fixture','should-not-exist.txt'));
  result.sampleIntact=hash(await readFile(join(m.root,'fixture/sample.txt')))===m.sampleSha256;
  result.activeWorkspaceHooks=existsSync(configPath);
  await writeFile(join(evidence,'C.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}
