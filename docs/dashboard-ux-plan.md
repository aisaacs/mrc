# Dashboard UX redesign — build plan (task #6)

**Status:** Sequencing plan for `docs/dashboard-ux.md`, owner-driven (2026-07-10). Under Pierre review
for containment/sanity before the gated phases are built. Grounded in a fresh read of `src/dashboard.html`
(SPA), `src/rooms-dashboard.js` (HTTP), `src/proxies/room-daemon.js` (control + launch), `src/commands/team.js`
(launch + config-vol), `src/teams/{names,personas,roster}.js`.

**▶ 2026-07-11 PIVOT — MODEL B (Phase 0 below, co-planned with Pierre).** Building P1's create form surfaced a
foundation decision the owner made decisively: **project identity must live OFF the repo.** Repos are a
per-AGENT property (any combination of teams/agents is valid; a repo is not a team trait); a project is a
collection of agents on a common goal, each on its own repo. Anchoring a project's identity to one agent's
repo ("Model A") technically works but drags project-level state back into a repo — the exact thing the #5
store-relocation was getting OUT. So **Phase 0 (the Model B anchor) is now the foundation P1 and P4 sit on**,
and it folds into #5's rebuild as one refactor. Greenfield / clean-cut — no migration.

## Context

`docs/dashboard-ux.md` is the agreed design; the owner's first live create→launch (field report §11)
exposed concrete friction. The bar (§0): *starting a session should feel as light as `mrc pick`.* This
plan sequences the design into shippable slices, ordered by daily-use value and dependency. The security
floor (guard-1 write-once pin/activate + guard-4 ttyd unix socket) is DONE + hardware-verified, so the
create-flow can lean on the trusted-pin/activate model already wired.

**Root cause of the "Launch → ⏸ stopped → press Resume" bug (deferred, but it dissolves in Phase 1):**
`/api/team-launch` → daemon `launchteam` spawns a *detached* `mrc team up` subprocess that writes the
launch record asynchronously (after image build). `running` is derived (`fresh <5min` OR a non-dead
member; `room-daemon.js:1226`), and the SPA's `bLaunch` drops the builder ~700ms after POST
(`dashboard.html:1712`). In that gap there's no record yet → `orgRunning()` false → "⏸ stopped." Resume
hits the *same* endpoint, just later. Fix = a provisional launch record written synchronously in
`launchteam` + a SPA "launching…" state.

---

## Phase 0 — Model B anchor (the foundation; folds into #5's rebuild)

