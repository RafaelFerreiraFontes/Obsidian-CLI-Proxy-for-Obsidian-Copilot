// Isolated native proof through the real HTTP/session approval channel.
// The production runner remains blocked. Only this fixture adapter overrides its capability gate.
import { readFile, writeFile, mkdir, lstat, realpath, appendFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { buildServer } from '../../dist/index.js';
import { AgyRunner } from '../../dist/providers/agy-runner.js';
import { AgyWorkspaceRegistry } from '../../dist/agy-workspaces.js';
import { readConfig, authenticate, executionContext, SERVER_ROOT } from '../../dist/config.js';

const manifest = JSON.parse(await readFile(join(SERVER_ROOT, '.tmp/agy-stage22.json'), 'utf8'));
const base = manifest.root, root = join(base, 'http-approval');
const rel = relative(await realpath(tmpdir()), base);
if (isAbsolute(rel) || rel.startsWith('..') || (await lstat(base)).isSymbolicLink() || await realpath(base) !== base) throw Error('Unsafe fixture');
const attempt = process.argv[2] ?? 'initial';
if (!/^[a-z-]+$/.test(attempt)) throw Error('Invalid attempt');
await mkdir(root, { recursive: true });
if (await realpath(root) !== root || (await lstat(root)).isSymbolicLink() || existsSync(join(root, 'approved.txt')) || existsSync(join(root, '.agents/hooks.json'))) throw Error('Fixture is not clean for a new attempt');
const evidence = join(root, 'evidence', attempt); await mkdir(evidence, { recursive: true });
const log = join(evidence, 'events.ndjson');
if (existsSync(log)) throw Error('Attempt already recorded');
const hash = value => createHash('sha256').update(value).digest('hex');
const binary = 'C:/Users/fedet/AppData/Local/agy/bin/agy.exe';
const stable = () => { if (hash(readFileSync(binary)).toLowerCase() !== manifest.binarySha256.toLowerCase()) throw Error('AGY binary changed; abort'); };
stable();
const record = value => appendFile(log, JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n');
const key = randomBytes(32).toString('hex');
const config = readConfig({ PROXY_API_KEY: key, PROXY_WORKSPACES: JSON.stringify({ smoke: root }), PROXY_DEFAULT_WORKSPACE: 'smoke', APPROVAL_TIMEOUT_MS: '240000', AGY_ATTESTATION_TIMEOUT_MS: '240000' });
const context = executionContext(config, authenticate(config, `Bearer ${key}`), 'smoke', 'agy', 'agy/gemini-3.8-flash-medium');
class ObservedRegistry extends AgyWorkspaceRegistry {
  launcher() {
    return `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(log)},JSON.stringify({at:new Date().toISOString(),phase:'launcher-start',ready:process.argv.includes('--ready'),node:process.version,cwd:process.cwd()})+'\\n');\n` + super.launcher();
  }
}
const registry = new ObservedRegistry(join(base, 'http-registry'));
class ProofRunner extends AgyRunner {
  assertExternalHookSupport() { stable(); if (this.config.agyRegistry !== registry) throw Error('Wrong fixture registration'); }
  async *run(options) {
    yield* super.run({ ...options, onPhase: phase => { void record({ phase: 'runner-phase', value: phase }); options.onPhase?.(phase); }, onApproval: async action => {
      const name = action.action.split('\n')[0];
      let args; try { args = JSON.parse(action.action.slice(action.action.indexOf('\n') + 1)); } catch { return false; }
      const expected = [join(root, 'approved.txt'), join(root, 'second.txt')];
      const index = expected.indexOf(resolve(typeof args.Path === 'string' ? args.Path : ''));
      const valid = name === 'write_file' && index >= 0 && action.cwd === root && args.Overwrite === false && Object.keys(args).length === 3 && args.Content === (index ? 'AGY_HTTP_SECOND_DENIED' : 'AGY_HTTP_HUMAN_APPROVED');
      await record({ phase: 'bridge-approval', tool: name, actionHash: hash(action.action), fixtureIndex: index, exactAction: valid });
      if (!valid) return false;
      const decision = await options.onApproval(action); // Actual AgentSession wait; never auto-true.
      await record({ phase: 'bridge-decision', fixtureIndex: index, approved: decision });
      return decision;
    } });
  }
}
const result = { productionGateUnchanged: true, proofAdapter: true, root, outcome: 'BLOCKED' };
let app, monitor, installed = false;
try {
  await registry.install(context, registry.planInstall(context).consent); installed = true; registry.verify(context);
  app = await buildServer({ logger: false, config, providers: { agy: new ProofRunner({ executable: binary, agyRegistry: registry }), codex: { async *run() { throw Error('Not used'); } } } });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const post = async body => {
    const response = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'x-proxy-workspace': 'smoke', 'x-proxy-profile': 'agy' }, body: JSON.stringify(body), signal: AbortSignal.timeout(480000) });
    const value = await response.json(); if (!response.ok) throw Object.assign(Error('HTTP proof failed'), { code: value.error?.code }); return value.choices[0].message;
  };
  monitor = setInterval(() => { try { stable(); } catch { result.binaryChanged = true; void app.close(); } }, 2000);
  const body = { model: 'agy/gemini-3.8-flash-medium', messages: [{ role: 'user', content: `Disposable human approval test. Use exactly two write_to_file operations, in order. First create ${JSON.stringify(join(root, 'approved.txt'))} with EXACT content AGY_HTTP_HUMAN_APPROVED, Overwrite false. Wait for success; only then try to create ${JSON.stringify(join(root, 'second.txt'))} with EXACT content AGY_HTTP_SECOND_DENIED, Overwrite false. No shell, other tools, artifacts, external paths, retries or bypass. Stop immediately on any denial or error.` }] };
  const assistant = await post(body);
  const marker = /<!-- cli-proxy-approval:([a-f0-9]+\.[a-f0-9]+) -->/.exec(assistant.content ?? '');
  if (!marker || !String(assistant.content).includes('AGY_HTTP_HUMAN_APPROVED') || existsSync(join(root, 'approved.txt'))) throw Error('No exact pending approval');
  result.pendingObserved = true;
  console.log(JSON.stringify({ HUMAN_APPROVAL_REQUIRED: true, path: join(root, 'approved.txt'), content: 'AGY_HTTP_HUMAN_APPROVED', overwrite: false, workspace: root, channel: 'real proxy HTTP AgentSession approval', firstSentinelAbsent: true }));
  const decision = await new Promise(resolveDecision => {
    let text = ''; const timer = setTimeout(() => finish('negar'), 180000);
    function receive(chunk) { text += chunk; if (text.includes('\n')) finish(text.trim() === 'aprovar' ? 'aprovar' : 'negar'); }
    function finish(value) { clearTimeout(timer); process.stdin.off('data', receive); process.stdin.pause(); resolveDecision(value); }
    process.stdin.on('data', receive); process.stdin.resume();
  });
  result.humanApproved = decision === 'aprovar'; result.absentBeforeHumanDecision = !existsSync(join(root, 'approved.txt'));
  const continued = { ...body, messages: [...body.messages, assistant, { role: 'user', content: decision }] };
  const next = await post(continued);
  result.firstSentinelExists = existsSync(join(root, 'approved.txt'));
  result.contentMatches = result.firstSentinelExists && await readFile(join(root, 'approved.txt'), 'utf8') === 'AGY_HTTP_HUMAN_APPROVED';
  result.secondRequiresApproval = /<!-- cli-proxy-approval:/.test(next.content ?? '') && next.content.includes('AGY_HTTP_SECOND_DENIED') && !next.content.includes(marker[0]);
  if (result.secondRequiresApproval) await post({ ...body, messages: [...continued.messages, next, { role: 'user', content: 'negar' }] });
  result.secondSentinelAbsent = !existsSync(join(root, 'second.txt'));
  result.outcome = result.humanApproved && result.absentBeforeHumanDecision && result.contentMatches && result.secondRequiresApproval && result.secondSentinelAbsent ? 'PASS' : 'BLOCKED';
} catch (error) { result.errorCode = error.code ?? 'proof_incomplete'; }
finally {
  clearInterval(monitor); await app?.close();
  if (installed) await registry.remove(context, registry.planRemove(context).consent);
  stable(); result.cleaned = !existsSync(join(root, '.agents/hooks.json'));
  await writeFile(join(evidence, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
}
