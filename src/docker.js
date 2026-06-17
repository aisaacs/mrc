import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { mkdirSync, statSync, rmSync, readdirSync, writeFileSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dbg } from './output.js'
import { IMAGE_NAME } from './constants.js'

/** Build the Docker image if needed. */
export function buildImage(scriptDir, { rebuild, verbose, uid, gid }) {
  const buildFlags = ['-q', '--build-arg', `USER_UID=${uid}`, '--build-arg', `USER_GID=${gid}`]
  const stdio = verbose ? 'inherit' : 'pipe'

  let fullBuild = false
  if (rebuild) {
    try { execFileSync('docker', ['rmi', '-f', IMAGE_NAME], { stdio: 'ignore' }) } catch {}
    buildFlags.push('--no-cache'); fullBuild = true
  } else {
    try {
      execFileSync('docker', ['image', 'inspect', IMAGE_NAME], { stdio: 'ignore' })
    } catch {
      buildFlags.push('--no-cache'); fullBuild = true
    }
  }

  // A full build (no image yet, or --rebuild) is silent for minutes — say so, so the wait isn't
  // mistaken for a hang. A cached build is near-instant.
  console.log(fullBuild
    ? '  ◎ Mr. Radar is scanning the environment... (full image build — this takes a few minutes)'
    : '  ◎ Mr. Radar is scanning the environment...')

  try {
    execFileSync('docker', ['build', ...buildFlags, '-t', IMAGE_NAME, scriptDir], { stdio })
  } catch (e) {
    console.error('  ✗ Build failed. Docker output:')
    if (e.stderr) process.stderr.write(e.stderr)
    process.exit(1)
  }
  console.log('  ✓ Radar locked.')
}

/** Warn if the image is more than 4 days old. */
export function checkImageAge(repoPath) {
  try {
    const created = execFileSync('docker', ['image', 'inspect', '--format', '{{.Created}}', IMAGE_NAME], {
      encoding: 'utf8',
    }).trim()
    const ageDays = Math.floor((Date.now() - new Date(created).getTime()) / 86_400_000)
    if (ageDays >= 4) {
      console.log('')
      console.log(`  ⚠ Your Claude Code image is ${ageDays} days old. Auto-update is disabled in the container.`)
      console.log('    Rebuild to get the latest version:')
      console.log(`      mrc --rebuild ${repoPath}`)
      console.log('')
    }
  } catch {}
}

// A claim file holds the launching process's PID and is GC'd by PID-LIVENESS, not a wall-clock TTL. The GC
// reaps a claim ONLY when that PID is affirmatively DEAD (process.kill(pid,0) → ESRCH). A slept/frozen launcher
// is ALIVE (slept ≠ dead) → its claim is KEPT → its slot can't be reclaimed mid-launch. (A WALL-CLOCK TTL here
// was an orphan: a laptop sleep > TTL in the claim→mount window made a live launcher's claim "stale", a racer
// GC'd it + saw no mount yet → both took the slot → shared volume → silent logout.) The dead-branch is the ONLY
// branch that deletes, so it's the only one that can orphan: everything ambiguous — empty/half-written (the
// O_EXCL open→write gap) / non-integer PID / EPERM / alive — reads as KEEP. The asymmetry IS the safety: a kept
// stale claim is a needless login; a wrongly-reaped live claim is a logged-out session.
const ADV_CLAIM_BACKSTOP_MS = 172_800_000  // 48h: reclaim a PID-REUSE leak (a recycled PID reads alive forever) —
                                           // NOT the liveness signal. Err LONG: the backstop is a TIMED reap, and a
                                           // reap is the only branch that can orphan. A FROZEN launcher is alive-
                                           // but-mount-down (a laptop slept overnight > any short backstop), so a
                                           // short backstop reaps its LIVE claim → a racer reclaims the slot → the
                                           // orphan. A >48h freeze landing in the ~1-4s claim→mount window is fantasy;
                                           // the reuse-leak this reclaims is a benign needless-login, fine for days.
                                           // (Airtight-later: stamp the PID's START-TIME too → reap on dead OR
                                           // start-time-mismatch, no wall-clock backstop at all; costs a per-claim
                                           // /proc-or-ps read, not free cross-platform — so it's the later, not the now.)
const ADV_DOCKER_TIMEOUT_MS = 8_000  // hard-bound `docker ps`; on timeout it throws → fail closed (below).
const ADV_MAX_SLOTS = 256            // sanity cap so a persistent write error can't spin the claim loop forever.
// Both racing claimers derive this from the SAME repoPath → SAME md5 → SAME dir; lives under the mrc data dir.
const slotsDir = (sub, repoPath) => join(homedir(), '.local', 'share', 'mrc', sub, createHash('md5').update(repoPath).digest('hex').slice(0, 12))

