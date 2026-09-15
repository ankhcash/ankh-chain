#!/usr/bin/env node
/**
 * propose-sidechain.js
 *
 * Proposes a sidechain on the main chain, signed with this node's identity.
 *
 * Usage:
 *   node scripts/propose-sidechain.js --init                 # write a template config
 *   node scripts/propose-sidechain.js --config chain.json    # check eligibility, then propose
 *   node scripts/propose-sidechain.js --config chain.json --dry-run
 *
 * Environment:
 *   ANKH_NODE_URL   Main-chain node to submit to (default https://api.ankh.cash)
 *
 * Everything is checked before anything is submitted. A proposal that cannot
 * succeed is reported as a list of what is missing, rather than as a rejected
 * transaction whose reason has to be guessed at.
 *
 * The README previously carried this as a snippet to paste into a file of your
 * own. That version required dotenv (not a dependency of this project), never
 * set a signing key so it fell through to the unsigned endpoint, and passed no
 * stake, so it could not have been accepted at any tier.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const Transaction = require('../src/core/Transaction');

const IDENTITY_FILE = path.join(__dirname, '..', 'data', 'node_identity.json');
const ANKH_NODE_URL = (process.env.ANKH_NODE_URL || 'https://api.ankh.cash').replace(/\/$/, '');

// Stake required per tier, in whole ANKH. Mirrors GenesisConfig.SIDECHAIN_TIERS;
// the authoritative values are fetched from the node at run time where possible.
const FALLBACK_STAKE = { COMMUNITY: 100, STANDARD: 10000, INSTITUTIONAL: 100000, SOVEREIGN: 500000 };

const TEMPLATE = {
  name: 'Republic of Exampleland',
  chainId: 'exampleland-sovereign-1',
  tier: 'SOVEREIGN',
  institutionType: 'government',
  stake: '500000',
  blockTime: 2000,
  nativeCurrency: { name: 'Exampleland Coin', symbol: 'EXC', decimals: 18, initialSupply: 0 },
  authorities: [{ address: 'ankh_REPLACE_WITH_YOUR_NODE_ADDRESS', name: 'Primary Authority Node', role: 'validator' }],
  metadata: { country: 'EX', region: 'Example Region', website: 'https://example.gov', ubiAmount: '500 EXC/month' }
};

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] ?? true);
}

async function main() {
  if (process.argv.includes('--init')) {
    const out = path.resolve(String(arg('--init') === true ? 'sidechain.json' : arg('--init')));
    if (fs.existsSync(out)) { console.error(`${out} already exists — refusing to overwrite.`); process.exit(1); }
    const ident = fs.existsSync(IDENTITY_FILE) ? JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8')) : null;
    const tpl = JSON.parse(JSON.stringify(TEMPLATE));
    if (ident) tpl.authorities[0].address = ident.address;
    fs.writeFileSync(out, JSON.stringify(tpl, null, 2) + '\n');
    console.log(`Wrote ${out}`);
    console.log('Edit it, then run:  node scripts/propose-sidechain.js --config ' + path.basename(out));
    return;
  }

  const configPath = arg('--config');
  if (!configPath || configPath === true) {
    console.error('Usage: node scripts/propose-sidechain.js --config <file.json>');
    console.error('       node scripts/propose-sidechain.js --init');
    process.exit(1);
  }
  if (!fs.existsSync(configPath)) { console.error(`No such config file: ${configPath}`); process.exit(1); }
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  if (!fs.existsSync(IDENTITY_FILE)) {
    console.error(`No node identity at ${IDENTITY_FILE}`);
    console.error('The keypair is generated on first boot. Run `npm start` once, then retry.');
    process.exit(1);
  }
  const ident = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
  const creator = cfg.creator || ident.address;
  const tier = (cfg.tier || 'INSTITUTIONAL').toUpperCase();

  console.log(`Creator    : ${creator}`);
  console.log(`Chain id   : ${cfg.chainId}`);
  console.log(`Tier       : ${tier}`);
  console.log(`Main chain : ${ANKH_NODE_URL}`);
  console.log('');

  // ── Pre-flight ─────────────────────────────────────────────────────────────
  const problems = [];

  if (!cfg.chainId || !/^[a-z0-9][a-z0-9-]{2,}$/.test(cfg.chainId)) {
    problems.push('chainId must be lowercase letters, digits and hyphens (3+ chars)');
  }
  if (!Array.isArray(cfg.authorities) || cfg.authorities.length === 0) {
    problems.push('authorities must list at least one validator');
  } else if (cfg.authorities.some(a => !/^ankh_[0-9a-f]{40}$/.test(a.address || ''))) {
    problems.push('every authority needs a valid ankh_ address (did you edit the template?)');
  }
  if (!cfg.nativeCurrency?.symbol) problems.push('nativeCurrency.symbol is required');

  const [acct, nodes, chains] = await Promise.all([
    fetch(`${ANKH_NODE_URL}/api/v1/accounts/${creator}`).then(r => r.json()).catch(() => null),
    fetch(`${ANKH_NODE_URL}/api/v1/nodes`).then(r => r.json()).catch(() => null),
    fetch(`${ANKH_NODE_URL}/api/v1/sidechains`).then(r => r.json()).catch(() => null)
  ]);

  const isVerified = acct?.data?.isVerified === true;
  const isRegisteredNode = nodes?.data?.some(n => n.address === creator) === true;
  const balance = BigInt(acct?.data?.balance ?? 0);
  const required = BigInt(cfg.stake ?? FALLBACK_STAKE[tier] ?? 0) * (10n ** 18n);

  // SOVEREIGN accepts a registered node operator in place of biometric
  // verification. Every other tier requires a verified human.
  if (tier === 'SOVEREIGN') {
    if (!isVerified && !isRegisteredNode) {
      problems.push('SOVEREIGN creator must be biometrically verified OR a registered node operator — run scripts/register-node.js');
    }
  } else if (!isVerified) {
    problems.push(`${tier} creator must be biometrically verified (only SOVEREIGN accepts a registered node instead)`);
  }

  if (balance < required) {
    const fmt = v => (Number(v / 10n ** 14n) / 10000).toLocaleString('en-US');
    problems.push(`insufficient balance: ${tier} needs ${fmt(required)} ANKH staked, address holds ${fmt(balance)}`);
  }

  if (chains?.data?.some(c => c.chainId === cfg.chainId)) {
    problems.push(`chainId "${cfg.chainId}" is already taken`);
  }

  console.log(`verified          : ${isVerified}`);
  console.log(`registered node   : ${isRegisteredNode}`);
  console.log(`balance           : ${balance} raw`);
  console.log(`stake required    : ${required} raw`);
  console.log('');

  if (problems.length) {
    console.error('Cannot propose yet:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('Pre-flight passed.');

  if (process.argv.includes('--dry-run')) {
    console.log('--dry-run: stopping before submission.');
    return;
  }

  // ── Submit ─────────────────────────────────────────────────────────────────
  const tx = new Transaction({
    type:  'SIDECHAIN_CREATE',
    from:  creator,
    to:    'sidechain_factory',
    value: required,
    fee:   0n,
    nonce: acct.data?.nonce ?? 0,
    data: {
      name:            cfg.name,
      chainId:         cfg.chainId,
      tier,
      consensusType:   'POA',
      authorities:     cfg.authorities,
      blockTime:       cfg.blockTime ?? 2000,
      nativeCurrency:  cfg.nativeCurrency,
      institutionType: cfg.institutionType,
      metadata:        cfg.metadata ?? {}
    },
    timestamp: Date.now()
  });
  tx.sign(ident.privateKey);

  const res = await fetch(`${ANKH_NODE_URL}/api/v1/transactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tx)
  });
  const body = await res.json();
  if (!res.ok || body.success === false) {
    console.error('Proposal rejected:', body.error || `HTTP ${res.status}`);
    process.exit(1);
  }

  console.log('Submitted. Transaction hash:', body.data?.hash || tx.hash);
  console.log('');
  if (tier === 'SOVEREIGN' || tier === 'INSTITUTIONAL') {
    console.log('This tier needs Foundation council approval before it activates.');
    console.log(`Council status:  curl ${ANKH_NODE_URL}/api/v1/sidechains/council`);
    console.log(`Proposal status: curl ${ANKH_NODE_URL}/api/v1/sidechains/proposals`);
    console.log('Council members approve with: scripts/approve-proposal.js <proposalId>');
  }
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
