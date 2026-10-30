import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PassThrough } from 'node:stream';
import { request as httpRequest } from 'node:http';
import { readConfig, authenticate, executionContext } from '../src/config.js';
import { createAgyMcpBridge, MCP_SERVER_NAME } from '../src/providers/agy-mcp-bridge.js';
import { processWitness, type ProcessFact, type ProcessWitness } from '../src/providers/agy-process-witness.js';
import { inspectAgyCapability, agyCapabilitySummary, AGY_REVIEWED_CLI } from '../src/providers/agy-capabilities.js';
import { serveMcp } from '../src/mcp-stdio.js';
import { SpawnRunner } from '../src/providers/base.js';
import { createAgyApprovalBridge } from '../src/providers/agy-approval-bridge.js';
import type { NativeMcpInvocation } from '../src/providers/agy-mcp-bridge.js';
import type { OpenAITool, ToolCall } from '../src/types.js';
import { fixtureProcessWitness, mcpPeer } from './mcp-client.js';
import { TEST_KEY } from './helpers.js';

interface FixtureOptions { callback?: (call: ToolCall) => Promise<string>; bind?: boolean; initMs?: number; toolMs?: number; tools?: OpenAITool[]; witness?: ProcessWitness }
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'agy-stage23-test-')), one = join(root, 'one'), two = join(root, 'two'); await mkdir(one); await mkdir(two);
  const keys = { A: TEST_KEY + 'A', B: TEST_KEY + 'B' };
  const config = readConfig({ PROXY_WORKSPACES: JSON.stringify({ one, two }), PROXY_CLIENTS: JSON.stringify(Object.fromEntries(['A','B'].map(k => [k, { key: keys[k as 'A'|'B'], workspaces: ['one','two'], profiles: ['agy'] }]))) });
  t.after(() => rm(root, { recursive: true, force: true }));
  const make = async (label: 'A'|'B', workspace: 'one'|'two' = 'one', overrides: FixtureOptions = {}) => {
    const context = executionContext(config, authenticate(config, `Bearer ${keys[label]}`), workspace, 'agy', 'agy/default');
    context.profile = { ...context.profile, initTimeoutMs: overrides.initMs ?? 1000, toolTimeoutMs: overrides.toolMs ?? 1000 };
    const controller = new AbortController(), cid = randomUUID(), events: Record<string, unknown>[] = [];
    let calls = 0;
    const options = { sessionId: randomUUID(), context, model: 'default', prompt: '', signal: controller.signal, tools: overrides.tools ?? [{ type: 'function' as const, function: { name: 'echo_isolation', description: 'Catalog ' + label, parameters: { type: 'object', properties: {}, additionalProperties: false } } }], onToolCall: async (call: ToolCall) => { calls++; return overrides.callback ? overrides.callback(call) : label + '_RESULT'; } };
    const b = await createAgyMcpBridge(options, () => {}, e => events.push(e), error => controller.abort(error), overrides.witness ?? fixtureProcessWitness);
    b.bindProcess(process.pid); if (overrides.bind !== false) b.bindNative(cid, context.workspaceRoot);
    t.after(async () => { controller.abort(); await b.close(); });
    const peer = mcpPeer(b.env, context.workspaceRoot, cid); await peer.attach();
    const payload = (name = 'echo_isolation', args: Record<string, unknown> = {}) => ({ conversationId: cid, workspacePaths: [context.workspaceRoot], toolCall: { name: 'call_mcp_tool', args: { ServerName: MCP_SERVER_NAME, ToolName: name, Arguments: args } } });
    const admit = (approved = true, name = 'echo_isolation', args: Record<string, unknown> = {}) => b.recordDecision(payload(name, args), approved);
    const call = (body: Record<string, unknown> = {}) => peer.post('call', { requestId: randomUUID(), name: 'echo_isolation', arguments: {}, ...body });
    return { b, peer, call, admit, payload, cid, context, controller, options, events, calls: () => calls };
  };
  return { make, root, one, two };
}

