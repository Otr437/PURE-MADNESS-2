use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand::rngs::OsRng;

pub fn generate_ed25519_keypair() -> (SigningKey, VerifyingKey) {
    let mut csprng = OsRng;
    let signing_key = SigningKey::generate(&mut csprng);
    let verifying_key = signing_key.verifying_key();
    (signing_key, verifying_key)
}

pub fn sign_ed25519(data: &[u8], private_key: &[u8]) -> anyhow::Result<Vec<u8>> {
    if private_key.len() != 32 {
        anyhow::bail!("Ed25519 private key must be 32 bytes");
    }

    let signing_key = SigningKey::from_bytes(private_key.try_into()?);
    let signature = signing_key.sign(data);

    Ok(signature.to_bytes().to_vec())
}

pub fn verify_ed25519(data: &[u8], signature: &[u8], public_key: &[u8]) -> anyhow::Result<bool> {
    if public_key.len() != 32 {
        anyhow::bail!("Ed25519 public key must be 32 bytes");
    }

    if signature.len() != 64 {
        anyhow::bail!("Ed25519 signature must be 64 bytes");
    }

    let verifying_key = VerifyingKey::from_bytes(public_key.try_into()?)?;
    let sig = Signature::from_bytes(signature.try_into()?);

    match verifying_key.verify(data, &sig) {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ed25519_sign_verify() {
        let (signing_key, verifying_key) = generate_ed25519_keypair();
        let message = b"Test message for signing";

        let signature = sign_ed25519(message, &signing_key.to_bytes()).unwrap();
        let valid = verify_ed25519(message, &signature, verifying_key.as_bytes()).unwrap();

        assert!(valid);

        // Test with wrong message
        let wrong_message = b"Wrong message";
        let invalid = verify_ed25519(wrong_message, &signature, verifying_key.as_bytes()).unwrap();
        assert!(!invalid);
    }
}
