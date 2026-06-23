/**
 * onchain.js — Direct Vaulta/EOS chain RPC module
 * Reads live on-chain state from nodeos RPC v1 chain API.
 */

const DEFAULT_RPC      = process.env.NODE_URL  || 'https://eos.greymass.com'
const DEFAULT_CONTRACT = process.env.CONTRACT  || 'vaultclean'

async function rpc(endpoint, body = null, rpcUrl = DEFAULT_RPC) {
    const opts = body
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : { method: 'GET' }
    const res = await fetch(`${rpcUrl}${endpoint}`, opts)
    if (!res.ok) throw new Error(`RPC ${endpoint} failed: ${res.status}`)
    return res.json()
}

export const getChainInfo    = ({ rpcUrl = DEFAULT_RPC } = {}) =>
    rpc('/v1/chain/get_info', null, rpcUrl)
export const getBlock        = ({ block_num_or_id, rpcUrl = DEFAULT_RPC } = {}) =>
    rpc('/v1/chain/get_block', { block_num_or_id }, rpcUrl)
export const getTransaction  = ({ id, rpcUrl = DEFAULT_RPC } = {}) =>
    rpc('/v1/history/get_transaction', { id }, rpcUrl)

export const getAccount      = ({ account_name, rpcUrl = DEFAULT_RPC } = {}) =>
    rpc('/v1/chain/get_account', { account_name }, rpcUrl)
export const getAbi          = ({ account_name, rpcUrl = DEFAULT_RPC } = {}) =>
    rpc('/v1/chain/get_abi', { account_name }, rpcUrl)
export async function accountExists({ account_name, rpcUrl = DEFAULT_RPC } = {}) {
    try { await getAccount({ account_name, rpcUrl }); return true } catch { return false }
}

export const getCurrencyBalance = ({ code, account, symbol = null, rpcUrl = DEFAULT_RPC } = {}) =>
    rpc('/v1/chain/get_currency_balance', { code, account, symbol }, rpcUrl)
export const getCurrencyStats   = ({ code, symbol, rpcUrl = DEFAULT_RPC } = {}) =>
    rpc('/v1/chain/get_currency_stats', { code, symbol }, rpcUrl)

export async function getAllBalances({ account, rpcUrl = DEFAULT_RPC } = {}) {
    const [eosArr, aArr] = await Promise.all([
        getCurrencyBalance({ code: 'eosio.token', account, symbol: 'EOS', rpcUrl }),
        getCurrencyBalance({ code: 'core.vaulta', account, symbol: 'A',   rpcUrl }),
    ])
    return { eos: eosArr[0] || '0.0000 EOS', a: aArr[0] || '0.0000 A' }
}

export async function getTableRows({ code, scope, table, lower_bound = null, upper_bound = null, limit = 10, reverse = false, index_position = 'primary', key_type = null, json = true, rpcUrl = DEFAULT_RPC } = {}) {
    return rpc('/v1/chain/get_table_rows', { code, scope: scope || code, table, lower_bound, upper_bound, limit, reverse, index_position, key_type, json }, rpcUrl)
}

export async function getAllTableRows({ code, scope, table, rpcUrl = DEFAULT_RPC } = {}) {
    let rows = [], next_key = null, more = true
    while (more) {
        const result = await getTableRows({ code, scope, table, lower_bound: next_key, limit: 100, rpcUrl })
        rows = rows.concat(result.rows)
        more = result.more
        next_key = result.next_key
    }
    return rows
}

export async function getVaultStats({ contract = DEFAULT_CONTRACT, rpcUrl = DEFAULT_RPC } = {}) {
    const r = await getTableRows({ code: contract, scope: contract, table: 'stats', limit: 1, rpcUrl })
    return r.rows[0] || null
}

export async function getUserVaultBalance({ account, contract = DEFAULT_CONTRACT, rpcUrl = DEFAULT_RPC } = {}) {
    const r = await getTableRows({ code: contract, scope: contract, table: 'balances', lower_bound: account, upper_bound: account, limit: 1, rpcUrl })
    return r.rows[0] || null
}

export const getAllVaultUsers = ({ contract = DEFAULT_CONTRACT, rpcUrl = DEFAULT_RPC } = {}) =>
    getAllTableRows({ code: contract, scope: contract, table: 'balances', rpcUrl })

export async function getWhitelistedUsers({ contract = DEFAULT_CONTRACT, rpcUrl = DEFAULT_RPC } = {}) {
    const rows = await getAllVaultUsers({ contract, rpcUrl })
    return rows.filter(r => r.whitelisted)
}

export async function getVaultSnapshot({ contract = DEFAULT_CONTRACT, rpcUrl = DEFAULT_RPC } = {}) {
    const [stats, users, chain] = await Promise.all([
        getVaultStats({ contract, rpcUrl }),
        getAllVaultUsers({ contract, rpcUrl }),
        getChainInfo({ rpcUrl }),
    ])
    return { chain_id: chain.chain_id, head_block: chain.head_block_num, timestamp: new Date().toISOString(), contract, stats, users, user_count: users.length, whitelisted: users.filter(u => u.whitelisted).length }
}

export async function getResources({ account_name, rpcUrl = DEFAULT_RPC } = {}) {
    const info = await getAccount({ account_name, rpcUrl })
    return {
        cpu: { used: info.cpu_limit?.used || 0, available: info.cpu_limit?.available || 0, max: info.cpu_limit?.max || 0 },
        net: { used: info.net_limit?.used || 0, available: info.net_limit?.available || 0, max: info.net_limit?.max || 0 },
        ram: { usage: info.ram_usage || 0, quota: info.ram_quota || 0, free: (info.ram_quota || 0) - (info.ram_usage || 0) },
    }
}
