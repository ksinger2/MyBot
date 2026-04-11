FROM node:20-slim

# Install git, gh CLI, and dev tools Claude Code needs
RUN apt-get update && apt-get install -y git openssh-client curl && rm -rf /var/lib/apt/lists/*

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
RUN pip3 install --break-system-packages --no-cache-dir yt-dlp
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

# Install Claude Code CLI, PM2, and Playwright MCP globally
RUN npm install -g @anthropic-ai/claude-code pm2 @playwright/mcp

# Install Playwright with Chromium for browser automation testing
RUN npx playwright install --with-deps chromium

WORKDIR /app

COPY package.json ./
RUN npm install

COPY *.js .mcp.json ./
COPY wizards/ ./wizards/
COPY personalities/ ./personalities/
COPY adapters/ ./adapters/
COPY skills/ ./skills/
COPY project-template/ ./project-template/
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Create writable directories for runtime data (node user can't write to /app)
RUN mkdir -p /home/node/.claude /app/data && chown -R node:node /home/node/.claude /app/data

# Run as non-root user (required by Claude CLI)
USER node

EXPOSE 3400
CMD ["/app/entrypoint.sh"]
