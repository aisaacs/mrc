#!/usr/bin/env node
//
// container-setup.js — Container-side config initialization.
// Called by entrypoint.sh after the firewall is up.
// Handles: plugin seeding, config restore, symlinks, hooks, statusline.
//
import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, readdirSync, cpSync, rmSync, unlinkSync, renameSync, lstatSync, statSync, appendFileSync, readlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { applyMrcCodexDefaults } from './codex-config.js'
import { rankedRollouts, resolveAutoResumeId } from './codex-sessions.js'

const HOME = process.env.HOME || '/home/coder'
const CLAUDE_DIR = join(HOME, '.claude')
const DEFAULTS_DIR = join(HOME, '.claude-defaults')
const SETTINGS_FILE = join(CLAUDE_DIR, 'settings.json')
const CONFIG_FILE = join(CLAUDE_DIR, 'claude.json')
const MRC_LOCAL = '/workspace/.mrc'
const PROJECT_STORE = join(CLAUDE_DIR, 'projects', '-workspace')
const CODEX_DIR = join(HOME, '.codex')
const CODEX_SESSIONS = join(CODEX_DIR, 'sessions')            // where Codex writes rollouts (in the volume)
const CODEX_SESSIONS_LOCAL = join(MRC_LOCAL, 'codex-sessions') // repo-local target, readable from the host

function readJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function writeJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}

// Symlink `src` to `dst` so image updates propagate on rebuild. Handles three cases:
//   - dst missing: create symlink
//   - dst is a symlink: no-op (already linked)
//   - dst is a real file/dir: migrate from legacy cpSync'd copy to symlink
//     - for files, only migrates when content matches src (preserves customizations)
//     - for dirs, migrates unconditionally (deep content comparison isn't practical;
//       plugin directories are not expected to be edited in place)
function linkOrMigrate(src, dst) {
  if (!existsSync(src)) return
  mkdirSync(dirname(dst), { recursive: true })

  if (!existsSync(dst)) {
    symlinkSync(src, dst)
    return
  }

  try {
    if (lstatSync(dst).isSymbolicLink()) return
  } catch { return }

  try {
    const stat = statSync(dst)
    if (stat.isFile()) {
      if (!readFileSync(src).equals(readFileSync(dst))) return  // user customized
      rmSync(dst)
    } else {
      rmSync(dst, { recursive: true, force: true })
    }
    symlinkSync(src, dst)
  } catch {}
}

// Copy `src` to `dst` if `dst` doesn't exist. Use for user-mutable templates
// where the copy is meant to be edited.
function copyIfAbsent(src, dst) {
  if (!existsSync(src)) return
  mkdirSync(dirname(dst), { recursive: true })
  if (!existsSync(dst)) cpSync(src, dst)
}

// 1. Seed plugins from build-time defaults into the persistent volume.
// Symlinks each marketplace and cached plugin individually so updates propagate
// on rebuild, while user-installed plugins (real dirs) and customizations (user
// replaced the symlink) are preserved.
if (existsSync(DEFAULTS_DIR)) {
  for (const subdir of ['marketplaces', 'cache']) {
    const src = join(DEFAULTS_DIR, 'plugins', subdir)
    const dst = join(CLAUDE_DIR, 'plugins', subdir)
    if (!existsSync(src)) continue
    mkdirSync(dst, { recursive: true })
    for (const entry of readdirSync(src)) {
      linkOrMigrate(join(src, entry), join(dst, entry))
    }
  }

  const defaultSettings = readJSON(join(DEFAULTS_DIR, 'settings.json'))
  if (defaultSettings) {
    const current = readJSON(SETTINGS_FILE)
    if (!current) {
      writeJSON(SETTINGS_FILE, defaultSettings)
    } else {
      current.enabledPlugins = { ...defaultSettings.enabledPlugins, ...current.enabledPlugins }
      writeJSON(SETTINGS_FILE, current)
    }
  }
}

