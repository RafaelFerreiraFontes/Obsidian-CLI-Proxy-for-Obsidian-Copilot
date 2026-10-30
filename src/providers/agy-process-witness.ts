import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { cliEnvironment } from '../config.js';
import { ProxyError } from '../types.js';

export interface ProcessFact { id: number; parent: number; birth: string; image: string }
export type ProcessQuery = (parent: number, worker: number, signal: AbortSignal) => Promise<ProcessFact[]>;
export type ProcessWitness = (parent: number, worker: number, spawnedAt: number, signal: AbortSignal) => Promise<() => Promise<void>>;
const unavailable = () => new ProxyError('MCP worker process ownership could not be verified.', 503, 'mcp_process_unverified');

/** Fixed read-only CIM query. No command line, environment, prompts or secrets. */
export const queryWindowsProcesses: ProcessQuery = async (parent, worker, signal) => {
  if (process.platform !== 'win32' || ![parent, worker].every(pid => Number.isSafeInteger(pid) && pid > 0)) throw unavailable();
  const script = `Get-CimInstance Win32_Process -Filter 'ProcessId = ${parent} OR ProcessId = ${worker}' | Select-Object @{Name='id';Expression={$_.ProcessId}},@{Name='parent';Expression={$_.ParentProcessId}},@{Name='birth';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}},@{Name='image';Expression={$_.ExecutablePath}} | ConvertTo-Json -Compress`;
  const output = await new Promise<string>((resolve, reject) => {
    execFile(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { shell: false, windowsHide: true, env: cliEnvironment(), signal, timeout: 5000, maxBuffer: 8192 }, (error, stdout) => error ? reject(unavailable()) : resolve(stdout));
  });
  try { const value: unknown = JSON.parse(output); if (!Array.isArray(value)) throw unavailable(); return value; } catch { throw unavailable(); }
};

/** Process ownership is IPC evidence, not filesystem containment or caller identity in MCP. */
export function processWitness(query: ProcessQuery = queryWindowsProcesses): ProcessWitness {
  return async (parentId, workerId, spawnedAt, signal) => {
    const snapshot = async () => {
      signal.throwIfAborted();
      const facts = await query(parentId, workerId, signal);
      const parent = facts.find(p => p.id === parentId), worker = facts.find(p => p.id === workerId);
      if (!parent || !worker || worker.id === parent.id || worker.parent !== parent.id || ![parent.birth, worker.birth].every(v => typeof v === 'string' && Number.isFinite(Date.parse(v))) || Date.parse(parent.birth) > spawnedAt || Date.parse(parent.birth) > Date.parse(worker.birth) || typeof worker.image !== 'string' || typeof parent.image !== 'string' || realpathSync(worker.image) !== realpathSync(process.execPath)) throw unavailable();
      return JSON.stringify([parent.id, parent.parent, parent.birth, realpathSync(parent.image), worker.id, worker.parent, worker.birth, realpathSync(worker.image)]);
    };
    const original = await snapshot();
    return async () => { if (await snapshot() !== original) throw unavailable(); };
  };
}
