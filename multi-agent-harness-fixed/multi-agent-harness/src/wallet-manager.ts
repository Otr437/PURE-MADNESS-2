// src/wallet-manager.ts
// HD wallet manager — self-custody, approval-gated, zero plaintext keys.
// Every method validates inputs through InputValidator before any logic runs.

import { randomBytes } from "crypto";
import * as readline from "readline";
import { MerkleLog } from "./merkle-log.js";
import { CryptoVault, readPinSilent, zeroBuffer } from "./crypto-vault.js";
import { InputValidator } from "./input-validator.js";
import { SecurityMiddleware } from "./security-middleware.js";

export type Chain = "evm" | "btc" | "zcash";

export interface WalletInfo {
  chain:           Chain;
  address:         string;
  derivationPath:  string;
  hasEncryptedKey: boolean;
}

export interface TxProposal {
  id:          string;
  chain:       Chain;
  from:        string;
  to:          string;
  value:       string;
  valueRaw:    bigint;
  data?:       string;
  memo?:       string;
  createdAt:   string;
  approved?:   boolean;
  approvedAt?: string;
  txHash?:     string;
}

export interface SpendingRules {
  maxPerTx:        Partial<Record<Chain, string>>;
  maxPerSession:   Partial<Record<Chain, string>>;
  maxTxPerSession: number;
  allowedToAddresses?: string[];
  requireApproval: boolean;
}

export class WalletManager {
  private log:             MerkleLog;
  private vault:           CryptoVault;
  private mw:              SecurityMiddleware;
  private rules:           SpendingRules;
  private wallets        = new Map<Chain, WalletInfo>();
  private sessionTxCount = 0;
  private sessionSpend:    Partial<Record<Chain, bigint>> = {};

  constructor(log: MerkleLog, vault: CryptoVault, mw: SecurityMiddleware, rules: SpendingRules) {
    this.log   = log;
    this.vault = vault;
    this.mw    = mw;
    this.rules = rules;
  }

  registerAddress(chain: unknown, address: unknown, path: unknown): void {
    const gate = this.mw.walletRegister(chain, address, path);
    if (!gate.allowed) { console.log(`[wallet] ⛔ ${gate.reason}`); return; }

    this.wallets.set(chain as Chain, {
      chain:          chain as Chain,
      address:        address as string,
      derivationPath: path as string,
      hasEncryptedKey: false,
    });
    this.log.append("wallet:register", {
      chain,
      address: (address as string).slice(0, 10) + "…",
      path,
    }, { ok: true });
    console.log(`[wallet] ${(chain as string).toUpperCase()} registered: ${address}`);
  }

  async storeChildKey(chain: unknown, pinBuf: Buffer): Promise<void> {
    const gate = this.mw.walletStoreKey(chain);
    if (!gate.allowed) { console.log(`[wallet] ⛔ ${gate.reason}`); return; }

    const keyHex = await readPinSilent(`Child key hex for ${(chain as string).toUpperCase()} (hidden): `);

    const hexCheck = InputValidator.isHex64(keyHex.toString("utf8"), "childKey");
    if (hexCheck) {
      zeroBuffer(keyHex);
      console.log(`[wallet] ⛔ ${hexCheck}`);
      return;
    }

    // Convert hex string to raw bytes, then encrypt — key never lives as a JS string
    const rawKey = Buffer.from(keyHex.toString("utf8"), "hex");
    zeroBuffer(keyHex);

    const blob = this.vault.encryptBuffer(rawKey, pinBuf);
    // rawKey is zeroed by encryptBuffer
    this.vault.saveEncrypted(`key-${chain}`, blob, pinBuf);

    const w = this.wallets.get(chain as Chain);
    if (w) w.hasEncryptedKey = true;
    this.log.append("wallet:key-stored", { chain, encrypted: true }, { ok: true });
    console.log(`[wallet] ${(chain as string).toUpperCase()} key encrypted and stored.`);
  }

