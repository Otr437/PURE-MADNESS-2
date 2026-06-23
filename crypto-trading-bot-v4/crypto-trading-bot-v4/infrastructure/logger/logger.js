'use strict';
/**
 * infrastructure/logger/logger.js
 * Structured JSON logger with levels, DB persistence, Telegram alerts,
 * request-id tracing, and global process error handlers.
 */

require('dotenv').config();
const axios = require('axios');
const { db }  = require('../db/database');

// ── CONFIG ───────────────────────────────────────────────────────────────────
const LEVELS     = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, FATAL: 4 };
const LEVEL_KEYS = Object.keys(LEVELS);
const MIN_LEVEL  = LEVELS[(process.env.LOG_LEVEL || 'info').toUpperCase()] ?? LEVELS.INFO;
const NODE_ENV   = process.env.NODE_ENV || 'development';
const IS_PROD    = NODE_ENV === 'production';

// Telegram config
const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT    = process.env.TELEGRAM_CHAT_ID;
const TG_ENABLED = !!(TG_TOKEN && TG_CHAT);

// PnL alert threshold
const PNL_THRESHOLD = parseFloat(process.env.ALERT_ON_PNL_THRESHOLD_USDT || '50');

// Cooldown map to prevent Telegram spam: key → last sent timestamp
const _tgCooldowns = new Map();
const TG_COOLDOWN_MS = 60_000; // 1 min minimum between same-key alerts

