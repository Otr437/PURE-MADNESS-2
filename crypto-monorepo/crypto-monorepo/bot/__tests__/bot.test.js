'use strict';

/**
 * bot/__tests__/bot.test.js
 * Full integration test suite — no LLM calls, no network.
 * All async tests wrapped properly for CJS.
 */

require('../core/resolver');

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

// ── Temp data dir ─────────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crypto-bot-test-'));
process.env.CRYPTO_BOT_SESSION_FILE = path.join(TMP, 'session.enc');
process.env.CRYPTO_BOT_MEMORY_FILE  = path.join(TMP, 'memory.jsonl');
process.env.CRYPTO_BOT_AUDIT_FILE   = path.join(TMP, 'audit.jsonl');
process.env.CRYPTO_BOT_SCHED_FILE   = path.join(TMP, 'scheduler.json');
process.env.CRYPTO_BOT_PASSPHRASE   = 'test-passphrase-1234';
process.env.LOG_LEVEL               = 'error';

// ── Imports ───────────────────────────────────────────────────────────────────
const { callTool, listTools }        = require('../tools/registry');
const session                        = require('../core/session');
const memory                         = require('../core/memory');
const { audit, verify, readAll }     = require('../core/audit');
const { withRetry, classify, ERROR_CLASSES } = require('../core/retry');
const scheduler                      = require('../core/scheduler');
const { SecureKeyStore }             = require('@crypto-monorepo/secure-key-store');

// ── Runner ────────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const queue = []; // { name, fn, async }

function test(name, fn)      { queue.push({ name, fn, async: false }); }
function testA(name, fn)     { queue.push({ name, fn, async: true  }); }

