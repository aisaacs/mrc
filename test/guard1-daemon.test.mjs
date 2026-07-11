// Guard-1 (dashboard-ux floor) — the daemon activation gate, proven on a real in-process daemon. Two tests Pierre
// required: (1) the DERIVATION — a control frame asserting trusted/activate WITHOUT the host-only secret is
// DOWNGRADED (a cross-uid raw frame can't read the 0600 secret), so the untrusted first-pin THROWS and NO pin
// lands; (2) the poisoned-launchteam / delete→recreate — after removeorg clears the pin, a no-secret defineOrg
// pointing at /victim pins NOTHING, so /victim/.env is never read. These fail loudly if the flags are ever
// "simplified" back to bare wire booleans, or if the poison is allowed to land inert.
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import { startRoomDaemon as _startRoomDaemon } from '../src/proxies/room-daemon.js'
import { findFreePort } from '../src/ports.js'
import { controlSecret } from '../src/rooms.js'
import { pinnedOrgRoot, loadAuthorizedRepos } from '../src/teams/repo-auth.js'

const _live = new Set()
function startRoomDaemon(o) { const d = _startRoomDaemon(o); if (d) _live.add(d); return d }   // teardown discipline (macOS exit-hang)
afterEach(() => { for (const d of _live) { try { d.stop?.() } catch {} } _live.clear() })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function controlCall(port, frame) {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, '127.0.0.1', () => c.write(JSON.stringify(frame) + '\n'))
    let b = ''
    c.on('data', (d) => { b += d; const i = b.indexOf('\n'); if (i >= 0) { try { resolve(JSON.parse(b.slice(0, i))) } catch (e) { reject(e) } c.end() } })
    c.on('error', reject); setTimeout(() => reject(new Error('control timeout')), 1500)
  })
}
async function bootDaemon(base) {
  const port = await findFreePort(base); const controlPort = await findFreePort(port + 1)
  startRoomDaemon({ port, controlPort, notifyPort: 0, version: 'test', idleMs: 9e9, tickMs: 9e9 })   // mints the control-capability secret
  await sleep(200)
  return { controlPort }
}
const tmpRepo = () => fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/mrc-g1repo-`))

test('guard-1 DERIVATION: a defineOrg asserting trusted WITHOUT the secret is downgraded → throws → no pin, org undefined', async () => {
  process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/mrc-g1a-`)
  const repo = tmpRepo()
  const { controlPort } = await bootDaemon(19700)
  // The cross-uid capability-forge: assert trusted/activate on a RAW frame with no secret. capOk() is false →
  // trusted/activate downgrade to false → resolveOrgRootForOrg(no-pin, untrusted) THROWS.
  const forged = await controlCall(controlPort, { action: 'defineOrg', trusted: true, activate: true, def: { org: 'acme', repo, members: [], rooms: [] } })
  assert.equal(forged.ok, false, 'a trusted/activate assertion without the secret is refused')
  assert.equal(pinnedOrgRoot('acme'), null, 'NO pin lands — the forge persists nothing')
  assert.equal((await controlCall(controlPort, { action: 'getroster', org: 'acme' })).roster, null, 'the org is not defined')
  // WITH the host-only secret (what the real CLI / in-daemon dashboard carry) → the capability is honored.
  const legit = await controlCall(controlPort, { action: 'defineOrg', trusted: true, activate: true, secret: controlSecret(), def: { org: 'acme', repo, members: [], rooms: [] } })
  assert.equal(legit.ok, true, 'the legit caller (with the secret) defines + pins')
  assert.equal(pinnedOrgRoot('acme'), repo, 'the root is pinned write-once')
})