// 1b. Seed video-analysis command and default config.
// Command is symlinked so image updates propagate; config is copied because
// it's meant to be modified by the agent or user.
const VA_SRC = '/opt/mrc-video-analysis'
if (existsSync(VA_SRC)) {
  // Purge legacy video-frames artifacts from previous versions
  const legacyPaths = [
    join(CLAUDE_DIR, 'commands', 'video-frames.md'),
    join(CLAUDE_DIR, 'skills', 'video-analysis'),  // entire dir; skill consolidated into command
  ]
  for (const p of legacyPaths) {
    if (existsSync(p)) {
      try {
        const stat = lstatSync(p)
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          rmSync(p, { recursive: true, force: true })
        } else {
          rmSync(p)
        }
      } catch {}
    }
  }

  // Migrate config file: video-frames.json → video-analysis.json
  const legacyCfg = join(MRC_LOCAL, 'video-frames.json')
  const newCfg = join(MRC_LOCAL, 'video-analysis.json')
  if (existsSync(legacyCfg) && !existsSync(newCfg)) {
    cpSync(legacyCfg, newCfg)
    rmSync(legacyCfg)
  }

  linkOrMigrate(join(VA_SRC, 'command.md'), join(CLAUDE_DIR, 'commands', 'video-analysis.md'))
  copyIfAbsent(join(VA_SRC, 'defaults.json'), newCfg)
}

// 1c. Seed Codex slash command.
const CODEX_SRC = '/opt/mrc-codex'
if (existsSync(CODEX_SRC)) {
  linkOrMigrate(join(CODEX_SRC, 'command.md'), join(CLAUDE_DIR, 'commands', 'codex.md'))
}

// 1d. Seed the /rename slash command — lets the human ask the session to rename itself (it runs the baked
// mrc-rename helper). Symlinked so image updates propagate; available in every session.
// NOTE: no /red-team command is shipped by design — the human always SUMMONS Pierre (the live
// summon_adversary channel verb), never a one-shot slash command, to keep from reaching for the wrong tool.
const RN_SRC = '/opt/mrc-rename'
if (existsSync(RN_SRC)) {
  linkOrMigrate(join(RN_SRC, 'command.md'), join(CLAUDE_DIR, 'commands', 'rename.md'))
}

// 2. Restore claude.json from backup if missing
if (!existsSync(CONFIG_FILE)) {
  const backupDir = join(CLAUDE_DIR, 'backups')
  try {
    const backups = readdirSync(backupDir)
      .filter(f => f.startsWith('.claude.json.backup.'))
      .sort((a, b) => statSync(join(backupDir, b)).mtimeMs - statSync(join(backupDir, a)).mtimeMs)
    if (backups.length > 0) {
      console.log('Restoring Claude config from backup...')
      cpSync(join(backupDir, backups[0]), CONFIG_FILE)
    }
  } catch {}
}

// 3. Skip onboarding when API key is provided
if (process.env.ANTHROPIC_API_KEY) {
  const claudeJson = join(HOME, '.claude.json')
  try {
    const content = readFileSync(claudeJson, 'utf8').trim()
    if (!content) throw new Error('empty')
  } catch {
    writeJSON(CONFIG_FILE, { hasCompletedOnboarding: true })
  }
}

// A caged adversary (MRC_ADVERSARY_FW) has /workspace mounted READ-ONLY, so the .mrc symlink + .gitignore
// writes below can't (and shouldn't) touch the repo.
const CAGED = !!process.env.MRC_ADVERSARY_FW
// ADVERSARY identity is set for a caged summon AND an uncaged --open-adversary-unsafe resume (mrc.js:517-521);
// FW is set only for the cage. Gate the project store on IDENTITY, not the cage: the -pierre-N config volume is
// a DURABLE, sequentially-shared pool (mrc.js:479-483), so an UNCAGED adversary must ALSO keep its store as a
// real dir — else it re-plants the /workspace/.mrc symlink and re-poisons the volume for the next caged claimant.
const ADVERSARY = !!process.env.MRC_ADVERSARY

