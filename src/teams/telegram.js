// Telegram transport (#12) — a per-org long-poll bridge between a project's bot and the @user inbox.
// All HTTP I/O is injected (fetchFn) so the poll loop, offset/dedup, parsing, and message shaping are
// unit-testable offline; the daemon supplies the real fetch + persistence. The bot token is HOST-SIDE
// ONLY (loaded from the repo .env by the daemon) — it never enters a container.
//
// Security/correctness invariants this layer enforces or surfaces (gated by the daemon on top):
//  • strict bot↔org binding: a token belongs to ONE org; updates from it are only ever routed to that
//    org (the daemon keys pollers by org and never cross-routes).
//  • one bot per org: Telegram returns 409 if a second getUpdates runs for the same token — surfaced
//    as a clear error, not a silent stall.
//  • offset advances ONLY past updates we hand off, so a crash mid-batch re-delivers rather than drops;
//    update_id dedup guards re-delivery.
//  • we request `allowed_updates=["message"]` — no inline/callback surface to validate.
// Inbound trust (strict from.id allowlist, group rejection, pending/pinned gating) lives in the daemon
// onboarding layer (#12 step 3); this module just shapes the raw update faithfully (incl. chat type +
// full from identity) so that layer can decide.

const api = (token, method) => `https://api.telegram.org/bot${encodeURIComponent(token)}/${method}`

// One getUpdates round. Returns { offset, messages, error } — `offset` is the next offset to poll
// with (advanced past every update seen this round, processed or skipped, so we never reread them),
// `messages` are the shaped message updates, `error` is set (and offset unchanged) on any failure.
export async function pollOnce({ token, offset = 0, fetchFn = globalThis.fetch, timeout = 25 } = {}) {
  let res
  try {
    res = await fetchFn(`${api(token, 'getUpdates')}?offset=${offset}&timeout=${timeout}&allowed_updates=${encodeURIComponent('["message"]')}`)
  } catch (e) { return { offset, messages: [], error: `network: ${e?.message || e}` } }
  if (res.status === 409) return { offset, messages: [], error: 'conflict: another getUpdates is running for this token (one bot per org)', conflict: true }
  if (res.status === 401) return { offset, messages: [], error: 'unauthorized: bad bot token', fatal: true }
  let j
  try { j = await res.json() } catch { return { offset, messages: [], error: 'bad telegram response' } }
  if (!j || !j.ok) return { offset, messages: [], error: `telegram: ${j?.description || 'error'}` }
  const updates = Array.isArray(j.result) ? j.result : []
  let next = offset
  const messages = []
  for (const u of updates) {
    next = Math.max(next, (u.update_id || 0) + 1)   // advance past EVERY update seen (incl. skipped ones)
    const m = u.message
    if (!m || !m.from) continue
    messages.push(shapeMessage(u.update_id, m))
  }
  return { offset: next, messages }
}

// Faithful, minimal shape of a message update — includes chat.type (so the daemon can REJECT groups)
// and the full from identity (id + username + first/last name, for the pairing-confirm display + the
// strict from.id check). No trust decision here.
export function shapeMessage(updateId, m) {
  return {
    updateId,
    messageId: m.message_id,
    chatId: m.chat?.id ?? null,
    chatType: m.chat?.type || null,            // 'private' | 'group' | 'supergroup' | 'channel'
    from: {
      id: m.from?.id ?? null,
      username: m.from?.username || null,
      firstName: m.from?.first_name || null,
      lastName: m.from?.last_name || null,
    },
    text: String(m.text ?? ''),
    replyToMessageId: m.reply_to_message?.message_id ?? null,   // links a reply back to a pushed question
    date: m.date || null,
  }
}

// `/start` (optionally "/start payload") — the only command the bot honors while unpaired.
export function isStart(text) { return /^\/start(?:\s|@|$)/i.test(String(text || '').trim()) }

