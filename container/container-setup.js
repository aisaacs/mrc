#!/usr/bin/env node
//
// container-setup.js — Container-side config initialization.
// Called by entrypoint.sh after the firewall is up.
// Handles: plugin seeding, config restore, symlinks, hooks, statusline.
//
import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, readlinkSync, readdirSync, cpSync, rmSync, unlinkSync, renameSync, lstatSync, statSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'

const HOME = process.env.HOME || '/home/coder'
const CLAUDE_DIR = join(HOME, '.claude')
const DEFAULTS_DIR = join(HOME, '.claude-defaults')
const SETTINGS_FILE = join(CLAUDE_DIR, 'settings.json')
const CONFIG_FILE = join(CLAUDE_DIR, 'claude.json')
const MRC_LOCAL = '/workspace/.mrc'
const PROJECT_STORE = join(CLAUDE_DIR, 'projects', '-workspace')
// #5 STORE-MODE: the store-layout contract version this container-setup implements (mount-conditional retarget of
// the project store to /mrc). The Dockerfile emits this as LABEL mrc.store.capability so the HOST launcher can
// gate store-mode on it (deny-unless-proven). MUST equal src/mrc-store.js's STORE_CAPABILITY (drift-tested).
// Bumping this changes THIS file's content → its COPY layer rebuilds → the label can never be present on an image
// whose container-setup is stale (the tie that stops the capability label from lying).
const STORE_CAPABILITY = 1
const MRC_STORE_MOUNT = '/mrc'   // where the host mounts the leaf slice when store-mode is active (existsSync = the runtime coordination signal)

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

  // The video-analysis CONFIG lives in /workspace/.mrc (agent/user-editable). A CAGED adversary has /workspace
  // mounted READ-ONLY (MRC_ADVERSARY_FW), so ANY write here EROFS-crashes container-setup and takes the whole
  // adversary session down — a fresh repo (no pre-existing video-analysis.json) is the trigger. The adversary
  // doesn't need this config, so SKIP the /workspace/.mrc writes when caged; the COMMAND symlink goes into the rw
  // config volume (CLAUDE_DIR), so it's safe either way. (Gate on FW/:ro, not adversary IDENTITY — an uncaged
  // adversary has a rw /workspace and can seed normally.)
  const CAGED_RO = !!process.env.MRC_ADVERSARY_FW
  linkOrMigrate(join(VA_SRC, 'command.md'), join(CLAUDE_DIR, 'commands', 'video-analysis.md'))   // rw config vol → always
  if (!CAGED_RO) {
    // The FW gate skips the KNOWN :ro container (the cage). The try/catch is defense against the CLASS (Pierre): if
    // a FUTURE mount ever gives some other container /workspace/.mrc :ro without MRC_ADVERSARY_FW, an EROFS here must
    // NOT kill container-setup — warn (fail-LOUD, so it's diagnosable, not a mystery crash) and CONTINUE. Only EROFS
    // is tolerated; any other write error still surfaces.
    try {
      const legacyCfg = join(MRC_LOCAL, 'video-frames.json')
      const newCfg = join(MRC_LOCAL, 'video-analysis.json')
      if (existsSync(legacyCfg) && !existsSync(newCfg)) { cpSync(legacyCfg, newCfg); rmSync(legacyCfg) }   // migrate old name → new
      copyIfAbsent(join(VA_SRC, 'defaults.json'), newCfg)                                                  // seed default config
    } catch (e) {
      if (e && e.code === 'EROFS') console.error(`  ! mrc: /workspace/.mrc is read-only — skipping the video-analysis config seed (${e.path || ''}). Continuing.`)
      else throw e
    }
  }
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

