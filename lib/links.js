// Finds glossary terms mentioned inside other terms' text ("Flemish-bond brick", "dormers").
// Shared by the app (to make them tappable) and scripts/build-content.js (to introduce
// building blocks before the styles that use them). No DOM, so it runs in Node too.

// Extra or replacement names. By default a term matches its own name, minus any "(…)" note,
// split on " / ". An entry here replaces that default, so ambiguous names can be narrowed.
const ALIASES = {
  'doric': ['Doric order', 'Doric'], 'ionic': ['Ionic order', 'Ionic'], 'corinthian': ['Corinthian order', 'Corinthian'],
  'brackets': ['bracket', 'bracketed'], 'dentils': ['dentil'], 'modillions': ['modillion'], 'voussoir': ['voussoir'],
  'quoins': ['quoin'], 'baluster': ['baluster'], 'sidelights': ['sidelight'], 'pocket-doors': ['pocket door'],
  'mansard': ['mansard roof', 'mansard'], 'window-hood': ['window hood', 'hood'], 'segmental-arch': ['segmental arch', 'segmental'],
  'herringbone': ['herringbone floor', 'herringbone'], 'chevron': ['chevron floor', 'chevron parquet'],
  'terra-cotta': ['architectural terra cotta', 'terra cotta'], 'copper-patina': ['copper patina', 'verdigris'],
  'brownstone-stone': ['brownstone sandstone'], 'brownstone-lingo': ['brownstone'],
  'old-law-tenement': ['old-law tenement', 'old-law'], 'new-law-tenement': ['new-law tenement', 'new-law'],
  'landmark': ['landmark', 'historic district'], 'contemporary': ['supertall style'],
  'postwar-brick': ['postwar white and red brick', 'white-brick', 'postwar brick'],
  'gallery': ['entry gallery', 'formal gallery'], 'marble-mantel': ['arched marble mantel'],
  'greek-revival-mantel': ['post-and-lintel mantel'], 'big': ['Bjarke Ingels Group', 'Bjarke Ingels'],
  'shop': ['SHoP Architects'], 'mies': ['Ludwig Mies van der Rohe', 'Mies van der Rohe'],
  'stair-skylight': ['stairwell skylight'], 'hex-tile': ['hexagonal tile', 'hex tile'],
};

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function namesFor(t) {
  if (ALIASES[t.id]) return ALIASES[t.id];
  return t.term.replace(/\s*\(.*?\)\s*/g, ' ').replace(/["“”]/g, '').split(' / ').map(s => s.trim()).filter(Boolean);
}

// Returns a function text -> [{ text, id? }] that marks the first mention of each term.
export function makeLinker(terms) {
  const byName = new Map();
  for (const t of terms) for (const n of namesFor(t)) byName.set(n.toLowerCase().replace(/[\s-]+/g, ' '), t.id);
  const names = [...byName.keys()].sort((a, b) => b.length - a.length); // longest first: "crown molding" before "crown"
  const pattern = names.map(n => escapeRe(n).replace(/ /g, '[\\s-]+')).join('|');
  const re = new RegExp(`(?<![\\w-])(${pattern})(?:e?s)?(?![\\w])`, 'gi');

  return function linkify(text, selfId, used = new Set()) {
    const out = [];
    let last = 0;
    for (const m of String(text ?? '').matchAll(re)) {
      const id = byName.get(m[1].toLowerCase().replace(/[\s-]+/g, ' '));
      if (!id || id === selfId || used.has(id)) continue;
      used.add(id);
      if (m.index > last) out.push({ text: text.slice(last, m.index) });
      out.push({ text: m[0], id });
      last = m.index + m[0].length;
    }
    if (last < String(text ?? '').length) out.push({ text: text.slice(last) });
    return out;
  };
}

// Ids of the other terms a term's definition and "how to spot it" text rely on, in reading order.
export function references(term, linkify) {
  const used = new Set();
  return [...linkify(term.def, term.id, used), ...linkify(term.spot, term.id, used)].filter(s => s.id).map(s => s.id);
}
