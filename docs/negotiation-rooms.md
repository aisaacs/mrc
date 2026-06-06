# Negotiation Rooms

**Status:** Implemented and host-validated (ambient model). Pending the first Docker
rebuild-test (Phase 4).
**Design + plan + progress live in this one file.**

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

The target experience — **ambient pairing**, no setup per use:

```
$ mrc pick           # client repo (your normal flow)
$ mrc pick           # server repo (another terminal)

  (in the client session) >  ask the server: what auth scheme and token format do you use?
```

The client agent calls an **`ask_peer`** tool → a host **room daemon** resolves "the server"
among the running room-enabled sessions → relays the question into the server session → the
server answers → it loops back. The human supervises by **observation + interrupt**, and the
loop ends on consensus, a turn cap, a stall, or a human brake.

Enabled with a single `--rooms` line in `.mrcrc` (global `~/.mrcrc` or per-repo). No `--room`,
no paths typed per use. `--room <name>` still exists for explicit, deterministic pairing of two
same-named sessions.

**The "room"** that forms for a pairing is a host dir at `~/.local/share/mrc/rooms/<roomId>/`,
mounted into both containers at `/rooms/<roomId>/`:
- **`consensus.md`** — the living *agreed record* (Decision 1). Single source of truth.
- **`thread.log`** — append-only transcript of every relayed hop.

## 3. Architecture

```
   Session A (container, repo A)                    Session B (container, repo B)
   claude … --dangerously-load-development-channels server:room   (dormant until paired)
        │ stdio                                            │ stdio
   mrc-channel-server.js                              mrc-channel-server.js
   (ask_peer/reply/sign_consensus)                    (ask_peer/reply/sign_consensus)
        │  persistent outbound TCP                         │  persistent outbound TCP
        └───────►  ROOM DAEMON (host, detached)  ◄─────────┘
                   host.docker.internal:MRC_ROOM_PORT
                   • registry of sessions (by repo)
                   • forms pairings on ask_peer / same --room name
                   • per-pairing: relay, brake, turn-cap, stall, consensus
                   • control socket (mrc rooms) ; room dirs at ~/.local/share/mrc/rooms/
        └──── /rooms (bind mount, shared) ────┴──── /rooms (bind mount, shared) ────┘
```

**Topology fact (firewall-respecting):** the host cannot reach into a container, so each
container's channel server opens a **persistent outbound TCP socket** to the daemon (one
sanctioned host port, reused as `MRC_ROOM_PORT`). The daemon pushes peer messages *back over
that same socket*. Identical trust surface to the clipboard/notify proxies — no new egress.

**One daemon, many sessions.** The daemon is a single detached process (auto-started by the
first `--rooms` session, recorded in `~/.local/share/mrc/room-daemon.json`). It outlives any
single session — closing a terminal does not break others' rooms.

## 4. Security model

The load-bearing section — the whole point of `mrc` is the sandbox.

- **Host-mediated, not peer-to-peer.** Messages flow session → daemon → session over the
  existing sanctioned host-port pattern. **No container-to-container network; one new
  sanctioned port; no new firewall whitelist/egress.**
- **Rooms = filesystem, not network.** A host-controlled bind mount (`/rooms`). Outside the
  firewall's surface.
- **Cross-session agent messages are untrusted data.** Every relayed message arrives framed by
  the daemon as `Peer (<repo>) says: "…"`, never as instructions the receiving agent executes.
  The channel server's MCP `instructions` reinforce this.
- **The human is the only trusted speaker.** Steers arrive framed `[Human directive]: …`.
- **Trust invariant:** each agent only ingests (a) trusted directives from *its own* human, and
  (b) untrusted data from its peer. Your words never cross directly into the peer's context.
- **Channel is dormant + human-initiated.** The channel loads connected to the daemon but
  relays nothing until a human says "ask the \<peer>…". Agents don't autonomously open
  conversations.
- **Max auth, not API credits.** Room sessions launch **without** `ANTHROPIC_API_KEY`, so the
  interactive session bills to the user's Max subscription. The key stays host-side for the
  Haiku session-naming calls only.

## 5. Key design decisions

1. **Flexible "agreed record".** Work spans a co-authored spec / a decision+rationale / a
   freeform clarification. `consensus.md` is one format-flexible doc (prose-first, can embed a
   schema). "Done" = both sign off on the same version; each side then reflects it into its own
   repo as appropriate.
2. **Autonomy = auto-relay + observe + sign-off**, not per-hop gating. The loop relays
   automatically; the human watches, may interject, blesses the final consensus. Bounded by
   turn cap + stall + consensus detectors.
