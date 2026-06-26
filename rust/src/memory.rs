// Conversation Memory — Rust
// JSON-backed session store. No serde bincode/pickle — pure JSON so
// loading a session file cannot execute code under any circumstances.
// Path traversal protected via allowlist character check on session IDs.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

fn now_secs() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

fn new_session_id() -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    now_secs().to_bits().hash(&mut h);
    std::thread::current().id().hash(&mut h);
    format!("{:016x}{:016x}", h.finish(), h.finish().wrapping_mul(6364136223846793005))
}

fn safe_filename(session_id: &str) -> Result<String> {
    if session_id.is_empty()
        || session_id.contains("..")
        || !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        anyhow::bail!("Invalid session_id");
    }
    Ok(format!("{}.json", session_id))
}

// ── Session model ──────────────────────────────────────────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub session_id: String,
    pub created_at: f64,
    pub updated_at: f64,
    pub messages:   Vec<Value>,
    pub summary:    String,
    pub metadata:   std::collections::HashMap<String, String>,
}

impl Session {
    fn new(session_id: String, metadata: std::collections::HashMap<String, String>) -> Self {
        let now = now_secs();
        Self {
            session_id,
            created_at: now,
            updated_at: now,
            messages:   Vec::new(),
            summary:    String::new(),
            metadata,
        }
    }
}

// ── MemoryStore ────────────────────────────────────────────────────────────────
pub struct MemoryStore {
    dir:  PathBuf,
    lock: Mutex<()>,
}

impl MemoryStore {
    pub fn new(dir: impl AsRef<Path>) -> Result<Self> {
        let dir = dir.as_ref().to_path_buf();
        fs::create_dir_all(&dir).context("create session dir")?;
        Ok(Self { dir, lock: Mutex::new(()) })
    }

    fn path(&self, session_id: &str) -> Result<PathBuf> {
        let name = safe_filename(session_id)?;
        Ok(self.dir.join(name))
    }

    pub fn create(&self, metadata: std::collections::HashMap<String, String>) -> Result<Session> {
        let session = Session::new(new_session_id(), metadata);
        self.save(&session)?;
        Ok(session)
    }

    pub fn load(&self, session_id: &str) -> Result<Option<Session>> {
        let path = self.path(session_id)?;
        let _guard = self.lock.lock().unwrap();
        if !path.exists() {
            return Ok(None);
        }
        let data = fs::read_to_string(&path).context("read session")?;
        let session: Session = serde_json::from_str(&data).context("parse session")?;
        Ok(Some(session))
    }

    pub fn save(&self, session: &Session) -> Result<()> {
        let mut s = session.clone();
        s.updated_at = now_secs();
        let path = self.path(&s.session_id)?;
        let tmp  = path.with_extension("tmp");
        let data = serde_json::to_string_pretty(&s)?;
        let _guard = self.lock.lock().unwrap();
        fs::write(&tmp, &data).context("write tmp")?;
        fs::rename(&tmp, &path).context("rename session")?;
        Ok(())
    }

    pub fn delete(&self, session_id: &str) -> Result<bool> {
        let path = self.path(session_id)?;
        let _guard = self.lock.lock().unwrap();
        if !path.exists() {
            return Ok(false);
        }
        fs::remove_file(&path).context("delete session")?;
        Ok(true)
    }

    pub fn list(&self) -> Result<Vec<String>> {
        let mut ids = Vec::new();
        for entry in fs::read_dir(&self.dir)? {
            let entry = entry?;
            let name  = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".json") && !name.ends_with(".tmp") {
                ids.push(name.trim_end_matches(".json").to_string());
            }
        }
        ids.sort();
        Ok(ids)
    }

    pub fn append_user(&self, session_id: &str, content: &str) -> Result<Session> {
        self.append(session_id, serde_json::json!({ "role": "user", "content": content }))
    }

    pub fn append_assistant(&self, session_id: &str, content: &str) -> Result<Session> {
        self.append(session_id, serde_json::json!({ "role": "assistant", "content": content }))
    }

    fn append(&self, session_id: &str, message: Value) -> Result<Session> {
        let mut session = self.load(session_id)?.unwrap_or_else(|| {
            Session::new(session_id.to_string(), Default::default())
        });
        session.messages.push(message);
        self.save(&session)?;
        Ok(session)
    }
}

// ── Context builder ───────────────────────────────────────────────────────────
pub fn build_context_messages(session: &Session, new_user_message: &str) -> Vec<Value> {
    let mut msgs = Vec::new();
    if !session.summary.is_empty() {
        msgs.push(serde_json::json!({ "role": "user", "content": format!("[Prior summary]: {}", session.summary) }));
        msgs.push(serde_json::json!({ "role": "assistant", "content": "Understood." }));
    }
    msgs.extend(session.messages.clone());
    msgs.push(serde_json::json!({ "role": "user", "content": new_user_message }));
    msgs
}

// ── Tests ─────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use tempfile::tempdir;

    #[test]
    fn test_create_and_load() {
        let dir   = tempdir().unwrap();
        let store = MemoryStore::new(dir.path()).unwrap();
        let s     = store.create(HashMap::new()).unwrap();
        let loaded = store.load(&s.session_id).unwrap().unwrap();
        assert_eq!(loaded.session_id, s.session_id);
    }

    #[test]
    fn test_append_messages() {
        let dir   = tempdir().unwrap();
        let store = MemoryStore::new(dir.path()).unwrap();
        let s     = store.create(HashMap::new()).unwrap();
        store.append_user(&s.session_id, "hello").unwrap();
        store.append_assistant(&s.session_id, "world").unwrap();
        let loaded = store.load(&s.session_id).unwrap().unwrap();
        assert_eq!(loaded.messages.len(), 2);
    }

    #[test]
    fn test_delete() {
        let dir   = tempdir().unwrap();
        let store = MemoryStore::new(dir.path()).unwrap();
        let s     = store.create(HashMap::new()).unwrap();
        assert!(store.delete(&s.session_id).unwrap());
        assert!(store.load(&s.session_id).unwrap().is_none());
    }

    #[test]
    fn test_path_traversal_rejected() {
        let dir   = tempdir().unwrap();
        let store = MemoryStore::new(dir.path()).unwrap();
        assert!(store.load("../../etc/passwd").is_err());
    }

    #[test]
    fn test_build_context() {
        let mut session = Session::new("test".to_string(), Default::default());
        session.messages.push(serde_json::json!({ "role": "user", "content": "hi" }));
        let msgs = build_context_messages(&session, "new question");
        assert_eq!(msgs.last().unwrap()["content"], "new question");
    }
}
