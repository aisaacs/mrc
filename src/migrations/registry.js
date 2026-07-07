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

// The slice's migration state, from its HOST-ONLY records. `layoutLevel` = MAX over the STAMPED rec.layoutLevel of every
// applied migration — the STAMP is authoritative (a live module-constant change can't retro-reinterpret an old slice), AND
// an UNKNOWN-module record (a slice migrated by a NEWER host, read by an OLDER one) STILL contributes its stamped level →
// an old host sees "level 3, I do ≤0" → deny, never undercount+misread. `corrupt` = a present-but-unreadable record (or a
// missing/NaN stamped level) → the caller must fail CLOSED (deny store-mode), never silently level 0.
export function sliceMigrationState(sliceDir, { metaRoot } = {}) {
  const dir = metaDir(sliceDir, metaRoot)
  const ran = new Map(); let corrupt = false, layoutLevel = 0
  let files; try { files = readdirSync(dir) } catch { return { ran, layoutLevel: 0, migrated: false, corrupt: false } }
  for (const f of files) {
    if (f.startsWith('.')) continue
    let rec; try { rec = JSON.parse(readFileSync(join(dir, f), 'utf8')) } catch { corrupt = true; continue }   // present-but-unparseable → fail-closed
    ran.set(f, rec)
    const lvl = Number(rec.layoutLevel)
    if (Number.isFinite(lvl)) { if (lvl > layoutLevel) layoutLevel = lvl } else corrupt = true               // missing/NaN stamped level → fail-closed
  }
  return { ran, layoutLevel, migrated: ran.size > 0, corrupt }
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

// The migrations PENDING for this slice, in order. Pending = no host record AND the module's own isPending(ctx) agrees.
export function pendingMigrations(sliceDir, ctx = {}) {
  const { ran } = sliceMigrationState(sliceDir, ctx)
  return MIGRATIONS.filter(m => !ran.has(m.id) && (typeof m.isPending === 'function' ? m.isPending({ ...ctx, sliceDir }) : true))
}

export function sliceLayoutLevel(sliceDir, opts = {}) { return sliceMigrationState(sliceDir, opts).layoutLevel }
export function hasMigration(sliceDir, id, { metaRoot } = {}) { return existsSync(join(metaDir(sliceDir, metaRoot), id)) }
