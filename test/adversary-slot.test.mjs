// The race-free Pierre config-volume slot claim (claimLowestFree): atomic O_EXCL create + PID-liveness GC.
// This is the correctness-critical core of nextAdversarySlot (which shells to `docker ps` for the live-mount
// oracle); here we test the claim/GC logic directly against a temp dir, no docker needed.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { claimLowestFree } from '../src/docker.js'

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
