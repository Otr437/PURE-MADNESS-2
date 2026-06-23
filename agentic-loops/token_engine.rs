//! RBAC Token Engine + Monitor — Rust
//! Plugs directly into react_loop.rs
//!
//! Cargo.toml additions:
//!   uuid = { version = "1", features = ["v4"] }
//!   chrono = { version = "0.4", features = ["serde"] }
//!
//! Usage:
//!   let engine = TokenEngine::new(DEFAULT_CONFIG.clone(), TokenEngineOptions::default());
//!   let session = engine.start_session("operator", "your task")?;
//!   engine.record_usage(&session.id, 500, 300, 1)?;
//!   engine.end_session(&session.id, "done")?;
//!   engine.print_monitor(false);

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ── Role definition ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Role {
    pub max_tokens:  u64,
    pub max_iter:    usize,
    pub alert_pct:   f64,
    pub cost_per_1k: f64,
}

// ── RBAC config ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct RBACConfig {
    pub roles: HashMap<String, Role>,
}

impl RBACConfig {
    pub fn get(&self, role: &str) -> Result<Role> {
        self.roles.get(role).cloned().ok_or_else(|| {
            let valid: Vec<_> = self.roles.keys().collect();
            anyhow!("Unknown role {:?} — valid roles: {:?}", role, valid)
        })
    }
}

pub fn default_config() -> RBACConfig {
    let mut roles = HashMap::new();
    roles.insert("admin".into(),    Role { max_tokens: 200_000, max_iter: 50, alert_pct: 0.80, cost_per_1k: 0.015 });
    roles.insert("operator".into(), Role { max_tokens:  50_000, max_iter: 30, alert_pct: 0.75, cost_per_1k: 0.015 });
    roles.insert("user".into(),     Role { max_tokens:  10_000, max_iter: 15, alert_pct: 0.70, cost_per_1k: 0.015 });
    roles.insert("readonly".into(), Role { max_tokens:   2_000, max_iter:  5, alert_pct: 0.60, cost_per_1k: 0.015 });
    RBACConfig { roles }
}

// ── Session ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct Session {
    pub id:            String,
    pub role:          String,
    pub task:          String,
    pub budget:        Role,
    pub started_at:    String,       // ISO8601
    pub ended_at:      Option<String>,
    pub elapsed_ms:    u128,
    pub input_tokens:  u64,
    pub output_tokens: u64,
    pub iterations:    usize,
    pub answer:        String,
    pub alerts:        Vec<String>,
    pub aborted:       bool,
    pub abort_reason:  String,
    #[serde(skip)]
    pub start_instant: Option<Instant>,
}

impl Session {
    pub fn total_tokens(&self)       -> u64   { self.input_tokens + self.output_tokens }
    pub fn budget_used_pct(&self)    -> f64   { self.total_tokens() as f64 / self.budget.max_tokens as f64 }
    pub fn estimated_cost_usd(&self) -> f64   { (self.total_tokens() as f64 / 1000.0) * self.budget.cost_per_1k }
}

// ── Errors ────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct BudgetExceededError(pub String);
impl std::fmt::Display for BudgetExceededError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result { write!(f, "{}", self.0) }
}
impl std::error::Error for BudgetExceededError {}

// ── Token Engine ──────────────────────────────────────────────────────────────

pub struct TokenEngineOptions {
    pub audit_path: String,
    pub on_alert:   Option<Box<dyn Fn(&Session, &str) + Send + Sync>>,
    pub on_abort:   Option<Box<dyn Fn(&Session, &str) + Send + Sync>>,
}

impl Default for TokenEngineOptions {
    fn default() -> Self {
        Self {
            audit_path: std::env::var("AGENT_AUDIT_LOG")
                .unwrap_or_else(|_| "/tmp/agent_audit.jsonl".into()),
            on_alert: None,
            on_abort: None,
        }
    }
}

pub struct TokenEngine {
    config:     RBACConfig,
    sessions:   Mutex<HashMap<String, Session>>,
    audit_path: String,
    on_alert:   Option<Arc<dyn Fn(&Session, &str) + Send + Sync>>,
    on_abort:   Option<Arc<dyn Fn(&Session, &str) + Send + Sync>>,
}

