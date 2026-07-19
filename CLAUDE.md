# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Mister Claude (`mrc`) is a sandboxed Docker container launcher for Claude Code with an iptables firewall. It runs Claude Code inside a locked-down container where only whitelisted domains are reachable (api.anthropic.com, platform.claude.com, registry.npmjs.org, the OpenAI/Codex endpoints — api.openai.com, auth.openai.com, chatgpt.com — sentry.io, statsig endpoints).

## Architecture

The system has two layers: a **Node.js host launcher** (`mrc.js` + `src/`) and a **container runtime** (Dockerfile, entrypoint, firewall).

> **Note:** A legacy bash launcher (`mrc` shell script) exists but is deprecated and frozen. All new development targets the JS version. Do not add features to the bash `mrc`.

### Host-side (Node.js — runs on macOS/Linux)

1. **`mrc.js`** — Main entry point. Loads config from `~/.mrcrc` (global) and `<repo>/.mrcrc` (per-repo), parses flags and subcommands (`status`, `sessions`, `pick`), starts Colima if needed, builds the Docker image with the user's UID/GID, discovers `.sandboxignore` files recursively, starts clipboard and notification proxies, creates per-repo config volumes, and runs the container with the repo bind-mounted at `/workspace`. Supports `--daemon` mode (detached containers), `--json` mode (stream-json output), and `--agent` selection (claude or codex).

2. **`src/colima.js`** — Colima VM management. Auto-starts Colima with host-detected CPU/memory defaults (all cores, half RAM with 8GB floor). Supports `--colima-cpu` and `--colima-memory` overrides.

3. **`src/config.js`** — Config file parsing (`.mrcrc`), `.env` loading (with 1Password `op://` support), and CLI argument parsing. Loads API keys for both Anthropic and OpenAI.

4. **`src/docker.js`** — Docker image building, container launching (interactive and daemon modes), `mrc status` display, and volume naming.

5. **`src/sandboxignore.js`** — Recursive `.sandboxignore` processing. Files are masked with `/dev/null`; directories get anonymous volume overlays.

6. **`src/proxies/clipboard-proxy.js`** — In-process TCP proxy serving clipboard content (text and images) to the container via `host.docker.internal`. No external `socat` dependency.

7. **`src/proxies/notify-proxy.js`** — In-process TCP proxy receiving notification messages from the container and firing native desktop notifications (`terminal-notifier` on macOS, `notify-send` on Linux).

8. **`src/sessions/`** — Session management: listing, naming, resuming, interactive picker, AI-generated names/summaries, and tool-miss detection from transcripts. **`src/sessions/codex.js`** is the Codex-side counterpart: it parses Codex's JSONL "rollouts" (from the repo-local store — see *Codex session resume* below) into the same row shape the picker uses, so `--agent codex` browses its own sessions with no Claude-only machinery.

9. **`src/ports.js`** — Dynamic port allocation starting from `MRC_PORT_BASE`.

10. **`src/context.js`** — Docker build context resolution with fallback paths (`<scriptDir>`, `~/.local/share/mrc/`, `$MRC_HOME/`), enabling standalone binary installs.

11. **`src/constants.js`** / **`src/output.js`** — Banner art, verbose logging, and spinner utilities.

### Container-side (runs inside Docker)

12. **`Dockerfile`** — Builds on `node:22-slim`. Installs Claude Code via native binary download, installs plugins from the official marketplace, installs Codex CLI (OpenAI), installs Playwright + Chromium (the `mrc-browse` headless-browser helper for in-team testing), creates a non-root `coder` user, and grants passwordless sudo only for the firewall script.

13. **`entrypoint.sh`** — Container startup. Waits for DNS (up to 30s), runs the firewall via sudo, runs `container-setup.js` for config merging, optionally logs in Codex, then starts the selected agent (`claude` or `codex`).

14. **`init-firewall.sh`** — Network lockdown. Preserves Docker's internal DNS NAT rules, resolves whitelisted domains to IPs via `dig`, populates an `ipset`, sets iptables default policy to DROP with explicit REJECT for immediate feedback, blocks all IPv6, and verifies by confirming `example.com` is unreachable.

