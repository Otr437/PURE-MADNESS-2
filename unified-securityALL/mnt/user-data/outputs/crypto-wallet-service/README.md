# Cryptocurrency Wallet Service - XMR & ZEC

A production-ready cryptocurrency wallet microservice supporting **Monero (XMR)** and **Zcash (ZEC)** with full wallet management, transaction handling, and blockchain interaction.

## 🪙 Supported Cryptocurrencies

### Monero (XMR)
- **Privacy**: Ring signatures, stealth addresses, RingCT
- **Wallets**: Standard, subaddresses, integrated addresses
- **Transactions**: Private by default
- **Current Price**: ~$468 USD

### Zcash (ZEC)
- **Privacy**: Optional shielded transactions (Sapling/Orchard)
- **Wallets**: Transparent (t-addr) and Shielded (z-addr)
- **Transactions**: Transparent and private options
- **Current Price**: ~$370 USD

## 🚀 Features

### Wallet Management
✅ Create new wallets with BIP39 mnemonics  
✅ Import/restore wallets from seed phrases  
✅ Multiple wallet support  
✅ Encrypted storage  
✅ Address generation (standard, integrated, shielded)  

### Transactions
✅ Send XMR with ring signatures  
✅ Send ZEC (transparent and shielded)  
✅ Transaction history tracking  
✅ Fee estimation  
✅ Confirmations monitoring  

### Privacy Features
✅ **Monero**: Automatic ring signatures and stealth addresses  
✅ **Zcash**: Shielded transaction support  
✅ Payment ID support (XMR)  
✅ Memo field support  

### Additional Features
✅ Real-time balance checking  
✅ Exchange rate integration  
✅ Address validation  
✅ Subaddress generation (XMR)  
✅ Transparent-to-shielded conversion (ZEC)  

## 📋 Quick Start

### Using Docker

```bash
docker build -t crypto-wallet-service .
docker run -p 8082:8082 crypto-wallet-service
```

### Build from Source

```bash
cargo build --release
./target/release/crypto-wallet-service
```

### Test It

```bash
# Create a Monero wallet
curl -X POST http://localhost:8082/wallets/create \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My XMR Wallet",
    "currency": "xmr"
  }'

# Create a Zcash wallet
curl -X POST http://localhost:8082/wallets/create \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My ZEC Wallet",
    "currency": "zec"
  }'
```

## 📖 API Documentation

### Base URL
```
http://localhost:8082
```

---

## Wallet Operations

### 1. Create Wallet

Create a new cryptocurrency wallet with a generated seed phrase.

**Endpoint:** `POST /wallets/create`

**Request:**
```json
{
  "name": "My Monero Wallet",
  "currency": "xmr",
  "password": "optional_encryption_password"
}
```

**Response:**
```json
{
  "wallet_id": "550e8400-e29b-41d4-a716-446655440000",
  "currency": "XMR",
  "address": "4ABC123...",
  "mnemonic": "word1 word2 word3 ... word25",
  "created_at": "2026-01-29T12:00:00Z"
}
```

**⚠️ IMPORTANT:** Save the mnemonic phrase securely! This is the only way to recover your wallet.

---

### 2. Import/Restore Wallet

Restore a wallet from a seed phrase.

**Endpoint:** `POST /wallets/import`

**Request:**
```json
{
  "name": "Restored Wallet",
  "currency": "xmr",
  "mnemonic": "word1 word2 word3 ...",
  "password": "optional"
}
```

**Response:** Same as create wallet

---

### 3. List Wallets

Get all wallets.

**Endpoint:** `GET /wallets/list`

**Response:**
```json
[
  {
    "id": "wallet-id-1",
    "name": "My XMR Wallet",
    "currency": "XMR",
    "address": "4ABC...",
    "created_at": "2026-01-29T12:00:00Z"
  },
  {
    "id": "wallet-id-2",
    "name": "My ZEC Wallet",
    "currency": "ZEC",
    "address": "t1DEF...",
    "created_at": "2026-01-29T13:00:00Z"
  }
]
```

---

### 4. Get Wallet Details

**Endpoint:** `GET /wallets/{wallet_id}`

**Response:**
```json
{
  "id": "wallet-id",
  "name": "My Wallet",
  "currency": "XMR",
  "address": "4ABC...",
  "mnemonic": "word1 word2...",
  "created_at": "2026-01-29T12:00:00Z"
}
```

---

### 5. Get Balance

**Endpoint:** `GET /wallets/{wallet_id}/balance`

**Response (Monero):**
```json
{
  "wallet_id": "wallet-id",
  "currency": "XMR",
  "balance": "1.500000000000",
  "available_balance": "1.200000000000",
  "pending_balance": "0.300000000000",
  "address": "4ABC..."
}
```

**Response (Zcash):**
```json
{
  "wallet_id": "wallet-id",
  "currency": "ZEC",
  "balance": "5.50000000",
  "available_balance": "4.00000000",
  "pending_balance": "1.50000000",
  "address": "t1DEF..."
}
```

---

### 6. Get Wallet Address

**Endpoint:** `GET /wallets/{wallet_id}/address`

