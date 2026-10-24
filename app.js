import * as db from './lib/store.js';
import { newCard, rate, preview, humanInterval, isLearned, Rating, State } from './lib/srs.js';
import { buildPrompt, buildQueue } from './lib/cards.js';
import { makeLinker } from './lib/links.js';

const app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Lookup tables keyed by ids from links or backups have no prototype, so names like 'constructor'
// or '__proto__' are simply absent instead of resolving to built-ins.
const dict = (entries = []) => Object.assign(Object.create(null), Object.fromEntries(entries));
const dayKey = d => { const x = new Date(d); return `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()}`; };

let content, cards = dict(), journal = [], photos = dict(), linkify;
const urls = new Map(); // journal blob -> object URL, made once

function blobURL(blob) {
  if (!urls.has(blob)) urls.set(blob, URL.createObjectURL(blob));
  return urls.get(blob);
}

async function load() {
  content = await fetch('content/index.json').then(r => r.json());
  content.byId = dict(content.terms.map(t => [t.id, t]));
  content.byDeck = dict(content.decks.map(d => [d.id, content.terms.filter(t => t.deck === d.id)]));
  content.deckName = dict(content.decks.map(d => [d.id, d.name]));
  linkify = makeLinker(content.terms);
  await refresh();
}

async function refresh() {
  cards = dict((await db.getAll('cards')).map(c => [c.termId, c]));
  journal = (await db.getAll('journal')).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  photos = dict();
  for (const t of content.terms) if (t.img) photos[t.id] = [{ src: t.img, mine: false }];
  for (const j of journal) for (const id of j.tags.filter(id => content.byId[id])) {
    (photos[id] ||= []).push({ src: blobURL(j.photo), mine: true, caption: j.address ? `Seen by you · ${j.address}` : `Seen by you · ${new Date(j.createdAt).toLocaleDateString()}`, entry: j.id });
  }
}

async function stats() {
  const log = await db.getAll('log');
  const days = new Set(log.map(l => dayKey(l.at)));
  let streak = 0;
  const d = new Date();
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1); // today not done yet doesn't break the streak
  while (days.has(dayKey(d))) { streak++; d.setDate(d.getDate() - 1); }
  const today = dayKey(new Date());
  const introducedToday = Object.values(cards).filter(c => !c.sorted && dayKey(c.introduced) === today).length;
  const reviewedToday = log.filter(l => dayKey(l.at) === today).length;
  return { streak, introducedToday, reviewedToday };
}

async function queue() {
  const { introducedToday } = await stats();
  return buildQueue({ content, cards, now: new Date(), newPerDay: await db.getSetting('newPerDay', 5), introducedToday, priority: await db.getSetting('priority', []) });
}

// Definition text with other glossary terms as tappable words; `used` keeps it to one link per term per card.
const rich = (text, selfId, used) => linkify(text, selfId, used)
  .map(s => s.id ? `<button type="button" class="tlink" data-term="${esc(s.id)}">${esc(s.text)}</button>` : esc(s.text)).join('');
const defAndSpot = (t, skipDef = false) => {
  const used = new Set();
  return `${skipDef ? '' : `<p class="def">${rich(t.def, t.id, used)}</p>`}<p class="spot">${rich(t.spot, t.id, used)}</p>`;
};

// A tapped term opens a sheet over whatever you're doing, so a review session isn't lost.
function openSheet(id) {
  const t = content.byId[id];
  if (!t) return;
  document.querySelector('.sheet-wrap')?.remove();
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  const reviewing = document.body.classList.contains('reviewing');
  wrap.innerHTML = `<div class="sheet" role="dialog" aria-label="${esc(t.term)}">
    ${t.img ? `<img src="${esc(t.img)}" alt="">` : ''}
    <div class="body"><p class="term">${esc(t.term)}</p>${t.era ? `<p class="era">${esc(t.era)}</p>` : ''}
      ${defAndSpot(t)}
      <div class="sheet-actions">${reviewing ? '' : `<a class="btn" href="#/term/${esc(t.id)}">Open card</a>`}<button class="btn primary" data-close>Close</button></div>
    </div></div>`;
  wrap.addEventListener('click', e => { if (e.target === wrap || e.target.closest('[data-close]') || e.target.closest('a')) wrap.remove(); });
  document.body.append(wrap);
}
document.addEventListener('click', e => {
  const b = e.target.closest('.tlink');
  if (b) { e.preventDefault(); openSheet(b.dataset.term); }
});
addEventListener('hashchange', () => document.querySelector('.sheet-wrap')?.remove());

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  document.body.append(el);
  setTimeout(() => el.remove(), 2200);
}

