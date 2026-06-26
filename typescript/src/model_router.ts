/**
 * Model Router — TypeScript
 * Unified interface over Anthropic Claude, DeepSeek, and OpenAI via their official SDKs.
 *
 * npm install @anthropic-ai/sdk@0.104.1 openai@4.104.0
 *
 * env: MODEL_PROVIDER = anthropic | deepseek | deepseek-openai | openai
 *      ANTHROPIC_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY
 *      MODEL_NAME (optional override)
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

// ── Unified response types ────────────────────────────────────────────────────
export interface TextBlock   { type: "text";     text: string }
export interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
export type ContentBlock = TextBlock | ToolUseBlock;

export interface Usage { inputTokens: number; outputTokens: number }

export interface UnifiedResponse {
  content:    ContentBlock[];
  stopReason: "end_turn" | "tool_use" | string;
  usage:      Usage;
}

// ── Default models ─────────────────────────────────────────────────────────────
const DEFAULT_MODELS: Record<string, string> = {
  "anthropic":       "claude-opus-4-6",
  "deepseek":        "deepseek-v4-pro",
  "deepseek-openai": "deepseek-v4-pro",
  "openai":          "gpt-5.5",
};

const DEEPSEEK_ANTHROPIC_BASE = "https://api.deepseek.com/anthropic";
const DEEPSEEK_OPENAI_BASE    = "https://api.deepseek.com";

// ── Tool schema conversion ────────────────────────────────────────────────────
function toOpenAITools(tools?: object[]): OpenAI.ChatCompletionTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t: any) => ({
    type: "function" as const,
    function: {
      name:        t.name,
      description: t.description ?? "",
      parameters:  t.input_schema ?? { type: "object", properties: {} },
    },
  }));
}

// ── Message format conversion ─────────────────────────────────────────────────
function toOpenAIMessages(
  messages: object[],
  system?: string,
): OpenAI.ChatCompletionMessageParam[] {
  const out: OpenAI.ChatCompletionMessageParam[] = [];
  if (system) out.push({ role: "system", content: system });

  for (const msg of messages as any[]) {
    const { role, content } = msg;
    if (typeof content === "string") {
      out.push({ role, content });
      continue;
    }
    if (role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = [];
      for (const b of content) {
        if (b.type === "text") textParts.push(b.text);
        else if (b.type === "tool_use") {
          toolCalls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } });
        }
      }
      const entry: any = { role: "assistant", content: textParts.join("") || null };
      if (toolCalls.length) entry.tool_calls = toolCalls;
      out.push(entry);
    } else if (role === "user") {
      const toolResults = (content as any[]).filter((b: any) => b.type === "tool_result");
      if (toolResults.length) {
        for (const tr of toolResults) {
          out.push({ role: "tool", tool_call_id: tr.tool_use_id, content: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content) });
        }
      } else {
        const text = (content as any[]).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
        out.push({ role: "user", content: text });
      }
    }
  }
  return out;
}

// ── ModelRouter ───────────────────────────────────────────────────────────────
export class ModelRouter {
  readonly provider: string;
  readonly model:    string;
  private kind:      "anthropic" | "openai";
  private anthropicClient?: Anthropic;
  private openaiClient?:    OpenAI;

  constructor(provider?: string, model?: string) {
    this.provider = (provider ?? process.env.MODEL_PROVIDER ?? "anthropic").toLowerCase();
    this.model    = model ?? process.env.MODEL_NAME ?? DEFAULT_MODELS[this.provider];

    if (!DEFAULT_MODELS[this.provider]) {
      throw new Error(`Unknown MODEL_PROVIDER '${this.provider}'. Valid: ${Object.keys(DEFAULT_MODELS).join(", ")}`);
    }

    if (this.provider === "anthropic") {
      this.anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, timeout: 60_000, maxRetries: 0 });
      this.kind = "anthropic";
    } else if (this.provider === "deepseek") {
      this.anthropicClient = new Anthropic({ apiKey: process.env.DEEPSEEK_API_KEY!, baseURL: DEEPSEEK_ANTHROPIC_BASE, timeout: 60_000, maxRetries: 0 });
      this.kind = "anthropic";
    } else if (this.provider === "deepseek-openai") {
      this.openaiClient = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY!, baseURL: DEEPSEEK_OPENAI_BASE, timeout: 60_000, maxRetries: 0 });
      this.kind = "openai";
    } else {
      this.openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY!, timeout: 60_000, maxRetries: 0 });
      this.kind = "openai";
    }
  }

  async create(messages: object[], options: { tools?: object[]; system?: string; maxTokens?: number } = {}): Promise<UnifiedResponse> {
    const { tools, system, maxTokens = 4096 } = options;
    return this.kind === "anthropic"
      ? this.createAnthropic(messages, tools, system, maxTokens)
      : this.createOpenAI(messages, tools, system, maxTokens);
  }

  private async createAnthropic(messages: object[], tools?: object[], system?: string, maxTokens = 4096): Promise<UnifiedResponse> {
    const params: any = { model: this.model, max_tokens: maxTokens, messages };
    if (tools?.length) params.tools = tools;
    if (system) params.system = system;
    const resp = await this.anthropicClient!.messages.create(params);
    const content: ContentBlock[] = resp.content.map((b: any) =>
      b.type === "text" ? { type: "text" as const, text: b.text } : { type: "tool_use" as const, id: b.id, name: b.name, input: b.input }
    );
    return { content, stopReason: resp.stop_reason, usage: { inputTokens: resp.usage.input_tokens, outputTokens: resp.usage.output_tokens } };
  }

  private async createOpenAI(messages: object[], tools?: object[], system?: string, maxTokens = 4096): Promise<UnifiedResponse> {
    const oaMessages = toOpenAIMessages(messages, system);
    const oaTools    = toOpenAITools(tools);
    const params: any = { model: this.model, messages: oaMessages, max_tokens: maxTokens };
    if (oaTools?.length) { params.tools = oaTools; params.tool_choice = "auto"; }
    const resp = await this.openaiClient!.chat.completions.create(params);
    const choice = resp.choices[0];
    const content: ContentBlock[] = [];
    if (choice.message.content) content.push({ type: "text", text: choice.message.content });
    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(tc.function.arguments); } catch {}
        content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
    }
    const stopReason = choice.message.tool_calls?.length ? "tool_use" : "end_turn";
    return { content, stopReason, usage: { inputTokens: resp.usage?.prompt_tokens ?? 0, outputTokens: resp.usage?.completion_tokens ?? 0 } };
  }

  toAssistantMessage(response: UnifiedResponse): object {
    return {
      role: "assistant",
      content: response.content.map(b =>
        b.type === "text" ? { type: "text", text: b.text } : { type: "tool_use", id: b.id, name: b.name, input: b.input }
      ),
    };
  }
}

export function makeToolResultMessage(toolUseId: string, content: string, isError = false): object {
  const block: any = { type: "tool_result", tool_use_id: toolUseId, content };
  if (isError) block.is_error = true;
  return { role: "user", content: [block] };
}
