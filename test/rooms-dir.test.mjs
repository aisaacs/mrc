// #30: removeRoomDir — the on-disk dir removal used by the daemon's failed-summon orphan reaper. Covers the
// path-safety guards (it must NEVER traverse out of roomsRoot) and the happy-path removal. HOME is redirected
// to a temp dir so roomsRoot() (os.homedir()-based, reads $HOME on POSIX) lands in isolation.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

process.env.HOME = fs.mkdtempSync(join(os.tmpdir(), 'mrc-roomsdir-'))
const { removeRoomDir, roomsRoot } = await import('../src/rooms.js')

const mkRoom = (id, files = {}) => {
  const dir = join(roomsRoot(), id)
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(join(dir, name), body)
  return dir
}

test('removeRoomDir removes a real room dir and its contents', () => {
  const dir = mkRoom('adversary-abc123', { 'thread.log': '', 'adversary-brief.md': 'x' })
  assert.ok(fs.existsSync(dir))
  assert.equal(removeRoomDir('adversary-abc123'), true)
  assert.ok(!fs.existsSync(dir), 'dir gone')
})

test('removeRoomDir REFUSES path traversal (../, /, leading dot) — never escapes roomsRoot', () => {
  // A sentinel file OUTSIDE roomsRoot that a traversal would try to reach.
  const outside = join(process.env.HOME, 'DO-NOT-DELETE')
  fs.writeFileSync(outside, 'keep')
  for (const bad of ['../..', '../../DO-NOT-DELETE', 'a/b', '..', '.hidden', '/etc', '']) {
    assert.equal(removeRoomDir(bad), false, `refused "${bad}"`)
  }
  assert.ok(fs.existsSync(outside), 'nothing outside roomsRoot was touched')
})

test('removeRoomDir returns false for a non-string / nonexistent id (no throw)', () => {
  assert.equal(removeRoomDir(undefined), false)
  assert.equal(removeRoomDir(null), false)
  assert.equal(removeRoomDir(42), false)
  assert.equal(removeRoomDir('adversary-never-existed'), true)   // rmSync force:true is idempotent — absent dir is a no-op success
})
