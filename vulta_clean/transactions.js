/**
 * transactions.js — Build and push transactions via Wharfkit
 */

import { Session, ChainDefinition } from '@wharfkit/session'
import { WalletPluginPrivateKey }   from '@wharfkit/wallet-plugin-privatekey'
import { WalletPluginAnchor }       from '@wharfkit/wallet-plugin-anchor'

export const CHAINS = {
    mainnet: ChainDefinition.from({ id: 'aca376f206b8fc25a6ed44dbdc66547c36c6c33d3a5402eba3c57778be1ad15', url: process.env.NODE_URL || 'https://eos.greymass.com' }),
    jungle:  ChainDefinition.from({ id: '73e4385a2708e6d7048834fbc1079f2fabb17b3c125b146af438971e90716c4d', url: 'https://jungle4.cryptolions.io' }),
}

export function makePrivKeySession({ privateKey, actor, permission = 'active', network = 'mainnet' }) {
    return new Session({ chain: CHAINS[network], walletPlugin: new WalletPluginPrivateKey(privateKey), actor, permission })
}
export async function makeAnchorSession({ network = 'mainnet' } = {}) {
    const s = new Session({ chain: CHAINS[network], walletPlugin: new WalletPluginAnchor() })
    await s.login()
    return s
}

async function tx(session, actions) {
    try {
        const r = await session.transact({ actions })
        return { success: true, txid: r.response?.transaction_id, result: r }
    } catch (e) { return { success: false, error: e.message || String(e) } }
}
const act = (account, name, data, actor, permission = 'active') =>
    ({ account, name, authorization: [{ actor, permission }], data })

export const transferEOS = ({ session, from, to, amount, memo = '' }) =>
    tx(session, [act('eosio.token', 'transfer', { from, to, quantity: `${(+amount).toFixed(4)} EOS`, memo }, from)])
export const transferA   = ({ session, from, to, amount, memo = '' }) =>
    tx(session, [act('core.vaulta', 'transfer', { from, to, quantity: `${(+amount).toFixed(4)} A`,   memo }, from)])

export const swapToA = ({ session, from, to, eosAmount, memo = 'swapto' }) =>
    tx(session, [act('core.vaulta', 'swapto', { from, to, quantity: `${(+eosAmount).toFixed(4)} EOS`, memo }, from)])

export const walletSwapEOStoA = ({ session, account, amount }) =>
    tx(session, [act('eosio.token', 'transfer', { from: account, to: 'core.vaulta', quantity: `${(+amount).toFixed(4)} EOS`, memo: 'swap' }, account)])
export const walletSwapAtoEOS = ({ session, account, amount }) =>
    tx(session, [act('core.vaulta', 'transfer', { from: account, to: 'core.vaulta', quantity: `${(+amount).toFixed(4)} A`,   memo: 'swap' }, account)])

export const depositEOS = ({ session, user, contract = 'vaultclean', amount }) =>
    tx(session, [act('eosio.token', 'transfer', { from: user, to: contract, quantity: `${(+amount).toFixed(4)} EOS`, memo: 'deposit' }, user)])
export const depositA   = ({ session, user, contract = 'vaultclean', amount }) =>
    tx(session, [act('core.vaulta', 'transfer', { from: user, to: contract, quantity: `${(+amount).toFixed(4)} A`,   memo: 'deposit' }, user)])
export const depositViaSwapTo = ({ session, user, contract = 'vaultclean', eosAmount }) =>
    swapToA({ session, from: user, to: contract, eosAmount, memo: 'deposit via swapto' })

export const vaultEOStoA = ({ session, user, contract = 'vaultclean', amount }) =>
    tx(session, [act(contract, 'eostoa', { user, eos_quantity: `${(+amount).toFixed(4)} EOS` }, user)])
export const vaultAtoEOS = ({ session, user, contract = 'vaultclean', amount }) =>
    tx(session, [act(contract, 'a2eos',  { user, a_quantity:   `${(+amount).toFixed(4)} A`   }, user)])

export const withdrawEOS = ({ session, user, contract = 'vaultclean', amount }) =>
    tx(session, [act(contract, 'withdraweos', { user, quantity: `${(+amount).toFixed(4)} EOS` }, user)])
export const withdrawA   = ({ session, user, contract = 'vaultclean', amount }) =>
    tx(session, [act(contract, 'withdrawa',   { user, quantity: `${(+amount).toFixed(4)} A`   }, user)])

export const addUser    = ({ session, contract = 'vaultclean', user })      => tx(session, [act(contract, 'adduser',    { user },    contract)])
export const removeUser = ({ session, contract = 'vaultclean', user })      => tx(session, [act(contract, 'removeuser', { user },    contract)])
export const setPaused  = ({ session, contract = 'vaultclean', paused })    => tx(session, [act(contract, 'setpaused',  { paused },  contract)])
export const setRate    = ({ session, contract = 'vaultclean', numerator }) => tx(session, [act(contract, 'setrate',    { numerator }, contract)])
export const emergDrain = ({ session, contract = 'vaultclean', to, quantity, memo = 'drain' }) =>
    tx(session, [act(contract, 'emergdrain', { to, quantity, memo }, contract)])

export const depositAndSwap = ({ session, user, contract = 'vaultclean', amount }) =>
    tx(session, [
        act('eosio.token', 'transfer', { from: user, to: contract, quantity: `${(+amount).toFixed(4)} EOS`, memo: 'deposit' }, user),
        act(contract, 'eostoa', { user, eos_quantity: `${(+amount).toFixed(4)} EOS` }, user),
    ])
