/**
 * The SDK ships its own pure-JS secp256k1 so that browsers need no dependencies.
 * That means there are two independent implementations of the same curve in this
 * repository — the SDK's, and `elliptic` as used by the node — and nothing forced
 * them to agree. They did not: a transposed pair in the Extended Euclidean
 * coefficient update made `inv()` return a non-inverse for every input, so every
 * key and every signature the SDK produced was wrong. It was invisible because
 * the SDK was never tested against the verifier that has to accept its output.
 *
 * These tests fix the SDK to the node's verifier, which is the only thing that
 * actually decides whether a transaction is valid.
 */
const path = require('path');
const crypto = require('crypto');
const AnkhSDK = require(path.join(__dirname, '..', 'ankh-sdk.js'));
const Transaction = require('../src/core/Transaction');
const EC = require('elliptic').ec;
const ec = new EC('secp256k1');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x)); };

const addrOf = pub =>
  'ankh_' + crypto.createHash('sha256').update(Buffer.from(pub, 'hex')).digest('hex').substring(0, 40);

(async () => {
  console.log('=== THE TWO CURVE IMPLEMENTATIONS AGREE ===');

  // Modular inversion is the primitive everything else rests on. If it is wrong
  // the failure is silent: points still look like points, they are just not on
  // the curve the rest of the world is using.
  {
    let good = 0;
    for (let i = 0; i < 100; i++) {
      const priv = crypto.randomBytes(32).toString('hex');
      const a = AnkhSDK.crypto.publicKeyFromPrivate(priv);
      const b = ec.keyFromPrivate(priv, 'hex').getPublic('hex');
      if (a === b) good++;
    }
    ok('public key derivation matches elliptic for every key', good === 100, `${good}/100`);
  }

  {
    let good = 0;
    for (let i = 0; i < 100; i++) {
      const priv = crypto.randomBytes(32).toString('hex');
      const msg = crypto.randomBytes(32).toString('hex');
      const sig = await AnkhSDK.crypto.sign(msg, priv);
      if (ec.keyFromPrivate(priv, 'hex').verify(msg, { r: sig.r, s: sig.s })) good++;
    }
    ok('SDK signatures verify under elliptic', good === 100, `${good}/100`);
  }

  {
    // recoveryParam is what lets the node reconstruct the signer's key from the
    // signature alone. A signature can be valid while its recoveryParam is wrong,
    // in which case the node silently recovers a different address and rejects.
    let good = 0;
    for (let i = 0; i < 100; i++) {
      const priv = crypto.randomBytes(32).toString('hex');
      const msg = crypto.randomBytes(32).toString('hex');
      const sig = await AnkhSDK.crypto.sign(msg, priv);
      const expected = ec.keyFromPrivate(priv, 'hex').getPublic('hex');
      let rec = null;
      try {
        rec = ec.recoverPubKey(Buffer.from(msg, 'hex'), { r: sig.r, s: sig.s }, sig.recoveryParam).encode('hex');
      } catch { /* counted as a failure below */ }
      if (rec === expected) good++;
    }
    ok('recoveryParam recovers the signing key', good === 100, `${good}/100`);
  }

  {
    // Low-S normalisation flips the parity bit. Signatures that needed the flip
    // are the ones a naive implementation gets wrong, so confirm both branches
    // are actually exercised rather than assuming the sample covered them.
    const seen = new Set();
    for (let i = 0; i < 60; i++) {
      const sig = await AnkhSDK.crypto.sign(
        crypto.randomBytes(32).toString('hex'),
        crypto.randomBytes(32).toString('hex')
      );
      seen.add(sig.recoveryParam & 1);
    }
    ok('both recovery parities occur in the sample', seen.size === 2, [...seen].join(','));
  }

  console.log('\n=== THE NODE ACCEPTS WHAT THE SDK SIGNS ===');

  // The real acceptance test: build and sign entirely through the SDK, then hand
  // the result to the node's own Transaction.verifySignature().
  const sdk = new AnkhSDK({ nodeUrl: 'http://localhost:3001' });
  const types = ['TRANSFER', 'UBI_CLAIM', 'TOKEN_CREATE', 'STAKE',
    'SIDECHAIN_ANCHOR', 'GOVERNANCE_VOTE', 'BRIDGE_LOCK'];

  for (const type of types) {
    let good = 0;
    for (let i = 0; i < 20; i++) {
      const priv = crypto.randomBytes(32).toString('hex');
      const from = addrOf(AnkhSDK.crypto.publicKeyFromPrivate(priv));
      const built = await sdk.buildTransaction({
        type, from, to: 'ankh_' + 'd'.repeat(40), value: '100', fee: '1', nonce: i, data: {}
      });
      await sdk.signTransaction(built, priv);
      const tx = new Transaction({
        type: built.type, from: built.from, to: built.to, value: built.value,
        fee: built.fee, nonce: built.nonce, data: built.data, timestamp: built.timestamp
      });
      tx.signature = built.signature;
      if (tx.hash === built.hash && tx.verifySignature()) good++;
    }
    ok(`${type} signed by the SDK is accepted`, good === 20, `${good}/20`);
  }

  {
    // NODE_REGISTER was documented as the one type the SDK could not sign. It is
    // the transaction sidechain operators have to send first, so it is the worst
    // possible place for a signing gap. It must work through the SDK like any other.
    let good = 0;
    for (let i = 0; i < 20; i++) {
      const priv = crypto.randomBytes(32).toString('hex');
      const publicKey = AnkhSDK.crypto.publicKeyFromPrivate(priv);
      const from = addrOf(publicKey);
      const built = await sdk.buildTransaction({
        type: 'NODE_REGISTER', from, to: 'system', value: '0', fee: '0', nonce: i, data: { publicKey }
      });
      await sdk.signTransaction(built, priv);
      const tx = new Transaction({
        type: built.type, from: built.from, to: built.to, value: built.value,
        fee: built.fee, nonce: built.nonce, data: built.data, timestamp: built.timestamp
      });
      tx.signature = built.signature;
      if (tx.hash === built.hash && tx.verifySignature()) good++;
    }
    ok('NODE_REGISTER signed by the SDK is accepted', good === 20, `${good}/20`);
  }

  {
    // The hash is what the signature commits to. If the SDK and the node disagree
    // about how to build it, signatures verify against the wrong message.
    let good = 0;
    for (let i = 0; i < 20; i++) {
      const from = 'ankh_' + crypto.randomBytes(20).toString('hex');
      const built = await sdk.buildTransaction({
        type: 'TRANSFER', from, to: 'ankh_' + 'e'.repeat(40),
        value: '12345', fee: '7', nonce: i, data: { note: 'x' }
      });
      const tx = new Transaction({
        type: built.type, from: built.from, to: built.to, value: built.value,
        fee: built.fee, nonce: built.nonce, data: built.data, timestamp: built.timestamp
      });
      if (tx.hash === built.hash) good++;
    }
    ok('SDK and node compute the same transaction hash', good === 20, `${good}/20`);
  }

  console.log('\n=== TAMPERING IS STILL CAUGHT ===');

  {
    // A correct signer must not make the verifier permissive.
    const priv = crypto.randomBytes(32).toString('hex');
    const from = addrOf(AnkhSDK.crypto.publicKeyFromPrivate(priv));
    const built = await sdk.buildTransaction({
      type: 'TRANSFER', from, to: 'ankh_' + 'd'.repeat(40), value: '100', fee: '1', nonce: 1, data: {}
    });
    await sdk.signTransaction(built, priv);

    const mk = over => {
      const t = new Transaction({
        type: 'TRANSFER', from: built.from, to: built.to, value: built.value,
        fee: built.fee, nonce: built.nonce, data: built.data, timestamp: built.timestamp, ...over
      });
      t.signature = over.signature || built.signature;
      return t;
    };

    ok('an altered value is rejected', mk({ value: '999999' }).verifySignature() === false);
    ok('an altered recipient is rejected', mk({ to: 'ankh_' + '9'.repeat(40) }).verifySignature() === false);
    ok('a forged sender is rejected', mk({ from: 'ankh_' + '0'.repeat(40) }).verifySignature() === false);
    ok('a corrupted signature is rejected',
      mk({ signature: { ...built.signature, s: 'f'.repeat(64) } }).verifySignature() === false);
    ok('a wrong recoveryParam is rejected',
      mk({ signature: { ...built.signature, recoveryParam: built.signature.recoveryParam ^ 1 } })
        .verifySignature() === false);
  }

  console.log('\n=== AMOUNTS ARE EXACT ===');

  {
    // parseAmount used to go through a float: Number(ankh) * 1e18. Above 2^53
    // that is lossy, and the loss is downward, so a stake of exactly a tier
    // threshold came out just under it and the account was silently given a
    // lower tier. Amounts that gate access have to be exact, not approximate.
    const GenesisConfig = require('../src/core/GenesisConfig');
    const cases = [
      ['100', 100n * 10n ** 18n],
      ['10000', 10_000n * 10n ** 18n],
      ['100000', 100_000n * 10n ** 18n],
      ['500000', 500_000n * 10n ** 18n],
      ['5185.19', 5_185_190_000_000_000_000_000n],
      ['0.000000000000000001', 1n],
      ['0', 0n],
      ['1e21', 10n ** 21n * 10n ** 18n]
    ];
    let good = 0;
    for (const [input, expected] of cases) {
      if (BigInt(AnkhSDK.parseAmount(input)) === expected) good++;
      else console.log(`    ${input} -> ${AnkhSDK.parseAmount(input)}, expected ${expected}`);
    }
    ok('parseAmount is exact for every representative amount', good === cases.length, `${good}/${cases.length}`);

    // Numbers and strings must agree; a caller passing 100000 unquoted should
    // not get a different result from one passing "100000".
    ok('numeric and string input agree',
      [100, 10000, 100000, 500000, 1234567.89, 0.1]
        .every(n => AnkhSDK.parseAmount(n) === AnkhSDK.parseAmount(String(n))));

    // The thresholds this actually has to clear, read from the chain config
    // rather than restated here.
    const tiers = GenesisConfig.TOKEN_TIERS;
    ok('a stake of exactly 100,000 reaches INSTITUTIONAL',
      BigInt(AnkhSDK.parseAmount(100000)) >= tiers.INSTITUTIONAL.STAKE_REQUIRED);
    ok('a stake of exactly 500,000 reaches SOVEREIGN',
      BigInt(AnkhSDK.parseAmount(500000)) >= tiers.SOVEREIGN.STAKE_REQUIRED);
    ok('a stake of exactly 10,000 reaches STANDARD',
      BigInt(AnkhSDK.parseAmount(10000)) >= tiers.STANDARD.STAKE_REQUIRED);

    // Fractions below one wei are truncated, never rounded up into value the
    // caller did not ask to spend.
    ok('sub-wei precision truncates rather than rounds up',
      AnkhSDK.parseAmount('0.1234567890123456789') === '123456789012345678');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
