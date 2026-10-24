import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

let input = '';
for await (const chunk of process.stdin) input += chunk.toString();
const agy = process.argv.includes('--input-format');
const prompt = agy ? JSON.parse(input).message.content : input;
const transcript = JSON.parse(prompt.slice(prompt.indexOf('Conversation (JSON):\n') + 'Conversation (JSON):\n'.length));
const message = transcript.at(-1).content;
const modelIndex = process.argv.indexOf('--model');
const model = modelIndex < 0 ? 'default' : process.argv[modelIndex + 1];

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
  event({ event: 'init', init: { tools: ['private_tool'] } });
  event({ event: 'step_update', step_update: { step_type: 'tool', text_delta: 'DO NOT EXPOSE TOOL OUTPUT' } });
  const text = `\x1b[32mHello 世界 (${model})\x1b[0m`;
  event({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: text.slice(0, 6) } });
  setTimeout(() => {
    event({ event: 'step_update', step_update: { step_type: 'agent_response', state: 'DONE', text_delta: text.slice(6) } });
    event({ event: 'result', result: { status: 'SUCCESS', response: text } });
  }, 30);
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
