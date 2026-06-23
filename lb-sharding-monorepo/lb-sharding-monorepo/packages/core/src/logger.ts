// ============================================================
// @lb-sharding/core — Structured Logger (JSON / pretty)
// ============================================================

import type { Logger, LogLevel } from "./types.js";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

const COLORS: Record<LogLevel, string> = {
  debug: "\x1b[36m",  // cyan
  info: "\x1b[32m",   // green
  warn: "\x1b[33m",   // yellow
  error: "\x1b[31m",  // red
  fatal: "\x1b[35m",  // magenta
};
const RESET = "\x1b[0m";

export interface LoggerOptions {
  level?: LogLevel;
  name?: string;
  pretty?: boolean;
  bindings?: Record<string, unknown>;
}

export class ConsoleLogger implements Logger {
  private readonly minLevel: number;
  private readonly name: string;
  private readonly pretty: boolean;
  private readonly bindings: Record<string, unknown>;

  constructor(options: LoggerOptions = {}) {
    this.minLevel = LEVELS[options.level ?? "info"];
    this.name = options.name ?? "app";
    this.pretty = options.pretty ?? process.env["NODE_ENV"] !== "production";
    this.bindings = options.bindings ?? {};
  }

  private write(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LEVELS[level] < this.minLevel) return;

    const entry = {
      time: new Date().toISOString(),
      level,
      name: this.name,
      msg,
      ...this.bindings,
      ...(meta ?? {}),
    };

    if (this.pretty) {
      const color = COLORS[level];
      const ts = entry.time;
      const extra = Object.entries(meta ?? {})
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(" ");
      process.stderr.write(
        `${color}${level.toUpperCase().padEnd(5)}${RESET} [${ts}] ${msg}${extra ? " " + extra : ""}\n`
      );
    } else {
      process.stderr.write(JSON.stringify(entry) + "\n");
    }
  }

  debug(msg: string, meta?: Record<string, unknown>): void { this.write("debug", msg, meta); }
  info(msg: string, meta?: Record<string, unknown>): void { this.write("info", msg, meta); }
  warn(msg: string, meta?: Record<string, unknown>): void { this.write("warn", msg, meta); }
  error(msg: string, meta?: Record<string, unknown>): void { this.write("error", msg, meta); }
  fatal(msg: string, meta?: Record<string, unknown>): void { this.write("fatal", msg, meta); }

  child(bindings: Record<string, unknown>): Logger {
    return new ConsoleLogger({
      level: Object.keys(LEVELS).find(
        (k) => LEVELS[k as LogLevel] === this.minLevel
      ) as LogLevel,
      name: this.name,
      pretty: this.pretty,
      bindings: { ...this.bindings, ...bindings },
    });
  }
}

// Singleton factory
let _defaultLogger: Logger | null = null;

export function getLogger(options?: LoggerOptions): Logger {
  if (!_defaultLogger || options) {
    _defaultLogger = new ConsoleLogger(options);
  }
  return _defaultLogger;
}
