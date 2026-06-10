# Crew — multi-session orchestration (PARKED / superseded)

> **Status: PARKED, superseded (2026-06).** This explored a generic multi-session *orchestration*
> capability — an orchestrator driving worker / oracle sessions, fan-out execution. It was deliberately
> **not built**.
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
