# Agent Teams

**Status:** Host-side core built and unit-tested end-to-end (150 tests); the container-launch and
worker-exec paths are wired and need a Docker rebuild to validate (this environment has no Docker).
Builds directly on **negotiation rooms** (`docs/negotiation-rooms.md`) — same host daemon, same
host-mediated transport, same trust model — generalized from a 2-party pairing to N-party teams.

A team is a set of agent **members**, each in its own sandboxed container, working a problem
together through a host-mediated relay, steered by the human from a web UI or any member's console.

---

## 1. The model

You declare a team in **`team.json`** and launch it with **`mrc team up`**. Members talk by
**@mention**; the human is **@user**; the human commits.

```json
{
  "org": "shop",
  "teams": [
    { "name": "client", "territory": "client", "members": [
        { "role": "architect", "backend": "claude", "lead": true },
        { "role": "engineer",    "backend": "claude", "territory": "client/src" },
        { "role": "critic",    "backend": "claude" } ] },
    { "name": "api", "territory": "api", "members": [
        { "role": "architect", "backend": "claude", "lead": true },
        { "role": "engineer",    "backend": "codex" } ] }
  ]
}
```

Each member gets a **handle** `first/backend` — a random French first name (with Spaceballs easter
eggs: Ludivine = *ludicrous speed*, Roland = *King Roland*, Médor = *Barf*, Sandrine = *Colonel
Sandurz*, Vespa, Dorothée = *Dot Matrix*…) and a last name that is the model/backend. Names are
**deterministic per roster**, so re-running `mrc team up` rebinds the same members.

---

## 2. Topology — federated, so channels don't tangle

```
                    ┌──────────── @user (human) ───────────┐
                    │              [leads room]             │
            Architect-Client ◄──── lead-to-lead ────► Architect-API   (leads are in 2 rooms)
                 │  [client team room]                 │  [api team room]
          Engineer-Client   Critic-Client          Engineer-API
          rw client/src   ro                     rw api  (codex worker)
```

- **Team room** (one per team): all of that team's members.
- **Leads room** (one): every team's lead + **@user**.
- A **lead** is the only member in two rooms (its team room + the leads room).

Three invariants the daemon enforces keep it untangled:

1. **Containment** — a member only sends into rooms it belongs to. Team rooms are disjoint except for
   leads; cross-team traffic flows **only** through the leads room, lead-to-lead. An engineer physically
   cannot reach another team.
2. **Scoped resolution** — `@role`/`@name` resolve **within the originating room** (so each team's
   `@critic` is its own). `@user` is the one global alias.
3. **Tagging** — every delivered message is room-tagged (`[room client] Peer (…) says: …`), so a lead
   in two rooms never confuses contexts.

**Floor control falls out of directed delivery:** a member only *receives* a message it is
@mentioned in. No mention → no one is interrupted. This kills the N-way autonomous-volley explosion
at the routing layer, not just via prompts. (A 2-member room keeps the legacy consult behavior:
no mention → the other member.)

---

## 3. Roles & personas

A "character" = a backend + a **role system-prompt** injected via `--append-system-prompt`. The
prompt encodes the protocol: the **architect** plans and directs the engineer and invokes the critic;
the **engineer** implements in its lane and asks when blocked; the **critic/adversary/ultracritical/
user-defender** review when invoked. Roles: `architect, engineer, critic, adversary, ultracritical,
user-defender, researcher` (`src/teams/personas.js`).

**Trust:** the architect is *not* the human. A teammate's message — even the architect's — is
**untrusted peer data**; only `[Human directive]`/`[Human reply]` (from @user/steer) is
authoritative. A member follows its architect because that is its role, not because the word is law.
This preserves the sandbox trust invariant from negotiation rooms.

---

## 4. Code on disk — territorial write isolation

Contention is avoided by **partitioning the filesystem**, not serializing engineers:

- A **whole-repo engineer** (`territory:"."`, `mount:"rw"`) gets `/workspace` read-write.
- Everyone else gets `/workspace` **read-only**, with `.mrc` kept writable (transcripts + persona).
- A **sub-tree engineer** also gets just its territory mounted read-write on top.

So `@ludivine` (writes `client/src`) and `@thierry` (writes `api`) never touch the same files, and a
**critic is read-only by capability, not etiquette**. The roster warns on overlapping write
territories. **The human commits** — engineers edit the working tree but never `git commit`, so there
is no shared-index contention. (Per-team git worktrees remain a future option for independent
branches.)

