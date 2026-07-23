# Task Board — Mister Claude (team-first)

_Fresh snapshot **2026-07-21**. This is the durable, in-repo tracking doc — the source of truth for "where
we are," because the ephemeral task list keeps disappearing. Supersedes the stale 2026-07-03 merge-snapshot.
Numbering below is the CURRENT scheme (the pre-07-15 board used a conflicting, now-retired numbering)._

Deploy map (which change lands how):
- `mrc.js` / `src/` (except `room-daemon.js`) → **host-side, live on the next launch** (no rebuild).
- `src/proxies/room-daemon.js` → **`mrc rooms restart`** (the daemon holds its imported modules from boot).
- `container/` + `Dockerfile` + `entrypoint.sh` + `init-firewall.sh` → **`docker rmi mister-claude` + relaunch.**

---

## 🔴 Awaiting metal verification (owner runs; nothing to build)

- ✅ **t27 REDELIVERY FIX (`9a66100`) — GATE MET by an automated REAL-CONTAINER test (`20d1f18`), push-eligible.**
  The gate was "the exact broken scenario survives on a real container." `test/channel-server-live.test.mjs`
  now runs the ACTUAL `container/mrc-channel-server.js` as a subprocess (SDK stubbed, real socket, real
  createInboundDedup) against an in-process daemon, kills+respawns it (a genuine PROCESS restart → fresh dedup),
  and asserts it surfaces a message buffered-while-down — exercising resume-token + resequence + roomStillLive on
  the real container. Proven reproduce-first: RED without roomStillLive (discard) AND RED without resume() (gap),
  GREEN with both. This is STRONGER than the manual caged-consult re-run (repeatable + red-without-fix), so the
  manual metal is no longer the gate. The owner ALSO confirmed live consults work post-rebuild (multi-round
  volley). Push-eligible on the owner's call. (NOTE: the owner's own caged CONSULT delivery binds with `rooms=[]`
  — likely legacy/no-`room`, so its cause was the fresh-gap not roomStillLive; a small `rooms=[]`-for-consults
  question is open, see below.)

