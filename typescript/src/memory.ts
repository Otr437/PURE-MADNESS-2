/**
 * Conversation Memory — TypeScript
 * File-backed (JSON only, never eval/deserialize) session store with
 * automatic summarization and context-window trimming.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { ModelRouter, TextBlock } from "./model_router";

const DEFAULT_STORE_DIR  = process.env.RAG_SESSION_DIR ?? path.join(process.cwd(), ".rag_sessions");
const MAX_BEFORE_SUMMARY = 40;
const KEEP_RECENT        = 10;

export interface Session {
  sessionId:  string;
  createdAt:  number;
  updatedAt:  number;
  messages:   object[];
  summary:    string;
  metadata:   Record<string, string>;
}

export class MemoryStore {
  private dir: string;

  constructor(storeDir = DEFAULT_STORE_DIR) {
    this.dir = storeDir;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private safePath(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9-]/g, "");
    if (!safe) throw new Error("Invalid sessionId");
    return path.join(this.dir, `${safe}.json`);
  }

  create(metadata: Record<string, string> = {}): Session {
    const now = Date.now() / 1000;
    const session: Session = {
      sessionId: crypto.randomUUID().replace(/-/g, ""),
      createdAt: now,
      updatedAt: now,
      messages:  [],
      summary:   "",
      metadata,
    };
    this.save(session);
    return session;
  }

  load(sessionId: string): Session | null {
    const p = this.safePath(sessionId);
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8")) as Session;
    } catch {
      return null;
    }
  }

  save(session: Session): void {
    session.updatedAt = Date.now() / 1000;
    const p   = this.safePath(session.sessionId);
    const tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(session, null, 2), "utf-8");
    fs.renameSync(tmp, p);
  }

  delete(sessionId: string): boolean {
    const p = this.safePath(sessionId);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    return true;
  }

  listSessions(): string[] {
    return fs.readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  }

  appendUser(sessionId: string, content: string): Session {
    return this._append(sessionId, { role: "user", content });
  }

  appendAssistant(sessionId: string, content: string | object): Session {
    return this._append(sessionId, { role: "assistant", content });
  }

  private _append(sessionId: string, message: object): Session {
    let session = this.load(sessionId);
    if (!session) {
      session = this.create();
      (session as any).sessionId = sessionId;
    }
    session.messages.push(message);
    this.save(session);
    return session;
  }
}

// ── Summarization ─────────────────────────────────────────────────────────────
let _summarizer: ModelRouter | null = null;
function getSummarizer(): ModelRouter {
  if (!_summarizer) _summarizer = new ModelRouter();
  return _summarizer;
}

export async function summarizeMessages(messages: object[], existingSummary = ""): Promise<string> {
  const lines = (messages as any[]).map((m) => {
    const role = m.role ?? "unknown";
    let content = m.content ?? "";
    if (Array.isArray(content)) {
      content = content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");
    }
    return `${role}: ${content}`;
  });

  const transcript = lines.join("\n");
  const prompt = existingSummary
    ? `Prior summary:\n${existingSummary}\n\nNew segment:\n${transcript}\n\nProduce an updated summary (3-6 sentences).`
    : `Conversation:\n${transcript}\n\nSummarize in 3-5 sentences, preserving key facts.`;

  const resp = await getSummarizer().create([{ role: "user", content: prompt }], {
    system:    "You are a precise conversation summarizer.",
    maxTokens: 512,
  });

  for (const b of resp.content) {
    if (b.type === "text") return (b as TextBlock).text.trim();
  }
  return existingSummary;
}

export async function maybeCompact(store: MemoryStore, session: Session): Promise<Session> {
  if (session.messages.length <= MAX_BEFORE_SUMMARY) return session;
  const toSummarize = session.messages.slice(0, -KEEP_RECENT);
  session.summary   = await summarizeMessages(toSummarize, session.summary);
  session.messages  = session.messages.slice(-KEEP_RECENT);
  store.save(session);
  return session;
}

export function buildContextMessages(session: Session, newUserMessage: string): object[] {
  const messages: object[] = [];
  if (session.summary) {
    messages.push({ role: "user",      content: `[Prior summary]: ${session.summary}` });
    messages.push({ role: "assistant", content: "Understood, I have that context." });
  }
  messages.push(...session.messages);
  messages.push({ role: "user", content: newUserMessage });
  return messages;
}
