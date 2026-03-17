// Autonomous Agent Loop - Core engine for goal-driven tasks
// Uses direct Anthropic API for fast tool_use decisions

const Anthropic = require('@anthropic-ai/sdk');
const { AGENT_TOOLS, executeToolCall } = require('./agent-tools');

const DEFAULT_MAX_ITERATIONS = 20;
const DEFAULT_MAX_COST_USD = 0.50;  // Safety limit per agent run
const COST_PER_INPUT_TOKEN = 0.003 / 1000;   // Claude 3.5 Sonnet pricing
const COST_PER_OUTPUT_TOKEN = 0.015 / 1000;

class AgentLoop {
  constructor(options = {}) {
    this.client = new Anthropic();
    this.maxIterations = options.maxIterations || DEFAULT_MAX_ITERATIONS;
    this.maxCostUsd = options.maxCostUsd || DEFAULT_MAX_COST_USD;
    this.cwd = options.cwd || '/workspace';
    this.identity = options.identity || { name: 'Agent', description: 'an autonomous assistant' };
    this.onProgress = options.onProgress || (() => {});  // callback for status updates
    this.onAskUser = options.onAskUser || null;  // callback when agent needs user input

    // State
    this.running = false;
    this.stopped = false;
    this.iteration = 0;
    this.totalCost = 0;
    this.messages = [];
    this.goal = null;
    this.result = null;

    // Loop protection state
    this.toolHistory = [];  // Track recent tool calls for loop detection
    this.noProgressCount = 0;  // Count iterations without progress
    this.lastProgressIteration = 0;
  }

  /**
   * Check for repetitive tool usage patterns (loop detection)
   */
  detectLoop(toolName, toolInput) {
    const signature = `${toolName}:${JSON.stringify(toolInput)}`;
    this.toolHistory.push(signature);

    // Keep last 10 calls
    if (this.toolHistory.length > 10) {
      this.toolHistory.shift();
    }

    // Check for exact repetition (same call 3+ times in last 6)
    const recent = this.toolHistory.slice(-6);
    const count = recent.filter(s => s === signature).length;
    if (count >= 3) {
      return { detected: true, reason: `Same tool call repeated ${count} times` };
    }

    // Check for alternating pattern (A-B-A-B)
    if (this.toolHistory.length >= 4) {
      const last4 = this.toolHistory.slice(-4);
      if (last4[0] === last4[2] && last4[1] === last4[3] && last4[0] !== last4[1]) {
        return { detected: true, reason: 'Alternating pattern detected (possible infinite loop)' };
      }
    }

    return { detected: false };
  }

  /**
   * Track progress - call when meaningful work is done
   */
  markProgress() {
    this.lastProgressIteration = this.iteration;
    this.noProgressCount = 0;
  }

  /**
   * Check if we're stuck (no progress for too long)
   */
  checkStuck() {
    const iterationsSinceProgress = this.iteration - this.lastProgressIteration;
    if (iterationsSinceProgress >= 3) {
      return { stuck: true, iterations: iterationsSinceProgress };
    }
    return { stuck: false };
  }

