// Integration test for the room daemon's state machine. Drives the real wire protocol with mock TCP
// clients, in-process — no host, no real Claude sessions. Covers the multiparty/adversary logic
// (participant set, broadcast, the one-live-room invariant, the consent flow, ghost-membership,
// out-of-order end, 3-member restore, stall-vs-sidechannel). It does NOT cover the host-side parts:
// the osascript tab-opener, a real summoned Claude booting, the `mrc rooms` CLI, or the dashboard.
//
//   run:  node test/rooms-daemon.test.mjs        (exit 0 = all pass, 1 = a failure)
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
const here = dirname(fileURLToPath(import.meta.url))
const { startRoomDaemon } = await import(join(here, '../src/proxies/room-daemon.js'))
const { findFreePort } = await import(join(here, '../src/ports.js'))
const { savePairings, removeRoomDir, ensureRoom } = await import(join(here, '../src/rooms.js'))

process.env.MRC_SUMMON_OPEN_CMD = 'true'   // no-op opener; we simulate the adversary booting by connecting a client

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`) } else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${extra ? '  «' + extra + '»' : ''}`) } }

function mkClient(port, sessionId) {
  const c = net.connect(port, '127.0.0.1'); const frames = []; let buf = ''
  c.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) { try { frames.push(JSON.parse(l)) } catch {} } } })
  c.on('error', () => {})
  return {
    sock: c, frames, sessionId,
    send: (o) => c.write(JSON.stringify(o) + '\n'),
    register: (extra = {}) => c.write(JSON.stringify({ type: 'register', sessionId, repo: sessionId, label: sessionId, repoPath: '/tmp/repo-' + sessionId, ...extra }) + '\n'),
    close: () => c.destroy(),
    clear: () => { frames.length = 0 },
    has: (type, sub) => frames.some((f) => f.type === type && (sub == null || (f.text || '').includes(sub))),
  }
}
const rpc = (controlPort, msg) => new Promise((resolve) => {
  const c = net.connect(controlPort, '127.0.0.1', () => c.write(JSON.stringify(msg) + '\n')); let buf = ''
  c.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { try { resolve(JSON.parse(buf.slice(0, i))) } catch { resolve({ ok: false }) } c.destroy() } })
  c.on('error', () => resolve({ ok: false }))
})
const status = (cp) => rpc(cp, { action: 'status' })
const control = (cp, action, extra = {}) => rpc(cp, { action, ...extra })
const roomBy = (st, ...names) => (st.pairings || []).find((p) => names.every((n) => (p.members || []).includes(n)))
// Poll daemon status until a predicate holds (bounded) — replaces sleep-and-pray for state handoffs.
const waitUntil = async (cp, pred, tries = 80) => { let s; for (let i = 0; i < tries; i++) { s = await status(cp); if (pred(s)) return s; await sleep(25) } return s }

