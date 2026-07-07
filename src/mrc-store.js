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
import { openSync, writeSync, closeSync, readFileSync, writeFileSync, mkdirSync, realpathSync, renameSync, lstatSync, copyFileSync, readdirSync, existsSync } from 'node:fs'
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
const advSliceKey = (repoPath, slot) => `adv-${md5(String(repoPath))}-${Number(slot) || 0}`    // adversary: SAME (repo,slot) boundary as its -pierre-N config vol
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
export function sessionStoreDir({ storeMode, ctx, legacyDir, migrate = false, exclude = null, include = null }) {
  if (!storeMode) return legacyDir
  const slice = mrcStoreDir(ctx)
  if (migrate) migrateToStore(legacyDir, slice, { exclude, include })
  return slice
}

// Build the slice ctx from a launch's resolved state. EVERY signal is coerced EXPLICIT so the lattice never hits
// its floor by accident (an unset field → the wrong grant/floor): `adversary` from the HOST-set caged flag (never
// a container-influenceable field), `isMember` = a REAL team member (a memberCtx present AND not solo — solo is
// mechanically a member but must key on repoId), `isSolo` from config.solo, and the (org,handle)/slot that key the
// isolated slices. Callers pass their launch state; this is the ONE place launch signals → a slice ctx.
// #5 MIGRATION: bring a repo's existing LEGACY .mrc transcripts + session-names into its store slice, ONCE, on the
// first store-capable launch. NON-DESTRUCTIVE (COPY, leave the legacy originals intact) — that's what makes the
// pick/resume bridge SYMMETRIC across BOTH the activation AND the de-activation rebuild boundary (a de-activation
// launch reading legacy still finds the session, because the copy never removed it). Copy-if-absent PER FILE
// (kill-safe: a Ctrl-C'd migration re-enters and only copies what's missing, never a torn overwrite — a partial
// copy stays a .tmp, the real dst appears only on the atomic rename) and the completion SENTINEL is written LAST,
// atomically (temp→rename), so an INTERRUPTED migration leaves NO sentinel → it re-runs cleanly.
// TWO scopes: `exclude` (plain/solo — the roster's memberSessionId set) is SKIPPED so PICKABLE⟺MIGRATED holds (the
// picker excludes the SAME set, nothing pickable is left un-migrated, no @member transcript bleeds into the plain
// slice); `include` (a MEMBER launch — its OWN memberSessionId) copies ONLY that transcript into its (org,handle)
// slice, and NOT the shared session-names (which would leak sibling names), so a member RESUMES on the first store
// launch rather than re-starting. exclude and include are mutually exclusive (a caller passes one); include wins.
const MIGRATED_SENTINEL = '.mrc-store-migrated'
export function migrateToStore(legacyDir, sliceDir, { exclude = null, include = null } = {}) {
  const sentinel = join(sliceDir, MIGRATED_SENTINEL)
  if (existsSync(sentinel)) return { migrated: 0, skipped: 0, alreadyDone: true }
  mkdirSync(sliceDir, { recursive: true })
  let migrated = 0, skipped = 0
  let entries
  try { entries = readdirSync(legacyDir) } catch { entries = [] }   // no legacy dir → nothing to copy (still stamp the sentinel so we don't re-scan every launch)
  for (const f of entries) {
    const isTranscript = f.endsWith('.jsonl')
    if (!isTranscript && f !== 'session-names') continue                                 // ONLY memory (Class 1): transcripts + names. NOT .env/config (Class 2 stays repo-relative), never .mrc-id.
    if (include) {                                                                       // MEMBER scope: only its OWN transcript, never session-names (no sibling-name leak into a member slice)
      if (!isTranscript || !include.has(f.slice(0, -6))) { skipped++; continue }
    } else if (isTranscript && exclude && exclude.has(f.slice(0, -6))) { skipped++; continue }   // -6 = '.jsonl'; PLAIN scope: a @member transcript → excluded (its own slice), matching the picker
    const dst = join(sliceDir, f)
    if (existsSync(dst)) { skipped++; continue }                                          // copy-if-absent: idempotent + never clobber newer store data with older repo data
    try {
      const tmp = `${dst}.${process.pid}.mig.tmp`
      copyFileSync(join(legacyDir, f), tmp)
      renameSync(tmp, dst)                                                                // atomic per-file — a partial copy is a .tmp, the dst appears whole or not at all
      migrated++
    } catch { /* a file that raced/vanished → skip; without a sentinel a re-run retries it */ }
  }
  try { const stmp = `${sentinel}.${process.pid}.tmp`; writeFileSync(stmp, ''); renameSync(stmp, sentinel) } catch {}   // SENTINEL LAST + atomic → an interrupt before here = no sentinel = clean re-entry
  return { migrated, skipped }
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
