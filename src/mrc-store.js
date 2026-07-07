// mrc-store.js (#5) — the host-scoped MEMORY store. Conversation transcripts / session-names / worker-logs live
// OUTSIDE the repo workspace, under ~/.local/share/mrc/store/<slice>/, mounted per-container at /mrc. This
// decouples MEMORY from the repo: it fixes multi-repo (a member edits member.repo but its memory stays with its
// team/session), dissolves the cage transcript special-case (no /workspace:ro coupling → no EROFS-vaporize), and
// removes the in-repo `.mrc` hostile-symlink surface. ONLY memory (Class 1) lives here — a repo's own .env/config
// (Class 2: .mrc/.env, video-analysis.json, .mrc-id) STAY repo-relative, and team.runtime.json (Class 3) is
// host-only, never mounted.
//
// SLICE KEYING is ISOLATED-BY-DEFAULT / repoId-BY-GRANT, checked UNTRUSTED-FIRST (see sliceKeyFor). The user's
// own memory slice (repoId) is *granted* only on a positive trusted-own signal (solo, or a clean plain session);
// a team member/worker gets its own (org,handle) slice; a summoned adversary gets a walled (repo,slot) slice
// (the SAME boundary its -pierre-N config volume already isolates on); anything unsure → an isolated per-session
// floor. repoId is NEVER a fall-through default — that would leak the user's history to a member or a red-team
// (the exact fail-open both first drafts had, closed here by making repoId a positive grant, never the else).
import { openSync, writeSync, closeSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, realpathSync, renameSync, lstatSync, copyFileSync, cpSync, rmSync, readdirSync, existsSync, statSync, utimesSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep, dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { memberSessionId } from './teams/session-id.js'   // ONE member-identity hash (\0-separated, injective) — no second-hash drift

export const storeRoot = () => join(homedir(), '.local', 'share', 'mrc', 'store')
function ensureStoreRoot() { const r = storeRoot(); mkdirSync(r, { recursive: true }); return realpathSync(r) }

const md5 = (s) => createHash('md5').update(String(s)).digest('hex').slice(0, 12)
const sha = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 16)
function tryReadTrim(p) { try { return readFileSync(p, 'utf8').trim() } catch { return null } }

// GATE 4: a slice key BECOMES a path segment join(storeRoot, key), so it must be ONE traversal-safe segment.
// We mint keys in known-safe forms below, but validate here too (defense-in-depth) because the repo-id is READ
// from a repo file (attacker-influenceable). Strict charset, single segment, no '.'/'..'/separator/NUL/newline.
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]{0,190}$/i
export function assertSafeSegment(key) {
  if (typeof key !== 'string' || key === '.' || key === '..' || key.includes(sep) || key.includes('/') ||
      key.includes('\0') || key.includes('\n') || !SAFE_SEGMENT.test(key)) {
    throw new Error(`unsafe store slice key ${JSON.stringify(key)} — refusing to path on it`)
  }
  return key
}

// The absolute dir for a slice, with the ..-guard. Use lstat (does NOT follow the leaf) so we detect symlink-ness
// DIRECTLY — catching resolving, LOOPing (ELOOP), AND DANGLING symlinks alike. A realpath-based check would
// swallow ELOOP and, worse, treat a DANGLING symlink as ENOENT ("absent → safe") → the caller then writes THROUGH
// the link. So: lstat; genuine ENOENT (absent leaf) → safe; ANY symlink → refuse; non-dir → refuse; any other
// stat error (EACCES/ELOOP-in-ancestor/ENOTDIR) → fail CLOSED (never swallowed). Mirrors the /rooms caged-mount
// guard (mrc.js:660-662): what you checked is what you mount, no valid slice → THROW.
export function sliceDir(key) {
  assertSafeSegment(key)
  const root = ensureStoreRoot()
  const p = join(root, key)
  let lst
  try { lst = lstatSync(p) }
  catch (e) {
    if (e && e.code === 'ENOENT') return p            // leaf genuinely absent → safe (becomes a real dir on first write)
    throw e                                            // EACCES/ELOOP-in-ancestor/ENOTDIR/etc → never swallow
  }
  if (lst.isSymbolicLink()) throw new Error(`store slice "${key}" is a symlink — a slice must be a real directory, refusing to mount`)
  if (!lst.isDirectory()) throw new Error(`store slice "${key}" exists but is not a directory — refusing to mount`)
  const real = realpathSync(p)                         // real dir → belt: confirm it's inside the (realpath'd) root
  if (real !== p && !(real === root || real.startsWith(root + sep))) throw new Error(`store slice "${key}" resolves to ${real}, outside the store root — refusing to mount`)
  return p
}

