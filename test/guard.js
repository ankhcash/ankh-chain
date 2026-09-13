/**
 * Refuse to run the test suite against a live node.
 *
 * The suites build large synthetic datasets — the descriptor benchmark alone
 * allocates 200,000 embeddings plus WASM inference models. Run on a production
 * node with limited memory, that is enough to exhaust the box: during
 * development it took a live server off the network entirely, to the point that
 * sshd could no longer fork a session.
 *
 * Tests are for a workstation or CI. A node operator should be able to type
 * `npm test` on the wrong machine and be stopped rather than taken offline.
 */
const fs = require('fs');
const path = require('path');

function chainDataDir() {
  return process.env.DATA_DIR || path.join(__dirname, '..', 'data');
}

/** Does this look like a node carrying real chain state? */
function looksLive() {
  const dir = chainDataDir();
  if (!fs.existsSync(dir)) return false;

  // A populated sharded state directory, or a chain file of meaningful size,
  // means this is not a scratch checkout.
  const stateDir = path.join(dir, 'state', 'verified_users');
  if (fs.existsSync(stateDir) && fs.readdirSync(stateDir).length > 0) return true;

  const chainFile = path.join(dir, 'chain.json');
  if (fs.existsSync(chainFile) && fs.statSync(chainFile).size > 10 * 1024 * 1024) return true;

  return false;
}

function assertSafeToRun() {
  if (process.env.ANKH_TEST_ALLOW_LIVE === '1') {
    console.warn('[test] ANKH_TEST_ALLOW_LIVE=1 — running against live chain data at the operator\'s risk.\n');
    return;
  }
  if (!looksLive()) return;

  console.error(`
  Refusing to run: this looks like a live node.

  Chain state was found at ${chainDataDir()}

  These suites allocate hundreds of megabytes of synthetic data and load ML
  models. On a production node that can exhaust memory and take the service
  offline — it has done exactly that once.

  Run them on a workstation or in CI instead. To verify a build on this machine,
  use a scratch data directory:

      DATA_DIR=/tmp/ankh-test npm test

  To override deliberately (not recommended on a small instance):

      ANKH_TEST_ALLOW_LIVE=1 npm test
`);
  process.exit(1);
}

module.exports = { assertSafeToRun, looksLive, chainDataDir };
