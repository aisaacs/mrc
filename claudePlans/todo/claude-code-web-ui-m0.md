# Claude Code web UI — M0 (read-only multi-session renderer) implementation plan

**Status:** Designed, ready to implement. **PARKED 2026-06-30** — holding all new features until the major git merge with Alessandro lands. Resume after the merge.
**Origin:** Research + design discussion, 2026-06-30 session ("get Claude Code out of the terminal"). The feasibility research, ToS pressure-test, and JSONL-streaming pressure-test are recorded inline below so this doc stands alone.
**Scope of THIS plan:** **M0 only** — the read-only, web-native renderer + multi-session dashboard. M1–M3 are sketched in the Roadmap section but are explicitly *out of scope here*.

---

## North star (one paragraph)

Get Claude Code out of the terminal: a browser app you can live in, with a dashboard of all your live + historical sessions across repos, each rendered web-natively (chat + collapsible thinking + tool cards + diffs), eventually reachable from anywhere. The full vision ("run") is an IDE-like surface. This plan delivers the **lowest-risk, highest-validation first slice**: a read-only renderer that proves the rendering half against real data, costs nothing, and touches no security surface.

---

## The hard constraints that shaped this (research findings, 2026-06-30)

### 1. Billing — interactive is the only reliably-free lane
- **Interactive Claude Code on Max/OAuth = normal subscription usage.** Unchanged, and it's exactly what mrc runs today.
- **`claude -p` (headless) and the Agent SDK = a *separate* metered credit pool** ($20 Pro / $100 Max5x / **$200 Max20x**) billed at **API rates**, then stops or spills to pay-as-you-go. It's also in flux (a credit-pool change was announced for June 15 2026, reportedly paused ~June 16 — sources conflict). Real users have been burned (one GH issue: $1,800 in two days from `-p`).
- **Consequence:** the obvious "drive a headless agent + render its event stream" architecture is precisely the credits/API path the owner has ruled out. **We must wrap the *interactive* session.**

### 2. ToS — the wrap-the-CLI design is defensible, with a clear line
Exact language from <https://code.claude.com/docs/en/legal-and-compliance> (fetched 2026-06-30):
> "Advertised usage limits for Pro and Max plans assume **ordinary, individual usage** of Claude Code and the Agent SDK."
> "**OAuth authentication** is intended exclusively for purchasers of … subscription plans and is designed to support **ordinary use of Claude Code and other native Anthropic applications**."
> "Anthropic does not permit **third-party developers to offer Claude.ai login or to route requests through Free, Pro, or Max plan credentials on behalf of their users**."

