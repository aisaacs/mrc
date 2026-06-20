# Session metadata: a single source of truth

> Status: DESIGN (spec for build). Supersedes the piecemeal #25/#26/#28/#32 patches —
> built in, not bolted on. Security-gated pieces are flagged; reviewed, not slipped in.

## Why

`mrc` derives a session's properties — its name, its repo, whether it's a summoned
adversary — from several different places, and they drift. The conversation UUID is already
the stable key (`resolveSessionId`, src/sessions/manager.js), but the only thing hung off it
is a flat `session-names` (`uuid=name`) file; everything else is re-derived or env-snapshotted
at one moment and goes stale:

- the **name** has ~4 sources (the `session-names` file; the launch `label` snapshot; the
  daemon's in-memory label; the statusline reading the file) → #25 (a fresh `mrc pick`
  mislabeled "Pierre"), #26 (`mrc . --new` no live name), #28 (a `list_peers` row you can't
  map to your own tab).
- **adversary / containment** is launch-only env → on a `mrc pick` resume it's lost → #32
  (a resumed Pierre returned uncaged), and the live test showed the daemon ALSO declassifies it
  (firewall-caged but daemon-trusted — the split-brain).
- worst: once the cage derives from a host-only record, that record **fails OPEN** — delete it
  and a bare `mrc .` silently resumes the adversary uncaged, on the default path, no warning.

The fix: **one durable record per conversation UUID that every consumer reads, never
re-derives** — and that, by being always present, lets the resume path fail **closed** instead
of open.

## The records (split by trust domain)

A session's metadata splits across two records, because the security-critical field cannot live
where the sandboxed session can write it (`/workspace/.mrc` is the repo bind mount; the config
volume is mounted RW):

**Display record** — repo-local, travels with the repo, container-readable:
`<repo>/.mrc/session-meta/<uuid>.json`
```
{ uuid, name, repoName, repoPath, createdAt }
```
Source of truth for: the launch label, `listSessions`, the picker, the statusline, and
`generateName`'s "already named?" guard. **Retires `session-names`** (kept only as a generated
back-compat projection during the transition, then deleted).

**Security record** — host-only, never mounted into any container, tamper-proof:
`~/.local/share/mrc/session-meta/<uuid>.json`
```
{ uuid, repoPath, adversary, summonedBy, slot }
```
Source of truth for: the firewall cage decision, the daemon's adversary classification, and the
resume's slot/login reuse. `adversary` is derived from `summonedBy` **at launch** — never from a
session's name, persona, or behavior (containment is launch-derived).

Each *field* has exactly one authoritative location — that is the single source of truth. Two
files is not "two copies of one fact"; it is two different facts living in the two trust domains
their tamper-models require.

## Always-write (the keystone)

At launch, for any session with a resolvable UUID (rooms sessions — the default, and every
adversary is one), write BOTH records, **every launch**, with `adversary: false` for a normal
session. Writing the security record even for normals is the keystone: it makes **absence
anomalous**, which is what lets the resume guard fail CLOSED on a missing record instead of
assuming "normal." Written host-side in `mrc.js` after the UUID is resolved + the slot claimed
and before `runContainer`, so the record lands at t=0 keyed by the UUID the entrypoint pins via
`claude --session-id`. (A `--no-rooms`/`--json`/`--daemon` launch resolves no host-side UUID, so it
gets **no record by design** — and the resume guard fails-closed on a missing record ONLY under
roomsActive, so those non-rooms sessions keep auto-resuming. See Resume.)

## Readers — nothing re-derives

- **name / label / repo:** read the display record. `session-names` is retired; the statusline
  (container-side) reads the display record too (→ rebuild).
- **adversary classification, firewall side:** launch reads the security record →
  `MRC_ADVERSARY_FW=1` + `allowWeb=false` for an adversary (summon OR re-sandboxed resume).
