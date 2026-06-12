# Rooms — live verification gate

The daemon **logic** is now verified by the in-process harness (`node test/rooms-daemon.test.mjs`, 35 checks)
and the **spawn path** is verified live (a real summon: tab opens under TCC, no re-auth, cold-start kickoff
fires). This plan is the gate the harness **can't** reach: real multi-session behaviour, the firewall, and —
the one that actually decides whether the feature works — **three live Claudes converging in a 3-party room.**
Companion to [`multiparty-adversarial-rooms.md`](./multiparty-adversarial-rooms.md).

## Pre-flight
- **Image rebuild** (`docker rmi mister-claude`) — picks up the channel server (new verbs) + the firewall.
- **`mrc rooms restart`** — picks up the daemon + the dashboard HTML.
- `mrc rooms status` → confirm the daemon version changed.

Evidence throughout: `mrc rooms status`, the dashboard, each room's `~/.local/share/mrc/rooms/<id>/thread.log`,
and (for the firewall) the summoned adversary's **boot log**.

## Already covered by the harness — don't re-test by hand
`node test/rooms-daemon.test.mjs` exercises, at the logic level: 2-party routing; the one-live-room invariant
(incl. resume/steer re-brake + reconnect-to-live); the consent reservation (double-summon reject,
unconsented-join refuse); ghost-membership thaw; out-of-order end; 3-member restart; stall-vs-sidechannel;
stormGuard; catch-up excluding the adversary. If it's green, focus the live run below.

## 1. Consent UX (the new default)
- [ ] **1a** In a live S↔V room, say **"bring Pierre in"** → he **joins immediately** (auto-accept default);
  all members notified; `status` shows 3 members. No prompt, no CLI.
- [ ] **1b** Turn on the checkpoint: `mrc rooms auto-accept <room> off` (or the dashboard `🤝 ⇄ 🛂` toggle).
  Summon again → now **pending**; V gets a `[CONSENT NEEDED]` notice; nothing joins yet.
- [ ] **1c** Approve it **three ways** (one each): say **"let Pierre in"** in V's session (natural language →
  `accept_adversary`); the dashboard **Accept** button; `mrc rooms accept <room>`. Each → Pierre joins.
- [ ] **1d** On a pending invite, **decline** (say "no" in V's session, dashboard Decline, or `mrc rooms decline`)
  → nothing joins; the summoner is told.

## 2. Hardened adversary firewall (can't be harness-tested — needs the real container)
- [ ] **2a** Summon Pierre; in his **boot log** confirm `Adversary firewall profile: runtime DNS will be
  dropped` + `api.anthropic.com reachable via pinned IP`.
- [ ] **2b** Pierre **boots and volleys normally** despite no `--web` / no statsig / no sentry. *(If he's
  degraded or won't boot, that's the statsig/sentry "hard edge" — add `statsig.com` back to the adversary
  allowlist in `init-firewall.sh` and re-evaluate.)*
- [ ] **2c** (optional, paranoid) From Pierre's container, confirm egress is dead: `curl https://example.com`
  fails, and a DNS lookup of a non-pinned host fails (port 53 dropped).

## 3. THE GATE — does a real 3-party actually work?
- [ ] **3a** Get three live Claudes into one room (S + V + a summoned Pierre). Confirm `addAdversaryToRoom`
  fired — the **consented-join branch, never run live before**: `status` shows 3 members and Pierre's replies
  broadcast to both.
- [ ] **3b** Let it run. Does it **converge / terminate**, or **storm-lock**? There is no turn-taking and no
  termination condition — Pierre's standing bet is a lock somewhere **north of turn 10**. The stormguard
  auto-pause (`>10` msgs / `20s`) is the safety net kicking in, **not** convergence. This is the empirical
  question the whole build rests on.

## Notes
- A stormguard auto-pause in a 3-party room is **expected** (the safety valve), not a bug.
- The consent default is **auto-accept**, coupled to one trust domain — if cross-machine rooms are ever built,
  that default must flip to require-consent (see the comment at `onSummonToRoom` in `room-daemon.js`).
