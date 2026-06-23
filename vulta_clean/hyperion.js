/**
 * hyperion.js — Hyperion History API v2 module
 *
 * Hyperion is the #1 history/indexer solution for Vaulta/EOS.
 * Indexes every action, transaction, table delta on chain.
 *
 * Mainnet endpoints (April 2026):
 *   EOS Nation  : https://eos.eosusa.io
 *   EOSphere    : https://eos.eosphere.io
 * Jungle testnet:
 *   CryptoLions : https://jungle4.cryptolions.io
 */

const HYPERION = {
    mainnet: process.env.HYPERION_URL || 'https://eos.eosusa.io',
    jungle:  'https://jungle4.cryptolions.io',
}
const DEFAULT_API = HYPERION.mainnet

export async function checkHealth({ api = DEFAULT_API } = {}) {
    const res = await fetch(`${api}/v2/health`)
    return res.json()
}

export async function getActions({ account, limit = 20, skip = 0, after = null, before = null, filter = null, api = DEFAULT_API } = {}) {
    const params = new URLSearchParams({ account, limit, skip, ...(after && { after }), ...(before && { before }), ...(filter && { filter }) })
    return fetch(`${api}/v2/history/get_actions?${params}`).then(r => r.json())
}

export async function getTransactions({ account, limit = 20, skip = 0, api = DEFAULT_API } = {}) {
    const params = new URLSearchParams({ account, limit, skip })
    return fetch(`${api}/v2/history/get_transactions?${params}`).then(r => r.json())
}

export async function getTransaction({ id, api = DEFAULT_API } = {}) {
    return fetch(`${api}/v2/history/get_transaction?id=${id}`).then(r => r.json())
}

export async function getTransfers({ account, token_contract = null, symbol = null, limit = 20, skip = 0, api = DEFAULT_API } = {}) {
    const filter = token_contract ? `${token_contract}:transfer` : 'eosio.token:transfer,core.vaulta:transfer'
    return getActions({ account, limit, skip, filter, api })
}

export async function getVaultActions({ account, contract = 'vaultclean', limit = 20, skip = 0, api = DEFAULT_API } = {}) {
    return getActions({ account, limit, skip, filter: `${contract}:*`, api })
}

export async function getBalances({ account, api = DEFAULT_API } = {}) {
    return fetch(`${api}/v2/state/get_tokens?account=${account}`).then(r => r.json())
}

export async function getTableRows({ code, table, scope = null, limit = 10, api = DEFAULT_API } = {}) {
    const params = new URLSearchParams({ code, table, scope: scope || code, limit })
    return fetch(`${api}/v2/state/get_table_rows?${params}`).then(r => r.json())
}

export function streamActions({ account, action = '*', callback, api = DEFAULT_API } = {}) {
    const wsUrl = api.replace('https://', 'wss://').replace('http://', 'ws://')
    const ws = new WebSocket(`${wsUrl}/v2/history/stream`)
    ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'action', account, action, start_from: 0 }))
        console.log(`Streaming ${account}::${action}`)
    }
    ws.onmessage = (e) => { try { if (callback) callback(JSON.parse(e.data)) } catch {} }
    ws.onerror   = (e) => console.error('WS error:', e)
    ws.onclose   = ()  => console.log('Stream closed.')
    return ws
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
    const account = process.argv[2] || 'eosio'
    const api     = process.argv[3] || DEFAULT_API
    console.log(`\nHyperion | ${api} | ${account}`)
    const health = await checkHealth({ api })
    console.log(`Health: ${health.status}`)
    const actions = await getVaultActions({ account, limit: 5, api })
    console.log(`\nLast 5 vault actions:`)
    for (const a of actions.actions || []) console.log(`  ${a.timestamp}  ${a.act.account}::${a.act.name}`)
    const transfers = await getTransfers({ account, limit: 5, api })
    console.log(`\nLast 5 transfers:`)
    for (const a of transfers.actions || []) {
        const d = a.act.data
        console.log(`  ${a.timestamp}  ${d.from} → ${d.to}  ${d.quantity}`)
    }
}
