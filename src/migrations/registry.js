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

// LAYOUT-MARKER CONVENTION (Pierre, ADOPT-A structural fix). ADOPTION of a pre-framework slice (data + in-slice
// sentinel, but NO host record — the old auto-migrate's output) must adopt DOWNWARD to the level the evidence
// PROVES and NEVER launder a HIGHER layout down to level-0. Detecting "higher" by scanning control files is only
// sound IF every layout-CHANGING migration leaves a durable, RECOGNIZABLE in-slice marker. So we make that a
// RULE, not a hope: any migration that changes the on-disk layout (layoutLevel >= 1) MUST declare `layoutMarker`
// = a filename in the RESERVED `.mrc-store-layout-<N>` namespace and WRITE it in up(). #001 is layout-NEUTRAL
// (level 0, a pure relocation any store-capable image reads) so it declares none — it IS the pre-framework
// baseline adoption is allowed to reach. `assertLayoutMarkerConvention` is the LINT (a test calls it): the day a
// #002 ships without a conforming marker, the suite fails — so adoption can never silently launder it. This turns
// ADOPT-A from a naming heuristic into a by-construction guarantee.
export const LAYOUT_MARKER_RE = /^\.mrc-store-layout-\d+$/
export function layoutMarkersOf(list = MIGRATIONS) { return new Set(list.map(m => m && m.layoutMarker).filter(Boolean)) }

// Does the slice show a layout NEWER than #001? (a `.mrc-store-layout-<N>` reserved-namespace marker, a registered
// migration's declared marker, or ANY other durable control file outside the #001 baseline → fail-safe over-detect).
// The ONE detector shared by adoption's higher-signature guard AND memberStoreActive's floor (so they can't drift).
const KNOWN_001_CONTROL = new Set(['.mrc-store-migrated', '.mrc-store-migrated-v2', '.mrc-mtimes-normalized', '.mrc-migrate.log'])
const isControlFile = (f) => f.startsWith('.mrc-') || f.startsWith('.oxcl') || f.endsWith('.lock')
const isTransientControl = (f) => f.startsWith('.oxcl') || f.endsWith('.lock')
export function sliceHigherSignature(sliceDir) {
  let files = []; try { files = readdirSync(sliceDir) } catch {}
  const declared = layoutMarkersOf()
  return files.some(f => LAYOUT_MARKER_RE.test(f) || declared.has(f)) ||
    files.filter(isControlFile).some(f => !KNOWN_001_CONTROL.has(f) && !isTransientControl(f))
}
export function assertLayoutMarkerConvention(list = MIGRATIONS) {
  for (const m of list) {
    if (Number(m.layoutLevel) >= 1 && !(m.layoutMarker && LAYOUT_MARKER_RE.test(m.layoutMarker))) {
      throw new Error(`migration ${m.id} changes layout (level ${m.layoutLevel}) but declares no valid layoutMarker (must match ${LAYOUT_MARKER_RE}); adoption could launder a level-${m.layoutLevel} slice down to level-0 — declare a .mrc-store-layout-${m.layoutLevel} marker and write it in up()`)
    }
  }
  return true
}

// HOST-ONLY record dir for a slice. `metaRoot` is injectable for tests (so a test never touches the real ~/.local/share);
// production defaults to the migration-meta sibling of the store.
const defaultMetaRoot = () => join(homedir(), '.local', 'share', 'mrc', 'migration-meta')
const metaDir = (sliceDir, metaRoot) => join(metaRoot || defaultMetaRoot(), basename(sliceDir))

// Does the SLICE hold real memory content (transcripts / shared memory / the relocate sentinel)? Used to distinguish a
// genuinely-fresh slice (no data, no record → safe, level 0) from a slice whose host record was LOST (data present, no
// record → dangerous, deny). "has data" is container-forgeable, but a forged data-present only pushes toward MORE deny
// (fail-closed), never activate → the attacker can't weaponize it.
// "has data" = ANY non-store-CONTROL entry (Pierre: a name allow-list would miss a session-summaries/- or <uuid>/-only
// slice → lost-record fail-open for that shape). Control files (`.mrc-*` incl the sentinel + migration markers, `.oxcl*`,
// `*.lock`) are the store's own; everything else is memory data.
const isStoreControl = (f) => f.startsWith('.mrc-') || f.startsWith('.oxcl') || f.endsWith('.lock')
const sliceHasData = (sliceDir) => {
  try { return readdirSync(sliceDir).some(f => !isStoreControl(f)) } catch { return false }
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

// ── OPT-OUT marker (from `mrc migrate detach`; consumed by storeActivation below) ────────────────────────────
// Host-only, a DOTFILE in the slice's migration-meta dir (sliceMigrationState skips `.`-files, so it never looks
// like a migration record). A repo opts OUT of the store here (detach); a later `mrc migrate up` opts back in by
// removing it. Same trust tier as the records — never in the container-writable /mrc mount.
export function recordOptOut(sliceDir, { metaRoot } = {}) {
  const dir = metaDir(sliceDir, metaRoot); mkdirSync(dir, { recursive: true })
  const file = join(dir, '.opted-out'), tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ optedOut: true, at: new Date().toISOString() }) + '\n'); renameSync(tmp, file)
  return file
}
export function clearOptOut(sliceDir, { metaRoot } = {}) {
  try { const f = join(metaDir(sliceDir, metaRoot), '.opted-out'); if (existsSync(f)) { renameSync(f, `${f}.cleared`); return true } } catch {}
  return false
}
export function isOptedOut(sliceDir, { metaRoot } = {}) {
  try { return existsSync(join(metaDir(sliceDir, metaRoot), '.opted-out')) } catch { return false }
}