test('catalog discovery waits for native init without leaking tools or selecting the last session', async t => {
  const f = await fixture(t), a = await f.make('A', 'one', { bind: false });
  let completed = false;
  const pending = a.peer.post('list').then(r => { completed = true; return r; });
  await delay(25); assert.equal(completed, false); assert.equal(a.events.some(e => e.event === 'mcp_tools_list'), false);
  a.b.bindNative(a.cid, f.one); assert.equal((await pending).status, 200);
});
test('missing native init and missing process identity never expose a catalog', async t => {
  const f = await fixture(t), a = await f.make('A', 'one', { bind: false, initMs: 20 });
  assert.equal((await a.peer.post('list')).status, 409); assert.equal(a.calls(), 0);
  assert.throws(() => a.b.bindProcess(process.pid + 1));
  const { sessionId: _, ...missingSession } = a.options;
  await assert.rejects(createAgyMcpBridge(missingSession, () => {}), /Explicit MCP session/);
});
for (const workspace of ['one', 'two'] as const) test(`two authenticated clients keep same-name catalogs and results separate (${workspace === 'one' ? 'same' : 'different'} workspace)`, async t => {
  const f = await fixture(t), a = await f.make('A'), b = await f.make('B', workspace);
  const catalogs = await Promise.all([a.peer.post('list'), b.peer.post('list')]);
  assert.equal((await catalogs[0]!.json()).tools[0].description, 'Catalog A'); assert.equal((await catalogs[1]!.json()).tools[0].description, 'Catalog B');
  assert.equal((await a.peer.post('list', { sessionId: b.b.env.CLI_PROXY_MCP_SESSION })).status, 409);
  assert.equal((await a.peer.post('list', {}, b.b.env.CLI_PROXY_MCP_TOKEN)).status, 403);
  assert.throws(() => a.b.recordDecision(b.payload(), true));
  a.admit(); b.admit(); const requestId = randomUUID();
  const results = await Promise.all([a.call({ requestId, rpcId: 4 }), b.call({ requestId, rpcId: 4 })]);
  assert.equal((await results[0]!.json()).content[0].text, 'A_RESULT'); assert.equal((await results[1]!.json()).content[0].text, 'B_RESULT');
});
test('a validated MCP request without a positive human decision cannot publish a client tool call', async t => {
  const f = await fixture(t), a = await f.make('A');
  assert.equal(a.b.validateInvocation(a.payload()), true);
  assert.equal((await a.call()).status, 409); a.admit(false); assert.equal((await a.call()).status, 409);
  assert.equal(a.calls(), 0); a.admit(); assert.equal((await a.call()).status, 200);
  assert.equal((await a.call()).status, 409); assert.equal(a.calls(), 1);
});
test('single-action admission preserves original argument schemas and rejects replayed RPC IDs', async t => {
  const f = await fixture(t), a = await f.make('A');
  a.admit(); assert.equal((await a.call({ arguments: { extra: true } })).status, 409);
  const requestId = randomUUID(); assert.equal((await a.call({ requestId, rpcId: 9 })).status, 200);
  a.admit(); assert.equal((await a.call({ requestId: randomUUID(), rpcId: 9 })).status, 409);
  assert.equal((await a.call({ requestId })).status, 409); assert.equal(a.calls(), 1);
});
test('admissions expire without extending a human decision', async t => {
  const f = await fixture(t), a = await f.make('A');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  a.admit(); t.mock.timers.setTime(Date.now() + 30001);
  assert.equal((await a.call()).status, 409); assert.equal(a.calls(), 0);
});
for (const workspace of ['one','two'] as const) test(`cancel A rejects its late result while B continues (${workspace} workspace)`, async t => {
  const f = await fixture(t); let release!: (value: string) => void;
  const a = await f.make('A', 'one', { callback: () => new Promise(resolve => { release = resolve; }) }), b = await f.make('B', workspace);
  a.admit(); const pending = a.call(); while (!release) await delay(1);
  assert.throws(() => a.b.assertIdle(), { code: 'mcp_orphaned_call' }); a.controller.abort(new Error('Cancel only A'));
  assert.equal((await pending).status, 409); release('LATE_A_RESULT');
  b.admit(); assert.equal((await (await b.call()).json()).content[0].text, 'B_RESULT');
  assert.equal((await a.peer.post('list')).status, 409); assert.equal(a.events.some(e => e.event === 'mcp_tool_resolved'), false);
});
test('expiring A revokes only A and cannot publish delayed output', async t => {
  const f = await fixture(t); let release!: (value: string) => void;
  const a = await f.make('A','one',{toolMs:20,callback:()=>new Promise(resolve=>{release=resolve;})}),b=await f.make('B');
  a.admit(); assert.equal((await a.call()).status,409); release('late');
  assert.equal((await a.call()).status,409); b.admit(); assert.equal((await b.call()).status,200);
  assert.equal(a.calls(),1); assert.equal(a.events.some(e=>e.event==='mcp_tool_resolved'),false);
});
test('worker restart or reconnect cannot reuse its original credentials and admission', async t => {
  const f = await fixture(t), a = await f.make('A'), b = await f.make('B'); a.admit();
  const restarted = mcpPeer(a.b.env, f.one); await assert.rejects(restarted.attach());
  assert.equal((await a.call()).status,409); assert.equal(a.calls(),0);
  b.admit(); assert.equal((await b.call()).status,200);
});
test('a closed bridge and a fresh invocation cannot reuse the old worker or removed tools', async t => {
  const f = await fixture(t), old = await f.make('A'); const oldLease=await old.peer.attach(); old.admit(); await old.b.close();
  await assert.rejects(old.peer.post('list'));
  const fresh=await f.make('A','one',{tools:[{type:'function',function:{name:'fresh_fixture',parameters:{type:'object',properties:{},additionalProperties:false}}}]});
  assert.equal((await fresh.peer.post('list',{},old.b.env.CLI_PROXY_MCP_TOKEN)).status,403);
  assert.equal((await fresh.peer.post('list',{peerId:old.peer.peerId,peerLease:oldLease})).status,409);
  assert.equal((await fresh.call()).status,409); fresh.admit(true,'fresh_fixture');
  assert.equal((await fresh.call({name:'fresh_fixture'})).status,200); assert.equal(fresh.calls(),1);
});
test('detaching an MCP worker revokes orphaned work and late results', async t => {
  const f=await fixture(t);let release!:(v:string)=>void;
  const a=await f.make('A','one',{callback:()=>new Promise(resolve=>{release=resolve;})});a.admit();const pending=a.call();while(!release)await delay(1);
  assert.equal((await a.peer.post('detach')).status,200);assert.equal((await pending).status,409);release('late');
  assert.equal((await a.peer.post('list')).status,409);assert.equal(a.events.some(e=>e.event==='mcp_tool_resolved'),false);
});
test('OS witness rejects wrong parents, PID reuse, missing processes and foreign executables', async () => {
  const now=Date.now();let records:ProcessFact[]=[{id:101,parent:1,birth:new Date(now-2000).toISOString(),image:process.execPath},{id:202,parent:101,birth:new Date(now-1000).toISOString(),image:process.execPath}];
  const query=async()=>structuredClone(records), signal=new AbortController().signal;
  const verify=await processWitness(query)(101,202,now,signal);await verify();
  records[1]!.birth=new Date(now).toISOString();await assert.rejects(verify());records[1]!.parent=999;await assert.rejects(processWitness(query)(101,202,now,signal));
  records=[];await assert.rejects(processWitness(query)(101,202,now,signal));
  records=[{id:101,parent:1,birth:new Date(now-2000).toISOString(),image:process.execPath},{id:202,parent:101,birth:new Date(now-1000).toISOString(),image:process.cwd()}];
  await assert.rejects(processWitness(query)(101,202,now,signal));
});
test('failed process ownership proof denies attach before native tools become reachable', async t => {
  const f=await fixture(t);await assert.rejects(f.make('A','one',{witness:async()=>{throw Error('Wrong OS process');}}));
});
test('production capability rejects an unreviewed binary and reports explicit blockers', async t => {
  const f=await fixture(t),a=await f.make('A');
  const wrong=inspectAgyCapability(a.options,process.execPath);assert.equal(wrong.eligible,false);assert.equal(wrong.checks.reviewedBinary,false);
  const summary=agyCapabilitySummary();assert.equal(summary.external_execution,false);assert.equal(summary.client_tools,false);assert.ok(summary.blockers.includes('os_containment_unverified'));
  assert.match(AGY_REVIEWED_CLI.sha256,/^[a-f0-9]{64}$/);
});
test('stdio preserves split UTF-8 and never writes peer credentials into MCP output', async t => {
  const f=await fixture(t),a=await f.make('A');
  // This fixture already attached a test peer: use another invocation for stdio.
  const options={...a.options,sessionId:randomUUID(),tools:[{type:'function' as const,function:{name:'echo_isolation',parameters:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false}}}],onToolCall:async(call:ToolCall)=>JSON.parse(call.function.arguments).value};const b=await createAgyMcpBridge(options,()=>{},undefined,undefined,fixtureProcessWitness);b.bindProcess(process.pid);const cid=randomUUID();b.bindNative(cid,f.one);t.after(()=>b.close());
  const input=new PassThrough(),output=new PassThrough();let raw='';output.on('data',c=>{raw+=c;});const job=serveMcp(input,output,{...b.env,CLI_PROXY_MCP_WORKSPACE:f.one});
  const send=(m:unknown)=>input.write(JSON.stringify(m)+'\n');const wait=async(id:number)=>{for(let n=0;n<200;n++){const item=raw.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)).find(m=>m.id===id);if(item)return item;await delay(5);}throw Error('MCP response missing');};
  send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25'}});await wait(1);
  b.recordDecision({conversationId:cid,workspacePaths:[f.one],toolCall:{name:'call_mcp_tool',args:{ServerName:MCP_SERVER_NAME,ToolName:'echo_isolation',Arguments:{value:'世界'}}}},true);
  const frame=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'echo_isolation',arguments:{value:'世界'},_meta:{'antigravity.google/conversation_id':cid,'antigravity.google/root_conversation_id':cid}}})+'\n'), index=frame.indexOf(Buffer.from('世'));
  input.write(frame.subarray(0,index+1));input.write(frame.subarray(index+1));assert.equal((await wait(2)).result.content[0].text,'世界');
  input.end();await job;assert.ok(!raw.includes(b.env.CLI_PROXY_MCP_TOKEN));
});
test('a decision arriving after the native hook connection closes cannot mint an admission', async t => {
  const f=await fixture(t),a=await f.make('A');let release!:(value:boolean)=>void;
  const hook=await createAgyApprovalBridge({...a.options,onApproval:()=>new Promise(resolve=>{release=resolve;})},()=>{},false,input=>a.b.validateInvocation(input as NativeMcpInvocation),(input,approved)=>a.b.recordDecision(input as NativeMcpInvocation,approved));t.after(()=>hook.close());
  const connection=new AbortController();const request=fetch(hook.env.CLI_PROXY_HOOK_URL,{method:'POST',headers:{authorization:`Bearer ${hook.env.CLI_PROXY_HOOK_TOKEN}`},body:JSON.stringify(a.payload()),signal:connection.signal}).catch(()=>undefined);
  while(!release)await delay(1);connection.abort();await request;await delay(10);release(true);await delay(20);
  assert.equal((await a.call()).status,409);assert.equal(a.calls(),0);
});
test('a denial from a foreign native conversation cannot revoke another session admission', async t => {
  const f=await fixture(t),a=await f.make('A'),b=await f.make('B');a.admit();
  assert.throws(()=>a.b.recordDecision(b.payload(),false));assert.equal((await a.call()).status,200);
});