- **adversary classification, daemon side — TWO signals**, because cage-intent and adversary-IDENTITY
  usually move together but MUST diverge for `--open-adversary-unsafe`:
  - `MRC_ADVERSARY_FW` = **cage-intent** → drives the firewall. Set for a re-sandboxed resume; UNSET for
    unsafe-open.
  - a separate **identity** bit → drives the daemon. The host sets `MRC_ADVERSARY` whenever the security
    record says `adversary:true` (INCLUDING unsafe-open — the container can't read the host-only record,
    so the host must forward it); the register frame forwards
    `adversary: process.env.MRC_ADVERSARY ? true : undefined` (beside the env-derived `web` bit,
    container/mrc-channel-server.js:263); the daemon re-flags on `if (f.summonedBy || f.adversary)`
    (src/proxies/room-daemon.js:680).

  So: **resume** → cage ON + identity ON (caged AND classified); **unsafe-open** → cage OFF + identity ON
  (network-uncaged but STILL daemon-classified, so it stays consent-protected in *others'* rooms,
  room-daemon.js:627); **normal** → both off. The #32 split-brain was the two diverging by ACCIDENT
  (identity lost on resume); unsafe-open is them diverging by INTENT — one signal can't say both, which is
  why there are two. Auto-pair (room-daemon.js:690) stays gated on `f.summonedBy`, so reclassifying never re-pairs.

## Resume behavior

- **Explicit `mrc pick` / `sessions resume`:** you chose it, so it resumes. A normal record →
  normal session, full egress, no prompt (identical to today). An `adversary:true` record →
  re-apply the cage + a "reopen this adversary?" confirm. `--open-adversary-unsafe` opens an
  adversary uncaged, deliberately (loud; belt 0 keeps the flag argv/`~/.mrcrc`-only, never the
  sandbox-writable repo `.mrcrc`).
- **Bare `mrc .` (silent auto-resume):** resumes the newest by file **mtime** (getSessions is
  mtime-primary, to track what `claude --continue` actually resumes). The guard is **SPLIT**:
  `adversary:true` newest → fail closed **unconditionally** (catches a recorded adversary even under
  `--no-rooms`); a **no-record** newest → fail closed **only under roomsActive**. Records are only
  written for rooms launches, so a `--no-rooms`/`--json`/`--daemon` session has no record AND can
  never be an adversary (a summon needs the daemon) — failing it closed would silently lose
  auto-resume for scripted/non-TTY callers for zero safety. Mode-split on fire: TTY → picker; non-TTY
  → start fresh. Fresh beats uncaged. **This is a picker, not a cage** — a normal session resumes normally.
