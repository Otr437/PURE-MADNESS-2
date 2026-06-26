// agent/memory.ts — In-process conversation and fact memory for the agent.
// Stores recent messages and extracted facts so the agent has context across
// multiple tool calls in a session. TTL-based eviction prevents unbounded growth.

import NodeCache from 'node-cache';
import { config } from '../config';

export interface MemoryEntry {
  id:        string;
  role:      'user' | 'assistant' | 'tool';
  content:   string;
  toolName?: string;
  timestamp: number;
  sessionId: string;
}

export interface ConversationSession {
  sessionId:  string;
  messages:   MemoryEntry[];
  createdAt:  number;
  updatedAt:  number;
  metadata:   Record<string, unknown>;
}

const sessionCache = new NodeCache({
  stdTTL:      config.MEMORY_TTL_SECONDS,
  checkperiod: 120,
  maxKeys:     config.MEMORY_MAX_ITEMS,
});

/**
 * Start a new conversation session.
 */
export function createSession(sessionId: string, metadata: Record<string, unknown> = {}): ConversationSession {
  const session: ConversationSession = {
    sessionId,
    messages:  [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata,
  };
  sessionCache.set(sessionId, session);
  return session;
}

/**
 * Retrieve an existing session or create a new one.
 */
export function getOrCreateSession(sessionId: string): ConversationSession {
  const existing = sessionCache.get<ConversationSession>(sessionId);
  if (existing) return existing;
  return createSession(sessionId);
}

/**
 * Append a message to a session's conversation history.
 */
export function addMessage(
  sessionId: string,
  role: MemoryEntry['role'],
  content: string,
  toolName?: string,
): MemoryEntry {
  const session = getOrCreateSession(sessionId);
  const entry: MemoryEntry = {
    id:        `${sessionId}-${session.messages.length}`,
    role,
    content,
    toolName,
    timestamp: Date.now(),
    sessionId,
  };

  session.messages.push(entry);
  session.updatedAt = Date.now();

  // Trim to last N messages to avoid token overflow
  const MAX_MESSAGES = 50;
  if (session.messages.length > MAX_MESSAGES) {
    session.messages = session.messages.slice(-MAX_MESSAGES);
  }

  sessionCache.set(sessionId, session);
  return entry;
}

/**
 * Get the conversation history formatted for the Anthropic messages API.
 */
export function getConversationHistory(
  sessionId: string,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const session = sessionCache.get<ConversationSession>(sessionId);
  if (!session) return [];

  return session.messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));
}

/**
 * Clear a session — called when the conversation is ended.
 */
export function clearSession(sessionId: string): void {
  sessionCache.del(sessionId);
}

/**
 * Return stats about current memory usage.
 */
export function getMemoryStats(): { sessions: number; keys: string[] } {
  return { sessions: sessionCache.getStats().keys, keys: sessionCache.keys() };
}
