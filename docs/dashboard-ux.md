# Dashboard UX — the command-and-control redesign (design)

**Status:** Design capture, owner-driven (2026-07-10). No code yet. The containment-sensitive
surfaces (§10) go past a live Pierre before any implementation. Builds on the solo onramp and
cross-repo member work already shipped (`docs/dashboard-solo-workflow.md` §4a, Mouth B) and the
teams substrate (`docs/agent-teams.md`). **Updated 2026-07-10** with the owner's first live
create→launch **field report (§11)** and the **recurring-characters ("Pierre model") direction (§5.2)**.

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

- **Named specialist *and* generalist characters** with a stable identity: name + role/persona + their
  **own persistent config volume**. You "add Fabrice the architect" (or a generalist) and get the *same*
  character across projects — same name, same persona, recognizable everywhere (dashboard, `@user`
  inbox, Telegram thread, transcript).
- **Persistent per-character volumes ⇒ far fewer re-auths.** Because a character reuses its own config
  volume, its Claude session is already authenticated — starting a new project with a familiar cast no
  longer means N fresh terminal logins. This directly attacks the "re-auth into every terminal on every
  new project" pain the owner called out.
- **Recognizability > novelty.** Random-name-per-run retires as the *default* (keep it as an optional
  flavor toggle if wanted, but it is not the model). Stability is what makes a teammate followable.
- **Pierre is the existing proof of concept** — the caged adversary already IS a stable character with a
  fixed identity + its own volume. Generalize that pattern into a small reusable cast (architect,
  engineer, critic, designer, …), each a "Pierre" of its specialty, plus user-authored characters.
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

---

*Design capture, not a commitment. It exists so the build has one spec, the ergonomic bar is stated
up front, and the containment-sensitive surfaces are named for Pierre before they're written.*
