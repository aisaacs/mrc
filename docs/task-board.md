# Task Board — Mister Claude (team-first)

_Snapshot at the `integration → main` merge (2026-07-03). Start a fresh session from this file: the
substance + all merge-blockers + all three wire-gates are **green**; everything below the line is
deferred/post-merge by decision. Context map: `docs/team-first-overview.md`. Next build:
`docs/dashboard-solo-workflow.md`._

Legend: **[post-merge]** the forward epic · **[deferred]** real but parked · **[gated]** needs owner
nod (security/isolation) · **[superseded]** don't build.

---

## ✅ Landed this cycle (verified)

- **Merge-blocker #64** — `pruneSessionRecords` no longer deletes a fresh session's security record
  (the launch-race that classified new sessions `unknown` → no peers, can't summon). Fixed via a
  prune-owned `<uuid>.seen` sentinel (prune never RMWs the record carrying the cage/trust bit → uncage
  closed by construction) + fresh-read + volume-reset guard + 1h age backstop. Pierre-verified 5
  rounds. **Wire-verified: `.seen` 0→57 on fresh launches, zero records eaten.**
- **#58** name propagation — daemon adopts a session's live auto-name as its display label. Committed +
  wire-verified (descriptive names, no hash-as-name).
- **D2 (#53)** caged-adversary resume — transcript persists (no more EROFS vaporization), exact-slot
  re-cage, in-session downgrade banner. Committed `c4598e1` + wire-verified (resume returns history +
  re-caged).
- **SNI cage seal** — re-verified on the wire (firewall rc7, foreign-SNI smuggle dropped, model
  reachable). ECH residual logged precisely: *starved by no-DNS + client-not-DoH, neither
  cage-enforced.*
- Earlier: the full pierre-hardening→teams-substrate re-port (host-record classification, register
  secrets, stable relay port, dead-room GC, naming fixes, cage) — all committed on `integration`.

## ▶ The merge itself

- **#52 — declare merge-ready + `integration → main`.** All gates green; this is the pull-the-trigger
  step. After it, `main` is the team-first trunk.

## ▶▶ Next build — the forward epic

- **#49 [post-merge] — dashboard-first solo workflow.** Work in a plain solo session inside the
  dashboard; pull in Pierre (caged) + cross-repo peers on demand. The engine already solves multi-room,
  so this **retires the legacy pairings path** rather than fixing it. Three pieces: (a) solo onramp =
  team-of-one with no roster ceremony; (b) Pierre-as-caged-member = summon moves onto the member-launch
  path (the load-bearing cage-port risk); (c) retire the pairings path. Full design +
  Pierre's pre-registered 4-point containment audit: `docs/dashboard-solo-workflow.md`.
- **#47 [superseded]** — Gap-D two-live-rooms reply misroute on the pairings path. **Do not build** —
  it dies with the pairings path under #49. Constraint banked in the design doc if it ever must live on.

## Deferred queue (real, parked)

**Security / cage:**
- **#13 [deferred, real hazard]** — worker cage: gate `ALLOW_WEB` task-workers through SNI/`HTTPS_PROXY`.
  The non-Claude worker path runs web-open with untrusted prompt text and no proxy — a live exfil
  surface. Must be caged before any hands-off worker use.
- **#6 [deferred]** — authenticate the daemon control socket (`127.0.0.1:controlPort` has zero app-layer
  auth; F6, tracked).
- **#55 [gated]** — a caged adversary can read all of `/workspace/.mrc` (the owner's dev transcripts);
  isolation change, needs owner nod.
- **#29 [deferred]** — allocation TOCTOU on proxy/ttyd ports + session-names write.

**D2 / adversary residuals (Pierre-found, narrow):**
- **#62** — route the D2 "started fresh, transcript lost" downgrade warning through the `@user` inbox
  (multi-surface), not just a model-context note.
- **#61** — D2 resume size-0-success + name-divergence edges.
- **#56** — caged transcript-store probe guards boot, not mid-session ENOSPC.
- **#54** — room re-pairing on adversary resume: summoner occasionally sees a "different Pierre"
  (ids/history mismatch). Owner-reported, needs a clean repro.
- **#48** — summon-vs-consult confusion: a live consult peer treated as the summoned Pierre. Likely
  falls out of the #49 substrate work.
- **#57** — can't summon Pierre while already in a consult room (one-room-per-session limit). Also
  resolved by #49's engine-native summon.

**Perf / infra:**
- **#63** — memoize `classifySession`/`loadSessionRecord` in the daemon (kills the per-message
  `readFileSync` in `deliver()`). Design: invalidate on register + close; keep the summon gate uncached.
- **#31** — port-change resilience: sessions follow a relay-port move without relaunch.
- **#32** — coverage-critic audit re-run (prove the ceiling, not just the floor).

**UX / objectives:**
- **#24** — spurious biometric prompts (twice on `mrc --rebuild`, once on `mrc rooms status`).
- **#34** — dashboard admin panel (daemon status/controls); low priority.
- **#9 / #10** — caffeine objectives: daemon-mode host caffeine; host-observed container CPU as the
  leading-edge solo-grind signal.
- **#66 [backlog] — resolve the Telegram bot token's `op://` reference so 1Password refs work.** The daemon
  reads `MRC_TELEGRAM_BOT_TOKEN` via `repoEnvKeyStrict`, which SKIPS any `op://` value — a detached daemon has
  no TTY for the `op` CLI Touch-ID prompt — so a 1Password-referenced token reads as "not configured" and the
  bridge never starts (today: put the LITERAL token in `<repo>/.env`). Fix: resolve the `op://` ref at solo/team
  **launch** (TTY + `op` session present) and thread the resolved value to the daemon per-org — `tgTokenFor`
  already falls back to a `tgToken[org]` map, so wire that. Keeps `op://` in the file; daemon still gets a usable
  token. Low-risk secret-plumbing (Pierre-glance for the per-org isolation, not a new inbound surface).

---

## Standing working rules

- **The owner always commits.** Stage precise paths + write a ready commit message (with the
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer), then stop.
- **Always summon Pierre via `mcp__plugin_room_room__summon_adversary`, never the `/red-team` skill.**
  Never re-port `/red-team`. Keep `/rename`.
- **Security/containment/mounts/firewall/isolation changes are human-gated** — discuss + get a nod.
- **Rank fixes by DURABLE + CORRECT**, never bias to the cheaper option to dodge a rebuild (rebuild is
  deploy-timing only).
- **Host diagnostics:** write a script to `claude-scripts/`, output timestamped to
  `claude-scripts/output/` (gitignored), read it back, delete when done. Give the owner a path relative
  to `/workspace`. The owner can't read sandbox files — paste anything they must read into chat.
- **Deploy map:** `mrc.js`/`src/` = host-side, live on next launch (no rebuild); `src/proxies/
  room-daemon.js` = `mrc rooms restart`; `container/` + Dockerfile + `entrypoint.sh` + `init-firewall.sh`
  = `docker rmi mister-claude` + relaunch.
