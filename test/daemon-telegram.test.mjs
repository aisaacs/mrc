// Integration test for the LIVE Telegram inbound path through the daemon (#12 step 3): token
// discovery → bridge → classify→execute (pending/confirm/authorized/unauthorized) + update_id dedup,
// with an injected fetch standing in for Telegram. The trust gate (from.id) is exercised end-to-end.
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import { startRoomDaemon } from '../src/proxies/room-daemon.js'
import { findFreePort } from '../src/ports.js'
import { parseRoster, leadsRoomId } from '../src/teams/roster.js'
import { memberSessionId } from '../src/teams/session-id.js'

const TMP_HOME = fs.mkdtempSync(`${os.tmpdir()}/mrc-tg-`)
process.env.HOME = TMP_HOME
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function controlCall(port, frame) {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, '127.0.0.1', () => c.write(JSON.stringify(frame) + '\n'))
    let buf = ''
    c.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { try { resolve(JSON.parse(buf.slice(0, i))) } catch (e) { reject(e) } c.end() } })
    c.on('error', reject)
    setTimeout(() => reject(new Error('control timeout')), 2000)
  })
}

// A scripted Telegram: getUpdates returns queued batches once, then empties; sends are recorded.
function fakeTelegram() {
  const queue = []           // arrays of updates, drained one getUpdates at a time
  const sent = [], edits = []
  let nextMsgId = 1000
  const fetchFn = async (url, opts) => {
    if (String(url).includes('/getUpdates')) {
      const batch = queue.shift() || []
      return { status: 200, json: async () => ({ ok: true, result: batch }) }
    }
    if (String(url).includes('/sendMessage')) { const b = JSON.parse(opts.body); const message_id = ++nextMsgId; sent.push({ ...b, message_id }); return { json: async () => ({ ok: true, result: { message_id } }) } }
    if (String(url).includes('/editMessageText')) { edits.push(JSON.parse(opts.body)); return { json: async () => ({ ok: true, result: {} }) } }
    return { status: 200, json: async () => ({ ok: true, result: {} }) }
  }
  return { queue, sent, edits, fetchFn }
}
const upd = (id, from, text, over = {}) => ({ update_id: id, message: { message_id: id, date: 1, chat: { id: from, type: 'private' }, from: { id: from, username: 'u' + from, first_name: 'F' + from }, text, ...over } })

