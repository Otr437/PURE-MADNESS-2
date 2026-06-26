import type { ExecutionLogEntry } from "@rtos/shared-types";
import type { EncryptionService } from "@rtos/shared-crypto";

export class Logger {
  private log: ExecutionLogEntry[] = [];
  private readonly maxEntries = 10_000;

  constructor(private readonly encryption?: EncryptionService) {}

  record(
    actor: string,
    action: string,
    details: string | object,
    target?: string,
    severity: ExecutionLogEntry["severity"] = "info",
    shouldEncrypt = false
  ): void {
    const entry: ExecutionLogEntry = {
      timestamp: new Date().toISOString(),
      actor,
      action,
      target,
      details:
        shouldEncrypt && this.encryption
          ? this.encryption.encrypt(
              typeof details === "string" ? details : JSON.stringify(details)
            )
          : details,
      severity,
      encrypted: shouldEncrypt && !!this.encryption,
    };

    this.log.push(entry);

    if (this.log.length > this.maxEntries) {
      this.log = this.log.slice(-this.maxEntries);
    }

    const prefix = `[${entry.severity.toUpperCase()}] [${actor}]`;
    console.error(`${prefix} ${action}${target ? ` → ${target}` : ""}`);
  }

  getEntries(limit?: number): ExecutionLogEntry[] {
    return limit ? this.log.slice(-limit) : [...this.log];
  }

  clear(): void {
    this.log = [];
  }
}