async function main() {
  const port = await findFreePort(41700)
  const controlPort = await findFreePort(port + 1)
  const d = startRoomDaemon({ port, controlPort, notifyPort: 0, version: 'test', stallMs: 400, tickMs: 120, idleMs: 9e8, catchupTimeoutMs: 300 })
  await sleep(120)

  // 1 — 2-party register + ask + reply (regression: pairing forms, broadcast-to-one routes both ways)
  console.log('\n[1] 2-party regression')
  const S = mkClient(port, 'S'), V = mkClient(port, 'V'); S.register(); V.register(); await sleep(100)
  S.send({ type: 'ask', question: 'hello V', peer: 'V' }); await sleep(150)
  let st = await status(controlPort)
  check('1a pairing S<->V exists', !!roomBy(st, 'S', 'V'))
  check('1b V received the ask', V.has('deliver', 'hello V'))
  V.clear(); V.send({ type: 'msg', text: 'hi back', id: 1 }); await sleep(150)
  check('1c S received V reply', S.has('deliver', 'hi back'))

  // 2 — multi-room + one-live-room invariant (open a 2nd room → 1st auto-brakes; reply routes to active)
  console.log('\n[2] multi-room: one-live-room invariant + active-room routing')
  const W = mkClient(port, 'W'); W.register(); await sleep(80)
  S.clear(); S.send({ type: 'ask', question: 'hello W', peer: 'W' }); await sleep(150)
  st = await status(controlPort)
  const r_sv = roomBy(st, 'S', 'V'), r_sw = roomBy(st, 'S', 'W')
  check('2a S<->V auto-braked (sidechannel)', r_sv && r_sv.state === 'Paused' && r_sv.pauseReason === 'sidechannel', r_sv && `${r_sv.state}/${r_sv.pauseReason}`)
  check('2b S<->W is the live room', r_sw && r_sw.state === 'Running', r_sw && r_sw.state)
  V.clear(); W.clear(); S.send({ type: 'msg', text: 'to-active', id: 2 }); await sleep(150)
  check('2c bare reply went to W (active), not V', W.has('deliver', 'to-active') && !V.has('deliver', 'to-active'))

  // 3 — clean 3-party, AUTO-ACCEPT DEFAULT: summon_to_room joins immediately → fresh adversary → broadcast
  console.log('\n[3] clean 3-party (auto-accept default)')
  const A = mkClient(port, 'A'), B = mkClient(port, 'B'); A.register(); B.register(); await sleep(100)
  A.send({ type: 'ask', question: 'design X', peer: 'B' }); await sleep(150)
  st = await status(controlPort); const abId = roomBy(st, 'A', 'B').roomId
  B.clear(); A.send({ type: 'summon_to_room', brief: 'red-team design X', id: 30 }); await sleep(150)
  st = await status(controlPort); let ab = roomBy(st, 'A', 'B')
  check('3a summon auto-accepted (default, no consent prompt)', A.frames.some((f) => f.type === 'ack' && f.id === 30 && f.status === 'invite-auto-accepted'), JSON.stringify(A.frames.filter((f) => f.type === 'ack')))
  check('3b no consent request to B; nothing pending', !B.has('notice', 'CONSENT NEEDED') && !ab.pendingInvite)
  // simulate the FRESH adversary booting into the shared room (what openAdversaryTab would have launched)
  const P = mkClient(port, 'Pierre'); P.register({ summonedBy: 'A', room: abId }); await sleep(150)
  st = await status(controlPort); ab = roomBy(st, 'A', 'B')
  check('3c adversary joined → 3-party', ab && ab.members.length === 3 && ab.members.includes('Pierre'), ab && JSON.stringify(ab.members))
  A.clear(); B.clear(); P.send({ type: 'msg', text: 'your premise is wrong', id: 9 }); await sleep(150)
  check('3d adversary reply broadcasts to BOTH A and B', A.has('deliver', 'premise') && B.has('deliver', 'premise'))

  // 4 — require-consent mode (auto-accept OFF) + decline
  console.log('\n[4] require-consent + decline')
  const C = mkClient(port, 'C'), Dd = mkClient(port, 'D'); C.register(); Dd.register(); await sleep(100)
  C.send({ type: 'ask', question: 'q', peer: 'D' }); await sleep(120)
  st = await status(controlPort); const cdId = roomBy(st, 'C', 'D').roomId
  await control(controlPort, 'autoaccept', { roomId: cdId, on: false }); await sleep(60)   // add a consent checkpoint to this room
  Dd.clear(); C.clear(); C.send({ type: 'summon_to_room', brief: 'b' }); await sleep(120)
  st = await status(controlPort); let cd = roomBy(st, 'C', 'D')
  check('4a consent required → request sent to D, pending recorded', Dd.has('notice', 'CONSENT NEEDED') && cd.pendingInvite === 'C')
  await control(controlPort, 'decline', { roomId: cdId }); await sleep(120)
  st = await status(controlPort); cd = roomBy(st, 'C', 'D')
  check('4b declined → invite cleared, room still 2-party', !cd.pendingInvite && cd.members.length === 2)
  check('4c issuer notified of decline', C.has('notice', 'declined'))

  // 5 — require-consent + NATURAL-LANGUAGE accept (the consenting peer relays its human's yes)
  console.log('\n[5] require-consent + natural-language accept')
  const E = mkClient(port, 'E'), F = mkClient(port, 'F'); E.register(); F.register(); await sleep(100)
  E.send({ type: 'ask', question: 'q', peer: 'F' }); await sleep(120)
  st = await status(controlPort); const efId = roomBy(st, 'E', 'F').roomId
  await control(controlPort, 'autoaccept', { roomId: efId, on: false }); await sleep(60)
  E.send({ type: 'summon_to_room', brief: 'b' }); await sleep(120)
  F.clear(); F.send({ type: 'consent', decision: 'accept', id: 55 }); await sleep(120)   // F is the consenting peer, not the summoner
  check('5a consenting peer accepted via natural language', F.frames.some((f) => f.type === 'ack' && f.id === 55 && f.status === 'accepted'), JSON.stringify(F.frames.filter((f) => f.type === 'ack')))
  st = await status(controlPort)
  check('5b invite cleared after accept', !roomBy(st, 'E', 'F').pendingInvite)
  const Pe = mkClient(port, 'Pierre5'); Pe.register({ summonedBy: 'E', room: efId }); await sleep(150)
  st = await status(controlPort)
  check('5c adversary joined → 3-party', roomBy(st, 'E', 'F').members.length === 3, roomBy(st, 'E', 'F') && JSON.stringify(roomBy(st, 'E', 'F').members))

  // 6 — ghost membership: disconnect a multi-room member → the OTHER room thaws (doesn't freeze forever)
  console.log('\n[6] ghost membership thaw on disconnect')
  const G = mkClient(port, 'G'), H = mkClient(port, 'H'), I = mkClient(port, 'I'); G.register(); H.register(); I.register(); await sleep(120)
  G.send({ type: 'ask', question: 'q', peer: 'H' }); await sleep(120)
  G.send({ type: 'ask', question: 'q', peer: 'I' }); await sleep(150)
  st = await status(controlPort)
  check('6a G<->H braked while G works in G<->I', roomBy(st, 'G', 'H').pauseReason === 'sidechannel')
  G.close(); await sleep(250)   // G vanishes — H must not be frozen forever
  st = await status(controlPort); const gh = roomBy(st, 'H')   // find by the surviving member
  check('6b G<->H thawed after G disconnected', gh && gh.state === 'Running', gh && `members=${JSON.stringify(gh.members)} ${gh.state}/${gh.pauseReason}`)
  check('6c departed member still renders by name, not "?"', gh && gh.members.includes('G'), gh && JSON.stringify(gh.members))

  // 7 — out-of-order end on a 3-room stack stays single-live (the LIFO fix)
  console.log('\n[7] out-of-order end on a 3-stack')
  const J = mkClient(port, 'J'), K = mkClient(port, 'K'), L = mkClient(port, 'L'), M = mkClient(port, 'M')
  J.register(); K.register(); L.register(); M.register(); await sleep(120)
  J.send({ type: 'ask', question: 'q', peer: 'K' }); await sleep(100)
  J.send({ type: 'ask', question: 'q', peer: 'L' }); await sleep(100)
  J.send({ type: 'ask', question: 'q', peer: 'M' }); await sleep(150)
  st = await status(controlPort); const jlId = roomBy(st, 'J', 'L').roomId
  await control(controlPort, 'end', { roomId: jlId }); await sleep(150)   // end the MIDDLE room
  st = await status(controlPort)
  const jk = roomBy(st, 'J', 'K'), jm = roomBy(st, 'J', 'M')
  const liveForJ = (st.pairings || []).filter((p) => p.members.includes('J') && p.state === 'Running')
  check('7a J live in exactly one room after out-of-order end', liveForJ.length === 1, 'live=' + liveForJ.map((p) => p.roomId).join(','))
  check('7b the live one is the newest (J<->M)', jm && jm.state === 'Running' && jk && jk.state === 'Paused')

  // 8 — 3-member restore (the migration's persistence: a 3rd member survives a dump, unlike old {a,b})
  console.log('\n[8] 3-member persistence round-trip')
  savePairings([{ roomId: 'restore-test', members: ['x', 'y', 'z'], seq: 99, turn: 3, turnCap: 0, autoCatchup: true, state: 'Running', pauseReason: null }])
  const p2 = await findFreePort(port + 50), c2 = await findFreePort(p2 + 1)
  const d2 = startRoomDaemon({ port: p2, controlPort: c2, notifyPort: 0, version: 'test2', idleMs: 9e8, tickMs: 9e8 })
  await sleep(150)
  const st2 = await status(c2); const rr = (st2.pairings || []).find((p) => p.roomId === 'restore-test')
  check('8a 3-member room restored with all 3', rr && rr.members.length === 3, rr && JSON.stringify(rr.members))
  d2.stop()

  // 9 — stall timer must skip a sidechannel-paused room (not double-pause / mis-resume it)
  console.log('\n[9] stall vs sidechannel-brake')
  const N = mkClient(port, 'N'), O = mkClient(port, 'O'), Q = mkClient(port, 'Q'); N.register(); O.register(); Q.register(); await sleep(120)
  N.send({ type: 'ask', question: 'q', peer: 'O' }); await sleep(100)
  N.send({ type: 'ask', question: 'q', peer: 'Q' }); await sleep(150)
  st = await status(controlPort)
  check('9a N<->O is sidechannel-paused', roomBy(st, 'N', 'O').pauseReason === 'sidechannel')
  await sleep(700)   // exceed stallMs(400) with several stall ticks
  st = await status(controlPort); const no = roomBy(st, 'N', 'O')
  check('9b sidechannel room untouched by stall timer', no && no.state === 'Paused' && no.pauseReason === 'sidechannel', no && `${no.state}/${no.pauseReason}`)

  // 10 — #1: resuming a sidechannel-braked room must RE-BRAKE (recompute), not leave two rooms live
  console.log('\n[10] resume re-asserts the one-live-room invariant')
  const R = mkClient(port, 'R'), T = mkClient(port, 'T'), U = mkClient(port, 'U'); R.register(); T.register(); U.register(); await sleep(120)
  R.send({ type: 'ask', question: 'q', peer: 'T' }); await sleep(100)
  R.send({ type: 'ask', question: 'q', peer: 'U' }); await sleep(150)   // R now in 2 rooms; R<->T auto-braked
  st = await status(controlPort); const rtId = roomBy(st, 'R', 'T').roomId
  check('10a R<->T sidechannel-braked', roomBy(st, 'R', 'T').pauseReason === 'sidechannel')
  await control(controlPort, 'resume', { roomId: rtId }); await sleep(120)   // human force-resumes the braked lower room
  st = await status(controlPort)
  const liveForR = (st.pairings || []).filter((p) => p.members.includes('R') && p.state === 'Running')
  check('10b after resume, R still live in exactly ONE room (re-braked)', liveForR.length === 1, 'live=' + liveForR.map((p) => p.roomId).join(','))

  // 11 — #2: a second summon while one is booting is rejected (reservation closes the TOCTOU)
  console.log('\n[11] double-summon rejected by the reservation')
  const A2 = mkClient(port, 'A2'), B2 = mkClient(port, 'B2'); A2.register(); B2.register(); await sleep(100)
  A2.send({ type: 'ask', question: 'q', peer: 'B2' }); await sleep(120)
  A2.clear(); A2.send({ type: 'summon_to_room', brief: 'b', id: 70 }); await sleep(120)   // auto-accepts (default) → reservation set, adversary "booting"
  A2.send({ type: 'summon_to_room', brief: 'b', id: 77 }); await sleep(120)               // 2nd during the boot window
  check('11a 1st summon auto-accepted', A2.frames.some((f) => f.type === 'ack' && f.id === 70 && f.status === 'invite-auto-accepted'), JSON.stringify(A2.frames.filter((f) => f.type === 'ack')))
  check('11b 2nd summon rejected (invite-busy)', A2.frames.some((f) => f.type === 'ack' && f.id === 77 && f.status === 'invite-busy'))
  st = await status(controlPort)
  check('11c room not over-filled', roomBy(st, 'A2', 'B2').members.length === 2)

  // 12 — #2: a register with summonedBy+room but NO reservation is refused (join tied to accept)
  console.log('\n[12] unconsented join refused')
  const A3 = mkClient(port, 'A3'), B3 = mkClient(port, 'B3'); A3.register(); B3.register(); await sleep(100)
  A3.send({ type: 'ask', question: 'q', peer: 'B3' }); await sleep(120)
  st = await status(controlPort); const ab3 = roomBy(st, 'A3', 'B3').roomId
  const rogue = mkClient(port, 'rogue'); rogue.register({ summonedBy: 'A3', room: ab3 }); await sleep(150)   // no accept ever happened
  st = await status(controlPort)
  check('12a rogue adversary refused — room still 2-party', roomBy(st, 'A3', 'B3').members.length === 2, JSON.stringify(roomBy(st, 'A3', 'B3').members))

  // 13 — #3a: a reconnected multi-room session routes its bare reply to the LIVE room, not a braked one.
  // Dedicated daemon (stall OFF) + state-polling so the close→reconnect handoff is deterministic. The
  // sleep-timed version flaked under load: a late socket close could delete the reconnected session, and
  // the stall timer could pause X<->Z while the disconnect-thaw bumped X<->Y's recency — so the bare
  // reply's fallback occasionally picked the braked room. None of that is what this test is about.
  console.log('\n[13] reconnect routes to the live room')
  const p13 = await findFreePort(port + 65), c13 = await findFreePort(p13 + 1)
  const d13 = startRoomDaemon({ port: p13, controlPort: c13, notifyPort: 0, version: 'test13', idleMs: 9e8, tickMs: 9e8, stallMs: 9e8 })
  await sleep(100)
  let X = mkClient(p13, 'X'); const Y = mkClient(p13, 'Y'), Z = mkClient(p13, 'Z'); X.register(); Y.register(); Z.register(); await sleep(120)
  X.send({ type: 'ask', question: 'q', peer: 'Y' }); await sleep(80)
  X.send({ type: 'ask', question: 'q', peer: 'Z' })                    // X<->Y braked, X<->Z live
  const oneLive = (s) => { const y = roomBy(s, 'X', 'Y'), z = roomBy(s, 'X', 'Z'); return y && z && z.state === 'Running' && y.state === 'Paused' }
  await waitUntil(c13, oneLive)
  X.close()
  await waitUntil(c13, (s) => !(s.sessions || []).some((se) => se.id === 'X'))   // close fully processed BEFORE reconnect (no register-vs-close race)
  X = mkClient(p13, 'X'); X.register()                                // reconnect: fresh session object, no activeRoom
  await waitUntil(c13, oneLive)                                       // settled back into the one-live-room state
  Y.clear(); Z.clear(); X.send({ type: 'msg', text: 'after-reconnect', id: 5 }); await sleep(120)
  check('13a reconnected reply went to the LIVE room (Z), not the braked one (Y)', Z.has('deliver', 'after-reconnect') && !Y.has('deliver', 'after-reconnect'))
  d13.stop()

  // 14 — #3b: a summoned adversary is excluded from the catch-up expectation (no 2/3 hang)
  console.log('\n[14] catch-up excludes the adversary')
  const A4 = mkClient(port, 'A4'), B4 = mkClient(port, 'B4'); A4.register(); B4.register(); await sleep(100)
  A4.send({ type: 'ask', question: 'q', peer: 'B4' }); await sleep(120)
  st = await status(controlPort); const ab4 = roomBy(st, 'A4', 'B4').roomId
  A4.send({ type: 'summon_to_room', brief: 'b' }); await sleep(120)   // auto-accepts (default)
  const P4 = mkClient(port, 'Pierre4'); P4.register({ summonedBy: 'A4', room: ab4 }); await sleep(150)
  st = await status(controlPort)
  check('14a room is 3-party', roomBy(st, 'A4', 'B4').members.length === 3, roomBy(st, 'A4', 'B4') && JSON.stringify(roomBy(st, 'A4', 'B4').members))
  A4.clear(); B4.clear(); P4.clear()
  await control(controlPort, 'catchup', { roomId: ab4 }); await sleep(150)
  check('14b adversary did NOT get a catch-up request', !P4.has('catchup_request'))
  check('14c the two real members DID', A4.has('catchup_request') && B4.has('catchup_request'))

  // 15 — stormGuard: a 3-party flood auto-pauses (Pierre's #3c — never fired in anger before)
  console.log('\n[15] stormGuard contains a 3-party flood')
  for (let i = 0; i < 14; i++) { A4.send({ type: 'msg', text: 'flood' + i }); await sleep(8) }   // >STORM_MAX(10) in <20s, in the 3-party room from [14]
  await sleep(250)
  st = await status(controlPort)
  check('15a 3-party flood tripped stormguard (auto-paused)', roomBy(st, 'A4', 'B4') && roomBy(st, 'A4', 'B4').pauseReason === 'stormguard', roomBy(st, 'A4', 'B4') && `${roomBy(st, 'A4', 'B4').state}/${roomBy(st, 'A4', 'B4').pauseReason}`)

  // 16 — #15: a 2nd PRIVATE summon REUSES the live Pierre instead of spawning a second (detect-and-reuse).
  // The ONLY test of the private onSummon path (others use summon_to_room). Pierre's room id is generated
  // from issuer:Date.now(), so it's discovered from the summon notice, then "booted" by registering a client.
  console.log('\n[16] private summon detect-and-reuse')
  const SS = mkClient(port, 'SS'); SS.register(); await sleep(100)
  SS.clear(); SS.send({ type: 'summon', brief: 'first brief', id: 80 }); await sleep(150)
  check('16a 1st private summon acks summoning', SS.frames.some((f) => f.type === 'ack' && f.id === 80 && f.status === 'summoning'), JSON.stringify(SS.frames.filter((f) => f.type === 'ack')))
  const advNote = SS.frames.find((f) => f.type === 'notice' && /room (adversary-[0-9a-f]+)/.test(f.text || ''))
  const advRoom = advNote && advNote.text.match(/room (adversary-[0-9a-f]+)/)[1]
  check('16b summon created an adversary room', !!advRoom, advRoom || 'no room id in notice')
  const Pr = mkClient(port, 'PrivPierre'); Pr.register({ summonedBy: 'SS', room: advRoom }); await sleep(150)
  st = await status(controlPort)
  // match by roomId, not member name: onAdversaryUp relabels the adversary to 'Pierre', so status members are ['SS','Pierre']
  const advPairing = (st.pairings || []).find((p) => p.roomId === advRoom)
  check('16c Pierre paired into the adversary room (2-party)', advPairing && advPairing.members.length === 2, JSON.stringify(advPairing ? advPairing.members : null))
  SS.clear(); Pr.clear(); SS.send({ type: 'summon', brief: 'second brief', id: 81 }); await sleep(150)
  check('16d 2nd private summon acks summon-reused (not summoning/busy)', SS.frames.some((f) => f.type === 'ack' && f.id === 81 && f.status === 'summon-reused'), JSON.stringify(SS.frames.filter((f) => f.type === 'ack')))
  check('16e the new brief was forwarded to the existing Pierre', Pr.has('deliver', 'second brief'))
  st = await status(controlPort)
  const advRooms = (st.pairings || []).filter((p) => (p.members || []).includes('SS') && p.roomId.startsWith('adversary-'))
  check('16f still exactly ONE adversary room (no second spawn)', advRooms.length === 1, JSON.stringify(advRooms.map((p) => p.roomId)))

  // 17 — #15: list_peers shows SESSION AGE (read from the transcript's birthtime), not time-since-write.
  // A freshly-created transcript ⇒ "just started"; a session with NO transcript ⇒ the age token is omitted.
  console.log('\n[17] list_peers shows session age')
  const ageRepo = join(tmpdir(), 'mrc-agetest-' + port)
  mkdirSync(join(ageRepo, '.mrc'), { recursive: true })
  writeFileSync(join(ageRepo, '.mrc', 'AGE1.jsonl'), '{"type":"user","timestamp":"2026-06-15T00:00:00.000Z"}\n')   // birthtime ≈ now ⇒ "just started"
  const AG = mkClient(port, 'AGE1'); AG.register({ repoPath: ageRepo }); await sleep(60)
  const VIEW = mkClient(port, 'VIEWER'); VIEW.register(); await sleep(60)
  VIEW.clear(); VIEW.send({ type: 'list' }); await sleep(120)
  const pl = VIEW.frames.find((f) => f.type === 'peerlist')
  const ageEntry = pl && (pl.peers || []).find((p) => p.id === 'AGE1')
  check('17a entry with a transcript shows a session-age token', !!ageEntry && /just started|\d+[mhd] old/.test(ageEntry.display || ''), ageEntry ? ageEntry.display : JSON.stringify(pl))
  const ssDisplay = (pl?.peers || []).find((p) => p.id === 'SS')?.display || ''   // SS (from [16]) has repoPath /tmp/repo-SS but no transcript file there
  check('17b entry with NO transcript omits the age token (no crash)', !!ssDisplay && !/old|just started|idle|active \d/.test(ssDisplay), ssDisplay)

  // 18 — N≥3 turn-budget backstop: arms, fires, and grants a fresh window on resume (the slow-loop
  // terminator #13 leans on; stormGuard [15] is the fast-flood one). Regression for the bug where an
  // AUTO-ARMED budget (daemon cap off) wedged the room unresumably at the cap — doResume/steer only
  // extended when the daemon-level cap was set, so a default 3-party room re-paused on the next turn.
  console.log('\n[18] N≥3 turn-budget arms + fires + resumable')
  const TB = mkClient(port, 'TB'), TC = mkClient(port, 'TC'); TB.register(); TC.register(); await sleep(100)
  TB.send({ type: 'ask', question: 'q', peer: 'TC' }); await sleep(120)
  st = await status(controlPort); const tbId = roomBy(st, 'TB', 'TC').roomId
  TB.send({ type: 'summon_to_room', brief: 'b' }); await sleep(120)   // auto-accepts (default)
  const TP = mkClient(port, 'Pierre18'); TP.register({ summonedBy: 'TB', room: tbId }); await sleep(150)
  st = await status(controlPort); const tbRoom = roomBy(st, 'TB', 'TC')
  check('18a going 3-party auto-armed a turn budget (cap>0, budget=20)', tbRoom && tbRoom.members.length === 3 && tbRoom.turnCap > 0 && tbRoom.turnBudget === 20, tbRoom && `cap=${tbRoom.turnCap} budget=${tbRoom.turnBudget} n=${tbRoom.members.length}`)

  // (b)+(c) on a DEDICATED daemon with the daemon cap OFF (the bug condition), via a restored room one
  // turn short of a small cap — so we hit it without tripping the rate-based stormGuard.
  const p3 = await findFreePort(port + 80), c3 = await findFreePort(p3 + 1)
  ensureRoom('tbudget', 'z1', 'z2')   // restored pairings don't create the dir; appendThread needs it
  savePairings([{ roomId: 'tbudget', members: ['z1', 'z2', 'z3'], seq: 7, turn: 2, turnCap: 3, autoCatchup: true, state: 'Running', pauseReason: null }])
  const d3 = startRoomDaemon({ port: p3, controlPort: c3, notifyPort: 0, version: 'test3', idleMs: 9e8, tickMs: 9e8 })
  await sleep(150)
  const z1 = mkClient(p3, 'z1'), z2 = mkClient(p3, 'z2'), z3 = mkClient(p3, 'z3'); z1.register(); z2.register(); z3.register(); await sleep(150)
  z1.send({ type: 'msg', text: 'to-the-cap', id: 1 }); await sleep(150)   // turn 2 -> 3 == cap -> pause turnCap
  let zst = await status(c3); let zr = (zst.pairings || []).find((p) => p.roomId === 'tbudget')
  check('18b reaching the budget paused the room (turnCap)', zr && zr.state === 'Paused' && zr.pauseReason === 'turnCap', zr && `${zr.state}/${zr.pauseReason} ${zr.turn}/${zr.turnCap}`)
  await control(c3, 'resume', { roomId: 'tbudget' }); await sleep(120)
  z2.send({ type: 'msg', text: 'after-resume', id: 2 }); await sleep(150)   // a fresh window must absorb this without re-wedging
  zst = await status(c3); zr = (zst.pairings || []).find((p) => p.roomId === 'tbudget')
  check('18c resume granted a fresh window (not re-wedged at the cap)', zr && zr.state === 'Running', zr && `${zr.state}/${zr.pauseReason} ${zr.turn}/${zr.turnCap}`)
  check('18d the post-resume turn reached the peers', z1.has('deliver', 'after-resume') && z3.has('deliver', 'after-resume'))
  d3.stop()

  // 19 — #13: in-band invite_peer pulls a 3rd REGULAR session into the CURRENT room (the naive-3-party
  // vehicle). Exercises the daemon's onInvite; the container tool just sends {type:'invite', peer}.
  console.log('\n[19] in-band invite_peer → 3 regular sessions, one room')
  const I1 = mkClient(port, 'I1'), I2 = mkClient(port, 'I2'), I3 = mkClient(port, 'I3')
  I1.register(); I2.register(); I3.register(); await sleep(120)
  I1.send({ type: 'invite', peer: 'I3', id: 60 }); await sleep(120)   // no live room yet
  check('19a invite with no live room → invite-no-room', I1.frames.some((f) => f.type === 'ack' && f.id === 60 && f.status === 'invite-no-room'), JSON.stringify(I1.frames.filter((f) => f.type === 'ack')))
  I1.send({ type: 'ask', question: 'q', peer: 'I2' }); await sleep(150)   // open I1<->I2
  I3.clear(); I1.clear(); I1.send({ type: 'invite', peer: 'I3', id: 61 }); await sleep(150)
  check('19b invite acked invited', I1.frames.some((f) => f.type === 'ack' && f.id === 61 && f.status === 'invited'), JSON.stringify(I1.frames.filter((f) => f.type === 'ack')))
  st = await status(controlPort); const iRoom = roomBy(st, 'I1', 'I2')
  check('19c room is now 3-party (I1, I2, I3)', iRoom && iRoom.members.length === 3 && iRoom.members.includes('I3'), iRoom && JSON.stringify(iRoom.members))
  check('19d invitee I3 got the "added you" notice', I3.has('notice', 'added you to a room'))
  I1.clear(); I2.clear(); I3.send({ type: 'msg', text: 'hi all', id: 62 }); await sleep(150)
  check('19e invitee reply broadcasts to BOTH I1 and I2', I1.has('deliver', 'hi all') && I2.has('deliver', 'hi all'))
  I1.send({ type: 'invite', peer: 'I3', id: 63 }); await sleep(120)
  check('19f re-inviting a current member → invite-already', I1.frames.some((f) => f.type === 'ack' && f.id === 63 && f.status === 'invite-already'))
  // 19g — invite into a PAUSED room is REFUSED (Pierre's lead catch: would strand the invitee + their other rooms)
  const I4 = mkClient(port, 'I4'), I5 = mkClient(port, 'I5'); I4.register(); I5.register(); await sleep(100)
  await control(controlPort, 'brake', { roomId: iRoom.roomId }); await sleep(80)
  I1.send({ type: 'invite', peer: 'I4', id: 64 }); await sleep(120)
  check('19g invite into a paused room → invite-paused', I1.frames.some((f) => f.type === 'ack' && f.id === 64 && f.status === 'invite-paused'), JSON.stringify(I1.frames.filter((f) => f.id === 64)))
  st = await status(controlPort)
  check('19g2 the paused room did NOT gain the invitee', !(roomBy(st, 'I1', 'I2').members || []).includes('I4'))
  await control(controlPort, 'resume', { roomId: iRoom.roomId }); await sleep(80)
  // 19h — inviting a peer who's in ANOTHER live room pulls it in AND sidechannel-pauses that room (one-live-room, by design)
  I4.send({ type: 'ask', question: 'q', peer: 'I5' }); await sleep(150)
  I1.send({ type: 'invite', peer: 'I4', id: 65 }); await sleep(150)
  st = await status(controlPort)
  const iRoom2 = (st.pairings || []).find((p) => p.roomId === iRoom.roomId)
  check('19h invitee joined (now 4-party)', iRoom2 && iRoom2.members.includes('I4') && iRoom2.members.length === 4, iRoom2 && JSON.stringify(iRoom2.members))
  check('19h2 invitee\'s OTHER room sidechannel-paused (one-live-room)', roomBy(st, 'I4', 'I5') && roomBy(st, 'I4', 'I5').pauseReason === 'sidechannel', roomBy(st, 'I4', 'I5') && `${roomBy(st, 'I4', 'I5').state}/${roomBy(st, 'I4', 'I5').pauseReason}`)
  // 19i — invite_peer REFUSES a summoned adversary (Pierre4 from [14]); must use summon_adversary_to_room
  I1.send({ type: 'invite', peer: 'Pierre4', id: 66 }); await sleep(120)
  check('19i invite a summoned adversary → invite-adversary', I1.frames.some((f) => f.type === 'ack' && f.id === 66 && f.status === 'invite-adversary'), JSON.stringify(I1.frames.filter((f) => f.id === 66)))

  // 20 — #B: leave_room (member self-leave) — non-destructive dual of invite_peer / granular replacement for `end`.
  // Leaving an aside promotes your next room and PRESERVES history (drops the pairing only if it falls below 2).
  console.log('\n[20] leave_room: self-leave promotes your next room, keeps history')
  const L1 = mkClient(port, 'L1'), L2 = mkClient(port, 'L2'), L3 = mkClient(port, 'L3'), L4 = mkClient(port, 'L4')
  L1.register(); L2.register(); L3.register(); L4.register(); await sleep(120)
  L1.send({ type: 'leave', id: 70 }); await sleep(100)   // not in any room yet
  check('20a leave with no room → leave-none', L1.frames.some((f) => f.type === 'ack' && f.id === 70 && f.status === 'leave-none'), JSON.stringify(L1.frames.filter((f) => f.id === 70)))
  L1.send({ type: 'ask', question: 'q', peer: 'L2' }); await sleep(120)
  L1.send({ type: 'invite', peer: 'L3', id: 71 }); await sleep(120)   // L1<->L2 + L3 = 3-party
  st = await status(controlPort); const lRoomId = roomBy(st, 'L1', 'L2').roomId
  L3.send({ type: 'leave', id: 72 }); await sleep(120)
  check('20b L3 self-leave acked left', L3.frames.some((f) => f.type === 'ack' && f.id === 72 && f.status === 'left'), JSON.stringify(L3.frames.filter((f) => f.id === 72)))
  st = await status(controlPort)
  check('20c room back to 2-party (L3 gone, room + history kept)', roomBy(st, 'L1', 'L2') && roomBy(st, 'L1', 'L2').members.length === 2 && !roomBy(st, 'L1', 'L2').members.includes('L3'), roomBy(st, 'L1', 'L2') && JSON.stringify(roomBy(st, 'L1', 'L2').members))
  L1.send({ type: 'ask', question: 'q', peer: 'L4' }); await sleep(150)   // L1<->L4 newest → main L1<->L2 sidechannel-pauses
  st = await status(controlPort)
  check('20d opening the aside L1<->L4 sidechannel-paused the main L1<->L2', roomBy(st, 'L1', 'L2') && roomBy(st, 'L1', 'L2').pauseReason === 'sidechannel', roomBy(st, 'L1', 'L2') && `${roomBy(st, 'L1', 'L2').state}/${roomBy(st, 'L1', 'L2').pauseReason}`)
  L1.send({ type: 'leave', id: 73 }); await sleep(150)   // leave the aside → main auto-promotes
  st = await status(controlPort)
  check('20e leaving the aside auto-promoted the main room (L1<->L2 Running)', roomBy(st, 'L1', 'L2') && roomBy(st, 'L1', 'L2').state === 'Running', roomBy(st, 'L1', 'L2') && `${roomBy(st, 'L1', 'L2').state}/${roomBy(st, 'L1', 'L2').pauseReason}`)
  check('20f the aside (dropped below 2) closed to history — pairing gone, not destroyed-via-delete', !roomBy(st, 'L1', 'L4'), JSON.stringify((st.pairings || []).filter((p) => (p.members || []).includes('L4'))))

  // 21 — #6 (Pierre): a 3→2 leave must clear the stale N-party turn-cap, else it re-opens the 4176f86
  // resume-wedge through the members-shrink door (leave_room is the first path that shrinks members).
  console.log('\n[21] leave 3→2 clears the stale N-party turn-cap (no re-wedge)')
  const p21 = await findFreePort(port + 90), c21 = await findFreePort(p21 + 1)
  ensureRoom('leavecap', 'm1', 'm2')
  savePairings([{ roomId: 'leavecap', members: ['m1', 'm2', 'm3'], seq: 9, turn: 2, turnCap: 3, autoCatchup: true, state: 'Running', pauseReason: null }])
  const d21 = startRoomDaemon({ port: p21, controlPort: c21, notifyPort: 0, version: 'test21', idleMs: 9e8, tickMs: 9e8, stallMs: 9e8 })
  await sleep(150)
  const m1 = mkClient(p21, 'm1'), m2 = mkClient(p21, 'm2'), m3 = mkClient(p21, 'm3'); m1.register(); m2.register(); m3.register(); await sleep(150)
  m3.send({ type: 'leave', id: 80 }); await sleep(120)   // 3 → 2: the stale cap (3) must be cleared
  let lcst = await status(c21); let lcr = (lcst.pairings || []).find((p) => p.roomId === 'leavecap')
  check('21a room is 2-party after leave', lcr && lcr.members.length === 2, lcr && JSON.stringify(lcr.members))
  m1.send({ type: 'msg', text: 'past-cap', id: 81 }); await sleep(120)   // turn 2 → 3 == old cap; must NOT pause
  lcst = await status(c21); lcr = (lcst.pairings || []).find((p) => p.roomId === 'leavecap')
  check('21b 2-party room does NOT re-wedge at the stale N-party cap', lcr && lcr.state === 'Running', lcr && `${lcr.state}/${lcr.pauseReason} turn=${lcr.turn}/${lcr.turnCap}`)
  d21.stop()

  // 22 — #7 (Pierre): a member leaving a SHARED room <2 mid-adversary-boot deletes it; the booting adversary
  // must NOT reincarnate the gone shared room as a PRIVATE summoner↔adversary room (skipping the consent gate).
  console.log('\n[22] leave deletes a shared room mid-adversary-boot → adversary refused, not mis-homed')
  const p22 = await findFreePort(port + 95), c22 = await findFreePort(p22 + 1)
  ensureRoom('sharedtgt', 's1', 's2')
  savePairings([{ roomId: 'sharedtgt', members: ['s1', 's2'], seq: 9, turn: 1, autoCatchup: true, state: 'Running', pauseReason: null, incomingAdversary: { by: 's1', at: 1 } }])
  const d22 = startRoomDaemon({ port: p22, controlPort: c22, notifyPort: 0, version: 'test22', idleMs: 9e8, tickMs: 9e8, stallMs: 9e8 })
  await sleep(150)
  const s1 = mkClient(p22, 's1'), s2 = mkClient(p22, 's2'); s1.register(); s2.register(); await sleep(150)
  s2.send({ type: 'leave', id: 90 }); await sleep(120)   // 2 → 1: 'sharedtgt' drops <2 → deleted, reservation gone
  let s22 = await status(c22)
  check('22a shared room deleted on a <2 leave', !(s22.pairings || []).some((p) => p.roomId === 'sharedtgt'))
  const advX = mkClient(p22, 'advX'); advX.register({ summonedBy: 's1', room: 'sharedtgt' }); await sleep(150)
  s22 = await status(c22)
  check('22b adversary did NOT reincarnate the gone shared room (no private mis-home)', !(s22.pairings || []).some((p) => p.roomId === 'sharedtgt' || (p.members || []).includes('advX')), JSON.stringify((s22.pairings || []).map((p) => p.roomId)))
  check('22c adversary got a "no longer available" notice', advX.has('notice', 'no longer available'))
  d22.stop()

  console.log(`\n${'='.repeat(40)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(40)}`)
  d.stop(); ;[S, V, W, A, B, P, C, Dd, E, F, Pe, H, I, J, K, L, M, N, O, Q, R, T, U, A2, B2, A3, B3, rogue, X, Y, Z, A4, B4, P4, SS, Pr, AG, VIEW, TB, TC, TP, z1, z2, z3, I1, I2, I3, I4, I5, L1, L2, L3, L4, m1, m2, m3, s1, s2, advX].forEach((c) => { try { c.close() } catch {} })
  if (advRoom) try { removeRoomDir(advRoom) } catch {}   // private summons use a Date.now()-based id → clean it so runs don't accumulate
  try { rmSync(ageRepo, { recursive: true, force: true }) } catch {}
  await sleep(80)
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2) })
