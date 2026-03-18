/**
 * ANKH Chain SDK  v2.0.0
 *
 * Zero-external-dependency browser / Node.js SDK for building wallets and apps
 * on ANKH Chain.  Includes built-in secp256k1 signing so no extra libraries are
 * required.
 *
 * ─── Signing note ──────────────────────────────────────────────────────────────
 *
 * The SDK's built-in secp256k1 signer uses a deterministic k-derivation scheme
 * that differs from the `elliptic` npm library used by the ANKH node for
 * signature verification. In practice this is safe for standard wallet operations
 * (transfers, UBI claims, verifications) where the node derives the sender address
 * from the signature using `recoverPubKey`.
 *
 * For server-side NODE_REGISTER transactions specifically, use Transaction.sign()
 * from the ANKH Chain source directly — it calls `elliptic` natively and avoids
 * any edge-case recoveryParam discrepancy:
 *
 *   const Transaction = require('./src/core/Transaction');
 *   const tx = new Transaction({ type: 'NODE_REGISTER', ... });
 *   tx.sign(privateKeyHex);
 *   // then POST to /api/v1/transactions
 *
 * ─── Quick Start ───────────────────────────────────────────────────────────────
 *
 *   Browser:
 *     <script src="http://localhost:3001/ankh-sdk.js"></script>
 *     const sdk = new AnkhSDK({ nodeUrl: 'http://localhost:3001' });
 *
 *   Node.js:
 *     const AnkhSDK = require('./ankh-sdk');
 *     const sdk = new AnkhSDK({ nodeUrl: 'http://localhost:3001' });
 *
 * ─── Wallet ────────────────────────────────────────────────────────────────────
 *
 *   // Generate a new wallet (keypair + address, server-assisted):
 *   const wallet = await sdk.generateWallet();
 *   // → { address, publicKey, privateKey }  — privateKey is NOT stored by node
 *
 *   // OR: generate fully client-side
 *   const wallet = await AnkhSDK.createWallet();
 *   // → { address, publicKey, privateKey, mnemonic? }
 *
 *   // Derive address from existing public key
 *   const address = await sdk.deriveAddress(publicKeyHex);
 *
 * ─── Signed operations (recommended for production) ───────────────────────────
 *
 *   // Set private key once — all mutating calls auto-sign:
 *   sdk.setPrivateKey('a1b2c3...');          // hex private key
 *
 *   await sdk.send(from, to, 100);           // auto-signed transfer
 *   await sdk.stake(address, 10000);         // auto-signed stake
 *   await sdk.createToken({ name:'MyToken', symbol:'MTK', tier:1, creator: address });
 *
 * ─── AnkhWallet convenience class ─────────────────────────────────────────────
 *
 *   const wallet = new AnkhWallet(sdk, address, privateKey);
 *   const bal    = await wallet.getBalance();
 *   await wallet.send('ankh_recipient...', 50);
 *   await wallet.stake(10000);
 *   await wallet.claimUBI();
 *   wallet.on('TRANSFER', tx => console.log('Received', tx.amount, 'ANKH'));
 *
 * ─── Tokens (ARC-20) ──────────────────────────────────────────────────────────
 *
 *   // Create a subtoken (requires staked ANKH based on tier)
 *   const token = await sdk.createToken({
 *     creator: address, name: 'MyToken', symbol: 'MTK', decimals: 18,
 *     initialSupply: '1000000', maxSupply: '10000000',
 *     tier: 1, mintable: true, burnable: true
 *   });
 *
 *   const tokens = await sdk.getTokens();
 *   const bal    = await sdk.getTokenBalance(tokenAddress, holderAddress);
 *   await sdk.transferToken(tokenAddress, from, to, amount);
 *   await sdk.mintToken(tokenAddress, toAddress, amount);
 *   await sdk.burnToken(tokenAddress, fromAddress, amount);
 *
 * ─── Sidechains ───────────────────────────────────────────────────────────────
 *
 *   const chains = await sdk.getSidechains();
 *   const chain  = await sdk.getSidechain('myChainId');
 *
 *   // 1. Register your node as a trusted verifier on the main chain
 *   sdk.setPrivateKey(nodePrivKey);
 *   await sdk.registerNode(nodeAddress, nodePublicKey);
 *
 *   // 2. Propose a sidechain (requires staked ANKH — 100k for INSTITUTIONAL)
 *   const result = await sdk.proposeSidechain({
 *     creator: address, name: 'GovChain', chainId: 'govchain_1',
 *     authorities: [{ address, name: 'Primary', role: 'validator' }],
 *     institutionType: 'government',  // 'government'|'organization'|'cooperative'
 *     stake: 100000
 *   });
 *
 *   // 3. Verified users vote to approve (need ≥5 votes, ≥66% approval)
 *   await sdk.voteOnSidechainProposal(result.proposalId, voterAddress, true);
 *
 *   // 4. Once approved, distribute benefits to verified citizens
 *   await sdk.distributeSidechainBenefits(
 *     'govchain_1', authorityAddress,
 *     ['ankh_abc...', 'ankh_def...'],   // recipients
 *     ['5000000000000000000000', ...],  // amounts in raw units (18 decimals)
 *     'MONTHLY_WELFARE'
 *   );
 *
 *   // 5. Periodically anchor sidechain state to the main chain
 *   await sdk.anchorSidechain('govchain_1', authorityAddress, blockHash, blockHeight);
 *
 *   const proposals = await sdk.getSidechainProposals();
 *
 * ─── Staking ──────────────────────────────────────────────────────────────────
 *
 *   await sdk.stake(address, 10000);                   // self-stake (become validator)
 *   await sdk.stake(address, 5000, validatorAddress);  // delegate to validator
 *   await sdk.unstake(address, 5000);                  // start 21-day unbonding
 *
 * ─── Governance ───────────────────────────────────────────────────────────────
 *
 *   await sdk.proposeGovernance(address, { title, description, type, params });
 *   await sdk.voteGovernance(address, proposalId, vote);  // vote: 'YES'|'NO'|'ABSTAIN'
 *
 * ─── Bridge (ETH ↔ ANKH) ──────────────────────────────────────────────────────
 *
 *   await sdk.bridgeLock(address, amount, 'ethereum', ethAddress);
 *   await sdk.bridgeRelease(address, amount, lockTxHash);
 *
 * ─── Reserve ──────────────────────────────────────────────────────────────────
 *
 *   // Requires the reserve wallet's private key set via setPrivateKey()
 *   await sdk.releaseReserve({ reserveType:'main', toAddress, amount, reason });
 *
 * ─── Peg ──────────────────────────────────────────────────────────────────────
 *
 *   const status  = await sdk.getPegStatus();
 *   const history = await sdk.getPegHistory(100);
 *
 * ─── Real-time events ──────────────────────────────────────────────────────────
 *
 *   await sdk.connect();
 *   sdk.on('NEW_BLOCK',     block => console.log('Block', block.index));
 *   sdk.on('TRANSFER',      tx    => { if (tx.to === myAddr) notify(tx); });
 *   sdk.on('USER_VERIFIED', ev    => console.log('Verified', ev.address));
 *   sdk.on('UBI_CLAIMED',   ev    => console.log('UBI claimed', ev.address));
 *   sdk.on('TOKEN_CREATED', ev    => console.log('New token', ev.symbol));
 *   // sdk.on('*', msg => …)  — catch-all
 *   const unsub = sdk.on('NEW_BLOCK', handler);
 *   unsub();  // unsubscribe
 *
 * ─── Address format ────────────────────────────────────────────────────────────
 *
 *   'ankh_' + first-40-hex-chars-of-SHA256(uncompressed-secp256k1-public-key)
 *
 * ─── Transaction hash & signature scheme ──────────────────────────────────────
 *
 *   txHash     = SHA256( JSON.stringify({ type,from,to,value,fee,nonce,data,timestamp }) )
 *   msgHash    = SHA256( txHash )
 *   signature  = ECDSA-secp256k1( msgHash, privateKey )  → { r, s, recoveryParam }
 */