- **Login reuse:** the security record stores the Pierre slot; a resume prefers it via
  `claimLowestFree(preferredStart=slot)` — still O_EXCL + mount-oracle, so a stale/slept claim
  can't lie and a stored slot that's taken just falls through to lowest-free (no #9 collision).
  Kills the per-resume re-OAuth and the slot-number climb.

## Migration / smoothing (legacy sessions)

Sessions created before this have no records. On first run after the upgrade:

- **Names migrate** for every legacy session (display record backfilled from `session-names`) —
  low-stakes, NOT a containment call, always safe, so the picker stays well-labeled.
- **The adversary flag is backfilled for NOBODY — no name/transcript heuristic.** A legacy session
  has no launch metadata, so it can't be *proven* normal, and classifying from name/transcript would
  (a) violate the launch-derived rule above and (b) FAIL OPEN: a heuristic that *misses* a real legacy
  adversary (a false-negative — e.g. a Pierre with a benign auto-generated name) would backfill it
  `adversary:false` and resume it UNCAGED. The false-negative is the only thing that can uncage a
  legacy Pierre, so the heuristic adds uncage-risk for zero benefit. Legacy sessions simply have **no
  security record** → they fail CLOSED (picker) once, on first bare-resume.
- **The human's one-time confirm is the ONLY thing that grants the normal stamp to a legacy session** —
  and it asks specifically *"are these all **NORMAL** (not red-team / adversary) sessions?"*, **showing
  each session's name + preview** so a stray Pierre is spottable. Never a blind "mark all mine": "mine"
  ≠ "normal" — a record-less Pierre IS yours but must NOT be stamped normal. So the normal stamp comes
  from exactly two non-heuristic sources: **launch** (every session going forward) or an **explicit,
  per-session-visible human vouch** (legacy). Zero persona-heuristic anywhere in the containment path.
  - *Limitation (documented, not fixable): the vouch's name+preview spot-check reads container-**writable**
    data — the display record and the `.jsonl` both live under `/workspace/.mrc`, RW by the sandbox (which
    is exactly why the security field is host-only) — so a legacy record-less adversary that self-named
    benignly could slip a bulk vouch. Bounded: pre-record legacy Pierres only (going forward every
    adversary has the tamper-proof security record and the vouch never sees them), and only if the human
    ACTIVELY vouches. The **fail-closed default** (picker each time, declassifies nobody) is the guarantee;
    the vouch is a best-effort human spot-check on forgeable legacy data, not an airtight gate.*

Net: a normal session resumes via `mrc pick` exactly as today — no cage, no prompt. The only
transition cost is a one-time picker on a bare `mrc .` for a legacy session not yet resumed, and
the migration + confirm largely erase even that.

## Transcript-coupled prune

The host-only record dir grows one file per session, so a prune will be added — and an unguarded
prune is the **exact `rm`** that reopens the silent fail-open. Transcript-coupling (drop a record
only when its `<repoPath>/.mrc/<uuid>.jsonl` is gone) is necessary but NOT sufficient: `repoPath` is
mutable, so moving/renaming the repo leaves the stored path empty → the prune reads "transcript gone"
and would drop an adversary record whose transcript actually lives at the new path → resume there →
UNCAGED. So: **never prune `adversary:true` records** (only ever a handful of Pierres; keeping them
forever costs nothing and means even a moved-repo resume still re-cages), prune only the unbounded
`adversary:false` bulk, and **bias to KEEP on ambiguity** (missing/unreadable path → keep, not drop).
The asymmetry is the safety: a stranded normal record = one wasted picker click; a dropped adversary
record = an uncage. (Confirm claude's transcript-filename stability across compaction — if it relocates
`<uuid>.jsonl` the same false-drop applies, which the never-prune-adversary rule already covers.)

## What this subsumes / what's separate

**Subsumes:** #25 (pick mislabel), #26 (`--new` live name), #28 (list_peers id + repo; a short
cross-ref id also surfaced in the statusline), #32 (adversary identity on resume + the
declassification + the fail-open floor), the login-reuse, and the tactical daemon-reflag + login-reuse
patches (built in).

**Separate tickets (NOT this block):** #27 (config-volume OAuth-token durability — partly helped
by slot reuse), #29 (catch-up `expected` count), #31 (persist pendingInvite), and the new
**normal-profile SNI/CDN egress bypass** (the non-adversary firewall allowlists CDN-hosted domains
by IP with port 53 open → SNI-fronting to a co-tenant; orthogonal to the cage, its own review).

## Deploy / rebuild

**Host-side (effective immediately, no rebuild):** the records, always-write, the launch readers,
the fail-closed guard, the migration, login-reuse, and the daemon `:680` clause (forward-
compatible — pre-rebuild the old channel-server sends no `adversary` bit, so `f.adversary` is
undefined and `f.summonedBy || undefined === f.summonedBy`, identical to today until the rebuild).

**One image rebuild** (`docker rmi mister-claude`) lands the container-side pieces together:
the statusline reading the record (retire `session-names`) + the channel-server forwarding the
**`adversary` IDENTITY bit** (← `MRC_ADVERSARY`, NOT the cage bit `MRC_ADVERSARY_FW` — forwarding the
cage bit would declassify an unsafe-open in the daemon, re-breaking the coworker-consent fix) + belt 2
(the firewall gates the 443 block behind `MRC_ADVERSARY_FW≠1`, init-firewall.sh) + #28's statusline id.

## Test plan

**Host-side smoke (no rebuild):** record round-trip + atomic write; migration (names backfilled for
ALL legacy sessions; NO adversary flag backfilled — every legacy session left no-record → fails closed
until human-vouched); the fail-closed guard (no-record newest → picker / fresh); login-reuse
(preferredStart reuses a free slot, falls through when taken).

