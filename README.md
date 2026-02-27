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
mrc                  # the command — builds, mounts, launches
Dockerfile           # his room — node:22-slim + Claude Code + firewall tools
entrypoint.sh        # waits for network, runs firewall, starts claude
init-firewall.sh     # iptables + ipset whitelist — the lock on the door
.env                 # your API key (not checked in)
```

## Prerequisites (macOS, from scratch)

You need three things: Homebrew, Docker CLI tools, and Colima (a lightweight Docker runtime — no Docker Desktop, no GUI, no license fees).

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
brew install docker docker-buildx colima
```

This installs:
- `docker` — the CLI client (no daemon, just the command)
- `docker-buildx` — the build plugin (required for `docker build`)
- `colima` — a lightweight Linux VM that runs the Docker daemon

### 3. Configure the buildx plugin

Docker needs to know where Homebrew installed the buildx plugin:

```bash
mkdir -p ~/.docker
echo '{"cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"]}' > ~/.docker/config.json
```

> **Note:** If you already have a `~/.docker/config.json` with other settings, merge the `cliPluginsExtraDirs` key into it manually instead of overwriting the file.

### 4. Start Colima

```bash
colima start --vm-type vz --mount-type virtiofs --cpu 4 --memory 8
```

- `--vm-type vz` — Apple's native Virtualization.framework (fast, low overhead)
- `--mount-type virtiofs` — fast file sharing between host and VM
- `--cpu 4 --memory 8` — allocates 4 CPU cores and 8 GB RAM to the VM

You only need to start Colima once per boot. `mrc` will auto-start it if it's not running.

Stop it when you're done to reclaim resources:

```bash
colima stop
```

### 5. Get an Anthropic API key

Go to [console.anthropic.com](https://console.anthropic.com/) and create an API key. A dedicated key for Mister Claude is recommended so you can revoke it independently.

## Setup

1. **Clone this repo:**

   ```bash
   git clone <repo-url>
   cd mister-claude
   ```

2. **Create the `.env` file** in the repo root:

   ```bash
   echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
   ```

   Replace `sk-ant-...` with your actual key. This file is gitignored.

3. **Add `mrc` to your PATH:**

   ```bash
   chmod +x mrc
   sudo ln -s "$(pwd)/mrc" /usr/local/bin/mrc
   ```

   This creates a symlink so you can run `mrc` from anywhere.

## Usage

```bash
# Open a project
mrc ~/projects/my-app

# Pass arguments to Claude Code after --
mrc ~/projects/my-app -- -p "refactor the auth module"
mrc ~/projects/my-app -- --model claude-sonnet-4-5-20250929

# Current directory
mrc .

# Verbose mode (shows Colima and Docker output)
mrc -v ~/projects/my-app
```

First run builds the Docker image (~2 min). After that it's ready in about 5 seconds while the firewall sets up.

When you quit Claude, the container disappears. Your files are safe on the host — only the container is ephemeral. Claude's config (settings, conversation history) is persisted in a Docker volume between runs.

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

## Letting him visit new places

Edit the domain list in `init-firewall.sh`:

```bash
for domain in \
    "registry.npmjs.org" \
    "api.anthropic.com" \
    "sentry.io" \
    "statsig.anthropic.com" \
    "statsig.com" \
    "your-private-registry.com"; do   # ← add your own here
```

Then force a rebuild:

```bash
docker rmi mister-claude
```

The next `mrc` run will rebuild the image with the new firewall rules.

## How it works

1. `mrc` resolves the repo path, auto-starts Colima if needed, builds the Docker image, reads `.sandboxignore`, and starts the container with the repo bind-mounted at `/workspace`
2. The container runs as a non-root `coder` user with UID/GID matching your host user (no permission weirdness with bind-mounted files)
3. `entrypoint.sh` waits for the network, then runs `init-firewall.sh` via passwordless sudo
4. The firewall resolves each allowed domain to IPs, adds them to an `ipset`, sets the default iptables policy to DROP, and verifies that `example.com` is unreachable
5. Claude Code starts with `--dangerously-skip-permissions` — the container is the security boundary, so Claude can freely run commands inside it
6. VS Code on the host sees all file changes instantly via the bind mount

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
FROM node:20-slim    # or node:18-slim, etc.
```

**More resources for Colima:**

```bash
colima stop
colima start --vm-type vz --mount-type virtiofs --cpu 6 --memory 16
```

**Let him run free** (no firewall) — replace the ENTRYPOINT in the Dockerfile:

```dockerfile
ENTRYPOINT ["claude", "--dangerously-skip-permissions"]
```

## Troubleshooting

**`docker: command not found`** — Run `brew install docker docker-buildx colima` and make sure Homebrew is on your PATH.

**`Cannot connect to the Docker daemon`** — Colima isn't running. Start it with `colima start --vm-type vz --mount-type virtiofs --cpu 4 --memory 8`.

**`ERROR: Network not ready after 30 attempts`** — The container couldn't resolve DNS. Try `colima stop && colima start --vm-type vz --mount-type virtiofs --cpu 4 --memory 8` to restart the VM.

**`ERROR: Firewall verification failed`** — The iptables rules didn't take effect. Make sure the container has `--cap-add=NET_ADMIN --cap-add=NET_RAW` (this is handled by `mrc` automatically).

**Permission errors on mounted files** — The Docker image builds with your UID/GID. If you see permission issues, rebuild: `docker rmi mister-claude` and run `mrc` again.

**Slow file access** — Make sure you started Colima with `--mount-type virtiofs`. If you started it without that flag, stop and restart with the full flags.
