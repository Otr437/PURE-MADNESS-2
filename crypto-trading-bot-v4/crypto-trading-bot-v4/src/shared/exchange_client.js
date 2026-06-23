'use strict';
/**
 * src/shared/exchange_client.js
 * Generic authenticated REST exchange client.
 * Each strategy bot instantiates its own — zero shared in-process state.
 *
 * Security:
 *   - API secret never logged or exposed in errors
 *   - All params validated before signing
 *   - Retry with exponential backoff on transient failures
 *   - Circuit breaker halts after consecutive failures
 *   - Request deduplication via timestamp nonce
 *   - Response validated for required fields before returning
 */

const axios  = require('axios');
const crypto = require('crypto');

// ── VALID CONSTANTS ────────────────────────────────────────────────────────────
const VALID_SIDES      = new Set(['BUY','SELL']);
const VALID_INTERVALS  = new Set(['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w','1M']);
const VALID_ORDER_TYPES= new Set(['MARKET','LIMIT','STOP_MARKET','STOP_LIMIT','TRAILING_STOP_MARKET']);
const MAX_LIMIT        = 1000;
const MIN_NOTIONAL     = 5;   // most exchanges reject orders < $5 notional

// ── RETRY / CIRCUIT BREAKER ───────────────────────────────────────────────────
const RETRYABLE_CODES  = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES      = 3;

