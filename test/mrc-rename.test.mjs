// Test for container/mrc-rename.js — the in-session "rename this session" helper. Runs the REAL script
// against a temp .mrc (via the MRC_RENAME_DIR override) and cross-checks the output with src/sessions/
// manager.js's readers, so the two stay in lockstep (the script replicates manager's file formats because
// src/ isn't available inside the container).
//
//   run:  node test/mrc-rename.test.mjs      (exit 0 = all pass)
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
const here = dirname(fileURLToPath(import.meta.url))
const { loadNames, loadMeta } = await import(join(here, '../src/sessions/manager.js'))
const SCRIPT = join(here, '../container/mrc-rename.js')

let pass = 0, fail = 0
const ck = (n, c) => { if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + n) } else { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + n) } }

const dir = join(mkdtempSync(join(tmpdir(), 'mrc-rename-')), '.mrc')
mkdirSync(dir, { recursive: true })
// Two transcripts; make 'cur-uuid' the most-recently-modified (the "active" session).
writeFileSync(join(dir, 'old-uuid.jsonl'), '{}\n'); utimesSync(join(dir, 'old-uuid.jsonl'), new Date(1000), new Date(1000))
writeFileSync(join(dir, 'cur-uuid.jsonl'), '{}\n'); utimesSync(join(dir, 'cur-uuid.jsonl'), new Date(9999999999), new Date(9999999999))
// Seed an existing meta field to confirm the merge preserves other keys.
mkdirSync(join(dir, 'session-meta'), { recursive: true })
writeFileSync(join(dir, 'session-meta', 'cur-uuid.json'), JSON.stringify({ uuid: 'cur-uuid', repoPath: '/keep/me', createdAt: 'X' }) + '\n')

const run = (args, env = {}) => execFileSync('node', [SCRIPT, ...args], { env: { ...process.env, MRC_RENAME_DIR: dir, ...env }, encoding: 'utf8' })

// 1 — no MRC_SESSION_ID → picks the newest jsonl, writes BOTH stores in manager-readable format
run(['my cool name'], { MRC_SESSION_ID: '' })
ck('1a names map updated for the newest session', loadNames(dir)['cur-uuid'] === 'my cool name')
ck('1b meta record .name updated', loadMeta(dir, 'cur-uuid').name === 'my cool name')
ck('1c meta merge preserved other fields', loadMeta(dir, 'cur-uuid').repoPath === '/keep/me' && loadMeta(dir, 'cur-uuid').createdAt === 'X')
ck('1d stickiness: names[uuid] truthy → host auto-namer (generateName) would skip', !!loadNames(dir)['cur-uuid'])

// 2 — MRC_SESSION_ID wins over the newest-jsonl heuristic
run(['second name'], { MRC_SESSION_ID: 'old-uuid' })
ck('2a MRC_SESSION_ID targeted old-uuid', loadNames(dir)['old-uuid'] === 'second name')
ck('2b the other session name is untouched', loadNames(dir)['cur-uuid'] === 'my cool name')

// 3 — sanitize: newline collapsed (session-names is line-based); a '=' in the name still round-trips
run(['has = and\nnewline'], { MRC_SESSION_ID: 'cur-uuid' })
ck('3a newline collapsed + = preserved through loadNames', loadNames(dir)['cur-uuid'] === 'has = and newline')
ck('3b meta record agrees', loadMeta(dir, 'cur-uuid').name === 'has = and newline')

// 4 — empty name → usage error (nonzero exit)
let errored = false
try { run([''], { MRC_SESSION_ID: 'cur-uuid' }) } catch { errored = true }
ck('4a empty name rejected (nonzero exit)', errored)

console.log(`\n${'='.repeat(40)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(40)}`)
process.exit(fail ? 1 : 0)
