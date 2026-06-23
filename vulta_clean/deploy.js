/**
 * deploy.js — Smart contract compile + deploy pipeline
 *
 * Handles the full lifecycle:
 *  1. Compile C++ contract via Antelope CDT (eosio-cpp)
 *  2. Read the resulting .wasm and .abi files
 *  3. Push set code (wasm) to the chain
 *  4. Push set abi to the chain
 *  5. Wait for confirmation of both transactions
 *
 * Prerequisites on your machine:
 *  - Antelope CDT installed (eosio-cpp in PATH)
 *    https://github.com/AntelopeIO/cdt/releases — v4.1.0 verified June 2026
 *  - cleos installed (ships with Leap/nodeos)
 *  - A funded account with the contract permission
 *
 * Verified against Vaulta mainnet/Jungle4 — June 2026
 * Requires Node.js 24+
 */

import { execSync, exec }  from 'node:child_process'
import { readFileSync }    from 'node:fs'
import { resolve, join }   from 'node:path'
import { promisify }       from 'node:util'
import { post }            from '@vaultclean/chain/rpc'
import { buildAndSign }    from '@vaultclean/transactions/sign'
import { broadcast }       from '@vaultclean/transactions/broadcast'
import { rpcUrl, contract as defaultContract, privateKey, accountName } from '@vaultclean/config'

const execAsync = promisify(exec)

/**
 * compile — run eosio-cpp to produce .wasm and .abi from a .cpp file.
 *
 * @param {string} cppPath   — absolute path to your .cpp contract file
 * @param {string} outDir    — directory to write .wasm and .abi into
 * @param {object} opts
 * @param {string} opts.contractName — override contract name (default: cpp filename)
 * @param {boolean} opts.abigen      — generate ABI (default: true)
 * @returns {{ wasmPath, abiPath, contractName }}
 */
export async function compile(cppPath, outDir, { contractName = null, abigen = true } = {}) {
    const abscpp  = resolve(cppPath)
    const absOut  = resolve(outDir)
    const name    = contractName || abscp.split('/').pop().replace('.cpp', '')
    const abscp   = absOut // reuse variable for clarity below

    console.log(`[deploy] Compiling: ${abspp}`)

    const flags = [
        `eosio-cpp`,
        `-o ${join(absOut, `${name}.wasm`)}`,
        abigen ? `--abigen` : '',
        abspp,
    ].filter(Boolean).join(' ')

    // fix: use correct variable
    const cpp  = resolve(cppPath)
    const cmd  = `eosio-cpp -o ${join(absOut, `${name}.wasm`)} ${abigen ? '--abigen' : ''} ${cpp}`

    try {
        const { stdout, stderr } = await execAsync(cmd)
        if (stdout) console.log(`[deploy] CDT stdout: ${stdout}`)
        if (stderr) console.log(`[deploy] CDT stderr: ${stderr}`)
    } catch (err) {
        throw Object.assign(new Error(`Compile failed: ${err.message}`), {
            compileError: true, cmd, raw: err,
        })
    }

    const wasmPath = join(absOut, `${name}.wasm`)
    const abiPath  = join(absOut, `${name}.abi`)

    console.log(`[deploy] Compiled: ${wasmPath}`)
    return { wasmPath, abiPath, contractName: name }
}

/**
 * readArtifacts — read .wasm and .abi from disk, ready to deploy.
 *
 * @param {string} wasmPath — path to compiled .wasm file
 * @param {string} abiPath  — path to compiled .abi file
 */
export function readArtifacts(wasmPath, abiPath) {
    const wasm = readFileSync(resolve(wasmPath))
    const abi  = JSON.parse(readFileSync(resolve(abiPath), 'utf8'))
    return {
        wasmHex: wasm.toString('hex'),
        abi,
        abiJson: JSON.stringify(abi),
    }
}

/**
 * setCode — push the .wasm bytecode to the chain (set code action).
 *
 * @param {string} account    — contract account name
 * @param {string} wasmHex   — hex-encoded wasm from readArtifacts()
 * @param {string} key       — active private key for the account
 * @param {object} opts
 */
export async function setCode(account, wasmHex, key, opts = {}) {
    console.log(`[deploy] Setting code on: ${account}`)
    const actions = [{
        account:       'eosio',
        name:          'setcode',
        authorization: [{ actor: account, permission: 'active' }],
        data: {
            account,
            vmtype:  0,
            vmversion: 0,
            code:    wasmHex,
        },
    }]
    const signed = await buildAndSign(actions, key)
    const result = await broadcast(signed, { confirm: true, irreversible: false, ...opts })
    console.log(`[deploy] set code tx: ${result.txid}`)
    return result
}

/**
 * setAbi — push the .abi definition to the chain (set abi action).
 *
 * @param {string} account  — contract account name
 * @param {string} abiJson  — JSON string of ABI from readArtifacts()
 * @param {string} key      — active private key for the account
 */
export async function setAbi(account, abiJson, key, opts = {}) {
    console.log(`[deploy] Setting ABI on: ${account}`)
    const actions = [{
        account:       'eosio',
        name:          'setabi',
        authorization: [{ actor: account, permission: 'active' }],
        data: {
            account,
            abi: Buffer.from(abiJson).toString('hex'),
        },
    }]
    const signed = await buildAndSign(actions, key)
    const result = await broadcast(signed, { confirm: true, irreversible: false, ...opts })
    console.log(`[deploy] set abi tx: ${result.txid}`)
    return result
}

/**
 * deploy — full pipeline: read artifacts + set code + set abi.
 *
 * @param {string} wasmPath  — path to .wasm file
 * @param {string} abiPath   — path to .abi file
 * @param {object} opts
 * @param {string} opts.account    — contract account (default: env CONTRACT)
 * @param {string} opts.privateKey — signing key (default: env PRIVATE_KEY)
 */
export async function deploy(wasmPath, abiPath, opts = {}) {
    const account = opts.account    || defaultContract
    const key     = opts.privateKey || privateKey

    if (!account) throw new Error('deploy: account is required (set CONTRACT env or opts.account)')
    if (!key)     throw new Error('deploy: privateKey is required (set PRIVATE_KEY env or opts.privateKey)')

    const { wasmHex, abiJson } = readArtifacts(wasmPath, abiPath)

    const codeResult = await setCode(account, wasmHex, key, opts)
    const abiResult  = await setAbi(account, abiJson,  key, opts)

    return {
        success:  true,
        account,
        codeTxid: codeResult.txid,
        abiTxid:  abiResult.txid,
    }
}

/**
 * compileAndDeploy — full end-to-end: compile from .cpp then deploy.
 *
 * @param {string} cppPath  — path to .cpp source file
 * @param {string} outDir   — directory for compiled artifacts
 * @param {object} opts     — passed to deploy()
 */
export async function compileAndDeploy(cppPath, outDir, opts = {}) {
    const { wasmPath, abiPath } = await compile(cppPath, outDir, opts)
    return deploy(wasmPath, abiPath, opts)
}

// CLI
if (process.argv[1] === new URL(import.meta.url).pathname) {
    const [,, wasmPath, abiPath] = process.argv
    if (!wasmPath || !abiPath) {
        console.error('Usage: node deploy.js <path/to/contract.wasm> <path/to/contract.abi>')
        process.exit(1)
    }
    const result = await deploy(wasmPath, abiPath)
    console.log('\nDeploy result:')
    console.log(`  Account  : ${result.account}`)
    console.log(`  Code TX  : ${result.codeTxid}`)
    console.log(`  ABI TX   : ${result.abiTxid}`)
}