impl TokenEngine {
    pub fn new(config: RBACConfig, opts: TokenEngineOptions) -> Arc<Self> {
        Arc::new(Self {
            config,
            sessions:   Mutex::new(HashMap::new()),
            audit_path: opts.audit_path,
            on_alert:   opts.on_alert.map(Arc::from),
            on_abort:   opts.on_abort.map(Arc::from),
        })
    }

    // ── Session lifecycle ─────────────────────────────────────────────────────

    pub fn start_session(&self, role: &str, task: &str) -> Result<Session> {
        let budget = self.config.get(role)?;
        let session = Session {
            id:           Uuid::new_v4().to_string(),
            role:         role.to_string(),
            task:         task.to_string(),
            budget,
            started_at:   chrono::Utc::now().to_rfc3339(),
            ended_at:     None,
            elapsed_ms:   0,
            input_tokens:  0,
            output_tokens: 0,
            iterations:   0,
            answer:       String::new(),
            alerts:       vec![],
            aborted:      false,
            abort_reason: String::new(),
            start_instant: Some(Instant::now()),
        };
        self.audit("session_start", &session, &[]);
        let mut sessions = self.sessions.lock().unwrap();
        sessions.insert(session.id.clone(), session.clone());
        Ok(session)
    }

    pub fn record_usage(&self, session_id: &str, input_tokens: u64, output_tokens: u64, iteration: usize) -> Result<()> {
        let mut sessions = self.sessions.lock().unwrap();
        let s = sessions.get_mut(session_id).ok_or_else(|| anyhow!("Unknown session: {}", session_id))?;
        s.input_tokens  += input_tokens;
        s.output_tokens += output_tokens;
        s.iterations     = iteration;
        let s_clone = s.clone();
        drop(sessions);
        self.audit("usage", &s_clone, &[
            ("delta_input",  input_tokens.to_string()),
            ("delta_output", output_tokens.to_string()),
        ]);
        self.check_budget(session_id)
    }

    pub fn end_session(&self, session_id: &str, answer: &str) -> Result<Session> {
        let mut sessions = self.sessions.lock().unwrap();
        let s = sessions.get_mut(session_id).ok_or_else(|| anyhow!("Unknown session: {}", session_id))?;
        s.ended_at = Some(chrono::Utc::now().to_rfc3339());
        if let Some(inst) = s.start_instant {
            s.elapsed_ms = inst.elapsed().as_millis();
        }
        s.answer = answer.to_string();
        let s_clone = s.clone();
        drop(sessions);
        self.audit("session_end", &s_clone, &[]);
        Ok(s_clone)
    }

    pub fn abort_session(&self, session_id: &str, reason: &str) -> Result<()> {
        let mut sessions = self.sessions.lock().unwrap();
        let s = sessions.get_mut(session_id).ok_or_else(|| anyhow!("Unknown session: {}", session_id))?;
        s.aborted      = true;
        s.abort_reason = reason.to_string();
        s.ended_at     = Some(chrono::Utc::now().to_rfc3339());
        if let Some(inst) = s.start_instant {
            s.elapsed_ms = inst.elapsed().as_millis();
        }
        let s_clone = s.clone();
        drop(sessions);
        self.audit("session_abort", &s_clone, &[("reason", reason.to_string())]);
        if let Some(cb) = &self.on_abort { cb(&s_clone, reason); }
        Err(anyhow!(BudgetExceededError(reason.to_string())))
    }

    // ── Budget enforcement ────────────────────────────────────────────────────

    pub fn check_iteration(&self, session_id: &str, iteration: usize) -> Result<()> {
        let sessions = self.sessions.lock().unwrap();
        let s = sessions.get(session_id).ok_or_else(|| anyhow!("Unknown session"))?;
        let max = s.budget.max_iter;
        let role = s.role.clone();
        drop(sessions);
        if iteration > max {
            return self.abort_session(session_id, &format!(
                "role {:?} iteration limit reached: {} max, attempted #{}",
                role, max, iteration
            ));
        }
        Ok(())
    }

