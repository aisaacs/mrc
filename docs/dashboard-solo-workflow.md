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

**Decision — the solo session is born detachable (Option A).** `mrc <repo>` (solo) spawns the session
inside a `dtach` master + `ttyd` viewer from launch and attaches your terminal to it — so the **browser
console and your native terminal are two attachers onto one session** (dtach is a transparent,
multi-attacher byte relay), giving both surfaces seamlessly with no relaunch to move between them. This
is exactly the member model, so it's one code path, not two. **Graceful degradation:** if
`ttyd`/`dtach`/`pgrep` aren't installed, solo falls back to today's direct `docker run -it` (native
terminal only, no browser) — so born-detachable adds **zero new hard dependency** for the plain-terminal
common case. (A foreground `docker run -it` can't be retrofitted into a detachable/browser session after
the fact — dtach must own the pty from launch — which is why "browser bolted on later" was rejected.)

### 4b. Pierre-as-caged-member — via a reusable **cage profile**
Summon moves from the pairings path to **adding a caged member to your engine room**. Pierre then
inherits the engine's multi-room + room-tagging for free — no #47 fix needed on the legacy path because
there is no legacy path. (Pierre is SAME-repo, so this holds — the caged member joins your own personal
org.) **CORRECTION (Pierre design review, 2026-07-04): the original claim "cross-repo peers join the same
way, which the engine already routes" is FALSE — see §6.5.** Cross-repo peers are cross-ORG, and the
engine REJECTS cross-org at `route()` (room-engine.js:340/345) by construction; that rejection is the
containment floor, not an accident. Cross-repo is a different story from Pierre-as-member.

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

1. Solo onramp (**4a**) — pure addition, no containment surface. Ship + use it as the default. **DONE.**
2. ~~Cross-repo peer as engine member~~ — **DO NOT BUILD as scoped (see §6.5).** Cross-repo consult stays
   on the pairings substrate; the engine is same-org only, by construction.
3. Pierre-as-caged-member (**4b**) — the containment port. Factor the inline cage into
   `applyCage(profile)`; the strict `adversary` profile must reproduce today's Pierre cage byte-for-byte;
   red-teamed with a summoned Pierre against the 4-point audit BEFORE it ships. **Core built; wiring §7.5.**
4. Retire the pairings path (**4c**) — **REVISED (see §6.5): retire only the same-repo/summon uses the
   engine supersedes; KEEP pairings as the dedicated cross-repo-consult substrate.**

## 6.5 Piece 2 finding — cross-repo consult stays on pairings (do NOT absorb it into the engine)

