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
- **MERGED ROOT — socket-liveness ≠ delivery/binding (the real remaining rooms hole).** `send()`
  (room-daemon.js:237) is `if (!s.sock.destroyed) sock.write()` with **no else** — a frame to a flapping Pierre
  hits a destroyed socket (dropped) or a half-open one (`!destroyed` true → written into a dead pipe →
  vanishes), no redelivery on rebind. The container buffers OUTBOUND (`outQ` :221, flush-on-reconnect :288);
  the daemon has **no symmetric inbound buffer**. Same mistake as `lastPong fresh` in the heartbeat: socket
  state used as proof of facts it doesn't prove. **Fix (one root):** a per-session daemon inbound buffer with
  redelivery-on-rebind (mirror of `outQ`) and/or a delivery-ack, so a frame across a flap survives the ~16s
  reconnect. This subsumes the "~16s message-loss window" residual AND the pong≠binding trap. Latent-but-real
  (not the owner's current symptom — the bind succeeds 30/0), ticket-don't-fire. Grounded, Pierre-reviewed.
- **#t12b — the launch-lock 90s TTL** auto-clears mid-launch if a launch (cold `docker pull`) exceeds it → the
  zombie the lock guards against. Tie release to completion (`clearLaunchLock`/`.finally`), timeout as backstop
  only; **measure a cold-pull launch** before trusting the number. Orthogonal to #t12; separate change.
- **Automated post-rebuild plugin-load gate** — the load CLASS's real gate. Can't weld here (repo has no
  CI/build system), so it's **author-discipline: after any container-side change, rebuild + confirm the plugin
  loads.** The host load gate (`test/channel-load.test.mjs`) is the early-warning under it, never a substitute.
- **`update_notes` SHRINK** — `writeConsensus` full-overwrites, so a terse note replaces a detailed
  `consensus.md`; the empty-guard stops the erase, not the shrink. Fix: append-with-history / revision retention.
- **`escalate:"false"` means-true quirk** — `!!"false"` is true; deliberately NOT coerced (would flip the
  branch); fix as its own change with its own test.
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
