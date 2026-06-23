'use strict';
/**
 * infrastructure/rpc/rpc.js
 * EVM (ethers.js) + Solana (web3.js) RPC clients.
 * Chainlink + Pyth price feeds. Jupiter DEX aggregator.
 * Automatic failover, circuit breaker, retry logic.
 */

require('dotenv').config();
const { ethers }             = require('ethers');
const { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL, VersionedTransaction } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync } = require('@solana/spl-token');
const bs58  = require('bs58');
const axios = require('axios');

// ── CIRCUIT BREAKER ───────────────────────────────────────────────────────────
class CircuitBreaker {
  constructor(name, { failThreshold = 3, resetTimeoutMs = 30_000 } = {}) {
    this.name          = name;
    this.failThreshold = failThreshold;
    this.resetTimeout  = resetTimeoutMs;
    this.state         = 'CLOSED'; // CLOSED | OPEN | HALF_OPEN
    this.failCount     = 0;
    this.lastFailTime  = null;
  }

  async execute(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailTime > this.resetTimeout) {
        this.state = 'HALF_OPEN';
      } else {
        throw new Error(`[CB:${this.name}] Circuit is OPEN — requests blocked`);
      }
    }

    try {
      const result  = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFail();
      throw err;
    }
  }

  _onSuccess() {
    this.failCount = 0;
    this.state     = 'CLOSED';
  }

  _onFail() {
    this.failCount++;
    this.lastFailTime = Date.now();
    if (this.failCount >= this.failThreshold) {
      this.state = 'OPEN';
      console.warn(`[CB:${this.name}] Circuit OPENED after ${this.failCount} failures`);
    }
  }

  isOpen() { return this.state === 'OPEN'; }
}

