// Team room engine — the generalized relay brain. Where the original daemon had a strictly
// 2-party `pairing` ({a,b}) with "the other side" routing, this models a room as a SET of members
// and routes by @mention (directed delivery). It is transport-agnostic: all I/O is injected
// (send/append/notify/now), so the routing, multi-room membership, and @user inbox are unit-testable
// without sockets or a filesystem.
//
// ORG ISOLATION (containment): one daemon hosts MANY orgs, and member handles (`first/backend`) are
// only unique WITHIN an org — two orgs can each have `roland/claude`. So the engine keys members by
// org in a NESTED map (`members: org -> handle -> member`) and every lookup is org-scoped. A room is
// org-tagged (`room.org`) and its memberMap is keyed by bare handle (unambiguous within one org).
// `bySession` maps a live session to its {org, handle}. This makes cross-org delivery and @user-inbox
// bleed structurally impossible: a member only ever resolves rooms/teammates inside its own org.
//
// Concepts:
//   member  — { handle, first, role, team, lead, backend, tier, org, sessionId|null }
//             handle = "first/backend" (unique per ORG). tier 'live' binds a session; 'worker'
//             members have no persistent session — a directed mention enqueues an invocation.
//   room    — { roomId, kind, team, org, members:Map<handle,{role,lead}>, state, turn, held, … }
//             kind: 'team' | 'leads' | 'consult' (legacy 2-party) | 'dm'.
//   routing — extract @mentions from the text; resolve each to a room member by handle, then first
//             name, then role (each must be unambiguous within the room). @user routes to the human
//             inbox + a notify. No mention in a 2-member room ⇒ the other member (consult back-compat);
//             no mention in a 3+-member room ⇒ nothing is delivered (directed-only is the floor control).
import { extractMentions, parseMention } from './names.js'
import { defangTrustMarkers, snippetForTrustedLine } from './trust.js'

const norm = (s) => String(s || '').trim()
const lc = (s) => String(s).toLowerCase()

// Accent-fold for resolution: strip diacritics so a user can type @come or @cote and still reach
// @Côme — handy on keyboards without dead keys. Display names stay accented; only matching folds.
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

// Light greeting/connector/vocative words allowed to PRECEDE or SEPARATE leading @mentions, so a
// natural opener still addresses ("Hey @architect, …", "ok @engineer ship it", "Quick one @critic: …",
// "a question for @user").
// KNOWN, ACCEPTED residual (architect's call): the bare particles a/to/for also let a statement ABOUT
// someone read as an address ("a @critic is needed", "to @roland this looks fine"). Kept on purpose —
// the asymmetry favors @user: those same particles keep "a question for @user" REACHING the human, and
// not-missing-@user-questions is an explicit priority, so we over-deliver rather than risk dropping a
// real question. A spurious teammate ping is mild noise; the costly path (a media worker firing) is
// separately backstopped by media.js's generation-intent gate. Revisit only if noisy in practice.
const ADDR_CONNECTORS = new Set([
  'and', 'also', 'cc', 're', 'plus', 'hey', 'hi', 'hello', 'yo', 'ok', 'okay', 'so', 'thanks', 'thx',
  'thank', 'you', 'quick', 'one', 'please', 'pls', 'morning', 'afternoon', 'evening', 'team', 'folks',
  'everyone', 'all', 'a', 'question', 'for', 'to',
])

// The ADDRESSEES of a message are the @mentions in its OPENING run — the leading stretch of
// @mentions and light greeting/connector words before the first SUBSTANTIVE word. @mentions after
// that (deep in the body) are REFERENCES, not addressing ("@engineer kickoff — scope locked by
// @user, build it" addresses @engineer; @user is a reference, no inbox ping, no worker fire). This
// is the floor control behind #10: a buried handle never spuriously delivers or invokes a paid
// worker, while a greeting before the @mention still addresses. Returns a Set of mention tokens.
// Applies identically to @user and teammates (one unified rule). The 2-member consult fallback (no
// opening addressee → the other member) lives in resolveTargets.
function openingAddressees(text) {
  const out = new Set()
  let s = String(text || '').replace(/^[\s,&:;—–-]+/, '')
  // token = a word (optionally @-prefixed) plus any trailing separators (space, comma, colon, dash…)
  const tokenRe = /^(@?[\p{L}\p{N}][\p{L}\p{N}._/-]*)([\s,&:;—–-]*)/u
  let m
  while ((m = s.match(tokenRe))) {
    const word = m[1]
    if (word.startsWith('@')) {
      const clean = word.slice(1).toLowerCase().replace(/[._-]+$/, '')
      if (clean) out.add(clean)
    } else if (!ADDR_CONNECTORS.has(word.toLowerCase())) {
      break   // first substantive (non-greeting, non-mention) word — the addressee run ends here
    }
    s = s.slice(m[0].length)
  }
  return out
}

