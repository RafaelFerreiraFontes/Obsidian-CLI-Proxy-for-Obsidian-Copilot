import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

if (process.argv.includes('--help')) {
  process.stdout.write('Fixture CLI help\n');
} else if (process.argv.includes('app-server')) {
  await import('./codex-app-server.mjs');
} else if (process.argv.includes('models')) {
  process.stdout.write('Fetching available models...\n\ngemini-4-argon-high     Gemini 4 Argon (High)\nclaude-opus-5-5-medium    Claude Opus 5.5 (Medium)\n');
} else {

const agy = process.argv.includes('--input-format');
let input = '';
if (agy) {
  await new Promise(resolve => {
    const receive = data => { input += data; if (input.includes('\n')) { process.stdin.off('data', receive); process.stdin.pause(); resolve(); } };
    process.stdin.on('data', receive);
  });
} else for await (const chunk of process.stdin) input += chunk.toString();
const prompt = agy ? JSON.parse(input).message.content : input;
const transcript = JSON.parse(prompt.slice(prompt.indexOf('Conversation (JSON):\n') + 'Conversation (JSON):\n'.length));
let message = transcript.at(-1).content;
const nativeInit = agy && message.startsWith('native-init:');
const registered = agy && JSON.parse(readFileSync(join(process.cwd(), '.agents/hooks.json'), 'utf8'))['obsidian-cli-proxy-approval']?.SessionStart;
if (registered && process.argv[process.argv.indexOf('--add-dir') + 1] !== process.cwd()) throw new Error('Authorized workspace was not mounted through --add-dir');
const conversationId = agy ? randomUUID() : undefined;
if (nativeInit) {
  message = message.slice('native-init:'.length);
}
if (conversationId && message !== 'phase-wait-init') {
  process.stdout.write(JSON.stringify({ event: 'init', conversation_id: conversationId, init: { cwd: process.cwd(), tools: [] } }) + '\n');
}
const hookEnv = nativeInit ? { ...process.env, CLI_PROXY_HOOK_URL: '', CLI_PROXY_HOOK_TOKEN: '' } : process.env;
const modelIndex = process.argv.indexOf('--model');
const model = modelIndex < 0 ? 'default' : process.argv[modelIndex + 1];
if (agy) {
  const hookDirectory = join(process.cwd(), '.agents');
  const hookConfig = JSON.parse(readFileSync(join(hookDirectory, 'hooks.json'), 'utf8'));
  const entry = hookConfig['obsidian-cli-proxy-approval'];
  const ready = message === 'only-pre-invocation' ? entry?.PreInvocation?.[0] : entry?.SessionStart?.[0];
  if (ready && !['skip-readiness', 'phase-wait-init', 'phase-wait-attestation'].includes(message)) {
    const match = /^(?:"([^"]+)"|([^\s"]+)) ([a-zA-Z0-9.-]+\.mjs) --ready$/.exec(ready.command);
    if (!match) throw new Error('Unexpected readiness command');
    const hook = spawn(match[1] ?? match[2], [match[3], '--ready'], { cwd: hookDirectory, env: hookEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    hook.stdin.end(JSON.stringify({ conversationId, workspacePaths: [process.cwd()] }));
    for await (const _chunk of hook.stdout) {}
  }
}
if (model === 'invalid-model') {
  process.stderr.write('Unknown model invalid-model');
  process.exit(1);
}