**Response:**
```json
{
  "wallet_id": "wallet-id",
  "address": "4ABC...",
  "currency": "XMR"
}
```

---

## Transaction Operations

### 7. Send Transaction

Send cryptocurrency to another address.

**Endpoint:** `POST /transactions/send`

**Request:**
```json
{
  "wallet_id": "wallet-id",
  "to_address": "recipient_address",
  "amount": "0.5",
  "password": "wallet_password",
  "fee": "0.0001",
  "memo": "Payment for services"
}
```

**Response:**
```json
{
  "tx_id": "abc123def456...",
  "from_address": "your_address",
  "to_address": "recipient_address",
  "amount": "0.5",
  "fee": "0.0001",
  "status": "pending",
  "timestamp": "2026-01-29T14:30:00Z"
}
```

---

### 8. Get Transaction History

**Endpoint:** `GET /wallets/{wallet_id}/transactions`

**Response:**
```json
{
  "transactions": [
    {
      "tx_id": "abc123...",
      "direction": "sent",
      "amount": "0.5",
      "fee": "0.0001",
      "confirmations": 10,
      "timestamp": "2026-01-29T14:30:00Z",
      "address": "recipient_address",
      "memo": "Payment"
    },
    {
      "tx_id": "def456...",
      "direction": "received",
      "amount": "1.0",
      "fee": null,
      "confirmations": 25,
      "timestamp": "2026-01-28T10:00:00Z",
      "address": "sender_address",
      "memo": null
    }
  ],
  "total_count": 2
}
```

---

### 9. Get Transaction Details

**Endpoint:** `GET /transactions/{tx_id}`

**Response:**
```json
{
  "tx_id": "abc123...",
  "status": "confirmed",
  "confirmations": 15,
  "block_height": 3000000,
  "timestamp": "2026-01-29T14:30:00Z"
}
```

---

## Address Operations

### 10. Validate Address

Check if an address is valid for a specific currency.

**Endpoint:** `POST /addresses/validate`

**Request:**
```json
{
  "address": "4ABC123...",
  "currency": "xmr"
}
```

**Response:**
```json
{
  "valid": true,
  "currency": "XMR",
  "address_type": "standard"
}
```

---

## Exchange Rates

### 11. Get Exchange Rate

**Endpoint:** `GET /rates/{currency}`

**Response:**
```json
{
  "currency": "XMR",
  "usd": "468.50",
  "btc": "0.0051",
  "timestamp": "2026-01-29T15:00:00Z"
}
```

---

### 12. Get All Rates

**Endpoint:** `GET /rates`

**Response:**
```json
{
  "XMR": {
    "usd": "468.50",
    "btc": "0.0051"
  },
  "ZEC": {
    "usd": "370.20",
    "btc": "0.0040"
  },
  "timestamp": "2026-01-29T15:00:00Z"
}
```

---

## Monero-Specific Features

### 13. Create Integrated Address

Create a Monero integrated address with payment ID.

**Endpoint:** `POST /monero/integrated-address`

**Request:**
```json
{
  "wallet_id": "wallet-id",
  "payment_id": "abc123..."
}
```

**Response:**
```json
{
  "integrated_address": "4...",
  "payment_id": "abc123..."
}
```

---

### 14. List Subaddresses

Get all subaddresses for a Monero wallet.

**Endpoint:** `GET /monero/subaddresses/{wallet_id}`

**Response:**
```json
{
  "subaddresses": [
    {
      "index": 0,
      "address": "8ABC...",
      "label": "Main",
      "used": true
    },
    {
      "index": 1,
      "address": "8DEF...",
      "label": "Savings",
      "used": false
    }
  ]
}
```

---

## Zcash-Specific Features

### 15. Get Shielded Balance

Get the shielded (z-address) balance.

**Endpoint:** `GET /zcash/shielded-balance/{wallet_id}`

**Response:**
```json
{
  "shielded_balance": "2.50000000",
  "transparent_balance": "1.00000000"
}
```

---

### 16. Shield Funds

Move funds from transparent to shielded pool.

**Endpoint:** `POST /zcash/shield`

**Request:**
```json
{
  "wallet_id": "wallet-id",
  "amount": "1.0",
  "from_address": "t1ABC...",
  "to_shielded_address": "zs1DEF..."
}
```

**Response:**
```json
{
  "tx_id": "shielding_tx_id",
  "status": "pending"
}
```

---

## 🔒 Security Best Practices

### Wallet Security
1. **Never share private keys or seed phrases**
2. **Use strong passwords** for wallet encryption
3. **Backup seed phrases** in multiple secure locations
4. **Use hardware wallets** for large amounts
5. **Verify addresses** before sending

### Privacy Best Practices

#### Monero
- Monero is private by default
- Use subaddresses for different purposes
- Avoid address reuse for maximum privacy

#### Zcash
- Use shielded addresses (z-addresses) for privacy
- Shield funds regularly from transparent addresses
- Transparent addresses leak privacy like Bitcoin

