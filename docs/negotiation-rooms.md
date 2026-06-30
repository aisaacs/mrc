# Negotiation Rooms

**Status:** Working end-to-end. A live client↔server round-trip relays on Max (discover → ask →
reply → relay), with **per-conversation room ids**, **autonomous relay**, and a **self-managing
host daemon** (version-stamped, auto-refresh on code change, idle auto-shutdown). Design,
decisions, and history live in this one file.

Let two running `mrc` sessions (usually different repos — e.g. a **client** and a **server**)
consult each other to a shared conclusion, without the human hand-carrying every message.

---

## 1. Problem

Working across concurrent `mrc` sessions, there's frequently a question only the *other* repo
can answer. Reaching a usable answer is rarely one round-trip — it's a multi-turn back-and-forth
that must converge on a conclusion **both sides adopt identically** (an API contract, a decision,
a clarified behavior). Today the human is the transport: copy a prompt out of session A, paste
into B, copy the reply back, repeat. Tedious and error-prone.

## 2. What it does (the model)

**Ambient pairing**, no setup per use:

```
$ mrc pick           # client repo (your normal flow)
$ mrc pick           # server repo (another terminal)

  (in the client session) >  ask the server: what auth scheme and token format do you use?
```

The client agent calls **`list_peers`** to show the real open sessions, the human picks one, the
agent calls **`ask_peer`** → a host **room daemon** relays the question into that session → the
peer answers → it loops back **autonomously**. The human supervises by observation + interrupt;
the loop pauses on a turn-cap check-in, a stall, or a human brake, and ends only on a human close.

**On by default** for interactive Claude sessions — no flag, no paths typed per use (disable with
`--no-rooms`, e.g. in `~/.mrcrc`). Skipped automatically for `--daemon`, `--json`, and `--agent
codex` (no interactive TTY to accept the channel prompt / drive the relay). `--room <name>` still
explicitly pairs two same-named sessions (and is how you deliberately join a room by id).

**The "room"** that forms for a pairing is a host dir at `~/.local/share/mrc/rooms/<roomId>/`,
mounted into both containers at `/rooms/<roomId>/`:
- **`thread.log`** — append-only transcript of every relayed hop. The source of truth.
- **`consensus.md`** — a living *shared summary* (Decision 1) either agent refreshes via
  `update_notes`, and the human can edit to steer. Notes, not a contract.

**Room identity (Decision 9).** A room id is **`<readable-labels>-<hash>`**, where the hash is
over the two participants' **stable session ids**. The session id is the Claude **conversation
UUID** (stable across resume, fresh per new conversation — see §5.9), so:
- a fresh pair of conversations always gets a **fresh** room (no stale summary/transcript reused);
- resuming **both** conversations resumes the **same** room (history preserved);
- human names are **aliases** only — used for discovery/addressing, never for identity.

## 3. Architecture

```
   Session A (container, repo A)                    Session B (container, repo B)
   claude … --channels plugin:room@mrc   (dormant until paired)
        │ stdio                                            │ stdio
   mrc-channel-server.js                              mrc-channel-server.js
   (list_peers/ask_peer/reply/update_notes/pause_room/resume_room)
        │  persistent outbound TCP                         │  persistent outbound TCP
        └───────►  ROOM DAEMON (host, detached)  ◄─────────┘
                   host.docker.internal:MRC_ROOM_PORT
                   • registry of sessions (id + repo + label)
                   • forms pairings on ask_peer / same --room name
                   • per-pairing: relay, brake, turn-cap check-in, self-healing stall
                   • control socket (mrc rooms); room dirs at ~/.local/share/mrc/rooms/
        └──── /rooms (bind mount, shared) ────┴──── /rooms (bind mount, shared) ────┘
```

**Topology fact (firewall-respecting):** the host cannot reach into a container, so each
container's channel server opens a **persistent outbound TCP socket** to the daemon (one
sanctioned host port, `MRC_ROOM_PORT`). The daemon pushes peer messages *back over that same
socket*. Identical trust surface to the clipboard/notify proxies — no new egress. (Verified live:
the channel connects to `host.docker.internal:<port>` over the firewall and registers.)