/* global fetch, WebSocket, module, require, process, globalThis */

// ════════════════════════════════════════════════════════════════
//  Internal crypto helpers
// ════════════════════════════════════════════════════════════════

/**
 * SHA-256 of a string or Uint8Array, returns lowercase hex string.
 * Works in browser (SubtleCrypto) and Node.js (built-in crypto).
 */
async function _sha256(data) {
  const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;
  if (isNode) {
    const c = require('crypto');
    if (typeof data === 'string') return c.createHash('sha256').update(data, 'utf8').digest('hex');
    return c.createHash('sha256').update(Buffer.from(data)).digest('hex');
  }
  // Browser - SubtleCrypto
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const buf   = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function _hexToBytes(hex) {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) b[i >> 1] = parseInt(hex.slice(i, i + 2), 16);
  return b;
}

function _bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function _randomBytes32() {
  const b = new Uint8Array(32);
  const c = (typeof globalThis !== 'undefined' && globalThis.crypto)
    ? globalThis.crypto
    : require('crypto').webcrypto;
  c.getRandomValues(b);
  return b;
}

// ════════════════════════════════════════════════════════════════
//  secp256k1 — minimal pure-JS implementation
//  Operations: point math, sign, public-key-from-private
// ════════════════════════════════════════════════════════════════

const _secp = (() => {
  /* eslint-disable no-bitwise */
  const P  = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
  const N  = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
  const Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
  const Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;

  const mod  = (a, m = P) => ((a % m) + m) % m;
  const modN = a => mod(a, N);

  // Modular inverse via Extended Euclidean Algorithm
  function inv(n, m = P) {
    let [a, b, x, u] = [mod(n, m), m, 1n, 0n];
    while (a !== 0n) {
      const q = b / a;
      [a, b] = [b - q * a, a];
      [x, u] = [u, x - q * u];
    }
    return mod(x, m);
  }

  // Affine point — null x/y represents point at infinity
  class Point {
    constructor(x, y) { this.x = x; this.y = y; }
    get isInfinity() { return this.x === null; }

    add(b) {
      if (this.isInfinity) return b;
      if (b.isInfinity)    return this;
      if (this.x === b.x) {
        if (this.y !== b.y) return INF;
        // Point doubling
        const lam = mod(3n * this.x * this.x * inv(2n * this.y));
        const x3  = mod(lam * lam - 2n * this.x);
        return new Point(x3, mod(lam * (this.x - x3) - this.y));
      }
      const lam = mod((b.y - this.y) * inv(b.x - this.x));
      const x3  = mod(lam * lam - this.x - b.x);
      return new Point(x3, mod(lam * (this.x - x3) - this.y));
    }

    multiply(k) {
      let result = INF;
      let addend = this;
      k = modN(k);
      while (k > 0n) {
        if (k & 1n) result = result.add(addend);
        addend = addend.add(addend);
        k >>= 1n;
      }
      return result;
    }

    toUncompressedHex() {
      return '04' + this.x.toString(16).padStart(64, '0') + this.y.toString(16).padStart(64, '0');
    }
  }

  const INF = new Point(null, null);
  const G   = new Point(Gx, Gy);

  return {
    /**
     * Derive secp256k1 public key (uncompressed hex) from private key hex.
     * @param {string} privHex - 32-byte private key as hex
     * @returns {string}         130-char uncompressed public key hex (04…)
     */
    publicKeyFromPrivate(privHex) {
      const d = BigInt('0x' + privHex);
      if (d <= 0n || d >= N) throw new Error('Invalid private key');
      return G.multiply(d).toUncompressedHex();
    },

    /**
     * ECDSA sign.  Uses deterministic k derived from privKey + msgHash (safe,
     * prevents k-reuse without full RFC 6979 implementation).
     *
     * @param   {string} msgHashHex  – 32-byte message hash as hex
     * @param   {string} privHex     – 32-byte private key as hex
     * @returns {Promise<{ r:string, s:string, recoveryParam:number }>}
     */
    async sign(msgHashHex, privHex) {
      const d = BigInt('0x' + privHex);
      const z = BigInt('0x' + msgHashHex);

      // Deterministic k: SHA256(privKey || msgHash || attempt)
      // This is not RFC 6979 but is deterministic and avoids k-reuse.
      let k, r, s, recoveryParam;
      let attempt = 0;
      do {
        const kHex = await _sha256(privHex + msgHashHex + attempt.toString(16).padStart(2, '0'));
        k = modN(BigInt('0x' + kHex));
        if (k === 0n) { attempt++; continue; }
        const kp = G.multiply(k);
        r = modN(kp.x);
        if (r === 0n) { attempt++; continue; }
        s = modN(inv(k, N) * modN(z + r * d));
        if (s === 0n) { attempt++; continue; }
        recoveryParam = Number(kp.y % 2n);
        // Low-S normalisation (BIP-62)
        if (s > N / 2n) { s = N - s; recoveryParam ^= 1; }
        break;
      } while (attempt < 100);

      if (attempt >= 100) throw new Error('secp256k1: failed to produce valid signature');

      return {
        r: r.toString(16).padStart(64, '0'),
        s: s.toString(16).padStart(64, '0'),
        recoveryParam
      };
    }
  };
})();

// ════════════════════════════════════════════════════════════════
//  Transaction builder (mirrors ankh_chain/src/core/Transaction.js)
// ════════════════════════════════════════════════════════════════

const _TYPES = {
  TRANSFER: 'TRANSFER', UBI_CLAIM: 'UBI_CLAIM',
  BIOMETRIC_REGISTRATION: 'BIOMETRIC_REGISTRATION',
  TOKEN_CREATE: 'TOKEN_CREATE', TOKEN_TRANSFER: 'TOKEN_TRANSFER',
  TOKEN_MINT: 'TOKEN_MINT', TOKEN_BURN: 'TOKEN_BURN',
  STAKE: 'STAKE', UNSTAKE: 'UNSTAKE',
  GOVERNANCE_PROPOSE: 'GOVERNANCE_PROPOSE', GOVERNANCE_VOTE: 'GOVERNANCE_VOTE',
  SIDECHAIN_CREATE: 'SIDECHAIN_CREATE', SIDECHAIN_ANCHOR: 'SIDECHAIN_ANCHOR',
  BRIDGE_LOCK: 'BRIDGE_LOCK', BRIDGE_RELEASE: 'BRIDGE_RELEASE',
  CONTRACT_DEPLOY: 'CONTRACT_DEPLOY', CONTRACT_CALL: 'CONTRACT_CALL',
  NODE_REGISTER: 'NODE_REGISTER', RESERVE_RELEASE: 'RESERVE_RELEASE'
};

/**
 * Build a transaction object and (optionally) sign it.
 * The returned object can be submitted via sdk.submitTransaction().
 *
 * @param {object}  fields   – { type, from, to, value, fee, nonce, data, timestamp? }
 * @param {string}  [privHex]  – private key; if provided the tx is signed
 * @returns {Promise<object>}  signed (or unsigned) transaction JSON
 */