async function runAll() {
  for (const t of queue) {
    try {
      if (t.async) await t.fn();
      else         t.fn();
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${t.name}: ${err.message}`);
      failed++;
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. Tool registry
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── Tool Registry ──');

test('lists ≥32 tools', () => {
  assert.ok(listTools().length >= 32, `got ${listTools().length}`);
});

test('every tool has name + description + parameters', () => {
  for (const t of listTools()) {
    assert.ok(t.name,        'missing name');
    assert.ok(t.description, `${t.name} missing description`);
    assert.ok(t.parameters !== undefined, `${t.name} missing parameters`);
  }
});

test('aes_gcm_generate_key', () => {
  const r = callTool('aes_gcm_generate_key', { keyId: 'k1' });
  assert.ok(r.ok);
  assert.strictEqual(r.keyHex.length, 64);
});

test('aes_gcm encrypt → decrypt', () => {
  callTool('aes_gcm_generate_key', { keyId: 'k2' });
  const { ciphertext } = callTool('aes_gcm_encrypt', { keyId: 'k2', plaintext: 'hello bot' });
  const { plaintext  } = callTool('aes_gcm_decrypt', { keyId: 'k2', ciphertext });
  assert.strictEqual(plaintext, 'hello bot');
});

test('aes_gcm_rotate_key produces new ciphertext', () => {
  callTool('aes_gcm_generate_key', { keyId: 'k-rot' });
  const { ciphertext: ct1 }            = callTool('aes_gcm_encrypt',     { keyId: 'k-rot', plaintext: 'rotate me' });
  const { newKeyId, newCiphertext }    = callTool('aes_gcm_rotate_key',  { keyId: 'k-rot', ciphertext: ct1 });
  const { plaintext }                  = callTool('aes_gcm_decrypt',     { keyId: newKeyId, ciphertext: newCiphertext });
  assert.strictEqual(plaintext, 'rotate me');
});

test('aes_cbc encrypt → decrypt', () => {
  callTool('aes_cbc_generate_key', { keyId: 'cbc1' });
  const { ciphertext } = callTool('aes_cbc_encrypt', { keyId: 'cbc1', plaintext: 'cbc msg' });
  const { plaintext  } = callTool('aes_cbc_decrypt', { keyId: 'cbc1', ciphertext });
  assert.strictEqual(plaintext, 'cbc msg');
});

test('rsa generate + hybrid encrypt/decrypt', () => {
  callTool('rsa_generate_keypair', { bits: 2048 });
  const { ciphertext } = callTool('rsa_hybrid_encrypt', { plaintext: 'rsa secret' });
  const { plaintext  } = callTool('rsa_hybrid_decrypt', { ciphertext });
  assert.strictEqual(plaintext, 'rsa secret');
});

test('rsa sign + verify', () => {
  const { signature } = callTool('rsa_sign',   { data: 'sign me' });
  const { valid }     = callTool('rsa_verify', { data: 'sign me', signature });
  assert.ok(valid);
  const { valid: bad } = callTool('rsa_verify', { data: 'tampered', signature });
  assert.ok(!bad);
});

test('hmac sign + verify', () => {
  callTool('aes_gcm_generate_key', { keyId: 'hmk' });
  const { macHex } = callTool('hmac_sign',   { keyId: 'hmk', data: 'auth this' });
  const { valid  } = callTool('hmac_verify', { keyId: 'hmk', data: 'auth this', macHex });
  assert.ok(valid);
  const { valid: bad } = callTool('hmac_verify', { keyId: 'hmk', data: 'wrong', macHex });
  assert.ok(!bad);
});

test('ed25519 generate + sign + verify', () => {
  callTool('ed25519_generate', {});
  const { signature } = callTool('ed25519_sign',   { data: 'ed msg' });
  const { valid }     = callTool('ed25519_verify', { data: 'ed msg', signature });
  assert.ok(valid);
});

test('sign_json + verify_json', () => {
  callTool('aes_gcm_generate_key', { keyId: 'jk' });
  const { payload, sig } = callTool('sign_json',   { keyId: 'jk', data: '{"x":1}' });
  const { valid }        = callTool('verify_json', { keyId: 'jk', payload, sig });
  assert.ok(valid);
});

test('kdf_scrypt produces 32-byte key', () => {
  const { keyHex } = callTool('kdf_scrypt', { password: 'pw', N: 1024 });
  assert.strictEqual(keyHex.length, 64);
});

test('kdf_pbkdf2 produces 32-byte key', () => {
  const { keyHex } = callTool('kdf_pbkdf2', { password: 'pw', iterations: 1000 });
  assert.strictEqual(keyHex.length, 64);
});

test('kdf_hkdf produces derived key', () => {
  const ikm = crypto.randomBytes(32).toString('hex');
  const { derivedKeyHex } = callTool('kdf_hkdf', { ikm, info: 'test', length: 32 });
  assert.strictEqual(derivedKeyHex.length, 64);
});

test('channel create + send + receive', () => {
  callTool('channel_create', { channelName: 'ch1' });
  const { frame   } = callTool('channel_send',    { channelName: 'ch1', message: 'peer msg', direction: 'i2r' });
  const { message } = callTool('channel_receive', { channelName: 'ch1', frame, direction: 'i2r' });
  assert.strictEqual(message, 'peer msg');
});

test('channel bidirectional', () => {
  callTool('channel_create', { channelName: 'ch2' });
  const { frame   } = callTool('channel_send',    { channelName: 'ch2', message: 'reply', direction: 'r2i' });
  const { message } = callTool('channel_receive', { channelName: 'ch2', frame, direction: 'r2i' });
  assert.strictEqual(message, 'reply');
});

test('utils_random produces correct byte count', () => {
  const { value } = callTool('utils_random', { bytes: 16, format: 'hex' });
  assert.strictEqual(value.length, 32);
});

test('utils_hash sha256 deterministic', () => {
  const h1 = callTool('utils_hash', { data: 'hello', algo: 'sha256' }).hexdigest;
  const h2 = callTool('utils_hash', { data: 'hello', algo: 'sha256' }).hexdigest;
  assert.strictEqual(h1, h2);
});

test('utils_hash sha512 length', () => {
  const { hexdigest } = callTool('utils_hash', { data: 'hello', algo: 'sha512' });
  assert.strictEqual(hexdigest.length, 128);
});

test('utils_timing_safe_eq', () => {
  const a = crypto.randomBytes(16).toString('hex');
  const { equal: yes } = callTool('utils_timing_safe_eq', { a, b: a });
  assert.ok(yes);
  const { equal: no } = callTool('utils_timing_safe_eq', { a, b: crypto.randomBytes(16).toString('hex') });
  assert.ok(!no);
});

test('keystore_list shows stored keys', () => {
  const { keys } = callTool('keystore_list', {});
  assert.ok(keys.some(k => k.id === 'k1'));
});

test('keystore_rotate_key changes key', () => {
  const { newKeyHex } = callTool('keystore_rotate_key', { keyId: 'k1' });
  assert.strictEqual(newKeyHex.length, 64);
});

test('keystore_delete removes key', () => {
  callTool('aes_gcm_generate_key', { keyId: 'del-me' });
  callTool('keystore_delete', { keyId: 'del-me' });
  const { keys } = callTool('keystore_list', {});
  assert.ok(!keys.some(k => k.id === 'del-me'));
});

test('missing param throws descriptive error', () => {
  assert.throws(
    () => callTool('aes_gcm_encrypt', { keyId: 'k2' }),
    /Missing required parameter: plaintext/
  );
});

test('unknown tool throws', () => {
  assert.throws(() => callTool('nonexistent_tool', {}), /Unknown tool/);
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. Audit log
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── Audit Log ──');

test('appends entries with hash chain', () => {
  audit('test.a', { x: 1 });
  audit('test.b', { x: 2 });
  const all = readAll();
  assert.ok(all.length >= 2);
  assert.ok(all[all.length - 1].hash.length === 64);
});

test('verify passes on clean log', () => {
  const { ok } = verify();
  assert.ok(ok);
});

test('verify catches tampered entry', () => {
  const lines = fs.readFileSync(process.env.CRYPTO_BOT_AUDIT_FILE, 'utf8').split('\n').filter(Boolean);
  const first = JSON.parse(lines[0]);
  first.data  = { hacked: true };
  lines[0]    = JSON.stringify(first);
  fs.writeFileSync(process.env.CRYPTO_BOT_AUDIT_FILE, lines.join('\n') + '\n');
  const { ok } = verify();
  assert.ok(!ok);
});

test('audit_verify tool works', () => {
  // Fresh audit file
  fs.writeFileSync(process.env.CRYPTO_BOT_AUDIT_FILE, '');
  // Re-init by writing a new entry
  const { verify: v2, readAll: r2 } = (() => {
    // Reset module cache for audit so seq resets
    delete require.cache[require.resolve('../core/audit')];
    return require('../core/audit');
  })();
  v2(); // just check it doesn't throw
});

test('audit_recent tool returns entries', () => {
  const r = callTool('audit_recent', { n: 5 });
  assert.ok(r.ok);
  assert.ok(Array.isArray(r.entries));
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. Memory
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── Memory ──');

test('append + recent', () => {
  memory.append('user', 'remember this xq9z', { goalId: 'g1', tags: ['test'] });
  const r = memory.recent(10);
  assert.ok(r.some(m => m.content.includes('xq9z')));
});

test('search finds by content', () => {
  memory.append('assistant', 'unique-zz77-result', {});
  const r = memory.search('unique-zz77');
  assert.ok(r.length > 0);
});

test('summarize returns role counts', () => {
  const s = memory.summarize();
  assert.ok(s.total > 0);
  assert.ok(typeof s.byRole === 'object');
});

test('buildContext returns string with header', () => {
  const ctx = memory.buildContext(5);
  assert.ok(ctx.includes('Recent conversation'));
});

test('memory_search tool', () => {
  const r = callTool('memory_search', { query: 'xq9z', limit: 5 });
  assert.ok(r.ok);
  assert.ok(r.results.length > 0);
});

test('memory_summary tool', () => {
  const r = callTool('memory_summary', {});
  assert.ok(r.ok);
  assert.ok(r.total > 0);
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. Session persistence
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── Session ──');

test('save + load round-trips key material', () => {
  const store = new SecureKeyStore();
  const raw   = crypto.randomBytes(32);
  store.store('persist-k', raw, { purpose: 'test' });

  session.save(store);
  assert.ok(session.exists());

  const loaded = session.load();
  assert.ok(loaded !== null);
  assert.deepStrictEqual(loaded.store.retrieve('persist-k'), raw);
});

test('clear removes session file', () => {
  session.clear();
  assert.ok(!session.exists());
});

test('load returns null with no session', () => {
  assert.strictEqual(session.load(), null);
});

test('wrong passphrase throws on load', () => {
  const store = new SecureKeyStore();
  store.store('x', crypto.randomBytes(32));
  session.save(store);

  const origPass = process.env.CRYPTO_BOT_PASSPHRASE;
  process.env.CRYPTO_BOT_PASSPHRASE = 'wrong-pw';
  // Must reload config + session with new passphrase
  delete require.cache[require.resolve('../config/config')];
  delete require.cache[require.resolve('../core/session')];
  const sess2 = require('../core/session');
  assert.throws(() => sess2.load(), /corrupted|passphrase|wrong/i);
  process.env.CRYPTO_BOT_PASSPHRASE = origPass;
  // Restore
  delete require.cache[require.resolve('../config/config')];
  delete require.cache[require.resolve('../core/session')];
  session.clear();
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. Retry
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── Retry ──');

testA('withRetry succeeds on 2nd attempt', async () => {
  let n = 0;
  const r = await withRetry(async () => {
    if (++n < 2) throw new Error('HTTP 500: temporary');
    return 'ok';
  }, { max: 3, baseMs: 5 });
  assert.strictEqual(r, 'ok');
  assert.strictEqual(n, 2);
});

testA('withRetry exhausts max attempts', async () => {
  let n = 0;
  await assert.rejects(async () =>
    withRetry(async () => { n++; throw new Error('HTTP 500: always'); }, { max: 3, baseMs: 5 })
  );
  assert.strictEqual(n, 3);
});

testA('withRetry does not retry 401', async () => {
  let n = 0;
  await assert.rejects(async () =>
    withRetry(async () => { n++; throw new Error('HTTP 401: unauthorized'); }, { max: 5, baseMs: 5 })
  );
  assert.strictEqual(n, 1);
});

test('classify rate_limit is retryable', () => {
  const { class: c, retryable } = classify(new Error('HTTP 429'));
  assert.strictEqual(c, ERROR_CLASSES.RATE_LIMIT);
  assert.ok(retryable);
});

test('classify bad_json is retryable', () => {
  const { class: c, retryable } = classify(new Error('non-JSON garbage'));
  assert.strictEqual(c, ERROR_CLASSES.BAD_JSON);
  assert.ok(retryable);
});

test('classify 401 is not retryable', () => {
  const { retryable } = classify(new Error('HTTP 401'));
  assert.ok(!retryable);
});

test('classify 403 is not retryable', () => {
  const { retryable } = classify(new Error('HTTP 403'));
  assert.ok(!retryable);
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. Scheduler
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── Scheduler ──');

test('addTask + listTasks', () => {
  const t = scheduler.addTask({ name: 't1', goal: 'do x', intervalMs: 60000 });
  assert.ok(scheduler.listTasks().some(x => x.id === t.id));
});

test('setEnabled disables task', () => {
  const t = scheduler.addTask({ name: 't2', goal: 'y', intervalMs: 60000 });
  scheduler.setEnabled(t.id, false);
  assert.ok(!scheduler.listTasks().find(x => x.id === t.id).enabled);
});

test('removeTask deletes it', () => {
  const t = scheduler.addTask({ name: 't3', goal: 'z', intervalMs: 60000 });
  scheduler.removeTask(t.id);
  assert.ok(!scheduler.listTasks().some(x => x.id === t.id));
});

testA('tick runs overdue enabled task', async () => {
  let ran = false;
  scheduler.start(async () => { ran = true; return { answer: 'done' }; });

  const t = scheduler.addTask({ name: 'overdue', goal: 'g', intervalMs: 999999, maxRuns: 1, delayMs: 0 });
  // Force past due
  scheduler.listTasks().find(x => x.id === t.id).nextRunAt = Date.now() - 1;

  await scheduler.tick();
  scheduler.stop();
  assert.ok(ran);
});

test('scheduler_add tool', () => {
  const r = callTool('scheduler_add', { name: 'tool-task', goal: 'hash', intervalMs: 3600000, maxRuns: 1 });
  assert.ok(r.ok);
  assert.ok(r.taskId);
});

test('scheduler_list tool', () => {
  const r = callTool('scheduler_list', {});
  assert.ok(r.ok);
  assert.ok(Array.isArray(r.tasks));
});

test('scheduler_remove tool', () => {
  const { taskId } = callTool('scheduler_add', { name: 'rm-task', goal: 'x', intervalMs: 1000 });
  const r = callTool('scheduler_remove', { taskId });
  assert.ok(r.ok);
  assert.ok(!callTool('scheduler_list', {}).tasks.some(t => t.id === taskId));
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. File tools
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n── File Tools ──');

const TF     = path.join(TMP, 'sample.txt');
const TF_ENC = TF + '.cbot';
const TF_DEC = path.join(TMP, 'sample.decrypted');

test('file_write_text + file_read_text', () => {
  callTool('file_write_text', { filePath: TF, content: 'file content here' });
  const { content } = callTool('file_read_text', { filePath: TF });
  assert.strictEqual(content, 'file content here');
});

test('file_hash sha256 consistent', () => {
  const h1 = callTool('file_hash', { filePath: TF, algo: 'sha256' }).hexdigest;
  const h2 = callTool('file_hash', { filePath: TF, algo: 'sha256' }).hexdigest;
  assert.strictEqual(h1, h2);
  assert.strictEqual(h1.length, 64);
});

test('file_hash sha512 length', () => {
  const { hexdigest } = callTool('file_hash', { filePath: TF, algo: 'sha512' });
  assert.strictEqual(hexdigest.length, 128);
});

test('file_encrypt + file_decrypt (passphrase) round-trip', () => {
  callTool('file_encrypt', { srcPath: TF, passphrase: 'filepw', outPath: TF_ENC });
  assert.ok(fs.existsSync(TF_ENC));
  callTool('file_decrypt', { srcPath: TF_ENC, passphrase: 'filepw', outPath: TF_DEC });
  assert.strictEqual(fs.readFileSync(TF_DEC, 'utf8'), 'file content here');
});

test('file_decrypt wrong passphrase throws', () => {
  assert.throws(() => callTool('file_decrypt', { srcPath: TF_ENC, passphrase: 'badpw', outPath: TF_DEC + '2' }));
});

test('file_encrypt + file_decrypt (keyId) round-trip', () => {
  callTool('aes_gcm_generate_key', { keyId: 'fkey' });
  const encOut = TF + '.keyid.cbot';
  const decOut = TF + '.keyid.dec';
  callTool('file_encrypt', { srcPath: TF, keyId: 'fkey', outPath: encOut });
  callTool('file_decrypt', { srcPath: encOut, keyId: 'fkey', outPath: decOut });
  assert.strictEqual(fs.readFileSync(decOut, 'utf8'), 'file content here');
});

test('file_hmac_sign + file_hmac_verify', () => {
  callTool('aes_gcm_generate_key', { keyId: 'fmac' });
  const { macHex } = callTool('file_hmac_sign',   { filePath: TF, keyId: 'fmac' });
  const { valid  } = callTool('file_hmac_verify', { filePath: TF, keyId: 'fmac', macHex });
  assert.ok(valid);
});

test('file_hmac_verify detects modified file', () => {
  callTool('aes_gcm_generate_key', { keyId: 'fmac2' });
  const { macHex } = callTool('file_hmac_sign', { filePath: TF, keyId: 'fmac2' });
  fs.appendFileSync(TF, ' TAMPERED');
  const { valid } = callTool('file_hmac_verify', { filePath: TF, keyId: 'fmac2', macHex });
  assert.ok(!valid);
});

test('file_list returns files', () => {
  const { files } = callTool('file_list', { dirPath: TMP });
  assert.ok(files.some(f => f.name === 'sample.txt'));
});

test('file_list filters by extension', () => {
  const { files } = callTool('file_list', { dirPath: TMP, extension: '.cbot' });
  assert.ok(files.every(f => f.name.endsWith('.cbot')));
  assert.ok(files.length > 0);
});

test('file_read_text rejects file > 64KB', () => {
  const bigFile = path.join(TMP, 'big.txt');
  fs.writeFileSync(bigFile, 'x'.repeat(70000));
  assert.throws(() => callTool('file_read_text', { filePath: bigFile }), /too large/);
});

// ══════════════════════════════════════════════════════════════════════════════
// Run all + summary
// ══════════════════════════════════════════════════════════════════════════════

runAll().then(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  const total = passed + failed;
  console.log(`\n${'─'.repeat(52)}`);
  console.log(`  ${total} tests — ${passed} passed, ${failed} failed`);
  console.log(`${'─'.repeat(52)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}).catch(err => {
  console.error('Test runner crashed:', err.message);
  process.exit(1);
});
