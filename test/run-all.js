/**
 * Test runner.
 *
 * `npm test` previously invoked jest against a repository with no test files,
 * which exits non-zero and tells a reader nothing. These suites run the real
 * modules — no mocks — and assert on security properties an auditor would want
 * to confirm independently:
 *
 *   security.test.js          the five findings from the external audit
 *   integration.test.js       verification pipeline, state persistence, save races
 *   descriptor-index.test.js  duplicate search is exact vs brute force
 *   sidechain.test.js         self-serve chain creation and its limits
 */
const { execFileSync } = require('child_process');
const path = require('path');
const { assertSafeToRun } = require('./guard');

// Stop before allocating anything if this is a live node.
assertSafeToRun();

// descriptor-index is a benchmark: it builds 200k descriptors and is the piece
// that can exhaust a small machine. It runs under `npm run bench`, not here.
const suites = ['security.test.js', 'integration.test.js', 'sidechain.test.js'];
let failed = 0;

for (const suite of suites) {
  process.stdout.write(`\n──── ${suite} ${'─'.repeat(Math.max(0, 46 - suite.length))}\n`);
  try {
    execFileSync(process.execPath, ['--max-old-space-size=6144', path.join(__dirname, suite)], {
      stdio: 'inherit',
      env: { ...process.env, ANKH_COMMIT_DESCRIPTORS: '1' }
    });
  } catch {
    failed++;
    console.error(`\n${suite} FAILED`);
  }
}

console.log(failed === 0 ? '\nAll suites passed.' : `\n${failed} suite(s) failed.`);
process.exit(failed ? 1 : 0);