**Pierre design review (2026-07-04), verified at the line.** Piece 2 ("cross-repo peer as an engine
member") should **not be built as scoped**, and 4c must **not** fully retire pairings. Cross-repo = cross-
**org**, and:

- **The engine is single-org BY CONSTRUCTION, and that's a containment floor, not a preference.** `route()`
  rejects cross-org on every call: room-engine.js:340 & 345, `if (room.org !== s.org || !room.members.has(h))
  return {ok:false}`. Every resolution goes through `mem(room.org, …)`; `bySession` is single-valued
  (one session → one `{org,handle}`). "Cross-org bleed structurally impossible" is this one conditional.
- **(a) foreign-member is impossible on the session-id.** A container has ONE `MRC_SESSION_ID` → registers
  as ONE org; it can't be both repo-B's solo member (orgB) and repo-A's foreign member (orgA), and
  `memberSessionId = sha1(org\0handle)` differs per org. Territory also assumes the member runs in the
  ORG's repo, but a cross-repo peer runs in its own. Conflates "routes in orgA" with "runs in repo-B."
- **(b) "narrow consult bridge" is (c) in disguise, and silently drops the most common case.** Two `--solo`
  peers are BOTH `you/claude` (SOLO_HANDLE is a constant); the memberMap is keyed by bare handle
  (room-engine.js:142) → they collide, and the 2-member fallback (`k !== fromHandle && k !== '@user'`,
  :227) finds no `other` → **the two-solo-devs consult is DROPPED.** Making it work forces org-qualified
  member keys + a modified line-340/345 gate + sender-org-scoped `@user` + a bypassed resolver — i.e. a
  fully multi-org engine.
- **The honest answer:** cross-repo consult is INHERENTLY cross-org/session-scoped; the pairings path
  already does it and is isolated *because it has no org concept at all* (nothing to bleed into). Engine =
  N-party SAME-org teams (structural floor); pairings = 2-party CROSS-org consult (no floor to breach).
  **Orthogonal, not redundant.** Absorbing cross-repo would convert the structural line-340/345 invariant
  into a per-route POLICY check for every room — a policy bug there is an org bleed for teams/leads/solo,
  not just consult. Negative-value "unification."

**Consequence for 4c:** keep pairings as the cross-repo-consult substrate permanently; retire only its
same-repo/summon uses.

**Dispatch-disjointness (audit-#2) — holds BY CONSTRUCTION today; pre-registered for one future feature.**
Traced at the line: the pairings-vs-engine dispatch is frame-type-based, and the frame family a session can
emit is FIXED AT LAUNCH by the toolset split — `mrc-channel-server.js:189`, `const tools = TEAM_MODE ?
teamTools : consultTools`. `summon_adversary`/`list_peers`/`ask_peer` are in `consultTools` ONLY; `teamTools`
has none of them. So a MEMBER can neither summon nor consult, a CONSULT session has no team tools, and a
session emits exactly ONE frame family → routes to exactly ONE substrate. The hypothesized misroute
(a member summons an adversary → lands in both substrates → reply misroutes) is **unreachable** — a member
has no summon tool. So disjointness holds structurally, not by convention; **no guard code is needed today.**
It becomes a real requirement at exactly ONE point: the moment a solo MEMBER is given consult tools so it can
**pull in a cross-repo peer on demand** (the #49 vision — a solo session reaching a cross-repo consult, which
per this finding lives on pairings). That feature makes a session dual-substrate. **Pre-registered:** when
that feature is built, build a pure `dispatchSubstrate(session-memberships, frame) → {substrate, room |
AMBIGUOUS}` guard + its test FIRST (same shape as `reconcileSealDecision`), because it is the feature that
breaks the toolset split. Until then, it's a spec, not code.

**Functional finding (NOT containment) that fell out of the trace — dead shared tools on team members.**
`teamTools` (mrc-channel-server.js:187) exposes the SHARED tools `update_notes` / `submit_handoff` /
`pause_room` / `resume_room` to a team member, but the daemon dispatches their frames UNCONDITIONALLY by
type (room-daemon.js:1065-1068) to PAIRINGS-only handlers — `onNote` (:834-835, `activePairingFor` → else
`ack('no-pairing')`), `onHandoff` (:890), `onAgentPause`/`onAgentResume` (:936/942). A member has no pairing
(proven above), so these four tools **silently no-op** for it ("a tool that acks `no-pairing` is a lie about
its own capability" — Pierre). Not a containment bug (the drop is safe — no row to misroute into), but a
member is told it has capabilities that do nothing. **DECISION (rebuild + design, not tonight):** either DROP
these from `teamTools`, or WIRE them to the engine equivalents (the engine already has `doBrake`/`doResume`
for pause/resume; decide whether teams want a notes/handoff analog). Verify each of the four before choosing.

## 7. Open questions

- ~~**Is the human's workspace the ttyd-embedded console, or their native terminal?**~~ **RESOLVED
  (Option A, born-detachable):** both, seamlessly — the solo session lives in a dtach master from launch;
  the browser (ttyd) and the native terminal (`dtach -a`) are two attachers onto the same session. Falls
  back to direct `docker run -it` (native only) when ttyd/dtach aren't present. See §4a.
- **Personal-org identity across repos** — does a solo session's "personal org" span repos (so
  multi-repo peers join one standing room), or is it per-repo with cross-repo peers joining ad hoc?
- **Resume** — a resumed solo session must rebind to its personal org deterministically (the same
  `memberSessionId` discipline the teams path already uses).
- **When does the pairings path actually get deleted** vs. kept as a fallback — what's the wire-verify
  bar for each case it served (consult, summon, resume) before removal?

## 7.5 4b implementation status — built vs. the rebuild-gated wiring

**Built + unit-tested (the cage-as-DATA core + the sidecar, ~20 tests, suite green):**
- `src/teams/cage.js` — the profile registry (dual-axis `ready`), `resolveCageProfile` (single mint gate),
  `applyCage`/`applyCageDials` (gated; the second door closed via `allowUnready`), the record-keystone fix
  (`adversary:true` for a caged member — closes the classify-as-normal uncage), HKDF-derived egress token.
- `src/proxies/seal.js` — the container-lifetime SNI sidecar + lifecycle: client-auth, the 3-state liveness
  probe, `ensureSeal` (fail-closed, reuse-gated on a live container, reap-then-spawn), `pgrep`-nonce reap
  (freshness-scoped), and the pure `reconcileSealDecision` (kill + reap branches BOTH fail-toward-starting).
- `src/proxies/sni-proxy.js` — `Proxy-Authorization` validated before the SNI peek/dial.
- `src/teams/roster.js` — a `cage` field rejected at parse for a non-claude backend / unknown profile.

**Remaining = the launch/daemon WIRING (containment-critical, Docker+pgrep-dependent → build against a live
rebuild + Pierre's matrix, never blind).** Precise plan + the open conflicts to resolve:
1. **Replace the in-process SNI proxy (mrc.js:616-627) with `ensureSeal` — atomically, with the port ordering
   fixed.** The seal needs the nonce (session id) + secret (`MRC_ROOM_SECRET`), both computed LATER than :616
   (roomInfo :631, record :648), AND `ensureSeal` ALLOCATES the seal port itself (findFreePort). So the ONLY
   correct order is: **ensureSeal (alloc port, spawn, confirm bound) → THEN inject `HTTPS_PROXY=…:${returned
   sealPort}` (with the derived token) into `envFlags` → THEN `runContainer` (:735).** Building the env from
   `applyCage` BEFORE `ensureSeal` injects a stale/guessed port — the port isn't known until ensureSeal
   returns. **DELETE the inline SNI (616-627) FULLY, in the same change** — never leave both, or you get a
   double `HTTPS_PROXY` (inline + applyCage, last-wins ambiguity) or a half-seal. Hard-gate: `!ensureSeal.ok →
   process.exit(1)` (mirror the :624 refusal); `ensureSeal` already reaps its own unconfirmed seal on timeout,
   so the gate is just the exit, and the hard-gate guarantees "no `HTTPS_PROXY` without a confirmed seal." MUST
   inject `liveContainerForNonce` (a `docker ps --filter label=mrc.seal=<nonce>` probe) at this call site —
   absent, `ensureSeal` fails SAFE (respawn) but the reuse optimization is off, so inject it. The daemon's
   `withinReapGrace` must be sized for a COLD launch (Colima boot + first-run image build = minutes), off the
   portfile mtime — a warm-sized grace reaps a cold-starting resume's fresh seal before it registers (Strike E).
2. **Recognize `member.cage` — make the MEMBER path cage-AWARE; do NOT fold into `cagedAdversary`** (Pierre —
   folding reintroduces the round-1 mutual-exclusion verbatim). mrc.js:450 is `memberCtx ?
   memberCtx.workspaceVolumes : [… cagedAdversary ? ':ro']` — a caged member HAS a memberCtx, so the ternary
   takes the memberCtx branch and the `cagedAdversary ? ':ro'` on the ELSE never fires. Setting
   `cagedAdversary=true` for a member gives it neither the ro workspace nor the slot pool — the member branch
   structurally bypasses every cagedAdversary-gated seam. So instead: **`memberWorkspaceVolumes` becomes
   cage-driven** (a member with `member.cage` → `applyCage` → `/workspace:ro`), and the member's config volume
   stays its dedicated per-handle key. applyCage DRIVES the member branch; it never rides a boolean that branch
   skips.
   - **OAuth-isolation, made a CHECKED PRECONDITION (not emergent from branch order).** Good news: a caged
     member already gets `volumeName(repo#<handle>)` — a DEDICATED volume, NEVER the user's `mrc-config-<hash>`
     — and memberCtx-first (mrc.js:497) means it can't fall through to the normal `nextInstanceSlot` branch
     where slot 1 REUSES the user's login volume (#9). So `repo#<handle>` IS the isolation; you do NOT need to
     graft the literal `-pierre-N` pool machinery (it lives else-of-member, exactly what a fold would fail to
     reach). BUT the invariant currently rests on branch ORDER, and this wiring REORDERS (retires inline
     cagedAdversary, reroutes summon through applyCage+member). A reorder-slip that drops a caged launch into
     the normal branch mounts the user's `~/.claude` RW into a red-team, silently. So **add a fail-closed
     assertion at the volume-selection point: if the cage profile is non-null AND the resolved `volName`
     equals the user's login volume (`volumeName(repoPath)` / `volumeName(repoPath, slot)`) → REFUSE
     (process.exit).** OAuth-isolation becomes "a violation halts the launch," not "safe because the branches
     happen to be ordered this way."
   - **O_EXCL on the handle-slot mint (round 3).** The member path keys `repo#<handle>` with no atomic claim
     because the handle is static-from-roster today. Summon-as-member mints `pierre-N` DYNAMICALLY, so the
     slot→handle claim must be O_EXCL (launcher-authoritative) — else two concurrent summons both mint
     `pierre-1` → the same `repo#pierre-1` volume → a shared `~/.claude` with no exclusion (the concurrent-write
     hazard the pool's O_EXCL exists to prevent).
3. **Widen the mrc.js:535 guard.** `cagedAdversary && config.daemon` refuses today because the in-process
   proxy is interactive-only. With the container-lifetime sidecar that reason is gone — but a caged member is
   born-detachable (a dtach master), which the guard must now ALLOW while still enforcing the seal.
4. **Daemon reconcile hook** — call `reconcileSealDecision` in room-daemon.js's reconcile loop with real
   probes (`docker ps mrc.seal` → liveSealNonces; `sealProcessAlive` → sealAlive; portfile-mtime →
   withinReapGrace; container-age → withinGrace); act on `killContainers` (docker kill) + `reapSeals`
   (`reapSealForNonce`). This is hygiene (fail-safe: a bug under-reaps, never uncages).
5. **Summon becomes an `applyCage` caller** (the daemon's summon launcher spawns a `cage:'adversary'` member)
   — coexists with the legacy summon until it's wire-verified, then the legacy path retires (4c-style).

**Pierre's 3-test rebuild matrix (the acceptance gate for the wiring):**
1. Kill the dtach master → container UP, seal ALIVE, egress WORKS, no kill fires (born-detachable survives).
2. Kill the seal → egress refused INSTANTLY (firewall + dead port, before any reconcile), then the zombie
   reaped; AND a resume during the window keeps its fresh seal (Strike A/E).
3. Kill the container → the seal reaped by `pgrep`-nonce (a pid-renamed decoy process must survive).

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