15. **`container/container-setup.js`** — Node.js config setup run by the entrypoint. Merges plugin config from build-time defaults into the persistent volume, restores Claude config from backups if needed, symlinks Claude's project store into `/workspace/.mrc/`, configures the `Stop` hook for desktop notifications, and sets up the default status line.

16. **`container/mrc-notify-hook.js`** — Container-side turn-complete hook handler for **both** agents. Claude Code delivers hook JSON on **stdin** (`hook_event_name`, `last_assistant_message`); Codex delivers it as the **last argv** (`type: agent-turn-complete`, `last-assistant-message` — hyphens). Extracts and truncates the message, then sends the repo name + summary to the host notification proxy via TCP. **`container/codex-config.js`** writes Codex's side of that (plus its status line) into `~/.codex/config.toml` — see *Codex status line and notifications* below.

17. **`container/mrc-statusline.js`** — Container-side Claude Code `statusLine` handler. Reads the statusline JSON from stdin and renders a color-coded context-usage progress bar, 5h/7d rate-limit gauges, and the session name.

### Negotiation rooms (cross-session consultation)

Lets two running `mrc` sessions consult each other through a host-mediated relay — one session's agent asks a peer and the reply loops back autonomously. On by default for interactive Claude sessions (`--no-rooms` opts out). **Deep dive, architecture, and design decisions live in `docs/negotiation-rooms.md`.**

- **`src/proxies/room-daemon.js`** — The host room daemon: a detached, version-stamped singleton that registers sessions, forms pairings, relays messages with untrusted-data framing, enforces brake / turn-cap check-in / self-healing stall (with a FIFO held-queue), writes `thread.log` + the `consensus.md` shared summary, and **hosts the dashboard**. Records `~/.local/share/mrc/room-daemon.json`; idle-shuts-down ~10 min after the last session leaves (an open dashboard keeps it alive).
- **`src/commands/pair.js`** — `ensureRoomDaemon()` (version-checked reuse / in-place refresh / fresh boot), `restartRoomDaemon()`, `stopRoomDaemon()`, and `roomSessionEnv()` (per-session env).
- **`src/commands/rooms.js`** — the `mrc rooms` CLI (`status` / `brake` / `resume` / `steer` / `end` / `restart` / `stop` / `dashboard`) over the daemon's control socket.
- **`src/rooms.js`** — room-dir manager for `~/.local/share/mrc/rooms/<roomId>/`: `ensureRoom`, `appendThread`, `writeConsensus`, `listRooms`.
- **`src/rooms-dashboard.js`** + **`src/dashboard.html`** — a dependency-free localhost web app served from inside the daemon: the unified, **teams-first** dashboard (see "Agent teams" below). `rooms-dashboard.js` is the HTTP layer (serves the app + the `/api/*` endpoints); `dashboard.html` is the single-page UI. It shows every room's full `thread.log` + summary (live & historical), per-pause **catch-up panes** (agent-written handoffs, with explicit mark-reviewed), the `@user` inbox, and pause/resume/steer/end controls.
- **`container/mrc-channel-server.js`** — container-side MCP "channel" server (loaded via `--dangerously-load-development-channels server:room`). Connects to the daemon and exposes `list_peers`/`ask_peer`/`reply`/`update_notes`/`pause_room`/`resume_room`, pushing peer messages into the session as `<channel>` tags. In **team mode** (`MRC_MEMBER_HANDLE` set) it instead exposes `send_message`/`list_team`/`ask_user`.

### Agent teams (multi-agent orchestration)

Builds **on top of negotiation rooms**: generalizes the 2-party pairing into N-party **teams** of agent **members**, each in its own container, addressing each other by **@mention** and steered by the human from a web UI or any member's console. Declared in a `team.json` roster, launched with `mrc team up`. **Deep dive, topology, and the test/rebuild recipe live in `docs/agent-teams.md`.**