test('daemon telegram: /start → pending → dashboard confirm → linked; authorized injects, others dropped', async () => {
  process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/mrc-tgiso-`)   // isolate the rooms store per test (no cross-test org/tg-state leak)
  const port = await findFreePort(19300)
  const controlPort = await findFreePort(port + 1)
  const tg = fakeTelegram()
  const daemon = startRoomDaemon({ port, controlPort, notifyPort: 0, version: 'test', idleMs: 9e9, tickMs: 9e9, turnCap: 100, workerInvoke: async () => ({ text: '' }), tgFetch: tg.fetchFn, tgToken: { anigame: 'BOT:TOKEN', shop: 'BOT:TOKEN', doomed: 'BOT:TOKEN' } })

  // Spy the leads-room inject so we can PROVE the negative (zero injects on unauthorized/duplicate),
  // not just "pin unchanged / no crash" — this is the trusted-injection regression guard.
  let injects = 0
  const origSteer = daemon.engine.doSteer
  daemon.engine.doSteer = (...a) => { injects++; return origSteer.apply(daemon.engine, a) }

  const norm = parseRoster({ org: 'anigame', repo: TMP_HOME, teams: [{ name: 'core', members: [
    { role: 'architect', backend: 'claude', name: 'roland', lead: true },
  ] }] }, {})
  await controlCall(controlPort, { action: 'defineOrg', def: { org: norm.org, repo: norm.repo, members: norm.members, rooms: norm.rooms } })

  // 1) A /start from user 555 → recorded as pending, bot replies the pairing welcome, NOT bound.
  tg.queue.push([upd(1, 555, '/start')])
  await sleep(250)
  let view = (await controlCall(controlPort, { action: 'team' })).telegram.anigame
  assert.equal(view.configured, true)
  assert.equal(view.pinned, null, 'a /start does not auto-bind')
  assert.equal(view.pending.length, 1)
  assert.equal(view.pending[0].fromId, 555)
  assert.ok(tg.sent.some((m) => /Confirm this chat/.test(m.text)), 'pairing welcome sent')

  // 2) An attacker /start (id 999) races in → a second pending, still no bind.
  tg.queue.push([upd(2, 999, '/start')])
  await sleep(200)
  view = (await controlCall(controlPort, { action: 'team' })).telegram.anigame
  assert.equal(view.pending.length, 2)

  // 3) Human confirms 555 on the dashboard → pinned, attacker pending cleared, linked msg sent.
  const conf = await controlCall(controlPort, { action: 'tgconfirm', org: 'anigame', fromId: 555 })
  assert.equal(conf.ok, true)
  assert.equal(conf.view.pinned.fromId, 555)
  assert.equal(conf.view.pending.length, 0, 'attacker pending cleared on confirm')

  // 4) The pinned user (555, right chat) sends a message → EXACTLY ONE leads-room inject.
  tg.queue.push([upd(3, 555, 'ship the candy theme')])
  await sleep(200)
  assert.equal(injects, 1, 'authorized message → exactly one inject')

  // 5) The attacker (999) sends a message → dropped, ZERO additional inject.
  tg.queue.push([upd(4, 999, 'rm -rf prod')])
  await sleep(200)
  assert.equal(injects, 1, 'unauthorized message injected NOTHING')

  // 6) Right from.id (555) but WRONG chat.id → unauthorized, ZERO additional inject (belt-and-suspenders).
  tg.queue.push([upd(5, 555, 'sneaky', { chat: { id: 7777, type: 'private' } })])
  await sleep(200)
  assert.equal(injects, 1, 'right id + wrong chat injected NOTHING')

  // 7) update_id dedup: re-deliver update 3 (already processed) → ZERO additional inject.
  tg.queue.push([upd(3, 555, 'ship the candy theme')])
  await sleep(200)
  assert.equal(injects, 1, 'duplicate update_id did NOT double-inject')

  // 8) A fresh authorized message DOES inject (proves the counter isn't simply stuck).
  tg.queue.push([upd(6, 555, 'and the acorn piece')])
  await sleep(200)
  assert.equal(injects, 2, 'a new authorized message increments the inject count')

  assert.equal((await controlCall(controlPort, { action: 'team' })).telegram.anigame.pinned.fromId, 555)
  daemon.stop()
})

test('daemon telegram step 4: question→push, reply→answer + H4 edit, stale reply, notification not pushed', async () => {
  process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/mrc-tgiso-`)   // isolate the rooms store per test (no cross-test org/tg-state leak)
  const port = await findFreePort(19350)
  const controlPort = await findFreePort(port + 1)
  const tg = fakeTelegram()
  const daemon = startRoomDaemon({ port, controlPort, notifyPort: 0, version: 'test', idleMs: 9e9, tickMs: 9e9, turnCap: 100, workerInvoke: async () => ({ text: '' }), tgFetch: tg.fetchFn, tgToken: { anigame: 'BOT:TOKEN', shop: 'BOT:TOKEN', doomed: 'BOT:TOKEN' } })

  const norm = parseRoster({ org: 'shop', repo: TMP_HOME, teams: [{ name: 'core', members: [
    { role: 'architect', backend: 'claude', name: 'roland', lead: true },
  ] }] }, {})
  await controlCall(controlPort, { action: 'defineOrg', def: { org: norm.org, repo: norm.repo, members: norm.members, rooms: norm.rooms } })

  // pin user 555
  tg.queue.push([upd(1, 555, '/start')]); await sleep(200)
  await controlCall(controlPort, { action: 'tgconfirm', org: 'shop', fromId: 555 })

  // register the lead and have it ask @user a QUESTION → pushed to Telegram.
  const sock = net.connect(port, '127.0.0.1'); await new Promise((r) => sock.on('connect', r))
  const send = (o) => sock.write(JSON.stringify(o) + '\n')
  send({ type: 'register', sessionId: memberSessionId('shop', 'roland/claude'), memberHandle: 'roland/claude', repo: 'shop' })
  await sleep(200)
  send({ type: 'say', id: 1, text: '@user should we ship the candy theme?', kind: 'question', room: 'leads' })
  await sleep(200)

  const pushed = tg.sent.find((m) => /should we ship the candy theme/.test(m.text))
  assert.ok(pushed, 'the question was pushed to Telegram')
  assert.match(pushed.text, /❓/); assert.match(pushed.text, /Reply to this message/)   // H1 marker + H2 reply hint
  assert.match(pushed.text, /roland/i)   // H1 attribution (speaker)

  // the pinned user REPLIES to that pushed message → maps to the question → answered.
  let reply = (text, replyId, id) => tg.queue.push([{ update_id: id, message: { message_id: id, date: 1, chat: { id: 555, type: 'private' }, from: { id: 555, username: 'jane' }, text, reply_to_message: { message_id: replyId } } }])
  reply('yes — ship it', pushed.message_id, 10); await sleep(250)
  assert.ok(tg.sent.some((m) => /Answer recorded/.test(m.text)), 'bot acked the answer')
  assert.ok(tg.edits.some((e) => /Answered: yes — ship it/.test(e.text) && e.message_id === pushed.message_id), 'H4: pushed message edited in place to show the answer')
  assert.equal((await controlCall(controlPort, { action: 'team' })).userInbox.find((x) => /candy theme/.test(x.text)).answered, true)

  // a SECOND reply to the now-resolved question → stale, bot says so, no re-answer.
  reply('actually no', pushed.message_id, 11); await sleep(250)
  assert.ok(tg.sent.some((m) => /already resolved/.test(m.text)), 'stale reply rejected with a clear message')

  // a NOTIFICATION (plain @user) is NOT pushed to Telegram (questions-only).
  const beforeCount = tg.sent.length
  send({ type: 'say', id: 2, text: '@user heads up, deploy finished' }); await sleep(200)
  assert.ok(!tg.sent.some((m) => /deploy finished/.test(m.text)), 'a notification is not pushed to Telegram')

  sock.destroy(); daemon.stop()
})

