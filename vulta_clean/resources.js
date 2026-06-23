/**
 * resources.js — Vaulta resource management module
 */

import { CHAINS } from './transactions.js'

async function tx(session, actions) {
    try {
        const r = await session.transact({ actions })
        return { success: true, txid: r.response?.transaction_id }
    } catch (e) { return { success: false, error: e.message || String(e) } }
}

export async function powerUp({ session, payer, receiver = null, max_payment = '1.0000 EOS', net_frac = 10000000000, cpu_frac = 40000000000 } = {}) {
    receiver = receiver || payer
    return tx(session, [{ account: 'eosio', name: 'powerup', authorization: [{ actor: payer, permission: 'active' }], data: { payer, receiver, days: 1, net_frac, cpu_frac, max_payment } }])
}

export async function buyRAM({ session, payer, receiver = null, bytes = 65536 } = {}) {
    receiver = receiver || payer
    return tx(session, [{ account: 'eosio', name: 'buyrambytes', authorization: [{ actor: payer, permission: 'active' }], data: { payer, receiver, bytes } }])
}
export async function buyRAMWithEOS({ session, payer, receiver = null, quant = '1.0000 EOS' } = {}) {
    receiver = receiver || payer
    return tx(session, [{ account: 'eosio', name: 'buyram', authorization: [{ actor: payer, permission: 'active' }], data: { payer, receiver, quant } }])
}
export async function sellRAM({ session, account, bytes } = {}) {
    return tx(session, [{ account: 'eosio', name: 'sellram', authorization: [{ actor: account, permission: 'active' }], data: { account, bytes } }])
}

export async function stake({ session, from, receiver = null, stake_cpu_quantity, stake_net_quantity } = {}) {
    receiver = receiver || from
    return tx(session, [{ account: 'eosio', name: 'delegatebw', authorization: [{ actor: from, permission: 'active' }], data: { from, receiver, stake_cpu_quantity, stake_net_quantity, transfer: false } }])
}
export async function unstake({ session, from, receiver = null, unstake_cpu_quantity, unstake_net_quantity } = {}) {
    receiver = receiver || from
    return tx(session, [{ account: 'eosio', name: 'undelegatebw', authorization: [{ actor: from, permission: 'active' }], data: { from, receiver, unstake_cpu_quantity, unstake_net_quantity } }])
}
export async function claimRefund({ session, owner } = {}) {
    return tx(session, [{ account: 'eosio', name: 'refund', authorization: [{ actor: owner, permission: 'active' }], data: { owner } }])
}

export async function getResourceStatus({ account, rpcUrl = 'https://eos.greymass.com' } = {}) {
    const res  = await fetch(`${rpcUrl}/v1/chain/get_account`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account_name: account }) })
    const info = await res.json()
    const pct  = (used, max) => max > 0 ? `${((used / max) * 100).toFixed(1)}%` : '0%'
    return {
        account,
        cpu: { used: info.cpu_limit?.used || 0, available: info.cpu_limit?.available || 0, max: info.cpu_limit?.max || 0, pct: pct(info.cpu_limit?.used, info.cpu_limit?.max) },
        net: { used: info.net_limit?.used || 0, available: info.net_limit?.available || 0, max: info.net_limit?.max || 0, pct: pct(info.net_limit?.used, info.net_limit?.max) },
        ram: { usage: info.ram_usage || 0, quota: info.ram_quota || 0, free: (info.ram_quota || 0) - (info.ram_usage || 0), pct: pct(info.ram_usage, info.ram_quota) },
    }
}
