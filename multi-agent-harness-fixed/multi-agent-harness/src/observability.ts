// src/observability.ts
// Lightweight structured tracing.
// Every agent call is a span with timing, tokens, tool calls, errors.
// Writes append-only JSONL to traces/trace-<date>.jsonl for inspection/replay.

import { appendFile, mkdir } from "fs/promises";
import { join } from "path";

export interface Span {
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  name: string;                  // e.g. "agent.run", "tool.calculator"
  provider?: string;
  model?: string;
  taskId?: string;
  startTime: number;             // unix ms
  endTime?: number;
  durationMs?: number;
  status: "running" | "ok" | "error";
  error?: string;
  attributes: Record<string, unknown>;
}

function randomId(len = 16): string {
  return Math.random().toString(36).slice(2, 2 + len).padEnd(len, "0");
}

export class Tracer {
  private spans: Span[] = [];
  private traceId: string = randomId();
  private logPath: string | null = null;
  private logReady: Promise<void> | null = null;

  async init(logDir = "traces"): Promise<void> {
    const dir = join(process.cwd(), logDir);
    await mkdir(dir, { recursive: true });
    const date = Temporal.Now.plainDateISO().toString();
    this.logPath = join(dir, `trace-${date}.jsonl`);
    this.logReady = Promise.resolve();
  }

  startSpan(name: string, attrs: Partial<Span> = {}): Span {
    const span: Span = {
      spanId: randomId(),
      traceId: this.traceId,
      name,
      startTime: Date.now(),
      status: "running",
      attributes: {},
      ...attrs,
    };
    this.spans.push(span);
    return span;
  }

  endSpan(span: Span, status: "ok" | "error" = "ok", error?: string): void {
    span.endTime = Date.now();
    span.durationMs = span.endTime - span.startTime;
    span.status = status;
    if (error) span.error = error;
    this.flushSpan(span);
  }

  private flushSpan(span: Span): void {
    if (!this.logPath) return;
    const line = JSON.stringify(span) + "\n";
    // Fire-and-forget append; errors logged but not thrown
    appendFile(this.logPath, line, "utf8").catch((e) =>
      console.warn("[tracer] Failed to write span:", e)
    );
  }

  // Wraps an async function in a span automatically
  async trace<T>(
    name: string,
    attrs: Partial<Span>,
    fn: (span: Span) => Promise<T>
  ): Promise<T> {
    const span = this.startSpan(name, attrs);
    try {
      const result = await fn(span);
      this.endSpan(span, "ok");
      return result;
    } catch (err) {
      this.endSpan(span, "error", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  getSpans(): Span[] {
    return [...this.spans];
  }

  printSummary(): void {
    const ok = this.spans.filter((s) => s.status === "ok").length;
    const err = this.spans.filter((s) => s.status === "error").length;
    const running = this.spans.filter((s) => s.status === "running").length;

    console.log("\n[tracer] ─────────────────────────────────────");
    console.log(`  TraceId  : ${this.traceId}`);
    console.log(`  Spans    : ${this.spans.length} total | ${ok} ok | ${err} error | ${running} running`);

    if (this.logPath) {
      console.log(`  Log file : ${this.logPath}`);
    }

    const agentSpans = this.spans.filter((s) => s.name === "agent.run");
    if (agentSpans.length > 0) {
      console.log("  Agent spans:");
      for (const s of agentSpans) {
        const dur = s.durationMs != null ? `${s.durationMs}ms` : "…";
        const icon = s.status === "ok" ? "✓" : s.status === "error" ? "✗" : "⏳";
        console.log(
          `    ${icon} [${s.provider ?? "?"}/${s.model ?? "?"}] task=${s.taskId ?? "?"} ${dur}`
        );
      }
    }
    console.log("[tracer] ─────────────────────────────────────\n");
  }

  reset(): void {
    this.spans = [];
    this.traceId = randomId();
  }
}

// Singleton used across the harness
export const tracer = new Tracer();
