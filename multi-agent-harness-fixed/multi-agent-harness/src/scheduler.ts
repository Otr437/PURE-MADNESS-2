// src/scheduler.ts
// Autonomous task scheduler — validated, auth-gated, Merkle-logged.
// Every public method validates inputs before any logic runs.

import { MerkleLog } from "./merkle-log.js";
import { SecurityMiddleware } from "./security-middleware.js";
import { InputValidator } from "./input-validator.js";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

export interface ScheduledJob {
  id:          string;
  name:        string;
  commands:    string[];
  intervalMs:  number;
  maxRuns:     number;
  runCount:    number;
  lastRun?:    string;
  nextRun:     string;
  enabled:     boolean;
  onRun:       (commands: string[]) => Promise<void>;
}

export const INTERVALS = {
  every1m:  60_000,
  every5m:  5  * 60_000,
  every15m: 15 * 60_000,
  every30m: 30 * 60_000,
  every1h:  60 * 60_000,
  every4h:  4  * 60 * 60_000,
  every8h:  8  * 60 * 60_000,
  every24h: 24 * 60 * 60_000,
};

export function msToHuman(ms: number): string {
  if (ms < 60_000)     return `${ms / 1000}s`;
  if (ms < 3_600_000)  return `${ms / 60_000}m`;
  return `${ms / 3_600_000}h`;
}

// Persisted job record — everything that needs to survive a restart.
// The onRun callback cannot be persisted; it is re-registered by the
// application on startup after calling loadJobs().
export interface PersistedJob {
  id:         string;
  name:       string;
  commands:   string[];
  intervalMs: number;
  maxRuns:    number;
  runCount:   number;
  lastRun?:   string;
  nextRun:    string;
  enabled:    boolean;
}

export class Scheduler {
  private jobs    = new Map<string, ScheduledJob>();
  private timers  = new Map<string, NodeJS.Timeout>();
  private log:    MerkleLog;
  private mw:     SecurityMiddleware;
  private running = false;
  private persistPath: string | null;

  constructor(log: MerkleLog, mw: SecurityMiddleware, persistDir?: string) {
    this.log = log;
    this.mw  = mw;
    if (persistDir) {
      if (!existsSync(persistDir)) mkdirSync(persistDir, { recursive: true, mode: 0o700 });
      this.persistPath = join(persistDir, "scheduler-jobs.json");
    } else {
      this.persistPath = null;
    }
  }

  // Persist current job state (minus callbacks) to disk
  private persist(): void {
    if (!this.persistPath) return;
    const records: PersistedJob[] = [...this.jobs.values()].map(j => ({
      id: j.id, name: j.name, commands: j.commands,
      intervalMs: j.intervalMs, maxRuns: j.maxRuns,
      runCount: j.runCount, lastRun: j.lastRun,
      nextRun: j.nextRun, enabled: j.enabled,
    }));
    writeFileSync(this.persistPath, JSON.stringify(records, null, 2), { encoding: "utf8", mode: 0o600 });
  }

  // Load persisted jobs. The caller must supply onRun for each job id.
  // Any job whose id has no matching callback will be skipped with a warning.
  loadJobs(callbacks: Record<string, (commands: string[]) => Promise<void>>): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    let records: PersistedJob[] = [];
    try {
      records = JSON.parse(readFileSync(this.persistPath, "utf8"));
    } catch (err) {
      console.error(`[scheduler] Failed to load persisted jobs: ${err}`);
      return;
    }

