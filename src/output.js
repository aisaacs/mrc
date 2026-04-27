import { YOGURT_QUOTES } from './constants.js'

// ANSI color helpers
export const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dimRed: '\x1b[2;31m',
  dimGreen: '\x1b[2;32m',
  dimYellow: '\x1b[2;33m',
  dimCyan: '\x1b[2;36m',
}

let verbose = false
export function setVerbose(v) { verbose = v }
export function dbg(...args) {
  if (verbose) process.stderr.write(`[mrc:debug] ${args.join(' ')}\n`)
}

export function log(prefix, ...args) {
  if (!verbose) return
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false })
  process.stderr.write(`[${prefix}] ${ts} ${args.join(' ')}\n`)
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function spinner(promise, message) {
  const quote = message || YOGURT_QUOTES[Math.floor(Math.random() * YOGURT_QUOTES.length)]
  let i = 0
  const timer = setInterval(() => {
    process.stderr.write(`\r  ${FRAMES[i++ % FRAMES.length]} ${quote}`)
  }, 100)
  return promise.finally(() => {
    clearInterval(timer)
    process.stderr.write(`\r${' '.repeat(quote.length + 6)}\r`)
  })
}
