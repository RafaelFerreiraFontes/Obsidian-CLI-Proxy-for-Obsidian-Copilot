// Operator relay only: invoke after an explicit human choice for these exact IDs.
// Never schedule, pipe automatic approvals, or reuse a decision from another run.
import { readFile, appendFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { relative, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
const [candidate, ...pairs] = process.argv.slice(2);
if (!candidate || !pairs.length || pairs.length % 2) throw Error('Expected TEMP_ROOT REQUEST_ID approve|deny [REQUEST_ID approve|deny]');
const root = await realpath(candidate), rel = relative(await realpath(tmpdir()), root);
if (isAbsolute(rel) || !/^agy-stage24-[a-zA-Z0-9]+$/.test(rel) || existsSync(join(root, 'evidence/result.json'))) throw Error('Fixture ended or invalid root');
const events = (await readFile(join(root, 'evidence/events.ndjson'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const pending = [];
for (const label of ['A','B']) { try { pending.push(JSON.parse(await readFile(join(root, `evidence/pending-${label}.json`), 'utf8'))); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
const decisions = [];
for (let index = 0; index < pairs.length; index += 2) {
  const requestId = pairs[index], decision = pairs[index + 1], item = pending.find(p => p.requestId === requestId);
  if (!item || !['approve','deny'].includes(decision) || !Number.isFinite(Date.parse(item.deadline)) || Date.now() >= Date.parse(item.deadline) || events.some(event => (event.event === 'operator-decision' && event.requestId === requestId) || (event.event === 'native-runner-ended' && event.session === item.session))) throw Error('Decision expired, consumed, foreign or invalid; nothing relayed');
  if (decisions.some(value => value.requestId === requestId)) throw Error('Duplicate decision');
  decisions.push({ requestId, decision });
}
await appendFile(join(root, 'operator-decisions.ndjson'), decisions.map(value => JSON.stringify(value) + '\n').join(''));
console.log(JSON.stringify({ relayed: decisions.map(value => value.requestId) }));
