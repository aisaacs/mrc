// Shared, dependency-light derivation of a member's stable conversation/session id.
//
// `memberSessionId(org, handle)` = a v5-shaped UUID from `${org}\u0000${handle}`. It is used two ways
// that MUST agree byte-for-byte:
//   1. the launcher (src/commands/team.js memberLaunch) pins each member's Claude `--session-id` to it,
//      so a member always resumes its OWN conversation even though all members share /workspace/.mrc;
//   2. the room daemon precomputes `memberSessionId(org, handle) -> member` for every member at
//      defineOrg, so when a member's channel registers (carrying its sessionId) the daemon binds it to
//      the RIGHT org even when two orgs share a handle — the containment fix, host-side, no container
//      change needed.
//
// The separator is an explicit NUL (\u0000), matching the launcher's historical value byte-for-byte so
// the ids are identical (a name can't contain a NUL, so org/handle can't be spoofed by concatenation).
// Written as the \u0000 escape, not a raw NUL byte, so this file stays plain text. NOTE: collision is
// possible only if two orgs share BOTH org name AND handle (identical sha1) — the same exposure as the
// slug(org)-based room ids; accepted, not solved here.
import { createHash } from 'node:crypto'

export function memberSessionId(org, handle) {
  const h = createHash('sha1').update(`${org}\u0000${handle}`).digest('hex')
  const y = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)   // RFC-4122 variant nibble
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${y}${h.slice(17, 20)}-${h.slice(20, 32)}`
}
