// Image pipeline, in two steps:
//   node scripts/fetch-images.js candidates   search Commons for each term's `q`, save
//                                             candidates.json and contact sheets to review
//   node scripts/fetch-images.js download     fetch the chosen file for each term (picks.json),
//                                             resize to 900px wide, write content/credits.json
// picks.json maps term id -> candidate index (0-5) or a full "File:..." title.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = process.env.WORK || join(root, '.images-work');
const UA = 'NYCArchVocab/0.1 (personal study app; https://github.com/nschroder99)';
const OK_LICENSE = /^(CC0|CC BY|CC BY-SA|Public domain|PD)/i;
const FONT = '/System/Library/Fonts/Supplemental/Arial.ttf';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const decks = ['facade', 'materials', 'interior', 'styles', 'architects', 'lingo']
  .map(id => JSON.parse(readFileSync(join(root, 'content/decks', id + '.json'), 'utf8')));
const terms = decks.flatMap(d => d.terms);

async function api(params) {
  const url = 'https://commons.wikimedia.org/w/api.php?' + new URLSearchParams({ format: 'json', ...params });
  for (let i = 0; i < 4; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    // Throttled requests can come back 200 with an error body instead of results.
    const d = res.ok ? await res.json() : null;
    if (d && !d.error) return d;
    await sleep(5000 * (i + 1));
  }
  throw new Error('Commons API failed: ' + url);
}

const strip = html => (html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

function info(page) {
  const ii = page.imageinfo?.[0];
  if (!ii) return null;
  const m = ii.extmetadata || {};
  return {
    title: page.title,
    thumb: ii.thumburl,
    page: ii.descriptionurl,
    license: strip(m.LicenseShortName?.value),
    artist: strip(m.Artist?.value) || 'Unknown',
    width: ii.width, height: ii.height,
  };
}

async function search(q, limit = 6) {
  const d = await api({
    action: 'query', generator: 'search', gsrnamespace: 6, gsrlimit: 20,
    gsrsearch: 'filetype:bitmap ' + q, prop: 'imageinfo', iiprop: 'url|extmetadata|size', iiurlwidth: 960,
  });
  const pages = Object.values(d.query?.pages || {}).sort((a, b) => a.index - b.index);
  return pages.map(info).filter(x => x && OK_LICENSE.test(x.license) && x.width >= 600 && !/\.(tiff?|pdf|djvu)$/i.test(x.title)).slice(0, limit);
}

async function byTitle(title) {
  const d = await api({ action: 'query', titles: title, prop: 'imageinfo', iiprop: 'url|extmetadata|size', iiurlwidth: 960 });
  return info(Object.values(d.query.pages)[0]);
}

// The lead image of the term's English Wikipedia article (t.wiki, else the term itself):
// usually a clear textbook example, which keyword search often misses.
async function wikiLead(title) {
  const url = 'https://en.wikipedia.org/w/api.php?' + new URLSearchParams({ format: 'json', action: 'query', titles: title, redirects: 1, prop: 'pageimages', piprop: 'name', pilicense: 'free' });
  const d = await fetch(url, { headers: { 'User-Agent': UA } }).then(r => r.json()).catch(() => null);
  const name = Object.values(d?.query?.pages || {})[0]?.pageimage;
  if (!name) return null;
  const c = await byTitle('File:' + name).catch(() => null);
  return c && OK_LICENSE.test(c.license) && !/\.svg$/i.test(c.title) ? c : null;
}

async function download(url, to) {
  for (let i = 0; i < 4; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.ok) { writeFileSync(to, Buffer.from(await res.arrayBuffer())); return; }
    await sleep(3000 * (i + 1));
  }
  throw new Error('download failed ' + url);
}

// Adds Wikipedia lead images to already-searched candidates, then rebuilds sheets.
async function leads() {
  const file = join(work, 'candidates.json');
  const out = JSON.parse(readFileSync(file));
  for (const t of terms) {
    const lead = await wikiLead(t.wiki || t.term.replace(/ \(.*\)$/, ''));
    if (!lead || out[t.id].some(c => c.title === lead.title)) continue;
    out[t.id].push(lead);
    await download(lead.thumb.replace(/\/\d+px-/, '/330px-'), join(work, 'thumbs', `${t.id}-${out[t.id].length - 1}.jpg`)).catch(e => console.warn(e.message));
    console.log('lead', t.id, lead.title);
    writeFileSync(file, JSON.stringify(out, null, 1));
    await sleep(300);
  }
  await candidates();
}

