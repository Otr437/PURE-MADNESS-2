use rsa::{
    Oaep, RsaPrivateKey, RsaPublicKey,
    pkcs8::{EncodePrivateKey, EncodePublicKey, DecodePrivateKey, DecodePublicKey, LineEnding},
};
use sha2::Sha256;

pub fn generate_rsa_keypair() -> anyhow::Result<(String, String)> {
    let mut rng = rand::thread_rng();
    let bits = 4096;

    let private_key = RsaPrivateKey::new(&mut rng, bits)?;
    let public_key = RsaPublicKey::from(&private_key);

    let private_pem = private_key.to_pkcs8_pem(LineEnding::LF)?.to_string();
    let public_pem = public_key.to_public_key_pem(LineEnding::LF)?;

    Ok((private_pem, public_pem))
}

pub fn encrypt_rsa(data: &[u8], public_key_pem: &str) -> anyhow::Result<Vec<u8>> {
    let public_key = RsaPublicKey::from_public_key_pem(public_key_pem)?;
    
    let mut rng = rand::thread_rng();
    let padding = Oaep::new::<Sha256>();

    let encrypted = public_key
        .encrypt(&mut rng, padding, data)
        .map_err(|e| anyhow::anyhow!("RSA encryption failed: {}", e))?;

    Ok(encrypted)
}

pub fn decrypt_rsa(ciphertext: &[u8], private_key_pem: &str) -> anyhow::Result<Vec<u8>> {
    let private_key = RsaPrivateKey::from_pkcs8_pem(private_key_pem)?;
    
    let padding = Oaep::new::<Sha256>();

    let decrypted = private_key
        .decrypt(padding, ciphertext)
        .map_err(|e| anyhow::anyhow!("RSA decryption failed: {}", e))?;

    Ok(decrypted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rsa_encryption_decryption() {
        let (private_pem, public_pem) = generate_rsa_keypair().unwrap();
        let data = b"Secret message";

        let encrypted = encrypt_rsa(data, &public_pem).unwrap();
        let decrypted = decrypt_rsa(&encrypted, &private_pem).unwrap();

        assert_eq!(data, decrypted.as_slice());
    }
}