export function createRoomEngine({ send, append, notify, onInbox, now = () => Date.now(), turnCap = 200 } = {}) {
  const members = new Map()   // orgId -> Map<handleLC, member def>   (sessionId bound when live)
  const rooms = new Map()     // roomId -> room state (org-tagged)
  const bySession = new Map() // sessionId -> { org, handle }  (reverse index for live members)
  const userInbox = []        // @user messages awaiting the human; each carries its `org` (no bleed)
  let inboxSeq = 0            // monotonic STABLE id per inbox item — answer/dismiss/reopen + any external
                             // surface (Telegram #12) address items by this, never by array index (which
                             // shifts as items resolve, so a stale reply could hit the wrong item)
  const workerQueue = []      // directed mentions to worker (non-live) members; each carries its `org`
  const orgs = new Map()      // orgId -> { org, repo }

  // `meta` (optional) carries the daemon's TRUSTED per-message qid/reqid (#18) so the structured
  // transcript can anchor jumps by an authored field, never by re-parsing the line text.
  const _append = (roomId, line, meta) => { try { append?.(roomId, line, meta) } catch {} }
  const _notify = (msg) => { try { notify?.(msg) } catch {} }
  // Fire-and-forget inbox lifecycle hook (new / resolved / reopened) — lets a transport like Telegram
  // (#12) push a question, edit it on resolve, and restore it on reopen. Never awaited; never throws.
  const _inbox = (kind, item) => { try { onInbox?.({ kind, item }) } catch {} }
  const ts = () => new Date(now()).toISOString()

  // --- org-scoped member access -------------------------------------------
  function mem(org, handle) { return members.get(String(org))?.get(lc(handle)) || null }
  // Convenience for non-routing callers (dashboard workerlog/removemember display): look up a handle,
  // optionally within a known org; without org, return the first match across orgs. Routing NEVER uses
  // the cross-org fallback — it always passes an explicit org (room.org / sender org).
  function memberByHandle(handle, org) {
    if (org != null) return mem(org, handle)
    for (const omap of members.values()) { const m = omap.get(lc(handle)); if (m) return m }
    return null
  }
  function senderOf(sessionId) { return bySession.get(sessionId) || null }   // { org, handle } | null
  function nameOf(org, handle) { const m = mem(org, handle); return m ? `@${m.first}` : (handle === '@user' ? '@user' : handle) }
  function roleOf(org, handle, room) { const e = room?.members.get(lc(handle)); return e?.role || mem(org, handle)?.role || '' }
  const online = (org, handle) => { const m = mem(org, handle); return !!(m && m.sessionId && m.tier === 'live') }

  // Register/refresh an org's roster: its members and its rooms. Idempotent — re-defining updates
  // membership without dropping live bindings or in-flight room state (turn/held are preserved).
  // Crucially org-scoped: defining org B never touches org A's members (the old shared-key clobber).
  function defineOrg({ org, repo, members: mem_ = [], rooms: rms = [] }) {
    const orgId = String(org)
    orgs.set(orgId, { org: orgId, repo: repo || null })
    if (!members.has(orgId)) members.set(orgId, new Map())
    const omap = members.get(orgId)
    // Redefining an org REPLACES it: prune members/rooms of THIS org that are gone from the new def,
    // so re-running `mrc team up` (or a daemon reload) never accumulates ghosts.
    const keepHandles = new Set(mem_.map((m) => lc(m.handle)))
    const keepRooms = new Set(rms.map((r) => r.roomId))
    for (const [h, m] of [...omap]) {
      if (!keepHandles.has(h)) { if (m.sessionId) bySession.delete(m.sessionId); omap.delete(h) }
    }
    for (const [id, r] of [...rooms]) if (r.org === orgId && !keepRooms.has(id)) rooms.delete(id)
    for (const m of mem_) {
      const h = lc(m.handle)
      const prev = omap.get(h)
      omap.set(h, {
        handle: m.handle, first: m.first, role: m.role, team: m.team, lead: !!m.lead,
        backend: m.backend, tier: m.tier || (m.backend === 'claude' ? 'live' : 'worker'),
        territory: m.territory, mount: m.mount, org: orgId, repo: repo || null,
        sessionId: prev?.sessionId ?? null,   // keep an existing live binding across a re-define
      })
    }
    for (const r of rms) {
      const existing = rooms.get(r.roomId)
      const memberMap = new Map()
      for (const h of r.members) {
        if (h === '@user') { memberMap.set('@user', { role: 'human', lead: false }); continue }
        const def = mem(orgId, h)
        memberMap.set(lc(h), { role: def?.role || '', lead: !!def?.lead })
      }
      if (existing) { existing.members = memberMap; existing.kind = r.kind; existing.team = r.team; existing.org = orgId }
      else rooms.set(r.roomId, freshRoom(r.roomId, r.kind, r.team, orgId, memberMap))
    }
    return { orgId, rooms: rms.map((r) => r.roomId) }
  }

  function freshRoom(roomId, kind, team, orgId, memberMap) {
    return {
      roomId, kind: kind || 'team', team: team || null, org: orgId || null,
      members: memberMap || new Map(),
      state: 'Running', pauseReason: null, turn: 0, turnCap, lastActivityAt: now(),
      held: [], autoCatchup: true, pendingCatchup: null,
    }
  }

  // Bind a live session to its member. The daemon resolves WHICH org's member is connecting via its
  // memberSessionId index (the sessionId is org-specific), then calls this with the resolved org.
  // Returns the rooms the member belongs to, for connect notices.
  function bindSession(org, handle, sessionId) {
    const orgId = String(org)
    const h = lc(handle)
    const m = mem(orgId, h)
    if (!m) return { ok: false, error: `unknown member ${handle} in org ${orgId}` }
    m.sessionId = sessionId
    bySession.set(sessionId, { org: orgId, handle: h })
    const inRooms = [...rooms.values()].filter((r) => r.org === orgId && r.members.has(h)).map((r) => r.roomId)
    return { ok: true, handle: h, org: orgId, rooms: inRooms }
  }
  function unbindSession(sessionId) {
    const s = bySession.get(sessionId)
    if (!s) return
    bySession.delete(sessionId)
    const m = mem(s.org, s.handle)
    if (m && m.sessionId === sessionId) m.sessionId = null
  }

  function roomsForSender(s) {
    if (!s) return []
    return [...rooms.values()].filter((r) => r.org === s.org && r.members.has(lc(s.handle)))
  }
  function roomsForSession(sessionId) { return roomsForSender(senderOf(sessionId)) }
  // Optional org arg; without it, falls back to the unique-across-orgs match (single-org/test use).
  function roomsForHandle(handle, org) {
    const s = org != null ? { org, handle } : senderFromHandle(handle)
    return roomsForSender(s)
  }

  // Resolve one @mention token to a member handle WITHIN a room (room is org-scoped, so the bare
  // handle it returns is unambiguous). Most-specific first: exact handle (first/backend) → unique
  // first-name (accent-insensitive) → unique role-holder. Returns handle | null.
  function resolveInRoom(room, token) {
    const { first, backend } = parseMention(token) || {}
    if (!first) return null
    const present = [...room.members.keys()].filter((k) => k !== '@user')
    if (backend) {
      const exact = `${first}/${backend}`
      if (room.members.has(exact)) return exact
    }
    const byFirst = present.filter((k) => fold(mem(room.org, k)?.first) === fold(first))
    if (byFirst.length === 1) return byFirst[0]
    if (byFirst.length > 1) return null   // ambiguous first name in this room
    const byRole = present.filter((k) => (room.members.get(k)?.role || '').toLowerCase() === first)
    if (byRole.length === 1) return byRole[0]
    return null
  }

  // Decide who a message is directed to. Returns { targets:[handles], toUser, unresolved:[tokens] }.
  // Only the message's OPENING addressees count (unified for @user AND teammates) — a buried @mention
  // is a reference, so it neither delivers nor reports as unresolved nor fires a paid worker (#10).
  function resolveTargets(room, fromHandle, text) {
    const addressees = openingAddressees(text)
    const targets = new Set()
    const unresolved = []
    let toUser = false
    for (const tok of addressees) {
      if (tok === 'user' || tok === 'user/human') { toUser = true; continue }
      const h = resolveInRoom(room, tok)
      if (h && h !== lc(fromHandle)) targets.add(h)
      else if (!h) unresolved.push(tok)
    }
    // Back-compat: a 2-member room with no explicit target delivers to the other member (consult).
    if (!targets.size && !toUser && room.members.size === 2) {
      const other = [...room.members.keys()].find((k) => k !== lc(fromHandle) && k !== '@user')
      if (other) targets.add(other)
    }
    return { targets: [...targets], toUser, unresolved }
  }

  function deliverTo(room, toHandle, fromHandle, text) {
    // Defense-in-depth containment: only ever deliver to an actual member of THIS room. A handle not
    // in room.members (e.g. a cross-room/cross-org handle slipped in programmatically) is dropped and
    // logged, never delivered.
    if (!room.members.has(lc(toHandle))) { _append(room.roomId, `${ts()} [BLOCKED delivery to non-member ${toHandle}]`); return 'blocked' }
    const m = mem(room.org, toHandle)
    const tag = room.kind === 'consult' ? '' : `[room ${room.team || room.roomId}] `
    const who = `${nameOf(room.org, fromHandle)}${roleOf(room.org, fromHandle, room) ? `, ${roleOf(room.org, fromHandle, room)}` : ''}`
    // Defang any forged [Human directive]/[Human reply] line in the peer/worker body — real directives
    // are minted as separate `directive` frames and never pass through here, so this can only strip a
    // forgery, never a genuine human instruction. (A1 trust-boundary fix.)
    const frame = { type: 'deliver', room: room.roomId, from: fromHandle,
      text: `${tag}Peer (${who}) says: "${defangTrustMarkers(text)}" [turn ${room.turn}/${room.turnCap}]` }
    if (m && m.tier === 'live' && m.sessionId) { send?.(m.sessionId, frame); return 'delivered' }
    // Worker (non-live) member: enqueue an invocation request; drained by the worker runner.
    workerQueue.push({ org: room.org, roomId: room.roomId, toHandle: lc(toHandle), fromHandle, text, at: now() })
    _append(room.roomId, `${ts()} [queued for worker ${toHandle}]`)
    return 'queued'
  }

  function clearStallOnActivity(room) {
    if (room.state === 'Paused' && room.pauseReason === 'stall') {
      room.state = 'Running'; room.pauseReason = null
      _append(room.roomId, `${ts()} [auto-resumed: activity disproved stall]`)
    }
  }

  // Identify the sender of a programmatic call. Production passes a bound sessionId; tests/tools may
  // pass a bare fromHandle (+ optional org / roomId to disambiguate). Without org context, falls back
  // to the unique-across-orgs match — safe because the collision case is exactly what a real session
  // (sessionId path) resolves unambiguously.
  function senderFromHandle(fromHandle, fromOrg, roomId) {
    const h = lc(fromHandle)
    if (fromOrg != null) return mem(fromOrg, h) ? { org: String(fromOrg), handle: h } : null
    if (roomId) { const r = rooms.get(roomId); if (r && mem(r.org, h)) return { org: r.org, handle: h } }
    const hits = []
    for (const [org, omap] of members) if (omap.has(h)) hits.push(org)
    return hits.length === 1 ? { org: hits[0], handle: h } : null
  }

  // Find the room a member is sending into when they didn't give an exact id. A soft `hint` may be a
  // room id, a team name, or "leads"; failing that, infer from the @mentioned targets (the one room,
  // among the sender's, where every named target resolves). Returns room | null (in no room) |
  // undefined (ambiguous — caller should ask them to name the team/room). All scoped to sender's org.
  function findRoom(sOrHandle, hint, text) {
    // Accept a resolved sender {org,handle} (route's internal path) or a bare handle (tests/tools).
    const s = typeof sOrHandle === 'string' ? senderFromHandle(sOrHandle) : sOrHandle
    if (!s) return null
    const mine = roomsForSender(s)
    if (mine.length === 0) return null
    if (hint) {
      const exact = rooms.get(hint)
      if (exact && exact.org === s.org && exact.members.has(lc(s.handle))) return exact
      const lch = lc(hint)
      const byTeam = mine.find((r) => (r.team || '').toLowerCase() === lch)
      if (byTeam) return byTeam
      if (lch === 'leads') { const l = mine.find((r) => r.kind === 'leads'); if (l) return l }
    }
    if (mine.length === 1) return mine[0]
    // Infer the room from the OPENING addressees (consistent with resolveTargets — buried refs don't
    // steer routing). Peer addressees pick the one room where they all resolve.
    const opening = openingAddressees(text)
    const toks = [...opening].filter((t) => t !== 'user' && t !== 'user/human')
    // An @user-only message (no peer addressee, no hint) from a lead belongs in the room where @user
    // actually lives — the leads room — not an "ambiguous room" error.
    if (!toks.length && (opening.has('user') || opening.has('user/human'))) {
      const withUser = mine.filter((r) => r.members.has('@user'))
      if (withUser.length === 1) return withUser[0]
    }
    if (toks.length) {
      const fit = mine.filter((r) => toks.every((t) => resolveInRoom(r, t)))
      if (fit.length === 1) return fit[0]
    }
    return undefined   // ambiguous
  }

  // Core entry: a member sent `text`. Identify the sender (bound session preferred; else fromHandle).
  // An exact `roomId` is strict (must be a room they're in); a soft `room` hint (team name / "leads")
  // or target inference picks the room otherwise. Directed delivery to @mentioned members; @user to
  // the inbox. Honors brake/turnCap (held FIFO).
  function route({ sessionId, fromHandle, fromOrg, roomId, room: hint, text, kind }) {
    const s = sessionId ? senderOf(sessionId) : (fromHandle ? senderFromHandle(fromHandle, fromOrg, roomId) : null)
    if (!s) return { ok: false, error: 'sender not bound to a member' }
    const h = lc(s.handle)
    let room
    if (roomId) {
      room = rooms.get(roomId)
      if (!room) return { ok: false, error: `no such room "${roomId}"` }
      if (room.org !== s.org || !room.members.has(h)) return { ok: false, error: 'not a member of that room' }
    } else {
      room = findRoom(s, hint, text)
      if (room === null) return { ok: false, error: 'not in any room' }
      if (room === undefined) return { ok: false, error: 'ambiguous room — name the team or room (e.g. room:"leads")' }
      if (room.org !== s.org || !room.members.has(h)) return { ok: false, error: 'not a member of that room' }
    }

    const { targets, toUser, unresolved } = resolveTargets(room, h, text)
    room.turn += 1; room.lastActivityAt = now()
    // type rides the member's tool choice (#11): ask_user → 'question' (wants a reply, badges); plain
    // @user via send_message → 'notification' (FYI, no badge). Default-to-notification is the safe
    // failure mode. Created BEFORE the thread-append so its stable id can be stamped on the line (#18).
    const item = toUser
      ? { id: ++inboxSeq, org: room.org, roomId: room.roomId, room: room.team || room.roomId, from: h, fromName: nameOf(room.org, h), role: roleOf(room.org, h, room), team: mem(room.org, h)?.team || null, text, type: kind === 'question' ? 'question' : 'notification', at: now(), answered: false, dismissed: false }
      : null
    // Stamp a visible, meaningful [#<id>] on the @user line — a cross-surface reference (CLI/file/
    // dashboard/Telegram). The id is ALSO passed as the trusted `qid` meta so the dashboard anchors the
    // jump from that field, not from re-scanning this line's text (which a member could spoof) (#18).
    // #63-B1: pass the TRUSTED structured fields (from/role/at + the clean body `text`, no routing prefix) so
    // the dashboard's Slack row renders the author header from a daemon field. `h` is the session-RESOLVED
    // sender (the #56 bound identity), so `from`/`role` are as spoof-proof as the [#N] chip — a member can't
    // forge who it is. `text` is the body only (the `t` line wraps it with ts/author/targets/[#N]).
    _append(room.roomId, `${ts()} ${nameOf(room.org, h)} -> ${targets.map((t) => nameOf(room.org, t)).join(', ') || (toUser ? '@user' : '(no one)')}: ${text}${item ? ` [#${item.id}]` : ''}`,
      { qid: item ? item.id : null, from: nameOf(room.org, h), role: roleOf(room.org, h, room), at: now(), text })
    clearStallOnActivity(room)

    if (item) {
      userInbox.push(item)
      _notify(item.type === 'question' ? `${nameOf(room.org, h)} needs you (room ${room.team || room.roomId})` : `${nameOf(room.org, h)} — FYI (room ${room.team || room.roomId})`)
      _inbox('new', item)
    }

    if (room.state === 'Paused') {
      for (const t of targets) room.held.push({ toHandle: t, fromHandle: h, text })
      if (targets.length) _append(room.roomId, `${ts()} [held ${targets.length} while ${room.pauseReason}]`)
      return { ok: true, held: targets.length, toUser, unresolved, state: 'Paused' }
    }

    const results = targets.map((t) => ({ handle: t, status: deliverTo(room, t, h, text) }))
    // turn-cap check-in (periodic pause that resume re-grants), same policy as the original daemon.
    if (room.turnCap > 0 && room.turn >= room.turnCap) {
      room.state = 'Paused'; room.pauseReason = 'turnCap'
      _notify(`Room ${room.team || room.roomId}: turn-cap check-in at ${room.turn}`)
      // #35: raise an @you inbox item too, so the pause isn't silent — it badges + pushes to Telegram
      // ("resume to continue"). ONE per pause episode (guarded by pauseInboxId; once Paused, further
      // messages are held above and never re-reach here, but the guard is belt-and-suspenders). It's
      // resolved when the room resumes (resolvePauseItem) — never a stale "paused" item.
      if (!room.pauseInboxId) {
        const pi = { id: ++inboxSeq, org: room.org, roomId: room.roomId, room: room.team || room.roomId, from: '@room', fromName: room.team || room.roomId, role: 'system', team: room.team || null, text: `Room "${room.team || room.roomId}" hit its turn-cap check-in at turn ${room.turn}. Resume it to grant another window.`, type: 'question', at: now(), answered: false, dismissed: false, pauseRoom: room.roomId }
        userInbox.push(pi); room.pauseInboxId = pi.id
        _append(room.roomId, `${ts()} [turn-cap check-in at ${room.turn} — @you #${pi.id}]`, { qid: pi.id })
        _inbox('new', pi)
      }
    }
    return { ok: true, delivered: results, toUser, unresolved, state: room.state }
  }

  // --- controls (per room) -------------------------------------------------
  function doBrake(room, reason = 'brake') {
    room.state = 'Paused'; room.pauseReason = reason; _append(room.roomId, `${ts()} [paused: ${reason}]`)
    return room.held.length ? room.held.map((x) => x.text).join(' / ') : null
  }
  // #35: resolve the turn-cap @you item (mark answered + fire 'resolved' so the daemon clears the badge
  // and edits the Telegram push). Idempotent; shared by resume and a reply-to-resume. Never leaves a
  // stale "room paused" item after the user has already resumed.
  function resolvePauseItem(room) {
    if (!room.pauseInboxId) return
    const pi = userInbox.find((x) => x.id === room.pauseInboxId)
    room.pauseInboxId = null
    // Keep a reply's already-recorded answer/via (the reply-resume path sets them BEFORE doResume); only
    // default them for a bare control-resume. Fires 'resolved' exactly once.
    if (pi && !pi.answered && !pi.dismissed) { pi.answered = true; if (!pi.answer) pi.answer = '(resumed)'; if (!pi.answeredVia) pi.answeredVia = 'resume'; _inbox('resolved', pi) }
  }
  function doResume(room) {
    if (room.pauseReason === 'turnCap' && turnCap > 0) room.turnCap = room.turn + turnCap
    resolvePauseItem(room)   // #35: clear the @you turn-cap item before re-running
    const queued = room.held; room.held = []
    for (const x of queued) deliverTo(room, x.toHandle, x.fromHandle, x.text)
    room.state = 'Running'; room.pauseReason = null; room.lastActivityAt = now()
    _append(room.roomId, `${ts()} [resumed${queued.length ? `: delivered ${queued.length} held` : ''}]`)
  }
  function doSteer(room, target, text, { via } = {}) {
    const marker = via === 'telegram' ? '[Human directive via Telegram]' : '[Human directive]'   // #12 step 5 audit tag
    const targets = !target || target === 'all'
      ? [...room.members.keys()].filter((k) => k !== '@user')
      : [resolveInRoom(room, target)].filter(Boolean)
    for (const t of targets) {
      const m = mem(room.org, t)
      if (m?.sessionId) send?.(m.sessionId, { type: 'directive', room: room.roomId, text: `${marker}: ${text}` })
      else workerQueue.push({ org: room.org, roomId: room.roomId, toHandle: t, fromHandle: '@user', text: `${marker}: ${text}`, at: now(), directive: true })
    }
    if (room.held.length) _append(room.roomId, `${ts()} [steer dropped ${room.held.length} held]`)
    room.held = []; room.state = 'Running'; room.pauseReason = null; room.lastActivityAt = now()
    _append(room.roomId, `${ts()} HUMAN -> ${targets.map((t) => nameOf(room.org, t)).join(', ') || 'all'}: ${text}`, { from: '@user', role: 'human', at: now(), text })   // #63-B1: trusted author (the human's steer)
    return { ok: true, targets }
  }

  // Post a message into a room with EXPLICIT targets (no @mention parsing) — used for worker replies
  // and any programmatic post. Honors brake (held FIFO) and turn counting like route().
  function post({ roomId, fromHandle, toHandles = [], text }) {
    const room = rooms.get(roomId)
    if (!room) return { ok: false, error: 'no such room' }
    const h = lc(fromHandle)
    room.turn += 1; room.lastActivityAt = now()
    _append(roomId, `${ts()} ${nameOf(room.org, h)} -> ${toHandles.map((t) => nameOf(room.org, t)).join(', ') || '(no one)'}: ${text}`)
    clearStallOnActivity(room)
    if (room.state === 'Paused') { for (const t of toHandles) room.held.push({ toHandle: lc(t), fromHandle: h, text }); return { ok: true, state: 'Paused', held: toHandles.length } }
    const delivered = toHandles.map((t) => ({ handle: t, status: deliverTo(room, t, h, text) }))
    return { ok: true, delivered }
  }

  // Push a system notice to every live member of a room (e.g. "@X just joined"). Logged to the thread.
  function notifyRoom(roomId, text, { except } = {}) {
    const room = rooms.get(roomId)
    if (!room) return 0
    let n = 0
    for (const h of room.members.keys()) {
      if (h === '@user' || h === lc(except)) continue
      const m = mem(room.org, h)
      if (m?.sessionId && m.tier === 'live') { send?.(m.sessionId, { type: 'notice', room: roomId, text }); n++ }
    }
    _append(roomId, `${ts()} [${text}]`)
    return n
  }

  // The human answered an @user inbox item (by STABLE id): route the reply back as a [Human reply].
  // Rejects a STALE reply (item already answered) so a late reply from any surface — dashboard or
  // Telegram (#12 H4) — can't double-route; the caller surfaces `stale` to drop it.
  function answerUser(id, text, { via } = {}) {
    const item = userInbox.find((x) => x.id === id)
    if (!item) return { ok: false, error: 'no such inbox item' }
    // OPEN = not answered AND not dismissed. Reject a stale reply to an item already resolved EITHER
    // way — answering a dismissed item would double-route (a TG reply to a dashboard-dismissed
    // question is exactly the cross-surface double-answer H4 prevents). The change-of-mind path is
    // Re-open (clears dismissed) → answer.
    if (item.answered || item.dismissed) return { ok: false, error: item.answered ? 'already answered' : 'already dismissed', stale: true }
    const room = rooms.get(item.roomId)
    if (!room) return { ok: false, error: 'room gone' }
    // #35: a turn-cap check-in item is not a member question — replying to it (dashboard OR Telegram)
    // RESUMES the room. If the reply carries TEXT ("resume but focus on the API"), it isn't dropped —
    // it's steered into the room as a [Human directive] in the same action (resume + nudge). No member
    // routing. The item records the actual reply text (not a bare "(resumed)"), so the ack is truthful.
    if (item.pauseRoom) {
      const nudge = String(text ?? '').trim()
      if (nudge) { item.answer = nudge; item.answeredVia = via || 'resume' }   // record BEFORE resume so resolvePauseItem keeps it
      if (room.state === 'Paused' && room.pauseReason === 'turnCap') doResume(room)   // → resolvePauseItem resolves it (once)
      if (nudge) doSteer(room, 'all', nudge, { via })   // resume AND steer the reply, in one action
      if (!item.answered && !item.dismissed) { item.answered = true; item.answer = nudge || '(resumed)'; item.answeredVia = via || 'resume'; _inbox('resolved', item) }   // fallback if it wasn't paused
      return { ok: true, resumed: true, steered: !!nudge }
    }
    // Reply traceability (#17): quote the ORIGINAL question inline so the member knows WHICH of their
    // @user messages this answers. The snippet is member-authored (untrusted) embedded in a TRUSTED
    // directive line, so it MUST go through snippetForTrustedLine (defang + break-out strip) — this is
    // the A1 class via the new quote. Audit tag (#12 step 5: via-Telegram) rides in the same marker.
    const quoted = snippetForTrustedLine(item.text)
    const marker = `[${via === 'telegram' ? 'Human reply via Telegram' : 'Human reply'} to "${quoted}"]`
    const m = mem(item.org, item.from)
    if (m?.sessionId) send?.(m.sessionId, { type: 'directive', room: room.roomId, text: `${marker}: ${text}` })
    else workerQueue.push({ org: item.org, roomId: room.roomId, toHandle: item.from, fromHandle: '@user', text: `${marker}: ${text}`, at: now(), directive: true })
    item.answered = true; item.answer = text; item.answeredVia = via || 'dashboard'   // #24: which surface resolved it, so the OTHER surface can show "answered via …"
    _append(room.roomId, `${ts()} HUMAN -> ${nameOf(item.org, item.from)}: ${text} (re #${item.id})`, { reqid: item.id, from: '@user', role: 'human', at: now(), text })   // #18 reqid + #63-B1 trusted author (the human)
    _inbox('resolved', item)
    return { ok: true }
  }

  // The human cleared an @user inbox item WITHOUT replying (#11): dismisses a notification (its only
  // action) or a question the human chooses not to answer. v1 = SILENT clear — the asking member is
  // not signaled (ask_user acks on delivery, not on the reply, so it isn't hard-blocked). To switch to
  // a courtesy signal, route a soft `[Human reply]: (dismissed, no response)` here. Idempotent.
  function dismissUser(id) {
    const item = userInbox.find((x) => x.id === id)
    if (!item) return { ok: false, error: 'no such inbox item' }
    if (item.answered || item.dismissed) return { ok: true }
    item.dismissed = true; item.dismissedAt = now()
    _append(item.roomId, `${ts()} HUMAN dismissed ${nameOf(item.org, item.from)}'s ${item.type || 'message'}`)
    _inbox('resolved', item)
    return { ok: true }
  }

  // Undo a dismiss (#11): a mis-dismissed question becomes actionable again. Only un-dismisses — an
  // already-answered item stays answered. Makes the silent-clear default recoverable.
  function reopenUser(id) {
    const item = userInbox.find((x) => x.id === id)
    if (!item) return { ok: false, error: 'no such inbox item' }
    if (!item.dismissed) return { ok: true }
    item.dismissed = false; item.dismissedAt = null
    _inbox('reopened', item)
    return { ok: true }
  }

  // Restore the persisted @user inbox on a daemon restart (#16) — replaces the in-memory list with the
  // saved items (answered/dismissed/type/org/id all intact, so the badge, show-dismissed, and the
  // question/notification split all come back exactly; resolved items stay resolved, not resurrected).
  // The id counter resumes past the highest restored id so new items never collide. No _inbox fire.
  function restoreInbox(items) {
    if (!Array.isArray(items)) return
    userInbox.length = 0
    for (const it of items) if (it && it.id != null) userInbox.push(it)
    inboxSeq = userInbox.reduce((m, x) => Math.max(m, x.id || 0), 0)
  }

  // What a member sees: its rooms and, per room, the teammates (with online state). Drives the
  // member's list_team tool and the dashboard roster.
  function memberView(org, handle) {
    const me = mem(org, handle)
    if (!me) return null
    const rms = roomsForSender({ org, handle }).map((r) => ({
      roomId: r.roomId, team: r.team, kind: r.kind, state: r.state,
      members: [...r.members.keys()].map((h) => h === '@user'
        ? { handle: '@user', first: 'user', role: 'human', lead: false, online: true }
        : { handle: h, first: mem(r.org, h)?.first, role: r.members.get(h)?.role, lead: !!r.members.get(h)?.lead, backend: mem(r.org, h)?.backend, online: online(r.org, h) }),
    }))
    return { handle: lc(handle), first: me.first, role: me.role, team: me.team, lead: me.lead, org, rooms: rms }
  }
  function viewForSession(sessionId) { const s = senderOf(sessionId); return s ? memberView(s.org, s.handle) : null }

  // Atomically take all queued worker invocations (the runner drains these), grouped by
  // (roomId, toHandle) so a burst of mentions to one worker becomes a single invocation.
  function claimWorkerBatches() {
    if (!workerQueue.length) return []
    const items = workerQueue.splice(0, workerQueue.length)
    const groups = new Map()
    for (const it of items) {
      const key = `${it.roomId}\x00${it.toHandle}`
      if (!groups.has(key)) groups.set(key, { org: it.org, roomId: it.roomId, toHandle: it.toHandle, items: [] })
      groups.get(key).items.push(it)
    }
    return [...groups.values()]
  }

  // Close a team room (human-only, mirrors legacy `end`): preserve files, drop in-memory state.
  function endRoom(roomId) {
    const r = rooms.get(roomId)
    if (!r) return { ok: false, error: 'no such room' }
    _append(roomId, `${ts()} [closed]`)
    rooms.delete(roomId)
    return { ok: true }
  }

  // Fully forget an org (the dashboard "Delete project"): drop its members, rooms, sessions, inbox
  // items, and queued work. Mirrors a teardown that defineOrg-prune can't do (it only prunes WITHIN a
  // redefine). Idempotent.
  function removeOrg(org) {
    const orgId = String(org)
    const omap = members.get(orgId)
    if (omap) { for (const m of omap.values()) if (m.sessionId) bySession.delete(m.sessionId); members.delete(orgId) }
    for (const [id, r] of [...rooms]) if (r.org === orgId) rooms.delete(id)
    for (let i = userInbox.length - 1; i >= 0; i--) if (userInbox[i].org === orgId) userInbox.splice(i, 1)
    for (let i = workerQueue.length - 1; i >= 0; i--) if (workerQueue[i].org === orgId) workerQueue.splice(i, 1)
    orgs.delete(orgId)
    return { ok: true }
  }

  // #42 chunk C: change the team turn-cap at RUNTIME. Updates the default for new rooms + the resume
  // re-grant size, and applies LIVE to every existing room so the change takes effect without waiting
  // for a resume: 0 disables the pause-after-N entirely (and resumes any room currently paused on it);
  // otherwise each room gets a fresh window from its current turn.
  function setTurnCap(n) {
    const v = Number(n)
    if (!Number.isFinite(v) || v < 0) return turnCap   // ignore junk — keep the current cap
    turnCap = Math.floor(v)
    for (const room of rooms.values()) {
      room.turnCap = turnCap === 0 ? 0 : room.turn + turnCap
      if (turnCap === 0 && room.state === 'Paused' && room.pauseReason === 'turnCap') doResume(room)
    }
    return turnCap
  }
  const getTurnCap = () => turnCap

  // #64: a member's statusline ints (context %, rate-limit %, session name), forwarded by its channel server
  // (transport B'). Identity is RESOLVED from the bound session — a member can NOT report another's status, and
  // the frame carries no identity field. Strict-numeric: each value must be a finite NUMBER (no string coercion,
  // so "99" is dropped, not parsed) → clamp 0–100, else null ("—" on display). The name is length-capped here and
  // escaped at DISPLAY (it's untrusted text). Display-only — nothing in the engine branches on these values.
  //
  // #68: the shared org RATE-LIMIT rail is BEST-EFFORT-DISPLAY, lead-PREFERRED with any-member fallback. Rate
  // limits are ACCOUNT-WIDE (all members share the Max/OAuth account), so any member's 5h/7d is accurate — the
  // original lead-ONLY gate left the rail empty whenever the lead specifically wasn't reporting (the actual bug).
  // Now: the lead's report is authoritative when present (stable, no flap if a non-lead ticks a slightly different
  // value); a non-lead fills the rail only when there's no value, the current value isn't from the lead, or the
  // lead's last report has gone stale. A report with no rate_limits (both null) never clobbers a good value. This
  // is a gauge a member FEEDS — a compromised member could show a wrong number (cosmetic; the human cross-checks
  // the real Claude statusline the rail mirrors), so it's best-effort, NOT a trustworthy guarantee.
  const clampPct = (v) => (typeof v === 'number' && Number.isFinite(v)) ? Math.max(0, Math.min(100, Math.floor(v))) : null
  const RATE_STALE_MS = 30_000
  function setStatus(sessionId, f) {
    const s = senderOf(sessionId); if (!s) return null
    const m = mem(s.org, s.handle); if (!m) return null
    const name = typeof f?.name === 'string' ? f.name.slice(0, 80) : ''
    m.status = { context: clampPct(f?.context), name, at: now() }
    const fiveHour = clampPct(f?.fiveHour), sevenDay = clampPct(f?.sevenDay)
    if (fiveHour != null || sevenDay != null) {
      const org = orgs.get(String(s.org))
      const cur = org?.rateLimit
      // lead-preferred, fall back to any-member: the lead always (re)writes; a non-lead writes only when there's
      // no value yet, the current value wasn't the lead's, or the lead's last value has gone stale.
      if (org && (m.lead || !cur || !cur.fromLead || (now() - (cur.at || 0)) > RATE_STALE_MS)) {
        org.rateLimit = { fiveHour, sevenDay, at: now(), fromLead: !!m.lead }
      }
    }
    return { org: s.org, handle: s.handle, lead: !!m.lead }
  }

  function status() {
    const allMembers = []
    for (const omap of members.values()) for (const m of omap.values()) allMembers.push(m)
    return {
      orgs: [...orgs.values()],
      members: allMembers.map((m) => ({ handle: m.handle, first: m.first, role: m.role, team: m.team, lead: m.lead, backend: m.backend, tier: m.tier, org: m.org, online: online(m.org, m.handle), status: m.status || null })),
      rooms: [...rooms.values()].map((r) => ({
        roomId: r.roomId, kind: r.kind, team: r.team, org: r.org, state: r.state, pauseReason: r.pauseReason,
        turn: r.turn, turnCap: r.turnCap, members: [...r.members.keys()],
      })),
      userInbox: userInbox.map((x) => ({ ...x })),   // each carries a stable `id` (addressing key)
      workerQueue: workerQueue.length,
    }
  }

  return {
    defineOrg, bindSession, unbindSession, route, endRoom, removeOrg, post,
    roomsForSession, roomsForHandle, resolveTargets, resolveInRoom, findRoom,
    doBrake, doResume, doSteer, answerUser, dismissUser, reopenUser, restoreInbox, status, setStatus, memberView, viewForSession, claimWorkerBatches, notifyRoom,
    setTurnCap, getTurnCap,
    // exposed for the daemon/dashboard + tests
    _rooms: rooms, _members: members, _userInbox: userInbox, _workerQueue: workerQueue,
    getRoom: (id) => rooms.get(id) || null,
    memberByHandle,
  }
}
