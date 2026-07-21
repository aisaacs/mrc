// LOAD GATE for the room channel server — the enforcement that would have caught the 753a345 regression.
//
// The saga's second lesson (Pierre): "a fix isn't done because it's green; it's done because it LOADED." The
// empty-body fix extracted a tools module and rewired the server's import; the opt-in flip then removed an export the
// server still imported — an ESM LINK-TIME crash that made plugin:room:room fail for every session. `node --check` is
// single-file; the guard unit tests import the TOOLS module directly and never load the SERVER (it imports the MCP
// SDK, absent on the host). So nothing caught it until a live session showed `✘ failed`.
//
// This runs the module RESOLVER instead of a hand-rolled regex: it stubs ONLY the SDK (via a loader hook) and actually
// `import()`s the server, so the JS engine is the oracle. It catches imported-but-not-exported from the (real,
// unstubbed) tools module AND any init-time throw, in one test. It is strictly stronger than the import-resolution
// regex in channel-guard.test.mjs; it does NOT replace the post-rebuild metal check (the stub can drift from a real
// SDK rename — see mcp-sdk-stub.mjs), which is why that check is documented as the real gate, this as the early warning.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, mkdtempSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const here = fileURLToPath(new URL('.', import.meta.url))
const registrar = join(here, 'fixtures', 'register-sdk-stub.mjs')
const runner = join(here, 'fixtures', 'load-channel-server.mjs')
const serverPath = join(here, '..', 'container', 'mrc-channel-server.js')
const toolsPath = join(here, '..', 'container', 'mrc-channel-tools.js')

const loadServer = (p) => spawnSync(process.execPath, ['--import', registrar, runner, p], { encoding: 'utf8' })

test('#LOAD-GATE: the channel server LINKS + INITIALIZES (SDK stubbed, tools module real)', () => {
  const r = loadServer(serverPath)
  assert.equal(r.status, 0, `channel server failed to load:\n${r.stderr}`)
  assert.match(r.stdout, /CHANNEL_SERVER_LOADED_OK/)
})

// Pierre's rule: a load-gate that doesn't RED-CATCH the exact crash it was built for is theater — run it against the
// real regression, don't reason that it would have worked. Reintroduce 753a345's broken import (a name the tools
// module does NOT export) in a temp copy and prove the gate fails on it, for the right reason.
test('#LOAD-GATE red-catches the 753a345 regression (imported-but-not-exported crashes the load)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mrc-load-'))
  cpSync(toolsPath, join(dir, 'mrc-channel-tools.js'))   // real tools module beside the broken server copy
  const broken = readFileSync(serverPath, 'utf8').replace(
    "import { isEscalate, consultTools, teamTools, guardArgs } from './mrc-channel-tools.js'",
    "import { isEscalate, consultTools, teamTools, guardArgs, NON_BODY_FIELDS } from './mrc-channel-tools.js'")
  assert.ok(broken.includes('NON_BODY_FIELDS'), 'fixture must actually reintroduce the broken import')
  const brokenServer = join(dir, 'mrc-channel-server.js')
  writeFileSync(brokenServer, broken)
  const r = loadServer(brokenServer)
  assert.notEqual(r.status, 0, 'the broken import MUST fail the load gate — else the gate is theater')
  assert.match(r.stderr, /NON_BODY_FIELDS|does not provide an export/, 'must fail for the RIGHT reason (the missing export)')
})

// The load gate's SDK stub is a hand-maintained mirror, so it only tracks the real SDK if the real SDK can only change
// on a DELIBERATE bump — which requires the install to be PINNED. Unpinned, it drifts on any rebuild, silently, and
// the host gate goes false-green against an old stub while the metal links a new SDK (Pierre, empty-body saga; also
// the exact unpinned-dep anti-pattern we refused ajv over). This asserts the pin can't quietly come off.
test('#LOAD-GATE: the channel server’s MCP SDK is version-PINNED in the Dockerfile', async () => {
  const { readFileSync } = await import('node:fs')
  const df = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')
  const m = df.match(/@modelcontextprotocol\/sdk@(\d+\.\d+\.\d+)/)
  assert.ok(m, 'install @modelcontextprotocol/sdk@X.Y.Z (pinned) — an unpinned SDK drifts on every rebuild and false-greens the load gate')
  assert.ok(!/npm install[^\n]*@modelcontextprotocol\/sdk(?![@])/.test(df), 'no unpinned @modelcontextprotocol/sdk install may remain')
})
