import { HAIKU_MODEL } from '../constants.js'
import { extractTranscript } from './transcript.js'
import { loadNames, saveNames, saveMeta } from './manager.js'

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
    // #52: a 401 is TERMINAL (the key won't work until relaunch) — throw a typed error so the namer's
    // retry loop stops instead of re-logging this every backoff. Other !ok (429/5xx) returns null = retryable.
    throw Object.assign(new Error('naming key rejected (401)'), { code: 'AUTH' })
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

/** Generate a descriptive kebab-case session name using Haiku.
 *  Returns a STATUS so a caller can retry (#52): 'named' / 'exists' / 'no-key' are TERMINAL (stop);
 *  'too-short' (transcript below the floor — try again as it grows) and 'error' (a transient Haiku /
 *  network blip) are RETRYABLE. */
export async function generateName(mrcDir, uuid) {
  const names = loadNames(mrcDir)
  if (names[uuid]) return 'exists'  // already named

  const apiKey = namingKey()
  if (!apiKey) {
    process.stderr.write('\x1b[1;31m  ✦ Name generation skipped: no MRC_SESSION_NAMING_ANTHROPIC_API_KEY set\x1b[0m\n')
    return 'no-key'
  }

  // #48: excludeMeta strips room/channel peer messages (and other injected turns) so a session a
  // peer consulted is named from its OWN input — not the peer's topic. If that leaves too little
  // (a pure-consultation session), the floor below skips naming and it stays unnamed (correct).
  const transcript = extractTranscript(mrcDir, uuid, 2000, { excludeMeta: true })
  // Floor: don't ask the namer to name an empty/near-empty session — it replies "no transcript
  // provided", which fails the kebab-case check below and surfaces as a confusing "bad format" error.
  // The watcher already gates on ~10KB of .jsonl, but this guards manual/resumed callers too. Returns
  // 'too-short' (not a hard stop) so the #52 retry loop keeps checking as the transcript grows.
  if (!transcript || transcript.trim().length < 200) return 'too-short'

  let text
  try {
    text = await callHaiku(apiKey, [{
      role: 'user',
      content:
        'Generate a short kebab-case name (3-5 words, lowercase, hyphens) that describes ' +
        "what this Claude Code session is about. Examples: 'android-splash-screen-hang-fix', " +
        "'add-user-auth-middleware', 'refactor-db-connection-pool'.\n\n" +
        'Reply with ONLY the kebab-case name, nothing else.\n\n' +
        `Transcript:\n${transcript}`,
    }], 30)
  } catch (e) {
    return e?.code === 'AUTH' ? 'no-key' : 'error'   // 401 = terminal (relaunch needed); network/timeout = retryable
  }

  if (!text) return 'error'   // non-401 API failure (429/5xx) — retryable

  const name = text.trim().toLowerCase().replace(/^["']|["']$/g, '')
  if (!name || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    process.stderr.write(`\x1b[1;31m  ✦ Name generation: bad format '${name}'\x1b[0m\n`)
    return 'error'   // a flaky response — retryable
  }

  // Re-read in case a manual name was set while we were generating
  const fresh = loadNames(mrcDir)
  if (!fresh[uuid]) {
    fresh[uuid] = name
    saveNames(mrcDir, fresh)                 // transitional projection (retired in Phase 2)
    saveMeta(mrcDir, uuid, { name })          // record = source of truth
    process.stderr.write(`\x1b[1;36m  ✦ Session named → \x1b[1;33m${name}\x1b[0m\n`)
    return 'named'
  }
  return 'exists'   // a concurrent writer named it while we were generating
}