const status = id => { const c = cards[id]; return !c ? '' : isLearned(c.card) ? 'learned' : 'learning'; };
const credit = t => t.credit ? `<p class="credit">Photo: <a href="${esc(t.credit.page)}" target="_blank" rel="noopener">${esc(t.credit.artist)}</a>, ${esc(t.credit.license)}, via Wikimedia Commons</p>` : '';

/* ---------- Today ---------- */

async function viewToday() {
  const seq = navSeq;
  const q = await queue();
  const s = await stats();
  const nNew = q.filter(x => x.isNew).length, nDue = q.length - nNew;
  const decks = content.decks.map(d => {
    const total = content.byDeck[d.id].length;
    const learned = content.byDeck[d.id].filter(t => cards[t.id] && isLearned(cards[t.id].card)).length;
    return `<li><span>${esc(d.name)}</span><span class="n">${learned} / ${total}</span><div class="track"><div class="fill" style="width:${(learned / total) * 100}%"></div></div></li>`;
  }).join('');
  const nextDue = Object.values(cards).map(c => new Date(c.card.due)).filter(d => d > new Date()).sort((a, b) => a - b)[0];
  const unsorted = (await sortQueue()).length;
  if (stale(seq)) return;
  app.innerHTML = `
    <header class="top"><p class="eyebrow">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p><h1>Cornice</h1></header>
    <section class="hero">
      ${q.length ? `
        <p class="eyebrow">Today’s review</p>
        <div class="big">${q.length}</div>
        <p class="muted">${nDue} due${nNew ? ` · ${nNew} new term${nNew > 1 ? 's' : ''}` : ''} · about ${Math.max(1, Math.round(q.length * 0.25))} min</p>
        <a class="btn primary block" href="#/review">Start</a>` : `
        <p class="eyebrow">Today’s review</p>
        <div class="big">Done</div>
        <p class="muted">${nextDue ? `Next card in ${humanInterval(nextDue)}.` : 'Nothing due.'} Go spot something.</p>
        <a class="btn block" href="#/journal/new">Add a sighting</a>`}
    </section>
    ${unsorted ? `<a class="sortlink" href="#/sort"><b>Already know some of these?</b><span>Sort the terms you’re confident on so reviews focus on the rest · ${unsorted} to go</span></a>` : ''}
    <div class="stats">
      <div class="stat"><b>${s.streak}</b><span>day streak</span></div>
      <div class="stat"><b>${Object.values(cards).filter(c => isLearned(c.card)).length}</b><span>learned</span></div>
      <div class="stat"><b>${journal.length}</b><span>sightings</span></div>
    </div>
    <h3>Decks</h3>
    <ul class="bars">${decks}</ul>`;
}

/* ---------- Review ---------- */