3. **Initiation = ambient `ask_peer`.** The human says "ask the \<peer>…"; the agent calls
   `ask_peer(peer?, question)`. The daemon resolves the peer (repo-name match → sole-peer auto →
   ambiguous returns the list so the agent asks the user). Human-initiated; agent never opens a
   room unprompted.
4. **Monitoring** = `mrc rooms status`, `tail -f /rooms/<id>/thread.log`, editing
   `consensus.md` (itself a steering mechanism), inline markers, and notifications on
   consensus/stall (reusing the notify proxy).
5. **Unified "Paused" state + daemon-enforced brake.** One Paused state reached four ways
   (human brake / turn cap / stall / consensus). Brake is enforced at the daemon: it stops
   delivering; in-flight messages are held + logged, never delivered until resume.
6. **Steering.** A human steer is a trusted directive; default applies to both sides of the
   pairing (`mrc rooms steer --target a|b` to narrow). Submitting a steer drops the held
   wrong-path message; plain resume lets it continue.
7. **Transport = channels** (see §6). Best UX (stay in your live session, on Max), local, our
   own thin server. Cost: rides a research-preview Claude Code feature.
8. **Ambient over explicit.** Pairing is on-demand at runtime (`ask_peer`), not declared at
   launch — matches the real workflow (`mrc pick` then ask). `--room <name>` remains for
   deterministic explicit pairing.

## 6. Transport — why channels (condensed findings)

- **Hard constraint:** a Claude Code session has one input driver at a time; you cannot attach
  to a running interactive session. *Inbound* injection into a live session is only possible via
  the **`/channels`** feature (research preview, present in our build though hidden from
  `--help`).
- **Channels** = a local MCP server (stdio + loopback, **no cloud**), two-way (push in via
  `notifications/claude/channel`; out via a tool), coexists with an interactive session, works
  on **Max/OAuth**. We ship our own ~90-line channel server, loaded with
  `--dangerously-load-development-channels server:room`.
- **Remote Control** was ruled out: requires claude.ai OAuth *and* routes through Anthropic's
  cloud; "API keys not supported." Channels work on either auth and stay local.
- **Spike proof:** a round-trip ran in-container on Max (key stripped) — `curl` → `<channel>`
  tag → agent `reply` → captured. Drops silently in non-interactive `-p` mode (fine; rooms are
  interactive).
- **ESM gotcha:** the channel server uses ESM `import`, which (unlike `require`) ignores
  `NODE_PATH`. So it ships in its own dir `/opt/mrc-channel/` with a **local** SDK install
  (validated).
- **Activation:** the dev-channel "I am using this for local development" prompt is interactive
  and not persisted (no settings key exists). The entrypoint wraps the launch in an **`expect`**
  script that auto-answers it, then `interact`s to hand the PTY to the user.
- **Risk:** channels are research preview — flag/protocol may change. Mitigation: the channel
  server is thin and the only coupling point.

## 7. Components (current code)

**New:**
- **`src/proxies/room-daemon.js`** — the host daemon. Registry of sessions; resolves
  `ask_peer`; forms pairings (on-demand or by matching `--room` name); per-pairing relay with
  untrusted framing, brake, turn cap, stall, consensus; notify-proxy notifications; control
  socket for `mrc rooms`; detached entrypoint that records `room-daemon.json`.
- **`container/mrc-channel-server.js`** — container-side channel MCP server. Connects to the
  daemon at `host.docker.internal:MRC_ROOM_PORT`, registers `{sessionId, repo, room?}`, exposes
  `ask_peer`/`reply`/`sign_consensus`, pushes daemon frames into the session as `<channel>`
  tags. Untrusted-data framing in its `instructions`.
- **`src/commands/pair.js`** — `ensureRoomDaemon()` (auto-start the detached daemon, reuse if
  live) + `roomSessionEnv()` (the per-session env).
- **`src/commands/rooms.js`** — `mrc rooms status|brake|resume|steer|end` via the daemon
  control port.
- **`src/rooms.js`** — room-dir manager (`ensureRoom`, `appendThread`, `writeConsensus`, …) at
  `~/.local/share/mrc/rooms/<roomId>/`.
- **`container/mrc-channel-launch.exp`** — `expect` wrapper: auto-accept the dev-channel prompt,
  then `interact`.

**Modified:**
- **`mrc.js`** — `--rooms`/`--room` launch path (ensure daemon, drop API key, `/rooms` mount,
  room labels); `mrc rooms` dispatch.
- **`src/config.js`** — `--room <name>` and `--rooms` flags.
- **`src/docker.js`** — `labels` param on `runContainer` (room labels).
- **`Dockerfile`** — `expect`; `/opt/mrc-channel` with a local `@modelcontextprotocol/sdk`; copy
  the channel server there + the `.exp` wrapper.
- **`entrypoint.sh`** — pass `MRC_ROOM_PORT` to the firewall; when set, launch via the `expect`
  wrapper with `--dangerously-load-development-channels server:room`.
