/**
 * RBAC Token Engine + Monitor — TypeScript
 * Plugs directly into react_loop.ts and run_agent.ts
 *
 * Usage:
 *   import { TokenEngine, DEFAULT_CONFIG, runReactRBAC } from "./token_engine";
 *   const engine = new TokenEngine(DEFAULT_CONFIG);
 *   const { answer, session } = await runReactRBAC({ task, role: "operator", engine });
 *   engine.printMonitor();
 */

import * as fs from "fs";
import { randomUUID } from "crypto";
import { runReact, Step } from "./react_loop";

// ── Role definition ───────────────────────────────────────────────────────────
export interface Role {
  maxTokens:   number;   // total token budget per session
  maxIter:     number;   // max agent iterations
  alertPct:    number;   // alert threshold (0–1)
  costPer1k:   number;   // USD per 1k tokens
}

// ── RBAC config ───────────────────────────────────────────────────────────────
export interface RBACConfig {
  roles: Record<string, Role>;
}

export const DEFAULT_CONFIG: RBACConfig = {
  roles: {
    admin:    { maxTokens: 200_000, maxIter: 50, alertPct: 0.80, costPer1k: 0.015 },
    operator: { maxTokens:  50_000, maxIter: 30, alertPct: 0.75, costPer1k: 0.015 },
    user:     { maxTokens:  10_000, maxIter: 15, alertPct: 0.70, costPer1k: 0.015 },
    readonly: { maxTokens:   2_000, maxIter:  5, alertPct: 0.60, costPer1k: 0.015 },
  },
};

// ── Session ───────────────────────────────────────────────────────────────────
export class Session {
  readonly id:        string;
  readonly role:      string;
  readonly task:      string;
  readonly budget:    Role;
  readonly startedAt: Date;
  endedAt?:           Date;
  inputTokens:        number = 0;
  outputTokens:       number = 0;
  iterations:         number = 0;
  answer:             string = "";
  alerts:             string[] = [];
  aborted:            boolean = false;
  abortReason:        string = "";

  constructor(id: string, role: string, task: string, budget: Role) {
    this.id        = id;
    this.role      = role;
    this.task      = task;
    this.budget    = budget;
    this.startedAt = new Date();
  }

  get totalTokens()      { return this.inputTokens + this.outputTokens; }
  get budgetUsedPct()    { return this.budget.maxTokens ? this.totalTokens / this.budget.maxTokens : 0; }
  get estimatedCostUsd() { return (this.totalTokens / 1000) * this.budget.costPer1k; }
  get elapsedMs()        { return ((this.endedAt ?? new Date()).getTime() - this.startedAt.getTime()); }

  toJSON() {
    return {
      id:               this.id,
      role:             this.role,
      task:             this.task.slice(0, 200),
      startedAt:        this.startedAt.toISOString(),
      endedAt:          this.endedAt?.toISOString() ?? null,
      elapsedMs:        this.elapsedMs,
      inputTokens:      this.inputTokens,
      outputTokens:     this.outputTokens,
      totalTokens:      this.totalTokens,
      budgetTokens:     this.budget.maxTokens,
      budgetUsedPct:    parseFloat((this.budgetUsedPct * 100).toFixed(1)),
      estimatedCostUsd: parseFloat(this.estimatedCostUsd.toFixed(6)),
      iterations:       this.iterations,
      maxIter:          this.budget.maxIter,
      alerts:           this.alerts,
      aborted:          this.aborted,
      abortReason:      this.abortReason,
      answerPreview:    this.answer.slice(0, 200),
    };
  }
}

// ── Errors ────────────────────────────────────────────────────────────────────
export class BudgetExceededError extends Error {
  constructor(message: string) { super(message); this.name = "BudgetExceededError"; }
}
export class UnknownRoleError extends Error {
  constructor(role: string, valid: string[]) {
    super(`Unknown role: '${role}'. Valid roles: ${valid}`);
    this.name = "UnknownRoleError";
  }
}

// ── Token Engine ──────────────────────────────────────────────────────────────
export class TokenEngine {
  private sessions = new Map<string, Session>();
  private auditPath: string;
  private onAlert?: (session: Session, msg: string) => void;
  private onAbort?: (session: Session, reason: string) => void;

