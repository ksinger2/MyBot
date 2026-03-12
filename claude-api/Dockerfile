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

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

COPY package.json ./
RUN npm install

COPY server.js bot.js briefings.js briefing-config.js ./
COPY personalities/ ./personalities/

# Create .claude directory with correct ownership before switching user
RUN mkdir -p /home/node/.claude && chown node:node /home/node/.claude

# Run as non-root user (required by Claude CLI)
USER node

EXPOSE 3400
CMD ["node", "server.js"]
