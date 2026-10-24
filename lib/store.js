// IndexedDB: everything the app remembers lives here, on the phone.
//   cards    termId -> { termId, fsrs card, introduced (ISO), priority }
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
const fromDataURL = url => fetch(url).then(r => r.blob());

export async function exportAll() {
  const settings = {};
  await tx('settings', 'readonly', s => new Promise(resolve => {
    s.openCursor().onsuccess = e => { const c = e.target.result; if (!c) return resolve(); settings[c.key] = c.value; c.continue(); };
  }));
  const journal = await Promise.all((await getAll('journal')).map(async j => ({ ...j, photo: await toDataURL(j.photo), thumb: await toDataURL(j.thumb) })));
  return { app: 'nyc-architecture', version: 1, exportedAt: new Date().toISOString(), cards: await getAll('cards'), log: await getAll('log'), settings, journal };
}

export async function importAll(data) {
  if (data?.app !== 'nyc-architecture') throw new Error('Not a backup from this app');
  const journal = await Promise.all(data.journal.map(async j => ({ ...j, photo: await fromDataURL(j.photo), thumb: await fromDataURL(j.thumb) })));
  for (const s of ['cards', 'log', 'journal', 'settings']) await clear(s);
  await tx('cards', 'readwrite', s => { data.cards.forEach(c => s.put(c)); });
  await tx('log', 'readwrite', s => { data.log.forEach(l => s.add(l)); });
  await tx('journal', 'readwrite', s => { journal.forEach(j => s.put(j)); });
  await tx('settings', 'readwrite', s => { Object.entries(data.settings).forEach(([k, v]) => s.put(v, k)); });
}
