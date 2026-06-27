// Unit tests for the Telegram pairing + inbound-trust state machine (#12 step 3 security core):
// group rejection, inert-until-pinned, /start→pending (no auto-bind), confirm/reject/unpair, strict
// from.id once pinned, update_id dedup, .env pre-pin. This is the from.id trust boundary — gated here.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  freshTgState, classifyInbound, addPending, confirmPending, rejectPending, unpair, prePin, tgView,
  isDuplicateUpdate, markUpdateProcessed,
} from '../src/teams/telegram-auth.js'

const m = (over = {}) => ({ updateId: 1, messageId: 9, chatId: 555, chatType: 'private', from: { id: 42, username: 'jane', firstName: 'Jane', lastName: 'Doe' }, text: 'hi', replyToMessageId: null, ...over })

test('tg-auth: a group/supergroup/channel message is rejected, never binds', () => {
  const s = freshTgState()
  for (const t of ['group', 'supergroup', 'channel']) {
    assert.equal(classifyInbound(s, m({ chatType: t, text: '/start' })).kind, 'reject-group')
  }
  assert.equal(s.pinned, null)
  assert.equal(s.pending.length, 0)
  // default-deny: an absent/null chatType also fails closed (malformed update never reaches pairing)
  assert.equal(classifyInbound(s, m({ chatType: null, text: '/start' })).kind, 'reject-group')
  assert.equal(classifyInbound(s, m({ chatType: undefined, text: '/start' })).kind, 'reject-group')
})

test('tg-auth: unpaired — /start records a pending candidate (no auto-bind), other text stays silent', () => {
  const s = freshTgState()
  const d = classifyInbound(s, m({ text: '/start' }))
  assert.equal(d.kind, 'pair-start')
  assert.equal(d.candidate.fromId, 42)
  addPending(s, d.candidate, 100)
  assert.equal(s.pinned, null, 'a /start does NOT bind — no TOFU race')
  assert.equal(s.pending.length, 1)
  // a non-/start message while unpaired → silent, no pending
  assert.equal(classifyInbound(s, m({ text: 'hello?' })).kind, 'pairing-idle')
})

test('tg-auth: pending dedups by from.id (a second /start refreshes, does not duplicate)', () => {
  const s = freshTgState()
  assert.equal(addPending(s, { fromId: 42, username: 'jane' }, 1), true)
  assert.equal(addPending(s, { fromId: 42, username: 'jane2' }, 2), false)
  assert.equal(s.pending.length, 1)
  assert.equal(s.pending[0].username, 'jane2', 'fields refreshed')
  assert.equal(addPending(s, { fromId: 99 }, 3), true)
  assert.equal(s.pending.length, 2)
})

test('tg-auth: confirm pins the chosen from.id+chat.id and clears ALL other pendings (race)', () => {
  const s = freshTgState()
  addPending(s, { fromId: 42, chatId: 555, username: 'jane' })
  addPending(s, { fromId: 7, chatId: 13, username: 'attacker' })   // raced a /start first
  const pinned = confirmPending(s, 42, 1000)
  assert.equal(pinned.fromId, 42)
  assert.equal(pinned.chatId, 555)
  assert.equal(s.pending.length, 0, 'the attacker pending is cleared on confirm')
})

test('tg-auth: once pinned, only the pinned from.id+chat.id is authorized; others dropped', () => {
  const s = freshTgState()
  addPending(s, { fromId: 42, chatId: 555 }); confirmPending(s, 42)
  // the pinned user, in the pinned chat → authorized, text routed
  const ok = classifyInbound(s, m({ from: { id: 42 }, chatId: 555, text: 'inline please', replyToMessageId: 88 }))
  assert.equal(ok.kind, 'authorized'); assert.equal(ok.text, 'inline please'); assert.equal(ok.replyToMessageId, 88)
  // a DIFFERENT from.id (even in the same chat) → unauthorized, dropped
  assert.equal(classifyInbound(s, m({ from: { id: 999 }, chatId: 555 })).kind, 'unauthorized')
  // the right from.id but a DIFFERENT chat → unauthorized (no binding leak)
  assert.equal(classifyInbound(s, m({ from: { id: 42 }, chatId: 111 })).kind, 'unauthorized')
})

test('tg-auth: a /start AFTER pinning never re-binds (captured id not silently overwritten)', () => {
  const s = freshTgState()
  addPending(s, { fromId: 42, chatId: 555 }); confirmPending(s, 42)
  // an attacker /starts after the legit user is pinned
  const d = classifyInbound(s, m({ from: { id: 7 }, chatId: 13, text: '/start' }))
  assert.equal(d.kind, 'unauthorized', 'post-pin /start from another id is just an unauthorized message')
  assert.equal(addPending(s, { fromId: 7, chatId: 13 }), false, 'addPending is a no-op once pinned')
  assert.equal(s.pinned.fromId, 42, 'pin unchanged')
})

test('tg-auth: unpair returns to pairing mode; reject removes a pending', () => {
  const s = freshTgState()
  addPending(s, { fromId: 42 }); addPending(s, { fromId: 7 })
  assert.equal(rejectPending(s, 7), true)
  assert.equal(s.pending.length, 1)
  confirmPending(s, 42)
  assert.equal(unpair(s), true)
  assert.equal(s.pinned, null)
  // a fresh /start can re-pend now
  assert.equal(classifyInbound(s, m({ text: '/start' })).kind, 'pair-start')
})

test('tg-auth: .env pre-pin binds without pairing (zero-window override)', () => {
  const s = freshTgState()
  prePin(s, 555)
  assert.equal(s.pinned.chatId, 555)
  assert.equal(s.pinned.prePinned, true)
  assert.equal(classifyInbound(s, m({ from: { id: 555 }, chatId: 555 })).kind, 'authorized')
})

test('tg-auth: update_id dedup — an id at/below the high-water-mark is a duplicate (no double-inject)', () => {
  const s = freshTgState()
  assert.equal(isDuplicateUpdate(s, 10), false)
  markUpdateProcessed(s, 10)
  assert.equal(isDuplicateUpdate(s, 10), true, 'same id → duplicate (re-delivered batch)')
  assert.equal(isDuplicateUpdate(s, 9), true, 'older id → duplicate')
  assert.equal(isDuplicateUpdate(s, 11), false, 'newer id → fresh')
  markUpdateProcessed(s, 11)
  assert.equal(s.maxUpdateId, 11)
})

test('tg-auth: tgView surfaces username+name+id for the pending confirm (real-account verification)', () => {
  const s = freshTgState(); s.token = 'x'
  addPending(s, { fromId: 42, chatId: 555, username: 'jane', firstName: 'Jane', lastName: 'Doe' })
  const v = tgView(s)
  assert.equal(v.configured, true)
  assert.equal(v.pinned, null)
  assert.deepEqual(v.pending[0], { fromId: 42, username: 'jane', firstName: 'Jane', lastName: 'Doe', chatId: 555 })
})
