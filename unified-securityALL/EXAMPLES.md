# Integration Examples

## Python

### Setup
```bash
pip install requests
```

### Complete Example
```python
import requests
import json

CRYPTO_SERVICE = "http://localhost:8081"

class CryptoClient:
    def __init__(self, base_url=CRYPTO_SERVICE):
        self.base_url = base_url
    
    def encrypt_aes(self, data):
        """Encrypt data with AES-256-GCM"""
        response = requests.post(f"{self.base_url}/encrypt", json={
            "data": data,
            "algorithm": "aes-256-gcm"
        })
        return response.json()
    
    def decrypt_aes(self, encrypted, nonce, key):
        """Decrypt AES-256-GCM encrypted data"""
        response = requests.post(f"{self.base_url}/decrypt", json={
            "encrypted": encrypted,
            "nonce": nonce,
            "key": key,
            "algorithm": "aes-256-gcm"
        })
        return response.json()["data"]
    
    def hash_password(self, password, algorithm="bcrypt"):
        """Hash a password"""
        response = requests.post(f"{self.base_url}/password/hash", json={
            "password": password,
            "algorithm": algorithm
        })
        return response.json()["hash"]
    
    def verify_password(self, password, hash):
        """Verify a password against a hash"""
        response = requests.post(f"{self.base_url}/password/verify", json={
            "password": password,
            "hash": hash
        })
        return response.json()["valid"]
    
    def create_jwt(self, claims, secret, expires_in=3600):
        """Create a JWT token"""
        response = requests.post(f"{self.base_url}/jwt/create", json={
            "claims": claims,
            "secret": secret,
            "expires_in": expires_in
        })
        return response.json()["token"]
    
    def verify_jwt(self, token, secret):
        """Verify a JWT token"""
        response = requests.post(f"{self.base_url}/jwt/verify", json={
            "token": token,
            "secret": secret
        })
        result = response.json()
        return result["valid"], result.get("claims")
    
    def hash_data(self, data, algorithm="sha256"):
        """Hash data"""
        response = requests.post(f"{self.base_url}/hash", json={
            "data": data,
            "algorithm": algorithm
        })
        return response.json()["hash"]
    
    def generate_key(self, algorithm="aes-256"):
        """Generate a cryptographic key"""
        response = requests.post(f"{self.base_url}/keys/generate", json={
            "algorithm": algorithm
        })
        return response.json()

# Usage examples
if __name__ == "__main__":
    client = CryptoClient()
    
    # Password hashing
    print("=== Password Hashing ===")
    password = "my_secure_password"
    hashed = client.hash_password(password)
    print(f"Hash: {hashed[:50]}...")
    print(f"Verify correct: {client.verify_password(password, hashed)}")
    print(f"Verify wrong: {client.verify_password('wrong', hashed)}")
    
    # JWT tokens
    print("\n=== JWT Tokens ===")
    claims = {"user_id": 123, "role": "admin"}
    token = client.create_jwt(claims, "my_secret")
    print(f"Token: {token[:50]}...")
    valid, decoded = client.verify_jwt(token, "my_secret")
    print(f"Valid: {valid}")
    print(f"Claims: {decoded}")
    
    # Hashing
    print("\n=== Hashing ===")
    data = "Hello, World!"
    sha256 = client.hash_data(data, "sha256")
    blake3 = client.hash_data(data, "blake3")
    print(f"SHA-256: {sha256}")
    print(f"BLAKE3: {blake3}")
    
    # Encryption
    print("\n=== Encryption ===")
    result = client.encrypt_aes("Secret message")
    print(f"Encrypted: {result['encrypted'][:50]}...")
    print(f"Nonce: {result['nonce']}")
```

---

## JavaScript/Node.js

### Setup
```bash
npm install axios
```

