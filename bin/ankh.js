#!/usr/bin/env node
/**
 * ankh — command line client for Ankh Chain.
 *
 * Deliberately zero-dependency: the SDK's whole point is that it needs nothing,
 * and a CLI that pulled in an argument parser would undo that for anyone who
 * installs the package. Argument handling here is small enough to own.
 *
 * Keys are never written in the clear. `ankh wallet new` prints the private key
 * once and stores an scrypt + AES-256-GCM keystore, both from node:crypto.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const AnkhSDK = require('../ankh-sdk.js');

const HOME = process.env.ANKH_HOME || path.join(os.homedir(), '.ankh');
const CONFIG_PATH = path.join(HOME, 'config.json');
const KEYSTORE_PATH = path.join(HOME, 'keystore.json');
const MAINNET = 'https://api.ankh.cash';

const USAGE = `
ankh — Ankh Chain command line client  (sdk ${AnkhSDK.VERSION})

Usage
  ankh <command> [args] [--node <url>]

Wallet
  wallet new                      Create a wallet; prints the private key once
  wallet import <privateKey>      Import and store an existing key
  wallet show                     Show the stored address
  wallet export                   Print the stored private key (asks first)

Chain
  balance [address]               ANKH balance (default: stored wallet)
  account [address]               Full account state
  info                            Chain id, height, validators
  stats                           Network statistics
  health                          Node health
  block [index|latest]            Block by index, or the latest

Money
  send <to> <amount>              Signed transfer
  stake <amount>                  Stake to become / back a validator
  unstake <amount>                Withdraw stake
  ubi status [address]            UBI eligibility and claim history
  ubi claim                       Claim this month's UBI

Tokens
  token list                      All tokens on the chain
  token info <symbol|address>     One token
  token tiers                     Tier thresholds
  token create --name <n> --symbol <s> [--supply <n>] [--stake <n>]
                                  Create an ARC-20 token

Network
  node register                   Register this wallet as a node operator
  sidechain list                  All sidechains
  council                         Foundation council and threshold
  watch [--events A,B]            Stream chain events until interrupted
  faucet [address]                Request dev funds (development chains only)

Config
  config show                     Current settings
  config set node <url>           Persist a default node URL

Options
  --node <url>    Node to talk to. Also ANKH_NODE_URL. Default ${MAINNET}
  --json          Raw JSON output, for scripting
  -h, --help      This message
  -v, --version   SDK and CLI versions

The private key can also come from ANKH_PRIVATE_KEY, which is what CI should use.
`;

// ── output ───────────────────────────────────────────────────────────────────
let asJson = false;
const out = (obj, human) => {
  if (asJson) console.log(JSON.stringify(obj, null, 2));
  else console.log(human !== undefined ? human : JSON.stringify(obj, null, 2));
};
const die = (msg, code = 1) => { console.error(`ankh: ${msg}`); process.exit(code); };

// ── config ───────────────────────────────────────────────────────────────────
const readJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
};
const writeJson = (p, obj) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), { mode: 0o600 });
};

// ── keystore ─────────────────────────────────────────────────────────────────
// scrypt-derived key, AES-256-GCM. The auth tag is what makes a wrong
// passphrase fail loudly instead of decrypting to garbage.
function encryptKey(privateKey, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
  return {
    version: 1,
    kdf: 'scrypt',
    params: { N: 16384, r: 8, p: 1 },
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ciphertext: ct.toString('hex')
  };
}

function decryptKey(store, passphrase) {
  const { N, r, p } = store.params || { N: 16384, r: 8, p: 1 };
  const key = crypto.scryptSync(passphrase, Buffer.from(store.salt, 'hex'), 32, { N, r, p });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(store.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(store.tag, 'hex'));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(store.ciphertext, 'hex')),
      decipher.final()
    ]).toString('utf8');
  } catch {
    die('wrong passphrase');
  }
}

function prompt(question, { hidden = false } = {}) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (!hidden) return rl.question(question, a => { rl.close(); resolve(a); });
    // Suppress echo for passphrase entry.
    const onData = char => {
      if (['\n', '\r', ''].includes(char.toString())) process.stdin.removeListener('data', onData);
      else process.stdout.write('\x1b[2K\x1b[200D' + question + '*'.repeat(rl.line.length));
    };
    process.stdin.on('data', onData);
    rl.question(question, a => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

async function loadPrivateKey() {
  if (process.env.ANKH_PRIVATE_KEY) return process.env.ANKH_PRIVATE_KEY.replace(/^0x/, '');
  const store = readJson(KEYSTORE_PATH, null);
  if (!store) die('no wallet. Run `ankh wallet new` or set ANKH_PRIVATE_KEY.');
  const pass = await prompt('passphrase: ', { hidden: true });
  return decryptKey(store, pass);
}

async function storePrivateKey(privateKey, address) {
  const pass = await prompt('choose a passphrase: ', { hidden: true });
  const again = await prompt('confirm passphrase: ', { hidden: true });
  if (pass !== again) die('passphrases do not match');
  if (!pass) die('passphrase cannot be empty');
  writeJson(KEYSTORE_PATH, { address, ...encryptKey(privateKey, pass) });
}

// ── args ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { asJson = true; continue; }
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) flags[name] = true;
      else { flags[name] = v; i++; }
      continue;
    }
    positional.push(a);
  }
  return { positional, flags };
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') { process.stdout.write(USAGE); return; }
  if (argv[0] === '-v' || argv[0] === '--version') {
    console.log(`ankh cli ${require('../package.json').version}  (sdk ${AnkhSDK.VERSION}, node ${process.version})`);
    return;
  }

  const { positional, flags } = parseArgs(argv);
  const cfg = readJson(CONFIG_PATH, {});
  const nodeUrl = flags.node || process.env.ANKH_NODE_URL || cfg.node || MAINNET;
  const sdk = new AnkhSDK({ nodeUrl });
  const stored = readJson(KEYSTORE_PATH, null);

  const [cmd, sub, ...rest] = positional;

  // Only these commands take a second word as part of the command name. For the
  // rest the second word is an argument (`block latest`, `balance ankh_…`), so
  // folding it into the dispatch key would make every argument look like an
  // unknown command.
  const GROUPED = new Set(['wallet', 'ubi', 'token', 'node', 'sidechain', 'config']);
  const key = GROUPED.has(cmd) ? `${cmd} ${sub || ''}`.trim() : cmd;
  const addrArg = a => a || stored?.address || die('no address given and no wallet stored');

  // Returns the signing address after arming the SDK with the key. The address
  // is derived from the key rather than read from the keystore when there is no
  // keystore, so ANKH_PRIVATE_KEY alone is enough — that is the whole point of
  // the CI path, and requiring a keystore too would defeat it.
  const signed = async () => {
    const priv = await loadPrivateKey();
    sdk.setPrivateKey(priv);
    if (stored?.address) return stored.address;
    return (await AnkhSDK.walletFromPrivateKey(priv)).address;
  };

  try {
    switch (key) {

      case 'wallet new': {
        const w = await AnkhSDK.createWallet();
        await storePrivateKey(w.privateKey, w.address);
        console.log(`\n  address      ${w.address}`);
        console.log(`  private key  ${w.privateKey}`);
        console.log('\n  This is the only time the private key is shown. Copy it somewhere safe.');
        console.log(`  Encrypted keystore written to ${KEYSTORE_PATH}\n`);
        break;
      }

      case 'wallet import': {
        if (!rest[0]) die('usage: ankh wallet import <privateKey>');
        const w = await AnkhSDK.walletFromPrivateKey(rest[0]);
        await storePrivateKey(w.privateKey, w.address);
        out(w, `imported ${w.address}`);
        break;
      }

      case 'wallet show':
        if (!stored) die('no wallet stored');
        out({ address: stored.address }, stored.address);
        break;

      case 'wallet export': {
        if (!stored) die('no wallet stored');
        const yes = await prompt('This prints your private key in the clear. Continue? [y/N] ');
        if (!/^y(es)?$/i.test(yes.trim())) return;
        console.log(await loadPrivateKey());
        break;
      }

      case 'balance': {
        const b = await sdk.getBalance(addrArg(sub));
        out(b, b.formatted);
        break;
      }

      case 'account':
        out(await sdk.getAccount(addrArg(sub)));
        break;

      case 'info': {
        const i = await sdk.getChainInfo();
        out(i, `${i.chainId}  height ${i.height}  validators ${i.activeValidators}`);
        break;
      }

      case 'stats':  out(await sdk.getStats()); break;
      case 'health': out(await sdk.getHealth()); break;

      case 'block': {
        const b = (!sub || sub === 'latest') ? await sdk.getLatestBlock() : await sdk.getBlock(Number(sub));
        out(b, `#${b.index}  ${b.hash}\n  ${b.transactions?.length ?? 0} tx  validator ${b.validator}`);
        break;
      }

      case 'send': {
        if (!sub || !rest[0]) die('usage: ankh send <to> <amount>');
        const from = await signed();
        out(await sdk.send(from, sub, rest[0]), `sent ${rest[0]} ANKH to ${sub}`);
        break;
      }

      case 'stake': {
        if (!sub) die('usage: ankh stake <amount>');
        out(await sdk.stake(await signed(), sub), `staked ${sub} ANKH`);
        break;
      }

      case 'unstake': {
        if (!sub) die('usage: ankh unstake <amount>');
        out(await sdk.unstake(await signed(), sub), `unstaked ${sub} ANKH`);
        break;
      }

      case 'ubi status': {
        const s = await sdk.getUBIStatus(addrArg(rest[0]));
        out(s, `claimable: ${s.canClaim}  claimed: ${s.monthsClaimed}/${(s.monthsClaimed ?? 0) + (s.remainingMonths ?? 0)}`);
        break;
      }

      case 'ubi claim':
        out(await sdk.claimUBI(await signed()), 'UBI claim submitted');
        break;

      case 'token list': {
        const t = await sdk.getTokens();
        out(t, (t || []).map(x => `${(x.symbol || '').padEnd(10)} ${x.name}`).join('\n') || 'no tokens');
        break;
      }

      case 'token info':  out(await sdk.getToken(rest[0] || die('usage: ankh token info <symbol>'))); break;
      case 'token tiers': {
        const t = await sdk.getTokenTiers();
        out(t, (t || []).map(x =>
          `${x.tier.padEnd(15)} stake ${(BigInt(x.stakeRequired) / 10n ** 18n).toString().padStart(8)} ANKH`).join('\n'));
        break;
      }

      case 'token create': {
        if (!flags.name || !flags.symbol) die('usage: ankh token create --name <n> --symbol <s> [--supply <n>] [--stake <n>]');
        const creator = await signed();
        out(await sdk.createToken({
          creator, name: flags.name, symbol: flags.symbol,
          initialSupply: flags.supply || '0', stake: flags.stake || '100',
          mintable: !!flags.mintable, burnable: !!flags.burnable,
          description: flags.description || ''
        }), `token ${flags.symbol} submitted`);
        break;
      }

      case 'node register': {
        // This is the transaction the SDK was long documented as unable to sign.
        // It signs like anything else now.
        const address = await signed();
        const pub = AnkhSDK.crypto.publicKeyFromPrivate(await loadPrivateKey());
        out(await sdk.registerNode(address, pub), `registered ${address} as a node operator`);
        break;
      }

      case 'sidechain list': {
        const c = await sdk.getSidechains();
        out(c, (c || []).map(x => `${(x.chainId || '').padEnd(24)} ${x.status || ''}`).join('\n') || 'none');
        break;
      }

      case 'council': {
        const c = await sdk.getSidechainCouncil?.() ?? await fetch(`${nodeUrl}/api/v1/sidechains/council`).then(r => r.json()).then(j => j.data);
        out(c, `${c.type}  threshold ${c.threshold} of ${c.totalMembers}`);
        break;
      }

      case 'faucet': {
        const address = addrArg(sub);
        const r = await fetch(`${nodeUrl}/api/v1/faucet`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address })
        });
        const j = await r.json();
        if (!j.success) die(j.error || 'faucet request failed');
        out(j.data, `funded ${address}`);
        break;
      }

      case 'watch': {
        const wanted = typeof flags.events === 'string' ? flags.events.split(',').map(s => s.trim()) : null;
        await sdk.connect();
        console.error(`watching ${nodeUrl} — Ctrl+C to stop`);
        for (const ev of wanted || ['NEW_BLOCK', 'TRANSFER', 'USER_VERIFIED', 'UBI_CLAIMED', 'TOKEN_CREATED']) {
          sdk.on(ev, payload => console.log(JSON.stringify({ event: ev, payload })));
        }
        await new Promise(() => {});   // until interrupted
        break;
      }

      case 'config show':
        out({ node: nodeUrl, home: HOME, wallet: stored?.address ?? null });
        break;

      case 'config set':
        if (positional[2] !== 'node' || !positional[3]) die('usage: ankh config set node <url>');
        writeJson(CONFIG_PATH, { ...cfg, node: positional[3] });
        out({ node: positional[3] }, `default node set to ${positional[3]}`);
        break;

      default:
        die(`unknown command "${positional.join(' ')}"\n${USAGE}`);
    }
  } catch (err) {
    die(err.message);
  }
})();
