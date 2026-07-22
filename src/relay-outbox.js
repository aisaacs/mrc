// Per-session reliable-delivery outbox for the room daemon (the t27 socket-liveness≠delivery fix).
//
// WHY THIS EXISTS. The daemon's send() writes a frame to a socket if it looks alive (`!destroyed`), but a
// half-open socket across a macOS-nap FLAP passes that check and the write vanishes into a dead pipe — and
// the daemon acks the SENDER on ROUTE acceptance (room-daemon.js:723), never on recipient receipt, so the
// sender trims its own outQ believing the frame landed. Nobody knows it was lost. The receiver is the only
// party that can confirm delivery (end-to-end argument), so we add a cumulative receipt-ack: the daemon
// stamps reliable frames with (epoch, seq), holds the unacked ones here, and RE-SENDS them when the session
// reconnects+rebinds. The container cumulative-acks the highest contiguous seq it has surfaced; on that ack we
// trim. This closes the half-open window, bounded by the container's ~16s heartbeat teardown that forces the
// reconnect.
//
// This module is the PURE seq/trim/overflow/delay math ONLY — no sockets, no disk, no daemon state — so the
// unit tests exercise the exact shipping logic (the same discipline as mrc-channel-tools.js). The daemon owns
// the sockets, the boot-epoch nonce, the persistence marker, and the reap lifecycle.
//
// LIFECYCLE INVARIANT (Pierre trap A): a box is keyed on the LOGICAL sessionId and its whole purpose is to
// survive a socket close, so it is reaped ONLY when the SESSION is (transient reap / age-out), NEVER in the
// socket 'close' handler. Reaping on close would destroy the redelivery buffer at the exact instant of the
// flap it exists to survive — an elaborate no-op. `forget()` is the only reap; the daemon calls it from the
// session-reap paths, not from close.

// `epoch` is a per-BOOT nonce (NOT the code version — a crash-restart or an unchanged `mrc rooms restart`
// repeats the version, and the container would then dedup fresh post-restart frames against stale state →
// silent loss of the first N frames). Frames are stamped {epoch, seq}; the container resets its dedup state
// when it observes a new epoch, and a stale-epoch ack is ignored here.
export function createRelayOutbox({ cap = 64, epoch } = {}) {
  if (!epoch) throw new Error('relay-outbox requires a per-boot epoch nonce')
  // sessionId -> { seq, frames:[{seq, frame, at}], lossPending, lossCount, floor, touch }
  //   floor = the highest seq EVICTED on overflow. The stream is contiguous ABOVE floor; the container jumps its
  //   high-water to floor on any frame carrying it, so an overflow hole (frames the container can never receive)
  //   doesn't stall the contiguous dedup forever (Pierre: contiguity + overflow must not deadlock).
  const boxes = new Map()
  const box = (sid) => {
    let b = boxes.get(sid)
    if (!b) { b = { seq: 0, frames: [], lossPending: false, lossCount: 0, floor: 0, touch: 0 }; boxes.set(sid, b) }
    return b
  }

  return {
    epoch,

    // Stamp a reliable frame with (epoch, seq, floor) and buffer it. Returns { stamped, dropped } — `stamped` is
    // the frame the daemon writes (first attempt), `dropped` = how many oldest-unacked were evicted on overflow.
    // Overflow drops the OLDEST (unacked longest), advances `floor`, and raises lossPending so the next flush
    // emits a LOUD loss-signal — fail-loud, never silent truncation.
    enqueue(sid, frame, at) {
      const b = box(sid)
      const seq = ++b.seq
      b.frames.push({ seq, frame, at })
      b.touch = at || b.touch
      let dropped = 0
      if (b.frames.length > cap) {
        const gone = b.frames.splice(0, b.frames.length - cap)
        dropped = gone.length
        b.floor = Math.max(b.floor, gone[gone.length - 1].seq)   // everything <= floor is delivered-or-evicted
        b.lossPending = true
        b.lossCount += dropped
      }
      return { stamped: { ...frame, epoch, seq, floor: b.floor }, dropped }
    },

    // Cumulative ack: the container has surfaced everything through `seq` (in this epoch). Trim seq<=ackSeq.
    // A stale-epoch ack (from before a daemon restart) is ignored — its seq numbers refer to a dead stream.
    // Returns true iff the box became empty AND has no pending loss-signal (so the daemon can clear the marker).
    ack(sid, ackEpoch, ackSeq) {
      if (ackEpoch !== epoch) return false
      const b = boxes.get(sid)
      if (!b) return false
      b.frames = b.frames.filter((x) => x.seq > ackSeq)
      return b.frames.length === 0 && !b.lossPending
    },

    // Consume the loss-signal count (resets it). The daemon turns a nonzero return into a reliable `warning`
    // frame via enqueue(), so the signal itself is buffered+redelivered — it can't be the frame that's dropped.
    takeLoss(sid) {
      const b = boxes.get(sid)
      if (!b || !b.lossPending) return 0
      const n = b.lossCount
      b.lossPending = false
      b.lossCount = 0
      return n
    },

    // Frames to RE-SEND on rebind, in seq order, each carrying the CURRENT floor. A redelivered `directive` is
    // stamped redelivered:true + delayedMs (Pierre #6): a stale ORDER must read as delayed, never a fresh steer;
    // stale DATA is harmless-late. A frame whose room the session has since LEFT is marked `discard:true` (NOT
    // dropped — dropping would gap the contiguous stream forever): it keeps its seq so the container advances
    // the sequence and acks it, but the container does not surface it. So the room-skip lives container-side
    // (after counting the seq), compatible with contiguity — the daemon just supplies the authoritative flag.
    list(sid, now, roomStillLive) {
      const b = boxes.get(sid)
      if (!b) return []
      b.touch = now || b.touch
      return b.frames.map(({ seq, frame, at }) => {
        const out = frame.type === 'directive' && at != null
          ? { ...frame, redelivered: true, delayedMs: Math.max(0, (now || at) - at) }
          : { ...frame }
        out.epoch = epoch; out.seq = seq; out.floor = b.floor
        if (frame.room && roomStillLive && !roomStillLive(frame.room)) out.discard = true
        return out
      })
    },

    pending(sid) { const b = boxes.get(sid); return b ? b.frames.length : 0 },
    hasLoss(sid) { const b = boxes.get(sid); return !!(b && b.lossPending) },
    // count reported in the persisted marker / loss-signal text (frames still held + any already dropped)
    markerCount(sid) { const b = boxes.get(sid); return b ? b.frames.length + (b.lossPending ? b.lossCount : 0) : 0 },

    // Age-out support: the daemon sweeps sessions whose socket is gone AND whose box has been idle past a TTL
    // far longer than any flap/restart-reconnect window, so a never-returning session can't leak a box or a
    // stale marker (Pierre's smaller point). The daemon filters by "no live socket"; this exposes the age.
    sessions() { return [...boxes.keys()] },
    idleMs(sid, now) { const b = boxes.get(sid); return b ? (now - b.touch) : Infinity },
    forget(sid) { boxes.delete(sid) },
    _size() { return boxes.size },
  }
}
