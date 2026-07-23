// t27 reliable-delivery protocol — unit tests for the pure daemon outbox + the container inbound dedup, and a
// full round-trip that models a flap and a daemon restart to prove no-loss / no-dup / loud-on-drop.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRelayOutbox } from '../src/relay-outbox.js'
import { createInboundDedup } from '../container/mrc-channel-tools.js'

test('outbox: stamps (epoch,seq) monotonically and returns the frame to write', () => {
  const ob = createRelayOutbox({ epoch: 'e1', cap: 64 })
  const a = ob.enqueue('s', { type: 'deliver', text: 'one' }, 1000)
  const b = ob.enqueue('s', { type: 'deliver', text: 'two' }, 1001)
  assert.equal(a.stamped.epoch, 'e1'); assert.equal(a.stamped.seq, 1)
  assert.equal(b.stamped.seq, 2)
  assert.equal(a.dropped, 0)
  assert.equal(ob.pending('s'), 2)
})

test('outbox: cumulative ack trims through seq; empties → returns true (marker can clear)', () => {
  const ob = createRelayOutbox({ epoch: 'e1' })
  ob.enqueue('s', { type: 'deliver', text: '1' }, 1); ob.enqueue('s', { type: 'deliver', text: '2' }, 2); ob.enqueue('s', { type: 'deliver', text: '3' }, 3)
  assert.equal(ob.ack('s', 'e1', 2), false)   // 3 still pending
  assert.equal(ob.pending('s'), 1)
  assert.equal(ob.ack('s', 'e1', 3), true)    // empty AND no loss → clearable
  assert.equal(ob.pending('s'), 0)
})

test('outbox: a STALE-epoch ack is ignored (its seq refers to a dead stream)', () => {
  const ob = createRelayOutbox({ epoch: 'e2' })
  ob.enqueue('s', { type: 'deliver', text: '1' }, 1)
  assert.equal(ob.ack('s', 'e1', 5), false)   // wrong epoch → no trim
  assert.equal(ob.pending('s'), 1)
})

test('outbox: overflow drops OLDEST + raises a loud loss-signal (fail-loud, never silent truncation)', () => {
  const ob = createRelayOutbox({ epoch: 'e1', cap: 3 })
  for (let i = 0; i < 5; i++) ob.enqueue('s', { type: 'deliver', text: `m${i}` }, i)
  assert.equal(ob.pending('s'), 3)                 // capped
  assert.equal(ob.hasLoss('s'), true)
  const list = ob.list('s', 100)
  assert.deepEqual(list.map((f) => f.text), ['m2', 'm3', 'm4'])   // oldest two evicted
  assert.equal(ob.takeLoss('s'), 2)                // two were dropped
  assert.equal(ob.hasLoss('s'), false)             // consumed
  assert.equal(ob.takeLoss('s'), 0)
})

test('outbox: list re-sends in order; a redelivered DIRECTIVE is stamped redelivered+delayedMs, data is not', () => {
  const ob = createRelayOutbox({ epoch: 'e1' })
  ob.enqueue('s', { type: 'directive', text: 'steer', room: 'r1' }, 1000)
  ob.enqueue('s', { type: 'deliver', text: 'data', room: 'r1' }, 1000)
  const list = ob.list('s', 6000)
  const dir = list.find((f) => f.type === 'directive'); const dat = list.find((f) => f.type === 'deliver')
  assert.equal(dir.redelivered, true); assert.equal(dir.delayedMs, 5000)
  assert.equal(dat.redelivered, undefined)         // stale DATA is fine, not marked
})

