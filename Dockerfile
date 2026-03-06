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
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code globally
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user (UID/GID overridden at build time)
ARG USER_UID=1000
ARG USER_GID=1000

RUN (getent group ${USER_GID} || groupadd -g ${USER_GID} coder) \
    && useradd -m -u ${USER_UID} -g ${USER_GID} -s /bin/bash coder

# Create workspace and config directories
RUN mkdir -p /workspace /home/coder/.claude/debug && \
    chown -R coder:${USER_GID} /home/coder/.claude && \
    ln -s /home/coder/.claude/claude.json /home/coder/.claude.json

# Firewall script + sudoers so coder can run it without password
COPY init-firewall.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/init-firewall.sh \
    && echo 'coder ALL=(root) NOPASSWD: SETENV: /usr/local/bin/init-firewall.sh' > /etc/sudoers.d/coder-firewall \
    && chmod 0440 /etc/sudoers.d/coder-firewall

COPY clipboard-shim.sh /usr/local/bin/xclip
RUN chmod +x /usr/local/bin/xclip

COPY sync-sessions.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/sync-sessions.sh

COPY entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh

# Disable auto-update — the version is pinned at build time
# and the firewall may block npm CDN hosts needed for updates.
ENV DISABLE_AUTOUPDATER=1

USER coder
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]