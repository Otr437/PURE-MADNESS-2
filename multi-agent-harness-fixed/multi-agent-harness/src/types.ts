// src/types.ts

// ─── Temporal global (Node 26+) ───────────────────────────────────────────────
// Temporal is a built-in global on Node 26. We declare it here so TypeScript
// is satisfied. On Node 22 you must polyfill: npm install @js-temporal/polyfill
// and import { Temporal } from "@js-temporal/polyfill" where needed.
declare const Temporal: typeof import("@js-temporal/polyfill").Temporal;

export interface AgentTask {
  id: string;
  prompt: string;
  systemPrompt?: string;
}

export interface AgentResult {
  agentId: string;
  provider: string;
  model: string;
  task: AgentTask;
  text: string;
  durationMs: number;
  tokensUsed?: {
    prompt: number;
    completion: number;
    total: number;
  };
  error?: string;
}

export interface AgentConfig {
  id: string;
  provider: "claude" | "openai" | "groq" | "deepseek";
  model: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface HarnessConfig {
  agents: AgentConfig[];
  tasks: AgentTask[];
  mode: "fan-out" | "pipeline" | "parallel-tasks";
  // fan-out:       every agent runs every task (compare outputs across providers)
  // pipeline:      tasks run in sequence, each agent's output feeds the next
  // parallel-tasks: each agent gets a different task, all run simultaneously
}

export interface HarnessResult {
  mode: HarnessConfig["mode"];
  totalDurationMs: number;
  results: AgentResult[];
  summary: {
    byProvider: Record<string, { count: number; avgDurationMs: number; errors: number }>;
    totalTasks: number;
    succeeded: number;
    failed: number;
  };
}
