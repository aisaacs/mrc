// Team-member naming. Every member has a two-part handle `first/backend` — a random French first
// name and a last name that is the model/backend family (claude, codex, qwen, gemini, …):
//   @ludivine/claude   @thierry/codex   @guy/qwen
// First names are drawn unique per org so a handle never collides. The pool is ordinary French
// names sprinkled with Spaceballs easter eggs — may the Schwartz be with whoever spots them all.

// The Schwartz is strong with these ones. (first name → the bit it's nodding at)
export const SPACEBALLS_EGGS = {
  Ludivine: 'Ludicrous speed — GO!',
  Roland: 'King Roland of Druidia',
  Vespa: 'Princess Vespa',
  Médor: 'Barf (half man, half dog — he\'s his own best friend); Médor is the archetypal French dog',
  Sandrine: 'Colonel Sandurz',
  Dorothée: 'Dot Matrix',
  Mégane: 'Mega Maid (she\'s gone from suck to blow)',
  Lonny: 'Lone Starr',
}

// Plain French first names, no agenda. Mixed with the eggs above into one draw pool.
const PLAIN = [
  'Thierry', 'Guy', 'Pierre', 'Camille', 'Hervé', 'Margot', 'Gaston', 'Colette', 'Rémy',
  'Yannick', 'Brigitte', 'Maurice', 'Sylvie', 'Étienne', 'Hélène', 'Bernard', 'Josette',
  'Lucien', 'Odette', 'Fabrice', 'Ghislaine', 'Bruno', 'Nadine', 'Pascal', 'Renée', 'Didier',
  'Mireille', 'Gérard', 'Solange', 'Florent', 'Apolline', 'Côme', 'Margaux', 'Anouk',
]

export const FRENCH_NAMES = [...Object.keys(SPACEBALLS_EGGS), ...PLAIN]

const defaultRng = () => Math.random()

// Pick a first name not already in `taken` (a Set of lowercased first names). Falls back to a
// numbered name if the pool is somehow exhausted, so assignment never throws.
export function pickFirstName(taken = new Set(), rng = defaultRng) {
  const free = FRENCH_NAMES.filter((n) => !taken.has(n.toLowerCase()))
  if (free.length) return free[Math.floor(rng() * free.length)]
  for (let i = 2; ; i++) {
    const base = FRENCH_NAMES[Math.floor(rng() * FRENCH_NAMES.length)]
    const cand = `${base}${i}`
    if (!taken.has(cand.toLowerCase())) return cand
  }
}

// Normalize a backend into a clean "last name" (claude / codex / qwen / gemini / …).
export function backendFamily(backend) {
  return String(backend || 'claude').trim().toLowerCase().replace(/[^a-z0-9]+/g, '') || 'claude'
}

// `first/backend`, lowercased — the canonical handle used everywhere for addressing.
export function makeHandle(first, backend) {
  return `${String(first).toLowerCase()}/${backendFamily(backend)}`
}

// Parse an @mention token into { first, backend? }. Accepts `@ludivine`, `ludivine`,
// `@ludivine/claude`, `ludivine/claude`. The backend half is optional (role/name addressing
// resolves within a room, so the first name alone is usually enough).
export function parseMention(token) {
  const t = String(token || '').trim().replace(/^@/, '').toLowerCase()
  if (!t) return null
  const [first, backend] = t.split('/')
  return { first, backend: backend || null }
}

// Pull every @mention out of a message body, in order, de-duplicated. Mentions look like
// `@first` or `@first/backend`; `@user` is included (it's a real, global addressee).
export function extractMentions(text) {
  const out = []
  const seen = new Set()
  const re = /@([a-z0-9._-]+(?:\/[a-z0-9._-]+)?)/gi
  let m
  while ((m = re.exec(String(text || '')))) {
    const key = m[1].toLowerCase()
    if (!seen.has(key)) { seen.add(key); out.push(m[1].toLowerCase()) }
  }
  return out
}
