/**
 * Long-Term Memory — SQLite FTS5-backed knowledge store.
 * Agents write learned facts and patterns here; on subsequent tasks
 * the agent queries this store to retrieve relevant prior knowledge
 * before beginning the ReAct loop, so it genuinely improves over time.
 *
 * Uses SQLite FTS5 for ranked full-text retrieval — no external vector DB
 * required, keeping the stack self-contained.
 */

import { db } from "../../db/index.js";
import { v4 as uuidv4 } from "uuid";

export interface LongTermEntry {
  id:         string;
  agent_id:   string;
  key:        string;   // short label, e.g. "cve-lookup-pattern"
  content:    string;   // the learned fact or pattern
  source:     string;   // task_id that produced this knowledge
  created_at: string;
}

/** Ensure tables exist — called once at startup. */
export function longTermMigrate(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS long_term_memory (
      id         TEXT PRIMARY KEY,
      agent_id   TEXT NOT NULL,
      key        TEXT NOT NULL,
      content    TEXT NOT NULL,
      source     TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_ltm_agent ON long_term_memory(agent_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS long_term_memory_fts
      USING fts5(id UNINDEXED, agent_id UNINDEXED, key, content, content='long_term_memory', content_rowid='rowid');

    CREATE TRIGGER IF NOT EXISTS ltm_ai AFTER INSERT ON long_term_memory BEGIN
      INSERT INTO long_term_memory_fts(rowid, id, agent_id, key, content)
        VALUES (new.rowid, new.id, new.agent_id, new.key, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS ltm_ad AFTER DELETE ON long_term_memory BEGIN
      INSERT INTO long_term_memory_fts(long_term_memory_fts, rowid, id, agent_id, key, content)
        VALUES ('delete', old.rowid, old.id, old.agent_id, old.key, old.content);
    END;
  `);
}

/** Store a new learned fact for an agent. */
export function longTermWrite(
  agentId: string,
  key:     string,
  content: string,
  source:  string   // task_id
): void {
  const id = uuidv4();
  db.prepare(
    "INSERT INTO long_term_memory (id, agent_id, key, content, source) VALUES (?, ?, ?, ?, ?)"
  ).run(id, agentId, key, content, source);
}

/**
 * Retrieve the top-K most relevant memories for an agent given a query.
 * Uses FTS5 BM25 ranking — highest relevance first.
 */
export function longTermQuery(agentId: string, query: string, limit = 5): LongTermEntry[] {
  // FTS5 requires the query to be sanitized — strip special chars that break the parser
  const safeQuery = query.replace(/['"*()]/g, " ").trim();
  if (!safeQuery) return [];

  try {
    return db.prepare(`
      SELECT m.*
      FROM long_term_memory m
      JOIN long_term_memory_fts f ON m.rowid = f.rowid
      WHERE f.agent_id = ? AND long_term_memory_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(agentId, safeQuery, limit) as LongTermEntry[];
  } catch {
    // FTS5 parse error on exotic queries — fall back to LIKE
    return db.prepare(`
      SELECT * FROM long_term_memory
      WHERE agent_id = ? AND content LIKE ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(agentId, `%${safeQuery}%`, limit) as LongTermEntry[];
  }
}

/** Format retrieved memories as a prompt-ready string. */
export function longTermSerialize(memories: LongTermEntry[]): string {
  if (memories.length === 0) return "";
  return memories
    .map(m => `[${m.key}]: ${m.content}`)
    .join("\n");
}

/** Delete all memories for an agent (e.g., agent reset). */
export function longTermClear(agentId: string): void {
  db.prepare("DELETE FROM long_term_memory WHERE agent_id = ?").run(agentId);
}
