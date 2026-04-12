---
name: shutdown
description: Stop all Docker containers, free ports, and kill running processes for this project
disable-model-invocation: true
allowed-tools: Bash(docker*)
---

# Kill All Project Processes

Stop everything related to this project:

1. Run `docker compose down` to stop and remove all containers, networks
2. Confirm everything is stopped with `docker compose ps`
3. Report what was stopped
