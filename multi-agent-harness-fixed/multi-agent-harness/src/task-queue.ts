// src/task-queue.ts
// Priority task queue with status tracking.
// Supports: enqueue, dequeue, retry-on-failure, status inspection, drain.
// Tasks persist in memory for the lifetime of the process.
// For cross-process persistence, swap the Map for a Redis/SQLite backend.

import type { AgentConfig, AgentTask } from "./types.js";

export type TaskStatus = "pending" | "running" | "done" | "failed" | "retrying";

export interface QueuedTask {
  id: string;
  task: AgentTask;
  agentConfig: AgentConfig;
  priority: number;        // higher = runs first
  status: TaskStatus;
  attempts: number;
  maxAttempts: number;
  result?: string;
  error?: string;
  enqueuedAt: number;
  startedAt?: number;
  completedAt?: number;
}

export class TaskQueue {
  private tasks = new Map<string, QueuedTask>();
  private pending: string[] = []; // sorted by priority (desc)

  enqueue(
    task: AgentTask,
    agentConfig: AgentConfig,
    options: { priority?: number; maxAttempts?: number } = {}
  ): string {
    const id = `tq-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const queued: QueuedTask = {
      id,
      task,
      agentConfig,
      priority: options.priority ?? 0,
      status: "pending",
      attempts: 0,
      maxAttempts: options.maxAttempts ?? 3,
      enqueuedAt: Date.now(),
    };

    this.tasks.set(id, queued);
    this.insertSorted(id, queued.priority);
    return id;
  }

  private insertSorted(id: string, priority: number): void {
    // Insert maintaining descending priority order
    let i = 0;
    while (i < this.pending.length) {
      const other = this.tasks.get(this.pending[i]);
      if (other && other.priority < priority) break;
      i++;
    }
    this.pending.splice(i, 0, id);
  }

  dequeue(): QueuedTask | null {
    while (this.pending.length > 0) {
      const id = this.pending.shift()!;
      const task = this.tasks.get(id);
      if (task && task.status === "pending") {
        task.status = "running";
        task.startedAt = Date.now();
        task.attempts++;
        return task;
      }
    }
    return null;
  }

  markDone(id: string, result: string): void {
    const t = this.tasks.get(id);
    if (!t) return;
    t.status = "done";
    t.result = result;
    t.completedAt = Date.now();
  }

  markFailed(id: string, error: string): void {
    const t = this.tasks.get(id);
    if (!t) return;

    if (t.attempts < t.maxAttempts) {
      t.status = "retrying";
      t.error = error;
      // Re-enqueue with same priority
      this.insertSorted(id, t.priority);
      t.status = "pending";
      console.warn(
        `  [task-queue] Task ${id} failed (attempt ${t.attempts}/${t.maxAttempts}). Requeueing.`
      );
    } else {
      t.status = "failed";
      t.error = error;
      t.completedAt = Date.now();
      console.error(`  [task-queue] Task ${id} permanently failed after ${t.attempts} attempts.`);
    }
  }

  pendingCount(): number {
    return this.pending.filter((id) => {
      const t = this.tasks.get(id);
      return t?.status === "pending";
    }).length;
  }

  isEmpty(): boolean {
    return this.pendingCount() === 0;
  }

  getAll(): QueuedTask[] {
    return Array.from(this.tasks.values());
  }

  getByStatus(status: TaskStatus): QueuedTask[] {
    return this.getAll().filter((t) => t.status === status);
  }

  printStats(): void {
    const all = this.getAll();
    const byStatus = (s: TaskStatus) => all.filter((t) => t.status === s).length;
    console.log("\n[task-queue] ─────────────────────────────────");
    console.log(`  Total    : ${all.length}`);
    console.log(`  Pending  : ${byStatus("pending")}`);
    console.log(`  Running  : ${byStatus("running")}`);
    console.log(`  Done     : ${byStatus("done")}`);
    console.log(`  Failed   : ${byStatus("failed")}`);
    console.log(`  Retrying : ${byStatus("retrying")}`);
    console.log("[task-queue] ─────────────────────────────────\n");
  }

  // Drains the queue — processes all pending tasks with the given worker function.
  // Respects concurrency limit. Handles retries: failed tasks are re-enqueued
  // and will be picked up in the same drain call.
  async drain(
    worker: (task: QueuedTask) => Promise<{ result?: string; error?: string }>,
    concurrency = 5
  ): Promise<void> {
    const inFlight = new Set<Promise<void>>();

    const startNext = (): void => {
      const task = this.dequeue();
      if (!task) return;

      const job: Promise<void> = (async () => {
        const { result, error } = await worker(task);
        if (error) {
          this.markFailed(task.id, error);
        } else {
          this.markDone(task.id, result ?? "");
        }
      })().finally(() => inFlight.delete(job));

      inFlight.add(job);
    };

    // Fill up to concurrency limit, then wait for one to finish before filling again.
    // Loop continues as long as there is pending work OR jobs still in flight
    // (in-flight jobs may re-enqueue on failure, so we must recheck isEmpty after each race).
    while (!this.isEmpty() || inFlight.size > 0) {
      while (inFlight.size < concurrency && !this.isEmpty()) {
        startNext();
      }
      if (inFlight.size > 0) {
        await Promise.race(inFlight);
      }
    }
  }
}

// Singleton
export const globalQueue = new TaskQueue();
