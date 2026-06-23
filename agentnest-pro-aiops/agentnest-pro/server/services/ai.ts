import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI, Type } from "@google/genai";
import OpenAI from "openai";
import { db, queries, logEntry } from "../db/index.js";
import { decrypt, safeDecryptSetting } from "./crypto.js";

export type Provider = "anthropic" | "gemini" | "openai" | "deepseek" | "ollama";

export interface AIMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AICallOptions {
  provider:    Provider;
  model:       string;
  systemPrompt: string;
  messages:    AIMessage[];
  maxTokens?:  number;
  taskId?:     string;
  agentId?:    string;
}

function getDecryptedKey(settingKey: string): string {
  const row = queries.getSetting.get(settingKey) as any;
  if (!row || !row.value) return process.env[settingKey] || "";
  return safeDecryptSetting(row.value, row.is_secret);
}

export async function callAI(opts: AICallOptions): Promise<string> {
  const { provider, model, systemPrompt, messages, maxTokens = 4096, taskId, agentId } = opts;

  logEntry(taskId || null, agentId || null, `Calling ${provider} model ${model}`, "command", "agent");

  try {
    let result: string;

    switch (provider) {
      case "anthropic":
        result = await callAnthropic(model, systemPrompt, messages, maxTokens);
        break;
      case "gemini":
        result = await callGemini(model, systemPrompt, messages, maxTokens);
        break;
      case "openai":
        result = await callOpenAI(model, systemPrompt, messages, maxTokens);
        break;
      case "deepseek":
        result = await callDeepSeek(model, systemPrompt, messages, maxTokens);
        break;
      case "ollama":
        result = await callOllama(model, systemPrompt, messages, maxTokens);
        break;
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }

    logEntry(taskId || null, agentId || null, `${provider} response received (${result.length} chars)`, "info", "agent");
    return result;

  } catch (err: any) {
    const msg = `AI call failed [${provider}/${model}]: ${err.message}`;
    logEntry(taskId || null, agentId || null, msg, "error", "agent");
    throw new Error(msg);
  }
}

async function callAnthropic(
  model: string,
  systemPrompt: string,
  messages: AIMessage[],
  maxTokens: number
): Promise<string> {
  const apiKey = getDecryptedKey("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured in settings");

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: model || "claude-sonnet-4-6",
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
  });

  const block = response.content[0];
  if (block.type !== "text") throw new Error("Unexpected non-text response from Anthropic");
  return block.text;
}

async function callGemini(
  model: string,
  systemPrompt: string,
  messages: AIMessage[],
  maxTokens: number
): Promise<string> {
  const apiKey = getDecryptedKey("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured in settings");

  const ai = new GoogleGenAI({ apiKey });

  const contents = messages.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const response = await ai.models.generateContent({
    model: model || "gemini-2.0-flash",
    contents,
    config: {
      systemInstruction: systemPrompt,
      maxOutputTokens: maxTokens,
    },
  });

  return response.text ?? "";
}

async function callOpenAI(
  model: string,
  systemPrompt: string,
  messages: AIMessage[],
  maxTokens: number
): Promise<string> {
  const apiKey = getDecryptedKey("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured in settings");

  const client = new OpenAI({ apiKey });
  const response = await client.chat.completions.create({
    model: model || "gpt-4o",
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: systemPrompt },
      ...messages.map(m => ({ role: m.role, content: m.content })),
    ],
  });

  return response.choices[0]?.message?.content ?? "";
}

async function callDeepSeek(
  model: string,
  systemPrompt: string,
  messages: AIMessage[],
  maxTokens: number
): Promise<string> {
  const apiKey = getDecryptedKey("DEEPSEEK_API_KEY");
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY not configured in settings");

  const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || "deepseek-chat",
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.map(m => ({ role: m.role, content: m.content })),
      ],
    }),
  });

  if (!response.ok) {
    const txt = await response.text();
    throw new Error(`DeepSeek error ${response.status}: ${txt}`);
  }

  const data = await response.json();
  return data.choices[0]?.message?.content ?? "";
}

async function callOllama(
  model: string,
  systemPrompt: string,
  messages: AIMessage[],
  maxTokens: number
): Promise<string> {
  const baseURL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

  const response = await fetch(`${baseURL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: model || "llama3.2",
      stream: false,
      options: { num_predict: maxTokens },
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.map(m => ({ role: m.role, content: m.content })),
      ],
    }),
  });

  if (!response.ok) {
    const txt = await response.text();
    throw new Error(`Ollama error ${response.status}: ${txt}`);
  }

  const data = await response.json();
  return data.message?.content ?? "";
}

// ─── Gemini with tool-calling for the orchestrator agent loop ────────────────

export interface OrchestratorTool {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export async function callGeminiWithTools(
  prompt: string,
  tools: OrchestratorTool[],
  taskId: string
): Promise<{ text: string; functionCalls: Array<{ name: string; args: any }> }> {
  const apiKey = getDecryptedKey("GEMINI_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY not configured in settings");

  const ai = new GoogleGenAI({ apiKey });

  const toolDeclarations = tools.map(t => ({
    name: t.name,
    description: t.description,
    parameters: {
      type: Type.OBJECT,
      properties: t.parameters,
    },
  }));

  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      systemInstruction:
        "You are a production agent orchestrator. Execute tasks using available tools. Break work into sub-tasks. Never output raw secret keys in text — only pass them inside tool call arguments.",
      tools: [{ functionDeclarations: toolDeclarations }] as any,
    },
  });

  const functionCalls: Array<{ name: string; args: any }> = [];
  const calls = response.functionCalls;
  if (calls) {
    for (const call of calls) {
      functionCalls.push({ name: call.name!, args: call.args ?? {} });
    }
  }

  return { text: response.text ?? "", functionCalls };
}
