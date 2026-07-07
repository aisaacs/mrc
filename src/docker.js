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
// `exact` (adversary RESUME): claim preferredStart OR FAIL — no lowest-free fallback. A resume MUST reattach its OWN
// recorded slot; falling back into another slot mounts a DIFFERENT summon's durable -pierre-N volume (its ~/.claude +
// transcript) = an isolation break + a silent wrong-identity resume (Pierre). Summon stays exact:false (lowest-free).
export function claimLowestFree(dir, used, preferredStart = 0, { exact = false } = {}) {
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
  // #D8: sawClaim = the EEXIST-walk saw a slot whose claim file exists but whose container isn't in `used` yet — a
  // CONCURRENT sibling (claimed the O_EXCL, container not docker-ps-visible yet) or a just-died launch's <TTL claim.
  // The mount-oracle is blind to both; only this walk sees them. nextInstanceSlot folds it into "others present" so
  // two simultaneous launches don't both --continue the shared transcript. (nextAdversarySlot ignores it.)
  let sawClaim = false
  const attempt = (n) => {
    if (used.has(n)) return null
    try { writeFileSync(join(dir, String(n)), `${process.pid}\n`, { flag: 'wx' }); return n }
    catch (e) { if (e && e.code === 'EEXIST') { sawClaim = true; return null }; throw e }
  }
  try {
    if (preferredStart > 0 && preferredStart <= ADV_MAX_SLOTS) { const got = attempt(preferredStart); if (got) return { slot: got, sawClaim } }
    if (exact) return null   // resume: preferred slot unavailable → FAIL, never fall into another Pierre's volume
    for (let n = 1; n <= ADV_MAX_SLOTS; n++) { const got = attempt(n); if (got) return { slot: got, sawClaim } }
  } catch { return null }   // non-EEXIST write error → lost signal → fail closed
  return null
}

/** Lowest free "Pierre" slot for a repo's summoned-adversary pool (volumes `mrc-config-<hash>-pierre-N`).
 *  Race-free + fail-closed. "In use" = RUNNING adversaries (their mrc.adversary.slot label). Returns the slot
 *  number, or null on a lost liveness oracle (docker down/timeout) / no safe slot → caller fails closed. */
export function nextAdversarySlot(repoPath, preferredSlot = 0, { exact = false } = {}) {
  // Adversary RESUME (exact): must reattach its OWN recorded slot. No recorded slot → can't safely reattach → fail
  // closed (never lowest-free into a stranger's volume). Pass exact through so the claim itself is preferred-or-fail.
  if (exact && !(preferredSlot > 0)) return null
  const used = new Set()
  try {
    const out = execFileSync('docker', [
      'ps', '--filter', 'label=mrc.adversary=1', '--filter', `label=mrc.repo=${repoPath}`,
      '--format', '{{.Label "mrc.adversary.slot"}}',
    ], { encoding: 'utf8', timeout: ADV_DOCKER_TIMEOUT_MS }).trim()
    for (const s of (out ? out.split('\n') : [])) { const n = parseInt(s, 10); if (n > 0) used.add(n) }
  } catch { return null }   // lost liveness oracle → fail closed
  const r = claimLowestFree(slotsDir('pierre-slots', repoPath), used, preferredSlot, { exact })
  return r ? r.slot : null
}

/** D8 — lowest FREE config-volume instance slot for a repo (`mrc-config-<hash>` = slot 1, `-<N>` = slot N).
 *  Replaces `getExistingCount()+1`, which used the running-container CARDINALITY: start A(1),B(2); stop A → count 1
 *  → next launch picks 2 = B's LIVE volume → two sessions racing one ~/.claude/refresh-token. The oracle is the
 *  occupied-slot SET, derived from running containers' ACTUAL config-volume MOUNTS (docker ps + inspect) — NOT the
 *  count, and NOT `docker volume ls` (a config volume is DURABLE, so listing existing volumes would reserve a
 *  stopped session's slot forever → a plain relaunch gets a FRESH volume → re-OAuth + no --continue, breaking
 *  CLAUDE.md config-persistence/auto-resume). The mounted SET keeps all three cases right: nothing running →
 *  used={} → slot 1 → REUSES `mrc-config-<hash>` (persistence ✓); two concurrent → claimLowestFree's O_EXCL gives
 *  1 then 2 (no collision); A(1),B(2),stop A,start C → used={2} → C gets 1 → reuses A's stopped volume, no
 *  collision with B. Fail-closed null on a lost oracle. `listMountedVolumes` is injectable for tests (default =
 *  the real docker ps+inspect); it returns an array of config-volume names mounted by running mrc containers. */
