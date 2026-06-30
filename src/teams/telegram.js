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
// #22: the retry backoff sleep — UNREF'd so a pending retry never keeps the host process alive (matches the
// bridge's unref'd schedule). Injectable in the send fns so tests don't actually wait.
const defaultSleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.() })

// #22: Telegram caps a single message at 4096 chars (UTF-16 code units). A longer @user push used to FAIL the
// whole send ("message is too long"); truncate it to fit with a pointer instead, so the notification still
// ARRIVES (the full text is in the dashboard). One message, not a noisy multi-part chunk — this is a
// notification bridge, the dashboard is the system of record.
export const TG_TEXT_MAX = 4096
const TG_TRUNC_MARK = '\n\n… (truncated — full text in the dashboard)'
export function clampTgText(text) {
  const s = String(text ?? '')
  if (s.length <= TG_TEXT_MAX) return s
  return s.slice(0, TG_TEXT_MAX - TG_TRUNC_MARK.length) + TG_TRUNC_MARK
}
// #22: classify a send/edit failure so the CALLER surfaces an ACCURATE message instead of a blanket "re-link":
//  • fatal     → an AUTH failure (401 bad token) — re-pairing is the right fix
//  • transient → network / 5xx / 429 — RETRY; do NOT tell the user to re-pair (it's not their pairing)
//  • retryAfter → Telegram's 429 backoff window (seconds), so the caller waits the amount Telegram asked
// Anything else carries Telegram's own `description` verbatim (e.g. "chat not found"), not a generic re-link.
function classifySend(res, j) {
  const error = j?.description || 'send failed'
  if (res?.status === 401 || res?.status === 403) return { fatal: true, kind: 'auth', error: j?.description || (res.status === 401 ? 'unauthorized: bad bot token' : 'forbidden: the bot was blocked or removed from the chat') }
  if (res?.status === 429) return { transient: true, kind: 'rate-limit', retryAfter: Number(j?.parameters?.retry_after) || 1, error: j?.description || 'rate limited (429)' }
  if (res && res.status >= 500) return { transient: true, kind: 'transient', error: j?.description || `telegram ${res.status}` }
  // #58: flag a parse_mode FORMATTING 400 (a malformed/unsupported HTML entity) so the caller resends PLAIN.
  // Still kind:'other' (accurate "formatting", NOT auth/re-link); only the fallback path keys on `formatting`.
  const formatting = res?.status === 400 && /can't parse entit|unsupported (start |end )?tag|unclosed|can't find end|byte offset|reserved/i.test(error)
  return { kind: 'other', error, ...(formatting ? { formatting: true } : {}) }   // e.g. 400 "chat not found" → accurate cause, NOT auth/re-link
}