// Shared claim step: GC dead claims (PID-liveness, see above), then take the lowest free slot via an ATOMIC
// O_EXCL create — the create IS the pick, so two concurrent claimers that both computed the same `used` set
// STILL can't land on the same slot (the kernel lets exactly one create it; the other gets EEXIST and walks on).
// EEXIST = taken (or a claim still bridging run→visible) → next slot; any OTHER write error
// (ENOSPC/EROFS/EACCES) is a lost signal → null (fail closed). A claim bridges the window until a just-launched
// container is visible to the next claimer's oracle, then is GC'd when its launcher process dies — so a frozen
// launcher's claim survives the freeze (no wall-clock lease to expire and re-open the slot under it).
function claimLowestFree(dir, used) {
  try { mkdirSync(dir, { recursive: true }) } catch {}
  const now = Date.now()
  try {
    for (const f of readdirSync(dir)) {
      if (!/^\d+$/.test(f)) continue            // only slot-numbered claim files
      const claim = join(dir, f)
      try {
        // Backstop FIRST: a very old claim is reclaimed regardless — a PID-reuse leak, or a long-running session
        // whose MOUNT already holds the slot (so dropping the redundant claim is safe).
        if (now - statSync(claim).mtimeMs >= ADV_CLAIM_BACKSTOP_MS) { rmSync(claim, { force: true }); continue }
        // Otherwise reap ONLY on AFFIRMATIVE death. Empty/half-written (O_EXCL open→write gap) / malformed → KEEP.
        const m = readFileSync(claim, 'utf8').match(/^(\d+)\n$/)   // require the trailing-newline SENTINEL: it's the
        if (!m) continue   // last byte written, so its presence proves the whole PID landed. A torn/empty/partial
                           // read (even on a network homedir with no single-write atomicity) lacks it → KEEP, never
                           // reap. (Don't rent atomicity from the FS when a byte makes it ours.)
        try { process.kill(parseInt(m[1], 10), 0) }                       // alive → no throw → KEEP; EPERM → KEEP
        catch (e) { if (e && e.code === 'ESRCH') rmSync(claim, { force: true }) }   // affirmatively dead → reap
      } catch {}
    }
  } catch {}
  // `sawClaim` = we walked past a slot whose claim file exists but whose container ISN'T in `used` — i.e. a
  // CONCURRENT sibling launch (claim on disk, mount not up yet) or a just-died launch's claim (<TTL, not yet
  // GC'd). The mount-oracle is blind to both; this EEXIST-walk is the only thing that sees them. The caller
  // folds it into "others present" so two simultaneous launches don't both --continue the shared transcript.
  // Over-counting the just-died case is the SAFE direction (forces a fresh conversation, not a shared one).
  let sawClaim = false
  for (let n = 1; n <= ADV_MAX_SLOTS; n++) {
    if (used.has(n)) continue
    // The claim BODY is our PID + a trailing-newline SENTINEL (for the PID-liveness GC). The O_EXCL create is
    // atomic (the slot is won at open); the body lands a syscall later — a concurrent GC reading that gap sees an
    // incomplete body (no sentinel) → KEEPS it, so the open→write gap can't orphan. (We DON'T temp-file-then-rename
    // to close the gap: rename clobbers, which would forfeit the O_EXCL atomic claim. Keep O_EXCL; make the gap safe.)
    try { writeFileSync(join(dir, String(n)), `${process.pid}\n`, { flag: 'wx' }); return { slot: n, sawClaim } }
    catch (e) { if (e && e.code === 'EEXIST') { sawClaim = true; continue }; return null }
  }
  return null   // exhausted the (absurd) cap → fail closed rather than spin
}

/** Lowest free "Pierre" slot for a repo's summoned-adversary pool (volumes `mrc-config-<hash>-pierre-N`).
 *  Race-free + fail-closed via claimLowestFree. "In use" = RUNNING adversaries (their mrc.adversary.slot label).
 *  The summoner is structurally safe regardless (disjoint volume names); this just keeps two concurrent Pierres
 *  off one slot (which would re-create the shared-refreshToken orphan between them). High-water-mark login: log
 *  into a slot once, then every future Pierre on it is free + immortal (its own independent grant). */
