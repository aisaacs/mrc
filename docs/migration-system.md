# mrc migration system

A versioned, guarded, **explicit** system for changing how mrc stores conversation memory on disk — designed so a teammate can run it **unsupervised without foot-gunning themselves**. The first migration (`#001`) relocates a repo's `.mrc` memory out of the repo into the host store; future migrations (layout changes, re-keying) plug into the same framework.

> **Design provenance:** this design was red-teamed to convergence with a summoned adversary (Pierre). The verdict: *"honest infrastructure that fails loud, heals what it can, and tells the truth about what it can't."* The alternative (a silent, per-repo, boolean-gated, reversible, cheap-verify migration) would have "wrapped the surviving split in ceremony and handed a teammate a rollback that eats history."

## The problem it fixes

Before this system, the first store-capable `mrc <repo>` launch **silently** migrated `repo/.mrc` → the host store. Silent-on-success meant a user couldn't tell if/when it happened — and if the same repo was later opened on an **older image** (or another machine), that legacy launch wrote to `repo/.mrc` while store-mode read the slice → a **dual-store split** ("my recent history is gone"). Non-destructive migration made it recoverable, but the trigger (silent auto-migrate) and the failure mode (two stores, different readers) were the foot-gun.

## The honest guarantee (what it does and does NOT do)

- **Removes the accidental trigger** — migration is now explicit (`mrc migrate`), never a silent side-effect of a launch.
- **Detects + heals** splits that still occur — losslessly when safe, surfaced-and-non-destructive when not.
- **Does NOT prevent** all splits. If someone runs an *old* image (or another machine) on a migrated repo, it will write to `repo/.mrc` — an old binary ignores any marker a new one writes; unpreventable by construction.
- Teammate-facing truth: **safe on the current image; auto-caught and healed otherwise; never a silent misread or a silent drop.**
- **Non-destructive is sacred:** `repo/.mrc` is never moved or deleted — always a copy, always a fallback.

## User-facing UX

- `mrc migrate [repo]` — run the pending migration(s) for a repo. Preflight → preview → confirm → apply → **self-test** → report. Per-repo mental model.
- `mrc migrate status [repo]` — *"store ACTIVE — `repo/.mrc` retained as fallback"* / *"NOT migrated (legacy)"* / pending. **Never** renders past-tense "migrated/moved" (which would imply the old store is gone — it isn't).
- `mrc migrate detach [repo]` — opt back out of the store (see **Detach**, below). Not called "rollback" — see why.
- **Unmigrated repos just work, loudly:** `mrc <repo>` on an unmigrated repo runs **legacy** with a **big warning** (`⚠ this project's memory is NOT relocated — run 'mrc migrate' when ready`). Not ready = stay legacy until you are. No silent auto-migrate.

## Core concepts

- **Slice** — the host-store directory that holds a set of conversations (`~/.local/share/mrc/store/<id>/`). A repo **resolves** to a slice via its `.mrc/.mrc-id` (or, for a team member, its member key). **N repos can resolve to ONE slice** — a `cp -r`'d project carries the same `.mrc-id` ("memory travels on copy"), and same-`(org,handle)` members share a slice.
- **Migration** — a numbered, tracked, idempotent change to the store, with a `layoutLevel` (the on-disk layout version it produces). `#001` = relocate `.mrc` → slice (layout-neutral, level 0).
- **Migration identity is PER-SLICE, not per-repo.** The migration history is a property of the slice (the data), which has exactly one owner — so it can't be double-run or stamped "done" while a sharer's data was never copied. A repo is just a front door. (The *command* is per-repo; the *identity* is per-slice.)

## Architecture

### 1. Migration modules
Each migration is a module:
```
{ id, description, layoutLevel,
  isPending(slice), preflight(ctx) -> {safe, reasons[]}, preview(ctx),
  up(ctx), down: null | fn, verify(ctx) -> {pass, checks[]} }
```
- `layoutLevel` — the slice-layout version `up()` produces. `#001` → 0.
- **`down: null` is a legal, first-class state** — an irreversible migration declares it honestly (see **Detach**).

### 2. Source of truth: the activation gate is HOST-ONLY (a security record)
The record of which migrations ran + the slice's `layoutLevel` **decides store-vs-legacy and whether an image may safely read the slice's layout** — it is a *security gate*. So it lives **host-only**, in `~/.local/share/mrc/migration-meta/<sliceId>/`, exactly like the adversary-containment `session-meta` store — **never inside the `/mrc` mount the sandbox can write to** (a container-writable gate lets a hostile/injected session forge or delete it → self-DoS to legacy, or a sibling-slice DoS).

This is a deliberate **trilemma** — {tamper-proof, desync-free, rebuildable-from-data}, pick two. An in-slice marker is desync-free + rebuildable but *not* tamper-proof (container-writable). Host-only is **tamper-proof** but is a sidecar that can desync from the slice data and is **not** rebuildable from the (attacker-forgeable) slice. A security gate must take tamper-proof.

**The cost, stated out loud:** `migration-meta`'s durability is load-bearing — **the layoutLevel gate is not recoverable from slice data by construction; back up `~/.local/share/mrc/migration-meta`.** Lose it and a migrated slice reads "not migrated" until a human re-runs `mrc migrate` (idempotent — `migrateToStore`'s in-slice sentinel skips the re-copy — so it recovers with **no misread**). Fail direction: a corrupt/unreadable record fails **closed** (deny store-mode + surface), never level-0-over-level-N.