test('outbox: list MARKS a left-room frame discard (keeps its seq for contiguity); legacy no-room frames are never marked', () => {
  const ob = createRelayOutbox({ epoch: 'e1' })
  ob.enqueue('s', { type: 'deliver', text: 'left-room', room: 'gone' }, 1)
  ob.enqueue('s', { type: 'deliver', text: 'live-room', room: 'here' }, 1)
  ob.enqueue('s', { type: 'deliver', text: 'legacy-1to1' }, 1)   // no room → never discarded
  const list = ob.list('s', 2, (roomId) => roomId === 'here')
  assert.deepEqual(list.map((f) => f.text), ['left-room', 'live-room', 'legacy-1to1'])   // ALL frames flow (no gap)
  assert.equal(list.find((f) => f.text === 'left-room').discard, true)                    // but the left-room one is flagged
  assert.equal(list.find((f) => f.text === 'live-room').discard, undefined)
  assert.equal(list.find((f) => f.text === 'legacy-1to1').discard, undefined)
})

test('outbox: forget() reaps the box + age tracking for the daemon sweep', () => {
  const ob = createRelayOutbox({ epoch: 'e1' })
  ob.enqueue('s', { type: 'deliver', text: '1' }, 1000)
  assert.equal(ob.idleMs('s', 3000), 2000)
  ob.forget('s')
  assert.equal(ob.pending('s'), 0)
  assert.equal(ob._size(), 0)
  assert.equal(ob.idleMs('s', 3000), Infinity)
})

// t27 container-restart fix — resume()/maxSeq() (pure). The ORDERING hole (bindSession live-write before
// flushOutbox) is NOT reproducible here — that lives at the daemon register seam (see daemon-teams.test.mjs).
test('outbox: resume() resequences the pending set to contiguous 1..K, preserving order + at, floor=0', () => {
  const ob = createRelayOutbox({ epoch: 'e1', cap: 64 })
  ob.enqueue('s', { type: 'deliver', text: 'a' }, 1000)        // seq 1
  ob.enqueue('s', { type: 'directive', text: 'steer' }, 2000)  // seq 2 (carries `at` for delayedMs)
  ob.ack('s', 'e1', 1)                                          // trim seq1 → pending [seq2]
  ob.enqueue('s', { type: 'deliver', text: 'b' }, 3000)        // seq 3 → pending seqs [2,3] (high + gapped for a fresh receiver)
  ob.resume('s')
  const list = ob.list('s', 5000)
  assert.deepEqual(list.map((f) => f.seq), [1, 2], 'renumbered to contiguous 1..K')
  assert.deepEqual(list.map((f) => f.text), ['steer', 'b'], 'order preserved')
  assert.equal(list[0].floor, 0, 'floor reset for the new numbering')
  assert.equal(list.find((f) => f.type === 'directive').delayedMs, 3000, '`at` preserved → 5000-2000 delayedMs (renumber seq only)')
  assert.equal(ob.maxSeq('s'), 2, 'ob.seq updated to K')
})

test('outbox: resume() does NOT clear lossPending (a fresh-connect after an overflow still fires the loud warning)', () => {
  const ob = createRelayOutbox({ epoch: 'e1', cap: 2 })
  for (let i = 0; i < 4; i++) ob.enqueue('s', { type: 'deliver', text: `m${i}` }, i)   // overflow → lossPending
  assert.equal(ob.hasLoss('s'), true)
  ob.resume('s')
  assert.equal(ob.hasLoss('s'), true, 'loss state survives the resequence')
  assert.equal(ob.takeLoss('s'), 2, 'the dropped-count survives too')
})

test('outbox: maxSeq is the monotonic assign counter (ob.seq), not max of current frames — the clamp ceiling', () => {
  const ob = createRelayOutbox({ epoch: 'e1' })
  ob.enqueue('s', { type: 'deliver', text: '1' }, 1)
  ob.enqueue('s', { type: 'deliver', text: '2' }, 2)
  ob.enqueue('s', { type: 'deliver', text: '3' }, 3)   // ob.seq = 3
  ob.ack('s', 'e1', 2)                                 // trim seq1,2 → pending [seq3]
  assert.equal(ob.maxSeq('s'), 3, 'the assign counter, survives a trim')
  // a forged-huge ackSeq clamps here: min(9999, maxSeq) = 3 → can never trim past what was assigned
  assert.equal(Math.min(9999, ob.maxSeq('s')), 3)
})

