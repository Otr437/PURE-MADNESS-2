#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, panic_with_error, token, Address, BytesN, Env, Symbol};

const INSTANCE_BUMP_THRESHOLD: u32 = 500;
const INSTANCE_BUMP_AMOUNT: u32 = 17_280;
const PERSISTENT_BUMP_THRESHOLD: u32 = 500;
const PERSISTENT_BUMP_AMOUNT: u32 = 120_960;

#[contracttype]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum VaultError {
    AlreadyInitialized      = 1,
    Unauthorized            = 2,
    InvalidAmount           = 3,
    InsufficientBalance     = 4,
    NoPendingOwner          = 5,
    TokenNotWhitelisted     = 6,
    TokenAlreadyWhitelisted = 7,
    Paused                  = 8,
    Overflow                = 9,
}

impl soroban_sdk::contracterror::ContractError for VaultError {
    fn value(self) -> u32 { self as u32 }
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Owner,
    PendingOwner,
    IsAdmin(Address),
    IsOperator(Address),
    Paused,
    Whitelisted(Address),
    Balance(Address),
}

#[contract]
pub struct VaultContract;

#[contractimpl]
impl VaultContract {
    pub fn __constructor(env: Env, owner: Address) {
        owner.require_auth();
        env.storage().instance().set(&DataKey::Owner, &owner);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        env.events().publish((Symbol::new(&env, "vault_created"),), owner);
    }

    pub fn propose_owner(env: Env, new_owner: Address) {
        Self::check_not_paused(&env);
        let owner = Self::get_owner(&env);
        owner.require_auth();
        env.storage().instance().set(&DataKey::PendingOwner, &new_owner);
        env.storage().instance().extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        env.events().publish((Symbol::new(&env, "owner_proposed"),), new_owner);
    }

    pub fn accept_owner(env: Env) {
        Self::check_not_paused(&env);
        let pending: Address = env.storage().instance().get(&DataKey::PendingOwner)
            .unwrap_or_else(|| panic_with_error!(&env, VaultError::NoPendingOwner));
        pending.require_auth();
        env.storage().instance().set(&DataKey::Owner, &pending);
        env.storage().instance().remove(&DataKey::PendingOwner);
        env.storage().instance().extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        env.events().publish((Symbol::new(&env, "owner_accepted"),), pending);
    }

