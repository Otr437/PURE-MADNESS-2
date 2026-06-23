import Database from "better-sqlite3";
import path from "path";
import bcrypt from "bcryptjs";
import { v4 as uuidv4 } from "uuid";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "../../agentnest.db");

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("synchronous = NORMAL");

// ─── SCHEMA ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user',
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login    DATETIME
  );

  CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    is_secret   INTEGER NOT NULL DEFAULT 0,
    description TEXT,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS teams (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT,
    workflow_mode   TEXT NOT NULL DEFAULT 'sequential',
    leader_agent_id TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS agents (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    model         TEXT NOT NULL,
    provider      TEXT NOT NULL DEFAULT 'anthropic',
    agent_type    TEXT NOT NULL DEFAULT 'general-assistant',
    system_prompt TEXT,
    capabilities  TEXT NOT NULL DEFAULT '[]',
    environment   TEXT NOT NULL DEFAULT 'office-desk',
    status        TEXT NOT NULL DEFAULT 'idle',
    color         TEXT NOT NULL DEFAULT '#10B981',
    team_id       TEXT REFERENCES teams(id) ON DELETE SET NULL,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS workflows (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    nodes       TEXT NOT NULL DEFAULT '[]',
    connections TEXT NOT NULL DEFAULT '[]',
    variables   TEXT NOT NULL DEFAULT '{}',
    status      TEXT NOT NULL DEFAULT 'draft',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id                TEXT PRIMARY KEY,
    agent_id          TEXT REFERENCES agents(id) ON DELETE SET NULL,
    workflow_id       TEXT REFERENCES workflows(id) ON DELETE SET NULL,
    description       TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending',
    result            TEXT,
    requires_approval INTEGER NOT NULL DEFAULT 0,
    task_type         TEXT NOT NULL DEFAULT 'direct',
    priority          INTEGER NOT NULL DEFAULT 1,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    started_at        DATETIME,
    completed_at      DATETIME
  );

  CREATE TABLE IF NOT EXISTS sub_tasks (
    id          TEXT PRIMARY KEY,
    task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    result      TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS logs (
    id         TEXT PRIMARY KEY,
    task_id    TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    agent_id   TEXT REFERENCES agents(id) ON DELETE SET NULL,
    message    TEXT NOT NULL,
    type       TEXT NOT NULL DEFAULT 'info',
    category   TEXT NOT NULL DEFAULT 'system',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS financial_accounts (
    id            TEXT PRIMARY KEY,
    type          TEXT NOT NULL,
    name          TEXT NOT NULL,
    address_or_id TEXT NOT NULL,
    spend_key     TEXT,
    view_key      TEXT,
    balance       TEXT NOT NULL DEFAULT '0.00',
    currency      TEXT NOT NULL DEFAULT 'USD',
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    agent_id   TEXT REFERENCES agents(id) ON DELETE SET NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

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

  CREATE TABLE IF NOT EXISTS long_term_memory (
    id         TEXT PRIMARY KEY,
    agent_id   TEXT NOT NULL,
    key        TEXT NOT NULL,
    content    TEXT NOT NULL,
    source     TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_status    ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_agent     ON tasks(agent_id);
  CREATE INDEX IF NOT EXISTS idx_logs_task       ON logs(task_id);
  CREATE INDEX IF NOT EXISTS idx_logs_created    ON logs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_chat_session    ON chat_messages(session_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_agents_team     ON agents(team_id);
  CREATE INDEX IF NOT EXISTS idx_agents_status   ON agents(status);
  CREATE INDEX IF NOT EXISTS idx_episodic_task   ON episodic_memory(task_id);
  CREATE INDEX IF NOT EXISTS idx_episodic_agent  ON episodic_memory(agent_id);
  CREATE INDEX IF NOT EXISTS idx_ltm_agent       ON long_term_memory(agent_id);
`);

// ─── LONG-TERM MEMORY FTS5 — set up after main schema ────────────────────────
// FTS5 virtual tables and their triggers must be created separately from the
// main schema block because they reference the base table by name.
try {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS long_term_memory_fts
      USING fts5(id UNINDEXED, agent_id UNINDEXED, key, content,
                 content='long_term_memory', content_rowid='rowid');

    CREATE TRIGGER IF NOT EXISTS ltm_ai AFTER INSERT ON long_term_memory BEGIN
      INSERT INTO long_term_memory_fts(rowid, id, agent_id, key, content)
        VALUES (new.rowid, new.id, new.agent_id, new.key, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS ltm_ad AFTER DELETE ON long_term_memory BEGIN
      INSERT INTO long_term_memory_fts(long_term_memory_fts, rowid, id, agent_id, key, content)
        VALUES ('delete', old.rowid, old.id, old.agent_id, old.key, old.content);
    END;
  `);
} catch (ftsErr: any) {
  // FTS5 may not be available in all SQLite builds — log and continue without it
  console.warn("[DB] FTS5 not available — long-term memory will use LIKE fallback:", ftsErr.message);
}

// ─── SEED ─────────────────────────────────────────────────────────────────────

const adminExists = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
if (!adminExists) {
  const hash = bcrypt.hashSync("admin123", 12);
  db.prepare(
    "INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)"
  ).run(uuidv4(), "admin", hash, "admin");
  console.log("[DB] Admin user created. Username: admin | Password: admin123 — CHANGE THIS NOW");
}

const defaultSettings = [
  { key: "SYSTEM_NAME",          value: "AgentNest Pro",  is_secret: 0, description: "Platform display name" },
  { key: "MAX_CONCURRENT_TASKS", value: "5",              is_secret: 0, description: "Max parallel tasks" },
  { key: "AGENT_LOOP_MS",        value: "5000",           is_secret: 0, description: "Agent polling interval ms" },
  { key: "LOG_RETENTION_DAYS",   value: "30",             is_secret: 0, description: "Days to retain logs" },
  { key: "GEMINI_API_KEY",       value: "",               is_secret: 1, description: "Google Gemini API key" },
  { key: "ANTHROPIC_API_KEY",    value: "",               is_secret: 1, description: "Anthropic Claude API key" },
  { key: "OPENAI_API_KEY",       value: "",               is_secret: 1, description: "OpenAI API key" },
  { key: "DEEPSEEK_API_KEY",     value: "",               is_secret: 1, description: "DeepSeek API key" },
  // ── Splunk ──────────────────────────────────────────────────────────────────
  { key: "SPLUNK_BASE_URL",      value: "",               is_secret: 0, description: "Splunk REST API base URL e.g. https://splunk.yourcompany.com:8089" },
  { key: "SPLUNK_TOKEN",         value: "",               is_secret: 1, description: "Splunk auth token (preferred over username/password)" },
  { key: "SPLUNK_USERNAME",      value: "",               is_secret: 0, description: "Splunk username (fallback if no token)" },
  { key: "SPLUNK_PASSWORD",      value: "",               is_secret: 1, description: "Splunk password (fallback if no token)" },
  // ── Email / SMTP ─────────────────────────────────────────────────────────────
  { key: "SMTP_HOST",            value: "",               is_secret: 0, description: "SMTP server hostname e.g. smtp.gmail.com" },
  { key: "SMTP_PORT",            value: "587",            is_secret: 0, description: "SMTP port (587 for STARTTLS, 465 for SSL)" },
  { key: "SMTP_SECURE",          value: "false",          is_secret: 0, description: "true = SSL on connect (port 465), false = STARTTLS (port 587)" },
  { key: "SMTP_USER",            value: "",               is_secret: 0, description: "SMTP login username / sending address" },
  { key: "SMTP_PASSWORD",        value: "",               is_secret: 1, description: "SMTP login password or app password" },
  { key: "EMAIL_FROM",           value: "",               is_secret: 0, description: "From address for outbound emails e.g. AgentNest SOC <soc@yourcompany.com>" },
  // ── Trading strategy bots (STRATS) ──────────────────────────────────────────
  { key: "STRATEGY_SCRIPTS_ROOT", value: "",              is_secret: 0, description: "Absolute path to the STRATS folder on this machine (parent of cross-exchange-arb/, grid/, dca/, etc.)" },
  { key: "LIVE_TRADING_ENABLED",  value: "false",         is_secret: 0, description: "Master kill switch. Must be exactly 'true' for ANY agent to place live orders, even if that agent has the liveTrading capability granted." },
];

const insertSetting = db.prepare(
  "INSERT OR IGNORE INTO settings (key, value, is_secret, description) VALUES (?, ?, ?, ?)"
);
for (const s of defaultSettings) {
  insertSetting.run(s.key, s.value, s.is_secret, s.description);
}

// ─── QUERY HELPERS ───────────────────────────────────────────────────────────

export const queries = {
  // Users
  getUserByUsername: db.prepare("SELECT * FROM users WHERE username = ?"),
  getUserById:       db.prepare("SELECT * FROM users WHERE id = ?"),
  updateLastLogin:   db.prepare("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?"),

  // Settings
  getAllSettings:    db.prepare("SELECT * FROM settings ORDER BY key"),
  getSetting:        db.prepare("SELECT * FROM settings WHERE key = ?"),
  upsertSetting:     db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, is_secret, description, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)"
  ),

  // Agents
  getAllAgents:       db.prepare("SELECT * FROM agents ORDER BY created_at DESC"),
  getAgentById:      db.prepare("SELECT * FROM agents WHERE id = ?"),
  getAgentsByTeam:   db.prepare("SELECT * FROM agents WHERE team_id = ?"),
  insertAgent:       db.prepare(
    "INSERT INTO agents (id, name, model, provider, agent_type, system_prompt, capabilities, environment, status, color, team_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ),
  updateAgentStatus: db.prepare("UPDATE agents SET status = ? WHERE id = ?"),
  deleteAgent:       db.prepare("DELETE FROM agents WHERE id = ?"),

  // Teams
  getAllTeams:        db.prepare("SELECT * FROM teams ORDER BY created_at DESC"),
  getTeamById:       db.prepare("SELECT * FROM teams WHERE id = ?"),
  insertTeam:        db.prepare(
    "INSERT INTO teams (id, name, description, workflow_mode, leader_agent_id) VALUES (?, ?, ?, ?, ?)"
  ),
  deleteTeam:        db.prepare("DELETE FROM teams WHERE id = ?"),

  // Workflows
  getAllWorkflows:    db.prepare("SELECT id, name, description, status, created_at, updated_at FROM workflows ORDER BY updated_at DESC"),
  getWorkflowById:   db.prepare("SELECT * FROM workflows WHERE id = ?"),
  insertWorkflow:    db.prepare(
    "INSERT INTO workflows (id, name, description, nodes, connections, variables, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ),
  updateWorkflow:    db.prepare(
    "UPDATE workflows SET name = ?, description = ?, nodes = ?, connections = ?, variables = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ),
  deleteWorkflow:    db.prepare("DELETE FROM workflows WHERE id = ?"),

  // Tasks
  getPendingTasks:   db.prepare(
    "SELECT * FROM tasks WHERE (status = 'approved' OR (status = 'pending' AND requires_approval = 0)) AND status != 'awaiting-human' ORDER BY priority DESC, created_at ASC LIMIT ?"
  ),
  getRecentTasks:    db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100"),
  getTaskById:       db.prepare("SELECT * FROM tasks WHERE id = ?"),
  insertTask:        db.prepare(
    "INSERT INTO tasks (id, agent_id, workflow_id, description, status, requires_approval, task_type, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ),
  updateTaskStatus:  db.prepare(
    "UPDATE tasks SET status = ?, result = ?, started_at = CASE WHEN ? = 'running' THEN CURRENT_TIMESTAMP ELSE started_at END, completed_at = CASE WHEN ? IN ('completed','failed') THEN CURRENT_TIMESTAMP ELSE completed_at END WHERE id = ?"
  ),
  approveTask:       db.prepare("UPDATE tasks SET status = 'approved' WHERE id = ? AND status = 'pending'"),

  // Sub-tasks
  getSubTasksByTask: db.prepare("SELECT * FROM sub_tasks WHERE task_id = ? ORDER BY created_at"),
  insertSubTask:     db.prepare(
    "INSERT INTO sub_tasks (id, task_id, description, status) VALUES (?, ?, ?, ?)"
  ),
  updateSubTask:     db.prepare("UPDATE sub_tasks SET status = ?, result = ? WHERE id = ?"),

  // Logs
  getRecentLogs:     db.prepare("SELECT * FROM logs ORDER BY created_at DESC LIMIT 200"),
  getLogsByTask:     db.prepare("SELECT * FROM logs WHERE task_id = ? ORDER BY created_at ASC"),
  insertLog:         db.prepare(
    "INSERT INTO logs (id, task_id, agent_id, message, type, category) VALUES (?, ?, ?, ?, ?, ?)"
  ),
  pruneOldLogs:      db.prepare(
    "DELETE FROM logs WHERE created_at < datetime('now', '-' || ? || ' days')"
  ),

  // Financial accounts
  getAllAccounts:     db.prepare("SELECT * FROM financial_accounts ORDER BY created_at DESC"),
  insertAccount:     db.prepare(
    "INSERT INTO financial_accounts (id, type, name, address_or_id, spend_key, view_key, balance, currency) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ),
  deleteAccount:     db.prepare("DELETE FROM financial_accounts WHERE id = ?"),

  // Chat
  getChatHistory:    db.prepare(
    "SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT 100"
  ),
  insertChatMessage: db.prepare(
    "INSERT INTO chat_messages (id, session_id, role, content, agent_id) VALUES (?, ?, ?, ?, ?)"
  ),
  clearChatSession:  db.prepare("DELETE FROM chat_messages WHERE session_id = ?"),

  // Episodic memory
  getEpisodicByTask:  db.prepare("SELECT * FROM episodic_memory WHERE task_id = ? ORDER BY step ASC"),
  getEpisodicByAgent: db.prepare("SELECT * FROM episodic_memory WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?"),

  // Long-term memory
  getLongTermByAgent: db.prepare("SELECT * FROM long_term_memory WHERE agent_id = ? ORDER BY created_at DESC LIMIT 100"),
  insertLongTerm:     db.prepare(
    "INSERT INTO long_term_memory (id, agent_id, key, content, source) VALUES (?, ?, ?, ?, ?)"
  ),
  deleteLongTermByAgent: db.prepare("DELETE FROM long_term_memory WHERE agent_id = ?"),

  // Human-in-the-loop checkpoints
  getPendingCheckpoints: db.prepare(
    "SELECT t.* FROM tasks t WHERE t.status = 'awaiting-human' ORDER BY t.created_at ASC"
  ),
  resumeCheckpoint: db.prepare(
    "UPDATE tasks SET status = 'approved', result = ? WHERE id = ? AND status = 'awaiting-human'"
  ),
};

export function logEntry(
  taskId: string | null,
  agentId: string | null,
  message: string,
  type: "info" | "warning" | "error" | "command" | "success" = "info",
  category: "system" | "agent" | "task" | "security" | "finance" = "system"
) {
  const id = uuidv4();
  queries.insertLog.run(id, taskId, agentId, message, type, category);
  return { id, task_id: taskId, agent_id: agentId, message, type, category, created_at: new Date().toISOString() };
}
