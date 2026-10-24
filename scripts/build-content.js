// Merges the deck files, image credits and the list of files to cache offline
// into content/index.json, which is all the app loads.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLinker, references } from '../lib/links.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DECKS = ['facade', 'interior', 'styles', 'materials', 'lingo', 'architects'];
const credits = existsSync(join(root, 'content/credits.json')) ? JSON.parse(readFileSync(join(root, 'content/credits.json'), 'utf8')) : {};

const decks = DECKS.map(id => JSON.parse(readFileSync(join(root, 'content/decks', id + '.json'), 'utf8')));
const terms = decks.flatMap(d => d.terms.map(t => {
  const { q, ...rest } = t;
  const img = existsSync(join(root, 'content/images', t.id + '.jpg')) ? `content/images/${t.id}.jpg` : null;
  return { ...rest, deck: d.id, img, credit: img ? credits[t.id] || null : null };
}));

// Introduction order: round-robin across decks so early days mix exterior, interior and styles,
// except that the terms a card's text relies on (Federal -> Flemish bond, dormer, fanlight) come
// just before it. One level only, so a building block never drags in the styles it mentions.
const linkify = makeLinker(terms);
const byId = Object.fromEntries(terms.map(t => [t.id, t]));
const order = [];
const placed = new Set();
const place = id => { if (!placed.has(id)) { placed.add(id); order.push(id); } };
const queues = decks.map(d => d.terms.map(t => t.id));
while (queues.some(q => q.length)) for (const q of queues) if (q.length) {
  const id = q.shift();
  if (placed.has(id)) continue;
  references(byId[id], linkify).forEach(place);
  place(id);
}

const files = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  'lib/store.js', 'lib/srs.js', 'lib/cards.js', 'lib/links.js', 'lib/vendor/ts-fsrs.mjs', 'content/index.json',
  ...terms.filter(t => t.img).map(t => t.img)];

const version = new Date().toISOString();
writeFileSync(join(root, 'content/index.json'), JSON.stringify({ version, decks: decks.map(d => ({ id: d.id, name: d.name })), terms, order }));
writeFileSync(join(root, 'precache.json'), JSON.stringify({ version, files }));
const sw = join(root, 'sw.js');
writeFileSync(sw, readFileSync(sw, 'utf8').replace(/const VERSION = '[^']*'/, `const VERSION = '${version}'`));
console.log(`${terms.length} terms, ${terms.filter(t => t.img).length} with photos, ${files.length} files to cache`);
