#!/usr/bin/env node
'use strict';

/**
 * run-tests.js
 * Runs every __tests__/*.test.js file in each package sequentially.
 * No test framework needed — each test file uses Node's assert and exits
 * with code 0 on success, non-zero on failure.
 */

const { execFileSync } = require('child_process');
const path             = require('path');
const fs               = require('fs');

const packagesDir = path.join(__dirname, 'packages');
const packages    = fs.readdirSync(packagesDir).filter(d =>
  fs.statSync(path.join(packagesDir, d)).isDirectory()
);

// Build a resolver map so packages can find siblings without npm install
const resolverPreamble = `
const _origResolve = require('module')._resolveFilename.bind(require('module'));
const _pkgMap = {
${packages.map(p => `  '@crypto-monorepo/${p}': require('path').resolve(__dirname, '../../../packages/${p}/src/index.js'),`).join('\n')}
  '@crypto-monorepo/shared': require('path').resolve(__dirname, '../../../shared/logger.js'),
};
require('module')._resolveFilename = (req, ...args) => _pkgMap[req] || _origResolve(req, ...args);
`;

let passed = 0;
let failed = 0;

for (const pkg of packages) {
  const testDir = path.join(packagesDir, pkg, '__tests__');
  if (!fs.existsSync(testDir)) continue;

  const testFiles = fs.readdirSync(testDir).filter(f => f.endsWith('.test.js'));
  for (const file of testFiles) {
    const testPath = path.join(testDir, file);
    try {
      execFileSync(process.execPath, [testPath], {
        stdio: 'inherit',
        env: { ...process.env, NODE_PATH: path.join(__dirname, 'packages') },
      });
      passed++;
    } catch {
      console.error(`FAIL: ${pkg}/${file}`);
      failed++;
    }
  }
}

console.log(`\n${passed + failed} test files — ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
