// Turns a term into a prompt. Prompt kinds:
//   learn    first sight of a term: everything on one card
//   recall   photo (or definition) -> do you know the name? self-graded
//   pickPhoto  term -> tap the matching photo of four
//   pickName   photo -> tap the right name of four (styles and architects: "what style is this?")
//   pair     photo -> which of two easily confused terms is it?

const shuffle = a => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const pick = a => a[Math.floor(Math.random() * a.length)];

// photos: termId -> [{ src, caption, mine }]
export function buildPrompt(term, { content, photos, isNew }) {
  if (isNew) return { kind: 'learn', term };
  const pool = photos[term.id] || [];
  const mine = pool.filter(p => p.mine);
  // Your own sightings come up half the time when you have them.
  const photo = mine.length && Math.random() < 0.5 ? pick(mine) : pool.find(p => !p.mine) || pool[0];
  const deckTerms = content.byDeck[term.deck].filter(t => t.id !== term.id);
  const confusers = (term.confuse || []).map(id => content.byId[id]).filter(Boolean);

  const options = [];
  if (photo) options.push('recall');
  else options.push('recallDef');
  if (photo && (term.deck === 'styles' || term.deck === 'architects')) options.push('pickName', 'pickName');
  if (photo && confusers.some(c => photos[c.id]?.length)) options.push('pair');
  if (photos[term.id]?.length && deckTerms.filter(t => photos[t.id]?.length).length >= 3 && term.deck !== 'architects') options.push('pickPhoto');
  if (photo && deckTerms.length >= 3) options.push('pickName');

  const kind = pick(options);
  if (kind === 'recall') return { kind, term, photo };
  if (kind === 'recallDef') return { kind: 'recall', term, photo: null };
  if (kind === 'pair') {
    const other = pick(confusers.filter(c => photos[c.id]?.length));
    return { kind, term, photo, choices: shuffle([term, other]) };
  }
  if (kind === 'pickName') {
    const distract = shuffle([...confusers, ...shuffle(deckTerms)].filter((t, i, a) => a.indexOf(t) === i)).slice(0, 3);
    return { kind, term, photo, choices: shuffle([term, ...distract]) };
  }
  // pickPhoto: confusers first as distractors, then random from the deck
  const others = [...confusers, ...shuffle(deckTerms)].filter((t, i, a) => a.indexOf(t) === i && photos[t.id]?.length && t.id !== term.id).slice(0, 3);
  const tiles = shuffle([{ term, photo: photo?.mine ? photo : pool.find(p => !p.mine) || pool[0] },
    ...others.map(t => ({ term: t, photo: photos[t.id].find(p => !p.mine) || photos[t.id][0] }))]);
  return { kind: 'pickPhoto', term, tiles };
}

// Today's queue: due reviews first (oldest due first), new terms mixed in every few cards.
// Terms you tagged in the journal (priority) come first and don't count against the daily limit.
export function buildQueue({ content, cards, now, newPerDay, introducedToday, priority = [] }) {
  const due = Object.values(cards).filter(c => new Date(c.card.due) <= now).sort((a, b) => new Date(a.card.due) - new Date(b.card.due)).map(c => ({ termId: c.termId, isNew: false }));
  const room = Math.max(0, newPerDay - introducedToday);
  const tagged = priority.filter(id => content.byId[id] && !cards[id]);
  const fresh = content.order.filter(id => !cards[id] && !tagged.includes(id)).slice(0, room);
  const news = [...tagged, ...fresh].map(termId => ({ termId, isNew: true }));
  const q = [];
  let n = 0;
  for (const item of due) { q.push(item); if (q.length % 4 === 0 && n < news.length) q.push(news[n++]); }
  while (n < news.length) q.push(news[n++]);
  return q;
}
