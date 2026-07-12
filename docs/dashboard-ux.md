# Dashboard UX — the command-and-control redesign (design)

**Status:** Design capture, owner-driven (2026-07-10). No code yet. The containment-sensitive
surfaces (§10) go past a live Pierre before any implementation. Builds on the solo onramp and
cross-repo member work already shipped (`docs/dashboard-solo-workflow.md` §4a, Mouth B) and the
teams substrate (`docs/agent-teams.md`). **Updated 2026-07-10** with the owner's first live
create→launch **field report (§11)** and the **recurring-characters ("Pierre model") direction (§5.2)**.
**Updated 2026-07-11 (§13):** a clickable prototype (`prototype/index.html`) drove the model to lock —
repo-per-agent, character-vs-role (Alessandro's roles preserved), team/leads-room semantics, no-delete,
teams-in-simple. §13 + the prototype are the current living reference.

This supersedes the repo-coupling framing in `dashboard-solo-workflow.md` §6.5: cross-repo work is
**same-project**, routed by the engine (one org, multi-repo members), *not* a bridge between two
projects. Pairings/consult shrinks to the genuine two-separate-projects edge case.

---

## 0. The bar (the whole point)

> Starting or opening a session and getting to work should feel **as light as opening a terminal and
> typing `mrc pick`.** That is the bar. Everything below is in service of it.

No `mrc team up`, no hand-authored `team.json`, no "correct incantation." You name a project (or let
it autoname), pick where it works, and go. Teams and members are things you *add when you want them*,
never ceremony you set up first.

## 1. The model (corrected)

- **Project = a unit of intent** — "the thing I'm working on." It is the org / isolation boundary.
  Internally the org's identity field is already literally `project`.
- **Repo is a member attribute, not a project attribute.** A project's members (across one or many
  teams) may live in the same repo or different repos, in any combination — one team spanning repos,
  many teams across many repos, members of one team split across repos. All valid. **Projects and
  repos are fully decoupled.** (Multi-repo members are same-org — this does not breach the one-project
  = one-org containment floor; it's what Mouth B built.)
- **"Solo" is an adjective, not a mode.** It just means a project has one member *right now*, which
  can change anytime. Like ambient rooms, every session simply *has* engine connectivity + an `@user`
  inbox + the ability to add members — you never launch "with or without" it. **The `--solo` flag
  retires as a user-facing concept**; being born a project-of-one is the default nature of every
  session, CLI- or dashboard-started.

**Vocabulary:** rename **org → project** everywhere user-facing. `team` / `member` stay as the
"advanced" vocabulary you only meet when you deliberately build a team.

## 2. The home — a command-and-control center

The landing screen is a glanceable grid of **project tiles**. See everything at a glance, drill into
any piece at any depth.

**Each tile shows:**
- Project name
- Number of teams · number of members
- Activity state: **idle** vs. **a member is working**
- A **needs-you badge** (❓) when any member in the project is waiting on you (aggregated from the
  `@user` inbox; same signal Telegram pushes)
- A timestamp — TBD which reads best in practice: uptime / created-at / last-message-at (decide by
  using it)

Tiles cover **live *and* suspended** projects, so the home doubles as the project picker.

## 3. Opening / creating — the two flows

The dashboard's entry is **project-level pick** (call it `pick-project`), distinct from the CLI's
repo-level `mrc pick` (which stays exactly as it is today):

**A. Resume a prior project** — pick an existing project from the list; its teams/members come back.
`team up` happens **implicitly** here (see §4).

**B. Create a new project** — two seed templates prefill the form:
- **Simple** (the solo default): one member.
- **Advanced**: define teams/members up front.

A new project's members each default to a **fresh session**, with the option to **resume a prior
session from the repo that member lives in** (member-level resume). So there are two independent
resume axes:
- *Project-level:* resume an existing project vs. create new.
- *Member-level:* within a new project, each member starts fresh or resumes a prior session in its repo.

The create form's inputs: **project name** (or autoname — Haiku can name it from the work, reusing the
existing host-side session-naming machinery) · **member(s) + their repo(s)** · **per-member fresh /
resume-prior** dropdown.

**The repo input is a validated directory chooser, not free text** (field report §11): it **expands
`~`/`$HOME`**, resolves to a realpath, validates the directory exists, and ideally offers a picker.
Today's raw free-text field rejects `~/…` with an opaque error — and, worse, is the CSRF `repo=/etc`
vector §10.1 hardens. A chooser fixes the ergonomics and drops the first-pin severity to
defense-in-depth in one move.

## 4. `team.json` is generated, not authored

- **Minted by the create-flow** with the teams/members you chose, **updated** as you add/remove
  teams/members, **scoped to the project**, and stored in the project's store slice (the `/mrc`
  location) — **not** committed in the repo root.
