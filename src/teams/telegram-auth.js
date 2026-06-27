// Per-org Telegram pairing + inbound trust state machine (#12 step 3). PURE + unit-testable; the
// daemon owns persistence (per-org state on disk) and the side effects (send replies, route to the
// inbox, surface pending in the dashboard). This module only DECIDES, so the security-critical
// `from.id` boundary can be gated without a live bot.
//
// Per-org state: { token, offset, pinned, pending } where
//   pinned  = { chatId, fromId, username, firstName, lastName, at } | null  — the ONE authorized user
//   pending = [ { chatId, fromId, username, firstName, lastName, at } ]      — unconfirmed /start attempts
//
// Trust model (dashboard-confirm-before-active — NO code; the trusted action is a Confirm click on the
// localhost dashboard):
//   • Private chats only — a group/supergroup/channel message is rejected, never binds.
//   • INERT UNTIL PINNED, both directions: while unpaired the bot only answers /start with the pairing
//     instruction and records a PENDING entry; it pushes nothing else and injects nothing. (Questions
//     keep landing in the dashboard @you pane meanwhile — zero leak window.)
//   • A /start records a pending candidate (dedup by from.id); the human confirms ONE on the trusted
//     localhost dashboard → pinned. No auto-bind on first message → no TOFU race.
//   • Once pinned: only `from.id === pinned.fromId` on `chat.id === pinned.chatId` is accepted; every
//     other sender is dropped silently (surfaced as an attempt, not acted on). Re-pair only via an
//     explicit dashboard Unpair (a captured id is never silently overwritten by a later /start).
import { isStart } from './telegram.js'

export function freshTgState() { return { token: null, offset: 0, pinned: null, pending: [], maxUpdateId: null } }

// update_id dedup BEFORE any injection. Telegram update_ids are monotonically increasing, so a single
// high-water-mark is enough: an id at or below it was already processed (a re-delivered batch after a
// handoff failure, or a replay after an offset loss across restart). Persist `maxUpdateId` per org so a
// restart can't double-inject a trusted leads-room message. Mark AFTER a successful injection.
export function isDuplicateUpdate(state, updateId) {
  return updateId != null && state?.maxUpdateId != null && updateId <= state.maxUpdateId
}
export function markUpdateProcessed(state, updateId) {
  if (updateId != null && (state.maxUpdateId == null || updateId > state.maxUpdateId)) state.maxUpdateId = updateId
}

const candidateOf = (msg) => ({
  chatId: msg.chatId, fromId: msg.from?.id,
  username: msg.from?.username || null, firstName: msg.from?.firstName || null, lastName: msg.from?.lastName || null,
})

// Decide what to do with ONE inbound message. Returns a tagged decision the daemon executes:
//   { kind: 'reject-group' }                         — non-private chat; ignore (optionally hint "DM me")
//   { kind: 'ignore' }                               — unattributable (no from.id)
//   { kind: 'authorized', text, replyToMessageId }   — the pinned user; route this into the org
//   { kind: 'unauthorized', fromId }                 — pinned, but a different sender → drop (surface attempt)
//   { kind: 'pair-start', candidate }                — /start while unpaired → record pending + welcome
//   { kind: 'pairing-idle' }                         — non-/start while unpaired → stay silent
// Decisions never mutate state; the daemon applies addPending/confirm/etc. as needed.
export function classifyInbound(state, msg) {
  if (!msg) return { kind: 'ignore' }
  // Default-deny: anything that isn't explicitly a private chat is rejected (a malformed/absent
  // chatType fails CLOSED rather than proceeding to pairing). Telegram always sets chat.type.
  if (msg.chatType !== 'private') return { kind: 'reject-group' }
  const fromId = msg.from?.id
  if (fromId == null) return { kind: 'ignore' }
  if (state.pinned) {
    if (fromId === state.pinned.fromId && msg.chatId === state.pinned.chatId) {
      return { kind: 'authorized', text: msg.text, replyToMessageId: msg.replyToMessageId }
    }
    return { kind: 'unauthorized', fromId }
  }
  if (isStart(msg.text)) return { kind: 'pair-start', candidate: candidateOf(msg) }
  return { kind: 'pairing-idle' }
}

// Record a /start candidate as pending (idempotent by from.id; refreshes its fields). No-op once pinned.
export function addPending(state, candidate, at = 0) {
  if (state.pinned || candidate?.fromId == null) return false
  const existing = state.pending.find((p) => p.fromId === candidate.fromId)
  if (existing) { Object.assign(existing, candidate, { at: existing.at || at }); return false }
  state.pending.push({ ...candidate, at })
  return true
}

// The human confirmed a pending candidate on the localhost dashboard → PIN it (bind from.id + chat.id),
// and clear ALL other pendings (race: confirm one, reject the rest). Returns the pinned record | null.
export function confirmPending(state, fromId, at = 0) {
  const cand = state.pending.find((p) => p.fromId === fromId)
  if (!cand) return null
  state.pinned = { ...cand, at }
  state.pending = []
  return state.pinned
}

export function rejectPending(state, fromId) {
  const before = state.pending.length
  state.pending = state.pending.filter((p) => p.fromId !== fromId)
  return state.pending.length < before
}

// Explicit dashboard Unpair → back to pairing mode (pending stays empty; a fresh /start re-pends).
export function unpair(state) {
  const had = !!state.pinned
  state.pinned = null
  return had
}

// Pre-pin a chat_id from `.env MRC_TELEGRAM_CHAT_ID` (optional zero-window override; skips pairing).
// We only have the id up front (no username/name until they message), which is fine — it's an
// operator-set trust anchor.
export function prePin(state, chatId, fromId, at = 0) {
  state.pinned = { chatId, fromId: fromId ?? chatId, username: null, firstName: null, lastName: null, at, prePinned: true }
  state.pending = []
  return state.pinned
}

// What the dashboard shows for an org's Telegram link: configured?/linked?/pending list.
export function tgView(state) {
  return {
    configured: !!state?.token,
    pinned: state?.pinned ? { chatId: state.pinned.chatId, fromId: state.pinned.fromId, username: state.pinned.username, firstName: state.pinned.firstName, lastName: state.pinned.lastName, prePinned: !!state.pinned.prePinned } : null,
    pending: (state?.pending || []).map((p) => ({ fromId: p.fromId, username: p.username, firstName: p.firstName, lastName: p.lastName, chatId: p.chatId })),
    lastPushError: state?.lastPushError || null,   // last outbound push failure (so the dashboard surfaces it, not just the log)
    warning: state?.warning || null,               // config problem surfaced before it churns (e.g. a token shared by 2 orgs)
  }
}