export async function sendMessage({ token, chatId, text, replyMarkup, fetchFn = globalThis.fetch } = {}) {
  let res
  try {
    res = await fetchFn(api(token, 'sendMessage'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: String(text ?? ''), ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }),
    })
  } catch (e) { return { ok: false, error: `network: ${e?.message || e}` } }
  let j
  try { j = await res.json() } catch { return { ok: false, error: 'bad telegram response' } }
  return j?.ok ? { ok: true, messageId: j.result?.message_id } : { ok: false, error: j?.description || 'send failed' }
}

// Edit a previously-pushed message in place (H4 cross-surface sync: when a question is answered/
// dismissed from any surface, its Telegram message updates to reflect the resolution).
export async function editMessageText({ token, chatId, messageId, text, fetchFn = globalThis.fetch } = {}) {
  let res
  try {
    res = await fetchFn(api(token, 'editMessageText'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: String(text ?? '') }),
    })
  } catch (e) { return { ok: false, error: `network: ${e?.message || e}` } }
  let j
  try { j = await res.json() } catch { return { ok: false, error: 'bad telegram response' } }
  return j?.ok ? { ok: true } : { ok: false, error: j?.description || 'edit failed' }
}

// Drives the long-poll loop for ONE org's bot — the per-org lifecycle. Everything external is
// injected: persistence (getOffset/setOffset), the handoff (onMessages), timers (schedule), fetch.
//   • ADVANCE-ONLY-AFTER-SUCCESS: the offset is persisted ONLY after onMessages resolves, so a crash
//     mid-batch re-delivers rather than drops (at-least-once; dedup is the caller's via update/msg id).
//   • 409 (another poller on this token) → back off and retry, never advance — the other instance wins
//     until it stops; one bot per org.
//   • 401/fatal → long back-off (bad token; surfaced once, not hot-looped).
//   • stop() is idempotent and halts the loop (daemon calls it on removeOrg / shutdown / before a
//     version-refresh restart, so there's never a double poller on one token).
export function createTelegramBridge({ token, org, fetchFn = globalThis.fetch, getOffset, setOffset, onMessages, log = () => {}, idleMs = 800, longPoll = 25, fatalMs = 60000, schedule } = {}) {
  let stopped = false, timer = null
  const sched = schedule || ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t })
  // One poll→handoff→persist cycle. Returns the backoff (ms) before the next tick. Exposed for tests.
  async function tickOnce() {
    const offset = (await getOffset()) || 0
    const r = await pollOnce({ token, offset, fetchFn, timeout: longPoll })
    if (r.error) { log(`[tg ${org}] ${r.error}`); return r.fatal ? fatalMs : (r.conflict ? 5000 : 1000) }
    if (r.messages.length) {
      try { await onMessages(r.messages) }
      catch (e) { log(`[tg ${org}] handoff failed (will re-deliver): ${e?.message || e}`); return 1000 }   // do NOT advance
    }
    if (r.offset !== offset) await setOffset(r.offset)   // advance ONLY after a successful handoff
    return 0
  }
  async function loop() {
    if (stopped) return
    let backoff = idleMs
    try { backoff = await tickOnce() } catch (e) { log(`[tg ${org}] loop error: ${e?.message || e}`); backoff = 2000 }
    if (!stopped) timer = sched(loop, backoff)
  }
  return {
    start() { if (!timer && !stopped) loop() },
    stop() { stopped = true; if (timer) { clearTimeout(timer); timer = null } },
    tickOnce,
  }
}

// Validate a token + fetch the bot identity (used to confirm a token works + show the bot @username in
// the pairing instructions). Returns { ok, bot:{id,username,firstName} } | { ok:false, error }.
export async function getMe({ token, fetchFn = globalThis.fetch } = {}) {
  let res
  try { res = await fetchFn(api(token, 'getMe')) } catch (e) { return { ok: false, error: `network: ${e?.message || e}` } }
  let j
  try { j = await res.json() } catch { return { ok: false, error: 'bad telegram response' } }
  if (!j?.ok) return { ok: false, error: j?.description || 'getMe failed' }
  return { ok: true, bot: { id: j.result?.id, username: j.result?.username || null, firstName: j.result?.first_name || null } }
}
