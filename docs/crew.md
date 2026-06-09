# Crew — multi-session orchestration (design)

> **Status: PARKED (2026-06-09).** Explored deeply, deliberately not built — see the Verdict below. WIP code set aside in a `git stash` (`git stash list` → "crew phase 1 … PARKED"). Crew is a generic mrc capability: run a *crew* of sandboxed
> sessions with roles (orchestrator / worker / oracle), coordinated over the rooms substrate. It's
> **rooms' bigger sibling** — roles + spawning + an orchestrator-shaped dashboard on top of the same
> daemon / relay / dashboard. Substrate: [`negotiation-rooms.md`](./negotiation-rooms.md).

## Verdict (2026-06-09): parked — existing tools cover the need

Explored the design + worker model to the bottom, then stress-tested the *premise* and parked it:

- **Same-repo fan-out** (decompose a task, run workers in parallel) is already covered by **ultracode /
  Workflow** inside one session — cheaper, no boot gates, no extra Max seats, with worktree isolation
  for parallel edits. Crew adds nothing here.
- **Cross-repo work** in this org is almost always **1:1 consultation** ("ask the server about X") →
  **rooms already does that** (built). The uniquely-crew case — fanning out *several* sessions *across
  repos*, durably — is rare, effectively a personal client↔server situation, and off the critical path
  (recipes is solo; the Figma rebuild is one repo → an ultracode fan-out).
- Crew's genuine differentiators (different-repo / `:ro`-isolated / human-attachable / durable / future
  cross-machine sessions) are real but niche. Revisit only on a concrete trigger: durable cross-repo
  fan-out, attach-and-takeover, or real multi-machine / multi-person orchestration.

**Adjacent ideas, also resolved as *not* a feature:**
- *Human session handoff* → a **git workflow** (agent writes a handoff doc, commit it with the WIP, the
  next person pulls — or Slack the doc). The only mrc-specific sliver (shipping the raw `.jsonl` for an
  exact-resume) is the path we rejected anyway; the curated brief is better.
- *Pair-programming* → git branches + Slack. If agent-to-agent pairing ever matters, the only
  mrc-shaped piece is making rooms delivery **non-interrupting** (a mailbox drained between turns) — a
  refinement to a built feature, parked.

**The keeper from this whole thread:** the **channel-as-plugin** work — ships the room channel as a
plugin in a baked-in local marketplace, allowlisted via managed-settings, so it loads with no prompt.
Improves rooms today, independent of crew. (Pending an image-rebuild test.)

## What it is (and isn't)

A human (later, an agent) acts as PM over a set of sandboxed sessions:

- **orchestrator** — plans the work, spawns the crew, assigns tasks, integrates results.
- **worker** — read-write on a repo; does a delegated task; reports back; can consult an oracle.
- **oracle** — read-only (`:ro` mount); answers questions; can't change anything.

**The boundary that keeps it squarely mrc** (the line we have to hold):

- **mrc owns the mechanism + runtime state** — roles, spawning, the relay, the dashboard, the verb
  set, and which sessions / assignments / messages are live right now. Generic; knows nothing about
  your work. Same category as rooms' session/thread state in `~/.local/share/mrc`.
- **Your repo owns the durable work** — `monitoring.md`, the backlog, the task list. That gets fed
  *into* an orchestration; mrc never stores it.
- Test for "is this mrc?": **it's the orchestration plumbing, not the to-do list.**

## Keystone: verbs once, two drivers

Every orchestrator capability is a **verb** — a clean, driver-agnostic operation:
`spawn`, `assign`, `check-in`, `report`, `review`, `approve`, `end`, …

- **Human-PM first:** the verbs are **dashboard buttons** you click.
- **Agent-PM later:** the *same verbs* are exposed to an orchestrator agent as **MCP tools**.
- **Handover is a dial, not a switch:** give the agent the routine verbs (spawn, assign, check-in)
  while the consequential ones stay human-only (approve a plan, ship, end). The verb set is the
  security boundary; *which* verbs the agent gets is the trust gate.

Rooms already proves this: its controls are wired to both the human (dashboard + `mrc rooms`) and the
agent (channel tools like `pause_room`), and `steer` (the trusted directive) stays human-only.

## Reused vs new

**Reused from rooms (the substrate):** the host daemon, the message relay + `thread.log`, the
dashboard chassis, trusted `[Human directive]` injection (the basis for check-ins).

**New (the crew delta):**

- **roles / permissions** on the daemon (orchestrator / worker / oracle; `:ro` for oracles)
- **spawning** — the orchestrator launches sandboxes (via mrc) with a role, vs rooms' pre-existing
  hand-picked peers
- **addressed relay** — one orchestrator ↔ N workers ↔ oracles (generalize rooms' single pairing)
- **an orchestrator-shaped dashboard** — topology + progress + the verb buttons + a check-in heartbeat

## Worker execution model (interactive-first)

Workers run as **interactive, Max-backed, channel-driven** sessions — *not* headless. Two reasons converge:

- **Cost:** around end of June 2026, headless / non-interactive Claude usage is billed as metered **API**
  usage instead of under the flat **Max** plan; interactive sessions stay on Max. Headless workers would
  get expensive fast.
- **Capability:** the rooms autonomous volley (a peer message drives a turn with *no* human keystroke)
  only works for *interactive* sessions. Headless mode is input-driven — it acts when its stdin receives
  a message — per Claude Code's stream-json model.

So a worker is a detached-but-interactive session (`docker run -dit`) the channel drives like a rooms
peer, and that you can `docker attach` to watch or steer. **Headless stays a pluggable, opt-in,
API-billed seam** (`--crew-headless`, off by default): not depended on, not removed. Caveat: even
interactive workers spend Max tokens, so a crew multiplies Max rate-limit consumption (the 5h/7d gauges)
— a real ceiling on crew size.

**Boot gates (empirically probed 2026-06-09).** *Auth — solved.* `~/.claude/.credentials.json` is a
portable, non-device-bound refresh token; 10 concurrent and 8 long-held sessions on one credential all
ran clean, so the "~4/repo re-auth" wall is the *interactive login* ceremony, not a concurrent cap.
**Cloning the orchestrator's authed config volume carries the login AND sidesteps the wall** (workers
reuse the token, never re-login) — the real ceiling becomes Max rate limits, not auth. *Dev-channel
approval — still open.* The managed-settings allowlist accepts only marketplace plugins, not a local
`server:` channel, so silent load needs the channel **packaged as a plugin** (which would also remove the
manual picker for existing rooms), unless a cloned volume turns out to carry a per-repo "accepted" state.