async function viewReview() {
  const seq = navSeq;
  let q = await queue();
  if (stale(seq)) return;
  const total = q.length;
  let doneCount = 0;
  if (!q.length) return viewToday();
  document.body.classList.add('reviewing');

  const bar = document.createElement('div');
  bar.className = 'answer-bar';
  bar.innerHTML = '<div class="inner"></div>';
  document.body.append(bar);
  const barInner = bar.firstChild;
  cleanup = () => { bar.remove(); document.body.classList.remove('reviewing'); };

  const next = () => {
    if (!q.length) {
      cleanup();
      app.innerHTML = `<div class="done"><p class="big">That’s today.</p><p class="muted">${doneCount} cards reviewed.</p><p><a class="btn primary" href="#/">Back to Today</a></p></div>`;
      return;
    }
    const item = q.shift();
    const term = content.byId[item.termId];
    const prompt = buildPrompt(term, { content, photos, isNew: item.isNew });
    render(prompt, item);
  };

  let busy = false;
  const finish = async (term, rating, item, kind) => {
    if (busy) return; // ignore double taps
    busy = true;
    const now = new Date();
    const rec = cards[term.id] || { termId: term.id, card: newCard(now), introduced: now.toISOString() };
    rec.card = rate(rec.card, rating, now);
    cards[term.id] = rec;
    await db.put('cards', rec);
    await db.put('log', { termId: term.id, rating, at: now.toISOString(), kind });
    if (item.isNew) {
      const pr = await db.getSetting('priority', []);
      if (pr.includes(term.id)) await db.setSetting('priority', pr.filter(x => x !== term.id));
    }
    // Short learning steps come back later in this same session.
    if (new Date(rec.card.due) - now < 20 * 60000) q.push({ termId: term.id, isNew: false });
    else doneCount++;
    busy = false;
    next();
  };

  const top = () => `<div class="session-top"><a class="link" href="#/" aria-label="End session">✕</a><div class="progress"><div style="width:${(doneCount / Math.max(total, doneCount + q.length + 1)) * 100}%"></div></div><span class="small muted">${q.length + 1}</span></div>`;
  const photoBlock = p => p ? `<div class="photo"><img src="${esc(p.src)}" alt="">${p.mine ? `<span class="cap">${esc(p.caption)}</span>` : ''}</div>` : '';
  const reveal = (t, p, skipDef = false) => `
    <p class="term">${esc(t.term)}</p>${t.era ? `<p class="era">${esc(t.era)}</p>` : ''}
    ${defAndSpot(t, skipDef)}
    <div class="ex"><span class="eyebrow">In New York</span><ul>${t.ex.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>
    ${t.confuse?.length ? `<p class="small muted">Don’t confuse with ${t.confuse.map(id => esc(content.byId[id]?.term)).join(', ')}.</p>` : ''}
    ${!p || !p.mine ? credit(t) : ''}`;

  const grades = (term, item, kind) => {
    const pv = preview(cards[term.id]?.card || newCard());
    barInner.innerHTML = `<div class="grades">
      <button class="again" data-r="${Rating.Again}">Again<small>${humanInterval(pv[Rating.Again])}</small></button>
      <button data-r="${Rating.Hard}">Hard<small>${humanInterval(pv[Rating.Hard])}</small></button>
      <button class="good" data-r="${Rating.Good}">Good<small>${humanInterval(pv[Rating.Good])}</small></button>
      <button data-r="${Rating.Easy}">Easy<small>${humanInterval(pv[Rating.Easy])}</small></button></div>`;
    barInner.querySelectorAll('button').forEach(b => b.onclick = () => finish(term, +b.dataset.r, item, kind));
  };
  const single = (label, fn, primary = true) => {
    barInner.innerHTML = `<button class="btn ${primary ? 'primary' : ''} block">${label}</button>`;
    barInner.firstChild.onclick = fn;
  };

  function render(p, item) {
    const t = p.term;
    window.scrollTo(0, 0);
    if (p.kind === 'learn') {
      const ph = photos[t.id]?.[0];
      app.innerHTML = `${top()}<article class="card">${photoBlock(ph)}<div class="body"><span class="newtag">New · ${esc(content.deckName[t.deck])}</span>${reveal(t, ph)}</div></article>`;
      single('Got it', () => finish(t, Rating.Good, item, 'learn'));
      return;
    }
    if (p.kind === 'recall') {
      app.innerHTML = `${top()}<article class="card">${photoBlock(p.photo)}<div class="body">
        <p class="ask">${p.photo ? (t.deck === 'architects' ? 'Who designed this?' : t.deck === 'styles' ? 'What style is this?' : 'What’s this called?') : 'Name the term'}</p>
        ${p.photo ? '' : `<p class="def">${rich(t.def, t.id)}</p>`}
        <div id="ans"></div></div></article>`;
      single('Show answer', () => {
        document.getElementById('ans').innerHTML = reveal(t, p.photo, !p.photo);
        grades(t, item, 'recall');
      });
      return;
    }
    if (p.kind === 'pickName' || p.kind === 'pair') {
      const ask = p.kind === 'pair' ? 'Which is it?' : t.deck === 'architects' ? 'Who designed this?' : t.deck === 'styles' ? 'What style is this?' : 'What’s this called?';
      app.innerHTML = `${top()}<article class="card">${photoBlock(p.photo)}<div class="body"><p class="ask">${ask}</p>
        <div class="choices">${p.choices.map(c => `<button data-id="${esc(c.id)}">${esc(c.term)}</button>`).join('')}</div><div id="ans"></div></div></article>`;
      barInner.innerHTML = '';
      app.querySelectorAll('.choices button').forEach(b => b.onclick = () => answered(b.dataset.id === t.id, b));
    }
    if (p.kind === 'pickPhoto') {
      app.innerHTML = `${top()}<article class="card"><div class="body"><p class="ask">Tap the</p><p class="term">${esc(t.term)}</p></div>
        <div class="tiles">${p.tiles.map(x => `<button data-id="${esc(x.term.id)}"><img src="${esc(x.photo.src)}" alt=""></button>`).join('')}</div><div class="body" id="ans" style="padding-top:0"></div></article>`;
      barInner.innerHTML = '';
      app.querySelectorAll('.tiles button').forEach(b => b.onclick = () => answered(b.dataset.id === t.id, b));
    }

    function answered(ok, chosen) {
      app.querySelectorAll('.choices button, .tiles button').forEach(b => {
        b.disabled = true;
        if (b.dataset.id === t.id) b.classList.add('right');
        if (p.kind === 'pickPhoto') b.insertAdjacentHTML('beforeend', `<span class="label">${esc(content.byId[b.dataset.id].term)}</span>`);
      });
      if (!ok) chosen.classList.add('wrong');
      const ph = p.photo || photos[t.id]?.[0];
      document.getElementById('ans').innerHTML = `<p class="feedback ${ok ? 'ok' : 'no'}">${ok ? 'Right.' : `It’s ${esc(t.term)}.`}</p>` + reveal(t, ph);
      if (ok) {
        barInner.innerHTML = `<div class="grades" style="grid-template-columns:1fr 2fr 1fr"><button data-r="${Rating.Hard}">Hard<small>was a guess</small></button><button class="good" data-r="${Rating.Good}">Good</button><button data-r="${Rating.Easy}">Easy</button></div>`;
        barInner.querySelectorAll('button').forEach(b => b.onclick = () => finish(t, +b.dataset.r, item, p.kind));
      } else single('Continue', () => finish(t, Rating.Again, item, p.kind));
    }
  }

  next();
}