    fn check_budget(&self, session_id: &str) -> Result<()> {
        let sessions = self.sessions.lock().unwrap();
        let s = sessions.get(session_id).ok_or_else(|| anyhow!("Unknown session"))?;
        let pct       = s.budget_used_pct();
        let threshold = s.budget.alert_pct;
        let alerted   = !s.alerts.is_empty();
        let total     = s.total_tokens();
        let max       = s.budget.max_tokens;
        let role      = s.role.clone();
        let id        = s.id.clone();
        drop(sessions);

        if pct >= threshold && !alerted {
            let msg = format!(
                "[ALERT] Role {:?} session {} at {:.1}% of token budget ({}/{})",
                role, &id[..8], pct * 100.0, total, max
            );
            {
                let mut sessions = self.sessions.lock().unwrap();
                if let Some(s) = sessions.get_mut(&id) {
                    s.alerts.push(msg.clone());
                }
            }
            self.emit_alert(session_id, &msg);
        }

        if total >= max {
            return self.abort_session(session_id, &format!(
                "role {:?} token budget exhausted: {}/{}", role, total, max
            ));
        }
        Ok(())
    }

    fn emit_alert(&self, session_id: &str, msg: &str) {
        println!("\n\x1b[93m⚠  TOKEN ALERT\x1b[0m  {}", msg);
        let sessions = self.sessions.lock().unwrap();
        if let Some(s) = sessions.get(session_id) {
            self.audit("alert", s, &[("message", msg.to_string())]);
            if let Some(cb) = &self.on_alert { cb(s, msg); }
        }
    }

    // ── Monitor ───────────────────────────────────────────────────────────────

    pub fn print_monitor(&self, active_only: bool) {
        let sessions = self.sessions.lock().unwrap();
        let mut list: Vec<&Session> = sessions.values()
            .filter(|s| !active_only || s.ended_at.is_none())
            .collect();
        list.sort_by_key(|s| &s.started_at);
        list.reverse();

        let sep = "─".repeat(112);
        println!("\n{}", sep);
        println!("{:<10} {:<12} {:<12} {:<10} {:<18} {:<8} {:<10} {:<10} {}",
            "SESSION", "ROLE", "TOKENS", "BUDGET", "USED%", "ITER", "COST$", "ELAPSED", "STATUS");
        println!("{}", sep);

        let mut total_tokens: u64  = 0;
        let mut total_cost:   f64  = 0.0;

        for s in &list {
            let (color, status) = if s.aborted {
                ("\x1b[91m", "ABORTED")
            } else if s.ended_at.is_some() {
                ("\x1b[92m", "DONE")
            } else {
                ("\x1b[93m", "RUNNING")
            };
            let pct    = s.budget_used_pct();
            let filled = (pct * 10.0) as usize;
            let bar    = "█".repeat(filled) + &"░".repeat(10 - filled);
            println!(
                "{:<10} {:<12} {:<12} {:<10} {} {:4.1}% {:<8} ${:<9.4} {:<9.1}ms {}{}\x1b[0m",
                &s.id[..8], s.role,
                s.total_tokens(), s.budget.max_tokens,
                bar, pct * 100.0,
                format!("{}/{}", s.iterations, s.budget.max_iter),
                s.estimated_cost_usd(),
                s.elapsed_ms as f64,
                color, status,
            );
            total_tokens += s.total_tokens();
            total_cost   += s.estimated_cost_usd();
        }

        println!("{}", sep);
        println!("  Sessions: {}  |  Tokens: {}  |  Cost: ${:.4}", list.len(), total_tokens, total_cost);
        println!("{}\n", sep);
    }

    pub fn get_report(&self) -> Vec<serde_json::Value> {
        let sessions = self.sessions.lock().unwrap();
        sessions.values()
            .map(|s| serde_json::to_value(s).unwrap_or_default())
            .collect()
    }

    pub fn write_report(&self, path: &str) -> Result<()> {
        let data = serde_json::to_string_pretty(&self.get_report())?;
        std::fs::write(path, data)?;
        Ok(())
    }

    // ── Audit log ─────────────────────────────────────────────────────────────

    fn audit(&self, event: &str, s: &Session, extra: &[(&str, String)]) {
        let mut record = serde_json::json!({
            "ts":         chrono::Utc::now().to_rfc3339(),
            "event":      event,
            "session_id": s.id,
            "role":       s.role,
            "tokens":     s.total_tokens(),
            "budget":     s.budget.max_tokens,
            "pct":        format!("{:.1}", s.budget_used_pct() * 100.0),
            "cost_usd":   format!("{:.6}", s.estimated_cost_usd()),
        });
        for (k, v) in extra {
            record[k] = serde_json::json!(v);
        }
        if let Ok(mut f) = OpenOptions::new().append(true).create(true).open(&self.audit_path) {
            let _ = writeln!(f, "{}", record);
        }
    }
}