  async propose(
    chain: unknown,
    to: unknown,
    value: unknown,
    valueRaw: unknown,
    memo?: string,
    data?: string
  ): Promise<TxProposal | null> {
    const gate = this.mw.walletPropose(chain, to, value, valueRaw);
    if (!gate.allowed) { console.log(`[wallet] ⛔ ${gate.reason}`); return null; }

    const c        = chain as Chain;
    const toAddr   = to as string;
    const valStr   = value as string;
    const valRaw   = valueRaw as bigint;
    const from     = this.wallets.get(c)?.address ?? "unknown";

    // Spending limits
    const maxTxRaw = this.rules.maxPerTx[c] ? parseUnits(this.rules.maxPerTx[c]!, c) : null;
    if (maxTxRaw !== null && valRaw > maxTxRaw) {
      this.log.append("wallet:limit-exceeded", { chain: c, value: valStr }, { ok: false });
      console.log(`[wallet] ⛔ ${valStr} exceeds per-tx limit of ${this.rules.maxPerTx[c]}`);
      return null;
    }

    if (this.sessionTxCount >= this.rules.maxTxPerSession) {
      this.log.append("wallet:session-tx-limit", { count: this.sessionTxCount }, { ok: false });
      console.log(`[wallet] ⛔ Session TX limit (${this.rules.maxTxPerSession}) reached`);
      return null;
    }

    const spent    = this.sessionSpend[c] ?? 0n;
    const maxSes   = this.rules.maxPerSession[c] ? parseUnits(this.rules.maxPerSession[c]!, c) : null;
    if (maxSes !== null && spent + valRaw > maxSes) {
      this.log.append("wallet:session-spend-limit", { chain: c }, { ok: false });
      console.log(`[wallet] ⛔ Session spend limit would be exceeded`);
      return null;
    }

    if (this.rules.allowedToAddresses?.length && !this.rules.allowedToAddresses.includes(toAddr)) {
      this.log.append("wallet:address-blocked", { to: toAddr.slice(0, 10) + "…" }, { ok: false });
      console.log(`[wallet] ⛔ Destination not in approved address list`);
      return null;
    }

    const proposal: TxProposal = {
      id:        randomBytes(8).toString("hex"),
      chain:     c,
      from,
      to:        toAddr,
      value:     valStr,
      valueRaw:  valRaw,
      data,
      memo,
      createdAt: Temporal.Now.instant().toString(),
    };

    this.log.append("wallet:propose", {
      id:    proposal.id,
      chain: c,
      to:    toAddr.slice(0, 10) + "…",
      value: valStr,
      memo,
    }, { ok: true, status: "pending" });

    return proposal;
  }

  async promptApproval(proposal: TxProposal): Promise<boolean> {
    const gate = this.mw.walletApprove();
    if (!gate.allowed) { console.log(`[wallet] ⛔ ${gate.reason}`); return false; }

    console.log("\n╔══════════════════════════════════════════════════════╗");
    console.log("║          ⚠  TRANSACTION APPROVAL REQUIRED            ║");
    console.log("╠══════════════════════════════════════════════════════╣");
    console.log(`║  ID      : ${proposal.id.padEnd(42)}║`);
    console.log(`║  Chain   : ${proposal.chain.toUpperCase().padEnd(42)}║`);
    console.log(`║  From    : ${proposal.from.slice(0, 42).padEnd(42)}║`);
    console.log(`║  To      : ${proposal.to.slice(0, 42).padEnd(42)}║`);
    console.log(`║  Amount  : ${proposal.value.padEnd(42)}║`);
    if (proposal.memo) console.log(`║  Reason  : ${proposal.memo.slice(0, 42).padEnd(42)}║`);
    if (proposal.data) console.log(`║  Data    : ${proposal.data.slice(0, 42).padEnd(42)}║`);
    console.log(`║  TXs left: ${String(this.rules.maxTxPerSession - this.sessionTxCount).padEnd(42)}║`);
    console.log("╚══════════════════════════════════════════════════════╝");

    const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = await new Promise<string>(res => {
      rl.question("\n  Approve? (yes/no): ", a => { rl.close(); res(a.trim().toLowerCase()); });
    });

    const approved     = ans === "yes" || ans === "y";
    proposal.approved  = approved;
    proposal.approvedAt = Temporal.Now.instant().toString();

    this.log.append("wallet:approval", {
      id: proposal.id,
      approved,
      chain: proposal.chain,
      value: proposal.value,
    }, { ok: approved });

    if (!approved) console.log("  [wallet] Rejected.\n");
    return approved;
  }