- **`src/teams/names.js`** — French first-name pool (with Spaceballs easter eggs) + unique `first/backend` handles + @mention parsing.
- **`src/teams/personas.js`** — role registry (architect/engineer/critic/adversary/ultracritical/user-defender/researcher/tester, plus media makers designer/sound-designer/composer) + `buildPersona()`, the team protocol injected via `--append-system-prompt`. The **tester** uses the in-container headless browser (`container/mrc-browse.js` → Playwright/Chromium) to verify web/game output.
- **`src/teams/media.js`** — media-maker members: a designer (Gemini image), sound-designer / composer (ElevenLabs) generate an asset FILE into their territory on @mention. Keys resolve per-repo (`repoEnvKey`).
- **`src/teams/presets.js`** — ready-made team rosters (game / web / mobile / backend) for `mrc team up --preset` and the builder's preset dropdown.
- **`src/teams/roster.js`** — parse/normalize `team.json` → members (unique handles, resolved territory/mount/tier, one lead per team) + derived rooms (one team room per team + a leads room with `@user`). Deterministic naming so members rebind across runs.
- **`src/teams/room-engine.js`** — the generalized relay engine (transport-agnostic, injected I/O): member-set rooms, **directed @routing**, multi-room membership, room-tagged delivery, the **`@user` inbox** (questions vs notifications/FYIs, reply/dismiss/reopen, stable `#N` ids + per-message structured transcript for jump-to-original, `answeredVia` for cross-surface resolve), brake/resume/turn-cap/steer for N members, the worker queue, and redefine-with-prune.
- **`src/teams/worker-runner.js`** — drives non-Claude (task-worker) members: drains the worker queue, batches a burst into one invocation, runs the worker's CLI, posts the reply back.
- **`src/teams/session-id.js`** — shared `memberSessionId` (sha1 of `org\0handle`) so a registering session binds to the right org (cross-org disambiguation).
- **`src/teams/trust.js`** — trust-boundary hygiene: `defangTrustMarkers` neutralizes forged `[Human directive]`/`[Human reply]` look-alikes in untrusted peer/worker text (run at delivery + worker-prompt build); `snippetForTrustedLine` sanitizes a member-authored quote embedded in a trusted reply line.
- **`src/teams/telegram.js`** — Telegram Bot API client + `createTelegramBridge`: getUpdates long-poll, advance-offset-only-after-success, `update_id` dedup, 409-conflict backoff.
- **`src/teams/telegram-auth.js`** — per-org pairing/auth state: dashboard-**Confirm** pairing (no auto-bind/TOFU), strict `from.id`+`chat.id` allowlist, reject non-private chats, `.env` pre-pin, unpair, the dashboard `tgView`.
- **`src/commands/team.js`** — the `mrc team` CLI (`up`/`status`/`console`/`down`/`define`/`exec`), member launch wiring (territorial volumes, persona files, per-member session ids/volumes), and the worker container exec.
- **`src/dashboard.html`** — the **unified, teams-first** web app (one SPA: **Teams / Rooms / Inbox / Build**), served by the room daemon. 3-pane workspace: nav rail → contextual list → detail. Surfaces the org roster + topology, all rooms (team + leads + legacy consult) with live state + catch-up panes, the `@user` **inbox** as a first-class destination, the in-app **team-builder**, and per-room steer/controls. Adds **per-project tabs** (per-org context, ❓ needs-you badge, off-screen `‹N/N›` hint; **close = suspend** — stop the members but keep the team/transcripts/history, resume later — vs **🗑 Delete project** = forget the org from Mister Claude, **files kept**), the inbox model (questions vs reply-optional 🔔 FYIs, dismiss/reopen, `[#N]`/`(re #N)` jump-to-original, "answered via Telegram"), **Telegram pairing** Confirm, and a semantic CSS-var **design system** (the Mr. Claude purple-brand palette, WCAG-AA, keyboard a11y). Builder endpoints (`/api/team-preview|save|define`) + `/api/teams` + `/api/state` + `/api/room` + `/api/tg` + `/api/action` are in `rooms-dashboard.js`. All state-changing `/api/*` are **CSRF-token-guarded** (persisted token + Origin + Host) and the SPA **confirms a 2xx before closing** any panel (no optimistic-close).

The daemon (`room-daemon.js`) runs the team engine + worker runner + **per-org Telegram bridges** **alongside** legacy pairings, persists orgs/inbox/Telegram state, and reconciles launch records against each member's live dtach session (#34: every live member runs in its own `dtach` master + `ttyd` viewer, no tmux); `mrc.js`/`config.js` gain a `team` subcommand and `--member`/`--roster` launch mode; `entrypoint.sh` injects the persona and has a one-shot worker-exec branch; `docker.js` adds `runWorkerExec`. **`mrc rooms restart`** is version-stamp-verified (escalates to SIGKILL, fails loudly rather than silently serving stale code) — host-side `src/` changes ride the daemon reload; container-side changes (`container/`, Dockerfile, `entrypoint.sh`) still need a relaunch to rebuild the image — a plain one, not `--rebuild` (see Development Workflow).