// 4. Project store. A NORMAL session symlinks ~/.claude/projects/-workspace → /workspace/.mrc (repo-local memory).
if (ADVERSARY) {
  // An adversary's transcript MUST be a real dir in its OWN config volume, NEVER a symlink into /workspace/.mrc:
  // for a cage /workspace is :ro, so a symlinked write EROFS-vaporizes the transcript SILENTLY (the session runs
  // fine, but a later resume finds nothing). The -pierre-N volumes are durable and many were minted BEFORE the
  // caged skip existed (a create-time symlinkSync planted the link), and a skip-only guard never scrubs it — so
  // RECONCILE every boot: drop a stale symlink/stray, ensure a real writable dir. Idempotent → this also MIGRATES
  // the already-poisoned volumes with no `docker volume rm`. (Behavior change, intended: an uncaged adversary's
  // transcript now lands in the pierre volume too — out of the owner's dev .mrc, and required to keep the pool clean.)
  try {
    let st; try { st = lstatSync(PROJECT_STORE) } catch {}
    if (st && st.isSymbolicLink()) unlinkSync(PROJECT_STORE)                   // drop the LINK ONLY — never its target (/workspace/.mrc, the owner's real transcripts)
    else if (st && !st.isDirectory()) rmSync(PROJECT_STORE, { force: true })   // a stray non-dir where the store should be
    mkdirSync(PROJECT_STORE, { recursive: true })                             // already a real dir → no-op (persisted transcripts preserved)
    // Tidy a stale migration temp (Pierre's cosmetic nit): a crash between the rescue cpSync and its rename/rmSync
    // can leave a `<id>.jsonl.rescue-<pid>.tmp`. Zero correctness impact (never stat'd as a transcript, never matched
    // by the `.jsonl` filter), but sweep it so cruft doesn't accumulate across boots.
    try { for (const f of readdirSync(PROJECT_STORE)) if (f.endsWith('.tmp') && f.includes('.rescue-')) rmSync(join(PROJECT_STORE, f), { force: true }) } catch {}
    // Fail-LOUD (CLAUDE.md doctrine): the whole bug was a SILENT EROFS eating sessions. Prove the store is writable
    // NOW; if not, abort rather than run a session whose transcript can't persist.
    const probe = join(PROJECT_STORE, '.mrc-write-probe')
    writeFileSync(probe, ''); rmSync(probe, { force: true })
  } catch (e) {
    console.error(`FATAL: adversary project store ${PROJECT_STORE} is not a writable real dir (${e.message}). A transcript would be silently lost — aborting.`)
    process.exit(1)
  }
} else try {
  let alreadyLinked = false
  try { alreadyLinked = lstatSync(PROJECT_STORE).isSymbolicLink() } catch {}

  if (!alreadyLinked) {
    mkdirSync(MRC_LOCAL, { recursive: true })
    mkdirSync(dirname(PROJECT_STORE), { recursive: true })
    if (existsSync(PROJECT_STORE)) {
      cpSync(PROJECT_STORE, MRC_LOCAL, { recursive: true })
      rmSync(PROJECT_STORE, { recursive: true, force: true })
    }
    symlinkSync(MRC_LOCAL, PROJECT_STORE)
  }
} catch (e) {
  console.error('Warning: project store symlink failed:', e.message)
}

// 4b. Codex session store — same project-local-memory move as the Claude project store above.
// Codex writes its rollouts to ~/.codex/sessions, which lives in the mrc-codex-<hash> VOLUME and is
// therefore invisible to the host. Symlinking it to /workspace/.mrc/codex-sessions buys three things:
// the host can read it (that's what makes `mrc pick --agent codex` possible at all), it survives a
// config-volume reset, and it's SHARED across the per-instance mrc-codex-<hash>-N volumes instead of
// being siloed in whichever slot happened to write it — matching how Claude sessions already behave.
// Skipped for an adversary (Claude-only, and its /workspace is :ro).
// Best-effort recursive copy that CANNOT take the process down. Deliberately NOT cpSync: on an
// unreadable source directory cpSync raises an uncatchable std::filesystem abort (core dump) that would
// kill container-setup and with it the entrypoint, and on an unreadable source FILE it reports EACCES
// against the DESTINATION path — which is what made the original failure so confusing. Here every entry
// is handled individually, so one unreadable legacy rollout costs exactly that one file.
// Returns { copied, skipped }; skipped > 0 means the source must NOT be deleted.
function copyTreeBestEffort(src, dst) {
  let copied = 0, skipped = 0
  let entries
  try { entries = readdirSync(src, { withFileTypes: true }) } catch { return { copied, skipped: skipped + 1 } }
  try { mkdirSync(dst, { recursive: true }) } catch { return { copied, skipped: skipped + entries.length } }
  for (const e of entries) {
    const s = join(src, e.name), d = join(dst, e.name)
    if (e.isDirectory()) {
      const r = copyTreeBestEffort(s, d)
      copied += r.copied; skipped += r.skipped
    } else if (e.isFile()) {
      // Don't re-copy something migration already placed here — this runs on every boot until it succeeds.
      try {
        if (existsSync(d) && statSync(d).size === statSync(s).size) { copied++; continue }
        cpSync(s, d)
        copied++
      } catch { skipped++ }
    }
  }
  return { copied, skipped }
}

