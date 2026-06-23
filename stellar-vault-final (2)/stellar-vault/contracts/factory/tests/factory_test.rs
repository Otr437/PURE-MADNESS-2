#![cfg(test)]

use soroban_sdk::{testutils::Address as _, Address, BytesN, Env};
use factory::VaultFactory;

fn setup() -> (Env, factory::VaultFactoryClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let owner = Address::generate(&env);
    let fee_dest = Address::generate(&env);
    let wasm_hash = BytesN::from_array(&env, &[0u8; 32]);
    let id = env.register(VaultFactory, (&owner, &wasm_hash, &1_000_0000_i128, &fee_dest));
    let client = factory::VaultFactoryClient::new(&env, &id);
    (env, client, owner, fee_dest)
}

#[test]
fn test_owner_set_on_construction() {
    let (_env, client, owner, _) = setup();
    assert_eq!(client.owner(), owner);
}

#[test]
fn test_not_paused_on_construction() {
    let (_env, client, _, _) = setup();
    assert!(!client.is_paused());
}

#[test]
fn test_fee_set_on_construction() {
    let (_env, client, _, _) = setup();
    assert_eq!(client.deploy_fee(), 1_000_0000_i128);
}

#[test]
fn test_fee_deposit_address_set() {
    let (_env, client, _, fee_dest) = setup();
    assert_eq!(client.fee_deposit_address(), fee_dest);
}

#[test]
fn test_deployed_vaults_empty_on_construction() {
    let (_env, client, _, _) = setup();
    assert_eq!(client.deployed_vaults().len(), 0);
}

#[test]
fn test_grant_and_revoke_admin() {
    let (env, client, _owner, _) = setup();
    let admin = Address::generate(&env);
    assert!(!client.is_admin(&admin));
    client.grant_admin(&admin);
    assert!(client.is_admin(&admin));
    client.revoke_admin(&admin);
    assert!(!client.is_admin(&admin));
}

#[test]
fn test_pause_and_unpause() {
    let (env, client, owner, _) = setup();
    assert!(!client.is_paused());
    client.pause(&owner);
    assert!(client.is_paused());
    client.unpause(&owner);
    assert!(!client.is_paused());
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_grant_admin_blocked_when_paused() {
    let (env, client, owner, _) = setup();
    client.pause(&owner);
    let admin = Address::generate(&env);
    client.grant_admin(&admin);
}

#[test]
fn test_set_deploy_fee_by_owner() {
    let (env, client, owner, _) = setup();
    client.set_deploy_fee(&owner, &2_000_0000_i128);
    assert_eq!(client.deploy_fee(), 2_000_0000_i128);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn test_set_negative_fee_panics() {
    let (env, client, owner, _) = setup();
    client.set_deploy_fee(&owner, &-1_i128);
}

#[test]
fn test_set_deploy_fee_by_admin() {
    let (env, client, _owner, _) = setup();
    let admin = Address::generate(&env);
    client.grant_admin(&admin);
    client.set_deploy_fee(&admin, &500_0000_i128);
    assert_eq!(client.deploy_fee(), 500_0000_i128);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn test_stranger_cannot_set_fee() {
    let (env, client, _, _) = setup();
    let stranger = Address::generate(&env);
    client.set_deploy_fee(&stranger, &0_i128);
}

#[test]
fn test_two_step_owner_transfer() {
    let (env, client, _owner, _) = setup();
    let new_owner = Address::generate(&env);
    client.propose_owner(&new_owner);
    client.accept_owner();
    assert_eq!(client.owner(), new_owner);
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn test_accept_owner_without_proposal_panics() {
    let (_env, client, _, _) = setup();
    client.accept_owner();
}

#[test]
fn test_set_fee_deposit_address_by_owner() {
    let (env, client, owner, _) = setup();
    let new_dest = Address::generate(&env);
    client.set_fee_deposit_address(&owner, &new_dest);
    assert_eq!(client.fee_deposit_address(), new_dest);
}
