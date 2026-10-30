// Sanitized evidence collection from explicitly listed, task-created experiments.
// Usage: node test/manual/agy-stage24-collect.mjs <absolute-temp-root> ...
import { readFile, writeFile, realpath, readdir } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const hash = text => createHash('sha256').update(text).digest('hex');
const experiments = [];
for (const candidate of process.argv.slice(2)) {
  const root = await realpath(candidate), rel = relative(await realpath(tmpdir()), root);
  if (isAbsolute(rel) || rel.startsWith('..') || !/^agy-stage24-(?:hooks-)?[a-zA-Z0-9]+$/.test(rel)) throw Error('Only explicitly created stage24 experiment roots');
  const files = [];
  for (const directory of [root, join(root, 'evidence')]) {
    let names = []; try { names = await readdir(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const name of names) if (['result.json','events.ndjson','workers.ndjson'].includes(name)) files.push(join(directory, name));
  }
  const entry = { experiment: rel, data: {} };
  for (const file of files) {
    const raw = await readFile(file, 'utf8');
    // Known filenames contain only bounded audit events, never native raw logs,
    // keys, transcripts, environment, operator files or private registry files.
    const value = file.endsWith('.ndjson') ? raw.trim().split('\n').filter(Boolean).map(JSON.parse) : JSON.parse(raw);
    entry.data[file.split(/[\\/]/).at(-1)] = JSON.parse(JSON.stringify(value).replaceAll(JSON.stringify(root).slice(1,-1), '<EXPERIMENT>'));
  }
  experiments.push(entry);
}
const historical = {};
const preflight = JSON.parse((await readFile('.tmp/agy-stage24-preflight-hashes.json','utf8')).replace(/^\uFEFF/,''));
for (const file of ['AGY_STAGE22_REPORT.md','AGY_STAGE23_REPORT.md','test/evidence/agy-stage22.json','test/evidence/agy-stage23.json','.tmp/agy-stage23-review.patch']) {
  const digest = hash(await readFile(file)); historical[file] = { sha256: digest, preserved: digest.toLowerCase() === preflight[file].toLowerCase() };
  if (!historical[file].preserved) throw Error('Historical evidence changed');
}
const evidence = { date: '2026-10-30', branch: 'feat/agy-production-mcp-bridge', initialHead: '21b85e6977c9d1d01efd208d93376e22dfaee2ce', productionEnabled: false, historical, experiments };
await writeFile('.tmp/agy-stage24-collected.json', JSON.stringify(evidence,null,2) + '\n');
console.log(JSON.stringify({ experiments: experiments.length, historicalPreserved: true }));
