// agent/tools.ts — Tool definitions the bot exposes to Claude.
// These tools call authorized-to-act's REST API using the bot's M2M token.
// The bot never holds user private keys — all blockchain ops go through ATA.

import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import { getBearerHeader, refreshToken } from '../auth/client';
import { buildAuthHeaders, hashBody } from '../crypto/signatures';
import { config } from '../config';
import { logger } from '../api/middleware';
import { sendSlackMessage } from '../external_apis/slackClient';
import { sendGmailMessage, listCalendarEvents, createCalendarEvent } from '../external_apis/googleClient';

export type AnthropicTool = Anthropic.Tool;

// ─── ATA API caller ───────────────────────────────────────────────────────────

async function callATA<T>(
  method: 'get' | 'post' | 'delete',
  path: string,
  body?: unknown,
): Promise<T> {
  const bearerHeader = await getBearerHeader();
  const authHeaders  = await buildAuthHeaders(
    bearerHeader.Authorization.slice(7),
    body ? hashBody(body) : undefined,
  );

  try {
    const response = await axios.request<T>({
      method,
      url:     `${config.ATA_API_URL}${path}`,
      data:    body,
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      timeout: 30_000,
    });
    return response.data;
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response?.status === 401) {
      // Token may have been revoked — force refresh and retry once
      logger.warn('ATA returned 401 — refreshing token and retrying');
      const newToken = await refreshToken();
      const retryHeaders = await buildAuthHeaders(newToken, body ? hashBody(body) : undefined);
      const retryResp = await axios.request<T>({
        method,
        url:     `${config.ATA_API_URL}${path}`,
        data:    body,
        headers: { 'Content-Type': 'application/json', ...retryHeaders },
        timeout: 30_000,
      });
      return retryResp.data;
    }
    throw err;
  }
}

// ─── Tool implementations ─────────────────────────────────────────────────────

async function getWalletBalance(args: { address: string; network?: string }): Promise<unknown> {
  return callATA('get', `/api/blockchain/balance?address=${encodeURIComponent(args.address)}&network=${args.network ?? 'ethereum'}`);
}

async function runAgentTask(args: { task: string; conversationHistory?: unknown[] }): Promise<unknown> {
  return callATA('post', '/api/agent/run', { task: args.task, conversationHistory: args.conversationHistory ?? [] });
}

async function getAgentHistory(args: { limit?: number; offset?: number }): Promise<unknown> {
  return callATA('get', `/api/agent/history?limit=${args.limit ?? 20}&offset=${args.offset ?? 0}`);
}

async function getAvailableTools(): Promise<unknown> {
  return callATA('get', '/api/agent/tools');
}

async function slackPost(args: { channel: string; message: string }): Promise<unknown> {
  return sendSlackMessage(args.channel, args.message);
}

async function gmailSend(args: { to: string; subject: string; body: string }): Promise<unknown> {
  return sendGmailMessage(args.to, args.subject, args.body);
}

async function calendarList(args: { maxResults?: number; timeMin?: string }): Promise<unknown> {
  return listCalendarEvents(args.maxResults ?? 10, args.timeMin);
}

async function calendarCreate(args: { summary: string; start: string; end: string; description?: string }): Promise<unknown> {
  return createCalendarEvent(args.summary, args.start, args.end, args.description);
}

// ─── Tool registry ────────────────────────────────────────────────────────────

export const TOOLS: AnthropicTool[] = [
  {
    name: 'get_wallet_balance',
    description: 'Get ETH and token balances for a wallet address via authorized-to-act',
    input_schema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Ethereum wallet address (0x...)' },
        network: { type: 'string', description: 'Network: ethereum, polygon, bsc, arbitrum', default: 'ethereum' },
      },
      required: ['address'],
    },
  },
  {
    name: 'run_agent_task',
    description: 'Delegate a task to the authorized-to-act AI agent for execution',
    input_schema: {
      type: 'object',
      properties: {
        task:                { type: 'string', description: 'Task description for the agent' },
        conversationHistory: { type: 'array',  description: 'Prior conversation context', items: { type: 'object' } },
      },
      required: ['task'],
    },
  },
  {
    name: 'get_agent_history',
    description: 'Retrieve the authorized-to-act agent action history',
    input_schema: {
      type: 'object',
      properties: {
        limit:  { type: 'number', description: 'Max records to return', default: 20 },
        offset: { type: 'number', description: 'Pagination offset',     default: 0  },
      },
    },
  },
  {
    name: 'get_available_tools',
    description: 'List all tools available in the authorized-to-act agent',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'slack_post',
    description: 'Post a message to a Slack channel',
    input_schema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Slack channel name (e.g. #general)' },
        message: { type: 'string', description: 'Message text to post' },
      },
      required: ['channel', 'message'],
    },
  },
  {
    name: 'gmail_send',
    description: 'Send an email via Gmail',
    input_schema: {
      type: 'object',
      properties: {
        to:      { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        body:    { type: 'string', description: 'Email body text' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'calendar_list',
    description: 'List upcoming Google Calendar events',
    input_schema: {
      type: 'object',
      properties: {
        maxResults: { type: 'number', description: 'Max events to return', default: 10 },
        timeMin:    { type: 'string', description: 'ISO 8601 start time filter' },
      },
    },
  },
  {
    name: 'calendar_create',
    description: 'Create a Google Calendar event',
    input_schema: {
      type: 'object',
      properties: {
        summary:     { type: 'string', description: 'Event title' },
        start:       { type: 'string', description: 'Start datetime ISO 8601' },
        end:         { type: 'string', description: 'End datetime ISO 8601'   },
        description: { type: 'string', description: 'Event description'       },
      },
      required: ['summary', 'start', 'end'],
    },
  },
];

export type ToolName = typeof TOOLS[number]['name'];

// ─── Dispatcher ───────────────────────────────────────────────────────────────

export async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  logger.info('Executing tool', { tool: name });

  switch (name) {
    case 'get_wallet_balance':  return getWalletBalance(args as { address: string; network?: string });
    case 'run_agent_task':      return runAgentTask(args as { task: string; conversationHistory?: unknown[] });
    case 'get_agent_history':   return getAgentHistory(args as { limit?: number; offset?: number });
    case 'get_available_tools': return getAvailableTools();
    case 'slack_post':          return slackPost(args as { channel: string; message: string });
    case 'gmail_send':          return gmailSend(args as { to: string; subject: string; body: string });
    case 'calendar_list':       return calendarList(args as { maxResults?: number; timeMin?: string });
    case 'calendar_create':     return calendarCreate(args as { summary: string; start: string; end: string; description?: string });
    default: throw new Error(`Unknown tool: ${name}`);
  }
}
