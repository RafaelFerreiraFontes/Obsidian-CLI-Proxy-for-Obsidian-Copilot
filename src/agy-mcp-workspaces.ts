import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, readFileSync } from 'node:fs';
import { mkdir, open, writeFile, rename, unlink } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SERVER_ROOT, validateExecution, type ExecutionContext } from './config.js';
import { ProxyError } from './types.js';
import { MCP_SERVER_NAME } from './providers/agy-mcp-bridge.js';

export const MCP_LAUNCHER = 'obsidian-cli-proxy-mcp.mjs';
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fail = (message: string): never => { throw new ProxyError(message, 503, 'mcp_registration_failed'); };
function object(text: string): Record<string, any> {
  const value = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Invalid MCP config object');
  return value;
}
function fingerprint(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path) return fail('MCP resources must be canonical regular files');
  return { hash: digest(readFileSync(path)), device: stat.dev, inode: stat.ino };
}
function directoryIdentity(path: string) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) return fail('MCP directory identity changed');
  return { device: stat.dev, inode: stat.ino };
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
async function atomic(path: string, text: string) {
  const temp = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  await writeFile(temp, text, { flag: 'wx', mode: 0o600 });
  try { await rename(temp, path); } finally { await unlink(temp).catch(() => {}); }
}

/** Separate operator consent from hooks. Static configuration never contains credentials. */
export class AgyMcpWorkspaceRegistry {
  constructor(readonly stateDirectory = join(SERVER_ROOT, '.local/mcp-workspaces'), readonly handler = join(SERVER_ROOT, 'dist/mcp-stdio.js')) {}
  private paths(context: ExecutionContext) {
    validateExecution(context);
    const state = resolve(this.stateDirectory), inside = relative(context.workspaceRoot, state);
    if (inside === '' || (!isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`))) fail('MCP private registry must be outside workspace');
    const directory = join(context.workspaceRoot, '.agents');
    if (existsSync(directory) && (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory() || realpathSync(directory) !== directory)) fail('MCP .agents must be a canonical directory');
    return { directory, config: join(directory, 'mcp_config.json'), launcher: join(directory, MCP_LAUNCHER), record: join(state, `${digest(context.workspaceRoot)}.json`), state };
  }
  private launcher(context: ExecutionContext) {
    return `// Managed MCP adapter; session credentials are never stored here.\nprocess.env.CLI_PROXY_MCP_WORKSPACE=${JSON.stringify(context.workspaceRoot)};\ntry{await (await import(${JSON.stringify(pathToFileURL(this.handler).href)})).serveMcp();}catch{process.stderr.write('MCP session unavailable.\\n');process.exitCode=1;}\n`;
  }
  private plan(context: ExecutionContext) {
    const paths = this.paths(context);
    if (existsSync(paths.record) || existsSync(paths.record + '.pending') || existsSync(paths.launcher)) fail('Existing or interrupted MCP registration; inspect before installing');
    const previousIdentity = existsSync(paths.config) ? fingerprint(paths.config) : null;
    const previous = previousIdentity ? readFileSync(paths.config, 'utf8') : null;
    const config = previous === null ? {} : object(previous);
    const servers = config.mcpServers === undefined ? {} : object(JSON.stringify(config.mcpServers));
    if (Object.hasOwn(servers, MCP_SERVER_NAME)) fail('Conflicting managed MCP server; no files changed');
    const node = realpathSync(process.execPath);
    const entry = { command: node, args: [paths.launcher], cwd: context.workspaceRoot, timeoutSeconds: 590 };
    const installed = JSON.stringify({ ...config, mcpServers: { ...servers, [MCP_SERVER_NAME]: entry } }, null, 2) + '\n';
    const resources = { handler: fingerprint(this.handler), node: fingerprint(node) };
    const launcher = this.launcher(context);
    const consent = digest(JSON.stringify({ operation: 'install-mcp', workspace: context.workspaceRoot, device: context.device, inode: context.inode, previousIdentity, previous, installed, launcher, resources }));
    return { paths, previousIdentity, previous, installed, entry, resources, launcher, consent };
  }
  planInstall(context: ExecutionContext) {
    const p = this.plan(context);
    return { operation: 'install-mcp', workspace: context.workspaceId, directory: context.workspaceRoot, files: [p.paths.config, p.paths.launcher], entry: p.entry, consent: p.consent, notice: 'Separate MCP consent. Preserves other servers. No tokens or global changes. Production client tools remain gated.' };
  }
  private async lock<T>(context: ExecutionContext, work: () => Promise<T>): Promise<T> {
    const paths = this.paths(context); await mkdir(paths.state, { recursive: true, mode: 0o700 });
    if (lstatSync(paths.state).isSymbolicLink() || realpathSync(paths.state) !== paths.state) fail('MCP private registry is redirected');
    const lockPath = join(paths.state, 'operator.lock'); const lock = await open(lockPath, 'wx', 0o600);
    try { return await work(); } finally { await lock.close(); await unlink(lockPath); }
  }
  async install(context: ExecutionContext, consent: string): Promise<void> {
    await this.lock(context, async () => {
      const p = this.plan(context);
      if (p.consent !== consent) throw new ProxyError('MCP consent does not match current plan.', 403, 'operator_consent_required');
      await writeFile(p.paths.record + '.pending', JSON.stringify({ workspace: context.workspaceRoot, previous: p.previous, installed: p.installed }), { flag: 'wx', mode: 0o600 });
      await mkdir(p.paths.directory, { recursive: true }); this.paths(context);
      await writeFile(p.paths.launcher, p.launcher, { flag: 'wx', mode: 0o600 });
      if (!equal(existsSync(p.paths.config) ? fingerprint(p.paths.config) : null, p.previousIdentity) || (existsSync(p.paths.config) ? readFileSync(p.paths.config, 'utf8') : null) !== p.previous) fail('MCP config changed during registration');
      this.paths(context); await atomic(p.paths.config, p.installed);
      await writeFile(p.paths.record, JSON.stringify({ version: 1, workspace: context.workspaceRoot, device: context.device, inode: context.inode, directory: directoryIdentity(p.paths.directory), entry: p.entry, previous: p.previous, installed: p.installed, resources: p.resources, config: fingerprint(p.paths.config), launcher: fingerprint(p.paths.launcher) }), { flag: 'wx', mode: 0o600 });
      await unlink(p.paths.record + '.pending');
    });
  }
  private record(context: ExecutionContext) {
    const paths = this.paths(context); fingerprint(paths.record);
    const record = object(readFileSync(paths.record, 'utf8'));
    if (record.version !== 1 || record.workspace !== context.workspaceRoot || record.device !== context.device || record.inode !== context.inode) fail('MCP workspace identity changed');
    if (!equal(directoryIdentity(paths.directory), record.directory)) fail('MCP directory replaced');
    return { paths, record };
  }
  verify(context: ExecutionContext): void {
    const { paths, record } = this.record(context);
    if (!equal(fingerprint(paths.config), record.config) || !equal(fingerprint(paths.launcher), record.launcher) || !equal(fingerprint(this.handler), record.resources.handler) || !equal(fingerprint(realpathSync(process.execPath)), record.resources.node) || readFileSync(paths.launcher, 'utf8') !== this.launcher(context) || !equal(object(readFileSync(paths.config, 'utf8')).mcpServers?.[MCP_SERVER_NAME], record.entry)) fail('MCP resource integrity changed');
  }
  private removal(context: ExecutionContext) {
    const { paths, record } = this.record(context);
    fingerprint(paths.config);
    const current = readFileSync(paths.config, 'utf8'), config = object(current);
    if (!equal(config.mcpServers?.[MCP_SERVER_NAME], record.entry) || !equal(fingerprint(paths.launcher), record.launcher)) fail('Managed MCP resources changed; refusing automatic removal');
    return { paths, record, current, config, consent: digest(JSON.stringify({ operation: 'remove-mcp', record, current })) };
  }
  planRemove(context: ExecutionContext) { const p = this.removal(context); return { operation: 'remove-mcp', workspace: context.workspaceId, directory: context.workspaceRoot, consent: p.consent }; }
  async remove(context: ExecutionContext, consent: string): Promise<void> {
    await this.lock(context, async () => {
      const p = this.removal(context);
      if (p.consent !== consent) throw new ProxyError('MCP removal requires current consent.', 403, 'operator_consent_required');
      if (p.current === p.record.installed) {
        if (p.record.previous === null) await unlink(p.paths.config); else await atomic(p.paths.config, p.record.previous);
      } else { delete p.config.mcpServers[MCP_SERVER_NAME]; await atomic(p.paths.config, JSON.stringify(p.config, null, 2) + '\n'); }
      await unlink(p.paths.launcher); await unlink(p.paths.record);
    });
  }
}
