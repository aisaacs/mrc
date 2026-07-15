// Team-member naming. Every member has a two-part handle `first/backend` — a random French first
// name and a last name that is the model/backend family (claude, codex, gemini, elevenlabs, …):
//   @ludivine/claude   @thierry/codex   @côme/gemini
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
// NOTE: "Pierre" is deliberately NOT here — it's RESERVED product-wide for the caged summoned adversary (whose
// name is HARDCODED at `--new 'Pierre'` + "You are PIERRE" in ADVERSARY_PROMPT, never drawn from this pool). If
// a random member could be auto-named Pierre, it would sit next to a summoned adversary Pierre with OPPOSITE
// containment — the two-Pierres confusion, arrived at by dice. Reserving the name at the source (not just the
// §5.2 cast) makes "Pierre" mean exactly one thing everywhere. (Pierre's call, this-session.)
const PLAIN = [
  'Thierry', 'Guy', 'Camille', 'Hervé', 'Margot', 'Gaston', 'Colette', 'Rémy',
  'Yannick', 'Brigitte', 'Maurice', 'Sylvie', 'Étienne', 'Hélène', 'Bernard', 'Josette',
  'Lucien', 'Odette', 'Fabrice', 'Ghislaine', 'Bruno', 'Nadine', 'Pascal', 'Renée', 'Didier',
  'Mireille', 'Gérard', 'Solange', 'Florent', 'Apolline', 'Côme', 'Margaux', 'Anouk', 'Claudine',
]

export const FRENCH_NAMES = [...Object.keys(SPACEBALLS_EGGS), ...PLAIN]

// #44: named style pools for the builder's member-naming. `french` is the default + the fallback for
// any unknown style. 'custom' is a style with NO pool — the builder free-types it (so it's not here; the
// styles LIST adds it). Every name is first-name-shaped and passes #36 assertSafeName (letters/accents +
// internal hyphens only — no spaces, dots, or shell metacharacters), so a picked name is a valid handle.
export const NAME_STYLES = {
  french: FRENCH_NAMES,
  spaceballs: ['Lonestarr', 'Barf', 'Helmet', 'Yogurt', 'Skroob', 'Sandurz', 'Vespa', 'Roland', 'Dot', 'Snotty', 'Zircon', 'Druidia', 'Ludivine', 'Médor'],
  'corporate-america': ['Chad', 'Brad', 'Karen', 'Kevin', 'Brittany', 'Tyler', 'Megan', 'Jared', 'Ashley', 'Greg', 'Trevor', 'Becky', 'Brent', 'Tiffany', 'Connor', 'Madison', 'Hunter', 'Courtney'],
  'far-west': ['Jesse', 'Wyatt', 'Doc', 'Billy', 'Annie', 'Cole', 'Clint', 'Hank', 'Cassidy', 'Butch', 'Sundance', 'Dakota', 'Colt', 'Cheyenne', 'Maverick', 'Buck', 'Jed', 'Cody'],
  italian: ['Giuseppe', 'Marco', 'Luca', 'Giovanni', 'Salvatore', 'Antonio', 'Francesca', 'Sofia', 'Lorenzo', 'Matteo', 'Alessandro', 'Giulia', 'Valentina', 'Paolo', 'Enzo', 'Rocco', 'Chiara', 'Gianni'],
  hitchhikers: ['Arthur', 'Ford', 'Zaphod', 'Trillian', 'Marvin', 'Slartibartfast', 'Fenchurch', 'Eddie', 'Random', 'Wowbagger', 'Agrajag', 'Zarniwoop', 'Prak', 'Hillman'],
}
// The full style list the UI offers — the pooled styles plus free-type 'custom'.
export const NAME_STYLE_NAMES = [...Object.keys(NAME_STYLES), 'custom']

const defaultRng = () => Math.random()

// #49: first names that must NEVER be auto-assigned to a team member — they are addressing keywords or the
// reserved SOLO identity (`you` = the solo member's handle `you/claude`; `user`/`human` resolve to @user).
// Auto-assigning one would collide a team member's handle with the solo member or ambiguate an @mention.
// A member may still be PINNED to one in team.json only if it passes assertSafeName (these all do) — the
// reservation is against the auto-DRAW, the only place the pool is consulted blindly.
export const RESERVED_FIRST_NAMES = new Set(['you', 'user', 'human'])
// The §5.2 cast characters are RESERVED from the auto-draw too — a plain Claude is never randomly named Colette/
// Thierry/Pierre (those identities are summoned deliberately from the cast). (Pierre is also absent from the pool
// entirely; Colette/Thierry stay valid French names but are never auto-DRAWN.)
export const RESERVED_CAST_NAMES = new Set(['colette', 'thierry', 'pierre'])

