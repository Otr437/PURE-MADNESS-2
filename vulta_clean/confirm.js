/**
 * confirm.js — Transaction confirmation poller
 *
 * CRITICAL: A tx hash from push_transaction means the node ACCEPTED it.
 * It does NOT mean the tx is confirmed or irreversible.
 *
 * This module polls the chain until:
 *  - The tx appears in a block (confirmed)
 *  - The block becomes irreversible / LIB (irreversible)
 *  - Or timeout is reached (throws)
 *
 * Verified against Vaulta mainnet — June 2026
 * Requires Node.js 24+
 */

import { post } from './rpc.js'
import {
    CONFIRM_POLL_MS,
    CONFIRM_TIMEOUT_MS,
    CONFIRM_IRREVERSIBLE,
} from '@vaultclean/config/constants'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * Fetch a transaction by ID from the chain.
 * Returns null if not found yet (still propagating).
 */
async function fetchTx(txid) {
    try {
        return await post('/v1/history/get_transaction', { id: txid })
    } catch (err) {
        // 404 / not found = still propagating, not an error yet
        if (err.status === 404 || err.status === 400) return null
        throw err
    }
}

/**
 * Get current LIB (Last Irreversible Block) number.
 */
async function getLIB() {
    const info = await post('/v1/chain/get_info', {})
    return info.last_irreversible_block_num
}

/**
 * waitForConfirmation — poll until tx is in a block.
 *
 * Returns the tx receipt once found.
 * Throws if timeout exceeded.
 *
 * @param {string}  txid         — transaction ID from push_transaction
 * @param {object}  opts
 * @param {boolean} opts.irreversible — wait for LIB (default: true)
 * @param {number}  opts.pollMs      — poll interval ms (default: 500)
 * @param {number}  opts.timeoutMs   — total timeout ms (default: 30000)
 */
export async function waitForConfirmation(txid, {
    irreversible = CONFIRM_IRREVERSIBLE,
    pollMs       = CONFIRM_POLL_MS,
    timeoutMs    = CONFIRM_TIMEOUT_MS,
} = {}) {
    const deadline = Date.now() + timeoutMs
    let tx = null

    // Phase 1 — wait for tx to appear in ANY block
    while (Date.now() < deadline) {
        tx = await fetchTx(txid)
        if (tx) break
        await sleep(pollMs)
    }

    if (!tx) {
        throw Object.assign(
            new Error(`Tx ${txid} not found after ${timeoutMs}ms`),
            { txid, timeout: true }
        )
    }

    const blockNum = tx.block_num || tx.block_number

    if (!irreversible) {
        return {
            txid,
            blockNum,
            irreversible: false,
            tx,
        }
    }

    // Phase 2 — wait for that block to pass LIB
    while (Date.now() < deadline) {
        const lib = await getLIB()
        if (blockNum <= lib) {
            return {
                txid,
                blockNum,
                lib,
                irreversible: true,
                tx,
            }
        }
        await sleep(pollMs)
    }

    throw Object.assign(
        new Error(`Tx ${txid} in block ${blockNum} but did not reach LIB within ${timeoutMs}ms`),
        { txid, blockNum, timeout: true, partialConfirm: true }
    )
}

/**
 * isConfirmed — quick check if a tx is already confirmed.
 * Returns { confirmed, irreversible, blockNum } without waiting.
 */
export async function isConfirmed(txid) {
    const tx = await fetchTx(txid)
    if (!tx) return { confirmed: false, irreversible: false, blockNum: null }

    const blockNum = tx.block_num || tx.block_number
    const lib      = await getLIB()

    return {
        confirmed:    true,
        irreversible: blockNum <= lib,
        blockNum,
        lib,
        tx,
    }
}

/**
 * confirmMany — confirm multiple transactions in parallel.
 * Returns array of results in same order as input txids.
 */
export async function confirmMany(txids, opts = {}) {
    return Promise.allSettled(
        txids.map(txid => waitForConfirmation(txid, opts))
    )
}