// The repo-id file — Class 2, STAYS repo-relative (travels with the repo on mv/cp, gitignored so a fresh clone
// mints fresh). A single opaque UUID; it decides only WHICH of the user's own slices to open, never identity.
export const repoIdFile = (repoPath) => join(repoPath, '.mrc', '.mrc-id')
const REPO_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// The repo's stable store id, minted if absent. GATE 2 (race-safe): O_EXCL create so N concurrent first-launches
// CONVERGE on one id (read-back on EEXIST), reusing the Pierre-slot claimLowestFree discipline. GATE 4 (traversal):
// a present-but-INVALID .mrc-id (tampered ../x, /abs, NUL, non-UUID) is REJECTED and REGENERATED — an invalid id
// is never legitimate, so it never becomes a path segment. Returns a validated UUID.
export function repoStoreId(repoPath) {
  const idPath = repoIdFile(repoPath)
  const existing = tryReadTrim(idPath)
  if (existing && REPO_ID_RE.test(existing)) return existing            // valid → use it (memory travels)
  mkdirSync(dirname(idPath), { recursive: true })
  const fresh = randomUUID()
  if (existing == null) {                                               // MISSING → race-safe O_EXCL mint
    try { const fd = openSync(idPath, 'wx'); writeSync(fd, fresh + '\n'); closeSync(fd); return fresh }
    catch (e) {
      if (e && e.code === 'EEXIST') { const won = tryReadTrim(idPath); if (won && REPO_ID_RE.test(won)) return won }
      throw e
    }
  }
  // PRESENT but INVALID (tampered/corrupt) → regenerate atomically, then re-read to converge with any concurrent
  // regenerate. NO-SILENT-FAILURE: a silently-replaced id means the user's memory just re-pointed to a fresh slice
  // (their history appears to "vanish") — surface it once so it's diagnosable, not a mystery.
  try { console.error(`  ! mrc: repo store id (.mrc-id) was invalid ${JSON.stringify(existing).slice(0, 40)} — regenerating (prior memory under the old id is orphaned, not lost)`) } catch {}
  const tmp = `${idPath}.${process.pid}.tmp`
  writeFileSync(tmp, fresh + '\n'); renameSync(tmp, idPath)
  const after = tryReadTrim(idPath)
  return (after && REPO_ID_RE.test(after)) ? after : fresh
}

// The slice-key builders — each a known-safe segment by construction.
const memberSliceKey = (org, handle) => `m-${memberSessionId(String(org), String(handle))}`   // team member/worker: the ONE \0-separated injective member hash; .mrc-id NEVER read
// adversary: SAME (repo,slot) boundary as its -pierre-N config vol. RESERVED isolated-adversary store (the "option-a"
// walled slice). UNREACHABLE in production BY DESIGN, not by accident (Pierre t7): the storeActive IDENTITY gate
// (mrc.js — `!(cagedAdversary || resumeIsAdversary)`) denies EVERY adversary a /mrc mount at all (the chosen "option-b").
// Kept because branch 1 below is the lattice's UNTRUSTED-FIRST second layer: if that mrc.js gate ever regresses, an
// adversary still isolates HERE (an adv- slice), never the user's repoId. Wire an adv- /mrc mount to make it live.
const advSliceKey = (repoPath, slot) => `adv-${md5(String(repoPath))}-${Number(slot) || 0}`
const isoSliceKey = (sessionId) => `iso-${sha(String(sessionId || randomUUID()))}`             // isolated per-session floor — never repoId

