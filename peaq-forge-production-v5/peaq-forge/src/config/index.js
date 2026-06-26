"use strict";

module.exports = {
  NODE_ENV:   process.env.NODE_ENV   || "production",
  PORT:       parseInt(process.env.PORT || "3048", 10),
  HOST:       process.env.HOST       || "127.0.0.1",
  // A07: Enforce minimum token entropy — reject tokens shorter than 32 chars
  AUTH_TOKEN: (() => {
    const token = process.env.PEAQ_FORGE_TOKEN;
    if (token) {
      if (token.length < 32) {
        console.error("[PEAQ FORGE] FATAL: PEAQ_FORGE_TOKEN must be at least 32 characters. Refusing to start with a weak token.");
        process.exit(1);
      }
      return token;
    }
    return require("crypto").randomBytes(32).toString("hex");
  })(),
  LOG_LEVEL:       process.env.LOG_LEVEL       || "info",
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS  || null,
  NETWORKS: {
    mainnet: {
      rpc: process.env.PEAQ_MAINNET_RPC || "https://peaq.api.onfinality.io/public",
      ws:  process.env.PEAQ_MAINNET_WS  || "wss://wss.peaq.network",
      chainId: 3338
    },
    agung: {
      rpc: process.env.PEAQ_AGUNG_RPC || "https://rpcpc1-qa.agung.peaq.network",
      ws:  process.env.PEAQ_AGUNG_WS  || "wss://wss.agung.peaq.network",
      chainId: 9990
    },
    krest: {
      rpc: process.env.PEAQ_KREST_RPC || "https://erpc.krest.peaq.network",
      ws:  process.env.PEAQ_KREST_WS  || "wss://krest.peaq.network",
      chainId: 2241
    },
    local: {
      rpc: "http://127.0.0.1:9944",
      ws:  "ws://127.0.0.1:9944",
      chainId: 4242
    }
  }
};
