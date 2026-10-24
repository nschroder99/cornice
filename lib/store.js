// IndexedDB: everything the app remembers lives here, on the phone.
//   cards    termId -> { termId, fsrs card, introduced (ISO), sorted (marked known without a lesson) }
//   log      auto id -> { termId, rating, at (ISO), kind }
//   journal  id -> { id, createdAt, address, note, tags[], photo Blob, thumb Blob }
//   settings key -> value

const DB = 'archvocab';
let dbp;

function open() {
  dbp ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('cards', { keyPath: 'termId' });
      db.createObjectStore('log', { autoIncrement: true });
      db.createObjectStore('journal', { keyPath: 'id' });
      db.createObjectStore('settings');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

const done = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function tx(store, mode, fn) {
  const db = await open();
  const t = db.transaction(store, mode);
  const result = await fn(t.objectStore(store));
  await new Promise((resolve, reject) => { t.oncomplete = resolve; t.onerror = () => reject(t.error); t.onabort = () => reject(t.error); });
  return result;
}

export const getAll = store => tx(store, 'readonly', s => done(s.getAll()));
export const get = (store, key) => tx(store, 'readonly', s => done(s.get(key)));
export const put = (store, value, key) => tx(store, 'readwrite', s => done(key === undefined ? s.put(value) : s.put(value, key)));
export const del = (store, key) => tx(store, 'readwrite', s => done(s.delete(key)));
export const clear = store => tx(store, 'readwrite', s => done(s.clear()));

export async function getSetting(key, fallback) {
  const v = await get('settings', key);
  return v === undefined ? fallback : v;
}
export const setSetting = (key, value) => put('settings', value, key);

// Backup: one JSON file with progress, settings and journal photos (as data URLs).
const toDataURL = blob => new Promise(resolve => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(blob); });

// A backup may come from someone else, so restore decodes photos locally (never fetches a URL)
// and stores them as JPEG/PNG/WebP only.
function fromDataURL(url) {
  const m = typeof url === 'string' && url.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) throw new Error('A photo in this backup is not a valid image');
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: m[1] });
}

const isStr = (v, max = 2000) => typeof v === 'string' && v.length <= max;
const isDate = v => isStr(v, 40) && !Number.isNaN(Date.parse(v));
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// Checks every record before anything is replaced. Unknown term ids are dropped rather than rejected
// so older backups still restore after a term is renamed. Returns clean copies with only known fields.
function validateBackup(data, termIds) {
  const bad = what => { throw new Error(`This backup is damaged or not from Cornice (${what})`); };
  if (!isObj(data) || data.app !== 'nyc-architecture') bad('app');
  for (const k of ['cards', 'log', 'journal']) if (!Array.isArray(data[k])) bad(k);
  if (!isObj(data.settings)) bad('settings');
  const known = id => isStr(id, 100) && termIds.has(id);

  const cards = data.cards.filter(c => isObj(c) && known(c.termId)).map(c => {
    if (!isObj(c.card) || !isDate(c.card.due) || !isDate(c.introduced)) bad('card');
    return { termId: c.termId, card: c.card, introduced: c.introduced, ...(c.sorted === true && { sorted: true }) };
  });
  const log = data.log.map(l => {
    if (!isObj(l) || !isDate(l.at)) bad('log');
    return { termId: isStr(l.termId, 100) ? l.termId : '', rating: Number(l.rating) || 0, at: l.at, kind: isStr(l.kind, 20) ? l.kind : '' };
  });
  const journal = data.journal.map(j => {
    if (!isObj(j) || !/^[A-Za-z0-9-]{1,64}$/.test(j.id ?? '') || !isDate(j.createdAt) || !Array.isArray(j.tags)) bad('journal');
    return {
      id: j.id, createdAt: j.createdAt,
      address: isStr(j.address) ? j.address : '', note: isStr(j.note, 10000) ? j.note : '',
      tags: j.tags.filter(known), photo: fromDataURL(j.photo), thumb: fromDataURL(j.thumb),
    };
  });
  const s = data.settings, settings = {};
  if (s.newPerDay !== undefined) settings.newPerDay = Math.max(0, Math.min(30, Math.round(Number(s.newPerDay)) || 0));
  if (Array.isArray(s.priority)) settings.priority = s.priority.filter(known);
  if (Array.isArray(s.sortTeach)) settings.sortTeach = s.sortTeach.filter(known);
  if (isDate(s.lastBackup)) settings.lastBackup = s.lastBackup;
  return { cards, log, journal, settings };
}

export async function exportAll() {
  const settings = {};
  await tx('settings', 'readonly', s => new Promise(resolve => {
    s.openCursor().onsuccess = e => { const c = e.target.result; if (!c) return resolve(); settings[c.key] = c.value; c.continue(); };
  }));
  const journal = await Promise.all((await getAll('journal')).map(async j => ({ ...j, photo: await toDataURL(j.photo), thumb: await toDataURL(j.thumb) })));
  return { app: 'nyc-architecture', version: 1, exportedAt: new Date().toISOString(), cards: await getAll('cards'), log: await getAll('log'), settings, journal };
}

// Replaces everything in one transaction: if any write fails, nothing on the phone changes.
export async function importAll(data, termIds) {
  const clean = validateBackup(data, termIds);
  const db = await open();
  const stores = ['cards', 'log', 'journal', 'settings'];
  const t = db.transaction(stores, 'readwrite');
  const finished = new Promise((resolve, reject) => { t.oncomplete = resolve; t.onerror = () => reject(t.error); t.onabort = () => reject(t.error || new Error('Restore aborted')); });
  try {
    for (const s of stores) t.objectStore(s).clear();
    clean.cards.forEach(c => t.objectStore('cards').put(c));
    clean.log.forEach(l => t.objectStore('log').add(l));
    clean.journal.forEach(j => t.objectStore('journal').put(j));
    Object.entries(clean.settings).forEach(([k, v]) => t.objectStore('settings').put(v, k));
  } catch (err) {
    t.abort();
    throw err;
  }
  await finished;
}