test('daemon #13: removeorg durably forgets a project (survives restart) and purges its TG state', async () => {
  process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/mrc-tgiso-`)
  const port = await findFreePort(19420)
  const controlPort = await findFreePort(port + 1)
  const tg = fakeTelegram()
  const daemon = startRoomDaemon({ port, controlPort, notifyPort: 0, version: 'test', idleMs: 9e9, tickMs: 9e9, turnCap: 100, workerInvoke: async () => ({ text: '' }), tgFetch: tg.fetchFn, tgToken: { anigame: 'BOT:TOKEN', shop: 'BOT:TOKEN', doomed: 'BOT:TOKEN' } })

  const norm = parseRoster({ org: 'doomed', repo: TMP_HOME, teams: [{ name: 'core', members: [{ role: 'architect', backend: 'claude', name: 'roland', lead: true }] }] }, {})
  await controlCall(controlPort, { action: 'defineOrg', def: { org: norm.org, repo: norm.repo, members: norm.members, rooms: norm.rooms } })
  tg.queue.push([upd(1, 555, '/start')]); await sleep(200)
  await controlCall(controlPort, { action: 'tgconfirm', org: 'doomed', fromId: 555 })
  let st = await controlCall(controlPort, { action: 'team' })
  assert.ok(st.orgs.some((o) => o.org === 'doomed'))
  assert.ok(st.telegram.doomed?.pinned, 'TG linked before delete')

  // Delete it.
  assert.equal((await controlCall(controlPort, { action: 'removeorg', org: 'doomed' })).ok, true)
  st = await controlCall(controlPort, { action: 'team' })
  assert.ok(!st.orgs.some((o) => o.org === 'doomed'), 'org gone from status')
  assert.ok(!st.members.some((m) => m.org === 'doomed'))
  assert.equal(st.telegram.doomed, undefined, 'TG state purged')
  // room-telegram.json on disk no longer has the org (durable purge)
  const tgFile = `${process.env.HOME}/.local/share/mrc/room-telegram.json`
  assert.ok(!fs.existsSync(tgFile) || !(JSON.parse(fs.readFileSync(tgFile, 'utf8')).orgs || {}).doomed, 'room-telegram.json purged of the org')
  // idempotent
  assert.equal((await controlCall(controlPort, { action: 'removeorg', org: 'doomed' })).ok, true)
  daemon.stop()
  await sleep(100)

  // RESTART: a fresh daemon on the same HOME must NOT resurrect the deleted org.
  const port2 = await findFreePort(19440), controlPort2 = await findFreePort(port2 + 1)
  const daemon2 = startRoomDaemon({ port: port2, controlPort: controlPort2, notifyPort: 0, version: 'test', idleMs: 9e9, tickMs: 9e9, turnCap: 100, workerInvoke: async () => ({ text: '' }), tgFetch: tg.fetchFn, tgToken: { anigame: 'BOT:TOKEN', shop: 'BOT:TOKEN', doomed: 'BOT:TOKEN' } })
  const st2 = await controlCall(controlPort2, { action: 'team' })
  assert.ok(!st2.orgs.some((o) => o.org === 'doomed'), 'stays deleted across a daemon restart')
  daemon2.stop()
})

test('daemon #14: a global process.env token/chat_id does NOT bleed to a token-less project', async () => {
  process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/mrc-tgiso-`)
  // Pollute the daemon's global env (the mrc-in-mrc case that misrouted CANESOFT).
  const savedTok = process.env.MRC_TELEGRAM_BOT_TOKEN, savedChat = process.env.MRC_TELEGRAM_CHAT_ID
  process.env.MRC_TELEGRAM_BOT_TOKEN = 'GLOBAL:LEAK'; process.env.MRC_TELEGRAM_CHAT_ID = '999999'
  try {
    const repoA = fs.mkdtempSync(`${os.tmpdir()}/mrc-A-`)   // has its OWN token (no chat_id)
    const repoB = fs.mkdtempSync(`${os.tmpdir()}/mrc-B-`)   // has NOTHING in its .env
    const repoC = fs.mkdtempSync(`${os.tmpdir()}/mrc-C-`)   // has token AND chat_id
    fs.writeFileSync(`${repoA}/.env`, 'MRC_TELEGRAM_BOT_TOKEN=A:OWNTOKEN\n')
    fs.writeFileSync(`${repoC}/.env`, 'MRC_TELEGRAM_BOT_TOKEN=C:OWNTOKEN\nMRC_TELEGRAM_CHAT_ID=4242\n')

    const port = await findFreePort(19470), controlPort = await findFreePort(port + 1)
    const tg = fakeTelegram()
    const daemon = startRoomDaemon({ port, controlPort, notifyPort: 0, version: 'test', idleMs: 9e9, tickMs: 9e9, turnCap: 100, workerInvoke: async () => ({ text: '' }), tgFetch: tg.fetchFn })   // NO tgToken: real orgs come from their own .env only
    const def = (org, repo) => parseRoster({ org, repo, teams: [{ name: 'core', members: [{ role: 'architect', backend: 'claude', name: 'roland', lead: true }] }] }, {})
    for (const [org, repo] of [['projA', repoA], ['projB', repoB], ['projC', repoC]]) { const n = def(org, repo); await controlCall(controlPort, { action: 'defineOrg', def: { org: n.org, repo: n.repo, members: n.members, rooms: n.rooms } }) }
    await sleep(150)
    const tgv = (await controlCall(controlPort, { action: 'team' })).telegram

    // (1) A (own token) → configured/bridge; B (no own token) → NO bridge despite the global env.
    assert.ok(tgv.projA?.configured, 'A got a bridge from its OWN token')
    assert.equal(tgv.projB, undefined, 'B got NO bridge — the global token did not bleed')
    // (2) A has a token but NO chat_id in its .env → NOT pre-pinned to the global chat_id (stays confirm-mode).
    assert.equal(tgv.projA.pinned, null, 'A is NOT auto-authorized by the global MRC_TELEGRAM_CHAT_ID')
    // (3) C has token+chat_id in its OWN .env → pre-pinned from its own file (feature intact).
    assert.ok(tgv.projC?.pinned, 'C is pre-pinned from its own .env chat_id')
    assert.equal(tgv.projC.pinned.chatId, 4242)
    daemon.stop()
  } finally {
    if (savedTok === undefined) delete process.env.MRC_TELEGRAM_BOT_TOKEN; else process.env.MRC_TELEGRAM_BOT_TOKEN = savedTok
    if (savedChat === undefined) delete process.env.MRC_TELEGRAM_CHAT_ID; else process.env.MRC_TELEGRAM_CHAT_ID = savedChat
  }
})

