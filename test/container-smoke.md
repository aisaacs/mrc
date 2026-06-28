# Container-path smoke checklist

The 154 host tests (`node --test test/`) cover everything that runs **host-side** — the room engine, the
@user inbox, persistence, the Telegram transport/auth, the trust defang, CSRF, the version stamp. They
**cannot** reach the *container* path: the Docker image build, launching a member in its sandbox, the
in-container Channels accept, live @mention routing, worker-exec, and a real Telegram round-trip. Those
need Docker + a human, so they're validated by running this checklist by hand.

**Legend:** ✅ = pass criterion · 🖐️ = a step that needs a human action (not automatable) · ⏱️ ≈ time.

**Record every check as PASS / FAIL / SKIPPED — never leave one blank, and a check you can't run is
SKIPPED, not PASS.** Some checks are conditional (no worker member → #6; Telegram not configured → #5).
If you skip one, write **SKIPPED + why** — a skip silently read as a pass is exactly the failure mode
the restart-safety work just closed; don't reintroduce it in the test for it.

Run from a repo you don't mind launching a team in (`<repo>` below). Do **#0 first** (it deploys the
restart-safety fix this checklist depends on).

---

### 0. Deploy the restart-safety fix (one-time)  ⏱️ ~10s
The running daemon can't reload itself, so load the committed `#28` code once:
```bash
pkill -f room-daemon.js
rm -f ~/.local/share/mrc/room-daemon.json   # the daemon's META file only (port/pid/version record) — NOT your data: the inbox, rooms, and transcripts are untouched
mrc rooms dashboard          # boots a fresh daemon on current code + opens the dashboard
```
- ✅ `mrc rooms status` prints a **Daemon version** stamp (12 hex chars).
- Note that stamp — check #2 proves it now tracks the whole `src/` tree.

---

### 1. Build + launch  ⏱️ ~2–5 min (first build)
```bash
docker rmi mister-claude                 # force a clean image rebuild (entrypoint/firewall/channel-server changed)
mrc team up <repo>                        # writes a team.json if none, builds the image, launches the live members in tmux
```
🖐️ **Accept the Channels prompt in each member's terminal** — `mrc team up` opens a tmux session per
live member; each shows a one-time "Channels" consent you must accept to bring it online. (This is the
human-in-the-loop step by design — there is no hands-free launch.)
- ✅ Every **live** member reads **online/ready** after you've accepted each. *(This — channel-registered = container up + Channels-accepted — is the container-path proof. `mrc team status` merely **listing** the members is true from the roster definition alone, so it's a precondition, not the proof.)*
- ✅ `mrc rooms dashboard` → the project tab shows the team with green member dots.
- ❌ If a member stays "starting", open its console (`mrc team console <handle>`) — it's likely waiting on the Channels accept or a login.
- ⚠️ **Known issue, NOT a test failure (D1):** a member may transiently read **offline shortly after connecting**, or a reconnect (a "[Joined as …]" line) may briefly null its binding — the deterministic-sessionId churn captured in the architecture review (`handoff-docs/architecture-review-room-team-daemon.md`); **#28 did not fix it**. If a member *flaps* offline→online, re-check after a moment or re-run `mrc team up`. Only score FAIL if a member stays **persistently** offline while its console shows it connected.

---

