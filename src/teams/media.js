// Media-generation members. A "designer", "sound-designer", or "composer" is a task-worker whose
// backend is a generation API (Gemini image, ElevenLabs SFX/music). On a directed @mention it turns
// the request into an asset FILE written into its territory, and posts back the path — no CLI, no
// container, just an HTTP call from the daemon (which has the keys via loadEnv). The HTTP calls take
// an injectable fetch so the dispatch / prompt-extraction / file-writing are unit-testable offline.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { canonicalWriteTarget } from '../mount-guard.js'   // #49: symlink-safe asset write target
import { stripMentions } from './names.js'
import { memberRepoEnvKey } from '../config.js'   // #49 cross-repo (Pierre Q4): member-secret MINT (denies a caged member's repo .env)
import { HAIKU_MODEL } from '../constants.js'

// role -> media kind. The ROLE decides what gets made; the backend just names the provider.
export const MEDIA_ROLES = { designer: 'image', 'sound-designer': 'sfx', composer: 'music' }
export const isMediaRole = (role) => Object.prototype.hasOwnProperty.call(MEDIA_ROLES, role)
// media kind -> provider backend. A media maker's backend is DERIVED from its role (not a free pick):
// designer -> gemini (image), sound-designer/composer -> elevenlabs (sfx/music).
const KIND_BACKEND = { image: 'gemini', sfx: 'elevenlabs', music: 'elevenlabs' }
export const mediaBackendForRole = (role) => (isMediaRole(role) ? KIND_BACKEND[MEDIA_ROLES[role]] : null)

const env = (k) => process.env[k] || ''
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'asset'

// Generation intent — only SPEND on a new asset when the request actually asks to make one. A bare
// reference or feedback ("the acorn is perfect, locked") must not fire a paid generation. Checked
// BEFORE the art-director (Haiku) call so feedback costs nothing. (The #10 opening-line gate already
// stops buried-mention misfires; this stops a leading mention that's still just chatter.)
// A generation IMPERATIVE — a generation verb that LEADS its clause. Position matters, not just the
// word: "design a banner" / "now make the blue jay" are requests; "the design looks great" / "that
// makes sense" are not (the verb-word is a noun/idiom there). So the verb must sit at the string
// start, after clause punctuation, or after a small set of imperative lead-ins (now/please/can you…) —
// never after a determiner. This kills the noun/common-verb false-positives (esp. "design", the
// designer's own domain word) without restructuring around an LLM. The art-director {skip} stays as a
// backstop for anything verb-leading that's still chatter.
// The verb must lead its clause — at the string start or after clause punctuation — though a run of
// politeness/greeting lead-ins may precede it (the @mention is already stripped, so "please make a
// logo" arrives as "please make…"). So: (clause start)(0+ lead-in words)(generation verb). "design a
// banner" / "please make a logo" / "now make the blue jay" pass; "the design looks great" / "love
// this design" / "that makes sense" / "good design work" do not (the verb-word follows a determiner/
// adjective, never a clause-lead).
const GEN_VERB = 'make|generate|regenerate|re-?generate|draw|redraw|create|recreate|render|re-?render|design|compose|produce|sketch|paint|illustrate|animate|redo|mock-?up'
const GEN_LEADIN = "now|then|just|quick|please|pls|kindly|also|and|so|ok|okay|hey|hi|yo|go|can|could|would|will|you|we|i|i'?d|let'?s|like|want|need|to"
const GENERATION_INTENT = new RegExp(`(?:^|[.;:,—–-]\\s*)(?:(?:${GEN_LEADIN})\\s+)*(?:${GEN_VERB})\\b`, 'i')

// Per-room generation rate cap — bound a runaway @designer loop. Sliding window kept in daemon memory.
const RATE = { max: 6, windowMs: 60_000 }
const _genTimes = new Map()   // roomId -> [timestamps]
function withinRateCap(roomId, now) {
  const key = roomId || '_'
  const arr = (_genTimes.get(key) || []).filter((t) => now - t < RATE.windowMs)
  if (arr.length >= RATE.max) { _genTimes.set(key, arr); return false }
  arr.push(now); _genTimes.set(key, arr)
  return true
}
export function _resetMediaRate() { _genTimes.clear() }   // test hook

// The generation prompt = the requesters' messages, stripped of @mentions and the [Human …] framing.
export function mediaPrompt(items = []) {
  return items
    .map((it) => String(it.text || '').replace(/\[Human (directive|reply)\]:/gi, ''))
    .map((t) => stripMentions(t))
    .filter(Boolean)
    .join('. ')
}

