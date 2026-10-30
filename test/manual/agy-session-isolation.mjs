// Native concurrent probe. Two explicit human decisions; no automatic approval.
import { mkdtemp, mkdir, writeFile, readFile, appendFile, realpath } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { SpawnRunner } from '../../dist/providers/base.js';
import { AgyDecoder } from '../../dist/providers/agy-runner.js';
import { AgyLifecycle } from '../../dist/providers/agy-lifecycle.js';
import { createAgyMcpBridge } from '../../dist/providers/agy-mcp-bridge.js';
import { createAgyApprovalBridge } from '../../dist/providers/agy-approval-bridge.js';
import { AgyWorkspaceRegistry } from '../../dist/agy-workspaces.js';
import { AgyMcpWorkspaceRegistry } from '../../dist/agy-mcp-workspaces.js';
import { HookCredentialLease } from '../../dist/hook-credentials.js';
import { SERVER_ROOT, readConfig, authenticate, executionContext } from '../../dist/config.js';

const mode = process.argv[2] ?? 'same';
if (!['same', 'different', 'same-cancel', 'different-cancel', 'same-discovery', 'different-discovery'].includes(mode)) throw Error('Invalid mode');
const root = await realpath(await mkdtemp(join(tmpdir(), 'agy-stage23-')));
await mkdir(join(SERVER_ROOT, '.tmp'), { recursive: true });
await writeFile(join(SERVER_ROOT, '.tmp/stage23-current.json'), JSON.stringify({ root, mode }), { flag: 'w' });
const evidence = join(root, 'evidence'); await mkdir(evidence);
const hash = value => createHash('sha256').update(value).digest('hex');
const record = event => appendFile(join(evidence, 'events.ndjson'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
const binary = 'C:/Users/fedet/AppData/Local/agy/bin/agy.exe';
const expectedHash = 'fade3d94282b8c1b12a24e54ffa930183bd6f6ff7a73a90421fb0aab4d9402ba';
const handlerHash = hash(readFileSync(join(SERVER_ROOT, 'dist/mcp-stdio.js')));
const stable = () => { if (hash(readFileSync(binary)) !== expectedHash || hash(readFileSync(join(SERVER_ROOT, 'dist/mcp-stdio.js'))) !== handlerHash) throw Error('Tested binary or handler changed; abort comparison'); };
stable();
const aRoot = join(root, 'workspace-A'), bRoot = mode.startsWith('same') ? aRoot : join(root, 'workspace-B');
await mkdir(aRoot); if (bRoot !== aRoot) await mkdir(bRoot);
const wrapper = join(root, 'observed-mcp.mjs');
await writeFile(wrapper, `import {Transform} from 'node:stream';import {appendFileSync} from 'node:fs';import {randomUUID,createHash} from 'node:crypto';import {serveMcp as core} from ${JSON.stringify(pathToFileURL(join(SERVER_ROOT, 'dist/mcp-stdio.js')).href)};
export async function serveMcp(){const worker=randomUUID(),owner=process.env.CLI_PROXY_PROBE_OWNER;const h=v=>createHash('sha256').update(String(v)).digest('hex');const log=x=>appendFileSync(${JSON.stringify(join(evidence, 'workers.ndjson'))},JSON.stringify({at:new Date().toISOString(),worker,owner,...x})+'\\n');log({event:'worker-start',pid:process.pid,parent:process.ppid,credentialPresent:!!process.env.CLI_PROXY_MCP_TOKEN});
function tracker(direction){let pending='';return new Transform({transform(chunk,encoding,cb){pending+=chunk.toString();const lines=pending.split('\\n');pending=lines.pop()??'';for(const line of lines){try{const m=JSON.parse(line);if(direction==='in')log({event:'mcp-input',method:m.method,idHash:m.id===undefined?null:h(m.id),paramKeys:Object.keys(m.params??{}),metaKeys:Object.keys(m.params?._meta??{}),nativeIdentityPresent:!!(m.params?.conversationId||m.params?._meta?.conversationId||m.params?._meta?.conversation_id)});else if(m.result?.tools)log({event:'catalog-sent',catalogHash:h(JSON.stringify(m.result.tools)),names:m.result.tools.map(t=>t.name)});}catch{}}cb(null,chunk);}});}
const input=tracker('in'),output=tracker('out');process.stdin.setEncoding('utf8');process.stdin.pipe(input);output.pipe(process.stdout);try{await core(input,output);}finally{output.end();log({event:'worker-end'});}}
`);
const keys = { A: randomBytes(32).toString('hex'), B: randomBytes(32).toString('hex') };
const config = readConfig({ PROXY_CLIENTS: JSON.stringify(Object.fromEntries(['A','B'].map(label => [label, { key: keys[label], profiles: ['agy'], workspaces: [label] }]))), PROXY_WORKSPACES: JSON.stringify({ A: aRoot, B: bRoot }), APPROVAL_TIMEOUT_MS: '580000', AGY_ATTESTATION_TIMEOUT_MS: '240000' });
const registry = new AgyWorkspaceRegistry(join(root, 'hook-state'));
const mcpRegistry = new AgyMcpWorkspaceRegistry(join(root, 'mcp-state'), wrapper);
const decisions = new Map();
const terminal = createInterface({ input: process.stdin });
terminal.on('line', line => { const match = /^(A|B) (aprovar|negar)$/.exec(line.trim()); if (match) decisions.get(match[1])?.(match[2] === 'aprovar'); });
const sessions = ['A','B'].map(label => ({ label, context: executionContext(config, authenticate(config, `Bearer ${keys[label]}`), label, 'agy', 'agy/gemini-3.8-flash-medium'), controller: new AbortController(), result: `${label}_RESULT_${randomBytes(12).toString('hex')}`, pending: false, listed: false }));
const installed = [], result = { mode, root, binarySha256: expectedHash, outcome: 'BLOCKED', productionEnabled: false, sessions: {} };
let monitor;
function releaseResults() {
  if (!sessions.every(s => s.pending && s.release)) return;
  if (mode.endsWith('cancel')) { sessions[0].controller.abort(new Error('Fixture cancels A with MCP pending')); sessions[1].release(sessions[1].result); }
  else for (const s of sessions) s.release(s.result);
}
try {
  for (const s of sessions) if (!installed.some(context => context.workspaceRoot === s.context.workspaceRoot)) { await registry.install(s.context, registry.planInstall(s.context).consent); await mcpRegistry.install(s.context, mcpRegistry.planInstall(s.context).consent); installed.push(s.context); }
  monitor = setInterval(() => { try { stable(); } catch (error) { result.binaryChanged = true; for (const s of sessions) s.controller.abort(error); } }, 2000);
  await Promise.all(sessions.map(async s => {
    const state = result.sessions[s.label] = { identity: s.context.identity, expectedResult: s.result, init: false, humanApproved: false, pending: false, receivedOwnResult: false, receivedForeignResult: false };
    const verify = () => { stable(); registry.verify(s.context); mcpRegistry.verify(s.context); };
    const clock = new AgyLifecycle(s.context.profile, error => s.controller.abort(error), phase => { void record({ session: s.label, event: 'phase', phase }); });
    const options = { sessionId: 'native-probe-' + randomBytes(16).toString('hex'), context: s.context, signal: s.controller.signal, model: 'gemini-3.8-flash-medium', prompt: mode.endsWith('discovery') ? 'Do not use tools. Return only OK.' : 'In this disposable test call echo_isolation from obsidian-cli-proxy-tools exactly once with arguments {}. Do not use any other tools, files, shell, browser, artifacts or other agents. Wait for human approval; stop on denial. Return only the exact MCP result. Never invent it.', tools: [{ type: 'function', function: { name: 'echo_isolation', description: 'Session catalog ' + s.label + '; in-memory harmless fixture. No files or commands.', parameters: { type: 'object', properties: {}, additionalProperties: false } } }], approvalTimeoutMs: 580000,
      onToolCall: async call => { if (call.function.name !== 'echo_isolation' || Object.keys(JSON.parse(call.function.arguments)).length) throw Error('Unexpected fixture tool'); state.pending = true; s.pending = true; await record({ session: s.label, event: 'client-call', idHash: hash(call.id) }); clock.phase('waiting_tool'); try { return await new Promise(resolve => { s.release = resolve; releaseResults(); }); } finally { clock.phase('active'); } },
      onApproval: async action => { const args = JSON.parse(action.action.slice(action.action.indexOf('\n')+1)); let a = args.Arguments; if(typeof a==='string') a=JSON.parse(a); if(!action.action.startsWith('call_mcp_tool\n')||args.ServerName!=='obsidian-cli-proxy-tools'||args.ToolName!=='echo_isolation'||!a||Object.keys(a).length) return false;
        clock.phase('waiting_approval'); await record({ session:s.label,event:'approval-pending',actionHash:hash(action.action) });
        console.log(JSON.stringify({ HUMAN_APPROVAL_REQUIRED:true,mode,session:s.label,workspace:s.context.workspaceRoot,conversationHash:state.conversationHash,server:'obsidian-cli-proxy-tools',tool:'echo_isolation',arguments:{},effect:'Only return '+s.result,command:s.label+' aprovar' }));
        const approved = await new Promise(resolve => { const aborted=()=>finish(false);const timeout=setTimeout(()=>finish(false),540000); const finish=value=>{clearTimeout(timeout);s.controller.signal.removeEventListener('abort',aborted);decisions.delete(s.label);resolve(value);};decisions.set(s.label,finish);s.controller.signal.addEventListener('abort',aborted,{once:true});if(s.controller.signal.aborted)aborted(); });
        state.humanApproved=approved; await record({ session:s.label,event:'human-decision',approved }); clock.phase('active'); return approved;
      } };
    let mcp, approval, lease;
    try {
      mcp = await createAgyMcpBridge(options, verify, event => { void record({ session:s.label,...event }); if(event.event==='mcp_tools_list'){s.listed=true;state.catalogListed=true;if(mode.endsWith('discovery')&&sessions.every(item=>item.listed))setTimeout(()=>{for(const item of sessions)item.controller.abort(new Error('Discovery-only fixture finished'));},100);}}, error => s.controller.abort(error));
      approval = await createAgyApprovalBridge(options, verify, true, input => mcp.validateInvocation(input), (input, approved) => mcp.recordDecision(input, approved));
      lease = new HookCredentialLease(s.context,{url:approval.env.CLI_PROXY_HOOK_URL,token:approval.env.CLI_PROXY_HOOK_TOKEN,approvalTimeoutMs:options.approvalTimeoutMs});
      void approval.ready.then(()=>clock.ready());
      class Runner extends SpawnRunner { command() { return { provider:'agy',executable:binary,args:['--add-dir',s.context.workspaceRoot,'--model',options.model,'--input-format','stream-json','--output-format','stream-json','--disable-slash-commands'],input:JSON.stringify({event:'user',message:{content:options.prompt}})+'\n',keepStdinOpen:true,managesStartup:true,onSpawn:pid=>{state.agyPid=pid;mcp.bindProcess(pid);clock.spawned();},env:{...mcp.env,...approval.env,CLI_PROXY_PROBE_OWNER:s.label},decoder:new AgyDecoder(async(id,cwd)=>{await lease.register(id,cwd);mcp.bindNative(id,cwd);state.init=true;state.conversationHash=hash(id);await record({session:s.label,event:'native-init',conversationHash:state.conversationHash});clock.init();})};} }
      clock.phase('spawning'); let text=''; for await(const part of new Runner({cwd:s.context.workspaceRoot}).run(options))text+=part;
      state.receivedOwnResult=text.includes(s.result);state.receivedForeignResult=text.includes(sessions.find(other=>other!==s).result); state.ready=approval.isReady();
    } catch(error) {state.errorCode=error.code??(s.controller.signal.aborted?'cancelled':'probe_incomplete');}
    finally {clock.close();s.controller.abort();await mcp?.close();await approval?.close();await lease?.close();}
  }));
  const a=result.sessions.A,b=result.sessions.B;
  result.outcome=mode.endsWith('discovery')?(a.catalogListed&&b.catalogListed?'DISCOVERY_ONLY':'BLOCKED'):((mode.endsWith('cancel')?a.pending&&a.errorCode==='cancelled':a.receivedOwnResult)&&b.receivedOwnResult&&!a.receivedForeignResult&&!b.receivedForeignResult?'PASS':'BLOCKED');
} finally {
  clearInterval(monitor);terminal.close();
  for(const context of installed.reverse()){await mcpRegistry.remove(context,mcpRegistry.planRemove(context).consent);await registry.remove(context,registry.planRemove(context).consent);}
  stable();result.cleaned=installed.every(c=>!existsSync(join(c.workspaceRoot,'.agents/hooks.json'))&&!existsSync(join(c.workspaceRoot,'.agents/mcp_config.json')));
  await writeFile(join(evidence,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
