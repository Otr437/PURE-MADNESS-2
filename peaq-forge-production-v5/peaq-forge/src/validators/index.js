"use strict";

const Joi = require("joi");

// ── Primitives ────────────────────────────────────────────────────────────────
const hexStr   = Joi.string().pattern(/^0x[0-9a-fA-F]+$/).max(256);
const ethAddr  = Joi.string().pattern(/^0x[0-9a-fA-F]{40}$/).max(42);
const ss58     = Joi.string().pattern(/^[1-9A-HJ-NP-Za-km-z]{44,50}$/).max(64);
const rpcUrl   = Joi.string().uri({ scheme: ["http","https","ws","wss"] }).max(512);
const wsUrl    = Joi.string().uri({ scheme: ["ws","wss"] }).max(512);
const suriStr  = Joi.string().max(256);  // //Alice or mnemonic — validated server-side
const netName  = Joi.string().valid("mainnet","agung","krest","local","custom");
const safeStr  = Joi.string().max(1024).pattern(/^[^;&|`$<>\n\r'"\\]*$/);
const boolF    = Joi.boolean().default(false);

// ── EVM / Hardhat ─────────────────────────────────────────────────────────────
const schemas = {

  init_hardhat_peaq: Joi.object({
    rpc:     rpcUrl.optional(),
    chainId: Joi.number().integer().min(1).max(999999).optional(),
  }),

  peaq_compile: Joi.object({}),

  hardhat_clean: Joi.object({}),

  peaq_test: Joi.object({
    grep:     safeStr.optional().allow(""),
    network:  safeStr.max(64).optional().allow(""),
    parallel: boolF,
    gas:      boolF,
  }),

  peaq_deploy: Joi.object({
    script:  safeStr.required(),
    network: netName.optional().default("agung"),
    rpc:     rpcUrl.optional().allow(""),
    // env_override: limited to known safe keys only — validated in hardhat.service.js
    env_override: Joi.object({
      MULTISIG_OWNERS:   Joi.string().pattern(/^(0x[0-9a-fA-F]{40},?)+$/).max(2048).optional(),
      MULTISIG_REQUIRED: Joi.number().integer().min(1).max(20).optional(),
      TOKEN_NAME:        Joi.string().max(64).optional(),
      TOKEN_SYMBOL:      Joi.string().alphanum().max(16).optional(),
      TOKEN_DECIMALS:    Joi.number().integer().min(0).max(18).optional(),
      TOKEN_MAX_SUPPLY:  Joi.number().min(0).optional(),
      TOKEN_INITIAL_MINT:Joi.number().min(0).optional(),
    }).optional(),
  }),

  peaq_verify: Joi.object({
    address: ethAddr.required(),
    network: safeStr.max(64).optional().allow(""),
    args:    safeStr.optional().allow(""),
  }),

  peaq_cast_call: Joi.object({
    to:       ethAddr.required(),
    sig:      safeStr.required(),
    calldata: safeStr.optional().allow(""),
    rpc_url:  rpcUrl.optional().allow(""),
  }),

  peaq_cast_send: Joi.object({
    to:          ethAddr.required(),
    sig:         safeStr.required(),
    calldata:    safeStr.optional().allow(""),
    rpc_url:     rpcUrl.optional().allow(""),
    private_key: hexStr.optional().allow(""),
    value:       safeStr.max(64).optional().allow(""),
  }),

  peaq_cast_balance: Joi.object({
    address: ethAddr.required(),
    rpc_url: rpcUrl.optional().allow(""),
    ether:   boolF,
  }),

  peaq_anvil: Joi.object({
    port:       Joi.number().integer().min(1024).max(65535).optional(),
    chain_id:   Joi.number().integer().min(1).optional(),
    accounts:   Joi.number().integer().min(1).max(100).optional(),
    block_time: Joi.number().min(0).optional(),
    fork_url:   rpcUrl.optional().allow(""),
  }),

  // ── Foundry ────────────────────────────────────────────────────────────────
  forge_build: Joi.object({
    optimize: boolF,
    via_ir:   boolF,
    sizes:    boolF,
  }),

  forge_clean: Joi.object({}),

  forge_test: Joi.object({
    filter:   safeStr.optional().allow(""),
    contract: safeStr.optional().allow(""),
    verbose:  boolF,
    gas:      boolF,
    fork_url: rpcUrl.optional().allow(""),
  }),

  forge_create: Joi.object({
    contract:         safeStr.required(),
    rpc_url:          rpcUrl.optional().allow(""),
    private_key:      hexStr.optional().allow(""),
    constructor_args: safeStr.optional().allow(""),
  }),

  forge_script: Joi.object({
    script:      safeStr.required(),
    rpc_url:     rpcUrl.optional().allow(""),
    private_key: hexStr.optional().allow(""),
    broadcast:   boolF,
    slow:        boolF,
  }),

  cast_call: Joi.object({
    to:       ethAddr.required(),
    sig:      safeStr.required(),
    calldata: safeStr.optional().allow(""),
    rpc_url:  rpcUrl.optional().allow(""),
  }),

  cast_send: Joi.object({
    to:          ethAddr.required(),
    sig:         safeStr.required(),
    calldata:    safeStr.optional().allow(""),
    rpc_url:     rpcUrl.optional().allow(""),
    private_key: hexStr.optional().allow(""),
    value:       safeStr.max(64).optional().allow(""),
  }),

  anvil_start: Joi.object({
    port:       Joi.number().integer().min(1024).max(65535).optional(),
    chain_id:   Joi.number().integer().min(1).optional(),
    accounts:   Joi.number().integer().min(1).max(100).optional(),
    block_time: Joi.number().min(0).optional(),
    fork_url:   rpcUrl.optional().allow(""),
  }),

  // ── ink! ───────────────────────────────────────────────────────────────────
  ink_new: Joi.object({
    name: Joi.string().pattern(/^[a-zA-Z0-9_]+$/).max(64).required(),
  }),

  ink_build: Joi.object({
    release: boolF,
  }),

  ink_check: Joi.object({}),

  ink_test: Joi.object({
    filter: safeStr.optional().allow(""),
  }),

  ink_instantiate: Joi.object({
    wasmFile:    safeStr.required(),
    constructor: safeStr.optional().default("new"),
    args:        safeStr.optional().allow(""),
    url:         wsUrl.optional().allow(""),
    suri:        suriStr.optional().allow(""),
    network:     netName.optional(),
  }),

  ink_call: Joi.object({
    contract: ss58.required(),
    message:  safeStr.required(),
    args:     safeStr.optional().allow(""),
    url:      wsUrl.optional().allow(""),
    suri:     suriStr.optional().allow(""),
    dryRun:   boolF,
  }),

  // ── Substrate ──────────────────────────────────────────────────────────────
  substrate_node: Joi.object({
    dev:         boolF,
    purge:       boolF,
    rpcExternal: boolF,
  }),

  substrate_build: Joi.object({
    release: boolF,
  }),

  substrate_check: Joi.object({}),

  substrate_rpc_call: Joi.object({
    url:    wsUrl.optional().allow(""),
    method: safeStr.required(),
    params: Joi.string().max(4096).optional().default("[]"),
  }),

  // ── DID ────────────────────────────────────────────────────────────────────
  did_create: Joi.object({
    name:     hexStr.required(),
    document: Joi.string().max(8192).optional(),
    suri:     suriStr.optional().allow(""),
    url:      wsUrl.optional().allow(""),
    network:  netName.optional(),
  }),

  did_read: Joi.object({
    address: Joi.alternatives().try(ss58, ethAddr).optional().allow(""),
    name:    hexStr.optional().allow(""),
    url:     wsUrl.optional().allow(""),
    network: netName.optional(),
  }),

  did_update: Joi.object({
    name:     hexStr.required(),
    document: Joi.string().max(8192).optional(),
    suri:     suriStr.optional().allow(""),
    url:      wsUrl.optional().allow(""),
    network:  netName.optional(),
  }),

  did_remove: Joi.object({
    name:    hexStr.required(),
    suri:    suriStr.optional().allow(""),
    url:     wsUrl.optional().allow(""),
    network: netName.optional(),
  }),

  // ── Storage ────────────────────────────────────────────────────────────────
  storage_add: Joi.object({
    itemType: hexStr.required(),
    value:    hexStr.optional().default("0x"),
    suri:     suriStr.optional().allow(""),
    url:      wsUrl.optional().allow(""),
    network:  netName.optional(),
  }),

  storage_get: Joi.object({
    address:  Joi.alternatives().try(ss58, ethAddr).optional().allow(""),
    itemType: hexStr.required(),
    url:      wsUrl.optional().allow(""),
    network:  netName.optional(),
  }),

  storage_update: Joi.object({
    itemType: hexStr.required(),
    value:    hexStr.optional().default("0x"),
    suri:     suriStr.optional().allow(""),
    url:      wsUrl.optional().allow(""),
    network:  netName.optional(),
  }),

  storage_remove: Joi.object({
    itemType: hexStr.required(),
    suri:     suriStr.optional().allow(""),
    url:      wsUrl.optional().allow(""),
    network:  netName.optional(),
  }),

  // ── RBAC ───────────────────────────────────────────────────────────────────
  rbac_add_role: Joi.object({
    roleId:   hexStr.required(),
    roleName: safeStr.required(),
    suri:     suriStr.optional().allow(""),
    url:      wsUrl.optional().allow(""),
    network:  netName.optional(),
  }),

  rbac_fetch_roles: Joi.object({
    address: Joi.alternatives().try(ss58, ethAddr).optional().allow(""),
    url:     wsUrl.optional().allow(""),
    network: netName.optional(),
  }),

  rbac_assign_role: Joi.object({
    roleId:  hexStr.required(),
    userId:  hexStr.required(),
    suri:    suriStr.optional().allow(""),
    url:     wsUrl.optional().allow(""),
    network: netName.optional(),
  }),

  rbac_add_permission: Joi.object({
    permissionId:   hexStr.required(),
    permissionName: safeStr.required(),
    suri:           suriStr.optional().allow(""),
    url:            wsUrl.optional().allow(""),
    network:        netName.optional(),
  }),

  // ── mNFT ───────────────────────────────────────────────────────────────────
  mnft_owner: Joi.object({
    contract: ethAddr.required(),
    tokenId:  Joi.alternatives().try(Joi.number().integer().min(0), hexStr).required(),
    rpc:      rpcUrl.optional().allow(""),
  }),

  mnft_uri_q: Joi.object({
    contract: ethAddr.required(),
    tokenId:  Joi.alternatives().try(Joi.number().integer().min(0), hexStr).required(),
    rpc:      rpcUrl.optional().allow(""),
  }),

  mnft_did_q: Joi.object({
    contract: ethAddr.required(),
    tokenId:  Joi.alternatives().try(Joi.number().integer().min(0), hexStr).required(),
    rpc:      rpcUrl.optional().allow(""),
  }),

  mnft_bind: Joi.object({
    contract:   ethAddr.required(),
    tokenId:    Joi.alternatives().try(Joi.number().integer().min(0), hexStr).required(),
    did:        hexStr.optional(),
    rpc:        rpcUrl.optional().allow(""),
    privateKey: hexStr.optional().allow(""),
  }),

  // ── Custom ─────────────────────────────────────────────────────────────────
  custom: Joi.object({
    command: Joi.string().max(512).required(),
  }),

  // ── Auth / kill ────────────────────────────────────────────────────────────
  auth: Joi.object({
    token: Joi.string().max(256).required(),
  }),

  kill: Joi.object({}),
};

/**
 * Validate args for a given action.
 * Returns { value, error } — error is null on success.
 */
function validate(action, args) {
  const schema = schemas[action];
  if (!schema) return { value: args || {}, error: null }; // unknown actions pass through; handler rejects them
  const { error, value } = schema.validate(args || {}, {
    abortEarly:   true,
    stripUnknown: true,
    convert:      true,
  });
  return { value, error: error ? error.details[0].message : null };
}

module.exports = { validate, schemas };
