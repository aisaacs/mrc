// Team room engine — the generalized relay brain. Where the original daemon had a strictly
// 2-party `pairing` ({a,b}) with "the other side" routing, this models a room as a SET of members
// and routes by @mention (directed delivery). It is transport-agnostic: all I/O is injected
// (send/append/notify/now), so the routing, multi-room membership, and @user inbox are unit-testable
// without sockets or a filesystem.
//
// Concepts:
//   member  — { handle, first, role, team, lead, backend, tier, sessionId|null }
//             handle = "first/backend" (unique per org). tier 'live' binds a session; 'worker'
//             members have no persistent session — a directed mention enqueues an invocation.
//   room    — { roomId, kind, team, members:Map<handle,{role,lead}>, state, turn, held, … }
//             kind: 'team' | 'leads' | 'consult' (legacy 2-party) | 'dm'.
//   routing — extract @mentions from the text; resolve each to a room member by handle, then first
//             name, then role (each must be unambiguous within the room). @user routes to the human
//             inbox + a notify. No mention in a 2-member room ⇒ the other member (consult back-compat);
//             no mention in a 3+-member room ⇒ nothing is delivered (directed-only is the floor control).
import { extractMentions, parseMention } from './names.js'

const norm = (s) => String(s || '').trim()

// The @mentions at the START of a message are its ADDRESSEES; @mentions later in the prose are
// references (e.g. "scope locked by @user"). Used so a passing @user reference isn't mistaken for a
// question to the human. Allows leading connectors ("@a and @b, …").
function leadingAddressees(text) {
  const out = []
  let s = String(text || '').trimStart()
  const re = /^(?:and\s+|&\s*|,\s*)?@([a-z0-9._/-]+)\s*/i
  let m
  while ((m = s.match(re))) { out.push(m[1].toLowerCase()); s = s.slice(m[0].length) }
  return out
}