  buildSystemPrompt() {
    return `You are ${this.identity.name}, ${this.identity.description}.

You are an AUTONOMOUS AGENT working to achieve a goal. You have tools to interact with the filesystem, run commands, search the web, and orchestrate other agents.

## Core Behavior
- Work step by step toward the goal
- Use tools to take action - don't just describe what you would do
- After each action, assess progress and decide next steps
- When the goal is achieved, use the "complete" tool with your final result
- If you need clarification from the user, use the "ask_user" tool
- If you're stuck or the goal is impossible, use "complete" with status "failed" and explain why

## Multi-Agent Orchestration
You can delegate complex coding tasks to sub-agents using "delegate_task":
- For large implementations: spawn a sub-agent to focus on building one component
- For parallel work: delegate multiple independent tasks to work faster
- For specialized work: let a sub-agent handle a specific file or feature
- Use "follow_up_agent" to give additional instructions to a sub-agent
- Use "check_agents" to monitor all active sub-agents
- Sub-agents are full Claude Code instances with file/command access

When to delegate vs do it yourself:
- Simple file reads/edits: do it yourself
- Multi-file refactors, new features, debugging: consider delegating
- Research + implementation: do research yourself, delegate implementation

## Loop Protection - CRITICAL
You MUST avoid infinite loops and wasted iterations:
- Track what you've already tried - don't repeat failed approaches
- If the same action fails twice, try a different approach
- If you've made no progress in 3 iterations, reassess the goal or ask for help
- Don't keep reading the same files or running the same commands
- If something is clearly impossible, complete with failure rather than spinning

## Communication Style
- Be direct and concise in your responses
- When completing, summarize what was done, not the full process
- Don't over-explain unless asked

## Browser Automation
You have powerful browser tools for web automation tasks:

### Available Capabilities
- **Navigation**: browse_url, wait_for_navigation, scroll
- **Interaction**: click, double_click, right_click, hover, type_input, press_key
- **Forms**: fill_form, select_dropdown, upload_file
- **Extraction**: get_page_content, extract_elements, get_element_text
- **Waiting**: wait_for_element, wait_for_text
- **Tabs**: new_tab, switch_tab, close_tab, list_tabs
- **Sessions**: save_session, restore_session, list_sessions (persist logins)

### Browser Workflow Pattern
1. restore_session('[site]') if previously logged in
2. browse_url('[target URL]')
3. wait_for_element('[key element]') to confirm page loaded
4. Interact with page (click, type, etc.)
5. Extract data or verify results

### Session Management
For authenticated sites (Gmail, Amazon, etc.):
- First time: Ask user to log in manually, then save_session('[name]')
- Later: restore_session('[name]') to skip login
- Sessions stored in ~/.claude/browser-sessions/

### Safety Rules - CRITICAL
1. **Purchases**: ALWAYS ask_user before adding to cart or checkout
2. **Emails**: ALWAYS show preview and ask_user before sending
3. **Forms**: Ask before submitting forms that trigger real actions
4. **Passwords**: Never store or log credentials
5. **Confirmation pattern**: show what will happen → ask_user → execute if confirmed

### Example: Safe Email Flow
1. Compose email content
2. ask_user: "Send this email? To: X, Subject: Y, Body: [preview]"
3. Only click Send if user confirms

### Common Selectors Reference
- Gmail compose: div[gh="cm"]
- Gmail body: div[aria-label="Message Body"]
- Amazon search: #twotabsearchtextbox
- Amazon cart: #add-to-cart-button
- Generic forms: input[type="text"], button[type="submit"]

## Current Context
- Working directory: ${this.cwd}
- Iteration limit: ${this.maxIterations}
- Cost limit: $${this.maxCostUsd.toFixed(2)}

Be efficient. Be decisive. Achieve the goal.`;
  }

