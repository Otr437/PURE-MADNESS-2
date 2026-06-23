use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    #[serde(flatten)]
    custom: Value,
    exp: i64,
    iat: i64,
}

pub fn create_jwt(custom_claims: Value, secret: &str, expires_in: i64) -> anyhow::Result<String> {
    let now = chrono::Utc::now().timestamp();
    let exp = now + expires_in;

    let claims = Claims {
        custom: custom_claims,
        exp,
        iat: now,
    };

    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )?;

    Ok(token)
}

pub fn verify_jwt(token: &str, secret: &str) -> anyhow::Result<Value> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_exp = true;

    let token_data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )?;

    Ok(token_data.claims.custom)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_jwt_create_verify() {
        let secret = "test_secret";
        let claims = json!({
            "user_id": 123,
            "username": "testuser",
            "role": "admin"
        });

        let token = create_jwt(claims.clone(), secret, 3600).unwrap();
        let decoded = verify_jwt(&token, secret).unwrap();

        assert_eq!(decoded["user_id"], 123);
        assert_eq!(decoded["username"], "testuser");
        assert_eq!(decoded["role"], "admin");
    }

    #[test]
    fn test_jwt_invalid_secret() {
        let secret = "test_secret";
        let wrong_secret = "wrong_secret";
        let claims = json!({"user_id": 123});

        let token = create_jwt(claims, secret, 3600).unwrap();
        let result = verify_jwt(&token, wrong_secret);

        assert!(result.is_err());
    }
}
