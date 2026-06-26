"use strict";

const router    = require("express").Router();
const { spawn } = require("child_process");
const os        = require("os");
const logger    = require("../utils/logger");

const IS_WIN = process.platform === "win32";
const HOME   = os.homedir();

function buildEnvPath() {
  const extra = IS_WIN ? [
    `${HOME}\\.cargo\\bin`, `${HOME}\\AppData\\Roaming\\npm`, `${HOME}\\.foundry\\bin`
  ] : [
    `${HOME}/.cargo/bin`, `${HOME}/.foundry/bin`,
    `/usr/local/bin`, `/opt/homebrew/bin`, `/usr/bin`
  ];
  return [process.env.PATH, ...extra].filter(Boolean).join(IS_WIN ? ";" : ":");
}

const ENV_PATH = buildEnvPath();

const TOOLS = [
  { name: "forge",  flags: ["--version"] },
  { name: "cast",   flags: ["--version"] },
  { name: "anvil",  flags: ["--version"] },
  { name: "node",   flags: ["--version"] },
  { name: "npx",    flags: ["--version"] },
  { name: "cargo",  flags: ["--version"] },
];

router.get("/", async (req, res) => {
  try {
    const results = await Promise.all(TOOLS.map(t => new Promise(resolve => {
      try {
        const proc = spawn(t.name, t.flags, {
          shell: false,
          env:   { PATH: ENV_PATH, HOME: require("os").homedir(), TERM: "dumb", FORCE_COLOR: "0" },
          timeout: 5000,
        });
        let out = "";
        proc.stdout.on("data", d => { out += d; });
        proc.stderr.on("data", d => { out += d; });
        proc.on("close",  code => resolve({ name: t.name, available: code === 0, version: out.trim().split("\n")[0] || "not found" }));
        proc.on("error",  ()   => resolve({ name: t.name, available: false, version: "not found" }));
        proc.on("timeout", ()  => { proc.kill(); resolve({ name: t.name, available: false, version: "timeout" }); });
      } catch (e) {
        resolve({ name: t.name, available: false, version: "error: " + e.message });
      }
    })));
    res.json({ tools: results });
  } catch (e) {
    logger.error("Tool check failed: " + e.message);
    res.status(500).json({ error: "Tool check failed", tools: [] });
  }
});

module.exports = router;