test('inbound: non-reliable frame (no seq) is passed through untouched, no rcpt', () => {
  const d = createInboundDedup()
  d.observe({ type: 'pong', epoch: 'e1' })            // learns epoch
  const r = d.observe({ type: 'notice', text: 'hi', epoch: 'e1' })   // no seq
  assert.equal(r.reliable, false)
})

test('inbound: surfaces a new frame once, DEDUPS a redelivery, re-acks both', () => {
  const d = createInboundDedup()
  const first = d.observe({ type: 'deliver', text: 'x', epoch: 'e1', seq: 1 })
  assert.equal(first.reliable, true); assert.deepEqual(first.surface.map((f) => f.text), ['x']); assert.equal(first.ackSeq, 1)
  const dup = d.observe({ type: 'deliver', text: 'x', epoch: 'e1', seq: 1 })
  assert.deepEqual(dup, { reliable: true, surface: [], ackSeq: 1, forcedSkip: 0 })   // re-ack, don't re-push
})

test('inbound: CONTIGUOUS — an out-of-order frame is BUFFERED at the gap, then surfaces in order when it fills', () => {
  const d = createInboundDedup()
  const a = d.observe({ type: 'deliver', text: 'm1', epoch: 'e1', seq: 1 })
  assert.deepEqual(a.surface.map((f) => f.text), ['m1'])
  // seq 3 arrives before seq 2 (the two rebind write paths in the wrong order) — must NOT swallow 2 as a dup.
  const c = d.observe({ type: 'deliver', text: 'm3', epoch: 'e1', seq: 3 })
  assert.deepEqual(c.surface, []); assert.equal(c.ackSeq, 1)             // held at the gap, ack still 1
  const b = d.observe({ type: 'deliver', text: 'm2', epoch: 'e1', seq: 2 })
  assert.deepEqual(b.surface.map((f) => f.text), ['m2', 'm3']); assert.equal(b.ackSeq, 3)   // gap fills → 2 AND 3 surface, in order
})

test('inbound: floor RESYNCS past an unrecoverable overflow hole (so a gap can never stall contiguity)', () => {
  const d = createInboundDedup()
  d.observe({ type: 'deliver', text: 'm1', epoch: 'e1', seq: 1 })        // highest 1
  // the daemon evicted seq 2..4 on overflow → floor=4; seq 5 is the next real frame. Without floor, we'd wait
  // for 2 forever. With floor, we jump highest to 4 and surface 5.
  const r = d.observe({ type: 'deliver', text: 'm5', epoch: 'e1', seq: 5, floor: 4 })
  assert.deepEqual(r.surface.map((f) => f.text), ['m5']); assert.equal(r.ackSeq, 5)
})

test('inbound: floor DELIVERS a held frame it has, skips only the TRUE hole (Pierre floor over-delete)', () => {
  const d = createInboundDedup()
  d.observe({ type: 'deliver', text: 'm1', epoch: 'e1', seq: 1 })        // highest 1, acked
  // seq 6 arrived out-of-order — the container HOLDS it, blocked behind the gap at 2..5.
  const held = d.observe({ type: 'deliver', text: 'm6', epoch: 'e1', seq: 6 })
  assert.deepEqual(held.surface, []); assert.equal(held.highest ? d.highest() : 1, 1)   // buffered, nothing surfaced
  // overflow evicts 2..6 → floor=6. But 6 is IN HAND — it must be DELIVERED, not deleted. A frame carrying
  // floor=6 (seq 7) arrives: walk to 6 delivering the held 6, skip 2..5, then surface 7.
  const r = d.observe({ type: 'deliver', text: 'm7', epoch: 'e1', seq: 7, floor: 6 })
  assert.deepEqual(r.surface.map((f) => f.text), ['m6', 'm7'])   // the held 6 is delivered, not dropped
  assert.equal(r.ackSeq, 7)
})

