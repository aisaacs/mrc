// Media-generation members. A "designer", "sound-designer", or "composer" is a task-worker whose
// backend is a generation API (Gemini image, ElevenLabs SFX/music). On a directed @mention it turns
// the request into an asset FILE written into its territory, and posts back the path — no CLI, no
// container, just an HTTP call from the daemon (which has the keys via loadEnv). The HTTP calls take
// an injectable fetch so the dispatch / prompt-extraction / file-writing are unit-testable offline.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { extractMentions } from './names.js'
import { repoEnvKey } from '../config.js'
import { HAIKU_MODEL } from '../constants.js'

// role -> media kind. The ROLE decides what gets made; the backend just names the provider.
export const MEDIA_ROLES = { designer: 'image', 'sound-designer': 'sfx', composer: 'music' }
export const isMediaRole = (role) => Object.prototype.hasOwnProperty.call(MEDIA_ROLES, role)

const env = (k) => process.env[k] || ''
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'asset'

// The generation prompt = the requesters' messages, stripped of @mentions and the [Human …] framing.
export function mediaPrompt(items = []) {
  return items
    .map((it) => String(it.text || '').replace(/\[Human (directive|reply)\]:/gi, '').trim())
    .map((t) => { for (const m of extractMentions(t)) t = t.split('@' + m).join('').split('@' + m.split('/')[0]).join(''); return t })
    .map((t) => t.replace(/\s+/g, ' ').trim())
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
  const system = `You are the ${kind === 'image' ? 'art' : 'audio'} director for a software team. A teammate sent the message below to a ${kind} generator. Reply ONLY with JSON. If it is a real request for a NEW ${kind} asset: {"prompt":"<concise standalone ${kind}-generation prompt>","name":"<2-4 word kebab filename, no extension>"}. If it is just feedback/approval/chatter and NOT a new asset request: {"skip":true}.`
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
export async function generateMedia(member, { items = [], fetchFn } = {}) {
  const kind = MEDIA_ROLES[member.role]
  if (!kind) return { text: `[@${member.first}: not a media role]` }
  const raw = mediaPrompt(items)
  if (!raw) return { text: `[@${member.first}: nothing to make — say what you want generated]` }
  // Art-director pass: clean the prompt + filename, and skip messages that are just feedback.
  const adKey = repoEnvKey(member.repo, 'MRC_SESSION_NAMING_ANTHROPIC_API_KEY') || repoEnvKey(member.repo, 'ANTHROPIC_API_KEY')
  const ad = await artDirect(raw, kind, { apiKey: adKey, fetchFn })
  if (ad?.skip) return { text: `[@${member.first}: that read as feedback, not a new ${kind} request — start with "make/generate …" when you want a new asset.]` }
  const prompt = (ad?.prompt) || raw
  const fileBase = slug(ad?.name || prompt)
  const apiKey = repoEnvKey(member.repo, KEY_FOR[kind])   // per-repo .env first, then the global key
  let asset
  try { asset = await GENERATORS[kind](prompt, { apiKey, fetchFn }) }
  catch (e) { return { text: `[@${member.first} couldn't generate it: ${e?.message || e}]` } }
  const territory = member.territory && member.territory !== '.' ? member.territory : 'assets'
  const dir = join(member.repo, territory)
  const name = `${fileBase}-${createHash('sha1').update(prompt + asset.bytes.length).digest('hex').slice(0, 6)}.${asset.ext}`
  try { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), asset.bytes) }
  catch (e) { return { text: `[@${member.first} generated it but couldn't write the file: ${e?.message || e}]` } }
  const rel = join(territory, name)
  return { text: `Generated ${kind === 'image' ? 'image' : kind === 'sfx' ? 'sound effect' : 'music'}: \`${rel}\` (${(asset.bytes.length / 1024).toFixed(0)} KB) — from "${prompt.slice(0, 80)}".` }
}