- Two on-disk **default templates** (simple / advanced) only *prefill the create form*; the real
  roster is minted fresh per project.
- **`team up` is never a manual step.** It happens automatically wherever it's required today — on
  **create**, on **resume**, on pick-project. The user never types it.

## 5. Inside a project

The existing project-level workspace (3-pane: nav → list → detail, embedded detached terminals per
member) is the drill-in. Refinements:

- **Sidebar `+ Add` button** — the on-demand way to grow a project:
  - **Add Pierre** (caged adversary) — auto-joins the room with the current session; the current
    session is notified; they start. (This is `#49` 4b, the caged-member port — core built, wiring
    rebuild-gated.)
  - **Add a cross-repo teammate** — pick the repo, optionally pick a role (default: a normal full-rw
    member, no role), that member comes up and is auto-roomed with the current session. (Mouth B —
    uncaged live cross-repo member — is built.)
  - **Add a design / other specialist member** — same gesture.
- **Sidebar `−` / dismiss** — remove a member cleanly when done. Dismissing a member **closes its
  room**, so ending a consult/adversary never requires remembering `mrc rooms end`.
- **Connect two live sessions from the GUI** — draw the room connection in the dashboard instead of
  doing the in-chat `list_peers` / `ask_peer` dance. This is **CLI/GUI parity**, not a replacement:
  the in-session verbs stay session-callable *and* gain a GUI equivalent (see §10 for the one
  exception).
- **End/close rooms from the GUI** — first-class buttons.

### 5.1 One clean Exit (= suspend), and Delete

The confusing tangle (x-pill vs. Delete vs. "Resume team") collapses to:

- **Exit / Close project** — **one** button. Cleanly shuts down each terminal, **warns if a terminal
  is mid-thought**, and is **non-destructive** — exactly like Ctrl-C-ing a terminal window. You resume
  in seconds and pick up precisely where you left off. This *is* suspend; drop the word "suspend" from
  the UI in favor of a plain Exit.
- **Delete project** — the rare "forget this project from Mister Claude." Still **keeps all files on
  disk** (repo, transcripts, roster); it just removes the project from the dashboard. Clearly
  separated from Exit, clearly the heavier action.
- **Launch must actually launch — in one gesture.** Field report (§11): tapping **🚀 Launch** left the
  project reading **"⏸ *stopped* — ▶ Resume team"** and the member reading **"@Fabrice isn't launched…
  (or `mrc team up`)"**; only **Resume team** actually brought it up. That launched-but-stopped →
  press-Resume two-step is the single most broken-feeling moment in the flow. Launch lands the project
  **live**, full stop — no second action, no `mrc team up` afterthought.
- **"Resume team" as a distinct control goes away** — resuming is just **pick-project** from the home
  (§3A).

## 5.2 Recurring characters (the "Pierre model") — stable identities, not random names

Today every launch mints fresh random French names (`names.js`). The owner's field report: the novelty
is genuinely fun, but it's **too noisy to follow** — you can't build a working relationship with a
teammate whose name changes every run, and every new name is a new terminal you must re-auth into.

The model to move toward: **a cast of recurring, recognizable characters — the way Pierre is always
Pierre.** You summon Pierre and you know exactly who you're getting: his role (faultfinding adversary),
his voice, his behavior. Members should work the same way.

- **Named characters** with a stable identity: name + role/persona + their **own persistent config
  volume**. You "add Colette the architect" and get the *same* character across projects — same name,
  same persona, recognizable everywhere (dashboard, `@user` inbox, Telegram thread, transcript).
- **Persistent per-character volumes ⇒ far fewer re-auths.** Because a character reuses its own config
  volume, its Claude session is already authenticated — starting a new project with a familiar cast no
  longer means N fresh terminal logins. This directly attacks the "re-auth into every terminal on every
  new project" pain the owner called out.
- **Recognizability > novelty.** Random-name-per-run retires as the *default* (keep it as an optional
  flavor toggle if wanted, but it is not the model). Stability is what makes a teammate followable.
- **Pierre is the existing proof of concept** — the caged adversary already IS a stable character with a
  fixed identity + its own volume. Generalize that pattern to a **curated few** true characters, plus
  user-authored ones. **Character ≠ role (see §13):** a character is a recurring *identity*; a role is
  Alessandro's *persona/mandate* (assignable to any Claude). Only a few jobs collapse to a single
  character — **architect = Colette, critique = Pierre, images = Thierry** — everything else (engineer,
  tester, …) stays a role you give a plain Claude.
- **The character is stable; its repo/territory is per-project.** A project assigns a character where it
  works this time; the identity/persona/volume travel with the character across projects.

