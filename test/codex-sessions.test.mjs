// Codex session resume + picker. Codex records conversations as append-only JSONL "rollouts" nested by
// date under ~/.codex/sessions, which container-setup.js symlinks to <repo>/.mrc/codex-sessions so the
// HOST can read them (that symlink is what makes `mrc pick --agent codex` possible). These tests pin the
// parser's defensive contract: a rollout with an unrecognized shape degrades to a bare row rather than
// disappearing, because the uuid alone is enough to `codex resume <uuid>`.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

const { getCodexSessions, resolveCodexSession, hasCodexSessions } = await import('../src/sessions/codex.js')

/** Write a rollout at the real nested path Codex uses: <sessions>/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl */
function writeRollout(mrcDir, { uuid, day = '2026/07/19', lines = [], mtime }) {
  const dir = join(mrcDir, 'codex-sessions', day)
  fs.mkdirSync(dir, { recursive: true })
  const file = join(dir, `rollout-2026-07-19T10-00-00-${uuid}.jsonl`)
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  if (mtime) fs.utimesSync(file, mtime, mtime)
  return file
}

function setup() {
  const repo = fs.mkdtempSync(join(os.tmpdir(), 'mrc-codex-'))
  const mrcDir = join(repo, '.mrc')
  fs.mkdirSync(mrcDir, { recursive: true })
  return mrcDir
}

const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'
const UUID_C = '33333333-3333-4333-8333-333333333333'

test('parses a rollout: uuid, codex-generated title, and first real user message', () => {
  const mrcDir = setup()
  writeRollout(mrcDir, {
    uuid: UUID_A,
    lines: [
      { type: 'session_meta', payload: { id: UUID_A, timestamp: '2026-07-19T10:00:00Z', originator: 'codex_cli' } },
      // Codex opens with synthetic turns; they must NOT become the preview or every row reads alike.
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd=/workspace</environment_context>' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'add a retry to the fetch helper' }] } },
      { type: 'turn_context', payload: { title: 'Add fetch retry' } },
    ],
  })

  const [s] = getCodexSessions(mrcDir)
  assert.equal(s.uuid, UUID_A)
  assert.equal(s.title, 'Add fetch retry')
  assert.equal(s.preview, 'add a retry to the fetch helper')
})

test('takes the LAST title Codex settled on, not the first', () => {
  const mrcDir = setup()
  writeRollout(mrcDir, {
    uuid: UUID_A,
    lines: [
      { type: 'session_meta', payload: { id: UUID_A, originator: 'codex_cli', title: 'Untitled' } },
      { type: 'turn_context', payload: { title: 'Fix the firewall' } },
    ],
  })
  assert.equal(getCodexSessions(mrcDir)[0].title, 'Fix the firewall')
})

test('reads the event_msg user-message shape too', () => {
  const mrcDir = setup()
  writeRollout(mrcDir, {
    uuid: UUID_A,
    lines: [
      { type: 'session_meta', payload: { id: UUID_A, originator: 'codex_cli' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'ship it' } },
    ],
  })
  assert.equal(getCodexSessions(mrcDir)[0].preview, 'ship it')
})

test('excludes non-interactive (codex exec) worker rollouts', () => {
  // `mrc team exec` runs task-worker turns against the SAME repo/volume. Those must not flood the
  // picker — matching what `codex resume --last` excludes by default.
  const mrcDir = setup()
  writeRollout(mrcDir, { uuid: UUID_A, lines: [{ type: 'session_meta', payload: { id: UUID_A, originator: 'codex_cli' } }] })
  writeRollout(mrcDir, { uuid: UUID_B, lines: [{ type: 'session_meta', payload: { id: UUID_B, originator: 'codex_exec' } }] })

  const rows = getCodexSessions(mrcDir)
  assert.deepEqual(rows.map(r => r.uuid), [UUID_A])
  assert.equal(getCodexSessions(mrcDir, { interactiveOnly: false }).length, 2)
})

