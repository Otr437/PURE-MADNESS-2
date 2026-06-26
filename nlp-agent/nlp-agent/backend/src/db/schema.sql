-- NLP Agent Production Database Schema
-- Run this file to initialize all tables

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Admin users
CREATE TABLE IF NOT EXISTS admin_users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'superadmin',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

-- JWT refresh tokens
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_admin ON refresh_tokens(admin_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);

-- Agent wallets — one per AI provider
CREATE TABLE IF NOT EXISTS agent_wallets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id TEXT UNIQUE NOT NULL CHECK (agent_id IN ('claude', 'openai', 'deepseek')),
  balance NUMERIC(20, 8) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  stripe_customer_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed wallets for all three agents
INSERT INTO agent_wallets (agent_id) VALUES ('claude'), ('openai'), ('deepseek')
ON CONFLICT (agent_id) DO NOTHING;

-- Transactions ledger
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  from_agent_id TEXT REFERENCES agent_wallets(agent_id),
  to_agent_id TEXT REFERENCES agent_wallets(agent_id),
  amount NUMERIC(20, 8) NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  type TEXT NOT NULL CHECK (type IN ('credit', 'debit', 'transfer', 'withdrawal', 'deposit')),
  rail TEXT NOT NULL CHECK (rail IN ('stripe', 'plaid_ach', 'internal')),
  status TEXT NOT NULL DEFAULT 'pending_approval' CHECK (status IN (
    'pending_approval', 'approved', 'denied', 'processing', 'completed', 'failed'
  )),
  description TEXT NOT NULL,
  stripe_payment_intent_id TEXT,
  plaid_transaction_id TEXT,
  approval_id UUID,
  approved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  failure_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_transactions_from ON transactions(from_agent_id);
CREATE INDEX IF NOT EXISTS idx_transactions_to ON transactions(to_agent_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at DESC);

-- Bank accounts linked via Plaid
CREATE TABLE IF NOT EXISTS bank_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id TEXT NOT NULL REFERENCES agent_wallets(agent_id),
  plaid_item_id TEXT NOT NULL,
  plaid_account_id TEXT UNIQUE NOT NULL,
  institution_name TEXT NOT NULL,
  account_name TEXT NOT NULL,
  account_type TEXT NOT NULL,
  mask TEXT NOT NULL,
  current_balance NUMERIC(20, 8),
  available_balance NUMERIC(20, 8),
  currency TEXT NOT NULL DEFAULT 'USD',
  last_synced TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bank_accounts_agent ON bank_accounts(agent_id);

-- Approval audit log (persisted in DB, not just memory)
CREATE TABLE IF NOT EXISTS approval_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  approval_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  action TEXT NOT NULL,
  parameters JSONB,
  context TEXT,
  risk_level TEXT NOT NULL,
  status TEXT NOT NULL,
  resolved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_approval_log_session ON approval_log(session_id);
CREATE INDEX IF NOT EXISTS idx_approval_log_status ON approval_log(status);

-- Wallet balance update trigger
CREATE OR REPLACE FUNCTION update_wallet_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wallet_updated ON agent_wallets;
CREATE TRIGGER wallet_updated
  BEFORE UPDATE ON agent_wallets
  FOR EACH ROW EXECUTE FUNCTION update_wallet_timestamp();
