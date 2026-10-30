// Creates only a disposable fixture manifest. Never installs hooks, logs in, or updates AGY.
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { SERVER_ROOT } from '../../dist/config.js';

const manifest = join(SERVER_ROOT, '.tmp/agy-stage22.json');
if (existsSync(manifest)) throw Error('Existing fixture manifest; preserve its evidence before preparing another experiment');
const binary = 'C:/Users/fedet/AppData/Local/agy/bin/agy.exe';
const expected = 'fade3d94282b8c1b12a24e54ffa930183bd6f6ff7a73a90421fb0aab4d9402ba';
const binarySha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
if (binarySha256 !== expected) throw Error('Executable differs from the reviewed AGY 1.4.10 experiment; investigate before testing');
for (const file of ['approval-hook.js', 'approval-ready.js', 'mcp-stdio.js']) if (!existsSync(join(SERVER_ROOT, 'dist', file))) throw Error('Run npm run build first');
await mkdir(join(SERVER_ROOT, '.tmp'), { recursive: true });
const root = await realpath(await mkdtemp(join(tmpdir(), 'agy-stage22-')));
const initialHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: SERVER_ROOT, encoding: 'utf8', windowsHide: true }).trim();
await writeFile(manifest, JSON.stringify({ initialHead, binarySha256, root }, null, 2), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ root, binarySha256, manifest, installedHooks: false, installedMcp: false }));
