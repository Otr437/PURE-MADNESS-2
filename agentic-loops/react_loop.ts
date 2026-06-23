/**
 * Production ReAct Loop — TypeScript
 * Reason → Act → Observe, repeat until finish() called.
 *
 * npm install @anthropic-ai/sdk
 * export ANTHROPIC_API_KEY=sk-ant-...
 * npx ts-node react_loop.ts "your task here"
 */

import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import * as fs from "fs";
import * as https from "https";

// ── Trace types ───────────────────────────────────────────────────────────────
type Thought    = { type: "thought";     content: string };
type Action     = { type: "action";      tool: string; input: Record<string, unknown> };
type Observation= { type: "observation"; content: string; error: boolean };
type Answer     = { type: "answer";      content: string };
type Step       = Thought | Action | Observation | Answer;

interface Trace {
  steps:       Step[];
  totalTokens: number;
  iterations:  number;
  elapsedMs:   number;
}

// ── Tool registry ─────────────────────────────────────────────────────────────
type ToolFn = (input: Record<string, unknown>) => Promise<string> | string;

interface ToolSchema {
  name:         string;
  description:  string;
  input_schema: Record<string, unknown>;
}

const toolRegistry  = new Map<string, ToolFn>();
const toolSchemas:  ToolSchema[] = [];

function registerTool(schema: ToolSchema, fn: ToolFn) {
  toolRegistry.set(schema.name, fn);
  toolSchemas.push(schema);
}

// ── Built-in tools ────────────────────────────────────────────────────────────

registerTool({
  name: "think",
  description: "Reason step by step before acting. Does not call external systems.",
  input_schema: {
    type: "object",
    properties: { reasoning: { type: "string" } },
    required: ["reasoning"],
  },
}, async ({ reasoning }) => {
  void reasoning; // logged by engine
  return "OK";
});

registerTool({
  name: "search",
  description: "Search the web for current information.",
  input_schema: {
    type: "object",
    properties: {
      query:       { type: "string" },
      num_results: { type: "integer" },
    },
    required: ["query"],
  },
}, async ({ query }) => {
  // Replace with Brave, Tavily, SerpAPI, etc.
  throw new Error(`Search not wired up. Query was: ${query}`);
});

registerTool({
  name: "fetch_url",
  description: "Fetch the text content of a URL.",
  input_schema: {
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
  },
}, ({ url }) => new Promise((resolve, reject) => {
  https.get(url as string, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      const clean = data.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      resolve(clean.slice(0, 8000));
    });
  }).on("error", reject);
}));

registerTool({
  name: "run_node",
  description: "Execute JavaScript code in Node.js. Returns stdout/stderr. Timeout 15s.",
  input_schema: {
    type: "object",
    properties: { code: { type: "string" } },
    required: ["code"],
  },
}, ({ code }) => {
  try {
    const result = execSync(`node -e ${JSON.stringify(code)}`, {
      timeout: 15000,
      encoding: "utf8",
    });
    return result.trim() || "(no output)";
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return (err.stdout || "") + (err.stderr || err.message || "unknown error");
  }
});

registerTool({
  name: "read_file",
  description: "Read a file from disk.",
  input_schema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
}, ({ path }) => fs.readFileSync(path as string, "utf8"),
);