if (!ADVERSARY) try {
  // Unconditionally: an ALREADY-linked store whose target vanished (.mrc wiped, fresh clone) is a
  // dangling symlink, and Codex would fail to write through it. Re-planting the target is idempotent.
  mkdirSync(CODEX_SESSIONS_LOCAL, { recursive: true })

  // Prove the repo-local target is WRITABLE before pointing Codex at it. Planting a symlink into a
  // directory we can't write is the worst outcome available: Codex would silently fail to record any
  // session at all — the same silent-transcript-loss class the adversary project store guards against.
  // If this throws we fall to the catch and leave Codex on its volume, where recording still works.
  const probe = join(CODEX_SESSIONS_LOCAL, '.mrc-write-probe')
  writeFileSync(probe, ''); rmSync(probe, { force: true })

  let alreadyLinked = false
  try { alreadyLinked = lstatSync(CODEX_SESSIONS).isSymbolicLink() } catch {}

  if (!alreadyLinked) {
    mkdirSync(dirname(CODEX_SESSIONS), { recursive: true })
    if (existsSync(CODEX_SESSIONS)) {
      // Migrate rollouts already in the volume so pre-existing Codex history shows up in the picker.
      const { copied, skipped } = copyTreeBestEffort(CODEX_SESSIONS, CODEX_SESSIONS_LOCAL)
      if (skipped === 0) {
        rmSync(CODEX_SESSIONS, { recursive: true, force: true })
      } else {
        // NEVER delete history we failed to copy. Move it aside instead: the symlink still gets planted
        // (so the feature works from here on) and the un-migrated rollouts stay recoverable in the volume.
        const aside = `${CODEX_SESSIONS}.pre-mrc`
        try { rmSync(aside, { recursive: true, force: true }) } catch {}
        renameSync(CODEX_SESSIONS, aside)
        console.error(`⚠ Migrated ${copied} Codex session file(s); ${skipped} could not be read and were left at ${aside} (they will not appear in \`mrc pick --agent codex\`).`)
      }
    }
    symlinkSync(CODEX_SESSIONS_LOCAL, CODEX_SESSIONS)
  }
} catch (e) {
  // Degrade loudly but keep booting: Codex records to its volume, so auto-resume still works — only the
  // host-side picker goes dark. Say exactly that, rather than a bare "symlink failed".
  console.error(`Warning: could not link the Codex session store into the repo (${e.code || e.message}). Codex will record to its volume instead — auto-resume still works, but \`mrc pick --agent codex\` won't see these sessions.`)
}

// 4c. Codex status line + turn-complete notifier, written into ~/.codex/config.toml.
// Codex renders its status line from BUILT-IN items (not a script like Claude's statusLine hook), and
// fires desktop notifications from the top-level `notify` array — so mrc configures Codex here rather
// than injecting a renderer. Additive and non-clobbering: a key the user already set is left alone, the
// same way a `/statusline` customization always beats mrc's Claude default.
try {
  mkdirSync(CODEX_DIR, { recursive: true })
  const cfgPath = join(CODEX_DIR, 'config.toml')
  let before = ''
  try { before = readFileSync(cfgPath, 'utf8') } catch {}
  // No notifier when the proxy isn't up (--no-notify, or a daemon/worker launch): pointing `notify` at
  // the hook then would spawn a process per turn only for it to no-op on the missing port.
  const notifyPath = process.env.MRC_NOTIFY_PORT ? '/usr/local/bin/mrc-notify-hook.js' : ''
  const after = applyMrcCodexDefaults(before, { notifyPath })
  if (after !== before) writeFileSync(cfgPath, after)
} catch (e) {
  console.error('Warning: could not configure the Codex status line / notifier:', e.message)
}

