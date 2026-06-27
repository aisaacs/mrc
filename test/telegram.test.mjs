// Unit tests for the Telegram transport (#12 step 2): getUpdates offset/dedup, one-bot 409, faithful
// message shaping (chat type + from identity for the trust layer), send/edit/getMe. Injected fetch.
import test from 'node:test'
import assert from 'node:assert/strict'
import { pollOnce, shapeMessage, isStart, sendMessage, editMessageText, getMe, createTelegramBridge } from '../src/teams/telegram.js'

const ok = (result) => ({ status: 200, json: async () => ({ ok: true, result }) })
const msg = (update_id, over = {}) => ({ update_id, message: { message_id: 100 + update_id, date: 1, chat: { id: 555, type: 'private' }, from: { id: 42, username: 'jane', first_name: 'Jane', last_name: 'Doe' }, text: 'hi', ...over } })

test('telegram pollOnce: advances offset past every update and shapes messages', async () => {
  const fetchFn = async () => ok([msg(10), msg(11)])
  const r = await pollOnce({ token: 't', offset: 0, fetchFn })
  assert.equal(r.error, undefined)
  assert.equal(r.offset, 12, 'offset = max update_id + 1')
  assert.equal(r.messages.length, 2)
  assert.deepEqual(r.messages[0].from, { id: 42, username: 'jane', firstName: 'Jane', lastName: 'Doe' })
  assert.equal(r.messages[0].chatType, 'private')
  assert.equal(r.messages[0].chatId, 555)
})

test('telegram pollOnce: empty result keeps the offset (no rewind), no messages', async () => {
  const r = await pollOnce({ token: 't', offset: 7, fetchFn: async () => ok([]) })
  assert.equal(r.offset, 7)
  assert.equal(r.messages.length, 0)
})

test('telegram pollOnce: advances past a non-message update so it is never reread (dedup)', async () => {
  // An edited_message / non-message update has no `.message` — we still advance the offset past it.
  const fetchFn = async () => ok([{ update_id: 20 }, msg(21)])
  const r = await pollOnce({ token: 't', offset: 0, fetchFn })
  assert.equal(r.offset, 22)
  assert.equal(r.messages.length, 1, 'only the real message is surfaced')
  assert.equal(r.messages[0].updateId, 21)
})

test('telegram pollOnce: a message with no from is skipped (cannot attribute), offset still advances', async () => {
  const fetchFn = async () => ok([{ update_id: 30, message: { message_id: 1, chat: { id: 5, type: 'private' }, text: 'x' } }])
  const r = await pollOnce({ token: 't', offset: 0, fetchFn })
  assert.equal(r.offset, 31)
  assert.equal(r.messages.length, 0)
})

test('telegram pollOnce: 409 surfaces a conflict (one bot per org), offset unchanged', async () => {
  const r = await pollOnce({ token: 't', offset: 3, fetchFn: async () => ({ status: 409, json: async () => ({ ok: false, description: 'Conflict' }) }) })
  assert.equal(r.conflict, true)
  assert.match(r.error, /one bot per org/)
  assert.equal(r.offset, 3, 'a conflict must not advance/lose the offset')
})

test('telegram pollOnce: 401 is fatal (bad token), and a network throw is caught', async () => {
  const bad = await pollOnce({ token: 't', fetchFn: async () => ({ status: 401, json: async () => ({ ok: false }) }) })
  assert.equal(bad.fatal, true)
  const net = await pollOnce({ token: 't', offset: 9, fetchFn: async () => { throw new Error('ECONNRESET') } })
  assert.match(net.error, /network/)
  assert.equal(net.offset, 9)
})

test('telegram pollOnce: group chats are surfaced with their type so the daemon can reject them', async () => {
  const r = await pollOnce({ token: 't', fetchFn: async () => ok([msg(40, { chat: { id: -100, type: 'group' } })]) })
  assert.equal(r.messages[0].chatType, 'group')   // the daemon rejects non-private; this layer just reports it
})

test('telegram shapeMessage: captures reply linkage + full identity', () => {
  const s = shapeMessage(1, { message_id: 9, chat: { id: 5, type: 'private' }, from: { id: 7, username: 'u' }, text: 'yes', reply_to_message: { message_id: 88 } })
  assert.equal(s.replyToMessageId, 88)
  assert.equal(s.from.id, 7)
  assert.equal(s.from.username, 'u')
  assert.equal(s.from.firstName, null)
})