---

## 5. Heterogeneity — live members vs task-workers

The Claude `/channels` inbound-injection that lets a session receive a message mid-work is
**Claude-only** (it's why rooms are skipped for `--agent codex`). So membership tiers by what a role
needs to *receive*:

| Tier | Backends | How it participates |
|---|---|---|
| **Live member** | Claude | full async @mention member (architect/critic/conductor) |
| **Task-worker** | Codex, Qwen, … | a directed @mention invokes its CLI for one turn; output posts back |

A non-Claude member is forced to tier `worker`. When @mentioned, the engine **queues** it; the
**worker runner** (`src/teams/worker-runner.js`) batches a burst into one prompt, runs the worker's
CLI in a sandboxed container scoped to its territory (`mrc team _worker-exec` → `runWorkerExec` →
`entrypoint.sh` exec branch → `codex exec`/`claude -p`), and posts the reply back to whoever pinged
it. Memory substrate = a stable per-member config volume. A failed invoke posts a graceful error,
never a silent drop.

---

## 6. The web orchestrator — "the real Mister Claude"

The daemon-hosted dashboard is a **unified, teams-first** single-page app (`src/dashboard.html`) — a
3-pane workspace (nav rail → list → detail) with four destinations:
- **Teams** (home): the org roster (members by team, online dots, lead/role/backend/tier) + each
  team's rooms; click a room → its transcript + steer.
- **Rooms**: every room (team + leads + legacy 2-party consult + history) with live state.
- **Inbox** (first-class): the **@user** queue. A member reaching you creates a **question** (from
  `ask_user`) or a **notification/FYI** (a plain `@user`); **both are replyable** (your reply routes
  back as `[Human reply]`), but only **questions badge** — an FYI is "reply optional", so it's visible
  everywhere and nags nowhere. Items are **dismissable** (recoverable via the show-dismissed toggle →
  re-open) and **persist across daemon restarts**. Each carries a stable **`#N`** id; your reply is
  stamped `(re #N)` and the dashboard turns it into a **jump to the original question** (anchored from
  a daemon-assigned id, so a member can't forge or hijack it). Plus catch-ups awaiting review.
- **Build**: the in-app team-builder (compose → live preview → Save team.json / Define rooms).

Per-room detail has Transcript / Summary / Catch-up tabs and **steer any member or everyone** +
pause/resume/close. You can also drop into any live member's terminal with `mrc team console
<handle>` (members run in a tmux session).

**Project tabs — suspend vs delete (both non-destructive).** Each org is a tab (per-project context,
an ❓ needs-you badge, an off-screen `‹N/N›` hint when a needy tab scrolls out of the strip).
**Closing a tab = suspend**: the member containers stop, but the team, transcripts, and history stay,
and **▶ Resume** relaunches them. **🗑 Delete project** is different but *still non-destructive on
disk*: it forgets the org from Mister Claude (stops its sessions, drops the tab) yet **deletes nothing
on disk** — your repo, `team.json`, and transcripts remain, so `mrc team up` re-adds it any time.

---

## 7. Telegram — link your phone to the @user inbox

Optional: answer your team from your phone. Each **project** uses its **own** bot (so one project's
chat never sees another's), and linking is **human-gated** — nothing auto-binds.

**First-time setup (end to end):**

1. **Create a bot.** DM [@BotFather](https://t.me/BotFather) on Telegram → `/newbot` → follow the
   prompts → it hands you a **bot token** (looks like `123456:ABC-…`).
2. **Give the token to the project.** Put it in *that repo's own* `.env` (read **strictly per-repo** —
   no global fallback, so it can never bleed to another project):
   ```
   MRC_TELEGRAM_BOT_TOKEN=123456:ABC-your-token
   ```
3. **Bring the project up on the daemon** — `mrc team up` (or Define/Launch it in the dashboard).
   Once the org is defined and the daemon is running, it starts the Telegram bridge for any defined
   project that has a token (and re-starts it on daemon boot for saved projects).
4. **DM your bot `/start`** from the phone/account you want to link.
5. **Confirm in the dashboard.** The chat appears as a **pending** link on that project's tab → click
   **Confirm**. This is the trust gate: only you, on localhost, can approve it — an *unexpected*
   pending entry is just someone else who messaged the bot, so **Reject** it. Now you're **linked**.

   *Shortcut:* if you already know your chat id, add `MRC_TELEGRAM_CHAT_ID=…` to the same `.env` to
   pre-pin it and skip the Confirm step.

**Once linked:**
- `@user` **questions** push as `❓ … #N … ↩️ Reply to this message to answer`; **FYIs** push as
  `🔔 … #N … 💬 FYI — reply optional` — the same `#N` the dashboard/CLI show.
- **Reply** to a pushed message on Telegram → it routes a `[Human reply]` back to the member. (An FYI is
  replyable too — "optional" is the framing, not a restriction.)
- **Resolve syncs both ways (H4):** answer/dismiss in the dashboard → the Telegram message edits in place
  to show it's resolved; reply on Telegram → the dashboard's open reply box closes with
  "✓ Answered via Telegram".
- **Unpair** on the tab unlinks it any time.

One bot serves **one** project: give two projects the *same* token and the second bridge is **refused
with a surfaced warning** (not a silent Telegram 409 conflict-loop). Inbound Telegram text is
**untrusted** and runs through the trust-marker defang (see §8).

---

## 8. Trust & security

Layered, and it **fails loud**:

- **Container + firewall** — the primary boundary (whitelisted egress only), unchanged from base `mrc`.
- **Untrusted peer data** — every teammate message, *even the architect's*, is untrusted; only
  `[Human directive]` / `[Human reply]` (from @user, a steer, or a confirmed Telegram reply) is
  authoritative. Forged look-alike markers in untrusted peer/worker/Telegram text are **defanged**
  (`src/teams/trust.js`) at the delivery, worker-prompt, and reply-quote sites — a member can't fake the
  human's authority.
- **Spoof-proof references** — the dashboard renders the transcript from a structured per-message store
  (`transcript.jsonl`) carrying a daemon-assigned `qid`/`reqid`; the `[#N]` chip and `(re #N)` jump
  anchor from that trusted field, never by scanning line text — so a member can't hijack a question's
  anchor or forge a jump by putting `[#N]` (or a newline-injected fake line) in its own message.
- **Dashboard CSRF** — state-changing `/api/*` require a per-daemon token (persisted `0600`, so it
  survives a restart without weakening — a cross-origin page still can't read it) plus Origin + Host
  checks; the SPA **confirms a 2xx before closing** a panel and surfaces a 403/error instead of
  optimistic-closing.
- **Telegram inbound** is allowlisted to the confirmed `from.id`+`chat.id`, private chats only.
- **Restart honesty** — `mrc rooms restart` **verifies the new daemon's version stamp** (and
  SIGKILL-escalates a wedged old process) so it never silently keeps serving stale code. Host-side
  `src/` changes ride the daemon reload; container-side changes still need `docker rmi mister-claude`.

---

## 9. Components

**New (`src/teams/`):**
- `names.js` — French/Spaceballs name pool, unique `first/backend` handles, @mention parsing.
- `personas.js` — role registry + `buildPersona()` (the team protocol as a system prompt).
- `roster.js` — parse/normalize `team.json` → members (unique handles, territory/mount/tier, one
  lead/team) + derived rooms; deterministic naming; overlap/escape validation.
- `room-engine.js` — the generalized relay: member-set rooms, directed @routing, multi-room
  membership, room-tagged delivery, the @user inbox (questions/notifications, dismiss/reopen, `#N` +
  structured transcript, `answeredVia`), brake/resume/turn-cap/steer for N, worker queue, redefine-with-prune.
- `worker-runner.js` — drains the worker queue, invokes task-workers, posts replies back.
- `session-id.js` — `memberSessionId` (sha1 `org\0handle`) for cross-org binding.
- `trust.js` — `defangTrustMarkers` + `snippetForTrustedLine` (the trust-boundary hygiene of §8).
- `telegram.js` — Telegram Bot API client + `createTelegramBridge` (long-poll, dedup, 409 backoff).
- `telegram-auth.js` — per-org pairing/auth state (Confirm pairing, allowlist, pre-pin, unpair, `tgView`).

**Modified:**
- `src/proxies/room-daemon.js` — engine + worker runner + **per-org Telegram bridges** alongside legacy
  pairings; `register` binds a member; control `defineOrg`/`team`/`answer`/`dismiss`/`reopen`/`removeorg`/
  `tg*` + brake/resume/steer/end; the dual `thread.log`/`transcript.jsonl` append; org + inbox + Telegram
  persistence; tmux-reconciled launch records.
- `src/commands/team.js` — the `mrc team` CLI (`up`/`status`/`console`/`down`/`define`/`exec`),
  member launch wiring, persona files, territorial volumes, worker exec.
- `src/commands/pair.js` — version-stamp-verified daemon restart (`probeVersion`/`waitUpVersion`) +
  SIGKILL escalation in `stopDaemon`.
- `container/mrc-channel-server.js` — team mode: registers as a member; `send_message`/`list_team`/
  `ask_user` tools + team instructions.
- `src/rooms-dashboard.js` + `src/dashboard.html` — the unified teams-first web app + its endpoints
  (`/api/teams`/`state`/`room`/`tg`/`team-*`/`action`), the CSRF token gate, project tabs, the inbox
  model, Telegram pairing UI, and the semantic-token design system.
- `mrc.js` / `src/config.js` — `team` subcommand, `--member`/`--roster`, member-mode launch; `config.js`
  adds `repoEnvKeyStrict` (per-repo `.env` only, no `process.env` fallback — the Telegram token reader).
- `entrypoint.sh` — `--append-system-prompt` for members; one-shot worker exec branch.
- `src/docker.js` — `runWorkerExec`. `src/rooms.js` — `saveOrgs`/`loadOrgs`, `saveInbox`/`loadInbox`,
  `saveTgStates`/`loadTgStates`, `appendTranscript`/`readTranscript`, launch records.

---

## 10. CLI

```
mrc team up      [path] [--roster f]   push the roster to the daemon + launch live members (tmux)
mrc team status  [path]                org, rooms, and the @user inbox
mrc team console <handle> [path]       attach to a running member's terminal
mrc team exec    <handle> "prompt"     run a task-worker turn manually
mrc team down    [path]                close the org's rooms
mrc team define  [path] [--roster f]   push the roster WITHOUT launching
```

---

## 11. What's tested vs. what needs Docker

**Unit/integration tested host-side (150 tests, `node --test test/*.test.mjs`):** naming, roster,
personas, the full room engine (directed routing, multi-room isolation, floor control, the @user inbox
incl. questions/notifications + dismiss/reopen + `#N`/structured-transcript spoof-proofing, brake/resume,
prune), socket-level daemon round-trips (define org → register → directed delivery → @user → brake/resume;
inbox + Telegram persistence; org isolation; tmux-reconciled launch records), the **Telegram** transport
+ auth (pairing, allowlist, push framing, H4, one-bot-per-org), the **trust-marker defang**, the
**dashboard CSRF + token-persist** gate, **restart version-stamp** verification, the launcher's pure
pieces (session ids, territorial mounts, persona files), and the worker-runner core (batch/invoke/
post-back, graceful failure).

**Needs the rebuild recipe to validate (no Docker here):** the live container launch
(`--append-system-prompt` persona, territorial bind mounts, the one-time Channels accept per member)
and the worker container exec (`codex exec` reach to its API, sentinel output capture, per-member
memory volume).

```bash
docker rmi mister-claude                 # container files changed (entrypoint, channel server)
cat > team.json <<'EOF'  …  EOF          # see §1
mrc team up                              # launches live members in tmux; accept the Channels prompt in each
mrc rooms dashboard                      # opens the teams-first dashboard (http://localhost:8787)
#  in a member:  @critic please review client/src/auth.js
#  a member asks you:  @user toasts or inline?   → answer it in the dashboard Inbox
mrc team exec @thierry "summarize the api contract"   # a task-worker turn
```

---

## 12. Open items / future

- Container-path validation (above). Confirm `claude --append-system-prompt` in the pinned build.
- Headless launch: the Channels accept prompt is interactive + non-persisted, so `mrc team up` still
  needs a human accept per live member (it runs them in tmux). A persisted accept / GA channels would
  let the web UI fully spin up a team.
- Worker conversational memory across turns depends on the backend's own resume; today the substrate
  is a persistent per-member config volume.
- Per-team git worktrees for independent branches (current model: one shared checkout, human commits).
- Web team-builder (edit `team.json` from the UI); embedded per-member terminals (ttyd).
- Live non-Claude membership (a per-backend inbound-injection path) remains deferred.
```