// THE keying lattice — isolated-by-default, repoId-by-GRANT, UNTRUSTED-FIRST. `repoStoreId` is injected for tests
// (so "a member never reads .mrc-id" is a test assertion, not a hope). Order: adversary → member → grant → floor.
// BOUNDARY COERCION with DIRECTIONAL fail-safety — the invariant: LENIENT toward ISOLATION, STRICT toward GRANTS.
// `adversary` is coerced LENIENT (any truthy → isolate, the safe direction). But EVERY signal that feeds the
// repoId GRANT (the user's own memory, the sensitive resource) is STRICT `=== true/false`: `isMember` (so an
// undefined can't satisfy `isMember === false`) AND `isSolo` (so a MEMBER carrying a STRAY truthy isSolo can't be
// kicked out of its member branch and fall into the repoId grant — a GATE-1 leak). A real solo sets isSolo to a
// boolean true from resolveMemberNorm's tested flag, so strict never denies a genuine solo; it only refuses a
// stray truthy, which safely falls back to the member branch.
export function sliceKeyFor(ctx, { repoStoreId: getId = repoStoreId } = {}) {
  const c = ctx || {}
  const adversary = !!c.adversary                       // LENIENT → any truthy adversary signal isolates (safe direction)
  const isSolo = c.isSolo === true                      // STRICT → a grant-signal; a stray truthy on a member must NOT grab repoId (GATE 1)
  const { adversarySlot, org, handle, repoPath, sessionId } = c
  if (adversary) return advSliceKey(repoPath, adversarySlot)                        // 1. UNTRUSTED FIRST — never repoId, never a team slice
  if (c.isMember === true && !isSolo) return memberSliceKey(org, handle)            // 2. real team member/worker — .mrc-id never read
  if (isSolo || (c.isMember === false && !adversary)) return getId(repoPath)        // 3. GRANT: solo / clean-plain → the user's own memory
  // 4. FLOOR — isolated, never repoId. Reaching it means a caller failed to set a CLEAR signal, so a session that
  // should be repoId or (org,handle) would silently land in a fresh isolated slice (memory "resets"). NO-SILENT-
  // FAILURE: warn so a routing bug is loud, not a mystery memory-reset. (This is a fail-safe; expected only if a
  // caller genuinely has no member/solo/adversary signal — which shouldn't happen once routing is wired.)
  try { console.error(`  ! mrc: session reached the isolated store floor (no clear member/solo/adversary signal) — memory will not persist to a repo/team slice; a routing bug if unexpected.`) } catch {}
  return isoSliceKey(sessionId)
}

// THE chokepoint: the absolute store dir for a session. Every Class-1 memory derivation routes through this — and
// ONLY Class-1 (Class-2 .env/config reads stay repo-relative, asserted by their own tests; they never call this).
export function mrcStoreDir(ctx, opts) { return sliceDir(sliceKeyFor(ctx, opts)) }

// #5 GATE-3 EPHEMERAL fork: a per-launch side slice for a concurrent opener the host detected is already live (a
// cp'd repo opened twice, or the same repo opened twice). EPHEMERAL by construction — a fresh random key NEVER
// derived from .mrc-id, so it exists for THIS launch only and the repo re-adopts its normal slice on the next solo
// open ("memory travels on cp" preserved; a persisted fork rewriting .mrc-id would silently reverse that). The
// `fork-` prefix makes the side slice greppable/nameable so the concurrent session's history is findable.
export const forkSliceKey = () => `fork-${randomUUID()}`
export function forkSliceDir() { return sliceDir(forkSliceKey()) }

// Orchestrator: the effective session-store dir for a launch or a subcommand. LEGACY → the repo's .mrc unchanged.
// STORE-MODE → the slice (mrcStoreDir(ctx)), migrating legacy→slice FIRST (before any read/resolve) when `migrate`:
// plain/solo carry their whole repo/.mrc in (`exclude`-scoped, minus @members, keeping PICKABLE⟺MIGRATED with the
// picker); a MEMBER carries ONLY its own transcript in (`include`-scoped) so it RESUMES rather than re-starting. An
// ADVERSARY is never store-mode (gated fully legacy upstream) so its pierre-vol history is untouched. One place
// launch/subcommand → session-store dir.
export function sessionStoreDir({ storeMode, ctx, legacyDir, migrate = false, exclude = null, include = null, isLive = null }) {
  if (!storeMode) return legacyDir
  const slice = mrcStoreDir(ctx)
  // #5 BUG-1: repair clobbered mtimes right after migrate, before any read. Finding-1: `isLive` (injected docker
  // probe — mrc-store has no docker dep) gates the normalize WRITE off when a live container holds the slice, so a
  // read-only `mrc pick`/`ls` while another session runs lists the (possibly-still-clobbered) slice but never
  // mtime-races the live agent; the repair lands on a later idle launch instead.
  if (migrate) migrateAndNormalize(legacyDir, slice, { exclude, include, skipWrite: isLive ? !!isLive(slice) : false })
  return slice
}