- **`init-firewall.sh`** — allow the one `MRC_ROOM_PORT` (modeled on the clipboard/notify rule).
- **`container/container-setup.js`** — when `MRC_ROOM_PORT` set, write `/tmp/mrc-room-mcp.json`
  pointing at `/opt/mrc-channel/mrc-channel-server.js`.

**Dead code (superseded by the daemon; remove in Phase 5):** `src/proxies/room-broker.js`,
`src/commands/room.js`, and their `/tmp/room-test/test-broker.mjs` / `test-room.mjs`.

**Env vars:** `MRC_ROOM_PORT` (daemon port), `MRC_ROOM_HOST` (`host.docker.internal`),
`MRC_SESSION_ID`, `MRC_REPO_NAME`, `MRC_ROOM` (optional explicit name), `MRC_ROOM_TURN_CAP`
(optional, default 20).

## 8. Data flow — one ask

1. Human: "ask the server: …". Agent A calls `ask_peer({peer:"server", question})`.
2. Channel A → daemon: `{type:"ask", peer, question}`.
3. Daemon resolves "server" → forms/looks-up the pairing → appends `thread.log` → pushes
   `{type:"deliver", text:'Peer (client) says: "…" [turn N/M]'}` over server's socket.
4. Channel B → session B sees `<channel source="room">…</channel>`. Agent B answers via `reply`.
5. Channel B → daemon `{type:"msg", text}` → routed to A as the next `deliver`. Loop until
   consensus / cap / stall / brake.

Daemon-applied framing: peer messages `Peer (<repo>) says: …`; human steers `[Human directive]:
…`. Those are the only two message classes a session sees.

## 9. Pairing & control

Per-pairing state in the daemon: `Running | Paused` + `pauseReason ∈ {brake,turnCap,stall,
consensus}`, `turn`/`turnCap` (default 20), `lastActivityAt`, held message, `signed` map.

- **brake** → Paused, stop delivering, stash next message.
- **turnCap** → Paused at `turn ≥ cap`. **stall** → idle > 2 min → Paused + notify.
- **consensus** → both `sign_consensus` with matching normalized text → write `consensus.md` →
  Paused + notify.
- **resume** → deliver held, continue. **steer** → inject `[Human directive]` (drop held),
  resume. **end** → drop the pairing.

CLI: `mrc rooms status` (sessions + pairings), `mrc rooms brake|resume|end`,
`mrc rooms steer [--target a|b] <text>` (applies to the sole active pairing).

## 10. Phases & progress

- **Phase 0 — Transport spike** ✅ *done.* Prove channels deliver into a live session on Max
  (the in-container `curl → reply "42"` round-trip).
- **Phase 1 — Relay engine** ✅ *done, validated (6/6 logic tests).* Per-pairing state machine:
  relay + untrusted framing + brake + turn-cap + stall + consensus. (Lives per-pairing inside
  `room-daemon.js`.)
- **Phase 2 — Channel transport** ✅ *done, validated.* Channel server
  (`ask_peer`/`reply`/`sign_consensus`), daemon protocol, ESM resolution via `/opt/mrc-channel`,
  container wiring (Dockerfile/entrypoint/firewall/`expect` auto-accept).
- **Phase 3 — Ambient pairing** ✅ *done, host-validated.* Detached daemon (registry, on-demand
  + named-room pairing), `--rooms` launch + `ensureRoomDaemon` + `/rooms` mount, `mrc rooms`
  CLI. Validated end-to-end on the host (no Docker): daemon auto-start → real channel servers
  register + auto-pair → `mrc rooms` controls them.
