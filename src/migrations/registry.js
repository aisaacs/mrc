// The migration framework core. Migrations are VERSIONED, ORDERED, IDEMPOTENT changes to how mrc stores memory, and
// their identity/history is PER-SLICE (the single-owner unit of data), NOT per-repo — a repo is just a front door that
// resolves to a slice, and N repos can share one slice (a cp'd sibling, a shared member). See docs/migration-system.md.
//
// TRUST TIER (Pierre): the activation GATE — which migrations ran + the slice's `layoutLevel` — is a SECURITY record: it
// decides store-vs-legacy and whether an image may safely READ the slice's data layout. So it is HOST-ONLY, in
// ~/.local/share/mrc/migration-meta/<sliceId>/, exactly like the adversary-containment session-meta store — NEVER inside
// the `/mrc` mount the sandbox can scribble on (a container-writable gate lets a hostile session forge/delete it).
// This is a deliberate TRILEMMA choice — {tamper-proof, desync-free, rebuildable-from-data}, pick two:
//   • an in-slice marker is desync-free + rebuildable-from-data but NOT tamper-proof (container-writable) — rejected.
//   • host-only is TAMPER-PROOF, but it is a sidecar that CAN desync from the slice data (backup-restore / disk loss)
//     and is NOT rebuildable from the (attacker-forgeable) slice — a security gate MUST take tamper-proof.
// COST, stated out loud (footgun-D, the right price): migration-meta's durability is load-bearing — lose it and a
// migrated slice reads "not migrated" until a human re-runs `mrc migrate` (idempotent; recovers with NO misread). BACK
// UP ~/.local/share/mrc/migration-meta. This record is NOT rebuildable from slice data by construction. Fail direction:
// a corrupt/unreadable record fails CLOSED (deny store-mode), never level-0-over-level-N (a silent misread).
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import mig001 from './001-relocate-mrc-to-store.js'

// Ordered list. APPEND new migrations; NEVER reorder or renumber — the id IS the identity and the order is the apply order.
export const MIGRATIONS = [mig001]

// HOST-ONLY record dir for a slice. `metaRoot` is injectable for tests (so a test never touches the real ~/.local/share);
// production defaults to the migration-meta sibling of the store.
const defaultMetaRoot = () => join(homedir(), '.local', 'share', 'mrc', 'migration-meta')
const metaDir = (sliceDir, metaRoot) => join(metaRoot || defaultMetaRoot(), basename(sliceDir))

// Does the SLICE hold real memory content (transcripts / shared memory / the relocate sentinel)? Used to distinguish a
// genuinely-fresh slice (no data, no record → safe, level 0) from a slice whose host record was LOST (data present, no
// record → dangerous, deny). "has data" is container-forgeable, but a forged data-present only pushes toward MORE deny
// (fail-closed), never activate → the attacker can't weaponize it.
const sliceHasData = (sliceDir) => {
  try { return readdirSync(sliceDir).some(f => f.endsWith('.jsonl') || f === 'memory' || f === 'session-names' || f === 'session-summaries' || f.startsWith('.mrc-store-migrated')) } catch { return false }
}

// The slice's migration state, from its HOST-ONLY records. `layoutLevel` = MAX over the STAMPED rec.layoutLevel of every
// applied migration — the STAMP is authoritative (a live module-constant change can't retro-reinterpret an old slice), AND
// an UNKNOWN-module record (a slice migrated by a NEWER host, read by an OLDER one) STILL contributes its stamped level →
// an old host sees "level 3, I do ≤0" → deny, never undercount+misread. `corrupt` = a present-but-unreadable record (or a
// missing/NaN stamped level) → the caller must fail CLOSED (deny store-mode), never silently level 0.
export function sliceMigrationState(sliceDir, { metaRoot } = {}) {
  const dir = metaDir(sliceDir, metaRoot)
  const ran = new Map(); let corrupt = false, layoutLevel = 0
  let files = null; try { files = readdirSync(dir) } catch {}                                                 // absent dir → files null (handled below)
  for (const f of (files || [])) {
    if (f.startsWith('.')) continue
    let rec; try { rec = JSON.parse(readFileSync(join(dir, f), 'utf8')) } catch { corrupt = true; continue }   // present-but-unparseable → fail-closed
    ran.set(f, rec)
    const lvl = Number(rec.layoutLevel)
    if (Number.isFinite(lvl)) { if (lvl > layoutLevel) layoutLevel = lvl } else corrupt = true               // missing/NaN stamped level → fail-closed
  }
  const migrated = ran.size > 0
  // RECORD-LOSS fail-closed (Pierre): a slice with DATA but NO host record is NOT a fresh slice — the host-only record
  // was LOST (backup-restore / disk / cleanup — the durability cost the trilemma named). We can't prove what layout the
  // data is at → DENY, never assume level 0 over level-N data (a misread + a cascading #002 double-apply). An absent
  // record + EMPTY slice = genuinely fresh = safe → level 0. This is the primary durability case, not an edge — record
  // LOSS is far likelier than record CORRUPTION and is the failure the host-only sidecar introduced by design.
  const recordLost = !migrated && sliceHasData(sliceDir)
  return { ran, layoutLevel, migrated, corrupt, recordLost }
}

