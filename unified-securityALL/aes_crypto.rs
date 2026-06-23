use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use chacha20poly1305::{ChaCha20Poly1305, Key};
use rand::RngCore;

pub fn generate_aes_key() -> Vec<u8> {
    let key = Aes256Gcm::generate_key(&mut OsRng);
    key.to_vec()
}

pub fn generate_chacha_key() -> Vec<u8> {
    let key = ChaCha20Poly1305::generate_key(&mut OsRng);
    key.to_vec()
}

pub fn encrypt_aes_gcm(data: &[u8], key: &[u8]) -> anyhow::Result<(Vec<u8>, Vec<u8>)> {
    if key.len() != 32 {
        anyhow::bail!("AES-256 requires a 32-byte key");
    }

    let key_array = key.try_into()?;
    let cipher = Aes256Gcm::new(key_array);

    // Generate random nonce
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, data)
        .map_err(|e| anyhow::anyhow!("Encryption failed: {}", e))?;

    Ok((ciphertext, nonce_bytes.to_vec()))
}

pub fn decrypt_aes_gcm(ciphertext: &[u8], key: &[u8], nonce: &[u8]) -> anyhow::Result<Vec<u8>> {
    if key.len() != 32 {
        anyhow::bail!("AES-256 requires a 32-byte key");
    }

    if nonce.len() != 12 {
        anyhow::bail!("AES-GCM requires a 12-byte nonce");
    }

    let key_array = key.try_into()?;
    let cipher = Aes256Gcm::new(key_array);
    let nonce = Nonce::from_slice(nonce);

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| anyhow::anyhow!("Decryption failed: {}", e))?;

    Ok(plaintext)
}

pub fn encrypt_chacha20(data: &[u8], key: &[u8]) -> anyhow::Result<(Vec<u8>, Vec<u8>)> {
    if key.len() != 32 {
        anyhow::bail!("ChaCha20-Poly1305 requires a 32-byte key");
    }

    let key_array: &Key = key.try_into()?;
    let cipher = ChaCha20Poly1305::new(key_array);

    // Generate random nonce
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, data)
        .map_err(|e| anyhow::anyhow!("Encryption failed: {}", e))?;

    Ok((ciphertext, nonce_bytes.to_vec()))
}

pub fn decrypt_chacha20(ciphertext: &[u8], key: &[u8], nonce: &[u8]) -> anyhow::Result<Vec<u8>> {
    if key.len() != 32 {
        anyhow::bail!("ChaCha20-Poly1305 requires a 32-byte key");
    }

    if nonce.len() != 12 {
        anyhow::bail!("ChaCha20-Poly1305 requires a 12-byte nonce");
    }

    let key_array: &Key = key.try_into()?;
    let cipher = ChaCha20Poly1305::new(key_array);
    let nonce = Nonce::from_slice(nonce);

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| anyhow::anyhow!("Decryption failed: {}", e))?;

    Ok(plaintext)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_aes_encryption_decryption() {
        let key = generate_aes_key();
        let data = b"Hello, World!";

        let (encrypted, nonce) = encrypt_aes_gcm(data, &key).unwrap();
        let decrypted = decrypt_aes_gcm(&encrypted, &key, &nonce).unwrap();

        assert_eq!(data, decrypted.as_slice());
    }

    #[test]
    fn test_chacha_encryption_decryption() {
        let key = generate_chacha_key();
        let data = b"Hello, ChaCha20!";

        let (encrypted, nonce) = encrypt_chacha20(data, &key).unwrap();
        let decrypted = decrypt_chacha20(&encrypted, &key, &nonce).unwrap();

        assert_eq!(data, decrypted.as_slice());
    }
}
