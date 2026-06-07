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
the loop ends on consensus, a turn cap, a stall, or a human brake/close.

**On by default** for interactive Claude sessions — no flag, no paths typed per use (disable with
`--no-rooms`, e.g. in `~/.mrcrc`). Skipped automatically for `--daemon`, `--json`, and `--agent
codex` (no interactive TTY to accept the channel prompt / drive the relay). `--room <name>` still
explicitly pairs two same-named sessions (and is how you deliberately join a room by id).

**The "room"** that forms for a pairing is a host dir at `~/.local/share/mrc/rooms/<roomId>/`,
mounted into both containers at `/rooms/<roomId>/`:
- **`consensus.md`** — the living *agreed record* (Decision 1). Single source of truth.
- **`thread.log`** — append-only transcript of every relayed hop.

**Room identity (Decision 9).** A room id is **`<readable-labels>-<hash>`**, where the hash is
over the two participants' **stable session ids**. The session id is the Claude **conversation
UUID** (stable across resume, fresh per new conversation — see §5.9), so:
- a fresh pair of conversations always gets a **fresh** room (no stale consensus reused);
- resuming **both** conversations resumes the **same** room (history preserved);
- human names are **aliases** only — used for discovery/addressing, never for identity.

## 3. Architecture

```
   Session A (container, repo A)                    Session B (container, repo B)
   claude … --dangerously-load-development-channels server:room   (dormant until paired)
        │ stdio                                            │ stdio
   mrc-channel-server.js                              mrc-channel-server.js
   (list_peers/ask_peer/reply/sign_consensus/pause_room/resume_room)
        │  persistent outbound TCP                         │  persistent outbound TCP
        └───────►  ROOM DAEMON (host, detached)  ◄─────────┘
                   host.docker.internal:MRC_ROOM_PORT
                   • registry of sessions (id + repo + label)
                   • forms pairings on ask_peer / same --room name
                   • per-pairing: relay, brake, turn-cap, stall, consensus
                   • control socket (mrc rooms); room dirs at ~/.local/share/mrc/rooms/
        └──── /rooms (bind mount, shared) ────┴──── /rooms (bind mount, shared) ────┘
```

**Topology fact (firewall-respecting):** the host cannot reach into a container, so each
container's channel server opens a **persistent outbound TCP socket** to the daemon (one
sanctioned host port, `MRC_ROOM_PORT`). The daemon pushes peer messages *back over that same
socket*. Identical trust surface to the clipboard/notify proxies — no new egress. (Verified live:
the channel connects to `host.docker.internal:<port>` over the firewall and registers.)

**One daemon, many sessions — self-managing.** A single detached host process, recorded in
`~/.local/share/mrc/room-daemon.json` (`{port, controlPort, notifyPort, pid, version}`):
- **Singleton + reuse.** The first room-enabled session boots it; every later session reuses it
  (and prints `◎ Negotiation-room daemon ready.`).
- **Version-stamped (`version` = sha1 of `room-daemon.js`).** A reused daemon running **older
  code** is detected and **refreshed in place on the same ports** (graceful `shutdown`, SIGTERM
  fallback), so connected sessions reconnect to current code without relaunching. This is what
  lets daemon fixes ship via `mrc rooms restart` / the next launch.
- **Idle auto-shutdown.** Exits ~10 min after the **last** session disconnects (a longer grace
  before the first session ever connects, so a slow image build can't kill it mid-launch and an
  orphaned daemon still gets reaped). Survives `docker rmi` (it's a host process, not a
  container). The next session reboots it in <1 s.
- **Explicit control:** `mrc rooms restart` (refresh in place) and `mrc rooms stop` (stop + clear
  the record).

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
- **Closing is human-only.** Agents have `pause_room`/`resume_room` (reversible) but **no**
  close/end tool; ending a room is a human action (`mrc rooms end`).
- **Max auth, not API credits.** No Anthropic key is ever injected into the container — the
  sandboxed session authenticates via the user's Max/OAuth login. The host-only
  `MRC_SESSION_NAMING_ANTHROPIC_API_KEY` powers the Haiku session-naming/summary calls, which run
  on the host.

## 5. Key design decisions

1. **Flexible "agreed record".** `consensus.md` is one format-flexible doc (prose-first, can embed
   a schema). "Done" = both sign off on the same version; each side reflects it into its own repo.