export function nextInstanceSlot(repoPath, { listMountedVolumes } = {}) {
  const hash = createHash('md5').update(repoPath).digest('hex').slice(0, 12)
  const base = `mrc-config-${hash}`
  const used = new Set()
  try {
    let names
    if (listMountedVolumes) {
      names = listMountedVolumes()
    } else {
      const ids = execFileSync('docker', ['ps', '-q', '--filter', 'label=mrc=1', '--filter', `label=mrc.repo=${repoPath}`], { encoding: 'utf8', timeout: ADV_DOCKER_TIMEOUT_MS }).trim()
      let out = ''
      if (ids) {
        // A container can exit in the gap between `docker ps` and `docker inspect` (benign race, likelier with
        // short-lived/daemon containers): inspect then exits non-zero on the "No such object" id but STILL prints
        // the survivors' mounts to stdout. Salvage that partial stdout rather than fail-closed on a benign race —
        // a container that just vanished has freed its slot anyway, so not counting it is correct, not a workaround.
        try { out = execFileSync('docker', ['inspect', '--format', '{{range .Mounts}}{{.Name}} {{end}}', ...ids.split('\n')], { encoding: 'utf8', timeout: ADV_DOCKER_TIMEOUT_MS }) }
        catch (e) { out = e && e.stdout ? String(e.stdout) : '' }
      }
      names = out.split(/\s+/)
    }
    const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-(\\d+)$')   // `-N` for N>=2 (not -pierre-, not mrc-codex-)
    for (const t of names) {
      const name = String(t).trim(); if (!name) continue
      if (name === base) used.add(1)                                          // base (no suffix) = instance 1
      else { const m = name.match(re); if (m) used.add(parseInt(m[1], 10)) }
    }
  } catch { return null }   // lost the liveness oracle → fail closed (never collide a new session onto a live volume)
  const r = claimLowestFree(slotsDir('instance-slots', repoPath), used)
  if (!r) return null
  // `others` = other REGULAR sessions for the "N running" warning + the auto-new-session force (so two sessions
  // don't both --continue the shared /workspace/.mrc transcript). |used| = running-mounted; r.sawClaim = a
  // concurrent sibling whose claim is on disk but whose mount isn't docker-ps-visible yet (the mount-oracle is
  // blind to it, the EEXIST-walk saw it). Over-counting a just-died <TTL claim is the safe direction.
  return { slot: r.slot, others: used.size + (r.sawClaim ? 1 : 0) }
}

/** #5 GATE-3 CEILING probe: is a RUNNING mrc container already mounting host slice `sliceHostDir` at /mrc?
 *  Returns { id, determined }: id = a live container on this slice (or null), determined = whether the probe
 *  could actually PROVE the answer. This is the host-side liveness oracle (the host can't flock-probe — no flock(1)
 *  on macOS, no flock(2) in Node) and it's SHARPER than a flock-probe: `docker ps` reports only running containers
 *  (a crashed owner drops off — no stale marker), it works for --daemon, and the /mrc mount exists from `docker run`
 *  time so it catches a pre-flock-startup owner. Match by the /mrc BIND mount's Source (bind → .Source, not .Name),
 *  by BASENAME (the slice key) — Colima-remap-invariant, and the SLICE not the mrc.repo label (a cp'd repo shares
 *  the slice at a different path; unrelated sessions share the label on different slices).
 *
 *  FAIL-CLOSED (Pierre): a docker `ps` throw OR a per-container inspect timeout must NOT be read as "clear" — that's
 *  the fail-open sin (an 8s timeout under a loaded Colima → falsely "no live container" → co-write). Instead RETRY
 *  the whole probe a few times (a genuine live container is still there; a transient timeout clears), and if it still
 *  can't decide → { id:null, determined:false } so the caller can refuse/skip rather than assume idle. A clean
 *  `ps → []` (or a full sweep with no match) IS a determination → { id:null, determined:true } → normal launch. */
// LIVENESS_TIMEOUT_MS (Pierre): a liveness PING, not the adversary path — a healthy `docker ps` answers sub-second,
// so 2s per attempt (× a few retries) keeps a loaded-but-ALIVE Colima answering inside budget instead of a false
// "unresponsive" REFUSE on a zero-contention launch. ADV_DOCKER_TIMEOUT_MS (8s) is sized for a different job.
const LIVENESS_TIMEOUT_MS = 2_000
export function sliceLiveContainer(sliceHostDir, { runningIds, mountSourceOf, attempts = 3, backoffMs = 200, timeoutMs = LIVENESS_TIMEOUT_MS } = {}) {
  const want = basename(sliceHostDir)
  for (let attempt = 0; attempt < attempts; attempt++) {
    let undetermined = false
    try {
      const ids = runningIds
        ? runningIds()
        : execFileSync('docker', ['ps', '-q', '--filter', 'label=mrc=1'], { encoding: 'utf8', timeout: timeoutMs }).trim().split('\n').filter(Boolean)
      for (const id of ids) {
        let src
        if (mountSourceOf) src = mountSourceOf(id)
        else {
          try { src = execFileSync('docker', ['inspect', '--format', '{{range .Mounts}}{{if eq .Destination "/mrc"}}{{.Source}}{{end}}{{end}}', id], { encoding: 'utf8', timeout: timeoutMs }).trim() }
          catch { undetermined = true; break }   // an inspect timeout must NOT count as "no match" — this container might be the one on our slice
        }
        if (src && basename(src) === want) return { id, determined: true }
      }
      if (!undetermined) return { id: null, determined: true }   // clean full sweep, no match → PROVEN clear
    } catch { undetermined = true }                              // ps threw → couldn't even list
    if (undetermined && attempt < attempts - 1) {                // short backoff, then retry (a real peer persists; a transient timeout clears)
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoffMs) } catch {}
    }
  }
  return { id: null, determined: false }   // retries exhausted without a determination → caller must fail-closed
}