// --- providers (each returns { bytes:Buffer, ext } or throws with a clear message) -----------------

// Gemini image (a.k.a. "nano-banana"). Model/endpoint are env-overridable since the API evolves.
export async function generateImage(prompt, { apiKey, model = env('MRC_GEMINI_IMAGE_MODEL') || 'gemini-2.5-flash-image', fetchFn = globalThis.fetch } = {}) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set (the room daemon loads it from .env — restart it after adding the key)')
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE'] } }),
  })
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const j = await res.json()
  const part = (j.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData?.data)
  if (!part) throw new Error('Gemini returned no image (try a more concrete description, or check the model name)')
  return { bytes: Buffer.from(part.inlineData.data, 'base64'), ext: (part.inlineData.mimeType || '').includes('jpeg') ? 'jpg' : 'png' }
}

// ElevenLabs text-to-sound-effect.
export async function generateSfx(prompt, { apiKey, fetchFn = globalThis.fetch } = {}) {
  if (!apiKey) throw new Error('ELEVEN_LABS_API_KEY is not set (restart the room daemon after adding it to .env)')
  const res = await fetchFn('https://api.elevenlabs.io/v1/sound-generation', {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ text: prompt }),
  })
  if (!res.ok) throw new Error(`ElevenLabs SFX ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return { bytes: Buffer.from(await res.arrayBuffer()), ext: 'mp3' }
}

// ElevenLabs Music (composer). Endpoint best-effort + env-overridable; verify on first real use.
export async function generateMusic(prompt, { apiKey, endpoint = env('MRC_ELEVEN_MUSIC_URL') || 'https://api.elevenlabs.io/v1/music', fetchFn = globalThis.fetch } = {}) {
  if (!apiKey) throw new Error('ELEVEN_LABS_API_KEY is not set (restart the room daemon after adding it to .env)')
  const res = await fetchFn(endpoint, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })
  if (!res.ok) throw new Error(`ElevenLabs Music ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return { bytes: Buffer.from(await res.arrayBuffer()), ext: 'mp3' }
}

const GENERATORS = { image: generateImage, sfx: generateSfx, music: generateMusic }
const KEY_FOR = { image: 'GEMINI_API_KEY', sfx: 'ELEVEN_LABS_API_KEY', music: 'ELEVEN_LABS_API_KEY' }

// Art-director pass: a teammate's message is conversational ("the acorn is perfect, locked — now the
// blue jay"). Turn it into a clean, standalone generation prompt + a tidy 2-4 word filename, and flag
// pure feedback so we don't generate (and don't name files after chatter). Uses the host-only Haiku
// key mrc already has; returns null on any failure so generation falls back to the raw text.
async function artDirect(rawRequest, kind, { apiKey, fetchFn = globalThis.fetch }) {
  if (!apiKey) return null
  const tField = kind === 'image' ? ',"transparent":true|false' : ''
  const tNote = kind === 'image' ? ' Set "transparent":true for a sprite/icon/object that needs a cut-out (no background), false for a full scene/background.' : ''
  const system = `You are the ${kind === 'image' ? 'art' : 'audio'} director for a software team. A teammate sent the message below to a ${kind} generator. Reply ONLY with JSON. If it is a real request for a NEW ${kind} asset: {"prompt":"<concise standalone ${kind}-generation prompt>","name":"<2-4 word kebab filename, no extension>"${tField}}.${tNote} If it is just feedback/approval/chatter and NOT a new asset request: {"skip":true}.`
  try {
    const res = await fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: HAIKU_MODEL, max_tokens: 200, system, messages: [{ role: 'user', content: String(rawRequest).slice(0, 1500) }] }),
    })
    if (!res.ok) return null
    const j = await res.json()
    const txt = (j.content?.[0]?.text || '').replace(/^```json\s*|\s*```$/g, '').trim()
    return JSON.parse(txt)
  } catch { return null }
}

