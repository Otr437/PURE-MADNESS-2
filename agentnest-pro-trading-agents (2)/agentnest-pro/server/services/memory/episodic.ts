/**
 * Episodic Memory — durable SQLite log of every agent decision.
 * Satisfies regulatory audit requirements: every thought, action, and
 * observation is persisted with timestamps and agent identity.
 * Written to the existing `logs` table using category = 'episodic'.
 */

import { db, logEntry } from "../../db/index.js";
import { v4 as uuidv4 } from "uuid";

export interface EpisodicEntry {
  id:          string;
  task_id:     string;
  agent_id:    string | null;
  step:        number;
  thought:     string;
  action:      string | null;
  action_input: string | null;   // JSON string
  observation: string | null;
  created_at:  string;
}

/** Persist one ReAct step to the episodic log. */
export function episodicWrite(
  taskId:      string,
  agentId:     string | null,
  step:        number,
  thought:     string,
  action:      string | null,
  actionInput: Record<string, any> | null,
  observation: string | null
): void {
  const id = uuidv4();
  const inputStr = actionInput ? JSON.stringify(actionInput) : null;

  // Persist to dedicated episodic_memory table
  db.prepare(`
    INSERT INTO episodic_memory
      (id, task_id, agent_id, step, thought, action, action_input, observation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, taskId, agentId, step, thought, action, inputStr, observation);

  // Mirror a summary line into the existing logs table for UI visibility
  const summary = action
    ? `[Step ${step}] ${thought.substring(0, 120)} → Action: ${action}`
    : `[Step ${step}] ${thought.substring(0, 120)} → Final answer`;
  logEntry(taskId, agentId, summary, "info", "agent");
}

/** Retrieve the full decision history for a task (ordered by step). */
export function episodicRead(taskId: string): EpisodicEntry[] {
  return db.prepare(
    "SELECT * FROM episodic_memory WHERE task_id = ? ORDER BY step ASC"
  ).all(taskId) as EpisodicEntry[];
}

/** Retrieve the last N decisions made by an agent across all tasks. */
export function episodicReadByAgent(agentId: string, limit = 50): EpisodicEntry[] {
  return db.prepare(
    "SELECT * FROM episodic_memory WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?"
  ).all(agentId, limit) as EpisodicEntry[];
}

/** Ensure the episodic_memory table exists (called once at startup). */
export function episodicMigrate(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodic_memory (
      id           TEXT PRIMARY KEY,
      task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      agent_id     TEXT REFERENCES agents(id) ON DELETE SET NULL,
      step         INTEGER NOT NULL,
      thought      TEXT NOT NULL,
      action       TEXT,
      action_input TEXT,
      observation  TEXT,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_episodic_task  ON episodic_memory(task_id);
    CREATE INDEX IF NOT EXISTS idx_episodic_agent ON episodic_memory(agent_id);
  `);
}