### 2. #28 deploy proof — the version stamp tracks the whole dep closure  ⏱️ ~30s
This is the thing that was broken (a stale daemon serving old code). Prove it's fixed:
```bash
mrc rooms status                                   # note the Daemon version stamp  (call it V1)
printf '\n// smoke-test touch\n' >> src/teams/trust.js   # edit a daemon-IMPORTED module (not room-daemon.js)
mrc rooms restart
mrc rooms status                                   # note the stamp again (V2)
git checkout -- src/teams/trust.js                 # undo the test edit (NB: discards any uncommitted edits to this file — it has none mid-smoke-test; or just delete the appended "// smoke-test touch" line by hand)
mrc rooms restart                                  # back to clean code
```
- ✅ **V2 ≠ V1** — editing an *imported* module changed the stamp (the old single-file hash would NOT have), so `mrc rooms restart` could detect and load it. *(Before #21b this was the silent-stale-code bug.)*
- ✅ After the `git checkout` + restart, the stamp returns to **V1** (deterministic).

---

### 3. @mention routing — directed delivery  ⏱️ ~1 min
**Precondition: ≥3 live members.** A 2-member room has a consult-style "no-mention → the other member" fallback that delivers *without* a mention, which muddies the negative proof — on a 2-member roster, run only the positive ✅ and mark the negative **SKIPPED**.

In the architect's console (`mrc team console <architect-handle>`), @mention **exactly one** member (the engineer):
```
@<engineer> please add a comment to the top of <some file in the engineer's territory>
```
- ✅ The engineer **receives** the message (visible in its console / the dashboard transcript) and acts.
- ✅ A **different, third** live member — one you did **not** @mention — receives **nothing** (directed delivery, no broadcast). Confirm that third member's transcript shows no copy of the message.
- ⚠️ **D1 caveat (see check 1):** if the target member is mid-flap (transiently offline-while-connected), the directed message can be delayed/mis-handled — give it a moment or re-send before scoring. Only a *persistent* non-delivery to an online member is a routing FAIL.

---

### 4. @you inbox — question vs FYI, and reply round-trip  ⏱️ ~1 min
Have a member reach you both ways (or steer it to: ask a member to "ask me a question via ask_user" and separately "send me a plain @user note").
- ✅ The `ask_user` one lands in the dashboard **@you inbox as a ❓ question** and **badges** the tab.
- ✅ The plain `@user` one lands as a **🔔 FYI** and does **NOT** badge (reply-optional).
- Reply to either from the dashboard.
- ✅ The member **receives your reply** (a `[Human reply]` directive, visible in its console/transcript), and the inbox item shows answered.

---

### 5. Telegram round-trip  🖐️ ⏱️ ~3 min  *(the path we couldn't exercise in the host loop)*
Set up per the docs (`docs/agent-teams.md` §7):
1. 🖐️ BotFather → `/newbot` → copy the token → put it in `<repo>/.env` as `MRC_TELEGRAM_BOT_TOKEN=…`
2. `mrc rooms restart` (so the bridge picks up the token), then 🖐️ DM the bot `/start`
3. 🖐️ In the dashboard, the chat shows **pending** on the project tab → click **Confirm**.
- ✅ A member's `@user` **question pushes to your phone** with `❓ … #N … reply to answer`.
- ✅ **Reply from Telegram** → the answer routes back to the member (its console shows the `[Human reply via Telegram]`).
- ✅ **H4 both ways:** answering/dismissing in the dashboard **edits** the Telegram message to "resolved"; replying on Telegram **closes** the dashboard reply box with "✓ Answered via Telegram".
- ❌ If a push fails, `mrc rooms status` / the dashboard surfaces `lastPushError` with the real reason (e.g. a stale chat_id) — it is never silent.

---

### 6. Worker-exec (non-Claude member) — the INTEGRATED room path  ⏱️ ~1 min  *(conditional — needs a `codex` worker)*
If the roster has **no** `codex` member, mark this **SKIPPED** (don't pass it). The `web`/`backend`
presets include one; otherwise add a `{ "role": "...", "backend": "codex" }` member. **Use `codex` specifically:** only `api.openai.com` is firewall-whitelisted, so a `gemini` media worker fails *at the firewall* unless you launch with `--web` — testing with `codex` keeps a failure attributable to the worker path, not egress.

**Primary proof — use an @mention, NOT `mrc team exec`.** From another member's console (or a steer), @mention the worker:
```
@<worker-handle> summarize what this repo does in two sentences
```
- ✅ The @mention **queues** the worker → its CLI runs in its sandboxed container → its reply is **posted back into the room transcript, addressed to whoever pinged it** (visible in the dashboard / console). This `workerQueue → worker-runner → engine` post-back is exactly the integrated path the host suite can't exercise.
- ❌ A failed invoke posts a **graceful error** into the room — never a silent drop.

> ⚠️ `mrc team exec <worker-handle> "…"` runs the worker's CLI and prints to **stdout only** — it smokes the container-exec mechanics alone and does **NOT** post back to the room. Useful as a sub-check, but do **not** count it as the integrated proof; the **@mention** is what proves the room path.

---

### 7. F2 crash-durability (optional but recommended)  ⏱️ ~1 min
Prove a hard kill can't lose the inbox (the F2 fix):
```bash
# with a pending @you question in the inbox:
pkill -9 -f room-daemon.js        # SIGKILL — the worst case (no graceful save)
mrc rooms dashboard               # relaunch
```
- ✅ The pending question is **still in the @you inbox** after the relaunch (atomic writes survived the kill).
- ✅ If a state file were ever torn, `~/.local/share/mrc/daemon.log` logs `[F2] corrupt JSON … preserved as …corrupt-<ts>` and the file is quarantined — never silently dropped.

---

**Reporting:** note PASS/FAIL per numbered check. Any ❌ is a real container-path regression worth filing
(the host suite wouldn't have caught it). The manual 🖐️ steps (Channels accept, Telegram Confirm) are the
intended human-in-the-loop controls, not failures.

---

### Coverage gaps — what this checklist does NOT yet prove  *(future #5 hardening; honest scope, not silent)*
Stated plainly so "ran the smoke test" isn't read as "the whole container path is proven":
- **Territorial rw/ro mount boundary** (the "read-only by capability, not etiquette" claim, agent-teams.md §4) is unproven. *To add:* in a **read-only member's** console, `echo x > /workspace/<some-file>` must **fail with an FS permission error** (not the agent politely declining); an rw engineer can write its own territory but **not** a sibling team's.
- **Media members (host-side path):** @mentioning a designer/composer runs generation **host-side** (no container, untrusted-text-driven, **no cost cap** today) — a ping there spends a real API call. Not covered; conditional check + that caveat belong here if a roster includes one.
- **Persona injection:** nothing explicitly confirms `--append-system-prompt` took (a member knows its handle/role) — check #3 only shows it implicitly.
- **tgPushed-not-persisted:** a Telegram reply sent *after* a daemon restart maps to nothing and falls back to a broadcast directive — check #5's restart is *before* the push, so this degradation isn't exercised.

These are gaps in the *test*, not known code regressions; they're in the captured backlog.
