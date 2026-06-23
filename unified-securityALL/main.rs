use axum::{
    extract::{Json, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use std::{net::SocketAddr, sync::Arc};
use tracing::{info, error};

mod aes_crypto;
mod rsa_crypto;
mod hashing;
mod jwt_handler;
mod key_management;
mod password;
mod signatures;

use aes_crypto::*;
use rsa_crypto::*;
use hashing::*;
use jwt_handler::*;
use key_management::*;
use password::*;
use signatures::*;

// ==================== CORE TYPES ====================

#[derive(Clone)]
pub struct AppState {
    pub key_manager: Arc<KeyManager>,
}

// ==================== REQUEST/RESPONSE TYPES ====================

#[derive(Debug, Serialize, Deserialize)]
pub struct EncryptRequest {
    pub data: String,
    #[serde(default)]
    pub algorithm: EncryptionAlgorithm,
    pub key: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EncryptResponse {
    pub encrypted: String,
    pub nonce: Option<String>,
    pub key_id: Option<String>,
    pub algorithm: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DecryptRequest {
    pub encrypted: String,
    pub nonce: Option<String>,
    pub key: Option<String>,
    pub key_id: Option<String>,
    #[serde(default)]
    pub algorithm: EncryptionAlgorithm,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DecryptResponse {
    pub data: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HashRequest {
    pub data: String,
    #[serde(default)]
    pub algorithm: HashAlgorithm,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HashResponse {
    pub hash: String,
    pub algorithm: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GenerateKeyRequest {
    #[serde(default)]
    pub algorithm: KeyAlgorithm,
    pub bits: Option<usize>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GenerateKeyResponse {
    pub key_id: String,
    pub public_key: Option<String>,
    pub private_key: Option<String>,
    pub algorithm: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SignRequest {
    pub data: String,
    pub key_id: Option<String>,
    pub private_key: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SignResponse {
    pub signature: String,
    pub algorithm: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct VerifyRequest {
    pub data: String,
    pub signature: String,
    pub key_id: Option<String>,
    pub public_key: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct VerifyResponse {
    pub valid: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PasswordHashRequest {
    pub password: String,
    #[serde(default)]
    pub algorithm: PasswordAlgorithm,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PasswordHashResponse {
    pub hash: String,
    pub algorithm: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PasswordVerifyRequest {
    pub password: String,
    pub hash: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PasswordVerifyResponse {
    pub valid: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct JwtCreateRequest {
    pub claims: serde_json::Value,
    pub secret: Option<String>,
    pub expires_in: Option<i64>, // seconds
}

#[derive(Debug, Serialize, Deserialize)]
pub struct JwtCreateResponse {
    pub token: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct JwtVerifyRequest {
    pub token: String,
    pub secret: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct JwtVerifyResponse {
    pub valid: bool,
    pub claims: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EncryptionAlgorithm {
    #[serde(rename = "aes-256-gcm")]
    Aes256Gcm,
    #[serde(rename = "chacha20-poly1305")]
    ChaCha20Poly1305,
    #[serde(rename = "rsa-4096")]
    Rsa4096,
}

impl Default for EncryptionAlgorithm {
    fn default() -> Self {
        Self::Aes256Gcm
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HashAlgorithm {
    Sha256,
    Sha512,
    Sha3_256,
    Sha3_512,
    Blake3,
}

impl Default for HashAlgorithm {
    fn default() -> Self {
        Self::Sha256
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyAlgorithm {
    #[serde(rename = "aes-256")]
    Aes256,
    #[serde(rename = "rsa-4096")]
    Rsa4096,
    #[serde(rename = "ed25519")]
    Ed25519,
}

impl Default for KeyAlgorithm {
    fn default() -> Self {
        Self::Aes256
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PasswordAlgorithm {
    Bcrypt,
    Argon2,
    Scrypt,
}

impl Default for PasswordAlgorithm {
    fn default() -> Self {
        Self::Bcrypt
    }
}

// ==================== MAIN ====================

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter("crypto_service=debug")
        .json()
        .init();

    info!("Starting Crypto Service v1.0.0");

    // Initialize key manager
    let key_manager = Arc::new(KeyManager::new());

    let state = AppState { key_manager };

    // Build router
    let app = Router::new()
        // Health & Info
        .route("/health", get(health_check))
        .route("/algorithms", get(list_algorithms))
        
        // Encryption/Decryption
        .route("/encrypt", post(encrypt_handler))
        .route("/decrypt", post(decrypt_handler))
        
        // Hashing
        .route("/hash", post(hash_handler))
        
        // Key Management
        .route("/keys/generate", post(generate_key_handler))
        .route("/keys/list", get(list_keys_handler))
        .route("/keys/:key_id", get(get_key_handler))
        
        // Digital Signatures
        .route("/sign", post(sign_handler))
        .route("/verify", post(verify_handler))
        
        // Password Hashing
        .route("/password/hash", post(password_hash_handler))
        .route("/password/verify", post(password_verify_handler))
        
        // JWT
        .route("/jwt/create", post(jwt_create_handler))
        .route("/jwt/verify", post(jwt_verify_handler))
        
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], 8081));
    info!("Crypto service listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

// ==================== HANDLERS ====================

async fn health_check() -> impl IntoResponse {
    Json(serde_json::json!({
        "status": "healthy",
        "service": "crypto-service",
        "version": "1.0.0"
    }))
}

async fn list_algorithms() -> impl IntoResponse {
    Json(serde_json::json!({
        "encryption": [
            "aes-256-gcm",
            "chacha20-poly1305",
            "rsa-4096"
        ],
        "hashing": [
            "sha256",
            "sha512",
            "sha3_256",
            "sha3_512",
            "blake3"
        ],
        "password": [
            "bcrypt",
            "argon2",
            "scrypt"
        ],
        "signatures": [
            "ed25519",
            "rsa-4096"
        ]
    }))
}

async fn encrypt_handler(
    State(state): State<AppState>,
    Json(req): Json<EncryptRequest>,
) -> Result<Json<EncryptResponse>, (StatusCode, String)> {
    match req.algorithm {
        EncryptionAlgorithm::Aes256Gcm => {
            let key = if let Some(k) = req.key {
                base64::decode(&k)
                    .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid key: {}", e)))?
            } else {
                generate_aes_key()
            };

            let (encrypted, nonce) = encrypt_aes_gcm(req.data.as_bytes(), &key)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

            Ok(Json(EncryptResponse {
                encrypted: base64::encode(&encrypted),
                nonce: Some(base64::encode(&nonce)),
                key_id: None,
                algorithm: "aes-256-gcm".to_string(),
            }))
        }
        EncryptionAlgorithm::ChaCha20Poly1305 => {
            let key = if let Some(k) = req.key {
                base64::decode(&k)
                    .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid key: {}", e)))?
            } else {
                generate_chacha_key()
            };

            let (encrypted, nonce) = encrypt_chacha20(req.data.as_bytes(), &key)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

            Ok(Json(EncryptResponse {
                encrypted: base64::encode(&encrypted),
                nonce: Some(base64::encode(&nonce)),
                key_id: None,
                algorithm: "chacha20-poly1305".to_string(),
            }))
        }
        EncryptionAlgorithm::Rsa4096 => {
            let public_key_pem = req
                .key
                .ok_or((StatusCode::BAD_REQUEST, "Public key required for RSA".to_string()))?;

            let encrypted = encrypt_rsa(req.data.as_bytes(), &public_key_pem)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

            Ok(Json(EncryptResponse {
                encrypted: base64::encode(&encrypted),
                nonce: None,
                key_id: None,
                algorithm: "rsa-4096".to_string(),
            }))
        }
    }
}

async fn decrypt_handler(
    State(state): State<AppState>,
    Json(req): Json<DecryptRequest>,
) -> Result<Json<DecryptResponse>, (StatusCode, String)> {
    let encrypted = base64::decode(&req.encrypted)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid encrypted data: {}", e)))?;

    match req.algorithm {
        EncryptionAlgorithm::Aes256Gcm => {
            let key_bytes = if let Some(k) = req.key {
                base64::decode(&k)
                    .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid key: {}", e)))?
            } else {
                return Err((StatusCode::BAD_REQUEST, "Key required".to_string()));
            };

            let nonce_bytes = req
                .nonce
                .ok_or((StatusCode::BAD_REQUEST, "Nonce required for AES-GCM".to_string()))
                .and_then(|n| {
                    base64::decode(&n)
                        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid nonce: {}", e)))
                })?;

            let decrypted = decrypt_aes_gcm(&encrypted, &key_bytes, &nonce_bytes)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

            let data = String::from_utf8(decrypted)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Invalid UTF-8: {}", e)))?;

            Ok(Json(DecryptResponse { data }))
        }
        EncryptionAlgorithm::ChaCha20Poly1305 => {
            let key_bytes = if let Some(k) = req.key {
                base64::decode(&k)
                    .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid key: {}", e)))?
            } else {
                return Err((StatusCode::BAD_REQUEST, "Key required".to_string()));
            };

            let nonce_bytes = req
                .nonce
                .ok_or((StatusCode::BAD_REQUEST, "Nonce required for ChaCha20".to_string()))
                .and_then(|n| {
                    base64::decode(&n)
                        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid nonce: {}", e)))
                })?;

            let decrypted = decrypt_chacha20(&encrypted, &key_bytes, &nonce_bytes)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

            let data = String::from_utf8(decrypted)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Invalid UTF-8: {}", e)))?;

            Ok(Json(DecryptResponse { data }))
        }
        EncryptionAlgorithm::Rsa4096 => {
            let private_key_pem = req
                .key
                .ok_or((StatusCode::BAD_REQUEST, "Private key required for RSA".to_string()))?;

            let decrypted = decrypt_rsa(&encrypted, &private_key_pem)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

            let data = String::from_utf8(decrypted)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Invalid UTF-8: {}", e)))?;

            Ok(Json(DecryptResponse { data }))
        }
    }
}

async fn hash_handler(
    Json(req): Json<HashRequest>,
) -> Result<Json<HashResponse>, (StatusCode, String)> {
    let hash = match req.algorithm {
        HashAlgorithm::Sha256 => hash_sha256(req.data.as_bytes()),
        HashAlgorithm::Sha512 => hash_sha512(req.data.as_bytes()),
        HashAlgorithm::Sha3_256 => hash_sha3_256(req.data.as_bytes()),
        HashAlgorithm::Sha3_512 => hash_sha3_512(req.data.as_bytes()),
        HashAlgorithm::Blake3 => hash_blake3(req.data.as_bytes()),
    };

    Ok(Json(HashResponse {
        hash: hex::encode(hash),
        algorithm: format!("{:?}", req.algorithm).to_lowercase(),
    }))
}

async fn generate_key_handler(
    State(state): State<AppState>,
    Json(req): Json<GenerateKeyRequest>,
) -> Result<Json<GenerateKeyResponse>, (StatusCode, String)> {
    match req.algorithm {
        KeyAlgorithm::Aes256 => {
            let key = generate_aes_key();
            let key_id = state.key_manager.store_symmetric_key(&key);

            Ok(Json(GenerateKeyResponse {
                key_id,
                public_key: Some(base64::encode(&key)),
                private_key: None,
                algorithm: "aes-256".to_string(),
            }))
        }
        KeyAlgorithm::Rsa4096 => {
            let (private_pem, public_pem) = generate_rsa_keypair()
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

            let key_id = state.key_manager.store_rsa_keypair(&private_pem, &public_pem);

            Ok(Json(GenerateKeyResponse {
                key_id,
                public_key: Some(public_pem),
                private_key: Some(private_pem),
                algorithm: "rsa-4096".to_string(),
            }))
        }
        KeyAlgorithm::Ed25519 => {
            let (private_key, public_key) = generate_ed25519_keypair();
            let key_id = state
                .key_manager
                .store_ed25519_keypair(&private_key, &public_key);

            Ok(Json(GenerateKeyResponse {
                key_id,
                public_key: Some(base64::encode(public_key.as_bytes())),
                private_key: Some(base64::encode(private_key.to_bytes())),
                algorithm: "ed25519".to_string(),
            }))
        }
    }
}

async fn list_keys_handler(State(state): State<AppState>) -> impl IntoResponse {
    let keys = state.key_manager.list_keys();
    Json(keys)
}

async fn get_key_handler(
    State(state): State<AppState>,
    axum::extract::Path(key_id): axum::extract::Path<String>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    if let Some(key_info) = state.key_manager.get_key(&key_id) {
        Ok(Json(key_info))
    } else {
        Err((StatusCode::NOT_FOUND, "Key not found".to_string()))
    }
}

async fn sign_handler(
    State(state): State<AppState>,
    Json(req): Json<SignRequest>,
) -> Result<Json<SignResponse>, (StatusCode, String)> {
    if let Some(private_key_b64) = req.private_key {
        // Use provided private key (Ed25519)
        let private_bytes = base64::decode(&private_key_b64)
            .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid private key: {}", e)))?;

        let signature = sign_ed25519(req.data.as_bytes(), &private_bytes)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        Ok(Json(SignResponse {
            signature: base64::encode(signature),
            algorithm: "ed25519".to_string(),
        }))
    } else if let Some(key_id) = req.key_id {
        // Use stored key
        let key_info = state
            .key_manager
            .get_key(&key_id)
            .ok_or((StatusCode::NOT_FOUND, "Key not found".to_string()))?;

        if let Some(private_key_b64) = key_info.get("private_key").and_then(|v| v.as_str()) {
            let private_bytes = base64::decode(private_key_b64)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Invalid stored key: {}", e)))?;

            let signature = sign_ed25519(req.data.as_bytes(), &private_bytes)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

            Ok(Json(SignResponse {
                signature: base64::encode(signature),
                algorithm: "ed25519".to_string(),
            }))
        } else {
            Err((StatusCode::BAD_REQUEST, "Key does not support signing".to_string()))
        }
    } else {
        Err((StatusCode::BAD_REQUEST, "Either key_id or private_key required".to_string()))
    }
}

async fn verify_handler(
    State(state): State<AppState>,
    Json(req): Json<VerifyRequest>,
) -> Result<Json<VerifyResponse>, (StatusCode, String)> {
    let signature = base64::decode(&req.signature)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid signature: {}", e)))?;

    if let Some(public_key_b64) = req.public_key {
        // Use provided public key
        let public_bytes = base64::decode(&public_key_b64)
            .map_err(|e| (StatusCode::BAD_REQUEST, format!("Invalid public key: {}", e)))?;

        let valid = verify_ed25519(req.data.as_bytes(), &signature, &public_bytes)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        Ok(Json(VerifyResponse { valid }))
    } else if let Some(key_id) = req.key_id {
        // Use stored key
        let key_info = state
            .key_manager
            .get_key(&key_id)
            .ok_or((StatusCode::NOT_FOUND, "Key not found".to_string()))?;

        if let Some(public_key_b64) = key_info.get("public_key").and_then(|v| v.as_str()) {
            let public_bytes = base64::decode(public_key_b64)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("Invalid stored key: {}", e)))?;

            let valid = verify_ed25519(req.data.as_bytes(), &signature, &public_bytes)
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

            Ok(Json(VerifyResponse { valid }))
        } else {
            Err((StatusCode::BAD_REQUEST, "Key does not support verification".to_string()))
        }
    } else {
        Err((StatusCode::BAD_REQUEST, "Either key_id or public_key required".to_string()))
    }
}

async fn password_hash_handler(
    Json(req): Json<PasswordHashRequest>,
) -> Result<Json<PasswordHashResponse>, (StatusCode, String)> {
    let hash = match req.algorithm {
        PasswordAlgorithm::Bcrypt => hash_password_bcrypt(&req.password)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?,
        PasswordAlgorithm::Argon2 => hash_password_argon2(&req.password)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?,
        PasswordAlgorithm::Scrypt => hash_password_scrypt(&req.password)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?,
    };

    Ok(Json(PasswordHashResponse {
        hash,
        algorithm: format!("{:?}", req.algorithm).to_lowercase(),
    }))
}

async fn password_verify_handler(
    Json(req): Json<PasswordVerifyRequest>,
) -> Result<Json<PasswordVerifyResponse>, (StatusCode, String)> {
    // Auto-detect algorithm from hash format
    let valid = if req.hash.starts_with("$2") {
        verify_password_bcrypt(&req.password, &req.hash)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    } else if req.hash.starts_with("$argon2") {
        verify_password_argon2(&req.password, &req.hash)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    } else if req.hash.starts_with("$scrypt") {
        verify_password_scrypt(&req.password, &req.hash)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    } else {
        return Err((StatusCode::BAD_REQUEST, "Unknown hash format".to_string()));
    };

    Ok(Json(PasswordVerifyResponse { valid }))
}

async fn jwt_create_handler(
    Json(req): Json<JwtCreateRequest>,
) -> Result<Json<JwtCreateResponse>, (StatusCode, String)> {
    let secret = req.secret.unwrap_or_else(|| "default_secret_change_me".to_string());
    let expires_in = req.expires_in.unwrap_or(3600); // 1 hour default

    let token = create_jwt(req.claims, &secret, expires_in)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(JwtCreateResponse { token }))
}

async fn jwt_verify_handler(
    Json(req): Json<JwtVerifyRequest>,
) -> Result<Json<JwtVerifyResponse>, (StatusCode, String)> {
    let secret = req.secret.unwrap_or_else(|| "default_secret_change_me".to_string());

    match verify_jwt(&req.token, &secret) {
        Ok(claims) => Ok(Json(JwtVerifyResponse {
            valid: true,
            claims: Some(claims),
        })),
        Err(_) => Ok(Json(JwtVerifyResponse {
            valid: false,
            claims: None,
        })),
    }
}