// Inc 1 (Model B / cross-repo authorize) — the `authorizerepo` action is capOk-gated AT ITS DOOR: a raw frame without
// the host-only secret cannot seed the org's authorized-set (a session can REQUEST a repo — resolveMemberRepo throws
// until it's here — but can never AUTHORIZE one). This is the SOLE daemon writer of the set (invariant #1); the launch
// path only reads it. Broad-guard holds even for the secret-holder (`/` is never a legitimate repo).
test('Inc 1 authorizerepo: capOk at the door — no-secret REFUSED (set stays empty); with-secret RECORDS the realpath; `/` broad-guarded', async () => {
  process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/mrc-g1auth-`)
  const repo = tmpRepo()
  const { controlPort } = await bootDaemon(19760)
  const forged = await controlCall(controlPort, { action: 'authorizerepo', org: 'proj', repo })
  assert.equal(forged.ok, false, 'authorizerepo without the secret is refused (capOk at the door)')
  assert.equal(loadAuthorizedRepos('proj').size, 0, 'NO set entry lands — an un-authorized frame writes nothing')
  const ok = await controlCall(controlPort, { action: 'authorizerepo', org: 'proj', repo, secret: controlSecret() })
  assert.equal(ok.ok, true, 'the legit caller (with the secret) authorizes the repo')
  assert.ok(loadAuthorizedRepos('proj').has(repo), 'the set now holds the realpath — resolveMemberRepo will pass it')
  const root = await controlCall(controlPort, { action: 'authorizerepo', org: 'proj', repo: '/', secret: controlSecret() })
  assert.equal(root.ok, false, 'authorizing `/` is refused by the broad-guard even WITH the secret')
  assert.equal(loadAuthorizedRepos('proj').size, 1, 'the refused `/` never entered the set')
})

test('guard-1 orgRoster no-poison (Pierre case 3): a REJECTED untrusted defineOrg does NOT persist its roster', async () => {
  process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/mrc-g1c-`)
  const { controlPort } = await bootDaemon(19780)
  // an untrusted (no-secret) defineOrg carrying a /victim roster → REJECTED (untrusted first-pin throws)
  const rej = await controlCall(controlPort, { action: 'defineOrg', trusted: true, activate: true, roster: { org: 'Y', repo: '/victim', teams: [] }, def: { org: 'Y', repo: '/victim', members: [], rooms: [] } })
  assert.equal(rej.ok, false, 'the untrusted define is rejected')
  // The set-after-success fix: the rejected op must NOT have left its /victim roster in orgRoster — else a later
  // secret'd launchteam{Y} with no f.roster would fall back to orgRoster.get(Y)=/victim and first-pin it.
  const gr = await controlCall(controlPort, { action: 'getroster', org: 'Y' })
  assert.equal(gr.roster, null, 'orgRoster is UNpoisoned — the launchteam fallback can never read /victim from a rejected define')
})

test('guard-1 poisoned-launchteam: after removeorg clears the pin, a no-secret defineOrg{/victim} pins NOTHING', async () => {
  process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/mrc-g1b-`)
  const repo = tmpRepo()
  const { controlPort } = await bootDaemon(19740)
  // legit define+activate → pinned
  await controlCall(controlPort, { action: 'defineOrg', trusted: true, activate: true, secret: controlSecret(), def: { org: 'proj', repo, members: [], rooms: [] } })
  assert.equal(pinnedOrgRoot('proj'), repo)
  // a human delete (WITH the secret — removeorg is gated too) clears the pin
  assert.equal((await controlCall(controlPort, { action: 'removeorg', secret: controlSecret(), org: 'proj' })).ok, true)
  assert.equal(pinnedOrgRoot('proj'), null, 'delete clears the write-once pin (so a legit re-create can re-pin)')
  // THE ATTACK: a no-secret wire defineOrg{proj, /victim} → downgraded → untrusted first-pin → THROWS BEFORE anything persists.
  const attack = await controlCall(controlPort, { action: 'defineOrg', trusted: true, activate: true, def: { org: 'proj', repo: '/victim', members: [], rooms: [] } })
  assert.equal(attack.ok, false, 'the laundered re-root is refused')
  assert.equal(pinnedOrgRoot('proj'), null, 'the poison NEVER lands — /victim is not pinned, so /victim/.env is never read + no bridge starts')
  // and removeorg WITHOUT the secret is refused (can't clear a pin to enable a re-root)
  await controlCall(controlPort, { action: 'defineOrg', trusted: true, activate: true, secret: controlSecret(), def: { org: 'proj', repo, members: [], rooms: [] } })
  assert.equal((await controlCall(controlPort, { action: 'removeorg', org: 'proj' })).ok, false, 'removeorg without the secret is refused')
  assert.equal(pinnedOrgRoot('proj'), repo, 'the pin survives the unauthorized delete attempt')
})
