// The race-free Pierre config-volume slot claim (claimLowestFree): atomic O_EXCL create + PID-liveness GC.
// This is the correctness-critical core of nextAdversarySlot (which shells to `docker ps` for the live-mount
// oracle); here we test the claim/GC logic directly against a temp dir, no docker needed.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { claimLowestFree, nextInstanceSlot, sliceLiveContainer } from '../src/docker.js'
import { createHash } from 'node:crypto'

const freshDir = () => fs.mkdtempSync(join(os.tmpdir(), 'mrc-slot-'))

test('claims the lowest free slot and writes a <pid>\\n claim body', () => {
  const dir = freshDir()
  const r = claimLowestFree(dir, new Set())
  assert.equal(r.slot, 1)
  assert.equal(fs.readFileSync(join(dir, '1'), 'utf8'), `${process.pid}\n`)
})

test('skips a slot already in the live-mount `used` set', () => {
  const dir = freshDir()
  assert.equal(claimLowestFree(dir, new Set([1, 2])).slot, 3)
})

test('two sequential claims land on DIFFERENT slots (the first claim file blocks the second via O_EXCL)', () => {
  const dir = freshDir()
  const a = claimLowestFree(dir, new Set())
  const b = claimLowestFree(dir, new Set())   // slot 1 claim file now exists → EEXIST → walks to 2
  assert.deepEqual([a.slot, b.slot].sort(), [1, 2])
})

test('a live claim (this process) is NOT reaped — the next claimer walks past it', () => {
  const dir = freshDir()
  fs.writeFileSync(join(dir, '1'), `${process.pid}\n`)   // a live-PID claim
  assert.equal(claimLowestFree(dir, new Set()).slot, 2, 'live claim on slot 1 is honored')
})

test('a stale claim (older than the 48h backstop) is reaped and its slot reclaimed', () => {
  const dir = freshDir()
  fs.writeFileSync(join(dir, '1'), `${process.pid}\n`)   // even a LIVE pid: the age backstop reaps it
  const old = new Date(Date.now() - 3 * 24 * 3600 * 1000)   // 3 days ago > 48h
  fs.utimesSync(join(dir, '1'), old, old)
  assert.equal(claimLowestFree(dir, new Set()).slot, 1, 'stale claim reaped by the age backstop')
})

test('a dead-PID claim (fresh mtime) IS reaped via the ESRCH liveness check', () => {
  const dir = freshDir()
  const dead = spawnSync(process.execPath, ['-e', '']).pid   // a real pid that has already exited → ESRCH
  fs.writeFileSync(join(dir, '1'), `${dead}\n`)
  assert.equal(claimLowestFree(dir, new Set()).slot, 1, 'dead-pid claim reaped, slot 1 reclaimed')
})

test('a torn/sentinel-less claim body is KEPT (never reaped on a partial read)', () => {
  const dir = freshDir()
  fs.writeFileSync(join(dir, '1'), '4000000000')   // NO trailing newline → incomplete → keep
  assert.equal(claimLowestFree(dir, new Set()).slot, 2, 'sentinel-less claim is kept, not reaped')
})

test('preferredStart is taken when free, else falls through to lowest-free', () => {
  const dir = freshDir()
  assert.equal(claimLowestFree(dir, new Set(), 5).slot, 5, 'free preferred slot is taken')
  // 5 now claimed; prefer 5 again → EEXIST → falls to lowest-free (1)
  assert.equal(claimLowestFree(dir, new Set(), 5).slot, 1, 'taken preferred slot falls through to lowest-free')
})

// --- adversary RESUME: EXACT-slot-or-fail (never open in another Pierre's durable volume) ---
test('exact: a FREE preferred slot is claimed', () => {
  const dir = freshDir()
  assert.equal(claimLowestFree(dir, new Set(), 3, { exact: true }).slot, 3, 'exact + free preferred → claimed')
})

test('exact: a TAKEN preferred slot FAILS with NO lowest-free fallback (the wrong-Pierre-volume bug)', () => {
  const usedDir = freshDir()
  assert.equal(claimLowestFree(usedDir, new Set([3]), 3, { exact: true }), null, 'exact + preferred in the live-mount used set → null (fail closed, no fall to slot 1)')

  const claimedDir = freshDir()
  fs.writeFileSync(join(claimedDir, '2'), `${process.pid}\n`)   // a live claim already holds slot 2
  assert.equal(claimLowestFree(claimedDir, new Set(), 2, { exact: true }), null, 'exact + preferred claim EEXISTs → null (never falls to slot 1 = another summon\'s volume)')
  // contrast: WITHOUT exact (a SUMMON), the same taken preferred still falls through to lowest-free
  assert.equal(claimLowestFree(claimedDir, new Set(), 2).slot, 1, 'non-exact summon still falls back to lowest-free')
})

test('exact: preferredStart 0 (no recorded slot) FAILS — cannot reattach an adversary without its own slot', () => {
  const dir = freshDir()
  assert.equal(claimLowestFree(dir, new Set(), 0, { exact: true }), null, 'exact + no preferred → null, never lowest-free')
})

