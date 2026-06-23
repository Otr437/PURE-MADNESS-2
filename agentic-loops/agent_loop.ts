/**
 * Plug-and-play Agentic Loop — TypeScript
 * Requires: npm install @anthropic-ai/sdk
 * Set: ANTHROPIC_API_KEY env var
 */

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Define your tools here ────────────────────────────────────────────────────
const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_weather",
    description: "Get the current weather for a city.",
    input_schema: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name" },
      },
      required: ["city"],
    },
  },
];

function executeTool(name: string, input: Record<string, string>): string {
  if (name === "get_weather") {
    return `The weather in ${input.city} is 72°F and sunny.`; // stub
  }
  return "Unknown tool";
}

// ── The loop ──────────────────────────────────────────────────────────────────
async function runAgent(userMessage: string, maxIterations = 10): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  for (let i = 0; i < maxIterations; i++) {
    const response = await client.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 1024,
      tools: TOOLS,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      for (const block of response.content) {
        if (block.type === "text") return block.text;
      }
    }

    if (response.stop_reason === "tool_use") {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          const result = executeTool(block.name, block.input as Record<string, string>);
          console.log(`[Tool] ${block.name}(${JSON.stringify(block.input)}) → ${result}`);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
        }
      }
      messages.push({ role: "user", content: toolResults });
    }
  }

  return "Max iterations reached.";
}

(async () => {
  const result = await runAgent("What's the weather like in Tokyo?");
  console.log(result);
})();
