import { createInterface } from 'node:readline'
import { getSessions, loadNames, getSummaryPreview } from './manager.js'
import { generateName } from './api.js'

const ESC = '\x1b'
const HIDE_CURSOR = `${ESC}[?25l`
const SHOW_CURSOR = `${ESC}[?25h`
const CLEAR_SCREEN = `${ESC}[2J${ESC}[H`
const BOLD = `${ESC}[1m`
const DIM = `${ESC}[2m`
const REVERSE = `${ESC}[7m`
const RESET = `${ESC}[0m`

function formatTs(ts) {
  try { return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) } catch { return ts.slice(0, 19) }
}

/**
 * One-time migration: auto-name all unnamed sessions via Haiku API.
 */
export async function ensureNamesMigrated(mrcDir) {
  const { existsSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')

  const flagFile = join(mrcDir, 'names-migrated')
  if (existsSync(flagFile)) return

  const sessions = getSessions(mrcDir)
  const names = loadNames(mrcDir)
  const unnamed = sessions.filter(s => !names[s.uuid])

  if (unnamed.length > 0) {
    process.stderr.write(`\n\x1b[1;36m  ✦ One-time session naming — tagging ${unnamed.length} unnamed session(s).\x1b[0m\n`)
    process.stderr.write(`  \x1b[2m  This only happens once. Future sessions are named automatically.\x1b[0m\n\n`)

    for (const { uuid, preview } of unnamed) {
      const label = preview || uuid.slice(0, 12)
      // Suppress stdout from generateName
      const origWrite = process.stderr.write.bind(process.stderr)
      process.stderr.write = () => true
      try { await generateName(mrcDir, uuid) } catch {}
      process.stderr.write = origWrite

      const resultName = loadNames(mrcDir)[uuid]
      if (resultName) {
        origWrite(`\x1b[1;36m  ✦ \x1b[0;2m"${label}"\x1b[0m \x1b[1;36m→\x1b[0m \x1b[1;33m${resultName}\x1b[0m\n`)
      } else {
        origWrite(`\x1b[1;31m  ✦ "${label}" → (failed)\x1b[0m\n`)
      }
    }
  }

  const { mkdirSync } = await import('node:fs')
  mkdirSync(mrcDir, { recursive: true })
  writeFileSync(flagFile, new Date().toISOString() + '\n')
}

/**
 * Interactive session picker. Returns selected UUID, 'NEW', or null (quit).
 */
export async function pick(mrcDir) {
  await ensureNamesMigrated(mrcDir)

  const sessions = getSessions(mrcDir)
  const names = loadNames(mrcDir)

  // Build rows: { action, num, ts, name, preview }
  const rows = [{ action: 'NEW', num: '', ts: '', name: 'New session', preview: '' }]
  for (let i = 0; i < sessions.length; i++) {
    const { uuid, lastUpdated, preview } = sessions[i]
    rows.push({
      action: uuid,
      num: String(i + 1),
      ts: formatTs(lastUpdated),
      name: names[uuid] || '(unnamed)',
      preview: getSummaryPreview(mrcDir, uuid) || preview,
    })
  }

  // We need to write to /dev/tty for the TUI (stdout may be captured by $())
  const { openSync, createWriteStream } = await import('node:fs')
  const { ReadStream: TtyReadStream } = await import('node:tty')
  let ttyOut
  try {
    const fd = openSync('/dev/tty', 'w')
    ttyOut = createWriteStream(null, { fd })
  } catch {
    ttyOut = process.stderr
  }

  const write = s => ttyOut.write(s)

  let selected = 0
  const cols = process.stdout.columns || 120

  function render() {
    write(CLEAR_SCREEN)
    write(`  ${BOLD}Use the Schwartz to pick a session${RESET}\n`)
    write(`  ${DIM}↑/↓ navigate · Enter select · q quit${RESET}\n`)
    write(`  ${'━'.repeat(Math.min(cols - 4, 70))}\n\n`)

    const maxVisible = (process.stdout.rows || 30) - 6
    let scrollOffset = 0
    if (selected >= maxVisible) scrollOffset = selected - maxVisible + 1

    for (let vi = 0; vi < maxVisible && scrollOffset + vi < rows.length; vi++) {
      const idx = scrollOffset + vi
      const row = rows[idx]
      const indicator = idx === selected ? '▸' : ' '
      const attr = idx === selected ? REVERSE : ''
      const reset = idx === selected ? RESET : ''

      let line
      if (row.action === 'NEW') {
        line = `  ${indicator} ✦  New session`
      } else {
        const nameCol = row.name.slice(0, 40).padEnd(42)
        const previewCol = row.preview.slice(0, cols - 80)
        line = `  ${indicator} ${row.num.padEnd(3)} ${row.ts.padEnd(20)} ${nameCol} ${previewCol}`
      }
      write(`${attr}${line.slice(0, cols - 1)}${reset}\n`)
    }
  }

  return new Promise(resolve => {
    write(HIDE_CURSOR)
    render()

    // Read keystrokes from the terminal in raw mode. Open /dev/tty directly so
    // this works even when stdin isn't a TTY, and wrap the fd in a
    // tty.ReadStream — NOT fs.createReadStream, which produces an fs.ReadStream
    // with no setRawMode. Without raw mode the terminal stays in cooked/echo
    // mode and arrow-key escape sequences get echoed (^[[A/^[[B) instead of
    // delivered to us as discrete keypresses.
    let input
    try {
      input = new TtyReadStream(openSync('/dev/tty', 'r'))
    } catch {
      input = process.stdin
    }

    const finish = result => {
      write(SHOW_CURSOR)
      write(CLEAR_SCREEN)
      if (input.setRawMode) input.setRawMode(false)
      input.pause()
      // Close our /dev/tty fd so it doesn't leak or hold the event loop open
      // before mrc.js launches the container. Never destroy the shared stdin.
      if (input !== process.stdin) input.destroy()
      resolve(result)
    }

    if (input.setRawMode) input.setRawMode(true)
    input.resume()

    input.on('data', key => {
      const k = key.toString()
      if (k === '\x1b[A' || k === 'k') { // up
        selected = Math.max(0, selected - 1)
        render()
      } else if (k === '\x1b[B' || k === 'j') { // down
        selected = Math.min(rows.length - 1, selected + 1)
        render()
      } else if (k === '\r' || k === '\n' || k === '\x1b[C') { // enter / right
        finish(rows[selected].action)
      } else if (k === 'q' || k === '\x1b' || k === '\x03') { // quit / Ctrl-C
        finish(null)
      }
    })
  })
}