export function nextAdversarySlot(repoPath) {
  const used = new Set()
  try {
    const out = execFileSync('docker', [
      'ps', '--filter', 'label=mrc.adversary=1', '--filter', `label=mrc.repo=${repoPath}`,
      '--format', '{{.Label "mrc.adversary.slot"}}',
    ], { encoding: 'utf8', timeout: ADV_DOCKER_TIMEOUT_MS }).trim()
    for (const s of (out ? out.split('\n') : [])) { const n = parseInt(s, 10); if (n > 0) used.add(n) }
  } catch { return null }   // lost liveness oracle (docker down/timeout) → fail closed
  const r = claimLowestFree(slotsDir('pierre-slots', repoPath), used)
  return r ? r.slot : null   // adversaries always --new, so sawClaim/others is irrelevant here — just the slot
}

/** Lowest free REGULAR config-volume slot for a repo (`mrc-config-<hash>` = slot 1, `-N` = slot N). Replaces the
 *  old `getExistingCount()+1`, which (a) RACED — two concurrent launches read the same count and grabbed the same
 *  `-N` volume → two real sessions sharing one ~/.claude + its refresh token → a session logged out; (b) failed
 *  OPEN — a docker hiccup made the count 0 → a new session collided onto the live instance-1 volume; (c) mis-picked
 *  across gaps — count+1 could equal a still-running higher slot. Race-free + fail-closed via the same atomic
 *  claim. "In use" is derived from running containers' ACTUAL config-volume MOUNTS, not a label, so it counts
 *  sessions started BEFORE this change too (no migration gap). Adversary `-pierre-N` and codex `mrc-codex-*`
 *  mounts don't match the regular pattern, so they're naturally excluded. */
export function nextInstanceSlot(repoPath) {
  const hash = createHash('md5').update(repoPath).digest('hex').slice(0, 12)
  const base = `mrc-config-${hash}`
  const used = new Set()
  try {
    const ids = execFileSync('docker', ['ps', '-q', '--filter', 'label=mrc=1', '--filter', `label=mrc.repo=${repoPath}`], { encoding: 'utf8', timeout: ADV_DOCKER_TIMEOUT_MS }).trim()
    if (ids) {
      const names = execFileSync('docker', ['inspect', '--format', '{{range .Mounts}}{{.Name}} {{end}}', ...ids.split('\n')], { encoding: 'utf8', timeout: ADV_DOCKER_TIMEOUT_MS })
      const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-(\\d+)$')   // `-N` for N>=2 (not -pierre-, not -codex-)
      for (const t of names.split(/\s+/)) {
        if (!t) continue
        if (t === base) used.add(1)                                          // base (no suffix) = instance 1
        else { const m = t.match(re); if (m) used.add(parseInt(m[1], 10)) }
      }
    }
  } catch { return null }   // lost liveness oracle → fail closed (never collide a new session onto a live volume)
  const r = claimLowestFree(slotsDir('instance-slots', repoPath), used)
  if (!r) return null
  // `others` = OTHER regular sessions, used by the caller for the "N running" warning + the auto-new-session
  // force (so two sessions don't both `--continue` the shared /workspace/.mrc transcript and interleave it).
  // TWO fail-closed sources: |used| = sessions whose container is already RUNNING (mount visible), and
  // r.sawClaim = a CONCURRENT sibling whose claim is on disk but whose mount isn't up yet — the mount-oracle
  // can't see it, the EEXIST-walk did. Without the sawClaim term two simultaneous launches both read used={}
  // and both --continue. (NOT instanceId>1: a freed low slot + a live high slot gives slot 1 yet others ARE
  // running — |used| catches that. Over-count from a just-died <TTL claim is the safe direction.)
  return { slot: r.slot, others: used.size + (r.sawClaim ? 1 : 0) }
}

/** Compute a per-repo config volume name. */
export function volumeName(repoPath, instanceId) {
  const hash = createHash('md5').update(repoPath).digest('hex').slice(0, 12)
  return instanceId > 1 ? `mrc-config-${hash}-${instanceId}` : `mrc-config-${hash}`
}

/** Run the Docker container. Returns a promise that resolves to the exit code.
 *  Uses spawn (not execFileSync) so the event loop stays free for the
 *  clipboard and notification proxy servers running in the same process. */
