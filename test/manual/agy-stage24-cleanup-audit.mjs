// Read-only audit of PIDs and lease filenames from this task's collected evidence.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SERVER_ROOT, cliEnvironment } from '../../dist/config.js';
const collected = JSON.parse(await readFile('.tmp/agy-stage24-collected.json', 'utf8'));
const pids = new Set(), conversations = new Set();
const add = pid => { if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid); };
for (const experiment of collected.experiments) {
  for (const event of experiment.data['events.ndjson'] ?? []) { add(event.processId); add(event.workerPid); if (/^[a-f0-9]{64}$/.test(event.conversationHash)) conversations.add(event.conversationHash); }
  for (const event of experiment.data['workers.ndjson'] ?? []) { add(event.pid); add(event.parent); }
  const result = experiment.data['result.json']; add(result?.executableLeasePid);
  for (const state of Object.values(result?.cases ?? {})) { add(state.pid); if (/^[a-f0-9]{64}$/.test(state.conversationHash)) conversations.add(state.conversationHash); }
}
if (!pids.size || pids.size > 256) throw Error('Invalid task PID inventory');
const filter = [...pids].flatMap(pid => [`ProcessId = ${pid}`, `ParentProcessId = ${pid}`]).join(' OR ');
const script = `@(Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object ProcessId,ParentProcessId,@{Name='birth';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}},ExecutablePath) | ConvertTo-Json -Compress`;
const stdout = await new Promise((resolve, reject) => execFile(join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo','-NoProfile','-NonInteractive','-Command',script], { shell: false, windowsHide: true, env: cliEnvironment(), timeout: 10000, maxBuffer: 65536 }, (error, output) => error ? reject(error) : resolve(output)));
const value = stdout.trim() ? JSON.parse(stdout) : [];
const remaining = (Array.isArray(value) ? value : [value]).map(record => ({ pid: record.ProcessId, parent: record.ParentProcessId, birth: record.birth, imageHash: createHash('sha256').update(record.ExecutablePath ?? '').digest('hex') }));
const audit = { at: new Date().toISOString(), knownPids: pids.size, matchingPidsOrDirectChildren: remaining, knownNativeConversations: conversations.size, ownedRuntimeCredentialFilesRemaining: [...conversations].filter(id => existsSync(join(SERVER_ROOT, '.local/agy-runtime', id + '.json'))).length };
await writeFile('.tmp/agy-stage24-cleanup.json', JSON.stringify(audit, null, 2) + '\n'); console.log(JSON.stringify(audit));
