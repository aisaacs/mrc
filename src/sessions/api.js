import { HAIKU_MODEL } from '../constants.js'
import { extractTranscript } from './transcript.js'
import { loadNames, saveNames } from './manager.js'

// Host-only key for the Haiku naming/summary calls. Renamed from ANTHROPIC_API_KEY so it never
// collides with the key Claude Code auto-detects inside the sandbox; the legacy name still works
// as a deprecated fallback.
const namingKey = () => process.env.MRC_SESSION_NAMING_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY

async function callHaiku(apiKey, messages, maxTokens = 512) {
  const body = JSON.stringify({ model: HAIKU_MODEL, max_tokens: maxTokens, messages })

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body,
    signal: AbortSignal.timeout(30_000),
  })

  if (resp.status === 401) {
    process.stderr.write(
      '\x1b[1;31m  ✦ API key rejected (401). The key may have been rotated.\x1b[0m\n' +
      '\x1b[0;2m    Exit this session and relaunch mrc to pick up the new key.\x1b[0m\n'
    )
    return null
  }
  if (!resp.ok) return null

  const result = await resp.json()
  return (result.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
}

/** Generate a session summary using Haiku. Writes to session-summaries/<uuid>.md. */
export async function summarize(mrcDir, uuid) {
  const apiKey = namingKey()
  if (!apiKey) return

  const transcript = extractTranscript(mrcDir, uuid)
  if (!transcript) return

  const text = await callHaiku(apiKey, [{
    role: 'user',
    content:
      'Summarize this Claude Code session transcript concisely. Include:\n' +
      '1. What was accomplished (1-2 sentences)\n' +
      '2. Key files changed (bulleted list, if any)\n' +
      '3. Notable decisions or tradeoffs (if any)\n\n' +
      'Keep the entire summary under 5 lines. Use markdown.\n\n' +
      `Transcript:\n${transcript}`,
  }])

  if (text?.trim()) {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = join(mrcDir, 'session-summaries')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${uuid}.md`), text.trim() + '\n')
  }
}

/** Generate a descriptive kebab-case session name using Haiku. */
export async function generateName(mrcDir, uuid) {
  const names = loadNames(mrcDir)
  if (names[uuid]) return  // already named

  const apiKey = namingKey()
  if (!apiKey) {
    process.stderr.write('\x1b[1;31m  ✦ Name generation skipped: no MRC_SESSION_NAMING_ANTHROPIC_API_KEY set\x1b[0m\n')
    return
  }

  // #48: excludeMeta strips room/channel peer messages AND the assistant replies to them (OBJ-4) so a session a
  // peer consulted is named from its OWN input — not the peer's topic.
  const transcript = extractTranscript(mrcDir, uuid, 2000, { excludeMeta: true })
  // #48/OBJ-4 FLOOR: don't name a session with too little of its OWN content. A pure-consultation session (only
  // peer asks + replies-to-the-peer, all stripped above) falls below this and stays UNNAMED rather than mis-named
  // from the peer's topic. Also guards the namer from an empty transcript (it replies "no transcript provided",
  // which then fails the kebab-case check as a confusing "bad format"). (#52's version had this floor; it was
  // deferred, so the comment promised a floor that didn't exist — a talkative consultation got named anyway.)
  if (!transcript || transcript.trim().length < 200) return

  const text = await callHaiku(apiKey, [{
    role: 'user',
    content:
      'Generate a short kebab-case name (3-5 words, lowercase, hyphens) that describes ' +
      "what this Claude Code session is about. Examples: 'android-splash-screen-hang-fix', " +
      "'add-user-auth-middleware', 'refactor-db-connection-pool'.\n\n" +
      'Reply with ONLY the kebab-case name, nothing else.\n\n' +
      `Transcript:\n${transcript}`,
  }], 30)

  if (!text) return

  const name = text.trim().toLowerCase().replace(/^["']|["']$/g, '')
  if (!name || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    process.stderr.write(`\x1b[1;31m  ✦ Name generation: bad format '${name}'\x1b[0m\n`)
    return
  }

  // Re-read in case a manual name was set while we were generating
  const fresh = loadNames(mrcDir)
  if (!fresh[uuid]) {
    fresh[uuid] = name
    saveNames(mrcDir, fresh)
    process.stderr.write(`\x1b[1;36m  ✦ Session named → \x1b[1;33m${name}\x1b[0m\n`)
  }
}
