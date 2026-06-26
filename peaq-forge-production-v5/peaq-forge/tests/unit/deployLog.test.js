"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path   = require("path");
const fs     = require("fs");
const os     = require("os");

// Use a temp file so tests don't pollute real deploy log
const TMP_LOG = path.join(os.tmpdir(), `.peaq_forge_test_${Date.now()}.json`);
process.env.PEAQ_FORGE_LOG_FILE = TMP_LOG;

let deployLog;

before(() => {
  deployLog = require("../../src/utils/deployLog");
});

after(() => {
  try { fs.unlinkSync(TMP_LOG); }       catch {}
  try { fs.unlinkSync(TMP_LOG + ".backup"); } catch {}
});

describe("deployLog.record", () => {
  it("records an entry", () => {
    deployLog.clear();
    deployLog.record({ type: "deploy", tool: "hardhat", chain: "agung", contractAddress: "0xABCD" });
    const all = deployLog.getAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].type, "deploy");
    assert.equal(all[0].chain, "agung");
  });

  it("strips private key fields", () => {
    deployLog.clear();
    deployLog.record({ type: "deploy", privateKey: "0xsecret", seed: "secret mnemonic", contract: "0xABCD" });
    const all = deployLog.getAll();
    assert.equal(all[0].privateKey, undefined);
    assert.equal(all[0].seed, undefined);
    assert.equal(all[0].contract, "0xABCD");
  });

  it("adds timestamp to each entry", () => {
    deployLog.clear();
    const before = Date.now();
    deployLog.record({ type: "test" });
    const after  = Date.now();
    const all    = deployLog.getAll();
    assert.ok(all[0].ts >= before);
    assert.ok(all[0].ts <= after);
  });

  it("redacts long hex strings in values", () => {
    deployLog.clear();
    const key = "0x" + "a".repeat(64);
    deployLog.record({ type: "deploy", output: `deployed at ${key}` });
    const all = deployLog.getAll();
    assert.ok(!all[0].output.includes(key), "long hex key should be redacted");
    assert.ok(all[0].output.includes("[REDACTED_KEY]"), "should contain redaction marker");
  });
});

describe("deployLog.getAll", () => {
  it("returns entries in reverse chronological order", () => {
    deployLog.clear();
    deployLog.record({ type: "first" });
    deployLog.record({ type: "second" });
    deployLog.record({ type: "third" });
    const all = deployLog.getAll();
    assert.equal(all[0].type, "third");
    assert.equal(all[2].type, "first");
  });
});

describe("deployLog.clear", () => {
  it("clears all entries", () => {
    deployLog.record({ type: "x" });
    deployLog.clear();
    assert.equal(deployLog.getAll().length, 0);
  });
});
