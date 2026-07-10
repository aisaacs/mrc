# Dashboard UX — the command-and-control redesign (design)

**Status:** Design capture, owner-driven (2026-07-10). No code yet. The containment-sensitive
surfaces (§10) go past a live Pierre before any implementation. Builds on the solo onramp and
cross-repo member work already shipped (`docs/dashboard-solo-workflow.md` §4a, Mouth B) and the
teams substrate (`docs/agent-teams.md`).

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
- **"Resume team" as a distinct control goes away** — resuming is just **pick-project** from the home
  (§3A).

## 6. Telegram — one token, per-project threads

Target UX: **each project is its own conversation thread in your Telegram inbox**; `@user` comments
accumulate in that project's thread; concurrent projects are separate labeled threads.

**Primary approach — one bot + Telegram topics.** A single bot (one token, set once in
`~/.config/mrc/.env` or the store) posts into per-project **topics**, so each project reads as its own
labeled sub-thread with no per-project token overhead. *(Verify the forum-topics bot API supports
create/target-topic the way this needs before committing — a short check, not an assertion.)*

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

## 11. Open / decide-by-using

- Which tile timestamp reads best (uptime / created-at / last-message-at).
- Telegram topics vs. bot-pool — pick after the topics-API verify.
- Autoname aggressiveness (Haiku-from-work vs. simple default-with-rename).

---

*Design capture, not a commitment. It exists so the build has one spec, the ergonomic bar is stated
up front, and the containment-sensitive surfaces are named for Pierre before they're written.*
