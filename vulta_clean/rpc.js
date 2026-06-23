/**
 * rpc.js — Base HTTP/fetch layer for Vaulta nodeos RPC
 *
 * Handles:
 *  - POST and GET requests to nodeos v1 chain API
 *  - Automatic retry with exponential backoff
 *  - Endpoint failover across multiple RPC nodes
 *  - Consistent error shape for all callers
 *
 * Every other chain module imports from here.
 * Nothing talks to nodeos directly except this file.
 *
 * Verified against Vaulta mainnet — June 2026
 * Requires Node.js 24+ (native fetch, no polyfill needed)
 */

import { allRpcUrls, rpcUrl } from '@vaultclean/config'

const DEFAULT_RETRIES    = 3
const BASE_BACKOFF_MS    = 300   // doubles each retry: 300, 600, 1200
const REQUEST_TIMEOUT_MS = 10000 // 10s per attempt

/**
 * Sleep helper
 */
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * Single RPC call — POST or GET to a specific endpoint.
 * Throws a structured error on failure.
 */
export async function rpcCall({ url, endpoint, body = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const fullUrl = `${url}${endpoint}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
        const opts = body
            ? {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(body),
                signal:  controller.signal,
              }
            : { method: 'GET', signal: controller.signal }

        const res = await fetch(fullUrl, opts)

        if (!res.ok) {
            const text = await res.text().catch(() => '')
            throw Object.assign(new Error(`RPC ${res.status} @ ${fullUrl}`), {
                status:   res.status,
                endpoint: fullUrl,
                body:     text,
            })
        }

        return await res.json()
    } catch (err) {
        if (err.name === 'AbortError') {
            throw Object.assign(new Error(`RPC timeout after ${timeoutMs}ms @ ${fullUrl}`), {
                timeout:  true,
                endpoint: fullUrl,
            })
        }
        throw err
    } finally {
        clearTimeout(timer)
    }
}

/**
 * rpc — Call a single endpoint with automatic retry + backoff.
 * Uses the primary rpcUrl from config by default.
 */
export async function rpc({
    endpoint,
    body     = null,
    url      = rpcUrl,
    retries  = DEFAULT_RETRIES,
    timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
    let lastErr
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await rpcCall({ url, endpoint, body, timeoutMs })
        } catch (err) {
            lastErr = err
            if (attempt < retries) {
                const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt)
                await sleep(backoff)
            }
        }
    }
    throw lastErr
}

/**
 * rpcWithFailover — Try each endpoint in turn until one succeeds.
 * Falls back through all known RPC nodes before giving up.
 */
export async function rpcWithFailover({
    endpoint,
    body      = null,
    urls      = allRpcUrls,
    retries   = 1,
    timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
    let lastErr
    for (const url of urls) {
        try {
            return await rpc({ endpoint, body, url, retries, timeoutMs })
        } catch (err) {
            lastErr = err
        }
    }
    throw Object.assign(lastErr, { allEndpointsFailed: true, endpoints: urls })
}

/**
 * Convenience wrappers — mirrors the nodeos v1 chain API shape.
 * These are what onchain.js and other modules call.
 */
export const post = (endpoint, body, opts = {}) =>
    rpcWithFailover({ endpoint, body, ...opts })

export const get = (endpoint, opts = {}) =>
    rpcWithFailover({ endpoint, body: null, ...opts })

/**
 * Health check — returns true if the RPC node is reachable.
 */
export async function isReachable(url = rpcUrl) {
    try {
        await rpcCall({ url, endpoint: '/v1/chain/get_info', timeoutMs: 3000 })
        return true
    } catch {
        return false
    }
}

/**
 * Pick the fastest reachable endpoint from a list.
 * Races all endpoints and returns whichever responds first.
 */
export async function fastestEndpoint(urls = allRpcUrls) {
    try {
        return await Promise.any(
            urls.map(url =>
                rpcCall({ url, endpoint: '/v1/chain/get_info', timeoutMs: 5000 })
                    .then(() => url)
            )
        )
    } catch {
        return urls[0] // fall back to primary if all fail
    }
}