// 5. Seed .gitignore entry for .mrc/
if (!CAGED && existsSync('/workspace/.git')) {
  const gitignore = '/workspace/.gitignore'
  try {
    const content = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : ''
    if (!content.split('\n').includes('.mrc/')) {
      appendFileSync(gitignore, '.mrc/\n')
    }
  } catch {}
}

// 6. Configure notification hooks + default statusLine in a single pass
{
  const settings = readJSON(SETTINGS_FILE) || {}

  // Purge stale hook paths (e.g. old mrc-notify-hook.sh from previous versions).
  // Runs unconditionally so broken hooks are cleaned even when MRC_NOTIFY_PORT
  // isn't set in this session.
  const STALE_HOOK_SUFFIXES = ['/mrc-notify-hook.sh']
  if (settings.hooks) {
    for (const event of Object.keys(settings.hooks)) {
      settings.hooks[event] = (settings.hooks[event] || []).filter(entry =>
        !(entry.hooks || []).some(h =>
          STALE_HOOK_SUFFIXES.some(suffix => h.command?.endsWith(suffix))
        )
      )
      if (settings.hooks[event].length === 0) delete settings.hooks[event]
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks
  }

  const notifyPort = process.env.MRC_NOTIFY_PORT
  if (notifyPort) {
    settings.hooks = settings.hooks || {}
    const hookEntry = [{
      matcher: '',
      hooks: [{ type: 'command', command: '/usr/local/bin/mrc-notify-hook.js' }],
    }]
    settings.hooks.Stop = hookEntry
    settings.hooks.PermissionRequest = hookEntry
    settings.hooks.Notification = hookEntry
  }

  const cmd = settings.statusLine?.command || ''
  const isStale = !cmd || cmd.endsWith('/mrc-statusline') || cmd.endsWith('/mrc-statusline.sh')
  if (!settings.statusLine || isStale) {
    settings.statusLine = {
      type: 'command',
      command: '/usr/local/bin/mrc-statusline.js',
      padding: 0,
    }
  }

  writeJSON(SETTINGS_FILE, settings)
}

// 7. Compute resume flag and write it for entrypoint.sh to read.
// Claude and Codex each get their own flag SYNTAX: Claude takes options (`--resume <id>` / `--continue`),
// Codex takes a SUBCOMMAND (`resume <id>` / `resume --last`). Any other agent gets an empty flag.
const agent = process.env.MRC_AGENT || 'claude'
let resumeFlag = ''

if (agent === 'claude') {
  const resumeSession = process.env.RESUME_SESSION || ''
  const newSession = process.env.NEW_SESSION === '1'

  if (resumeSession) {
    // A resume normally targets the persisted transcript. But a PRE-FIX caged adversary's transcript was
    // EROFS-vaporized (see the project-store reconcile above), and `--resume` on a missing conversation
    // hard-crashes the entrypoint (the line-98 failure). Decide deterministically here — the transcript is a
    // real file in PROJECT_STORE now (a symlink for a normal session resolves through to /workspace/.mrc): a
    // non-empty file → real resume; absent → DOWNGRADE to a fresh session under the same id (empty flag → the
    // entrypoint's `--session-id ${MRC_SESSION_ID}` path, exactly what a fresh summon uses). VERIFIED on the
    // rebuild: `--session-id <old-id>` STARTS clean even when .claude.json carries the id with no transcript
    // (Claude discovers sessions by scanning the transcript dir, which is empty for that id) — so no alias needed.
    // RELIABLE resume-vs-fresh + rescue (Pierre): "gone"/"absent" must mean a PERSISTENT ENOENT across retries —
    // never a single stat, and never a non-ENOENT error (EACCES/EIO ≠ absence). /workspace/.mrc is virtiofs with a
    // real consistency window, so the SAME rigor must gate BOTH the primary check AND the orphan check — one shared
    // helper, so the asymmetry (a single un-retried stat that reads a transient ENOENT as "gone") cannot return. A
    // present, correctly-named file returns success or a non-ENOENT error, never a persistent ENOENT → this can
    // never downgrade or mislabel a present transcript, whatever the failure's cause.
    const transcriptPresent = (p) => {
      for (let attempt = 0; ; attempt++) {
        try { return statSync(p).size > 0 }                                  // found (non-empty) or empty — decided
        catch (e) {
          if (!(e && e.code === 'ENOENT')) return true                       // non-ENOENT → NOT absence → treat as present (resume / recoverable)
          if (attempt >= 4) return false                                     // persistent ENOENT across retries → genuinely absent
          try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100) } catch {}   // 100ms settle, then re-stat (defeats a transient ENOENT)
        }
      }
    }
    const transcriptPath = join(PROJECT_STORE, `${resumeSession}.jsonl`)
    let hasTranscript = transcriptPresent(transcriptPath)
    // (A) migration rescue + HONEST recoverability (Pierre): an UNCAGED pre-fix adversary (--open-adversary-unsafe →
    // writable /workspace) wrote its transcript THROUGH the old symlink to /workspace/.mrc/<id>.jsonl; the reconcile
    // above removed the symlink, so on the first post-fix resume it's orphaned THERE, not at PROJECT_STORE. Rescue
    // THIS uuid's file only (never the owner's OTHER .mrc transcripts — the containment line) into the real store.
    let orphanRecoverablePath = null   // set iff a real transcript is on disk at the old location but couldn't be rescued
    if (!hasTranscript) {
      const orphan = join(MRC_LOCAL, `${resumeSession}.jsonl`)
      if (transcriptPresent(orphan)) {   // BUG1+BUG3: same retry + non-ENOENT rigor as the primary (virtiofs can transiently ENOENT — must not read as "gone")
        // BUG4 (Pierre): cpSync isn't atomic — a partial (ENOSPC mid-copy) would leave a truncated .jsonl that the
        // NEXT boot's presence check reads as "present" → --resume on corrupt data. Copy to a temp then ATOMIC
        // rename (same fs, so rename is atomic), so transcriptPath only ever holds a COMPLETE file; clean up on fail.
        const tmp = `${transcriptPath}.rescue-${process.pid}.tmp`
        try { cpSync(orphan, tmp); renameSync(tmp, transcriptPath); hasTranscript = true }        // rescued → --resume
        catch { try { rmSync(tmp, { force: true }) } catch {}; orphanRecoverablePath = orphan }   // un-rescuable → downgrade, but it's RECOVERABLE (BUG2)
      }
    }
    if (hasTranscript) {
      resumeFlag = `--resume ${resumeSession}`
    } else {
      resumeFlag = ''
      // BUG2 (Pierre): tell the TRUTH about recoverability — "unrecoverable" ONLY when nothing is on disk. If the
      // orphan is present but the rescue failed, the real transcript is sitting at that path and the human can recover it.
      const recover = orphanRecoverablePath
        ? `the prior transcript is ON DISK at ${orphanRecoverablePath} (automatic recovery failed) and may be recoverable`
        : `the prior transcript was lost to a since-fixed bug and is unrecoverable`
      console.error(`⚠ No persisted transcript for session ${resumeSession} — starting FRESH under the same id (${recover}).`)
      // Gap-(b): the console.error above is entrypoint STDERR — it scrolls away when the TUI paints. ALSO write an
      // in-session note the agent relays on its FIRST turn (entrypoint folds /tmp/mrc-session-note into
      // --append-system-prompt). NOTE (Pierre's 4th, STILL OPEN): --append-system-prompt is model-context the agent
      // MAY not surface, and a dashboard/Telegram-supervised human never sees a TTY note — the @user-inbox routing
      // (#62) is the real cross-surface net for the caged-summon population; this note is only the direct-TTY cover.
      try {
        writeFileSync('/tmp/mrc-session-note',
          `[SESSION NOTICE — say this to your human in your FIRST message, before anything else]: This session's earlier transcript (id ${resumeSession}) could not be resumed, so you are running FRESH under the same session id — ${orphanRecoverablePath ? `the prior conversation is NOT lost: it is on disk at ${orphanRecoverablePath} (automatic recovery failed) and can be recovered` : `the prior conversation is gone, this is a clean start`}. State that plainly, then carry on.`)
      } catch {}
    }
  } else if (!newSession) {
    try {
      const jsonls = readdirSync(MRC_LOCAL).filter(f => f.endsWith('.jsonl'))
      if (jsonls.length > 0) resumeFlag = '--continue'
    } catch {}
  }
} else if (agent === 'codex') {
  // Mirror Claude's auto-resume: reopening a repo continues where you left off, `--new` starts clean.
  const resumeSession = process.env.RESUME_SESSION || ''
  const newSession = process.env.NEW_SESSION === '1'

  // Both stores: the repo-local one the picker reads, and Codex's own in the volume. Normally the second
  // is a symlink to the first; scanning both keeps auto-resume correct even if that link isn't intact.
  const STORES = [CODEX_SESSIONS_LOCAL, CODEX_SESSIONS]

  if (resumeSession) {
    // `codex resume <id>` on an unknown id is a hard startup failure, which would take the entrypoint
    // down with it. Same doctrine as the Claude branch: verify first, and DOWNGRADE to a fresh session
    // with a loud warning rather than crash the container out from under the user.
    const found = rankedRollouts(STORES).some(({ f }) => f.includes(resumeSession))
    if (found) {
      resumeFlag = `resume ${resumeSession}`
    } else {
      resumeFlag = ''
      console.error(`⚠ No Codex rollout found for session ${resumeSession} — starting a FRESH Codex session instead.`)
    }
  } else if (!newSession) {
    // Resolve the id ourselves rather than trusting `codex resume --last` — see codex-sessions.js.
    const id = resolveAutoResumeId(STORES)
    if (id) resumeFlag = `resume ${id}`
    // One line of ground truth about the store, so a future "it didn't resume" needs no guesswork about
    // which directory was read, how many rollouts were seen, or whether the symlink is intact.
    let link = 'missing'
    try { link = lstatSync(CODEX_SESSIONS).isSymbolicLink() ? `→ ${readlinkSync(CODEX_SESSIONS)}` : 'real dir (NOT linked)' } catch {}
    console.log(`Codex sessions: ${rankedRollouts(STORES).length} rollout(s); ~/.codex/sessions ${link}; resuming ${id || '(none — fresh session)'}`)
  }
}

writeFileSync('/tmp/mrc-resume-flag', resumeFlag)

// 8. Negotiation-room / crew channel plugin. The channel ships as a plugin in a baked-in LOCAL
// marketplace (/opt/mrc-marketplace), allowlisted in /etc/claude-code/managed-settings.json, so the
// entrypoint loads it via `--channels plugin:room@mrc` with NO experimental-channel prompt. Local
// marketplaces aren't cloned into ~/.claude/plugins, so they don't ride the defaults-restore the
// GitHub plugins use — register it into this (per-repo) volume here instead. Idempotent: skipped once
// installed_plugins.json shows it, so it's a one-time cost on a fresh volume.
if (process.env.MRC_ROOM_PORT && existsSync('/opt/mrc-marketplace')) {
  const installed = readJSON(join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'))
  if (!installed || !JSON.stringify(installed).includes('room@mrc')) {
    try {
      execFileSync('claude', ['plugin', 'marketplace', 'add', '/opt/mrc-marketplace'], { stdio: 'ignore' })
      execFileSync('claude', ['plugin', 'install', 'room@mrc'], { stdio: 'ignore' })
    } catch (e) {
      console.error('Warning: room channel plugin registration failed:', e.message)
    }
  }
}

console.log('Container setup complete.')