- **Phase 4 — Docker integration test** 🔧 *in progress — first rebuild surfaced two issues.*
  - **(fixed) Daemon-startup hang:** the first `--rooms` session blocked silently while
    `ensureRoomDaemon` polled for up to 5 s (2nd window was instant — daemon already up). Now
    prints "◎ Booting the negotiation-room daemon… ready."
  - **(OPEN — needs a decision) `expect` activation is broken.** On the rebuild it failed to
    auto-accept the dev-channel prompt (session 1: had to accept manually) and garbled the TUI /
    input (session 2: arrow keys as `^[[B`, leaked terminal DA response, unusable). Root cause:
    `expect` mishandles PTY size/raw-mode for Claude's fullscreen Ink UI.
  - **Investigation findings (claude 2.1.167, in-container):**
    - Dev-channel acceptance is **NOT persisted** anywhere in `~/.claude` (full-tree diff) → no
      "bake the accepted flag" shortcut.
    - `-p` mode does **not** prompt and runs clean — but `-p` drops channel events (unusable for
      a live session).
    - Driving the prompt by PTY is **version-brittle**: a harness that worked at 2.1.160 behaves
      differently at 2.1.167. We're auto-answering a *research-preview* prompt whose wording
      shifts between releases.
    - The non-dev `--channels` flag does **not** prompt; the dev prompt is specific to
      `--dangerously-load-development-channels`.
  - **(reverted) the PTY/`expect` auto-accept was dangerous — removed.** Auto-injecting
    `1<Enter>` landed on an unintended menu on a real run and triggered a compact. Replaced with
    **direct launch + manual accept**: the entrypoint runs `claude
    --dangerously-load-development-channels server:room --mcp-config …` directly (no wrapper).
    Claude renders natively (the wrapper *was* the garbling); the user accepts the one-time
    prompt by hand. `expect` and `mrc-channel-launch.py` removed.
  - **(round 2) explicit, no-confabulation flow.** First test showed the agent *confabulating* a
    "handshake" (reframing existing context as a peer chat). Fixed structurally: a `list_peers`
    tool returns the REAL connected sessions, and the channel instructions now mandate
    discover-first / never-fabricate / relay-only-real-`<channel>`-messages. Flow: human asks to
    consult → agent calls `list_peers` → shows the real list → human picks → agent
    `ask_peer(<exact name>)`. (7/7 daemon tests incl. list, label match, close.)
  - **(round 2) session naming.** Room identity = the `mrc pick` session name (label) if any,
    else repo basename; shown in `mrc rooms status` as `name (repo) [id]`; `ask_peer` matches on
    name+repo. Disambiguates multiple sessions from one repo.
  - **(round 2) close notifies both sides** and preserves the transcript.
  - Remaining Phase-4 checks (next rebuild): clean native startup + manual accept; container→
    daemon over the firewall (`mrc rooms status` shows both); the explicit list→pick→relay round
    trip; `/rooms` mount; Max auth.
- **Phase 5 — Polish & hardening** ☐ *stubbed.* Inline markers (`→ sent` / `← replied` /
  `✎ consensus`); consensus sign-off UX + notifications; turn-cap/stall tuning; daemon lifecycle
  (auto-shutdown when idle, health/restart, `mrc rooms stop`); remove dead code
  (`room-broker.js`/`room.js` + tests); socket reconnect/replay policy; optional co-typing
  buffer (~500 ms) so a channel push doesn't interrupt mid-keystroke.
- **Phase 6 — Stretch** ☐ *stubbed.* Per-repo peer aliases in `.mrcrc`; background-subagent
  delegation for context-free asks (answer from repo B without a live B session); >2-party
  rooms; richer room-view TUI; in-flight per-message edit; strict per-hop approval mode.

## 11. Rebuild-test (Phase 4 recipe)

```bash
docker rmi mister-claude                 # rebuild (Dockerfile/entrypoint/firewall changed)
# add one line to ~/.mrcrc:  --rooms     # enables ambient rooms everywhere
mrc pick     # client repo (first session auto-starts the daemon)
mrc pick     # server repo
#   then in the client session:  ask the server: <question>
mrc rooms status                          # observe; brake / steer / resume to supervise
```

## 12. Open items, limitations, follow-ups

- **Phase-4 unknowns** (rebuild-only): `expect` ↔ Claude TUI robustness (Node-PTY fallback
  ready); whether the agent reliably maps "ask the server" → `ask_peer`; firewall path to the
  daemon; co-typing interaction.
- **Daemon lifecycle:** currently never auto-stops (harmless local listener). Add idle
  shutdown + `mrc rooms stop` in Phase 5.
- **Steering target default** is "both"; per-watched-side default is a possible refinement.
- **Research-preview channels:** monitor for upstream flag/protocol changes; keep the channel
  server thin.
- **Dead code** from the pre-ambient broker model is still in the tree (see §7) — slated for
  Phase-5 removal.
- **Closing / resuming rooms (implemented).** *Close:* human-initiated and **selective** —
  `mrc rooms end <roomId>` closes one room (ids from `mrc rooms status`); with no id it acts on
  the sole open room and refuses if several are open (never "close all"). `brake`/`resume`/`steer`
  take the same optional `<roomId>`/`--room`. Both sides are notified; transcript/`consensus.md`
  preserved (no agent self-close). *Resume:* room ids are now **stable** — a `--room <name>` uses the name; an ambient
  pairing uses the sorted participant labels (same pair → same room dir). So closing then
  reopening/re-asking resumes the same room, with `thread.log`/`consensus.md` accumulating across
  sessions. *Catch-up* is point-at-file: the connect notice tells each agent to read
  `/rooms/<id>/thread.log` for any prior history, so resume never depends on agent memory.
  Future: explicit multi-topic named rooms per pair; an agent `request_close` surfaced to the
  human for confirmation.