export function createRoomEngine({ send, append, notify, now = () => Date.now(), turnCap = 100 } = {}) {
  const members = new Map()   // handle -> member def (sessionId bound when its live session connects)
  const rooms = new Map()     // roomId -> room state
  const bySession = new Map() // sessionId -> handle (reverse index for live members)
  const userInbox = []        // @user messages awaiting the human (read by the dashboard/CLI)
  const workerQueue = []      // directed mentions to worker (non-live) members, awaiting invocation
  const orgs = new Map()      // orgId -> { org, repo }

  const _append = (roomId, line) => { try { append?.(roomId, line) } catch {} }
  const _notify = (msg) => { try { notify?.(msg) } catch {} }
  const ts = () => new Date(now()).toISOString()

  function memberByHandle(h) { return members.get(String(h).toLowerCase()) || null }
  function handleForSession(sessionId) { return bySession.get(sessionId) || null }
  function nameOf(handle) { const m = memberByHandle(handle); return m ? `@${m.first}` : handle }
  function roleOf(handle, room) { const e = room?.members.get(handle); return e?.role || memberByHandle(handle)?.role || '' }
  const online = (handle) => { const m = memberByHandle(handle); return !!(m && m.sessionId && m.tier === 'live') }

  // Register/refresh an org's roster: its members and its rooms. Idempotent — re-defining updates
  // membership without dropping live bindings or in-flight room state (turn/held are preserved).
  function defineOrg({ org, repo, members: mem = [], rooms: rms = [] }) {
    const orgId = String(org)
    orgs.set(orgId, { org: orgId, repo: repo || null })
    // Redefining an org REPLACES it: prune members/rooms that belonged to this org but are gone from
    // the new def, so re-running `mrc team up` (or a daemon reload) never accumulates ghosts.
    const keepHandles = new Set(mem.map((m) => String(m.handle).toLowerCase()))
    const keepRooms = new Set(rms.map((r) => r.roomId))
    for (const [h, m] of [...members]) {
      if (m.org === orgId && !keepHandles.has(h)) {
        if (m.sessionId) bySession.delete(m.sessionId)
        members.delete(h)
      }
    }
    for (const [id, r] of [...rooms]) if (r.org === orgId && !keepRooms.has(id)) rooms.delete(id)
    for (const m of mem) {
      const handle = String(m.handle).toLowerCase()
      const prev = members.get(handle)
      members.set(handle, {
        handle, first: m.first, role: m.role, team: m.team, lead: !!m.lead,
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
        const def = memberByHandle(h)
        memberMap.set(String(h).toLowerCase(), { role: def?.role || '', lead: !!def?.lead })
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

  // Bind a live session to its member (called when its channel registers with a memberHandle).
  // Returns the rooms the member belongs to, for connect notices.
  function bindSession(handle, sessionId) {
    const h = String(handle).toLowerCase()
    const m = members.get(h)
    if (!m) return { ok: false, error: `unknown member ${handle}` }
    m.sessionId = sessionId
    bySession.set(sessionId, h)
    const inRooms = [...rooms.values()].filter((r) => r.members.has(h)).map((r) => r.roomId)
    return { ok: true, handle: h, rooms: inRooms }
  }
  function unbindSession(sessionId) {
    const h = bySession.get(sessionId)
    if (!h) return
    bySession.delete(sessionId)
    const m = members.get(h)
    if (m && m.sessionId === sessionId) m.sessionId = null
  }

  function roomsForSession(sessionId) {
    const h = handleForSession(sessionId)
    if (!h) return []
    return [...rooms.values()].filter((r) => r.members.has(h))
  }
  function roomsForHandle(h) {
    h = String(h).toLowerCase()
    return [...rooms.values()].filter((r) => r.members.has(h))
  }

  // Resolve one @mention token to a member handle WITHIN a room. Most-specific first:
  // exact handle (first/backend) → unique first-name → unique role-holder. Returns handle | null.
  function resolveInRoom(room, token) {
    const { first, backend } = parseMention(token) || {}
    if (!first) return null
    const present = [...room.members.keys()].filter((k) => k !== '@user')
    if (backend) {
      const exact = `${first}/${backend}`
      if (room.members.has(exact)) return exact
    }
    const byFirst = present.filter((k) => memberByHandle(k)?.first?.toLowerCase() === first)
    if (byFirst.length === 1) return byFirst[0]
    if (byFirst.length > 1) return null   // ambiguous first name in this room
    const byRole = present.filter((k) => (room.members.get(k)?.role || '').toLowerCase() === first)
    if (byRole.length === 1) return byRole[0]
    return null
  }

  // Decide who a message is directed to. Returns { targets:[handles], toUser, unresolved:[tokens] }.
  function resolveTargets(room, fromHandle, text) {
    const mentions = extractMentions(text)
    const targets = new Set()
    const unresolved = []
    for (const tok of mentions) {
      if (tok === 'user' || tok === 'user/human') continue   // @user handled via leading-addressee below
      const h = resolveInRoom(room, tok)
      if (h && h !== fromHandle) targets.add(h)
      else if (!h) unresolved.push(tok)
    }
    // @user is a question for the human ONLY when it's a leading addressee (how ask_user phrases it),
    // not a passing reference like "scope locked by @user" — otherwise the inbox fills with noise.
    const toUser = leadingAddressees(text).some((t) => t === 'user' || t === 'user/human')
    // Back-compat: a 2-member room with no explicit target delivers to the other member (consult).
    if (!targets.size && !toUser && room.members.size === 2) {
      const other = [...room.members.keys()].find((k) => k !== fromHandle && k !== '@user')
      if (other) targets.add(other)
    }
    return { targets: [...targets], toUser, unresolved }
  }

  function deliverTo(room, toHandle, fromHandle, text) {
    const m = memberByHandle(toHandle)
    const tag = room.kind === 'consult' ? '' : `[room ${room.team || room.roomId}] `
    const who = `${nameOf(fromHandle)}${roleOf(fromHandle, room) ? `, ${roleOf(fromHandle, room)}` : ''}`
    const frame = { type: 'deliver', room: room.roomId, from: fromHandle,
      text: `${tag}Peer (${who}) says: "${text}" [turn ${room.turn}/${room.turnCap}]` }
    if (m && m.tier === 'live' && m.sessionId) { send?.(m.sessionId, frame); return 'delivered' }
    // Worker (non-live) member: enqueue an invocation request; drained by the worker runner (P5).
    workerQueue.push({ roomId: room.roomId, toHandle, fromHandle, text, at: now() })
    _append(room.roomId, `${ts()} [queued for worker ${toHandle}]`)
    return 'queued'
  }

  function clearStallOnActivity(room) {
    if (room.state === 'Paused' && room.pauseReason === 'stall') {
      room.state = 'Running'; room.pauseReason = null
      _append(room.roomId, `${ts()} [auto-resumed: activity disproved stall]`)
    }
  }

  // Find the room a member is sending into when they didn't give an exact id. A soft `hint` may be a
  // room id, a team name, or "leads"; failing that, infer from the @mentioned targets (the one room,
  // among the sender's, where every named target resolves). Returns room | null (in no room) |
  // undefined (ambiguous — caller should ask them to name the team/room).
  function findRoom(h, hint, text) {
    const mine = roomsForHandle(h)
    if (mine.length === 0) return null
    if (hint) {
      const exact = rooms.get(hint)
      if (exact && exact.members.has(h)) return exact
      const lc = String(hint).toLowerCase()
      const byTeam = mine.find((r) => (r.team || '').toLowerCase() === lc)
      if (byTeam) return byTeam
      if (lc === 'leads') { const l = mine.find((r) => r.kind === 'leads'); if (l) return l }
    }
    if (mine.length === 1) return mine[0]
    const toks = extractMentions(text).filter((t) => t !== 'user' && t !== 'user/human')
    if (toks.length) {
      const fit = mine.filter((r) => toks.every((t) => resolveInRoom(r, t)))
      if (fit.length === 1) return fit[0]
    }
    return undefined   // ambiguous
  }

  // Core entry: a member sent `text`. An exact `roomId` is strict (must be a room they're in); a soft
  // `room` hint (team name / "leads") or target inference picks the room otherwise. Directed delivery
  // to @mentioned members; @user to the inbox. Honors brake/turnCap (held FIFO).
  function route({ sessionId, fromHandle, roomId, room: hint, text }) {
    const h = fromHandle ? String(fromHandle).toLowerCase() : handleForSession(sessionId)
    if (!h) return { ok: false, error: 'sender not bound to a member' }
    let room
    if (roomId) {
      room = rooms.get(roomId)
      if (!room) return { ok: false, error: `no such room "${roomId}"` }
      if (!room.members.has(h)) return { ok: false, error: 'not a member of that room' }
    } else {
      room = findRoom(h, hint, text)
      if (room === null) return { ok: false, error: 'not in any room' }
      if (room === undefined) return { ok: false, error: 'ambiguous room — name the team or room (e.g. room:"leads")' }
      if (!room.members.has(h)) return { ok: false, error: 'not a member of that room' }
    }

    const { targets, toUser, unresolved } = resolveTargets(room, h, text)
    room.turn += 1; room.lastActivityAt = now()
    _append(room.roomId, `${ts()} ${nameOf(h)} -> ${targets.map(nameOf).join(', ') || (toUser ? '@user' : '(no one)')}: ${text}`)
    clearStallOnActivity(room)

    if (toUser) {
      userInbox.push({ roomId: room.roomId, room: room.team || room.roomId, from: h, fromName: nameOf(h), text, at: now(), answered: false })
      _notify(`${nameOf(h)} needs you (room ${room.team || room.roomId})`)
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
    }
    return { ok: true, delivered: results, toUser, unresolved, state: room.state }
  }

  // --- controls (per room) -------------------------------------------------
  function doBrake(room, reason = 'brake') {
    room.state = 'Paused'; room.pauseReason = reason; _append(room.roomId, `${ts()} [paused: ${reason}]`)
    return room.held.length ? room.held.map((x) => x.text).join(' / ') : null
  }
  function doResume(room) {
    if (room.pauseReason === 'turnCap' && turnCap > 0) room.turnCap = room.turn + turnCap
    const queued = room.held; room.held = []
    for (const x of queued) deliverTo(room, x.toHandle, x.fromHandle, x.text)
    room.state = 'Running'; room.pauseReason = null; room.lastActivityAt = now()
    _append(room.roomId, `${ts()} [resumed${queued.length ? `: delivered ${queued.length} held` : ''}]`)
  }
  function doSteer(room, target, text) {
    const targets = !target || target === 'all'
      ? [...room.members.keys()].filter((k) => k !== '@user')
      : [resolveInRoom(room, target)].filter(Boolean)
    for (const t of targets) {
      const m = memberByHandle(t)
      if (m?.sessionId) send?.(m.sessionId, { type: 'directive', room: room.roomId, text: `[Human directive]: ${text}` })
      else workerQueue.push({ roomId: room.roomId, toHandle: t, fromHandle: '@user', text: `[Human directive]: ${text}`, at: now(), directive: true })
    }
    if (room.held.length) _append(room.roomId, `${ts()} [steer dropped ${room.held.length} held]`)
    room.held = []; room.state = 'Running'; room.pauseReason = null; room.lastActivityAt = now()
    _append(room.roomId, `${ts()} HUMAN -> ${targets.map(nameOf).join(', ') || 'all'}: ${text}`)
    return { ok: true, targets }
  }

  // Post a message into a room with EXPLICIT targets (no @mention parsing) — used for worker replies
  // and any programmatic post. Honors brake (held FIFO) and turn counting like route().
  function post({ roomId, fromHandle, toHandles = [], text }) {
    const room = rooms.get(roomId)
    if (!room) return { ok: false, error: 'no such room' }
    const h = String(fromHandle).toLowerCase()
    room.turn += 1; room.lastActivityAt = now()
    _append(roomId, `${ts()} ${nameOf(h)} -> ${toHandles.map(nameOf).join(', ') || '(no one)'}: ${text}`)
    clearStallOnActivity(room)
    if (room.state === 'Paused') { for (const t of toHandles) room.held.push({ toHandle: t, fromHandle: h, text }); return { ok: true, state: 'Paused', held: toHandles.length } }
    const delivered = toHandles.map((t) => ({ handle: t, status: deliverTo(room, t, h, text) }))
    return { ok: true, delivered }
  }

  // The human answered an @user inbox item: route the reply back into the room as a [Human directive].
  function answerUser(idx, text) {
    const item = userInbox[idx]
    if (!item) return { ok: false, error: 'no such inbox item' }
    const room = rooms.get(item.roomId)
    if (!room) return { ok: false, error: 'room gone' }
    const m = memberByHandle(item.from)
    if (m?.sessionId) send?.(m.sessionId, { type: 'directive', room: room.roomId, text: `[Human reply]: ${text}` })
    else workerQueue.push({ roomId: room.roomId, toHandle: item.from, fromHandle: '@user', text: `[Human reply]: ${text}`, at: now(), directive: true })
    item.answered = true; item.answer = text
    _append(room.roomId, `${ts()} HUMAN -> ${nameOf(item.from)}: ${text}`)
    return { ok: true }
  }

  // What a member sees: its rooms and, per room, the teammates (with online state). Drives the
  // member's list_team tool and the dashboard roster.
  function memberView(handle) {
    handle = String(handle).toLowerCase()
    const me = members.get(handle)
    if (!me) return null
    const rms = roomsForHandle(handle).map((r) => ({
      roomId: r.roomId, team: r.team, kind: r.kind, state: r.state,
      members: [...r.members.keys()].map((h) => h === '@user'
        ? { handle: '@user', first: 'user', role: 'human', lead: false, online: true }
        : { handle: h, first: memberByHandle(h)?.first, role: r.members.get(h)?.role, lead: !!r.members.get(h)?.lead, backend: memberByHandle(h)?.backend, online: online(h) }),
    }))
    return { handle, first: me.first, role: me.role, team: me.team, lead: me.lead, rooms: rms }
  }
  function viewForSession(sessionId) { const h = handleForSession(sessionId); return h ? memberView(h) : null }

  // Atomically take all queued worker invocations (the runner drains these), grouped by
  // (roomId, toHandle) so a burst of mentions to one worker becomes a single invocation.
  function claimWorkerBatches() {
    if (!workerQueue.length) return []
    const items = workerQueue.splice(0, workerQueue.length)
    const groups = new Map()
    for (const it of items) {
      const key = `${it.roomId}\x00${it.toHandle}`
      if (!groups.has(key)) groups.set(key, { roomId: it.roomId, toHandle: it.toHandle, items: [] })
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

  function status() {
    return {
      orgs: [...orgs.values()],
      members: [...members.values()].map((m) => ({ handle: m.handle, first: m.first, role: m.role, team: m.team, lead: m.lead, backend: m.backend, tier: m.tier, org: m.org, online: online(m.handle) })),
      rooms: [...rooms.values()].map((r) => ({
        roomId: r.roomId, kind: r.kind, team: r.team, org: r.org, state: r.state, pauseReason: r.pauseReason,
        turn: r.turn, turnCap: r.turnCap, members: [...r.members.keys()],
      })),
      userInbox: userInbox.map((x, i) => ({ i, ...x })),
      workerQueue: workerQueue.length,
    }
  }

  return {
    defineOrg, bindSession, unbindSession, route, endRoom, post,
    roomsForSession, roomsForHandle, resolveTargets, resolveInRoom, findRoom,
    doBrake, doResume, doSteer, answerUser, status, memberView, viewForSession, claimWorkerBatches,
    // exposed for the daemon/dashboard + tests
    _rooms: rooms, _members: members, _userInbox: userInbox, _workerQueue: workerQueue,
    getRoom: (id) => rooms.get(id) || null,
    memberByHandle,
  }
}
