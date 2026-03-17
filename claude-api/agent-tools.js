// Tool definitions for the autonomous agent loop
// These are the tools available to the agent for interacting with the system

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { spawnSubAgent, messageSubAgent, stopSubAgent, getActiveSubAgents } = require('./sub-agents');
const { BROWSER_TOOLS, executeBrowserTool } = require('./browser-tools');

// Tool definitions in Anthropic format
const AGENT_TOOLS = [
  {
    name: 'read_file',
    description: 'Read the contents of a file. Use this to examine code, config files, documentation, etc.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file (relative to working directory or absolute)'
        },
        start_line: {
          type: 'integer',
          description: 'Optional: start reading from this line (1-indexed)'
        },
        end_line: {
          type: 'integer',
          description: 'Optional: stop reading at this line'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Write content to a file. Creates the file if it doesn\'t exist, overwrites if it does.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file (relative to working directory or absolute)'
        },
        content: {
          type: 'string',
          description: 'Content to write to the file'
        }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'edit_file',
    description: 'Edit a file by replacing specific text. The old_text must match exactly.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file'
        },
        old_text: {
          type: 'string',
          description: 'Exact text to find and replace (must match exactly including whitespace)'
        },
        new_text: {
          type: 'string',
          description: 'Text to replace it with'
        }
      },
      required: ['path', 'old_text', 'new_text']
    }
  },
  {
    name: 'list_directory',
    description: 'List files and directories in a path',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path (relative to working directory or absolute)'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'search_files',
    description: 'Search for files matching a pattern (glob) or containing text (grep)',
    input_schema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern for file names (e.g. "**/*.js") OR text to search for in file contents'
        },
        search_type: {
          type: 'string',
          enum: ['glob', 'grep'],
          description: 'Type of search: "glob" for file names, "grep" for file contents'
        },
        path: {
          type: 'string',
          description: 'Directory to search in (defaults to working directory)'
        }
      },
      required: ['pattern', 'search_type']
    }
  },
  {
    name: 'run_command',
    description: 'Run a shell command. Use for builds, tests, git operations, etc. Avoid long-running commands.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to execute'
        },
        timeout_seconds: {
          type: 'integer',
          description: 'Timeout in seconds (default: 30, max: 120)'
        }
      },
      required: ['command']
    }
  },
  {
    name: 'web_search',
    description: 'Search the web for information. Use for research, finding documentation, etc.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'ask_user',
    description: 'Ask the user a question when you need clarification, permission, or input. Use this rather than guessing.',
    input_schema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The question to ask the user'
        },
        context: {
          type: 'string',
          description: 'Brief context about why you\'re asking (what you\'re trying to do)'
        }
      },
      required: ['question']
    }
  },
  {
    name: 'complete',
    description: 'Mark the goal as complete (success or failure). Use this when the goal is achieved or cannot be achieved.',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['success', 'failed', 'partial'],
          description: 'Whether the goal was achieved'
        },
        result: {
          type: 'string',
          description: 'Summary of what was accomplished or why it failed'
        }
      },
      required: ['status', 'result']
    }
  },
  // Multi-agent orchestration tools
  {
    name: 'delegate_task',
    description: 'Spawn a Claude Code sub-agent to work on a specific task. Use this for complex coding tasks, large refactors, or when you need another agent to focus on a specific piece of work while you coordinate. The sub-agent has full access to read/write files and run commands.',
    input_schema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Detailed description of what the sub-agent should accomplish. Be specific about files, requirements, and expected outcomes.'
        },
        working_directory: {
          type: 'string',
          description: 'Directory for the sub-agent to work in (defaults to current working directory)'
        },
        max_turns: {
          type: 'integer',
          description: 'Maximum turns for the sub-agent (default: 25, max: 50)'
        }
      },
      required: ['task']
    }
  },
  {
    name: 'follow_up_agent',
    description: 'Send a follow-up message to a previously spawned sub-agent session. Use this to provide additional instructions, ask for changes, or continue work on a task.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'The session ID returned from delegate_task'
        },
        message: {
          type: 'string',
          description: 'Follow-up instructions or questions for the sub-agent'
        }
      },
      required: ['session_id', 'message']
    }
  },
  {
    name: 'check_agents',
    description: 'Check the status of all active sub-agents. Use this to monitor progress on delegated tasks.',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'stop_agent',
    description: 'Stop a running sub-agent. Use this if a delegated task is taking too long or needs to be cancelled.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'The session ID of the sub-agent to stop'
        }
      },
      required: ['session_id']
    }
  },
  // Browser automation tools
  ...BROWSER_TOOLS
];

