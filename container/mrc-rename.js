#!/usr/bin/env node
//
// mrc-rename — rename THIS mrc session from inside the container.
//
// Writes the session's display name to the repo's flat name map:
//   /workspace/.mrc/session-names  (line-based `uuid=name`)
// which is the ONE place the status line (container/mrc-statusline.js → lookupSessionName) and the session
// picker (src/sessions/manager.js → loadNames) read a name from. Writing it here also pins the name against
// the host auto-namer, which does `if (names[uuid]) return` (generateName → 'exists') and so never clobbers
// a human-chosen name.
//
// NOTE (integration substrate): pierre-plus-more ALSO wrote a per-uuid `.mrc/session-meta/<uuid>.json`
// "source of truth". Integration deliberately did NOT build that display-metadata split (see
// session-record.js — "#32 name-meta" is decided-against); names live ONLY in the flat session-names file.
// So this port writes session-names alone — writing a per-uuid record here would produce a file nothing reads.
//
// The conversation uuid is the pinned MRC_SESSION_ID (rooms sessions) or, failing that, the most recently
// written transcript in .mrc (the active session is the one being written right now).
//
// Invoked by the /rename slash command, or directly when the human asks Claude to rename the session
// ("rename this session" / "rename this to <x>"). Mirrors src/sessions/manager.js's saveNames (merge-on-save),
// which we can't import here (src/ isn't in the container) — so the file format + merge are replicated.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

const MRC_DIR = process.env.MRC_RENAME_DIR || '/workspace/.mrc'   // override only for tests; prod is always the repo's .mrc
const fail = (msg) => { process.stderr.write(msg + '\n'); process.exit(1) }

function currentUuid() {
  if (process.env.MRC_SESSION_ID) return process.env.MRC_SESSION_ID
  let best = null, bestMs = -1, files
  try { files = readdirSync(MRC_DIR).filter((f) => f.endsWith('.jsonl')) } catch { return null }
  for (const f of files) {
    let ms = 0
    try { ms = statSync(join(MRC_DIR, f)).mtimeMs } catch {}
    if (ms > bestMs) { bestMs = ms; best = basename(f, '.jsonl') }
  }
  return best
}

// Sanitize: collapse to a single line (session-names is line-based `uuid=name`), trim, length-cap. We keep
// spaces + mixed case (funny names are the point); the daemon de-trusts labels on its side (E/#42).
const name = process.argv.slice(2).join(' ').replace(/[\r\n]+/g, ' ').trim().slice(0, 80)
if (!name) fail('usage: mrc-rename <new session name>')

const uuid = currentUuid()
if (!uuid) fail('Could not determine the current session id (no MRC_SESSION_ID and no transcript in .mrc).')

try {
  // session-names map — MERGE with the on-disk state first (mirrors manager.js saveNames), so a concurrent
  // host auto-namer writing a different uuid isn't clobbered, then set our uuid. This also makes the name
  // sticky: the auto-namer sees names[uuid] present and returns 'exists' without overwriting it.
  const namesFile = join(MRC_DIR, 'session-names')
  const names = {}
  try {
    for (const line of readFileSync(namesFile, 'utf8').split('\n')) {
      const eq = line.indexOf('=')
      if (eq > 0) names[line.slice(0, eq)] = line.slice(eq + 1)
    }
  } catch {}
  names[uuid] = name
  writeFileSync(namesFile, Object.entries(names).map(([u, n]) => `${u}=${n}`).join('\n') + '\n')
} catch (e) {
  fail(`Couldn't write the session name (${e.message}). If this is a sandboxed adversary, /workspace is read-only.`)
}

process.stdout.write(`Renamed this session → "${name}"\n` +
  `The status line updates on its next render; the session picker shows it the next time you resume.\n`)