**Heartbeat (#51).** TCP-open is *not* trusted as "connected": if the daemon's port moved (see #50), a
reused port could be a clipboard/notify proxy that accepts the socket but never speaks the room protocol
(the notify proxy never even closes it → a silent false-healthy wedge). So the channel server sends a
`ping` on connect + every few seconds; the daemon replies `{type:'pong',version}`; it goes **`connected`
only after a pong** (the wrong-listener guard), and a **stale pong** (a post-sleep half-open socket, or a
daemon that vanished without a FIN) tears the socket down so it reconnects. The `version` rides each pong
so the channel server can also spot an old daemon. Both halves ship in one tree — the daemon's pong
deploys on `mrc rooms restart`/the version-refresh, the channel server's ping-requirement at the next
image rebuild; the version-stamp auto-refresh (which runs *before* the container starts) makes the
new-image/old-daemon transition safe, and an old channel server simply ignores an unknown `pong` frame.

**One daemon, many sessions — self-managing.** A single detached host process, recorded in
`~/.local/share/mrc/room-daemon.json` (`{port, controlPort, notifyPort, dashboardPort, pid, version}`):
- **Singleton + reuse.** The first room-enabled session boots it; every later session reuses it
  (and prints `◎ Negotiation-room daemon ready.`).
- **Version-stamped (`version` = sha1 of `room-daemon.js`).** A reused daemon running **older
  code** is detected and **refreshed in place on the same ports** (graceful `shutdown`, SIGTERM
  fallback), so connected sessions reconnect to current code without relaunching. This is what
  lets daemon fixes ship via `mrc rooms restart` / the next launch. **In-flight rooms survive the
  refresh:** on graceful shutdown the daemon dumps its pairings (turn count + autoCatchup) to
  `room-pairings.json`, and the next daemon restores them (a ≤2 min freshness guard ignores stale
  dumps), so a `reply` keeps landing. If a pairing is somehow missing, `reply` returns a notice to
  re-open with `ask_peer` rather than silently dropping.
- **Stable port across restart / crash (#50).** The recorded `port` is what every live session is
  pinned to — in its env (`MRC_ROOM_PORT`) **and** in its container firewall allowlist (the cage admits
  host egress on *only* that port), so a session **cannot follow a moved port**: it's an L3/L4 pin, not
  just a stale env var. So when the daemon is gone (crash / idle-shutdown / `mrc rooms stop`) and
  something respawns it, `ensureRoomDaemon` / `restart` **re-bind the recorded port** (scanning to a new
  one only if it was actually taken) and live sessions reconnect on their own via the channel server's
  retry. `mrc rooms stop` leaves a **tombstone** (record kept, marked `stopped`) instead of unlinking,
  so even a stop→restart reuses the port. If the port genuinely *had* to move, the sessions are
  stranded by the cage and must relaunch — surfaced by `mrc rooms restart`'s "MOVED" note and an
  **"awaiting reconnect"** marker on any partially-connected room in `mrc rooms status`. (The only true
  fix for the must-move case is widening the cage to a port *range* — a human-gated egress decision,
  deliberately not bundled here. A connect-time/heartbeat handshake — #51 — separately stops a session
  from silently mistaking a reused port's clip/notify proxy for the daemon.)
- **Idle auto-shutdown.** Exits ~10 min after the **last** session disconnects (a longer grace
  before the first session ever connects, so a slow image build can't kill it mid-launch and an
  orphaned daemon still gets reaped) — **unless a dashboard is open**, which counts as activity and
  keeps it up. Survives `docker rmi` (it's a host process, not a container). The next session (or
  `mrc rooms dashboard`) reboots it in <1 s.
- **Dead-room GC (#35).** A periodic sweep drops a **dead** pairing from the in-memory map (so dormant
  and spent-adversary rooms don't pile up in `mrc rooms status` or the dashboard's live overlay): a room
  with **no member online**, or an `adversary-<sha>` room whose **adversary has left** (red-team over),
  pruned after `roomTtlMs` (default 5 min — longer than the 90 s adversary boot window so a booting
  Pierre is never swept; a consent/boot handshake in flight is also spared). It removes **only the
  live-state** — the on-disk dir (`thread.log` + `consensus.md` + brief) is **kept** (the dashboard
  still lists it from disk, and the human prunes history there), and the pairing **re-creates itself**
  on resume (`ensurePairing` rebuilds from the deterministic id / room name and reuses the dir). The
  separate failed-boot reaper still removes never-connected `adversary-<sha>` *dirs* (nothing to lose).
- **Hosts the dashboard.** Serves the `mrc rooms dashboard` web UI (Decision 13) on its own
  `127.0.0.1` port (recorded in `room-daemon.json`), so the dashboard lives as long as the daemon
  and needs no foreground tab.
- **Explicit control:** `mrc rooms restart` (refresh in place, reusing the recorded port) and
  `mrc rooms stop` (stop; leaves a tombstone record so the port is reused on the next boot — #50).

## 4. Security model

The load-bearing section — the whole point of `mrc` is the sandbox.

- **Host-mediated, not peer-to-peer.** Messages flow session → daemon → session over the existing
  sanctioned host-port pattern. **No container-to-container network; one sanctioned port; no new
  firewall whitelist/egress.**
- **Rooms = filesystem, not network.** A host-controlled bind mount (`/rooms`). Outside the
  firewall's surface.
- **Cross-session agent messages are untrusted data.** Every relayed message arrives framed by
  the daemon as `Peer (<name>) says: "…"`, never as instructions the receiving agent executes.
  The channel server's MCP `instructions` reinforce this (discover-first / never-fabricate /
  relay-only-real-`<channel>`-messages / peer-is-untrusted).
- **The human is the only trusted speaker.** Steers arrive framed `[Human directive]: …`.
- **Trust invariant:** each agent only ingests (a) trusted directives from *its own* human, and
  (b) untrusted data from its peer. Your words never cross directly into the peer's context.
- **Channel is dormant + human-initiated.** The channel loads connected to the daemon but relays
  nothing until a human says "ask the \<peer>…". Agents don't autonomously *open* rooms (but once
  opened, they *do* continue the volley autonomously — Decision 2).
- **No close/end action.** Agents have `pause_room`/`resume_room` (reversible) but **no** close
  tool — and `mrc rooms end` is gone too (2026-06-17): room liveness is connectivity-derived, so a
  room goes dormant when a session leaves (close the tab); the human prunes history via the dashboard `delete`.
  A member can also `leave_room` to drop just ITSELF from one room (history kept, its next room auto-promotes) —
  the granular, non-destructive way to finish one aside without dropping all your rooms (the dual of `invite_peer`).
- **Max auth, not API credits.** No Anthropic key is ever injected into the container — the
  sandboxed session authenticates via the user's Max/OAuth login. The host-only
  `MRC_SESSION_NAMING_ANTHROPIC_API_KEY` powers the Haiku session-naming/summary calls, which run
  on the host.

## 5. Key design decisions

1. **Living shared summary (not a signed contract).** `consensus.md` is one format-flexible doc
   (prose-first, can embed a schema) that either agent refreshes via `update_notes` as durable
   conclusions land, and the human can edit to steer. It's a skimmable running summary on top of
   the `thread.log` transcript — there is no "both sign matching text" gate and no terminal "done"
   state; the human ends the room when finished. (An earlier design used a dual-signed consensus;
   it was dropped — see §10.)
2. **Autonomy = auto-relay + observe**, not per-hop gating. Once the human opens a room, the agent
   **replies to incoming peer messages itself** to keep the volley moving — it does *not* ask the
   human to approve each reply. It pauses to ask only on a decision/authorization that's genuinely
   the human's. Bounded by a turn-cap check-in + stall + human brake/close.
3. **Initiation = discover-then-ask.** The human says "ask the \<peer>…"; the agent calls
   `list_peers` (shows the REAL connected sessions), the human picks, the agent calls `ask_peer`.
   The daemon resolves the peer **most-specific-first** (exact id → exact display handle → exact
   name → name substring → name+repo substring), so an exact name beats a loose repo substring;
   genuinely identical names disambiguate via unique `[id]` handles. Human-initiated; the agent
   never opens a room unprompted or fabricates a peer.
4. **Monitoring** = the **`mrc rooms dashboard`** web UI (Decision 13) for the full live/historical
   transcript + summary and one-click pause/resume/steer + a dormant-room delete; plus `mrc rooms status` (daemon
   version + sessions + pairings), `tail -f /rooms/<id>/thread.log`, editing `consensus.md` (itself
   a steering mechanism), and desktop notifications on turn-cap/stall (via the notify proxy).
5. **Unified "Paused" state + daemon-enforced brake.** One Paused state reached three ways (human
   brake / turn-cap check-in / stall). Brake is enforced at the daemon: it stops delivering;
   in-flight messages are held in a **FIFO queue** + logged, then delivered in order on resume. A
   *stall* pause is self-healing (the next real message auto-resumes it) and a *turn-cap* pause
   grants another window on resume — see §9.
6. **Steering.** A human steer is a trusted directive; default applies to both sides
   (`mrc rooms steer --target a|b` to narrow). Submitting a steer drops the held backlog (the
   wrong-path messages); plain resume delivers it instead.
7. **Transport = channels** (see §6). Best UX (stay in your live session, on Max), local, our own
   thin server. Cost: rides a research-preview Claude Code feature.
8. **Ambient over explicit.** Pairing is on-demand at runtime (`ask_peer`), not declared at launch.
   `--room <name>` remains for deterministic explicit pairing / joining a room by id.
9. **Per-conversation room identity.** The session id used for room identity is the Claude
   **conversation UUID**: for resume it's the resumed UUID; for plain `--continue` it's the latest
   conversation's UUID; for a brand-new conversation `mrc.js` generates a fresh UUID and the
   entrypoint **pins it via `claude --session-id`** (only when `RESUME_FLAG` is empty, so
   resume/continue are untouched). The room id hashes the two UUIDs → fresh-per-new,
   same-on-resume-both. Names are aliases, never identity.
10. **On by default.** Rooms load for every interactive Claude session (`--no-rooms` opts out) — a
    session can only join a room if it was *launched* room-enabled (the channel can't be injected
    into a live session). Cost: a one-time "Channels (experimental)" accept per session. Skipped
    for `--daemon`/`--json`/codex.
11. **Control split (human-authority preserved).** Reversible controls (`pause`/`resume`) are
    reachable in-chat via agent tools *and* the CLI; **closing is CLI/human-only** (no agent
    self-close). `end` is a **generic** close — preserves `thread.log`/`consensus.md` and notifies
    both sides, no result payload. The live two-sided watch view is now the **`mrc rooms
    dashboard`** web UI (Decision 13).
12. **Self-managing daemon.** Singleton, version-stamped (auto-refresh on code change), idle
    auto-shutdown, `mrc rooms restart`/`stop`. See §3.
13. **Local dashboard, hosted by the daemon.** `mrc rooms dashboard` **boots-or-reuses the daemon**
    (which serves the UI on `127.0.0.1`) and just opens the browser, then exits — no foreground tab
    to babysit, and it works even if the daemon had idle-shut-down. The page shows every room's
    full, untruncated `thread.log` + summary (live and historical, polled) and exposes
    pause/resume/steer. It's the practical way to *read* a relay: the in-session TUI only
    renders a collapsed one-line preview of each `<channel>` message. An **open dashboard counts as
    keep-alive**, so the daemon won't idle-shutdown out from under a viewer. Read-mostly and
    localhost-only — room ids whitelisted against the rooms dir (no path traversal), actions an
    allowlist. Port in `room-daemon.json`; `MRC_DASHBOARD_PORT=0` disables it.
14. **Catch-up panes (host-elicited handoffs).** When a room pauses autonomously (turn-cap or
    stall) the daemon asks **each live side** for a short handoff — what it did this round
    *including un-relayed local workspace work*, where things stand, and what it needs from the
    human — by pushing a `catchup_request`; the agent answers via the `submit_handoff` tool (Opus
    on the user's Max plan, so no API cost, and richer than a transcript summary because the working
    agent has off-log context the `thread.log` never saw). The daemon assembles both sides into
    **one pane per pause** in `catchups.json` — or on demand from the dashboard's **Catch-up now**
    button (no pause needed; a pane shows whatever's filed immediately, and re-triggering re-asks
    only the side(s) that haven't filed, e.g. one that was mid-task). The dashboard paginates panes latest-first, opens to
    the oldest unreviewed, and tracks an explicit `reviewedAt` — opening a pane never marks it, only
    the "Mark reviewed" button does. Unreviewed counts drive room-list triage, and Resume
    soft-confirms when a room still has unreviewed panes. A per-room **auto catch-up** toggle
    (🔔/🔕 in the dashboard, control `autocatchup`) governs the *pause-triggered* elicitation.
    It is **off by default** — a pause doesn't interrupt the agents for a handoff; turn it on
    (🔔) to auto-capture one when you're away. The room still pauses either way (skips are logged
    to `thread.log`, and **Catch-up now** still works on demand). A pane finalizes (`ready`) once every
    still-present side has filed; if a side **leaves or disconnects before filing** it's dropped from the
    pane's `expected` count so the pane finalizes on the remaining handoffs rather than hanging at e.g.
    1/2 (a ~2 min timeout is the final backstop, and a reconnecting side's late handoff still attaches to
    the un-reviewed pane). #29

## 6. Transport — why channels (condensed findings)

- **Hard constraint:** a Claude Code session has one input driver at a time; you cannot attach to
  a running interactive session. *Inbound* injection into a live session is only possible via the
  **`/channels`** feature (research preview, present in our build though hidden from `--help`).
- **Channels** = a local MCP server (stdio + loopback, **no cloud**), two-way (push in via
  `notifications/claude/channel`; out via a tool), coexists with an interactive session, works on
  **Max/OAuth**. We ship our own channel server as the `room` plugin in a baked-in **local
  marketplace**, loaded with `--channels plugin:room@mrc` — allowlisted in managed-settings, so it
  loads with no experimental-channel prompt (was `--dangerously-load-development-channels`, which
  prompted every first-use).
- **Remote Control** was ruled out: requires claude.ai OAuth *and* routes through Anthropic's
  cloud ("API keys not supported"). Channels work on either auth and stay local.
- **ESM gotcha:** the channel server uses ESM `import`, which (unlike `require`) ignores
  `NODE_PATH`. So it ships in its own dir `/opt/mrc-channel/` with a **local** SDK install. That dir's
  `package.json` **must pin `"type": "module"`** — the Dockerfile runs `npm pkg set type=module` after
  `npm init -y` (#54). A recent npm changed `npm init -y` to write `"type": "commonjs"`, and an
  *explicit* `type:commonjs` overrides node 24's automatic ESM-syntax detection → node parses the `.js`
  as CommonJS → "Cannot use import statement outside a module" → the server crashes on load → its MCP
  never starts → **rooms silently break**. (The sibling `/usr/local/bin` scripts are ESM too but have no
  local `package.json`, so node's auto-detect still loads them as ESM — only the channel dir, which has
  its own `npm init` package.json, needs the explicit pin.)
- **Activation:** the dev-channel "I am using this for local development" prompt is interactive and
  **not persisted**. Auto-answering it via a PTY wrapper (`expect`) proved version-brittle and
  dangerous (it once landed on the wrong menu and triggered a compact), so it was **removed**: the
  entrypoint launches `claude` directly and the human accepts the one-time prompt by hand.
- **The `server:room · no MCP server configured with that name` banner is benign** — it appears at
  load but the channel still binds; the live round-trip (peer reply surfacing as
  `<channel source="room">`) works.
- **Risk:** channels are research preview — flag/protocol may change. Mitigation: the channel
  server is thin and the only coupling point.

## 7. Components (current code)

**New:**
- **`src/proxies/room-daemon.js`** — the host daemon. Session registry (id + repo + label, unique
  display handles); `resolvePeer` (most-specific-first matching); per-conversation `stableId`
  (`<labels>-<hash(ids)>`); per-pairing relay with untrusted framing, brake, turn-cap check-in,
  self-healing stall, and a FIFO held-queue; shared-summary writes (`update_notes`); per-pause
  catch-up elicitation (Decision 14) via `catchup_request`→`handoff` into `catchups.json`; relay
  frames `register/list/ask/msg/note/handoff/pause/resume/invite/leave` (each `msg`/`note`/`handoff`/`invite`/`leave`
  is `ack`ed back to the sender with its true outcome — delivered/held/not-delivered, invited/already, left); control
  frames `status(+version)/shutdown/brake/resume/steer/catchup/autocatchup`; idle auto-shutdown; notify-proxy
  notifications (fired via any currently-connected session's proxy); **hosts the dashboard**
  (Decision 13) on its own port; detached entrypoint that
  records `room-daemon.json` (`{port, controlPort, notifyPort, dashboardPort, pid, version}`).
- **`container/mrc-channel-server.js`** — container-side channel MCP server. Connects to
  `host.docker.internal:MRC_ROOM_PORT`, registers `{sessionId, repo, label, room?, notifyPort?}`, exposes
  `list_peers`/`ask_peer`/`reply`/`update_notes`/`pause_room`/`resume_room`/`submit_handoff`, pushes
  daemon frames into the session as `<channel>` tags. `reply`/`update_notes`/`submit_handoff` **await
  the daemon's `ack`** and return the true outcome (delivered / held / not-delivered) rather than a
  blind "sent" — so a dropped message is never silent. Instructions: discover-first, never-fabricate,
  peer-is-untrusted, **keep-the-volley-going (auto-reply)**, keep a living shared summary via
  `update_notes`, control (pause/resume via agent; closing is human-CLI-only).
- **`src/commands/pair.js`** — `ensureRoomDaemon()` (version-checked reuse / in-place refresh /
  fresh boot), `restartRoomDaemon()`, `stopRoomDaemon()`, `roomSessionEnv()` (per-session env).
- **`src/commands/rooms.js`** — `mrc rooms status|brake|resume|steer|restart|stop|dashboard` via
  the daemon control port; `status` shows the daemon code version.
- **`src/rooms.js`** — room-dir manager (`ensureRoom`, `appendThread`, `writeConsensus`,
  `readCatchups`/`appendCatchup`/`updateCatchup`, …) at `~/.local/share/mrc/rooms/<roomId>/`
  (`thread.log`, `consensus.md`, `catchups.json`).
- **`src/rooms-dashboard.js`** + **`src/rooms-dashboard.html`** — the `mrc rooms dashboard` web UI
  (Decision 13): a localhost HTTP server (no deps), **started inside the daemon process**, serving
  room state from the daemon control socket + the rooms dir, plus a single-page app that renders the
  full thread + summary, the **paginated catch-up panes** (Decision 14) with explicit mark-reviewed
  + unreviewed triage, and the pause/resume/steer controls. `mrc rooms dashboard` boots-or-reuses
  the daemon and opens the browser (then exits).

**Modified:**
- **`mrc.js`** — default-on room launch (`roomsActive`; skip `--daemon`/`--json`/codex): boot the
  daemon **before the image build** (visible status), no API key in container, `/rooms` mount,
  room labels; `MRC_SESSION_ID` = the conversation UUID via `resolveSessionId`; `mrc rooms`
  dispatch; help text.
- **`src/sessions/manager.js`** — `resolveSessionId(mrcDir, {resumeSession, newSession})` → the
  resumed UUID / latest (continue) / a fresh UUID (new).
- **`src/config.js`** — `rooms` defaults **true**; `--no-rooms` / `--room <name>` flags.
- **`src/docker.js`** — `labels` param on `runContainer`; `buildImage` announces a full image
  build ("a few minutes") vs a cached one.
- **`Dockerfile`** — `/opt/mrc-channel` with a local `@modelcontextprotocol/sdk`; copy the channel
  server there. Also bake `/opt/mrc-marketplace` (the local `mrc` marketplace whose `room` plugin
  points at that server) + `/etc/claude-code/managed-settings.json` allowlisting `{marketplace:mrc,
  plugin:room}`. (No `expect`/PTY wrapper.)
- **`entrypoint.sh`** — pass `MRC_ROOM_PORT` to the firewall; room branch launches `claude
  --channels plugin:room@mrc`, pinning `--session-id $MRC_SESSION_ID` for a NEW conversation (empty
  `RESUME_FLAG`); resume/continue keep their flag.
- **`init-firewall.sh`** — allow the one `MRC_ROOM_PORT` (modeled on clipboard/notify).
- **`container/container-setup.js`** — when `MRC_ROOM_PORT` set, register the `room` plugin into the
  per-repo volume (`claude plugin marketplace add /opt/mrc-marketplace` + `plugin install room@mrc`),
  idempotently (skipped once present) — local marketplaces don't ride the plugin defaults-restore.

**Env vars:** `MRC_ROOM_PORT` (daemon relay port), `MRC_ROOM_HOST` (`host.docker.internal`),
`MRC_SESSION_ID` (the conversation UUID), `MRC_REPO_NAME`, `MRC_ROOM_LABEL` (display alias),
`MRC_ROOM` (optional explicit `--room` name), `MRC_ROOM_TURN_CAP` (turn-cap check-in; off by default, set N to enable),
`MRC_DASHBOARD_PORT` (dashboard port; default 8787, `0` disables).

## 8. Data flow — one ask

1. Human: "ask the server: …". Agent A calls `list_peers`, the human picks, agent A calls
   `ask_peer({peer:"<name>", question})`.
2. Channel A → daemon: `{type:"ask", peer, question}`.
3. Daemon resolves the peer (§5.3) → forms/looks-up the pairing → appends `thread.log` → pushes
   `{type:"deliver", text:'Peer (A) says: "…" [turn N/M]'}` over B's socket.
4. Channel B → session B sees `<channel source="room">…</channel>`. Agent B answers **on its own**
   via `reply` (auto-relay).
5. Channel B → daemon `{type:"msg", text}` → routed to A as the next `deliver`. Loop until a human
   brake/close (a turn-cap check-in or a stall only *pauses*).

Daemon-applied framing: peer messages `Peer (<name>) says: …`; human steers `[Human directive]:
…`. Those are the only two message classes a session sees.

## 9. Pairing & control

Per-pairing state in the daemon: `Running | Paused` + `pauseReason ∈ {brake,turnCap,stall,sidechannel}`,
`turn`/`turnCap` (off by default; `MRC_ROOM_TURN_CAP=N` enables), `lastActivityAt`, and a FIFO
`held` queue.

- **brake** → Paused, stop delivering, queue further messages (FIFO).
- **turnCap** → a periodic *check-in*: Paused at `turn ≥ cap`; **resume grants another full window**
  so a long-running channel isn't a per-turn wall (off by default; `MRC_ROOM_TURN_CAP=N` enables).
- **stall** → idle > 10 min → Paused + notify, but **self-healing**: the next real message
  auto-resumes it (a slow peer composing a long reply is never swallowed).
- **sidechannel** → the **one-live-room invariant**: a session is unpaused in at most ONE room — the
  highest-`seq` room it's in — so a private aside in a newer room can't leak into an older one. Brakes
  are recomputed purely from `seq` on every room create/close/(dis)connect (no `brakedBy` chain to
  corrupt on out-of-order closes); closing the live room auto-promotes the next-highest. The recompute
  is **scoped to the changed session's member-sharing cluster** (#36) — a connect/disconnect in one
  cluster never ripples a recompute across unrelated sessions' rooms (identical result: a room outside
  the cluster has no member whose `seq`-landscape changed, so the global pass was always a no-op for it).
- **catch-up** → on a turnCap/stall pause (or the dashboard's **Catch-up now**) the daemon elicits
  a handoff from each live side (`catchup_request`→`submit_handoff`) into a per-pause pane in
  `catchups.json`; a side that files late (after the pane timed out) still lands on it. The
  **verbatim** request prompt and the full handoffs are **also appended to `thread.log`** word-for-
  word — it's the canonical append-only record, so nothing is lost even though panes can be
  edited/dropped. The dashboard then *display-makes* the log (collapses the boilerplate prompt into a
  chip, renders handoffs as cards) — full audit in the log, clean conversation in the UI (Decision 14).
- **update_notes** → either side rewrites the shared summary in `consensus.md`. *Not* a pause and
  *not* a gate — no matching, the room stays open.
- **resume** → deliver the full held backlog in order, continue. **steer** → inject
  `[Human directive]` (drops held backlog), resume.
- **end** → drop the pairing (generic close; preserves files; no payload).

Control surfaces:
- **CLI** (`mrc rooms`, any terminal): `status` (daemon version + sessions + pairings),
  `brake|resume [roomId]`, `steer [--room id] [--target a|b] <text>`, `restart` (refresh the
  daemon in place), `stop` (stop it), `dashboard` (the web UI, Decision 13). **`end` is human-only**
  (no agent self-close).
- **In-chat** (the human tells their own session): the agent calls `pause_room`/`resume_room`
  (relayed to the daemon as `pause`/`resume`). Closing is *not* an agent power. Steering your own
  side is just talking to your agent; cross-side directives use the CLI `steer`.

**Resume.** Room ids are stable per the two conversations (§5.9): closing then re-asking the same
peer (same two conversations) reuses the same room dir, with `thread.log`/`consensus.md`
accumulating. A `--room <name>` id is verbatim, so you can deliberately join by id. Catch-up is
point-at-file: the connect notice tells each agent to read `/rooms/<id>/thread.log` — resume never
depends on agent memory.

## 10. Status & history

**Working end-to-end** on Max: discovery (`list_peers` shows the real sessions), explicit pick,
`ask_peer` relay, autonomous reply, and the round-trip surfacing as `<channel source="room">`.

Built and validated (host-side unit tests where the container path can't run locally):
- **Relay engine** — per-pairing state machine (relay + untrusted framing + brake + turn-cap
  check-in + self-healing stall + FIFO held-queue).
- **Channel transport** — channel server + daemon protocol; ESM resolution via `/opt/mrc-channel`;
  direct launch + manual channel accept (the `expect` auto-accept was reverted as dangerous).
- **Ambient pairing** — detached daemon, `mrc rooms` CLI.
- **Stale-daemon fix** — version-stamping + in-place refresh (a long-lived daemon on old code
  answered `register` but not `list`, so every session saw zero peers; diagnosed live by probing
  the daemon port from inside a session).
- **Peer matching** — most-specific-first + unique `[id]` handles (an exact name no longer
  collides with another session sharing the repo).
- **Per-conversation room ids** — `<labels>-<hash>` over the conversation UUIDs (no stale reuse;
  resume-both reuses the room).
- **Autonomous relay** — the agent keeps the volley going without per-message approval.
- **Daemon lifecycle** — idle auto-shutdown, `mrc rooms restart`/`stop`, visible startup status.
- **Stall recovery + FIFO held-queue** — a slow peer's reply is no longer dropped by the stall
  pause; held messages deliver in order on resume (host-side smoke test).
- **Turn-cap check-in** — resume/steer grant another window instead of re-pausing every turn once
  over the cap (host-side smoke test).
- **Shared summary** — `update_notes` rewrites `consensus.md`; the old dual-signed consensus gate
  was removed (it didn't fit an open-ended consult channel — two agents rarely emit byte-identical
  text, and there's no single "done" moment).
- **Dashboard** — `mrc rooms dashboard` web UI over the control socket + rooms dir (served
  end-to-end against real room data).
- **Catch-up panes** — on an autonomous pause the daemon elicits a per-side handoff and stores one
  pane per pause; the dashboard paginates them with explicit (button-only) mark-reviewed, unreviewed
  triage, and a Resume soft-gate (host-side smoke tests for both the daemon capture and the
  dashboard serve/review path).

**Future (not built):** inline markers (`→ sent` / `← replied`); a result-payload on `end`; per-repo
peer aliases; background-subagent delegation (answer from repo B without a live B session); >2-party
rooms; strict per-hop approval mode.

## 11. Deploy / rebuild recipe

Most changes are host-side and take effect on the next `mrc` invocation. The split:
- **Daemon code (`room-daemon.js`)** → `mrc rooms restart`, or just launch a session (the version
  check auto-refreshes the running daemon in place; connected sessions reconnect).
- **Host launcher (`mrc.js`, `pair.js`, `rooms.js`, `manager.js`, `docker.js`)** → live on the
  next `mrc` run.
- **Container (`Dockerfile`, `entrypoint.sh`, `container-setup.js`, `mrc-channel-server.js`,
  `init-firewall.sh`)** → `docker rmi mister-claude` then relaunch.

```bash
docker rmi mister-claude     # only when container files changed
mrc pick                     # client repo — rooms ON by default; accept the one-time Channels prompt
mrc pick                     # server repo — accept it there too
#   in one session:  ask the <peer>: <question>     → list_peers → pick → relay (auto)
mrc rooms status             # daemon version + sessions + pairings
mrc rooms dashboard          # web UI: full transcript + summary, live & historical, with controls
mrc rooms restart | stop     # refresh in place / stop the daemon
```

## 12. Open items, limitations, follow-ups

- **One active room per session.** Reply routing uses a session's first pairing, so a session
  can't actively be in two rooms at once without crossing wires. Fine for one-consult-at-a-time;
  revisit if concurrent rooms are needed.
- **`mrc-channel-server.js` display handles** (for same-name collisions) need an image rebuild to
  show; the daemon's exact-name matching already resolves the common case without it.
- **Research-preview channels:** monitor for upstream flag/protocol changes; keep the channel
  server thin.
- **Steering target default** is "both"; a per-watched-side default is a possible refinement.
- Future niceties: explicit multi-topic named rooms per pair; an agent `request_close` surfaced to
  the human for confirmation.
