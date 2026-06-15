# Spec — deprecating `mrc rooms end` (connectivity-derived room liveness)

Status: **FINALIZED 2026-06-15** — Pierre-reviewed; #7 (the human hard-stop) resolved to **pure-C**. This is the build spec for Phase 1. Supersedes the 2026-06-12 draft.

## Why

`mrc rooms end` is the human-only way to close a room. In practice it's never run *voluntarily* — only when *forced*, because a stale/disconnected room blocks a fresh summon (the "zombie-block," hit **3× in one session**). Its original rationale — preserving consensus before closing — never held: `thread.log` + `consensus.md` persist on disk regardless, and peer rooms re-open **deterministically** (the room id hashes the two conversation UUIDs) when the same two sessions reconnect. So `end` mostly adds friction and buys little.

## Core principle

**Room liveness is *derived from member connectivity*, not stored as explicit lifecycle state.** A room is *live* iff ≥1 member socket is currently connected; otherwise it's *dormant* (history). Nothing needs to "end" a room — a room with no connected members simply isn't live.

This is already half-true: the one-live-room invariant (`recomputeSidechannelBrakes`) keys off connectivity, and the summon guards now ignore disconnected ("ghost") adversaries (the #4 fix, committed). Deprecation *generalizes* that — but the generalization has to land at one specific spot (the keystone) or it breaks routing.

## The keystone — `hasOtherConnected` (Pierre review)

The brake and routing logic must derive liveness from *a connected counterparty*, not from `state` or a mutable label. One helper:

```
hasOtherConnected(room, self) = room.members.some(o => o !== self && sessions.has(o))
```

composed **two ways** (NOT one identical predicate — the subtlety Pierre caught):

- **Routing** (`activeRoomFor` — the explicit-active branch + the live-filter): `state === 'Running' && hasOtherConnected(p, id)`. Without the `hasOtherConnected` half, a member whose newer room went dormant still routes a bare reply into the **grave** — the corpse room stays `state === 'Running'` because nothing ever brakes the highest-seq room.
- **Brake** (`recomputeSidechannelBrakes`): `hasOtherConnected(r, m)` — and it must **NOT** read `r.state`. `recompute` *sets* state, so reading it inside the predicate is order-dependent/circular; that's exactly why the current code keys on immutable `seq` + connectivity.

This single atom discharges three things: **#5** (a dormant room no longer brakes a live one), the `activeRoomFor` routing audit, and the dormant-vs-live generalization. **Build it first.**

## What changes

1. **Blocking / guards** — only *live* rooms count (the keystone). A dormant room never blocks a summon, a pairing, or the one-live-room slot. (#4 connectivity-aware summon guards: done + committed.)

2. **`mrc rooms end` — REMOVED entirely, with no replacement** (the #7 decision — below). Drop the CLI subcommand, the `end` control action, and the agent-facing "only the human can end a room" framing. Manual cleanup of *peer* history moves to a dashboard delete (#4).

3. **Pairing retention** — pairings persist across disconnect (restored on restart). A dormant peer pairing re-activates automatically when both members reconnect (deterministic id + persisted pairing). No data loss, no manual re-open.

4. **Reaping — TWO reapers, different triggers** (Pierre review: the original single disconnect-grace was blind to half the garbage):
   - **Connected-then-disconnected adversary → disconnect-grace reap.** On the adversary's socket close, stamp `disconnectedAt` on the pairing (**persisted**, not a `setTimeout` — a one-shot timer dies on `mrc rooms restart` and orphans the room). A periodic **tick** reaps adversary rooms whose `disconnectedAt` is older than the grace (~45s) with no reconnect. Cancel = `disconnectedAt` cleared on reconnect (the relaunched adversary re-registers carrying its `--room` id, so the match survives the non-deterministic room id).
   - **Never-connected summon reservation → reservation-expiry reap.** A summon that *never opened a socket* (failed boot) has **no pairing and no socket**, so the disconnect-grace can't see it — it leaks an orphaned `adversary-<sha>` dir (the zombie hit live 3×). On the reservation timeout (`summoningPrivate` / `incomingAdversary`, ~90s) **with no connection ever made**, **unlink the orphaned room dir**. Different layer, different trigger from the disconnect-grace — they are not the same reaper.
   - **Peer rooms** (deterministic id, re-openable) → **retain forever as dormant history** + a **dashboard "delete" control** for on-demand pruning (the only sanctioned manual cleanup, replacing `rooms end`).

5. **Status / dashboard** — show LIVE (≥1 connected) vs DORMANT (0 connected, re-openable) vs reaped, all derived from connectivity. No "closed" state required.

6. **Turn-miscount fix** (Pierre review; folds in because it touches the same pause/brake machinery): move `p.turn += 1` **past** the hold-gate in `onMsg`/`onAsk` (factor `increment + cap-check` into one post-deliver `countTurn(p)`). Today a message held under a pause still burns a budget turn, and the turn-cap can be crossed *silently* while held. Keep `lastActivityAt` **before** the gate (a held message is still activity).

## #7 — the human hard-stop: RESOLVED to **pure-C** (dropped, no replacement)

Pierre's #7: removing `end` drops the human's *irreversible* hard-stop for a LIVE room (`brake` is agent-reversible — either agent can `resume_room`; `steer` doesn't stop). Decision (2026-06-15): **we don't need it.**

- **Rooms are your own sessions** — there is no adversary to forcibly cut off. The natural, irreversible stop is **closing the tab**: the session disconnects → the room goes dormant. Under connectivity-derived liveness, *that is the stop.* "Stop this room" and "close this session" collapse into one act.
- A "human-locked, stays-stopped-but-connected" state would **re-introduce the explicit lifecycle** we're deleting `end` to remove — philosophically backwards.
- The need was *reasoned, not observed* (the pattern that also killed "name on Max"): no one has ever actually needed to hard-stop a live room without closing it.
- `brake` already halts instantly; the only residual is the *theoretical* "an agent re-resumes against you," and a well-behaved agent should not resume a room its own human braked.

**Deferred option (NOT building now):** if agents ever *do* undo human brakes in practice, a ~1-line guard makes a human `brake` agent-irreversible (`onAgentResume` skips `pauseReason === 'brake'`; only `mrc rooms resume` clears it). It's correctness-not-feature (a human directive should outrank an agent action) and nearly free — but deferred until a real case is observed, to keep `brake` a simple soft pause.

## Risks / things to verify

- **Keystone routing:** confirm `activeRoomFor` (explicit-active branch AND live-filter) gates on `hasOtherConnected`, so a bare reply never routes into a dormant `Running` corpse.
- **Brake circularity:** the brake predicate must NOT read `r.state` — only `seq` + `hasOtherConnected`.
- **Reap vs in-flight summon:** never reap while the adversary is still booting (the `incomingAdversary`/`summoningPrivate` window). Reservation-expiry reap fires only when the reservation times out *without* a connection.
- **Reap survives restart:** `disconnectedAt` persisted (not a `setTimeout`); the periodic tick re-evaluates after a restart.
- **Resume:** a dormant peer room must re-pair on reconnect (deterministic id + persisted pairing — verify end-to-end).

## Rollout

- **Phase 1 (the build):** the `hasOtherConnected` keystone (→ #5 brake-liveness + `activeRoomFor` routing) + **both reapers** (disconnect-grace via persisted `disconnectedAt` + tick; reservation-expiry dir-reap) + **remove `rooms end`** (CLI + control action + framing) + **dashboard delete** for peer history + the `countTurn` turn-miscount fix. #7 = pure-C (nothing to build). Build as ONE coherent, **tested** pass.
- **Phase 2:** generalize liveness across status/dashboard + optional peer-room dormancy prune.
- **Phase 3:** verify the one-live-room invariant + peer-room resume hold under real multi-session load.

## Decisions (2026-06-12; #7 + the Pierre-review refinements added 2026-06-15)

1. **`rooms end`: removed entirely** — not kept as a soft "forget." The dashboard delete covers the one remaining manual-cleanup case.
2. **Adversary-room reaping: GRACE (~45s) via persisted `disconnectedAt` + a periodic tick** — NOT a one-shot `setTimeout` (dies on `mrc rooms restart`, orphans the room) and NOT hard-on-disconnect (a restart drops every socket momentarily, so a hard reap deletes every adversary room in the gap; non-deterministic ids mean a wrongly-reaped room never re-opens). The #4 guard already ignores disconnected adversaries, so the grace adds **no** blocking downside.
3. **A SECOND reaper for never-connected summon reservations** — the disconnect-grace is structurally blind to a summon that never opened a socket; reap its orphaned dir on reservation-expiry.
4. **Peer rooms: kept forever as history** + a dashboard delete for on-demand pruning.
5. **#7 human hard-stop: pure-C — dropped, no replacement.** The stop is close-the-tab/disconnect. The 1-line "human-brake-is-authoritative" guard is deferred until a real need is observed.

## Not yet built
Phase 1 is **spec'd, not implemented** as of 2026-06-15. Only the #4 connectivity-aware guards are done + committed. Everything else (keystone, both reapers, dashboard delete, remove-`end`, `countTurn`) is the Phase 1 build.
