import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

if (process.argv.includes('app-server')) {
  await import('./codex-app-server.mjs');
} else if (process.argv.includes('models')) {
  process.stdout.write('Fetching available models...\n\ngemini-4-argon-high     Gemini 4 Argon (High)\nclaude-opus-5-5-medium    Claude Opus 5.5 (Medium)\n');
} else {

let input = '';
for await (const chunk of process.stdin) input += chunk.toString();
const agy = process.argv.includes('--input-format');
const prompt = agy ? JSON.parse(input).message.content : input;
const transcript = JSON.parse(prompt.slice(prompt.indexOf('Conversation (JSON):\n') + 'Conversation (JSON):\n'.length));
const message = transcript.at(-1).content;
const modelIndex = process.argv.indexOf('--model');
const model = modelIndex < 0 ? 'default' : process.argv[modelIndex + 1];
if (model === 'invalid-model') {
  process.stderr.write('Unknown model invalid-model');
  process.exit(1);
}

if (message === 'fail') {
  process.stderr.write('\x1b[31mAuthentication expired: sign in again.\x1b[0m');
  process.exit(7);
}
if (message === 'auth-wait') {
  process.stderr.write('Authentication required. Please visit the URL to log in.');
  setInterval(() => {}, 1000);
} else if (message.startsWith('sleep:')) {
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  writeFileSync(message.slice(6), JSON.stringify({ parent: process.pid, descendant: descendant.pid }));
  setInterval(() => {}, 1000);
} else if (agy) {
  const event = data => process.stdout.write(JSON.stringify(data) + '\n');
  if (message.startsWith('approval') || message === 'edit-approval') {
    const hook = spawn(process.execPath, [fileURLToPath(new URL('../../src/approval-hook.js', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    hook.stdin.end(JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'echo approved', Cwd: process.cwd() } }, workspacePaths: [process.cwd()] }));
    let output = '';
    for await (const chunk of hook.stdout) output += chunk.toString();
    const decision = JSON.parse(output).decision;
    if (decision === 'auto_approve' && message.startsWith('approval:')) writeFileSync(message.slice(9), 'executed');
    const text = decision === 'auto_approve' ? 'Executed approved action.' : 'Action denied.';
    event({ event: 'result', result: { status: 'SUCCESS', response: text } });
  } else {
  event({ event: 'init', init: { tools: ['private_tool'] } });
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
