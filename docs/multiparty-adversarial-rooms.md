# Trustworthy low-touch progress — multiparty adversarial rooms (design)

> **Status: thesis validated by a live pre-check (2026-06-10, N=1); not built.** The direction that
> survived the parked crew exploration (see [`crew.md`](./crew.md)). Downtime work, off the critical
> path. Substrate: [`negotiation-rooms.md`](./negotiation-rooms.md).
>
> The build decision is now *informed* — see **[Pre-check verdict](#pre-check-verdict-2026-06-10)**: the
> dialogue-grounding **value is real and reachable two-party, by hand, today**; the multiparty build buys
> **autonomy, not the value**. So the next phase is to *dogfood* the workflow, not to build plumbing.

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
2. **✓ Tier 1 — `summon_adversary` (BUILT 2026-06-10, pending host test).** *Owner: the most appealing
   tier — letting the adversary **pivot on empirical grounding** is "the whole point."* Built: a channel
   verb `summon_adversary(brief)` → the daemon writes the brief to `/rooms/<id>/adversary-brief.md`,
   **opens a new iTerm tab** (osascript, with a paste-the-command fallback) running a *normal* interactive
   `mrc <yourRepo> --new --room <id> --summoned-by <you>`, then **auto-pairs** it back on register and
   **primes** it via a channel directive (no detached/headless — it's a normal tab, so it volleys; no cost
   cliff). Files: `config.js`/`pair.js`/`mrc.js` (`--summoned-by` + `MRC_REPO_PATH`), `mrc-channel-server.js`
   (the verb + register fields), `room-daemon.js` (`onSummon` + opener + handshake, adapted from the parked
   `onSpawn`; the spawn is **hard-constrained** — fixed adversary on your repo, no container args, one per
   requester). **Pending host verification:** (a) the osascript opener under macOS TCC (else the paste
   fallback / move to `mrc.js`), (b) whether a freshly-booted adversary acts on the priming directive.
   **Deferred:** auth-volume clone (else a one-time OAuth in the adversary's tab). Needs an image rebuild
   to pick up the channel verb.
3. **Tier 2 — multiparty join (the owner's actual common case).** Let an adversary join a room whose
   peers are *already* paired (lift one-room-per-session). *Owner (2026-06-10): "the workflow I'm in the
   most — client+server are already roomed, so without it I'm just copying and pasting a bunch."* So this
   is the real destination, **not** an "if frequent" maybe — Tiers 0–1 are the on-ramp to it. Also
   entails: hardening the role-prompt for *longer* volleys (drift), and the trust-boundary /
   knowing-when-to-stop problem the pre-check left untested.

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