/* ---------- Glossary ---------- */

function termRow(t) {
  const thumb = photos[t.id]?.find(p => !p.mine)?.src || photos[t.id]?.[0]?.src;
  return `<li><a href="#/term/${esc(t.id)}">${thumb ? `<img class="thumb" src="${esc(thumb)}" alt="" loading="lazy">` : '<span class="thumb"></span>'}<span style="min-width:0"><span class="t">${esc(t.term)}</span><span class="m">${esc(t.era || t.def)}</span></span><span class="dot ${status(t.id)}"></span></a></li>`;
}

function viewGlossary() {
  app.innerHTML = `
    <header class="top"><p class="eyebrow">${content.terms.length} terms</p><h1>Glossary</h1></header>
    <input class="search" type="search" placeholder="Search terms, buildings, architects" id="q" autocomplete="off">
    <div id="results"></div>`;
  const results = document.getElementById('results');
  const decksHTML = `<h3>Decks</h3><div class="deckgrid">${content.decks.map(d => {
    const cover = content.byDeck[d.id].find(t => t.img);
    return `<a href="#/deck/${esc(d.id)}">${cover ? `<img src="${esc(cover.img)}" alt="" loading="lazy">` : ''}<span>${esc(d.name)}<small>${content.byDeck[d.id].length} terms</small></span></a>`;
  }).join('')}</div>`;
  const show = () => {
    const s = document.getElementById('q').value.trim().toLowerCase();
    if (!s) { results.innerHTML = decksHTML; return; }
    const hits = content.terms.filter(t => [t.term, t.def, t.spot, ...t.ex].join(' ').toLowerCase().includes(s))
      .sort((a, b) => (b.term.toLowerCase().includes(s)) - (a.term.toLowerCase().includes(s)));
    results.innerHTML = hits.length ? `<ul class="list" style="margin-top:12px">${hits.map(termRow).join('')}</ul>` : '<p class="empty">No matches.</p>';
  };
  document.getElementById('q').oninput = show;
  show();
}

function viewDeck(id) {
  const terms = content.byDeck[id];
  if (!terms) return viewGlossary();
  app.innerHTML = `<a class="back" href="#/glossary">‹ Glossary</a>
    <header class="top" style="padding-top:6px"><p class="eyebrow">${terms.length} terms</p><h1>${esc(content.deckName[id])}</h1></header>
    <ul class="list">${terms.map(termRow).join('')}</ul>`;
  const seq = navSeq;
  sortQueue(id).then(q => { if (q.length && !stale(seq)) app.querySelector('header.top').insertAdjacentHTML('afterend', `<a class="btn block" href="#/sort/${esc(id)}" style="margin-bottom:12px">Sort what I already know · ${q.length}</a>`); });
}