export function runContainer({ repoPath, envFlags, volumes, claudeArgs, allowWeb, json, labels = [] }) {
  const args = [
    'run', '--rm', ...(json ? [] : ['-it']), '--init',
    '--cap-add=NET_ADMIN',
    '--cap-add=NET_RAW',
    '--add-host=host.docker.internal:host-gateway',
    '--label', 'mrc=1',
    '--label', `mrc.repo=${repoPath}`,
    '--label', `mrc.repo.name=${basename(repoPath)}`,
    '--label', `mrc.web=${!!allowWeb}`,
    ...labels,
    ...envFlags,
    ...volumes,
    IMAGE_NAME,
    ...(json ? ['--output-format', 'stream-json'] : []),
    ...claudeArgs,
  ]

  return new Promise(resolve => {
    const child = spawn('docker', args, { stdio: json ? ['pipe', 'pipe', 'pipe'] : 'inherit' })
    if (json) {
      child.stdout.pipe(process.stdout)
      child.stderr.pipe(process.stderr)
      process.stdin.pipe(child.stdin)
    }
    child.on('close', code => resolve(code ?? 1))
    child.on('error', () => resolve(1))
  })
}

/** Start a daemon container (detached). Returns the container ID. */
export function startDaemon({ repoPath, envFlags, volumes, allowWeb }) {
  const args = [
    'run', '-d', '--rm', '--init',
    '--cap-add=NET_ADMIN', '--cap-add=NET_RAW',
    '--add-host=host.docker.internal:host-gateway',
    '--label', 'mrc=1',
    '--label', `mrc.repo=${repoPath}`,
    '--label', `mrc.repo.name=${basename(repoPath)}`,
    '--label', `mrc.web=${!!allowWeb}`,
    '-e', 'MRC_DAEMON=1',
    ...envFlags, ...volumes,
    IMAGE_NAME,
  ]
  // LOAD-BEARING: `docker run -d` BLOCKS until the container is started and visible to `docker ps`. On the daemon
  // path mrc.js process.exit(0)s right after this returns, so its slot-claim's PID dies almost immediately — the
  // mount-oracle (nextInstanceSlot) MUST already see this container by then, or a racer's PID-liveness GC would
  // reap the dead-PID claim, see no mount, and reclaim the slot → a shared-volume orphan. The blocking gives that
  // handoff (claim → mount) zero gap. Do NOT switch this to spawn-detached-without-waiting without restoring the
  // overlap some other way (e.g. keep a holder process alive, or stamp the claim with the container id).
  return execFileSync('docker', args, { encoding: 'utf8' }).trim()
}

/** Run claude inside a running daemon container. Returns the spawned child process. */
export function execInContainer(containerId, claudeArgs) {
  return spawn('docker', [
    'exec', '-i', containerId,
    'claude', '--dangerously-skip-permissions', '--continue',
    '--output-format', 'stream-json',
    ...claudeArgs,
  ], { stdio: ['pipe', 'pipe', 'pipe'] })
}

/** Show active mrc containers (mrc status). */
export function showStatus() {
  // Set DOCKER_HOST for Colima if needed
  if (!process.env.DOCKER_HOST) {
    try {
      execFileSync('which', ['colima'], { stdio: 'ignore' })
      process.env.DOCKER_HOST = `unix://${join(process.env.HOME, '.colima/default/docker.sock')}`
    } catch {}
  }

  // Ensure Docker is reachable
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' })
  } catch {
    console.error('Docker is not running.')
    process.exit(1)
  }

  let containers
  try {
    containers = execFileSync('docker', [
      'ps', '--filter', 'label=mrc=1', '--format', '{{.ID}}',
    ], { encoding: 'utf8' }).trim()
  } catch { containers = '' }

  if (!containers) {
    console.log('  No Mr. Claude containers running.')
    return
  }

  console.log('')
  console.log('  🎩 Active Mr. Claude Sessions')
  console.log('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

  for (const cid of containers.split('\n')) {
    const inspect = (fmt) => {
      try { return execFileSync('docker', ['inspect', '--format', fmt, cid], { encoding: 'utf8' }).trim() } catch { return '' }
    }

    const repoName = inspect('{{index .Config.Labels "mrc.repo.name"}}')
    const repoLabel = inspect('{{index .Config.Labels "mrc.repo"}}')
    const web = inspect('{{index .Config.Labels "mrc.web"}}')
    const started = inspect('{{.State.StartedAt}}')

    let uptime = 'unknown'
    if (started) {
      const secs = Math.floor((Date.now() - new Date(started).getTime()) / 1000)
      if (secs >= 3600) uptime = `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
      else if (secs >= 60) uptime = `${Math.floor(secs / 60)}m`
      else uptime = `${secs}s`
    }

    const webTag = web === 'true' ? ' (--web)' : ''
    console.log(`  → ${repoName || 'unknown'}  ·  up ${uptime}${webTag}`)
    console.log(`    ${repoLabel || '?'}  [${cid.slice(0, 12)}]`)
  }
  console.log('')
}