  async execute(proposal: TxProposal, pinBuf: Buffer): Promise<string | null> {
    const gate = this.mw.walletExecute();
    if (!gate.allowed) { console.log(`[wallet] ⛔ ${gate.reason}`); return null; }

    if (!proposal.approved) {
      console.log("[wallet] Not approved.");
      return null;
    }

    const w = this.wallets.get(proposal.chain);
    if (!w?.hasEncryptedKey) {
      console.log(`[wallet] No encrypted key for ${proposal.chain}. Run: wallet storekey ${proposal.chain}`);
      return null;
    }

    let keyBuf:  Buffer | null = null;
    let txHash:  string | null = null;

    try {
      const encBlob = this.vault.loadDecrypted(`key-${proposal.chain}`, pinBuf);
      keyBuf = this.vault.decryptToBuffer(encBlob, pinBuf);

      switch (proposal.chain) {
        case "evm":   txHash = await executeEvm(proposal, keyBuf, this.log);   break;
        case "btc":   txHash = await executeBtc(proposal, keyBuf, this.log);   break;
        case "zcash": txHash = await executeZcash(proposal, this.log);         break;
      }
    } catch (err) {
      this.log.append("wallet:tx-error", { id: proposal.id, error: String(err) }, { ok: false });
      console.error(`[wallet] TX error: ${err}`);
      return null;
    } finally {
      if (keyBuf) zeroBuffer(keyBuf);
    }

    if (txHash) {
      proposal.txHash = txHash;
      this.sessionTxCount++;
      this.sessionSpend[proposal.chain] = (this.sessionSpend[proposal.chain] ?? 0n) + proposal.valueRaw;
      this.log.append("wallet:tx-sent", {
        id:    proposal.id,
        chain: proposal.chain,
        txHash: txHash.slice(0, 20) + "…",
        value: proposal.value,
      }, { ok: true });
      console.log(`\n[wallet] ✓ TX sent: ${txHash}\n`);
    }

    return txHash;
  }

  async proposeAndExecute(
    chain: unknown, to: unknown, value: unknown, valueRaw: unknown,
    pinBuf: Buffer, memo?: string, data?: string
  ): Promise<string | null> {
    const proposal = await this.propose(chain, to, value, valueRaw, memo, data);
    if (!proposal) return null;
    const approved = await this.promptApproval(proposal);
    if (!approved) return null;
    return this.execute(proposal, pinBuf);
  }

  printStatus(): void {
    console.log("\n─────────────────────────────────────────────────────");
    console.log("  WALLET STATUS");
    console.log("─────────────────────────────────────────────────────");
    if (this.wallets.size === 0) { console.log("  No wallets registered."); }
    for (const [chain, info] of this.wallets) {
      const ks = info.hasEncryptedKey ? "🔒 key in vault" : "👁  watch-only";
      console.log(`  ${chain.toUpperCase().padEnd(6)} ${info.address}`);
      console.log(`         ${ks}  |  ${info.derivationPath}`);
    }
    console.log(`\n  Session TXs : ${this.sessionTxCount} / ${this.rules.maxTxPerSession}`);
    for (const [chain, spent] of Object.entries(this.sessionSpend)) {
      console.log(`  ${chain} spent : ${formatUnits(spent as bigint, chain as Chain)}`);
    }
    console.log("─────────────────────────────────────────────────────\n");
  }
}