async function candidates() {
  mkdirSync(join(work, 'thumbs'), { recursive: true });
  const out = existsSync(join(work, 'candidates.json')) ? JSON.parse(readFileSync(join(work, 'candidates.json'))) : {};
  const only = process.argv.slice(3);
  for (const t of terms) {
    if (only.length ? !only.includes(t.id) : out[t.id]) continue;
    out[t.id] = await search(t.q);
    const lead = await wikiLead(t.wiki || t.term.replace(/ \(.*\)$/, ''));
    if (lead && !out[t.id].some(c => c.title === lead.title)) out[t.id].push(lead);
    for (const [i, c] of out[t.id].entries()) {
      const f = join(work, 'thumbs', `${t.id}-${i}.jpg`);
      await download(c.thumb.replace(/\/\d+px-/, '/330px-'), f).catch(e => console.warn(e.message));
    }
    console.log(t.id, out[t.id].length);
    await sleep(1000);
    writeFileSync(join(work, 'candidates.json'), JSON.stringify(out, null, 1));
  }
  // Contact sheets: 4 terms per sheet, one row each, candidates numbered 0-5.
  mkdirSync(join(work, 'sheets'), { recursive: true });
  const ids = only.length ? only : terms.map(t => t.id);
  for (let s = 0; s * 4 < ids.length; s++) {
    const rows = ids.slice(s * 4, s * 4 + 4).map(id => {
      const tiles = (out[id] || []).map((_, i) => join(work, 'thumbs', `${id}-${i}.jpg`)).filter(existsSync);
      const row = join(work, 'sheets', `row-${id}.jpg`);
      const args = tiles.length
        ? [...tiles.flatMap((f, i) => ['(', f, '-resize', '240x180^', '-gravity', 'center', '-extent', '240x180', '-gravity', 'NorthWest', '-font', FONT, '-fill', 'yellow', '-undercolor', 'black', '-pointsize', '22', '-annotate', '+4+2', String(i), ')']), '+append']
        : ['-size', '240x180', 'xc:gray'];
      execFileSync('magick', [...args, '(', '-size', '1680x28', 'xc:white', '-font', FONT, '-fill', 'black', '-pointsize', '20', '-annotate', '+6+21', id, ')', '-gravity', 'NorthWest', '-background', 'white', '+swap', '-append', row]);
      return row;
    });
    execFileSync('magick', [...rows, '-background', 'white', '-append', join(work, 'sheets', `sheet-${String(s).padStart(2, '0')}.jpg`)]);
  }
}

async function downloadPicks() {
  const cands = JSON.parse(readFileSync(join(work, 'candidates.json')));
  const picks = JSON.parse(readFileSync(join(work, 'picks.json')));
  const credits = existsSync(join(root, 'content/credits.json')) ? JSON.parse(readFileSync(join(root, 'content/credits.json'))) : {};
  mkdirSync(join(root, 'content/images'), { recursive: true });
  for (const [id, pick] of Object.entries(picks)) {
    const dest = join(root, 'content/images', id + '.jpg');
    const c = typeof pick === 'number' ? cands[id][pick] : await byTitle(pick);
    if (credits[id]?.title === c.title && existsSync(dest)) continue;
    const tmp = join(work, 'dl-' + id);
    await download(c.thumb, tmp);
    execFileSync('magick', [tmp, '-auto-orient', '-resize', '900x900>', '-strip', '-quality', '78', dest]);
    credits[id] = { title: c.title, page: c.page, artist: c.artist, license: c.license };
    console.log('saved', id);
    await sleep(300);
  }
  writeFileSync(join(root, 'content/credits.json'), JSON.stringify(credits, null, 1));
}

const cmd = process.argv[2];
if (cmd === 'candidates') await candidates();
else if (cmd === 'leads') await leads();
else if (cmd === 'download') await downloadPicks();
else console.log('usage: node scripts/fetch-images.js candidates [ids...] | download');
