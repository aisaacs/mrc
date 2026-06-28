# Architecture Review — Room + Team Daemon

**Status: CAPTURE-ONLY.** No code was changed. This is a findings + recommendations document to act on later, commissioned 2026-06-28. Sources: ultracritical static pass (Florent), adversary dynamic pass (Ghislaine), two independent code-mapping passes (architect), correctness pass (Roland). All findings cite `file:line`.

---

## 1. Executive summary

The room/team daemon works, but its "brittle" feel is real and has **four convergent root causes** — and the same handful of small, high-leverage fixes resolve most findings at once. Most of this session's bug-detours (stale daemon, CSRF-after-restart, token bleed/409 storm, silent Telegram outbound, the live "offline churn") are symptoms of these same four roots, not independent bugs.

The single most valuable structural move — collapsing the two parallel relay engines into one — is *net code-negative* (deletes ~250–300 lines) **and** delivers the deferred heartbeat/stall feature (#26) for free.

### The four roots (each independently found by ≥2 reviewers)
- **R1 — No per-connection identity/trust secret** (identity is a *deterministic* id; trust is an *in-band string*). Explains: D1 live offline-churn · D11 member impersonation · A1 trust-marker forgery (all of `trust.js`). Fix: per-launch random token as the binding key + an **unforgeable rendered** trust envelope (`source="human"` vs `source="room"`).
- **R2 — No atomic persistence** (every state file is in-place `writeFileSync`; torn writes read back silently-empty). Explains: D2 torn-write data loss · D3 · D7 TG replay. Fix: one `temp→fsync→rename` + quarantine-on-load helper (~20 lines kills the class).
- **R3 — Two parallel relay engines** (legacy 2-party `pairings` vs the N-party `engine`, each with its own brake/resume/turn-cap/held/stall + control dispatch). Explains: D6 wrong-peer routing · feature asymmetry (stall + catch-up exist for legacy only) · most accidental complexity. Fix: collapse legacy into the engine as 2-member `kind:'consult'` rooms ("consult = degenerate team").
- **R4 — Silent-failure / stand-in-for-a-real-abstraction class.** Explains: stale daemon (version-stamp hashes 1 of ~10 files) · one throw nukes everything (no `uncaughtException`) · unpersisted workerQueue/tgPushed · swallowed appends · `onSay` false 'delivered' · blocking `execFileSync(docker)` on the loop. Fix: fail-loud + observable; version-stamp the dep closure; supervised daemon; async subprocess.

### Two free payoffs from R3 (the collapse)
- **Root cause of the live "you were all stopped" incident** = team rooms have **no stall detection** (only legacy pairings do). Moving stall/catch-up onto the engine fixes it for all rooms.
- That same move **is** the deferred **#26 heartbeat/stall-recovery** — it falls out of the collapse instead of being built greenfield.

---

## 2. Findings inventory (severity-tagged)

### HIGH
- **D1 — Deterministic sessionId nulls a fresh binding on reconnect.** `memberSessionId=sha1(org\0handle)` is identical across restarts (session-id.js:19). New socket binds; the OLD socket's late `close` → `unbindSession` guard `m.sessionId===sessionId` is true → nulls the just-rebound session + deletes `bySession[SID]` → member reads **offline while connected** (room-engine.js:163-179, room-daemon.js:566). ≈ root cause of the live "[Joined as @x]" churn. *Fix: per-connection nonce as the binding key.*
- **D2 — Zero write atomicity.** All `rooms.js` writes are in-place `writeFileSync` (room.json:32/47/58, consensus:107, catchups:123/131, pairings:142, orgs:158, inbox:171, telegram:182, launches:192). Crash mid-write truncates; try/caught readers silently return empty → invisible loss of pending @user questions / org defs / TG pairing. *Fix: temp→fsync→rename + quarantine-on-load.* (`writeFileSync` blocks the loop, so there is **no** concurrent-write race — only crash-atomicity is the issue.)
- **Version-stamp covers 1 of ~10 files (restart-safety defeated).** `daemonVersion()` hashes only `room-daemon.js` (pair.js:22-24; daemon stamp:818) — not its imports (room-engine, trust, telegram, telegram-auth, worker-runner, rooms, roster, media). Editing any of those leaves the version unchanged → `mrc rooms restart`/auto-refresh sees "same version" and serves **stale code**; the #21 probeVersion fix can't even detect it. The deeper root cause of the stale-daemon hours; makes CLAUDE.md's "host-side src/ changes ride the daemon reload" false except for room-daemon.js. *Fix: hash the dependency closure (all `src/**/*.js`).*

### MED-HIGH
- **D11 — Member impersonation / session hijack via `register`.** The register frame trusts a self-claimed `memberHandle` with no secret; `orgsWithHandle` fallback binds on the handle alone; `engine.bindSession` overwrites a teammate's binding (room-daemon.js:531-543). The relay port is exposed to every container as `host.docker.internal:MRC_ROOM_PORT` (firewall-whitelisted) and agents run `--dangerously-skip-permissions` + full bash → any member can register **as** any teammate. Same root as D1. **Blast-radius nuance:** the "all peer messages are untrusted; only `⦉quoted “Human directive”⦊` is authoritative" design *bounds* this — a spoofed @architect still cannot mint a `⦉quoted “Human directive”⦊` (those come from the control-socket steer path). So it is **not** human-authority escalation; it **is** a confidentiality + impersonation + availability break. *Fix: per-launch token required on register/say.*

### MED
- **No `uncaughtException` handler; unwrapped dispatch.** `sock.on('data')` dispatch (room-daemon.js:526-564) and `engine.route` in `onSay` (314) are unwrapped → one throw takes down every org + dashboard + all Telegram bridges (single failure domain). *Fix: top-level handler + per-frame try/catch.*
- **Dual relay implementations (R3).** Two brake/resume/turn-cap/held/stall paths (daemon 391-507 + 784-794 vs engine 253-375) + duplicate control dispatch (team block 737-744 vs legacy `pick()` 755-776). Guaranteed drift.
- **Feature asymmetry.** Stall auto-pause (daemon:784-794 iterates `pairings`) + catch-up panes (elicitCatchup/onHandoff 442-491) exist **only** for legacy pairings; team rooms get neither — yet CLAUDE.md advertises catch-up for "all rooms." (Unimplemented-feature gap + doc-accuracy bug.)
- **Offline live-member directive mis-route.** `answerUser`/`doSteer` decide live-vs-queue with a bare `if (m?.sessionId)` (engine:382-384, 439-441), bypassing `deliverTo`'s tier check (246) → a live Claude member momentarily offline gets its `⦉quoted “Human reply”⦊`/directive shoved into the workerQueue and spawned as a one-shot worker (worker-runner.js:52-63); no path to deliver to a live member that reconnects later. *Fix: funnel all delivery through `deliverTo`; queue-for-live-reconnect.*
- **Non-transactional org mutation.** `defineOrg` rewrites orgDefs + sessionIndex + ensureTgForOrg + writeTeamFile non-atomically (room-daemon.js:162-171). Refined: adding *distinct* orgs is safe; the real residual risks are **same-org** concurrent read-modify-write (addMember vs removeMember) and fire-and-forget `writeTeamFile` desyncing team.json from the engine.
- **Blocking subprocess on the event loop.** `execFileSync('docker')` + `teamMod.tmuxWindows` run synchronously per org on every dashboard `/api/teams` poll (daemon:36-43, 603-606) → a slow Docker/tmux freezes all relays + Telegram. *Fix: async-spawn or cache.*
- **D4 — Restart kill-escalation dance brittle.** graceful→SIGTERM→SIGKILL→poll→waitUpVersion (pair.js:74-128); depends on right pid + poll timing. A supervised single daemon retires it.
- **D5 — Control socket unauthenticated (honest caveat).** `control.listen(controlPort,'127.0.0.1')` (daemon:781); no token on steer/end/killsession/launchteam/removeorg. **Loopback-only and a browser cannot open a raw TCP socket → NOT remotely/browser-exploitable**; the real statement is "any local process == the human" (fine single-user). *Action: document the assumption; the firewall must never expose controlPort.* (The dashboard HTTP layer that proxies to it IS properly gated — see §"solid".)

### LOW-MED
- **D7 — TG mark-processed not transactional** with its side-effect → crash before persist replays the update → a second `⦉quoted “Human directive”⦊` (daemon:251). Same root as R2.
- **D8 — workerQueue + in-flight worker invocations not persisted** → crash loses queued/running work silently. **tgPushed map also not persisted** → after restart a Telegram reply can't map to its #N and is treated as a fresh broadcast directive (daemon:256-257). (Task #16 intended to persist tgPushed; only the inbox actually landed.)
- **Telegram >4096 "message too long" — CONFIRMED LIVE (2026-06-28).** A long inbox item is sent **raw** to `tgSend` (daemon:283) with no truncate/chunk, so it 400s "message is too long" and never reaches the phone; the H4 `tgEdit` path (:289) has the same gap (a long item's resolve/reopen edit would 400 too). The real error IS captured in `lastPushError` (:285) + logged, but the **dashboard misdiagnoses it** — it wraps the length-400 in a generic "stale chat / re-link" hint. *Fix (#22 backlog):* **TRUNCATE the item text to fit one message, do NOT chunk** — the reply→answer mapping keys on the single pushed `messageId` (`reply_to_message_id`), so splitting into multiple messages breaks the reply mapping; keep the `#N` + reply-hint framing and the single messageId, and apply the same cap to `tgResolvedText`/`tgEdit`. Surface `r.error` verbatim in `tgView` (only suggest "re-link" for an actual auth/chat-not-found). Pairs with the 429/`retry_after` item.
- **Worker invoke timeout leaks children; media generation has no per-call timeout** (daemon:58).
- **Unbounded growth / full-file reads per poll.** userInbox never pruned; `/api/room` reads the entire thread.log + transcript.jsonl every poll (dashboard:223); no log rotation.

### LOW
- **D3 — `room.json` load has no try/catch** (rooms.js:46/53/61); one torn file throws the whole `listRooms` enumeration (and 500s dashboard requests via knownRoom→listRooms→loadRoom). *(Closed by F2's `loadJsonFile` — `loadRoom` now degrades to a fallback meta. **Behavior note R2:** because `loadJsonFile` quarantines a corrupt file on READ and `listRooms` filters by `existsSync(room.json)`, a quarantined torn room.json drops out of the dashboard list entirely — degraded, not crash — so that room silently disappears from the UI rather than showing a degraded entry. Acceptable.)*
- **D9 — Idle-exit can drop a connection in the exit window** (daemon:799); self-heals via 1.5s reconnect.
- **prePin implicit invariant** — sets chatId=fromId=CHAT_ID (daemon:217 vs telegram-auth:101); correct only because TG private chat.id==from.id. Document or accept the explicit pair only.

### What's actually solid (preserve in any redo)
- **Dashboard HTTP surface is well-defended:** path traversal closed (`knownRoom` whitelists roomId vs `listRooms`, no `../`, rooms-dashboard.js:46); CSRF token 0600-persisted + required on every state-changing POST (122); same-origin prevents cross-origin read. This is why D5 is not browser-reachable.
- Telegram offset-advance-only-after-handoff (at-least-once); persisted inbox (#16); org-scoped member isolation; version-stamp + SIGKILL escalation (the mechanism is right — its *hash scope* is the bug).

### False-positives — look like races, AREN'T (single-threaded + synchronous fs; captured so a cold re-read doesn't resurrect them)
send()-to-destroyed-socket (105-107); deliverTo null-sessionId (245); held-queue-lost-on-resume (503); stall-timer-overwrites-resume & Map-mutation-during-iteration (784, sync loop); concurrent-writeFileSync data loss (blocks the turn); transcript-backfill double-append (rooms.js:93, sync read).

---

## 3. Proposed simpler target architecture

**One room model.** Collapse the legacy 2-party relay into the engine as 2-member `kind:'consult'` rooms — the engine already models this (consult framing with no `[room]` tag, deliverTo:239; the 2-member no-mention→other fallback, 226-229). The daemon keeps only *discovery* (sessions map, peerList/resolvePeer) + the thin consensus-file writer; everything else routes through one engine.

**Net effect:** two relays → one; the engine becomes the single source of truth for brake/resume/turn-cap/held/stall/catch-up across consults **and** teams; ~250–300 daemon lines collapse into a ~60–80 line discovery+shim layer; #26 (stall/heartbeat) is delivered as part of the move.

### Engine must GAIN (the collapse is earned, not free)
1. `ensureConsult(sessIdA, sessIdB, labels)` — synthesize a 2-member room on demand; model each consult as its own synthetic org (org = roomId) so org-isolation makes consults non-bleeding for free.
2. Catch-up on engine rooms (move elicitCatchup/onHandoff/maybeCatchup, keyed by room.members for N) — `freshRoom` already reserves `pendingCatchup:null`.
3. Stall awareness on engine rooms (repoint the stall timer / engine owns it).

### Hard migration constraints (the ways it can "look solved" but isn't)
- **Room-id continuity (HARD).** Room dirs are keyed by `stableId` (363-368). `ensureConsult` must reproduce it **byte-identical** or the same two sessions resume into a new empty dir and orphan all history. Keep stableId verbatim as the consult roomId; add a test. (Independently flagged by the static AND dynamic lanes.)
- **Trust fix must be an unforgeable RENDERED distinction, not a boolean.** A frame-level trust bit retires `trust.js` only if the trusted directive is rendered in an envelope the untrusted path cannot reproduce (`source="human"` vs `source="room"`), on a code path untrusted text can never reach. Today both classes collapse into the same `<channel source="room">` envelope (mrc-channel-server.js:288) — a meta bit alone just relocates the forgery one layer down.
- **Consult collapse is a migration, not a rename.** Preserve two consult-only properties the declared-roster model lacks: (a) ambient discovery UX (list_peers → human picks → ask_peer); (b) per-conversation room identity (roomId = hash of the two conversation UUIDs) for resume-both-rejoin.
- **Synthetic-org cleanup:** consult `end` must call `engine.removeOrg(consultOrg)`, not just `endRoom` (514-520 only drops the room) — else members + bySession entries leak slowly. (Itself an instance of R4.)

### Recommended cutover order (each independently shippable, no big-bang; gate steps 2 & 5 hardest)
1. **Fix the version stamp first** — otherwise none of the rest reloads cleanly. (Shipping now as #21b.)
2. Move stall + catch-up onto the engine (delivers #26 for both room kinds while legacy still exists — pure, reversible addition).
3. Add `ensureConsult`; repoint onAsk/onMsg/onNote/onAgentPause.
4. Unify the control dispatch.
5. Delete the legacy `pairings` block + restore/dump.

Plus two cross-cutting fixes not tied to the collapse (can land independently):
- **R1 identity/trust secret** — per-launch token (closes D1 + D11) + the unforgeable rendered trust envelope.
- **R2 atomic-write helper** — temp→fsync→rename + quarantine-on-load (closes D2/D3/D7). *Shipping now as F2.*

---

## 4. Correctness lane (Roland) + cross-lane convergence

- **F1 (HIGH)** version-stamp scope — confirmed by all lanes; = the headline. Fix: hash all `src/**/*.js` (a static import walk would MISS dynamic imports — room-daemon.js `import('../commands/team.js')`, engine `import('./media.js')`/`import('./png.js')` — so glob, don't walk). Must include config.js (repoEnvKeyStrict) + constants.js. *Shipping now as #21b.*
- **F2 (HIGH)** torn-write (= D2) + compounding: #21's SIGKILL can torn-write mid-`saveInbox` → silent inbox loss → a **net regression** on inbox durability, so atomicity must ship WITH the SIGKILL hardening. *Shipping now.*
- **F3 (MED)** no `uncaughtException`/`unhandledRejection`; daemon detached `stdio:'ignore'` → silent death, no respawn. *Shipping now.*
- **F4 (LOW, NEW)** `route()` increments `room.turn` before checking delivery → a zero-target message inflates toward turnCap → spurious pause. Fix: count on delivery.
- **CLEARED as correct (not bugs):** inbox answered/dismissed mutual-exclusion (guarded by code, not convention); turnCap=0 = intentional disable; doResume turn-window regrant; held FIFO. `doSteer` dropping held is a documented design choice (but is silent message loss — worth surfacing "N held dropped").

**Cross-lane interactions (only visible by combining lanes):**
1. **#21-SIGKILL × F2 = a REGRESSION** — atomicity must land WITH/BEFORE SIGKILL hardening (honored: bundled into the #21b package).
2. **F3 × D3 = silent death, not a 500** — without the global handler, an uncaught parse in an async path takes the daemon down silently.
3. **A2 × F4 = double penalty** — a trailing-punctuation parser miss (`@name.`) yields a zero-target message that still burns turnCap.

---

## 5. Methodology
Four independent lanes (ultracritical static, adversary dynamic, two architect code-maps, correctness) cross-checked against each other; every claim verified at `file:line`; suspected races filtered against the single-threaded + synchronous-fs reality, with disproven ones recorded so they aren't re-found. Convergence of ≥2 lanes onto each root is the confidence signal.
