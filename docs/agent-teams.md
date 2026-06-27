# Agent Teams

**Status:** Host-side core built and unit-tested end-to-end (44 tests); the container-launch and
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
        { "role": "writer",    "backend": "claude", "territory": "client/src" },
        { "role": "critic",    "backend": "claude" } ] },
    { "name": "api", "territory": "api", "members": [
        { "role": "architect", "backend": "claude", "lead": true },
        { "role": "writer",    "backend": "codex" } ] }
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
          Writer-Client   Critic-Client          Writer-API
          rw client/src   ro                     rw api  (codex worker)
```

- **Team room** (one per team): all of that team's members.
- **Leads room** (one): every team's lead + **@user**.
- A **lead** is the only member in two rooms (its team room + the leads room).

Three invariants the daemon enforces keep it untangled:

1. **Containment** — a member only sends into rooms it belongs to. Team rooms are disjoint except for
   leads; cross-team traffic flows **only** through the leads room, lead-to-lead. A writer physically
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
prompt encodes the protocol: the **architect** plans and directs the writer and invokes the critic;
the **writer** implements in its lane and asks when blocked; the **critic/adversary/ultracritical/
user-defender** review when invoked. Roles: `architect, writer, critic, adversary, ultracritical,
user-defender, researcher` (`src/teams/personas.js`).

**Trust:** the architect is *not* the human. A teammate's message — even the architect's — is
**untrusted peer data**; only `[Human directive]`/`[Human reply]` (from @user/steer) is
authoritative. A member follows its architect because that is its role, not because the word is law.
This preserves the sandbox trust invariant from negotiation rooms.

---

## 4. Code on disk — territorial write isolation

Contention is avoided by **partitioning the filesystem**, not serializing writers:

- A **whole-repo writer** (`territory:"."`, `mount:"rw"`) gets `/workspace` read-write.
- Everyone else gets `/workspace` **read-only**, with `.mrc` kept writable (transcripts + persona).
- A **sub-tree writer** also gets just its territory mounted read-write on top.

So `@ludivine` (writes `client/src`) and `@thierry` (writes `api`) never touch the same files, and a
**critic is read-only by capability, not etiquette**. The roster warns on overlapping write
territories. **The human commits** — writers edit the working tree but never `git commit`, so there
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
- **Inbox** (first-class): the **@user** queue — a member's `@user` question lands here; you answer
  and it routes back as `[Human reply]` — plus catch-ups awaiting review.
- **Build**: the in-app team-builder (compose → live preview → Save team.json / Define rooms).

Per-room detail has Transcript / Summary / Catch-up tabs and **steer any member or everyone** +
pause/resume/close. You can also drop into any live member's terminal with `mrc team console
<handle>` (members run in a tmux session).

---

## 7. Components

**New (`src/teams/`):**
- `names.js` — French/Spaceballs name pool, unique `first/backend` handles, @mention parsing.
- `personas.js` — role registry + `buildPersona()` (the team protocol as a system prompt).
- `roster.js` — parse/normalize `team.json` → members (unique handles, territory/mount/tier, one
  lead/team) + derived rooms; deterministic naming; overlap/escape validation.
- `room-engine.js` — the generalized relay: member-set rooms, directed @routing, multi-room
  membership, room-tagged delivery, @user inbox, brake/resume/turn-cap/steer for N, worker queue,
  org redefine-with-prune.
- `worker-runner.js` — drains the worker queue, invokes task-workers, posts replies back.

**Modified:**
- `src/proxies/room-daemon.js` — engine + worker runner alongside legacy pairings; `register`
  binds a member; relay frames `say`/`whoami`; control `defineOrg`/`team`/`answer` + brake/resume/
  steer/end generalized to engine rooms; org persistence.
- `src/commands/team.js` — the `mrc team` CLI (`up`/`status`/`console`/`down`/`define`/`exec`),
  member launch wiring, persona files, territorial volumes, worker exec.
- `container/mrc-channel-server.js` — team mode: registers as a member; `send_message`/`list_team`/
  `ask_user` tools + team instructions.
- `src/rooms-dashboard.js` + `src/dashboard.html` — the unified teams-first web app + its endpoints
  (`/api/teams`, `/api/team-preview|save|define`, the `answer` action).
- `mrc.js` / `src/config.js` — `team` subcommand, `--member`/`--roster`, member-mode launch.
- `entrypoint.sh` — `--append-system-prompt` for members; one-shot worker exec branch.
- `src/docker.js` — `runWorkerExec`. `src/rooms.js` — `saveOrgs`/`loadOrgs`.

---

## 8. CLI

```
mrc team up      [path] [--roster f]   push the roster to the daemon + launch live members (tmux)
mrc team status  [path]                org, rooms, and the @user inbox
mrc team console <handle> [path]       attach to a running member's terminal
mrc team exec    <handle> "prompt"     run a task-worker turn manually
mrc team down    [path]                close the org's rooms
mrc team define  [path] [--roster f]   push the roster WITHOUT launching
```

---

## 9. What's tested vs. what needs Docker

**Unit/integration tested host-side (44 tests, `node --test test/`):** naming, roster, personas,
the full room engine (directed routing, multi-room isolation, floor control, @user inbox,
brake/resume, prune), a socket-level daemon round-trip (define org → register → directed delivery →
@user → brake/resume), the launcher's pure pieces (session ids, territorial mounts, persona files),
and the worker-runner core (batch/invoke/post-back, graceful failure).

**Needs the rebuild recipe to validate (no Docker here):** the live container launch
(`--append-system-prompt` persona, territorial bind mounts, the one-time Channels accept per member)
and the worker container exec (`codex exec` reach to its API, sentinel output capture, per-member
memory volume).

```bash
docker rmi mister-claude                 # container files changed (entrypoint, channel server)
cat > team.json <<'EOF'  …  EOF          # see §1
mrc team up                              # launches live members in tmux; accept the Channels prompt in each
mrc rooms dashboard                      # then open the "🎩 Team orchestrator →" link (/teams)
#  in a member:  @critic please review client/src/auth.js
#  a member asks you:  @user toasts or inline?   → answer it in the /teams inbox
mrc team exec @thierry "summarize the api contract"   # a task-worker turn
```

---

## 10. Open items / future

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
