# Trustworthy low-touch progress — multiparty adversarial rooms (design)

> **Status: design, not built.** The direction that survived the parked crew exploration
> (see [`crew.md`](./crew.md)). Downtime work, off the critical path. Substrate:
> [`negotiation-rooms.md`](./negotiation-rooms.md).

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
proposed solution. One **adversarial agent** is summoned (by an original, via the daemon) and
**red-teams the solution + proposes alternatives in LIVE dialogue** with the originals, grounding or
refuting each claim against their real data. The *dialogue* — not a one-shot critique — is what makes
the adversary's output strong and grounded.

Why this, and not the parked crew: crew was *fan-out execution*, which ultracode / Workflow already
cover. This is *group reasoning by dialogue*, which **nothing** covers — subagents and Workflow are
one-shot beeliners, and rooms today is strictly two-party. **Dialogue ≠ delegation.**

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

## Easy 80% vs hard 20%

- **Easy (plumbing):** generalize the daemon's binary relay (a↔b) to a **participant set + broadcast**,
  plus a way to **join an existing room**. This is the one useful kernel of what would've been crew's
  "Phase 2 relay," minus the orchestrator / worker / dashboard baggage. The **summon verb** (an original
  asks the daemon to spawn + auto-join the adversary) is a thin layer on top — and cheap now that the
  channel-as-plugin work removed the dev-channel prompt.
- **Hard (the actual problem):**
  - An adversary that **stays adversarial** — rooms agents drift toward consensus (the volley +
    `consensus.md` both pull that way); a red-teamer that converges to polite agreement is worthless.
    The adversary's *role design* is the crux.
  - An agent that **knows its trust boundary** — advances the safe part, stops at the rest.

## What we ruled out (and why) — so we don't re-explore

- **Crew / fan-out execution** → ultracode / Workflow cover same-repo parallel work (with worktree
  isolation); the uniquely-crew slice (durable cross-repo fan-out) is rare, personal, and off the
  critical path. Parked — see [`crew.md`](./crew.md).
- **Human session handoff** → a plain git workflow (agent writes a handoff doc, commit it with the WIP,
  the next person pulls / Slack it). Not an mrc feature.
- **One-shot subagents for design** → they beeline; no mid-course dialogue. Wrong tool for design.
- **A separate "planner" agent** → planning is work the main session does well *in* context; it gets
  none of the independent-context benefit that justifies the adversary.

## Build order (when it's worth investing)

1. **Multiparty relay** — participant set + broadcast + join-an-existing-room.
2. **The adversary role-prompt** — the real crux; engineered to refute and stay grounded, not to agree.
3. **The summon verb** — slick; an original spawns + auto-joins the adversary via the daemon.

**Cheap pre-check first:** next design wobble, even pairwise-manual, point an agent at a real design and
see if it produces *real friction* vs fluent noise. That tells you whether the role-design is tractable
before you build any plumbing.

## Pointers

- Substrate: [`negotiation-rooms.md`](./negotiation-rooms.md) — the built 2-party rooms.
- History: [`crew.md`](./crew.md) — the parked crew exploration + verdict; the worker-execution /
  auth / spawn mechanics live there (and in the `crew-worker-model` memory) for if the summon is built.