  constructor(
    private config: RBACConfig,
    options: {
      auditPath?: string;
      onAlert?:   (session: Session, msg: string) => void;
      onAbort?:   (session: Session, reason: string) => void;
    } = {}
  ) {
    this.auditPath = options.auditPath ?? process.env.AGENT_AUDIT_LOG ?? "/tmp/agent_audit.jsonl";
    this.onAlert   = options.onAlert;
    this.onAbort   = options.onAbort;
  }

  // ── Session lifecycle ───────────────────────────────────────────────────────

  startSession(role: string, task: string): Session {
    const budget = this.config.roles[role];
    if (!budget) throw new UnknownRoleError(role, Object.keys(this.config.roles));
    const session = new Session(randomUUID(), role, task, budget);
    this.sessions.set(session.id, session);
    this.audit("session_start", session);
    return session;
  }

  recordUsage(sessionId: string, inputTokens: number, outputTokens: number, iteration?: number): void {
    const session = this.get(sessionId);
    session.inputTokens  += inputTokens;
    session.outputTokens += outputTokens;
    if (iteration !== undefined) session.iterations = iteration;
    this.audit("usage", session, { deltaInput: inputTokens, deltaOutput: outputTokens });
    this.checkBudget(session);
  }

  endSession(sessionId: string, answer = ""): Session {
    const session = this.get(sessionId);
    session.endedAt = new Date();
    session.answer  = answer;
    this.audit("session_end", session);
    return session;
  }

  abortSession(sessionId: string, reason: string): never {
    const session = this.get(sessionId);
    session.aborted     = true;
    session.abortReason = reason;
    session.endedAt     = new Date();
    this.audit("session_abort", session, { reason });
    this.onAbort?.(session, reason);
    throw new BudgetExceededError(reason);
  }

  // ── Budget enforcement ──────────────────────────────────────────────────────

  checkIteration(sessionId: string, iteration: number): void {
    const session = this.get(sessionId);
    if (iteration > session.budget.maxIter) {
      this.abortSession(sessionId,
        `Role '${session.role}' iteration limit reached: ${session.budget.maxIter} max, attempted #${iteration}`);
    }
  }

  private checkBudget(session: Session): void {
    const pct = session.budgetUsedPct;

    if (pct >= session.budget.alertPct && !session.alerts.some(a => a.includes("ALERT"))) {
      const msg = `[ALERT] Role '${session.role}' session ${session.id.slice(0, 8)} ` +
        `at ${(pct * 100).toFixed(1)}% of token budget (${session.totalTokens}/${session.budget.maxTokens})`;
      session.alerts.push(msg);
      this.emitAlert(session, msg);
    }

    if (session.totalTokens >= session.budget.maxTokens) {
      this.abortSession(session.id,
        `Role '${session.role}' token budget exhausted: ${session.totalTokens}/${session.budget.maxTokens}`);
    }
  }

  private emitAlert(session: Session, message: string): void {
    process.stdout.write(`\n\x1b[93m⚠  TOKEN ALERT\x1b[0m  ${message}\n`);
    this.audit("alert", session, { message });
    this.onAlert?.(session, message);
  }

  // ── Monitor ─────────────────────────────────────────────────────────────────

