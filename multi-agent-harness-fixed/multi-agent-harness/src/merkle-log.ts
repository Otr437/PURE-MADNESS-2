// src/merkle-log.ts
// Off-chain Merkle tree — private, local, tamper-proof action log.
//
// Every browser action gets hashed and appended as a leaf.
// The root hash changes with every new action, giving you a running
// fingerprint of your entire session. No data leaves your machine.
//
// Design:
//   leaf  = SHA-256( timestamp | tool | args | result )
//   tree  = standard binary Merkle tree, left-padded when odd
//   root  = Merkle root of all leaves so far
//
// Commands in the REPL:
//   log     — print all recorded actions
//   proof   — show root + leaf count
//   verify  — re-derive root from leaves and confirm integrity

import { createHash } from "crypto";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface ActionEntry {
  seq: number;                 // sequence number
  ts: string;                  // ISO timestamp
  tool: string;                // tool name e.g. "navigate"
  args: Record<string, unknown>;
  result: unknown;
  leaf: string;                // SHA-256 hex of this entry
}

export interface MerkleState {
  leaves: string[];            // hex hashes, one per action
  entries: ActionEntry[];      // full action records
  root: string;                // current Merkle root
}

// ─── HASH HELPERS ─────────────────────────────────────────────────────────────

function sha256(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function hashPair(left: string, right: string): string {
  return sha256(left + right);
}

// Standard binary Merkle tree — duplicate last node when count is odd
function computeRoot(leaves: string[]): string {
  if (leaves.length === 0) return sha256("empty");
  let level = [...leaves];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? left; // duplicate if odd
      next.push(hashPair(left, right));
    }
    level = next;
  }
  return level[0];
}

// ─── MERKLE LOG CLASS ─────────────────────────────────────────────────────────

export class MerkleLog {
  private state: MerkleState;
  private persistPath: string | null;
  private archiveDir: string | null;
  private readonly MAX_ENTRIES = 10_000;    // rotate at 10k entries
  private readonly MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

  constructor(persistPath: string | null = null) {
    this.persistPath = persistPath;
    this.archiveDir  = persistPath ? persistPath.replace(/\.json$/, "-archive") : null;

    if (persistPath && existsSync(persistPath)) {
      try {
        const raw = readFileSync(persistPath, "utf8");
        // Guard against malformed file
        if (raw.length > this.MAX_FILE_BYTES) {
          console.warn(`[merkle] Log file exceeds ${this.MAX_FILE_BYTES / 1024 / 1024}MB — archiving and starting fresh`);
          this.archiveCurrentLog();
          this.state = { leaves: [], entries: [], root: sha256("empty") };
        } else {
          this.state = JSON.parse(raw);
          console.log(`[merkle] Loaded ${this.state.entries.length} existing entries from ${persistPath}`);
          // Verify integrity on load
          const v = this.verifyInternal();
          if (!v.ok) {
            console.error(`[merkle] ⚠ Integrity check FAILED on load — stored root does not match derived root. Log may be tampered.`);
            console.error(`[merkle]   stored=${v.stored.slice(0, 16)}… derived=${v.derived.slice(0, 16)}…`);
          }
        }
      } catch (err) {
        console.error(`[merkle] Failed to parse log file: ${err}. Starting fresh.`);
        this.state = { leaves: [], entries: [], root: sha256("empty") };
      }
    } else {
      this.state = { leaves: [], entries: [], root: sha256("empty") };
    }
  }

  private archiveCurrentLog(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    if (!this.archiveDir) return;
    if (!existsSync(this.archiveDir)) {
      mkdirSync(this.archiveDir, { recursive: true });
    }
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const archivePath = join(this.archiveDir, `log-${ts}.json`);
    try {
      writeFileSync(archivePath, readFileSync(this.persistPath));
      console.log(`[merkle] Archived log to ${archivePath}`);
    } catch (err) {
      console.error(`[merkle] Archive failed: ${err}`);
    }
  }