test('inbound: held buffer is BOUNDED — a runaway un-fillable gap forces past + reports forcedSkip (fail-loud)', () => {
  const d = createInboundDedup({ heldCap: 4 })
  d.observe({ type: 'pong', epoch: 'e1' })
  // seq 1 never arrives (a daemon-bug gap with no floor); pile up 2..7 out of order (> cap of 4).
  const results = [2, 3, 4, 5, 6, 7].map((s) => d.observe({ type: 'deliver', text: `m${s}`, epoch: 'e1', seq: s }))
  const forced = results.find((r) => r.forcedSkip > 0)
  assert.ok(forced, 'forced past the stuck gap once the held buffer exceeded its cap')
  assert.ok(forced.surface.length > 0, 'and surfaced the buffered frames instead of holding forever')
  assert.deepEqual(d.highest() >= 6, true, 'the pileup drained after the forced skip')
})

test('inbound: a new epoch (daemon restart) resets the high-water — from a FRAME, not only the pong (trap C)', () => {
  const d = createInboundDedup()
  d.observe({ type: 'deliver', epoch: 'e1', seq: 40, text: 'a', floor: 39 })   // high-water 40
  // restart: fresh epoch e2 starts its seq at 1. If we didn't reset, seq 1 <= 40 would be wrongly deduped.
  const r = d.observe({ type: 'deliver', epoch: 'e2', seq: 1, text: 'b' })
  assert.deepEqual(r.surface.map((f) => f.text), ['b']); assert.equal(r.ackSeq, 1)
  assert.equal(d.epoch(), 'e2'); assert.equal(d.highest(), 1)
})

// The whole point: the protocol converges under a flap (redelivery) and a restart (epoch flip) with no lost
// message surfaced-twice and no dropped message going silent.
test('round-trip: flap redelivery is deduped; every surfaced message is unique and complete', () => {
  const ob = createRelayOutbox({ epoch: 'boot-A' })
  const d = createInboundDedup()
  const surfaced = []
  // helper: deliver an outbox frame to the container, applying dedup + acking back to the outbox
  const wire = (frame) => { const r = d.observe(frame); if (r.reliable) { for (const fr of r.surface) if (!fr.discard) surfaced.push(fr.text); ob.ack('s', d.epoch(), r.ackSeq) } }
  d.observe({ type: 'pong', epoch: 'boot-A' })
  wire(ob.enqueue('s', { type: 'deliver', text: 'm1' }, 1).stamped)
  wire(ob.enqueue('s', { type: 'deliver', text: 'm2' }, 2).stamped)
  // FLAP: m3 sent into a half-open socket — NOT acked. (We enqueue+"send" but the container never sees it.)
  const m3 = ob.enqueue('s', { type: 'deliver', text: 'm3' }, 3).stamped
  assert.equal(ob.pending('s'), 1)                   // m3 still unacked in the outbox
  // rebind: the daemon flushes unacked → the container finally sees m3 (once).
  for (const f of ob.list('s', 10)) wire(f)
  assert.deepEqual(surfaced, ['m1', 'm2', 'm3'])
  assert.equal(ob.pending('s'), 0)                   // m3 now acked → trimmed
  // a spurious redelivery of m3 (daemon didn't get the ack in time) must NOT double-surface.
  wire(m3)
  assert.deepEqual(surfaced, ['m1', 'm2', 'm3'])
})