    pub fn grant_admin(env: Env, account: Address) {
        Self::check_not_paused(&env);
        let owner = Self::get_owner(&env);
        owner.require_auth();
        env.storage().persistent().set(&DataKey::IsAdmin(account.clone()), &true);
        env.storage().persistent().extend_ttl(&DataKey::IsAdmin(account.clone()), PERSISTENT_BUMP_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
        env.storage().instance().extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        env.events().publish((Symbol::new(&env, "admin_granted"),), account);
    }

    pub fn revoke_admin(env: Env, account: Address) {
        Self::check_not_paused(&env);
        let owner = Self::get_owner(&env);
        owner.require_auth();
        env.storage().persistent().remove(&DataKey::IsAdmin(account.clone()));
        env.storage().instance().extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        env.events().publish((Symbol::new(&env, "admin_revoked"),), account);
    }

    pub fn grant_operator(env: Env, caller: Address, account: Address) {
        Self::check_not_paused(&env);
        caller.require_auth();
        Self::check_owner_or_admin(&env, &caller);
        env.storage().persistent().set(&DataKey::IsOperator(account.clone()), &true);
        env.storage().persistent().extend_ttl(&DataKey::IsOperator(account.clone()), PERSISTENT_BUMP_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
        env.storage().instance().extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        env.events().publish((Symbol::new(&env, "operator_granted"),), account);
    }

    pub fn revoke_operator(env: Env, caller: Address, account: Address) {
        Self::check_not_paused(&env);
        caller.require_auth();
        Self::check_owner_or_admin(&env, &caller);
        env.storage().persistent().remove(&DataKey::IsOperator(account.clone()));
        env.storage().instance().extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        env.events().publish((Symbol::new(&env, "operator_revoked"),), account);
    }

    pub fn pause(env: Env, caller: Address) {
        caller.require_auth();
        Self::check_owner_or_admin(&env, &caller);
        env.storage().instance().set(&DataKey::Paused, &true);
        env.storage().instance().extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        env.events().publish((Symbol::new(&env, "paused"),), caller);
    }

    pub fn unpause(env: Env, caller: Address) {
        caller.require_auth();
        Self::check_owner_or_admin(&env, &caller);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        env.events().publish((Symbol::new(&env, "unpaused"),), caller);
    }

    pub fn whitelist_token(env: Env, caller: Address, token_id: Address) {
        Self::check_not_paused(&env);
        caller.require_auth();
        Self::check_owner_or_admin(&env, &caller);
        let key = DataKey::Whitelisted(token_id.clone());
        if env.storage().persistent().has(&key) {
            panic_with_error!(&env, VaultError::TokenAlreadyWhitelisted);
        }
        env.storage().persistent().set(&key, &true);
        env.storage().persistent().extend_ttl(&key, PERSISTENT_BUMP_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
        env.storage().instance().extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        env.events().publish((Symbol::new(&env, "token_whitelisted"),), token_id);
    }

    pub fn remove_token(env: Env, caller: Address, token_id: Address) {
        Self::check_not_paused(&env);
        caller.require_auth();
        Self::check_owner_or_admin(&env, &caller);
        let key = DataKey::Whitelisted(token_id.clone());
        if !env.storage().persistent().has(&key) {
            panic_with_error!(&env, VaultError::TokenNotWhitelisted);
        }
        env.storage().persistent().remove(&key);
        env.storage().instance().extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        env.events().publish((Symbol::new(&env, "token_removed"),), token_id);
    }

    pub fn deposit(env: Env, depositor: Address, token_id: Address, amount: i128) {
        // CHECKS
        Self::check_not_paused(&env);
        depositor.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, VaultError::InvalidAmount);
        }
        let whitelist_key = DataKey::Whitelisted(token_id.clone());
        if !env.storage().persistent().has(&whitelist_key) {
            panic_with_error!(&env, VaultError::TokenNotWhitelisted);
        }
        // EFFECTS
        let balance_key = DataKey::Balance(token_id.clone());
        let current: i128 = env.storage().persistent().get(&balance_key).unwrap_or(0_i128);
        let new_balance = current.checked_add(amount)
            .unwrap_or_else(|| panic_with_error!(&env, VaultError::Overflow));
        env.storage().persistent().set(&balance_key, &new_balance);
        env.storage().persistent().extend_ttl(&balance_key, PERSISTENT_BUMP_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
        env.storage().persistent().extend_ttl(&whitelist_key, PERSISTENT_BUMP_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
        env.storage().instance().extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        // INTERACTIONS
        let tok = token::Client::new(&env, &token_id);
        tok.transfer(&depositor, &env.current_contract_address(), &amount);
        env.events().publish((Symbol::new(&env, "deposit"), depositor), (token_id, amount));
    }

    pub fn withdraw(env: Env, token_id: Address, to: Address, amount: i128) {
        // CHECKS
        Self::check_not_paused(&env);
        let owner = Self::get_owner(&env);
        owner.require_auth();
        if amount <= 0 {
            panic_with_error!(&env, VaultError::InvalidAmount);
        }
        let balance_key = DataKey::Balance(token_id.clone());
        let current: i128 = env.storage().persistent().get(&balance_key).unwrap_or(0_i128);
        if current < amount {
            panic_with_error!(&env, VaultError::InsufficientBalance);
        }
        // EFFECTS
        let new_balance = current.checked_sub(amount)
            .unwrap_or_else(|| panic_with_error!(&env, VaultError::Overflow));
        env.storage().persistent().set(&balance_key, &new_balance);
        env.storage().persistent().extend_ttl(&balance_key, PERSISTENT_BUMP_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
        env.storage().instance().extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        // INTERACTIONS
        let tok = token::Client::new(&env, &token_id);
        tok.transfer(&env.current_contract_address(), &to, &amount);
        env.events().publish((Symbol::new(&env, "withdraw"), owner), (token_id, to, amount));
    }

    pub fn emergency_withdraw(env: Env, token_id: Address) {
        // CHECKS
        Self::check_not_paused(&env);
        let owner = Self::get_owner(&env);
        owner.require_auth();
        let balance_key = DataKey::Balance(token_id.clone());
        let balance: i128 = env.storage().persistent().get(&balance_key).unwrap_or(0_i128);
        if balance <= 0 {
            panic_with_error!(&env, VaultError::InsufficientBalance);
        }
        // EFFECTS
        env.storage().persistent().set(&balance_key, &0_i128);
        env.storage().persistent().extend_ttl(&balance_key, PERSISTENT_BUMP_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
        env.storage().instance().extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        // INTERACTIONS
        let tok = token::Client::new(&env, &token_id);
        tok.transfer(&env.current_contract_address(), &owner, &balance);
        env.events().publish((Symbol::new(&env, "emergency_withdraw"), owner), (token_id, balance));
    }

    pub fn owner(env: Env) -> Address { Self::get_owner(&env) }

    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get::<_, bool>(&DataKey::Paused).unwrap_or(false)
    }

    pub fn is_admin(env: Env, account: Address) -> bool {
        let key = DataKey::IsAdmin(account);
        let has = env.storage().persistent().has(&key);
        if has { env.storage().persistent().extend_ttl(&key, PERSISTENT_BUMP_THRESHOLD, PERSISTENT_BUMP_AMOUNT); }
        has
    }

    pub fn is_operator(env: Env, account: Address) -> bool {
        let key = DataKey::IsOperator(account);
        let has = env.storage().persistent().has(&key);
        if has { env.storage().persistent().extend_ttl(&key, PERSISTENT_BUMP_THRESHOLD, PERSISTENT_BUMP_AMOUNT); }
        has
    }

    pub fn is_whitelisted(env: Env, token_id: Address) -> bool {
        let key = DataKey::Whitelisted(token_id);
        let has = env.storage().persistent().has(&key);
        if has { env.storage().persistent().extend_ttl(&key, PERSISTENT_BUMP_THRESHOLD, PERSISTENT_BUMP_AMOUNT); }
        has
    }

    pub fn vault_balance(env: Env, token_id: Address) -> i128 {
        let key = DataKey::Balance(token_id);
        let bal: i128 = env.storage().persistent().get(&key).unwrap_or(0_i128);
        if bal > 0 { env.storage().persistent().extend_ttl(&key, PERSISTENT_BUMP_THRESHOLD, PERSISTENT_BUMP_AMOUNT); }
        bal
    }

    fn get_owner(env: &Env) -> Address {
        env.storage().instance().get::<_, Address>(&DataKey::Owner)
            .unwrap_or_else(|| panic_with_error!(env, VaultError::Unauthorized))
    }

    fn check_owner_or_admin(env: &Env, caller: &Address) {
        let owner = Self::get_owner(env);
        if *caller == owner { return; }
        let is_admin = env.storage().persistent()
            .get::<_, bool>(&DataKey::IsAdmin(caller.clone()))
            .unwrap_or(false);
        if !is_admin { panic_with_error!(env, VaultError::Unauthorized); }
    }

    fn check_not_paused(env: &Env) {
        let paused = env.storage().instance().get::<_, bool>(&DataKey::Paused).unwrap_or(false);
        if paused { panic_with_error!(env, VaultError::Paused); }
    }
}