### Legacy (deprecated — do not modify)

18. **`mrc`** (bash) — Original host-side launcher. Superseded by `mrc.js`. Kept for reference only.

19. **`clipboard-proxy.sh`** / **`notify-proxy.sh`** / **`mrc-notify-hook.sh`** — Original bash/socat proxies and hook. Superseded by the Node.js equivalents in `src/proxies/` and `container/`.

20. **`mrc-statusline`** (Python) — Original status line script. Superseded by `container/mrc-statusline.js`.

## Key Design Decisions

- **Container is the security boundary** — Claude runs with `--dangerously-skip-permissions` because the Docker container + firewall provide isolation, not Claude's own permission system.
- **UID/GID matching** — The Docker image is built with the host user's UID/GID as build args so bind-mounted files have correct ownership.
- **Config persistence** — `~/.claude` is stored in a per-repo Docker volume (`mrc-config-<hash>`) that survives container restarts. Each repo gets its own volume, keyed by an MD5 hash of the repo path, to avoid cross-project contamination. A separate `mrc-codex-<hash>` volume persists Codex config.
- **Project-local memory** — Claude Code's project store (`~/.claude/projects/-workspace/`) is symlinked into `/workspace/.mrc/` so that memory, conversation history, and project settings live in the repo itself. This survives volume resets and travels with the project. `.mrc/` is auto-added to `.gitignore`.
- **Auto-resume** — The entrypoint passes `--continue` to Claude Code, so re-opening a repo automatically resumes the last conversation. A fresh conversation starts if no prior session exists.

