/**
 * broadcast.js — Push signed transactions to the chain
 *
 * Separates broadcasting from signing.
 * Handles:
 *  - Pushing a signed tx via nodeos push_transaction
 *  - Catching and parsing chain error responses clearly
 *  - Optionally waiting for confirmation after push
 *  - Dry-run / compute mode (simulate without writing to chain)
 *
 * Verified against Vaulta mainnet — June 2026
 * Requires Node.js 24+
 */

import { post }                from '@vaultclean/chain/rpc'
import { waitForConfirmation } from '@vaultclean/chain/confirm'

function parseChainError(err) {
    try {
        const body   = typeof err.body === 'string' ? JSON.parse(err.body) : err.body
        const detail = body?.error?.details?.[0]?.message
            || body?.error?.what
            || body?.message
            || err.message
        return Object.assign(new Error(detail), {
            chainError: true,
            errorCode:  body?.error?.code,
            errorName:  body?.error?.name,
            raw:        body,
        })
    } catch {
        return err
    }
}

/**
 * broadcast — push a signed transaction to the chain.
 *
 * @param {object}  signedTx           — result from sign.js signTransaction()
 * @param {boolean} opts.confirm       — wait for confirmation (default: true)
 * @param {boolean} opts.irreversible  — wait for LIB (default: true)
 * @param {boolean} opts.dryRun        — simulate only, no state change
 */
export async function broadcast(signedTx, {
    confirm      = true,
    irreversible = true,
    dryRun       = false,
} = {}) {
    const endpoint = dryRun
        ? '/v1/chain/compute_transaction'
        : '/v1/chain/push_transaction'

    const body = {
        signatures:                signedTx.signatures,
        compression:               'none',
        packed_context_free_data:  '',
        packed_trx:                signedTx.packed_trx?.toString() || signedTx.packed_trx,
    }

    let result
    try {
        result = await post(endpoint, body)
    } catch (err) {
        throw parseChainError(err)
    }

    const txid = result.transaction_id || result.id

    if (dryRun) return { success: true, dryRun: true, txid, result }
    if (!txid)  throw Object.assign(new Error('broadcast: no transaction_id in response'), { result })
    if (!confirm) return { success: true, txid, confirmed: false, result }

    const confirmation = await waitForConfirmation(txid, { irreversible })

    return {
        success:      true,
        txid,
        blockNum:     confirmation.blockNum,
        irreversible: confirmation.irreversible,
        lib:          confirmation.lib,
        result,
    }
}

/**
 * broadcastMany — push multiple signed transactions sequentially.
 * Collects all results — does not stop on failure.
 */
export async function broadcastMany(signedTxs, opts = {}) {
    const results = []
    for (const signedTx of signedTxs) {
        try {
            results.push({ ok: true,  ...(await broadcast(signedTx, opts)) })
        } catch (err) {
            results.push({ ok: false, error: err.message, raw: err })
        }
    }
    return results
}

/**
 * simulate — dry-run without writing to chain.
 * Good for estimating CPU/NET cost before committing.
 */
export const simulate = (signedTx) =>
    broadcast(signedTx, { dryRun: true, confirm: false })
