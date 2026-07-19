# 🎩 Mister Claude

```
      __  __ ____     ____  _                 _
     |  \/  |  _ \ . / ___|| | __ _ _   _  __| | ___
     | |\/| | |_) |  | |   | |/ _` | | | |/ _` |/ _ \
     | |  | |  _ <   | |___| | (_| | |_| | (_| |  __/
     |_|  |_|_| \_\   \____|_|\__,_|\__,_|\__,_|\___|
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Sandboxed Claude Code  ·
  "It's my industrial-strength hair dryer, AND IT WORKS."
```

A sandboxed Docker container for [Claude Code](https://docs.anthropic.com/en/docs/claude-code) with an iptables firewall.
Your code stays on the host, VS Code sees changes instantly, and Claude stays in his room.

## What he can reach

| Domain | Why |
|---|---|
| `api.anthropic.com` | His brain |
| `registry.npmjs.org` | npm packages |
| `sentry.io` | Telemetry |
| `statsig.anthropic.com` / `statsig.com` | Telemetry |

Everything else is blocked. He'll get an immediate REJECT if he tries.

## Files

```
mrc.js               # the command — builds, mounts, launches (Node.js)
src/                  # host-side modules (colima, docker, config, proxies, sessions)
Dockerfile           # his room — node:24-slim + Claude Code + firewall tools
entrypoint.sh        # waits for network, runs firewall, starts agent
init-firewall.sh     # iptables + ipset whitelist — the lock on the door
container/           # container-side scripts (setup, hooks, statusline)
clipboard-shim.sh   # container-side xclip replacement
.env                 # your API key (not checked in)
.mrc/                # project-local Claude memory (auto-created, gitignored)
```

## Prerequisites (macOS, from scratch)

You need Homebrew, Node.js, and the Docker CLI tools + Colima (a lightweight Docker runtime — no Docker Desktop, no GUI, no license fees).

### 1. Install Homebrew

If you don't have it yet:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Follow the instructions it prints at the end to add `brew` to your PATH. For Apple Silicon Macs this is usually:

```bash
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"
```

### 2. Install Docker + Colima

```bash
brew install node docker docker-buildx colima terminal-notifier
```

This installs:
- `node` — the runtime for the `mrc` launcher (it's a Node.js script)
- `docker` — the CLI client (no daemon, just the command)
- `docker-buildx` — the build plugin (required for `docker build`)
- `colima` — a lightweight Linux VM that runs the Docker daemon
- `terminal-notifier` — native macOS notifications

### 3. Configure the buildx plugin

Docker needs to know where Homebrew installed the buildx plugin:

```bash
mkdir -p ~/.docker
echo '{"cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"]}' > ~/.docker/config.json
```

> **Note:** If you already have a `~/.docker/config.json` with other settings, merge the `cliPluginsExtraDirs` key into it manually instead of overwriting the file.

### [Optional] 4. Get an Anthropic API key

Go to [console.anthropic.com](https://console.anthropic.com/) and create an API key. A dedicated key for Mister Claude is recommended so you can revoke it independently.

## Setup

1. **Install via script:**

   ```bash
   curl -fsSL https://aisaacs.github.io/mrc/install.sh | bash
   ```

   Or **from source** (requires Node.js 22+):

   ```bash
   git clone git@github.com:aisaacs/mrc.git
   cd mrc
   sudo ln -s "$(pwd)/mrc.js" /usr/local/bin/mrc
   ```

2. [Optional] **Create the `.env` file** (next to mrc.js or at `~/.config/mrc/.env`):

   ```bash
   echo "MRC_SESSION_NAMING_ANTHROPIC_API_KEY=sk-ant-..." > .env
   ```

   This key is used **only** on the host for cheap Haiku calls that name and
   summarize sessions — the sandboxed session itself runs on your Max/OAuth login,
   not this key. Replace `sk-ant-...` with your actual key. This file is gitignored.

   1Password references are supported:
   ```
   MRC_SESSION_NAMING_ANTHROPIC_API_KEY="op://Vault/Key/credential"
   OPENAI_API_KEY="op://Vault/OpenAI/credential"
   ```

## Usage

```bash
# Open a project
mrc ~/projects/my-app

# Pass arguments to Claude Code after --
mrc ~/projects/my-app -- -p "refactor the auth module"
mrc ~/projects/my-app -- --model claude-sonnet-4-5-20250929

# Use Codex instead of Claude
mrc --agent codex ~/projects/my-app

# Current directory
mrc .

# Verbose mode (shows Colima and Docker output)
mrc -v ~/projects/my-app

# Run in background (daemon mode)
mrc --daemon ~/projects/my-app

# Stream JSON output (for embedding)
mrc --json ~/projects/my-app
```

First run builds the Docker image (~2 min). After that it's ready in about 5 seconds while the firewall sets up.

When you quit Claude, the container disappears. Your files are safe on the host — only the container is ephemeral.

Claude's global config (auth, settings, plugins) is persisted in a per-repo Docker volume (`mrc-config-<hash>`) between runs. Codex config is persisted in a separate volume (`mrc-codex-<hash>`). Project-specific data (memory, conversation history, project settings) is stored in `.mrc/` inside the repo itself — it survives volume resets and travels with the project.

Sessions auto-resume: when you re-open the same repo, Claude picks up where you left off. To start a new conversation instead, use `mrc --new`.

## Sessions

Each conversation is saved in `.mrc/` and can be listed, named, and resumed.

```bash
# Start a new named session
mrc --new fix-bug-42

# Start a new unnamed session
mrc --new

# Interactive session picker
mrc pick

# List sessions
mrc sessions ls

# Name the most recent session
mrc sessions name "auth-refactor"

# Name a specific session by number
mrc sessions name "clipboard-fix" 2

# Resume a session by name or number
mrc sessions resume auth-refactor
mrc sessions resume 2
```

## Keeping secrets from Mister Claude

Create a `.sandboxignore` file in the root of the repo you're mounting:

```
# Secrets
.env
.env.local
.env.production

# Infrastructure
terraform/
k8s/
secrets/
```

- **Files** are masked with `/dev/null` (appear empty inside the container)
- **Directories** get an anonymous volume overlay (appear as empty directories)
- Comments (`#`) and blank lines are supported

He doesn't know what he's missing.

## Data persistence

Mister Claude stores data in two places:

**Per-repo Docker volumes** — `mrc-config-<hash>` holds global Claude config (auth state, settings, plugins). `mrc-codex-<hash>` holds Codex config. Each repo gets its own volumes (keyed by MD5 hash of the repo path) so projects don't contaminate each other. The volume name is shown in the banner at startup.

**`.mrc/` in your repo** — holds project-specific Claude data: memory, conversation history, project settings. This directory is:
- Auto-created on first run
- Auto-added to `.gitignore`
- Symlinked from `~/.claude/projects/-workspace/` inside the container

Because `.mrc/` lives in the repo, it survives volume resets and travels with the project if you move or clone it. To start fresh, just `rm -rf .mrc/`.

To nuke the volume for a repo:

```bash
# Find the volume name (shown in the mrc banner, or:)
docker volume ls | grep mrc-config

# Remove it
docker volume rm mrc-config-<hash>
```

## Colima resources

By default, `mrc` gives the Colima VM **all your CPU cores** and **half your system RAM** (with an 8GB floor). Override with flags or in your `.mrcrc`:

```bash
# CLI
mrc --colima-cpu 8 --colima-memory 32 ~/projects/my-app

# Or in ~/.mrcrc (applies to every session)
--colima-memory 48
```

Resource settings only take effect when `mrc` starts Colima. If Colima is already running, it keeps its current settings. To pick up changes:

```bash
colima stop
mrc ~/projects/my-app
```

## Letting him visit new places

Edit the domain list in `init-firewall.sh`:

```bash
ALLOWED_DOMAINS=("registry.npmjs.org" "api.anthropic.com" "platform.claude.com" \
                 "api.openai.com" "auth.openai.com" "chatgpt.com" \
                 "sentry.io" "statsig.com" \
                 "your-private-registry.com")   # ← add your own here
```

Then just relaunch — `init-firewall.sh` is COPY'd near the end of the Dockerfile, so Docker's layer
cache rebuilds only from that COPY down. No `--rebuild` needed:

```bash
mrc ~/projects/my-app
```

The next `mrc` run will rebuild the image with the new firewall rules.

## How it works

1. `mrc` resolves the repo path, auto-starts Colima if needed, builds the Docker image, reads `.sandboxignore`, creates per-repo config volumes, starts in-process clipboard and notification proxies, and starts the container with the repo bind-mounted at `/workspace`
2. The container runs as a non-root `coder` user with UID/GID matching your host user (no permission weirdness with bind-mounted files)
3. `entrypoint.sh` waits for the network, then runs `init-firewall.sh` via passwordless sudo
4. The firewall resolves each allowed domain to IPs, adds them to an `ipset`, sets the default iptables policy to DROP, and verifies that `example.com` is unreachable
5. The entrypoint runs `container-setup.js` to merge plugin config and symlink Claude's project store into `/workspace/.mrc/`
6. The selected agent starts with full permissions — the container is the security boundary

## Customization

**More system tools** — add packages to the `apt-get install` line in the Dockerfile:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    ripgrep \
    sudo \
    iptables \
    ipset \
    iproute2 \
    dnsutils \
    python3 \        # ← add what you need
    && rm -rf /var/lib/apt/lists/*
```

**Different Node version** — change the base image in the Dockerfile:

```dockerfile
FROM node:22-slim    # or node:20-slim, etc.
```

**Let him run free** (no firewall) — replace the ENTRYPOINT in the Dockerfile:

```dockerfile
ENTRYPOINT ["claude", "--dangerously-skip-permissions"]
```

## Clipboard (image paste)

Text paste works out of the box (it travels through the terminal as stdin), but pasting images requires a clipboard bridge between the host and the container. Mister Claude ships one — an in-process TCP proxy built into the launcher.

### How it works

1. `mrc` starts a TCP clipboard server on a dynamic port
2. Inside the container, a shim installed at `/usr/local/bin/xclip` intercepts Claude Code's clipboard reads
3. The shim connects to the proxy via `host.docker.internal` and fetches clipboard data over TCP

The banner will show `Clipboard: the Schwartz can see your clipboard` when the proxy is running.

### Usage

Just copy an image to your clipboard on the host and press **Ctrl+V** inside Claude Code. That's it.

### Troubleshooting clipboard

**Banner doesn't show the clipboard line** — The clipboard proxy failed to start. Check for port conflicts or run with `-v` for details.

**"No image found in clipboard"** — Try these steps:

1. From inside the container, verify connectivity:

   ```bash
   printf 'GET TARGETS\n' | socat -,ignoreeof TCP:host.docker.internal:7722
   ```

2. Check the shim logs inside the container:

   ```bash
   cat /tmp/mrc-xclip-shim.log
   ```

**"No route to host" in shim logs** — The firewall may be blocking traffic to `host.docker.internal`. Relaunch `mrc` to pick up the latest firewall rules (`init-firewall.sh` is a late COPY layer, so a plain launch rebuilds it).

## Notifications

Mister Claude sends a desktop notification whenever Claude needs your attention — when he finishes a response, when he asks for permission to run a tool, and when he shows the plan approval prompt. Work in another window and he'll tap you on the shoulder when he needs you.

### Prerequisites

Install `terminal-notifier` on the host:

```bash
brew install terminal-notifier
```

### Do Not Disturb

Notifications come from the **terminal-notifier** app. To let them through macOS Focus / Do Not Disturb:

1. **System Settings** → **Focus** → **Do Not Disturb**
2. **Allowed Notifications** → **Apps** → **Add** → select **terminal-notifier**

### Options

```bash
mrc --no-notify ~/projects/my-app   # disable notifications entirely
mrc --no-sound ~/projects/my-app    # notifications without the Glass sound
```

### Troubleshooting notifications

**Notifications appear in Notification Center but not on screen** — The notification style is set to "None". Go to **System Settings** → **Notifications** → find **terminal-notifier** → set the style to **Banners** (auto-dismiss) or **Alerts** (stay until dismissed).

**No notifications while screen sharing or mirroring** — macOS suppresses notifications during screen sharing by default. Go to **System Settings** → **Notifications** → **Show Notifications** → set **"when mirroring or sharing the display"** to **Allow Notifications**.

**Two terminal-notifier entries in notification settings** — This is a known quirk. One is typically from Homebrew, the other from a previous install or a bundled copy. Make sure both have notifications enabled and the style set to Banners or Alerts.

**Notifications not appearing at all** — macOS may silently block `terminal-notifier` on first use. Go to **System Settings** → **Notifications** → find **terminal-notifier** → make sure **Allow Notifications** is toggled on.

**Quick test from the host** — Run this to verify `terminal-notifier` works outside of mrc:

```bash
terminal-notifier -title "Mr. Claude · test" -message "Ready for input." -sound Glass
```

If nothing appears, check the settings above. If you see an error, make sure it's installed (`brew install terminal-notifier`).

## Troubleshooting

**`docker: command not found`** — Run `brew install docker docker-buildx colima` and make sure Homebrew is on your PATH.

**`Cannot connect to the Docker daemon`** — Colima isn't running. Start it with `colima start --vm-type vz --mount-type virtiofs` or just run `mrc` and it will auto-start Colima.

**`ERROR: Network not ready after 30 attempts`** — The container couldn't resolve DNS. Try `colima stop && colima start --vm-type vz --mount-type virtiofs` to restart the VM.

**`ERROR: Firewall verification failed`** — The iptables rules didn't take effect. Make sure the container has `--cap-add=NET_ADMIN --cap-add=NET_RAW` (this is handled by `mrc` automatically).

**Permission errors on mounted files** — The Docker image builds with your UID/GID. If you see permission issues, run `mrc --rebuild` — UID/GID are `--build-arg`s consumed by an early `RUN`, so busting the cache is what re-applies them.

**`✗ Auto-update failed`** — Claude Code's version is baked into the Docker image at build time and auto-update is disabled inside the container. This is the case that genuinely needs `--rebuild`: the Dockerfile text is unchanged, so a cached build would reuse the stale binary layer.

```bash
mrc --rebuild ~/projects/my-app
```

**Slow file access** — Make sure Colima is running with `--mount-type virtiofs`. `mrc` does this automatically when it starts Colima; if you started Colima manually without that flag, stop and let `mrc` restart it.
