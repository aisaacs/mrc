// Codex status line + notifier config. Unlike Claude Code (where mrc points `statusLine`/`hooks` at its
// own scripts), Codex renders its status line from BUILT-IN item identifiers and fires its notifier from
// a top-level `notify` array — so mrc edits ~/.codex/config.toml instead. The edit is textual and
// additive because there's no TOML library in the container and a re-emit would eat the user's comments.
// Two TOML rules drive the placement tests: a top-level key must precede the first [table] header, and a
// [table] must not be declared twice.
import test from 'node:test'
import assert from 'node:assert/strict'

const {
  applyMrcCodexDefaults, setTopLevelKey, setTableKey, hasTopLevelKey, hasTableKey, STATUS_LINE_ITEMS,
} = await import('../container/codex-config.js')
const { summarize, payloadFromArgv } = await import('../container/mrc-notify-hook.js')

const NOTIFY = '/usr/local/bin/mrc-notify-hook.js'

test('empty config gets notify + the [tui] status line', () => {
  const out = applyMrcCodexDefaults('', { notifyPath: NOTIFY })
  assert.match(out, /^notify = \["\/usr\/local\/bin\/mrc-notify-hook\.js"\]/m)
  assert.match(out, /\[tui\]/)
  assert.match(out, /status_line = \["context-used", "five-hour-limit", "weekly-limit", "thread-title", "thread-id"\]/)
  assert.match(out, /status_line_use_colors = true/)
})

test('the top-level notify key lands BEFORE the first table header', () => {
  // TOML rule 1: after a [table] header, a bare key belongs to that table — appending would silently
  // turn `notify` into `model_providers.notify` and it would never fire.
  const out = applyMrcCodexDefaults('[model_providers.foo]\nname = "x"\n', { notifyPath: NOTIFY })
  assert.ok(out.indexOf('notify =') < out.indexOf('[model_providers.foo]'), `notify must precede the table:\n${out}`)
})

test('reuses an existing [tui] table rather than declaring it twice', () => {
  // TOML rule 2: a duplicate [tui] header is a hard parse error, which would break Codex startup.
  const out = applyMrcCodexDefaults('[tui]\ntheme = "dark"\n', { notifyPath: NOTIFY })
  assert.equal(out.match(/^\[tui\]/gm).length, 1, `exactly one [tui]:\n${out}`)
  assert.match(out, /theme = "dark"/)
  assert.match(out, /status_line = \[/)
})

test('never clobbers a key the user already set', () => {
  const user = [
    'notify = ["/my/own/notifier"]',
    '',
    '[tui]',
    'status_line = ["model"]',
    'status_line_use_colors = false',
  ].join('\n') + '\n'
  assert.equal(applyMrcCodexDefaults(user, { notifyPath: NOTIFY }), user, 'user config must be untouched')
})

test('adds only the missing key when the user set some of them', () => {
  const user = '[tui]\nstatus_line = ["model", "current-dir"]\n'
  const out = applyMrcCodexDefaults(user, { notifyPath: NOTIFY })
  assert.match(out, /status_line = \["model", "current-dir"\]/)      // theirs kept
  assert.match(out, /status_line_use_colors = true/)                  // ours added
  assert.equal(out.match(/status_line = /g).length, 1)
})

test('omitting notifyPath configures the status line only', () => {
  // --no-notify / daemon / worker launches: no proxy port, so no notifier should be registered.
  const out = applyMrcCodexDefaults('', { notifyPath: '' })
  assert.ok(!/^notify = /m.test(out), `no notify key expected:\n${out}`)
  assert.match(out, /status_line = \[/)
})

test('is idempotent across boots', () => {
  const once = applyMrcCodexDefaults('', { notifyPath: NOTIFY })
  assert.equal(applyMrcCodexDefaults(once, { notifyPath: NOTIFY }), once)
})

test('key detection is table-scoped, not global', () => {
  const text = '[tui]\nstatus_line = ["model"]\n'
  assert.equal(hasTableKey(text, 'tui', 'status_line'), true)
  assert.equal(hasTableKey(text, 'other', 'status_line'), false)
  // a key inside a table is NOT a top-level key — this is what keeps `notify` placement correct
  assert.equal(hasTopLevelKey('[tui]\nnotify = ["x"]\n', 'notify'), false)
  assert.equal(hasTopLevelKey('notify = ["x"]\n[tui]\n', 'notify'), true)
})

test('setTopLevelKey / setTableKey are no-ops when the key exists', () => {
  assert.equal(setTopLevelKey('notify = ["a"]\n', 'notify', '["b"]'), 'notify = ["a"]\n')
  assert.equal(setTableKey('[tui]\ntheme = "x"\n', 'tui', 'theme', '"y"'), '[tui]\ntheme = "x"\n')
})

test('every configured status-line item is from Codex\'s built-in vocabulary', () => {
  // Codex silently drops unknown items with an "Ignored invalid status line items" warning, so a typo
  // here would degrade the status line with no test failure anywhere else.
  const VALID = new Set([
    'project-name', 'current-dir', 'run-state', 'thread-title', 'git-branch',
    'context-remaining', 'context-used', 'context-window-size',
    'five-hour-limit', 'weekly-limit',
    'codex-version', 'used-tokens', 'total-input-tokens', 'total-output-tokens',
    'thread-id', 'fast-mode', 'model-with-reasoning', 'reasoning', 'task-progress',
    'pull-request-number', 'branch-changes', 'permissions', 'approval-mode',
    'raw-output', 'workspace-headline', 'model', 'approval',
  ])
  for (const item of STATUS_LINE_ITEMS) assert.ok(VALID.has(item), `unknown status line item: ${item}`)
})

// --- the shared notify hook: two agents, two payload shapes ---

test('summarize reads Codex\'s hyphenated agent-turn-complete payload', () => {
  assert.equal(
    summarize({ type: 'agent-turn-complete', 'last-assistant-message': 'Fixed the firewall.' }),
    'Fixed the firewall.')
  assert.equal(summarize({ type: 'agent-turn-complete', 'last-assistant-message': '' }), 'Done.')
})

test('summarize still reads Claude\'s underscored Stop payload', () => {
  assert.equal(summarize({ hook_event_name: 'Stop', last_assistant_message: 'All tests pass.' }), 'All tests pass.')
  assert.equal(summarize({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' }), 'Needs approval: Bash')
  assert.equal(summarize({ hook_event_name: 'Notification', message: 'hi' }), 'hi')
})

test('summarize never throws on junk', () => {
  for (const junk of [null, undefined, 42, 'str', {}, { type: 'unknown' }]) {
    assert.equal(typeof summarize(junk), 'string')
  }
})

test('summarize strips markdown and truncates long messages', () => {
  assert.equal(summarize({ type: 'agent-turn-complete', 'last-assistant-message': '# Done\n\n**all** good' }), 'Done all good')
  const long = summarize({ type: 'agent-turn-complete', 'last-assistant-message': 'x'.repeat(300) })
  assert.ok(long.length <= 141 && long.endsWith('…'))
})

test('payloadFromArgv picks up Codex argv JSON but not Claude\'s stdin case', () => {
  const p = { type: 'agent-turn-complete', 'last-assistant-message': 'hi' }
  assert.deepEqual(payloadFromArgv(['node', 'hook.js', JSON.stringify(p)]), p)
  assert.equal(payloadFromArgv(['node', 'hook.js']), null)          // Claude: nothing on argv
  assert.equal(payloadFromArgv(['node', 'hook.js', 'not json']), null)
  assert.equal(payloadFromArgv(['node', 'hook.js', '{bad']), null)  // malformed must not throw
})
