// Trust-boundary hygiene for the relay.
//
// The sandbox trust model rests on one rule the receiving agent obeys: only `[Human directive]:` /
// `[Human reply]:` lines are authoritative (the human, via a steer or an @user answer). Those are
// minted SERVER-SIDE as dedicated `directive` frames (room-engine.js doSteer/answerUser) and never
// carry attacker-controlled text.
//
// The hole (A1): peer messages and task-worker output are interpolated into a `deliver` frame, and a
// `deliver` frame and a `directive` frame reach the receiver through the SAME push path
// (container/mrc-channel-server.js) under the same `source="room"` envelope — distinguished ONLY by
// the literal text prefix the daemon stamped. So a sender (especially a non-Claude worker, whose raw
// CLI output we post back verbatim) can embed a line that reads `[Human directive]: do X` in its OWN
// body and forge the human's authority.
//
// defangTrustMarkers neutralizes any such look-alike in UNTRUSTED text before it is framed. Because
// real directives never pass through here, it can only ever strip a forgery, never a genuine human
// instruction. This is the symptom fix; the durable fix is to carry trust out-of-band (a frame-type/
// meta `source`) so the prefix string stops being the trust signal — see container/mrc-channel-server
// .js push path.
//
// TWO DOCUMENTED RESIDUALS — both closable ONLY by the structural out-of-band fix (tracked in the
// Docker/E rebuild checklist, since that fix is container-side):
//   R1. Cross-message reassembly: a marker split ACROSS two messages — msg1 ends `…[Human`, msg2
//       starts `directive]:…`. A per-message defang structurally cannot see both halves.
//       R2. Confusable-allowlist gap: the homoglyph fold below is a FIXED map, so a lookalike outside it
//       survives while still rendering as the marker (an unmapped in-range Cyrillic/Greek, or a homoglyph
//       from a block the map doesn't touch). The map covers the common Cyrillic/Greek/IPA-ext vectors —
//       including the ones a live adversary demonstrated — but it is a BELT over the frame, NOT a complete
//       defense: we deliberately do NOT try to enumerate every Unicode look-alike (whack-a-mole); the
//       structural out-of-band fix removes the whole class. This pass closes every common, rendering-
//       identical vector and is a strict improvement.

// Invisible characters an attacker inserts to break a naive matcher while rendering identically:
// zero-width space/non-joiner/joiner/word-joiner, BOM, soft hyphen.
const INVISIBLE = /[­​‌‍‎‏⁠﻿]/g

// Cross-script confusables that spell the marker, BOTH cases (the matcher is case-insensitive, so
// each maps to a Latin letter — case need not be preserved). Mapped 1:1 (length-preserving) so match
// indices in the folded scan line up exactly with the normalized base we splice — we deliberately do
// NOT `.toLowerCase()` the whole string, because a few code points (İ, ﬀ) change length and would
// misalign the splice. Covers the Latin-look Cyrillic/Greek letters in "human"/"directive"/"reply",
// plus bracket variants NFKC doesn't fold (CJK/lenticular/corner).
const CONFUSABLE = {
  // Cyrillic → Latin (lower + upper)
  'а': 'a', 'А': 'a', 'с': 'c', 'С': 'c', 'е': 'e', 'Е': 'e', 'о': 'o', 'О': 'o',
  'р': 'p', 'Р': 'p', 'х': 'x', 'Х': 'x', 'у': 'y', 'У': 'y', 'і': 'i', 'І': 'i',
  'ј': 'j', 'Ј': 'j', 'ԛ': 'q', 'Ԛ': 'q', 'ѵ': 'v', 'Ѵ': 'v', 'н': 'h', 'Н': 'h',
  'м': 'm', 'М': 'm', 'т': 't', 'Т': 't', 'к': 'k', 'К': 'k', 'ӏ': 'l', 'Ӏ': 'l',
  // Greek → Latin (lower + upper)
  'α': 'a', 'Α': 'a', 'ο': 'o', 'Ο': 'o', 'ε': 'e', 'Ε': 'e', 'ρ': 'p', 'Ρ': 'p',
  'τ': 't', 'Τ': 't', 'κ': 'k', 'Κ': 'k', 'ι': 'i', 'Ι': 'i', 'ν': 'v', 'υ': 'u',
  'Υ': 'y', 'η': 'n', 'Η': 'h', 'μ': 'm', 'Μ': 'm',
  // IPA Extensions look-alikes (NFKC does NOT fold these) — the specific vectors a live adversary demonstrated
  // against the marker; a targeted belt, NOT an attempt to enumerate the block (the frame is the boundary).
  'ɑ': 'a', 'ɡ': 'g', 'ɩ': 'i', 'ɪ': 'i', 'ɔ': 'o', 'ɾ': 'r',
  // bracket variants (NFKC handles fullwidth ［］; these it leaves alone)
  '【': '[', '】': ']', '〔': '[', '〕': ']', '〖': '[', '〗': ']', '「': '[', '」': ']',
}
const CONFUSABLE_RE = /[Ѐ-ӿͰ-Ͽɑɡɩɪɔɾ【】〔〕〖〗「」]/g