async function _buildTx(fields, privHex) {
  const tx = {
    id: _uuid(),
    type:      fields.type,
    from:      fields.from,
    to:        fields.to || 'system',
    value:     String(fields.value || 0),
    fee:       String(fields.fee   || 0),
    nonce:     fields.nonce || 0,
    data:      fields.data  || {},
    signature: null,
    timestamp: fields.timestamp || Date.now()
  };

  // Calculate hash (matches Transaction.calculateHash in the chain)
  const hashData = {
    type: tx.type, from: tx.from, to: tx.to,
    value: tx.value, fee: tx.fee,
    nonce: tx.nonce, data: tx.data, timestamp: tx.timestamp
  };
  tx.hash = '0x' + await _sha256(JSON.stringify(hashData));

  if (privHex) {
    const msgHash  = await _sha256(tx.hash);
    tx.signature   = await _secp.sign(msgHash, privHex);
  }

  return tx;
}

function _uuid() {
  const b = _randomBytes32();
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = _bytesToHex(b);
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

// ════════════════════════════════════════════════════════════════
//  AnkhSDK
// ════════════════════════════════════════════════════════════════

class AnkhSDK {
  /**
   * @param {object}  opts
   * @param {string}  [opts.nodeUrl='http://localhost:3001']
   * @param {boolean} [opts.autoReconnect=true]
   * @param {number}  [opts.reconnectDelayMs=3000]
   */
  constructor({ nodeUrl = 'http://localhost:3001', autoReconnect = true, reconnectDelayMs = 3000 } = {}) {
    this.nodeUrl          = nodeUrl.replace(/\/$/, '');
    this.autoReconnect    = autoReconnect;
    this.reconnectDelayMs = reconnectDelayMs;

    this._ws        = null;
    this._wsReady   = false;
    this._listeners = new Map();
    this._privKey   = null;  // set via setPrivateKey()
    this._signer    = null;  // optional async signing function override
  }

  // ════════════════════════════════════════════════════════════════
  //  Signing configuration
  // ════════════════════════════════════════════════════════════════

  /**
   * Store a private key for automatic transaction signing.
   * All mutating SDK methods (send, stake, createToken, …) will auto-sign
   * after this is called.
   *
   * @param {string} privateKeyHex  – 32-byte secp256k1 private key as hex
   */
  setPrivateKey(privateKeyHex) {
    this._privKey = privateKeyHex.replace(/^0x/, '');
    this._signer  = null;
  }

  /**
   * Provide a custom async signing function instead of a stored private key.
   * The function receives (txHashHex: string) and must return
   * { r: string, s: string, recoveryParam: number }.
   *
   * Use this to integrate hardware wallets or external key management.
   *
   * @param {Function} fn  – async (txHashHex) => { r, s, recoveryParam }
   */
  setSignerAsync(fn) {
    this._signer  = fn;
    this._privKey = null;
  }

  /** Clear the stored private key and signer. */
  clearKey() {
    this._privKey = null;
    this._signer  = null;
  }

  // ════════════════════════════════════════════════════════════════
  //  Wallet
  // ════════════════════════════════════════════════════════════════

  /**
   * Generate a new wallet keypair via the node.
   * The node returns the keypair but does NOT persist the private key.
   * @returns {Promise<{ address, publicKey, privateKey }>}
   */
  generateWallet() {
    return this._post('/api/v1/wallet/generate', {});
  }

  /**
   * Derive an ANKH address from an uncompressed secp256k1 public key (hex).
   * @param   {string} publicKeyHex  – 130-char uncompressed hex (04…)
   * @returns {Promise<string>}         ankh_… address
   */
  async deriveAddress(publicKeyHex) {
    const data = await this._get(`/api/v1/wallet/derive?publicKey=${publicKeyHex}`);
    return data.address;
  }

  /**
   * Compute an ANKH address from a public key entirely client-side (no network).
   * @param   {string} publicKeyHex  – 130-char uncompressed hex (04…)
   * @returns {Promise<string>}         ankh_… address
   */
  static async addressFromPublicKey(publicKeyHex) {
    const hash = await _sha256(_hexToBytes(publicKeyHex));
    return 'ankh_' + hash.substring(0, 40);
  }

  /**
   * Derive public key and address from a private key, entirely client-side.
   * @param   {string} privateKeyHex
   * @returns {Promise<{ privateKey, publicKey, address }>}
   */
  static async walletFromPrivateKey(privateKeyHex) {
    const privHex   = privateKeyHex.replace(/^0x/, '');
    const publicKey = _secp.publicKeyFromPrivate(privHex);
    const address   = await AnkhSDK.addressFromPublicKey(publicKey);
    return { privateKey: privHex, publicKey, address };
  }

  /**
   * Create a new wallet fully client-side (no network request).
   * @returns {Promise<{ privateKey, publicKey, address }>}
   */
  static async createWallet() {
    const privBytes = _randomBytes32();
    const privHex   = _bytesToHex(privBytes);
    return AnkhSDK.walletFromPrivateKey(privHex);
  }

  // ════════════════════════════════════════════════════════════════
  //  Account
  // ════════════════════════════════════════════════════════════════

  /**
   * Get ANKH balance.
   * @returns {Promise<{ address, raw, formatted }>}
   *   raw = wei string (18 decimals),  formatted = "X.XXXX ANKH"
   */
  async getBalance(address) {
    const d = await this._get(`/api/v1/accounts/${address}/balance`);
    return { address: d.address, raw: d.balance, formatted: d.balanceFormatted };
  }

  /**
   * Full account state (balance, nonce, isVerified, stakedAmount, …).
   */
  getAccount(address) {
    return this._get(`/api/v1/accounts/${address}`);
  }

  /**
   * Transaction history for an address.
   * @param {number} [limit=20]  – max 100
   * @returns {Promise<Array<{ hash, type, from, to, value, fee, timestamp, blockIndex, direction }>>}
   */
  getTransactions(address, limit = 20) {
    return this._get(`/api/v1/accounts/${address}/transactions?limit=${limit}`);
  }

  // ════════════════════════════════════════════════════════════════
  //  Transfers
  // ════════════════════════════════════════════════════════════════

  /**
   * Send ANKH to another address.
   *
   * If a private key is set via setPrivateKey(), the transaction is signed
   * client-side and submitted via POST /api/v1/transactions.
   * Otherwise falls back to the trusted-node send endpoint.
   *
   * @param   {string}        from    – Sender ankh_ address
   * @param   {string}        to      – Recipient ankh_ address
   * @param   {number|string} amount  – Decimal ANKH amount (e.g. 100 or "0.5")
   * @param   {object}        [opts]  – { fee, nonce }
   * @returns {Promise<{ txHash, blockIndex, blockHash, from, to, amount, amountFormatted }>}
   */
  async send(from, to, amount, opts = {}) {
    if (this._privKey || this._signer) {
      const nonce  = opts.nonce ?? (await this.getAccount(from)).nonce;
      const value  = AnkhSDK.parseAmount(amount);
      const fee    = String(opts.fee ?? 0);
      const tx     = await _buildTx({ type: _TYPES.TRANSFER, from, to, value, fee, nonce }, this._privKey);
      if (this._signer && !this._privKey) {
        const msgHash  = await _sha256(tx.hash);
        tx.signature   = await this._signer(msgHash);
      }
      return this._post('/api/v1/transactions', tx);
    }
    return this._post('/api/v1/send', { from, to, amount });
  }

  /**
   * Submit a pre-built and signed transaction object.
   * Build the transaction with buildTransaction() and sign with signTransaction().
   */
  submitTransaction(signedTx) {
    return this._post('/api/v1/transactions', signedTx);
  }

  /** Pending transactions in the mempool. */
  getPendingTransactions() {
    return this._get('/api/v1/transactions/pending');
  }

  // ════════════════════════════════════════════════════════════════
  //  Transaction builder (client-side)
  // ════════════════════════════════════════════════════════════════

  /**
   * Build an unsigned transaction.  Supply all fields manually.
   * @param {object} fields – { type, from, to, value, fee, nonce, data, timestamp? }
   * @returns {Promise<object>}  unsigned tx (with hash)
   */
  buildTransaction(fields) {
    return _buildTx(fields);
  }

  /**
   * Sign an already-built transaction with the stored private key.
   * @param {object} tx       – unsigned tx (must have tx.hash set)
   * @param {string} [privHex] – override private key for this call
   * @returns {Promise<object>}  tx with .signature populated
   */
  async signTransaction(tx, privHex) {
    const key = privHex ?? this._privKey;
    if (!key) throw new Error('No private key set. Call setPrivateKey() first.');
    const msgHash  = await _sha256(tx.hash);
    tx.signature   = await _secp.sign(msgHash, key);
    return tx;
  }

  // ════════════════════════════════════════════════════════════════
  //  UBI
  // ════════════════════════════════════════════════════════════════

  /**
   * UBI status for a verified user.
   * @returns {Promise<{ canClaim, monthsClaimed, nextClaimAvailable, monthlyAmount, … }>}
   */
  getUBIStatus(address) {
    return this._get(`/api/v1/ubi/${address}/status`);
  }

  /**
   * Claim the monthly UBI disbursement.  User must be verified first.
   * @returns {Promise<{ amount, blockIndex, blockHash, … }>}
   */
  claimUBI(address) {
    return this._post(`/api/v1/ubi/${address}/claim`, {});
  }

  /** Global UBI distribution statistics. */
  getUBIStats() {
    return this._get('/api/v1/ubi/stats');
  }

  // ════════════════════════════════════════════════════════════════
  //  Staking
  // ════════════════════════════════════════════════════════════════

  /**
   * Stake ANKH.
   *   - Self-stake (become a validator):  omit validatorAddress or set equal to address
   *   - Delegate:                         set validatorAddress to an existing validator
   *
   * @param {string}        address           – Staker's address
   * @param {number|string} amount            – ANKH amount (min 10,000 to self-stake)
   * @param {string}        [validatorAddress]– Validator to delegate to (optional)
   * @returns {Promise<{ txHash, … }>}
   */
  async stake(address, amount, validatorAddress) {
    if (!this._privKey && !this._signer) {
      throw new Error('stake() requires a private key or signer — staking is an authorized operation');
    }
    const nonce  = (await this.getAccount(address)).nonce;
    const value  = AnkhSDK.parseAmount(amount);
    const tx     = await _buildTx({
      type: _TYPES.STAKE, from: address, to: validatorAddress || 'staking_contract',
      value, nonce, data: { action: 'DELEGATE', validator: validatorAddress || address }
    }, this._privKey);
    if (this._signer && !this._privKey) {
      const msgHash = await _sha256(tx.hash);
      tx.signature  = await this._signer(msgHash);
    }
    return this._post('/api/v1/transactions', tx);
  }

  /**
   * Begin unstaking.  Starts the 21-day unbonding period.
   *
   * @param {string}        address
   * @param {number|string} [amount]           – defaults to full stake
   * @param {string}        [validatorAddress] – if delegating, the validator's address
   */
  async unstake(address, amount, validatorAddress) {
    if (!this._privKey && !this._signer) {
      throw new Error('unstake() requires a private key or signer — unstaking is an authorized operation');
    }
    const nonce  = (await this.getAccount(address)).nonce;
    const value  = amount ? AnkhSDK.parseAmount(amount) : '0';
    const tx     = await _buildTx({
      type: _TYPES.UNSTAKE, from: address, to: validatorAddress || 'staking_contract',
      value, nonce, data: { action: 'UNDELEGATE', validator: validatorAddress || address }
    }, this._privKey);
    if (this._signer && !this._privKey) {
      const msgHash = await _sha256(tx.hash);
      tx.signature  = await this._signer(msgHash);
    }
    return this._post('/api/v1/transactions', tx);
  }

  // ════════════════════════════════════════════════════════════════
  //  Tokens  (ARC-20 subtokens)
  // ════════════════════════════════════════════════════════════════

  /** List all ARC-20 tokens on the chain. */
  getTokens() {
    return this._get('/api/v1/tokens');
  }

  /**
   * Get token info by address or symbol.
   * @param {string} identifier – token address or symbol
   */
  getToken(identifier) {
    return this._get(`/api/v1/tokens/${identifier}`);
  }

  /**
   * Token balance for a holder.
   * @param {string} tokenAddress
   * @param {string} holderAddress
   */
  getTokenBalance(tokenAddress, holderAddress) {
    return this._get(`/api/v1/tokens/${tokenAddress}/balance/${holderAddress}`);
  }

  /** Token tier requirements and minimum stake amounts. */
  getTokenTiers() {
    return this._get('/api/v1/tokens/tiers');
  }

  /** Pending token creation proposals. */
  getPendingTokens() {
    return this._get('/api/v1/tokens/pending');
  }

  /**
   * Create a new ARC-20 subtoken.
   *
   * Requires the creator to have sufficient staked ANKH for the chosen tier.
   *   Tier 1 (community): min stake ~1,000 ANKH
   *   Tier 2 (project):   min stake ~10,000 ANKH
   *   Tier 3 (enterprise):min stake ~100,000 ANKH
   *
   * @param {object} params
   * @param {string} params.creator        – Creator's ankh_ address
   * @param {string} params.name           – Full token name
   * @param {string} params.symbol         – Ticker symbol (e.g. 'MTK')
   * @param {number} [params.decimals=18]
   * @param {string} [params.initialSupply='0']
   * @param {string} [params.maxSupply]    – null = unlimited
   * @param {number} params.tier           – 1 | 2 | 3
   * @param {boolean}[params.mintable=false]
   * @param {boolean}[params.burnable=false]
   * @param {boolean}[params.pausable=false]
   * @param {object} [params.metadata={}]
   * @returns {Promise<{ tokenAddress, symbol, name, tier, txHash, … }>}
   */
  async createToken(params) {
    if (this._privKey || this._signer) {
      const nonce = (await this.getAccount(params.creator)).nonce;
      const stake = AnkhSDK.parseAmount(params.stakeAmount || 0);
      const tx    = await _buildTx({
        type: _TYPES.TOKEN_CREATE,
        from: params.creator,
        to:   'token_factory',
        value: stake,
        nonce,
        data: {
          name:          params.name,
          symbol:        params.symbol,
          decimals:      params.decimals      ?? 18,
          initialSupply: String(params.initialSupply ?? 0),
          maxSupply:     params.maxSupply      ? String(params.maxSupply) : null,
          tier:          params.tier,
          mintable:      params.mintable       ?? false,
          burnable:      params.burnable       ?? false,
          pausable:      params.pausable       ?? false,
          metadata:      params.metadata       ?? {}
        }
      }, this._privKey);
      if (this._signer && !this._privKey) {
        const msgHash = await _sha256(tx.hash);
        tx.signature  = await this._signer(msgHash);
      }
      return this._post('/api/v1/transactions', tx);
    }
    return this._post('/api/v1/tokens/create', { creator: params.creator, ...params });
  }

  /**
   * Transfer ARC-20 tokens.
   * @param {string}        tokenAddress  – Token contract address
   * @param {string}        from
   * @param {string}        to
   * @param {string|number} amount        – Token amount in human units
   * @param {object}        [opts]        – { fee, nonce }
   */
  async transferToken(tokenAddress, from, to, amount, opts = {}) {
    if (this._privKey || this._signer) {
      const nonce = opts.nonce ?? (await this.getAccount(from)).nonce;
      const tx    = await _buildTx({
        type: _TYPES.TOKEN_TRANSFER,
        from, to, value: '0', nonce,
        data: { tokenAddress, amount: String(amount) }
      }, this._privKey);
      if (this._signer && !this._privKey) {
        const msgHash = await _sha256(tx.hash);
        tx.signature  = await this._signer(msgHash);
      }
      return this._post('/api/v1/transactions', tx);
    }
    return this._post(`/api/v1/tokens/${tokenAddress}/transfer`, { from, to, amount });
  }

  /**
   * Mint additional tokens (only the token creator / minter can call this).
   * @param {string}        tokenAddress
   * @param {string}        toAddress
   * @param {string|number} amount
   */
  async mintToken(tokenAddress, toAddress, amount, opts = {}) {
    const from  = opts.from || toAddress;
    if (this._privKey || this._signer) {
      const nonce = opts.nonce ?? (await this.getAccount(from)).nonce;
      const tx    = await _buildTx({
        type: _TYPES.TOKEN_MINT,
        from, to: toAddress, value: '0', nonce,
        data: { tokenAddress, amount: String(amount) }
      }, this._privKey);
      if (this._signer && !this._privKey) {
        const msgHash = await _sha256(tx.hash);
        tx.signature  = await this._signer(msgHash);
      }
      return this._post('/api/v1/transactions', tx);
    }
    return this._post(`/api/v1/tokens/${tokenAddress}/mint`, { toAddress, amount });
  }

  /**
   * Burn tokens (remove from supply).
   * @param {string}        tokenAddress
   * @param {string}        fromAddress
   * @param {string|number} amount
   */
  async burnToken(tokenAddress, fromAddress, amount, opts = {}) {
    if (this._privKey || this._signer) {
      const nonce = opts.nonce ?? (await this.getAccount(fromAddress)).nonce;
      const tx    = await _buildTx({
        type: _TYPES.TOKEN_BURN,
        from: fromAddress, to: 'burn', value: '0', nonce,
        data: { tokenAddress, amount: String(amount) }
      }, this._privKey);
      if (this._signer && !this._privKey) {
        const msgHash = await _sha256(tx.hash);
        tx.signature  = await this._signer(msgHash);
      }
      return this._post('/api/v1/transactions', tx);
    }
    return this._post(`/api/v1/tokens/${tokenAddress}/burn`, { fromAddress, amount });
  }

  // ════════════════════════════════════════════════════════════════
  //  Sidechains
  // ════════════════════════════════════════════════════════════════

  /** List all registered sidechains. */
  getSidechains() {
    return this._get('/api/v1/sidechains');
  }

  /** Get a sidechain by ID. */
  getSidechain(chainId) {
    return this._get(`/api/v1/sidechains/${chainId}`);
  }

  /** Pending sidechain proposals. */
  getSidechainProposals() {
    return this._get('/api/v1/sidechains/proposals');
  }

  /**
   * Propose a new institutional sidechain.
   *
   * @param {object} params
   * @param {string}   params.creator          – Proposer's ankh_ address
   * @param {string}   params.name             – Human-readable chain name
   * @param {string}   params.chainId          – Unique chain identifier (snake_case)
   * @param {string[]} params.authorities      – Array of ankh_ validator addresses
   * @param {string}   params.institutionType  – 'government'|'organization'|'enterprise'|'community'
   * @param {string}   [params.nativeCurrency] – Symbol for the sidechain's native token (optional)
   * @param {number}   [params.blockTime=1000] – Target block time in ms
   * @param {object}   [params.metadata={}]
   * @param {number|string} [params.stake=0]   – Required ANKH stake
   */
  async proposeSidechain(params) {
    if (this._privKey || this._signer) {
      const nonce = (await this.getAccount(params.creator)).nonce;
      const stake = AnkhSDK.parseAmount(params.stake || 0);
      const tx    = await _buildTx({
        type: _TYPES.SIDECHAIN_CREATE,
        from:  params.creator,
        to:    'sidechain_factory',
        value: stake,
        nonce,
        data: {
          name:            params.name,
          chainId:         params.chainId,
          tier:            params.tier            ?? 'INSTITUTIONAL',
          consensusType:   'POA',
          authorities:     params.authorities,
          blockTime:       params.blockTime       ?? 1000,
          nativeCurrency:  params.nativeCurrency,
          institutionType: params.institutionType,
          metadata:        params.metadata        ?? {}
        }
      }, this._privKey);
      if (this._signer && !this._privKey) {
        const msgHash = await _sha256(tx.hash);
        tx.signature  = await this._signer(msgHash);
      }
      return this._post('/api/v1/transactions', tx);
    }
    return this._post('/api/v1/sidechains/propose', { creator: params.creator, ...params });
  }

  /**
   * Register a node's public key on the main chain so it can sign biometric
   * verification proofs.  Must be called before submitting BIOMETRIC_REGISTRATION
   * transactions on behalf of users (e.g. from a government sidechain node).
   *
   * @param {string} address    – Node operator's ankh_ address (must have private key set)
   * @param {string} publicKey  – Node's secp256k1 public key (hex, uncompressed or compressed)
   * @param {object} [opts]     – { fee, nonce }
   */
  async registerNode(address, publicKey, opts = {}) {
    const nonce = opts.nonce ?? (await this.getAccount(address)).nonce;
    const fee   = opts.fee   ?? '0';
    const tx    = await _buildTx({
      type: _TYPES.NODE_REGISTER,
      from: address, to: 'node_registry', value: '0', fee, nonce,
      data: { publicKey }
    }, this._privKey);
    if (this._signer && !this._privKey) {
      tx.signature = await this._signer(await _sha256(tx.hash));
    }
    return this._post('/api/v1/transactions', tx);
  }

  /**
   * List all registered nodes (addresses that submitted a NODE_REGISTER tx).
   * @returns {Promise<Array<{ publicKey, address, registeredAt, isActive }>>}
   */
  getNodes() {
    return this._get('/api/v1/nodes');
  }

  /**
   * Get a single registered node by public key or ankh_ address.
   * @param {string} identifier  – Node's secp256k1 public key (hex) or ankh_ address
   * @returns {Promise<{ publicKey, address, registeredAt, isActive }>}
   */
  getNode(identifier) {
    return this._get(`/api/v1/nodes/${encodeURIComponent(identifier)}`);
  }

  /**
   * Execute a PASSED governance proposal (marks it EXECUTED on-chain).
   * @param {string} proposalId  – Proposal ID
   * @param {string} [executor]  – Executor's ankh_ address (optional, for audit trail)
   */
  executeGovernanceProposal(proposalId, executor) {
    return this._post(`/api/v1/governance/proposals/${proposalId}/execute`, { executor });
  }

  /**
   * Vote on a pending sidechain proposal.
   * @param {string}  proposalId  – Proposal ID from proposeSidechain()
   * @param {string}  voter       – Voter's ankh_ address (must be verified)
   * @param {boolean} approve     – true = approve, false = reject
   * @param {string}  [reason]    – Optional reason string
   */
  voteOnSidechainProposal(proposalId, voter, approve, reason) {
    return this._post(`/api/v1/sidechains/proposals/${proposalId}/vote`, {
      voter, approve, reason
    });
  }

  /**
   * Distribute benefits (payments) to verified citizens on a sidechain.
   * The caller must be a registered authority of the sidechain.
   *
   * @param {string}   chainId      – Target sidechain's chainId
   * @param {string}   distributor  – Authority's ankh_ address
   * @param {string[]} recipients   – Array of ankh_ addresses to pay
   * @param {string[]} amounts      – Corresponding amounts in raw units (18 decimals)
   * @param {string}   benefitType  – Label recorded on-chain, e.g. 'MONTHLY_WELFARE'
   */
  distributeSidechainBenefits(chainId, distributor, recipients, amounts, benefitType) {
    return this._post(`/api/v1/sidechains/${chainId}/distribute`, {
      distributor, recipients, amounts, benefitType
    });
  }

  /**
   * Submit a sidechain anchor block hash to the main chain.
   * @param {string} sidechainId    – sidechain's chainId
   * @param {string} from           – anchoring authority address
   * @param {string} anchorHash     – sidechain block hash to anchor
   * @param {number} anchorHeight   – sidechain block height
   */
  async anchorSidechain(sidechainId, from, anchorHash, anchorHeight, opts = {}) {
    if (this._privKey || this._signer) {
      const nonce = opts.nonce ?? (await this.getAccount(from)).nonce;
      const tx    = await _buildTx({
        type: _TYPES.SIDECHAIN_ANCHOR,
        from, to: 'sidechain_factory', value: '0', nonce,
        data: { sidechainId, anchorHash, anchorHeight }
      }, this._privKey);
      if (this._signer && !this._privKey) {
        const msgHash = await _sha256(tx.hash);
        tx.signature  = await this._signer(msgHash);
      }
      return this._post('/api/v1/transactions', tx);
    }
    return this._post(`/api/v1/sidechains/${sidechainId}/anchor`, { from, anchorHash, anchorHeight });
  }

  // ════════════════════════════════════════════════════════════════
  //  Governance
  // ════════════════════════════════════════════════════════════════

  /**
   * List governance proposals.
   * @param {string} [status]  – Filter: 'ACTIVE'|'PASSED'|'REJECTED'|'EXPIRED'
   */
  getGovernanceProposals(status) {
    const qs = status ? `?status=${status}` : '';
    return this._get(`/api/v1/governance/proposals${qs}`);
  }

  /**
   * Get a single governance proposal by ID.
   * @param {string} proposalId
   */
  getGovernanceProposal(proposalId) {
    return this._get(`/api/v1/governance/proposals/${proposalId}`);
  }

  /**
   * Submit a governance proposal.
   * @param {string} from    – Proposer's address
   * @param {object} proposal
   * @param {string}   proposal.title
   * @param {string}   proposal.description
   * @param {string}   proposal.type        – 'PARAMETER_CHANGE'|'PROTOCOL_UPGRADE'|'FUND_REQUEST'
   * @param {object}   [proposal.params={}] – Type-specific parameters
   */
  async proposeGovernance(from, proposal, opts = {}) {
    if (this._privKey || this._signer) {
      const nonce = opts.nonce ?? (await this.getAccount(from)).nonce;
      const tx    = await _buildTx({
        type: _TYPES.GOVERNANCE_PROPOSE,
        from, to: 'governance', value: '0', nonce,
        data: proposal
      }, this._privKey);
      if (this._signer && !this._privKey) {
        const msgHash = await _sha256(tx.hash);
        tx.signature  = await this._signer(msgHash);
      }
      return this._post('/api/v1/transactions', tx);
    }
    return this._post('/api/v1/governance/propose', { from, ...proposal });
  }

  /**
   * Vote on a governance proposal.
   * @param {string} from        – Voter's address
   * @param {string} proposalId  – Proposal ID
   * @param {string} vote        – 'YES' | 'NO' | 'ABSTAIN'
   */
  async voteGovernance(from, proposalId, vote, opts = {}) {
    if (this._privKey || this._signer) {
      const nonce = opts.nonce ?? (await this.getAccount(from)).nonce;
      const tx    = await _buildTx({
        type: _TYPES.GOVERNANCE_VOTE,
        from, to: 'governance', value: '0', nonce,
        data: { proposalId, vote }
      }, this._privKey);
      if (this._signer && !this._privKey) {
        const msgHash = await _sha256(tx.hash);
        tx.signature  = await this._signer(msgHash);
      }
      return this._post('/api/v1/transactions', tx);
    }
    return this._post('/api/v1/governance/vote', { from, proposalId, vote });
  }

  // ════════════════════════════════════════════════════════════════
  //  Bridge  (ETH ↔ ANKH)
  // ════════════════════════════════════════════════════════════════

  /**
   * Lock ANKH on the native chain to bridge to Ethereum.
   * @param {string}        from            – ANKH source address
   * @param {number|string} amount          – ANKH amount
   * @param {string}        targetChain     – e.g. 'ethereum'
   * @param {string}        targetAddress   – Ethereum address to receive the bridged tokens
   */
  async bridgeLock(from, amount, targetChain, targetAddress, opts = {}) {
    if (this._privKey || this._signer) {
      const nonce = opts.nonce ?? (await this.getAccount(from)).nonce;
      const tx    = await _buildTx({
        type: _TYPES.BRIDGE_LOCK,
        from, to: 'bridge_contract',
        value: AnkhSDK.parseAmount(amount),
        nonce,
        data: { targetChain, targetAddress, lockTimestamp: Date.now() }
      }, this._privKey);
      if (this._signer && !this._privKey) {
        const msgHash = await _sha256(tx.hash);
        tx.signature  = await this._signer(msgHash);
      }
      return this._post('/api/v1/transactions', tx);
    }
    return this._post('/api/v1/bridge/lock', { from, amount, targetChain, targetAddress });
  }

  /**
   * Release ANKH on the native chain from a confirmed bridge lock.
   * @param {string}        to              – ANKH recipient address
   * @param {number|string} amount
   * @param {string}        lockTxHash      – The lock transaction hash on the source chain
   */
  async bridgeRelease(to, amount, lockTxHash, opts = {}) {
    const from = opts.from || to;
    if (this._privKey || this._signer) {
      const nonce = opts.nonce ?? (await this.getAccount(from)).nonce;
      const tx    = await _buildTx({
        type: _TYPES.BRIDGE_RELEASE,
        from, to,
        value: AnkhSDK.parseAmount(amount),
        nonce,
        data: { lockTxHash, releaseTimestamp: Date.now() }
      }, this._privKey);
      if (this._signer && !this._privKey) {
        const msgHash = await _sha256(tx.hash);
        tx.signature  = await this._signer(msgHash);
      }
      return this._post('/api/v1/transactions', tx);
    }
    return this._post('/api/v1/bridge/release', { to, amount, lockTxHash });
  }

  // ════════════════════════════════════════════════════════════════
  //  Reserve wallets
  // ════════════════════════════════════════════════════════════════

  /**
   * Release funds from a named reserve wallet.
   * The reserve wallet's private key must be set via setPrivateKey() first.
   *
   * @param {object} params
   * @param {string}   params.reserveAddress   – Reserve wallet ankh_ address
   * @param {string}   params.toAddress        – Destination address
   * @param {string|number} params.amount      – ANKH amount
   * @param {string}   params.reserveType      – 'main'|'foundation'|'development'|'ecosystem'|'emergency'
   * @param {string}   params.reason           – Human-readable reason (recorded on-chain)
   */
  async releaseReserve(params) {
    const { reserveAddress, toAddress, amount, reserveType, reason } = params;
    if (this._privKey || this._signer) {
      const nonce = (await this.getAccount(reserveAddress)).nonce;
      const value = AnkhSDK.parseAmount(amount);
      const tx    = await _buildTx({
        type: _TYPES.RESERVE_RELEASE,
        from: reserveAddress, to: toAddress, value, nonce,
        data: { reserveType, reason }
      }, this._privKey);
      if (this._signer && !this._privKey) {
        const msgHash = await _sha256(tx.hash);
        tx.signature  = await this._signer(msgHash);
      }
      return this._post('/api/v1/transactions', tx);
    }
    throw new Error('releaseReserve requires a private key. Call setPrivateKey(reserveWalletPrivKey) first.');
  }

  // ════════════════════════════════════════════════════════════════
  //  Verification
  // ════════════════════════════════════════════════════════════════

  /**
   * Check biometric verification status for an address.
   * @returns {Promise<{ isVerified, verificationId?, registrationTimestamp?, ageVerification? }>}
   */
  getVerificationStatus(address) {
    return this._get(`/api/v1/verify/${address}/status`);
  }

  /**
   * Submit biometric data for verification.
   * Normally handled by the frontend biometric capture UI, but exposed here
   * for programmatic testing or third-party integrations.
   *
   * @param {string} address           – Wallet address to verify
   * @param {object} biometricData     – { facial: { sequence: [ { type, timestamp, score } ] } }
   *   sequence must contain >= 5 items, include 'center' and 'blink' types
   * @returns {Promise<{ address, verified, verificationProof }>}
   */
  verify(address, biometricData) {
    return this._post('/api/v1/verify', { address, biometricData });
  }

  // ════════════════════════════════════════════════════════════════
  //  Validators
  // ════════════════════════════════════════════════════════════════

  /** All validators. */
  getValidators() {
    return this._get('/api/v1/validators');
  }

  /**
   * Top validators by stake.
   * @param {number} [count=21]
   */
  getTopValidators(count = 21) {
    return this._get(`/api/v1/validators/top?count=${count}`);
  }

  // ════════════════════════════════════════════════════════════════
  //  Chain / Blocks
  // ════════════════════════════════════════════════════════════════

  /** Genesis configuration. */
  getGenesis() {
    return this._get('/api/v1/genesis');
  }

  /** Chain configuration — useful for SDK bootstrapping in external wallets. */
  getChainConfig() {
    return this._get('/api/v1/chain-config');
  }

  /** Live chain info (height, stateRoot, activeValidators, …). */
  getChainInfo() {
    return this._get('/api/v1/info');
  }

  /** Aggregate statistics. */
  getStats() {
    return this._get('/api/v1/stats');
  }

  /** Node health check. */
  getHealth() {
    return this._get('/health');
  }

  /** Latest block. */
  getLatestBlock() {
    return this._get('/api/v1/blocks/latest');
  }

  /**
   * Block by index or hash.
   * @param {number|string} indexOrHash
   */
  getBlock(indexOrHash) {
    return this._get(`/api/v1/blocks/${indexOrHash}`);
  }

  /**
   * Multiple blocks (paginated).
   * @param {number} [limit=10]
   * @param {number} [offset=0]
   */
  getBlocks(limit = 10, offset = 0) {
    return this._get(`/api/v1/blocks?limit=${limit}&offset=${offset}`);
  }

  // ════════════════════════════════════════════════════════════════
  //  Network / Peg
  // ════════════════════════════════════════════════════════════════

  /** Connected P2P peers. */
  getNetworkPeers() {
    return this._get('/api/v1/network/peers');
  }

  /** USD peg status. */
  getPegStatus() {
    return this._get('/api/v1/peg/status');
  }

  /**
   * Historical peg price data.
   * @param {number} [limit=100]
   */
  getPegHistory(limit = 100) {
    return this._get(`/api/v1/peg/history?limit=${limit}`);
  }

  // ════════════════════════════════════════════════════════════════
  //  WebSocket  (real-time events)
  // ════════════════════════════════════════════════════════════════

  /**
   * Open a persistent WebSocket to the node.
   * Auto-reconnects unless autoReconnect: false.
   *
   * Events: 'NEW_BLOCK' | 'NEW_TRANSACTION' | 'USER_VERIFIED' | 'UBI_CLAIMED' |
   *         'TRANSFER'  | 'TOKEN_CREATED'   | 'connect'       | 'disconnect' | '*'
   *
   * @returns {Promise<void>}  resolves once connection is open
   */
  connect() {
    const wsUrl = this.nodeUrl.replace(/^http/, 'ws');
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        this._ws      = ws;
        this._wsReady = true;
        this._emit('connect', {});
        resolve();
      };

      ws.onerror = err => {
        if (!this._wsReady) reject(err);
        this._emit('error', err);
      };

      ws.onmessage = event => {
        try {
          const msg = JSON.parse(event.data);
          this._emit(msg.type, msg);
          this._emit('*', msg);
        } catch { /* ignore malformed */ }
      };

      ws.onclose = () => {
        this._wsReady = false;
        this._emit('disconnect', {});
        if (this.autoReconnect) {
          setTimeout(() => this.connect().catch(() => {}), this.reconnectDelayMs);
        }
      };
    });
  }

  /** Close the WebSocket (disables auto-reconnect). */
  disconnect() {
    this.autoReconnect = false;
    if (this._ws) { this._ws.close(); this._ws = null; }
  }

  /**
   * Subscribe to a named channel on the WebSocket server.
   * @param {string} channel  – e.g. 'blocks', 'transactions', 'ubi'
   */
  subscribe(channel) {
    if (!this._wsReady) throw new Error('Not connected. Call connect() first.');
    this._ws.send(JSON.stringify({ type: 'SUBSCRIBE', channel }));
  }

  /**
   * Unsubscribe from a channel.
   * @param {string} channel
   */
  unsubscribe(channel) {
    if (!this._wsReady) return;
    this._ws.send(JSON.stringify({ type: 'UNSUBSCRIBE', channel }));
  }

  /** Send a WebSocket PING to keep the connection alive. */
  ping() {
    if (!this._wsReady) return;
    this._ws.send(JSON.stringify({ type: 'PING' }));
  }

  /**
   * Subscribe to a chain event.  Returns an unsubscribe function.
   *
   * @param   {string}   eventType  – Event name or '*' for all
   * @param   {Function} handler    – Called with the event payload
   * @returns {Function}              Call to unsubscribe
   *
   * @example
   *   const unsub = sdk.on('NEW_BLOCK', b => console.log(b.index));
   *   unsub();
   */
  on(eventType, handler) {
    if (!this._listeners.has(eventType)) this._listeners.set(eventType, new Set());
    this._listeners.get(eventType).add(handler);
    return () => this.off(eventType, handler);
  }

  /** Unsubscribe a specific handler. */
  off(eventType, handler) {
    this._listeners.get(eventType)?.delete(handler);
  }

  // ════════════════════════════════════════════════════════════════
  //  Internals
  // ════════════════════════════════════════════════════════════════

  _emit(type, payload) {
    this._listeners.get(type)?.forEach(fn => {
      try { fn(payload); } catch { /* don't let one listener crash others */ }
    });
  }

  async _get(path) {
    const res  = await fetch(`${this.nodeUrl}${path}`);
    const json = await res.json();
    if (!json.success && json.error) throw new Error(json.error);
    return json.data ?? json;
  }

  async _post(path, body) {
    const res  = await fetch(`${this.nodeUrl}${path}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body)
    });
    const json = await res.json();
    if (!json.success && json.error) throw new Error(json.error);
    return json.data ?? json;
  }
}

// ════════════════════════════════════════════════════════════════
//  AnkhWallet  — convenience class that binds an address + key to an SDK
// ════════════════════════════════════════════════════════════════

/**
 * Convenience class for single-wallet applications.
 * All methods default to `this.address` without needing to pass it each time.
 *
 * @example
 *   const sdk    = new AnkhSDK({ nodeUrl: 'http://localhost:3001' });
 *   const wallet = new AnkhWallet(sdk, 'ankh_abc...', 'privateKeyHex');
 *
 *   await wallet.connect();          // opens WebSocket
 *   const bal = await wallet.getBalance();
 *   await wallet.send('ankh_xyz...', 100);
 *   await wallet.stake(10000);
 *   await wallet.claimUBI();
 *   wallet.on('TRANSFER', tx => console.log('Received', tx.amount));
 */
class AnkhWallet {
  /**
   * @param {AnkhSDK} sdk
   * @param {string}  address     – ankh_… address
   * @param {string}  [privateKey] – hex private key (enables signed transactions)
   */
  constructor(sdk, address, privateKey) {
    this.sdk     = sdk;
    this.address = address;
    if (privateKey) sdk.setPrivateKey(privateKey);
  }

  // ── Queries ────────────────────────────────────────────────────

  /** @returns {Promise<{ address, raw, formatted }>} */
  getBalance()                      { return this.sdk.getBalance(this.address); }

  /** @returns {Promise<object>}  Full account state */
  getAccount()                      { return this.sdk.getAccount(this.address); }

  /** @returns {Promise<Array>}   Recent transactions */
  getTransactions(limit = 20)       { return this.sdk.getTransactions(this.address, limit); }

  /** @returns {Promise<object>}  UBI status */
  getUBIStatus()                    { return this.sdk.getUBIStatus(this.address); }

  /** @returns {Promise<object>}  Verification status */
  getVerificationStatus()           { return this.sdk.getVerificationStatus(this.address); }

  // ── Actions ───────────────────────────────────────────────────

  /**
   * Send ANKH.
   * @param {string}        to
   * @param {number|string} amount
   */
  send(to, amount, opts)            { return this.sdk.send(this.address, to, amount, opts); }

  /**
   * Stake ANKH.
   * @param {number|string} amount
   * @param {string}        [validatorAddress]
   */
  stake(amount, validatorAddress)   { return this.sdk.stake(this.address, amount, validatorAddress); }

  /**
   * Start unstaking.
   * @param {number|string} [amount]
   */
  unstake(amount)                   { return this.sdk.unstake(this.address, amount); }

  /** Claim monthly UBI. */
  claimUBI()                        { return this.sdk.claimUBI(this.address); }

  /**
   * Create an ARC-20 subtoken (creator defaults to this wallet).
   * @param {object} params  – see sdk.createToken() docs
   */
  createToken(params)               { return this.sdk.createToken({ ...params, creator: this.address }); }

  /**
   * Transfer ARC-20 tokens.
   * @param {string}        tokenAddress
   * @param {string}        to
   * @param {number|string} amount
   */
  transferToken(tokenAddress, to, amount, opts) {
    return this.sdk.transferToken(tokenAddress, this.address, to, amount, opts);
  }

  /**
   * Propose a sidechain (creator defaults to this wallet).
   * @param {object} params  – see sdk.proposeSidechain() docs
   */
  proposeSidechain(params)          { return this.sdk.proposeSidechain({ ...params, creator: this.address }); }

  /**
   * Submit a governance proposal.
   * @param {object} proposal  – { title, description, type, params? }
   */
  proposeGovernance(proposal, opts) { return this.sdk.proposeGovernance(this.address, proposal, opts); }

  /**
   * Vote on a governance proposal.
   * @param {string} proposalId
   * @param {string} vote  'YES' | 'NO' | 'ABSTAIN'
   */
  voteGovernance(proposalId, vote)  { return this.sdk.voteGovernance(this.address, proposalId, vote); }
  getGovernanceProposals(status)    { return this.sdk.getGovernanceProposals(status); }
  getGovernanceProposal(id)         { return this.sdk.getGovernanceProposal(id); }

  /**
   * Bridge: lock ANKH to send to Ethereum.
   * @param {number|string} amount
   * @param {string}        ethAddress  – Ethereum recipient
   */
  bridgeLock(amount, ethAddress, opts) {
    return this.sdk.bridgeLock(this.address, amount, 'ethereum', ethAddress, opts);
  }

  // ── WebSocket passthrough ──────────────────────────────────────

  connect()                          { return this.sdk.connect(); }
  disconnect()                       { return this.sdk.disconnect(); }
  on(event, handler)                 { return this.sdk.on(event, handler); }
  off(event, handler)                { return this.sdk.off(event, handler); }
}

// ════════════════════════════════════════════════════════════════
//  Static helpers  (no SDK instance needed)
// ════════════════════════════════════════════════════════════════

/**
 * Format a raw wei balance (BigInt or string) as human-readable ANKH.
 * @param   {string|bigint} raw  – balance in wei (18 decimals)
 * @param   {number}  [dp=4]     – decimal places
 * @returns {string}               e.g. "5,185.1852 ANKH"
 */
AnkhSDK.formatBalance = function (raw, dp = 4) {
  const n = Number(BigInt(raw)) / 1e18;
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }) + ' ANKH';
};

/**
 * Parse a human-readable ANKH amount to a raw wei string.
 * @param   {number|string} ankh  – e.g. 5185.19 or "100"
 * @returns {string}               raw wei string (18 decimals)
 */
AnkhSDK.parseAmount = function (ankh) {
  return String(BigInt(Math.round(Number(ankh) * 1e18)));
};

/**
 * Generate a random ANKH address (no private key — watch-only / testing).
 * @returns {string}  ankh_…
 */
AnkhSDK.generateRandomAddress = function () {
  return 'ankh_' + _bytesToHex(_randomBytes32()).substring(0, 40);
};

/** Expose the transaction type constants. */
AnkhSDK.TX_TYPES = _TYPES;

/** Expose secp256k1 primitives for advanced use. */
AnkhSDK.crypto = {
  publicKeyFromPrivate: privHex => _secp.publicKeyFromPrivate(privHex),
  sign:                 (msgHashHex, privHex) => _secp.sign(msgHashHex, privHex),
  sha256:               data => _sha256(data),
  hexToBytes:           _hexToBytes,
  bytesToHex:           _bytesToHex,
  randomBytes32:        _randomBytes32
};

// ── Export ───────────────────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  // Default export is AnkhSDK for backward compatibility: const AnkhSDK = require('./ankh-sdk')
  // Named exports also available:  const { AnkhWallet } = require('./ankh-sdk')
  module.exports = AnkhSDK;
  module.exports.AnkhSDK  = AnkhSDK;
  module.exports.AnkhWallet = AnkhWallet;
}
