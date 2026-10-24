// Fails if any term is incomplete, links to a missing term, or has a photo without a credit.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const decks = readdirSync(join(root, 'content/decks')).map(f => JSON.parse(readFileSync(join(root, 'content/decks', f), 'utf8')));
const credits = JSON.parse(readFileSync(join(root, 'content/credits.json'), 'utf8'));
const terms = decks.flatMap(d => d.terms);
const ids = new Set();
const problems = [];

for (const t of terms) {
  if (ids.has(t.id)) problems.push(`${t.id}: duplicate id`);
  ids.add(t.id);
}
for (const t of terms) {
  for (const f of ['term', 'def', 'spot']) if (!t[f]?.trim()) problems.push(`${t.id}: missing ${f}`);
  if (!t.ex?.length) problems.push(`${t.id}: no NYC example`);
  for (const c of t.confuse || []) if (!ids.has(c)) problems.push(`${t.id}: confuse -> unknown ${c}`);
  const img = join(root, 'content/images', t.id + '.jpg');
  // noPhoto: true marks a term with no good free photo; it's quizzed by definition instead.
  if (!existsSync(img)) { if (!t.noPhoto) problems.push(`${t.id}: no photo`); }
  else if (!credits[t.id]?.artist || !credits[t.id]?.license || !credits[t.id]?.page) problems.push(`${t.id}: photo has no full credit`);
}
for (const id of Object.keys(credits)) if (!ids.has(id)) problems.push(`credits: ${id} is not a term`);

const idx = JSON.parse(readFileSync(join(root, 'content/index.json'), 'utf8'));
if (idx.terms.length !== terms.length) problems.push('content/index.json is stale: run node scripts/build-content.js');

console.log(`${terms.length} terms in ${decks.length} decks`);
if (problems.length) { console.log(problems.join('\n')); process.exit(1); }
console.log('All terms complete.');