registerTool({
  name: "write_file",
  description: "Write content to a file on disk.",
  input_schema: {
    type: "object",
    properties: {
      path:    { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
}, ({ path, content }) => {
  fs.writeFileSync(path as string, content as string, "utf8");
  return `Written ${(content as string).length} bytes to ${path}`;
});

registerTool({
  name: "finish",
  description: "Call this when you have the final answer. Ends the loop.",
  input_schema: {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
  },
}, ({ answer }) => answer as string,
);

// ── Client ────────────────────────────────────────────────────────────────────
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  timeout: 60_000,
  maxRetries: 4,
});

// ── ReAct system prompt ───────────────────────────────────────────────────────
const REACT_SYSTEM = `You are an autonomous agent operating in a ReAct loop (Reason + Act + Observe).

For every task:
1. Use the think tool to reason about what to do next before acting.
2. Call the appropriate tool to act.
3. Observe the result and reason again.
4. Repeat until you have a complete, verified answer.
5. Call finish with your final answer when done.

Rules:
- Always think before acting. Never skip the think step.
- If a tool errors, reason about why and try a different approach.
- Do not guess. If unsure, search or fetch.
- Be thorough. Do not call finish until the task is fully complete.`;

// ── Core ReAct engine ─────────────────────────────────────────────────────────
export async function runReact(
  task: string,
  options: {
    systemExtra?:   string;
    maxIterations?: number;
    onStep?:        (step: Step) => void;
  } = {}
): Promise<{ answer: string; trace: Trace }> {
  const { systemExtra = "", maxIterations = 30, onStep } = options;
  const system = REACT_SYSTEM + (systemExtra ? `\n\n${systemExtra}` : "");

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: task },
  ];

  const trace: Trace = { steps: [], totalTokens: 0, iterations: 0, elapsedMs: 0 };
  const startTime = Date.now();

  console.error(`[react] START: ${task.slice(0, 120)}`);

  for (let i = 0; i < maxIterations; i++) {
    trace.iterations = i + 1;
    console.error(`[react] iteration ${i + 1}`);

    const response = await client.messages.create({
      model:      "claude-opus-4-6",
      max_tokens: 4096,
      system,
      tools:      toolSchemas as Anthropic.Tool[],
      messages,
    });

    trace.totalTokens += response.usage.input_tokens + response.usage.output_tokens;
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      for (const block of response.content) {
        if (block.type === "text" && block.text.trim()) {
          const answer = block.text.trim();
          trace.steps.push({ type: "answer", content: answer });
          trace.elapsedMs = Date.now() - startTime;
          return { answer, trace };
        }
      }
    }

    if (response.stop_reason === "tool_use") {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type !== "tool_use") continue;

        const { id, name, input } = block;
        const inp = input as Record<string, unknown>;

        // Think step
        if (name === "think") {
          const thought: Thought = { type: "thought", content: inp.reasoning as string };
          trace.steps.push(thought);
          onStep?.(thought);
          console.error(`[react] 💭 ${thought.content.slice(0, 200)}`);
          toolResults.push({ type: "tool_result", tool_use_id: id, content: "OK" });
          continue;
        }

        // Finish
        if (name === "finish") {
          const answer = inp.answer as string;
          trace.steps.push({ type: "answer", content: answer });
          trace.elapsedMs = Date.now() - startTime;
          console.error(`[react] DONE — ${trace.iterations} iterations, ${trace.totalTokens} tokens, ${trace.elapsedMs}ms`);
          return { answer, trace };
        }

        // Regular action
        const action: Action = { type: "action", tool: name, input: inp };
        trace.steps.push(action);
        onStep?.(action);
        console.error(`[react] ⚡ ${name}(${JSON.stringify(inp).slice(0, 200)})`);

        let result: string;
        let isError = false;
        try {
          const fn = toolRegistry.get(name);
          if (!fn) throw new Error(`Tool '${name}' not registered`);
          result = await fn(inp);
        } catch (e: unknown) {
          result = `Tool error: ${(e as Error).message}`;
          isError = true;
          console.error(`[react] ❌ ${name} error: ${result}`);
        }

        const obs: Observation = { type: "observation", content: result, error: isError };
        trace.steps.push(obs);
        onStep?.(obs);
        console.error(`[react] 👁 ${result.slice(0, 200)}`);

        toolResults.push({
          type:        "tool_result",
          tool_use_id: id,
          content:     result,
          is_error:    isError,
        });
      }

      messages.push({ role: "user", content: toolResults });
      continue;
    }

    console.error(`[react] unexpected stop_reason: ${response.stop_reason}`);
    break;
  }

  trace.elapsedMs = Date.now() - startTime;
  throw new Error(
    `ReAct loop did not finish within ${maxIterations} iterations. Tokens: ${trace.totalTokens}`
  );
}

// ── CLI entry point ───────────────────────────────────────────────────────────
if (require.main === module) {
  const task = process.argv.slice(2).join(" ") ||
    "Calculate the 47th Fibonacci number using code, then explain the result.";

  runReact(task, {
    onStep(step) {
      if (step.type === "thought")     process.stdout.write(`\n💭 THOUGHT: ${step.content.slice(0, 300)}\n`);
      if (step.type === "action")      process.stdout.write(`\n⚡ ACTION: ${step.tool}(${JSON.stringify(step.input).slice(0, 200)})\n`);
      if (step.type === "observation") process.stdout.write(`\n${step.error ? "❌" : "👁"} OBSERVE: ${step.content.slice(0, 300)}\n`);
    },
  }).then(({ answer, trace }) => {
    console.log("\n" + "=".repeat(60));
    console.log("FINAL ANSWER:");
    console.log(answer);
    console.log("=".repeat(60));
    console.log(`Iterations: ${trace.iterations} | Tokens: ${trace.totalTokens} | Time: ${trace.elapsedMs}ms`);
    console.log("\nFull trace:");
    console.log(JSON.stringify(trace.steps, null, 2));
  }).catch((e) => {
    console.error("FATAL:", e.message);
    process.exit(1);
  });
}
