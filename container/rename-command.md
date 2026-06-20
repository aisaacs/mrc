---
description: Rename the current mrc session (updates the status line + the session picker)
---

Rename the current mrc session — the human asked the session to rename itself.

Decide the new name:
- If the user gave a name in `$ARGUMENTS`, use it (lightly cleaned — trim, single line).
- If `$ARGUMENTS` is empty, choose a concise, descriptive name (3–5 words, lowercase-with-hyphens) that
  captures what THIS session has actually been about so far, from the conversation. This is the common
  case — the session was auto-named too early or poorly, and now there's enough context for a better one.

Then apply it by running the container helper:

`mrc-rename "NEW NAME HERE"`

Relay the helper's one-line confirmation. The status line picks up the new name on its next render; the
`mrc pick` / `mrc sessions` list shows it the next time the session is resumed. (If the command errors
because `/workspace` is read-only, this is a sandboxed adversary session and cannot be renamed.)
