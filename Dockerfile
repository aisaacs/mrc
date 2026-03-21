FROM node:22-slim

# System tools for Claude Code + firewall
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    git \
    ripgrep \
    sudo \
    iptables \
    ipset \
    iproute2 \
    dnsutils \
    socat \
    python3 \
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

# Create workspace and config directories
RUN mkdir -p /workspace && \
    ln -sf /home/coder/.claude/claude.json /home/coder/.claude.json

# Firewall script + sudoers so coder can run it without password
COPY init-firewall.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/init-firewall.sh \
    && echo 'coder ALL=(root) NOPASSWD: SETENV: /usr/local/bin/init-firewall.sh' > /etc/sudoers.d/coder-firewall \
    && chmod 0440 /etc/sudoers.d/coder-firewall

COPY clipboard-shim.sh /usr/local/bin/xclip
RUN chmod +x /usr/local/bin/xclip

COPY mrc-notify-hook.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/mrc-notify-hook.sh

COPY entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh

# Disable auto-update — the version is pinned at build time
# and the firewall may block npm CDN hosts needed for updates.
ENV DISABLE_AUTOUPDATER=1

USER coder
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]