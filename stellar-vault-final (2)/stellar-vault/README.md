# Stellar Vault — Production Smart Contract Suite

Three production Soroban contracts for ownable, RBAC-secured token storage on Stellar.

**SDK versions (live-verified 2026-06-14):**
- `soroban-sdk = "26.1.0"`
- `soroban-token-sdk = "26.1.0"`
- Rust ≥ 1.84.0 required
- Protocol 26 mainnet (Protocol 27 ships 2026-07-08 — review auth patterns before that date)

---

## Contracts

### 1. `rbac` — Role-Based Access Control

Standalone RBAC registry. Any contract in the system can cross-call it to check roles.

| Role | Privileges |
|---|---|
| Owner | Grant/revoke Admin; two-step transfer; pause/unpause |
| Admin | Grant/revoke Operator; pause/unpause |
| Operator | Protocol-level operations (e.g., vault withdrawals) |

**Key security properties:**
- Re-initialization guard (error #1)
- Two-step owner transfer prevents accidental key loss
- Pause state blocks all downstream operations when combined with `assert_not_paused()`
- All role checks typed (no raw Symbol comparison)

### 2. `token` — SEP-41 Fungible Token

Full SEP-41 interface with owner-controlled mint, burn, transfer, allowances.

| Function | Auth required |
|---|---|
| `initialize` | Owner (deployer) |
| `mint` | Owner |
| `transfer` | `from` address |
| `approve` | `from` address |
| `transfer_from` | `spender` address |
| `burn` | `from` address |
| `burn_from` | `spender` address |

**Key security properties:**
- All arithmetic via `checked_add`/`checked_sub` — overflow panics with error #7
- Allowances stored in temporary storage with `expiration_ledger` (ledger number, not timestamp)
- Expired allowances return 0 — never usable
- Total supply tracked and verified on mint and burn

### 3. `vault` — Owner Token Vault

Multi-token vault. Owner deposits any SAC or SEP-41 token; withdrawals are gated by owner
or delegated operators.

| Function | Auth required |
|---|---|
| `initialize` | Owner |
| `deposit` | Depositor (any address) |
| `withdraw` | Owner, global operator, or per-token operator |
| `emergency_withdraw` | Owner only |
| `grant_operator` | Owner |
| `revoke_operator` | Owner |
| `grant_token_operator` | Owner |
| `revoke_token_operator` | Owner |
| `propose_owner` | Owner |
| `accept_owner` | Pending owner |

**Key security properties:**
- Checks-Effects-Interactions: vault balance updated BEFORE every external token transfer
- Two-step owner transfer
- Per-token operator scope (narrower than global operator)
- Emergency withdraw bypasses all operator delegation — owner-only escape hatch
- Zero-balance emergency withdraw panics with error #4

---

## Build

```bash
# Install toolchain (once)
rustup target add wasm32-unknown-unknown
cargo install --locked stellar-cli --version 26.1.0

# Build all contracts
stellar contract build

# Optimize (mandatory — contracts must stay under 64 KB)
stellar contract optimize --wasm target/wasm32-unknown-unknown/release/rbac.wasm
stellar contract optimize --wasm target/wasm32-unknown-unknown/release/token.wasm
stellar contract optimize --wasm target/wasm32-unknown-unknown/release/vault.wasm

# Run all tests
cargo test
```

---

## Deploy Order

Deploy in this order — vault and token reference RBAC by address.

```bash
# 1. Deploy RBAC
RBAC_ID=$(stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/rbac.optimized.wasm \
  --source alice \
  --network testnet)

stellar contract invoke --id $RBAC_ID --source alice --network testnet \
  -- initialize --owner <OWNER_ADDRESS>

# 2. Deploy Token
TOKEN_ID=$(stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/token.optimized.wasm \
  --source alice \
  --network testnet)

stellar contract invoke --id $TOKEN_ID --source alice --network testnet \
  -- initialize \
    --owner <OWNER_ADDRESS> \
    --name "VaultToken" \
    --symbol "VTK" \
    --decimals 7 \
    --initial_supply 1000000000

# 3. Deploy Vault
VAULT_ID=$(stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/vault.optimized.wasm \
  --source alice \
  --network testnet)

stellar contract invoke --id $VAULT_ID --source alice --network testnet \
  -- initialize --owner <OWNER_ADDRESS>
```

---

## Typical Vault Usage

```bash
# Owner approves vault to spend their tokens (on the token contract)
stellar contract invoke --id $TOKEN_ID --source alice --network testnet \
  -- approve \
    --from <OWNER_ADDRESS> \
    --spender $VAULT_ID \
    --amount 500000 \
    --expiration_ledger 9999999

# Deposit into vault
stellar contract invoke --id $VAULT_ID --source alice --network testnet \
  -- deposit \
    --depositor <OWNER_ADDRESS> \
    --token_address $TOKEN_ID \
    --amount 500000

# Check vault balance
stellar contract invoke --id $VAULT_ID --network testnet \
  -- vault_balance --token_address $TOKEN_ID

# Withdraw
stellar contract invoke --id $VAULT_ID --source alice --network testnet \
  -- withdraw \
    --caller <OWNER_ADDRESS> \
    --token_address $TOKEN_ID \
    --to <RECIPIENT_ADDRESS> \
    --amount 100000
```

---

## Security Audit Status

- [ ] Internal review complete
- [ ] Threat model documented
- [ ] Fuzz testing run with Stellar's official fuzzer
- [ ] Bytecode hash verified post-deploy
- [ ] Submit to [Stellar Soroban Security Audit Bank](https://stellar.org/audit-bank) before mainnet TVL > $10K

---

## Error Codes

| Contract | Code | Meaning |
|---|---|---|
| rbac | 1 | AlreadyInitialized |
| rbac | 2 | Unauthorized |
| rbac | 3 | NoPendingTransfer |
| rbac | 4 | InvalidAddress |
| rbac | 5 | Paused |
| token | 1 | AlreadyInitialized |
| token | 2 | Unauthorized |
| token | 3 | InsufficientBalance |
| token | 4 | InsufficientAllowance |
| token | 5 | AllowanceExpired |
| token | 6 | InvalidAmount |
| token | 7 | Overflow |
| vault | 1 | AlreadyInitialized |
| vault | 2 | Unauthorized |
| vault | 3 | InvalidAmount |
| vault | 4 | InsufficientVaultBalance |
| vault | 5 | NoPendingTransfer |
| vault | 6 | TokenNotRegistered |
| vault | 7 | Overflow |
