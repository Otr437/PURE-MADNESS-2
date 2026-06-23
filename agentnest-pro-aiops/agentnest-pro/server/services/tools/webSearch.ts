/**
 * webSearch tool — searches the web via DuckDuckGo's JSON API.
 * No API key required. Returns a structured summary of top results.
 * Agents use this for real-time information beyond their training data.
 */

import { registerTool, type ToolResult } from "./index.js";

registerTool({
  name:        "webSearch",
  description: "Search the web for current information. Use when you need up-to-date facts, CVEs, prices, news, or anything beyond your training data.",
  parameters: {
    query: { type: "string", description: "The search query", required: true },
    maxResults: { type: "number", description: "Maximum results to return (default 5, max 10)" },
  },

  async execute(args, _taskId, _agentId): Promise<ToolResult> {
    const query = String(args.query ?? "").trim();
    if (!query) return { success: false, output: "", error: "query is required" };

    const max = Math.min(Number(args.maxResults ?? 5), 10);

    try {
      // DuckDuckGo Instant Answers API — no rate limit for reasonable use
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) throw new Error(`DuckDuckGo returned ${res.status}`);

      const data: any = await res.json();
      const results: string[] = [];

      // Abstract (instant answer)
      if (data.Abstract) {
        results.push(`Summary: ${data.Abstract}\nSource: ${data.AbstractURL}`);
      }

      // Answer (calculator, conversions, etc.)
      if (data.Answer) {
        results.push(`Answer: ${data.Answer}`);
      }

      // Related topics
      if (Array.isArray(data.RelatedTopics)) {
        for (const topic of data.RelatedTopics.slice(0, max)) {
          if (topic.Text && topic.FirstURL) {
            results.push(`${topic.Text}\n→ ${topic.FirstURL}`);
          }
        }
      }

      if (results.length === 0) {
        return {
          success: true,
          output: `No instant results found for "${query}". Consider refining your search or using a more specific query.`,
        };
      }

      return {
        success: true,
        output:  results.slice(0, max).join("\n\n"),
      };

    } catch (err: any) {
      if (err.name === "AbortError") {
        return { success: false, output: "", error: "webSearch timed out after 8 seconds" };
      }
      return { success: false, output: "", error: `webSearch failed: ${err.message}` };
    }
  },
});