// Build the slice ctx from a launch's resolved state. EVERY signal is coerced EXPLICIT so the lattice never hits
// its floor by accident (an unset field → the wrong grant/floor): `adversary` from the HOST-set caged flag (never
// a container-influenceable field), `isMember` = a REAL team member (a memberCtx present AND not solo — solo is
// mechanically a member but must key on repoId), `isSolo` from config.solo, and the (org,handle)/slot that key the
// isolated slices. Callers pass their launch state; this is the ONE place launch signals → a slice ctx.
// #5 MIGRATION: bring a repo's existing LEGACY .mrc transcripts + session-names into its store slice, ONCE, on the
// first store-capable launch. NON-DESTRUCTIVE (COPY, leave the legacy originals intact). CAUTION (Pierre t5): this
// makes the pick/resume bridge symmetric ONLY for PRE-MIGRATION content — a de-activation launch reading legacy still
// finds anything that existed BEFORE the first store launch, because the copy never removed it. It is NOT symmetric
// for STORE-ERA-BORN conversations (created in the slice, never in legacy): migration is one-directional (legacy→slice,
// NO reverse bridge), so on a de-activation (image loses the capability label) those live ONLY in the slice and a
// legacy launch cannot see them. That reachability gap must be SURFACED, not silent — a legacy launch that finds a
// populated slice for this repo's .mrc-id emits a loud notice (see noticePopulatedSliceOnLegacy). Copy-if-absent PER FILE
// (kill-safe: a Ctrl-C'd migration re-enters and only copies what's missing, never a torn overwrite — a partial
// copy stays a .tmp, the real dst appears only on the atomic rename) and the completion SENTINEL is written LAST,
// atomically (temp→rename), so an INTERRUPTED migration leaves NO sentinel → it re-runs cleanly.
// TWO scopes: `exclude` (plain/solo — the roster's memberSessionId set) is SKIPPED so PICKABLE⟺MIGRATED holds (the
// picker excludes the SAME set, nothing pickable is left un-migrated, no @member transcript bleeds into the plain
// slice); `include` (a MEMBER launch — its OWN memberSessionId) copies ONLY that transcript into its (org,handle)
// slice, and NOT the shared session-names (which would leak sibling names), so a member RESUMES on the first store
// launch rather than re-starting. exclude and include are mutually exclusive (a caller passes one); include wins.
// v2 (Pierre): the flat .jsonl-only copy SILENTLY DROPPED every SUBDIR — memory/, session-summaries/, <uuid>/subagents.
// Bump the sentinel so a v1-migrated slice re-runs ONCE and recovers them (leaf copy-if-absent skips the transcripts
// already there). v1's own name stays in the deny-set so it isn't itself migrated.
const MIGRATED_SENTINEL = '.mrc-store-migrated-v2'
// A session id: a plain uuid OR a memberSessionId (sha1, 40 hex). Keys BOTH a `<id>.jsonl` transcript and a `<id>/`
// subagent subtree, so exclude/include (which are id-sets) apply to both.
const SESSION_ID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{40})$/
// KNOWN NON-MEMORY — skipped SILENTLY (not logged): Class-2 repo secrets/config (.env is the STRICT per-repo Telegram
// token, cf. config.js; .mrc-id, video-analysis.json), Class-3 host/persona (team.runtime.json, teams/), the
// MACHINE-GLOBAL adversary-CONTAINMENT record store (session-meta — HARD deny: it carries rec.adversary/repoPath that
// decides caging and a slice is container-readable; a repo-side copy is stale legacy anyway), diagnostic logs, and the
// store's own control files. Everything NOT allowed AND not here → LOUD-logged (never silently dropped, never swept).
const KNOWN_NON_MEMORY = new Set(['.env', '.mrc-id', 'video-analysis.json', 'team.runtime.json', 'teams', 'session-meta',
  'launch.log', 'tool-misses.log'])
// store CONTROL files — never memory: the sentinels, the mtime marker, the migrate log, the write-probe, the O_EXCL /
// flock locks. `.mrc-*` covers them all (+ future ones), so a store artifact never gets logged as "unrecognized".
const isStoreInternal = (f) => f.startsWith('.mrc-') || f.startsWith('.oxcl') || f.endsWith('.lock')   // sentinels/markers/migrate-log/probe + the per-uuid + whole-slice flock files