- **Codex session resume mirrors Claude's, but the plumbing differs in two ways.** (1) *Flag syntax*: resume is an **option** for Claude (`--resume <id>` / `--continue`) and a **subcommand** for Codex (`resume <id>` / `resume --last`), so `container-setup.js` computes a per-agent flag string that `entrypoint.sh` expands **before** the options. (2) *Visibility*: Codex writes rollouts to `~/.codex/sessions`, which lives in the `mrc-codex-<hash>` **volume** and is invisible to the host — so container-setup symlinks it to `/workspace/.mrc/codex-sessions`, the same project-local-memory move already used for Claude's project store. That symlink is what makes a **host-side** `mrc pick --agent codex` possible at all; it also survives a volume reset and unifies sessions across the per-instance `-N` volumes. Because `codex resume` on a missing session is a **hard startup failure** (it would take the entrypoint down), container-setup emits a resume flag only after confirming a matching rollout exists, and otherwise downgrades to a fresh session with a warning. Auto-resume deliberately does **not** use `codex resume --last`: that flag applies its own opaque selection rules (cwd filtering, an internal ledger, non-interactive exclusion) and was observed not to resume, while `resume <id>` works. `container/codex-sessions.js` resolves the id itself, which also buys an invariant the tests pin: **auto-resume continues exactly the session `mrc pick --agent codex` lists first**, since both rank by the same recency and skip the same `codex exec` worker rollouts. It scans **both** stores (the repo-local one and `~/.codex/sessions`) and dedups by realpath, so it stays correct whether or not the symlink is intact — the observed failure was the migration copying rollouts into the repo store and emptying the volume dir *without* the symlink landing, which left a volume-only scan blind while `mrc pick` (reading the repo store) worked fine. container-setup logs a one-line store summary (rollout count, symlink state, chosen id) so that class of failure needs no guesswork next time. The picker excludes non-interactive (`codex exec`) rollouts, matching what `codex resume --last` skips by default — otherwise `mrc team exec` worker turns would flood the list. Sessions are labelled with **Codex's own generated title**, so no Haiku naming is involved; the rollout schema is internal to Codex, so the parser is defensive — an unrecognized shape degrades a row rather than dropping the session, since the uuid alone is enough to resume.
- **Auto-update disabled** — `DISABLE_AUTOUPDATER=1` is set because the firewall blocks npm CDN hosts needed for updates. Use `mrc --rebuild` to get a new Claude Code version: the Dockerfile text is unchanged, so only a `--no-cache` build re-fetches the binary.
- **`.sandboxignore` (recursive)** — Can be placed anywhere in the repo tree. Each file's entries resolve relative to the directory containing it (like `.gitignore`). Files are masked with `/dev/null` (appear empty); directories get anonymous volume overlays (appear as empty dirs).
- **Host network lockdown** — The firewall only allows traffic to the host on the dynamically assigned proxy ports. All other host services (Postgres, Redis, etc.) are unreachable from the container.
- **Desktop notifications** — A Claude Code `Stop` hook fires on every response completion. The container-side hook script extracts a summary and sends it to the host-side notification proxy, which shows a native macOS/Linux notification.
- **Default status line** — The entrypoint writes a `statusLine` entry pointing at the statusline script only if the user hasn't already set one, so a `/statusline` customization always wins.
- **Container labeling** — Each container is labeled with `mrc=1`, `mrc.repo`, `mrc.repo.name`, and `mrc.web` for discovery by `mrc status`.
- **Config files (`.mrcrc`)** — Global defaults in `~/.mrcrc`, per-repo overrides in `<repo>/.mrcrc`. Both use the same format: one CLI flag per line, comments with `#`. All sources are merged (global + repo + CLI), with CLI flags taking precedence.
- **Multi-instance support** — Multiple `mrc` instances can run against the same repo. Each gets its own config volume (`mrc-config-<hash>-2`, `-3`, etc.) and dynamically allocated proxy ports. When a peer is already live, a launch is forced to a FRESH conversation (two sessions auto-resuming would both land on the newest conversation and trample each other) — but that force is **per-agent** (`countAgentPeers`, keyed on the `mrc.agent` container label), because Claude and Codex share no conversation store. Counting every peer regardless of agent was a real bug: an open Claude session silently defeated `mrc --agent codex`'s auto-resume, and it looked like broken resume rather than a deliberate fresh start, since `mrc pick` sets `resumeSession` explicitly and bypasses the force. A container with no `mrc.agent` label predates it and counts as `claude`. The force now also says out loud that it happened.
- **Dynamic port allocation** — Proxy ports are allocated by scanning for free ports starting from `MRC_PORT_BASE` (default 7722). The clipboard proxy takes the first free port, the notification proxy takes the next.
- **In-process proxies** — The Node.js launcher runs clipboard and notification proxies as `net.createServer()` instances in the same process. No external `socat` dependency required.
- **Codex status line and notifications are CONFIG, not scripts** — the inversion to remember: for Claude, mrc *supplies the renderer* (`statusLine` and the `Stop` hook both point at mrc scripts); Codex has no such hook, so mrc *configures Codex* instead, by editing `~/.codex/config.toml` in `container-setup.js`. Its status line is an ordered array of **built-in item identifiers** under `[tui]` (mrc sets `context-used`, `five-hour-limit`, `weekly-limit`, `thread-title`, `thread-id` — the same information mrc's Claude status line shows, though not the custom bar, which isn't expressible). An unrecognized identifier is silently dropped by Codex, so `test/codex-config.test.mjs` asserts every one against the known vocabulary. Notifications use Codex's **legacy top-level `notify`** array rather than its newer `[hooks]` table, because `[hooks]` is behind a trust gate that **silently no-ops** unless every launch passes `--dangerously-bypass-hook-trust`; `notify` has no gate. Codex exposes **no idle/waiting event** — `agent-turn-complete` is the only notify event, and it carries the same meaning as Claude's `Stop` (turn over, agent now waiting on you). Editing is **textual and additive**, never a parse/re-emit (that would eat the user's comments), and never overwrites a key the user set — the same doctrine as the Claude status line. Two TOML rules make placement load-bearing and are tested: a top-level key (`notify`) must be inserted **before the first `[table]` header** or it silently becomes a key *of* that table, and `[tui]` must be **reused rather than re-declared** — a duplicate table is a hard parse error that stops Codex from starting at all.

- **Multi-agent support** — `--agent codex` launches OpenAI Codex instead of Claude Code. The `MRC_AGENT` env var is passed to the container, and session post-processing (AI naming/summaries, tool-miss detection — all Claude-transcript-shaped) is skipped for non-Claude agents. Session *resume* and the *picker* are not skipped: both agents have them, via their own stores (see *Codex session resume*).
- **Codex auth is per-user, not per-repo** — Codex bills either a platform org (`OPENAI_API_KEY`) or a personal ChatGPT subscription (`codex login --device-auth`), and both write the same `~/.codex/auth.json`. The host cannot tell an unauthed volume from a subscription-authed one, so `mrc.js` does **not** gate the launch on a key; `entrypoint.sh` decides, where `codex login status` has ground truth. It acts **only when there is no existing login** — otherwise every boot's `--with-api-key` would silently downgrade a subscription login to platform billing. The auth persists in `mrc-codex-<hash>`, which `mrc team` worker-exec mounts too, so one device-auth covers codex task-workers. Device-auth (not the plain flow) is used because the browser is on the host and `localhost:1455` is unreachable from the container.
- **Colima resource detection** — CPU and memory for the Colima VM default to all host cores and half host RAM (8GB floor). Overridable via `--colima-cpu` and `--colima-memory` flags or `.mrcrc`.
- **Docker context resolution** — `mrc.js` searches for the Dockerfile in three locations: `<scriptDir>`, `~/.local/share/mrc/`, and `$MRC_HOME/`. This enables standalone binary installs separate from the Docker context.
- **Negotiation rooms are host-mediated and sandbox-safe** — cross-session consultation flows session → host daemon → session over one sanctioned host port (no container-to-container network, no new firewall egress). Peer messages are always framed as untrusted data (`Peer (<name>) says: …`); only the human's steers are trusted (`[Human directive]: …`). Rooms are a host-controlled bind mount (`/rooms`), not network. Room ids hash the two sessions' conversation UUIDs, so resuming both conversations deterministically rejoins the same room (history preserved); closing a room is human-only.
- **Rooms daemon + dashboard lifecycle** — one self-managing daemon serves all sessions (version-stamped, so it auto-refreshes when `room-daemon.js` changes; idle auto-shutdown). It also hosts the `mrc rooms dashboard` web UI, so the dashboard persists without a foreground tab and an open dashboard keeps the daemon alive. `consensus.md` is a _living shared summary_ refreshed by either agent via `update_notes` (not a signed gate); the turn cap (default 200, `MRC_ROOM_TURN_CAP`) is a periodic check-in that grants another window on resume.

- **Agent teams generalize rooms, federated and directed** — a team is N members in N containers on one host daemon. The anti-tangle design is three invariants: **containment** (members only reach their own rooms; cross-team only via the leads room, lead-to-lead), **scoped resolution** (`@role`/`@name` resolve within the originating room; `@user` is global), and **room-tagging** (so a lead in two rooms never confuses contexts). **Directed delivery** (a member only receives messages it's @mentioned in) is the floor control that prevents the N-way autonomous-volley explosion. **Territorial write isolation** avoids file contention (read-only `/workspace` except a member's own sub-tree, mounted rw on top) and **the human commits**. **Heterogeneity tiers by transport**: Claude members are live `/channels` participants; non-Claude (Codex/Qwen) members are forced to **task-workers** — a directed @mention invokes their CLI for one turn (the channel transport is Claude-only). A teammate's message — even the architect's — is **untrusted peer data**; only `[Human directive]`/`[Human reply]` is authoritative.

- **The `@user` inbox is a typed, persistent queue** — a member reaching the human creates an item that is a **question** (from `ask_user`) or a **notification/FYI** (from a plain `@user`). Both are **replyable** (a reply routes a `[Human reply]` back to the member); they differ only in framing — a question says "reply to answer", an FYI says "reply optional" — and **only questions badge** (push ≠ nag). Items can be **dismissed** (recoverable via show-dismissed → re-open) and **persist across daemon restarts** (`room-inbox.json`). Each carries a stable **`#N`** id stamped on its thread line; the human's reply is stamped `(re #N)`. The dashboard renders the transcript from a **structured per-message store** (`transcript.jsonl`) carrying the daemon-assigned `qid`/`reqid`, so the `[#N]` chip / `(re #N)` jump anchor from a trusted field — a member can't forge or hijack an anchor by putting `[#N]` in their own text (incl. a newline-injected fake line).

- **Telegram is an optional per-project bridge to the `@user` inbox** — each project supplies its **own** bot token via its repo `.env` (`MRC_TELEGRAM_BOT_TOKEN`, read **strictly per-repo**, no global fallback, so one project's bot never bleeds to another). Linking is **human-gated, not automatic**: you DM the bot `/start`, then **Confirm** the pending chat in the dashboard (strict `from.id`+`chat.id` allowlist, private chats only; an `.env` `MRC_TELEGRAM_CHAT_ID` pre-pins). Once linked, `@user` questions (❓ "reply to answer") and FYIs (🔔 "reply optional") **push** to Telegram with the same `#N`; replying there routes a `[Human reply]`; resolving on **either** surface edits the pushed message in place (H4 both ways). One bot serves one project — a token shared by two orgs is refused with a surfaced warning, not a silent 409 storm. Telegram inbound is untrusted and runs through the trust-marker defang.

- **Suspend vs delete are distinct and non-destructive** — closing a project tab **suspends** it (stops the member containers; the team, transcripts, and history stay; ▶ Resume relaunches). **Delete project** forgets the org from Mister Claude (stops sessions, removes the tab) but **deletes nothing on disk** — the repo, `team.json`, and transcripts remain, so it can be re-added with `mrc team up`.

- **Layered security, fail-loud** — the container/firewall is the primary boundary; on top: the dashboard's state-changing `/api/*` are guarded by a **persisted CSRF token** + Origin + Host checks (persisting the token survives a restart without weakening it — cross-origin still can't read it); the SPA **confirms a 2xx before closing** a panel and surfaces a 403/error instead of optimistic-closing; Telegram inbound is allowlisted; and forged `[Human directive]`/`[Human reply]` look-alikes in untrusted text are **defanged** at the injection sites. `mrc rooms restart` **verifies the new daemon's version stamp** (and SIGKILL-escalates the old process) so it never silently keeps serving stale code.

## CLI Reference

```
mrc [options] [path-to-repo] [-- claude-code-args...]

Options:
  -r, --rebuild        Force a full image rebuild (no cache)
  -v, --verbose        Show Colima and Docker output
  --daemon             Start container in background and print container ID
  -j, --json           Stream JSON output instead of interactive TTY
  -n, --new [name]     Start a new conversation (optionally named)
  -w, --web            Allow outbound HTTPS to any host
  --agent <name>       AI agent to launch: claude (default), codex
  --room <name>        Pair only with another session sharing this --room name
  --no-rooms           Disable cross-session negotiation rooms (on by default)
  --no-summary         Skip AI session summary on exit
  --no-notify          Disable desktop notifications entirely
  --no-sound           Disable notification sound (still shows notification)
  --colima-cpu N       CPUs for Colima VM (default: all host cores)
  --colima-memory N    Memory (GB) for Colima VM (default: half host RAM, min 8)

Commands:
  mrc status                              Show active containers across repos
  mrc pick [path]                         Interactive session picker (arrow keys)
  mrc sessions ls [path]                  List saved sessions
  mrc sessions name <name> [#] [path]     Name a session (Claude only — Codex titles its own)
  mrc sessions resume <name-or-#> [path]  Resume a specific session
  mrc sessions pick [path]                Alias for mrc pick
  (pick / sessions ls / sessions resume take --agent codex to browse the Codex session store)
  mrc rooms status                        Show the room daemon, sessions, and pairings
  mrc rooms dashboard                     Open the local web dashboard (daemon-hosted)
  mrc rooms brake|resume|end [room-id]    Pause / resume / close a room
  mrc rooms steer [--target a|b] <text>   Inject a trusted [Human directive] into a room
  mrc rooms restart|stop                  Refresh / stop the room daemon
  mrc team up [path] [--preset name]      Define + launch a team (per-member dtach session + embeddable ttyd terminal)
  mrc team status [path]                  Show the org, rooms, and the @user inbox
  mrc team console <handle> [path]        Attach to a running member's terminal
  mrc team exec <handle> "prompt"         Run a task-worker (codex/qwen) turn manually
  mrc team presets                        List ready-made team presets (game/web/mobile/backend)
  mrc team new --preset <name> [path]     Write a team.json from a preset
  mrc team down|define [path]             Close the org's rooms / define without launching
  (Or do it all in the GUI: mrc rooms dashboard → Build → 🚀 Launch → Console.)

Config files (~/.mrcrc or <repo>/.mrcrc, one flag per line):
  # Example ~/.mrcrc
  --no-sound
  --web
  --colima-memory 32

Environment:
  MRC_SESSION_NAMING_ANTHROPIC_API_KEY   Host-only Anthropic key for Haiku session
                       naming/summaries (.env next to mrc or ~/.config/mrc/.env).
                       The sandboxed session runs on Max/OAuth, not this key.
                       (Legacy ANTHROPIC_API_KEY still works as a deprecated fallback.)
  OPENAI_API_KEY       OpenAI platform key — OPTIONAL for --agent codex, and the choice of
                       BILLING LANE, not a requirement. Set it to bill a pay-as-you-go platform
                       org; omit it to bill a personal ChatGPT subscription (Plus/Pro/Team),
                       which entrypoint.sh links via `codex login --device-auth` on first run.
                       A key can never draw on a subscription's limits, so a subscription user
                       who sets one anyway gets that org's "Quota exceeded".
  MRC_PORT_BASE        Starting port for proxy allocation (default: 7722)
  MRC_ROOM_TURN_CAP    Room turn-cap window before a check-in pause (default: 200; 0 disables)
  MRC_DASHBOARD_PORT   Room dashboard port (default: 8787; 0 disables the daemon-hosted dashboard)
  MRC_TELEGRAM_BOT_TOKEN  Per-PROJECT Telegram bot token, read STRICTLY from the repo's own .env
                       (.env / .mrc/.env; no process.env or global fallback). Enables the Telegram
                       bridge for that project — then DM the bot /start and Confirm the pending chat
                       in the dashboard to link it.
  MRC_TELEGRAM_CHAT_ID Optional per-repo .env pre-pin (skips the dashboard Confirm for that chat id).
  MRC_HOME             Override Docker context directory (advanced)
```

## Development Workflow

There is no build system or linter. The host-side logic has a **Node.js test suite** (`node --test test/*.test.mjs` — 150 tests covering the room engine + `@user` inbox, the daemon round-trips, Telegram transport/auth, the trust-marker defang, CSRF, org isolation, and the worker runner); the container-launch and worker-exec paths still need a Docker rebuild to validate (see `docs/agent-teams.md`). Otherwise the project is Node.js modules (`mrc.js` + `src/`), a Dockerfile, shell scripts for the container entrypoint and firewall, and Node.js container scripts (`container/`).

**To test changes:** run `mrc.js` against a target repo and verify behavior. `buildImage()` runs on every launch, so which rebuild you need depends on *what* changed — the two cases are not the same cost:

```bash
# Changed a file the Dockerfile COPYs (entrypoint.sh, init-firewall.sh, container/*)?
# Just relaunch. Every COPY sits at Dockerfile lines 87-142, AFTER the expensive RUN layers
# (apt, Claude binary, codex, sharp, Playwright+Chromium), so Docker's cache rebuilds only
# from the changed COPY down. Seconds.
node mrc.js ~/some/repo

# Want to BUST the cache — a new Claude Code / Codex version, fresh apt — where the
# Dockerfile text is unchanged so Docker would happily reuse a stale layer?
node mrc.js --rebuild ~/some/repo     # rmi -f + --no-cache; several minutes (re-downloads Chromium)
```

Editing the Dockerfile itself needs no flag either — changing a line invalidates from that line down on its own. Prefer `--rebuild` over a manual `docker rmi`: `src/docker.js:132-141` shows both end in the same `--no-cache` build, but `--rebuild` uses `rmi -f`, so it won't fail when a stopped container still references the image.

Changes to `mrc.js` and `src/` take effect immediately (they run on the host) — except `src/proxies/room-daemon.js`, which runs as a long-lived daemon: apply it with `mrc rooms restart` (or it auto-refreshes on the next launch via its version stamp).

**To add allowed domains:** edit the `for domain in ...` loop in `init-firewall.sh`.

**To add system packages:** add to the `apt-get install` line in the Dockerfile.

## Conventions

- All bash scripts use `set -euo pipefail`
- User-facing output uses Spaceballs-themed messaging
- Host-container communication uses TCP proxies via `host.docker.internal`
- Proxy ports are dynamically allocated, not hardcoded
- The JS launcher (`mrc.js`) is the canonical implementation; the bash `mrc` is deprecated