### Complete Example
```javascript
const axios = require('axios');

const CRYPTO_SERVICE = 'http://localhost:8081';

class CryptoClient {
  constructor(baseUrl = CRYPTO_SERVICE) {
    this.baseUrl = baseUrl;
  }

  async encryptAES(data) {
    const response = await axios.post(`${this.baseUrl}/encrypt`, {
      data,
      algorithm: 'aes-256-gcm'
    });
    return response.data;
  }

  async decryptAES(encrypted, nonce, key) {
    const response = await axios.post(`${this.baseUrl}/decrypt`, {
      encrypted,
      nonce,
      key,
      algorithm: 'aes-256-gcm'
    });
    return response.data.data;
  }

  async hashPassword(password, algorithm = 'bcrypt') {
    const response = await axios.post(`${this.baseUrl}/password/hash`, {
      password,
      algorithm
    });
    return response.data.hash;
  }

  async verifyPassword(password, hash) {
    const response = await axios.post(`${this.baseUrl}/password/verify`, {
      password,
      hash
    });
    return response.data.valid;
  }

  async createJWT(claims, secret, expiresIn = 3600) {
    const response = await axios.post(`${this.baseUrl}/jwt/create`, {
      claims,
      secret,
      expires_in: expiresIn
    });
    return response.data.token;
  }

  async verifyJWT(token, secret) {
    const response = await axios.post(`${this.baseUrl}/jwt/verify`, {
      token,
      secret
    });
    return {
      valid: response.data.valid,
      claims: response.data.claims
    };
  }

  async hashData(data, algorithm = 'sha256') {
    const response = await axios.post(`${this.baseUrl}/hash`, {
      data,
      algorithm
    });
    return response.data.hash;
  }

  async generateKey(algorithm = 'aes-256') {
    const response = await axios.post(`${this.baseUrl}/keys/generate`, {
      algorithm
    });
    return response.data;
  }

  async signData(data, keyId) {
    const response = await axios.post(`${this.baseUrl}/sign`, {
      data,
      key_id: keyId
    });
    return response.data.signature;
  }

  async verifySignature(data, signature, publicKey) {
    const response = await axios.post(`${this.baseUrl}/verify`, {
      data,
      signature,
      public_key: publicKey
    });
    return response.data.valid;
  }
}

// Usage examples
async function main() {
  const client = new CryptoClient();

  // Password hashing
  console.log('=== Password Hashing ===');
  const password = 'my_secure_password';
  const hashed = await client.hashPassword(password);
  console.log(`Hash: ${hashed.substring(0, 50)}...`);
  console.log(`Verify correct: ${await client.verifyPassword(password, hashed)}`);
  console.log(`Verify wrong: ${await client.verifyPassword('wrong', hashed)}`);

  // JWT tokens
  console.log('\n=== JWT Tokens ===');
  const claims = { user_id: 123, role: 'admin' };
  const token = await client.createJWT(claims, 'my_secret');
  console.log(`Token: ${token.substring(0, 50)}...`);
  const { valid, claims: decoded } = await client.verifyJWT(token, 'my_secret');
  console.log(`Valid: ${valid}`);
  console.log(`Claims:`, decoded);

  // Encryption
  console.log('\n=== Encryption ===');
  const encrypted = await client.encryptAES('Secret message');
  console.log(`Encrypted: ${encrypted.encrypted.substring(0, 50)}...`);
  console.log(`Nonce: ${encrypted.nonce}`);

  // Digital signatures
  console.log('\n=== Digital Signatures ===');
  const keyPair = await client.generateKey('ed25519');
  console.log(`Key ID: ${keyPair.key_id}`);
  const signature = await client.signData('Important message', keyPair.key_id);
  console.log(`Signature: ${signature.substring(0, 50)}...`);
  const sigValid = await client.verifySignature('Important message', signature, keyPair.public_key);
  console.log(`Signature valid: ${sigValid}`);
}

main().catch(console.error);
```

---

## Go

### Complete Example
```go
package main

import (
    "bytes"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
)

const CryptoService = "http://localhost:8081"

type CryptoClient struct {
    BaseURL string
}

func NewCryptoClient(baseURL string) *CryptoClient {
    return &CryptoClient{BaseURL: baseURL}
}

func (c *CryptoClient) post(endpoint string, payload interface{}) (map[string]interface{}, error) {
    jsonData, err := json.Marshal(payload)
    if err != nil {
        return nil, err
    }

    resp, err := http.Post(
        c.BaseURL+endpoint,
        "application/json",
        bytes.NewBuffer(jsonData),
    )
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    body, err := io.ReadAll(resp.Body)
    if err != nil {
        return nil, err
    }

    var result map[string]interface{}
    if err := json.Unmarshal(body, &result); err != nil {
        return nil, err
    }

    return result, nil
}

func (c *CryptoClient) HashPassword(password, algorithm string) (string, error) {
    payload := map[string]string{
        "password":  password,
        "algorithm": algorithm,
    }

    result, err := c.post("/password/hash", payload)
    if err != nil {
        return "", err
    }

    return result["hash"].(string), nil
}

func (c *CryptoClient) VerifyPassword(password, hash string) (bool, error) {
    payload := map[string]string{
        "password": password,
        "hash":     hash,
    }

    result, err := c.post("/password/verify", payload)
    if err != nil {
        return false, err
    }

    return result["valid"].(bool), nil
}

func (c *CryptoClient) CreateJWT(claims map[string]interface{}, secret string, expiresIn int) (string, error) {
    payload := map[string]interface{}{
        "claims":     claims,
        "secret":     secret,
        "expires_in": expiresIn,
    }

    result, err := c.post("/jwt/create", payload)
    if err != nil {
        return "", err
    }

    return result["token"].(string), nil
}

func (c *CryptoClient) VerifyJWT(token, secret string) (bool, map[string]interface{}, error) {
    payload := map[string]string{
        "token":  token,
        "secret": secret,
    }

    result, err := c.post("/jwt/verify", payload)
    if err != nil {
        return false, nil, err
    }

    valid := result["valid"].(bool)
    claims, _ := result["claims"].(map[string]interface{})

    return valid, claims, nil
}

func (c *CryptoClient) HashData(data, algorithm string) (string, error) {
    payload := map[string]string{
        "data":      data,
        "algorithm": algorithm,
    }

    result, err := c.post("/hash", payload)
    if err != nil {
        return "", err
    }

    return result["hash"].(string), nil
}

func main() {
    client := NewCryptoClient(CryptoService)

    // Password hashing
    fmt.Println("=== Password Hashing ===")
    password := "my_secure_password"
    hashed, _ := client.HashPassword(password, "bcrypt")
    fmt.Printf("Hash: %s...\n", hashed[:50])
    
    valid, _ := client.VerifyPassword(password, hashed)
    fmt.Printf("Verify correct: %v\n", valid)
    
    invalid, _ := client.VerifyPassword("wrong", hashed)
    fmt.Printf("Verify wrong: %v\n", invalid)

    // JWT tokens
    fmt.Println("\n=== JWT Tokens ===")
    claims := map[string]interface{}{
        "user_id": 123,
        "role":    "admin",
    }
    token, _ := client.CreateJWT(claims, "my_secret", 3600)
    fmt.Printf("Token: %s...\n", token[:50])
    
    tokenValid, decoded, _ := client.VerifyJWT(token, "my_secret")
    fmt.Printf("Valid: %v\n", tokenValid)
    fmt.Printf("Claims: %v\n", decoded)

    // Hashing
    fmt.Println("\n=== Hashing ===")
    sha256, _ := client.HashData("Hello, World!", "sha256")
    blake3, _ := client.HashData("Hello, World!", "blake3")
    fmt.Printf("SHA-256: %s\n", sha256)
    fmt.Printf("BLAKE3: %s\n", blake3)
}
```

