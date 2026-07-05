// mount-guard.js (#49 multi-repo floor) — realpath-canonical containment for every repo-relative path the
// launcher MOUNTS or WRITES. Poured FIRST, because docker resolves symlinks at mount and Node follows them at
// write, while the launcher's checks compared path STRINGS: resolveTerritory rejected textual `..` only, and
// realpath was used NOWHERE in the mount chain (only solo.js, for identity). So two LIVE, pre-existing escapes
// existed before the multi-repo work:
//   • MOUNT escape: a session with rw in its own repo plants `evil -> /etc`, names `territory:'evil'` (not
//     `..`, so it passed), and docker mounts /etc into the container.
//   • WRITE escape: plant `.mrc -> /etc`, and the persona writer's writeFileSync(join(repo,'.mrc','teams',…))
//     FOLLOWS the link, writing into /etc/teams/… on the HOST as the host user.
// The floor: realpath every repo-relative path, confirm the RESOLVED path is inside the RESOLVED repo, and use
// the resolved path. (Named residual — Pierre: this closes the STATIC symlink; a summoner racing its OWN
// writable source between check and mount is a dynamic TOCTOU that resolved-p can't close alone — caged
// members are covered by the egress seal, uncaged cross-repo members need the source out of the racer's reach.)
import { realpathSync } from 'node:fs'
import { join, sep } from 'node:path'

// Is `p` the repo root or strictly inside it? `+ sep` closes the /repo vs /repo-evil prefix collision;
// `=== repoReal` catches the root itself. BOTH args must already be resolved realpaths.
function within(repoReal, p) {
  return p === repoReal || p.startsWith(repoReal + sep)
}

// Realpath the repo FEED (never trust the caller to have canonicalized it — mrc.js passes `resolve()`), and
// REFUSE the one unambiguous pathological root IN the primitive: a repo that resolves to the filesystem root.
// `within('/', '/')` would otherwise ACCEPT mounting root itself — so a summoner's repo that (symlink or not)
// resolves to '/' would mount all of '/' UNLESS an upstream broad-guard remembered to reject it. That's the
// on-unless-someone-forgets pattern; fail toward safe HERE. Fuzzier roots (a home dir, a project-root's
// parent) stay POLICY for the authorized-set/implicit-grant layer — only the unambiguous '/' is refused here.
function resolveRepoRoot(repo) {
  const repoReal = realpathSync(String(repo))
  if (repoReal === sep) throw new Error(`refusing a repo that resolves to the filesystem root (${repoReal}) — a repo at "/" is never a legitimate mount root`)
  return repoReal
}

// Resolve `subpath` (repo-relative) against the repo, realpath BOTH — NEVER trust the caller to have
// canonicalized the repo root (mrc.js passes `resolve()`, not `realpath()`; a symlinked root would defeat
// containment before any subpath check). REJECT unless the resolved target is within the resolved repo.
// Returns the RESOLVED absolute path — MOUNT THAT (so what you checked is what mounts, closing the
// check-reads-link-vs-mount-reads-link race). For a path that EXISTS (a mount source); throws on a missing path.
export function canonicalMountSource(repo, subpath = '.') {
  const repoReal = resolveRepoRoot(repo)                            // realpath the FEED + refuse a '/'-repo
  const target = realpathSync(join(repoReal, String(subpath)))     // NOTE: THROWS ENOENT on a missing source — a conscious, fail-closed behavior change from docker's root-owned auto-create (a member should not mount a territory that isn't in the tree)
  if (!within(repoReal, target)) {
    throw new Error(`mount source "${subpath}" escapes the repo — resolves to ${target}, outside ${repoReal}`)
  }
  return target
}

// Like canonicalMountSource, but for a WRITE target whose LEAF may not exist yet (writePersonaFile CREATES
// `teams/` and the `.persona` leaf, so realpath'ing the whole path would ENOENT — and a naive catch-and-skip
// would skip the guard on exactly the paths being created). A symlink can only escape through a link that
// ALREADY EXISTS, and that lives in the deepest existing ANCESTOR — so resolve down part-by-part to the
// deepest existing ancestor (resolving any symlink in the chain), confirm IT is within the repo, then the
// not-yet-existent tail is appended to that resolved ancestor. Returns the canonical write path.
//
// TOCTOU WARNING (Pierre — the write window is WIDER than the mount's and mkdirSync HIDES the swap): a mount
// is one syscall after the check; a write is TWO (mkdirSync(recursive) then writeFileSync), and
// mkdirSync(recursive:true) on a tail that already exists AS A SYMLINK-TO-A-DIR succeeds SILENTLY (it neither
// recreates nor rejects it). So a summoner planting `.mrc/teams -> /etc` between this return and the caller's
// mkdir gets the persona written into /etc with NO error. Static containment is closed here; the dynamic swap
// needs the write source out of the racer's reach for the launch window (the named residual, enforced in the
// wiring), and the write path warrants the louder warning because mkdirSync actively masks the failure.
export function canonicalWriteTarget(repo, subpath) {
  const repoReal = resolveRepoRoot(repo)
  const parts = String(subpath).split('/').filter((s) => s && s !== '.')
  let base = repoReal
  let i = 0
  for (; i < parts.length; i++) {
    let next
    try { next = realpathSync(join(base, parts[i])) } catch { break }   // this part doesn't exist → `base` is the deepest existing ancestor
    base = next                                                          // resolves any symlink in `parts[i]` (escape shows up in `base`)
  }
  if (!within(repoReal, base)) {
    throw new Error(`write target "${subpath}" escapes the repo — deepest existing ancestor resolves to ${base}, outside ${repoReal}`)
  }
  const tail = parts.slice(i)
  return tail.length ? join(base, ...tail) : base
}
