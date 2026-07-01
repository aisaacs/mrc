import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { mkdirSync, readdirSync, statSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dbg } from './output.js'
import { IMAGE_NAME } from './constants.js'

// --- summoned-adversary (Pierre) config-volume slot pool ---------------------------------------------
// A caged adversary gets a DEDICATED per-repo config volume (mrc-config-<hash>-pierre-N) so it never mounts
// the user's login/config and its transcript can't be auto-resumed by a normal launch. Slots are claimed
// race-free (atomic O_EXCL create) + fail-closed, keyed by the mrc data dir (never a container mount).
const ADV_CLAIM_BACKSTOP_MS = 172_800_000  // 48h: reclaim a PID-REUSE leak (a recycled PID reads alive forever)
const ADV_DOCKER_TIMEOUT_MS = 8_000        // hard-bound `docker ps`; on timeout it throws → fail closed
const ADV_MAX_SLOTS = 256                  // sanity cap so a persistent write error can't spin the claim loop
const slotsDir = (sub, repoPath) => join(homedir(), '.local', 'share', 'mrc', sub, createHash('md5').update(repoPath).digest('hex').slice(0, 12))

// Take the lowest free slot via an ATOMIC O_EXCL create — the create IS the pick, so two concurrent claimers
// that both computed the same `used` set still can't land on the same slot. GC a dead claim first (PID-liveness
// + a 48h backstop for PID-reuse); a claim body is `<pid>\n` (the trailing-newline SENTINEL proves the whole
// PID landed, so a torn read never reaps a live claim). Returns {slot} or null (taken/fail-closed).
export function claimLowestFree(dir, used, preferredStart = 0) {
  try { mkdirSync(dir, { recursive: true }) } catch {}
  const now = Date.now()
  try {
    for (const f of readdirSync(dir)) {
      if (!/^\d+$/.test(f)) continue
      const claim = join(dir, f)
      try {
        if (now - statSync(claim).mtimeMs >= ADV_CLAIM_BACKSTOP_MS) { rmSync(claim, { force: true }); continue }
        const m = readFileSync(claim, 'utf8').match(/^(\d+)\n$/)
        if (!m) continue   // torn/empty/partial (no sentinel) → KEEP, never reap
        try { process.kill(parseInt(m[1], 10), 0) }                       // alive / EPERM → KEEP
        catch (e) { if (e && e.code === 'ESRCH') rmSync(claim, { force: true }) }   // affirmatively dead → reap
      } catch {}
    }
  } catch {}
  const attempt = (n) => {
    if (used.has(n)) return null
    try { writeFileSync(join(dir, String(n)), `${process.pid}\n`, { flag: 'wx' }); return n }
    catch (e) { if (e && e.code === 'EEXIST') return null; throw e }
  }
  try {
    if (preferredStart > 0 && preferredStart <= ADV_MAX_SLOTS) { const got = attempt(preferredStart); if (got) return { slot: got } }
    for (let n = 1; n <= ADV_MAX_SLOTS; n++) { const got = attempt(n); if (got) return { slot: got } }
  } catch { return null }   // non-EEXIST write error → lost signal → fail closed
  return null
}

/** Lowest free "Pierre" slot for a repo's summoned-adversary pool (volumes `mrc-config-<hash>-pierre-N`).
 *  Race-free + fail-closed. "In use" = RUNNING adversaries (their mrc.adversary.slot label). Returns the slot
 *  number, or null on a lost liveness oracle (docker down/timeout) / no safe slot → caller fails closed. */
export function nextAdversarySlot(repoPath, preferredSlot = 0) {
  const used = new Set()
  try {
    const out = execFileSync('docker', [
      'ps', '--filter', 'label=mrc.adversary=1', '--filter', `label=mrc.repo=${repoPath}`,
      '--format', '{{.Label "mrc.adversary.slot"}}',
    ], { encoding: 'utf8', timeout: ADV_DOCKER_TIMEOUT_MS }).trim()
    for (const s of (out ? out.split('\n') : [])) { const n = parseInt(s, 10); if (n > 0) used.add(n) }
  } catch { return null }   // lost liveness oracle → fail closed
  const r = claimLowestFree(slotsDir('pierre-slots', repoPath), used, preferredSlot)
  return r ? r.slot : null
}

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

/** Get count of running mrc containers for a given repo path. */
export function getExistingCount(repoPath) {
  try {
    const ids = execFileSync('docker', [
      'ps', '--filter', 'label=mrc=1', '--filter', `label=mrc.repo=${repoPath}`, '--format', '{{.ID}}',
    ], { encoding: 'utf8' }).trim()
    return ids ? ids.split('\n').length : 0
  } catch { return 0 }
}

/** Compute a per-repo config volume name. */
export function volumeName(repoPath, instanceId) {
  const hash = createHash('md5').update(repoPath).digest('hex').slice(0, 12)
  return instanceId > 1 ? `mrc-config-${hash}-${instanceId}` : `mrc-config-${hash}`
}

/** Run the Docker container. Returns a promise that resolves to the exit code.
 *  Uses spawn (not execFileSync) so the event loop stays free for the
 *  clipboard and notification proxy servers running in the same process. */
export function runContainer({ repoPath, envFlags, volumes, claudeArgs, allowWeb, json, labels = [], member = null }) {
  // A team member (#34) runs as its own ttyd-hosted PTY (no tmux). Force TERM=xterm-256color so Claude
  // sees a real xterm — that's what makes the mouse wheel scroll the transcript natively — and label the
  // container with the member handle so the daemon can reconcile/console/stop it by `docker ps` label.
  const memberFlags = member ? ['-e', 'TERM=xterm-256color', '--label', `mrc.member=${member}`] : []
  const args = [
    'run', '--rm', ...(json ? [] : ['-it']), '--init',
    '--cap-add=NET_ADMIN',
    '--cap-add=NET_RAW',
    '--add-host=host.docker.internal:host-gateway',
    '--label', 'mrc=1',
    '--label', `mrc.repo=${repoPath}`,
    '--label', `mrc.repo.name=${basename(repoPath)}`,
    '--label', `mrc.web=${!!allowWeb}`,
    ...memberFlags,
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

/** Run a one-shot worker turn (non-interactive): a task-worker member's CLI executes inside the
 *  sandbox scoped to its territory, and its stdout is the reply. Same security flags as a normal
 *  run; the entrypoint takes its exec branch when MRC_EXEC_PROMPT_FILE is set. Returns stdout. */
export function runWorkerExec({ repoPath, envFlags, volumes, allowWeb }) {
  const args = [
    'run', '--rm', '--init',
    '--cap-add=NET_ADMIN', '--cap-add=NET_RAW',
    '--add-host=host.docker.internal:host-gateway',
    '--label', 'mrc=1',
    '--label', `mrc.repo=${repoPath}`,
    '--label', `mrc.repo.name=${basename(repoPath)}`,
    '--label', `mrc.web=${!!allowWeb}`,
    '--label', 'mrc.worker=1',
    ...envFlags, ...volumes, IMAGE_NAME,
  ]
  try {
    return { text: execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }), ok: true }
  } catch (e) {
    // #48: a non-zero docker/codex exit — KEEP the output for the user, but PRESERVE the failure signal
    // (ok:false) instead of flattening the exit away into text (which made a failed codex call read ✓).
    return { text: (e.stdout || '') + (e.stderr ? `\n[worker stderr] ${e.stderr}` : `\n[worker failed: ${e.message}]`), ok: false }
  }
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
