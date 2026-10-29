import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SERVER_ROOT, validateExecution, type ExecutionContext } from './config.js';
import { ProxyError } from './types.js';

const HOOK_NAME = 'obsidian-cli-proxy-approval';
export const AGY_LAUNCHER = 'obsidian-cli-proxy-launcher.mjs';
export function agyLauncherCommand(nodePath: string, platform: NodeJS.Platform = process.platform): string {
  const node = nodePath.replaceAll('\\', '/');
  // Installed Windows dispatcher escapes quotes before invoking cmd.exe. Keep
  // its command grammar deliberately small; the workspace path is never part
  // of this string. A Node installation requiring quoting fails at plan time.
  if (platform === 'win32') {
    if (!/^[A-Za-z]:\/[A-Za-z0-9_./-]+$/.test(node)) fail('Windows hook execution requires canonical Node in a path without spaces, Unicode or shell characters. Use a standard Node installation before registering.');
    return `${node} ${AGY_LAUNCHER}`;
  }
  if (/["`$%!&|<>^()\r\n]/.test(node)) fail('Node executable path contains unsupported shell characters; install Node in a standard path.');
  return `"${node}" ${AGY_LAUNCHER}`;
}
type Fingerprint = { hash: string; device: number; inode: number };
type Registration = {
  version: 1; workspace: string; device: number; inode: number;
  hooks: Fingerprint; launcher: Fingerprint; handler: Fingerprint; readyHandler: Fingerprint; credentialHelper: Fingerprint;
  entry: unknown; previousHooks: string | null; installedHooks: string;
};
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
function fail(message: string, code = 'approval_hook_failed'): never { throw new ProxyError(message, 503, code); }
function object(data: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(data.replace(/^\uFEFF/, '')); } catch { return fail('Workspace hooks.json is invalid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Workspace hooks.json must be an object.');
  return value as Record<string, unknown>;
}
function fingerprint(path: string): Fingerprint {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path) fail('Hook resources must be regular canonical files.');
  return { hash: hash(readFileSync(path)), device: stat.dev, inode: stat.ino };
}
function equal(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
async function atomicWrite(path: string, data: string): Promise<void> {
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
  try { await rename(temporary, path); }
  finally { await unlink(temporary).catch(() => {}); }
}

/** Operator-only registration. HTTP requests never call install/remove. */
export class AgyWorkspaceRegistry {
  readonly handlerPath: string;
  readonly readyHandlerPath: string;
  constructor(readonly stateDirectory = join(SERVER_ROOT, '.local', 'agy-workspaces'), handlerPath = join(SERVER_ROOT, 'dist', 'approval-hook.js'), readyHandlerPath = join(SERVER_ROOT, 'dist', 'approval-ready.js')) {
    this.handlerPath = resolve(handlerPath);
    this.readyHandlerPath = resolve(readyHandlerPath);
  }
  private statePath(root: string): string { return join(this.stateDirectory, `${hash(root)}.json`); }
  private paths(context: ExecutionContext) {
    validateExecution(context);
    const directory = join(context.workspaceRoot, '.agents');
    if (existsSync(directory) && (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory() || realpathSync(directory) !== directory)) fail('Workspace .agents must be a canonical directory, not a symlink or junction.');
    return { directory, hooks: join(directory, 'hooks.json'), launcher: join(directory, AGY_LAUNCHER) };
  }
  private launcher(): string {
    // File URL is a JS string, never a shell fragment. No workspace credentials.
    return `// Managed by Obsidian CLI Proxy; no session credentials are stored here.\nprocess.env.CLI_PROXY_REQUIRE_LEASE='1';\ntry { await import(process.argv.includes('--ready') ? ${JSON.stringify(pathToFileURL(this.readyHandlerPath).href)} : ${JSON.stringify(pathToFileURL(this.handlerPath).href)}); } catch { console.log(JSON.stringify({decision:'deny',reason:'Approval handler unavailable.'})); process.exitCode=1; }\n`;
  }
  private entry() {
    const command = agyLauncherCommand(realpathSync(process.execPath));
    const ready = { type: 'command', command: `${command} --ready`, timeout: 10 };
    return { enabled: true, SessionStart: [ready], PreInvocation: [ready], PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command, timeout: 600 }] }] };
  }
  private installation(context: ExecutionContext) {
    const paths = this.paths(context);
    if (existsSync(`${this.statePath(context.workspaceRoot)}.pending`)) fail('An interrupted installation has a recovery journal. Inspect it before installing again.');
    if (existsSync(this.statePath(context.workspaceRoot))) fail('Workspace already registered; inspect or remove the existing registration first.');
    if (existsSync(paths.launcher)) fail('Workspace launcher path already exists; refusing to overwrite it.');
    const before = existsSync(paths.hooks) ? (fingerprint(paths.hooks), readFileSync(paths.hooks, 'utf8')) : null;
    const hooks = before === null ? {} : object(before);
    if (Object.hasOwn(hooks, HOOK_NAME)) fail('Workspace already has a conflicting proxy hook. No files changed.');
    for (const value of Object.values(hooks)) {
      if (value && typeof value === 'object' && 'PreToolUse' in value && 'enabled' in value && value.enabled === false) continue;
      if (value && typeof value === 'object' && 'PreToolUse' in value && Array.isArray(value.PreToolUse) && value.PreToolUse.length) fail('An enabled third-party PreToolUse hook overlaps the approval gate; review the conflict before installing.');
    }
    const entry = this.entry();
    const installed = JSON.stringify({ [HOOK_NAME]: entry, ...hooks }, null, 2) + '\n';
    const handler = fingerprint(this.handlerPath);
    const readyHandler = fingerprint(this.readyHandlerPath);
    const credentialHelper = fingerprint(join(SERVER_ROOT, 'dist', 'hook-credentials.js'));
    const launcher = this.launcher();
    const consent = hash(JSON.stringify({ operation: 'install', root: context.workspaceRoot, device: context.device, inode: context.inode, before, installed, launcher, handler, readyHandler, credentialHelper }));
    return { paths, before, installed, entry, handler, readyHandler, credentialHelper, launcher, consent };
  }
  planInstall(context: ExecutionContext) {
    const plan = this.installation(context);
    return { operation: 'install', workspace: context.workspaceId, directory: context.workspaceRoot, files: [plan.paths.hooks, plan.paths.launcher], entry: plan.entry, registry: this.statePath(context.workspaceRoot), consent: plan.consent, notice: 'Writes only these two workspace files and a local registration/backup. Existing third-party hooks are retained. No tokens are stored.' };
  }
  private async lock<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    const path = join(this.stateDirectory, 'operator.lock');
    const lock = await open(path, 'wx', 0o600).catch(() => fail('Another registration operation is active; inspect operator.lock if an earlier process crashed.'));
    try { return await work(); } finally { await lock.close(); await unlink(path); }
  }
  async install(context: ExecutionContext, consent: string): Promise<void> {
    await this.lock(async () => {
      const plan = this.installation(context);
      if (consent !== plan.consent) fail('Consent does not match the current installation plan. Run plan-install again.', 'operator_consent_required');
      const recoveryPath = `${this.statePath(context.workspaceRoot)}.pending`;
      const recovery = await open(recoveryPath, 'wx', 0o600);
      try {
        await recovery.writeFile(JSON.stringify({ version: 1, workspace: context.workspaceRoot, previousHooks: plan.before, installedHooks: plan.installed, entry: plan.entry }));
        await recovery.sync();
      } finally { await recovery.close(); }
      await mkdir(plan.paths.directory, { recursive: true });
      this.paths(context);
      await writeFile(plan.paths.launcher, plan.launcher, { flag: 'wx', mode: 0o600 });
      try {
        this.paths(context);
        if ((existsSync(plan.paths.hooks) ? readFileSync(plan.paths.hooks, 'utf8') : null) !== plan.before) fail('Workspace hooks changed during registration; no hooks were overwritten.');
        await atomicWrite(plan.paths.hooks, plan.installed);
        const record: Registration = { version: 1, workspace: context.workspaceRoot, device: context.device, inode: context.inode,
          hooks: fingerprint(plan.paths.hooks), launcher: fingerprint(plan.paths.launcher), handler: plan.handler, readyHandler: plan.readyHandler, credentialHelper: plan.credentialHelper,
          entry: plan.entry, previousHooks: plan.before, installedHooks: plan.installed };
        await writeFile(this.statePath(context.workspaceRoot), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
        await unlink(recoveryPath);
      } catch (error) {
        // No trusted registration exists after a partial install: execution stays blocked.
        // Leave the files for explicit inspection instead of overwriting a concurrent edit.
        throw error;
      }
    });
  }
  private record(context: ExecutionContext): Registration {
    try {
      const path = this.statePath(context.workspaceRoot);
      fingerprint(path);
      const record = JSON.parse(readFileSync(path, 'utf8')) as Registration;
      if (record.version !== 1 || record.workspace !== context.workspaceRoot || record.device !== context.device || record.inode !== context.inode) fail('Workspace registration does not match the authorized directory.');
      return record;
    } catch (error) { if (error instanceof ProxyError) throw error; return fail('Workspace has no valid Antigravity hook registration. Run agy:workspace plan-install.', 'approval_hook_missing'); }
  }
  verify(context: ExecutionContext): void {
    const paths = this.paths(context);
    const record = this.record(context);
    if (!equal(record.entry, this.entry())) fail('Registered hook command requires migration. Review plan-remove/remove, then plan-install/install with fresh consent; existing resources are not rewritten automatically.');
    try {
      if (!equal(fingerprint(paths.hooks), record.hooks) || !equal(fingerprint(paths.launcher), record.launcher) || !equal(fingerprint(this.handlerPath), record.handler) || !equal(fingerprint(this.readyHandlerPath), record.readyHandler) || !equal(fingerprint(join(SERVER_ROOT, 'dist', 'hook-credentials.js')), record.credentialHelper)
        || readFileSync(paths.launcher, 'utf8') !== this.launcher() || !equal(object(readFileSync(paths.hooks, 'utf8'))[HOOK_NAME], this.entry()) || !equal(record.entry, this.entry())) fail('Registered hook, launcher or handler changed; execution blocked.');
    } catch (error) { if (error instanceof ProxyError) throw error; fail('Registered hook resource is missing or unavailable.', 'approval_hook_missing'); }
  }
  private removal(context: ExecutionContext) {
    const paths = this.paths(context);
    const record = this.record(context);
    const current = readFileSync(paths.hooks, 'utf8');
    const hooks = object(current);
    if (!equal(hooks[HOOK_NAME], record.entry) || !equal(fingerprint(paths.launcher), record.launcher)) fail('Managed resources changed; refusing automatic removal. Restore/inspect them first.');
    const consent = hash(JSON.stringify({ operation: 'remove', root: context.workspaceRoot, record, current }));
    return { paths, record, current, hooks, consent };
  }
  planRemove(context: ExecutionContext) {
    const plan = this.removal(context);
    return { operation: 'remove', workspace: context.workspaceId, directory: context.workspaceRoot, files: [plan.paths.hooks, plan.paths.launcher], consent: plan.consent, notice: 'Removes only the managed hook/launcher. Restores original hooks bytes if unchanged; otherwise preserves current third-party hooks.' };
  }
  async remove(context: ExecutionContext, consent: string): Promise<void> {
    await this.lock(async () => {
      const plan = this.removal(context);
      if (consent !== plan.consent) fail('Consent does not match the current removal plan.', 'operator_consent_required');
      if (plan.current === plan.record.installedHooks) {
        if (plan.record.previousHooks === null) await unlink(plan.paths.hooks);
        else await atomicWrite(plan.paths.hooks, plan.record.previousHooks);
      } else {
        delete plan.hooks[HOOK_NAME];
        await atomicWrite(plan.paths.hooks, JSON.stringify(plan.hooks, null, 2) + '\n');
      }
      await unlink(plan.paths.launcher);
      await unlink(this.statePath(context.workspaceRoot));
      await unlink(`${this.statePath(context.workspaceRoot)}.pending`).catch(() => {});
      // Keep .agents: it may contain user resources or concurrent additions.
    });
  }
}