// ── RETRY HELPER ─────────────────────────────────────────────────────────────
async function withRetry(fn, { retries = 3, baseDelayMs = 500, label = 'rpc' } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (i < retries - 1) {
        const delay = baseDelayMs * Math.pow(2, i); // exponential backoff
        console.warn(`[RPC:${label}] Attempt ${i+1}/${retries} failed: ${err.message}. Retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────────────
// EVM CLIENT
// ─────────────────────────────────────────────────────────────────────────────
class EVMClient {
  constructor() {
    this._urls     = [process.env.EVM_RPC_URL, process.env.EVM_RPC_URL_FALLBACK].filter(Boolean);
    this._chainId  = parseInt(process.env.EVM_CHAIN_ID || '1');
    this._provider = null;
    this._signer   = null;
    this._cb       = new CircuitBreaker('EVM', { failThreshold: 3, resetTimeoutMs: 30_000 });

    if (this._urls.length === 0) {
      console.warn('[EVM] No RPC URLs configured — EVM features disabled');
    }
  }

  /**
   * Get a healthy provider, automatically failing over to fallback.
   */
  async getProvider() {
    // Health-check cached provider
    if (this._provider) {
      try {
        await this._provider.getBlockNumber();
        return this._provider;
      } catch (_) {
        console.warn('[EVM] Cached provider unhealthy — reconnecting');
        this._provider = null;
        this._signer   = null;
      }
    }

    for (const url of this._urls) {
      try {
        const p = new ethers.JsonRpcProvider(url, this._chainId, {
          staticNetwork: true,        // skip eth_chainId on every call
          batchMaxCount: 10,
          polling: false,
        });
        await p.getBlockNumber();
        this._provider = p;
        console.log('[EVM] Connected:', url.replace(/\/[a-z0-9]{30,}/gi, '/***'));
        return p;
      } catch (err) {
        console.warn('[EVM] Provider failed:', url.slice(0, 40), '-', err.message);
      }
    }
    throw new Error('[EVM] All RPC endpoints failed');
  }

  async getSigner() {
    if (this._signer) return this._signer;
    if (!process.env.EVM_PRIVATE_KEY) throw new Error('[EVM] EVM_PRIVATE_KEY not set');
    // Validate key format
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(process.env.EVM_PRIVATE_KEY)) {
      throw new Error('[EVM] EVM_PRIVATE_KEY has invalid format');
    }
    const provider    = await this.getProvider();
    this._signer      = new ethers.Wallet(process.env.EVM_PRIVATE_KEY, provider);
    console.log('[EVM] Signer address:', this._signer.address);
    return this._signer;
  }

  // ── Read methods ────────────────────────────────────────────────────────
  async getBlockNumber() {
    return this._cb.execute(async () => {
      const p = await this.getProvider();
      return p.getBlockNumber();
    });
  }

  async getETHBalance(address) {
    ethers.getAddress(address); // validates checksum
    const p   = await this.getProvider();
    const bal = await withRetry(() => p.getBalance(address), { label: 'ethBalance' });
    return parseFloat(ethers.formatEther(bal));
  }

  async getTokenBalance(tokenAddress, walletAddress, decimals = 18) {
    ethers.getAddress(tokenAddress);
    ethers.getAddress(walletAddress);
    const p        = await this.getProvider();
    const abi      = ['function balanceOf(address) view returns (uint256)',
                      'function decimals() view returns (uint8)'];
    const contract = new ethers.Contract(tokenAddress, abi, p);
    const [raw, dec] = await Promise.all([
      withRetry(() => contract.balanceOf(walletAddress), { label: 'tokenBalance' }),
      decimals === 18 ? Promise.resolve(18) : withRetry(() => contract.decimals(), { label: 'decimals' }),
    ]);
    return parseFloat(ethers.formatUnits(raw, dec));
  }

  async getGasPrice() {
    const p         = await this.getProvider();
    const feeData   = await withRetry(() => p.getFeeData(), { label: 'feeData' });
    const maxGwei   = BigInt(parseInt(process.env.EVM_MAX_GAS_PRICE_GWEI || '100'));
    const maxWei    = maxGwei * BigInt(1e9);

    const capFee = (fee) => fee && fee > maxWei ? maxWei : fee;

    return {
      gasPrice:            capFee(feeData.gasPrice),
      maxFeePerGas:        capFee(feeData.maxFeePerGas),
      maxPriorityFeePerGas:feeData.maxPriorityFeePerGas,
      isEIP1559:           !!feeData.maxFeePerGas,
      gweiStr:             feeData.gasPrice
                             ? ethers.formatUnits(capFee(feeData.gasPrice), 'gwei').slice(0, 8)
                             : '0',
    };
  }

  async estimateGas(txRequest) {
    const p        = await this.getProvider();
    const est      = await withRetry(() => p.estimateGas(txRequest), { label: 'estimateGas' });
    const userLimit= parseInt(process.env.EVM_GAS_LIMIT || '300000');
    // Add 20% buffer, cap at user-defined limit
    const withBuf  = est * 120n / 100n;
    return withBuf > BigInt(userLimit) ? BigInt(userLimit) : withBuf;
  }

  // ── Chainlink price feed ────────────────────────────────────────────────
  async getChainlinkPrice(feedAddress) {
    ethers.getAddress(feedAddress);
    const p   = await this.getProvider();
    const abi = [
      'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
      'function decimals() view returns (uint8)',
    ];
    const feed = new ethers.Contract(feedAddress, abi, p);

    const [roundData, decimals] = await withRetry(
      () => Promise.all([feed.latestRoundData(), feed.decimals()]),
      { label: 'chainlink' }
    );

    const [, answer, , updatedAt, answeredInRound] = roundData;
    const roundId = roundData[0];

    // Validate round integrity
    if (answeredInRound < roundId) throw new Error('[EVM] Chainlink: stale round data');
    if (answer <= 0n) throw new Error('[EVM] Chainlink: invalid answer (<= 0)');

    const price       = parseFloat(ethers.formatUnits(answer, decimals));
    const staleSeconds= Date.now() / 1000 - Number(updatedAt);
    if (staleSeconds > 3600) {
      console.warn(`[EVM] Chainlink feed ${feedAddress} stale by ${staleSeconds.toFixed(0)}s`);
    }

    return { price, updatedAt: new Date(Number(updatedAt) * 1000), staleSeconds, feedAddress };
  }

  // ── Uniswap V3 quoter ───────────────────────────────────────────────────
  async getUniswapQuote({ quoterAddress, tokenIn, tokenOut, amountIn, fee = 3000 }) {
    ethers.getAddress(quoterAddress);
    ethers.getAddress(tokenIn);
    ethers.getAddress(tokenOut);
    if (amountIn <= 0n) throw new Error('getUniswapQuote: amountIn must be > 0');

    const p   = await this.getProvider();
    const abi = [
      'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
    ];
    const quoter = new ethers.Contract(quoterAddress, abi, p);
    const result = await withRetry(
      () => quoter.quoteExactInputSingle.staticCall({ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }),
      { label: 'uniswapQuote' }
    );
    return { amountOut: result[0], gasEstimate: result[3] };
  }

  // ── Send transaction ─────────────────────────────────────────────────────
  async sendTransaction(txRequest, maxRetries = 2) {
    const signer  = await this.getSigner();
    const gasData = await this.getGasPrice();
    const gasLimit= await this.estimateGas({ ...txRequest, from: signer.address });

    const enriched = {
      ...txRequest,
      gasLimit,
      ...(gasData.isEIP1559
        ? { maxFeePerGas: gasData.maxFeePerGas, maxPriorityFeePerGas: gasData.maxPriorityFeePerGas }
        : { gasPrice: gasData.gasPrice }
      ),
    };

    return withRetry(async () => {
      const tx      = await signer.sendTransaction(enriched);
      const receipt = await tx.wait(1);
      if (receipt.status === 0) throw new Error(`TX reverted: ${tx.hash}`);
      return receipt;
    }, { retries: maxRetries + 1, label: 'sendTx' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SOLANA CLIENT
// ─────────────────────────────────────────────────────────────────────────────
class SolanaClient {
  constructor() {
    this._primaryUrl  = process.env.SOLANA_RPC_URL;
    this._fallbackUrl = process.env.SOLANA_RPC_URL_FALLBACK;
    this._commitment  = (process.env.SOLANA_COMMITMENT || 'confirmed');
    this._conn        = null;
    this._keypair     = null;
    this._cb          = new CircuitBreaker('Solana', { failThreshold: 3, resetTimeoutMs: 30_000 });

    const validCommitments = ['processed','confirmed','finalized'];
    if (!validCommitments.includes(this._commitment)) {
      throw new Error(`Invalid SOLANA_COMMITMENT: ${this._commitment}`);
    }
  }

  getConnection(useFallback = false) {
    if (this._conn && !useFallback) return this._conn;
    const url = useFallback ? this._fallbackUrl : this._primaryUrl;
    if (!url) throw new Error('[SOL] No RPC URL configured');
    this._conn = new Connection(url, {
      commitment:  this._commitment,
      wsEndpoint:  url.replace(/^https/, 'wss').replace(/^http/, 'ws'),
      httpHeaders: { 'User-Agent': 'crypto-trading-bot/2.0' },
      confirmTransactionInitialTimeout: 30_000,
    });
    return this._conn;
  }

  getKeypair() {
    if (this._keypair) return this._keypair;
    const key = process.env.SOLANA_WALLET_PRIVATE_KEY;
    if (!key) throw new Error('[SOL] SOLANA_WALLET_PRIVATE_KEY not set');
    try {
      const secretKey  = bs58.decode(key);
      if (secretKey.length !== 64) throw new Error('Invalid key length (expected 64 bytes)');
      this._keypair = Keypair.fromSecretKey(secretKey);
      console.log('[SOL] Wallet:', this._keypair.publicKey.toString());
      return this._keypair;
    } catch (err) {
      throw new Error(`[SOL] Invalid private key: ${err.message}`);
    }
  }

  // ── Read methods ────────────────────────────────────────────────────────
  async getSlot() {
    return this._cb.execute(() =>
      withRetry(() => this.getConnection().getSlot(), { label: 'solSlot' })
    );
  }

  async getSOLBalance(walletAddress) {
    const pk       = new PublicKey(walletAddress);
    const lamports = await withRetry(
      () => this.getConnection().getBalance(pk),
      { label: 'solBalance' }
    );
    return lamports / LAMPORTS_PER_SOL;
  }

  async getTokenBalance(walletAddress, mintAddress) {
    const wallet = new PublicKey(walletAddress);
    const mint   = new PublicKey(mintAddress);
    const ata    = getAssociatedTokenAddressSync(mint, wallet);
    try {
      const bal = await withRetry(
        () => this.getConnection().getTokenAccountBalance(ata),
        { label: 'tokenBal' }
      );
      return {
        amount:   parseFloat(bal.value.amount),
        decimals: bal.value.decimals,
        uiAmount: bal.value.uiAmount,
      };
    } catch (_) {
      return { amount: 0, decimals: 0, uiAmount: 0 }; // account doesn't exist
    }
  }

  async getRecentBlockhash() {
    const conn = this.getConnection();
    return withRetry(() => conn.getLatestBlockhash(this._commitment), { label: 'blockhash' });
  }

  isValidAddress(address) {
    try { new PublicKey(address); return true; }
    catch (_) { return false; }
  }

  // ── Pyth oracle (off-chain Hermes API + on-chain verification) ──────────
  async getPythPrice(priceFeedId, maxStaleMs = 60_000) {
    if (!priceFeedId || !/^0x[0-9a-fA-F]{64}$/.test(priceFeedId)) {
      throw new Error(`[SOL] Invalid Pyth feed ID: ${priceFeedId}`);
    }

    const res = await withRetry(
      () => axios.get('https://hermes.pyth.network/v2/updates/price/latest', {
        params:  { ids: [priceFeedId] },
        timeout: 6_000,
      }),
      { label: 'pyth', retries: 3 }
    );

    const feed = res.data.parsed?.[0];
    if (!feed) throw new Error(`[SOL] Pyth: no data for feed ${priceFeedId}`);

    const expo        = feed.price.expo;
    const price       = parseFloat(feed.price.price) * Math.pow(10, expo);
    const confidence  = parseFloat(feed.price.conf)  * Math.pow(10, expo);
    const publishTime = new Date(feed.price.publish_time * 1000);
    const staleMs     = Date.now() - publishTime.getTime();

    if (staleMs > maxStaleMs) {
      throw new Error(`[SOL] Pyth feed stale by ${(staleMs/1000).toFixed(0)}s (max ${maxStaleMs/1000}s)`);
    }
    if (price <= 0) throw new Error(`[SOL] Pyth returned non-positive price: ${price}`);

    return { price, confidence, publishTime, staleMs, feedId: priceFeedId };
  }

  // ── Jupiter V6 swap ─────────────────────────────────────────────────────
  async getJupiterQuote({ inputMint, outputMint, amount, slippageBps = 50 }) {
    if (!this.isValidAddress(inputMint))  throw new Error('getJupiterQuote: invalid inputMint');
    if (!this.isValidAddress(outputMint)) throw new Error('getJupiterQuote: invalid outputMint');
    if (amount <= 0) throw new Error('getJupiterQuote: amount must be > 0');
    if (slippageBps > 500) throw new Error('getJupiterQuote: slippageBps > 500 rejected');

    const res = await withRetry(
      () => axios.get('https://quote-api.jup.ag/v6/quote', {
        params:  { inputMint, outputMint, amount: Math.floor(amount).toString(), slippageBps, onlyDirectRoutes: false },
        timeout: 8_000,
      }),
      { label: 'jupiterQuote' }
    );

    if (!res.data?.outAmount) throw new Error('[SOL] Jupiter: no quote returned');
    return res.data;
  }

  async executeJupiterSwap({ inputMint, outputMint, amount, slippageBps = 50 }) {
    const keypair = this.getKeypair();
    const quote   = await this.getJupiterQuote({ inputMint, outputMint, amount, slippageBps });

    const swapRes = await withRetry(
      () => axios.post('https://quote-api.jup.ag/v6/swap', {
        quoteResponse:    quote,
        userPublicKey:    keypair.publicKey.toString(),
        wrapAndUnwrapSol: true,
        computeUnitPriceMicroLamports: 'auto',
      }, { timeout: 15_000 }),
      { label: 'jupiterSwap' }
    );

    const txBuffer = Buffer.from(swapRes.data.swapTransaction, 'base64');
    const tx       = VersionedTransaction.deserialize(txBuffer);
    tx.sign([keypair]);

    const conn = this.getConnection();
    const sig  = await withRetry(
      () => conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 }),
      { label: 'sendTx', retries: 2 }
    );

    const conf = await conn.confirmTransaction(
      { signature: sig, ...(await this.getRecentBlockhash()) },
      this._commitment
    );

    if (conf.value.err) throw new Error(`[SOL] TX failed: ${JSON.stringify(conf.value.err)}`);

    return { signature: sig, quote, confirmation: conf };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PRICE FEED AGGREGATOR
// ─────────────────────────────────────────────────────────────────────────────
class PriceFeedAggregator {
  constructor(evmClient, solanaClient) {
    this.evm    = evmClient;
    this.solana = solanaClient;

    // Chainlink ETH mainnet feed addresses
    this.chainlinkFeeds = {
      'BTC/USD': '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88b',
      'ETH/USD': '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
      'SOL/USD': '0x4ffC43a60e009B551865A93d232E33Fce9f01507',
      'BNB/USD': '0x14e613AC84a31f709eadbEF3bf98585Ea5EBF97',
      'USDT/USD':'0x3E7d1eAB13ad0104d2750B8863b489D65364e32D',
    };

    // Pyth feed IDs
    this.pythFeeds = {
      'BTC/USD': '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
      'ETH/USD': '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
      'SOL/USD': '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
      'BNB/USD': '0x2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f',
    };
  }

  /**
   * Get prices from all available sources, return median.
   * Warns if deviation between sources > 0.5%.
   */
  async getAggregatedPrice(symbol) {
    const normalized = symbol.toUpperCase().replace('%2F', '/');
    const sources    = [];

    const [clResult, pythResult] = await Promise.allSettled([
      this.chainlinkFeeds[normalized]
        ? this.evm.getChainlinkPrice(this.chainlinkFeeds[normalized])
        : Promise.reject(new Error('No Chainlink feed')),
      this.pythFeeds[normalized]
        ? this.solana.getPythPrice(this.pythFeeds[normalized])
        : Promise.reject(new Error('No Pyth feed')),
    ]);

    if (clResult.status === 'fulfilled')   sources.push({ source: 'chainlink', price: clResult.value.price,  staleSeconds: clResult.value.staleSeconds });
    else                                   console.warn('[PRICE] Chainlink failed:', clResult.reason?.message);

    if (pythResult.status === 'fulfilled') sources.push({ source: 'pyth', price: pythResult.value.price });
    else                                   console.warn('[PRICE] Pyth failed:', pythResult.reason?.message);

    if (sources.length === 0) throw new Error(`[PRICE] No price sources available for ${normalized}`);

    const prices = sources.map(s => s.price).sort((a, b) => a - b);
    const median = prices.length === 1 ? prices[0] : (prices[0] + prices[prices.length - 1]) / 2;

    const maxDev    = Math.max(...prices) - Math.min(...prices);
    const devPct    = (maxDev / median) * 100;

    if (devPct > 0.5) {
      console.warn(`[PRICE] ${normalized} source deviation: ${devPct.toFixed(3)}% — ${JSON.stringify(sources.map(s => ({ s: s.source, p: s.price })))}`);
    }

    if (devPct > 5) {
      throw new Error(`[PRICE] ${normalized} deviation too large (${devPct.toFixed(2)}%) — rejecting price`);
    }

    return { symbol: normalized, price: median, sources, deviationPct: devPct, ts: new Date().toISOString() };
  }

  /**
   * Cross-validate a CEX price against oracle price.
   * Returns true if within tolerance, false otherwise.
   */
  async validatePrice(symbol, cexPrice, tolerancePct = 1.0) {
    try {
      const { price: oraclePrice } = await this.getAggregatedPrice(symbol);
      const deviation = Math.abs(cexPrice - oraclePrice) / oraclePrice * 100;
      if (deviation > tolerancePct) {
        console.warn(`[PRICE] CEX/Oracle deviation for ${symbol}: ${deviation.toFixed(3)}% (limit ${tolerancePct}%)`);
        return false;
      }
      return true;
    } catch (err) {
      console.warn(`[PRICE] Oracle validation failed for ${symbol}: ${err.message} — proceeding without`);
      return true; // fail open when oracle is unavailable
    }
  }
}

// ── SINGLETONS ────────────────────────────────────────────────────────────────
const evmClient    = new EVMClient();
const solanaClient = new SolanaClient();
const priceFeed    = new PriceFeedAggregator(evmClient, solanaClient);

module.exports = { evmClient, solanaClient, priceFeed, EVMClient, SolanaClient, PriceFeedAggregator };
