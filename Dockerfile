FROM node:24-slim

# System tools for Claude Code + firewall
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    git \
    ripgrep \
    jq \
    file \
    gosu \
    iptables \
    ipset \
    iproute2 \
    dnsutils \
    socat \
    python3 \
    ffmpeg \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user (UID/GID overridden at build time)
ARG USER_UID=1000
ARG USER_GID=1000

RUN (getent group ${USER_GID} || groupadd -g ${USER_GID} coder) \
    && useradd -m -u ${USER_UID} -g ${USER_GID} -s /bin/bash coder

# Install Claude Code native binary (the install.sh script fails in Docker
# because `claude install` needs a TTY, so we do the download step manually)
USER coder
RUN ARCH=$(case "$(uname -m)" in x86_64|amd64) echo x64;; arm64|aarch64) echo arm64;; esac) \
    && PLATFORM="linux-${ARCH}" \
    && GCS="https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases" \
    && VERSION=$(curl -fsSL "${GCS}/latest") \
    && mkdir -p /home/coder/.local/bin \
    && curl -fsSL -o /home/coder/.local/bin/claude "${GCS}/${VERSION}/${PLATFORM}/claude" \
    && chmod +x /home/coder/.local/bin/claude
ENV PATH="/home/coder/.local/bin:${PATH}"

# Install plugins, then stash the config for volume-aware restore at runtime.
# ~/.claude gets overlaid by a Docker volume, so we save the build-time state
# to /home/coder/.claude-defaults for the entrypoint to merge in.
RUN claude plugin marketplace add anthropics/claude-plugins-official \
    && claude plugin install frontend-design \
    && claude plugin install code-review \
    && claude plugin install feature-dev \
    && claude plugin install claude-md-management \
    && claude plugin install pr-review-toolkit \
    && claude plugin install hookify \
    && cp -a /home/coder/.claude /home/coder/.claude-defaults

USER root

# Install Codex CLI (OpenAI) — always available for cross-model review
RUN npm install -g --loglevel=error @openai/codex \
    && mkdir -p /home/coder/.codex \
    && chown ${USER_UID}:${USER_GID} /home/coder/.codex

# Pre-install sharp globally so any repo at /workspace (or an ad-hoc script) can
# require('sharp') without a per-project npm install. The prebuilt binary and the
# bundled libvips ship as npm packages from registry.npmjs.org, which the firewall
# already whitelists — no extra allowed domains needed.
RUN npm install -g --loglevel=error sharp

# Node does not search the global npm root by default, so make it resolvable from
# project code via NODE_PATH. A project's own local node_modules still take
# precedence, so this only acts as a fallback and never shadows a pinned version.
ENV NODE_PATH=/usr/local/lib/node_modules

# Negotiation-room channel server + its MCP SDK. Kept in its own dir with a LOCAL install so
# the channel server's ESM `import` resolves — ESM does not consult NODE_PATH like require() does.
RUN mkdir -p /opt/mrc-channel \
    && cd /opt/mrc-channel \
    && npm init -y >/dev/null 2>&1 \
    && npm install --loglevel=error @modelcontextprotocol/sdk
COPY container/mrc-channel-server.js /opt/mrc-channel/mrc-channel-server.js

# Negotiation-room / crew channel, packaged as a plugin in a baked-in LOCAL marketplace so it loads
# via `--channels plugin:room@mrc` with NO experimental-channel prompt (vs the old
# --dangerously-load-development-channels, which prompted). The allowlist below makes the load
# non-interactive; container-setup.js registers the plugin into the per-repo config volume at runtime
# (local marketplaces aren't cloned into ~/.claude/plugins, so they don't ride the defaults-restore the
# GitHub-marketplace plugins use). The plugin's .mcp.json points back at /opt/mrc-channel above.
COPY mrc-marketplace /opt/mrc-marketplace
RUN mkdir -p /etc/claude-code \
    && printf '%s\n' '{ "channelsEnabled": true, "allowedChannelPlugins": [ { "marketplace": "mrc", "plugin": "room" } ] }' > /etc/claude-code/managed-settings.json

# Create workspace and config directories
RUN mkdir -p /workspace && \
    ln -sf /home/coder/.claude/claude.json /home/coder/.claude.json

# Firewall script. C/#38: the firewall runs ONLY as root at container boot (the entrypoint's root pass), after
# which the container drops to the unprivileged `coder` user for config setup + the agent. coder has NO sudo
# grant; the `sudo` package is removed entirely (above) and coder's password is locked (useradd default), so a
# sandboxed session has NO escalation path at all — no way to invoke, let alone weaken, its own firewall.
COPY init-firewall.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/init-firewall.sh

# Clipboard shim (stays bash — mimics xclip interface)
COPY clipboard-shim.sh /usr/local/bin/xclip
RUN chmod +x /usr/local/bin/xclip

# Container-side Node scripts
COPY container/mrc-notify-hook.js /usr/local/bin/
COPY container/mrc-statusline.js /usr/local/bin/
COPY container/container-setup.js /usr/local/bin/
# mrc-rename installs WITHOUT the .js so the /rename slash command can invoke it as a clean `mrc-rename`
# (it has a node shebang + lands on PATH, exactly like the xclip shim above). The other three KEEP .js —
# they're referenced by full path in hooks/settings/entrypoint, never typed as a command.
COPY container/mrc-rename.js /usr/local/bin/mrc-rename
RUN chmod +x /usr/local/bin/mrc-notify-hook.js \
    /usr/local/bin/mrc-statusline.js \
    /usr/local/bin/container-setup.js \
    /usr/local/bin/mrc-rename

# Video analysis script + slash command (staged for runtime seeding)
COPY container/video-analysis.sh /usr/local/bin/video-analysis
RUN chmod +x /usr/local/bin/video-analysis
COPY container/video-analysis-command.md /opt/mrc-video-analysis/command.md
COPY container/video-analysis-defaults.json /opt/mrc-video-analysis/defaults.json

# Codex slash command (seeded into ~/.claude/commands/ at runtime)
COPY container/codex-command.md /opt/mrc-codex/command.md

# Red-team slash command (seeded into ~/.claude/commands/ at runtime). Tier 0 of the
# adversarial-rooms design — a one-shot grounded adversary on demand; see docs/multiparty-adversarial-rooms.md
COPY container/red-team-command.md /opt/mrc-red-team/command.md

# Rename slash command (seeded into ~/.claude/commands/ at runtime). Lets the human ask the session to
# rename itself ("/rename" or "/rename a-better-name"); runs the mrc-rename helper above.
COPY container/rename-command.md /opt/mrc-rename/command.md

COPY entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh

# Disable auto-update — the version is pinned at build time
# and the firewall may block npm CDN hosts needed for updates.
ENV DISABLE_AUTOUPDATER=1

# C/#38: start the container as ROOT so the entrypoint can apply the firewall, then drop to `coder` (gosu)
# for config setup + the agent. coder has no sudo, so the cage is untouchable from inside the session. The
# coder pass of the entrypoint runs with the matched UID/GID, so bind-mount file ownership is unchanged.
USER root
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
