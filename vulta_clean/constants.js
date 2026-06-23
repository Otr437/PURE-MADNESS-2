/**
 * constants.js — Static values for the Vaultclean monorepo
 * All contract names, token symbols, known system accounts,
 * and network-level constants live here.
 * Verified against Vaulta mainnet — June 2026
 */

export const TOKEN_CONTRACT_EOS = 'eosio.token'
export const TOKEN_CONTRACT_A   = 'core.vaulta'
export const TOKEN_SYMBOL_EOS   = 'EOS'
export const TOKEN_SYMBOL_A     = 'A'
export const TOKEN_PRECISION    = 4

export const SYSTEM_CONTRACT    = 'eosio'
export const EVM_CONTRACT       = 'eosio.evm'
export const RAM_CONTRACT       = 'eosio.ram'

export const DEFAULT_CONTRACT   = process.env.CONTRACT || 'vaultclean'

export const CHAIN_IDS = {
    mainnet: 'aca376f206b8fc25a6ed44dbdc66547c36c6c33d3a5402eba3c57778be1ad15',
    jungle:  '73e4385a2708e6d7048834fbc1079f2fabb17b3c125b146af438971e90716c4d',
}

export const RPC_ENDPOINTS = {
    mainnet: [
        'https://eos.greymass.com',
        'https://api.eosn.io',
        'https://eos.eosphere.io',
        'https://eos.api.heliosblockchain.io',
    ],
    jungle: [
        'https://jungle4.cryptolions.io',
        'https://jungle4.greymass.com',
    ],
}

export const HYPERION_ENDPOINTS = {
    mainnet: [
        'https://eos.eosusa.io',
        'https://eos.eosphere.io',
    ],
    jungle: [
        'https://jungle4.cryptolions.io',
    ],
}

export const SHIP_ENDPOINTS = {
    mainnet: [ 'wss://eos.greymass.com' ],
    jungle:  [ 'wss://jungle4.cryptolions.io' ],
}

export const CONFIRM_POLL_MS      = 500
export const CONFIRM_TIMEOUT_MS   = 30000
export const CONFIRM_IRREVERSIBLE = true

export const POWERUP_CPU_FRAC = 40000000000
export const POWERUP_NET_FRAC = 10000000000
export const POWERUP_MAX_PAY  = '1.0000 EOS'
export const RAM_BUY_BYTES    = 65536

export const TABLE_STATS    = 'stats'
export const TABLE_BALANCES = 'balances'
export const TABLE_CONFIG   = 'config'

export const ACTION_DEPOSIT_EOS  = 'depositeos'
export const ACTION_DEPOSIT_A    = 'deposita'
export const ACTION_WITHDRAW_EOS = 'withdraweos'
export const ACTION_WITHDRAW_A   = 'withdrawa'
export const ACTION_EOS_TO_A     = 'eostoa'
export const ACTION_A_TO_EOS     = 'a2eos'
export const ACTION_ADD_USER     = 'adduser'
export const ACTION_REMOVE_USER  = 'removeuser'
export const ACTION_SET_PAUSED   = 'setpaused'
export const ACTION_SET_RATE     = 'setrate'
export const ACTION_EMERG_DRAIN  = 'emergdrain'
