// src/context-manager.ts
// Manages conversation context across multi-turn agent loops.
// Prevents context rot and token overflow.
// Strategies: sliding window, summarize-and-prune, priority-based trimming.

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tokenEstimate?: number;
  priority?: "high" | "normal" | "low"; // high = never pruned
  timestamp?: number;
}

export interface ContextConfig {
  maxTokens: number;       // hard limit for the context window
  reserveForOutput: number;// tokens reserved for model output
  summarizeAt: number;     // token count at which to trigger summarization
  strategy: "sliding-window" | "priority-prune" | "summarize";
}

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  maxTokens: 128_000,
  reserveForOutput: 4_096,
  summarizeAt: 100_000,
  strategy: "priority-prune",
};

// Rough token estimator: ~4 chars per token
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function totalTokens(messages: Message[]): number {
  return messages.reduce(
    (sum, m) => sum + (m.tokenEstimate ?? estimateTokens(m.content)),
    0
  );
}

export class ContextManager {
  private messages: Message[] = [];
  private config: ContextConfig;

  constructor(config: ContextConfig = DEFAULT_CONTEXT_CONFIG) {
    this.config = config;
  }

  addMessage(msg: Message): void {
    const tokenEstimate = estimateTokens(msg.content);
    this.messages.push({
      ...msg,
      tokenEstimate,
      timestamp: msg.timestamp ?? Date.now(),
    });
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  tokenCount(): number {
    return totalTokens(this.messages);
  }

  // Returns true if the context is approaching the limit
  isNearLimit(): boolean {
    return (
      this.tokenCount() >=
      this.config.maxTokens - this.config.reserveForOutput
    );
  }

  // ── SLIDING WINDOW ────────────────────────────────────────────────────────
  // Keeps the system message + the N most recent messages that fit in budget.
  slidingWindow(): Message[] {
    const budget = this.config.maxTokens - this.config.reserveForOutput;
    const system = this.messages.filter((m) => m.role === "system");
    const rest   = this.messages.filter((m) => m.role !== "system");

    let used = totalTokens(system);
    const kept: Message[] = [];

    // Walk from newest to oldest, collect messages that fit
    for (let i = rest.length - 1; i >= 0; i--) {
      const m = rest[i];
      const t = m.tokenEstimate ?? estimateTokens(m.content);
      if (used + t <= budget) {
        kept.unshift(m); // prepend to maintain chronological order
        used += t;
      }
    }

    // System messages always go first
    return [...system, ...kept];
  }

  // ── PRIORITY PRUNE ────────────────────────────────────────────────────────
  // Drops "low" priority messages first, then "normal", keeps "high" and system.
  priorityPrune(): Message[] {
    const budget = this.config.maxTokens - this.config.reserveForOutput;

    if (totalTokens(this.messages) <= budget) {
      return [...this.messages];
    }

    // Try pruning low first
    let pruned = this.messages.filter((m) => m.priority !== "low");
    if (totalTokens(pruned) <= budget) return pruned;

    // Then prune normal
    pruned = pruned.filter(
      (m) => m.priority === "high" || m.role === "system"
    );
    if (totalTokens(pruned) <= budget) return pruned;

    // Last resort: sliding window on what's left
    return this.slidingWindow();
  }

  // ── SUMMARIZE PLACEHOLDER ─────────────────────────────────────────────────
  // Inject a summary message in place of old messages.
  // Call this with a summary string produced by the model (pass the conversation
  // to the model with a "summarize this conversation so far" prompt).
  injectSummary(summaryText: string, replaceBefore: number): void {
    const summaryMsg: Message = {
      role: "assistant",
      content: `[Summary of earlier conversation]: ${summaryText}`,
      priority: "high",
      tokenEstimate: estimateTokens(summaryText) + 10,
      timestamp: Date.now(),
    };

    this.messages = [
      ...this.messages.filter((m) => m.role === "system"),
      summaryMsg,
      ...this.messages.filter(
        (m) => m.role !== "system" && (m.timestamp ?? 0) >= replaceBefore
      ),
    ];
  }

  // Returns the messages to actually send based on configured strategy
  getWindowedMessages(): Message[] {
    switch (this.config.strategy) {
      case "sliding-window":
        return this.slidingWindow();
      case "priority-prune":
        return this.priorityPrune();
      case "summarize":
        // Caller is responsible for calling injectSummary() before this
        return this.slidingWindow();
      default:
        return [...this.messages];
    }
  }

  clear(): void {
    this.messages = [];
  }
}