### Transaction Security
1. **Double-check recipient addresses**
2. **Start with small test transactions**
3. **Wait for confirmations** (10+ for XMR, 6+ for ZEC)
4. **Use appropriate fees** to avoid stuck transactions
5. **Keep software updated**

---

## 💡 Examples

### Complete Workflow: Monero

```bash
# 1. Create wallet
WALLET=$(curl -X POST http://localhost:8082/wallets/create \
  -H "Content-Type: application/json" \
  -d '{"name":"My XMR","currency":"xmr"}')

WALLET_ID=$(echo $WALLET | jq -r '.wallet_id')
echo "Wallet ID: $WALLET_ID"
echo "Address: $(echo $WALLET | jq -r '.address')"
echo "Mnemonic: $(echo $WALLET | jq -r '.mnemonic')"

# 2. Check balance
curl http://localhost:8082/wallets/$WALLET_ID/balance

# 3. Send transaction
curl -X POST http://localhost:8082/transactions/send \
  -H "Content-Type: application/json" \
  -d "{
    \"wallet_id\": \"$WALLET_ID\",
    \"to_address\": \"4recipient_address\",
    \"amount\": \"0.1\"
  }"

# 4. Check transaction history
curl http://localhost:8082/wallets/$WALLET_ID/transactions
```

### Complete Workflow: Zcash

```bash
# 1. Create wallet
WALLET=$(curl -X POST http://localhost:8082/wallets/create \
  -H "Content-Type: application/json" \
  -d '{"name":"My ZEC","currency":"zec"}')

WALLET_ID=$(echo $WALLET | jq -r '.wallet_id')

# 2. Get shielded balance
curl http://localhost:8082/zcash/shielded-balance/$WALLET_ID

# 3. Shield funds (move to private pool)
curl -X POST http://localhost:8082/zcash/shield \
  -H "Content-Type: application/json" \
  -d "{
    \"wallet_id\": \"$WALLET_ID\",
    \"amount\": \"1.0\"
  }"
```

---

## 🏗️ Architecture

```
┌────────────────────────────────────┐
│     API Layer (Axum)               │
│  - REST endpoints                  │
│  - Request validation              │
│  - Response formatting             │
└─────────┬──────────────────────────┘
          │
┌─────────┴──────────────────────────┐
│   Wallet Management Layer          │
│  - Wallet creation/restoration     │
│  - Key derivation (BIP39)          │
│  - Address generation              │
│  - Transaction building            │
└─────────┬──────────────────────────┘
          │
┌─────────┴──────────────────────────┐
│   Blockchain Clients               │
│  ┌──────────┐    ┌──────────┐     │
│  │ Monero   │    │ Zcash    │     │
│  │ RPC      │    │ RPC      │     │
│  └──────────┘    └──────────┘     │
└─────────┬──────────────────────────┘
          │
┌─────────┴──────────────────────────┐
│   Storage Layer (SQLite)           │
│  - Wallet metadata                 │
│  - Transaction history             │
│  - Encrypted keys                  │
└────────────────────────────────────┘
```

---

## 🔧 Configuration

Create `config.toml`:

```toml
[server]
port = 8082
host = "0.0.0.0"

[database]
path = "wallets.db"

[monero]
rpc_url = "http://localhost:18081"
testnet = false

[zcash]
rpc_url = "http://localhost:8232"
testnet = false

[security]
encrypt_keys = true
require_password = true
```

---

## 📊 Comparison: XMR vs ZEC

| Feature | Monero (XMR) | Zcash (ZEC) |
|---------|--------------|-------------|
| **Privacy** | Mandatory | Optional |
| **Technology** | Ring signatures, RingCT | zk-SNARKs |
| **Traceability** | Not traceable | Traceable if using t-addresses |
| **Supply** | Infinite (tail emission) | 21M fixed |
| **Block Time** | ~2 minutes | ~75 seconds |
| **Address Types** | Standard, integrated, subaddress | Transparent, Shielded (Sapling/Orchard) |
| **Typical Fee** | ~$0.01-0.05 | ~$0.001-0.01 |
| **Best For** | Maximum privacy | Selective disclosure |

---

## 🐳 Docker Deployment

```dockerfile
FROM rust:1.85-slim as builder
WORKDIR /usr/src/app
COPY . .
RUN cargo build --release

FROM debian:bookworm-slim
COPY --from=builder /usr/src/app/target/release/crypto-wallet-service /usr/local/bin/
EXPOSE 8082
CMD ["crypto-wallet-service"]
```

```bash
docker build -t crypto-wallet-service .
docker run -d -p 8082:8082 \
  -v $(pwd)/wallets.db:/app/wallets.db \
  crypto-wallet-service
```

---

## 🧪 Testing

```bash
# Run all tests
cargo test

# Test Monero wallet creation
cargo test monero_wallet

# Test Zcash wallet creation
cargo test zcash_wallet

# Integration tests
./test_wallet.sh
```

---

## 📝 License

Apache 2.0

---

## ⚠️ Disclaimer

This software is for educational and development purposes. Always:
- Test with small amounts first
- Verify all transactions
- Keep backups of seed phrases
- Use at your own risk

**Not financial advice. Cryptocurrency investments carry risk.**
