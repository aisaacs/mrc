# MRC for VS Code

Sandboxed Claude Code chat panel inside VS Code, powered by [mrc](../README.md).

## Prerequisites

- **mrc** installed and working (Docker, API key, etc.)
- **VS Code** 1.85+
- **Docker** running (or Colima on macOS)

## Install

Create a symlink from the VS Code extensions directory to this folder:

```bash
# macOS / Linux
ln -s /path/to/vscode-mrc ~/.vscode/extensions/mrc-vscode

# Verify
ls -la ~/.vscode/extensions/mrc-vscode
```

Reload VS Code (`Cmd+Shift+P` → "Reload Window").

The extension auto-detects `mrc.js` by resolving the symlink back to the repo. If your layout is different, set the path explicitly:

```
Settings → Extensions → Mister Claude → Executable Path
```

## Usage

| Shortcut | Command | What it does |
|---|---|---|
| `Cmd+Shift+M` | MRC: Open Chat | Opens the chat panel (shows session picker) |
| `Cmd+Shift+L` | MRC: Send Selection | Sends selected code to the chat as context |
| `Cmd+Shift+;` | MRC: Switch Session | Switch between sessions mid-conversation |

On first open, a session picker appears — pick an existing session to resume or start a new one.

## How it works

1. **Daemon mode** — The extension starts an mrc container in the background (`mrc --daemon`). The container stays running between messages.
2. **Per-message exec** — Each message spawns `docker exec ... claude -p "your message"` inside the running container. Output streams back as JSON events.
3. **Session continuity** — Sessions are stored in `<repo>/.mrc/` as JSONL files. Resuming a session passes `--resume <uuid>` to Claude Code.

## Features

- Streaming responses with real-time thinking indicator
- Tool use display (file paths, commands)
- Context window usage bar
- Image paste support (Cmd+V with an image)
- Session history on resume
- Send editor selections as context

## Settings

| Setting | Default | Description |
|---|---|---|
| `mrc.executablePath` | (auto-detect) | Path to `mrc.js` |
| `mrc.extraArgs` | `[]` | Extra args passed to mrc (e.g. `["--web"]`) |

## Troubleshooting

**"Failed to start" / no container ID**
- Is Docker running? (`docker ps`)
- Does `mrc --daemon .` work from the terminal?
- Check the mrc image exists: `docker images mister-claude`

**No response / stuck on "Thinking"**
- Check the container is alive: `docker ps | grep mrc`
- Try a simple prompt from terminal: `docker exec <id> claude -p "hello"`

**Avatar not showing**
- Make sure `mrc.png` exists in the extension directory

**Extension not loading**
- Verify symlink: `ls -la ~/.vscode/extensions/mrc-vscode/package.json`
- Reload window after creating the symlink
