// #49 multi-repo floor — realpath-canonical mount/write containment. Tests use REAL symlinks in temp dirs
// (realpathSync resolves them for real), so the security-critical validation is proven WITHOUT Docker: plant
// a symlink that escapes the repo and assert it's rejected; plant one that stays inside and assert it's
// accepted and returns the RESOLVED path. Covers both live pre-existing escapes (mount + host-write) + the
// edges Pierre named: realpath-the-feed (symlinked repo root), the +sep prefix collision, and the write-mode
// ENOENT (realpath the existing ancestor, not the not-yet-created leaf).
import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalMountSource, canonicalWriteTarget } from '../src/mount-guard.js'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

// A fresh sandbox: a repo dir + an "outside" dir (an escape target), both real, siblings under one temp root.
function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mrc-mg-')))
  const repo = join(root, 'repo'); mkdirSync(repo)
  const outside = join(root, 'outside'); mkdirSync(outside)
  return { root, repo, outside, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('canonicalMountSource: a real in-repo subpath is accepted and returns the RESOLVED path', () => {
  const s = sandbox()
  try {
    mkdirSync(join(s.repo, 'src'))
    const p = canonicalMountSource(s.repo, 'src')
    assert.equal(p, join(s.repo, 'src'))
  } finally { s.cleanup() }
})

test('canonicalMountSource: a symlink escaping the repo (evil -> outside) is REJECTED', () => {
  const s = sandbox()
  try {
    symlinkSync(s.outside, join(s.repo, 'evil'))   // the live mount escape
    assert.throws(() => canonicalMountSource(s.repo, 'evil'), /escapes the repo/)
  } finally { s.cleanup() }
})

test('canonicalMountSource: a symlink staying INSIDE the repo is accepted, returns the resolved target', () => {
  const s = sandbox()
  try {
    mkdirSync(join(s.repo, 'real'))
    symlinkSync(join(s.repo, 'real'), join(s.repo, 'link'))   // link -> ./real (inside)
    const p = canonicalMountSource(s.repo, 'link')
    assert.equal(p, join(s.repo, 'real'))
  } finally { s.cleanup() }
})

test('canonicalMountSource: realpaths the FEED — a symlinked repo ROOT still contains correctly', () => {
  const s = sandbox()
  try {
    // The repo is REACHED via a symlink (repoLink -> repo). A caller passing the un-realpathed spelling must
    // still get correct containment, because the helper realpaths the repo arg itself (never trusts the feed).
    const repoLink = join(s.root, 'repoLink'); symlinkSync(s.repo, repoLink)
    mkdirSync(join(s.repo, 'inside'))
    assert.equal(canonicalMountSource(repoLink, 'inside'), join(s.repo, 'inside'))   // resolves under the REAL repo
    symlinkSync(s.outside, join(s.repo, 'out'))
    assert.throws(() => canonicalMountSource(repoLink, 'out'), /escapes the repo/)   // escape still caught through the symlinked root
  } finally { s.cleanup() }
})

test('canonicalMountSource: no /repo vs /repo-evil prefix collision (the +sep guard)', () => {
  const s = sandbox()
  try {
    // A sibling whose name is a PREFIX-extension of the repo. A naive startsWith(repoReal) without +sep would
    // accept it; +sep rejects it.
    const sibling = join(s.root, 'repo-evil'); mkdirSync(sibling)
    symlinkSync(sibling, join(s.repo, 'link'))
    assert.throws(() => canonicalMountSource(s.repo, 'link'), /escapes the repo/)
  } finally { s.cleanup() }
})

test('canonicalWriteTarget: a not-yet-existent leaf under a real dir is accepted (no ENOENT)', () => {
  const s = sandbox()
  try {
    mkdirSync(join(s.repo, '.mrc'))
    // teams/x.persona does NOT exist yet (writePersonaFile creates it) — must not ENOENT, must return the path.
    const p = canonicalWriteTarget(s.repo, '.mrc/teams/x.persona')
    assert.equal(p, join(s.repo, '.mrc', 'teams', 'x.persona'))
  } finally { s.cleanup() }
})

test('canonicalWriteTarget: a symlinked .mrc (-> outside) is REJECTED before any mkdir (the host-write escape)', () => {
  const s = sandbox()
  try {
    symlinkSync(s.outside, join(s.repo, '.mrc'))   // .mrc -> outside; the persona writer would writeFileSync into `outside` on the HOST
    assert.throws(() => canonicalWriteTarget(s.repo, '.mrc/teams/x.persona'), /escapes the repo/)
  } finally { s.cleanup() }
})

test('canonicalWriteTarget: resolves a symlinked-but-inside ancestor, appends the tail', () => {
  const s = sandbox()
  try {
    mkdirSync(join(s.repo, 'realmrc'))
    symlinkSync(join(s.repo, 'realmrc'), join(s.repo, '.mrc'))   // .mrc -> ./realmrc (inside)
    const p = canonicalWriteTarget(s.repo, '.mrc/teams/x.persona')
    assert.equal(p, join(s.repo, 'realmrc', 'teams', 'x.persona'))
  } finally { s.cleanup() }
})

test('canonicalWriteTarget: mid-chain excursion OUT then back IN is accepted (final-base-only is safe)', () => {
  // Pierre's nastiest static case: a/b -> outside (OUT), outside/c -> repo/x (back IN). The walk goes out then
  // back; the FINAL resolved base (repo/x) is inside, and we write to THAT link-free endpoint — the excursion
  // is irrelevant because nothing is written along the path, only at the resolved endpoint.
  const s = sandbox()
  try {
    mkdirSync(join(s.repo, 'a'))
    symlinkSync(s.outside, join(s.repo, 'a', 'b'))           // a/b -> outside (excursion out)
    mkdirSync(join(s.repo, 'x'))
    symlinkSync(join(s.repo, 'x'), join(s.outside, 'c'))     // outside/c -> repo/x (back inside)
    const p = canonicalWriteTarget(s.repo, 'a/b/c/leaf')
    assert.equal(p, join(s.repo, 'x', 'leaf'))               // resolved endpoint, inside the repo
  } finally { s.cleanup() }
})

test('canonicalMountSource: a MISSING source THROWS (fail-closed — kills docker\'s root-owned auto-create)', () => {
  const s = sandbox()
  try {
    // Conscious behavior change (Pierre not-named-2): docker -v auto-creates a missing bind source as a
    // root-owned empty dir; the guard throws instead. A member shouldn't mount a territory not in the tree.
    assert.throws(() => canonicalMountSource(s.repo, 'not-in-the-tree'))
  } finally { s.cleanup() }
})

test('resolveRepoRoot: a repo that resolves to "/" is REFUSED in the primitive (not left to an upstream guard)', () => {
  const s = sandbox()
  try {
    const rootLink = join(s.root, 'rootlink'); symlinkSync(sep, rootLink)   // rootlink -> /
    assert.throws(() => canonicalMountSource(rootLink, '.'), /filesystem root/)
    assert.throws(() => canonicalWriteTarget(rootLink, 'x'), /filesystem root/)
  } finally { s.cleanup() }
})