- **#t12 launch-lock fix — the CONCURRENT 2-project run (the decisive test).** `mrc rooms restart`, both
  projects up, a Pierre summoned in EACH, work **both simultaneously**. Pass = both stay usable, no forced
  dismiss/resume, no "already in flight." A single-Pierre run proves nothing (the empty-body half is already
  proven by this session's own Pierre consult). Sharp failure signal: a Pierre needs a reseat while its
  messages DO carry → concurrency-specific past the lock → grab the daemon `[register …]` logs + the
  socket-liveness root. (Pierre-converged; committed `185a9fd`.)
- **#50 cross-project login** — launch the same generalist (e.g. Claudine) in project A (log in), then B →
  should reuse `mrc-char-claudine`, no re-auth. Fix committed `331ff45`; char vols confirmed to exist.
- **#69 fresh-cast** — a genuinely-fresh cast/summon of Pierre shows the neutral `[starting a fresh consult
  — no prior conversation on record]`, not the old "conversation lost" alarm. Committed; needs a live look.

---

## ✅ Recently shipped (verified where noted; commits on `main`)

**t27 reliability outbox + two quick wins (2026-07-22..23, Pierre-signed). ✅ PUSH-ELIGIBLE — a live caged-consult
delivery FAILURE (2026-07-23) surfaced TWO real regressions in the shipped outbox, both fixed (`9a66100`) AND now
covered by an automated REAL-CONTAINER test (`20d1f18`) that's red-without-fix; the manual gate is superseded.** THE REGRESSIONS (both hit engine/consult redelivery on a
reconnect, both missed by the pure tests AND the legacy flap wiretest — the exact "container receive last-mile"
we labeled unproven; caught by a new register-seam integration test):
- **`roomStillLive` object→id (the PRIMARY cause of the owner's symptom).** flushOutbox's discard check was
  `roomsForSession(sid).includes(roomId)`, but that returns room OBJECTS → object-vs-string is ALWAYS false →
  EVERY engine frame (carries a `room`) was `discard`ed on redelivery + silently skipped. Legacy 2-party has no
  `room` field → spared → why the legacy flap wiretest went green while caged-consult redelivery was broken.
  Shipped in `4c9ef15`; fixed in `9a66100`.
- **Fresh-container gap.** A container PROCESS restart (session resume / crash) resets its dedup high-water to 0
  while the daemon's seq climbs → the fresh receiver holds every frame at an unfillable gap → surfaces nothing
  (regression vs pre-t27 which displayed any frame). Fix: a RESUME-TOKEN handshake — the container reports
  (epoch, highest) in register; the daemon FLAP (epoch===boot nonce → trim clamped ackSeq) vs FRESH (→ resequence
  pending to 1..K a highest-0 receiver accepts, enqueue-only pendingDeliveries flush, finally-cleared flag). All
  four mechanisms proven RED-without-fix at the register seam. Suite 713. **DURABLE: the register seam is where
  BOTH regressions lived, and both were invisible to unit + the mirrored wiretest — only a real engine member on
  the live register handler surfaced them. Daemon side now integration-covered; the SHIPPING container receive
  path (real createInboundDedup over a real socket) STAYS unproven (ticket).**

METAL COVERAGE — the EXACT truth (prior-run flap+restart legs via `claude-scripts/t27-wiretest.mjs`; the
caged-consult resume is the NEW decisive gate):
- ✅ **FLAP survival — METAL-PROVEN** (2026-07-22 wiretest), but via the LEGACY 2-party path (raw send() :1115),
  so it proves LEGACY reliability, not the engine outbox.
- ✅ **RESTART survival — METAL-PROVEN** (marker persisted on the durable set-edge; daemon self-restarted; the
  loud `[1 …lost across a daemon restart…]` fired). Non-vacuous — the old code had no marker.
- ⚠️ **The engine outbox ENTRY + the `pendingDeliveries`×outbox SEAM — UNIT-PROVEN + DETERMINISTIC, NOT
  metal-exercised.** This is the interaction the diff's bug lived in; the legacy flap test CANNOT cover it (no
  pendingDeliveries on that path). Pierre confirmed the register handler is fully synchronous → the two-buffer
  flush order is deterministic (not a race) and faithfully unit-modeled, and code-traced the wiring
  (bindSession flush → send?.→enqueue :290, flushOutbox re-lists after). Strong, but "reasoned + unit-covered,"
  NOT "watched on metal." → ticket below.
- ❌ **Container `observe→pushIn`/`renderFrame` last mile — UNIT/re-impl only, UNPROVEN.** The wiretest's
  B-client is a re-implementation of the dedup, so the shipping container's receive/render path
  (mrc-channel-server.js:324) is exercised by neither the unit test nor the wiretest. → ticket below.
- `4c9ef15` **reliable cross-session delivery** — per-session redelivery outbox: the daemon stamps reliable push
  frames (reliable-by-DEFAULT, opt-out ephemeral set) with a per-BOOT epoch + seq, buffers them, re-sends
  unacked on rebind; the container cumulative-acks the highest CONTIGUOUS seq + dedups. send() is the enforced
  sole emission point (static test, red-on-planted). Pierre caught TWO silent-loss bugs INSIDE the fix — the
  integration seam (bindSession's pendingDeliveries flush writes newer seqs live before flushOutbox re-sends
  older ones → jump-to-any-higher dedup swallowed them; fixed by contiguity) and the floor over-delete (resync
  dropped a frame the container was holding; fixed to deliver-what-you-hold, skip-only-true-holes). Loud
  loss-signals (overflow + a body-free persisted marker for restart-loss). Pure logic in `src/relay-outbox.js` +
  `createInboundDedup` → unit-tested as shipped (seam / overflow / floor-over-delete / restart-epoch / left-room).
  Same commit folds **update_notes shrink-safety** (writeConsensus retains the displaced body in an attributed
  `consensus.history.jsonl`). **Durable lesson, again: my read + Pierre's caught what 707 green tests couldn't,
  TWICE — reading necessary not sufficient; the wiretest must exercise the DEGRADED paths or it's a false green.**
- `b9ab9f1` **escalate:"false" no longer means true** — shared `parseEscalate` consumed by BOTH the container's
  answer-required predicate AND the daemon resolve branch (was `!!f.escalate`); closes the H2 path a stringly-
  false escalate used to slip. Separate commit per the decouple discipline, same rebuild.

**Rooms empty-message bug — the big one this session (metal-verified BOTH directions).** Peers arrived blank
for ~5 days: the model keyed `reply`'s body `message`, the server read only `a.text` → shipped `text:''`;
low-level MCP `Server` never validates inputSchema + the ack lied "Delivered." 7-round live-Pierre red-team.
- `753a345` guard/recover/refuse (schema-derived, `.trim()`-aware, opt-in `body:true` recovery, H2
  conditional predicate, `ask_peer` through the ack path, daemon relay belt) + enforcement tests.
- `eb233bc` fixed a self-inflicted import regression (`plugin:room:room · ✘ failed`) — caught only on the
  metal; the load gate now catches that class.
- `512ab36` a real **load gate** (stubs the SDK, actually `import()`s the server; proven to red-catch the
  regression) + dropped the every-message body logging.
- `1a38596` **pinned** `@modelcontextprotocol/sdk@1.29.0` (`--save-exact`) + enforcement test — an unpinned
  link-dep drifted on every rebuild. Full saga + lessons: `[[empty-body-channel-bug]]` (memory).

**#t12 caged-Pierre launch-lock cross-project false-block** (`185a9fd`) — `resumingConsults` keyed on the bare
`pierreHandle`; two projects whose summoners share the default `claude/claude` handle collide. Keyed on the
org-scoped `pierreSessionId` at all 3 sites; static regression guard; `[lock-block]` tripwire. Metal test above.

**Overnight run 07-15 (all Pierre-signed):**
- `f6dadae`/`1dc60f7` **#69** fresh caged consult no longer claims "conversation lost" (neutral line).
- `331ff45` **#50** deterministic generalist names (Claudine/Pascal/Solange/Guy) → stable char-slug → the
  char vol (`mrc-char-<slug>`, name-keyed, cross-project) persists the login. Was the owner's #1 daily pain.
- `f9aad94` **#59** reap a member/consult record when it LEAVES the org def (removemember/removeorg).
- `29a0537` **#70** authoritative-redefine reap-diff (builder team-define drops M → reap M + its orphaned
  caged-Pierre record; `authoritative:true`+capOk-gated; invert-limbo closed by construction).
- **#30** guard-2 = closed BY CONSTRUCTION (persona rides the untamperable `--member-def` blob). **#31**
  recurring characters = closed by #50 + the cast wiring.

**Caged-Pierre epic #56 + #66** (metal-verified) — summon-into-a-team / cast-add / resume / bug-C register-limbo
(`9e1512f`) / bug-D suspend→reopen (`503c9fc`) / #67 team.json consults (`540ef89`) / #68 viewer card
(`107345e`); **#66** shared caged-login (credential-slot pool + per-consult `~/.claude` + auth-profile sync;
`90c90dd`). Saga: `[[pierre-in-dashboard-blocker]]`.

**Also landed (recent):** ADMIN "Running sessions" task-manager (`41e97c4`/`71e88a6`); **#57** `--web`
end-to-end + `--web`-on-by-default for new projects (`091248a`/`4bb125a`); the spec-driven dashboard rebuild
(9 commits, Playwright-verified); SECURITY `4d548d6` (capOk-gate trusted-injection); MODEL B identity-off-repo
(#33); ESCALATION §14 + (d) triage; symmetric sessions (`c7f55b8`); guard-1 + guard-4 ttyd-unix-socket.

---

## ▶ Open / ticketed (build-when-picked)

### From the empty-body / rooms-reliability work (this session)
- ✅ **(was TICKET t27 gap 1) — ENGINE-PATH register seam — NOW INTEGRATION-COVERED (`9a66100`).** The
  `pendingDeliveries`×outbox interaction + the register/resume/resequence/roomStillLive paths are now driven on
  the LIVE daemon by `test/daemon-teams.test.mjs` (a real engine member; the receiver mirrors createInboundDedup).
  This is what caught BOTH `9a66100` regressions — the blackhole-proxy synthetic variant is no longer needed for
  the daemon side. (The container receive last-mile is still gap 2.)
- ✅ **(was TICKET t27 gap 2) — CONTAINER RECEIVE LAST-MILE — CLOSED (`20d1f18`).** The shipping container's
  `observe→createInboundDedup→pushIn/renderFrame` path with the REAL dedup over a real socket now has an automated
  test: `test/channel-server-live.test.mjs` runs the actual `mrc-channel-server.js` as a subprocess (SDK stubbed
  via the load-gate hook; the stub emits `SURFACED\t<content>` per pushIn under MRC_CAPTURE_SURFACED) vs an
  in-process daemon, kill+respawn = a real PROCESS restart. Red-without-fix for BOTH regressions. The inch both
  bugs hid in is now a red build, not a week of silent loss. **Owner directive that drove this: build automated
  container tests, never lean on a manual quit/resume/click when the path can be tested in code —
  [[prefer-automated-container-tests]].**
- **TICKET (small, new) — caged CONSULT Pierre binds with `rooms=[]`.** daemon.log shows `[register member BOUND]
  @pierre.claude-claude/claude → rooms=[]` for consult Pierres (vs a team member which lists its team room). Means
  consult delivery likely doesn't carry a `room` (legacy-ish path) → roomStillLive never applied to consults, so
  the owner's stuck-consult cause was the fresh-gap alone. Benign-looking but not understood; worth a look — is a
  consult member supposed to have its consult room in roomsForSession, and does anything (catch-up, discard,
  status) depend on it? Not blocking.
- ✅ **MERGED ROOT — socket-liveness ≠ delivery/binding — SHIPPED (`4c9ef15`, PUSH-READY; flap+restart
  metal-proven, seam unit-proven+deterministic — see the coverage verdict up in Recently-shipped).** Built as
  the per-session redelivery outbox + cumulative receipt-ack (NOT the
  originally-sketched in-memory inbound buffer — the design converged with Pierre through transcript-replay
  (rejected: the transcript has no per-recipient addressing) to a contiguous seq/ack protocol at the send()
  chokepoint, which covers the engine, the bind-flush, AND the legacy 1:1 pairing uniformly). Restart-durability
  is the loud persisted loss-marker (content-recovery = the ticketed follow-up below).
- **PERSIST THE RING (content recovery) — the t27 follow-up.** v1 makes restart-loss LOUD (a body-free marker);
  it does NOT redeliver the CONTENT across a daemon restart (the in-memory ring dies with the process). Persist
  the bounded ring per-org (reload on boot) to recover the frames, not just warn. Bounded + framed already, so
  it's cheap; deferred out of the reliability rebuild to keep the untrusted-body disk lifecycle out of it.
- **#t12b — the launch-lock 90s TTL** auto-clears mid-launch if a launch (cold `docker pull`) exceeds it → the
  zombie the lock guards against. Tie release to completion (`clearLaunchLock`/`.finally`), timeout as backstop
  only; **measure a cold-pull launch** before trusting the number. Orthogonal to #t12; separate change.
- **Automated post-rebuild plugin-load gate** — the load CLASS's real gate. Can't weld here (repo has no
  CI/build system), so it's **author-discipline: after any container-side change, rebuild + confirm the plugin
  loads.** The host load gate (`test/channel-load.test.mjs`) is the early-warning under it, never a substitute.
- ✅ **`update_notes` SHRINK — SHIPPED** (`4c9ef15`, folded into the reliability commit): displaced body retained
  in an attributed, bounded `consensus.history.jsonl`. (Open sub-nit, ticketed: a burst of trivial notes can
  evict real history at cap 10.)
- ✅ **`escalate:"false"` means-true quirk — SHIPPED** (`b9ab9f1`): shared `parseEscalate`. Bonus: it also closes
  the H2 answer-required bypass the quirk created.
- **General MCP-arg validation beyond string/number/bool** — enums/nesting are red-gated by the type-subset
  test (can't silently regress); implement if a tool ever needs a richer schema.
- **Stubbed-load SDK-rename caveat** — the load gate's SDK stub is a hand-maintained mirror; a real SDK export
  rename is caught only if the stub is updated (the pin makes that a deliberate, coupled moment).

### SoT / lifecycle (owner-deferred to AFTER the spec work)
- **#65 SoT census + make-it-structurally-impossible** — the owner suspects >2 sources of truth; sweep every
  session-meta reader/writer against the mirror-map (session-record.js header).
- **#63 session-state SoT** — Pierre's 3-axis: containment(done) / lifecycle-intent{active,suspended,dismissed}
  (new durable SoT) / liveness(DERIVED, never stored). Rule: never durably store what the socket owns.
- **#71 orphan-record GC** — the authoritative-by-construction sweep-all for CLI-drop/rename record lingerers.
  TWO required gates: (1) run only against a FULLY-LOADED orgDefs (never mid-boot → mass-reap); (2)
  TRANSIENT-EXEMPTION — a normal record reaps if its handle is in no orgDefs.members, but a TRANSIENT/adversary
  record reaps only if its ORG is gone (a suspended Pierre in a live org keeps its ▶Resume anchor). Both, or
  it's bug C a third time.
- **#60 / #61 mark-adversary couplings** — PARKED: no consumer (the mark-adversary feature doesn't exist). The
  doc-halves landed in the mirror-map; they wait for a real consumer.

### Older backlog (still real, carried over — verify before building)
- **Worker cage** — gate `ALLOW_WEB` task-workers through SNI/`HTTPS_PROXY` (a web-open worker on untrusted
  prompt text is a live exfil surface). Security-gated.
- **Daemon control-socket auth (F6)** — `127.0.0.1:controlPort` has capOk on state-changers but no transport
  auth; the one open remainder from the cage/summon audit.
- **Caged cross-repo Inc-3** — `ensureSeal` pre-flight + detached (`-d`) launch seal-kill-matrix. Rebuild-gated.
- **#54 manual-rooms** (live-Pierre §14 routing) · **#55 name-theme → Settings** (identity-coupled) ·
  **CONVERSATION-VIEW #49** (chat panel replaces the terminal — the big post-spec build) · **Telegram one-bot**
  (§6, `op://` token resolution) · guard-3 + 0700-dir assert (#24) · sha1/sockSlug collision (#26).