test('a rollout with no parsable meta still resumes via the uuid in its filename', () => {
  // Degrading a row is fine; dropping it is not — the uuid alone is enough for `codex resume <uuid>`.
  const mrcDir = setup()
  const dir = join(mrcDir, 'codex-sessions', '2026/07/19')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(join(dir, `rollout-2026-07-19T10-00-00-${UUID_C}.jsonl`), 'not json at all\n{broken\n')

  const rows = getCodexSessions(mrcDir)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].uuid, UUID_C)
  assert.equal(rows[0].title, '')
})

test('sorts newest-first and dedups a repeated uuid', () => {
  const mrcDir = setup()
  const old = new Date('2026-07-01T00:00:00Z')
  const recent = new Date('2026-07-19T00:00:00Z')
  writeRollout(mrcDir, { uuid: UUID_A, day: '2026/07/01', mtime: old, lines: [{ type: 'session_meta', payload: { id: UUID_A, originator: 'codex_cli' } }] })
  writeRollout(mrcDir, { uuid: UUID_B, day: '2026/07/19', mtime: recent, lines: [{ type: 'session_meta', payload: { id: UUID_B, originator: 'codex_cli' } }] })
  // same uuid recorded twice (a fork/copy) — resuming is keyed on uuid, so it must appear once
  writeRollout(mrcDir, { uuid: UUID_B, day: '2026/07/18', lines: [{ type: 'session_meta', payload: { id: UUID_B, originator: 'codex_cli' } }] })

  assert.deepEqual(getCodexSessions(mrcDir).map(r => r.uuid), [UUID_B, UUID_A])
})

test('dedup retains the newest copy of a repeated uuid regardless of traversal order', () => {
  const mrcDir = setup()
  writeRollout(mrcDir, {
    uuid: UUID_B,
    day: '2026/07/01',
    mtime: new Date('2026-07-01T00:00:00Z'),
    lines: [{ type: 'session_meta', payload: { id: UUID_B, originator: 'codex_cli', title: 'Stale title' } }],
  })
  writeRollout(mrcDir, {
    uuid: UUID_B,
    day: '2026/07/19',
    mtime: new Date('2026-07-19T00:00:00Z'),
    lines: [{ type: 'session_meta', payload: { id: UUID_B, originator: 'codex_cli', title: 'Current title' } }],
  })

  const rows = getCodexSessions(mrcDir)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].title, 'Current title')
  assert.equal(rows[0].lastUpdated, '2026-07-19T00:00:00.000Z')
})

test('empty / missing store is empty, never a throw', () => {
  const mrcDir = setup()
  assert.deepEqual(getCodexSessions(mrcDir), [])
  assert.equal(hasCodexSessions(mrcDir), false)
  assert.equal(resolveCodexSession(mrcDir, '1'), null)
})

test('resolve accepts list number, uuid, uuid prefix, and title substring', () => {
  const mrcDir = setup()
  const old = new Date('2026-07-01T00:00:00Z')
  const recent = new Date('2026-07-19T00:00:00Z')
  writeRollout(mrcDir, { uuid: UUID_A, day: '2026/07/01', mtime: old, lines: [{ type: 'session_meta', payload: { id: UUID_A, originator: 'codex_cli', title: 'Firewall work' } }] })
  writeRollout(mrcDir, { uuid: UUID_B, day: '2026/07/19', mtime: recent, lines: [{ type: 'session_meta', payload: { id: UUID_B, originator: 'codex_cli', title: 'Dashboard polish' } }] })

  assert.equal(resolveCodexSession(mrcDir, '1'), UUID_B)          // #1 == newest, matching the picker's order
  assert.equal(resolveCodexSession(mrcDir, '2'), UUID_A)
  assert.equal(resolveCodexSession(mrcDir, UUID_A), UUID_A)
  assert.equal(resolveCodexSession(mrcDir, '11111111'), UUID_A)   // uuid prefix
  assert.equal(resolveCodexSession(mrcDir, 'firewall'), UUID_A)   // title substring, case-insensitive
  assert.equal(resolveCodexSession(mrcDir, 'nope'), null)
})