// 4. Project store. #5 STORE-MODE: the host mounted the /mrc slice (existsSync = the runtime coordination signal —
// the container FOLLOWS the mount, so a stale-labeled image with no /mrc mount degrades to legacy, never
// split-brain). Memory lives in /mrc, which is RW (no /workspace:ro EROFS), so the adversary cage transcript
// special-case DISSOLVES — a caged adversary symlinks to /mrc like everyone else. Retarget the project store to
// /mrc UNCONDITIONALLY every boot (Trap 4: fix a stale/wrong link from a config-restore or a just-activated
// store-mode). Fail-LOUD writable probe (the whole EROFS class was a SILENT transcript loss). Else → the existing
// behavior (adversary: a real dir in its config vol; normal: symlink to /workspace/.mrc). MUST equal src/mrc-store's
// mount path; container-setup owns MRC_STORE_MOUNT.
// #5 ADVERSARY-EXCLUDED: an adversary NEVER follows a /mrc mount. The host already keeps /mrc unmounted for an
// adversary (mrc.js storeActive = store.storeMode && !cagedAdversary) because its transcripts live in its own
// pierre config-vol as a REAL DIR that the repo/.mrc→slice migration never touches — so the store branch's
// real-dir rmSync (below) would DESTROY its un-migrated history. `&& !ADVERSARY` is belt-and-suspenders: even if
// a future host regression mounts /mrc for an adversary, the container refuses it and stays on the pierre-vol
// (ADVERSARY branch), so line 197 can never rmSync an adversary's only copy. For plain/solo/member the real-dir
// case is safe — their store is a symlink to /workspace/.mrc (host-migrated), so a real dir here is empty/fresh.
const STORE_MOUNTED = existsSync(MRC_STORE_MOUNT)
if (STORE_MOUNTED && !ADVERSARY) try {
  let cur; try { cur = lstatSync(PROJECT_STORE) } catch {}
  if (cur && cur.isSymbolicLink()) unlinkSync(PROJECT_STORE)                                            // drop a stale/wrong link — NEVER its target
  else if (cur && existsSync(PROJECT_STORE)) rmSync(PROJECT_STORE, { recursive: true, force: true })   // a real dir (a prior legacy store) → for plain/solo/member their transcripts were migrated to the slice host-side (repo/.mrc→/mrc); the store IS /mrc now. Adversary is excluded above (its real-dir pierre-vol store is un-migrated → never reaches here).
  mkdirSync(MRC_STORE_MOUNT, { recursive: true })
  mkdirSync(dirname(PROJECT_STORE), { recursive: true })   // #5 FIX: ensure ~/.claude/projects/ exists before the symlink — a FRESH config volume (a new repo's first store launch) lacks it after the config restore → symlink ENOENTs → FATAL. (The legacy branch already does this; the store-mode branch had missed it.)
  symlinkSync(MRC_STORE_MOUNT, PROJECT_STORE)
  const probe = join(MRC_STORE_MOUNT, `.mrc-write-probe-${process.pid}`); writeFileSync(probe, ''); rmSync(probe, { force: true })   // #5 per-session name — under per-uuid COEXIST two sessions probe /mrc at once; a shared name would race
} catch (e) {
  console.error(`FATAL: store-mode /mrc slice is not a writable real mount (${e.message}). A transcript would be silently lost — aborting.`)
  process.exit(1)
} else if (ADVERSARY) {
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
  // LEGACY: the project store is a symlink to /workspace/.mrc. CRITICAL (#13 de-activation): "already linked" must
  // mean linked to /workspace/.mrc SPECIFICALLY, not merely "is a symlink". A prior STORE-mode launch left the
  // symlink pointing at /mrc (MRC_STORE_MOUNT); on de-activation — an adoptable / unmigrated / opted-out repo now
  // running legacy, which #13 makes the COMMON path — /mrc is NOT mounted, so that stale link DANGLES. The old
  // `isSymbolicLink()`-only check read it as already-linked and skipped the retarget → the session read nothing and
  // started FRESH ("wiped"), even though its transcripts sit in /workspace/.mrc. So: retarget any link that doesn't
  // point at /workspace/.mrc. Drop the stale LINK only (never its target — /mrc's slice, or the legacy dir).
  let linkedTo = null
  try { const st = lstatSync(PROJECT_STORE); if (st.isSymbolicLink()) linkedTo = readlinkSync(PROJECT_STORE) } catch {}
  if (linkedTo !== MRC_LOCAL) {
    mkdirSync(MRC_LOCAL, { recursive: true })
    mkdirSync(dirname(PROJECT_STORE), { recursive: true })
    let cur; try { cur = lstatSync(PROJECT_STORE) } catch {}
    if (cur && cur.isSymbolicLink()) unlinkSync(PROJECT_STORE)                                          // stale/wrong link (e.g. → /mrc from a prior store launch) → drop the LINK, never its target
    else if (cur && existsSync(PROJECT_STORE)) { cpSync(PROJECT_STORE, MRC_LOCAL, { recursive: true }); rmSync(PROJECT_STORE, { recursive: true, force: true }) }   // a real legacy dir → migrate into /workspace/.mrc
    symlinkSync(MRC_LOCAL, PROJECT_STORE)
  }
} catch (e) {
  console.error('Warning: project store symlink failed:', e.message)
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
// Only Claude supports session resume — other agents get an empty flag.
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
      if (jsonls.length > 0) {
        // #5 per-UUID COEXIST: NEVER in-container `--continue` in store-mode — its newest-by-MTIME pick can diverge
        // from the host's per-uuid resolution AND from the per-conversation flock (MRC_SESSION_ID), so two coexisting
        // sessions could lock uuid A while `--continue` resumes B → co-write. The host ALWAYS resolves a concrete
        // MRC_SESSION_ID (an existing conversation when jsonls>0), so --resume it deterministically. Legacy unchanged.
        const sid = process.env.MRC_SESSION_ID || ''
        resumeFlag = (STORE_MOUNTED && sid) ? `--resume ${sid}` : '--continue'
      }
    } catch {}
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
