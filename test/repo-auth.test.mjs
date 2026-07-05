// #49 multi-repo Inc 1 — the per-org authorized-repo set + the resolveMemberRepo mint gate. The record is a
// HOST-ONLY file, so tests use a unique per-run org and clean it up. Real temp repos (realpath resolves them).
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveMemberRepo, addAuthorizedRepo, removeAuthorizedRepo, loadAuthorizedRepos, _authPathForTest } from '../src/teams/repo-auth.js'
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, sep } from 'node:path'

let orgN = 0
function scratch() {
  const org = `test-repoauth-${process.pid}-${orgN++}`
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mrc-ra-')))
  const orgRepo = join(root, 'orgrepo'); mkdirSync(orgRepo)
  const other = join(root, 'otherrepo'); mkdirSync(other)
  return { org, root, orgRepo, other, cleanup: () => { rmSync(root, { recursive: true, force: true }); try { unlinkSync(_authPathForTest(org)) } catch {} } }
}

test('resolveMemberRepo: default (no request) → the org repo, realpath-canonical', () => {
  const s = scratch()
  try { assert.equal(resolveMemberRepo(s.orgRepo, undefined, s.org), s.orgRepo) } finally { s.cleanup() }
})

test('resolveMemberRepo: own-repo grant — requesting the org repo (any spelling) is always allowed', () => {
  const s = scratch()
  try {
    assert.equal(resolveMemberRepo(s.orgRepo, s.orgRepo, s.org), s.orgRepo)
    const link = join(s.root, 'orglink'); symlinkSync(s.orgRepo, link)   // a symlink spelling still resolves to the own repo
    assert.equal(resolveMemberRepo(s.orgRepo, link, s.org), s.orgRepo)
  } finally { s.cleanup() }
})

test('resolveMemberRepo: an UNAUTHORIZED cross-repo is REFUSED (fail-closed — empty set by default)', () => {
  const s = scratch()
  try { assert.throws(() => resolveMemberRepo(s.orgRepo, s.other, s.org), /not authorized/) } finally { s.cleanup() }
})

test('resolveMemberRepo: after a HUMAN addAuthorizedRepo, the cross-repo resolves (realpath-canonical match)', () => {
  const s = scratch()
  try {
    addAuthorizedRepo(s.org, s.other)
    assert.equal(resolveMemberRepo(s.orgRepo, s.other, s.org), s.other)
    const link = join(s.root, 'otherlink'); symlinkSync(s.other, link)   // a symlink spelling of the authorized repo still matches
    assert.equal(resolveMemberRepo(s.orgRepo, link, s.org), s.other)
  } finally { s.cleanup() }
})

test('broad-guard is on the IMPLICIT own-repo grant only (Pierre #3): a "/"/$HOME ORG repo is refused', () => {
  const s = scratch()
  try {
    // The auto-authorization (own-repo grant) is broad-guarded — an org repo that resolves to / or $HOME refuses.
    assert.throws(() => resolveMemberRepo(sep, sep, s.org), /filesystem root/)
    assert.throws(() => resolveMemberRepo(homedir(), 'x', s.org), /home directory/)
    // But a REQUEST resolving to $HOME is refused by the SET-check (not a separate denylist) — it isn't in the set.
    assert.throws(() => resolveMemberRepo(s.orgRepo, homedir(), s.org), /not authorized/)
    // and the human can't even ADD / or $HOME (the add broad-guards).
    assert.throws(() => addAuthorizedRepo(s.org, homedir()), /home directory/)
  } finally { s.cleanup() }
})

test('authorized-repo record is HOST-ONLY (under homedir/.local/share/mrc), never repo-relative', () => {
  const s = scratch()
  try {
    const p = _authPathForTest(s.org)
    assert.ok(p.startsWith(join(homedir(), '.local', 'share', 'mrc')), 'record lives host-side')
    assert.ok(!p.includes(s.orgRepo), 'record is not inside any repo — a container can neither read nor mutate it')
  } finally { s.cleanup() }
})

test('cross-org isolation of the KEY: orgs whose names slug-COLLIDE get DISTINCT records (Pierre)', () => {
  // `acme.prod` and `acme_prod` collapse to the same slug — a lossy key would SHARE their authorized-set (a
  // cross-org privilege leak, attacker-triggerable via a slug-colliding org name). The injective (hex) key
  // keeps them distinct: authorizing a repo for one does NOT authorize it for the other.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mrc-ra-')))
  const repoX = join(root, 'repox'); mkdirSync(repoX)
  const orgA = `acme.prod-${process.pid}`, orgB = `acme_prod-${process.pid}`
  try {
    assert.notEqual(_authPathForTest(orgA), _authPathForTest(orgB), 'slug-colliding orgs get distinct record files')
    addAuthorizedRepo(orgA, repoX)
    assert.ok(loadAuthorizedRepos(orgA).has(repoX), 'orgA has its repo')
    assert.equal(loadAuthorizedRepos(orgB).size, 0, 'orgB does NOT inherit orgA\'s grant (no shared set)')
    assert.throws(() => resolveMemberRepo(root, repoX, orgB), /not authorized/, 'orgB still refuses the repo orgA authorized')
  } finally { rmSync(root, { recursive: true, force: true }); try { unlinkSync(_authPathForTest(orgA)) } catch {}; try { unlinkSync(_authPathForTest(orgB)) } catch {} }
})

test('loadAuthorizedRepos: missing record → empty set (fail-closed); add/remove round-trip is idempotent', () => {
  const s = scratch()
  try {
    assert.equal(loadAuthorizedRepos(s.org).size, 0)
    addAuthorizedRepo(s.org, s.other)
    assert.equal(loadAuthorizedRepos(s.org).size, 1)
    assert.equal(removeAuthorizedRepo(s.org, s.other), true)
    assert.equal(loadAuthorizedRepos(s.org).size, 0)
    assert.equal(removeAuthorizedRepo(s.org, s.other), false)   // idempotent
  } finally { s.cleanup() }
})
