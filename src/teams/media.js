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

// Worker invoker for a media member: generate the asset and write it into the member's territory.
// `member` carries { role, repo, territory, first }; ctx carries { items, fetchFn? }.
export async function generateMedia(member, { items = [], fetchFn } = {}) {
  const kind = MEDIA_ROLES[member.role]
  if (!kind) return { text: `[@${member.first}: not a media role]` }
  const prompt = mediaPrompt(items)
  if (!prompt) return { text: `[@${member.first}: nothing to make — say what you want generated]` }
  const apiKey = repoEnvKey(member.repo, KEY_FOR[kind])   // per-repo .env first, then the global key
  let asset
  try { asset = await GENERATORS[kind](prompt, { apiKey, fetchFn }) }
  catch (e) { return { text: `[@${member.first} couldn't generate it: ${e?.message || e}]` } }
  const territory = member.territory && member.territory !== '.' ? member.territory : 'assets'
  const dir = join(member.repo, territory)
  const name = `${slug(prompt)}-${createHash('sha1').update(prompt + asset.bytes.length).digest('hex').slice(0, 6)}.${asset.ext}`
  try { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), asset.bytes) }
  catch (e) { return { text: `[@${member.first} generated it but couldn't write the file: ${e?.message || e}]` } }
  const rel = join(territory, name)
  return { text: `Generated ${kind === 'image' ? 'image' : kind === 'sfx' ? 'sound effect' : 'music'}: \`${rel}\` (${(asset.bytes.length / 1024).toFixed(0)} KB) — from "${prompt.slice(0, 80)}".` }
}
