use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use scrypt::{
    password_hash::{PasswordHash as ScryptPasswordHash, PasswordHasher as ScryptPasswordHasher, PasswordVerifier as ScryptPasswordVerifier, SaltString as ScryptSaltString},
    Scrypt,
};

pub fn hash_password_bcrypt(password: &str) -> anyhow::Result<String> {
    let hash = bcrypt::hash(password, bcrypt::DEFAULT_COST)?;
    Ok(hash)
}

pub fn verify_password_bcrypt(password: &str, hash: &str) -> anyhow::Result<bool> {
    Ok(bcrypt::verify(password, hash)?)
}

pub fn hash_password_argon2(password: &str) -> anyhow::Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();

    let password_hash = argon2
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| anyhow::anyhow!("Argon2 hashing failed: {}", e))?
        .to_string();

    Ok(password_hash)
}

pub fn verify_password_argon2(password: &str, hash: &str) -> anyhow::Result<bool> {
    let parsed_hash = PasswordHash::new(hash)
        .map_err(|e| anyhow::anyhow!("Invalid hash format: {}", e))?;

    let argon2 = Argon2::default();

    match argon2.verify_password(password.as_bytes(), &parsed_hash) {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

pub fn hash_password_scrypt(password: &str) -> anyhow::Result<String> {
    let salt = ScryptSaltString::generate(&mut OsRng);
    let scrypt = Scrypt;

    let password_hash = scrypt
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| anyhow::anyhow!("Scrypt hashing failed: {}", e))?
        .to_string();

    Ok(password_hash)
}

pub fn verify_password_scrypt(password: &str, hash: &str) -> anyhow::Result<bool> {
    let parsed_hash = ScryptPasswordHash::new(hash)
        .map_err(|e| anyhow::anyhow!("Invalid hash format: {}", e))?;

    let scrypt = Scrypt;

    match scrypt.verify_password(password.as_bytes(), &parsed_hash) {
        Ok(_) => Ok(true),
        Err(_) => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bcrypt() {
        let password = "my_secure_password";
        let hash = hash_password_bcrypt(password).unwrap();
        assert!(verify_password_bcrypt(password, &hash).unwrap());
        assert!(!verify_password_bcrypt("wrong_password", &hash).unwrap());
    }

    #[test]
    fn test_argon2() {
        let password = "my_secure_password";
        let hash = hash_password_argon2(password).unwrap();
        assert!(verify_password_argon2(password, &hash).unwrap());
        assert!(!verify_password_argon2("wrong_password", &hash).unwrap());
    }

    #[test]
    fn test_scrypt() {
        let password = "my_secure_password";
        let hash = hash_password_scrypt(password).unwrap();
        assert!(verify_password_scrypt(password, &hash).unwrap());
        assert!(!verify_password_scrypt("wrong_password", &hash).unwrap());
    }
}
