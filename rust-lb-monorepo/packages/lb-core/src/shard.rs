use crate::{
    backend::Backend,
    error::{LbError, LbResult},
    types::ShardId,
};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

/// Strategy for determining which shard handles a given key.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum ShardStrategy {
    /// Consistent hash ring with configurable virtual nodes.
    ConsistentHash { virtual_nodes: u32 },
    /// Modulo-based: hash(key) % shard_count.
    Modulo { shard_count: u32 },
    /// Range-based: key prefixes or lexicographic ranges map to shards.
    Range { ranges: Vec<ShardRange> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShardRange {
    pub start: String,
    pub end: String,
    pub shard_id: u32,
}

/// A shard owns a set of backends and handles keys assigned to it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Shard {
    pub id: ShardId,
    pub backend_ids: Vec<String>,
    pub replica_count: u32,
    pub is_primary: bool,
}

/// The sharding manager maps keys to shards and shards to backends.
#[derive(Debug)]
pub struct ShardManager {
    strategy: ShardStrategy,
    shards: DashMap<u32, Shard>,
    backend_map: DashMap<String, Arc<Backend>>,
}

impl ShardManager {
    pub fn new(strategy: ShardStrategy) -> Self {
        Self {
            strategy,
            shards: DashMap::new(),
            backend_map: DashMap::new(),
        }
    }

    pub fn register_shard(&self, shard: Shard) {
        self.shards.insert(shard.id.value(), shard);
    }

    pub fn register_backend(&self, backend: Arc<Backend>) {
        self.backend_map
            .insert(backend.id.as_str().to_owned(), backend);
    }

    pub fn remove_shard(&self, shard_id: u32) {
        self.shards.remove(&shard_id);
    }

    pub fn remove_backend(&self, backend_id: &str) {
        self.backend_map.remove(backend_id);
    }

    /// Map a key to its shard ID using the configured strategy.
    pub fn shard_for_key(&self, key: &str) -> LbResult<u32> {
        match &self.strategy {
            ShardStrategy::ConsistentHash { virtual_nodes } => {
                self.consistent_hash_shard(key, *virtual_nodes)
            }
            ShardStrategy::Modulo { shard_count } => {
                if *shard_count == 0 {
                    return Err(LbError::Config("shard_count must be > 0".into()));
                }
                let hash = self.sha256_u64(key);
                Ok((hash % *shard_count as u64) as u32)
            }
            ShardStrategy::Range { ranges } => {
                for range in ranges {
                    if key >= range.start.as_str() && key < range.end.as_str() {
                        return Ok(range.shard_id);
                    }
                }
                Err(LbError::ShardNotFound(key.to_owned()))
            }
        }
    }

    /// Return the primary backend for the shard that owns the given key.
    pub fn backend_for_key(&self, key: &str) -> LbResult<Arc<Backend>> {
        let shard_id = self.shard_for_key(key)?;
        let shard = self
            .shards
            .get(&shard_id)
            .ok_or_else(|| LbError::ShardNotFound(format!("shard {}", shard_id)))?;

        // Select first healthy backend in this shard's backend list
        for backend_id in &shard.backend_ids {
            if let Some(backend) = self.backend_map.get(backend_id) {
                if backend.is_healthy() && !backend.is_circuit_open() {
                    return Ok(backend.clone());
                }
            }
        }
        Err(LbError::NoHealthyBackends)
    }

    /// Return all backends for a shard (for replication or read fanout).
    pub fn backends_for_shard(&self, shard_id: u32) -> LbResult<Vec<Arc<Backend>>> {
        let shard = self
            .shards
            .get(&shard_id)
            .ok_or_else(|| LbError::ShardNotFound(format!("shard {}", shard_id)))?;

        let mut result = Vec::new();
        for backend_id in &shard.backend_ids {
            if let Some(backend) = self.backend_map.get(backend_id) {
                result.push(backend.clone());
            }
        }
        Ok(result)
    }

    pub fn shard_count(&self) -> usize {
        self.shards.len()
    }

    pub fn backend_count(&self) -> usize {
        self.backend_map.len()
    }

    fn sha256_u64(&self, key: &str) -> u64 {
        let mut hasher = Sha256::new();
        hasher.update(key.as_bytes());
        let result = hasher.finalize();
        u64::from_le_bytes(result[..8].try_into().unwrap_or([0u8; 8]))
    }

    fn consistent_hash_shard(&self, key: &str, virtual_nodes: u32) -> LbResult<u32> {
        if self.shards.is_empty() {
            return Err(LbError::NoHealthyBackends);
        }
        let shard_ids: Vec<u32> = self.shards.iter().map(|e| *e.key()).collect();
        // Build ring: (ring_hash, shard_id)
        let mut ring: Vec<(u64, u32)> = Vec::new();
        for shard_id in &shard_ids {
            for vn in 0..virtual_nodes {
                let vkey = format!("shard-{}#{}", shard_id, vn);
                ring.push((self.sha256_u64(&vkey), *shard_id));
            }
        }
        ring.sort_unstable_by_key(|(h, _)| *h);
        let key_hash = self.sha256_u64(key);
        let entry = ring
            .iter()
            .find(|(h, _)| *h >= key_hash)
            .or_else(|| ring.first());
        match entry {
            Some((_, shard_id)) => Ok(*shard_id),
            None => Err(LbError::ShardNotFound(key.to_owned())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_shard(id: u32, backend_ids: Vec<String>) -> Shard {
        Shard {
            id: ShardId::new(id),
            backend_ids,
            replica_count: 1,
            is_primary: true,
        }
    }

    #[test]
    fn modulo_sharding_distributes_keys() {
        let manager = ShardManager::new(ShardStrategy::Modulo { shard_count: 4 });
        for i in 0..4 {
            manager.register_shard(make_shard(i, vec![]));
        }
        let key1 = "user:12345";
        let key2 = "user:12345";
        assert_eq!(
            manager.shard_for_key(key1).unwrap(),
            manager.shard_for_key(key2).unwrap()
        );
    }

    #[test]
    fn consistent_hash_is_deterministic() {
        let manager = ShardManager::new(ShardStrategy::ConsistentHash { virtual_nodes: 150 });
        for i in 0..4 {
            manager.register_shard(make_shard(i, vec![]));
        }
        let shard_id_first = manager.shard_for_key("order:abc-123").unwrap();
        for _ in 0..20 {
            assert_eq!(
                manager.shard_for_key("order:abc-123").unwrap(),
                shard_id_first
            );
        }
    }

    #[test]
    fn range_sharding_maps_correctly() {
        let manager = ShardManager::new(ShardStrategy::Range {
            ranges: vec![
                ShardRange {
                    start: "a".to_string(),
                    end: "m".to_string(),
                    shard_id: 0,
                },
                ShardRange {
                    start: "m".to_string(),
                    end: "z".to_string(),
                    shard_id: 1,
                },
            ],
        });
        assert_eq!(manager.shard_for_key("alice").unwrap(), 0);
        assert_eq!(manager.shard_for_key("mike").unwrap(), 1);
        assert!(manager.shard_for_key("zzz_out").is_err());
    }
}
