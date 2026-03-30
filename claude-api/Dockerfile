FROM node:20-slim

# Install git, gh CLI, and dev tools Claude Code needs
RUN apt-get update && apt-get install -y git openssh-client curl && rm -rf /var/lib/apt/lists/*

# Install dev tools that Claude Code commonly needs (persists across restarts)
RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-venv \
    build-essential \
    jq \
    wget \
    unzip \
    && ln -s /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Install Docker CLI (for container management from inside the container)
RUN apt-get update && apt-get install -y docker.io && rm -rf /var/lib/apt/lists/*

# Install cloudflared for exposing local dev servers via tunnel
RUN curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb \
    && dpkg -i /tmp/cloudflared.deb \
    && rm /tmp/cloudflared.deb

# Install Chromium and dependencies for browser automation (Playwright MCP)
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

COPY package.json ./
RUN npm install

COPY *.js .mcp.json ./
COPY wizards/ ./wizards/
COPY personalities/ ./personalities/
COPY skills/ ./skills/
COPY project-template/ ./project-template/
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Create .claude directory with correct ownership before switching user
RUN mkdir -p /home/node/.claude && chown node:node /home/node/.claude

# Run as non-root user (required by Claude CLI)
USER node

EXPOSE 3400
CMD ["/app/entrypoint.sh"]
