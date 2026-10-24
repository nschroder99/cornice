// Scheduling with FSRS. Dates are stored as ISO strings so cards survive JSON backups.
import { fsrs, createEmptyCard, Rating, State } from './vendor/ts-fsrs.mjs';

const scheduler = fsrs({ request_retention: 0.9, enable_fuzz: true, enable_short_term: true });
export { Rating, State };

const DATE_FIELDS = ['due', 'last_review'];
const revive = c => { const o = { ...c }; for (const f of DATE_FIELDS) if (o[f]) o[f] = new Date(o[f]); return o; };
const freeze = c => { const o = { ...c }; for (const f of DATE_FIELDS) if (o[f]) o[f] = new Date(o[f]).toISOString(); return o; };

export const newCard = (now = new Date()) => freeze(createEmptyCard(now));

// Returns the updated stored card for a given rating.
export function rate(card, rating, now = new Date()) {
  return freeze(scheduler.next(revive(card), now, rating).card);
}

// Due dates each rating would give, for labeling the buttons.
export function preview(card, now = new Date()) {
  const p = scheduler.repeat(revive(card), now);
  return Object.fromEntries([Rating.Again, Rating.Hard, Rating.Good, Rating.Easy].map(r => [r, p[r].card.due]));
}

export function humanInterval(due, now = new Date()) {
  const m = (new Date(due) - now) / 60000;
  if (m < 60) return `${Math.max(1, Math.round(m))}m`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 30) return `${Math.round(d)}d`;
  if (d < 365) return `${Math.round(d / 30)}mo`;
  return `${(d / 365).toFixed(1)}y`;
}

export const isDue = (card, now = new Date()) => new Date(card.due) <= now;
export const isLearned = card => card.state === State.Review;
