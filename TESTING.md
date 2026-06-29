# Test Checklist

Features awaiting @user verification. Activation: 🔄 reload dashboard · ♻️ `mrc rooms restart` · 🐳 Docker rebuild (`docker rmi mister-claude` + relaunch).

## Awaiting test (since the Settings redesign)
- [ ] **Settings → gear-icon modal** (#46) 🔄 — top-right ⚙ opens a modal; closing returns to your exact place
- [ ] **@you inbox → Slack-style channel** (#47) 🔄 — one @you row → sequential thread; reply per-message; click a notification → jumps to it
- [ ] **Worker console → call-history** (#48) ♻️ — per-call cards, honest ✓/✕ verdict (surfaces silent failures), image thumbnails + audio players
- [ ] **Never-blank terminal** (#4a) 🔄 — placeholder + "live from here, earlier output not replayed" banner instead of a blank box
- [ ] **Builder header + ✕ Cancel + discard-guard** (#55) 🔄 — "New project"/"Editing {org}" header; ✕ Cancel returns to place; confirms before discarding unsaved edits
