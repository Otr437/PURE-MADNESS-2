use axum::{
    extract::{Json, Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use std::{net::SocketAddr, sync::Arc};
use tracing::{info, error};

mod monero_wallet;
mod zcash_wallet;
mod wallet_manager;
mod blockchain_client;
mod transaction_builder;
mod address_generator;

use monero_wallet::*;
use zcash_wallet::*;
use wallet_manager::*;
use blockchain_client::*;
use transaction_builder::*;
use address_generator::*;

// ==================== STATE ====================

#[derive(Clone)]
pub struct AppState {
    pub wallet_manager: Arc<WalletManager>,
    pub monero_client: Arc<MoneroClient>,
    pub zcash_client: Arc<ZcashClient>,
}

// ==================== REQUEST/RESPONSE TYPES ====================

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateWalletRequest {
    pub name: String,
    pub currency: Currency,
    pub password: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateWalletResponse {
    pub wallet_id: String,
    pub currency: String,
    pub address: String,
    pub mnemonic: String,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ImportWalletRequest {
    pub name: String,
    pub currency: Currency,
    pub mnemonic: String,
    pub password: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GetBalanceResponse {
    pub wallet_id: String,
    pub currency: String,
    pub balance: String,
    pub available_balance: String,
    pub pending_balance: String,
    pub address: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SendTransactionRequest {
    pub wallet_id: String,
    pub to_address: String,
    pub amount: String,
    pub password: Option<String>,
    pub fee: Option<String>,
    pub memo: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SendTransactionResponse {
    pub tx_id: String,
    pub from_address: String,
    pub to_address: String,
    pub amount: String,
    pub fee: String,
    pub status: String,
    pub timestamp: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TransactionHistoryResponse {
    pub transactions: Vec<TransactionInfo>,
    pub total_count: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TransactionInfo {
    pub tx_id: String,
    pub direction: String, // "sent" or "received"
    pub amount: String,
    pub fee: Option<String>,
    pub confirmations: u32,
    pub timestamp: String,
    pub address: String,
    pub memo: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ValidateAddressRequest {
    pub address: String,
    pub currency: Currency,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ValidateAddressResponse {
    pub valid: bool,
    pub currency: String,
    pub address_type: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ExchangeRateResponse {
    pub currency: String,
    pub usd: String,
    pub btc: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Currency {
    #[serde(rename = "xmr")]
    Monero,
    #[serde(rename = "zec")]
    Zcash,
}

impl Currency {
    fn as_str(&self) -> &str {
        match self {
            Currency::Monero => "XMR",
            Currency::Zcash => "ZEC",
        }
    }
}

// ==================== MAIN ====================

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter("crypto_wallet_service=debug")
        .json()
        .init();

    info!("Starting Crypto Wallet Service v1.0.0");

    // Initialize components
    let wallet_manager = Arc::new(WalletManager::new("wallets.db").await?);
    let monero_client = Arc::new(MoneroClient::new());
    let zcash_client = Arc::new(ZcashClient::new());

    let state = AppState {
        wallet_manager,
        monero_client,
        zcash_client,
    };

    // Build router
    let app = Router::new()
        // Health & Info
        .route("/health", get(health_check))
        .route("/currencies", get(list_currencies))
        
        // Wallet Management
        .route("/wallets/create", post(create_wallet_handler))
        .route("/wallets/import", post(import_wallet_handler))
        .route("/wallets/list", get(list_wallets_handler))
        .route("/wallets/:wallet_id", get(get_wallet_handler))
        .route("/wallets/:wallet_id/balance", get(get_balance_handler))
        .route("/wallets/:wallet_id/address", get(get_address_handler))
        
        // Transactions
        .route("/transactions/send", post(send_transaction_handler))
        .route("/wallets/:wallet_id/transactions", get(get_transaction_history_handler))
        .route("/transactions/:tx_id", get(get_transaction_handler))
        
        // Address Validation
        .route("/addresses/validate", post(validate_address_handler))
        
        // Exchange Rates
        .route("/rates/:currency", get(get_exchange_rate_handler))
        .route("/rates", get(get_all_rates_handler))
        
        // Monero Specific
        .route("/monero/integrated-address", post(create_monero_integrated_address))
        .route("/monero/subaddresses/:wallet_id", get(list_monero_subaddresses))
        
        // Zcash Specific
        .route("/zcash/shielded-balance/:wallet_id", get(get_zcash_shielded_balance))
        .route("/zcash/shield", post(shield_zcash_funds))
        
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], 8082));
    info!("Crypto wallet service listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

// ==================== HANDLERS ====================

async fn health_check() -> impl IntoResponse {
    Json(serde_json::json!({
        "status": "healthy",
        "service": "crypto-wallet-service",
        "version": "1.0.0",
        "supported_currencies": ["XMR", "ZEC"]
    }))
}

async fn list_currencies() -> impl IntoResponse {
    Json(serde_json::json!({
        "currencies": [
            {
                "code": "XMR",
                "name": "Monero",
                "type": "privacy",
                "features": ["ring_signatures", "stealth_addresses", "confidential_transactions"]
            },
            {
                "code": "ZEC",
                "name": "Zcash",
                "type": "privacy",
                "features": ["shielded_transactions", "transparent_transactions", "selective_disclosure"]
            }
        ]
    }))
}

async fn create_wallet_handler(
    State(state): State<AppState>,
    Json(req): Json<CreateWalletRequest>,
) -> Result<Json<CreateWalletResponse>, (StatusCode, String)> {
    match req.currency {
        Currency::Monero => {
            let wallet = create_monero_wallet(&req.name, req.password.as_deref())
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            
            let wallet_id = state.wallet_manager.store_wallet(
                &req.name,
                "XMR",
                &wallet.address,
                &wallet.mnemonic,
                &wallet.private_spend_key,
                &wallet.private_view_key,
            ).await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

            Ok(Json(CreateWalletResponse {
                wallet_id,
                currency: "XMR".to_string(),
                address: wallet.address,
                mnemonic: wallet.mnemonic,
                created_at: chrono::Utc::now().to_rfc3339(),
            }))
        }
        Currency::Zcash => {
            let wallet = create_zcash_wallet(&req.name, req.password.as_deref())
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            
            let wallet_id = state.wallet_manager.store_wallet(
                &req.name,
                "ZEC",
                &wallet.transparent_address,
                &wallet.mnemonic,
                &wallet.private_key,
                "",
            ).await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

            Ok(Json(CreateWalletResponse {
                wallet_id,
                currency: "ZEC".to_string(),
                address: wallet.transparent_address,
                mnemonic: wallet.mnemonic,
                created_at: chrono::Utc::now().to_rfc3339(),
            }))
        }
    }
}

async fn import_wallet_handler(
    State(state): State<AppState>,
    Json(req): Json<ImportWalletRequest>,
) -> Result<Json<CreateWalletResponse>, (StatusCode, String)> {
    match req.currency {
        Currency::Monero => {
            let wallet = restore_monero_wallet(&req.name, &req.mnemonic, req.password.as_deref())
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            
            let wallet_id = state.wallet_manager.store_wallet(
                &req.name,
                "XMR",
                &wallet.address,
                &req.mnemonic,
                &wallet.private_spend_key,
                &wallet.private_view_key,
            ).await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

            Ok(Json(CreateWalletResponse {
                wallet_id,
                currency: "XMR".to_string(),
                address: wallet.address,
                mnemonic: req.mnemonic,
                created_at: chrono::Utc::now().to_rfc3339(),
            }))
        }
        Currency::Zcash => {
            let wallet = restore_zcash_wallet(&req.name, &req.mnemonic, req.password.as_deref())
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            
            let wallet_id = state.wallet_manager.store_wallet(
                &req.name,
                "ZEC",
                &wallet.transparent_address,
                &req.mnemonic,
                &wallet.private_key,
                "",
            ).await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

            Ok(Json(CreateWalletResponse {
                wallet_id,
                currency: "ZEC".to_string(),
                address: wallet.transparent_address,
                mnemonic: req.mnemonic,
                created_at: chrono::Utc::now().to_rfc3339(),
            }))
        }
    }
}

async fn list_wallets_handler(
    State(state): State<AppState>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let wallets = state.wallet_manager.list_wallets().await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    
    Ok(Json(wallets))
}

async fn get_wallet_handler(
    State(state): State<AppState>,
    Path(wallet_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let wallet = state.wallet_manager.get_wallet(&wallet_id).await
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    
    Ok(Json(wallet))
}

async fn get_balance_handler(
    State(state): State<AppState>,
    Path(wallet_id): Path<String>,
) -> Result<Json<GetBalanceResponse>, (StatusCode, String)> {
    let wallet = state.wallet_manager.get_wallet(&wallet_id).await
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    
    let currency = wallet.get("currency")
        .and_then(|v| v.as_str())
        .ok_or((StatusCode::INTERNAL_SERVER_ERROR, "Invalid wallet data".to_string()))?;
    
    let address = wallet.get("address")
        .and_then(|v| v.as_str())
        .ok_or((StatusCode::INTERNAL_SERVER_ERROR, "Invalid wallet data".to_string()))?;

    match currency {
        "XMR" => {
            let balance = state.monero_client.get_balance(address).await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            
            Ok(Json(GetBalanceResponse {
                wallet_id: wallet_id.clone(),
                currency: "XMR".to_string(),
                balance: balance.total.to_string(),
                available_balance: balance.unlocked.to_string(),
                pending_balance: (balance.total - balance.unlocked).to_string(),
                address: address.to_string(),
            }))
        }
        "ZEC" => {
            let balance = state.zcash_client.get_balance(address).await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            
            Ok(Json(GetBalanceResponse {
                wallet_id: wallet_id.clone(),
                currency: "ZEC".to_string(),
                balance: balance.total.to_string(),
                available_balance: balance.confirmed.to_string(),
                pending_balance: balance.unconfirmed.to_string(),
                address: address.to_string(),
            }))
        }
        _ => Err((StatusCode::BAD_REQUEST, "Unsupported currency".to_string()))
    }
}

async fn get_address_handler(
    State(state): State<AppState>,
    Path(wallet_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let wallet = state.wallet_manager.get_wallet(&wallet_id).await
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    
    Ok(Json(serde_json::json!({
        "wallet_id": wallet_id,
        "address": wallet.get("address"),
        "currency": wallet.get("currency")
    })))
}

async fn send_transaction_handler(
    State(state): State<AppState>,
    Json(req): Json<SendTransactionRequest>,
) -> Result<Json<SendTransactionResponse>, (StatusCode, String)> {
    let wallet = state.wallet_manager.get_wallet(&req.wallet_id).await
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    
    let currency = wallet.get("currency")
        .and_then(|v| v.as_str())
        .ok_or((StatusCode::INTERNAL_SERVER_ERROR, "Invalid wallet data".to_string()))?;

    match currency {
        "XMR" => {
            let tx = state.monero_client.send_transaction(
                &wallet,
                &req.to_address,
                &req.amount,
                req.fee.as_deref(),
            ).await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            
            Ok(Json(SendTransactionResponse {
                tx_id: tx.tx_id,
                from_address: wallet.get("address").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                to_address: req.to_address,
                amount: req.amount,
                fee: tx.fee,
                status: "pending".to_string(),
                timestamp: chrono::Utc::now().to_rfc3339(),
            }))
        }
        "ZEC" => {
            let tx = state.zcash_client.send_transaction(
                &wallet,
                &req.to_address,
                &req.amount,
                req.fee.as_deref(),
            ).await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            
            Ok(Json(SendTransactionResponse {
                tx_id: tx.tx_id,
                from_address: wallet.get("address").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                to_address: req.to_address,
                amount: req.amount,
                fee: tx.fee,
                status: "pending".to_string(),
                timestamp: chrono::Utc::now().to_rfc3339(),
            }))
        }
        _ => Err((StatusCode::BAD_REQUEST, "Unsupported currency".to_string()))
    }
}

async fn get_transaction_history_handler(
    State(state): State<AppState>,
    Path(wallet_id): Path<String>,
) -> Result<Json<TransactionHistoryResponse>, (StatusCode, String)> {
    let wallet = state.wallet_manager.get_wallet(&wallet_id).await
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
    
    let currency = wallet.get("currency")
        .and_then(|v| v.as_str())
        .ok_or((StatusCode::INTERNAL_SERVER_ERROR, "Invalid wallet data".to_string()))?;
    
    let address = wallet.get("address")
        .and_then(|v| v.as_str())
        .ok_or((StatusCode::INTERNAL_SERVER_ERROR, "Invalid wallet data".to_string()))?;

    let transactions = match currency {
        "XMR" => state.monero_client.get_transactions(address).await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?,
        "ZEC" => state.zcash_client.get_transactions(address).await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?,
        _ => return Err((StatusCode::BAD_REQUEST, "Unsupported currency".to_string()))
    };

    Ok(Json(TransactionHistoryResponse {
        total_count: transactions.len(),
        transactions,
    }))
}

async fn get_transaction_handler(
    State(state): State<AppState>,
    Path(tx_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    // This would query both chains
    // For now, return mock response
    Ok(Json(serde_json::json!({
        "tx_id": tx_id,
        "status": "confirmed",
        "message": "Transaction details"
    })))
}

async fn validate_address_handler(
    Json(req): Json<ValidateAddressRequest>,
) -> Result<Json<ValidateAddressResponse>, (StatusCode, String)> {
    let valid = match req.currency {
        Currency::Monero => validate_monero_address(&req.address),
        Currency::Zcash => validate_zcash_address(&req.address),
    };

    Ok(Json(ValidateAddressResponse {
        valid,
        currency: req.currency.as_str().to_string(),
        address_type: if valid { Some("standard".to_string()) } else { None },
    }))
}

async fn get_exchange_rate_handler(
    Path(currency): Path<String>,
) -> Result<Json<ExchangeRateResponse>, (StatusCode, String)> {
    // Mock exchange rates - in production, fetch from API
    let (usd, btc) = match currency.to_uppercase().as_str() {
        "XMR" => ("468.50", "0.0051"),
        "ZEC" => ("370.20", "0.0040"),
        _ => return Err((StatusCode::BAD_REQUEST, "Unsupported currency".to_string()))
    };

    Ok(Json(ExchangeRateResponse {
        currency: currency.to_uppercase(),
        usd: usd.to_string(),
        btc: btc.to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
    }))
}

async fn get_all_rates_handler() -> impl IntoResponse {
    Json(serde_json::json!({
        "XMR": {
            "usd": "468.50",
            "btc": "0.0051"
        },
        "ZEC": {
            "usd": "370.20",
            "btc": "0.0040"
        },
        "timestamp": chrono::Utc::now().to_rfc3339()
    }))
}

async fn create_monero_integrated_address(
    State(state): State<AppState>,
    Json(params): Json<serde_json::Value>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    Ok(Json(serde_json::json!({
        "integrated_address": "4...",
        "payment_id": "abc123"
    })))
}

async fn list_monero_subaddresses(
    State(state): State<AppState>,
    Path(wallet_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    Ok(Json(serde_json::json!({
        "subaddresses": []
    })))
}

async fn get_zcash_shielded_balance(
    State(state): State<AppState>,
    Path(wallet_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    Ok(Json(serde_json::json!({
        "shielded_balance": "0.0",
        "transparent_balance": "0.0"
    })))
}

async fn shield_zcash_funds(
    State(state): State<AppState>,
    Json(params): Json<serde_json::Value>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    Ok(Json(serde_json::json!({
        "tx_id": "shielding_tx",
        "status": "pending"
    })))
}