// Worker invoker for a media member: generate the asset and write it into the member's territory.
// `member` carries { role, repo, territory, first }; ctx carries { items, fetchFn? }.
export async function generateMedia(member, { items = [], fetchFn, room, now } = {}) {
  const kind = MEDIA_ROLES[member.role]
  if (!kind) return { text: `[@${member.first}: not a media role]`, ok: false }
  const raw = mediaPrompt(items)
  if (!raw) return { text: `[@${member.first}: nothing to make — say what you want generated]`, ok: false }
  // Intent gate — cheap, BEFORE the paid art-director (Haiku) call: feedback/discussion never spends.
  if (!GENERATION_INTENT.test(raw)) return { text: `[@${member.first}: that read as feedback/discussion, not a new ${kind} request — start with "make/generate/draw …" when you want a NEW asset.]`, ok: false }
  // Rate cap — bound a runaway generation loop in this room before any paid call.
  if (!withinRateCap(room, typeof now === 'number' ? now : Date.now())) return { text: `[@${member.first}: throttled — too many ${kind} generations in this room in the last minute. Give it a moment, then ask again.]`, ok: false }
  // Art-director pass: clean the prompt + filename, and skip messages that are just feedback.
  const adKey = memberRepoEnvKey(member, 'MRC_SESSION_NAMING_ANTHROPIC_API_KEY') || memberRepoEnvKey(member, 'ANTHROPIC_API_KEY')
  const ad = await artDirect(raw, kind, { apiKey: adKey, fetchFn })
  if (ad?.skip) return { text: `[@${member.first}: that read as feedback, not a new ${kind} request — start with "make/generate …" when you want a new asset.]`, ok: false }
  const prompt = (ad?.prompt) || raw
  const fileBase = slug(ad?.name || prompt)
  const apiKey = memberRepoEnvKey(member, KEY_FOR[kind])   // per-repo .env first, then the global key (caged member → denied)
  // Gemini can't emit real alpha (it paints a fake transparency checkerboard). For a cut-out asset,
  // ask for a solid magenta background and chroma-key it to true transparency ourselves.
  const CHROMA = { r: 255, g: 0, b: 255 }
  const wantTransparent = kind === 'image' && (ad ? !!ad.transparent : /\btransparent\b|\bsprite\b|\bicon\b|\bcut-?out\b/i.test(raw))
  const genPrompt = wantTransparent
    ? `${prompt}. Render the subject centered on a SOLID FLAT pure magenta (#FF00FF) background that completely fills the frame — an actual solid color, NOT a transparency checkerboard.`
    : prompt
  let asset
  try { asset = await GENERATORS[kind](genPrompt, { apiKey, fetchFn }) }
  catch (e) { return { text: `[@${member.first} couldn't generate it: ${e?.message || e}]`, ok: false } }
  let transparent = false
  if (wantTransparent && asset.ext === 'png') {
    try { const { chromaKey } = await import('./png.js'); asset = { ...asset, bytes: chromaKey(asset.bytes, CHROMA, 70) }; transparent = true } catch {}
  }
  const territory = member.territory && member.territory !== '.' ? member.territory : 'assets'
  const name = `${fileBase}-${createHash('sha1').update(prompt + asset.bytes.length).digest('hex').slice(0, 6)}.${asset.ext}`
  // #49 (Pierre — the indirection-hidden site): `territory` came through resolveTerritory (rejects textual
  // `..` but NOT symlinks), so `territory:'evil'` where `member.repo/evil -> /etc` would writeFileSync the
  // generated asset bytes to /etc — the SAME symlinked-territory escape closed for the MOUNT, on the WRITE.
  // Canonicalize the full asset path (catches the symlink, tolerates a not-yet-created territory dir).
  let assetPath
  try { assetPath = canonicalWriteTarget(member.repo, join(territory, name)) }
  catch (e) { return { text: `[@${member.first} generated it but the target path escapes the repo: ${e?.message || e}]`, ok: false } }
  try { mkdirSync(dirname(assetPath), { recursive: true }); writeFileSync(assetPath, asset.bytes) }
  catch (e) { return { text: `[@${member.first} generated it but couldn't write the file: ${e?.message || e}]`, ok: false } }
  const rel = join(territory, name)
  // #48: return the structured asset alongside the text (the clean {text, asset} contract — no backtick
  // regex downstream) so the worker-runner can record path/ext/bytes/kind/prompt for the call-history UI.
  return {
    ok: true,
    text: `Generated ${kind === 'image' ? 'image' : kind === 'sfx' ? 'sound effect' : 'music'}: \`${rel}\`${transparent ? ' (transparent bg)' : ''} (${(asset.bytes.length / 1024).toFixed(0)} KB) — from "${prompt.slice(0, 80)}".`,
    asset: { path: rel, ext: asset.ext, bytes: asset.bytes.length, kind, prompt: prompt.slice(0, 200) },
  }
}
