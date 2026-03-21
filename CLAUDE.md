# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Mister Claude (`mrc`) is a sandboxed Docker container launcher for Claude Code with an iptables firewall. It runs Claude Code inside a locked-down container where only whitelisted domains are reachable (api.anthropic.com, registry.npmjs.org, sentry.io, statsig endpoints).

## Architecture

The system has seven components:

### Host-side (runs on macOS/Linux)

1. **`mrc`** (bash) — Host-side launcher. Loads config from `~/.mrcrc` (global) and `<repo>/.mrcrc` (per-repo), parses flags and subcommands (`status`, `sessions`), starts Colima if needed, builds the Docker image with the user's UID/GID, discovers `.sandboxignore` files recursively throughout the repo tree, starts clipboard and notification proxies, creates a per-repo config volume (`mrc-config-<hash>`), and runs the container with the repo bind-mounted at `/workspace`. Labels each container with `mrc.*` metadata for `mrc status` queries. On exit, detects new sessions, reports missing tools, and generates AI summaries.

2. **`clipboard-proxy.sh`** (bash) — Host-side TCP proxy (port 7722). Serves clipboard content (text and images) to the container via socat. The container reaches it through `host.docker.internal`.

3. **`notify-proxy.sh`** (bash) — Host-side TCP proxy (port 7723). Receives notification messages from the container and fires native desktop notifications (`osascript` on macOS, `notify-send` on Linux). Supports `--no-sound` to suppress the Glass sound. Protocol: line 1 = repo name (title), line 2 = summary (body).

### Container-side (runs inside Docker)

4. **`Dockerfile`** — Builds on `node:22-slim`. Installs Claude Code via native binary download, installs plugins from the official marketplace, creates a non-root `coder` user, and grants passwordless sudo only for the firewall script.

5. **`entrypoint.sh`** — Container startup. Waits for DNS (up to 30s), runs the firewall via sudo, merges plugin config from build-time defaults into the persistent volume, restores Claude config from backups if needed, symlinks Claude's project store into `/workspace/.mrc/` for repo-local persistence, configures the `Stop` hook for desktop notifications, then starts `claude --dangerously-skip-permissions`.

6. **`init-firewall.sh`** — Network lockdown. Preserves Docker's internal DNS NAT rules, resolves whitelisted domains to IPs via `dig`, populates an `ipset`, sets iptables default policy to DROP with explicit REJECT for immediate feedback, blocks all IPv6, and verifies by confirming `example.com` is unreachable. Host network access is restricted to the clipboard and notification proxy ports only — all other host services (databases, etc.) are blocked.

7. **`mrc-notify-hook.sh`** — Container-side Claude Code `Stop` hook handler. Reads the hook JSON from stdin, extracts and truncates `last_assistant_message`, and sends the repo name + summary to the host notification proxy via socat.

## Key Design Decisions

- **Container is the security boundary** — Claude runs with `--dangerously-skip-permissions` because the Docker container + firewall provide isolation, not Claude's own permission system.
- **UID/GID matching** — The Docker image is built with the host user's UID/GID as build args so bind-mounted files have correct ownership.
- **Config persistence** — `~/.claude` is stored in a per-repo Docker volume (`mrc-config-<hash>`) that survives container restarts. A symlink maps `~/.claude.json` → `~/.claude/claude.json`. Each repo gets its own volume, keyed by an MD5 hash of the repo path, to avoid cross-project contamination.
- **Project-local memory** — Claude Code's project store (`~/.claude/projects/-workspace/`) is symlinked into `/workspace/.mrc/` so that memory, conversation history, and project settings live in the repo itself. This survives volume resets and travels with the project. `.mrc/` is auto-added to `.gitignore`.
- **Auto-resume** — The entrypoint passes `--continue` to Claude Code, so re-opening a repo automatically resumes the last conversation. A fresh conversation starts if no prior session exists.
- **Auto-update disabled** — `DISABLE_AUTOUPDATER=1` is set because the firewall blocks npm CDN hosts needed for updates. Rebuild the image (`docker rmi mister-claude`) to get a new Claude Code version.
- **`.sandboxignore` (recursive)** — Can be placed anywhere in the repo tree. Each file's entries resolve relative to the directory containing it (like `.gitignore`). Files are masked with `/dev/null` (appear empty); directories get anonymous volume overlays (appear as empty dirs).
- **Host network lockdown** — The firewall only allows traffic to the host on specific proxy ports (7722 clipboard, 7723 notifications). All other host services (Postgres, Redis, etc.) are unreachable from the container.
- **Desktop notifications** — A Claude Code `Stop` hook fires on every response completion. The container-side hook script extracts a summary from the response and sends it to the host-side notification proxy, which shows a native macOS/Linux notification identifying which repo's session is ready.
- **Container labeling** — Each container is labeled with `mrc=1`, `mrc.repo`, `mrc.repo.name`, and `mrc.web` for discovery by `mrc status`.
- **Config files (`.mrcrc`)** — Global defaults in `~/.mrcrc`, per-repo overrides in `<repo>/.mrcrc`. Both use the same format: one CLI flag per line, comments with `#`. All sources are merged (global + repo + CLI), with CLI flags taking precedence.

## CLI Reference

```
mrc [options] [path-to-repo] [-- claude-code-args...]

Options:
  -r, --rebuild        Force a full image rebuild (no cache)
  -v, --verbose        Show Colima and Docker output
  -n, --new [name]     Start a new conversation (optionally named)
  -w, --web            Allow outbound HTTPS to any host
  --no-summary         Skip AI session summary on exit
  --no-notify          Disable desktop notifications entirely
  --no-sound           Disable notification sound (still shows notification)

Config files (~/.mrcrc or <repo>/.mrcrc, one flag per line):
  # Example ~/.mrcrc
  --no-sound
  --web

Commands:
  mrc status                              Show active containers across repos
  mrc sessions ls [path]                  List saved sessions
  mrc sessions name <name> [#] [path]     Name a session
  mrc sessions resume <name-or-#> [path]  Resume a specific session
```

## Development Workflow

There is no build system, test suite, or linter. The project is shell scripts, a Dockerfile, and a Python helper (`mrc-sessions`).

**To test changes:** run `mrc` against a target repo and verify behavior. Force an image rebuild after Dockerfile, entrypoint.sh, init-firewall.sh, or mrc-notify-hook.sh changes:

```bash
docker rmi mister-claude
mrc ~/some/repo
```

Changes to `mrc`, `clipboard-proxy.sh`, and `notify-proxy.sh` take effect immediately (they run on the host).

**To add allowed domains:** edit the `for domain in ...` loop in `init-firewall.sh`.

**To add system packages:** add to the `apt-get install` line in the Dockerfile.

## Conventions

- All bash scripts use `set -euo pipefail`
- User-facing output uses Spaceballs-themed messaging
- The launcher script handles macOS/Colima-specific concerns (auto-starting VM, DOCKER_HOST socket)
- Host-container communication uses TCP proxies via socat + `host.docker.internal`