**Post-rebuild live regression (mandatory — the mock daemon suite proves the `:680` logic but
NOT the wire):** summon → exit → `mrc pick`-resume a real adversary → `/proc/1/environ` shows
`MRC_ADVERSARY_FW=1` AND `mrc rooms status` now shows it adversary-flagged; the fail-open check
(move a record aside, bare `mrc .`, confirm it now fails CLOSED to the picker, not a silent
uncaged resume); and a normal `mrc pick` resume is unchanged (no cage, no prompt).

## Security decisions (human-gated — reviewed, not slipped in)

- **Fail-closed** changes the bare `mrc .` default path (picker on an unclassifiable newest).
  Decided: fail-safe over silent-resume; it is a picker, never a cage on a normal session.
- **The migration** backfills names only; a legacy session's normal stamp comes ONLY from an explicit
  human vouch — no name/transcript heuristic (its false-negative would uncage a missed legacy adversary,
  and it violates the launch-derived rule). Legacy = fail-closed until vouched.
- **Two bits, not one:** cage-intent (`MRC_ADVERSARY_FW`, firewall) and adversary-identity
  (`MRC_ADVERSARY`, daemon) couple for a resume but DECOUPLE for `--open-adversary-unsafe` (uncaged yet
  still daemon-classified) — a local uncage must not silently strip a coworker room's consent gate.
- **belt 2** (the firewall edit) and **`--open-adversary-unsafe`** (the cage opt-out) are the
  gated diffs to review at build time.

## Implementation status (2026-06-18)

**Built host-side + tested** (no rebuild; keystone + adversary path LIVE-validated on the author's host):
- **Records + always-write** (mrc.js rooms block; src/session-record.js): a security record per session,
  `adversary:false` for normals, never-downgrade-on-resume, stores `repoPath` + `slot`.
- **Two-bit env** (mrc.js): `MRC_ADVERSARY_FW` (cage→firewall) + `MRC_ADVERSARY` (identity→daemon), decoupled.
- **Login-reuse** (src/docker.js `claimLowestFree(preferredStart)` + `nextAdversarySlot`; mrc.js): a resume
  prefers its stored slot through the same race-free gate (used-check + O_EXCL), falls through if taken.
- **Trust-half** (src/proxies/room-daemon.js:680 `f.summonedBy || f.adversary`; container/mrc-channel-server.js
  register `adversary` bit): closes the #32 split-brain. Forward-compatible (inert until the rebuild forwards
  the bit). Daemon suite **74/0** incl. the `[24]` regression (identity-bit register → flagged → invite refused).
- **#25 + belt 0** (earlier): picker labels adversaries + the silent `mrc .` guard; the adversary confirm is
  rendered INLINE in the picker TUI (single keypress); `confirmIfAdversary` guards the non-picker
  `sessions resume`. belt 0 strips egress/containment flags+envs from the repo `.mrcrc`.

**DONE + SHIPPED (2026-06-19):** the **guard-split** (3-state `classifySession`), the **migration vouch**, and the
**transcript-coupled prune** all built + committed (cc81a27); **belt 2** (firewall gates 443 behind
`MRC_ADVERSARY_FW`) + the **statusline-reads-record** built + committed; **image rebuilt**. Post-rebuild **LIVE
regression PASSED**: a fresh caged Pierre logged `arbitrary 443 (1.1.1.1) blocked — belt 2 / cage holds` on the
WIRE + the 4 substrate checks green (`MRC_ADVERSARY_FW=1` + `MRC_ADVERSARY=1`, no `ALLOW_WEB`; example.com
blocked; anthropic reachable); the host-side guard (record-move → picker; the "all NORMAL?" vouch) was
live-validated earlier.

**→ But that live run SPAWNED a full adversary-cage red-team that found the containment broadly holey (8
findings) — see `docs/adversary-containment-hardening.md`.** Note the **trust-half above** (room-daemon.js:680
classifying from the register *frame*) is **SUPERSEDED there by B/#39**: the daemon must read THIS host-only
record (via `classifySession`), not the forgeable wire bit — the record was the authority all along; the daemon
was wired to the frame. The two-bit env + the firewall-cage half stand.

**Open verify (carried):** claude transcript-filename stability across compaction (sets prune conservatism).