test('approval transport preserves exact Unicode arguments across split HTTP chunks', async t => {
  const f = await fixture(t), a = await f.make('A');
  let displayed = '';
  const bridge = await createAgyApprovalBridge({ ...a.options, onApproval: async action => { displayed = action.action; return false; } });
  t.after(() => bridge.close());
  const args = { Path: join(f.one, 'ação-世界.txt'), Content: 'conteúdo 世界', Overwrite: false };
  const raw = Buffer.from(JSON.stringify({ conversationId: a.cid, workspacePaths: [f.one], toolCall: { name: 'write_file', args } }));
  const split = raw.indexOf(Buffer.from('世')) + 1;
  const result = await new Promise<string>((resolve, reject) => {
    const req = httpRequest(bridge.env.CLI_PROXY_HOOK_URL!, { method: 'POST', headers: { authorization: `Bearer ${bridge.env.CLI_PROXY_HOOK_TOKEN}` } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve(body));
    });
    req.on('error', reject); req.write(raw.subarray(0, split)); setTimeout(() => req.end(raw.subarray(split)), 10);
  });
  assert.equal(JSON.parse(result).approved, false);
  assert.deepEqual(JSON.parse(displayed.slice(displayed.indexOf('\n') + 1)), args);
});


test('process binding failure rejects the request and reaps its child instead of crashing the server', async () => {
  let pid = 0;
  class Runner extends SpawnRunner {
    protected command() { return { executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], input: '', onSpawn: (childPid: number) => { pid = childPid; throw Error('Fixture ownership failure'); } }; }
  }
  await assert.rejects(async () => { for await (const _ of new Runner({ cwd: process.cwd() }).run({ model: 'default', prompt: '', signal: new AbortController().signal })) {} }, { code: 'cli_protocol_error' });
  assert.ok(pid > 0); assert.throws(() => process.kill(pid, 0));
});
