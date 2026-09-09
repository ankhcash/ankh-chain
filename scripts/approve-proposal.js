#!/usr/bin/env node
/**
 * approve-proposal.js
 *
 * Signs and submits a Foundation council approval for a sidechain proposal.
 *
 * Usage:
 *   FOUNDATION_PRIVATE_KEY=<hex> node scripts/approve-proposal.js <proposalId> [apiUrl]
 *
 * Examples:
 *   FOUNDATION_PRIVATE_KEY=abc123... node scripts/approve-proposal.js 9a0a4658-...
 *   FOUNDATION_PRIVATE_KEY=abc123... node scripts/approve-proposal.js 9a0a4658-... https://api.ankh.cash
 */

'use strict';

const crypto = require('crypto');
const https  = require('https');
const http   = require('http');
const { ec: EC } = require('elliptic');

const ec = new EC('secp256k1');

// ── Args ──────────────────────────────────────────────────────────────────────
const proposalId     = process.argv[2];
const apiUrl         = (process.argv[3] || 'http://localhost:3001').replace(/\/$/, '');
const privateKeyHex  = process.env.FOUNDATION_PRIVATE_KEY;

if (!proposalId) {
  console.error('Usage: FOUNDATION_PRIVATE_KEY=<hex> node approve-proposal.js <proposalId> [apiUrl]');
  process.exit(1);
}
if (!privateKeyHex) {
  console.error('Error: FOUNDATION_PRIVATE_KEY environment variable is required');
  process.exit(1);
}

// ── Sign ──────────────────────────────────────────────────────────────────────
let keyPair;
try {
  keyPair = ec.keyFromPrivate(privateKeyHex, 'hex');
} catch (err) {
  console.error('Invalid private key:', err.message);
  process.exit(1);
}

const publicKey = keyPair.getPublic('hex');
const address   = 'ankh_' + crypto
  .createHash('sha256')
  .update(Buffer.from(publicKey, 'hex'))
  .digest('hex')
  .substring(0, 40);

const timestamp = Date.now();
const message   = JSON.stringify({ action: 'APPROVE_SIDECHAIN', proposalId, timestamp });
const msgHash   = crypto.createHash('sha256').update(message).digest();
const sig       = keyPair.sign(msgHash);

const body = JSON.stringify({
  timestamp,
  signature: {
    publicKey,
    r: sig.r.toString('hex'),
    s: sig.s.toString('hex')
  }
});

console.log('');
console.log('Submitting Foundation council approval...');
console.log(`  Proposal: ${proposalId}`);
console.log(`  Signer:   ${address}`);
console.log(`  API:      ${apiUrl}`);
console.log('');

// ── POST ──────────────────────────────────────────────────────────────────────
const endpoint = `/api/v1/sidechains/proposals/${proposalId}/approve`;
const parsed   = new URL(apiUrl + endpoint);
const lib      = parsed.protocol === 'https:' ? https : http;

const req = lib.request(
  {
    hostname: parsed.hostname,
    port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path:     parsed.pathname,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  },
  (res) => {
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(data); } catch { parsed = { raw: data }; }

      if (parsed.success) {
        if (parsed.data?.status === 'APPROVED') {
          console.log('✓ Proposal APPROVED — sidechain is now active!');
          console.log(`  Chain ID: ${parsed.data.sidechain?.chainId}`);
        } else {
          const d = parsed.data;
          console.log(`✓ Vote recorded (${d.foundationApprovals || 1} / ${d.required || '?'} required)`);
          console.log('  Waiting for additional Foundation member approvals...');
        }
      } else {
        console.error('✗ Approval failed:', parsed.error || data);
        process.exit(1);
      }
    });
  }
);

req.on('error', (err) => {
  console.error('Request failed:', err.message);
  process.exit(1);
});

req.write(body);
req.end();
