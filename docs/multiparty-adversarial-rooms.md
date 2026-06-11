# Trustworthy low-touch progress — multiparty adversarial rooms (design)

> **Status (2026-06-11): Tiers 0 + 1 BUILT and verified live; Tier 2 is a costed design fork awaiting a
> call.** The direction that survived the parked crew exploration (see [`crew.md`](./crew.md)). Substrate:
> [`negotiation-rooms.md`](./negotiation-rooms.md).
>
> Validated twice: by a live pre-check ([verdict](#pre-check-verdict-2026-06-10)), then by the feature
> *itself* — once Tier 1 was live we summoned the adversary (**Pierre**) onto Tier 2's own design, and he
> found a silent bug, a consent hole, and a better shape ([Tier 2 red-team](#tier-2-red-team-pierre-2026-06-11)).
> What's left is the **A/B fork** plus a shared first fix — see the build order.

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
3. **Tier 2 — a costed fork, red-teamed (see [Tier 2 red-team](#tier-2-red-team-pierre-2026-06-11)).** The
   owner's actual everyday case (client + server already roomed, pull Pierre in as a third). Pierre's
   teardown turned the "participant-set + broadcast" plan into a decision: **(A) pairwise side-channel**
   (cheap, consent-clean, summoner-mediated server-grilling) vs **(B) true 3-party done right**
   (participant-set + speaking token + a real server-consent handshake — buys live *unmediated*
   cross-examination). **Shared first step either way:** fix the latent `pairingFor` / `ensurePairing`
   routing bug (a real bug in the tree today). *Decision pending — the human's product call.* Also still
   open beyond the fork: the trust-boundary / knowing-when-to-stop problem, and drift over *longer* volleys
   (one good multi-turn volley so far — Pierre held).

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
