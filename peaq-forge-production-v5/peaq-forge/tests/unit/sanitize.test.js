"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeStr, isValidRpc, isHex, isEthAddress, isSS58, sanitizeArgs } = require("../../src/utils/sanitize");

describe("sanitizeStr", () => {
  it("removes shell injection characters", () => {
    assert.equal(sanitizeStr("hello;world"), "helloworld");
    assert.equal(sanitizeStr("hello|world"), "helloworld");
    assert.equal(sanitizeStr("hello`world"), "helloworld");
    assert.equal(sanitizeStr("hello$world"), "helloworld");
    assert.equal(sanitizeStr("hello>world"), "helloworld");
    assert.equal(sanitizeStr("hello<world"), "helloworld");
  });
  it("passes safe strings through", () => {
    assert.equal(sanitizeStr("hello-world"), "hello-world");
    assert.equal(sanitizeStr("MyContract"), "MyContract");
  });
});

describe("isValidRpc", () => {
  it("accepts https URLs", () => {
    assert.equal(isValidRpc("https://rpcpc1-qa.agung.peaq.network"), true);
    assert.equal(isValidRpc("https://peaq.api.onfinality.io/public"), true);
  });
  it("accepts wss URLs", () => {
    assert.equal(isValidRpc("wss://wss.agung.peaq.network"), true);
  });
  it("accepts localhost http/ws", () => {
    assert.equal(isValidRpc("http://127.0.0.1:9944"), true);
    assert.equal(isValidRpc("ws://127.0.0.1:9944"), true);
  });
  it("rejects non-https remote URLs", () => {
    assert.equal(isValidRpc("http://evil.com/rpc"), false);
    assert.equal(isValidRpc("ftp://example.com"), false);
  });
  it("rejects empty/null", () => {
    assert.equal(isValidRpc(""), false);
    assert.equal(isValidRpc(null), false);
    assert.equal(isValidRpc(undefined), false);
  });
});

describe("isHex", () => {
  it("accepts valid hex", () => {
    assert.equal(isHex("0xabcdef1234"), true);
    assert.equal(isHex("0xABCDEF"), true);
  });
  it("rejects non-hex", () => {
    assert.equal(isHex("0xGGGG"), false);
    assert.equal(isHex("abcdef"), false);
    assert.equal(isHex(""), false);
  });
});

describe("isEthAddress", () => {
  it("accepts valid Ethereum addresses", () => {
    assert.equal(isEthAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"), true);
  });
  it("rejects invalid addresses", () => {
    assert.equal(isEthAddress("0xshort"), false);
    assert.equal(isEthAddress("notanaddress"), false);
  });
});

describe("sanitizeArgs", () => {
  it("filters out shell injection", () => {
    const result = sanitizeArgs(["safe", "arg;evil", "another|bad"]);
    assert.equal(result.length, 1);
    assert.equal(result[0], "safe");
  });
  it("passes safe args", () => {
    const result = sanitizeArgs(["--network", "agung", "--gas-report"]);
    assert.deepEqual(result, ["--network", "agung", "--gas-report"]);
  });
  it("returns empty array for non-array input", () => {
    assert.deepEqual(sanitizeArgs(null), []);
    assert.deepEqual(sanitizeArgs(undefined), []);
  });
});