**Spawn handshake.** On worker-register the daemon opens the orchestrator↔worker room immediately; the
worker's reply confirms it's fully up and responsive — and doubles as opening the room. (N-worker
addressing is Phase 2; today the pairing is 1:1.)

## Rough phases

> Deliberately rough — refine as we build. Human-PM throughout 1–3; the agent driver is phase 4.

### Phase 1 — Roles + spawning (skeleton)
`mrc crew` in a repo marks that session the **orchestrator**; the daemon records roles. The
orchestrator can **spawn a worker** sandbox with a role (oracle = `:ro`). Minimal target: spawn one
worker, it registers with the daemon, the daemon knows who's who. No rich coordination yet.

### Phase 2 — Relay + reporting (they talk)
Generalize the relay to **addressed routing** so orchestrator↔worker(↔oracle) can message and workers
**report back**. This is the multi-room / addressing generalization the substrate has wanted anyway.

### Phase 3 — Dashboard + verbs-as-buttons (you drive)
The crew dashboard — a **superset of the rooms dashboard**: see the topology, all comms, and progress;
**buttons** for the verbs (spawn / assign / check-in / end); the periodic **check-in heartbeat**
(a trusted directive on a timer). This is the human-PM cockpit — the first genuinely useful milestone.

### Phase 4 — Verbs-as-tools (agent drives, selectively)
Expose the **safe subset** of verbs to an orchestrator agent as MCP tools; keep the consequential ones
human-only. The buttons-become-tools step — gated, opt-in, only once the human-driven version is
trusted.

## Parked (don't solve yet)

- Spawn ergonomics: how the orchestrator session launches a sandbox and wires it to the daemon.
- Check-ins: daemon-automated, human-triggered, or both.
- Worker lifecycle on completion: idle / exit / await next.
- Transport flavor for crew comms: network channel vs bind-mount.
- Entry UX details: `mrc crew` survives only as optional sugar — ambient-orchestrator is decided (every
  session is latently an orchestrator; the role is stamped on first delegation, not declared at launch).
- Best-practices writeup — what crew is good at vs. what it shouldn't be used for (capture the conclusions
  of that dive here once the worker model settles).

## Progress log

- **2026-06-09 (channel plugin)** — Built the dev-channel-prompt fix so unattended workers (and
  existing rooms) load the channel silently. The channel now ships as the `room` plugin in a baked-in
  **local marketplace** (`mrc-marketplace/`), allowlisted via `/etc/claude-code/managed-settings.json`,
  loaded with `--channels plugin:room@mrc` instead of `--dangerously-load-development-channels` (which
  prompted). Validated on-box: the real plugin adds + installs non-interactively (exit 0, `channels`
  field accepted, cached; `claude plugin list` shows it). Wiring: Dockerfile bakes the marketplace +
  allowlist; `container-setup.js` registers it into the per-repo volume at runtime (idempotent);
  `entrypoint.sh` switched to `--channels`. Establishes the reusable "mrc ships a local
  marketplace + plugin + managed-settings allowlist" pattern. Pending the image rebuild to confirm
  silent load + that the plugin's MCP server still inherits the container env.

- **2026-06-09 (worker model)** — Worker execution model converged toward **interactive/Max-backed**
  (see section above): the end-of-June-2026 headless→API billing change + the fact that the autonomous
  volley only works interactively both point the same way; headless kept as an opt-in `--crew-headless`
  seam. Surfaced the **boot gates** (OAuth seat, dev-channel approval) an unattended worker can't answer
  — lever is inheriting/cloning the orchestrator's authed config volume (open: does cloning carry
  login + approval?). **Adopted the spawn handshake** (open room on register; worker's reply = "up &
  responsive"). Host-side spawn brain built (`onSpawn`, role-stamp, parent→child topology,
  pairing-on-register); worker-*launch* code deliberately held pending the gate investigation.

- **2026-06-09 (cont.)** — Phase 1 split into **1a** (role plumbing) + **1b** (daemon-spawn). **1a
  built + smoke-tested 8/8:** a `role` (orchestrator/worker/oracle) threads launch → channel
  `register` frame → daemon session state → `mrc rooms status` + `peerlist`; new `--role` flag and
  `MRC_CREW_ROLE` env; purely additive — existing rooms behavior untouched. **Hinge resolved — the
  daemon spawns:** an in-container agent has no Docker access, so the privileged launch must live
  host-side, and one daemon spawn path unifies the CLI / dashboard / agent drivers. **1b next:** `mrc
  crew` front door, a `spawn` control action, and decoupling channel-registration from the
  interactive-TTY gate so headless workers can register.
- **2026-06-09** — Reset. Discarded the earlier "CS work-board app" framing (that was a *user
  workflow*, not mrc) and its board code. Reframed crew as a generic orchestration **mechanism** —
  rooms' bigger sibling — which is squarely mrc. Rough phases 1–4 drafted.
