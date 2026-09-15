#!/usr/bin/env node
/**
 * register-node.js
 *
 * Registers this node as a trusted operator on the main chain. A registered
 * node can sign biometric registration proofs, submit sidechain anchors, and
 * qualifies as a SOVEREIGN sidechain creator without separate biometric
 * verification.
 *
 * Run this AFTER starting the node at least once — the keypair it signs with
 * is created on first boot at data/node_identity.json.
 *
 * Usage:
 *   node scripts/register-node.js
 *   ANKH_NODE_URL=https://api.ankh.cash node scripts/register-node.js
 *
 * Environment:
 *   ANKH_NODE_URL   Main-chain node to submit to (default https://api.ankh.cash)
 *
 * This script previously lived only in the README, where it opened with
 * `require('dotenv').config()`. dotenv is not a dependency of this project, so
 * the documented version failed with MODULE_NOT_FOUND before doing anything.
 * Configuration comes from the environment here, which needs no package.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const Transaction = require('../src/core/Transaction');

const IDENTITY_FILE = path.join(__dirname, '..', 'data', 'node_identity.json');
const ANKH_NODE_URL = (process.env.ANKH_NODE_URL || 'https://api.ankh.cash').replace(/\/$/, '');

async function main() {
  if (!fs.existsSync(IDENTITY_FILE)) {
    console.error(`No node identity at ${IDENTITY_FILE}`);
    console.error('');
    console.error('The identity keypair is generated the first time the node boots.');
    console.error('Start the node once, wait for it to finish syncing, then re-run this:');
    console.error('');
    console.error('    npm start');
    console.error('');
    process.exit(1);
  }

  const ident = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
  console.log(`Node address : ${ident.address}`);
  console.log(`Main chain   : ${ANKH_NODE_URL}`);

  // Already registered? Registering twice is not harmful, but telling the
  // operator plainly is better than a second transaction that looks like it
  // did something.
  const nodesRes = await fetch(`${ANKH_NODE_URL}/api/v1/nodes`).then(r => r.json()).catch(() => null);
  const already = nodesRes?.data?.some(n => n.address === ident.address);
  if (already) {
    console.log('');
    console.log('This node is already registered. Nothing to do.');
    return;
  }

  const acctRes = await fetch(`${ANKH_NODE_URL}/api/v1/accounts/${ident.address}`).then(r => r.json());
  const nonce = acctRes.data?.nonce ?? 0;

  const tx = new Transaction({
    type:      'NODE_REGISTER',
    from:      ident.address,
    to:        'node_registry',
    value:     0n,
    fee:       0n,
    nonce,
    data:      { publicKey: ident.publicKey },
    timestamp: Date.now()
  });
  tx.sign(ident.privateKey);

  const res = await fetch(`${ANKH_NODE_URL}/api/v1/transactions`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(tx)
  });
  const body = await res.json();

  if (!res.ok || body.success === false) {
    console.error('');
    console.error('Registration rejected:', body.error || `HTTP ${res.status}`);
    process.exit(1);
  }

  console.log('');
  console.log('Submitted. Transaction hash:', body.data?.hash || tx.hash);
  console.log('');
  console.log('Confirm once it is mined (a few seconds):');
  console.log(`    curl ${ANKH_NODE_URL}/api/v1/nodes`);
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
