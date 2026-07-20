// Codex image paste. Codex reads the clipboard IN-PROCESS via arboard (X11), so unlike Claude Code it
// never calls the `xclip` shim — its only clipboard path that crosses a command boundary is the WSL
// fallback, which shells out to `powershell.exe` and maps the `C:\...` path that command prints back
// into /mnt/<drive>/. mrc stands in for PowerShell there (codex-paste-shim.sh).
//
// That makes FOUR separate files agree on one contract, none of which can see the others at runtime.
// These tests pin the joins, because every drift mode is silent: the shim would run and Codex would
// still report its original X11 error, giving no hint that mrc was even involved.
//   1. entrypoint.sh must set WSL_DISTRO_NAME  -> else is_probably_wsl() is false and the shim is
//      never spawned at all.
//   2. the shim must print a `C:\...` path     -> convert_windows_path_to_wsl() returns None for
//      anything else (verified empirically: a bare /tmp path is silently discarded).
//   3. that path must map to where it wrote    -> Codex reads the MAPPED path, not the printed one.
//   4. the Dockerfile must pre-create /mnt/c   -> `coder` cannot mkdir in /, so the shim would abort.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const read = f => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
const shim = read('codex-paste-shim.sh')
const entrypoint = read('entrypoint.sh')
const dockerfile = read('Dockerfile')

/** Codex's convert_windows_path_to_wsl (codex-rs/tui/src/clipboard_paste.rs), reimplemented so the
 *  shim's stdout is checked against the real mapping rather than against our own assumption. */
function convertWindowsPathToWsl(input) {
  if (input.startsWith('\\\\')) return null                      // UNC paths are rejected outright
  const drive = input[0]?.toLowerCase()
  if (!drive || !/[a-z]/.test(drive)) return null
  if (input.slice(1, 2) !== ':') return null
  const rest = input.slice(2).replace(/^[\\/]+/, '').split(/[\\/]/).filter(Boolean)
  return ['/mnt', drive, ...rest].join('/')
}

test('the shim writes where Codex will look: printed C:\\ path maps back to the file on disk', () => {
  // The one join no single file can express. Shim writes /mnt/c/mrc-clipboard/<name> and prints
  // C:\mrc-clipboard\<name>; Codex opens the MAPPING of what was printed. They must be the same path.
  const dir = shim.match(/^DIR="([^"]+)"/m)?.[1]
  const printf = shim.match(/^printf '([^']+)' "\$NAME"/m)?.[1]
  assert.ok(dir, 'shim must define DIR')
  assert.ok(printf, 'shim must printf a path built from $NAME')

  const name = 'paste-20260101-000000-42.png'
  // Resolve the printf escapes the way printf(1) does (`\\` → `\`, `\n` → newline) before mapping.
  const printed = printf.replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c)).replace('%s', name).trim()
  assert.equal(convertWindowsPathToWsl(printed), `${dir}/${name}`)
})

test('the shim lands under /mnt/<drive>/ — the only shape Codex maps back', () => {
  const dir = shim.match(/^DIR="([^"]+)"/m)[1]
  assert.match(dir, /^\/mnt\/[a-z]\//, `Codex maps C:\\… to /mnt/<drive>/…; ${dir} would never be reached`)
})

test('only the final path reaches stdout', () => {
  // Codex takes stdout verbatim as the path, so a stray line of chatter becomes part of it. Every
  // diagnostic goes to $LOG instead; the one other printf is the request piped into socat.
  const emits = shim.split('\n').filter(l => /^\s*(echo|printf)\b/.test(l))
  const toStdout = emits.filter(l => !l.includes('$LOG') && !l.includes('socat'))
  assert.deepEqual(toStdout.map(l => l.trim()), [String.raw`printf 'C:\\mrc-clipboard\\%s\n' "$NAME"`])
  // Exit 0 is a promise that stdout holds a usable path — there is no success path but the last line.
  assert.doesNotMatch(shim, /^\s*exit 0$/m)
})

test('no clipboard proxy configured → exit 1 with no stdout', () => {
  // Same answer as an empty clipboard, and it must stay exit 1: Codex reports its own error, rather
  // than being handed a 0-byte file it would fail to decode.
  const r = spawnSync('bash', [fileURLToPath(new URL('../codex-paste-shim.sh', import.meta.url))],
    { env: { ...process.env, MRC_CLIPBOARD_PORT: '' }, encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.equal(r.stdout, '')
})

test('entrypoint.sh flips is_probably_wsl() for Codex only, and only with a clipboard proxy', () => {
  // WSL_DISTRO_NAME is the whole trigger — without it Codex never spawns powershell.exe. Scoped to the
  // codex branch so nothing else in the container starts believing it is on WSL.
  const codexBranch = entrypoint.slice(entrypoint.indexOf('\n  codex)'))
  assert.match(codexBranch, /if \[ -n "\$\{MRC_CLIPBOARD_PORT:-\}" \]; then\n\s*export WSL_DISTRO_NAME=/)
  assert.doesNotMatch(entrypoint.slice(0, entrypoint.indexOf('\n  codex)')), /WSL_DISTRO_NAME=/)
})

test('the Dockerfile installs the shim as powershell.exe and pre-creates its /mnt/c', () => {
  // Codex probes "powershell.exe", then "pwsh", then "powershell" — the first name is the one to own.
  assert.match(dockerfile, /COPY codex-paste-shim\.sh \/usr\/local\/bin\/powershell\.exe/)
  assert.match(dockerfile, /chmod 0755 \/usr\/local\/bin\/powershell\.exe/)
  // `coder` cannot mkdir in /, so without this the shim aborts before it ever reaches the proxy.
  const dir = shim.match(/^DIR="([^"]+)"/m)[1]
  assert.ok(dockerfile.includes(`mkdir -p ${dir}`), `Dockerfile must pre-create ${dir}`)
  assert.match(dockerfile, /chown -R \$\{USER_UID\}:\$\{USER_GID\} \/mnt\/c/)
})