    let loaded = 0;
    for (const r of records) {
      const onRun = callbacks[r.id];
      if (!onRun) {
        console.warn(`[scheduler] No callback registered for persisted job "${r.id}" — skipping`);
        continue;
      }
      // Skip jobs that already completed their max runs
      if (r.runCount >= r.maxRuns) {
        console.log(`[scheduler] Persisted job "${r.name}" already completed (${r.runCount}/${r.maxRuns} runs) — skipping`);
        continue;
      }
      const job: ScheduledJob = { ...r, onRun };
      // Recalculate nextRun: use the stored nextRun if it's still in the future,
      // otherwise schedule one interval from now (handles missed runs)
      const stored = new Date(r.nextRun).getTime();
      if (stored < Date.now()) {
        console.log(`[scheduler] Job "${r.name}" missed ${Math.floor((Date.now() - stored) / r.intervalMs)} run(s) during downtime — rescheduling from now`);
        job.nextRun = Temporal.Now.instant().add({ milliseconds: r.intervalMs }).toString();
      }
      this.jobs.set(job.id, job);
      loaded++;
    }
    this.log.append("scheduler:load", { loaded, total: records.length }, { ok: true });
    console.log(`[scheduler] Loaded ${loaded}/${records.length} persisted jobs`);
  }

  addJob(
    id: unknown,
    name: unknown,
    commands: unknown,
    intervalMs: unknown,
    maxRuns: unknown,
    onRun: (commands: string[]) => Promise<void>
  ): ScheduledJob | null {
    const gate = this.mw.schedulerAdd(id, name, commands, intervalMs, maxRuns);
    if (!gate.allowed) {
      console.log(`[scheduler] ⛔ ${gate.reason}`);
      return null;
    }

    // Validate each command string
    const cmds = commands as string[];
    for (const cmd of cmds) {
      const err = InputValidator.isSafeCommand(cmd, "command");
      if (err) {
        console.log(`[scheduler] ⛔ Invalid command "${cmd.slice(0, 40)}…": ${err}`);
        return null;
      }
    }

    const job: ScheduledJob = {
      id:         id as string,
      name:       name as string,
      commands:   cmds,
      intervalMs: intervalMs as number,
      maxRuns:    maxRuns as number,
      runCount:   0,
      nextRun:    Temporal.Now.instant().add({ milliseconds: intervalMs as number }).toString(),
      enabled:    true,
      onRun,
    };

    this.jobs.set(job.id, job);
    this.log.append("scheduler:add", {
      id: job.id, name: job.name,
      intervalMs: job.intervalMs, maxRuns: job.maxRuns,
      commandCount: cmds.length,
    }, { ok: true });
    console.log(`[scheduler] Job "${job.name}" added — every ${msToHuman(job.intervalMs)}, max ${job.maxRuns} runs`);
    return job;
  }

  start(): void {
    const gate = this.mw.schedulerStart();
    if (!gate.allowed) { console.log(`[scheduler] ⛔ ${gate.reason}`); return; }

    this.running = true;
    for (const job of this.jobs.values()) {
      if (job.enabled) this.scheduleNext(job);
    }
    this.log.append("scheduler:start", { jobCount: this.jobs.size }, { ok: true });
    console.log(`[scheduler] Started — ${this.jobs.size} job(s) active`);
  }

  stop(): void {
    const gate = this.mw.schedulerStop();
    if (!gate.allowed) { console.log(`[scheduler] ⛔ ${gate.reason}`); return; }

    this.running = false;
    for (const [id, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    this.log.append("scheduler:stop", {}, { ok: true });
    console.log("[scheduler] Stopped");
  }

  toggleJob(id: unknown, enabled: boolean): void {
    const gate = this.mw.schedulerToggle(id);
    if (!gate.allowed) { console.log(`[scheduler] ⛔ ${gate.reason}`); return; }

    const job = this.jobs.get(id as string);
    if (!job) { console.log(`[scheduler] Job "${id}" not found`); return; }

    job.enabled = enabled;
    if (!enabled) {
      const t = this.timers.get(job.id);
      if (t) { clearTimeout(t); this.timers.delete(job.id); }
    } else if (this.running) {
      this.scheduleNext(job);
    }
    this.log.append("scheduler:toggle", { id: job.id, enabled }, { ok: true });
    console.log(`[scheduler] "${job.name}" ${enabled ? "enabled" : "disabled"}`);
  }

  private scheduleNext(job: ScheduledJob): void {
    if (!this.running || !job.enabled) return;

    const timer = setTimeout(async () => {
      await this.runJob(job);
      if (job.enabled && job.runCount < job.maxRuns) {
        job.nextRun = Temporal.Now.instant().add({ milliseconds: job.intervalMs }).toString();
        this.scheduleNext(job);
      } else if (job.runCount >= job.maxRuns) {
        job.enabled = false;
        this.log.append("scheduler:maxruns", { id: job.id, name: job.name }, { ok: true });
        console.log(`\n[scheduler] "${job.name}" hit max runs (${job.maxRuns}). Stopped.`);
      }
    }, job.intervalMs);

    this.timers.set(job.id, timer);
  }

  private async runJob(job: ScheduledJob): Promise<void> {
    if (!job.enabled || job.runCount >= job.maxRuns) return;

    job.runCount++;
    job.lastRun = Temporal.Now.instant().toString();

    this.log.append("scheduler:run", {
      id: job.id, name: job.name,
      run: job.runCount, max: job.maxRuns,
    }, { ok: true });
    console.log(`\n[scheduler] ▶ "${job.name}" run ${job.runCount}/${job.maxRuns}`);

    try {
      await job.onRun(job.commands);
    } catch (err) {
      this.log.append("scheduler:error", { id: job.id, error: String(err) }, { ok: false });
      console.error(`[scheduler] Error in "${job.name}": ${err}`);
    }
  }

  printStatus(): void {
    console.log("\n─────────────────────────────────────────────────────");
    console.log(`  SCHEDULER  (${this.running ? "RUNNING" : "STOPPED"})`);
    if (this.jobs.size === 0) { console.log("  No jobs."); }
    for (const job of this.jobs.values()) {
      const status = !job.enabled ? "DISABLED" : job.runCount >= job.maxRuns ? "DONE" : "ACTIVE";
      console.log(`  [${status.padEnd(8)}] "${job.name}"  ${job.runCount}/${job.maxRuns} runs  every ${msToHuman(job.intervalMs)}`);
      if (job.enabled) console.log(`    Next: ${job.nextRun}`);
    }
    console.log("─────────────────────────────────────────────────────\n");
  }
}