if (message === 'fail') {
  process.stderr.write('\x1b[31mAuthentication expired: sign in again.\x1b[0m');
  process.exit(7);
}
if (['phase-wait-init', 'phase-wait-attestation'].includes(message)) {
  setInterval(() => {}, 1000);
} else if (message === 'auth-wait') {
  process.stderr.write('Authentication required. Please visit the URL to log in.');
  setInterval(() => {}, 1000);
} else if (message.startsWith('sleep:')) {
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  writeFileSync(message.slice(6), JSON.stringify({ parent: process.pid, descendant: descendant.pid }));
  setInterval(() => {}, 1000);
} else if (agy) {
  const event = data => process.stdout.write(JSON.stringify(data) + '\n');
  if (message === 'stdin-lifecycle') {
    let earlyEOF = false;
    process.stdin.on('end', () => { earlyEOF = true; }); process.stdin.resume();
    setTimeout(() => event({ event: 'result', result: { status: 'SUCCESS', response: earlyEOF ? 'closed too early' : 'input kept open' } }), 50);
  } else if (message === 'mcp-fixture') {
      // An actual stdio child lets production process-ownership checks run,
      // rather than impersonating an MCP worker with the fake AGY process.
      const entry = JSON.parse(readFileSync(join(process.cwd(), '.agents/mcp_config.json'), 'utf8')).mcpServers['obsidian-cli-proxy-tools'];
      const worker = spawn(entry.command, entry.args, { cwd: entry.cwd, env: process.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      worker.stderr.resume(); worker.stdin.on('error', () => {});
      const closed = new Promise(resolve => worker.once('close', resolve));
      const lines = createInterface({ input: worker.stdout }); let nextId = 0; const waiting = new Map();
      lines.on('line', raw => { const message = JSON.parse(raw); waiting.get(message.id)?.(message); waiting.delete(message.id); });
      const rpc = (method, params = {}) => new Promise(resolve => { const id = ++nextId; waiting.set(id, resolve); worker.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
      await rpc('initialize', { protocolVersion: '2025-11-25' }); await rpc('tools/list');
    const command = JSON.parse(readFileSync(join(process.cwd(), '.agents/hooks.json'), 'utf8'))['obsidian-cli-proxy-approval'].PreToolUse[0].hooks[0].command;
    const match = /^(?:"([^"]+)"|([^\s"]+)) ([a-zA-Z0-9.-]+\.mjs)$/.exec(command);
    if (!match) throw Error('Unexpected MCP fixture hook');
    const hook = spawn(match[1] ?? match[2], [match[3]], { cwd: join(process.cwd(), '.agents'), env: hookEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    hook.stdin.end(JSON.stringify({ conversationId, workspacePaths: [process.cwd()], toolCall: { name: 'call_mcp_tool', args: { ServerName: 'obsidian-cli-proxy-tools', ToolName: 'echo_fixture', Arguments: { value: 'fixture call' } } } }));
    let decision = ''; for await (const part of hook.stdout) decision += part;
    if (JSON.parse(decision).decision !== 'auto_approve') { worker.stdin.end(); await closed; lines.close(); event({ event: 'result', result: { status: 'SUCCESS', response: 'MCP action denied.' } }); }
    else {
      const reply = await rpc('tools/call', { name: 'echo_fixture', arguments: { value: 'fixture call' }, _meta: { 'antigravity.google/conversation_id': conversationId, 'antigravity.google/root_conversation_id': conversationId } });
      worker.stdin.end(); await closed; lines.close();
      event({ event: 'result', result: { status: reply.result ? 'SUCCESS' : 'ERROR', response: reply.result?.content?.[0]?.text, error: 'Fixture MCP call rejected' } });
    }
  } else if (message.startsWith('approval') || message === 'edit-approval') {
    const hookDirectory = join(process.cwd(), '.agents');
    const hookConfig = JSON.parse(readFileSync(join(hookDirectory, 'hooks.json'), 'utf8'));
    const command = hookConfig['obsidian-cli-proxy-approval'].PreToolUse[0].hooks[0].command;
    const match = /^(?:"([^"]+)"|([^\s"]+)) ([a-zA-Z0-9.-]+\.mjs)$/.exec(command);
    if (!match) throw new Error('Unexpected hook command');
    const hook = spawn(match[1] ?? (match[2] === 'node' ? process.execPath : match[2]), [match[3]], { cwd: hookDirectory, env: hookEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    hook.stdin.end(JSON.stringify({ conversationId, toolCall: { name: 'run_command', args: { CommandLine: 'echo approved', Cwd: process.cwd() } }, workspacePaths: [process.cwd()] }));
    let output = '';
    for await (const chunk of hook.stdout) output += chunk.toString();
    const decision = JSON.parse(output).decision;
    if (decision === 'auto_approve' && message.startsWith('approval:')) writeFileSync(message.slice(9), 'executed');
    const text = decision === 'auto_approve' ? 'Executed approved action.' : 'Action denied.';
    event({ event: 'result', result: { status: 'SUCCESS', response: text } });
  } else {
  event({ event: 'step_update', step_update: { step_type: 'tool', text_delta: 'DO NOT EXPOSE TOOL OUTPUT' } });
  const text = `\x1b[32mHello 世界 (${model})\x1b[0m`;
  event({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: text.slice(0, 6) } });
  setTimeout(() => {
    event({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'DONE', text_delta: text.slice(6) } });
    event({ event: 'result', result: { status: 'SUCCESS', response: text } });
  }, 30);
  }
} else {
  // Split both an ANSI sequence and a UTF-8 code point across stdout writes.
  process.stdout.write('\x1b[');
  setTimeout(() => {
    process.stdout.write(`32mHello (${model}) `);
    const unicode = Buffer.from('世界');
    process.stdout.write(unicode.subarray(0, 1));
    setTimeout(() => {
      process.stdout.write(unicode.subarray(1));
      process.stdout.write('\x1b[0m');
    }, 30);
  }, 30);
}
}
