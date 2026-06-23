'use strict';
/**
 * config/default.js
 * All bot default configs. Values are overridden by .env at runtime.
 * Override per-bot at launch: BOT=grid GRID_LOWER=80000 node src/index.js
 */

module.exports = {
  cross_arb: {
    symbol:                    'BTC/USDT',
    minProfitPercent:          0.3,
    tradeAmountUSDT:           parseFloat(process.env.DEFAULT_TRADE_AMOUNT_USDT || '100'),
    pollIntervalMs:            1000,
    maxSlippagePercent:        0.1,
    oracleValidation:          true,
    maxOracleDeviationPercent: 1.0,
    chainlinkBTCFeed:          '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88b',
    exchangeA: {
      name:            process.env.EXCHANGE_A_NAME      || 'ExchangeA',
      baseUrl:         process.env.EXCHANGE_A_BASE_URL,
      apiKey:          process.env.EXCHANGE_A_API_KEY,
      apiSecret:       process.env.EXCHANGE_A_API_SECRET,
      takerFeePercent: parseFloat(process.env.EXCHANGE_A_TAKER_FEE || '0.1'),
      makerFeePercent: parseFloat(process.env.EXCHANGE_A_MAKER_FEE || '0.05'),
    },
    exchangeB: {
      name:            process.env.EXCHANGE_B_NAME      || 'ExchangeB',
      baseUrl:         process.env.EXCHANGE_B_BASE_URL,
      apiKey:          process.env.EXCHANGE_B_API_KEY,
      apiSecret:       process.env.EXCHANGE_B_API_SECRET,
      takerFeePercent: parseFloat(process.env.EXCHANGE_B_TAKER_FEE || '0.1'),
      makerFeePercent: parseFloat(process.env.EXCHANGE_B_MAKER_FEE || '0.05'),
    },
  },

  tri_arb: {
    exchange: {
      name:            process.env.EXCHANGE_A_NAME || 'Exchange',
      baseUrl:         process.env.EXCHANGE_A_BASE_URL,
      apiKey:          process.env.EXCHANGE_A_API_KEY,
      apiSecret:       process.env.EXCHANGE_A_API_SECRET,
      takerFeePercent: parseFloat(process.env.EXCHANGE_A_TAKER_FEE || '0.1'),
    },
    cycles: [
      {
        name: 'USDT→BTC→ETH→USDT',
        legs: [
          { pair: 'BTCUSDT', action: 'buy',  base: 'BTC', quote: 'USDT' },
          { pair: 'ETHBTC',  action: 'buy',  base: 'ETH', quote: 'BTC'  },
          { pair: 'ETHUSDT', action: 'sell', base: 'ETH', quote: 'USDT' },
        ],
      },
      {
        name: 'USDT→ETH→BTC→USDT',
        legs: [
          { pair: 'ETHUSDT', action: 'buy',  base: 'ETH', quote: 'USDT' },
          { pair: 'ETHBTC',  action: 'sell', base: 'ETH', quote: 'BTC'  },
          { pair: 'BTCUSDT', action: 'sell', base: 'BTC', quote: 'USDT' },
        ],
      },
    ],
    startAmountUSDT:  500,
    minProfitPercent: 0.2,
    pollIntervalMs:   500,
  },

  cash_carry: {
    exchange: {
      name:            process.env.EXCHANGE_A_NAME || 'Exchange',
      baseUrl:         process.env.EXCHANGE_A_BASE_URL,
      apiKey:          process.env.EXCHANGE_A_API_KEY,
      apiSecret:       process.env.EXCHANGE_A_API_SECRET,
      takerFeePercent: parseFloat(process.env.EXCHANGE_A_TAKER_FEE || '0.1'),
      perpTakerFee:    0.05,
    },
    spotPair:                'BTCUSDT',
    perpPair:                'BTCUSDT-PERP',
    tradeAmountUSDT:         1000,
    minFundingRatePercent:   0.03,
    exitFundingRatePercent:  0.005,
    maxHoldHours:            72,
    checkIntervalMs:         30000,
    pythFeedId:              '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  },

  dca: {
    exchange: {
      name:            process.env.EXCHANGE_A_NAME || 'Exchange',
      baseUrl:         process.env.EXCHANGE_A_BASE_URL,
      apiKey:          process.env.EXCHANGE_A_API_KEY,
      apiSecret:       process.env.EXCHANGE_A_API_SECRET,
      takerFeePercent: parseFloat(process.env.EXCHANGE_A_TAKER_FEE || '0.1'),
    },
    assets: [
      { pair: 'BTCUSDT', asset: 'BTC', amountUSDT: 50 },
      { pair: 'ETHUSDT', asset: 'ETH', amountUSDT: 30 },
      { pair: 'SOLUSDT', asset: 'SOL', amountUSDT: 20 },
    ],
    schedule: '0 9 * * 1',   // every Monday 9am
    enhancedDCA: {
      enabled:   true,
      smaPeriod: 50,
      dips: [
        { dropPercent:  5, multiplier: 1.5 },
        { dropPercent: 10, multiplier: 2.0 },
        { dropPercent: 20, multiplier: 3.0 },
      ],
    },
  },

  grid: {
    exchange: {
      name:            process.env.EXCHANGE_A_NAME || 'Exchange',
      baseUrl:         process.env.EXCHANGE_A_BASE_URL,
      apiKey:          process.env.EXCHANGE_A_API_KEY,
      apiSecret:       process.env.EXCHANGE_A_API_SECRET,
      takerFeePercent: parseFloat(process.env.EXCHANGE_A_TAKER_FEE || '0.1'),
      makerFeePercent: parseFloat(process.env.EXCHANGE_A_MAKER_FEE || '0.05'),
    },
    pair:               'BTCUSDT',
    gridLower:          parseFloat(process.env.GRID_LOWER  || '80000'),
    gridUpper:          parseFloat(process.env.GRID_UPPER  || '100000'),
    gridLevels:         parseInt(process.env.GRID_LEVELS   || '10'),
    totalCapitalUSDT:   parseFloat(process.env.GRID_CAPITAL|| '1000'),
    stopLossPercent:    15,
    takeProfitPercent:  20,
    pollIntervalMs:     2000,
  },

  trend: {
    exchange: {
      name:            process.env.EXCHANGE_A_NAME || 'Exchange',
      baseUrl:         process.env.EXCHANGE_A_BASE_URL,
      apiKey:          process.env.EXCHANGE_A_API_KEY,
      apiSecret:       process.env.EXCHANGE_A_API_SECRET,
      takerFeePercent: parseFloat(process.env.EXCHANGE_A_TAKER_FEE || '0.1'),
    },
    pair:              'BTCUSDT',
    interval:          '4h',
    tradeAmountUSDT:   500,
    fastMAPeriod:      50,
    slowMAPeriod:      200,
    maType:            'EMA',
    rsiPeriod:         14,
    rsiOverbought:     70,
    rsiOversold:       30,
    atrPeriod:         14,
    atrStopMultiplier: 2.0,
    riskRewardRatio:   2.0,
    allowShort:        false,
    pollIntervalMs:    60000,
  },

  scalp: {
    exchange: {
      name:            process.env.EXCHANGE_A_NAME || 'Exchange',
      baseUrl:         process.env.EXCHANGE_A_BASE_URL,
      apiKey:          process.env.EXCHANGE_A_API_KEY,
      apiSecret:       process.env.EXCHANGE_A_API_SECRET,
      takerFeePercent: parseFloat(process.env.EXCHANGE_A_TAKER_FEE || '0.05'),
    },
    pair:                      'BTCUSDT',
    interval:                  '1m',
    tradeAmountUSDT:           200,
    rsiPeriod:                 7,
    rsiBullish:                55,
    rsiBearish:                45,
    momentumPeriod:            10,
    momentumThresholdPercent:  0.15,
    atrPeriod:                 7,
    atrStopMultiplier:         1.5,
    riskRewardRatio:           1.5,
    maxTradesPerHour:          10,
    tradeCooldownMs:           30000,
    maxHoldTimeMs:             300000,
    minBidAskImbalance:        0.6,
    minVolumeMultiplier:       1.2,
    allowShort:                true,
    pollIntervalMs:            5000,
  },
};
