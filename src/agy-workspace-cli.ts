import { pathToFileURL } from 'node:url';
import { AgyWorkspaceRegistry } from './agy-workspaces.js';
import { executionContext, loadServerEnv, readConfig } from './config.js';
import { ProxyError } from './types.js';

async function main(): Promise<void> {
  const [operation, ...args] = process.argv.slice(2);
  if (!['plan-install', 'install', 'status', 'plan-remove', 'remove'].includes(operation ?? '') || args.length % 2 || args.some((value, index) => index % 2 === 0 && !['--workspace', '--consent'].includes(value))) throw new Error('Usage: npm run agy:workspace -- plan-install|install|status|plan-remove|remove --workspace ID [--consent HASH]');
  const flags = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]]));
  if (Object.keys(flags).length !== args.length / 2) throw new Error('Duplicate flags are not supported.');
  loadServerEnv();
  const config = readConfig();
  const profile = Object.entries(config.profiles).find(([, p]) => p.provider === 'agy');
  if (!profile) throw new Error('Configure an Antigravity profile before registering a workspace.');
  const model = profile[1].models.find(m => m !== '*') ?? 'default';
  const context = executionContext(config, { identity: 'operator', client: { key: '', workspaces: Object.keys(config.workspaces), profiles: Object.keys(config.profiles) } }, flags['--workspace'] ?? '', profile[0], `agy/${model}`);
  const registry = new AgyWorkspaceRegistry();
  if (operation === 'plan-install') console.log(JSON.stringify(registry.planInstall(context), null, 2));
  else if (operation === 'plan-remove') console.log(JSON.stringify(registry.planRemove(context), null, 2));
  else if (operation === 'status') { registry.verify(context); console.log(JSON.stringify({ workspace: context.workspaceId, registered: true, resourcesVerified: true, realCLIHookLoadVerified: false })); }
  else {
    if (!flags['--consent']) throw new ProxyError('Review the plan first and provide its exact consent hash.', 403, 'operator_consent_required');
    if (operation === 'install') await registry.install(context, flags['--consent']);
    else await registry.remove(context, flags['--consent']);
    console.log(JSON.stringify({ workspace: context.workspaceId, operation, complete: true }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(error => {
  console.error(JSON.stringify({ error: { code: error instanceof ProxyError ? error.code : 'registration_failed', message: error instanceof ProxyError ? error.message : 'Registration failed. Check arguments, configured workspace and file permissions; configuration values are omitted.' } }));
  process.exitCode = 1;
});