// #50 (owner's #1 daily pain): the deterministic generalist name ORDER. An auto-assigned generalist (a member with no
// explicit name, french/default style) draws from THIS list IN ORDER — the Nth generalist across ANY project is always
// the Nth name, NOT an org-seeded random draw. So the same recognizable cast recurs everywhere (Claude is the primary/
// lead, named explicitly by the cast; these are the ADDITIONAL ones).
// THIS IS THE AUTH FIX (Pierre-verified, turn 200): a non-caged Claude member's ~/.claude is keyed on the character
// SLUG, not the project — mrc.js:646 overrides memberConfigVolName with charVolName(charSlug(first)) = `mrc-char-<slug>`
// (docker.js:149, no repo/org component; nextCharSlot's oracle is global across ALL projects). So a STABLE name → one
// reused login vol everywhere → the login PERSISTS across projects (no re-auth). The churn was RANDOM names giving an
// unstable slug (project-A "Sylvie" → mrc-char-sylvie, project-B "Gaspard" → mrc-char-gaspard → different vols →
// re-login); deterministic names complete the already-name-keyed char vol. No shared-auth-unit vol is needed or wanted
// here — that's the CAGED-adversary pattern (isolate each consult's conversations); an uncaged recurring character is
// MEANT to share its whole ~/.claude (login + memory) across projects (§5.2 continuity). Caged isolate, own-char share.
// All four are ordinary French names already in the draw pool (⊆ FRENCH_NAMES), none reserved.
export const GENERALIST_NAMES = ['Claudine', 'Pascal', 'Solange', 'Guy']

// Pick a first name not already in `taken` (a Set of lowercased first names) NOR reserved, from the given
// style's pool (default + fallback `french`; an unknown/`custom` style falls back to french). Falls back
// to a numbered name if the pool is somehow exhausted, so assignment never throws.
export function pickFirstName(taken = new Set(), rng = defaultRng, style = 'french') {
  const pool = NAME_STYLES[style] || NAME_STYLES.french
  const notTaken = (n) => !taken.has(n.toLowerCase()) && !RESERVED_FIRST_NAMES.has(n.toLowerCase()) && !RESERVED_CAST_NAMES.has(n.toLowerCase())
  // #50: the generalist default (french, incl. the unknown/custom fallback + roster.js's no-style auto-assign) consumes
  // the deterministic GENERALIST_NAMES list IN ORDER first — the Nth auto-assigned generalist is always the Nth name,
  // seed-independent, so the same cast recurs across projects. A chosen THEME (spaceballs/italian/…) is untouched: its
  // members keep the themed random draw. Exhaust the list → fall through to the existing pool draw.
  if (pool === NAME_STYLES.french) {
    const g = GENERALIST_NAMES.find(notTaken)
    if (g) return g
  }
  const free = pool.filter(notTaken)
  if (free.length) return free[Math.floor(rng() * free.length)]
  for (let i = 2; ; i++) {
    const base = pool[Math.floor(rng() * pool.length)]
    const cand = `${base}${i}`
    if (!taken.has(cand.toLowerCase())) return cand
  }
}

// Normalize a backend into a clean "last name" (claude / codex / gemini / elevenlabs / …).
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
//
// Unicode-aware on purpose: the name pool is French, so accented handles (@Côme, @Médor, @Dorothée)
// must capture in FULL — an ASCII-only class truncated them at the first accent (@Côme -> "c"),
// making accented members unaddressable. The leading lookbehind keeps email locals and mid-word "@"
// from false-matching (a@b.com, foo@bar), and the trailing trim drops sentence punctuation so a
// sentence-final "@user." still reaches the human and "@Roland," still resolves.
const MENTION_RE = /(?<![\p{L}\p{N}_@/])@([\p{L}\p{N}][\p{L}\p{N}._-]*(?:\/[\p{L}\p{N}._-]+)?)/gu
export function extractMentions(text) {
  const out = []
  const seen = new Set()
  const re = new RegExp(MENTION_RE)   // fresh lastIndex per call
  let m
  while ((m = re.exec(String(text || '')))) {
    const key = m[1].toLowerCase().replace(/[._-]+$/, '')
    if (key && !seen.has(key)) { seen.add(key); out.push(key) }
  }
  return out
}

// Remove every @mention span from a body, regardless of case or accents (uses the same matcher as
// extractMentions, so it strips `@Côme` whole — not the broken case/accent-sensitive split it
// replaced). Used to clean a media-generation prompt of its addressees.
export function stripMentions(text) {
  return String(text || '').replace(new RegExp(MENTION_RE), '').replace(/\s+/g, ' ').trim()
}
