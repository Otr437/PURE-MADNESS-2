use sha2::{Sha256, Sha512, Digest};
use sha3::{Sha3_256, Sha3_512};
use blake3::Hasher;

pub fn hash_sha256(data: &[u8]) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().to_vec()
}

pub fn hash_sha512(data: &[u8]) -> Vec<u8> {
    let mut hasher = Sha512::new();
    hasher.update(data);
    hasher.finalize().to_vec()
}

pub fn hash_sha3_256(data: &[u8]) -> Vec<u8> {
    let mut hasher = Sha3_256::new();
    hasher.update(data);
    hasher.finalize().to_vec()
}

pub fn hash_sha3_512(data: &[u8]) -> Vec<u8> {
    let mut hasher = Sha3_512::new();
    hasher.update(data);
    hasher.finalize().to_vec()
}

pub fn hash_blake3(data: &[u8]) -> Vec<u8> {
    let mut hasher = Hasher::new();
    hasher.update(data);
    hasher.finalize().as_bytes().to_vec()
}

pub fn hmac_sha256(data: &[u8], key: &[u8]) -> Vec<u8> {
    use hmac::{Hmac, Mac};
    type HmacSha256 = Hmac<Sha256>;
    
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC can take key of any size");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sha256() {
        let data = b"Hello, World!";
        let hash = hash_sha256(data);
        assert_eq!(hash.len(), 32);
    }

    #[test]
    fn test_sha512() {
        let data = b"Hello, World!";
        let hash = hash_sha512(data);
        assert_eq!(hash.len(), 64);
    }

    #[test]
    fn test_blake3() {
        let data = b"Hello, World!";
        let hash = hash_blake3(data);
        assert_eq!(hash.len(), 32);
    }

    #[test]
    fn test_hmac() {
        let data = b"message";
        let key = b"secret_key";
        let mac = hmac_sha256(data, key);
        assert_eq!(mac.len(), 32);
    }
}