// ── #13: LAUNCH-TIME store activation (capability-as-version + explicit-migration-gated) ──────────────────────
// Store-mode for the user's OWN plain/solo repo is a GRANT, DENY-UNLESS-PROVEN — it REPLACES the silent
// auto-migrate. It activates ONLY when: (a) the image is store-capable, (b) the repo was EXPLICITLY migrated via
// `mrc migrate` — a HOST RECORD, not the container-writable in-slice sentinel, (c) image capability >= the slice's
// layoutLevel (a COMPARISON, so a future layout needs a newer image), and (d) not opted out. Every other case →
// LEGACY, with a `reason` the launcher turns into a loud, accurate warning. corrupt/recordLost fail CLOSED (the
// accessors already deny). Migration itself happens ONLY in the runner now — never as a launch side effect.
export function storeActivation(sliceDir, imageStore, { metaRoot } = {}) {
  if (!imageStore || !imageStore.storeMode) return { active: false, reason: 'image-not-capable' }
  if (isOptedOut(sliceDir, { metaRoot })) return { active: false, reason: 'opted-out' }
  const s = sliceMigrationState(sliceDir, { metaRoot })
  if (s.corrupt) return { active: false, reason: 'record-corrupt' }
  if (s.recordLost) {
    // record-lost splits by RECOVERABILITY so the launcher can act: ADOPTABLE (an earlier-mrc migration — the #001
    // sentinel, no higher-layout signature) can be adopted with one confirm; STRANDED (data but no sentinel, or a
    // higher signature) needs manual recovery. The launcher STOPS an adoptable repo and offers to adopt rather than
    // silently opening a DIVERGING legacy session (the owner's bar — a naive user must not be dropped into a split).
    let files = []; try { files = readdirSync(sliceDir) } catch {}
    const hasSentinel = files.includes('.mrc-store-migrated-v2') || files.includes('.mrc-store-migrated')
    return { active: false, reason: (hasSentinel && !sliceHigherSignature(sliceDir)) ? 'adoptable' : 'stranded' }
  }
  if (!s.migrated) return { active: false, reason: 'unmigrated' }
  if (Number(imageStore.cap) >= Number(s.layoutLevel)) return { active: true, reason: 'migrated', layoutLevel: s.layoutLevel }
  return { active: false, reason: 'capability-shortfall', layoutLevel: s.layoutLevel }
}

// #13 MEMBER belt (Pierre #13-review): a team member BYPASSES the record requirement (it's team-launched, a human
// never runs `mrc migrate` for it) — but it must NOT bypass the CAPABILITY-as-version check (the ADOPT-A shape: a
// bare bypass is a future misread). A member slice is layout-0 today (relocation-only, include-scoped). We can't use
// sliceLayoutLevel here — a member slice has the in-slice sentinel but NO host record → recordLost → Infinity → it
// would fail-close EVERY member (break teams). So: no framework record → treat as the layout-0 member FLOOR (the
// current reality); a PRESENT record at a higher layout the image can't drive → fail closed; a CORRUPT record →
// deny. A no-op today (cap 1 >= 0); the day a member slice ever carries a layout≥1 record, it fails to legacy
// instead of misreading. This is the "enforce the invariant, don't hope it" close.
export function memberStoreActive(sliceDir, imageStore, { metaRoot } = {}) {
  if (!imageStore || !imageStore.storeMode) return false
  const s = sliceMigrationState(sliceDir, { metaRoot })
  if (s.corrupt) return false
  // Pierre #13-review corner: the no-record floor is layout-0 ONLY if the slice shows no HIGHER layout SIGNATURE.
  // A member slice carrying a `.mrc-store-layout-2` marker but no host record would otherwise floor to 0 and misread
  // its layout-2 data. Fold the tripwire into the floor with the SAME machinery adoption uses. No-op today.
  if (!s.migrated && sliceHigherSignature(sliceDir)) return false
  const layout = s.migrated ? s.layoutLevel : 0
  return Number(imageStore.cap) >= Number(layout)
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