The prohibition targets a *developer serving other people* on subscription auth (that's what got the third-party client **OpenCode** server-side-blocked in Jan 2026). Our design sits on the safe side **because the web layer is a pure driver/renderer of the genuine official CLI** — it never authenticates, never calls the API, never serves anyone but the owner. Every API request still originates from the real Claude Code process, which is *literally what the OAuth clause says it's "designed to support."*

**Four permanent invariants (these are design law, not preferences):**
1. The web layer **NEVER touches credentials or the Anthropic API** — only the official CLI does.
2. **Single user (the owner), their own subscription, interactive cadence.**
3. **Never offer login to / serve other people.** ("Host it anywhere" = the owner reaching *their* sessions = fine; others using the owner's hosted instance = a ToS violation.)
4. Keep aggregate usage **"ordinary, individual."** A dashboard that makes 20 parallel 24/7 sessions trivial is how you'd accidentally cross the line.

> Not legal advice. For anything multi-user, the page itself says "contact sales."

### 3. Streaming — VERIFIED: block-level incremental, from the file alone
Dissected this very conversation's transcript (`/workspace/.mrc/b014ccc2-….jsonl`). A single assistant turn (one `message.id`) is split across multiple lines, **one per content block, each with its own timestamp spread across the generation**:
```
03:22:05  assistant  thinking    (block flushed)
03:22:11  assistant  text        (+6s)
03:22:24  assistant  tool_use     (+13s)
03:22:24  user       tool_result
```
Each `message.id` appears 2–5 times; tool_use → tool_result interleave in real time. **So tailing the file gives live, step-by-step updates** (thinking → text → "calling Edit on X" → result) at seconds latency. What the file does **not** give is token-by-token typewriter animation *inside* a text block — that exists only on the PTY. For M0, block-level is plenty; token-level is an optional later enhancement (tap the PTY) and explicitly out of scope.

### 4. The transcripts are on the host filesystem
`/workspace/.mrc/*.jsonl` (in-container) == `<repo>/.mrc/*.jsonl` **on the host** — that's *why* CLAUDE.md says they "survive volume resets / travel with the repo." So the host daemon reads every repo's sessions **directly from disk, for both live and historical sessions, with zero container changes.** This is already how `mrc sessions ls` works (`getSessions(mrcDir)`).

---

## Locked-in decisions

| Decision | Choice | Why |
|---|---|---|
| Overall architecture | Web app = **pure driver/renderer of the genuine interactive CLI**; never auth/API | Only path that's both free (interactive billing) and ToS-safe (invariants above) |
| M0 scope | **Read-only renderer + dashboard.** No input, no IDE editor, no remote hosting | Lowest risk; validates the hard part (rendering fidelity + live latency); zero ToS/cost/security exposure |
| Render source | Tail `<repo>/.mrc/<uuid>.jsonl` on the host | Host-accessible; block-level live; reuses existing parser |
| Container changes | **None** | M0 is pure host-side. (M1 input-injection is what touches the container — human-gated, later) |
| Live mechanism | SSE to the browser; `fs.watch` on Linux + **size-poll fallback on macOS/Colima** | Bind-mount inotify is unreliable across the Colima VM boundary |
| Daemon shape | Mirror the room-daemon/rooms-dashboard host patterns: bind `127.0.0.1` only, Host-header check, `findFreePort`, version-stamp, idle auto-shutdown | Proven, dependency-free, fits the security model |
| Port | `MRC_WEB_PORT`, default **8788** (next to the dashboard's 8787) | Consistent with existing convention |
| Network | **Localhost first.** Remote = M3 (behind an auth proxy/tunnel; invariant #3) | De-risk; remote is standard once the app exists |
| Adversary sessions | Label (or hide) Pierre sessions via `classifySession()`; **never** give them an input box in M1 | Containment is host-record-derived (session-record.js); don't leak/relax it in a new surface |

---

## Verified transcript schema (reference — so the implementer doesn't re-discover it)

Line `type` values seen (each line = one complete JSON object): `user`, `assistant`, `system` (`isMeta`,`subtype`,`durationMs`), `attachment`, `file-history-snapshot` (`messageId`,`snapshot`,`isSnapshotUpdate`), `ai-title` (`aiTitle`), `last-prompt`, `mode` (`mode`), `permission-mode` (`permissionMode`), `queue-operation`.

Key fields:
- **assistant**: `timestamp`, `uuid`, `parentUuid`, `requestId`, `isSidechain`, `gitBranch`, `cwd`, `version`, and `message` = `{ id, model, role, content[], stop_reason, stop_details, usage }`.
  - `content[]` block types: **`thinking`** (`.thinking`), **`text`** (`.text`), **`tool_use`** (`.id`,`.name`,`.input`).
- **user**: `message.content` is either a **string** (human turn; `isMeta:true` marks injected/non-human turns) or an **array** of **`tool_result`** blocks (`.tool_use_id`,`.content`); the line also carries structured **`toolUseResult`** + `sourceToolAssistantUUID`.
- Ordering: file order ≈ chronological, but the authoritative thread is the **`parentUuid`→`uuid` DAG** (handles edits/branches). Group consecutive same-`message.id` blocks into one assistant turn.
- **Recency** = `max(file mtime, last in-transcript timestamp)` — metadata lines (ai-title/mode/snapshots) bump mtime *without* a `timestamp`, so mtime is the truth (see `getSessions` comment).

> ⚠️ **Format is internal/unstable** — Anthropic's docs: "the entry format is internal to Claude Code and changes between versions." mrc already eats this cost (session naming parses these files); M0 rides the same risk. Keep all field access defensive (`?.`, try/catch per line).

---

## File-by-file implementation plan

### 1. `src/web/transcript-stream.js` (new) — normalizer + incremental follower
Extends the block-handling already in `src/sessions/transcript.js` (`extractTranscript`), but emits **structured render events** instead of text, and supports **tailing**.

```js
import { statSync, openSync, readSync, closeSync, watch } from 'node:fs'

// Normalize ONE parsed jsonl object into 0+ render events. Shared by the
// initial full read and the live tail. Mirrors extractTranscript's block logic.
export function renderEvents(obj) {
  const base = { ts: obj.timestamp || null, uuid: obj.uuid, parentUuid: obj.parentUuid, sidechain: !!obj.isSidechain }
  switch (obj.type) {
    case 'user': {
      const c = obj.message?.content
      if (Array.isArray(c)) {
        return c.filter(b => b.type === 'tool_result')
                .map(b => ({ kind: 'tool_result', forId: b.tool_use_id, content: b.content, structured: obj.toolUseResult, ...base }))
      }
      if (typeof c === 'string' && c.trim() && !obj.isMeta) return [{ kind: 'user', text: c, ...base }]
      return []
    }
    case 'assistant': {
      const c = obj.message?.content, id = obj.message?.id, usage = obj.message?.usage
      if (!Array.isArray(c)) return []
      return c.map(b =>
        b.type === 'thinking' ? { kind: 'thinking', text: b.thinking, msgId: id, ...base } :
        b.type === 'text'     ? { kind: 'assistant', markdown: b.text, msgId: id, usage, ...base } :
        b.type === 'tool_use' ? { kind: 'tool_call', id: b.id, name: b.name, input: b.input, msgId: id, ...base } :
        null).filter(Boolean)
    }
    case 'ai-title':              return [{ kind: 'title', text: obj.aiTitle }]
    case 'mode':                  return [{ kind: 'mode', mode: obj.mode }]
    case 'permission-mode':       return [{ kind: 'permission-mode', mode: obj.permissionMode }]
    case 'file-history-snapshot': return [{ kind: 'snapshot', messageId: obj.messageId, snapshot: obj.snapshot }]
    default: return []
  }
}

// Stateful follower over one session jsonl. Emits events for existing content,
// then for each appended line. Tracks a byte offset + carries a partial trailing
// line between reads (a flushed block can land mid-write).
export function followTranscript(file, onEvents, { pollMs = 800 } = {}) {
  let offset = 0, carry = ''
  const pump = () => {
    let size; try { size = statSync(file).size } catch { return }
    if (size <= offset) return
    const fd = openSync(file, 'r'); const buf = Buffer.alloc(size - offset)
    readSync(fd, buf, 0, buf.length, offset); closeSync(fd); offset = size
    const parts = (carry + buf.toString('utf8')).split('\n'); carry = parts.pop()
    const ev = []
    for (const line of parts) { if (!line) continue; try { ev.push(...renderEvents(JSON.parse(line))) } catch {} }
    if (ev.length) onEvents(ev)
  }
  pump()
  // Linux: fs.watch is reliable on bind mounts. macOS/Colima: inotify rarely
  // crosses the VM boundary → poll. Do both; pump() is idempotent on offset.
  let watcher = null; try { watcher = watch(file, pump) } catch {}
  const timer = setInterval(pump, process.platform === 'darwin' ? pollMs : pollMs * 4)
  return () => { try { watcher?.close() } catch {}; clearInterval(timer) }
}
```

### 2. `src/web/web-daemon.js` (new) — host HTTP server + SSE
Clone the serve scaffolding from `src/rooms-dashboard.js` **verbatim where possible**:
- `http.createServer`, `server.listen(free, '127.0.0.1')` — **loopback only**.
- **Host-header check** (reject unless `Host` is `127.0.0.1:<port>`/`localhost:<port>`) — anti-DNS-rebind (rooms-dashboard.js:82-87).
- `findFreePort(Number(process.env.MRC_WEB_PORT) || 8788)` from `src/ports.js`.
- `openBrowser(url)` — reuse the exact helper at rooms-dashboard.js:147.
- Version-stamp + idle auto-shutdown + `~/.local/share/mrc/web-daemon.json` record — mirror `room-daemon.js` lifecycle.

Endpoints:
- `GET /` → serve `src/web/app.html` (read each load so it can be edited live; `fileURLToPath(new URL('./app.html', import.meta.url))`).
- `GET /api/sessions` → the dashboard list (see Repo discovery below).
- `GET /api/session/:uuid/stream` → **SSE**. On connect: resolve uuid→`<repo>/.mrc`, `followTranscript()`, write each event batch as `data: {json}\n\n`. Close → tear down the follower.

Session list builder (reuse existing functions — do NOT reinvent):
```js
import { getSessions, loadNames, getSummaryPreview } from '../sessions/manager.js'
import { classifySession } from '../session-record.js'
// for each repo's mrcDir = join(repo, '.mrc'):
//   getSessions(mrcDir) -> [{uuid,lastUpdated,recencyMs,preview}]
//   names = loadNames(mrcDir);  summary = getSummaryPreview(mrcDir,uuid)
//   klass = classifySession(uuid)   // 'adversary' -> tag/hide; 'normal'/'unknown' -> show
//   live  = uuid ∈ runningContainerSessions   // see discovery
```

### 3. `src/web/app.html` (new) — the frontend (the bulk of the work)
Single dependency-free page (matches `rooms-dashboard.html`), **unless** the bundler decision below flips.
- **Left rail = the dashboard:** sessions grouped by repo; per row show name (`loadNames`) / live AI title (`ai-title` events) / summary / last-activity / mode chip / **live·idle badge**; float live sessions up. Adversary sessions tagged (or filtered).
- **Main pane = selected session, live:** subscribe to `/api/session/:uuid/stream`; render:
  - `user` → human bubble; `assistant` → **markdown**; `thinking` → collapsible; `tool_call` → **tool card** (Bash→cmd+output, Edit/Write→**diff** via `snapshot`, Read→file, Grep/Glob→pattern, Task→subagent header); `tool_result` → attach to its card by `forId`; `usage` → a context meter (mirror `mrc-statusline.js`).
  - `isSidechain` turns → **collapsible nested thread** (associate to the spawning `Task` tool_call — heuristic, see Known sub-problems).
  - Auto-scroll + jump-to-latest.
- **No input box** (or a disabled one labeled "driving lands in M1").

### 4. `src/commands/web.js` (new) — the `mrc web` CLI
`ensureWebDaemon()` (version-checked reuse / refresh / boot — pattern from `src/commands/pair.js`), then `openBrowser(url)`. Mirror `mrc rooms dashboard`.

### 5. `mrc.js` — wiring
- Route the `web` subcommand to `src/commands/web.js`.
- **Known-repos registry:** at launch, append the repo path to `~/.local/share/mrc/known-repos.json` (deduped) so the daemon can list *historical* repos that aren't currently running. One small write; see discovery.
- Add `mrc web` to the help/usage block.

### 6. `CLAUDE.md` — docs
- New Architecture component (host-side): "**Web UI daemon** — `src/web/web-daemon.js` + `app.html`: a localhost, read-only, web-native renderer of all sessions, tailing `<repo>/.mrc/*.jsonl`. Pure driver/renderer of the genuine interactive CLI — never authenticates or calls the API (ToS invariant)."
- New Key Design Decision: the wrap-the-CLI principle + the 4 invariants + why headless/SDK is excluded (billing + ToS).

### 7. `README.md` — short "Web UI" section: `mrc web`, `MRC_WEB_PORT`, localhost-only, read-only in M0.

---

## Repo discovery (which `.mrc` dirs to scan)
- **Live** sessions/repos: `docker ps --filter label=mrc=1` → read `mrc.repo` / `mrc.repo.name` / `mrc.web` labels (see `src/docker.js` `mrc status`). These mark which uuids are *live* (input box eligible in M1).
- **Historical** repos: the `~/.local/share/mrc/known-repos.json` registry written at launch (step 5). Union with live. Skip paths that no longer exist.

---

## Security posture (M0)
- Read-only; **loopback bind + Host-header check**; no credentials, no API, no container/mount/firewall changes → **not in the human-gated-security category.**
- If any control endpoint is ever added, reuse the **CSRF token** pattern (rooms-dashboard.js:108) — but M0 has none.
- Adversary (Pierre) sessions: label/hide via `classifySession()`; their containment is host-record-derived and must not be relaxed by this surface.
- **M1 (input injection) and M3 (remote) DO touch the security boundary** → per the project's "security changes are human-gated" rule, get an explicit nod before building those.

---

## Expected behavior after implementation
1. `mrc web` → boots/refreshes the web daemon, opens `http://127.0.0.1:8788/`.
2. Dashboard lists all sessions across repos, live ones badged + floated, with names/titles/summaries.
3. Click a live session → its conversation renders and **updates live** as Claude works (block-level: thinking → text → tool cards → results), at seconds latency.
4. Click a historical session → full rendered transcript, static.
5. Nothing is billed beyond the normal interactive session already running; nothing is sent to Anthropic by the web layer.

---

## Testing checklist
- [ ] `mrc web` boots, opens browser, lists sessions from ≥2 repos.
- [ ] Live session updates appear within ~1–2s of Claude emitting a block (Linux: fs.watch; macOS: poll).
- [ ] Historical (stopped-container) session renders fully from `<repo>/.mrc`.
- [ ] Markdown, collapsible thinking, Bash/Edit/Read tool cards, and a diff (from `snapshot`) all render.
- [ ] Subagent (`isSidechain`) turns nest/collapse correctly.
- [ ] A mid-write partial last line doesn't crash the follower (carry logic) and resolves on the next pump.
- [ ] Adversary session is tagged/hidden, never shown as a normal input target.
- [ ] Host-header check rejects a non-loopback `Host`; server refuses non-127.0.0.1 binds.
- [ ] Daemon idle-auto-shuts-down; an open page keeps it alive (onActivity keep-alive).
- [ ] Corrupt/truncated jsonl line → skipped, not fatal.

---

## Roadmap beyond M0 (OUT OF SCOPE here — listed so M0 doesn't paint us in)
- **M1 — input injection (driving).** Feed the human's typed message into the *live* interactive CLI via a PTY/tmux keystroke channel (likely run `claude` under tmux/node-pty in the container; web sends keys; render still from JSONL). *No official API for this — drive the terminal. Brittle to TUI changes. **Touches the container → human-gated.*** Turns viewing into a real client.
- **M2 — IDE chrome.** File tree + Monaco editor + git diffs over the bind-mounted repo. **Zero Claude coupling**, independent, low risk — the "text editor" part is actually the easy part.
- **M3 — remote hosting.** Auth proxy / Tailscale / Cloudflare Tunnel so the owner reaches their sessions from anywhere. **Crosses localhost → human-gated**; invariant #3 (single user, never serve others) is the hard rule.
- **Optional — token-level streaming.** Tap the PTY for typewriter-effect text; JSONL stays the structured source of truth.

---

## Known sub-problems to solve during implementation
- **Sidechain ↔ parent Task association.** Sidechain turns are flagged `isSidechain` but the link back to the spawning `Task` tool_call needs a heuristic (match by sub-agent id / parentUuid chain / sessionId). Verify against a real Task-bearing transcript.
- **Diff rendering source.** Decide diff source: the `file-history-snapshot` entries vs. Edit `tool_use.input` (old/new strings) vs. `toolUseResult`. Snapshots are richest but need decoding.
- **macOS live latency.** Confirm the poll fallback feels live enough on Colima; tune `pollMs`.

---

## Open decisions to resolve on resume
1. **Frontend deps:** dependency-free (matches repo norm, more hand-rolled markdown/diff work) **vs.** a small bundler + markdown/diff libs (faster, cleaner, breaks the "no deps" convention). *Leaning: small bundle — the renderer is real frontend work and hand-rolling markdown+diff dep-free is a poor use of time. Owner's call.*
2. **Daemon placement:** standalone `web-daemon` **vs.** a new tab/route inside the existing **room daemon** (they share Host-check, CSRF, findFreePort, lifecycle, idle-shutdown). *Leaning: standalone for clean separation now; fold-in later if duplication hurts.*
3. **Historical-repo discovery:** the `known-repos.json` registry (proposed) **vs.** scanning common roots for `.mrc` dirs. *Leaning: registry — explicit, cheap, no surprise filesystem walks.*

## Questions to flag with the owner on resume
- Confirm the 4 ToS invariants are acceptable as permanent constraints (esp. #3: never multi-user — this caps "host it anywhere" to *your* access only).
- Resolve the 3 open decisions above before coding.
- Confirm M0-then-M1 sequencing still matches appetite (read-only first, driving second).
