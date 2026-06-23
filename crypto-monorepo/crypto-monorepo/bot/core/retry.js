'use strict';

/**
 * bot/core/retry.js
 * Exponential backoff retry with jitter and structured error classification.
 *
 * Pure Node.js — no external deps.
 */

const CONFIG = require('../config/config');

// ── Sleep ─────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ── Error classification ──────────────────────────────────────────────────────

const ERROR_CLASSES = {
  RATE_LIMIT:    'rate_limit',    // HTTP 429 — back off and retry
  SERVER_ERROR:  'server_error',  // HTTP 5xx — retry
  BAD_JSON:      'bad_json',      // LLM returned unparseable output — retry with nudge
  TOOL_ERROR:    'tool_error',    // tool threw — may be retryable
  AUTH:          'auth',          // HTTP 401/403 — do NOT retry
  FATAL:         'fatal',         // anything else unrecoverable
};

/**
 * Classify an error into a retry strategy.
 * @param {Error} err
 * @returns {{ class: string, retryable: boolean }}
 */
function classify(err) {
  const msg = err.message || '';

  if (msg.includes('HTTP 429'))                        return { class: ERROR_CLASSES.RATE_LIMIT,   retryable: true  };
  if (msg.match(/HTTP 5\d\d/))                         return { class: ERROR_CLASSES.SERVER_ERROR, retryable: true  };
  if (msg.includes('HTTP 401') || msg.includes('HTTP 403')) return { class: ERROR_CLASSES.AUTH,   retryable: false };
  if (msg.includes('non-JSON') || msg.includes('JSON')) return { class: ERROR_CLASSES.BAD_JSON,   retryable: true  };
  if (msg.includes('Missing required parameter') ||
      msg.includes('not found') ||
      msg.includes('not established'))                  return { class: ERROR_CLASSES.TOOL_ERROR,  retryable: true  };

  return { class: ERROR_CLASSES.FATAL, retryable: false };
}

// ── Retry wrapper ─────────────────────────────────────────────────────────────

/**
 * Retry an async function with exponential backoff + full jitter.
 *
 * @param {Function} fn            Async function to retry: () => Promise<T>
 * @param {object}   [opts]
 * @param {number}   [opts.max]    Max attempts (default from config).
 * @param {number}   [opts.baseMs] Base delay in ms (default from config).
 * @param {Function} [opts.onRetry] Called before each retry: (attempt, err, delayMs) => void
 * @returns {Promise<T>}
 */
async function withRetry(fn, opts = {}) {
  const max    = opts.max    ?? CONFIG.retryMax;
  const baseMs = opts.baseMs ?? CONFIG.retryBaseMs;
  const onRetry = opts.onRetry || (() => {});

  let lastErr;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const { retryable } = classify(err);

      if (!retryable || attempt === max) throw err;

      // Full jitter: delay in [0, baseMs * 2^(attempt-1)]
      const cap     = baseMs * Math.pow(2, attempt - 1);
      const delayMs = Math.floor(Math.random() * cap);

      onRetry(attempt, err, delayMs);
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

/**
 * Retry specifically for LLM calls — adds a "please respond in JSON" nudge
 * message to the conversation on bad-JSON errors.
 *
 * @param {Function} llmFn   async (messages) => string
 * @param {object[]} messages
 * @param {object}   [opts]
 * @returns {Promise<string>}
 */
async function withLLMRetry(llmFn, messages, opts = {}) {
  const max    = opts.max    ?? CONFIG.retryMax;
  const baseMs = opts.baseMs ?? CONFIG.retryBaseMs;

  let msgs = [...messages];
  let lastErr;

  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await llmFn(msgs);
    } catch (err) {
      lastErr = err;
      const { class: errClass, retryable } = classify(err);

      if (!retryable || attempt === max) throw err;

      // On bad JSON, inject a correction nudge
      if (errClass === ERROR_CLASSES.BAD_JSON) {
        msgs = [
          ...msgs,
          {
            role:    'user',
            content: 'Your previous response was not valid JSON. You MUST respond with a single JSON object only — no markdown, no prose, no code fences. Try again.',
          },
        ];
      }

      const delayMs = Math.floor(Math.random() * baseMs * Math.pow(2, attempt - 1));
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

module.exports = { withRetry, withLLMRetry, classify, ERROR_CLASSES, sleep };