// ── TELEGRAM ─────────────────────────────────────────────────────────────────
async function sendTelegram(message, key = null, parseMode = 'Markdown') {
  if (!TG_ENABLED) return;

  // Cooldown check
  if (key) {
    const last = _tgCooldowns.get(key) || 0;
    if (Date.now() - last < TG_COOLDOWN_MS) return;
    _tgCooldowns.set(key, Date.now());
  }

  // Truncate to Telegram's 4096 char limit
  const text = String(message).slice(0, 4000);

  try {
    await axios.post(
      `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,
      { chat_id: TG_CHAT, text, parse_mode: parseMode, disable_web_page_preview: true },
      { timeout: 8_000 }
    );
  } catch (err) {
    // Log to stderr only — never throw from alert path
    process.stderr.write(`[TELEGRAM] Failed: ${err.message}\n`);
  }
}

// ── LOGGER CLASS ─────────────────────────────────────────────────────────────
class Logger {
  /**
   * @param {string|null} botId   - UUID of the bot (null for system logger)
   * @param {string}      botName - Human-readable name for log output
   * @param {string|null} reqId   - Request ID for tracing (optional)
   */
  constructor(botId = null, botName = 'system', reqId = null) {
    this.botId   = botId;
    this.botName = botName;
    this.reqId   = reqId;
  }

  /** Return a child logger with a specific request ID attached */
  withReqId(reqId) {
    return new Logger(this.botId, this.botName, reqId);
  }

  // ── Core log emitter ─────────────────────────────────────────────────────
  _emit(level, message, context = {}) {
    if (LEVELS[level] === undefined) throw new Error(`Invalid log level: ${level}`);
    if (LEVELS[level] < MIN_LEVEL) return;

    const entry = {
      ts:      new Date().toISOString(),
      level,
      env:     NODE_ENV,
      bot:     this.botName,
      botId:   this.botId,
      ...(this.reqId && { reqId: this.reqId }),
      message: String(message).slice(0, 4000),
      ...(Object.keys(context).length && { ctx: context }),
    };

    const line = JSON.stringify(entry) + '\n';

    if (LEVELS[level] >= LEVELS.ERROR) {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }

    // Persist WARN and above to database (async, non-blocking)
    if (this.botId && LEVELS[level] >= LEVELS.WARN) {
      db.log(this.botId, level, entry.message, context).catch(() => {});
    }
  }

  debug(msg, ctx)  { this._emit('DEBUG', msg, ctx); }
  info(msg, ctx)   { this._emit('INFO',  msg, ctx); }
  warn(msg, ctx)   { this._emit('WARN',  msg, ctx); }
  error(msg, ctx)  { this._emit('ERROR', msg, ctx); }
  fatal(msg, ctx)  { this._emit('FATAL', msg, ctx); }

  // ── Structured trade alerts ───────────────────────────────────────────────
  async tradeOpen({ pair, side, price, qty, stopLoss, takeProfit }) {
    const emoji = side === 'LONG' || side === 'BUY' ? '🟢' : '🔴';
    this._emit('INFO', `Trade opened: ${side} ${pair}`, { pair, side, price, qty, stopLoss, takeProfit });

    if (process.env.ALERT_ON_TRADE !== 'true') return;
    const sl = stopLoss   ? `\nSL: \`$${Number(stopLoss).toFixed(2)}\`` : '';
    const tp = takeProfit ? `\nTP: \`$${Number(takeProfit).toFixed(2)}\`` : '';
    await sendTelegram(
      `${emoji} *${this.botName}* — OPEN ${side}\n` +
      `Pair: \`${pair}\` | Price: \`$${Number(price).toFixed(2)}\` | Qty: \`${Number(qty).toFixed(6)}\`${sl}${tp}`,
      `trade_open:${this.botId}:${pair}`
    );
  }

  async tradeClose({ pair, side, entryPrice, exitPrice, qty, netPnl, reason }) {
    const profit = parseFloat(netPnl || 0);
    const emoji  = profit >= 0 ? '💰' : '💸';
    this._emit('INFO', `Trade closed: ${side} ${pair}`, { pair, side, entryPrice, exitPrice, qty, netPnl, reason });

    if (process.env.ALERT_ON_TRADE !== 'true') return;
    await sendTelegram(
      `${emoji} *${this.botName}* — CLOSE ${side}\n` +
      `Pair: \`${pair}\` | Entry: \`$${Number(entryPrice).toFixed(2)}\` → Exit: \`$${Number(exitPrice).toFixed(2)}\`\n` +
      `PnL: \`$${profit.toFixed(4)}\` | Reason: ${reason}`,
      `trade_close:${this.botId}:${pair}`
    );

    // Threshold alert (regardless of ALERT_ON_TRADE flag)
    if (Math.abs(profit) >= PNL_THRESHOLD) {
      await this.pnlAlert({ pair, pnl: profit });
    }
  }

  async pnlAlert({ pair, pnl }) {
    const emoji = pnl >= 0 ? '🏆' : '⚠️';
    await sendTelegram(
      `${emoji} *PnL Alert — ${this.botName}*\n` +
      `\`${pair}\` | Net PnL: \`$${Number(pnl).toFixed(4)}\``,
      `pnl:${this.botId}:${pair}`
    );
  }

  async alertError(message, context = {}) {
    this._emit('ERROR', message, context);
    if (process.env.ALERT_ON_ERROR !== 'true') return;
    await sendTelegram(
      `🚨 *Error — ${this.botName}*\n\`${String(message).slice(0, 500)}\``,
      `error:${this.botId}`
    );
  }

  async alertFatal(message, context = {}) {
    this._emit('FATAL', message, context);
    await sendTelegram(
      `🔥 *FATAL — ${this.botName}*\n\`${String(message).slice(0, 500)}\``,
      null // no cooldown on fatal
    );
  }

  async alertDrawdown({ drawdownPct, currentCapital }) {
    this._emit('WARN', `Drawdown breached ${drawdownPct.toFixed(2)}%`, { drawdownPct, currentCapital });
    await sendTelegram(
      `📉 *Drawdown Alert — ${this.botName}*\n` +
      `Drawdown: \`${drawdownPct.toFixed(2)}%\` | Capital: \`$${Number(currentCapital).toFixed(2)}\``,
      `drawdown:${this.botId}`
    );
  }

  async alertDailyLossLimit({ lossUsdt, limitUsdt }) {
    this._emit('ERROR', 'Daily loss limit reached', { lossUsdt, limitUsdt });
    await sendTelegram(
      `🛑 *Daily Loss Limit — ${this.botName}*\n` +
      `Loss: \`$${Number(lossUsdt).toFixed(2)}\` ≥ Limit: \`$${Number(limitUsdt).toFixed(2)}\`\n` +
      `No new positions will be opened today.`,
      `dailyloss:${this.botId}`
    );
  }

  async alertHeartbeatMiss(lastSeen) {
    await sendTelegram(
      `💔 *Heartbeat Miss — ${this.botName}*\nLast seen: \`${lastSeen}\``,
      `heartbeat:${this.botId}`
    );
  }

  async alertStartup(config) {
    this._emit('INFO', 'Bot started', { dryRun: config.dryRun, pair: config.pair || config.symbol });
    await sendTelegram(
      `🤖 *Started — ${this.botName}*\n` +
      `DryRun: \`${config.dryRun}\` | ` +
      `Pair: \`${config.pair || config.symbol || 'multi'}\` | ` +
      `Env: \`${NODE_ENV}\``,
      `startup:${this.botId}`
    );
  }

  async alertShutdown(stats = {}) {
    this._emit('INFO', 'Bot stopped', stats);
    const wins     = stats.wins     || 0;
    const losses   = stats.losses   || 0;
    const total    = stats.trades   || (wins + losses);
    const winRate  = total > 0 ? ((wins / total) * 100).toFixed(1) : '0.0';
    const pnl      = (stats.totalPnlUSDT || 0).toFixed(4);
    await sendTelegram(
      `🛑 *Stopped — ${this.botName}*\n` +
      `Trades: \`${total}\` | W/L: \`${wins}/${losses}\` | WinRate: \`${winRate}%\` | PnL: \`$${pnl}\``,
      null
    );
  }

  async alertFundingAccrued({ symbol, rate, payment, total }) {
    this._emit('INFO', 'Funding accrued', { symbol, rate, payment, total });
    // Only alert for significant funding payments
    if (Math.abs(payment) >= PNL_THRESHOLD / 10) {
      await sendTelegram(
        `💸 *Funding — ${this.botName}*\n` +
        `\`${symbol}\` | Rate: \`${Number(rate).toFixed(4)}%\` | Payment: \`$${Number(payment).toFixed(4)}\` | Total: \`$${Number(total).toFixed(4)}\``,
        `funding:${this.botId}:${symbol}`
      );
    }
  }
}

// ── GLOBAL PROCESS HANDLERS ───────────────────────────────────────────────────
const _sysLogger = new Logger(null, 'process');

process.on('uncaughtException', async (err) => {
  _sysLogger.fatal('Uncaught Exception', { error: err.message, stack: err.stack });
  await sendTelegram(`🔥 *FATAL uncaughtException*\n\`${err.message}\``);
  // Give async ops 1s to flush then exit
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', async (reason, promise) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  _sysLogger.error('Unhandled Promise Rejection', { reason: message });
  if (process.env.ALERT_ON_ERROR === 'true') {
    await sendTelegram(`⚠️ *Unhandled Rejection*\n\`${message.slice(0, 500)}\``);
  }
});

process.on('warning', (warning) => {
  _sysLogger.warn('Node.js Warning', { name: warning.name, message: warning.message });
});

// ── FACTORY ───────────────────────────────────────────────────────────────────
function createLogger(botId, botName) {
  return new Logger(botId, botName);
}

module.exports = { Logger, createLogger, sendTelegram };
