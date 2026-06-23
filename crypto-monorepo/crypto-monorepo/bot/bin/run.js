#!/usr/bin/env node
'use strict';

/**
 * bot/bin/run.js
 * CLI entry point for the crypto agent.
 *
 * Usage:
 *   node bin/run.js                          → interactive REPL
 *   node bin/run.js "encrypt hello with AES" → one-shot goal
 *   node bin/run.js --quiet "..."            → one-shot, minimal output
 *   node bin/run.js --tools                  → list all available tools
 *   node bin/run.js --demo                   → run built-in demo goals
 */

require('../core/resolver');

const readline  = require('readline');
const { run }   = require('../core/agent');
const { listTools } = require('../tools/registry');

const args    = process.argv.slice(2);
const quiet   = args.includes('--quiet');
const verbose = !quiet;

// ── --tools flag ──────────────────────────────────────────────────────────────

if (args.includes('--tools')) {
  const tools = listTools();
  console.log(`\n Crypto Agent — ${tools.length} tools available\n`);
  for (const t of tools) {
    console.log(`  ▸ ${t.name.padEnd(30)} ${t.description}`);
  }
  console.log();
  process.exit(0);
}

// ── --demo flag ───────────────────────────────────────────────────────────────

if (args.includes('--demo')) {
  const DEMO_GOALS = [
    'Generate an AES-256-GCM key, encrypt the message "Hello, crypto world!" with it, then decrypt it and confirm the plaintext.',
    'Derive a key from the password "hunter2" using scrypt, then HMAC-sign the message "authenticate this" with it and verify the signature.',
    'Generate an RSA 2048-bit keypair, sign the message "signed payload" with Ed25519 as well, then verify both signatures.',
    'Create an encrypted channel named "demo-channel", send the message "secret handshake" from initiator to responder, receive and decrypt it.',
  ];

  (async () => {
    console.log('\n═══════════════════════════════════════════════════');
    console.log('  Crypto Agent — Demo Mode');
    console.log('═══════════════════════════════════════════════════\n');

    for (let i = 0; i < DEMO_GOALS.length; i++) {
      const goal = DEMO_GOALS[i];
      console.log(`\n── Demo ${i + 1}/${DEMO_GOALS.length} ──────────────────────────────`);
      console.log(`Goal: ${goal}\n`);
      try {
        const { answer, steps } = await run(goal, { verbose: true });
        console.log(`\n✓ Complete in ${steps.length} steps`);
        console.log(`  Answer: ${answer}`);
      } catch (err) {
        console.error(`✗ Failed: ${err.message}`);
      }
    }

    console.log('\n═══════════════════════════════════════════════════\n');
    process.exit(0);
  })();
  return;
}

// ── One-shot mode ─────────────────────────────────────────────────────────────

const oneShot = args.filter(a => !a.startsWith('--')).join(' ').trim();
if (oneShot) {
  (async () => {
    if (!quiet) {
      console.log('\n Crypto Agent');
      console.log(`Goal: ${oneShot}\n`);
    }
    try {
      const { answer, steps } = await run(oneShot, { verbose });
      if (quiet) {
        console.log(answer);
      } else {
        console.log(`\n✓ Done in ${steps.length} step(s)`);
        console.log(`Answer: ${answer}`);
      }
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
    process.exit(0);
  })();
  return;
}

// ── Interactive REPL ──────────────────────────────────────────────────────────

const tools = listTools();

console.log(`
╔═══════════════════════════════════════════════════════╗
║           Crypto Agent — Interactive Mode             ║
║  ${tools.length} tools  |  zero npm deps  |  pure Node.js       ║
╠═══════════════════════════════════════════════════════╣
║  Type a goal in plain English and press Enter.        ║
║  Commands: :tools  :quit  :help                       ║
╚═══════════════════════════════════════════════════════╝
`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '\n Goal > ' });
rl.prompt();

rl.on('line', async (line) => {
  const input = line.trim();
  if (!input) { rl.prompt(); return; }

  // Built-in commands
  if (input === ':quit' || input === ':exit') { console.log('Bye.'); process.exit(0); }
  if (input === ':tools') {
    for (const t of tools) console.log(`  ▸ ${t.name.padEnd(30)} ${t.description}`);
    rl.prompt(); return;
  }
  if (input === ':help') {
    console.log('  Just describe what you want in plain English.');
    console.log('  Examples:');
    console.log('    Generate an AES-GCM key and encrypt "hello world"');
    console.log('    Derive a scrypt key from the password "mypass" and hash it with SHA-256');
    console.log('    Create an encrypted channel and send a message through it');
    rl.prompt(); return;
  }

  // Run agent
  try {
    const { answer, steps } = await run(input, { verbose: true });
    console.log(`\n✓ Complete in ${steps.length} step(s)`);
    console.log(`  ${answer}`);
  } catch (err) {
    console.error('\n✗ Error:', err.message);
  }

  rl.prompt();
});

rl.on('close', () => { console.log('\nBye.'); process.exit(0); });