**Containment note for Pierre (§10):** a per-character config volume **shared across the projects that
use that character** crosses the one-project=one-org isolation floor for that volume. That trade (auth
reuse + identity continuity vs. per-project config isolation) is a real containment question — it goes
to Pierre before it's built, alongside how a character's volume is keyed and what it may/may not carry
between projects.

## 6. Telegram — one token, per-project threads

Target UX: **each project is its own conversation thread in your Telegram inbox**; `@user` comments
accumulate in that project's thread; concurrent projects are separate labeled threads.

**Primary approach — one bot + Telegram topics. VERIFIED viable (Bot API, July 2026):**
- `createForumTopic` lets the bot make one topic **per project**; `sendMessage` with `message_thread_id`
  targets it; inbound updates carry `message_thread_id`, so a reply in a project's topic **routes back
  unambiguously**. One token, per-project threads, exactly the owner's vision.
- **One-time human setup** (bots can't create groups): the human creates a **supergroup**, turns on
  **Topics** (forum mode), and adds the bot as **admin with the `can_manage_topics` right** (that
  specific right — other admin rights don't substitute; `createForumTopic` fails *silently* without it).
  After that, per-project topics are automatic. This is the whole cost of the one-bot model.
- **Promising lighter lead (UNVERIFIED — worth a follow-up):** the Bot API docs hint topics work in
  **private chats** too (`message_thread_id` is "for supergroups and private chats only"; "bots can
  create topics in private chats without admin rights"). If that holds for our bot flow, it's **one bot,
  a plain DM, no supergroup at all** — each project a topic in the DM. Verify before relying on it.

**Alternative if topics don't pan out — a small bot pool.** On first run the user creates ~5–6 bots
once; the daemon **pools and reuses** them across projects as projects launch/tear down (the user
runs 3–4 projects at a time, and some sessions need no bot). A slot-pool over a fixed set of tokens,
managed centrally — not one-token-per-project-forever.

Either way:
- **Reply cost does not grow with volume.** Every push carries a stable `#N`; **tap-reply on the
  specific message** (or reply in the project's topic) routes unambiguously back to the right session,
  whether you have 3 projects or 30.
- Questions badge (❓ "reply to answer") vs. FYIs (🔔 "reply optional"); resolving on either surface
  edits the other in place.

This replaces today's strictly-per-project-token model (the overhead the owner flagged).

## 7. CLI

- **`mrc dashboard`** replaces `mrc rooms dashboard` (keep the old as an alias).
- **`mrc pick` (CLI, repo-level) stays exactly as today** — open a terminal in a repo, `mrc pick`,
  resume-or-new, work. The dashboard `pick-project` is an *additional* project-level picker, not a
  replacement.
- **`--solo` retires** as a user concept (see §1) — every session is born a project-of-one.
- **CLI/GUI parity** is the guiding principle: anything you can do in the dashboard (add a member,
  connect sessions, exit a project) has a CLI equivalent and vice-versa.

## 8. Seamless CLI ↔ web (already the design)

A session lives in a `dtach` master; the **web terminal and a native terminal are two attachers onto
the same session**. So:
- A coworker who wants to stay in their terminal **never has to work in the web UI** — they work in
  their normal terminal, and the dashboard is an optional second window + control panel. They can add
  a Pierre / design agent from the dashboard (or by summoning right in their terminal) and it appears
  **in their terminal session**.
- Moving a session between CLI and web is **not a big ask** — it's this same born-detachable design,
  already largely built for the solo onramp. CLI-started and dashboard-started sessions converge to
  one path by construction.
- Graceful degradation: if `ttyd`/`dtach`/`pgrep` are absent, fall back to a plain `docker run -it`
  (native terminal only) — zero new hard dependency for the plain-terminal common case.

## 9. What's already built vs. new work

**Substrate that exists:**
- Engine multi-room routing, directed `@mention`, per-room membership, the `@user` inbox.
- The solo onramp (born-detachable project-of-one) — `#49` 4a, **done**.
- Cross-repo **uncaged** live member in one org (Mouth B) — **done**.
- Per-member terminal in the browser (dtach + ttyd).
- Host-side Haiku session naming/summaries.
- GUI team launch (Build → 🚀 Launch) — the raw plumbing behind one-tap create.

**New work (mostly control-plane + defaulting, not new engine):**
- The **command-center home** (project tiles, badges, live+suspended).
- The **create/pick-project flow** with simple/advanced templates + member-level fresh/resume.
- **`team.json` lifecycle management** (generate/update, store-scoped, implicit `team up`).
- Making the **solo onramp the default** and retiring the `--solo` flag.
- The **sidebar `+ Add` / `−` Dismiss / connect-sessions / end-room** actions with CLI/GUI parity.
- The **one clean Exit** + relabelled Delete.
- **One-bot Telegram** (topics or pool) + globally-stable `#N` routing.
- The **caged-Pierre sidebar action** (the rebuild-gated 4b wiring).
- **Recurring characters (§5.2)** — a reusable cast with stable identity + persistent per-character
  volume; retire random-name-per-run as the default.
- **Create-form declutter (§11)** — collapse to name · members+repos · fresh/resume; remove/hide
  Save-team.json, Define-rooms, custom-roles, name-style, the territory `x`, and the `mrc team up`
  footer; make Launch land the project live in one gesture; repo input becomes a validated chooser.

## 10. Containment surfaces for Pierre (review before code)

1. **The daemon launching containers from a GUI tap.** Today launch is a host-TTY act; one-tap create
   means the (detached) daemon spawns `docker run`. Verify the launch-derived containment markers
   (host-record classification, cage profile resolution) are all established host-side at that spawn,
   never inferred from anything the container can influence.
2. **Connect-sessions parity vs. repo-authorization.** Creating a **room** between two sessions stays
   **session-callable + GUI** (parity) — it's the existing rooms mechanism, no new privilege.
   **Authorizing a repo** for a member (`addAuthorizedRepo` — choosing what host filesystem a member
   mounts and reads secrets from) **remains human-only, never session-callable.** These two must not be
   conflated: parity for room-connection, human-gate for repo-authorization.
3. **One-bot cross-project Telegram routing.** With a single token serving all projects, verify
   per-project isolation still holds — a reply in project A's thread/`#N` can only ever route to a
   member of project A; no cross-project inbox bleed via a forged or mis-stamped `#N`.
4. **Shared per-character config volumes (§5.2).** A recurring character reusing one config volume
   across the projects it joins deliberately crosses the per-project config-isolation line for that
   volume (the point is auth + identity continuity). Verify the blast radius: what a character's volume
   may carry between projects, that it can't become a cross-project data channel between two otherwise
   isolated orgs, and how it interacts with the caged-adversary identity rules (a character volume is a
   USER-RESOURCE, so it must key on identity, per the cage-vs-identity rule).

### 10.1 The launch security floor (Pierre-hardened, build-first)

Investigating surface #1 with a live Pierre turned up a **real, pre-existing hole** the create-flow
would walk into, and four rounds of hardening. Captured here so the floor is built **before** the UX.

**The hole.** The daemon's GUI launch delegates to a real `mrc team up` (good — the host-side gates
`parseRoster`→`resolveMemberRepo`/`assertCageAllowed` and the host-set `--member-def` identity blob all
still fire, so a container can't forge its *own* identity/mount/cage). BUT the **org's own top-level
repo** (`data.repo` / the launch `f.repo`) hits **zero guard**: `resolveMemberRepo`'s broad-guard runs
only for an *explicit cross-repo member*, never the org root (`roster.js:239` takes the default). The
exemption is justified in-code as "the human typed the path" — an **argv assumption the create-flow
deletes**, replacing a typed argv with a **free-text wire field** (`dashboard.html:1247`, posted in the
body). Result if unguarded: a GUI/CSRF launch mounts *any* host path (e.g. `/etc`) rw **and** reads its
`.env` secrets into the team. Host-side ≠ authorized.

**Four Pierre catches (each verified at the line):**
1. Guarding `launchteam.f.repo` alone is bypassable — the repo also rides in on `f.roster→data.repo`
   and on the **persisted `defineOrg.f.def.repo`** (stored wholesale + `saveOrgs`, no parse), which
   later `relaunchmember`/boot re-materialize. Gate at the **mint chokepoint**, not one handler.
2. `rosterFromDef` is **lossy** (drops per-member `repo`/`mount`/`cage`) — so C is precisely and only
   the **org-root** axis. One guard site.
3. Don't fold the org root into the member **authorized-set** — root ≠ member-host (the root is the
   default rw mount + `.env`-read root for *every* default member), so a flat set **over-grants** a
   member-eligible repo into a root. The root is **write-once/immutable** instead: pinned at create,
   never re-read from a later wire frame — structural, not a set-check.
4. **Pin ≠ Activate.** `defineOrg` doesn't just validate `def.repo` — it **acts on it at define-time**:
   `ensureTgForOrg` reads `def.repo/.env` + starts a Telegram bridge (`:439/:469`), `writeTeamFile`
   writes into it (`:419`), and **boot re-runs the read for every persisted org** (`:599`). A value-check
   never stops these — they consume `def.repo` directly. So the guard must hold the **side effects**
   inert until a trusted activate.

**Guard #1 — org root write-once + pin/activate separation.**
- **Value gate — `resolveOrgRoot(pinnedRoot, requestedRepo, {trusted})` — BUILT (`repo-auth.js`), 13
  unit tests green.** Existing pin → realpath-match or throw (write-once beats trust). First-pin →
  *trusted* origin only (CLI argv / picker create; keeps the `mrc ~` exemption); untrusted throws;
  refuses `/`.
- **Side-effect gate (daemon wiring, next).** A `def.repo` consumer (`.env` read, TG bridge,
  `writeTeamFile`) runs **only after a trusted ACTIVATE**, never at define/boot. The cases:
  - **Untrusted first-pin** (a raw/CSRF `defineOrg{new-org}`) → **THROWS, records nothing** (this is
    `resolveOrgRoot`'s untrusted-first-pin refusal — an attacker root must not even *persist* into
    durable state as a fat-finger-activate-later landmine).
  - **Trusted-but-not-yet-activated** and **grandfathered** (a root a pre-guard daemon persisted) → pin
    stands but **inert**: no consumer runs until an explicit activate.
  - **Activation record = a host-only sidecar of CONFIRMED REALPATHS per org** — literally the
    `authorized-repos` primitive applied to the root: **hex-keyed** (`Buffer.from(org,'utf8').hex`, never
    `slug` — collision = cross-org activation inheritance), **purged by `removeorg`**, and activation
    fires **iff `realpath(def.repo)` is in the org's recorded set** — a *value* match, not a name-keyed
    boolean. This kills the **delete→recreate** vector: `removeorg{X}` then `defineOrg{X, /victim}`
    can't inherit activation because `/victim` ≠ the recorded realpath, even if a purge is ever missed.
  - **CLI `team up` is genuinely trusted** (a local TTY frame a browser can't forge onto the control
    socket) → it activates directly. **The browser create is NOT** — it arrives as the same control-
    socket frame as a forgery, marked "human" only by the CSRF token — so browser **activation is a
    separate explicit human gesture on the pinned root** ("Activate project rooted at /X? [Confirm]",
    the Telegram-Confirm shape), never implied by the create POST. One gesture, trivial for a real
    root; the friction only bites an attacker or a stale/grandfathered root.

**Guard #2 — persona → host-authoritative record.** `rosterFromDef` re-reads `team.json` from the
container-writable repo for persona text on every relaunch/addmember (`team.js:632-637`) → a peer can
inject another member's `--append-system-prompt`. Fix mirrors identity/mount/cage: carry persona in the
daemon def (persisted, never re-read from a mounted file). *(Moving `team.json` to the store does NOT
fix it — the store slice is mounted rw at `/mrc`.)*

**Guard #3 — authenticate the control socket (`#6`).** `control.listen` on `127.0.0.1` has no app-layer
auth (`register` verifies a secret; the control handler doesn't). Bounded today only by the firewall
keeping *containers* off host ports (exposure = host-local). The create-flow turns this socket into a
durable **mount-any-path amplifier**, so host-local-only stops being acceptable — add the same secret
handshake `register` uses. **Ships together with guard #1**, since the trusted/untrusted origin
distinction leans on an authenticated caller.

**Create-flow hardening (folds into the UX):** make the repo input a **validated directory chooser**,
not free text — drops the first-pin severity from primary → defense-in-depth by removing the
CSRF-sets-`repo=/etc` path at the source. The inert-pin gate holds regardless.

## 11. Field report — the first dashboard create→launch (owner, 2026-07-10)

The owner built and launched a team ("test pros 2") entirely from the dashboard and logged the friction.
This is the ground truth the redesign has to beat. Each item maps to its fix — an existing section, or a
**NEW** requirement now folded in.

**The create / teams form ("the whole teams form is weird"):**
- **Repo path rejected `~`.** Typed `~/Downloads/repos/mrc/`; opaque error (no `~`-expansion). → §3
  **validated directory chooser** (expand `~`/`$HOME`, resolve, validate, picker). Also drops the
  §10.1 CSRF `repo=/etc` severity. **NEW req captured.**
- **Footer "then launch live members: `mrc team up`"** — unclear if it's required after Launch. → §4:
  `team up` is never manual. **Remove the CLI incantation from the GUI create screen entirely** — it
  belongs in CLI help, not the form.
- **"Save team.json" — "don't know why it exists."** → §4: the roster is generated + store-managed; a
  user should never see a "save the roster file" action. **Remove the button.**
- **"Define rooms" — unclear.** → rooms are derived from the roster (team room + leads room). **Hide
  behind advanced; auto-derive by default.**
- **"Custom roles" — unclear.** → tie to §5.2: pick a character/role from a known cast; "custom role"
  is an advanced escape hatch, not front-and-center.
- **"Start from preset" — good idea but very unclear.** → keep presets (the fast path) but make them the
  **primary** create choice ("start from a template team") with plain-language descriptions of what each
  spins up — not a bare dropdown.
- **Name style — "cool but too noisy."** → §5.2: retire random-name-per-run as the default in favor of
  recurring, recognizable characters.
- **The territory `x` button — "don't understand it."** → territory (a member's writable sub-tree) is
  advanced; the unlabeled `x` is inscrutable. **Hide territory behind advanced; default each member to
  its natural territory; if surfaced, label the control.**

**The "lead" concept:**
- Good concept, but **should be implicit** — "when you open a single session, that session is the lead."
  → §1 (solo-is-an-adjective) + §5.2: the first/only member is lead **by default**; "lead" is a derived
  property, not a manual toggle in the form. Advanced-only if surfaced at all.

**Launch → live (the most broken moment):**
- Immediately after **🚀 Launch**, the sidebar showed **"⏸ 'test pros 2' is stopped — ▶ Resume team"**
  and the member showed **"@Fabrice isn't launched. Build + 🚀 Launch the team (or `mrc team up`)."**
  **Only tapping "Resume team" actually loaded it.** → §5.1 **Launch must actually launch** — one
  gesture to live, no launched-but-stopped→Resume two-step, no `mrc team up` afterthought.

**What the owner *liked* (keep):**
- The character/naming *idea* — but as **stable, recurring** identities (§5.2), the Pierre model.
- **"Pierre is always Pierre."** Summon a known character, know what you'll get. This is the anchor for
  §5.2 and the whole "recognizable cast" direction.

## 12. Open / decide-by-using

- Which tile timestamp reads best (uptime / created-at / last-message-at).
- Telegram topics vs. bot-pool — pick after the topics-API verify.
- Autoname aggressiveness (Haiku-from-work vs. simple default-with-rename).
- Recurring-character volume keying + what a character may carry between projects (§5.2 / §10 #4).
- Preset presentation — how prominent, how much each template explains itself (§11).

## 13. Prototype-driven model (locked from the clickable prototype, 2026-07-11)

A clickable, fully-stubbed prototype (**`prototype/index.html`** — open locally, no server) drove several
model decisions out of the owner's head. These refine the sections above and are the reference the build
implements against:

- **Repo is per-AGENT, not per-project.** The create flow: each agent picks its own repo (recent-repo
  quick-picks by folder name, full path shown on select; a system folder chooser; manual), *then* a
  session in it (the GUI for `mrc pick` — fresh or a prior session). Happy path stays: New → pick a repo →
  Launch. (Confirms §1's "repo is a member attribute" concretely.)
- **"Members" → "agents". Default = a plain Claude.** Role is **de-emphasized** — a single session is
  just "claude"; roles surface only in Advanced and only matter for teams.
- **Character vs. role — the load-bearing split (preserves Alessandro's `personas.js` whole):**
  - A **role** is Alessandro's persona: a **mandate** (the collaboration charter) + a **mount** capability
    (`ro`/`rw`, a real bind boundary) + `leadByDefault` + the shared protocol (directed `@mention`, the
    leads-room rule, the trust model, human-commits). **Kept exactly.** Assignable to any Claude:
    engineer, tester, researcher, user-defender.
  - A **character** is a new layer on top: a recurring *identity* (name + persona + its **own persistent,
    already-authed config volume**), reusable across projects. A character may carry a default role.
  - **A few jobs collapse to a single character (hard-stops), by owner decision:** **architect = Colette**,
    **critique = Pierre**, **images = Thierry (Gemini)**. You don't spin up a generic critic/architect/
    designer — you summon the character. Everything else stays a role on a Claude. Solene/Margaux (critic/
    engineer) retire as *named* characters; their roles live on (critique→Pierre; engineer→a Claude+role).
  - **Making the other characters "proper like Pierre" IS the P4 build** (task #6, §5.2): Pierre already
    has the full stack (summon flow, prime persona, cage, persistent login-slot volume, durable host
    record); Colette/Thierry need the same. Gated on the P4 `~/.claude`-leak audit (§10 #4).
- **Team room + leads room — surfaced only where they earn it (Alessandro's design, unchanged):** a
  **team room** exists per team with **≥2 members** (intra-team `@mention`); a **leads room** exists per
  project with **≥2 teams** (each team's lead + `@user` — the *only* cross-team path, lead-to-lead). A
  solo/1-agent project has **no rooms**. The **`@user` inbox is separate** — your direct line to an agent,
  not a room. (The phantom 1-member "team room" that confused the owner was a rendering bug, not his
  design; removed.)
- **Teams in simple mode.** Default one team / one agent (fast path intact). Each team is **its own card**
  (Team label + editable name; agents inside); **＋ Add team** below the cards. No delete-team button
  (an empty extra team offers a small "remove").
- **Nothing is ever deleted.** The only lifecycle verb is **Close project** (= suspend → Recently used,
  resumable). Per-agent **Close session** (= Ctrl-C) greys the agent in the list; tapping it **Resumes**.
  Delete is gone entirely.
- **Home in three sections** — **Active** (live; New-project tile at the end), **Recently used** (no live
  terminals, last 14 days), **Archived** (collapsed). Tiles are the project picker; badge reads
  **"❓ needs human"**.
- **☰ → daemon Rooms screen** — every open room across all projects + consults, with controls and its
  **`thread.log` readable outside the project**.
- **Names are themeable aliases** over the stable identity (the config-volume id is the real identity);
  the **name theme lives in project settings**, not the add-agent modal. Switch themes or rename freely —
  the character keeps its volume + login.
- **Backend/model is per-agent** (Advanced): claude / codex / gemini.
- **Advanced is a toggle** revealing: the optional **template** (None / web / game / backend — Solo
  retired), per-agent **territory** (with an explanation: the sub-folder the agent may *write* to), per-
  agent **backend** and **role**, and a manual **Rooms** card (pair agents into extra rooms; you know a
  room by its members).
- **Launch = one gesture, lands live** (the §11 fix, rendered as the `launching → live` progress modal,
  never a "stopped" flash).

---

## 14. The escalation model — rooms, `★` leads, and the notify boundary (locked 2026-07-11)

Worked out with the owner from concrete traces (a checkout feature spanning a client + a server). It
resolves how `@user` fits the room topology, preserving **Alessandro's autonomous hierarchical team** and
the owner's **ad-hoc / flat / simple** workflow in **one uniform rule**. This is the foundation the
`deriveRooms` change and the create-form sit on.

**The invariant (the whole thing in one line):**

> **The human is notified ONLY on escalation decisions. Coordination is observe-and-steer on demand —
> pull, never push.** Your limited context stays spent on "what does the project need from me to unblock
> it," and nothing else. Want the backstory for a decision? You read that room's `thread.log` on demand —
> the context is there when you *want* it, not shoved at you constantly. You can always look at or steer
> any coordination room yourself; you just don't get *notifications* from it.

**The structure that falls out of the invariant:**

- **The escalation room = every `★` + `@user`, and it ALWAYS exists.** This is the "situation room" — the
  *only* surface that pushes to the human. It is the leads room, generalized (the owner's first instinct —
  "the leads room might need to always be there" — was right; it's how agents reach the human).
- **`★` ("can reach the human") is a per-AGENT capability, and there can be SEVERAL.** This is the
  primitive missing today (`deriveRooms` does one-lead-per-team). Solo = the one member is `★`. Hierarchical
  team = the lead is `★`. Ad-hoc peers (a client + a server) = **both** `★`. A Pierre/adversary is **never**
  `★` (it relays to the session it's consulting, never escalates to the human).
- **Coordination rooms carry NO `@user`. That absence IS the wall.** It's what forces a non-`★` (engineer,
  critic, Pierre) to escalate UP to a `★` rather than bicking the human directly — which is exactly
  Alessandro's autonomy chain (fan out → check each other → escalate up → the human only when the chain is
  exhausted → the answer filters back down to the origin agent). The wall is a structural property, not a
  persona instruction.
- **Only an explicit `@user`-directed message notifies.** The engine already does this — `ask_user` →
  question (badges/pushes), a plain `@user` → FYI (no badge), peer-directed → no inbox item at all. So peer
  chatter never pushes to the human regardless of which room it happens in.

**Split-vs-merged dissolves — it's just "is there a non-`★` to wall off?"** The *rule* is uniform ("`@user`
sits with the `★`s; coordination rooms wall off everyone else"); the room *count* varies by whether a wall
is needed:

- **Hierarchical team (autonomous):** team room `[architect ★, engineer, critic]` (coordination, no `@user`)
  **+** escalation room `[architect ★, @user]`. Split — because the non-`★` engineer/critic must be walled
  from the human. The engineer stuck ⇒ `@architect`; the architect stuck ⇒ `@user`; the answer flows back
  down to the engineer. This is the "give it a task and it runs, escalating only when genuinely stuck" flow.
- **Flat peers (ad-hoc), "Option 2" — the owner's choice:** two co-equal `★`s in one team get a **team room**
  `[client, server]` for coordination **+** the escalation room `[client, server, @user]` — the **same shape**
  every ≥2-member team gets. One uniform rule, no special-case for flat teams (Option 1 would have skipped the
  team room for all-`★` teams — a `★`'s room membership would then depend on its teammates' `★`-status; and it
  would have put their coordination *in* the escalation room, the exact clutter the owner rejected). Both peers
  reach the human directly (`@user` → escalation room) and coordinate in their team room (`@server` /
  un-addressed → team room); a Pierre lives in separate `[client, pierre]` / `[server, pierre]` consult rooms and
  reaches neither the human nor the other peer. Because the two `★`s are in BOTH rooms, a bare `@server` resolves
  in each — the **`findRoom` disambiguation** (below) routes it to the team room, keeping the escalation room
  `@user`-only **by construction**. (Note the `size===2` gate still applies *within* a room: un-addressed reaches
  the peer in a **2-member** team room, but drops in any **3+**-member room — so in a 3+ team, members must
  `@mention` to be heard. That's a size property, not a flat-vs-hierarchical one; the persona conveys "in a room
  of 3+, un-addressed drops — `@mention`.")
- **Solo (+ optional Pierre):** `[member ★, @user]`, plus a `[member, pierre]` consult if summoned. Not a
  special case — just "the only escalation path is the human," the general rule with one `★`.

**The engine change is bounded to routing SELECTION, not enforcement.** (An earlier draft claimed "no engine
change" — that was wrong for Option 2 and corrected here; the owner re-consented on the true premise.) `@user`
still lives in a room as a member and escalations still land in the inbox (that machinery is untouched). What
changes: **(1)** `deriveRooms` — team rooms gated to ≥2 members; the escalation room = all `★` + `@user`,
always; never seat `@user` in a room holding a non-`★`. **(2)** the **multiple-`★`** primitive (decouple
"reaches the human" from one-lead-per-team). **(3)** a bounded **`findRoom` disambiguation** — Option 2 puts
two same-team `★`s in BOTH their team room and the escalation room, so a bare `@peer` was ambiguous; `findRoom`
now drops the escalation room from the candidate set for peer/un-addressed routing **unless** `@user` is
addressed **or** the escalation room is the sole room a peer resolves in (a cross-team lead). This keeps the
escalation room `@user`-only by construction. It is **narrow-only** — `candidates ⊆ mine`, so it can only
*remove* a room, never add one the sender isn't in — and `deliverTo`'s membership gate still enforces
containment on whatever room is picked, so routing SELECTION never weakens the wall. A `@<team-only member> +
@user` cross-room span fails **loud** (never silently drops the teammate). **(4)** the create-form to express
`★` and ad-hoc rooms. **Pierre-gated: the multiple-`★` + `deriveRooms` invariant AND the `findRoom`
narrow-not-widen both go past a live Pierre** (correctness / containment-critical — the human-reachability path).

**The `deriveRooms` containment invariant (Pierre-verified — the three checks the diff must pass):**

> **`@user` ∈ room.members  ⟺  every non-`@user` member of that room is a `★`.** Equivalently: there is
> **exactly one** `@user`-carrying room — the escalation room — and its members are **exactly** the
> `★`-flagged agents `+ @user`.

Three failure modes `deriveRooms` must structurally prevent — get any wrong and it's the whole autonomy
story (a/b leak the human to a non-`★`; c strands the human unreachable):
- **(a) No non-`★` in the escalation room.** Build its members as `members.filter(★) + @user`, never "all
  members" — a single stray non-`★` in it reaches the human directly and the wall is gone.
- **(b) No `@user` in any coordination room.** The phantom-leads-room bug generalized. Assert: for every
  room that is not the escalation room, `!room.members.has('@user')`.
- **(c) At least one `★`.** Zero `★` is a dead-end — the human is unreachable (no `@user` path) *and* can't
  reach any agent. Floor: `1 ≤ ★-count ≤ member-count`; a create-form declaring an all-non-`★` team must be
  refused or default one member to `★` (solo already does this — the lone member IS `★`). This is exactly
  the invariant a naive multiple-lead primitive breaks by permitting zero.

Why the wall holds (routing SELECTION aside — enforcement is unchanged): a non-`★` lives in coordination rooms
only (no `@user`, by **b**), so its `@user` token resolves to no room-member and is **blocked at delivery**
(`deliverTo`, `room-engine.js`) — it cannot address the human. A `★` is in the escalation room (has `@user`) →
reaches the human. The `findRoom` disambiguation only chooses *which* room a message routes to; it never adds a
room, and `deliverTo` re-checks membership on the pick — so the wall rests on the membership gate, not on the
selection. The wall *is*
the autonomy chain: a non-`★` `@mention`s a `★` in its coordination room → the `★` `@user`s in the escalation
room. **Pierre checks exactly (a)/(b)/(c) on the `deriveRooms` diff before it ships.**

**Why this is the right landing:** it preserves Alessandro's work/intention/autonomy (the wall + the
escalation chain are intact and structural) AND the owner's need for flexibility, simplicity, and
efficiency (a plain session or "just a client, a server, and a Pierre" is first-class; the human is bugged
only for real decisions and can go as hands-on or hands-off as they want, on demand). One rule spans "full
autonomous team" down to "a session and a Pierre."

---

*Design capture, not a commitment. It exists so the build has one spec, the ergonomic bar is stated
up front, and the containment-sensitive surfaces are named for Pierre before they're written. §13, §14, and
`prototype/index.html` are the current living reference.*