// The SINGLE enumeration of what a migration copies — shared by migrateToStore (to COPY) AND #001.verify (to BYTE-CHECK
// the same set), so the two can NEVER drift (Pierre: a verify whose allow-list drifts from up()'s certifies its own blind
// spot). legacyDir is ATTACKER-INFLUENCEABLE and feeds a MOUNT → lstat EVERY entry and REFUSE any symlink (a symlinked
// memory/→/etc or →another slice = traversal/exfil). Recursive into memory/ + session-summaries/ + <uuid>/ dirs; the
// @member uuid-exclude applies at EVERY uuid-keyed leaf (a nested session-summaries/<memberUuid>.md must not land in a
// plain slice). Returns { manifest: relative paths of in-scope memory LEAVES (what SHOULD be in the slice),
// refused: {path, reason:'symlink'|'unrecognized'} that up() deliberately did NOT migrate (verify must NOT flag these) }.
export function planMigration(legacyDir, { exclude = null, include = null } = {}) {
  const manifest = [], refused = []
  const inScope = (uuid) => include ? include.has(uuid) : !(exclude && exclude.has(uuid))
  const excludedLeaf = (name) => exclude && exclude.size && exclude.has(name.replace(/\.[^.]+$/, ''))
  const walk = (rel) => {
    let ents; try { ents = readdirSync(join(legacyDir, rel), { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name
      let lst; try { lst = lstatSync(join(legacyDir, r)) } catch { continue }
      if (lst.isSymbolicLink()) { refused.push({ path: r, reason: 'symlink' }); continue }
      if (lst.isDirectory()) walk(r)
      else if (lst.isFile() && !excludedLeaf(e.name)) manifest.push(r)
    }
  }
  let ents; try { ents = readdirSync(legacyDir, { withFileTypes: true }) } catch { return { manifest, refused } }
  for (const ent of ents) {
    const f = ent.name
    if (KNOWN_NON_MEMORY.has(f) || isStoreInternal(f)) continue                          // known non-memory → silent skip
    let lst; try { lst = lstatSync(join(legacyDir, f)) } catch { continue }
    if (lst.isSymbolicLink()) { refused.push({ path: f, reason: 'symlink' }); continue }
    const isTranscript = lst.isFile() && f.endsWith('.jsonl')
    const uuid = isTranscript ? f.slice(0, -6) : f
    const isSessionDir = lst.isDirectory() && SESSION_ID_RE.test(f)                      // <uuid>/ subagent subtree
    const isSharedFile = lst.isFile() && (f === 'session-names' || f === 'names-migrated' || f === 'security-migrated')
    const isSharedDir = lst.isDirectory() && (f === 'memory' || f === 'session-summaries')
    if (isTranscript || isSessionDir) { if (!inScope(uuid)) continue; if (isSessionDir) walk(f); else manifest.push(f) }
    else if (isSharedFile) { if (!include) manifest.push(f) }                            // shared → PLAIN only (a member is silently excluded)
    else if (isSharedDir) { if (!include) walk(f) }
    else refused.push({ path: f, reason: 'unrecognized' })                               // recognized-shape-none → LOUD-log at copy time
  }
  return { manifest, refused }
}

export function migrateToStore(legacyDir, sliceDir, { exclude = null, include = null } = {}) {
  const plan = planMigration(legacyDir, { exclude, include })                            // the ONE enumeration (verify shares it → can't drift)
  const sentinel = join(sliceDir, MIGRATED_SENTINEL)
  if (existsSync(sentinel)) return { migrated: 0, skipped: 0, alreadyDone: true, manifest: plan.manifest, refused: plan.refused }
  mkdirSync(sliceDir, { recursive: true })
  // LOUD-log: stderr AND a slice-local .mrc-migrate.log (store-internal → never re-migrated) so a genuinely-dropped new
  // class stays diagnosable post-hoc even though stderr scrolls under the TUI.
  const logFile = join(sliceDir, '.mrc-migrate.log')
  const log = (m) => { try { console.error(`  ! mrc migrate: ${m}`) } catch {}; try { appendFileSync(logFile, `${m}\n`) } catch {} }
  for (const r of plan.refused) log(r.reason === 'symlink'
    ? `refused a symlink at ${r.path} (not migrated)`
    : `not migrating "${r.path}" — unrecognized store item; if this is memory it must be added to the allow-list`)
  let migrated = 0, skipped = 0
  for (const rel of plan.manifest) {
    const dst = join(sliceDir, rel)
    if (existsSync(dst)) { skipped++; continue }                                         // leaf copy-if-absent — never clobber newer store data
    try {
      const src = join(legacyDir, rel)
      const lst = lstatSync(src)                                                         // re-lstat: TOCTOU — a symlink swapped in AFTER planMigration must still be refused (copyFileSync follows links)
      if (lst.isSymbolicLink()) { log(`refused a symlink at ${rel} (swapped in mid-migration — not migrated)`); plan.refused.push({ path: rel, reason: 'symlink-swapped' }); continue }   // mark it so verify attributes the miss to a swap (slice changed underfoot), NOT a divergent sharer
      mkdirSync(dirname(dst), { recursive: true })                                       // manifest leaves under memory/ etc. need their parent
      const tmp = `${dst}.${process.pid}.mig.tmp`
      copyFileSync(src, tmp); renameSync(tmp, dst)                                        // atomic per-file
      try { utimesSync(dst, lst.atime, lst.mtime) } catch {}                             // preserve SOURCE mtime (copyFileSync stamps NOW → recency collapse)
      migrated++
    } catch { /* raced/vanished → skip; no sentinel yet on a throw means a re-run retries */ }
  }
  try { const stmp = `${sentinel}.${process.pid}.tmp`; writeFileSync(stmp, ''); renameSync(stmp, sentinel) } catch {}   // SENTINEL LAST + atomic → interrupt before here = clean re-entry
  return { migrated, skipped, manifest: plan.manifest, refused: plan.refused }
}

const MTIME_SENTINEL = '.mrc-mtimes-normalized'
// #5 BUG-1 REPAIR: an ALREADY-migrated slice (pre-fix) has clobbered mtimes (all = the copy time) AND the migrate
// sentinel set, so migrateToStore no-ops and Fix-B (preserve-on-copy) never heals it. Repair ONCE: set each slice
// transcript's mtime to its TRUE recency = MAX(legacy-source-mtime if the non-destructive original still exists,
// the slice file's OWN last in-transcript timestamp). Two safety properties: (1) it NEVER reads the CURRENT
// (clobbered = NOW) slice mtime, so the bug can't launder itself through the repair; (2) MAX takes the newer REAL
// signal, so a session opened in-slice AFTER migration (stale legacy mtime, but recent slice-lastTs because its new
// turns are IN the slice transcript) is NOT demoted. Own sentinel → one-time; order-independent with migrate.
export function normalizeSliceMtimes(sliceDir, legacyDir) {
  const marker = join(sliceDir, MTIME_SENTINEL)
  if (existsSync(marker)) return { normalized: 0, alreadyDone: true }
  let files
  try { files = readdirSync(sliceDir).filter(f => f.endsWith('.jsonl')) } catch { return { normalized: 0, failed: true } }   // couldn't even list → DON'T stamp, retry next time
  let normalized = 0, failed = false
  for (const f of files) {
    const dst = join(sliceDir, f)
    let ms = 0
    try { ms = statSync(join(legacyDir, f)).mtimeMs } catch {}                 // the intact legacy source's mtime, if it survives (non-destructive migration keeps it)
    try {                                                                      // the slice file's OWN last in-transcript ts — authoritative content recency, immune to any mtime pollution
      let lastTs = ''
      for (const line of readFileSync(dst, 'utf8').split('\n')) { if (!line) continue; try { const o = JSON.parse(line); if (o.timestamp) lastTs = o.timestamp } catch {} }
      const tsMs = Date.parse(lastTs) || 0
      // #5 SECURITY (Pierre, turn 3): the in-transcript `timestamp` is ATTACKER-CONTROLLED file content — a hostile
      // clone can force-commit a `<uuid>.jsonl` stamped "2099-..." so this derivation makes it out-sort every real
      // conversation and DETERMINISTICALLY win auto-continue (mrc.js sessions[0]) → first-launch injection. A genuine
      // transcript's last ts is ALWAYS ≤ now; only a forgery is in the future. Clamp to now: a future-stamped file
      // can't inflate its recency (it falls back to the legacy source mtime). Closes the amplifier #5's own file added;
      // the migrate-copies-hostile-content root cause is the separate .mrc-at-entry chokepoint.
      if (tsMs > ms && tsMs <= Date.now()) ms = tsMs
    } catch {}
    if (ms > 0) { try { const d = new Date(ms); utimesSync(dst, d, d); normalized++ } catch { failed = true } }   // a utimes that THREW (transient EPERM/rotation) is retry-worthy; ms=0 (no derivable recency) is unhelpable, NOT a failure
  }
  // #5 Finding-2 (Pierre): stamp the sentinel ONLY when nothing FAILED. normalize's inputs (legacy-mtime, in-
  // transcript ts) are stable → re-running is idempotent + convergent, so retry is free; but a sentinel written over
  // a run where every utimes failed would freeze the slice clobbered FOREVER, silently — the no-silent-failure sin.
  if (!failed) { try { const tmp = `${marker}.${process.pid}.tmp`; writeFileSync(tmp, ''); renameSync(tmp, marker) } catch {} }
  return { normalized, failed }
}

// #5: migrate THEN repair mtimes — the ONE unit every store-dir consumer must run so no read (host getSessions,
// resolveSessionId, OR the container's on-disk `claude --continue`) ever sees a clobbered recency. Called from BOTH
// sessionStoreDir (subcommands + the pre-build auto-resume) AND the launch (before /mrc mounts + before resolveSessionId).
export function migrateAndNormalize(legacyDir, sliceDir, opts = {}) {
  // #5 Finding-1 (Pierre) + v2: BOTH steps WRITE the slice. The v2 sentinel bump means a v1 slice RE-migrates (subdir
  // recovery) — no longer the no-op it was — and normalize rewrites mtimes. Neither may run while a live container
  // holds the slice (it would race the live agent). `skipWrite` (set from the caller's liveness probe: live OR
  // undetermined) skips the whole write; recovery + repair defer to a later idle launch.
  if (opts.skipWrite) return { skipped: true }
  const r = migrateToStore(legacyDir, sliceDir, opts)
  normalizeSliceMtimes(sliceDir, legacyDir)
  return r
}

// #5 DE-ACTIVATION AMNESIA GUARD (Pierre t5). A LEGACY launch (store-mode INACTIVE — e.g. the image lost its
// capability label via a rebuild/rollback/STORE_SUPPORTED bump) on a repo that already has a populated store slice
// would SILENTLY show only the frozen migration-snapshot in repo/.mrc — hiding every store-era-BORN conversation,
// which lives ONLY in the slice (migration is one-directional; there is no reverse bridge). That is reachability-loss
// presenting as amnesia — the exact panic #5 exists to kill, self-inflicted by the "fail toward legacy" fallback. So
// SURFACE it: return a loud notice string the launcher logs. Read-only + fail-safe (any error → null → no notice, never
// a crash). `root` injectable for tests. Returns null when there's nothing to warn about (no .mrc-id / tampered id /
// no slice / empty slice).
export function noticePopulatedSliceOnLegacy(repoPath, { root = storeRoot(), extraSliceKeys = [] } = {}) {
  const count = (key) => {
    try {
      if (!key) return 0
      try { assertSafeSegment(key) } catch { return 0 }   // a tampered/invalid key maps to no legitimate slice
      const slice = join(root, key)
      if (!existsSync(slice)) return 0
      return readdirSync(slice).filter(f => f.endsWith('.jsonl')).length
    } catch { return 0 }
  }
  try {
    let repoId = null
    const idFile = repoIdFile(repoPath)
    if (existsSync(idFile)) { const id = readFileSync(idFile, 'utf8').trim(); try { assertSafeSegment(id); repoId = id } catch {} }
    const repoN = repoId ? count(repoId) : 0
    // Pierre t7: also count team-MEMBER stores (m-<hash> slices) — a repo that ran a team in store-mode strands those
    // too, and a repoId-only notice would silently under-report. The caller passes the roster's member slice keys.
    const memberN = extraSliceKeys.reduce((s, k) => s + count(k), 0)
    if (repoN + memberN === 0) return null
    const parts = []
    if (repoN) parts.push(`${repoN} conversation${repoN === 1 ? '' : 's'}`)
    if (memberN) parts.push(`${memberN} team-member conversation${memberN === 1 ? '' : 's'}`)
    return `${parts.join(' + ')} live in your host memory store (${root}) but THIS image is not store-capable — this legacy launch shows only the pre-migration snapshot in ${join(repoPath, '.mrc')}. Your store-era history is safe, just not visible here; rebuild a store-capable image to see it:  docker rmi mister-claude && mrc ${repoPath}`
  } catch { return null }
}

export function storeCtx({ solo, memberCtx, cagedAdversary, adversarySlot, repoPath, sessionId }) {
  return {
    adversary: cagedAdversary === true,
    adversarySlot,
    isMember: !!(memberCtx && solo !== true),
    isSolo: solo === true,
    org: memberCtx && memberCtx.org,
    handle: memberCtx && memberCtx.member && memberCtx.member.handle,
    repoPath,
    sessionId,
  }
}

// ── STORE-MODE CAPABILITY GATE ──────────────────────────────────────────────────────────────────────────────
// Store-mode (memory OUT of the repo, mounted at /mrc) is coupled to a CONTAINER change (container-setup retargets
// the project-store symlink to /mrc) that only lands in a rebuilt IMAGE. Routing the host reads to the store while
// an OLD container still writes to /workspace/.mrc = split-brain → the plain-session picker/resume breaks. So
// store-mode is a GRANT gated on image capability, DENY-UNLESS-PROVEN. The capability is a version constant that
// lives IN container-setup.js (bumping it changes that file's content → its COPY layer rebuilds → the mount-aware
// retarget code is GUARANTEED present whenever the label is), emitted as a Dockerfile LABEL — so "label capable" ⟺
// "new container-setup in the image" BY CONSTRUCTION (a free-floating label a commit could add independently would
// be a lie). FAIL TOWARD LEGACY: absent/malformed/older label → legacy (repo/.mrc, today's behavior), NEVER
// store-mode — a false-"capable" is the split-brain; a false-"not-capable" degrades safely (a mount-aware container
// that sees no /mrc stays legacy, consistent with the host's legacy reads). Same grant-vs-isolate invariant as the
// slice lattice: lenient toward the safe direction (legacy), strict toward the grant (store-mode).
export const STORE_CAPABILITY = 1                 // the CURRENT store-layout contract version — what a fresh image is built with; MUST equal container-setup.js's STORE_CAPABILITY (drift-tested)
const STORE_SUPPORTED = new Set([1])              // the versions THIS host code positively knows how to DRIVE (route + migrate). NOT a `>=` — an image NEWER than the host (a layout the host can't drive) must fall to legacy, not "probably fine".

// Pure: does this image's labels prove a store layout the host can DRIVE? store-mode ONLY if the label parses to an
// integer that is in the host's SUPPORTED SET. Absent / empty / malformed / older / UNKNOWN-HIGHER → legacy. Using a
// positive set (not `cap >= required`) closes the image-newer-than-host case: an unrecognized version is denied, so
// a future layout the host doesn't yet drive can never falsely grant store-mode. Deny-first by construction.
export function decideStoreMode(imageLabels) {
  const cap = Number(imageLabels && imageLabels['mrc.store.capability'])
  if (Number.isInteger(cap) && STORE_SUPPORTED.has(cap)) return { storeMode: true, cap }
  return { storeMode: false, cap: Number.isFinite(cap) ? cap : 0 }
}

// Decide store-mode for the EXACT image that will RUN. `imageId` MUST be a resolved image ID, not a tag — a tag can
// retag between inspect and run (Hazard C), so the caller resolves the tag→id ONCE and RUNS THAT ID (`docker run
// <id>`, never the tag), so inspect and run are the same image by construction. `inspect(imageId) → labels` is
// injected (tests / mrc.js's docker shell-out). ANY failure → legacy, WITH a no-silent-failure log (couldn't
// confirm capability ≠ silently reshaping the user's memory layout).
export function resolveStoreMode(imageId, inspect) {
  if (typeof inspect !== 'function') return { storeMode: false, cap: 0, reason: 'no inspector → legacy' }   // programming/test path — no log
  if (!imageId) {   // a docker hiccup at the PIN (imageIdOf returned '') — log for no-silent-failure PARITY with the inspect-failure below
    try { console.error(`  ! mrc: could not pin an image id (docker hiccup?) — store-mode disabled, using LEGACY memory layout (repo/.mrc). Safe fallback.`) } catch {}
    return { storeMode: false, cap: 0, reason: 'no pinned image id → legacy' }
  }
  let labels
  try { labels = inspect(imageId) }
  catch (e) {
    try { console.error(`  ! mrc: could not confirm store capability (image inspect failed: ${e && e.message}) — using LEGACY memory layout (repo/.mrc). Safe fallback.`) } catch {}
    return { storeMode: false, cap: 0, reason: 'image inspect failed → legacy' }
  }
  const d = decideStoreMode(labels || {})
  return { ...d, reason: d.storeMode ? `store-mode (image capability ${d.cap} ∈ supported)` : `legacy (image capability ${d.cap} not in host-supported set)` }
}
