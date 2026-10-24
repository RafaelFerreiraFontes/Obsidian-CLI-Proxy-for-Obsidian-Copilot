import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const response = (id, result) => send({ id, result });
let model = 'default';
let message = '';
let approvalCount = 0;
const done = text => {
  send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-fixture', delta: text } });
  send({ method: 'turn/completed', params: { threadId: 'thread-fixture', turn: { id: 'turn-fixture', status: 'completed', items: [] } } });
};

for await (const line of createInterface({ input: process.stdin })) {
  const event = JSON.parse(line);
  if (event.method === 'initialize') response(event.id, {});
  else if (event.method === 'thread/start') {
    model = event.params.model ?? 'default';
    if (event.params.approvalPolicy !== 'untrusted' || event.params.sandbox !== 'read-only') throw new Error('Wrong approval configuration');
    if (model === 'invalid-model') send({ id: event.id, error: { message: 'Unknown model invalid-model' } });
    else response(event.id, { thread: { id: 'thread-fixture' } });
  } else if (event.method === 'turn/start') {
    const prompt = event.params.input[0].text;
    const transcript = JSON.parse(prompt.slice(prompt.indexOf('Conversation (JSON):\n') + 'Conversation (JSON):\n'.length));
    message = transcript.at(-1).content;
    response(event.id, { turn: { id: 'turn-fixture', status: 'inProgress' } });
    if (message === 'fail') {
      process.stderr.write('\x1b[31mAuthentication expired: sign in again.\x1b[0m');
      process.exit(7);
    } else if (message.startsWith('sleep:')) {
      const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
      writeFileSync(message.slice(6), JSON.stringify({ parent: process.pid, descendant: descendant.pid }));
    } else if (message.startsWith('approval')) {
      send({ method: 'item/started', params: { threadId: 'thread-fixture', item: { id: 'command-fixture', type: 'commandExecution', command: 'echo approved', cwd: process.cwd() } } });
      send({ id: 100, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-fixture', turnId: 'turn-fixture', itemId: 'command-fixture', command: 'echo approved', cwd: process.cwd(), reason: 'User requested action' } });
    } else if (message === 'edit-approval') {
      send({ method: 'item/started', params: { threadId: 'thread-fixture', item: { id: 'file-fixture', type: 'fileChange', changes: [{ path: 'note.md', diff: '+updated text' }] } } });
      send({ id: 100, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-fixture', turnId: 'turn-fixture', itemId: 'file-fixture', reason: 'Edit note' } });
    } else if (message === 'tool') {
      send({ id: 101, method: 'item/tool/call', params: { threadId: 'thread-fixture', turnId: 'turn-fixture', callId: `tool-${process.pid}`, tool: 'read_note', arguments: { path: 'note.md' } } });
    } else {
      send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-fixture', delta: `\x1b[32mHello (${model}) ` } });
      setTimeout(() => done('世界\x1b[0m'), 30);
    }
  } else if ((event.id === 100 || event.id === 102) && event.result) {
    approvalCount++;
    if (event.result.decision === 'accept' && message.startsWith('approval:')) writeFileSync(message.slice(9), 'executed');
    if (event.result.decision === 'accept' && message.startsWith('approval-two:')) writeFileSync(message.slice(13) + `-${approvalCount}`, 'executed');
    if (message.startsWith('approval-two:') && approvalCount === 1) {
      send({ id: 102, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-fixture', turnId: 'turn-fixture', itemId: 'second-command', command: 'echo second command', cwd: process.cwd() } });
    } else done(event.result.decision === 'accept' ? 'Executed approved action.' : 'Action denied.');
  } else if (event.id === 101 && event.result) done(`Tool returned: ${event.result.contentItems[0].text}`);
}
