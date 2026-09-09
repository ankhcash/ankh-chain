#!/usr/bin/env node
/**
 * generate-foundation-keys.js
 *
 * Generates secp256k1 keypairs for Ankh Foundation council members.
 *
 * Usage:
 *   node scripts/generate-foundation-keys.js [count] [threshold]
 *
 * Examples:
 *   node scripts/generate-foundation-keys.js          # 3 members, threshold 2
 *   node scripts/generate-foundation-keys.js 5 3      # 5 members, threshold 3
 *
 * OUTPUT
 * ------
 * 1. Prints each member's PRIVATE key to stdout (save these securely, one per person).
 * 2. Writes data/foundation_council.json with public keys only (safe to commit).
 *
 * SECURITY NOTE
 * -------------
 * This script prints private keys in plain text. Run it on an air-gapped machine
 * or in a secure terminal session. Each Foundation member should receive only their
 * own private key and store it in a hardware wallet or encrypted key store.
 * Never share private keys or commit them to version control.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { ec: EC } = require('elliptic');

const ec = new EC('secp256k1');

// ── Args ──────────────────────────────────────────────────────────────────────
const count     = parseInt(process.argv[2]) || 3;
const threshold = parseInt(process.argv[3]) || Math.ceil(count * 2 / 3); // default 2-of-3

if (count < 1 || threshold < 1 || threshold > count) {
  console.error(`Usage: node generate-foundation-keys.js [count] [threshold]`);
  console.error(`  count must be >= 1, threshold must be between 1 and count`);
  process.exit(1);
}

// ── Generate ──────────────────────────────────────────────────────────────────
console.log('');
console.log('╔══════════════════════════════════════════════════════════════════╗');
console.log('║          ANKH FOUNDATION COUNCIL KEY GENERATION                  ║');
console.log('╚══════════════════════════════════════════════════════════════════╝');
console.log('');
console.log(`  Generating ${count} keypairs with ${threshold}-of-${count} threshold`);
console.log('');
console.log('  ⚠  SAVE EACH PRIVATE KEY SECURELY — IT CANNOT BE RECOVERED  ⚠');
console.log('');

const members = [];

for (let i = 1; i <= count; i++) {
  const keyPair    = ec.genKeyPair();
  const privateKey = keyPair.getPrivate('hex');
  const publicKey  = keyPair.getPublic('hex');
  const address    = 'ankh_' + crypto
    .createHash('sha256')
    .update(Buffer.from(publicKey, 'hex'))
    .digest('hex')
    .substring(0, 40);

  const name = `Ankh Foundation Member ${i}`;

  console.log(`  ── Member ${i}: ${name} ──────────────────────────────────`);
  console.log(`  Address:     ${address}`);
  console.log(`  Public Key:  ${publicKey}`);
  console.log(`  Private Key: ${privateKey}   ← KEEP SECRET`);
  console.log('');

  members.push({ name, publicKey, address });
}

// ── Write public council file ─────────────────────────────────────────────────
const dataDir      = path.join(__dirname, '..', 'data');
const councilPath  = path.join(dataDir, 'foundation_council.json');

fs.mkdirSync(dataDir, { recursive: true });

const existing = fs.existsSync(councilPath)
  ? JSON.parse(fs.readFileSync(councilPath, 'utf8'))
  : null;

if (existing && Array.isArray(existing.members) && existing.members.length > 0) {
  const backup = councilPath.replace('.json', `_backup_${Date.now()}.json`);
  fs.copyFileSync(councilPath, backup);
  console.log(`  Existing council backed up to: ${path.basename(backup)}`);
}

const council = {
  _comment: "Ankh Foundation Council — governs SOVEREIGN sidechain approvals. Contains PUBLIC keys only.",
  threshold,
  members
};

fs.writeFileSync(councilPath, JSON.stringify(council, null, 2));

console.log(`  ✓ data/foundation_council.json written (${members.length} members, threshold ${threshold})`);
console.log('');
console.log('  NEXT STEPS:');
console.log('  1. Send each member their private key through a secure channel.');
console.log('  2. Each member stores their key in a hardware wallet or encrypted vault.');
console.log('  3. Restart the ankh_chain node to load the new council.');
console.log(`  4. To approve a SOVEREIGN proposal, ${threshold} member(s) must each call:`);
console.log('       POST /api/v1/sidechains/proposals/:proposalId/approve');
console.log('       { timestamp, signature: { publicKey, r, s } }');
console.log('');
console.log('  See scripts/approve-proposal.js for a signing helper.');
console.log('');
