use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};
use serde_json::{json, Value};
use uuid::Uuid;

pub struct WalletManager {
    pool: SqlitePool,
}

impl WalletManager {
    pub async fn new(database_path: &str) -> anyhow::Result<Self> {
        let database_url = format!("sqlite:{}", database_path);
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect(&database_url)
            .await?;

        // Create tables
        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS wallets (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                currency TEXT NOT NULL,
                address TEXT NOT NULL,
                mnemonic TEXT NOT NULL,
                private_key_1 TEXT NOT NULL,
                private_key_2 TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
            "#,
        )
        .execute(&pool)
        .await?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS transactions (
                id TEXT PRIMARY KEY,
                wallet_id TEXT NOT NULL,
                tx_hash TEXT NOT NULL,
                direction TEXT NOT NULL,
                amount TEXT NOT NULL,
                fee TEXT,
                confirmations INTEGER DEFAULT 0,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                address TEXT,
                memo TEXT,
                FOREIGN KEY (wallet_id) REFERENCES wallets(id)
            )
            "#,
        )
        .execute(&pool)
        .await?;

        Ok(Self { pool })
    }

    pub async fn store_wallet(
        &self,
        name: &str,
        currency: &str,
        address: &str,
        mnemonic: &str,
        private_key_1: &str,
        private_key_2: &str,
    ) -> anyhow::Result<String> {
        let id = Uuid::new_v4().to_string();

        sqlx::query(
            r#"
            INSERT INTO wallets (id, name, currency, address, mnemonic, private_key_1, private_key_2)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(name)
        .bind(currency)
        .bind(address)
        .bind(mnemonic)
        .bind(private_key_1)
        .bind(private_key_2)
        .execute(&self.pool)
        .await?;

        Ok(id)
    }

    pub async fn get_wallet(&self, wallet_id: &str) -> anyhow::Result<Value> {
        let row = sqlx::query(
            r#"
            SELECT id, name, currency, address, mnemonic, private_key_1, private_key_2, created_at
            FROM wallets
            WHERE id = ?
            "#,
        )
        .bind(wallet_id)
        .fetch_one(&self.pool)
        .await?;

        Ok(json!({
            "id": row.try_get::<String, _>("id")?,
            "name": row.try_get::<String, _>("name")?,
            "currency": row.try_get::<String, _>("currency")?,
            "address": row.try_get::<String, _>("address")?,
            "mnemonic": row.try_get::<String, _>("mnemonic")?,
            "private_key_1": row.try_get::<String, _>("private_key_1")?,
            "private_key_2": row.try_get::<Option<String>, _>("private_key_2")?,
            "created_at": row.try_get::<String, _>("created_at")?,
        }))
    }

    pub async fn list_wallets(&self) -> anyhow::Result<Vec<Value>> {
        let rows = sqlx::query(
            r#"
            SELECT id, name, currency, address, created_at
            FROM wallets
            ORDER BY created_at DESC
            "#,
        )
        .fetch_all(&self.pool)
        .await?;

        let wallets = rows
            .iter()
            .map(|row| {
                json!({
                    "id": row.try_get::<String, _>("id").ok(),
                    "name": row.try_get::<String, _>("name").ok(),
                    "currency": row.try_get::<String, _>("currency").ok(),
                    "address": row.try_get::<String, _>("address").ok(),
                    "created_at": row.try_get::<String, _>("created_at").ok(),
                })
            })
            .collect();

        Ok(wallets)
    }

    pub async fn store_transaction(
        &self,
        wallet_id: &str,
        tx_hash: &str,
        direction: &str,
        amount: &str,
        fee: Option<&str>,
        address: &str,
        memo: Option<&str>,
    ) -> anyhow::Result<String> {
        let id = Uuid::new_v4().to_string();

        sqlx::query(
            r#"
            INSERT INTO transactions (id, wallet_id, tx_hash, direction, amount, fee, address, memo)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&id)
        .bind(wallet_id)
        .bind(tx_hash)
        .bind(direction)
        .bind(amount)
        .bind(fee)
        .bind(address)
        .bind(memo)
        .execute(&self.pool)
        .await?;

        Ok(id)
    }

    pub async fn get_transactions(&self, wallet_id: &str) -> anyhow::Result<Vec<Value>> {
        let rows = sqlx::query(
            r#"
            SELECT id, tx_hash, direction, amount, fee, confirmations, timestamp, address, memo
            FROM transactions
            WHERE wallet_id = ?
            ORDER BY timestamp DESC
            "#,
        )
        .bind(wallet_id)
        .fetch_all(&self.pool)
        .await?;

        let transactions = rows
            .iter()
            .map(|row| {
                json!({
                    "id": row.try_get::<String, _>("id").ok(),
                    "tx_hash": row.try_get::<String, _>("tx_hash").ok(),
                    "direction": row.try_get::<String, _>("direction").ok(),
                    "amount": row.try_get::<String, _>("amount").ok(),
                    "fee": row.try_get::<Option<String>, _>("fee").ok(),
                    "confirmations": row.try_get::<i32, _>("confirmations").ok(),
                    "timestamp": row.try_get::<String, _>("timestamp").ok(),
                    "address": row.try_get::<String, _>("address").ok(),
                    "memo": row.try_get::<Option<String>, _>("memo").ok(),
                })
            })
            .collect();

        Ok(transactions)
    }

    pub async fn delete_wallet(&self, wallet_id: &str) -> anyhow::Result<()> {
        // Delete transactions first
        sqlx::query("DELETE FROM transactions WHERE wallet_id = ?")
            .bind(wallet_id)
            .execute(&self.pool)
            .await?;

        // Delete wallet
        sqlx::query("DELETE FROM wallets WHERE id = ?")
            .bind(wallet_id)
            .execute(&self.pool)
            .await?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_wallet_storage() {
        let manager = WalletManager::new(":memory:").await.unwrap();

        let wallet_id = manager
            .store_wallet(
                "Test Wallet",
                "XMR",
                "4ABC123",
                "word1 word2 word3",
                "priv_key_1",
                "priv_key_2",
            )
            .await
            .unwrap();

        let wallet = manager.get_wallet(&wallet_id).await.unwrap();
        assert_eq!(wallet["name"], "Test Wallet");
        assert_eq!(wallet["currency"], "XMR");

        let wallets = manager.list_wallets().await.unwrap();
        assert_eq!(wallets.len(), 1);
    }
}
