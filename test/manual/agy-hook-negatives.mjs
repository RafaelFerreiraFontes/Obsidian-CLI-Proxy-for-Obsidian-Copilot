// Isolated filesystem/protocol negatives. These do not prove AGY-native hooks.
import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile, rename, mkdir, rmdir, realpath, lstat } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { AgyWorkspaceRegistry } from '../../dist/agy-workspaces.js';
import { AgyRunner } from '../../dist/providers/agy-runner.js';
import { readConfig, authenticate, executionContext, validateExecution, SERVER_ROOT } from '../../dist/config.js';

const m=JSON.parse(await readFile('.tmp/agy-hook-smoke-latest.json','utf8'));
const rel=relative(await realpath(tmpdir()),m.root);
if(isAbsolute(rel)||rel.startsWith('..')||(await lstat(m.root)).isSymbolicLink()||await realpath(m.root)!==m.root)throw Error('Unsafe experiment root');
const root=join(m.root,'negative-fixtures');await mkdir(root);
const results=[];
async function scenario(name,run){try{await run();results.push({name,status:'PASS',source:'fixture-preflight-or-handler-protocol',nativeAGY:false});}catch(error){results.push({name,status:'FAIL',code:error.code??'assertion',nativeAGY:false});}}
const key=randomBytes(32).toString('hex');
const config=readConfig({PROXY_API_KEY:key,PROXY_WORKSPACES:JSON.stringify({negative:root})});
const auth=authenticate(config,`Bearer ${key}`);
const context=executionContext(config,auth,'negative','agy','agy/gemini-3.8-flash-medium');
const handler=join(root,'handler.mjs');await copyFile(join(SERVER_ROOT,'dist/approval-hook.js'),handler);
const registry=new AgyWorkspaceRegistry(join(SERVER_ROOT,'.tmp',`agy-negative-registration-${m.experiment}`),handler);
await registry.install(context,registry.planInstall(context).consent);
const hooks=join(root,'.agents/hooks.json'),launcher=join(root,'.agents/obsidian-cli-proxy-launcher.mjs');
async function absent(path,run){const backup=path+'.fixture-backup';await rename(path,backup);try{await run();}finally{await rename(backup,path);}}
async function changed(path,data,run){const original=await readFile(path);await writeFile(path,data);try{await run();}finally{await writeFile(path,original);}}
const rejects=()=>assert.throws(()=>registry.verify(context));
try {
  await scenario('hook absent',()=>absent(hooks,async()=>rejects()));
  await scenario('hook disabled',async()=>{const data=JSON.parse(await readFile(hooks,'utf8'));data['obsidian-cli-proxy-approval'].enabled=false;await changed(hooks,JSON.stringify(data),async()=>rejects());});
  await scenario('hook invalid JSON',()=>changed(hooks,'{invalid',async()=>rejects()));
  await scenario('launcher absent',()=>absent(launcher,async()=>rejects()));
  await scenario('compiled handler absent (private copy)',()=>absent(handler,async()=>rejects()));
  await scenario('handler hash mismatch',()=>changed(handler,'// changed fixture',async()=>rejects()));
  await scenario('workspace unauthorized',async()=>{const restricted={identity:'other',client:{key:'',workspaces:[],profiles:['agy']}};assert.throws(()=>executionContext(config,restricted,'negative','agy','agy/default'));});
  await scenario('workspace replaced during pinned execution',async()=>{const moved=root+'-moved';await rename(root,moved);try{await mkdir(root);try{assert.throws(()=>validateExecution(context));}finally{await rmdir(root);}}finally{await rename(moved,root);}});
  await scenario('production block before native spawn',async()=>{const runner=new AgyRunner({executable:join(root,'must-not-spawn.exe'),agyRegistry:registry});await assert.rejects(async()=>{for await(const _ of runner.run({model:'gemini-3.8-flash-medium',prompt:'fixture',context,signal:new AbortController().signal,onApproval:async()=>false})){}},error=>error.code==='approval_hook_failed');});
  async function invoke(env){const child=spawn(process.execPath,[join(SERVER_ROOT,'dist/approval-hook.js')],{cwd:root,env:{SystemRoot:process.env.SystemRoot,...env},stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});let text='';child.stdout.on('data',chunk=>text+=chunk);child.stderr.resume();child.stdin.end('{}');await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(JSON.parse(text).decision,'deny');}
  await scenario('token absent: real compiled handler, synthetic payload',()=>invoke({CLI_PROXY_HOOK_URL:'http://127.0.0.1:1/approve'}));
  await scenario('bridge unreachable: real compiled handler, synthetic payload',async()=>{const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));await invoke({CLI_PROXY_HOOK_URL:`http://127.0.0.1:${port}/approve`,CLI_PROXY_HOOK_TOKEN:'disposable-fixture-token',CLI_PROXY_APPROVAL_TIMEOUT_MS:'1000'});});
} finally {await registry.remove(context,registry.planRemove(context).consent);}
const evidence={experiment:m.experiment,results,nativeAGY:false,note:'Cancellation and timeout/process-tree scenarios are separately covered by npm test fixtures, not new native AGY evidence.'};
await writeFile(join(m.root,'evidence','E.json'),JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence,null,2));
if(results.some(r=>r.status!=='PASS'))process.exitCode=1;
