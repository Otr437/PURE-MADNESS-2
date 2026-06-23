/**
 * config.js — Runtime environment config
 * Single source of truth for network selection and active endpoints.
 * Everything else imports from here — never from .env directly.
 * Verified against Vaulta mainnet — June 2026
 */

import {
    RPC_ENDPOINTS,
    HYPERION_ENDPOINTS,
    SHIP_ENDPOINTS,
    CHAIN_IDS,
    DEFAULT_CONTRACT,
} from './constants.js'

const NETWORK = process.env.NETWORK || 'mainnet'

if (!['mainnet', 'jungle'].includes(NETWORK)) {
    throw new Error(`Invalid NETWORK "${NETWORK}" — must be mainnet or jungle`)
}

export const rpcUrl      = process.env.NODE_URL     || RPC_ENDPOINTS[NETWORK][0]
export const hyperionUrl = process.env.HYPERION_URL || HYPERION_ENDPOINTS[NETWORK][0]
export const shipUrl     = process.env.SHIP_URL     || SHIP_ENDPOINTS[NETWORK][0]
export const chainId     = CHAIN_IDS[NETWORK]
export const network     = NETWORK
export const contract    = DEFAULT_CONTRACT

export const allRpcUrls      = RPC_ENDPOINTS[NETWORK]
export const allHyperionUrls = HYPERION_ENDPOINTS[NETWORK]
export const allShipUrls     = SHIP_ENDPOINTS[NETWORK]

export const privateKey  = process.env.PRIVATE_KEY || null
export const accountName = process.env.ACCOUNT     || null
export const permission  = process.env.PERMISSION  || 'active'

export default {
    network, chainId, rpcUrl, hyperionUrl, shipUrl, contract,
    allRpcUrls, allHyperionUrls, allShipUrls,
    privateKey, accountName, permission,
}
