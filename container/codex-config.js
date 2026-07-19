//
// codex-config.js — minimal, surgical editing of ~/.codex/config.toml.
//
// Codex's status line and notifier are CONFIG, not hooks: unlike Claude Code (where mrc points
// `statusLine`/`hooks` at its own scripts), Codex renders its status line from a fixed vocabulary of
// built-in item identifiers, and fires its notifier from a top-level `notify` array. So mrc configures
// Codex rather than scripting it.
//
// Editing is deliberately TEXTUAL and additive — there is no TOML library in the container, and a
// parse/re-emit round-trip would destroy the user's comments and formatting. The same doctrine the
// Claude status line already follows applies: only ever set a key the user has NOT set, so any
// customization always wins. Two TOML rules make placement non-obvious, and both are handled below:
//   1. A top-level key (`notify`) must appear BEFORE the first [table] header — after one, it would
//      silently become a key OF that table.
//   2. A [table] must not be declared twice, so `status_line` goes INTO an existing [tui] if present.
//

/** Does `text` already define `key` at the top level (i.e. before any [table] header)? */
export function hasTopLevelKey(text, key) {
  const re = new RegExp(`^\\s*${key}\\s*=`)
  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) return false          // reached the first table — top level is over
    if (re.test(line)) return true
  }
  return false
}

/** Does `text` define `key` inside `[table]`? */
export function hasTableKey(text, table, key) {
  const re = new RegExp(`^\\s*${key}\\s*=`)
  let inTable = false
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*\[([^\]]+)\]/)
    if (m) { inTable = m[1].trim() === table; continue }
    if (inTable && re.test(line)) return true
  }
  return false
}

/** Insert a top-level `key = value`, before the first table header (TOML rule 1). */
export function setTopLevelKey(text, key, value) {
  if (hasTopLevelKey(text, key)) return text
  const lines = text.split('\n')
  const firstTable = lines.findIndex(l => /^\s*\[/.test(l))
  const entry = `${key} = ${value}`
  if (firstTable === -1) {
    const base = text.trimEnd()
    return (base ? base + '\n' : '') + entry + '\n'
  }
  lines.splice(firstTable, 0, entry, '')
  return lines.join('\n')
}

/** Set `key = value` inside `[table]`, reusing the table if it already exists (TOML rule 2). */
export function setTableKey(text, table, key, value) {
  if (hasTableKey(text, table, key)) return text
  const lines = text.split('\n')
  const header = lines.findIndex(l => {
    const m = l.match(/^\s*\[([^\]]+)\]/)
    return m && m[1].trim() === table
  })
  const entry = `${key} = ${value}`
  if (header === -1) {
    const base = text.trimEnd()
    return (base ? base + '\n\n' : '') + `[${table}]\n${entry}\n`
  }
  lines.splice(header + 1, 0, entry)
  return lines.join('\n')
}

/**
 * The status-line items mrc configures, mirroring what mrc's Claude status line shows:
 * context usage, the 5h and weekly rate-limit gauges, the session title, and the short session id.
 * Every identifier here is from Codex's built-in vocabulary — an unrecognized one is dropped by Codex
 * with a visible "Ignored invalid status line items" warning, so this list stays conservative.
 */
export const STATUS_LINE_ITEMS = [
  'context-used',
  'five-hour-limit',
  'weekly-limit',
  'thread-title',
  'thread-id',
]

const toTomlArray = (arr) => `[${arr.map(s => `"${s}"`).join(', ')}]`

/**
 * Apply mrc's Codex defaults to a config.toml body. Returns the new text (unchanged if the user
 * already set everything). `notifyPath` is the container path of the notify hook.
 */
export function applyMrcCodexDefaults(text, { notifyPath, statusLineItems = STATUS_LINE_ITEMS } = {}) {
  let out = text || ''
  if (notifyPath) out = setTopLevelKey(out, 'notify', toTomlArray([notifyPath]))
  out = setTableKey(out, 'tui', 'status_line', toTomlArray(statusLineItems))
  out = setTableKey(out, 'tui', 'status_line_use_colors', 'true')
  return out
}
