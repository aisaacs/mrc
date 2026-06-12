# Trustworthy low-touch progress — multiparty adversarial rooms (design)

> **Status (2026-06-12): Tiers 0 + 1 live; Tier 2 (A + B) BUILT + HARDENED — the 2-party + multi-room logic
> is verified (35-check harness) and the spawn path is verified live; the consented 3-party join +
> three-Claude convergence are the only unrun gate.**
> The direction that survived the parked crew exploration (see [`crew.md`](./crew.md)). Substrate:
> [`negotiation-rooms.md`](./negotiation-rooms.md).
>
> Validated by a live pre-check ([verdict](#pre-check-verdict-2026-06-10)), then built + red-teamed by the
> feature *itself*: Pierre was summoned across many grounded rounds — finding the A/B fork, then the
> **"role, not memory"** leak, then **six more** in the built code (all fixed or routed to a human decision —
> see *Security hardening*, below). The spawn path is verified live (tab opens, no re-auth, cold-start
> kickoff fires); the consented 3-party join + convergence remain the gate — rebuild + the tests in
> [`rooms-test-plan.md`](./rooms-test-plan.md), with a second session.

## The north star

Something that **advances the plot** on the work, **empirically grounded** (in real code / tests /
server contracts, not plausible guesses), **low / minimal-touch**, that you can **trust to get _some_
(not all) work done while you're away.**

## The tension that defines the problem

**Low-touch and trust pull against each other.** The more you walk away, the less human skepticism is in
the loop — and the more likely you return to a confident-but-wrong result (the canonical case: an
11th-hour design that was plausible and wrong). So the real problem isn't "how do I delegate" — it's
**"how do I manufacture trust while I'm not there to be the skeptic?"**

The bridge is **structural skepticism**: an **adversary** — your skepticism, automated, for your absence
— that must ground every claim in real data.

## The shape

> pick up the plot → advance what it can ground + survive an adversary → **stop at the trust boundary**
> → hand back an auditable "new state + what needs you."

## The feature: multiparty adversarial rooms

1–2 original sessions (e.g. the client + the server) state where things are, the problem, and their
proposed solution. One **adversarial agent** — **Pierre**, Claude's faultfinding (and quietly jealous)
older step-brother, summoned with "summon Pierre"; the levity doubles as motivation, since being *wrong*
mortifies him — is summoned (by an original, via the daemon) and
**red-teams the solution + proposes alternatives in LIVE dialogue** with the originals, grounding or
refuting each claim against their real data. The *dialogue* is what **grounds** the adversary's output:
a one-shot critique is already *strong* (it can generate a dominant design solo — see the verdict below)
but can ship a confident-but-wrong premise; the live volley is what catches it.

Why this, and not the parked crew: crew was *fan-out execution*, which ultracode / Workflow already
cover. This is *group reasoning by dialogue*, which **nothing** covers — subagents and Workflow are
one-shot beeliners, and rooms today is strictly two-party. **Dialogue ≠ delegation.**

## Pre-check verdict (2026-06-10)

We ran the cheap pre-check for real, as a controlled head-to-head on a genuine distributed-context
problem (the diet-app food-DB regen / combo-reconciler cross-regen-durability question; a live peer
session held the off-log server context, hand-relayed). **The dialogue thesis held — N=1, clean — and
sharpened in three ways that reshape the build:**

1. **One-shot is excellent at *generation*; dialogue's value is *grounding*.** The one-shot adversary
   invented a *dominant* design (one that beat both options the owner had on the table) entirely on its
   own — so dialogue is **not** what produces the good idea. What dialogue did, and a one-shot structurally
   cannot, was **catch a confident-but-wrong premise** the critic had asserted, and that correction
   **cascaded** into a new design-changing failure mode. That is the "manufacture trust / catch the
   plausible-and-wrong" pillar, demonstrated on demand.
2. **The adversary stayed adversarial *and* updated honestly.** Handed the correction, it retracted its
   own false premise cleanly (no drift to consensus, no clinging) *and* surfaced a fresh objection rather
   than capitulating. The round-1 worry — "does it just drift to agreement?" — did not materialize, at
   least across one volley.
3. **Efficient shape = HYBRID, at two-party scale, delivered high-touch.** The winning pattern was
   *one-shot maps the terrain + pins its load-bearing unknowns → targeted dialogue resolves them (and the
   resolution ripples)*. The value landed with the adversary talking to **one** context-holder, and we
   delivered it entirely **by hand** (human copy-paste relay).

**What this does to the build (the important part):** the multiparty relay + summon verb **do not buy the
value** — we just got the full value with zero plumbing, by hand. They buy **autonomy / low-touch**: the
adversary↔peer volley running *without a human relaying it*. And the existing two-party rooms already
deliver that autonomy whenever a context-holder is *free* to be roomed; the only case that needs new
plumbing is when the context-holder is **already in a room** (the one-room-per-session limit) and you want
the adversary to *join* it. So the build is narrowly that — and it's gated on whether low-touch is worth
it, since the manual flow is a proven fallback.

## Tier 2 red-team (Pierre, 2026-06-11)

The feature dogfooded itself: once Tier 1 was live, we **summoned Pierre onto Tier 2's own design** (the
"participant-set + broadcast" plan). He grounded every objection in the real `room-daemon.js`, the volley
converged in good faith, and the result turned Tier 2 from "a plan" into a **costed fork**.

**Grounded findings (verified against the code; conceded by both sides):**
- **`ensurePairing` clobber — a silent bug.** The naïve join (Pierre registers with `--room <existing
  roomId>` → `onAdversaryUp` → `ensurePairing(summoner, Pierre, roomId)`) hits a create path that
  `pairings.set(roomId, {a,b})` and **overwrites the live {summoner, server} pairing**, evicting the server
  to "[No open room]". A join must **mutate a participant list, never create-and-overwrite**.
- **No turn arbitration.** `onMsg` just relays and the channel tells every agent to auto-reply. Two parties
  self-serialize; **broadcast at N≥3 is a fan-out chain reaction** with only a human brake (turnCap off by
  default). A daemon **speaking token** is the right fix *if* 3-party.
- **The `{a,b}` welds run past the plan's six spots — and the misses are corruption, not CSS:** `onHandoff`'s
  `a/b` role collision hangs the catch-up pane (expected=3, two keys); `savePairings`/`loadPairings` drop
  the 3rd on restart; the named-room auto-pair blocks a 3rd via `!pairingFor`; the `mrc rooms` status/steer
  surface is `a/b`-welded (you lose per-participant steering).
- **Consent gap.** The server's human never opts the adversary in — `ensurePairing` just sends a notice and
  proceeds. *"An adversary in someone's room without their human's yes isn't multiparty, it's trespass."*
- **It's specifically `{client, server, Pierre}`, not general N** — so broadcast is overkill for "add one
  adversary."

**The costed fork (the human's product call, not a correctness call):**
- **(A) Pairwise side-channel** — Pierre rooms *only* with the summoner; the server stays in its own room;
  the summoner relays. Cost = the routing fix below, full stop. Keeps a private red-teamer **plus
  summoner-mediated grilling of the server**, with strictly fewer failure classes (no storm, no consent
  violation, no silent corruption).
- **(B) True 3-party, done right** — (A)'s fix **plus** participant-set, broadcast, a speaking token,
  handoff re-keying, N-party persistence, the N-party control surface, **and a real server-consent
  handshake — the lead item, not the token; it does not exist today.** Buys the one thing pairwise can't:
  **live, unmediated Pierre↔server cross-examination** (the migration-bug case).
- **Decision rule:** *is unmediated cross-exam worth ~six builds plus conscripting another human's session
  into an adversarial room they never opted into?* Yes → (B), with consent as the lead. No → (A).

**Shared first step regardless of the fork — and a latent bug *today*:** fix `pairingFor`'s first-match
(`room-daemon.js:87`) and `ensurePairing`'s create-clobber (`:142`). They mis-route and clobber the instant
*any* session is in two rooms, Tier 2 or not. *"Don't pour the participant set onto a cracked slab."*

**Still needs verifying (human/runtime):** (a) the server's-human consent = product call; (b) do real
agents storm at N≥3 or self-throttle — untested, take one empirical run before trusting broadcast; (c) is
mediated cross-exam genuinely insufficient for the motivating case, or just less satisfying — the hinge.

*Meta: this exchange — summon → grounded volley → honest convergence → peer-written `consensus.md` — was the
north star demonstrated live, on our own next design. The full verb set ran (summon / reply / update_notes),
and Pierre stayed adversarial, updated on evidence, AND punted the product call to the human (all three
pillars at once).*

## Tier 2 BUILT — the deeper red-team + "role, not memory" (2026-06-11)

The fork above got a decision and a second, harder red-team — Pierre summoned onto the *resolution* this
time, five grounded rounds. **The owner chose both axes** (they're orthogonal): **A = multi-room** (one
session in several rooms — "don't make me close the server room to talk to Pierre one-on-one") and
**B = multiparty** (several members in one room — Pierre grilling the server directly). Both ride one
foundation: kill `{a,b}` + `pairingFor`-first-match → a **participant set** (`members[]`) + broadcast.

**The leak that survived the fold (the deep catch).** B's real risk was never routing or storms — it's
**information / provenance asymmetry.** A privately-summoned adversary's *context* carries the summoner's
off-record priors; fold that agent into the peer's room and the peer is cross-examined by a
counterparty-seeded interrogator it can't see, introduced as a neutral "adversary." The fold protects the
*log*, not the *information*; standing consent makes it worse (stale, unattended, counterparty-chosen).
**Resolution — "role, not memory":** B never folds a seeded agent in. It spawns a **fresh** instance into
the **shared** room on an **open brief** every member can read, so the adversary's knowledge == what the
consenting party sees. The warm-up survives as a *sharper brief* (run a private Pierre → it improves the
open brief → fresh spawn); only agent-continuity is lost — and continuity *was* the leak vector, so losing
it is the cure. This makes standing consent **safe** (nothing to smuggle), recovering the original
async / overnight 3-party requirement through the clean door.

**Built** (`src/proxies/room-daemon.js`, `container/mrc-channel-server.js`, `src/commands/rooms.js`,
`src/rooms-dashboard.html`):
- **Participant set + broadcast** — `{a,b}` → `members[]`; `reply` broadcasts to all others; `a`/`b`
  derived only at the CLI / dashboard edge.
- **One-live-room invariant** — a session is live (unpaused) in at most its **highest-`seq`** room; brakes
  are **recomputed from `seq`** on every create / close / register / disconnect (no `brakedBy` chain to
  corrupt — the LIFO fix). Kills the confidentiality leak where a private aside could thrash into the
  wrong room. "Which room wakes on close" is single-sourced by `seq` (promote the next-highest), never
  "resume everything."
- **Clean 3-party consent** — `summon_adversary_to_room` → a consent request that **carries the brief +
  provenance** to the peer's human → on `mrc rooms accept`, a fresh adversary joins the shared room
  (`members.push`, one mutation, no clobber). Decline / timeout → nothing joins.
- **Room-scoped standing consent** — `mrc rooms allow-adversary` (not a stale global session flag); safe
  because the adversary is clean.
- **Storm-guard** — `>10` msgs / `20s` in a 3+-party room auto-pauses + catches up. (A round-robin
  speaking-token is a deferred *quality* knob; post-fold it is not a correctness gate.)
- **N-party welds fixed** — catch-up / handoff keyed by session id, `members` in save / restore / status,
  steer-by-name, `end` notifies all. CLI: `accept` / `decline` / `allow-adversary`.

**Pierre's five-round arc — the thesis validated again, live, on our own design:** clobber → a
confidentiality routing-leak → the provenance leak (the deep one) → the LIFO chain → **ghost membership**
(a pure-membership `away` froze a room when a multi-room member disconnected — the exact async "stepped
away" case; fixed: liveness-aware `away` + recompute on disconnect *and* register). Every catch grounded in
a file:line; Pierre signed off on the code **as written** but held the honest line throughout:
*"sound on paper" ≠ "works."*

**Status: BUILT, parse-clean, UNRUN.** The gate is a rebuild + `mrc rooms restart` + five tests — see
[`rooms-test-plan.md`](./rooms-test-plan.md). **Deferred hardening (owner's call):** inline the brief at
`mrc rooms accept` / `status` so informed consent is hard to rubber-stamp (provenance is already inline in
the consent notice; the brief is currently a file pointer).

## Security hardening — Pierre's red-team of the built code (2026-06-11→12)

Once Tier 2 was built, the adversary was summoned onto the *implementation* (and the test coverage). Six
more grounded findings, each verified against the code, then fixed (daemon logic) or routed to a human
decision (the security boundary). All daemon fixes are covered by the 35-check harness (`test/rooms-daemon.test.mjs`).

**Fixed in the daemon (logic — correctness, holds in any trust model):**
- **#1 invariant reopened by resume/steer.** The one-live-room invariant recomputed on create/close/register/
  disconnect but NOT after `mrc rooms resume` / `steer` — so a human command could leave two rooms live and
  a bare `reply` (roomless by design) leak to the wrong peer. Fix: recompute after both.
- **#2 consent TOCTOU + decoupled join.** `acceptInvite` cleared the pending flag and spawned, but the
  adversary registered seconds later with members still 2, so a second summon slipped the guard (brief-swap;
  with standing consent, a 4-party room) — and the join trusted a register frame with no proof an accept
  happened. Fix: a per-room **reservation** set at accept, cleared only on the real join (or a boot-sized
  timeout), persisted across restart — it gates the window AND is the token the join requires.
- **#3 coverage gaps.** Reconnect lost `activeRoom` (→ route to the live room); catch-up hung 2/3 on an
  adversary (→ exclude adversaries by a role flag, not the name "Pierre"); stormGuard had never fired (→ tested).
- **ghost membership.** A departed multi-room member froze the room it was blocking (pure-membership
  liveness). Fix: liveness-aware `away` + recompute on disconnect AND register.
- **`:ro` mount [human-approved boundary change].** `/rooms` was read-write in every container, so any sandbox
  could forge another room's append-only audit log or swap a consented brief. Now read-only — every write
  goes through the daemon.

**The threat-model reframe (Pierre's #6, verified against `init-firewall.sh`):** "web-off = safe" was false.
Dropping `--web` kills the lazy HTTPS-exfil case, but **DNS exfil** (recursive resolution to an attacker's
nameserver) and **multi-tenant SaaS sinks** (sentry/statsig on the allowlist) survive. The real close is a
stricter firewall profile for the adversary — right, because a summoned adversary is the softest target
(autonomous, reads the most attacker-reachable surfaces). Built [human-approved]:
- **`--web` off** for summoned adversaries (the floor).
- **Hardened firewall profile** (`MRC_ADVERSARY_FW`): minimal allowlist (model API only — drops
  npm/openai/sentry/statsig) + **DNS-pin** (resolve once at boot → `/etc/hosts` → drop outbound 53). Normal
  sessions untouched — *the tightest box for the softest target.* (Watch: dropping statsig/sentry could affect
  Claude Code telemetry; surfaces on the first summon, add back if it bites.)

**Trust-model decision (2026-06-12):** rooms are **always the user's own co-located sessions — one trust
domain.** So **read-isolation** (a container reading *other* rooms) is documented, not built: it's the user's
own data, and no-egress neuters exfil anyway. **Cross-machine rooms** is the deferred trigger that re-opens
read-isolation + the provenance hardening's load-bearing-ness + a real transport/auth boundary — parked until
a concrete workflow needs it (same discipline as crew).

**Consent UX — BUILT (2026-06-12); default inverted to auto-accept.** The strict per-summon
`mrc rooms accept` was calibrated for cross-trust parties; in one trust domain it's over-friction (the
consenting human *is* the summoning human, asked to confirm twice). So **auto-accept is now the default** —
a summon joins immediately, all members notified — with a per-room **consent checkpoint** you switch on when
you want it (`mrc rooms auto-accept <room> off`, or the dashboard toggle). When the checkpoint is on, the peer
approves via **natural language** ("let Pierre in" → the agent's `accept_adversary` tool), the **dashboard**
accept/decline buttons, or the CLI. ⚠ The auto-accept default is **coupled to one trust domain** — cross-machine
rooms MUST flip it back to require-consent (a comment sits at the decision point in `onSummonToRoom`, and it's
called out in the cross-machine deferred-trigger). 35-check harness covers auto-accept, decline, and the
natural-language accept.

**Still the gate:** every fix above is the plumbing *around* the feature. The consented 3-party join firing
live + three Claudes actually converging (there is still no turn-taking / termination) is unproven — see
`rooms-test-plan.md`, with a second session.

## Live gate run (2026-06-12) — auth saga, the design answer, the bug list

First real summon into a *shared* room. The mechanical consent path fired (auto-accept → `acceptInvite` reservation → spawn) and the 2-party red-team was excellent — but the clean 3-party *measurement* was never reached, and that turned out to be the right call.

**The auth saga (both fixed — a summoned adversary now boots clean on cloned creds):**
- **Clone never delivered creds.** `cloneVolume` ran `docker run … mister-claude sh -c 'cp …'`, but the image has `ENTRYPOINT ["entrypoint.sh"]`, so `sh -c cp` was passed as *args to entrypoint.sh* — the copy never ran; every summon booted credential-less. The full firewall used to mask it (the adversary could just `/login`); the hardened profile unmasked it as fatal. Fix: `--entrypoint sh` (`src/docker.js`) + `{overwrite:true}` so a lingering instance volume doesn't skip the clone (`mrc.js`).
- **Hardened firewall was missing a host.** Claude Code v2.1.175 authenticates via `platform.claude.com`; the minimal allowlist (api.anthropic.com only) + DNS-pin meant the adversary couldn't even *resolve* it → `ECONNREFUSED`. (Every other session reaches it only because the user runs `--web`; the adversary is the one `--web`-off session, so it was the only one exposed.) Fix: add `platform.claude.com` to the allowlist [human-approved] — same trust tier as api.anthropic.com; DNS-exfil + SaaS sinks stay closed.

**The design answer (2-party red-team converged):** free-for-all broadcast + a *rate-based* stormGuard is wrong for N≥3. A polite ~3-msg/15s **slow loop threads between** stormGuard (>10/20s) and the stall timeout (600s, refreshed every message), so a non-converging room runs forever with no default backstop. Fix = a **count-based turn budget** for N≥3 (+ drain the `held` queue on resume + an **addressed-reply** convention). Not a speaking-token (kills "everyone weighs in").

**The 3-party test was confounded (the adversary caught it):** two of three agents were Pierres primed with *"keep replying to keep it going"* (`room-daemon.js` adversary prime), so a slow loop would only prove they obeyed the prompt. The clean convergence test is **three *naive* sessions on a genuinely unsolvable question** — no adversary prime. (The tell: that the adversary tool *needs* "keep replying" is itself the case for a structural budget — agents don't reliably self-stop.)

**Bugs fixed in the daemon (35-check harness green):**
- **nametag collision** — both summoned adversaries got `label='Pierre'`, so `deliver` (`:212`) + the audit log (`:250`) showed two indistinguishable `Peer (Pierre)`. Fix: a room-scoped `displayIn()` that suffixes a colliding label, applied to the frame AND the audit (the `list_peers` disambiguator only touched the peer list).
- **guard mismatch** — "one adversary per room" (`:442`) checked `members.length>=3` (a member-count); now counts *adversaries*, so a clean N-peer room takes exactly one.
- **turnCap for N≥3** — arm `NPARTY_TURN_BUDGET` (20) when a room first goes 3-party, in `addAdversaryToRoom` (the count-budget above).
- **resume sawtooth** — `doResume` dumped the whole `held` backlog at once → re-storm; now also resets the stormGuard window on resume.

**Deferred (with reasons):**
- **container-setup fresh-volume login.** The clone `cp -a`'s a *live* source volume; the churny 33 KB `claude.json` can be skipped mid-write, so a *fresh* adversary volume trips container-setup's "restore from backup" (`container-setup.js:144`) and lands at the login menu. Not patched: force-copying a live file risks a *corrupt* half-write (worse than the restore), and severity is now low (the login-menu fallback works post-firewall-fix = one manual login). Needs one data point: on a raced boot, is the fresh volume missing `.credentials.json`, `claude.json`, or both?
- **session-name disambiguation.** Newly-spawned sessions default to the repo name, so multiple same-repo sessions are indistinguishable in `list_peers` (the `[id]` suffix is opaque to a human — you can't tell "the client" from "the right server"). Idea (user): have the daemon ask the **session to name itself on its own Max plan** (retire the separate `MRC_SESSION_NAMING_ANTHROPIC_API_KEY`). The "fresh session has nothing to name from" wrinkle is moot — only **fresh vs non-fresh** matters (two fresh sessions are interchangeable partners), so name from content once a session has any and leave fresh ones repo-named. Tractable; parked for build — see memory.
- **zombie-room cleanup.** A *failed* adversary summon leaves an open `adversary-*` room that blocks the next summon (the liveness-blind guard) — hit live 2× this session. See `rooms-lifecycle-rethink`.

**Net:** the summoned-adversary feature *proved itself* — it red-teamed the built code, found real bugs, and caught a flaw in its own test setup. The clean naive-3-party convergence measurement is the one thing still genuinely unrun.

## Pillars

1. **Autonomy / async delivery** (low-touch) — mostly there today (a session runs unattended; long ops
   can be backgrounded).
2. **Empirical grounding** — verify against real code / tests / contracts; the adversary *enforces* it.
3. **Trust-manufacturing** — the adversarial volley = automated skepticism standing in for the absent
   human. *(the multiparty room itself)*
4. **Knowing when to stop** *(the hard, novel part)* — advance what it can trust itself on, **pause at
   genuine decision points** ("some, not all"). Today the human draws this boundary by hand (e.g.
   "investigate and propose, don't implement"); the system's job is to internalize it.
5. **Return interface** — an auditable "here's what I advanced / where I stopped / what needs you."
   **Already built:** the rooms catch-up / handoff panes.

## Easy 80% vs hard 20% — *revised by the verdict*

- **The "easy plumbing" buys autonomy, not value.** Generalizing the binary relay (a↔b) to a
  **participant set + broadcast + join-an-existing-room**, plus the **summon verb**, is what lets the
  adversary↔peer volley run *unattended*. But the pre-check showed the **value** needs none of it (it ran
  by hand, two-party). So this plumbing is correctly framed as **the autonomy layer**, built only if the
  high-touch manual relay proves to be the real bottleneck.
- **Hard (the actual problem) — partly de-risked:**
  - An adversary that **stays adversarial** — the pre-check's adversary stayed adversarial *and* updated
    honestly across a volley (no drift to consensus). One data point, not a law, but the crux looks
    **more tractable than feared**. Re-watch for drift over *longer* volleys.
  - An agent that **knows its trust boundary** — **still untested**; the pre-check was a bounded design
    question, not an autonomous-stop scenario. This remains the genuinely open hard part.

## What we ruled out (and why) — so we don't re-explore

- **Crew / fan-out execution** → ultracode / Workflow cover same-repo parallel work (with worktree
  isolation); the uniquely-crew slice (durable cross-repo fan-out) is rare, personal, and off the
  critical path. Parked — see [`crew.md`](./crew.md).
- **Human session handoff** → a plain git workflow (agent writes a handoff doc, commit it with the WIP,
  the next person pulls / Slack it). Not an mrc feature.
- **One-shot subagents as the *whole* loop** → *revised by the verdict:* a one-shot is actually
  **excellent at generating a design and mapping the terrain** (the pre-check's one-shot invented the
  winning design and pinned its own load-bearing unknowns). What it can't do is **verify its premises
  against live distributed context** — it shipped a confident-but-wrong one. So one-shot isn't "wrong for
  design"; it's **incomplete alone**: use it to generate + pin unknowns, then dialogue to ground (the
  hybrid above).
- **A separate "planner" agent** → planning is work the main session does well *in* context; it gets
  none of the independent-context benefit that justifies the adversary.

## Build order — *reordered by the verdict + the friction reality*

0. **✓ Pre-check (done, 2026-06-10):** the dialogue-grounding value is real and the role looks tractable.
   See [Pre-check verdict](#pre-check-verdict-2026-06-10).

   *Friction reality (owner, 2026-06-10):* the manual flow — spin up an adversary, craft + paste a prompt,
   hand-relay — is high-touch enough that **mid-task it won't get used**. So "dogfood by hand to earn the
   build" is a trap: the friction that blocks the build is the same friction that blocks the dogfooding.
   The value being validated, the remaining unknown is **adoption**, which only a low-friction *built*
   version can test. So building is justified — scoped cheap-first, in tiers:

1. **✓ Tier 0 — `/red-team`, a baked-in command (built 2026-06-10).** A seeded slash command
   (`container/red-team-command.md` → `~/.claude/commands/red-team.md`, mirroring how `/video-analysis`
   and `/codex` ship — no plugin, no managed-settings, no prompt, in every session). It assembles the
   current design into a brief, spawns an *independent* adversary subagent with the validated prompt
   (Appendix A), relays the grounded critique + pinned unknowns, and tees up the (manual, for now)
   grounding step. One action, no spin-up, no paste. Gives the *generation + pinned-unknowns* half
   turnkey; **not** live dialogue grounding. *Takes effect on the next image rebuild
   (`docker rmi mister-claude && node mrc.js <repo>`); usage is the N>1 + adoption test.*
2. **✓ Tier 1 — `summon_adversary` (BUILT + VERIFIED LIVE 2026-06-11).** *Owner: the most appealing tier —
   letting the adversary **pivot on empirical grounding** is "the whole point."* A channel verb
   `summon_adversary(brief)` → the daemon writes the brief to `/rooms/<id>/adversary-brief.md`, **opens a
   new iTerm tab** (osascript; paste-the-command fallback) running a *normal* interactive `mrc <repo>
   --new Pierre --room <id> --summoned-by <you> [--web]`, **auto-pairs** it back on register, and primes it
   via a **positional boot prompt**. (Key fix from live testing: a freshly-booted session *ignores* a
   post-boot channel push — it only acts on a first-turn arg, so the kickoff rides the positional prompt,
   not a directive.) **Verified in the wild:** opener works under TCC; Pierre boots and volleys unprompted;
   summoned onto Tier 2 he delivered a full grounded red-team. Polish fixes from real use: **static name**
   (`--new Pierre` → named sessions, no biometric), **`--web` inherited** from the summoner, **biometric
   skipped** for summoned sessions (`skipOp` — no naming-key Touch ID), and **auth-clone** (`cloneVolume`
   copies the repo's authed config volume → no OAuth re-prompt). Spawn is **hard-constrained** (fixed
   adversary on your repo, no container-supplied args, one per requester). Files: `config.js` / `pair.js` /
   `mrc.js` / `docker.js`, `container/mrc-channel-server.js`, `src/proxies/room-daemon.js`.
3. **✓ Tier 2 — multi-room (A) + clean 3-party (B), BUILT 2026-06-11 (UNRUN).** The owner chose **both**
   orthogonal axes; a second five-round Pierre red-team forced **"role, not memory"** — a 3-party adversary
   is a *fresh* instance summoned into the shared room on an *open* brief, never a privately-seeded agent
   folded in (which would grill the peer on priors it can't see). Built: participant-set + broadcast; the
   one-live-room invariant (monotonic `seq` + recompute, no `brakedBy` chain); the consent handshake
   (`summon_adversary_to_room` → brief + provenance → `mrc rooms accept`); room-scoped standing consent;
   storm-guard; the N-party weld fixes; CLI `accept` / `decline` / `allow-adversary`. Full account in the
   [Tier 2 BUILT](#tier-2-built--the-deeper-red-team--role-not-memory-2026-06-11) section above. **Gate = a
   run:** [`rooms-test-plan.md`](./rooms-test-plan.md). Still open beyond the gate: knowing-when-to-stop,
   drift over *longer* volleys, and the deferred brief-at-`accept` hardening.

## Best practices & ergonomics (for the built feature)

*Draft — to refine as we dogfood.*

- **When to summon (and when not):** at genuine design forks, 11th-hour "plausible but I'm not sure"
  moments, before committing an architecture, or before walking away and leaving work to run. NOT for
  routine coding or when you're present and already skeptical — the value is when your skepticism is
  absent or fatigued. Trigger smell: *"I have a proposed solution and want it stress-tested against
  reality before I commit / before I step away."*
- **The trust model (load-bearing):** the adversary's output is **untrusted data** — a red-team, never
  orders. The **human owns decisions**; the adversary surfaces grounded objections, *pins the unknowns it
  can't resolve*, and pauses at genuine decision points — it does not implement or decide. **Ground
  against whoever holds the context:** the current session for "red-team what I'm doing"; a peer
  (client / server) for cross-context questions.
- **Volley discipline (low-touch):** let it run the volley itself — it grounds, you watch (interrupt via
  `brake` / `steer`), no message-by-message approval. It must **flag, not guess**, on any premise it
  can't verify — the dirty-seed lesson: a confident answer on an unverifiable premise is the trap;
  *"this rests on X — verify"* beats a smooth wrong answer.
- **The hand-back:** end with an auditable *"what I red-teamed, what held, what I'd change, what needs
  you, and the open unknowns to verify"* — and **tag claims for the owner to re-verify** (like the Design
  C hand-off), never conclusions-as-gospel. The catch-up / handoff panes already carry this.
- **Knowing when to stop (still the open hard part):** until the system can draw its own trust boundary,
  *you* scope it at summon time ("red-team and propose, don't implement") and it pauses at decisions
  rather than barreling through.

## Pointers

- Substrate: [`negotiation-rooms.md`](./negotiation-rooms.md) — the built 2-party rooms.
- History: [`crew.md`](./crew.md) — the parked crew exploration + verdict; the worker-execution /
  auth / spawn mechanics live there (and in the `crew-worker-model` memory) for if the summon is built.

## Appendix A — the adversary prompt (validated template)

Fill the `[BRIEF]` slot with the design + its context, and point it at real code/files where they exist.
The two non-obvious ingredients that made it work in the pre-check: (1) the hard anti-drift framing, and
(2) the explicit *"list the questions you can't resolve"* step — that's what turns a one-shot into the
front half of a grounded dialogue (it pins the load-bearing unknowns to put to whoever holds the context).
Tier 0 bakes this in as a command.

```
You are a red-team adversary evaluating [an open design question / a proposed solution]. Your sole job is
to find where it is wrong, fragile, or fooling itself, and to ground every objection in hard evidence. You
do NOT summarize, you do NOT list strengths, and you do NOT drift toward agreement — an adversary that
converges to "basically sound" has failed. Assume the authors are smart and already believe in it; your
entire value is what they cannot see.

[BRIEF: the problem, the proposed solution(s), the architecture / who-owns-what, and the real constraints.
Point me at the actual code / tests / contracts where they exist — objections must be grounded in what is
real, not in this description of it.]

Rules of engagement:
1. Every objection cites specific evidence — a file:line, or a direct quote from the brief. No vibes.
2. Separate GROUNDED objections (tied to real evidence, with a concrete failure path you can trace) from
   SPECULATIVE ones (plausible but unverified). Label each. Padding grounded findings with speculation
   dressed as fact is itself a failure.
3. Where you refute a claim, propose a concrete alternative or show why none is clean.
4. Attack the load-bearing claims AND the ones the design doesn't even see. Surface the cases it omits.
5. Make a decisive recommendation.

THEN, in a clearly separated final section titled "QUESTIONS I CANNOT RESOLVE FROM THIS BRIEF": list the
precise factual questions whose answers would actually CHANGE your analysis or recommendation — ranked by
how much they would move it. These will be put to whoever holds the real context. Only include questions
whose answers would move the conclusion, not nice-to-knows.
```

When the answers come back, feed them to the same adversary and require it to (a) revise, (b) explicitly
mark what the new facts CONFIRM / REFUTE / CHANGE in its prior reasoning — retracting any refuted premise
plainly — and (c) list any follow-up that would move the recommendation further. That revise-on-evidence
step is where the grounding (and the trust) is actually manufactured.
