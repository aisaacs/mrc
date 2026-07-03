# Team-First Mister Claude — Overview

_Synthesis of the team-first direction, the two-branch convergence, and the invariants that must
never regress. Consolidates the earlier working docs (strategy brief, mechanism comparison, merge
plan/playbook/audit) now that the convergence has landed on `integration`. High-level only — the
granular merge steps are done; this is the durable map._

---

## North star

Mister Claude becomes a **team-first, web-steered orchestrator.** You declare (or spin up) a crew of
sandboxed agents; they work one problem together through host-mediated rooms; you are **`@user`**,
steering from a web dashboard (or phone) and committing the work. Multi-agent beats one agent only
because each member's **independence** — separate context, separate mandate — is *real and defended*,
not cosmetic. The goal is **trustworthy, low-touch, async progress**: set direction, step away, come
back to work you can trust.

## The two halves (both must be true)

Both descend from **negotiation rooms** (a 2-party host-mediated relay + daemon) and generalize it in
opposite directions. The team-first product is the union:

- **Breadth — the substrate (`feature/agent-teams`, Alessandro).** Declared roster, federated
  team/leads rooms, `@mention` routing as floor-control, org isolation, the web dashboard, Telegram,
  the `@user` inbox. Live-proven for all-Claude teams. **Adopt, don't rebuild.**
- **Depth — the trust + plumbing layer (`pierre-plus-more`).** The hardened container **cage**
  (SNI-pinning egress proxy, launch-time firewall/volumes), **no-prompt channel loading**,
  dedicated non-cloned login slots, **host-record (not wire) containment classification**, and the
  **independence / reflex-summon** discipline (Pierre). Live-gated on the wire.

The one-line thesis the reality-check produced: **teams is "single-power-user solid,
product-fragile."** It works for one expert babysitting an all-Claude team in terminals he can see;
everything between that and a hands-off/web product lives in the trust/robustness/plumbing layer —
exactly the layer the depth branch matured. Ownership split: **Alessandro owns the substrate**
(coordination / routing / UI); **we own the trust + plumbing layer** that turns "works for one expert"
into "works as a product."

## Where it stands

The depth work has been **re-expressed onto the substrate** on the `integration` branch — not a file
copy, but a feature-by-feature port onto teams' `engine` (teams' N-party engine supersedes pierre's
old `p.members[]` model). The cage, host-record classification, register secrets, stable relay port,
dead-room GC, naming fixes, and the D2 caged-resume hardening are all in and **wire-verified**
(see `docs/task-board.md` for the live-gate matrix). `integration → main` is the merge that makes
this the trunk.

## Invariants that must never regress

1. **One disjoint `~/.claude` per agent; never clone a login.** Both branches independently landed
   here. Cloning a login shares a refresh token → one agent refreshing logs another out. Teams gets
   this free from deterministic per-handle volumes; pierre earned it by removing `cloneVolume` and
   hardening a race-safe slot pool. This is the single OAuth rule to carry across everything.
2. **Containment is LAUNCH-derived and classified from the tamper-proof HOST RECORD, never the wire.**
   `classifySession` reads `~/.local/share/mrc/session-meta/<uuid>.json` (host-only, never mounted),
   not the forgeable register frame. **This is the gate that fails _silently_** — "rooms work in the
   demo" ≠ "containment is wired." A green dashboard while containment has quietly downgraded to
   trusting the wire is the failure mode to fear. Gate it hardest, always.
3. **The cage is launch-time.** Firewall, SNI proxy, and ro/territorial volumes are fixed at
   `docker run` — a live container cannot be re-caged. Any "downgrade a live session to adversary"
   idea is a daemon-trust-view change, not a container change (see the `#64` sentinel tripwire).
4. **Peer text is untrusted data; only `[Human directive]` / `[Human reply]` is authoritative.**
   `defangTrustMarkers` neutralizes forged trust-marker look-alikes at every injection site. A
   teammate — even the architect/lead — is untrusted; a member follows its lead because that's its
   *role*, not because the word is law.

## Known pre-existing hazard to keep caged

The non-Claude **task-worker path** runs with `ALLOW_WEB=1` + untrusted peer text in the prompt and
**no SNI proxy** — a real web-exfil surface that exists independent of the merge. It must never ship
un-caged: route the worker `-p` / `codex exec` egress through `HTTPS_PROXY` + SNI before re-enabling
web. (Tracked as the worker-cage task.)

## Forward direction

The next epic is **the dashboard-first solo workflow** (`docs/dashboard-solo-workflow.md`): work in a
plain solo session inside the dashboard, and pull in Pierre (caged) and cross-repo peers on demand.
Because the engine already solves multi-room correctly, this **retires the legacy pairings path**
rather than fixing it — the load-bearing work is porting the launch-time cage onto the member-launch
path, red-teamed against Pierre's pre-registered audit before it ships.

## Open questions for Alessandro (the real convergence conversation)

- Does his e2e usage exercise the **non-Claude task-workers**, or is it all-Claude live members?
  (Decides whether the worker path is proven or the biggest unknown.)
- Is **hands-off / web spin-up** the goal — and did he know the depth branch already solved the
  per-member channel-accept prompt (no-prompt plugin load)?
- How to **converge the branches** long-term — rebase, or keep cherry-picking plumbing onto teams?
- Confirm **teams' `engine` is the canonical N-party substrate** (so pierre's `p.members[]` model
  stays correctly discarded — almost certainly yes; it's his substrate, in active use).