---

## Rust

### Cargo.toml
```toml
[dependencies]
reqwest = { version = "0.12", features = ["json"] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
tokio = { version = "1", features = ["full"] }
```

### Complete Example
```rust
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;

const CRYPTO_SERVICE: &str = "http://localhost:8081";

struct CryptoClient {
    client: Client,
    base_url: String,
}

impl CryptoClient {
    fn new(base_url: &str) -> Self {
        Self {
            client: Client::new(),
            base_url: base_url.to_string(),
        }
    }

    async fn hash_password(&self, password: &str, algorithm: &str) -> Result<String, Box<dyn std::error::Error>> {
        let response = self.client
            .post(&format!("{}/password/hash", self.base_url))
            .json(&json!({
                "password": password,
                "algorithm": algorithm
            }))
            .send()
            .await?
            .json::<HashMap<String, String>>()
            .await?;

        Ok(response.get("hash").unwrap().clone())
    }

    async fn verify_password(&self, password: &str, hash: &str) -> Result<bool, Box<dyn std::error::Error>> {
        let response = self.client
            .post(&format!("{}/password/verify", self.base_url))
            .json(&json!({
                "password": password,
                "hash": hash
            }))
            .send()
            .await?
            .json::<HashMap<String, bool>>()
            .await?;

        Ok(*response.get("valid").unwrap())
    }

    async fn create_jwt(&self, claims: serde_json::Value, secret: &str, expires_in: i64) -> Result<String, Box<dyn std::error::Error>> {
        let response = self.client
            .post(&format!("{}/jwt/create", self.base_url))
            .json(&json!({
                "claims": claims,
                "secret": secret,
                "expires_in": expires_in
            }))
            .send()
            .await?
            .json::<HashMap<String, String>>()
            .await?;

        Ok(response.get("token").unwrap().clone())
    }

    async fn hash_data(&self, data: &str, algorithm: &str) -> Result<String, Box<dyn std::error::Error>> {
        let response = self.client
            .post(&format!("{}/hash", self.base_url))
            .json(&json!({
                "data": data,
                "algorithm": algorithm
            }))
            .send()
            .await?
            .json::<HashMap<String, String>>()
            .await?;

        Ok(response.get("hash").unwrap().clone())
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = CryptoClient::new(CRYPTO_SERVICE);

    // Password hashing
    println!("=== Password Hashing ===");
    let password = "my_secure_password";
    let hashed = client.hash_password(password, "bcrypt").await?;
    println!("Hash: {}...", &hashed[..50]);
    
    let valid = client.verify_password(password, &hashed).await?;
    println!("Verify correct: {}", valid);
    
    let invalid = client.verify_password("wrong", &hashed).await?;
    println!("Verify wrong: {}", invalid);

    // JWT tokens
    println!("\n=== JWT Tokens ===");
    let claims = json!({
        "user_id": 123,
        "role": "admin"
    });
    let token = client.create_jwt(claims, "my_secret", 3600).await?;
    println!("Token: {}...", &token[..50]);

    // Hashing
    println!("\n=== Hashing ===");
    let sha256 = client.hash_data("Hello, World!", "sha256").await?;
    let blake3 = client.hash_data("Hello, World!", "blake3").await?;
    println!("SHA-256: {}", sha256);
    println!("BLAKE3: {}", blake3);

    Ok(())
}
```