test('daemon telegram (#21/#3): two orgs sharing one bot token → only one bridge; the other surfaces a warning', async () => {
  process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/mrc-tgiso-`)
  const port = await findFreePort(19490), controlPort = await findFreePort(port + 1)
  const tg = fakeTelegram()
  // Both orgs resolve to the SAME token (a real misconfig: same token pasted in two repos' .env). The
  // daemon must NOT start a second getUpdates poller — that 409-storms Telegram forever — and must
  // tell the user WHY (dashboard warning), instead of silently churning (the pre-fix behavior @user hit).
  const daemon = startRoomDaemon({ port, controlPort, notifyPort: 0, version: 'test', idleMs: 9e9, tickMs: 9e9, turnCap: 100, workerInvoke: async () => ({ text: '' }), tgFetch: tg.fetchFn, tgToken: { first: 'SHARED:TOKEN', second: 'SHARED:TOKEN' } })
  const repoA = fs.mkdtempSync(`${os.tmpdir()}/mrc-sh1-`), repoB = fs.mkdtempSync(`${os.tmpdir()}/mrc-sh2-`)
  const def = (org, repo) => parseRoster({ org, repo, teams: [{ name: 'core', members: [{ role: 'architect', backend: 'claude', name: 'roland', lead: true }] }] }, {})
  for (const [org, repo] of [['first', repoA], ['second', repoB]]) { const n = def(org, repo); await controlCall(controlPort, { action: 'defineOrg', def: { org: n.org, repo: n.repo, members: n.members, rooms: n.rooms } }) }
  await sleep(150)
  const tgv = (await controlCall(controlPort, { action: 'team' })).telegram
  assert.equal(tgv.first.warning, null, 'the first org claims the token — runs cleanly, no warning')
  assert.ok(tgv.second.warning && /already in use by project "first"/.test(tgv.second.warning), 'the second org is refused with a clear, actionable warning')
  daemon.stop()
})

test('daemon telegram: a failed outbound push is NOT silent — surfaced in the dashboard tgView + logged', async () => {
  process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/mrc-tgiso-`)
  const port = await findFreePort(19380), controlPort = await findFreePort(port + 1)
  // Telegram REJECTS sendMessage (e.g. stale chat_id) — the live-bug shape ("inbound ok, outbound silent").
  const queue = []
  const tgFetch = async (url) => {
    if (String(url).includes('/getUpdates')) { const b = queue.shift() || []; return { status: 200, json: async () => ({ ok: true, result: b }) } }
    if (String(url).includes('/sendMessage')) return { json: async () => ({ ok: false, description: 'Bad Request: chat not found' }) }
    return { status: 200, json: async () => ({ ok: true, result: {} }) }
  }
  const daemon = startRoomDaemon({ port, controlPort, notifyPort: 0, version: 'test', idleMs: 9e9, tickMs: 9e9, turnCap: 100, workerInvoke: async () => ({ text: '' }), tgFetch, tgToken: { shop: 'BOT:TOKEN' } })
  const norm = parseRoster({ org: 'shop', repo: TMP_HOME, teams: [{ name: 'core', members: [{ role: 'architect', backend: 'claude', name: 'roland', lead: true }] }] }, {})
  await controlCall(controlPort, { action: 'defineOrg', def: { org: norm.org, repo: norm.repo, members: norm.members, rooms: norm.rooms } })
  queue.push([upd(1, 555, '/start')]); await sleep(150)
  await controlCall(controlPort, { action: 'tgconfirm', org: 'shop', fromId: 555 })   // welcome send also "fails", but pin still set

  const sock = net.connect(port, '127.0.0.1'); await new Promise((r) => sock.on('connect', r))
  sock.write(JSON.stringify({ type: 'register', sessionId: memberSessionId('shop', 'roland/claude'), memberHandle: 'roland/claude', repo: 'shop' }) + '\n')
  await sleep(150)
  sock.write(JSON.stringify({ type: 'say', id: 1, text: '@user should this push?', kind: 'question', room: 'leads' }) + '\n')
  await sleep(250)

  const tgv = (await controlCall(controlPort, { action: 'team' })).telegram.shop
  assert.ok(tgv.pinned, 'org is linked (inbound side is fine)')
  assert.match(tgv.lastPushError, /chat not found/, 'the outbound failure is SURFACED in the dashboard tgView, not swallowed')
  sock.destroy(); daemon.stop()
})
