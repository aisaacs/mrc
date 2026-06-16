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
const { savePairings, removeRoomDir } = await import(join(here, '../src/rooms.js'))

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

  // 13 — #3a: a reconnected multi-room session routes its bare reply to the LIVE room, not a braked one
  console.log('\n[13] reconnect routes to the live room')
  let X = mkClient(port, 'X'); const Y = mkClient(port, 'Y'), Z = mkClient(port, 'Z'); X.register(); Y.register(); Z.register(); await sleep(120)
  X.send({ type: 'ask', question: 'q', peer: 'Y' }); await sleep(100)
  X.send({ type: 'ask', question: 'q', peer: 'Z' }); await sleep(150)   // X<->Y braked, X<->Z live
  X.close(); await sleep(150)                                          // X drops → loses its activeRoom
  X = mkClient(port, 'X'); X.register(); await sleep(150)              // X reconnects (fresh session object, no activeRoom)
  Y.clear(); Z.clear(); X.send({ type: 'msg', text: 'after-reconnect', id: 5 }); await sleep(150)
  check('13a reconnected reply went to the LIVE room (Z), not the braked one (Y)', Z.has('deliver', 'after-reconnect') && !Y.has('deliver', 'after-reconnect'))

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

  console.log(`\n${'='.repeat(40)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(40)}`)
  d.stop(); ;[S, V, W, A, B, P, C, Dd, E, F, Pe, H, I, J, K, L, M, N, O, Q, R, T, U, A2, B2, A3, B3, rogue, X, Y, Z, A4, B4, P4, SS, Pr, AG, VIEW].forEach((c) => { try { c.close() } catch {} })
  if (advRoom) try { removeRoomDir(advRoom) } catch {}   // private summons use a Date.now()-based id → clean it so runs don't accumulate
  try { rmSync(ageRepo, { recursive: true, force: true }) } catch {}
  await sleep(80)
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2) })
