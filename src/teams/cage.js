// Cage profiles (#49, 4b) — the reusable, named container cage, factored out of mrc.js's inline
// `cagedAdversary` bundle so caging ANY member is "apply profile X". A profile is a DEFAULT-DENY
// allow-list of dials; `applyCage(profile, ctx)` is the SINGLE source of truth that turns a profile +
// launch context into the cage's contribution to `docker run` (volumes/env), the tamper-proof HOST
// RECORD fields, and the SIDECAR seal spec. Both the (retiring) summon path and the member-launch path
// call it, so a caged member and a summoned Pierre are caged by the SAME code — that equivalence is the
// correctness anchor (the golden-diff test).
//
// THREE FLOORS (invariant across every profile, NEVER dials — see docs/dashboard-solo-workflow.md):
//  1. The profile is resolved on the HOST at launch and stamped into the host record; the daemon
//     classifies from that record, NEVER the wire. A caged container can't name/soften its own cage.
//  2. Launch-time only — no re-caging a live container.
//  3. Peer text is untrusted under every profile; a looser cage grants more RESOURCES, never more TRUST.
//
// THE BUG THIS CLOSES (Pierre, adversary-7177993db5): the old inline path recorded `adversary:false` for a
// caged MEMBER (cagedAdversary was false off the member branch), so the daemon classified a caged Pierre as
// NORMAL. Here, recordFields DERIVES the keystone from the resolved profile — a caging profile ALWAYS
// records `adversary:true` — so classifySession can never read the wrong bit for a caged member again.
import { createHash, createHmac } from 'node:crypto'

// #49 (4b, Pierre note-3 hardening): the egress client-auth token is DERIVED from MRC_ROOM_SECRET, not the
// secret itself. The caged container can READ this token (it's in its own HTTPS_PROXY env, and a proxy URL is
// the most exposed surface — logs, `ps`, error strings), so we never put the MASTER secret there: leaking the
// egress token (proxy-URL surface) must not leak the REGISTER secret (channel-auth surface). One-way, labeled.
export function deriveEgressToken(secret) {
  return createHmac('sha256', String(secret)).update('mrc-cage-egress-v1').digest('hex').slice(0, 32)
}

// The DUAL-AXIS readiness table (Pierre, adversary-7177993db5) — a single greppable source of truth. A
// profile ships only when BOTH axes are true:
//   ready.transport — a host-side seal (the SNI sidecar) can enforce its egress → it may ride a LIVE claude
//                     member; a `false` here means no transport can honor it (never applicable).
//   ready.classifier — the containment CLASSIFIER can represent it. `adversary` is `true` (the record
//                     keystone). A LOOSER tier is `false` and MUST stay so until classifySession →
//                     classifyContainment is 3-valued, else a caged-but-not-adversary member records
//                     adversary:false → classifies 'normal' → the trust gates go blind (the leak).
// The looser profiles are PHYSICALLY PRESENT (so the table is complete + applyCage's dials are exercisable in
// tests by constructing the object directly) but UN-MINTABLE in production: resolveCageProfile is the single
// mint chokepoint and refuses any profile not ready on both axes — so summon, the GUI, the parser, and any
// future caller are all covered BY CONSTRUCTION (applyCage always calls resolveCageProfile), not by guarding
// one door. Adding a profile later = set its two flags; the gate updates itself, nothing to allow-list thrice.
export const CAGE_PROFILES = {
  // The strict adversary cage — reproduces today's summoned-Pierre cage (the byte-for-byte anchor).
  adversary: {
    name: 'adversary',
    egress: 'pinned',        // SNI-pinned to the model API via the host sidecar (no direct net, no web)
    workspace: 'ro',         // /workspace read-only
    login: 'slot',           // dedicated -pierre-N slot volume (no clone, no codex, never the owner's config)
    hostBridges: false,      // clipboard + notify blocked
    roomsScope: 'own',       // only its own room dir, read-only
    mrcVisibility: 'readable', // TODAY's behavior (#55 masking is a separate, owner-gated change)
    identity: 'adversary',   // record keystone + MRC_ADVERSARY
    ready: { transport: true, classifier: true },
  },
  // FUTURE middle tier — present so the readiness table is complete and its dials are test-exercisable, but
  // classifier:false ⇒ UN-MINTABLE until classifyContainment is 3-valued. Do NOT flip classifier:true here
  // without shipping the 3-valued classifier + migrating the trust gates (room-daemon.js:313/223, summon gate).
  contained: {
    name: 'contained',
    egress: 'whitelist',     // the standard in-container firewall allowlist (no host seal beyond that)
    workspace: 'ro',
    login: 'own',            // its own persistent per-handle volume
    hostBridges: true,
    roomsScope: 'own',
    mrcVisibility: 'readable',
    identity: 'contained',   // NOT the adversary keystone — this is the tier that needs classifyContainment
    ready: { transport: true, classifier: false },
  },
}

