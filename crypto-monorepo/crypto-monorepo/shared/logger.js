'use strict';

/**
 * shared/logger.js — Minimal structured logger
 * Provides { getLogger } compatible with the crypto module suite.
 */

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info;

function getLogger(namespace) {
  const prefix = `[${namespace}]`;

  function log(level, message, meta) {
    if (LOG_LEVELS[level] < CURRENT_LEVEL) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      ns: namespace,
      message,
      ...(meta || {}),
    };
    const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    out.write(JSON.stringify(entry) + '\n');
  }

  return {
    debug: (msg, meta) => log('debug', msg, meta),
    info:  (msg, meta) => log('info',  msg, meta),
    warn:  (msg, meta) => log('warn',  msg, meta),
    error: (msg, meta) => log('error', msg, meta),
  };
}

module.exports = { getLogger };
