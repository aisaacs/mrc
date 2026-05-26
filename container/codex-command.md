Get a second opinion from Codex (OpenAI). Run the user's prompt through Codex
non-interactively and present the results.

Prompt: $ARGUMENTS

Run this using `codex exec` in a Bash tool call:

```
codex exec --dangerously-bypass-approvals-and-sandbox "$PROMPT"
```

Where $PROMPT is the user's arguments above, expanded with any relevant context
(current file paths, recent changes, etc.) to give Codex enough information to
be useful.

After Codex responds, present its output clearly. If you have a different view
on any point Codex raised, note the disagreement — the whole point is a fresh
perspective.
