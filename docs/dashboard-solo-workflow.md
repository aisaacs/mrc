# Dashboard-First Solo Workflow (design)

**Status:** Design only — no code. Captures the shape of **#49** (the post-merge EPIC:
"multi-room normal sessions + dashboard single-session flow"). Builds on **agent teams**
(`docs/agent-teams.md`) and **negotiation rooms** (`docs/negotiation-rooms.md`). Write it now so it's
ready to build the moment `integration → main` lands.

---

## 1. The vision (owner's words)

> "Work in a normal plain session inside the dashboard, but also take advantage of Pierre and
> multi-repo work when I need them."

One surface — the daemon-hosted dashboard — where the **default** is a plain solo Claude session, and
Pierre (a caged adversary) or cross-repo peers are things you **pull in on demand**, not a separate
ceremony you set up in advance. No `team.json` to hand-author for the common case; the roster is what
you reach for only when you actually want a standing multi-member team.

## 2. Why now: this makes #47 obsolete, not deferred

There are **two routing substrates** in the daemon today, and that duality is the whole problem:

- **Legacy pairings path** — `pairings` Map, `onAsk`/`onMsg`/`deliver`, `onAdversaryUp` →
  `ensurePairing`. This is 2-party and single-room. **Summoning Pierre and cross-repo consults run
  here.** It's where the **#47** multi-room reply-misroute bug lives. room-daemon.js says it outright:
  *"summon is a future scope — it needs the legacy path to gain multi-room, or to route summon via the
  engine."*
- **Teams engine** — `src/teams/room-engine.js`. N-party, directed `@routing`, multi-room membership,
  room-tagged delivery, the `@user` inbox, brake/resume/turn-cap/steer for N members. Its membership
  check (`room-engine.js:333`, `senderOf(sessionId)` re-validated against the secret-authenticated
  register) is the *correct* multi-room containment — a live Pierre conceded it under red-team.

**The multi-party foundation is already built.** #47 is only a problem because solo work is stranded
on the *legacy* path. Route solo work through the **engine** and the multi-room reply bug has nowhere
to live — you don't fix the pairings path, you **retire** it. That is why, once this lands, #47 is
moot rather than merely deferred.

## 3. What is already built (the foundation we inherit)

- **Engine multi-room routing** — directed `@mention`, room-tagged delivery, per-room membership,
  scoped resolution (`room-engine.js`). The hard part is done and Pierre-verified.