async function withRetry(fn, label) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      // Don't retry auth errors, validation errors, or unknown errors
      if (status && !RETRYABLE_CODES.has(status)) throw err;
      if (attempt < MAX_RETRIES - 1) {
        const delay = Math.min(500 * Math.pow(2, attempt), 5000);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ── EXCHANGE CLIENT ───────────────────────────────────────────────────────────
class ExchangeClient {
  /**
   * @param {object} opts
   * @param {string}  opts.name
   * @param {string}  opts.baseUrl
   * @param {string}  opts.apiKey
   * @param {string}  opts.apiSecret      Never logged
   * @param {number}  [opts.takerFeePercent=0.1]
   * @param {number}  [opts.makerFeePercent=0.05]
   * @param {boolean} [opts.dryRun=true]
   * @param {number}  [opts.timeoutMs=8000]
   * @param {number}  [opts.recvWindow=5000]  Max ms server accepts request after timestamp
   */
  constructor({
    name,
    baseUrl,
    apiKey,
    apiSecret,
    takerFeePercent = 0.1,
    makerFeePercent = 0.05,
    dryRun          = true,
    timeoutMs       = 8_000,
    recvWindow      = 5_000,
  }) {
    // ── Validation ───────────────────────────────────────────────────────────
    if (!baseUrl)   throw new Error('ExchangeClient: baseUrl required');
    if (!apiKey)    throw new Error('ExchangeClient: apiKey required');
    if (!apiSecret) throw new Error('ExchangeClient: apiSecret required');
    if (!/^https?:\/\/.+/.test(baseUrl)) throw new Error(`ExchangeClient: invalid baseUrl "${baseUrl}"`);
    if (takerFeePercent < 0 || takerFeePercent > 5)  throw new RangeError('takerFeePercent must be 0-5');
    if (makerFeePercent < 0 || makerFeePercent > 5)  throw new RangeError('makerFeePercent must be 0-5');

    this.name      = (name || 'exchange').toLowerCase();
    this.fee       = takerFeePercent;
    this.mkrFee    = makerFeePercent;
    this.dryRun    = dryRun;
    this._key      = apiKey;
    this._recvWin  = recvWindow;

    // Secret stored only in closure scope — not on `this`
    const _secret  = apiSecret;
    this._sign     = (query) => crypto.createHmac('sha256', _secret).update(query).digest('hex');

    this.http = axios.create({
      baseURL:         baseUrl,
      timeout:         timeoutMs,
      validateStatus:  null,   // handle all status codes manually
      headers: {
        'User-Agent':  'crypto-trading-bot/4.0',
        'Content-Type':'application/json',
      },
    });

    // Track consecutive failures for circuit breaker
    this._failures   = 0;
    this._circuitOpen= false;
    this._lastFailure= 0;
    this._CB_THRESHOLD    = 5;
    this._CB_RESET_MS     = 30_000;
  }

  // ── CIRCUIT BREAKER ───────────────────────────────────────────────────────
  _checkCircuit() {
    if (!this._circuitOpen) return;
    if (Date.now() - this._lastFailure > this._CB_RESET_MS) {
      this._circuitOpen = false;
      this._failures    = 0;
      return;
    }
    throw new Error(`[${this.name}] Circuit breaker OPEN — exchange requests halted after ${this._failures} failures`);
  }

  _onSuccess() { this._failures = 0; this._circuitOpen = false; }

  _onFailure(err) {
    this._failures++;
    this._lastFailure = Date.now();
    if (this._failures >= this._CB_THRESHOLD) {
      this._circuitOpen = true;
    }
    throw err;
  }

  // ── AUTH HEADER BUILDER ───────────────────────────────────────────────────
  _auth(params = {}) {
    const ts = Date.now();
    const signed = { ...params, timestamp: ts, recvWindow: this._recvWin };
    const qs     = new URLSearchParams(signed).toString();
    return {
      params:  { ...signed, signature: this._sign(qs) },
      headers: {
        'X-MBX-APIKEY': this._key,   // Binance-style; override per-exchange if needed
        'X-API-KEY':    this._key,
      },
    };
  }

  // ── INTERNAL REQUEST ──────────────────────────────────────────────────────
  async _request(method, path, options = {}) {
    this._checkCircuit();
    try {
      const res = await withRetry(
        () => this.http.request({ method, url: path, ...options }),
        `${method} ${path}`
      );

      // Surface exchange-level errors from 2xx responses (e.g. Binance -1121)
      if (res.status >= 400 || (res.data?.code && res.data.code < 0)) {
        const msg = res.data?.msg || res.data?.message || `HTTP ${res.status}`;
        const err = new Error(`[${this.name}] ${method} ${path}: ${msg}`);
        err.code   = res.data?.code;
        err.status = res.status;
        this._onFailure(err);
      }

      this._onSuccess();
      return res.data;
    } catch (err) {
      // Scrub any accidental secret leakage from error messages
      if (err.message?.includes(this._key)) {
        err.message = err.message.replace(this._key, '[REDACTED]');
      }
      this._onFailure(err);
    }
  }

  // ── INPUT VALIDATORS ──────────────────────────────────────────────────────
  _validatePair(pair) {
    if (typeof pair !== 'string' || !/^[A-Z0-9]{2,20}$/.test(pair))
      throw new TypeError(`Invalid pair: "${pair}". Must be uppercase alphanum 2-20 chars.`);
  }

  _validateSide(side) {
    const s = String(side).toUpperCase();
    if (!VALID_SIDES.has(s)) throw new TypeError(`Invalid side: "${side}". Must be BUY or SELL.`);
    return s;
  }

  _validateInterval(interval) {
    if (!VALID_INTERVALS.has(interval))
      throw new TypeError(`Invalid interval: "${interval}". Valid: ${[...VALID_INTERVALS].join(', ')}`);
  }

  _validateQty(qty, label = 'quantity') {
    if (typeof qty !== 'number' || !isFinite(qty) || qty <= 0)
      throw new RangeError(`${label} must be a positive finite number, got: ${qty}`);
  }

  _validatePrice(price, label = 'price') {
    if (typeof price !== 'number' || !isFinite(price) || price <= 0)
      throw new RangeError(`${label} must be a positive finite number, got: ${price}`);
  }

  // ── PUBLIC API ────────────────────────────────────────────────────────────

  /** Current best bid/ask price */
  async getPrice(pair) {
    this._validatePair(pair);
    const data = await this._request('GET', '/api/v3/ticker/price', { params: { symbol: pair } });
    const price = parseFloat(data.price);
    if (!isFinite(price) || price <= 0) throw new Error(`[${this.name}] Invalid price returned for ${pair}: ${data.price}`);
    return price;
  }

  /** L2 order book with depth imbalance */
  async getOrderBook(pair, limit = 10) {
    this._validatePair(pair);
    if (limit < 1 || limit > MAX_LIMIT) throw new RangeError(`limit must be 1-${MAX_LIMIT}`);

    const data   = await this._request('GET', '/api/v3/depth', { params: { symbol: pair, limit } });
    const bids   = data.bids || [];
    const asks   = data.asks || [];
    if (!bids.length || !asks.length) throw new Error(`[${this.name}] Empty order book for ${pair}`);

    const bidVol = bids.reduce((s, [, q]) => s + parseFloat(q), 0);
    const askVol = asks.reduce((s, [, q]) => s + parseFloat(q), 0);
    const totalVol = bidVol + askVol;

    return {
      bid:       parseFloat(bids[0][0]),
      bidSize:   parseFloat(bids[0][1]),
      ask:       parseFloat(asks[0][0]),
      askSize:   parseFloat(asks[0][1]),
      bidVol,
      askVol,
      spread:    parseFloat(asks[0][0]) - parseFloat(bids[0][0]),
      spreadPct: ((parseFloat(asks[0][0]) - parseFloat(bids[0][0])) / parseFloat(bids[0][0])) * 100,
      imbalance: totalVol > 0 ? bidVol / totalVol : 0.5,
      depth:     { bids: bids.slice(0,5), asks: asks.slice(0,5) },
    };
  }

  /** OHLCV candles — validated for OHLC integrity */
  async getKlines(pair, interval, limit = 200) {
    this._validatePair(pair);
    this._validateInterval(interval);
    if (limit < 1 || limit > MAX_LIMIT) throw new RangeError(`limit must be 1-${MAX_LIMIT}`);

    const data = await this._request('GET', '/api/v3/klines', {
      params: { symbol: pair, interval, limit },
    });

    if (!Array.isArray(data) || data.length === 0)
      throw new Error(`[${this.name}] No klines returned for ${pair}/${interval}`);

    return data.map((k, i) => {
      const [open, high, low, close, volume] = [+k[1],+k[2],+k[3],+k[4],+k[5]];
      // Integrity check
      if (high < low || high < open || high < close || low > open || low > close)
        throw new Error(`[${this.name}] Malformed candle at index ${i}: OHLC integrity failure`);
      return {
        time:        k[0],
        open, high, low, close, volume,
        quoteVolume: +k[7],
        tradeCount:  +k[8],
        closeTime:   k[6],
      };
    });
  }

  /** All book tickers in one call (fast for triangular arb) */
  async getAllTickers() {
    const data = await this._request('GET', '/api/v3/ticker/bookTicker');
    if (!Array.isArray(data)) throw new Error(`[${this.name}] getAllTickers: unexpected response`);
    const t = {};
    for (const x of data) {
      const bid = parseFloat(x.bidPrice), ask = parseFloat(x.askPrice);
      if (bid > 0 && ask > 0) t[x.symbol] = { bid, ask };
    }
    return t;
  }

  /** 24hr ticker stats (for volatility/volume checks) */
  async get24hStats(pair) {
    this._validatePair(pair);
    const data = await this._request('GET', '/api/v3/ticker/24hr', { params: { symbol: pair } });
    return {
      priceChange:    parseFloat(data.priceChange),
      priceChangePct: parseFloat(data.priceChangePercent),
      high:           parseFloat(data.highPrice),
      low:            parseFloat(data.lowPrice),
      volume:         parseFloat(data.volume),
      quoteVolume:    parseFloat(data.quoteVolume),
      count:          parseInt(data.count),
    };
  }

  /** Perpetual futures funding rate */
  async getFundingRate(perpPair) {
    this._validatePair(perpPair);
    const data = await this._request('GET', '/fapi/v1/fundingRate', {
      params: { symbol: perpPair, limit: 1 },
    });
    const entry = Array.isArray(data) ? data[0] : data;
    if (!entry) throw new Error(`[${this.name}] No funding rate data for ${perpPair}`);
    const rate = parseFloat(entry.fundingRate);
    if (!isFinite(rate)) throw new Error(`[${this.name}] Invalid funding rate: ${entry.fundingRate}`);
    return {
      rate:      rate * 100,                     // as percentage
      nextTime:  new Date(entry.fundingTime || Date.now() + 28_800_000),
      symbol:    perpPair,
    };
  }

  /** Funding rate history (for cash & carry average rate calculation) */
  async getFundingHistory(perpPair, limit = 8) {
    this._validatePair(perpPair);
    const data = await this._request('GET', '/fapi/v1/fundingRate', {
      params: { symbol: perpPair, limit: Math.min(limit, 1000) },
    });
    return (Array.isArray(data) ? data : [data]).map(d => ({
      rate: parseFloat(d.fundingRate) * 100,
      time: new Date(d.fundingTime),
    }));
  }

  /** Market BUY or SELL — validates notional before sending */
  async marketOrder(pair, side, qty = null, quoteQty = null) {
    this._validatePair(pair);
    const validSide = this._validateSide(side);

    if (qty !== null)      this._validateQty(qty, 'quantity');
    if (quoteQty !== null) this._validateQty(quoteQty, 'quoteQty');
    if (qty === null && quoteQty === null) throw new Error('marketOrder: qty or quoteQty required');

    // Notional check
    if (quoteQty !== null && quoteQty < MIN_NOTIONAL)
      throw new RangeError(`marketOrder: quoteQty $${quoteQty} below minimum notional $${MIN_NOTIONAL}`);

    if (this.dryRun) {
      const price  = await this.getPrice(pair);
      const execQty= quoteQty ? quoteQty / price : qty;
      return {
        orderId:             `dry-mkt-${validSide}-${Date.now()}`,
        executedQty:         execQty,
        executedPrice:       price,
        cummulativeQuoteQty: execQty * price,
        feeAmount:           execQty * price * (this.fee / 100),
        feeAsset:            'USDT',
        status:              'FILLED',
      };
    }

    const params = { symbol: pair, side: validSide, type: 'MARKET' };
    if (quoteQty !== null) params.quoteOrderQty = quoteQty.toFixed(2);
    else                   params.quantity       = qty.toFixed(6);

    const data = await this._request('POST', '/api/v3/order', this._auth(params));
    const execQty   = parseFloat(data.executedQty);
    const execQuote = parseFloat(data.cummulativeQuoteQty);
    if (execQty === 0) throw new Error(`[${this.name}] Market order ${validSide} ${pair} returned zero executed quantity`);

    return {
      orderId:             String(data.orderId),
      executedQty:         execQty,
      executedPrice:       execQuote / execQty,
      cummulativeQuoteQty: execQuote,
      feeAmount:           parseFloat(data.fills?.[0]?.commission || execQuote * this.fee / 100),
      feeAsset:            data.fills?.[0]?.commissionAsset || 'USDT',
      status:              data.status,
    };
  }

  /** GTC limit order */
  async limitOrder(pair, side, qty, price) {
    this._validatePair(pair);
    const validSide = this._validateSide(side);
    this._validateQty(qty, 'quantity');
    this._validatePrice(price, 'price');
    if (qty * price < MIN_NOTIONAL)
      throw new RangeError(`limitOrder: notional $${(qty*price).toFixed(2)} below minimum $${MIN_NOTIONAL}`);

    if (this.dryRun) {
      return {
        orderId: `dry-lmt-${validSide}-${price.toFixed(2)}-${Date.now()}`,
        status:  'NEW',
        price, qty,
      };
    }

    const data = await this._request('POST', '/api/v3/order', this._auth({
      symbol:      pair,
      side:        validSide,
      type:        'LIMIT',
      timeInForce: 'GTC',
      quantity:    qty.toFixed(6),
      price:       price.toFixed(2),
    }));

    return { orderId: String(data.orderId), status: data.status, price, qty };
  }

  /** Cancel a specific order */
  async cancelOrder(pair, orderId) {
    this._validatePair(pair);
    if (!orderId) throw new TypeError('cancelOrder: orderId required');
    if (this.dryRun) return { orderId: String(orderId), status: 'CANCELED' };

    const data = await this._request('DELETE', '/api/v3/order', this._auth({
      symbol:  pair,
      orderId: String(orderId),
    }));
    return { orderId: String(data.orderId), status: data.status };
  }

  /** Cancel all open orders for a pair */
  async cancelAllOrders(pair) {
    this._validatePair(pair);
    if (this.dryRun) {
      console.log(`[DRY][${this.name}] Cancel all orders for ${pair}`);
      return [];
    }
    const data = await this._request('DELETE', '/api/v3/openOrders', this._auth({ symbol: pair }));
    return Array.isArray(data) ? data : [];
  }

  /** Query order status */
  async getOrder(pair, orderId) {
    this._validatePair(pair);
    if (!orderId) throw new TypeError('getOrder: orderId required');

    if (this.dryRun) {
      // In dry-run, simulate a 15% fill chance on each poll
      return {
        orderId:     String(orderId),
        status:      Math.random() < 0.15 ? 'FILLED' : 'NEW',
        executedQty: '0',
      };
    }

    const data = await this._request('GET', '/api/v3/order', this._auth({
      symbol:  pair,
      orderId: String(orderId),
    }));
    return data;
  }

  /** Get all open orders for a pair */
  async getOpenOrders(pair) {
    this._validatePair(pair);
    const data = await this._request('GET', '/api/v3/openOrders', this._auth({ symbol: pair }));
    return Array.isArray(data) ? data : [];
  }

  /** Place a stop-loss market order */
  async setStopLoss(pair, side, qty, stopPrice) {
    this._validatePair(pair);
    const validSide = this._validateSide(side);
    this._validateQty(qty, 'quantity');
    this._validatePrice(stopPrice, 'stopPrice');

    if (this.dryRun) {
      return { orderId: `dry-sl-${validSide}-${stopPrice.toFixed(2)}-${Date.now()}` };
    }

    const data = await this._request('POST', '/api/v3/order', this._auth({
      symbol:        pair,
      side:          validSide,
      type:          'STOP_MARKET',
      stopPrice:     stopPrice.toFixed(2),
      quantity:      qty.toFixed(6),
      timeInForce:   'GTE_GTC',
      workingType:   'MARK_PRICE',
    }));
    return { orderId: String(data.orderId) };
  }

  /** Place OCO (One-Cancels-Other): take-profit + stop-loss together */
  async setOCO(pair, side, qty, takeProfitPrice, stopPrice, stopLimitPrice) {
    this._validatePair(pair);
    const validSide = this._validateSide(side);
    this._validateQty(qty, 'quantity');
    this._validatePrice(takeProfitPrice, 'takeProfitPrice');
    this._validatePrice(stopPrice, 'stopPrice');
    this._validatePrice(stopLimitPrice, 'stopLimitPrice');

    if (this.dryRun) {
      return { orderListId: `dry-oco-${Date.now()}`, status: 'EXEC_STARTED' };
    }

    const data = await this._request('POST', '/api/v3/order/oco', this._auth({
      symbol:            pair,
      side:              validSide,
      quantity:          qty.toFixed(6),
      price:             takeProfitPrice.toFixed(2),
      stopPrice:         stopPrice.toFixed(2),
      stopLimitPrice:    stopLimitPrice.toFixed(2),
      stopLimitTimeInForce: 'GTC',
    }));
    return { orderListId: String(data.orderListId), status: data.listStatusType };
  }

  /** Cancel OCO order list */
  async cancelOCO(pair, orderListId) {
    this._validatePair(pair);
    if (!orderListId) throw new TypeError('cancelOCO: orderListId required');
    if (this.dryRun) return { status: 'CANCELED' };
    return this._request('DELETE', '/api/v3/orderList', this._auth({ symbol: pair, orderListId: String(orderListId) }));
  }

  /** Account balances — only returns assets with non-zero balance */
  async getBalances() {
    const data     = await this._request('GET', '/api/v3/account', this._auth());
    const balances = {};
    for (const b of (data.balances || [])) {
      const free   = parseFloat(b.free);
      const locked = parseFloat(b.locked);
      if (free > 0 || locked > 0) balances[b.asset] = { free, locked };
    }
    return balances;
  }

  /** Single asset balance */
  async getBalance(asset) {
    if (!asset || typeof asset !== 'string') throw new TypeError('getBalance: asset must be a string');
    const balances = await this.getBalances();
    return balances[asset.toUpperCase()] ?? { free: 0, locked: 0 };
  }

  /** Exchange info: trading rules, min notional, lot size filters */
  async getSymbolInfo(pair) {
    this._validatePair(pair);
    const cacheKey = `syminfo:${this.name}:${pair}`;
    // Cache in memory for 1hr (exchange info rarely changes)
    if (!ExchangeClient._symInfoCache) ExchangeClient._symInfoCache = new Map();
    const cached = ExchangeClient._symInfoCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 3_600_000) return cached.data;

    const data   = await this._request('GET', '/api/v3/exchangeInfo', { params: { symbol: pair } });
    const symbol = data.symbols?.find(s => s.symbol === pair);
    if (!symbol) throw new Error(`[${this.name}] Symbol ${pair} not found in exchange info`);

    const lotSize     = symbol.filters?.find(f => f.filterType === 'LOT_SIZE');
    const minNotional = symbol.filters?.find(f => f.filterType === 'MIN_NOTIONAL');
    const priceFilter = symbol.filters?.find(f => f.filterType === 'PRICE_FILTER');

    const result = {
      symbol:        pair,
      status:        symbol.status,
      baseAsset:     symbol.baseAsset,
      quoteAsset:    symbol.quoteAsset,
      minQty:        parseFloat(lotSize?.minQty || '0.00001'),
      maxQty:        parseFloat(lotSize?.maxQty || '99999999'),
      stepSize:      parseFloat(lotSize?.stepSize || '0.00001'),
      minNotional:   parseFloat(minNotional?.minNotional || '5'),
      tickSize:      parseFloat(priceFilter?.tickSize || '0.01'),
      pricePrecision:symbol.quotePrecision,
      qtyPrecision:  symbol.baseAssetPrecision,
      trading:       symbol.status === 'TRADING',
    };

    ExchangeClient._symInfoCache.set(cacheKey, { data: result, ts: Date.now() });
    return result;
  }

  /** Round quantity to lot size step */
  roundQty(qty, stepSize) {
    if (stepSize <= 0) throw new RangeError('stepSize must be > 0');
    const precision = -Math.round(Math.log10(stepSize));
    return parseFloat(qty.toFixed(Math.max(0, precision)));
  }

  /** Round price to tick size */
  roundPrice(price, tickSize) {
    if (tickSize <= 0) throw new RangeError('tickSize must be > 0');
    const precision = -Math.round(Math.log10(tickSize));
    return parseFloat(price.toFixed(Math.max(0, precision)));
  }

  /** Health check */
  get circuitBreakerOpen() { return this._circuitOpen; }
  get consecutiveFailures() { return this._failures; }
}

module.exports = ExchangeClient;