Goal: a project's identity lives in a neutral, mrc-owned store — tied to NO agent's repo. Every agent repo
(the lead's included) is a human-authorized, mounted workspace through ONE uniform gate. No privileged repo.

**The crux — `def.repo` is overloaded 5 ways** (`room-daemon.js defineOrg`): (1) the guard-1 pinned identity
root, (2) the member default mount root, (3) the `.env`-read root (Telegram token + member secrets), (4) the
launch.log target, (5) the activation record subject. Model B splits this by ROLE (never reinterpret one
field — that overload is what caused this):
- **`def.anchor`** (NEW; Model-B identity — derived `hex(project-name)`, mrc-owned, NO pin, immutable *by
  derivation*): consumers (1) identity, (4) launch.log target, (3-Telegram) TG-token source (moves from
  `def.repo/.env` → `anchor/.env`, still per-project-isolated by the hex-key — flag for P5).
- **`member.repo`** (per-agent; ALREADY EXISTS): consumers (2) mount (`team.js:62`), (3-secrets) member `.env`
  (`memberRepoEnvKey`). Model B makes it always-explicit (no `|| repoPath` fallback to a root that no longer
  exists) and set-gated.
- **`def.repo`** = LEGACY ONLY (absent in Model-B).

**Guard-1 RETIRES — both the pin AND activation, subsumed by the authorized-set.** The pin protected "a wire
frame can't re-point the mount/`.env` root"; activation deferred the root `.env`-read until a human act. In
Model B, IDENTITY is a derived path (needs no pin — you can't re-point a hash of a validated name) and every
repo is `.env`-read/mounted ONLY after it's in the authorized-set (a human CSRF+capOk act) — so the set IS the
re-root protection AND the deferral. Two guard-1 mechanisms → one uniform gate. The floor gets *simpler*, and
the surface concentrates onto one well-guarded thing: **the authorized-set becomes the SOLE repo gate.**

**Activation gate (stage-inert, #5-style).** Model B rides #5's rails: host-side changes are inert behind the
image capability signal (the daemon inspects the mister-claude image — `resolveStoreMode` — the ground-truth
shared signal), byte-identical legacy until the rebuild; container-side (store mount + `.mrc` retarget) is
#5's container change. Close the daemon/container split-brain window BOTH ways: (a) inspect FRESH per-decision
(per `defineOrg`/launch, not cached-at-boot, so the daemon reflects the CURRENT image); (b) the daemon PASSES
its Model-B decision to the container, which ASSERTS it against its own runtime capability → mismatch REFUSES
the launch loud (guard-4 `assertTtydUnixSocket` shape) — never mount-legacy-while-daemon-thinks-neutral.
**Seam that keeps legacy byte-identical:** `def.anchor` is OPTIONAL; each consumer branches
`modelB ? (anchor | member.repo) : def.repo`, and legacy (capability-inactive) falls through to `def.repo` +
pin + activation, untouched.

**Increments (each stage-inert + independently cold-readable, #5-discipline):**
- **Inc 1 — `/api/authorize-repo` + daemon `authorizerepo` → `addAuthorizedRepo` (capOk+CSRF at the door). ✅
  DONE.** Additive, un-gated, safe now — the GUI form of the CLI cross-repo (Mouth B) authorize, useful today;
  the launch path only READS the set. `resolveMemberRepo` UNCHANGED. Covered by `guard1-daemon.test.mjs`
  ("Inc 1 authorizerepo: capOk at the door"). Invariant grep clean: `addAuthorizedRepo` callers = only the CLI
  (`team.js:834`) + the capOk `authorizerepo` action (`room-daemon.js`); `authorizerepo` reachable only via the
  CSRF `/api/authorize-repo` or the capOk daemon action.
- **Inc 2 — config-vol keying → uniform `org#handle`** (`memberConfigVolName`, drop the crossRepo branch),
  gated on Model-B-active. Inert until the capability flips.
- **Inc 3 — the core:** `def.anchor` split threaded through the 5 consumers under the gate + RETIRE pin AND
  activation + DELETE the own-repo-grant (`resolveMemberRepo`). Gated. The whole security delta lands here.

**Pierre cold-read contract (Inc 3):** (1) the FULL `resolveMemberRepo` body — every `return` reaches a
`loadAuthorizedRepos(org).has(...)` set-check or a throw, no residual `== null/''`/early-return/helper/
caller-pre-resolve bypass (read, not grepped); (2) `def.anchor` threading — each of the 5 consumers reads the
right field under the gate; (3) the `authorizerepo` handler is capOk+CSRF at its door; (4) pin + activation
FULLY retired on the Model-B path — no orphaned `isActivatedRoot`/`recordActivatedRoot` consumer. Build-confirm:
a leftover pre-Model-B real `.mrc` dir in a throwaway repo is clean-removed/ignored (data-loss FINE), never an
`EEXIST` that fails the re-create launch.

**Deferred (tracked):** solo `.mrc-id` → neutral anchor (agreed faithful end-state, non-urgent; solo stays
repoId-keyed this pass — two identity models coexist deliberately; track the convergence so it doesn't become
permanent). #5's memory-migration + the plain-host-terminal guardrail are UNTOUCHED.

Files: `src/proxies/room-daemon.js`, `src/rooms-dashboard.js`, `src/teams/repo-auth.js`, `src/teams/roster.js`,
`src/commands/team.js` (config-vol key), `src/mrc-store.js` (anchor derivation), `container/container-setup.js`
(mount/retarget, rebuild-gated). **Pierre-gate: HARD on Inc 3** (the sole-gate refactor); Inc 1/2 light.

## Phase 1 — Create → launch that just works (biggest win, lowest risk)

Goal: create a project and it comes up live, in one gesture, with a form that isn't scary. **Now sits on the
Phase 0 Model B foundation** — per-agent DIFFERING repos are first-class (each authorized through the set via
`/api/authorize-repo`), the org anchor is neutral, no repo is privileged.

- **1a. Launch lands live (kills the Resume two-step) — as a self-correcting `launching` state, never
  "running" on faith (Pierre).** A bare "running" written before the detached `mrc team up` confirms its
  build is a LIE — a failed build (bad roster / build error / ENAMETOOLONG) would leave a permanent
  phantom-running org with no members, worse than the flicker. So the provisional record carries a THIRD
  state `state:'launching'` (a timestamp; **never counted as `running`**), and it self-corrects: the
  detached subprocess upgrades it to `running` when member records appear (fast path = capture the child
  **exit code**), OR a **2–3 min timeout** flips a stuck `launching`→`failed` with the build error (the
  honest backstop — don't trust the subprocess to report its own failure). In the SPA, `bLaunch`
  (`dashboard.html:1710`) shows the persistent "launching @X…" state and polls until it reconciles to
  running/failed, instead of the 700ms drop to a generic render; `memberState`/`renderTerminal`
  (`dashboard.html:565,762`) render `launching` as "starting," never "isn't launched." (Post-capOk —
  `launchteam` is guard-1-gated — so this is pure state-machine honesty, no new containment surface.)
- **1b. Repo input → validated directory chooser (UX ONLY — not a server guard, Pierre).** In the builder
  (`dashboard.html:1247` `#bRepo`), expand `~`/`$HOME`, resolve realpath, validate existence with inline
  feedback via a tiny read-only `/api/validate-repo` (reuse the `existsSync`+`realpathSync` in
  `/api/team-save`, `rooms-dashboard.js:262`). Fixes the opaque `~` error. **This is pure ergonomics — it
  does NOT close any CSRF path**: a wire `repo=/etc` POSTed straight to `/api/team-launch` never touches
  the widget. What actually stops it is **guard-1** (capOk-derived trusted first-pin) + the CSRF front door
  (token/Origin/Host), both already verified. Do NOT credit the chooser with a security property, or a
  later "simplify" will trust it and delete the real guard.
- **1c. Declutter the form** to name · members+repos · fresh/resume. Remove **"💾 Save team.json"**
  (`dashboard.html:1252`, `bSave` 1370) and the **"mrc team up" footer** (1253); move **Define-rooms**
  (`bDefine`), **custom-roles** (1271-1322), **name-style** (1249), and **per-member/team territory + ✕**
  (1327,1337) behind an **"Advanced"** disclosure.
- **1d. Lead becomes implicit.** First/only member is lead by default (compute it; `roster.js` already
  enforces one lead/team); drop the lead checkbox (`dashboard.html:1336`) to Advanced.
- **1e. Stop clobbering the repo's `team.json`.** Removing Save (1c) already stops the create-flow
  overwriting `repo/team.json`; the GUI launch persists the roster via the daemon (`defineOrg`→`orgDefs`/
  `saveOrgs`) + the launcher's own `--roster` temp, not the repo root. (Full store lifecycle is Phase 3.)

- **1f. Config-volume name behind a SEAM (Pierre hygiene).** P4 swaps volume keying from per-project
  (`repoPath#handle`) to per-character. Resolve the config-volume name through the ONE existing helper
  (`memberConfigVolName`, `team.js:97`) everywhere in the launch path now, so P4 is a resolver swap, not a
  launch-path rewrite. Cheap now, saves a retrofit.

Files: `src/dashboard.html`, `src/rooms-dashboard.js`, `src/proxies/room-daemon.js`. Host-side;
`mrc rooms restart` to deploy. **Pierre-gate: light** (1a/1b touch the launch path he signed — send the diff).

## Phase 2 — Command-center home + one clean Exit (§2, §5.1)

- **Project tiles** grid (live + suspended): name · teams·members · idle-vs-working · a needs-you ❓ badge
  (aggregate the `@user` inbox) · a timestamp. Doubles as `pick-project`.
- **One clean Exit (= suspend)** + relabeled **Delete** (keeps files); retire the x-pill / "Resume team" —
  resuming is just picking the project from the home. Warn-if-mid-thought on Exit.
- **Route new verbs to gated paths (Pierre):** Resume MAPS to the capOk-gated `launchteam`/activate path
  (it re-activates a pinned org → reads `.env`, spawns), NOT a fresh ungated `/api/resume`; Delete MAPS to
  the already-gated `removeorg` (clears pin/activation). Don't rebuild either as a new ungated door.
- **Vocabulary sweep org→project** in user-facing strings (internal field is already `project`).

Files: `src/dashboard.html`, `src/rooms-dashboard.js`. Host-side. **Pierre-gate: a read-path verify (not
"none", Pierre).** The home is the cross-org READ aggregation (tiles + needs-you badges from every org's
`@user` inbox). Low-risk — it's the human's own authorized global view and members can't reach the
dashboard HTTP — but verify: no one org's inbox TEXT surfaces in another's scope, and every
member-influenced field (org name, inbox body) is rendered **escaped** into the shared home.

## Phase 3 — Grow-a-project actions + team.json store lifecycle (§5, §4)

- **Sidebar +Add** (Pierre / cross-repo teammate / specialist), **−Dismiss** (closes the member's room),
  **connect-two-sessions** from the GUI, **end-room** buttons — CLI/GUI parity. Most plumbing exists
  (Mouth B add-member, caged-Pierre core).
- **team.json fully store-scoped** (generate/update in the project's `/mrc` slice, implicit team up),
  completing §4. **This is security-NEUTRAL, NOT the persona-injection fix (Pierre):** the `/mrc` store is
  rw-mounted, so re-reading it for personas is as forgeable as re-reading the repo root. **Build guard-2
  IN this phase, paired with the store-move:** persona comes from the host-authoritative def, never a
  re-read of ANY mounted file. Do not record "team.json→store" as the persona-injection close.
- **Keep the §10.2 split intact:** connect-two-sessions stays session-callable + GUI (parity); the +Add
  **repo-authorization** (mounting a repo for a member) stays **human-only, never session-callable**.
- **GUI `steer` MUST be capOk-gated (Pierre — the sharp one).** When P3 surfaces room controls
  (brake/resume/steer/end) to the GUI, `steer` injects the `[Human directive]` trust marker — the ONE
  marker agents obey — so an ungated GUI steer = cross-uid authoritative-instruction injection into every
  agent in the room (worse than a re-root: it drives them directly). brake/resume/end are lower-stakes
  (pause/close, no trust inject) but steer requires the secret. **Banked principle:** every phase that adds
  a GUI action adds a capability DOOR — re-check the guard-1 rule ("activate/spawn/destructive/trust-inject
  requires the secret") against each new door, never assume it from the lifecycle pass.

Files: `src/dashboard.html`, `src/rooms-dashboard.js`, `src/commands/team.js`, guard-2 (unbuilt).
**Pierre-gate: medium** (guard-2 is the real fix here; the human-only repo-auth boundary).

## Phase 4 — Recurring characters, the "Pierre model" (§5.2) — the big lift, Pierre-gated

Goal: a reusable cast with stable identity + persona + a **repo-independent per-character config volume**
so a character's Claude auth persists across projects (fewer re-auths), and teammates are recognizable.

- **P0 GATE — the `~/.claude`-leak audit, done BEFORE P1–P3 accrue assumptions (Pierre).** P4 is buildable
  ONLY IF the config volume is truly character-global: project DATA (memory/history/secrets) lives in the
  repo/`.mrc` store (symlinked OUT of `~/.claude/projects/-workspace/` per CLAUDE.md), NOT in the config
  volume — so sharing the config volume by identity does not, on its face, cross project-DATA isolation.
  **The audit proves that premise:** enumerate everything a Claude session writes to `~/.claude` *outside*
  `projects/-workspace/` (`history*`, `todos`, `settings.json`, caches) and confirm none captures project-A
  content a character-in-B could read. Cheap: `find ~/.claude -newer <marker>` during a live session,
  cross-referenced against the symlink. Each leak found = a cross-project data channel to close (route
  through the symlink or exclude from the shared vol). **Name INSTALLED MCP servers / plugins explicitly
  (Pierre):** a shared per-character volume carrying MCP config means a character that gains an MCP in
  project A carries it to B — an active code-exec/egress channel, STRONGER than a passive settings file.
  Probably acceptable (the character's own tooling follows it) but it's the one `~/.claude` resident that's
  active, not data — call it out and decide deliberately. **If the symlink isn't airtight, P4 in
  its shared-volume form cannot exist — so run this before committing P1–P3 to it.**
- **Two hard constraints regardless of the audit (Pierre):** (1) **Caged characters are EXCLUDED from the
  shared volume** — a caged adversary keeps its isolated `-pierre-N` slot pool; only UNCAGED recurring
  teammates get a shared-identity volume (never breach the cage login-isolation floor). (2) The **sharing
  boundary = only the projects the human ADDED the character to** — cross-project sharing stays human-gated,
  consistent with repo-auth; a character never silently spans projects.
- **Pierre design volley** on the containment trade (§10 #4) after the audit, *before any code*.
- **Character identity object** = name + role/personaDef + a character-keyed volume. Generalize Pierre's
  pattern: literal stable name (`room-daemon.js:723`) + durable record (`session-record.js`) + the
  login-persistent `-pierre-N` slot pool (`mrc.js:642`). New keying axis in `memberConfigVolName`
  (`team.js:97`): keyed on character identity, NOT `repoPath#handle`.
- **Retire random-name-per-run as default** (`names.js`/`roster.js` org-seed) in favor of a picked cast;
  keep random as an optional flavor toggle.

Files: `src/teams/{names,personas,roster}.js`, `src/commands/team.js`, `src/docker.js`, `src/dashboard.html`.
**Pierre-gate: HARD — design volley before code.** May be rebuild-gated (container-side volume mounts).

## Phase 5 — Telegram one-bot (§6) — mostly independent, gated on an API spike

- **Verify the topics-in-private-chat lead** (Bot API spike) → topics vs. small bot-pool. Then one-bot +
  globally-stable `#N` routing + per-project isolation (§10 #3). Overlaps task #22.
  **Pierre-gate: medium** (cross-project routing isolation).

---

## Sequencing & gates

1 → 2 → 3 → 4 → 5, with two dependencies surfaced by Pierre's review:
- **P0 (do first): the P4 `~/.claude`-leak audit.** It decides whether P4's shared-character-volume can
  exist at all — run it *before* P1–P3 accrue design decisions that assume it. Cheap; gates the long pole.
- **Guard-2 (persona→host-def) is currently UNBUILT and P3 needs it** — schedule it inside P3, paired with
  the team.json→store move (which is security-neutral on its own).

Otherwise: P1 (host-side, low risk) → P2 (cross-org read-path verify) → P3 (guard-2 + human-gated add) →
P4 (post-audit, uncaged-only, human-added-boundary) → P5 (Telegram, its 3 isolation constraints stay the
wire-test). Each phase ships independently (host-side, `mrc rooms restart`); Phase 4 may need a rebuild.

## Verification (per phase)

- **Unit:** extend `test/*.test.mjs` for any new endpoint (`/api/validate-repo`), the provisional-record
  logic, and (Phase 4) the character-volume keying (door test: same character → same volume across
  projects; different characters → different). Keep the full suite green (currently 583).
- **Wire (host, gitignored `claude-scripts/`):** the owner drives the live gate each phase — Phase 1: a
  Build→Launch lands live in one gesture (no "stopped" flash), `~/path` accepted, form decluttered,
  `repo/team.json` untouched. Phase 4: launch the same character in two projects → one shared volume, no
  re-auth, isolation holds.
- **Two-gate discipline:** Pierre = code-right on the gated phases; owner-hardware = works. Both or neither ships.

## Out of scope / deferred (tracked)

Guard-3 + the 0700-dir assert (#24), Inc-3 rebuild-gated (#23), sha1/sockSlug collision (#26). The launch
bug is folded into Phase 1a (not a separate task).
