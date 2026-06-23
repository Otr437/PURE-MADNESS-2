/**
 * sign.js — Transaction signing layer
 *
 * Separates signing from broadcasting.
 * Handles:
 *  - Building raw transactions from action arrays
 *  - Signing with a private key (local, no wallet daemon needed)
 *  - Returning signed tx ready for broadcast — without pushing it
 *  - Multi-sig support (collect multiple signatures)
 *
 * Why separate from broadcast?
 *  - Test signing without hitting the chain
 *  - Air-gapped / offline signing workflows
 *  - Inspect the tx before it goes out
 *  - Sign on one machine, broadcast from another
 *
 * Verified against Vaulta mainnet — June 2026
 * Requires: @wharfkit/antelope@1.1.1, @wharfkit/session@1.6.1
 */

import { ABI, Action, Transaction, PrivateKey, Signature } from '@wharfkit/antelope'
import { post } from '@vaultclean/chain/rpc'
import { chainId, rpcUrl } from '@vaultclean/config'

/**
 * Fetch the current chain header info needed to build a valid tx.
 * (expiration, ref_block_num, ref_block_prefix)
 */
async function getChainHeader() {
    const info  = await post('/v1/chain/get_info', {})
    const block = await post('/v1/chain/get_block', { block_num_or_id: info.last_irreversible_block_num })
    return {
        expiration:        new Date(Date.now() + 60_000).toISOString().slice(0, 19), // +60s
        ref_block_num:     block.block_num & 0xffff,
        ref_block_prefix:  block.ref_block_prefix,
    }
}

/**
 * buildTransaction — construct a raw unsigned transaction object.
 *
 * @param {Array}  actions  — array of action objects { account, name, authorization, data }
 * @returns {object}        — unsigned transaction ready for signing
 */
export async function buildTransaction(actions) {
    const header = await getChainHeader()
    return {
        ...header,
        max_net_usage_words: 0,
        max_cpu_usage_ms:    0,
        delay_sec:           0,
        context_free_actions: [],
        actions,
        transaction_extensions: [],
    }
}

/**
 * signTransaction — sign a raw transaction with a private key.
 *
 * @param {object} transaction  — unsigned transaction from buildTransaction()
 * @param {string} privateKeyStr — WIF or PEM private key string
 * @returns {{ signatures, packed_trx, signed_transaction }}
 */
export async function signTransaction(transaction, privateKeyStr) {
    if (!privateKeyStr) throw new Error('signTransaction: privateKey is required')

    const key = PrivateKey.from(privateKeyStr)

    // Serialize the transaction to get the signing digest
    const tx          = Transaction.from(transaction)
    const digest      = tx.signingDigest(chainId)
    const signature   = key.signDigest(digest)

    return {
        signatures:         [signature.toString()],
        signed_transaction: tx,
        packed_trx:         tx,
    }
}

/**
 * buildAndSign — convenience: build + sign in one call.
 *
 * @param {Array}  actions       — action objects
 * @param {string} privateKeyStr — signing key
 */
export async function buildAndSign(actions, privateKeyStr) {
    const tx = await buildTransaction(actions)
    return signTransaction(tx, privateKeyStr)
}

/**
 * addSignature — add an additional signature to an already-signed tx.
 * Used for multi-sig workflows where multiple keys are required.
 *
 * @param {object} signedTx      — result from signTransaction()
 * @param {string} privateKeyStr — additional signing key
 */
export function addSignature(signedTx, privateKeyStr) {
    const key       = PrivateKey.from(privateKeyStr)
    const digest    = signedTx.signed_transaction.signingDigest(chainId)
    const signature = key.signDigest(digest)
    return {
        ...signedTx,
        signatures: [...signedTx.signatures, signature.toString()],
    }
}

/**
 * verifySignature — verify a signature matches a public key and tx digest.
 * Useful for confirming a co-signer actually signed before broadcasting.
 *
 * @param {object} signedTx  — result from signTransaction()
 * @param {string} publicKey — expected public key string
 * @returns {boolean}
 */
export function verifySignature(signedTx, publicKey) {
    try {
        const digest = signedTx.signed_transaction.signingDigest(chainId)
        for (const sigStr of signedTx.signatures) {
            const sig         = Signature.from(sigStr)
            const recoveredPk = sig.recoverDigest(digest)
            if (recoveredPk.toString() === publicKey) return true
        }
        return false
    } catch {
        return false
    }
}

/**
 * makeAction — helper to build a single action object cleanly.
 */
export const makeAction = (account, name, data, actor, permission = 'active') => ({
    account,
    name,
    authorization: [{ actor, permission }],
    data,
})
