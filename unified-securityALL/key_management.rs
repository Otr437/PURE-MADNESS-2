use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::RwLock;
use uuid::Uuid;

pub struct KeyManager {
    keys: RwLock<HashMap<String, KeyInfo>>,
}

#[derive(Debug, Clone)]
struct KeyInfo {
    key_type: KeyType,
    public_key: Option<String>,
    private_key: Option<String>,
    symmetric_key: Option<Vec<u8>>,
    created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone)]
enum KeyType {
    Aes256,
    Rsa4096,
    Ed25519,
}

impl KeyManager {
    pub fn new() -> Self {
        Self {
            keys: RwLock::new(HashMap::new()),
        }
    }

    pub fn store_symmetric_key(&self, key: &[u8]) -> String {
        let key_id = Uuid::new_v4().to_string();
        let key_info = KeyInfo {
            key_type: KeyType::Aes256,
            public_key: None,
            private_key: None,
            symmetric_key: Some(key.to_vec()),
            created_at: chrono::Utc::now(),
        };

        let mut keys = self.keys.write().unwrap();
        keys.insert(key_id.clone(), key_info);
        key_id
    }

    pub fn store_rsa_keypair(&self, private_pem: &str, public_pem: &str) -> String {
        let key_id = Uuid::new_v4().to_string();
        let key_info = KeyInfo {
            key_type: KeyType::Rsa4096,
            public_key: Some(public_pem.to_string()),
            private_key: Some(private_pem.to_string()),
            symmetric_key: None,
            created_at: chrono::Utc::now(),
        };

        let mut keys = self.keys.write().unwrap();
        keys.insert(key_id.clone(), key_info);
        key_id
    }

    pub fn store_ed25519_keypair(&self, private_key: &ed25519_dalek::SigningKey, public_key: &ed25519_dalek::VerifyingKey) -> String {
        let key_id = Uuid::new_v4().to_string();
        let key_info = KeyInfo {
            key_type: KeyType::Ed25519,
            public_key: Some(base64::encode(public_key.as_bytes())),
            private_key: Some(base64::encode(private_key.to_bytes())),
            symmetric_key: None,
            created_at: chrono::Utc::now(),
        };

        let mut keys = self.keys.write().unwrap();
        keys.insert(key_id.clone(), key_info);
        key_id
    }

    pub fn get_key(&self, key_id: &str) -> Option<Value> {
        let keys = self.keys.read().unwrap();
        keys.get(key_id).map(|info| {
            json!({
                "key_id": key_id,
                "type": format!("{:?}", info.key_type),
                "public_key": info.public_key,
                "private_key": info.private_key,
                "symmetric_key": info.symmetric_key.as_ref().map(|k| base64::encode(k)),
                "created_at": info.created_at.to_rfc3339()
            })
        })
    }

    pub fn list_keys(&self) -> Vec<Value> {
        let keys = self.keys.read().unwrap();
        keys.iter()
            .map(|(id, info)| {
                json!({
                    "key_id": id,
                    "type": format!("{:?}", info.key_type),
                    "has_public_key": info.public_key.is_some(),
                    "has_private_key": info.private_key.is_some(),
                    "has_symmetric_key": info.symmetric_key.is_some(),
                    "created_at": info.created_at.to_rfc3339()
                })
            })
            .collect()
    }

    pub fn delete_key(&self, key_id: &str) -> bool {
        let mut keys = self.keys.write().unwrap();
        keys.remove(key_id).is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_store_and_retrieve_symmetric_key() {
        let manager = KeyManager::new();
        let key = vec![0u8; 32];
        let key_id = manager.store_symmetric_key(&key);

        let retrieved = manager.get_key(&key_id);
        assert!(retrieved.is_some());
    }

    #[test]
    fn test_list_keys() {
        let manager = KeyManager::new();
        let key1 = vec![0u8; 32];
        let key2 = vec![1u8; 32];

        manager.store_symmetric_key(&key1);
        manager.store_symmetric_key(&key2);

        let keys = manager.list_keys();
        assert_eq!(keys.len(), 2);
    }
}
