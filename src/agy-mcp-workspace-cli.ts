import { pathToFileURL } from 'node:url';
import { AgyMcpWorkspaceRegistry } from './agy-mcp-workspaces.js';
import { loadServerEnv, readConfig, executionContext } from './config.js';
import { ProxyError } from './types.js';

async function main() {
  const [operation, ...args] = process.argv.slice(2);
  if (!['plan-install', 'install', 'status', 'plan-remove', 'remove'].includes(operation ?? '') || args.length % 2 || args.some((v, i) => i % 2 === 0 && !['--workspace', '--consent'].includes(v))) throw Error('Invalid MCP registration command');
  const flags = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]]));
  if (Object.keys(flags).length !== args.length / 2) throw Error('Duplicate flags');
  loadServerEnv(); const config = readConfig();
  const selected = Object.entries(config.profiles).find(([, p]) => p.provider === 'agy'); if (!selected) throw Error('AGY profile required');
  const context = executionContext(config, { identity: 'operator', client: { key: '', profiles: [selected[0]], workspaces: Object.keys(config.workspaces) } }, flags['--workspace'] ?? '', selected[0], `agy/${selected[1].models.find(m => m !== '*') ?? 'default'}`);
  const registry = new AgyMcpWorkspaceRegistry();
  if (operation === 'plan-install') console.log(JSON.stringify(registry.planInstall(context), null, 2));
  else if (operation === 'plan-remove') console.log(JSON.stringify(registry.planRemove(context), null, 2));
  else if (operation === 'status') { registry.verify(context); console.log('{"registered":true,"integrityVerified":true,"nativeToolsValidated":false}'); }
  else {
    const consent = flags['--consent']; if (!consent) throw new ProxyError('Review MCP plan and supply its consent hash.', 403, 'operator_consent_required');
    if (operation === 'install') await registry.install(context, consent); else await registry.remove(context, consent);
    console.log('{"complete":true}');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(error => { console.error(JSON.stringify({ error: { code: error instanceof ProxyError ? error.code : 'mcp_registration_failed', message: 'MCP registration failed; inspect arguments, consent, integrity and private recovery journal.' } })); process.exitCode = 1; });
