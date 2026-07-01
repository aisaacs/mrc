// Socket-level test for 3.A/#39 containment classification on the REAL daemon: writes tamper-proof
// host records, boots startRoomDaemon, registers sessions over the actual wire, and asserts the daemon
// classifies each from the HOST RECORD (not the register frame) and surfaces the verdict on `status`.
// This locks Gate 3's DAEMON half; the container half (record never mounted → an adversary can't forge
// 'normal') still needs the live rebuild.
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'

// Isolate HOME BEFORE importing anything that reads homedir() (session-record's recordDir()).
process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/mrc-classify-home-`)
const { startRoomDaemon } = await import('../src/proxies/room-daemon.js')
const { saveSessionRecord } = await import('../src/session-record.js')
const { findFreePort } = await import('../src/ports.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function client(port) {
  const frames = []
  const sock = net.connect(port, '127.0.0.1')
  let buf = ''
  sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) try { frames.push(JSON.parse(l)) } catch {} } })
  const send = (o) => sock.write(JSON.stringify(o) + '\n')
  return { sock, frames, send, ready: new Promise((res) => sock.on('connect', res)) }
}

function controlCall(port, frame) {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, '127.0.0.1', () => c.write(JSON.stringify(frame) + '\n'))
    let buf = ''
    c.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { try { resolve(JSON.parse(buf.slice(0, i))) } catch (e) { reject(e) } c.end() } })
    c.on('error', reject)
    setTimeout(() => reject(new Error('control timeout')), 1500)
  })
}

test('daemon classifies from the host record, not the register frame; surfaces on status', async () => {
  process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/mrc-cls-`)
  const repo = process.env.HOME

  // Host-only records, written BEFORE launch (as mrc.js does): an adversary (summonedBy set), a normal
  // session, and — deliberately — NO record for the 'unknown' session.
  const ADV = 'sess-adversary-uuid'
  const NORM = 'sess-normal-uuid'
  const UNK = 'sess-unknown-uuid'
  saveSessionRecord(ADV, { repoPath: repo, summonedBy: 'sess-summoner-uuid', adversary: true })
  saveSessionRecord(NORM, { repoPath: repo, adversary: false })

  const port = await findFreePort(19100)
  const controlPort = await findFreePort(port + 1)
  const daemon = startRoomDaemon({ port, controlPort, notifyPort: 0, version: 'test', idleMs: 9e9, tickMs: 9e9, turnCap: 100, workerInvoke: async () => ({ text: '' }) })

  // The adversary REGISTERS AS A NORMAL FRAME — no summonedBy/adversary field. The daemon must classify
  // it 'adversary' anyway, from the record: the whole point (a contained session can't declassify itself).
  const a = client(port); await a.ready
  const n = client(port); await n.ready
  const u = client(port); await u.ready
  a.send({ type: 'register', sessionId: ADV, repo: 'evil', label: 'totally-normal' })   // forged-benign frame
  n.send({ type: 'register', sessionId: NORM, repo: 'proj', label: 'proj' })
  u.send({ type: 'register', sessionId: UNK, repo: 'legacy', label: 'legacy' })
  await sleep(120)

  const st = await controlCall(controlPort, { action: 'status' })
  const byId = Object.fromEntries(st.sessions.map((s) => [s.id, s]))

  assert.equal(byId[ADV]?.adversary, true, 'adversary record → adversary:true despite a benign frame')
  assert.ok(!byId[ADV]?.unverified, 'a classified adversary is not also unverified')
  assert.ok(!byId[NORM]?.adversary, 'normal record → not flagged adversary')
  assert.ok(!byId[NORM]?.unverified, 'normal record → not unverified')
  assert.ok(!byId[UNK]?.adversary, 'no record → not branded adversary (mislabel = availability bug)')
  assert.equal(byId[UNK]?.unverified, true, 'no record → unverified (loud-on-absent, not silent-trust)')

  daemon?.stop?.()
  for (const c of [a, n, u]) try { c.sock.destroy() } catch {}
})
