/**
 * ship.js — State History Plugin (SHiP) WebSocket client
 *
 * SHiP is the native Vaulta/Antelope streaming interface.
 * Connects via WebSocket to nodeos state_history_plugin.
 * Delivers real-time block traces and table deltas as they happen.
 *
 * Use cases:
 *  - Watch for specific contract actions in real time
 *  - Monitor table changes (balance updates, config changes)
 *  - Build event-driven pipelines without polling
 *
 * Verified against Vaulta mainnet — June 2026
 * Requires Node.js 24+ (native WebSocket)
 */

import { shipUrl } from '@vaultclean/config'

/**
 * SHiPClient — connects to a nodeos SHiP endpoint and streams blocks.
 *
 * Usage:
 *   const client = new SHiPClient()
 *   await client.connect()
 *   client.onBlock(block => console.log(block))
 *   client.subscribe({ start_block_num: 0, end_block_num: 0xffffffff })
 */
export class SHiPClient {
    constructor({ url = shipUrl, reconnectMs = 5000 } = {}) {
        this.url         = url
        this.reconnectMs = reconnectMs
        this.ws          = null
        this.connected   = false
        this._blockCb    = null
        this._traceCb    = null
        this._deltaCb    = null
        this._errorCb    = null
        this._closeCb    = null
        this._reconnect  = true
    }

    /**
     * Connect to SHiP endpoint.
     * Resolves when the WebSocket handshake completes.
     */
    connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.url)

            this.ws.onopen = () => {
                this.connected = true
                console.log(`[SHiP] Connected: ${this.url}`)
                resolve(this)
            }

            this.ws.onerror = (err) => {
                if (!this.connected) reject(err)
                if (this._errorCb) this._errorCb(err)
            }

            this.ws.onclose = () => {
                this.connected = false
                console.log('[SHiP] Disconnected')
                if (this._closeCb) this._closeCb()
                if (this._reconnect) {
                    console.log(`[SHiP] Reconnecting in ${this.reconnectMs}ms...`)
                    setTimeout(() => this.connect(), this.reconnectMs)
                }
            }

            this.ws.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data)
                    this._dispatch(msg)
                } catch (e) {
                    // SHiP can send binary ABI data on first connect — ignore
                }
            }
        })
    }

    /**
     * Subscribe to block range.
     * Set end_block_num to 0xffffffff to stream indefinitely.
     */
    subscribe({
        start_block_num    = 0,
        end_block_num      = 0xffffffff,
        max_messages_in_flight = 10,
        have_positions     = [],
        irreversible_only  = false,
        fetch_block        = true,
        fetch_traces       = true,
        fetch_deltas       = true,
    } = {}) {
        if (!this.connected) throw new Error('[SHiP] Not connected')
        this.ws.send(JSON.stringify([
            'get_blocks_request_v0',
            {
                start_block_num,
                end_block_num,
                max_messages_in_flight,
                have_positions,
                irreversible_only,
                fetch_block,
                fetch_traces,
                fetch_deltas,
            }
        ]))
        return this
    }

    /**
     * Request the next batch of messages (flow control).
     */
    ack(numMessages = 10) {
        if (this.connected) {
            this.ws.send(JSON.stringify(['get_blocks_ack_request_v0', { num_messages: numMessages }]))
        }
        return this
    }

    /** Register callback for each block received */
    onBlock(cb)  { this._blockCb = cb;  return this }

    /** Register callback for action traces */
    onTrace(cb)  { this._traceCb = cb;  return this }

    /** Register callback for table deltas */
    onDelta(cb)  { this._deltaCb = cb;  return this }

    /** Register callback for errors */
    onError(cb)  { this._errorCb = cb;  return this }

    /** Register callback for disconnect */
    onClose(cb)  { this._closeCb = cb;  return this }

    /**
     * Disconnect cleanly.
     */
    disconnect() {
        this._reconnect = false
        if (this.ws) this.ws.close()
    }

    _dispatch(msg) {
        if (!Array.isArray(msg)) return
        const [type, data] = msg

        if (type === 'get_blocks_result_v0') {
            if (this._blockCb  && data.block)   this._blockCb(data)
            if (this._traceCb  && data.traces)  this._traceCb(data.traces, data)
            if (this._deltaCb  && data.deltas)  this._deltaCb(data.deltas, data)
            this.ack(1) // auto-ack each message
        }
    }
}

/**
 * watchContract — convenience wrapper.
 * Streams all actions for a specific contract account.
 *
 * @param {string}   contract  — account name to watch
 * @param {function} callback  — called with each matching action trace
 * @param {object}   opts      — SHiPClient + subscribe options
 */
export async function watchContract(contract, callback, opts = {}) {
    const client = new SHiPClient({ url: opts.url })
    await client.connect()

    client.onTrace((traces) => {
        for (const trace of traces) {
            const actions = trace[1]?.action_traces || []
            for (const action of actions) {
                if (action[1]?.act?.account === contract) {
                    callback(action[1], trace)
                }
            }
        }
    })

    client.subscribe({
        start_block_num: opts.start_block_num || 0,
        fetch_block:     false,
        fetch_traces:    true,
        fetch_deltas:    opts.fetch_deltas || false,
    })

    return client
}
