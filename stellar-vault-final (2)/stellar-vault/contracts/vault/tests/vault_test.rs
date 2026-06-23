#![cfg(test)]

use soroban_sdk::{testutils::Address as _, Address, Env};
use vault::VaultContract;

fn setup() -> (Env, vault::VaultContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let owner = Address::generate(&env);
    let id = env.register(VaultContract, (&owner,));
    let client = vault::VaultContractClient::new(&env, &id);
    (env, client, owner)
}

#[test]
fn test_owner_set_on_construction() {
    let (_env, client, owner) = setup();
    assert_eq!(client.owner(), owner);
}

#[test]
fn test_not_paused_on_construction() {
    let (_env, client, _owner) = setup();
    assert!(!client.is_paused());
}

#[test]
fn test_grant_and_revoke_admin() {
    let (env, client, _owner) = setup();
    let admin = Address::generate(&env);
    assert!(!client.is_admin(&admin));
    client.grant_admin(&admin);
    assert!(client.is_admin(&admin));
    client.revoke_admin(&admin);
    assert!(!client.is_admin(&admin));
}

#[test]
fn test_grant_and_revoke_operator() {
    let (env, client, _owner) = setup();
    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    client.grant_admin(&admin);
    client.grant_operator(&admin, &operator);
    assert!(client.is_operator(&operator));
    client.revoke_operator(&admin, &operator);
    assert!(!client.is_operator(&operator));
}

#[test]
fn test_whitelist_and_remove_token() {
    let (env, client, owner) = setup();
    let token = Address::generate(&env);
    assert!(!client.is_whitelisted(&token));
    client.whitelist_token(&owner, &token);
    assert!(client.is_whitelisted(&token));
    client.remove_token(&owner, &token);
    assert!(!client.is_whitelisted(&token));
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn test_whitelist_duplicate_panics() {
    let (env, client, owner) = setup();
    let token = Address::generate(&env);
    client.whitelist_token(&owner, &token);
    client.whitelist_token(&owner, &token);
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn test_deposit_non_whitelisted_panics() {
    let (env, client, _owner) = setup();
    let depositor = Address::generate(&env);
    let token = Address::generate(&env);
    client.deposit(&depositor, &token, &100_i128);
}

#[test]
#[should_panic(expected = "Error(Contract, #3)")]
fn test_deposit_zero_amount_panics() {
    let (env, client, owner) = setup();
    let depositor = Address::generate(&env);
    let token = Address::generate(&env);
    client.whitelist_token(&owner, &token);
    client.deposit(&depositor, &token, &0_i128);
}

#[test]
fn test_pause_and_unpause() {
    let (env, client, owner) = setup();
    assert!(!client.is_paused());
    client.pause(&owner);
    assert!(client.is_paused());
    client.unpause(&owner);
    assert!(!client.is_paused());
}

#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn test_whitelist_blocked_when_paused() {
    let (env, client, owner) = setup();
    let token = Address::generate(&env);
    client.pause(&owner);
    client.whitelist_token(&owner, &token);
}

#[test]
#[should_panic(expected = "Error(Contract, #8)")]
fn test_withdraw_blocked_when_paused() {
    let (env, client, owner) = setup();
    let token = Address::generate(&env);
    let recipient = Address::generate(&env);
    client.pause(&owner);
    client.withdraw(&token, &recipient, &100_i128);
}

#[test]
fn test_two_step_owner_transfer() {
    let (env, client, _owner) = setup();
    let new_owner = Address::generate(&env);
    client.propose_owner(&new_owner);
    client.accept_owner();
    assert_eq!(client.owner(), new_owner);
}

#[test]
#[should_panic(expected = "Error(Contract, #5)")]
fn test_accept_owner_without_proposal_panics() {
    let (_env, client, _owner) = setup();
    client.accept_owner();
}

#[test]
fn test_vault_balance_zero_for_unknown_token() {
    let (env, client, _owner) = setup();
    let token = Address::generate(&env);
    assert_eq!(client.vault_balance(&token), 0_i128);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn test_withdraw_insufficient_balance_panics() {
    let (env, client, owner) = setup();
    let token = Address::generate(&env);
    let recipient = Address::generate(&env);
    client.whitelist_token(&owner, &token);
    client.withdraw(&token, &recipient, &100_i128);
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn test_emergency_withdraw_zero_balance_panics() {
    let (env, client, owner) = setup();
    let token = Address::generate(&env);
    client.whitelist_token(&owner, &token);
    client.emergency_withdraw(&token);
}

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn test_stranger_cannot_grant_operator() {
    let (env, client, _owner) = setup();
    let stranger = Address::generate(&env);
    let target = Address::generate(&env);
    client.grant_operator(&stranger, &target);
}