// Resolve a profile NAME to its definition, or throw — the SINGLE mint chokepoint. An unknown profile, or one
// not ready on BOTH axes, cannot be instantiated by ANY caller (applyCage/assertCageAllowed both route here),
// so a cage the system can't fully honor can never come into existence — the illegal state is unrepresentable.
export function resolveCageProfile(name) {
  const p = CAGE_PROFILES[String(name)]
  if (!p) throw new Error(`unknown cage profile "${name}" — known: ${Object.keys(CAGE_PROFILES).join(', ') || '(none)'}`)
  if (!p.ready?.transport || !p.ready?.classifier) {
    throw new Error(`cage profile "${name}" is not shippable yet (transport:${!!p.ready?.transport} classifier:${!!p.ready?.classifier}) — it stays un-mintable until both axes are ready.`)
  }
  return p
}

// Parser gate (used by roster.js): may this backend carry this cage profile? A host-enforced profile (the
// egress sidecar) can only seal a LIVE claude member — a one-shot worker has no launcher to host the seal, so
// a `cage` on a non-claude backend is REJECTED at parse (not in execWorker), before it can launch web-open
// behind a "caged" label. Returns { ok } | { ok:false, error }.
export function assertCageAllowed(name, backend) {
  let p
  try { p = resolveCageProfile(name) } catch (e) { return { ok: false, error: String(e.message || e) } }
  // A pinned-egress profile needs the host SNI sidecar, which only a live claude member's launcher can host —
  // a one-shot worker has no launcher to run the seal, so it would launch un-sealed behind a "caged" label.
  if (p.egress === 'pinned' && String(backend).toLowerCase() !== 'claude') {
    return { ok: false, error: `cage "${name}" needs a host-enforced egress seal, which only a live claude member can carry — a ${backend} worker would launch un-sealed (reject at parse, not at exec).` }
  }
  return { ok: true }
}

// A short, stable freshness token for a launch — folds the nonce + secret so a resume's readiness-poll can
// tell THIS launch's portfile from a prior (orphaned) launch's stale one (they share the nonce).
export function sealFreshness(nonce, secret) {
  return createHash('sha256').update(`${nonce}\0${secret}`).digest('hex').slice(0, 16)
}

// The gated entry: resolve the profile NAME (the mint chokepoint — refuses un-mintable profiles), then
// translate its dials. EVERY production caller (launcher, summon, GUI) uses THIS, so a not-ready profile can
// never reach the translator. ctx: { repoPath, nonce (=memberSessionId, the sidecar reap key), secret
// (MRC_ROOM_SECRET), sealPort, loginVolume (launcher-allocated), summonedBy? }.
export function applyCage(profileName, ctx = {}) {
  return applyCageDials(resolveCageProfile(profileName), ctx)
}

