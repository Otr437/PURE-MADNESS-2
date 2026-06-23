/**
 * memoryRead / memoryWrite tools — agents access their own long-term memory.
 * Agents call memoryWrite to save a learned fact at the end of a task.
 * Agents call memoryRead to retrieve relevant past knowledge before acting.
 */

import { registerTool, type ToolResult } from "./index.js";
import { longTermWrite, longTermQuery, longTermSerialize } from "../memory/longTerm.js";

// ─── memoryRead ───────────────────────────────────────────────────────────────

registerTool({
  name:        "memoryRead",
  description: "Retrieve relevant knowledge from your long-term memory. Call this at the start of a task to recall patterns, findings, or context from previous tasks.",
  parameters: {
    query: { type: "string", description: "What you are trying to remember — a topic, pattern, or keyword", required: true },
    limit: { type: "number", description: "Max memories to retrieve (default 5)" },
  },

  async execute(args, _taskId, agentId): Promise<ToolResult> {
    if (!agentId) {
      return { success: false, output: "", error: "memoryRead requires an agent context" };
    }
    const query = String(args.query ?? "").trim();
    if (!query) return { success: false, output: "", error: "query is required" };

    const limit   = Math.min(Number(args.limit ?? 5), 20);
    const entries = longTermQuery(agentId, query, limit);

    if (entries.length === 0) {
      return { success: true, output: "No relevant memories found for this query." };
    }

    return {
      success: true,
      output:  `Retrieved ${entries.length} memory entries:\n\n${longTermSerialize(entries)}`,
    };
  },
});

// ─── memoryWrite ──────────────────────────────────────────────────────────────

registerTool({
  name:        "memoryWrite",
  description: "Save a learned fact or pattern to your long-term memory. Call this when you discover something useful that should be remembered for future tasks.",
  parameters: {
    key:     { type: "string", description: "Short label for this memory (e.g., 'cve-lookup-pattern', 'eth-gas-trend')", required: true },
    content: { type: "string", description: "The fact, pattern, or insight to remember",                                   required: true },
  },

  async execute(args, taskId, agentId): Promise<ToolResult> {
    if (!agentId) {
      return { success: false, output: "", error: "memoryWrite requires an agent context" };
    }
    const key     = String(args.key     ?? "").trim();
    const content = String(args.content ?? "").trim();

    if (!key)     return { success: false, output: "", error: "key is required" };
    if (!content) return { success: false, output: "", error: "content is required" };

    longTermWrite(agentId, key, content, taskId);

    return {
      success: true,
      output:  `Memory saved under key "${key}".`,
    };
  },
});