  private maybePersist(): void {
    if (!this.persistPath) return;
    // Rotate before writing if we're at the limit
    if (this.state.entries.length >= this.MAX_ENTRIES) {
      console.log(`[merkle] Entry limit (${this.MAX_ENTRIES}) reached — archiving and rotating`);
      this.archiveCurrentLog();
      // Keep last 1000 entries so continuity isn't completely broken
      const keep = 1000;
      this.state.entries = this.state.entries.slice(-keep);
      this.state.leaves  = this.state.leaves.slice(-keep);
      this.state.root    = computeRoot(this.state.leaves);
    }
    writeFileSync(this.persistPath, JSON.stringify(this.state, null, 2), "utf8");
  }

  // Append a new action and return its leaf hash
  append(tool: string, args: Record<string, unknown>, result: unknown): string {
    const seq = this.state.entries.length;
    const ts = Temporal.Now.instant().toString();

    // Deterministic leaf: seq + ts + tool + args + result
    const leafInput = JSON.stringify({ seq, ts, tool, args, result });
    const leaf = sha256(leafInput);

    const entry: ActionEntry = { seq, ts, tool, args, result, leaf };

    this.state.leaves.push(leaf);
    this.state.entries.push(entry);
    this.state.root = computeRoot(this.state.leaves);

    this.maybePersist();

    return leaf;
  }

  private verifyInternal(): { ok: boolean; stored: string; derived: string; entries: number } {
    const derived = computeRoot(this.state.leaves);
    return {
      ok: derived === this.state.root,
      stored: this.state.root,
      derived,
      entries: this.state.entries.length,
    };
  }

  // Re-derive root from stored leaves and check it matches
  verify(): { ok: boolean; stored: string; derived: string; entries: number } {
    return this.verifyInternal();
  }

  // Generate an inclusion proof for a single leaf index
  proof(index: number): {
    leaf: string;
    root: string;
    path: Array<{ sibling: string; direction: "left" | "right" }>;
  } | null {
    if (index < 0 || index >= this.state.leaves.length) return null;

    const path: Array<{ sibling: string; direction: "left" | "right" }> = [];
    let level = [...this.state.leaves];
    let idx = index;

    while (level.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = level[i + 1] ?? left;
        next.push(hashPair(left, right));

        // If our index is in this pair, record sibling
        if (i === idx || i + 1 === idx) {
          if (idx % 2 === 0) {
            path.push({ sibling: right, direction: "right" });
          } else {
            path.push({ sibling: left, direction: "left" });
          }
        }
      }
      idx = Math.floor(idx / 2);
      level = next;
    }

    return { leaf: this.state.leaves[index], root: this.state.root, path };
  }

  get root(): string { return this.state.root; }
  get count(): number { return this.state.entries.length; }
  get entries(): ActionEntry[] { return this.state.entries; }

  // Pretty-print the action log
  printLog(last = 20) {
    const show = this.state.entries.slice(-last);
    console.log("\n─────────────────────────────────────────────────────────");
    console.log(`  ACTION LOG  (${this.state.entries.length} total, showing last ${show.length})`);
    console.log("─────────────────────────────────────────────────────────");
    for (const e of show) {
      const args = JSON.stringify(e.args);
      const argStr = args.length > 60 ? args.slice(0, 60) + "…" : args;
      const ok = (e.result as any)?.ok !== false ? "✓" : "✗";
      console.log(`  #${String(e.seq).padStart(3, "0")}  ${ok}  [${e.tool}]  ${argStr}`);
      console.log(`        ${e.ts}  leaf: ${e.leaf.slice(0, 16)}…`);
    }
    console.log("─────────────────────────────────────────────────────────");
    console.log(`  Root: ${this.state.root}`);
    console.log("─────────────────────────────────────────────────────────\n");
  }

  // Pretty-print current proof stats
  printProof() {
    console.log("\n─────────────────────────────────────────────────────────");
    console.log("  MERKLE PROOF");
    console.log("─────────────────────────────────────────────────────────");
    console.log(`  Entries : ${this.state.entries.length}`);
    console.log(`  Root    : ${this.state.root}`);
    if (this.state.entries.length > 0) {
      const last = this.state.entries[this.state.entries.length - 1];
      console.log(`  Last    : [${last.tool}] @ ${last.ts}`);
      console.log(`  Leaf    : ${last.leaf}`);
    }
    console.log("─────────────────────────────────────────────────────────\n");
  }
}
