"use strict";

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

describe("timingSafeCompare", () => {
  let timingSafeCompare;
  before(() => {
    process.env.PEAQ_FORGE_TOKEN = "test-token-123";
    ({ timingSafeCompare } = require("../../src/middleware/auth"));
  });

  it("returns true for matching strings", () => {
    assert.equal(timingSafeCompare("hello", "hello"), true);
    assert.equal(timingSafeCompare("test-token-123", "test-token-123"), true);
  });

  it("returns false for non-matching strings", () => {
    assert.equal(timingSafeCompare("hello", "world"), false);
    assert.equal(timingSafeCompare("short", "longer-string"), false);
  });

  it("returns false for empty strings vs non-empty", () => {
    assert.equal(timingSafeCompare("", "nonempty"), false);
  });
});
