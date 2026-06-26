// src/agent-tools.ts
// Runs agents with tool-calling enabled.
// All four providers share the same tool definitions via AI SDK's unified tool spec.
// Tools: web_search (mock), calculator, fetch_json

import { generateText, tool } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { groq } from "@ai-sdk/groq";
import { deepseek } from "@ai-sdk/deepseek";
import { z } from "zod";
import type { AgentConfig, AgentTask, AgentResult } from "./types.js";

// ─── SHARED TOOL DEFINITIONS ──────────────────────────────────────────────────
// These same tools are passed to every provider. The AI SDK normalizes the
// tool spec to each provider's native format automatically.

const sharedTools = {
  calculator: tool({
    description:
      "Evaluates a mathematical expression and returns the numeric result. " +
      "Use for arithmetic, percentages, unit conversions.",
    parameters: z.object({
      expression: z
        .string()
        .describe("A valid JavaScript math expression, e.g. '2 ** 10 / 3'"),
    }),
    execute: async ({ expression }) => {
      try {
        // Safe eval: only allow math characters
        if (!/^[0-9+\-*/.() %^]+$/.test(expression)) {
          return { error: "Invalid expression — only math operators allowed." };
        }
        // eslint-disable-next-line no-new-func
        const result = new Function(`return (${expression})`)();
        return { result: String(result) };
      } catch {
        return { error: "Could not evaluate expression." };
      }
    },
  }),

  fetch_json: tool({
    description:
      "Fetches JSON data from a public URL. Use for reading structured data from an API endpoint.",
    parameters: z.object({
      url: z.string().url().describe("The URL to fetch JSON from."),
    }),
    execute: async ({ url }) => {
      try {
        const res = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return { error: `HTTP ${res.status}: ${res.statusText}` };
        const data = await res.json();
        // Truncate large responses so they fit in context
        const text = JSON.stringify(data);
        return {
          data: text.length > 4000 ? text.slice(0, 4000) + "…[truncated]" : data,
        };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  }),

  web_search: tool({
    description:
      "Searches the web for current information. Returns a list of results with titles, URLs, and snippets. " +
      "Requires BRAVE_API_KEY, SERPER_API_KEY, or TAVILY_API_KEY in environment.",
    parameters: z.object({
      query: z.string().describe("The search query."),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(5)
        .describe("Number of results to return."),
    }),
    execute: async ({ query, max_results }) => {
      // ── Brave Search ──────────────────────────────────────────────────────
      if (process.env.BRAVE_API_KEY) {
        const res = await fetch(
          `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${max_results}`,
          {
            headers: {
              "Accept": "application/json",
              "Accept-Encoding": "gzip",
              "X-Subscription-Token": process.env.BRAVE_API_KEY,
            },
            signal: AbortSignal.timeout(10_000),
          }
        );
        if (!res.ok) throw new Error(`Brave Search error: HTTP ${res.status}`);
        const data: any = await res.json();
        const results = (data.web?.results ?? []).slice(0, max_results);
        return results.map((r: any) => ({
          title:   r.title   ?? "",
          url:     r.url     ?? "",
          snippet: r.description ?? "",
        }));
      }

      // ── Serper (Google Search via serper.dev) ─────────────────────────────
      if (process.env.SERPER_API_KEY) {
        const res = await fetch("https://google.serper.dev/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-KEY": process.env.SERPER_API_KEY,
          },
          body: JSON.stringify({ q: query, num: max_results }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`Serper error: HTTP ${res.status}`);
        const data: any = await res.json();
        const results = (data.organic ?? []).slice(0, max_results);
        return results.map((r: any) => ({
          title:   r.title   ?? "",
          url:     r.link    ?? "",
          snippet: r.snippet ?? "",
        }));
      }

      // ── Tavily ────────────────────────────────────────────────────────────
      if (process.env.TAVILY_API_KEY) {
        const res = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key:        process.env.TAVILY_API_KEY,
            query,
            max_results,
            search_depth:   "basic",
            include_answer: false,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`Tavily error: HTTP ${res.status}`);
        const data: any = await res.json();
        const results = (data.results ?? []).slice(0, max_results);
        return results.map((r: any) => ({
          title:   r.title   ?? "",
          url:     r.url     ?? "",
          snippet: r.content ?? "",
        }));
      }

      // ── No search provider configured — hard error, not a silent fake ─────
      throw new Error(
        "web_search requires a search API key. Set one of: BRAVE_API_KEY, SERPER_API_KEY, or TAVILY_API_KEY in your .env file.\n" +
        "  Brave:  https://api.search.brave.com  (~$3/mo for 2k queries)\n" +
        "  Serper: https://serper.dev            (~$1/1k queries)\n" +
        "  Tavily: https://tavily.com            (free tier available)"
      );
    },
  }),
};

function getModel(config: AgentConfig) {
  switch (config.provider) {
    case "claude":   return anthropic(config.model);
    case "openai":   return openai(config.model);
    case "groq":     return groq(config.model);
    case "deepseek": return deepseek(config.model);
    default: throw new Error(`Unknown provider: ${config.provider}`);
  }
}

// Runs a single agent with tool calling. maxSteps controls the tool-use loop.
export async function runAgentWithTools(
  config: AgentConfig,
  task: AgentTask,
  maxSteps = 5
): Promise<AgentResult> {
  const start = Date.now();

  try {
    const model = getModel(config);

    const { text, usage, steps } = await generateText({
      model,
      system: config.systemPrompt ?? task.systemPrompt,
      prompt: task.prompt,
      tools: sharedTools,
      maxSteps,           // allows multi-turn tool-use loops
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens ?? 4096,
    });

    // Log tool calls for visibility
    const toolCalls = steps.flatMap((s) =>
      s.toolCalls?.map((tc) => `${tc.toolName}(${JSON.stringify(tc.args)})`) ?? []
    );
    if (toolCalls.length > 0) {
      console.log(
        `  [${config.provider}/${config.model}] tool calls: ${toolCalls.join(" → ")}`
      );
    }

    return {
      agentId: config.id,
      provider: config.provider,
      model: config.model,
      task,
      text,
      durationMs: Date.now() - start,
      tokensUsed: usage
        ? {
            prompt: usage.promptTokens,
            completion: usage.completionTokens,
            total: usage.totalTokens,
          }
        : undefined,
    };
  } catch (err) {
    return {
      agentId: config.id,
      provider: config.provider,
      model: config.model,
      task,
      text: "",
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