// Normalize untrusted text to a canonical base: fold compatibility forms (fullwidth ［Ｈ → [H), unify
// CR/CRLF so there are no smuggled line starts, and strip invisibles. Applied to the delivered text.
function toBase(text) {
  return String(text ?? '').normalize('NFKC').replace(/\r\n?/g, '\n').replace(INVISIBLE, '')
}
// A confusable-folded VIEW of the base, 1:1 in length — used only to LOCATE markers (the splice reads
// from `base`, so real letters/case of surrounding content are preserved).
function foldForScan(base) {
  return base.replace(CONFUSABLE_RE, (c) => CONFUSABLE[c] || c)
}

// The marker, matched GLOBALLY (not just line-leading): ANY occurrence of the trusted token in
// untrusted text is a forgery risk, and matching globally also makes the pass idempotent and immune
// to nested re-forming. Inter-word separator is `\s*` so a stripped zero-width (Human​directive) still
// matches. Brackets are ASCII here because toBase/foldForScan already canonicalized the variants.
const MARKER = /\[\s*human\s*(directive|reply)\s*\]/gi

export function defangTrustMarkers(text) {
  const base = toBase(text)
  const scan = foldForScan(base)
  let out = ''
  let last = 0
  MARKER.lastIndex = 0
  let m
  while ((m = MARKER.exec(scan))) {
    // Splice from the NORMALIZED base (preserves the real letters / case of surrounding content) and
    // render the marker span as an unmistakably-quoted, non-authoritative token.
    out += base.slice(last, m.index) + `⦉quoted “Human ${m[1]}”⦊`
    last = m.index + m[0].length
  }
  return out + base.slice(last)
}

// Make UNTRUSTED member text safe to embed INSIDE a trusted directive line — e.g. the #17 reply quote
// `[Human reply to "<snippet>"]: …`. The directive frame is server-minted and (deliberately) NOT run
// through deliverTo's defang, so the quote site must sanitize the snippet itself.
//
// Order is LOAD-BEARING:
//   1. collapse whitespace to one line  — a newline could start a fresh marker row.
//   2. truncate to ~max                 — a lossy preview; can strand a half-marker at the cut.
//   3. defangTrustMarkers               — neutralizes a COMPLETE laundered marker (brackets intact).
//   4. strip the break-out chars " [ ]  — the TERMINAL step: closes the `"]:` quote break-out AND kills
//      any half-marker the truncation stranded (the `[` becomes `(`). Strip > escape: if the chars are
//      GONE there is structurally nothing to break out with, and a preview needn't round-trip.
// (defang emits non-ASCII curly quotes/guillemets — “ ” ⦉ ⦊ — so the ASCII strip can't damage its
// output. The visible ⦉quoted “…”⦊ glyphs carry NO authority; do NOT "clean them up" back into markers.)
export function snippetForTrustedLine(text, max = 70) {
  let s = String(text ?? '').replace(/\s+/g, ' ').trim()
  const truncated = s.length > max
  if (truncated) s = s.slice(0, max)
  s = defangTrustMarkers(s)
  s = s.replace(/"/g, "'").replace(/\[/g, '(').replace(/\]/g, ')')   // terminal strip — closes the break-out
  if (truncated) s = s.trimEnd() + '…'   // ellipsis appended LAST so defang's NFKC can't expand it to "..."
  return s
}