// #58: convert a SMALL Markdown subset to TELEGRAM HTML (parse_mode:'HTML'). A SIBLING of safeMD — same cardinal
// rule (escape ALL HTML first, THEN allowlisted transforms on the inert text) — but it emits ONLY the tags
// Telegram supports (<b>/<i>/<u>/<s>/<code>/<pre>/<a>); lists become plain "• " bullets and newlines STAY "\n"
// (Telegram has no <ul>/<br>). Telegram escapes ONLY < > & (not "/' — those are literal in text). Because the
// base text is escaped before any transform, a member writing "<b>x</b>" or a forged tag is inert escaped text;
// transforms add only FIXED tags + an allowlisted href. Output is balanced (complete-pair fires) → valid Telegram
// HTML; a malformed/oversized result 400s and the caller falls back to PLAIN (never lost). ReDoS-bounded (capped).
const TG_HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
const escTgHtml = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => TG_HTML_ESC[c])
const TG_NUL = String.fromCharCode(0)
const TG_NUL_RE = new RegExp(TG_NUL, 'g')
const TG_SLOT_RE = new RegExp(TG_NUL + '(\\d+)' + TG_NUL, 'g')
const TG_CTRL_WS_RE = new RegExp('[' + TG_NUL + '-' + String.fromCharCode(0x20) + ']+', 'g')   // all control + space (0x00..0x20)
// Link only an http/https/mailto url; the url is already <>&-escaped, so add the SCHEME gate (normalize: strip
// control/space + lowercase) and percent-encode a literal " so it can't break out of href="...". Else → null
// (the caller leaves the inert literal "[text](url)").
function tgHref(escapedUrl) {
  const probe = escapedUrl.replace(TG_CTRL_WS_RE, '').toLowerCase()
  const m = probe.match(/^([a-z][a-z0-9+.\-]*):/)
  if (!(m && (m[1] === 'http' || m[1] === 'https' || m[1] === 'mailto'))) return null
  return escapedUrl.replace(/"/g, '%22')
}
export function mdToTelegramHTML(input) {
  let s = String(input == null ? '' : input).replace(TG_NUL_RE, '')      // drop NULs (our slot sentinel)
  if (s.length > TG_TEXT_MAX) s = s.slice(0, TG_TEXT_MAX) + '…'          // bound it (a long result 400s → plain fallback)
  s = escTgHtml(s)                                                        // (1) ESCAPE < > & FIRST — rest transforms inert text
  const slots = []
  const stash = (html) => TG_NUL + (slots.push(html) - 1) + TG_NUL
  // (2) code spans BEFORE other transforms (** / _ / [ ] inside code stay literal); the fenced lang tag is DROPPED
  s = s.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, body) => stash('<pre>' + body + '</pre>'))
  s = s.replace(/`([^`\n]+)`/g, (_, body) => stash('<code>' + body + '</code>'))
  // (3) links [text](url): allowlisted+escaped href, escaped text; a disallowed scheme leaves the inert literal
  s = s.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (m0, text, url) => { const h = tgHref(url); return h ? '<a href="' + h + '">' + text + '</a>' : m0 })
  // (4) bold (** / __) then italic (* / _), each only on a COMPLETE same-line pair → balanced
  s = s.replace(/\*\*([^\n]+?)\*\*/g, '<b>$1</b>')
  s = s.replace(/__([^\n]+?)__/g, '<b>$1</b>')
  s = s.replace(/(^|[^\w*])\*([^*\n]+?)\*(?=[^\w*]|$)/g, '$1<i>$2</i>')
  s = s.replace(/(^|[^\w_])_([^_\n]+?)_(?=[^\w_]|$)/g, '$1<i>$2</i>')
  // (5) "- " / "* " bullet lines → plain "• " (Telegram has no <ul>); newlines STAY "\n" (no <br>). Numbered
  //     "N. " lines are already plain and untouched. Run AFTER italic so a "*text*" isn't seen as a bullet.
  s = s.replace(/^[ \t]*[-*][ \t]+/gm, '• ')
  // (6) restore the stashed code spans verbatim
  return s.replace(TG_SLOT_RE, (_, i) => slots[Number(i)])
}

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
  // #22: honor Telegram's 429 backoff on the poll too — surface retry_after so the bridge waits the asked amount
  // (this is also the proper fix for the old 409-storm class: back off, don't hot-loop).
  if (res.status === 429) { let p = {}; try { p = await res.json() } catch {} return { offset, messages: [], error: 'rate limited (429)', retryAfter: Number(p?.parameters?.retry_after) || 1, transient: true } }
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

// #22: split a >4096 body into ≤4096 chunks on a natural boundary (last newline, else last space, else hard
// cut) so a long @you item is delivered in full across sequential messages rather than failing or truncating.
export function splitTgText(text, max = TG_TEXT_MAX) {
  const s = String(text ?? '')
  if (s.length <= max) return [s]
  const out = []
  let rest = s
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max)
    if (cut < max * 0.6) cut = rest.lastIndexOf(' ', max)   // don't honor a too-early newline; prefer a late space
    if (cut < max * 0.6) cut = max                          // no good boundary → hard cut
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\s+/, '')
  }
  if (rest.length) out.push(rest)
  return out
}

// One sendMessage attempt-with-retry: honors a 429 `retry_after` (waits the amount Telegram asked, BOUNDED
// retries) and clamps text to the 4096 limit as a safety floor. Returns the classified result (#22) so the
// caller surfaces an accurate message (transient/retryAfter/fatal) rather than a blanket "re-link".
export async function sendMessage({ token, chatId, text, replyMarkup, parseMode, fetchFn = globalThis.fetch, maxRetries = 2, sleep = defaultSleep } = {}) {
  const body = JSON.stringify({ chat_id: chatId, text: clampTgText(text), ...(replyMarkup ? { reply_markup: replyMarkup } : {}), ...(parseMode ? { parse_mode: parseMode } : {}) })
  for (let attempt = 0; ; attempt++) {
    let res
    try { res = await fetchFn(api(token, 'sendMessage'), { method: 'POST', headers: { 'content-type': 'application/json' }, body }) }
    catch (e) { if (attempt < maxRetries) { await sleep(1000); continue } return { ok: false, transient: true, kind: 'transient', error: `network: ${e?.message || e}` } }   // network blip → bounded retry
    let j
    try { j = await res.json() } catch { return { ok: false, transient: true, kind: 'transient', error: 'bad telegram response' } }
    if (j?.ok) return { ok: true, messageId: j.result?.message_id }
    const c = classifySend(res, j)
    // retry the TRANSIENT classes (429 → wait Telegram's retry_after; 5xx → short backoff), bounded; auth/other don't retry
    if ((c.retryAfter || c.transient) && attempt < maxRetries) { await sleep((c.retryAfter ? Math.min(c.retryAfter, 60) : 1) * 1000); continue }
    return { ok: false, ...c }
  }
}

// #22: send a long @you body in full as ≤4096 chunks, sequentially. Returns the FIRST message's id (the one the
// caller pins for the H4 resolve-edit; continuations are extra context). Stops + reports on the first failure so
// nothing's silently dropped, and the classified error (transient/fatal/retryAfter) rides up.
export async function sendMessageChunked({ token, chatId, text, replyMarkup, fetchFn = globalThis.fetch, maxRetries = 2, sleep } = {}) {
  const parts = splitTgText(text)
  let firstId = null
  for (let i = 0; i < parts.length; i++) {
    const r = await sendMessage({ token, chatId, text: parts[i], replyMarkup: i === 0 ? replyMarkup : undefined, fetchFn, maxRetries, sleep })
    if (!r.ok) return { ok: false, ...r, messageId: firstId, sent: i }   // partial: report what failed, keep the first id for an edit
    if (i === 0) firstId = r.messageId
  }
  return { ok: true, messageId: firstId, parts: parts.length }
}

// Edit a previously-pushed message in place (H4 cross-surface sync: when a question is answered/
// dismissed from any surface, its Telegram message updates to reflect the resolution).
export async function editMessageText({ token, chatId, messageId, text, parseMode, fetchFn = globalThis.fetch, maxRetries = 2, sleep = defaultSleep } = {}) {
  const body = JSON.stringify({ chat_id: chatId, message_id: messageId, text: clampTgText(text), ...(parseMode ? { parse_mode: parseMode } : {}) })
  for (let attempt = 0; ; attempt++) {
    let res
    try { res = await fetchFn(api(token, 'editMessageText'), { method: 'POST', headers: { 'content-type': 'application/json' }, body }) }
    catch (e) { return { ok: false, transient: true, error: `network: ${e?.message || e}` } }
    let j
    try { j = await res.json() } catch { return { ok: false, transient: true, error: 'bad telegram response' } }
    if (j?.ok) return { ok: true }
    const c = classifySend(res, j)
    if (c.retryAfter && attempt < maxRetries) { await sleep(Math.min(c.retryAfter, 60) * 1000); continue }
    return { ok: false, ...c }
  }
}

// #56: send an image to a chat as multipart/form-data. Telegram caps sendPhoto at 10MB; a larger image
// transparently falls back to sendDocument (50MB cap) so the asset still ARRIVES (as a file) rather than
// silently failing; past 50MB it's rejected with a clear error. caption is optional (already defanged +
// length-capped by the caller — this layer is transport only). A 429 returns { ok:false, retryAfter } so
// the caller can honor Telegram's backoff window (ties to #22) instead of hammering.
const TG_PHOTO_MAX = 10 * 1024 * 1024
const TG_DOC_MAX = 50 * 1024 * 1024
export async function sendPhoto({ token, chatId, photo, filename = 'image', caption, fetchFn = globalThis.fetch } = {}) {
  const bytes = Buffer.isBuffer(photo) ? photo : Buffer.from(photo || [])
  if (!bytes.length) return { ok: false, error: 'empty image' }
  if (bytes.length > TG_DOC_MAX) return { ok: false, error: `image too large: ${(bytes.length / 1048576).toFixed(1)}MB exceeds Telegram's 50MB cap` }
  const asDoc = bytes.length > TG_PHOTO_MAX            // >10MB can't go as a photo; send as a document instead
  const method = asDoc ? 'sendDocument' : 'sendPhoto'
  let res
  try {
    const form = new FormData()
    form.append('chat_id', String(chatId))
    if (caption != null && String(caption).length) form.append('caption', String(caption))
    form.append(asDoc ? 'document' : 'photo', new Blob([bytes]), filename)
    res = await fetchFn(api(token, method), { method: 'POST', body: form })   // fetch sets the multipart boundary
  } catch (e) { return { ok: false, error: `network: ${e?.message || e}` } }
  let j
  try { j = await res.json() } catch { return { ok: false, error: 'bad telegram response' } }
  if (j?.ok) return { ok: true, messageId: j.result?.message_id, asDocument: asDoc }
  return { ok: false, ...classifySend(res, j) }   // #22: 401→fatal, 429→retryAfter+transient, 5xx→transient, else the verbatim description
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
    if (r.error) { log(`[tg ${org}] ${r.error}`); return r.retryAfter ? Math.min(r.retryAfter, 60) * 1000 : r.fatal ? fatalMs : r.conflict ? 5000 : 1000 }   // #22: back off by Telegram's retry_after on 429
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
