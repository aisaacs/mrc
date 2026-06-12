# Crew — multi-session orchestration (PARKED / superseded)

> **Status: PARKED, superseded (2026-06).** This explored a generic multi-session *orchestration*
> capability — an orchestrator driving worker / oracle sessions, fan-out execution. It was deliberately
> **not built**.
>
> **Update (2026-06-11):** a concrete use case finally surfaced — orchestrating parallel `/investigate`
> runs over a batch of related CS tickets — which re-opens the "no compelling case" premise. Still not
> built; now a candidate to revisit (see *The concrete problem that re-opens this*, below).
>
> **The direction that survived this exploration** — *group reasoning by dialogue*, not fan-out
> execution — lives in **[`multiparty-adversarial-rooms.md`](./multiparty-adversarial-rooms.md)**. Start
> there.

## Why it was parked (the lesson)

- **Same-repo fan-out** → **ultracode / Workflow** already cover it (cheaper, worktree isolation, no
  boot gates, no extra Max seats). Crew added nothing here.
- **Cross-repo work**, in this org, is almost always **1:1 consultation** ("ask the server about X"),
  which **rooms** already does. The only uniquely-crew case — fanning out *several* sessions *across
  repos*, durably — is rare, effectively a personal client↔server situation, and off the critical path.
- It never touched the critical path (recipes → Figma).

The deeper insight: what's actually missing isn't *delegation* (covered) — it's *dialogue* (one-shot
subagents beeline; rooms is only two-party). That reframed the whole thing into the surviving direction
above, whose trust-engine is an **adversary in a multiparty room**.

## The concrete problem that re-opens this (2026-06-11) — orchestrated investigations

The park rested on "no compelling uniquely-crew case, off the critical path." One surfaced, on a real work
path (clearing the CS queue) — so the premise is worth re-examining.

**The case (workload — the user's, not mrc's):** three Zendesk tickets on the weekly-review recommendation
flow. A triage session mini-investigated each and split them — two share one maintenance code-path (one
investigation), one is a separate setup subsystem — yielding **two parallel investigations**. The worker
is the user's `/investigate` skill: **long (15–60 min), phased, with hard human-guided checkpoints.**

**Why it's the genuine crew gap (re-examining the parked premise):** that worker is neither a one-shot
ultracode/Workflow beeline (no checkpoints, no guidance — they sprint to an answer) nor a 2-party consult
(rooms). **Parallel, durable, checkpoint-guided workers an orchestrator spawns, tracks, and *synthesizes
across*** is exactly the slice crew was for — and here it's on the actual work path, not the rare cross-repo
edge the park dismissed. The orchestrator's distinguishing value is the **cross-worker synthesis** (the
triage already caught a calorie-floor clamp shared across both investigation groups) — what fan-out can't do.

**Pierre's placement — corrected, and it's the design crux:** *not* an end-gate that rubber-stamps a
concluded result. His value is **mid-work** — challenging hypotheses as they form, pressure-testing whether
a test actually validates, grounding findings before they harden (what he just did to the rooms design).
Woven into a worker's phase checkpoints, he could **subsume part of the skill's own verification** — the
dialogue-thesis (catch the confident-but-wrong premise) applied to investigation.

**Mechanism vs workload (hold the boundary — see the parked lesson):** the mrc-shaped pieces are the
**mechanism** — spawn a worker, monitor it, the cross-room synthesis surface, and the *adversary-in-a-
worker-room verb*. The CS triage, the `/investigate` phase structure, and *when* to invoke the adversary are
**workload** — the user's skill, fed in on top. Don't bake the investigation pipeline into mrc (the original
crew mistake).

**Design tensions to carry in:**
1. **One-live-room invariant vs parallel tracking.** Rooms' hardened "a session is live in ≤1 room" (the
   leak fix) means an orchestrator can't *live-volley* N workers at once. Fine for this shape: **monitor**
   via thread.log / dashboard / catch-up panes + attend checkpoints **serially** (`/investigate` is
   autonomous between them, so serial loses nothing). A true simultaneous N-way would want a **trusted-cohort
   exemption** — an orchestrator + its own workers is one trust domain, so the leak the invariant guards is
   moot there. (This is the orchestrator's load-bearing difference from the *adversarial* rooms case, where
   the invariant must hold.)
2. **Spawn generalization.** `summon` launches Pierre with a fixed adversary prompt; a worker-spawn launches
   a session running a skill (`/investigate`) on a ticket-set, joined to the orchestrator — same daemon
   spawn / auth / channel mechanics (Phase 1b), different payload.
3. It's also the natural **>2-party live test** for the multiparty rooms work.

**Status (2026-06-11):** the investigations themselves run **vanilla** — manual `/investigate`, no rooms /
Pierre — so the CS work doesn't wait on infra. The orchestrator + mid-work-Pierre integration is
**deliberate design work, deferred**, and gated on the still-open rooms multiparty fixes + security calls
([`multiparty-adversarial-rooms.md`](./multiparty-adversarial-rooms.md), [`rooms-test-plan.md`](./rooms-test-plan.md)).

## The keeper from chasing it

The **channel-as-plugin** work: the room channel now ships as the `room` plugin in a baked-in local
marketplace (`mrc-marketplace/`), allowlisted via `/etc/claude-code/managed-settings.json`, so it loads
with **no dev-channel prompt** (`--channels plugin:room@mrc`). A win for rooms today, independent of
crew — and it pre-clears the boot gate for the eventual adversary-summon.

## Where the full detail lives

The complete original design (orchestrator / worker / oracle roles, phases, the worker-execution model,
boot gates, the spawn handshake) is preserved in **git history (commit `5a8a164`)** and in the
`orchestrator-crew-design` + `crew-worker-model` memory notes — in case the adversary-summon (which
reuses the same spawn / auth / channel mechanics) is ever built.