### 3. Activation is a VERSION COMPARISON, not a boolean
Store-mode activates for a repo iff:
- its slice exists and is marked migrated, **AND**
- **`imageCapability ≥ slice.layoutLevel`** — the running image can read the layout the slice is at.

On a shortfall (image too old for the slice's layout) → **fail to legacy + a loud stranded-notice**, *never a misread.* A layout-changing migration **bumps** the image capability (a container-setup constant → image rebuild) and **refuses to run until you've rebuilt** — so data can never advance past the image that reads it. Built day one; `#001` (level 0) exercises the trivial case.

### 4. The runner
- **`up`:**
  1. **Preflight — refuse-until-safe.** No active writer to *either* store: the **union** of (a) repo-labeled containers (`mrc=1` + `mrc.repo=<repoPath>` — legacy *or* store, writing `repo/.mrc`) and (b) slice-source containers (store, incl. a `cp`'d sibling on another path). Refuse if **either** is live. A layout migration also refuses unless the image already carries its target capability.
  2. **Shared-slice check (policy = detect + warn + confirm).** If other front-doors resolve the same slice, **show them and require explicit confirmation** before mutating shared data.
  3. **Preview** (N conversations, size) → confirm.
  4. Hold a **per-slice lock** across `up → verify → record`.
  5. `up()` (idempotent).
  6. **Verify** (below).
  7. Stamp the in-slice marker.
- **`detach`** (opt out) — for an irreversible migration: **refuse if store-born content exists** (it lives only in the slice; detaching would strand it), otherwise **preserve the slice untouched + loud notice** ("your store-era conversations live in `<slice>`, not `repo/.mrc`; legacy won't show them; re-opt-in to see them"). **Never** copies slice → `repo/.mrc` (that would un-do the relocation and re-open the hostile-clone surface). It is **not** "rollback" — calling an irreversible, potentially-stranding operation "rollback" is the foot-gun in the word itself.

### 5. verify() is byte-honest — no self-certifying
A cheap "sentinel present + file-count matches" check is exactly the *green that hides a live break*. So `#001`'s verify is **honest-and-slow**:
- **sha256** every legacy file against its slice copy — identical or **FAIL**.
- On a shared slice, additionally **flag any `repo/.mrc` content that is NOT in the slice** (a divergent sharer: another copy's own conversations, or same-id-different-bytes that a copy-if-absent skipped) → surface *"your `repo/.mrc` has content not in the shared store — another working copy may share it,"* **never a silent pass.**

### 6. The reconciler (heals a split — a separate mechanism from migration)
On a store launch, per conversation, compare the slice vs the `repo/.mrc` fallback:
- **Prefix** (one file is a clean byte-prefix of the other — continued in one store only, the common case): take the **longer**. Lossless.
- **Diverged** (neither is a prefix — both got unique turns after a split): **promote the fork to a new, pickable session** (`<newuuid>.jsonl` + a `session-names` entry, e.g. *"…(legacy fork 07-07)"*) so **both** appear in `mrc pick` and the human chooses by reading them. **Never** a silent drop, **never** an auto-merge of two realities, **never** a `.conflict` dead-letter file (invisible to the picker = preservation theater).

### 7. Safety nets
- **Format-drift canary** (test suite): continue a known session under the **real** Claude Code in the image and assert the byte-prefix property at **rebuild** — so a future CC "compact-in-place" is caught at `docker rmi`/rebuild, not in a user's live reconcile. (Append-only is CC's on-disk behavior, not our contract — this pins it.)
- **Non-destructive** — `repo/.mrc` is never touched by migration.

## The doors (RED-before / GREEN-after — a green unit suite is necessary, never sufficient)

Data-integrity boundaries must be proven on built doors, not self-certified:
1. **Divergent-sharer fails verify** — two front-doors → one slice → repoB divergent content → `verify()` FAILS (does not pass).
2. **cp'd-sibling blocks preflight** — a sibling repo's live container (sharing the slice) blocks a migrate of that slice.
3. **layout-shortfall fires the notice** — an image below the slice's `layoutLevel` → fail-to-legacy + stranded-notice (not just the image-not-capable case).
4. **format-drift canary green at rebuild** — prefix-losslessness holds against the real CC.
5. Reconciler: prefix→longer (lossless) and diverged→pickable-fork (both reachable), each RED-before/GREEN-after.

## First build

The framework (module contract, in-slice markers, capability-as-version activation, the runner with union-preflight + shared-slice-warn + byte-verify + `detach`, the reconciler, the format-drift canary) **plus** migration `#001` — refactoring today's implicit auto-migrate into the explicit `mrc migrate`, and **removing the silent auto-migrate from the launch path** (unmigrated → legacy + warning).
