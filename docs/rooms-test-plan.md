# Rooms — Tier 2 (A + B) smoke-test plan

Everything below is **BUILT but UNRUN** — parse-clean only. This is the gate before trusting any of it.
Companion to [`multiparty-adversarial-rooms.md`](./multiparty-adversarial-rooms.md).

## Pre-flight — apply the changes
The changes span both layers:
- **Channel server** (`container/mrc-channel-server.js`) → needs an **image rebuild**:
  `docker rmi mister-claude` then launch normally.
- **Daemon** (`src/proxies/room-daemon.js`, host) → `mrc rooms restart` (or it auto-refreshes on the next
  launch via its version stamp).
- **CLI** (`src/commands/rooms.js`) + **dashboard** (`src/rooms-dashboard.html`) → host-side; CLI is
  immediate, dashboard refreshes on daemon restart.

Do the image rebuild **and** `mrc rooms restart`, then `mrc rooms status` and confirm the daemon version
changed.

Evidence for pass/fail throughout: `mrc rooms status`, the dashboard, and each room's
`~/.local/share/mrc/rooms/<id>/thread.log`.

---

## 1. Regression — 2-party still works (the migration touched the core)
- [ ] **1a** Two sessions, `ask_peer`, volley 3–4 turns → replies route correctly both ways.
- [ ] **1b** `mrc rooms status` shows the room as `<name> <-> <name>` with state/turn; `brake` / `resume` /
  `steer --target <name>` / `end` all behave.
- [ ] **1c** Stall a 2-party room (or `mrc rooms catchup`) → both sides file handoffs → dashboard shows
  **both** catch-up panes. *(Exercises the new session-id handoff keying.)*

## 2. A — multi-room + the confidentiality-leak fix
- [ ] **2a** In a live S↔V room, say **"summon Pierre"** → Pierre opens in a new tab **without** closing the
  V room. `mrc rooms status` shows **two** rooms with S; the **V room auto-pauses** (`sidechannel`).
- [ ] **2b** Reply to Pierre → lands in the **adversary** room's `thread.log`, not V's. Then
  `mrc rooms end <pierre-room>` → the **V room resumes** and delivers anything held.
- [ ] **2c** (old latent bug) From one session `ask_peer` **two** different peers → your replies go to
  whoever you're actively in, not first-match.

## 3. B — clean 3-party adversary + consent (the headline)
- [ ] **3a** In a live S↔V room, say **"bring Pierre in"** / **"red-team this with the server"** →
  `summon_adversary_to_room` fires. **V's** session gets a **consent request** showing the brief path +
  provenance ("chosen & briefed by S, no prior context"). **Nothing joins yet**; `status` shows
  `⏳ adversary invite pending`.
- [ ] **3b** `mrc rooms accept <room>` (as V) → a **fresh** Pierre spawns **into the shared room** →
  3-party. Pierre's replies **broadcast** to both S and V; all three names show in `status`.
- [ ] **3c** Confirm `/rooms/<id>/adversary-brief.md` is the **open** brief (readable by all), and this
  Pierre carries **no** private S-context (fresh instance).
- [ ] **3d** Decline path: re-run 3a, then `mrc rooms decline <room>` → no adversary joins; S is told.
- [ ] **3e** Standing consent: `mrc rooms allow-adversary <room>`, then invite → **auto-accepts**, no
  prompt. (`--off` revokes.)

## 4. Invariant edge-cases (the state-machine corners most likely to hide a bug)
- [ ] **4a — stall vs sidechannel-brake:** while a room is `sidechannel`-paused (from 2a), let time pass →
  the stall timer must **not** double-pause or mis-resume it (it only acts on `Running` rooms).
- [ ] **4b — 3-member restart:** with a live 3-party room, `mrc rooms restart` → it round-trips with **all
  three** members + state (the 3rd isn't dropped).
- [ ] **4c — out-of-order end:** stack one session in 3 rooms (A→B→C), then `end` **B** → that session
  stays live in only one room (C); A doesn't wake while C is live. No thrash.
- [ ] **4d — ghost-membership thaw:** open a side-channel (the other room auto-pauses), then **close the
  multi-room session's terminal** → the other room **keeps delivering** (doesn't freeze forever). Twin:
  reconnect that session → its lower room re-brakes.

## Notes
- A storm-guard auto-pause (`>10` msgs / `20s` in a 3-party room) is **expected**, not a bug.
- **Deferred hardening (not a test, a decision):** inline the brief at `mrc rooms accept` / `status` so
  informed consent is hard to rubber-stamp. Provenance is already inline in the consent notice; the brief
  is currently a file pointer.