  async run(goal, existingContext = []) {
    this.goal = goal;
    this.running = true;
    this.stopped = false;
    this.iteration = 0;
    this.totalCost = 0;
    this.result = null;

    // Initialize messages with goal
    this.messages = [
      ...existingContext,
      { role: 'user', content: `## Goal\n${goal}\n\nBegin working toward this goal. Take action with tools.` }
    ];

    this.onProgress({ type: 'start', goal, maxIterations: this.maxIterations });

    try {
      while (this.running && !this.stopped && this.iteration < this.maxIterations) {
        this.iteration++;

        // Check cost limit
        if (this.totalCost >= this.maxCostUsd) {
          this.result = {
            status: 'cost_limit',
            message: `Cost limit reached ($${this.totalCost.toFixed(4)} of $${this.maxCostUsd.toFixed(2)}). Stopping to prevent runaway costs.`,
            iterations: this.iteration,
            cost: this.totalCost,
          };
          break;
        }

        this.onProgress({
          type: 'iteration',
          iteration: this.iteration,
          maxIterations: this.maxIterations,
          cost: this.totalCost
        });

        // Call Claude
        const response = await this.client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          system: this.buildSystemPrompt(),
          tools: AGENT_TOOLS,
          messages: this.messages,
        });

        // Track cost
        const inputCost = (response.usage?.input_tokens || 0) * COST_PER_INPUT_TOKEN;
        const outputCost = (response.usage?.output_tokens || 0) * COST_PER_OUTPUT_TOKEN;
        this.totalCost += inputCost + outputCost;

        // Process response
        const assistantContent = response.content;
        this.messages.push({ role: 'assistant', content: assistantContent });

        // Extract text and tool calls
        const textBlocks = assistantContent.filter(b => b.type === 'text');
        const toolCalls = assistantContent.filter(b => b.type === 'tool_use');

        // Report any text output
        for (const block of textBlocks) {
          if (block.text?.trim()) {
            this.onProgress({ type: 'thinking', text: block.text });
          }
        }

        // If no tool calls, check if we need to prompt for action
        if (toolCalls.length === 0) {
          if (response.stop_reason === 'end_turn') {
            // Claude stopped without using tools - may need to prompt
            this.messages.push({
              role: 'user',
              content: 'You stopped without using any tools. Either use tools to make progress, use "complete" to finish, or use "ask_user" if you need help.'
            });
            continue;
          }
        }

        // Check if stuck (no progress for too long)
        const stuckCheck = this.checkStuck();
        if (stuckCheck.stuck) {
          this.messages.push({
            role: 'user',
            content: `WARNING: You have made no meaningful progress in ${stuckCheck.iterations} iterations. Either complete the task, ask the user for help, or fail gracefully. Do NOT continue spinning.`
          });
        }

        // Execute tool calls
        const toolResults = [];
        for (const toolCall of toolCalls) {
          // Loop detection
          const loopCheck = this.detectLoop(toolCall.name, toolCall.input);
          if (loopCheck.detected) {
            this.onProgress({ type: 'loop_detected', reason: loopCheck.reason });
            this.result = {
              status: 'failed',
              message: `Stopped due to detected loop: ${loopCheck.reason}. This prevents wasted API costs.`,
              iterations: this.iteration,
              cost: this.totalCost,
            };
            this.running = false;
            return this.result;
          }

          this.onProgress({
            type: 'tool_start',
            tool: toolCall.name,
            input: toolCall.input
          });

          // Handle special tools
          if (toolCall.name === 'complete') {
            this.running = false;
            this.result = {
              status: toolCall.input.status || 'success',
              message: toolCall.input.result || toolCall.input.message,
              iterations: this.iteration,
              cost: this.totalCost,
            };
            this.onProgress({ type: 'complete', result: this.result });
            return this.result;
          }

          if (toolCall.name === 'ask_user') {
            // Need user input - pause and return
            this.running = false;
            this.result = {
              status: 'needs_input',
              question: toolCall.input.question,
              context: toolCall.input.context,
              iterations: this.iteration,
              cost: this.totalCost,
              resumeState: {
                messages: this.messages,
                toolCallId: toolCall.id,
              },
            };
            this.onProgress({ type: 'ask_user', question: toolCall.input.question });
            return this.result;
          }

          // Execute regular tool
          try {
            const result = await executeToolCall(toolCall.name, toolCall.input, {
              cwd: this.cwd,
            });
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolCall.id,
              content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            });

            // Mark progress for write operations (actual work being done)
            if (['write_file', 'edit_file', 'run_command'].includes(toolCall.name)) {
              this.markProgress();
            }

            this.onProgress({
              type: 'tool_result',
              tool: toolCall.name,
              success: true,
              preview: (typeof result === 'string' ? result : JSON.stringify(result)).substring(0, 200)
            });
          } catch (err) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolCall.id,
              content: `Error: ${err.message}`,
              is_error: true,
            });
            this.onProgress({
              type: 'tool_result',
              tool: toolCall.name,
              success: false,
              error: err.message
            });
          }
        }

        // Add tool results to conversation
        if (toolResults.length > 0) {
          this.messages.push({ role: 'user', content: toolResults });
        }
      }

      // Reached iteration limit
      if (this.iteration >= this.maxIterations && this.running) {
        this.result = {
          status: 'iteration_limit',
          message: `Reached ${this.maxIterations} iterations without completing. The goal may need to be broken into smaller steps.`,
          iterations: this.iteration,
          cost: this.totalCost,
        };
      }

      // Stopped by user
      if (this.stopped) {
        this.result = {
          status: 'stopped',
          message: 'Agent stopped by user.',
          iterations: this.iteration,
          cost: this.totalCost,
        };
      }

      this.onProgress({ type: 'complete', result: this.result });
      return this.result;

    } catch (err) {
      this.result = {
        status: 'error',
        message: err.message,
        iterations: this.iteration,
        cost: this.totalCost,
      };
      this.onProgress({ type: 'error', error: err.message });
      return this.result;
    } finally {
      this.running = false;
    }
  }

  // Resume after ask_user
  async resume(userResponse, resumeState) {
    // Restore state
    this.messages = resumeState.messages;

    // Add user's response as tool result
    this.messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: resumeState.toolCallId,
        content: userResponse,
      }],
    });

    this.running = true;
    this.stopped = false;

    // Continue the loop from where we left off
    return this.continueLoop();
  }

  async continueLoop() {
    // Same loop logic as run(), but without reinitializing
    while (this.running && !this.stopped && this.iteration < this.maxIterations) {
      this.iteration++;

      if (this.totalCost >= this.maxCostUsd) {
        this.result = {
          status: 'cost_limit',
          message: `Cost limit reached ($${this.totalCost.toFixed(4)}).`,
          iterations: this.iteration,
          cost: this.totalCost,
        };
        break;
      }

      this.onProgress({
        type: 'iteration',
        iteration: this.iteration,
        maxIterations: this.maxIterations,
        cost: this.totalCost
      });

      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: this.buildSystemPrompt(),
        tools: AGENT_TOOLS,
        messages: this.messages,
      });

      const inputCost = (response.usage?.input_tokens || 0) * COST_PER_INPUT_TOKEN;
      const outputCost = (response.usage?.output_tokens || 0) * COST_PER_OUTPUT_TOKEN;
      this.totalCost += inputCost + outputCost;

      const assistantContent = response.content;
      this.messages.push({ role: 'assistant', content: assistantContent });

      const textBlocks = assistantContent.filter(b => b.type === 'text');
      const toolCalls = assistantContent.filter(b => b.type === 'tool_use');

      for (const block of textBlocks) {
        if (block.text?.trim()) {
          this.onProgress({ type: 'thinking', text: block.text });
        }
      }

      if (toolCalls.length === 0) {
        if (response.stop_reason === 'end_turn') {
          this.messages.push({
            role: 'user',
            content: 'Use tools to make progress, "complete" to finish, or "ask_user" if you need help.'
          });
          continue;
        }
      }

      const toolResults = [];
      for (const toolCall of toolCalls) {
        this.onProgress({ type: 'tool_start', tool: toolCall.name, input: toolCall.input });

        if (toolCall.name === 'complete') {
          this.running = false;
          this.result = {
            status: toolCall.input.status || 'success',
            message: toolCall.input.result || toolCall.input.message,
            iterations: this.iteration,
            cost: this.totalCost,
          };
          this.onProgress({ type: 'complete', result: this.result });
          return this.result;
        }

        if (toolCall.name === 'ask_user') {
          this.running = false;
          this.result = {
            status: 'needs_input',
            question: toolCall.input.question,
            context: toolCall.input.context,
            iterations: this.iteration,
            cost: this.totalCost,
            resumeState: { messages: this.messages, toolCallId: toolCall.id },
          };
          this.onProgress({ type: 'ask_user', question: toolCall.input.question });
          return this.result;
        }

        try {
          const result = await executeToolCall(toolCall.name, toolCall.input, { cwd: this.cwd });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolCall.id,
            content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          });
          this.onProgress({ type: 'tool_result', tool: toolCall.name, success: true });
        } catch (err) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolCall.id,
            content: `Error: ${err.message}`,
            is_error: true,
          });
          this.onProgress({ type: 'tool_result', tool: toolCall.name, success: false, error: err.message });
        }
      }

      if (toolResults.length > 0) {
        this.messages.push({ role: 'user', content: toolResults });
      }
    }

    if (this.iteration >= this.maxIterations && this.running) {
      this.result = {
        status: 'iteration_limit',
        message: `Reached ${this.maxIterations} iterations.`,
        iterations: this.iteration,
        cost: this.totalCost,
      };
    }

    if (this.stopped) {
      this.result = { status: 'stopped', message: 'Stopped by user.', iterations: this.iteration, cost: this.totalCost };
    }

    this.onProgress({ type: 'complete', result: this.result });
    return this.result;
  }

  stop() {
    this.stopped = true;
    this.running = false;
  }

  getStatus() {
    return {
      running: this.running,
      iteration: this.iteration,
      maxIterations: this.maxIterations,
      cost: this.totalCost,
      maxCost: this.maxCostUsd,
      goal: this.goal,
    };
  }
}

module.exports = { AgentLoop };
