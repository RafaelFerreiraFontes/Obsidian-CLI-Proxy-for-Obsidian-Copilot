// Windows laboratory file lease: read sharing only, no write/delete sharing.
// Holds only the disposable executable copy; never changes ACLs/preferences.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { once } from 'node:events';
import { waitForShutdown } from '../../dist/providers/base.js';

export async function pinFixtureExecutable(path) {
  if (process.platform !== 'win32') throw Error('Native Windows proof only');
  const literal = "'" + path.replaceAll("'", "''") + "'";
  const script = `$guard=[System.IO.File]::Open(${literal},[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read);[Console]::Out.WriteLine('PINNED');[Console]::In.ReadLine()|Out-Null;$guard.Dispose()`;
  const helper = spawn(join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo','-NoProfile','-NonInteractive','-Command',script], { shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  helper.stdin.on('error', () => {}); helper.stderr.resume();
  const closed = once(helper, 'close');
  const ready = new Promise((resolve, reject) => {
    let text = '';
    helper.stdout.setEncoding('utf8'); helper.stdout.on('data', chunk => { text += chunk; if (text.includes('PINNED')) resolve(); if (text.length > 128) reject(Error('Invalid file lease witness')); });
    helper.once('error', reject); helper.once('exit', () => reject(Error('File lease unavailable')));
  });
  try { await waitForShutdown(ready, 10000); }
  catch (error) { helper.kill(); await closed.catch(() => {}); throw error; }
  return { pid: helper.pid, async close() { helper.stdin.end('\n'); try { await waitForShutdown(closed, 5000); } catch (error) { helper.kill(); await closed.catch(() => {}); throw error; } } };
}
