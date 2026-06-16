import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { mkdirSync, statSync, rmSync, readdirSync, writeFileSync } from 'node:fs'
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

/** Get count of running REGULAR mrc containers for a repo (excludes summoned adversaries). */
export function getExistingCount(repoPath) {
  try {
    // ONE snapshot — NOT two separate `docker ps` calls. With two calls, a Pierre transitioning to running
    // between them would skew the subtraction (all-count misses it, adversary-count catches it → count too
    // low) and could collide a NEW regular session's instance number onto a LIVE regular volume. One snapshot
    // can't skew. Each line is "<id> <mrc.adversary-value>"; the id keeps every line non-empty so the count
    // is exact, and a regular session's empty label just isn't "1".
    const out = execFileSync('docker', [
      'ps', '--filter', 'label=mrc=1', '--filter', `label=mrc.repo=${repoPath}`, '--format', '{{.ID}} {{.Label "mrc.adversary"}}',
    ], { encoding: 'utf8', timeout: ADV_DOCKER_TIMEOUT_MS }).trim()
    if (!out) return 0
    const lines = out.split('\n')
    // Adversaries (their `-pierre-N` pool must not bump regular instance numbering) — subtract off the SAME snapshot.
    const adversaries = lines.filter((l) => l.split(' ')[1] === '1').length
    return Math.max(0, lines.length - adversaries)
  } catch { return 0 }
}

// A claim file only has to bridge [the atomic claim] → [the container's slot label becoming visible to the
// next summon's `docker ps`]. That label appears at `docker run` START (~1-4s), INDEPENDENT of how long
// /login takes — so this is NOT a login-length TTL. Erring LONG is benign (a stale claim merely bumps the
// next summon to a higher slot — never a collision); erring short risks a gap, so keep it generous.
const ADV_CLAIM_TTL_MS = 45_000
const ADV_DOCKER_TIMEOUT_MS = 8_000  // hard-bound `docker ps`; on timeout it throws → fail closed (below).
const ADV_MAX_SLOTS = 256            // sanity cap so a persistent write error can't spin the claim loop forever.
// Both racing summons derive this from the SAME repoPath → SAME md5 → SAME dir; lives under the mrc data dir.
const advSlotsDir = (repoPath) => join(homedir(), '.local', 'share', 'mrc', 'pierre-slots', createHash('md5').update(repoPath).digest('hex').slice(0, 12))

/** Lowest free "Pierre" slot for a repo's summoned-adversary pool. Serialization is STRUCTURAL, not locked:
 *  the claim is an atomic O_EXCL create, so two concurrent same-repo summons that both read an empty slot set
 *  STILL can't land on the same slot — one wins the create, the other gets EEXIST and walks on. No mutex, no
 *  fence, no read→commit gap to freeze in (this is a macOS+Colima laptop tool — it sleeps; an atomic claim has
 *  no lease to expire mid-freeze). "In use" = RUNNING adversaries (docker ps slot label) ∪ existing claim files
 *  (each bridges run→label-visible, then GC'd at TTL). FAILS CLOSED (null) on any lost signal — docker
 *  unreachable, or a non-EEXIST write error — so the caller aborts rather than risk two Pierres on one volume.
 *  Summoner is structurally safe regardless (disjoint volume names). High-water-mark login: log into a slot
 *  once, then every future Pierre on it is free + immortal (its own independent grant). */
export function nextAdversarySlot(repoPath) {
  const dir = advSlotsDir(repoPath)
  try { mkdirSync(dir, { recursive: true }) } catch {}
  // Oracle: slots with a RUNNING adversary. A THROW (docker down / timeout) is a lost liveness signal — a Pierre
  // alive past its claim's TTL exists ONLY as this label — so fail closed; never treat "can't tell" as "free".
  const used = new Set()
  try {
    const out = execFileSync('docker', [
      'ps', '--filter', 'label=mrc.adversary=1', '--filter', `label=mrc.repo=${repoPath}`,
      '--format', '{{.Label "mrc.adversary.slot"}}',
    ], { encoding: 'utf8', timeout: ADV_DOCKER_TIMEOUT_MS }).trim()
    for (const s of (out ? out.split('\n') : [])) { const n = parseInt(s, 10); if (n > 0) used.add(n) }
  } catch { return null }
  // GC claim files older than the TTL so a long-dead summon's claim doesn't falsely block a slot.
  const now = Date.now()
  try {
    for (const f of readdirSync(dir)) {
      const n = parseInt(f, 10); if (!(n > 0)) continue
      try { if (now - statSync(join(dir, f)).mtimeMs >= ADV_CLAIM_TTL_MS) rmSync(join(dir, f), { force: true }) } catch {}
    }
  } catch {}
  // The atomic claim IS the pick: `wx` (O_EXCL) create-or-fail. Two racers both try slot 1; the kernel lets
  // exactly one create it, the other gets EEXIST and walks to 2 — no lock, no gap. EEXIST = taken (or a claim
  // still bridging run→visible) → next slot. Any OTHER write error (ENOSPC/EROFS/EACCES) is a lost signal → null.
  for (let n = 1; n <= ADV_MAX_SLOTS; n++) {
    if (used.has(n)) continue
    try { writeFileSync(join(dir, String(n)), '', { flag: 'wx' }); return n }
    catch (e) { if (e && e.code === 'EEXIST') continue; return null }
  }
  return null   // exhausted the (absurd) cap → fail closed rather than spin
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
