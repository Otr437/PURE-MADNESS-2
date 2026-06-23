#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, panic_with_error, token, Address, BytesN, Env, Symbol, Vec};

const INSTANCE_BUMP_THRESHOLD: u32 = 500;
const INSTANCE_BUMP_AMOUNT: u32 = 17_280;
const PERSISTENT_BUMP_THRESHOLD: u32 = 500;
const PERSISTENT_BUMP_AMOUNT: u32 = 120_960;

#[contracttype]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum FactoryError {
    Unauthorized       = 1,
    NoPendingOwner     = 2,
    Paused             = 3,
    InvalidFee         = 4,
    InvalidDepositAddr = 5,
}

impl soroban_sdk::contracterror::ContractError for FactoryError {
    fn value(self) -> u32 { self as u32 }
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Owner,
    PendingOwner,
    IsAdmin(Address),
    Paused,
    DeployFee,
    FeeDepositAddress,
    VaultWasmHash,
    DeployedVaults,
}

#[contract]
pub struct VaultFactory;

#[contractimpl]
impl VaultFactory {
    pub fn __constructor(
        env: Env,
        owner: Address,
        vault_wasm_hash: BytesN<32>,
        deploy_fee: i128,
        fee_deposit_address: Address,
    ) {
        owner.require_auth();
        if deploy_fee < 0 {
            panic_with_error!(&env, FactoryError::InvalidFee);
        }
        env.storage().instance().set(&DataKey::Owner, &owner);
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage().instance().set(&DataKey::VaultWasmHash, &vault_wasm_hash);
        env.storage().instance().set(&DataKey::DeployFee, &deploy_fee);
        env.storage().instance().set(&DataKey::FeeDepositAddress, &fee_deposit_address);
        env.storage().persistent().set(&DataKey::DeployedVaults, &Vec::<Address>::new(&env));
        env.storage().persistent().extend_ttl(&DataKey::DeployedVaults, PERSISTENT_BUMP_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
        env.storage().instance().extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        env.events().publish((Symbol::new(&env, "factory_created"),), owner);
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
            .unwrap_or_else(|| panic_with_error!(&env, FactoryError::NoPendingOwner));
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

    pub fn set_deploy_fee(env: Env, caller: Address, new_fee: i128) {
        Self::check_not_paused(&env);
        caller.require_auth();
        Self::check_owner_or_admin(&env, &caller);
        if new_fee < 0 {
            panic_with_error!(&env, FactoryError::InvalidFee);
        }
        env.storage().instance().set(&DataKey::DeployFee, &new_fee);
        env.storage().instance().extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        env.events().publish((Symbol::new(&env, "fee_updated"),), new_fee);
    }

    pub fn set_fee_deposit_address(env: Env, caller: Address, new_address: Address) {
        Self::check_not_paused(&env);
        caller.require_auth();
        Self::check_owner_or_admin(&env, &caller);
        env.storage().instance().set(&DataKey::FeeDepositAddress, &new_address);
        env.storage().instance().extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        env.events().publish((Symbol::new(&env, "deposit_addr_updated"),), new_address);
    }

    pub fn set_vault_wasm_hash(env: Env, caller: Address, new_hash: BytesN<32>) {
        Self::check_not_paused(&env);
        caller.require_auth();
        Self::check_owner_or_admin(&env, &caller);
        env.storage().instance().set(&DataKey::VaultWasmHash, &new_hash);
        env.storage().instance().extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        env.events().publish((Symbol::new(&env, "wasm_hash_updated"),), new_hash);
    }

    pub fn deploy_vault(
        env: Env,
        deployer: Address,
        salt: BytesN<32>,
        native_token: Address,
    ) -> Address {
        // CHECKS
        Self::check_not_paused(&env);
        deployer.require_auth();
        let fee: i128 = env.storage().instance().get(&DataKey::DeployFee).unwrap_or(0_i128);
        let deposit_address: Address = env.storage().instance().get(&DataKey::FeeDepositAddress)
            .unwrap_or_else(|| panic_with_error!(&env, FactoryError::InvalidDepositAddr));
        let wasm_hash: BytesN<32> = env.storage().instance().get(&DataKey::VaultWasmHash)
            .unwrap_or_else(|| panic_with_error!(&env, FactoryError::Unauthorized));
        // EFFECTS
        let vault_address = env
            .deployer()
            .with_address(env.current_contract_address(), salt)
            .deploy_v2(wasm_hash, (&deployer,));
        let mut vaults: Vec<Address> = env.storage().persistent()
            .get(&DataKey::DeployedVaults)
            .unwrap_or_else(|| Vec::new(&env));
        vaults.push_back(vault_address.clone());
        env.storage().persistent().set(&DataKey::DeployedVaults, &vaults);
        env.storage().persistent().extend_ttl(&DataKey::DeployedVaults, PERSISTENT_BUMP_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
        env.storage().instance().extend_ttl(INSTANCE_BUMP_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        // INTERACTIONS
        if fee > 0 {
            let tok = token::Client::new(&env, &native_token);
            tok.transfer(&deployer, &deposit_address, &fee);
        }
        env.events().publish((Symbol::new(&env, "vault_deployed"), deployer), vault_address.clone());
        vault_address
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

    pub fn deploy_fee(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::DeployFee).unwrap_or(0_i128)
    }

    pub fn fee_deposit_address(env: Env) -> Address {
        env.storage().instance().get(&DataKey::FeeDepositAddress)
            .unwrap_or_else(|| panic_with_error!(&env, FactoryError::InvalidDepositAddr))
    }

    pub fn deployed_vaults(env: Env) -> Vec<Address> {
        let vaults: Vec<Address> = env.storage().persistent()
            .get(&DataKey::DeployedVaults)
            .unwrap_or_else(|| Vec::new(&env));
        env.storage().persistent().extend_ttl(&DataKey::DeployedVaults, PERSISTENT_BUMP_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
        vaults
    }

    fn get_owner(env: &Env) -> Address {
        env.storage().instance().get::<_, Address>(&DataKey::Owner)
            .unwrap_or_else(|| panic_with_error!(env, FactoryError::Unauthorized))
    }

    fn check_owner_or_admin(env: &Env, caller: &Address) {
        let owner = Self::get_owner(env);
        if *caller == owner { return; }
        let is_admin = env.storage().persistent()
            .get::<_, bool>(&DataKey::IsAdmin(caller.clone()))
            .unwrap_or(false);
        if !is_admin { panic_with_error!(env, FactoryError::Unauthorized); }
    }

    fn check_not_paused(env: &Env) {
        let paused = env.storage().instance().get::<_, bool>(&DataKey::Paused).unwrap_or(false);
        if paused { panic_with_error!(env, FactoryError::Paused); }
    }
}