- **Per-member terminal in the browser** — every live member runs in its own **dtach master + ttyd
  viewer** (#34), embedded in the dashboard. "Work in a plain session *inside* the dashboard" is
  already the member model; a solo session is just a team-of-one member rendered the same way.
- **The `@user` inbox** — typed, persistent, cross-surface (dashboard + Telegram). A solo session's
  questions/FYIs already have a home.
- **The adversary persona** — `src/teams/personas.js` already has an adversary role.
- **The cage** — SNI-pinning egress proxy, ro/territorial volumes, launch-derived containment markers
  (`/proc/1/environ`), classified from the tamper-proof host record. Built and wire-verified — but
  today it rides the **summon/pairings** launch path, not the member-launch path (see §5).

## 4. What is NOT built (the actual work), three pieces

### 4a. The solo onramp
Today the engine requires a hand-authored `team.json` (`mrc team up` throws without a roster). Add a
**team-of-one / personal-org** launch that needs *zero* roster ceremony: "just launch a normal
session," but it registers as an engine member so it gets the dashboard console + engine membership +
the `@user` inbox for free. This is the ergonomic core of the ask — the dashboard's default "New
session" button, not a team builder.

- The org is derived (one member, the human as `@user`, a default personal room), so the human never
  writes JSON for the common case.
- The plain session behaves exactly like today's solo Claude session — the engine membership is
  invisible until you pull someone in.

### 4b. Pierre-as-caged-member — via a reusable **cage profile**
Summon moves from the pairings path to **adding a caged member to your engine room**. Pierre then
inherits the engine's multi-room + room-tagging for free — no #47 fix needed on the legacy path because
there is no legacy path. Cross-repo peers join the same way: a member per repo in a shared room, which
the engine already routes.

**Make the cage reusable, not Pierre-specific.** Today the cage is a *hardcoded bundle* wired inline in
`mrc.js` behind one boolean (`cagedAdversary = config.summonedBy || config.cageAdversary`): ro workspace,
SNI-pinned egress, dedicated login slot, blocked host bridges, scoped `/rooms`, the host security record.
Part of this work is to **factor it into one reusable `applyCage(profile, ctx)`** — the single source of
truth producing both the `docker run` grants *and* the host-record fields — so caging *any* member is
"apply profile X," and a member can be caged looser or tighter without re-touching the plumbing. The
(retiring) summon path and the member-launch path both call it.

**The cage is a set of dials, not one boolean.** Read straight from the current inline cage, the real
knobs — and the strictness axis for each:

| Dial | Strict (Pierre today) | Looser options |
|---|---|---|
| `egress` | SNI-pinned to the model API only (`sni-proxy` + `MRC_ADVERSARY_FW` firewall + `ALLOW_WEB` force-stripped) | `whitelist` (standard mrc domains) · `web` (full) |
| `workspace` | `/workspace:ro` | `territory` (own lane rw) · `rw` |
| `login` | disposable dedicated `-pierre-N` slot, never the owner's config, no codex vol | own persistent per-handle volume |
| `hostBridges` | clipboard + notify **blocked** | allowed |
| `roomsScope` | own room dir only, `:ro` | all rooms `:ro` |
| `mrcVisibility` | *(today: readable — this is the open **#55** hazard)* → the strict profile is the natural place to finally **mask** `/workspace/.mrc` (owner-gated) | readable |

A **profile** is an allow-list of these grants, **default-deny**: the strict `adversary` profile grants
nothing beyond model egress + ro; a looser profile *explicitly names* what it adds. Profiles live in a
small named registry (like `presets`/`personas`); a member declares `"cage": "adversary"` in team.json,
or an inline override object for a one-off. **The strict `adversary` profile must reproduce today's
Pierre cage byte-for-byte** — that equivalence is the correctness anchor for the port.

**Floors — identical for every profile, never a dial (the line the config must not cross):**
1. **The profile is resolved on the HOST at launch and stamped into the tamper-proof host record; the
   daemon classifies from that record, never the wire.** "Configurable" means *the human picks the
   profile at launch* (team.json / summon), resolved host-side — **never** a runtime setting the caged
   container can name, request, or soften over the channel. A member choosing its own looser cage over
   the wire *is* the silent-wire-trust failure the whole architecture exists to prevent.
2. **The cage is launch-time only** — no re-caging a live container; a profile change means a relaunch.
3. **Peer text is untrusted data under every profile**; only `[Human directive]`/`[Human reply]` is
   authoritative. A looser cage grants more *resources*, never more *trust*.

### 4c. Retire the pairings path
Consults, summons, and resume all route through `pairings` today. Once solo + summon + consult are all
engine-native, the pairings Map and its `onAsk`/`onMsg`/`deliver`/`ensurePairing` machinery can be
**removed** — a migration, not just an addition. Do this last, behind a flag, with the legacy path
kept until the engine path is wire-verified for every case it served.

## 5. The load-bearing risk: porting the cage to the member-launch path

Piece **4b** is the security-critical one. The launch-time cage (SNI proxy, ro volumes, containment
markers, host-record classification) currently rides the **summon** launch path
(`adversaryLaunchCmd`). Moving Pierre into the engine means wiring that cage onto the **member**-launch
path (`memberLaunch`) instead. The cage model is unchanged — **launch-derived containment, classified
from the tamper-proof host record, never the wire** — but the wiring is new and it is exactly where a
mistake becomes an uncage.

**This is Pierre's pre-registered seam #4** (see `overnight-wire-gate-queue.md`): when the human sits
in *both* the adversary room and the plain room, containment rests on **room-tagging integrity**, not
membership (the human is legitimately a member of both). The engine already has the right primitive
(directed delivery + room-tagging + the `:333` membership re-check); wiring a *caged* member into it is
where the care goes.

### Pierre's 4-point audit (pre-registered — build to it)
The same four points that gate the (now-obsolete) #47 pairings fix apply to the engine path, because
they are really about the containment substrate, not the specific code path:
1. **`id` must be secret-authenticated, never frame-carried.** The membership gate is theater if the
   sender id comes from the reply frame instead of the `MRC_ROOM_SECRET`-bound register
   (`senderOf`). The engine already does this at `:333` — keep it that way for the caged member.
2. **Dispatch disjointness.** During the transition two tables coexist (pairings + engine). A reply's
   roomId must not let a member's reply fall into the *other* table and bypass its membership check.
   The retirement in **4c** removes this hazard entirely — a reason to finish it.
3. **Gate on LIVE state, not just membership.** Refuse a reply into an ended-but-not-GC'd room
   (the #35 dead-room window).
4. **The issuer-in-both-rooms case (#57).** Verify a reply from the human/issuer can't carry
   adversary-room content into the plain room via a roomId swap — containment there is room-tagging
   integrity, and it is the seam to trust least.

## 6. Sequencing

**Post-merge.** This reshapes the substrate that `integration → main` is stabilizing, so it lands
after the merge, not before. Order within the epic:

1. Solo onramp (**4a**) — pure addition, no containment surface. Ship + use it as the default.
2. Cross-repo peer as engine member — exercises multi-room with *uncaged* members first (lower risk).
3. Pierre-as-caged-member (**4b**) — the containment port. Factor the inline cage into
   `applyCage(profile)`; the strict `adversary` profile must reproduce today's Pierre cage byte-for-byte;
   red-teamed with a summoned Pierre against the 4-point audit BEFORE it ships.
4. Retire the pairings path (**4c**) — last, behind a flag, only once 1–3 are wire-verified.

## 7. Open questions

- **Is the human's workspace the ttyd-embedded console, or their native terminal with the dashboard as
  an overlay?** The member model gives the former for free; the latter may be what a heads-down solo
  session actually wants. Possibly both (attach either way to the same dtach master).
- **Personal-org identity across repos** — does a solo session's "personal org" span repos (so
  multi-repo peers join one standing room), or is it per-repo with cross-repo peers joining ad hoc?
- **Resume** — a resumed solo session must rebind to its personal org deterministically (the same
  `memberSessionId` discipline the teams path already uses).
- **When does the pairings path actually get deleted** vs. kept as a fallback — what's the wire-verify
  bar for each case it served (consult, summon, resume) before removal?

## 8. Acceptance criteria (wire-verified before "done")

Not a green suite — an *observed end-to-end round-trip on the wire*, per the standing "red-team before
staged" rule (a green suite ships real bugs).

- **4a solo onramp** — `mrc <repo>` (or the dashboard "New session") with **no `team.json`** registers as
  a team-of-one engine member: it appears in the dashboard with a console, has an `@user` inbox, and the
  plain-session UX is byte-identical to today *until* someone is pulled in.
- **Telegram round-trip (the autonomous-handoff payoff)** — with the project's bot linked, a solo session
  *and* a Pierre+session pair can reach you when stuck: `ask_user` on the box → push to your phone → your
  reply there → the session receives it as a trusted `[Human reply]` and continues. Verified end-to-end on
  the wire, with resolution on **either** surface editing the other in place. **The epic is not done until
  this round-trips.** (This is why 4a matters beyond ergonomics: today's summon/consult path has no
  `@user` inbox, so a caged Pierre literally cannot page you — only the engine path can.)
- **4b caged member via profile** — a member launched with the strict `adversary` profile through the
  *member* path is caged **byte-for-byte identically** to today's summoned Pierre (egress, ro, login slot,
  host record, scoped rooms), classified from the host record (never the wire), and passes Pierre's
  4-point audit under a **live red-team** before it ships.
- **Reusable + configurable** — a *second* member caged with a *different, looser* profile gets exactly
  the strictness that profile declares and **no more**: its named extra grants are present, every dial it
  did *not* loosen is still at the strict floor, and it still cannot name or soften its own profile over
  the wire (the three floors hold regardless of profile).

---

*This is a design capture, not a commitment to an implementation. It exists so the epic is ready to
build with the cage-port risk named up front, and so the containment work is red-teamed against
Pierre's pre-registered audit rather than discovered late.*