// THE SEAM Pierre caught: at rebind, bindSession flushes pendingDeliveries through the SAME reliability send()
// (newer seqs) and writes them LIVE, THEN flushOutbox re-sends the older still-bound-window buffered frames. A
// jump-to-any-higher dedup would swallow the older frames as duplicates → silent loss. Contiguity must save it.
test('round-trip SEAM: newer seqs arrive live BEFORE older buffered ones — none are swallowed', () => {
  const ob = createRelayOutbox({ epoch: 'boot-A' })
  const d = createInboundDedup()
  const surfaced = []
  const wire = (frame) => { const r = d.observe(frame); if (r.reliable) { for (const fr of r.surface) if (!fr.discard) surfaced.push(fr.text); ob.ack('s', d.epoch(), r.ackSeq) } }
  d.observe({ type: 'pong', epoch: 'boot-A' })
  wire(ob.enqueue('s', { type: 'deliver', text: 'a1' }, 1).stamped)   // acked, highest 1
  // FLAP: still-bound-window frames a2,a3 written into a half-open socket — enqueued (seq 2,3) but never seen.
  ob.enqueue('s', { type: 'deliver', text: 'a2' }, 2)
  ob.enqueue('s', { type: 'deliver', text: 'a3' }, 3)
  // UNBOUND window then rebind: bindSession flushes pendingDeliveries through send() → they get seq 4,5 and are
  // written LIVE FIRST (before flushOutbox re-lists). Model that: enqueue m,n and deliver them to the container now.
  wire(ob.enqueue('s', { type: 'deliver', text: 'm4' }, 4).stamped)   // seq 4 — arrives while 2,3 still missing
  wire(ob.enqueue('s', { type: 'deliver', text: 'n5' }, 5).stamped)   // seq 5
  assert.deepEqual(surfaced, ['a1'])                                   // 4,5 are BUFFERED at the gap, nothing new surfaced
  // THEN flushOutbox re-sends everything unacked in order: [2,3,4,5].
  for (const fr of ob.list('s', 10)) wire(fr)
  assert.deepEqual(surfaced, ['a1', 'a2', 'a3', 'm4', 'n5'])           // the older buffered frames are NOT lost
  assert.equal(ob.pending('s'), 0)                                     // all acked
})

test('round-trip: a left-room frame is DISCARDED container-side (advances the seq, never surfaced) — no gap', () => {
  const ob = createRelayOutbox({ epoch: 'boot-A' })
  const d = createInboundDedup()
  const surfaced = []
  const wire = (frame) => { const r = d.observe(frame); if (r.reliable) { for (const fr of r.surface) if (!fr.discard) surfaced.push(fr.text); ob.ack('s', d.epoch(), r.ackSeq) } }
  d.observe({ type: 'pong', epoch: 'boot-A' })
  ob.enqueue('s', { type: 'deliver', text: 'stay', room: 'here' }, 1)
  ob.enqueue('s', { type: 'deliver', text: 'gone', room: 'left' }, 2)   // room the session leaves during outage
  ob.enqueue('s', { type: 'deliver', text: 'stay2', room: 'here' }, 3)
  for (const fr of ob.list('s', 10, (r) => r === 'here')) wire(fr)      // 'left' is no longer live
  assert.deepEqual(surfaced, ['stay', 'stay2'])                         // the left-room frame is not surfaced...
  assert.equal(ob.pending('s'), 0)                                      // ...but its seq WAS acked → no gap, box drains
})

test('round-trip: a daemon RESTART (new epoch) does not dedup the fresh stream against the old high-water', () => {
  const dOld = createRelayOutbox({ epoch: 'boot-A' })
  const d = createInboundDedup()
  const surfaced = []
  const wireFrom = (ob, ep, frame) => { const r = d.observe(frame); if (r.reliable) { for (const fr of r.surface) if (!fr.discard) surfaced.push(fr.text); ob.ack('s', d.epoch(), r.ackSeq) } }
  d.observe({ type: 'pong', epoch: 'boot-A' })
  wireFrom(dOld, 'boot-A', dOld.enqueue('s', { type: 'deliver', text: 'old-1' }, 1).stamped)   // high-water → 1
  wireFrom(dOld, 'boot-A', dOld.enqueue('s', { type: 'deliver', text: 'old-2' }, 2).stamped)   // high-water → 2
  // RESTART: a brand-new daemon, fresh boot nonce, seq restarts at 1.
  const dNew = createRelayOutbox({ epoch: 'boot-B' })
  wireFrom(dNew, 'boot-B', dNew.enqueue('s', { type: 'deliver', text: 'new-1' }, 3).stamped)   // seq 1, epoch boot-B
  assert.deepEqual(surfaced, ['old-1', 'old-2', 'new-1'])   // new-1 (seq 1) NOT swallowed by the old high-water (2)
  assert.equal(d.epoch(), 'boot-B'); assert.equal(d.highest(), 1)
})