// Record a migration as applied — HOST-ONLY, atomic (tmp→rename). Stamps the module's layoutLevel + whatever `extra`
// (e.g. the manifest, so `mrc migrate verify` re-runs at the same scope). The RUNNER calls this HOST-SIDE, AFTER verify().
export function recordMigration(sliceDir, mod, { metaRoot, ...extra } = {}) {
  const dir = metaDir(sliceDir, metaRoot); mkdirSync(dir, { recursive: true })
  const rec = { id: mod.id, ranAt: new Date().toISOString(), layoutLevel: mod.layoutLevel, ...extra }
  const file = join(dir, mod.id), tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n'); renameSync(tmp, file)
  return rec
}

// FAIL-CLOSED accessors (Pierre): both deny states — `corrupt` (present-but-unreadable record) AND `recordLost` (data
// present, record missing) — must be UNSATISFIABLE BY CONSTRUCTION, honored in the RETURN, never a flag a caller
// (resolveStoreMode, the runner) has to remember, or the convenience path silently fails OPEN (the job-1 pattern).
const denied = (s) => s.corrupt || s.recordLost
//   sliceLayoutLevel → Infinity on either deny → EVERY `imageCapability >= level` denies automatically (no misread).
export function sliceLayoutLevel(sliceDir, opts = {}) {
  const s = sliceMigrationState(sliceDir, opts)
  return denied(s) ? Infinity : s.layoutLevel
}
//   pendingMigrations THROWS on either deny — the runner MUST HALT (over a corrupt/lost record you can't prove what ran;
//   auto-re-running would act on unknown state — e.g. re-apply #002 over already-layout-2 data). A forgetful caller gets
//   a loud error, never a silent fail-open re-run. (The runner ADOPTS a legit record-lost #001 slice explicitly — see it.)
export function pendingMigrations(sliceDir, ctx = {}) {
  const s = sliceMigrationState(sliceDir, ctx)
  if (s.corrupt) throw new Error(`migration record for slice ${basename(sliceDir)} is CORRUPT — refusing to compute pending (inspect ~/.local/share/mrc/migration-meta/${basename(sliceDir)})`)
  if (s.recordLost) throw new Error(`slice ${basename(sliceDir)} holds DATA but its migration record is MISSING (host-only record lost) — refusing to blind-migrate; adopt/recover it explicitly (inspect ~/.local/share/mrc/migration-meta/${basename(sliceDir)})`)
  return MIGRATIONS.filter(m => !s.ran.has(m.id) && (typeof m.isPending === 'function' ? m.isPending({ ...ctx, sliceDir }) : true))
}
//   hasMigration routes through the PARSED state (not a bare existsSync — a corrupt marker file "exists" but proves
//   nothing) → throws on either deny, else honestly "did <id> run".
export function hasMigration(sliceDir, id, opts = {}) {
  const s = sliceMigrationState(sliceDir, opts)
  if (denied(s)) throw new Error(`migration record for slice ${basename(sliceDir)} is ${s.corrupt ? 'CORRUPT' : 'MISSING (data present, record lost)'}`)
  return s.ran.has(id)
}