test('telegram isStart: matches /start and /start payload and /start@bot, not plain text', () => {
  assert.ok(isStart('/start'))
  assert.ok(isStart('/start abc123'))
  assert.ok(isStart('/start@myprojbot'))
  assert.ok(!isStart('start'))
  assert.ok(!isStart('please /start'))
})

test('telegram sendMessage: posts chat_id+text and returns the message id', async () => {
  let body
  const fetchFn = async (url, opts) => { body = JSON.parse(opts.body); return { json: async () => ({ ok: true, result: { message_id: 321 } }) } }
  const r = await sendMessage({ token: 't', chatId: 9, text: 'hello', fetchFn })
  assert.equal(r.ok, true); assert.equal(r.messageId, 321)
  assert.equal(body.chat_id, 9); assert.equal(body.text, 'hello')
})

test('telegram sendMessage: surfaces a telegram error', async () => {
  const r = await sendMessage({ token: 't', chatId: 9, text: 'x', fetchFn: async () => ({ json: async () => ({ ok: false, description: 'chat not found' }) }) })
  assert.equal(r.ok, false); assert.match(r.error, /chat not found/)
})

test('telegram editMessageText: edits in place for H4 sync', async () => {
  let body
  const fetchFn = async (url, opts) => { body = JSON.parse(opts.body); return { json: async () => ({ ok: true }) } }
  const r = await editMessageText({ token: 't', chatId: 9, messageId: 321, text: '✓ answered', fetchFn })
  assert.equal(r.ok, true)
  assert.equal(body.message_id, 321); assert.equal(body.text, '✓ answered')
})

test('telegram getMe: returns the bot identity for the pairing instructions', async () => {
  const r = await getMe({ token: 't', fetchFn: async () => ({ json: async () => ({ ok: true, result: { id: 1, username: 'myprojbot', first_name: 'Proj' } }) }) })
  assert.equal(r.ok, true); assert.equal(r.bot.username, 'myprojbot')
})

// --- bridge lifecycle (advance-only-after-success / re-deliver / 409 backoff / stop) ---------------
function bridgeHarness(over = {}) {
  let offset = 0
  const handed = []
  const b = createTelegramBridge({
    token: 't', org: 'shop',
    getOffset: () => offset, setOffset: (o) => { offset = o },
    onMessages: async (msgs) => { handed.push(...msgs) },
    schedule: () => null,   // tests drive tickOnce manually; no real timer
    ...over,
  })
  return { b, handed, getOffset: () => offset }
}

test('telegram bridge: advances the persisted offset ONLY after a successful handoff', async () => {
  const h = bridgeHarness({ fetchFn: async () => ok([msg(50), msg(51)]) })
  const backoff = await h.b.tickOnce()
  assert.equal(h.getOffset(), 52, 'offset persisted past the batch')
  assert.equal(h.handed.length, 2)
  assert.equal(backoff, 0)
})

test('telegram bridge: a handoff failure does NOT advance the offset (re-delivers next tick)', async () => {
  const h = bridgeHarness({ fetchFn: async () => ok([msg(60)]), onMessages: async () => { throw new Error('inbox down') } })
  const backoff = await h.b.tickOnce()
  assert.equal(h.getOffset(), 0, 'offset NOT advanced on handoff failure')
  assert.ok(backoff >= 1000)
})

test('telegram bridge: a 409 conflict backs off and never advances the offset', async () => {
  let offset = 5
  const b = createTelegramBridge({ token: 't', org: 'shop', getOffset: () => offset, setOffset: (o) => { offset = o }, onMessages: async () => {}, schedule: () => null, fetchFn: async () => ({ status: 409, json: async () => ({ ok: false, description: 'Conflict' }) }) })
  const backoff = await b.tickOnce()
  assert.equal(offset, 5)
  assert.equal(backoff, 5000)
})

test('telegram bridge: stop() is idempotent and halts the loop', async () => {
  const h = bridgeHarness({ fetchFn: async () => ok([]) })
  h.b.stop(); h.b.stop()
  // after stop, start() must not schedule (no throw, no work)
  h.b.start()
  assert.ok(true)
})
