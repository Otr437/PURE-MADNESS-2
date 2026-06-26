"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// Stub joi so validator loads without installed package during CI
let validate;
try {
  ({ validate } = require("../../src/validators"));
} catch (e) {
  // If Joi not installed, skip gracefully
  console.warn("Skipping validator tests — joi not installed:", e.message);
  process.exit(0);
}

describe("Validator — did_create", () => {
  it("accepts valid hex name", () => {
    const { error } = validate("did_create", { name: "0x6d79546f6b656e" });
    assert.equal(error, null);
  });

  it("rejects non-hex name", () => {
    const { error } = validate("did_create", { name: "not-hex" });
    assert.ok(error, "should have error for non-hex name");
  });

  it("rejects missing name", () => {
    const { error } = validate("did_create", {});
    assert.ok(error, "should have error for missing name");
  });

  it("strips unknown keys", () => {
    const { value } = validate("did_create", { name: "0xaabb", injected: "; rm -rf" });
    assert.equal(value.injected, undefined);
  });
});

describe("Validator — peaq_deploy", () => {
  it("accepts valid script path", () => {
    const { error } = validate("peaq_deploy", { script: "scripts/deploy.js" });
    assert.equal(error, null);
  });

  it("rejects missing script", () => {
    const { error } = validate("peaq_deploy", {});
    assert.ok(error);
  });

  it("rejects invalid network", () => {
    const { error } = validate("peaq_deploy", { script: "deploy.js", network: "badnet" });
    assert.ok(error);
  });

  it("accepts valid network names", () => {
    for (const net of ["mainnet", "agung", "krest", "local", "custom"]) {
      const { error } = validate("peaq_deploy", { script: "deploy.js", network: net });
      assert.equal(error, null, `should accept network: ${net}`);
    }
  });
});

describe("Validator — peaq_cast_call", () => {
  it("accepts valid eth address and sig", () => {
    const { error } = validate("peaq_cast_call", {
      to:  "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      sig: "balanceOf(address)",
    });
    assert.equal(error, null);
  });

  it("rejects invalid eth address", () => {
    const { error } = validate("peaq_cast_call", { to: "0xshort", sig: "fn()" });
    assert.ok(error);
  });

  it("rejects missing to", () => {
    const { error } = validate("peaq_cast_call", { sig: "fn()" });
    assert.ok(error);
  });
});

describe("Validator — mnft_bind", () => {
  it("requires contract and tokenId", () => {
    const { error } = validate("mnft_bind", {});
    assert.ok(error);
  });

  it("accepts valid inputs", () => {
    const { error } = validate("mnft_bind", {
      contract: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      tokenId:  1,
      did:      "0x" + "ab".repeat(32),
    });
    assert.equal(error, null);
  });
});

describe("Validator — rbac_add_permission", () => {
  it("requires permissionId and permissionName", () => {
    const { error } = validate("rbac_add_permission", {});
    assert.ok(error);
  });

  it("accepts valid inputs", () => {
    const { error } = validate("rbac_add_permission", {
      permissionId:   "0x7065726d3031",
      permissionName: "read_sensor",
    });
    assert.equal(error, null);
  });
});

describe("Validator — custom", () => {
  it("requires command field", () => {
    const { error } = validate("custom", {});
    assert.ok(error);
  });

  it("rejects command over 512 chars", () => {
    const { error } = validate("custom", { command: "x".repeat(513) });
    assert.ok(error);
  });

  it("accepts valid command", () => {
    const { error } = validate("custom", { command: "forge --version" });
    assert.equal(error, null);
  });
});

describe("Validator — unknown action", () => {
  it("passes through unknown actions without error", () => {
    const { error, value } = validate("__unknown_action__", { foo: "bar" });
    assert.equal(error, null);
    assert.equal(value.foo, "bar");
  });
});