// The dial→flag translator. Takes a profile OBJECT so tests can exercise the looser dials directly. But it is
// NOT ungated (Pierre, adversary-7177993db5): the module exports both this and CAGE_PROFILES, so
// `applyCageDials(CAGE_PROFILES.contained, ctx)` would otherwise be a SECOND mint door — producing
// launch-capable flags for an unready profile (recording adversary:false → classifies 'normal' → the silent
// uncage this whole module exists to kill), reachable from any importer, guarded only by a comment. So it
// REFUSES an unready profile unless the caller passes `{ allowUnready: true }` — a loud, greppable,
// unmistakably test-only declaration that launch code can never make by accident (`grep allowUnready src/`
// returns tests forever). applyCage() never passes it (the profile is already mint-gated), so it's
// belt-and-suspenders there; a direct caller must declare "I am a test" or get a throw. Second door → locked.
// Returns { volumes, envFlags, recordFields, sealSpec, hostBridges, labels, roomsScope, workspaceRo }.
export function applyCageDials(p, ctx = {}, { allowUnready = false } = {}) {
  if ((!p?.ready?.transport || !p?.ready?.classifier) && !allowUnready) {
    throw new Error(`applyCageDials refused an unready cage profile "${p?.name}" (transport:${!!p?.ready?.transport} classifier:${!!p?.ready?.classifier}) — production must call applyCage(name), which gates at the mint. Pass { allowUnready: true } ONLY from a test.`)
  }
  const { repoPath, nonce, secret, sealPort, loginVolume, summonedBy } = ctx
  const volumes = []
  const envFlags = []
  const labels = []

  // workspace dial
  if (p.workspace === 'ro') volumes.push('-v', `${repoPath}:/workspace:ro`)
  else if (p.workspace === 'rw') volumes.push('-v', `${repoPath}:/workspace`)
  // (territory-rw is a looser tier, not defined yet)

  // login dial — the dedicated slot volume (claude only; NEVER a codex volume, NEVER the owner's config).
  if (p.login === 'slot' && loginVolume) volumes.push('-v', `${loginVolume}:/home/coder/.claude`)

  // egress dial — pinned = the host SNI sidecar, client-authed. HTTPS_PROXY carries MRC_ROOM_SECRET creds so
  // a port-reuse can't hand egress to a wrong container (a strengthening over today's auth-less inline proxy;
  // both the member AND summon paths get it via applyCage, so they stay byte-identical to EACH OTHER).
  let sealSpec = null
  if (p.egress === 'pinned') {
    const token = deriveEgressToken(secret)   // NOT the master secret — see deriveEgressToken
    const proxyUrl = `http://mrc:${token}@host.docker.internal:${sealPort}`
    envFlags.push('-e', `HTTPS_PROXY=${proxyUrl}`, '-e', `https_proxy=${proxyUrl}`)
    envFlags.push('-e', 'MRC_ADVERSARY_FW=1')   // in-container firewall hardening (belt 2 to the host seal)
    // The launcher spawns/probes the seal with `token` (as its auth) and the `freshness` instance token.
    sealSpec = { needed: true, nonce, token, port: sealPort, freshness: sealFreshness(nonce, secret), allowlist: ['api.anthropic.com', 'platform.claude.com'] }
  }

  // identity dial — the record keystone + MRC_ADVERSARY. THE FIX: a caging profile ALWAYS records
  // adversary:true, derived from the profile, never from the old cagedAdversary boolean.
  const recordFields = {}
  if (p.identity === 'adversary') {
    envFlags.push('-e', 'MRC_ADVERSARY=1')
    recordFields.adversary = true
    if (summonedBy) recordFields.summonedBy = summonedBy
  }
  recordFields.cageProfile = p.name   // additive: the containment tier for classifyContainment (looser tiers ride this)

  // labels — dial-conditioned: the adversary-slot pool oracle reads mrc.adversary; the daemon reaps the seal
  // by matching mrc.seal=<nonce> ↔ the sidecar portfile. Only an adversary-identity profile is an adversary;
  // only a sealed (pinned-egress) profile carries a seal to reap.
  if (p.identity === 'adversary') labels.push('--label', 'mrc.adversary=1')
  if (sealSpec) labels.push('--label', `mrc.seal=${nonce}`)

  return {
    volumes, envFlags, recordFields, sealSpec, labels,
    hostBridges: { clipboard: p.hostBridges, notify: p.hostBridges },   // false → launcher does not start them
    roomsScope: p.roomsScope,
    workspaceRo: p.workspace === 'ro',
  }
}