// --- D8: nextInstanceSlot — MOUNTED-slot SET oracle (running containers' config-volume mounts, injected here) ---
const setHome = () => { process.env.HOME = freshDir() }
const cfgBase = (repo) => `mrc-config-${createHash('md5').update(repo).digest('hex').slice(0, 12)}`

test('nextInstanceSlot: NOTHING running → slot 1 → REUSES mrc-config-<hash> (auto-resume + login persist)', () => {
  setHome()
  const r = nextInstanceSlot('/repo/persist', { listMountedVolumes: () => [] })
  assert.equal(r.slot, 1, 'a plain sequential relaunch with nothing running reuses slot 1 = the durable config volume (CLAUDE.md persistence/auto-resume)')
  assert.equal(r.others, 0, 'no other running session')
})

test('nextInstanceSlot: stop-A/start-B/start-C — reuses A\'s STOPPED slot, no collision with B\'s live volume', () => {
  setHome()
  const repo = '/repo/stopstart'; const base = cfgBase(repo)
  // B is running on slot 2 (mounts base-2); A is STOPPED (not mounted). C launches → used={2} → slot 1.
  const r = nextInstanceSlot(repo, { listMountedVolumes: () => [`${base}-2`] })
  assert.equal(r.slot, 1, 'C reuses A\'s stopped slot-1 volume (used={2}=B only) — the old count+1 picked 2 = B\'s LIVE volume (the contamination bug)')
  assert.equal(r.others, 1, 'B is the one other running session')
})

test('nextInstanceSlot: two concurrent launches (same used-set) get different slots; sawClaim flags the sibling', () => {
  setHome()
  const repo = '/repo/concurrent'
  const list = () => []   // both launching simultaneously — neither mount is up yet
  const r1 = nextInstanceSlot(repo, { listMountedVolumes: list })
  const r2 = nextInstanceSlot(repo, { listMountedVolumes: list })
  assert.equal(r1.slot, 1, 'first concurrent claim → 1')
  assert.equal(r1.others, 0, 'first sees no sibling claim')
  assert.equal(r2.slot, 2, 'second concurrent claim → 2 (O_EXCL: slot 1 claim on disk though its mount is not up)')
  assert.equal(r2.others, 1, 'sawClaim caught the on-disk sibling the mount-oracle is blind to → others=1 (so it won\'t --continue the shared transcript)')
})

test('nextInstanceSlot: ignores -pierre-<N> and mrc-codex-* mounts (separate slot spaces)', () => {
  setHome()
  const repo = '/repo/mixed'; const base = cfgBase(repo)
  const r = nextInstanceSlot(repo, { listMountedVolumes: () => [`${base}-pierre-3`, `mrc-codex-${base.slice(11)}`] })
  assert.equal(r.slot, 1, 'a running adversary/codex mount does not occupy a regular instance slot → slot 1 still free')
})

test('nextInstanceSlot: fail-CLOSED (null) when the mount oracle throws', () => {
  setHome()
  assert.equal(nextInstanceSlot('/repo/x', { listMountedVolumes: () => { throw new Error('docker down') } }), null, 'lost oracle → null → caller refuses to launch (never collide onto a live volume)')
})

// --- #5 GATE-3 CEILING: sliceLiveContainer — match a running container by its /mrc BIND-mount Source (basename) ---
test('sliceLiveContainer: matches a running container mounting THIS slice at /mrc (by Source basename)', () => {
  const live = sliceLiveContainer('/Users/me/.local/share/mrc/store/repo-uuid-abc', {
    runningIds: () => ['aaa', 'bbb'],
    mountSourceOf: (id) => id === 'bbb' ? '/some/other/prefix/store/repo-uuid-abc' : '/x/store/other-slice',
  })
  assert.equal(live, 'bbb', 'matched the container whose /mrc Source basename == this slice key, across a REMAPPED path prefix (Colima)')
})

test('sliceLiveContainer: a container mounting a DIFFERENT slice is NOT a match (no label false-positive)', () => {
  const live = sliceLiveContainer('/store/repo-uuid-abc', {
    runningIds: () => ['aaa'],
    mountSourceOf: () => '/store/repo-uuid-DIFFERENT',   // same mrc label, DIFFERENT slice → must not match
  })
  assert.equal(live, null, 'two mrc sessions on different slices must not false-positive (match the SLICE, not the label)')
})

test('sliceLiveContainer: no /mrc mount (empty Source) is skipped; none live → null', () => {
  assert.equal(sliceLiveContainer('/store/s1', { runningIds: () => ['a', 'b'], mountSourceOf: () => '' }), null, 'containers with no /mrc mount (legacy sessions) never match')
  assert.equal(sliceLiveContainer('/store/s1', { runningIds: () => [] }), null, 'nothing running → null')
})

test('sliceLiveContainer: docker error → null (fail toward NOT forking; the flock floor still backstops)', () => {
  assert.equal(sliceLiveContainer('/store/s1', { runningIds: () => { throw new Error('docker down') } }), null, 'lost the oracle → null → no fork; if a peer IS live the container flock floor refuses (never silent co-write)')
})