/** #5 per-UUID COEXIST: the SET of session uuids currently HELD by live containers. Each mrc container --resumes its
 *  MRC_SESSION_ID; the host reads that env off every running mrc container so it can (a) force-new a bare launch off
 *  a HELD newest (coexist, not collide) and (b) REFUSE an explicit resume of a held uuid. Returns { held, determined };
 *  same fail-closed retry discipline as sliceLiveContainer — a ps/inspect throw → determined:false so the caller
 *  fails closed (force-new for auto, refuse for explicit), never a silent "nothing held" that lets a co-resume through. */
export function heldUuids({ runningIds, envOf, attempts = 3, backoffMs = 200, timeoutMs = LIVENESS_TIMEOUT_MS } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    let undetermined = false
    const held = new Set()
    try {
      const ids = runningIds
        ? runningIds()
        : execFileSync('docker', ['ps', '-q', '--filter', 'label=mrc=1'], { encoding: 'utf8', timeout: timeoutMs }).trim().split('\n').filter(Boolean)
      for (const id of ids) {
        let sid
        if (envOf) sid = envOf(id)
        else {
          try {
            const env = execFileSync('docker', ['inspect', '--format', '{{range .Config.Env}}{{println .}}{{end}}', id], { encoding: 'utf8', timeout: timeoutMs })
            const line = env.split('\n').find((l) => l.startsWith('MRC_SESSION_ID='))
            sid = line ? line.slice('MRC_SESSION_ID='.length).trim() : ''
          } catch { undetermined = true; break }   // can't read this container's session → can't rule its uuid out
        }
        if (sid) held.add(sid)
      }
      if (!undetermined) return { held, determined: true }
    } catch { undetermined = true }
    if (undetermined && attempt < attempts - 1) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoffMs) } catch {} }
  }
  return { held: new Set(), determined: false }   // couldn't determine → caller fails closed
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

/** #12: the FAIL-CLOSED repo-label live-container probe for `mrc migrate`'s preflight. getExistingCount swallows a
 *  docker error to 0 (fail-OPEN — fine for launch's instance-count, WRONG for a migrate guard: a transient error
 *  would green a migrate racing a live LEGACY session, the exact split incident). Same retry/determined discipline
 *  as sliceLiveContainer: a clean `ps` → {count, determined:true}; retries exhausted without an answer →
 *  {count:0, determined:false} so the preflight refuses rather than assume idle. */
export function repoLiveContainers(repoPath, { attempts = 3, backoffMs = 200, timeoutMs = LIVENESS_TIMEOUT_MS } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const ids = execFileSync('docker', ['ps', '-q', '--filter', 'label=mrc=1', '--filter', `label=mrc.repo=${repoPath}`], { encoding: 'utf8', timeout: timeoutMs }).trim().split('\n').filter(Boolean)
      return { count: ids.length, determined: true }
    } catch {
      if (attempt < attempts - 1) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoffMs) } catch {} }
    }
  }
  return { count: 0, determined: false }
}

/** Compute a per-repo config volume name. */
export function volumeName(repoPath, instanceId) {
  const hash = createHash('md5').update(repoPath).digest('hex').slice(0, 12)
  return instanceId > 1 ? `mrc-config-${hash}-${instanceId}` : `mrc-config-${hash}`
}

/** Run the Docker container. Returns a promise that resolves to the exit code.
 *  Uses spawn (not execFileSync) so the event loop stays free for the
 *  clipboard and notification proxy servers running in the same process. */
// #5 store-mode: resolve an image's immutable ID + capability labels in ONE docker inspect (one call, not two), so
// the id we RUN and the labels we DECIDE from come from a single consistent inspect — a tag can't retag between two
// calls (Hazard C), and the caller RUNS this exact id. `{ id:'', labels:{} }` on ANY failure → the caller falls to
// legacy. A labelless image → `{{json .Config.Labels}}` prints `null` → {} → legacy.
export function imageIdAndLabels(name = IMAGE_NAME) {
  try {
    const out = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}} {{json .Config.Labels}}', name], { encoding: 'utf8', timeout: 10000 }).trim()
    const sp = out.indexOf(' ')
    const id = sp < 0 ? out : out.slice(0, sp)
    let labels = {}
    if (sp >= 0) { try { labels = JSON.parse(out.slice(sp + 1)) || {} } catch {} }
    return { id, labels }
  } catch { return { id: '', labels: {} } }
}

export function runContainer({ repoPath, envFlags, volumes, claudeArgs, allowWeb, json, labels = [], member = null, image = IMAGE_NAME }) {
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
    image,   // #5: the PINNED image id (resolved once via imageIdOf) so inspect-and-run are the same image; falls back to IMAGE_NAME
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
export function startDaemon({ repoPath, envFlags, volumes, allowWeb, image = IMAGE_NAME }) {
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
    image,   // #5: pinned image id (or IMAGE_NAME fallback)
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
