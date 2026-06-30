// #21b — the daemon's code version, used to detect stale code across `mrc rooms restart`.
//
// The OLD stamp hashed only room-daemon.js, so editing any module it imports (room-engine, trust,
// telegram, config's repoEnvKeyStrict #14 token reader, constants, …) left the stamp UNCHANGED — the
// version check couldn't see the change and the daemon silently kept serving stale code. That was the
// root cause of the stale-daemon saga.
//
// Fix: hash EVERY `.js` under src/ (sorted → deterministic). We glob the whole tree rather than walk the
// import graph on purpose — room-daemon.js / the engine use DYNAMIC `import('../commands/team.js')` /
// `import('./media.js')` / `import('./png.js')` at call time, which a static closure walk can't see.
// Over-including a few unrelated files is harmless (a couple of extra legitimate cache-misses on edits);
// under-including re-opens the silent-stale bug. Drift-proof beats curated-and-fragile.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// This file lives at src/daemon-version.js, so its directory IS the src/ root.
const SRC_DIR = dirname(fileURLToPath(import.meta.url))

function allJsFiles(dir) {
  const out = []
  let names
  try { names = readdirSync(dir) } catch { return out }
  for (const name of names) {
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) out.push(...allJsFiles(p))
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

// sha1 over (relative path + contents) of every `.js` under `dir` (default src/), sorted by path.
// Deterministic: same tree → same stamp twice; ANY edit to a daemon-reachable file changes it. Returns
// '?' only if the tree is unreadable. `dir` is parameterized for tests; production always uses src/.
export function daemonVersion(dir = SRC_DIR) {
  try {
    const files = allJsFiles(dir).sort()
    if (!files.length) return '?'
    const h = createHash('sha1')
    for (const f of files) {
      h.update(f.slice(dir.length))   // relative path (stable regardless of where the tree is checked out)
      h.update('\0')
      h.update(readFileSync(f))
      h.update('\0')
    }
    return h.digest('hex').slice(0, 12)
  } catch { return '?' }
}