// Tool execution functions
async function executeToolCall(toolName, input, context = {}) {
  const cwd = context.cwd || process.cwd();

  const resolvePath = (p) => {
    if (path.isAbsolute(p)) return p;
    return path.join(cwd, p);
  };

  switch (toolName) {
    case 'read_file': {
      const filePath = resolvePath(input.path);
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${input.path}`);
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      if (input.start_line || input.end_line) {
        const start = (input.start_line || 1) - 1;
        const end = input.end_line || lines.length;
        return lines.slice(start, end).map((line, i) => `${start + i + 1}: ${line}`).join('\n');
      }

      // Add line numbers
      return lines.map((line, i) => `${i + 1}: ${line}`).join('\n');
    }

    case 'write_file': {
      const filePath = resolvePath(input.path);
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, input.content);
      return `File written: ${input.path} (${input.content.length} bytes)`;
    }

    case 'edit_file': {
      const filePath = resolvePath(input.path);
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${input.path}`);
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      if (!content.includes(input.old_text)) {
        throw new Error(`Text not found in file. Make sure old_text matches exactly (including whitespace).`);
      }
      const newContent = content.replace(input.old_text, input.new_text);
      fs.writeFileSync(filePath, newContent);
      return `File edited: ${input.path}`;
    }

    case 'list_directory': {
      const dirPath = resolvePath(input.path);
      if (!fs.existsSync(dirPath)) {
        throw new Error(`Directory not found: ${input.path}`);
      }
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const formatted = entries.map(e => {
        const prefix = e.isDirectory() ? '📁' : '📄';
        const suffix = e.isDirectory() ? '/' : '';
        return `${prefix} ${e.name}${suffix}`;
      });
      return formatted.join('\n') || '(empty directory)';
    }

    case 'search_files': {
      const searchPath = input.path ? resolvePath(input.path) : cwd;

      if (input.search_type === 'glob') {
        // Use find for glob patterns
        const pattern = input.pattern.replace(/\*\*/g, '').replace(/\*/g, '*');
        try {
          const result = execSync(
            `find "${searchPath}" -name "${pattern}" -type f 2>/dev/null | head -50`,
            { encoding: 'utf-8', timeout: 10000 }
          );
          return result.trim() || 'No files found';
        } catch {
          return 'No files found';
        }
      } else {
        // Use grep for content search
        try {
          const result = execSync(
            `grep -r -l "${input.pattern}" "${searchPath}" 2>/dev/null | head -30`,
            { encoding: 'utf-8', timeout: 15000 }
          );
          return result.trim() || 'No matches found';
        } catch {
          return 'No matches found';
        }
      }
    }

    case 'run_command': {
      const timeout = Math.min(input.timeout_seconds || 30, 120) * 1000;
      try {
        const result = execSync(input.command, {
          cwd,
          encoding: 'utf-8',
          timeout,
          maxBuffer: 1024 * 1024,  // 1MB
          stdio: ['pipe', 'pipe', 'pipe']
        });
        const output = result.trim();
        // Truncate very long output
        if (output.length > 10000) {
          return output.substring(0, 5000) + '\n...[truncated]...\n' + output.substring(output.length - 2000);
        }
        return output || '(command completed with no output)';
      } catch (err) {
        if (err.killed) {
          throw new Error(`Command timed out after ${timeout / 1000}s`);
        }
        // Include stderr in error
        const stderr = err.stderr?.toString() || '';
        const stdout = err.stdout?.toString() || '';
        throw new Error(`Command failed (exit ${err.status}): ${stderr || stdout || err.message}`);
      }
    }

    case 'web_search': {
      // Use a simple web search via DuckDuckGo HTML (no API key needed)
      // In production, you'd use a proper search API
      try {
        const query = encodeURIComponent(input.query);
        const result = execSync(
          `curl -s "https://html.duckduckgo.com/html/?q=${query}" | grep -oP '<a rel="nofollow" class="result__a" href="[^"]*">[^<]*' | head -10 | sed 's/<a rel="nofollow" class="result__a" href="//' | sed 's/">/\\n  /'`,
          { encoding: 'utf-8', timeout: 15000 }
        );
        return result.trim() || 'No results found';
      } catch {
        return 'Web search failed - try a different query';
      }
    }

    case 'ask_user':
    case 'complete':
      // These are handled specially in the agent loop
      return input;

    // Multi-agent orchestration
    case 'delegate_task': {
      const maxTurns = Math.min(input.max_turns || 25, 50);
      const workDir = input.working_directory ? resolvePath(input.working_directory) : cwd;

      console.log(`[Orchestrator] Spawning sub-agent for: ${input.task.substring(0, 100)}...`);

      const result = await spawnSubAgent({
        task: input.task,
        cwd: workDir,
        maxTurns,
        onProgress: (event) => {
          if (event.type === 'tool') {
            console.log(`[SubAgent ${event.sessionId.substring(0, 8)}] Using: ${event.tool}`);
          }
        },
      });

      return {
        session_id: result.sessionId,
        status: result.status,
        output: result.output,
        cost: result.cost,
        turns: result.turns,
        tools_used: result.toolsUsed,
        message: `Sub-agent ${result.status}. Session ID: ${result.sessionId}`,
      };
    }

    case 'follow_up_agent': {
      const workDir = cwd;

      console.log(`[Orchestrator] Following up with agent ${input.session_id.substring(0, 8)}...`);

      const result = await messageSubAgent(input.session_id, input.message, workDir);

      return {
        session_id: result.sessionId,
        status: result.status,
        output: result.output,
        cost: result.cost,
        turns: result.turns,
      };
    }

    case 'check_agents': {
      const agents = getActiveSubAgents();
      if (agents.length === 0) {
        return 'No active sub-agents.';
      }
      return agents.map(a =>
        `• ${a.id.substring(0, 12)}... | Task: ${a.task.substring(0, 50)}... | Running: ${a.runningFor}s | Status: ${a.status}`
      ).join('\n');
    }

    case 'stop_agent': {
      const stopped = stopSubAgent(input.session_id);
      return stopped
        ? `Stopped sub-agent: ${input.session_id}`
        : `No active sub-agent found with ID: ${input.session_id}`;
    }

    // Browser automation tools
    case 'browse_url':
    case 'get_page_content':
    case 'extract_elements':
    case 'get_element_text':
    case 'click':
    case 'double_click':
    case 'right_click':
    case 'hover':
    case 'type_input':
    case 'press_key':
    case 'select_dropdown':
    case 'fill_form':
    case 'upload_file':
    case 'drag_drop':
    case 'scroll':
    case 'wait_for_element':
    case 'wait_for_text':
    case 'wait_for_navigation':
    case 'new_tab':
    case 'switch_tab':
    case 'close_tab':
    case 'list_tabs':
    case 'save_session':
    case 'restore_session':
    case 'list_sessions':
    case 'delete_session':
    case 'screenshot':
    case 'run_page_script':
    case 'page_info':
    case 'close_browser':
      return await executeBrowserTool(toolName, input, context);

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

module.exports = { AGENT_TOOLS, executeToolCall };
