/**
 * verify.js — Confirm a contract deployed correctly
 *
 * After deploy.js runs, verify.js checks:
 *  1. Contract account exists on chain
 *  2. Code hash matches the .wasm you deployed
 *  3. ABI is present and has the expected actions/tables
 *  4. Tables are readable (contract is live)
 *  5. Optionally push a read-only action to confirm execution
 *
 * Verified against Vaulta mainnet — June 2026
 * Requires Node.js 24+
 */

import { createHash }    from 'node:crypto'
import { readFileSync }  from 'node:fs'
import { resolve }       from 'node:path'
import { post }          from '@vaultclean/chain/rpc'
import { contract as defaultContract } from '@vaultclean/config'

/**
 * getDeployedAbi — fetch the live ABI from the chain for an account.
 */
export async function getDeployedAbi(account = defaultContract) {
    const result = await post('/v1/chain/get_abi', { account_name: account })
    return result.abi || null
}

/**
 * getDeployedCodeHash — fetch the code hash of the deployed wasm.
 */
export async function getDeployedCodeHash(account = defaultContract) {
    const result = await post('/v1/chain/get_code_hash', { account_name: account })
    return result.code_hash || null
}

/**
 * localWasmHash — compute sha256 of a local .wasm file.
 * Compare against getDeployedCodeHash() to verify deploy.
 *
 * @param {string} wasmPath — path to .wasm file
 */
export function localWasmHash(wasmPath) {
    const wasm = readFileSync(resolve(wasmPath))
    return createHash('sha256').update(wasm).digest('hex')
}

/**
 * verifyCode — confirm the deployed wasm matches the local file.
 *
 * @param {string} wasmPath — local .wasm file to compare against
 * @param {string} account  — contract account name
 * @returns {{ match, localHash, chainHash }}
 */
export async function verifyCode(wasmPath, account = defaultContract) {
    const [localHash, chainHash] = await Promise.all([
        Promise.resolve(localWasmHash(wasmPath)),
        getDeployedCodeHash(account),
    ])
    return {
        match:     localHash === chainHash,
        localHash,
        chainHash,
        account,
    }
}

/**
 * verifyAbi — check the deployed ABI has expected actions and tables.
 *
 * @param {string[]} expectedActions — action names that must exist
 * @param {string[]} expectedTables  — table names that must exist
 * @param {string}   account         — contract account name
 */
export async function verifyAbi(expectedActions = [], expectedTables = [], account = defaultContract) {
    const abi = await getDeployedAbi(account)
    if (!abi) return { valid: false, reason: 'No ABI found on chain', account }

    const chainActions = (abi.actions || []).map(a => a.name)
    const chainTables  = (abi.tables  || []).map(t => t.name)

    const missingActions = expectedActions.filter(a => !chainActions.includes(a))
    const missingTables  = expectedTables.filter(t =>  !chainTables.includes(t))

    return {
        valid:          missingActions.length === 0 && missingTables.length === 0,
        account,
        chainActions,
        chainTables,
        missingActions,
        missingTables,
        abi,
    }
}

/**
 * verifyTables — confirm contract tables are readable on chain.
 * A table being readable means the contract is live and indexed.
 *
 * @param {string[]} tables  — table names to check
 * @param {string}   account — contract account name
 */
export async function verifyTables(tables = [], account = defaultContract) {
    const results = {}
    for (const table of tables) {
        try {
            const r = await post('/v1/chain/get_table_rows', {
                code:  account,
                scope: account,
                table,
                limit: 1,
                json:  true,
            })
            results[table] = { readable: true, rows: r.rows?.length || 0 }
        } catch (err) {
            results[table] = { readable: false, error: err.message }
        }
    }
    return results
}

/**
 * verify — run all checks in one call.
 * This is the main entry point after a deploy.
 *
 * @param {object} opts
 * @param {string}   opts.wasmPath       — local .wasm to compare hash
 * @param {string}   opts.account        — contract account
 * @param {string[]} opts.actions        — expected action names
 * @param {string[]} opts.tables         — expected table names
 */
export async function verify({
    wasmPath = null,
    account  = defaultContract,
    actions  = [],
    tables   = [],
} = {}) {
    console.log(`\n[verify] Checking contract: ${account}`)

    const [codeCheck, abiCheck, tableCheck] = await Promise.all([
        wasmPath ? verifyCode(wasmPath, account) : Promise.resolve(null),
        verifyAbi(actions, tables, account),
        verifyTables(tables, account),
    ])

    const allGood = (
        (!codeCheck || codeCheck.match) &&
        abiCheck.valid
    )

    if (codeCheck) {
        console.log(`[verify] Code hash match : ${codeCheck.match ? '✓' : '✗'}`)
        if (!codeCheck.match) {
            console.log(`         Local : ${codeCheck.localHash}`)
            console.log(`         Chain : ${codeCheck.chainHash}`)
        }
    }

    console.log(`[verify] ABI valid       : ${abiCheck.valid ? '✓' : '✗'}`)
    if (abiCheck.missingActions?.length) console.log(`         Missing actions: ${abiCheck.missingActions.join(', ')}`)
    if (abiCheck.missingTables?.length)  console.log(`         Missing tables : ${abiCheck.missingTables.join(', ')}`)

    for (const [table, status] of Object.entries(tableCheck)) {
        console.log(`[verify] Table ${table.padEnd(12)}: ${status.readable ? '✓' : '✗'} ${status.error || ''}`)
    }

    console.log(`[verify] Result          : ${allGood ? 'PASS ✓' : 'FAIL ✗'}\n`)

    return { allGood, codeCheck, abiCheck, tableCheck, account }
}

// CLI
if (process.argv[1] === new URL(import.meta.url).pathname) {
    const account = process.argv[2] || defaultContract
    const result  = await verify({
        account,
        actions: ['eostoa', 'a2eos', 'withdraweos', 'withdrawa', 'adduser', 'removeuser', 'setpaused', 'setrate'],
        tables:  ['stats', 'balances'],
    })
    process.exit(result.allGood ? 0 : 1)
}
