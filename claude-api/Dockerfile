FROM --platform=linux/amd64 node:20-slim

# Install git, gh CLI, and dev tools Claude Code needs
RUN apt-get update && apt-get install -y git openssh-client curl sudo && rm -rf /var/lib/apt/lists/*

# Install dev tools that Claude Code commonly needs (persists across restarts)
# Includes yt-dlp + ffmpeg for TikTok/Instagram/YouTube transcript extraction
# (download video → extract audio → send to Whisper for transcription).
RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-venv \
    build-essential \
    jq \
    wget \
    unzip \
    ffmpeg \
    && ln -s /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*
# yt-dlp from pip — much fresher than apt's package; --break-system-packages
# is needed because Debian 12 ships PEP 668-protected python.
# Pinned 2026-04-11 to avoid silent supply-chain drift. yt-dlp uses calendar
# versioning. To bump, check https://pypi.org/project/yt-dlp/ for the latest
# stable, update the version below, and rebuild.
RUN pip3 install --break-system-packages --no-cache-dir yt-dlp==2026.3.17
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Install Docker CLI (for container management from inside the container)
# docker.io provides the engine + CLI, but on Debian 12 it does NOT include the
# `docker compose` v2 plugin. Without compose, the self-rebuild path falls back
# to `docker run` which kills this container without rebuilding it. We install
# the standalone v2 binary explicitly so `docker compose ...` works inside.
RUN apt-get update && apt-get install -y docker.io && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /usr/local/lib/docker/cli-plugins \
    && curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" \
       -o /usr/local/lib/docker/cli-plugins/docker-compose \
    && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# Install cloudflared for exposing local dev servers via tunnel
RUN curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb \
    && dpkg -i /tmp/cloudflared.deb \
    && rm /tmp/cloudflared.deb

# Install Claude Code CLI — pinned to avoid silent binary drift on rebuild.
# @anthropic-ai/claude-code-linux-x64 is an optionalDependency; --include=optional
# forces npm to fetch it. The retry loop handles transient CDN flakes.
# Build-time `claude --version` verification fails the build if the binary is
# missing — turns a silent runtime failure into a loud build failure.
# To bump: update CLAUDE_CODE_VERSION in docker-compose.yml build.args.
ARG CLAUDE_CODE_VERSION=latest
RUN for i in 1 2 3; do \
      npm install -g --include=optional --foreground-scripts @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} pm2 @playwright/mcp \
      && claude --version \
      && break; \
    done \
    || (echo "FATAL: claude binary failed to install after 3 attempts" && exit 1)

# Install Playwright with Chromium for browser automation testing
RUN npx playwright install --with-deps chromium

WORKDIR /app

COPY package.json ./
RUN npm install --legacy-peer-deps

COPY *.js .mcp.json ./
COPY commands/ ./commands/
COPY wizards/ ./wizards/
COPY personalities/ ./personalities/
COPY adapters/ ./adapters/
COPY skills/ ./skills/
COPY plugins/ ./plugins/
COPY project-template/ ./project-template/
COPY tests/ ./tests/
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Run regression tests at build time — fails the build if any test breaks
RUN node --test tests/*.test.js

# Create writable directories for runtime data (node user can't write to /app)
RUN mkdir -p /home/node/.claude /app/data && chown -R node:node /home/node/.claude /app/data
# Isolated home for non-owner CLI spawns — no ~/.claude.json here, so Karen's
# account-level MCPs (Google Calendar, etc.) are never exposed to non-owner sessions.
RUN mkdir -p /home/node-nonowner/.claude && chown -R node:node /home/node-nonowner

# Sandbox: allow the node user to run useradd/chown/mkdir/cp for runtime
# sandbox user provisioning. Minimal sudoers — only these four commands.
# Sandbox sudoers: SETENV allows env passthrough for sudo -E (required so
# Claude CLI inherits HOME, PATH, etc. inside the mount namespace).
RUN echo 'node ALL=(root) NOPASSWD:SETENV: /usr/sbin/useradd, /usr/bin/chown, /usr/bin/mkdir, /usr/bin/cp, /usr/bin/unshare' > /etc/sudoers.d/sandbox \
    && chmod 440 /etc/sudoers.d/sandbox

# Run as non-root user (required by Claude CLI)
USER node

EXPOSE 3400
CMD ["/app/entrypoint.sh"]