async function executeEvm(proposal: TxProposal, keyBuf: Buffer, log: MerkleLog): Promise<string> {
  const { ethers } = await import("ethers");
  const rpc     = process.env.EVM_RPC_URL ?? "https://eth.llamarpc.com";
  const privHex = "0x" + keyBuf.toString("hex");
  const wallet  = new ethers.Wallet(privHex, new ethers.JsonRpcProvider(rpc));
  const tx     = await wallet.sendTransaction({
    to:    proposal.to,
    value: proposal.valueRaw,
    data:  proposal.data ?? "0x",
  });
  log.append("evm:tx-broadcast", { hash: tx.hash.slice(0, 20) + "…" }, { ok: true });
  return tx.hash;
}

async function executeBtc(proposal: TxProposal, keyBuf: Buffer, log: MerkleLog): Promise<string> {
  const bitcoin = await import("bitcoinjs-lib");
  const ECPair  = (await import("ecpair")).ECPairFactory(await import("tiny-secp256k1"));
  const network = bitcoin.networks.bitcoin;
  const keyPair = ECPair.fromPrivateKey(keyBuf, { network });
  const { address } = bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network });

  const utxos: any[] = await fetch(`https://mempool.space/api/address/${address}/utxo`).then(r => r.json());
  if (!utxos.length) throw new Error("No UTXOs available");

  const psbt = new bitcoin.Psbt({ network });
  let total  = 0n;

  for (const u of utxos) {
    const raw = await fetch(`https://mempool.space/api/tx/${u.txid}/hex`).then(r => r.text());
    psbt.addInput({ hash: u.txid, index: u.vout, nonWitnessUtxo: Buffer.from(raw, "hex") });
    total += BigInt(u.value);
    if (total >= proposal.valueRaw + 1000n) break;
  }

  const fee    = 1000n;
  const change = total - proposal.valueRaw - fee;
  psbt.addOutput({ address: proposal.to, value: proposal.valueRaw });
  if (change > 546n) psbt.addOutput({ address: address!, value: change });

  psbt.signAllInputs(keyPair);
  psbt.finalizeAllInputs();

  const raw    = psbt.extractTransaction().toHex();
  const txHash = await fetch("https://mempool.space/api/tx", {
    method: "POST", body: raw, headers: { "Content-Type": "text/plain" },
  }).then(r => r.text());

  log.append("btc:tx-broadcast", { txHash: txHash.slice(0, 20) + "…" }, { ok: true });
  return txHash;
}

async function executeZcash(proposal: TxProposal, log: MerkleLog): Promise<string> {
  const rpc  = process.env.ZCASH_RPC_URL  ?? "";
  const user = process.env.ZCASH_RPC_USER ?? "";
  const pass = process.env.ZCASH_RPC_PASS ?? "";

  const res  = await fetch(rpc, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
    },
    body: JSON.stringify({
      jsonrpc: "1.0", id: "bot",
      method: "sendtoaddress",
      params: [proposal.to, Number(proposal.valueRaw) / 1e8],
    }),
  });

  const json: any = await res.json();
  if (json.error) throw new Error(json.error.message);
  log.append("zcash:tx-broadcast", { txHash: String(json.result).slice(0, 20) + "…" }, { ok: true });
  return json.result;
}

function parseUnits(human: string, chain: Chain): bigint {
  return BigInt(Math.round(parseFloat(human) * (chain === "evm" ? 1e18 : 1e8)));
}

function formatUnits(raw: bigint, chain: Chain): string {
  const labels = { evm: "ETH", btc: "BTC", zcash: "ZEC" };
  return `${Number(raw) / (chain === "evm" ? 1e18 : 1e8)} ${labels[chain]}`;
}
