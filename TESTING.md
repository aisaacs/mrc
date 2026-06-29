# Test Checklist

Features awaiting @user verification. Activation: 🔄 reload dashboard · ♻️ `mrc rooms restart` · 🐳 Docker rebuild (`docker rmi mister-claude` + relaunch).

## Awaiting test (since the Settings redesign)
- [ ] **Settings → gear-icon modal** (#46) 🔄 — top-right ⚙ opens a modal; closing returns to your exact place
- [ ] **@you inbox → Slack-style channel** (#47) 🔄 — one @you row → sequential thread; reply per-message; click a notification → jumps to it
- [ ] **Worker console → call-history** (#48) ♻️ — per-call cards, honest ✓/✕ verdict (surfaces silent failures), image thumbnails + audio players
- [ ] **Never-blank terminal** (#4a) 🔄 — placeholder + "live from here, earlier output not replayed" banner instead of a blank box
- [ ] **Builder header + ✕ Cancel + discard-guard** (#55) 🔄 — "New project"/"Editing {org}" header; ✕ Cancel returns to place; confirms before discarding unsaved edits
- [ ] **Send image to Telegram** (#56) 🐳 — a live member's `send_photo` pushes an image from its own territory to your linked Telegram chat (needs a confirmed chat; image-only, own-territory-only, you don't choose the recipient)
- [ ] **Project home panel** (#61) 🔄 — entering a project lands on a HOME overview (members/rooms/status) + its Telegram/--web/Delete settings; the ⚙ gear is now global-only; clicking the active tab reopens home
- [ ] **Markdown in room messages** (#63-A) 🔄 — room-transcript messages render safe markdown (bold/italic/`code`/links/lists); raw HTML stays inert text, and the [#N] chip / re-#N jump can't be forged from a member's message text
- [ ] **Project/team name validation** (#65) 🔄 — a project/team name with quotes or HTML/JS metacharacters is rejected at parse; readable names with spaces + accents ("My Project", "Équipe Alpha", "项目") still work (closes a dashboard XSS via a malicious team.json)
- [ ] **Slack-style room transcript** (#63-B) 🔄 — room messages show a per-message author header (name + role-color), consecutive-same-author grouping, timestamps, and markdown bodies (also needs `mrc rooms restart` so new messages carry the enriched author fields; older messages render header-less)
