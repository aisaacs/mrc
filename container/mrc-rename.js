#!/usr/bin/env node
//
// mrc-rename — rename THIS mrc session from inside the container.
//
// Writes the session's display name to BOTH:
//   1. the per-uuid record  /workspace/.mrc/session-meta/<uuid>.json (.name)  — the SOURCE OF TRUTH the
//      status line + the session picker read (updates the status line on the next render);
//   2. the legacy map       /workspace/.mrc/session-names  (uuid=name)        — keeps the host auto-namer
//      from later clobbering this name (generateName does `if (names[uuid]) return`), and feeds rooms
//      list_peers on the next launch.
//
// The conversation uuid is the pinned MRC_SESSION_ID (rooms sessions) or, failing that, the most
// recently written transcript in .mrc (the active session is the one being written right now).
//
// Invoked by the /rename slash command, or directly when the human asks Claude to rename the session
// ("rename this session" / "rename this to <x>"). Mirrors src/sessions/manager.js's nameSession, which we
// can't import here (src/ isn't in the container) — so the file format is replicated, kept in lockstep.
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, renameSync } from 'node:fs'
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
  // 1) legacy session-names map (merge) — makes the name sticky against the host auto-namer
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

  // 2) per-uuid record (source of truth) — atomic temp+rename, preserving other fields
  const metaDir = join(MRC_DIR, 'session-meta')
  mkdirSync(metaDir, { recursive: true })
  const metaFile = join(metaDir, `${uuid}.json`)
  let meta = {}
  try { meta = JSON.parse(readFileSync(metaFile, 'utf8')) } catch {}
  const tmp = `${metaFile}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ ...meta, name, uuid }, null, 2) + '\n')
  renameSync(tmp, metaFile)
} catch (e) {
  fail(`Couldn't write the session name (${e.message}). If this is a sandboxed adversary, /workspace is read-only.`)
}

process.stdout.write(`Renamed this session → "${name}"\n` +
  `The status line updates on its next render; the session picker shows it the next time you resume.\n`)
