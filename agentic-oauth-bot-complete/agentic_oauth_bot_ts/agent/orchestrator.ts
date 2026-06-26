// agent/orchestrator.ts — Core agentic loop.
// Sends tasks to Claude, executes tools via authorized-to-act, feeds results back.
// Uses the bot's own M2M OAuth token and RSA-signed assertions on every ATA call.

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { TOOLS, executeTool } from './tools';
import { addMessage, getConversationHistory } from './memory';
import { logger } from '../api/middleware';

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  return _client;
}

export interface OrchestratorResult {
  response:    string;
  toolResults: Array<{ tool: string; success: boolean; result?: unknown; error?: string }>;
  iterations:  number;
  sessionId:   string;
  timestamp:   string;
}

const SYSTEM_PROMPT = `You are an autonomous OAuth agent named ${config.AGENT_NAME ?? 'agentic-oauth-bot'}.
You have a verified machine identity issued by Auth0 and sign every request to the authorized-to-act backend with your RSA private key.
You can run AI agent tasks, check blockchain balances, post to Slack, send emails, and manage Google Calendar events.
Always confirm destructive or financial actions before executing them.
Be concise, precise, and security-conscious.`;

const MAX_ITERATIONS = 8;

/**
 * Run the agentic loop for a given task.
 *
 * @param task      — Natural-language task description
 * @param sessionId — Conversation session ID (creates new session if not found)
 */
export async function runOrchestrator(task: string, sessionId: string): Promise<OrchestratorResult> {
  if (!task || !task.trim()) throw new Error('task is required');

  // Record the user turn in memory
  addMessage(sessionId, 'user', task);

  const history = getConversationHistory(sessionId);
  const messages: Anthropic.MessageParam[] = history.length > 1
    ? history.slice(0, -1) // everything before the current message
    : [];
  messages.push({ role: 'user', content: task });

  const toolResults: OrchestratorResult['toolResults'] = [];
  let iterations = 0;
  let response: Anthropic.Message | null = null;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    response = await getClient().messages.create({
      model:      config.ANTHROPIC_API_KEY ? 'claude-3-5-sonnet-20241022' : 'claude-3-haiku-20240307',
      max_tokens: 4096,
      system:     SYSTEM_PROMPT,
      tools:      TOOLS,
      messages,
    });

    if (response.stop_reason === 'end_turn') break;

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });

      const toolResultContent: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        try {
          const result = await executeTool(block.name, block.input as Record<string, unknown>);
          toolResults.push({ tool: block.name, success: true, result });
          toolResultContent.push({
            type:        'tool_result',
            tool_use_id: block.id,
            content:     JSON.stringify(result),
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error('Tool execution failed', { tool: block.name, error: message, sessionId });
          toolResults.push({ tool: block.name, success: false, error: message });
          toolResultContent.push({
            type:        'tool_result',
            tool_use_id: block.id,
            content:     `Error: ${message}`,
            is_error:    true,
          });
        }
      }

      messages.push({ role: 'user', content: toolResultContent });
    } else {
      break;
    }
  }

  const finalText = (response?.content ?? [])
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  // Record assistant response in memory
  addMessage(sessionId, 'assistant', finalText);

  return {
    response:   finalText,
    toolResults,
    iterations,
    sessionId,
    timestamp:  new Date().toISOString(),
  };
}