### Hygiene
- **Revert diagnostic aids** once the rooms work is fully settled: `[creds exit-sync]` daemonLog, consult-launch
  stderr capture, the `claude-scripts/*-diag.mjs` probes (gitignored). The `[relay-in]` every-message log is
  already dropped; `[tool-in]` (key-shape only) + `[lock-block]` + `[arg-drift]` are KEPT as permanent telemetry.

---

## Standing working rules

- **Commit autonomy in THIS repo** ([[commit-autonomy-mrc]]) — I run `git commit` directly as
  `Alexander Chang <awchang56@gmail.com>`, **no `Co-Authored-By` trailer**, no per-commit ping; free to
  build/commit/advance on convergence with Pierre. Pushing is still the owner's. (Elsewhere the default is
  stage-and-stop.)
- **Always work with Pierre** on correctness/containment-critical changes — `summon_adversary` (never the
  `/red-team` skill), red-team BEFORE staging; a green suite ships real bugs. Keep `/rename`.
- **Green host tests are necessary, not sufficient** — "a fix isn't done because it's green; it's done because
  it LOADED." Container-side changes need the rebuild + a live look; the metal is the only gate that has ever
  caught a load failure here.
- **Security/containment/mounts/firewall/isolation changes are human-gated** — discuss + get a nod.
- **Rank fixes by DURABLE + CORRECT**, never bias to the cheaper option to dodge a rebuild (rebuild = deploy
  timing only).
- **Measure, don't guess** — instrument + probe (host-diagnostic-script workflow); one probe answers the
  decisive fork; build the measurement to be able to come back "no."
- **Host diagnostic scripts:** write to `claude-scripts/` (gitignored), output timestamped to
  `claude-scripts/output/`, arm a background watcher. **Tell the owner the RELATIVE path, no leading slash:**
  `node claude-scripts/<name>.mjs` — never `/workspace/...` (the sandbox mount, unusable on their side). The
  owner can't read sandbox files — paste anything they must read into chat.