  printMonitor(activeOnly = false): void {
    let sessions = [...this.sessions.values()];
    if (activeOnly) sessions = sessions.filter(s => !s.endedAt);
    sessions.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

    const sep = "─".repeat(112);
    console.log(`\n${"TOKEN MONITOR".padStart(56 + 7)}`);
    console.log(sep);
    console.log(
      "SESSION".padEnd(10) + " " + "ROLE".padEnd(12) + " " +
      "TOKENS".padEnd(12) + " " + "BUDGET".padEnd(10) + " " +
      "USED%".padEnd(18) + " " + "ITER".padEnd(8) + " " +
      "COST$".padEnd(10) + " " + "ELAPSED".padEnd(10) + " STATUS"
    );
    console.log(sep);

    for (const s of sessions) {
      const status = s.aborted ? "ABORTED" : (s.endedAt ? "DONE" : "RUNNING");
      const color  = s.aborted ? "\x1b[91m" : (s.endedAt ? "\x1b[92m" : "\x1b[93m");
      const filled = Math.round(s.budgetUsedPct * 10);
      const bar    = "█".repeat(filled) + "░".repeat(10 - filled);
      console.log(
        s.id.slice(0, 8).padEnd(10) + " " +
        s.role.padEnd(12) + " " +
        s.totalTokens.toLocaleString().padEnd(12) + " " +
        s.budget.maxTokens.toLocaleString().padEnd(10) + " " +
        `${bar} ${(s.budgetUsedPct * 100).toFixed(1)}%`.padEnd(18) + " " +
        `${s.iterations}/${s.budget.maxIter}`.padEnd(8) + " " +
        `$${s.estimatedCostUsd.toFixed(4)}`.padEnd(10) + " " +
        `${(s.elapsedMs / 1000).toFixed(1)}s`.padEnd(10) + " " +
        `${color}${status}\x1b[0m`
      );
    }

    console.log(sep);
    const totalTokens = sessions.reduce((s, r) => s + r.totalTokens, 0);
    const totalCost   = sessions.reduce((s, r) => s + r.estimatedCostUsd, 0);
    console.log(`  Sessions: ${sessions.length}  |  Tokens: ${totalTokens.toLocaleString()}  |  Cost: $${totalCost.toFixed(4)}`);
    console.log(sep + "\n");
  }

  getReport()               { return [...this.sessions.values()].map(s => s.toJSON()); }
  writeReport(path: string) { fs.writeFileSync(path, JSON.stringify(this.getReport(), null, 2)); }

  // ── Audit ───────────────────────────────────────────────────────────────────

  private audit(event: string, session: Session, extra: Record<string, unknown> = {}): void {
    const record = {
      ts:        new Date().toISOString(),
      event,
      sessionId: session.id,
      role:      session.role,
      tokens:    session.totalTokens,
      budget:    session.budget.maxTokens,
      pct:       parseFloat((session.budgetUsedPct * 100).toFixed(1)),
      costUsd:   parseFloat(session.estimatedCostUsd.toFixed(6)),
      ...extra,
    };
    fs.appendFileSync(this.auditPath, JSON.stringify(record) + "\n");
  }

  private get(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`Unknown session: ${id}`);
    return s;
  }
}

// ── Wired run_react with RBAC ─────────────────────────────────────────────────
export async function runReactRBAC(opts: {
  task:         string;
  role:         string;
  engine:       TokenEngine;
  systemExtra?: string;
  onStep?:      (step: Step) => void;
}): Promise<{ answer: string; session: Session }> {
  const { task, role, engine, systemExtra = "", onStep } = opts;

  const session = engine.startSession(role, task);
  process.stdout.write(
    `\n[token] Session ${session.id.slice(0, 8)} | Role: ${role} | Budget: ${session.budget.maxTokens.toLocaleString()} tokens\n\n`
  );

  let iterCount = 0;

  const wrappedStep = (step: Step) => {
    if (step.type === "action") {
      iterCount++;
      engine.checkIteration(session.id, iterCount);
    }
    onStep?.(step);
  };

  try {
    const { answer, trace } = await runReact(task, {
      systemExtra,
      maxIterations: session.budget.maxIter,
      onStep: wrappedStep,
    });

    engine.recordUsage(
      session.id,
      Math.floor(trace.totalTokens / 2),
      trace.totalTokens - Math.floor(trace.totalTokens / 2),
      trace.iterations,
    );
    engine.endSession(session.id, answer);
    return { answer, session };

  } catch (e) {
    if (e instanceof BudgetExceededError) throw e;
    engine.abortSession(session.id, (e as Error).message);
  }
}

// ── CLI demo ──────────────────────────────────────────────────────────────────
if (require.main === module) {
  const role = process.argv[2] ?? "user";
  const task = process.argv.slice(3).join(" ") || "Calculate the 10th Fibonacci number using code.";

  const engine = new TokenEngine(DEFAULT_CONFIG);

  runReactRBAC({ task, role, engine }).then(({ answer }) => {
    console.log(`\nAnswer: ${answer}`);
  }).catch(e => {
    console.error(`\n[${e.name}] ${e.message}`);
  }).finally(() => {
    engine.printMonitor();
    engine.writeReport("/tmp/token_report.json");
    console.log("Audit → /tmp/agent_audit.jsonl\nReport → /tmp/token_report.json");
  });
}