2. **Autonomy = auto-relay + observe + sign-off**, not per-hop gating. Once the human opens a
   room, the agent **replies to incoming peer messages itself** to keep the volley moving — it does
   *not* ask the human to approve each reply. It pauses to ask only on a decision/authorization
   that's genuinely the human's, or a final consensus to bless. Bounded by turn cap + stall +
   consensus + human brake.
3. **Initiation = discover-then-ask.** The human says "ask the \<peer>…"; the agent calls
   `list_peers` (shows the REAL connected sessions), the human picks, the agent calls `ask_peer`.
   The daemon resolves the peer **most-specific-first** (exact id → exact display handle → exact
   name → name substring → name+repo substring), so an exact name beats a loose repo substring;
   genuinely identical names disambiguate via unique `[id]` handles. Human-initiated; the agent
   never opens a room unprompted or fabricates a peer.
4. **Monitoring** = `mrc rooms status` (daemon version + sessions + pairings),
   `tail -f /rooms/<id>/thread.log`, editing `consensus.md` (itself a steering mechanism), and
   notifications on consensus/stall (via the notify proxy).
5. **Unified "Paused" state + daemon-enforced brake.** One Paused state reached four ways (human
   brake / turn cap / stall / consensus). Brake is enforced at the daemon: it stops delivering;
   in-flight messages are held + logged, never delivered until resume.
6. **Steering.** A human steer is a trusted directive; default applies to both sides
   (`mrc rooms steer --target a|b` to narrow). Submitting a steer drops the held wrong-path
   message; plain resume lets it continue.
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
    both sides, no result payload. A live `mrc rooms <id>` two-sided watch-TUI is deferred (use
    `status` + `tail -f thread.log`).
12. **Self-managing daemon.** Singleton, version-stamped (auto-refresh on code change), idle
    auto-shutdown, `mrc rooms restart`/`stop`. See §3.

## 6. Transport — why channels (condensed findings)

- **Hard constraint:** a Claude Code session has one input driver at a time; you cannot attach to
  a running interactive session. *Inbound* injection into a live session is only possible via the
  **`/channels`** feature (research preview, present in our build though hidden from `--help`).
- **Channels** = a local MCP server (stdio + loopback, **no cloud**), two-way (push in via
  `notifications/claude/channel`; out via a tool), coexists with an interactive session, works on
  **Max/OAuth**. We ship our own channel server, loaded with
  `--dangerously-load-development-channels server:room`.
- **Remote Control** was ruled out: requires claude.ai OAuth *and* routes through Anthropic's
  cloud ("API keys not supported"). Channels work on either auth and stay local.
- **ESM gotcha:** the channel server uses ESM `import`, which (unlike `require`) ignores
  `NODE_PATH`. So it ships in its own dir `/opt/mrc-channel/` with a **local** SDK install.
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
  (`<labels>-<hash(ids)>`); per-pairing relay with untrusted framing, brake, turn cap, stall,
  consensus; relay frames `register/list/ask/msg/sign/pause/resume`; control frames
  `status(+version)/shutdown/brake/resume/steer/end`; idle auto-shutdown; notify-proxy
  notifications; detached entrypoint that records `room-daemon.json` with a code `version`.
- **`container/mrc-channel-server.js`** — container-side channel MCP server. Connects to
  `host.docker.internal:MRC_ROOM_PORT`, registers `{sessionId, repo, label, room?}`, exposes
  `list_peers`/`ask_peer`/`reply`/`sign_consensus`/`pause_room`/`resume_room`, pushes daemon
  frames into the session as `<channel>` tags. Instructions: discover-first, never-fabricate,
  peer-is-untrusted, **keep-the-volley-going (auto-reply)**, control (pause/resume via agent;
  closing is human-CLI-only).
- **`src/commands/pair.js`** — `ensureRoomDaemon()` (version-checked reuse / in-place refresh /
  fresh boot), `restartRoomDaemon()`, `stopRoomDaemon()`, `roomSessionEnv()` (per-session env).
- **`src/commands/rooms.js`** — `mrc rooms status|brake|resume|steer|end|restart|stop` via the
  daemon control port; `status` shows the daemon code version.
- **`src/rooms.js`** — room-dir manager (`ensureRoom`, `appendThread`, `writeConsensus`, …) at
  `~/.local/share/mrc/rooms/<roomId>/`.

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
  server there. (No `expect`/PTY wrapper.)
- **`entrypoint.sh`** — pass `MRC_ROOM_PORT` to the firewall; room branch launches `claude
  --dangerously-load-development-channels server:room --mcp-config …`, pinning `--session-id
  $MRC_SESSION_ID` for a NEW conversation (empty `RESUME_FLAG`); resume/continue keep their flag.