/* ---------- Sort what you already know ---------- */

// Terms never introduced and not already marked "teach me", in the order lessons would bring them.
async function sortQueue(deck) {
  const teach = new Set(await db.getSetting('sortTeach', []));
  return content.order.filter(id => !cards[id] && !teach.has(id) && (!deck || content.byId[id].deck === deck));
}

async function viewSort(deck) {
  if (deck && !content.byDeck[deck]) return viewGlossary();
  const seq = navSeq;
  const q = await sortQueue(deck);
  if (stale(seq)) return;
  const total = q.length;
  const history = []; // for Undo: { id, choice }
  let known = 0, teach = 0;
  document.body.classList.add('reviewing');
  cleanup = () => document.body.classList.remove('reviewing');

  const bar = () => `<div class="session-top"><a class="link" href="${deck ? `#/deck/${esc(deck)}` : '#/'}" aria-label="Done sorting">✕</a>
    <div class="progress"><div style="width:${(history.length / Math.max(1, total)) * 100}%"></div></div>
    <button class="link" id="undo" ${history.length ? '' : 'disabled'}>Undo</button></div>`;

  function render() {
    window.scrollTo(0, 0);
    const id = q[history.length];
    if (!id) {
      app.innerHTML = `<div class="done"><p class="big">All sorted.</p>
        <p class="muted">${known} marked as known${known ? ': each comes back once over the next week or so for a quick check' : ''}.<br>${teach} left for your daily lessons.</p>
        <p><a class="btn primary" href="#/">Back to Today</a></p></div>`;
      return;
    }
    const t = content.byId[id];
    app.innerHTML = `${bar()}<article class="card">${t.img ? `<div class="photo"><img src="${esc(t.img)}" alt=""></div>` : ''}<div class="body">
      <span class="newtag">${esc(content.deckName[t.deck])} · ${history.length + 1} of ${total}</span>
      <p class="term">${esc(t.term)}</p>${t.era ? `<p class="era">${esc(t.era)}</p>` : ''}
      ${defAndSpot(t)}${credit(t)}</div></article>
      <div class="answer-bar"><div class="inner"><div class="grades" style="grid-template-columns:1fr 1fr">
        <button data-c="teach">Teach me<small>add to lessons</small></button>
        <button class="good" data-c="known">I know this<small>check once later</small></button></div></div></div>`;
    app.querySelector('#undo').onclick = undo;
    app.querySelectorAll('[data-c]').forEach(b => b.onclick = () => choose(id, b.dataset.c));
  }

  async function choose(id, choice) {
    if (choice === 'known') {
      // Scheduled as an easy first review, then pulled in to 2-9 days so the check comes soon and spread out.
      const now = new Date();
      const card = rate(newCard(now), Rating.Easy, now);
      card.due = new Date(now.getTime() + (2 + Math.random() * 7) * 86400000).toISOString();
      const rec = { termId: id, card, introduced: now.toISOString(), sorted: true };
      cards[id] = rec;
      await db.put('cards', rec);
      known++;
    } else {
      await db.setSetting('sortTeach', [...await db.getSetting('sortTeach', []), id]);
      teach++;
    }
    history.push({ id, choice });
    render();
  }

  async function undo() {
    const last = history.pop();
    if (!last) return;
    if (last.choice === 'known') { delete cards[last.id]; await db.del('cards', last.id); known--; }
    else { await db.setSetting('sortTeach', (await db.getSetting('sortTeach', [])).filter(x => x !== last.id)); teach--; }
    render();
  }

  render();
}

function viewTerm(id) {
  const t = content.byId[id];
  if (!t) return viewGlossary();
  const c = cards[id];
  const mine = (photos[id] || []).filter(p => p.mine);
  const st = !c ? 'Not introduced yet.' : `${isLearned(c.card) ? 'Learned' : 'Learning'} · next review in ${humanInterval(c.card.due)}`;
  app.innerHTML = `<a class="back" href="#/deck/${esc(t.deck)}">‹ ${esc(content.deckName[t.deck])}</a>
    <article class="card">${t.img ? `<div class="photo"><img src="${esc(t.img)}" alt=""></div>` : ''}<div class="body">
      <p class="term">${esc(t.term)}</p>${t.era ? `<p class="era">${esc(t.era)}</p>` : ''}
      ${defAndSpot(t)}
      <div class="ex"><span class="eyebrow">In New York</span><ul>${t.ex.map(e => `<li>${esc(e)}</li>`).join('')}</ul></div>
      ${t.confuse?.length ? `<h3>Don’t confuse with</h3><div class="chips">${t.confuse.map(cid => `<a class="chip" href="#/term/${esc(cid)}">${esc(content.byId[cid].term)}</a>`).join('')}</div>` : ''}
      ${credit(t)}
    </div></article>
    <h3>Your sightings</h3>
    ${mine.length ? `<div class="seen">${mine.map(p => `<a href="#/journal/${esc(p.entry)}"><img src="${esc(p.src)}" alt=""></a>`).join('')}</div>` : `<p class="small muted">None yet. <a href="#/journal/new?tag=${esc(id)}">Add one</a></p>`}
    <p class="status" style="margin-top:20px">${st}</p>
    ${c ? '' : `<button class="btn block" id="learn" style="margin-top:8px">Add to next review</button>`}`;
  document.getElementById('learn')?.addEventListener('click', async () => {
    await addPriority([id]);
    toast('Added to your next review');
    document.getElementById('learn').remove();
  });
}

async function addPriority(ids) {
  const pr = await db.getSetting('priority', []);
  await db.setSetting('priority', [...new Set([...ids.filter(id => !cards[id]), ...pr])]);
}

/* ---------- Journal ---------- */

let journalMode = 'date';
function viewJournal() {
  const fab = `<a class="fab" href="#/journal/new" aria-label="Add a sighting"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></a>`;
  const tile = j => `<a href="#/journal/${esc(j.id)}"><img src="${esc(blobURL(j.thumb))}" alt="" loading="lazy"><p class="t">${esc(j.address || j.tags.map(id => content.byId[id]?.term).filter(Boolean).join(', ') || 'Untitled')}</p><p class="m">${new Date(j.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</p></a>`;
  let body;
  if (!journal.length) body = `<div class="empty"><p>Photograph a building you see at a showing and tag the features you can name.</p><p>Your photos then show up in your reviews.</p><p><a class="btn primary" href="#/journal/new">Add your first sighting</a></p></div>`;
  else if (journalMode === 'date') body = `<div class="jgrid">${journal.map(tile).join('')}</div>`;
  else {
    const group = journalMode === 'style' ? t => t.deck === 'styles' : t => t.deck !== 'styles';
    const byTerm = dict();
    for (const j of journal) for (const id of j.tags) if (content.byId[id] && group(content.byId[id])) (byTerm[id] ||= []).push(j);
    const ids = Object.keys(byTerm).sort((a, b) => byTerm[b].length - byTerm[a].length || content.byId[a].term.localeCompare(content.byId[b].term));
    body = ids.length ? ids.map(id => `<h3><a href="#/term/${esc(id)}" style="color:inherit;text-decoration:none">${esc(content.byId[id].term)} · ${byTerm[id].length}</a></h3><div class="jgrid">${byTerm[id].map(tile).join('')}</div>`).join('')
      : `<p class="empty">No sightings tagged with a ${journalMode === 'style' ? 'style' : 'term'} yet.</p>`;
  }
  app.innerHTML = `<header class="top"><p class="eyebrow">${journal.length} sighting${journal.length === 1 ? '' : 's'}</p><h1>Journal</h1></header>
    ${journal.length ? `<div class="seg">${[['date', 'By date'], ['term', 'By term'], ['style', 'By style']].map(([k, l]) => `<button data-m="${k}" class="${journalMode === k ? 'on' : ''}">${l}</button>`).join('')}</div>` : ''}
    ${body}${fab}`;
  app.querySelectorAll('.seg button').forEach(b => b.onclick = () => { journalMode = b.dataset.m; viewJournal(); });
}

async function shrink(file, max, quality) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
}

function tagPicker(el, tags, onChange) {
  el.innerHTML = `<input class="search" type="search" placeholder="Search: cornice, oriel, Italianate…" autocomplete="off"><ul class="suggest" hidden></ul><div class="chips tagged"></div>`;
  const input = el.querySelector('input'), list = el.querySelector('.suggest'), chips = el.querySelector('.tagged');
  const draw = () => {
    chips.innerHTML = tags.map(id => `<button class="chip" data-id="${esc(id)}" type="button">${esc(content.byId[id].term)} ✕</button>`).join('');
    chips.querySelectorAll('button').forEach(b => b.onclick = () => { tags.splice(tags.indexOf(b.dataset.id), 1); draw(); onChange?.(); });
  };
  input.oninput = () => {
    const s = input.value.trim().toLowerCase();
    const hits = s ? content.terms.filter(t => !tags.includes(t.id) && t.term.toLowerCase().includes(s)).slice(0, 6) : [];
    list.hidden = !hits.length;
    list.innerHTML = hits.map(t => `<li><button type="button" data-id="${esc(t.id)}">${esc(t.term)}<small>${esc(content.deckName[t.deck])}</small></button></li>`).join('');
    list.querySelectorAll('button').forEach(b => b.onclick = () => { tags.push(b.dataset.id); input.value = ''; list.hidden = true; draw(); onChange?.(); input.focus(); });
  };
  draw();
}

function viewNewEntry(params) {
  const tags = params.get('tag') && content.byId[params.get('tag')] ? [params.get('tag')] : [];
  let photo, thumb;
  app.innerHTML = `<a class="back" href="#/journal">‹ Journal</a>
    <header class="top" style="padding-top:6px"><h1>New sighting</h1></header>
    <form class="form" id="f">
      <div id="ph"><label class="pickphoto"><svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>Take or choose a photo<input type="file" accept="image/*" id="file"></label></div>
      <label for="tags">What can you name?</label><div id="tags"></div>
      <label for="addr">Address</label><input type="text" id="addr" placeholder="e.g. 145 East 73rd Street" autocomplete="off">
      <label for="note">Note</label><textarea id="note" placeholder="What caught your eye?"></textarea>
      <div class="stack"><button class="btn primary block" id="save" disabled>Save sighting</button></div>
    </form>`;
  tagPicker(document.getElementById('tags'), tags);
  document.getElementById('file').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    [photo, thumb] = await Promise.all([shrink(f, 1600, 0.82), shrink(f, 480, 0.75)]);
    document.getElementById('ph').innerHTML = `<div class="preview"><img src="${URL.createObjectURL(photo)}" alt=""></div><button type="button" class="link" id="redo">Choose a different photo</button>`;
    document.getElementById('redo').onclick = () => viewNewEntry(params);
    document.getElementById('save').disabled = false;
  };
  document.getElementById('f').onsubmit = async e => {
    e.preventDefault();
    if (!photo) return;
    const entry = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), address: document.getElementById('addr').value.trim(), note: document.getElementById('note').value.trim(), tags, photo, thumb };
    await db.put('journal', entry);
    await addPriority(tags);
    navigator.storage?.persist?.();
    await refresh();
    toast('Saved');
    location.hash = '#/journal/' + entry.id;
  };
}

function viewEntry(id) {
  const j = journal.find(x => x.id === id);
  if (!j) return viewJournal();
  app.innerHTML = `<a class="back" href="#/journal">‹ Journal</a>
    <div class="entry-photo"><img src="${esc(blobURL(j.photo))}" alt=""></div>
    <header class="top" style="padding:16px 0 4px"><p class="eyebrow">${new Date(j.createdAt).toLocaleDateString(undefined, { weekday: 'short', month: 'long', day: 'numeric', year: 'numeric' })}</p><h2>${esc(j.address || 'Sighting')}</h2></header>
    ${j.note ? `<p>${esc(j.note)}</p>` : ''}
    <h3>Tagged</h3><div id="tags"></div>
    <div class="stack" style="margin-top:28px"><button class="btn block danger" id="del">Delete sighting</button></div>`;
  tagPicker(document.getElementById('tags'), j.tags, async () => { await db.put('journal', j); await addPriority(j.tags); await refresh(); });
  document.getElementById('del').onclick = async () => {
    if (!confirm('Delete this sighting and its photo?')) return;
    await db.del('journal', id);
    await refresh();
    location.hash = '#/journal';
  };
}

/* ---------- Settings ---------- */

async function viewSettings() {
  const seq = navSeq;
  const n = Math.max(0, Math.min(30, Math.round(Number(await db.getSetting('newPerDay', 5))) || 0));
  const lastBackup = await db.getSetting('lastBackup', null);
  const persisted = await navigator.storage?.persisted?.();
  const est = await navigator.storage?.estimate?.();
  if (stale(seq)) return;
  app.innerHTML = `<header class="top"><h1>Settings</h1></header>
    <div class="setting"><span>New terms per day</span><span class="stepper"><button id="minus" aria-label="Fewer">−</button><b id="n">${n}</b><button id="plus" aria-label="More">+</button></span></div>
    <h3>Your data</h3>
    <p class="small muted">Progress and photos are stored on this device only${persisted ? ', protected from automatic clearing' : ''}${est ? ` (${(est.usage / 1e6).toFixed(1)} MB)` : ''}. Last backup: ${lastBackup ? new Date(lastBackup).toLocaleDateString() : 'never'}.</p>
    <div class="stack">
      <button class="btn block" id="export">Back up / send progress</button>
      <label class="btn block">Merge progress from another device<input type="file" accept="application/json,.json" id="merge" hidden></label>
      <label class="link small" style="text-align:center">Replace everything with a backup<input type="file" accept="application/json,.json" id="import" hidden></label>
    </div>
    <p class="small muted">To move progress between your computer and phone: on the device you used, tap <b>Back up / send progress</b> and send the file to the other one (AirDrop works). There, tap <b>Merge progress</b> and pick the file. Each term keeps whichever device reviewed it most recently, and sightings from both are kept.</p>
    <h3>About</h3>
    <p class="small muted">${content.terms.length} terms. Scheduling uses FSRS, which brings each card back just before you’d likely forget it. Photos from Wikimedia Commons; credits on each card.</p>`;
  const setN = async v => { v = Math.max(0, Math.min(30, v)); await db.setSetting('newPerDay', v); document.getElementById('n').textContent = v; };
  document.getElementById('minus').onclick = () => setN(+document.getElementById('n').textContent - 1);
  document.getElementById('plus').onclick = () => setN(+document.getElementById('n').textContent + 1);
  document.getElementById('export').onclick = async () => {
    const data = await db.exportAll();
    const file = new File([JSON.stringify(data)], `cornice-backup-${new Date().toISOString().slice(0, 10)}.json`, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file] }); } catch (e) { if (e.name === 'AbortError') return; throw e; }
    } else {
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: file.name });
      a.click();
    }
    await db.setSetting('lastBackup', new Date().toISOString());
    toast('Backup ready');
    viewSettings();
  };
  document.getElementById('merge').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const r = await db.mergeAll(JSON.parse(await f.text()), new Set(content.terms.map(t => t.id)));
      await refresh();
      toast(`Merged: ${r.cards} term${r.cards === 1 ? '' : 's'} updated, ${r.sightings} sighting${r.sightings === 1 ? '' : 's'} added`);
      viewSettings();
    } catch (err) { alert('Could not merge: ' + err.message); }
  };
  document.getElementById('import').onchange = async e => {
    const f = e.target.files[0];
    if (!f || !confirm('Replace everything on this device with this backup? Anything not in the backup will be lost.')) return;
    try {
      await db.importAll(JSON.parse(await f.text()), new Set(content.terms.map(t => t.id)));
      await refresh();
      toast('Restored');
      viewSettings();
    } catch (err) { alert('Could not restore: ' + err.message); }
  };
}

/* ---------- Router ---------- */

let cleanup = () => {};
let navSeq = 0; // bumped on every navigation so a slow view that finishes late doesn't draw over the current one
const stale = seq => seq !== navSeq;
async function route() {
  cleanup(); cleanup = () => {}; navSeq++;
  const [path, query] = location.hash.slice(1).split('?');
  const parts = (path || '/').split('/').filter(Boolean);
  const params = new URLSearchParams(query || '');
  const tab = { glossary: 'glossary', deck: 'glossary', term: 'glossary', journal: 'journal', settings: 'settings', sort: parts[1] ? 'glossary' : 'today' }[parts[0]] || 'today';
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  if (parts[0] !== 'review') window.scrollTo(0, 0);
  switch (parts[0]) {
    case 'review': return viewReview();
    case 'sort': return viewSort(parts[1]);
    case 'glossary': return viewGlossary();
    case 'deck': return viewDeck(parts[1]);
    case 'term': return viewTerm(parts[1]);
    case 'journal': return parts[1] === 'new' ? viewNewEntry(params) : parts[1] ? viewEntry(parts[1]) : viewJournal();
    case 'settings': return viewSettings();
    default: return viewToday();
  }
}

addEventListener('hashchange', route);
await load();
route();
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js');