- **`init-firewall.sh`** — allow the one `MRC_ROOM_PORT` (modeled on clipboard/notify).
- **`container/container-setup.js`** — when `MRC_ROOM_PORT` set, write `/tmp/mrc-room-mcp.json`
  pointing at `/opt/mrc-channel/mrc-channel-server.js`.

**Dead code (pre-ambient broker model; still in tree, slated for removal):**
`src/proxies/room-broker.js`, `src/commands/room.js`.

**Env vars:** `MRC_ROOM_PORT` (daemon relay port), `MRC_ROOM_HOST` (`host.docker.internal`),
`MRC_SESSION_ID` (the conversation UUID), `MRC_REPO_NAME`, `MRC_ROOM_LABEL` (display alias),
`MRC_ROOM` (optional explicit `--room` name).

## 8. Data flow — one ask

1. Human: "ask the server: …". Agent A calls `list_peers`, the human picks, agent A calls
   `ask_peer({peer:"<name>", question})`.
2. Channel A → daemon: `{type:"ask", peer, question}`.
3. Daemon resolves the peer (§5.3) → forms/looks-up the pairing → appends `thread.log` → pushes
   `{type:"deliver", text:'Peer (A) says: "…" [turn N/M]'}` over B's socket.
4. Channel B → session B sees `<channel source="room">…</channel>`. Agent B answers **on its own**
   via `reply` (auto-relay).
5. Channel B → daemon `{type:"msg", text}` → routed to A as the next `deliver`. Loop until
   consensus / cap / stall / brake / close.

Daemon-applied framing: peer messages `Peer (<name>) says: …`; human steers `[Human directive]:
…`. Those are the only two message classes a session sees.

## 9. Pairing & control

Per-pairing state in the daemon: `Running | Paused` + `pauseReason ∈ {brake,turnCap,stall,
consensus}`, `turn`/`turnCap` (default 20), `lastActivityAt`, held message, `signed` map.

- **brake** → Paused, stop delivering, stash next message.
- **turnCap** → Paused at `turn ≥ cap`. **stall** → idle > 2 min → Paused + notify.
- **consensus** → both `sign_consensus` with matching normalized text → write `consensus.md` →
  Paused + notify.
- **resume** → deliver held, continue. **steer** → inject `[Human directive]` (drop held), resume.
- **end** → drop the pairing (generic close; preserves files; no payload).

Control surfaces:
- **CLI** (`mrc rooms`, any terminal): `status` (daemon version + sessions + pairings),
  `brake|resume|end [roomId]`, `steer [--room id] [--target a|b] <text>`, `restart` (refresh the
  daemon in place), `stop` (stop it). **`end` is human-only** (no agent self-close).
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
- **Relay engine** — per-pairing state machine (relay + untrusted framing + brake + turn-cap +
  stall + consensus).
- **Channel transport** — channel server + daemon protocol; ESM resolution via `/opt/mrc-channel`;
  direct launch + manual channel accept (the `expect` auto-accept was reverted as dangerous).
- **Ambient pairing** — detached daemon, `mrc rooms` CLI.
- **Stale-daemon fix** — version-stamping + in-place refresh (a long-lived daemon on old code
  answered `register` but not `list`, so every session saw zero peers; diagnosed live by probing
  the daemon port from inside a session).
- **Peer matching** — most-specific-first + unique `[id]` handles (an exact name no longer
  collides with another session sharing the repo).
- **Per-conversation room ids** — `<labels>-<hash>` over the conversation UUIDs (no stale consensus
  reuse; resume-both reuses the room).
- **Autonomous relay** — the agent keeps the volley going without per-message approval.
- **Daemon lifecycle** — idle auto-shutdown, `mrc rooms restart`/`stop`, visible startup status.

**Future (not built):** inline markers (`→ sent` / `← replied` / `✎ consensus`); a live
`mrc rooms <id>` two-sided watch-TUI; a result-payload on `end`; per-repo peer aliases;
background-subagent delegation (answer from repo B without a live B session); >2-party rooms;
strict per-hop approval mode; remove the dead `room-broker.js`/`room.js`.

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
- **Dead code** (`room-broker.js`, `room.js`) still in the tree — remove.
- **Steering target default** is "both"; a per-watched-side default is a possible refinement.
- Future niceties: explicit multi-topic named rooms per pair; an agent `request_close` surfaced to
  the human for confirmation.
