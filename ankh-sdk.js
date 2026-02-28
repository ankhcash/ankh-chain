/**
 * ANKH Chain SDK  v1.0.0
 *
 * Zero-dependency browser/Node.js SDK for building wallets and apps on ANKH Chain.
 * Works in any modern browser (no bundler needed) or Node.js via require/import.
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
 * ─── Wallet generation ─────────────────────────────────────────────────────────
 *
 *   // Option A: server-assisted (easiest, good for demos)
 *   const wallet = await sdk.generateWallet();
 *   // → { address: 'ankh_...', publicKey: '04...', privateKey: '...' }
 *   // Store privateKey securely — the node does NOT keep it.
 *
 *   // Option B: fully client-side (recommended for production)
 *   // Use noble-secp256k1 or elliptic.js to generate a keypair, then:
 *   const address = await sdk.deriveAddress(publicKeyHex);
 *
 * ─── Balance & transactions ────────────────────────────────────────────────────
 *
 *   const { raw, formatted } = await sdk.getBalance(wallet.address);
 *   // → { raw: '5185185200000000000000', formatted: '5185.1852 ANKH' }
 *
 *   const txs = await sdk.getTransactions(wallet.address);
 *   // → [{ hash, type, from, to, value, direction: 'IN'|'OUT', blockIndex, … }]
 *
 * ─── Sending ANKH ──────────────────────────────────────────────────────────────
 *
 *   // Trusted-node path — no private key required in the request
 *   await sdk.send(wallet.address, 'ankh_recipient...', 100);   // 100 ANKH
 *   await sdk.send(wallet.address, 'ankh_recipient...', '0.5'); // 0.5 ANKH
 *
 * ─── UBI ───────────────────────────────────────────────────────────────────────
 *
 *   const status = await sdk.getUBIStatus(wallet.address);
 *   // → { canClaim, monthsClaimed, nextClaimAvailable, monthlyAmount, … }
 *   if (status.canClaim) {
 *     const result = await sdk.claimUBI(wallet.address);
 *     console.log('Claimed', result.amount, 'ANKH');
 *   }
 *
 * ─── Real-time events ──────────────────────────────────────────────────────────
 *
 *   await sdk.connect();   // open WebSocket
 *
 *   sdk.on('NEW_BLOCK',    block => console.log('Block', block.index));
 *   sdk.on('TRANSFER',     tx    => { if (tx.to === myAddress) notifyUser(tx); });
 *   sdk.on('USER_VERIFIED', ev   => console.log('New user verified', ev.address));
 *   sdk.on('UBI_CLAIMED',   ev   => console.log('UBI claimed by',    ev.address));
 *   // sdk.on('*', msg => …) subscribes to all event types
 *
 *   // Each sdk.on() returns an unsubscribe function:
 *   const unsub = sdk.on('NEW_BLOCK', handler);
 *   unsub(); // stop listening
 *
 * ─── Chain & token queries ─────────────────────────────────────────────────────
 *
 *   const config  = await sdk.getChainConfig();   // address format, chain ID, …
 *   const block   = await sdk.getLatestBlock();
 *   const tokens  = await sdk.getTokens();
 *   const balance = await sdk.getTokenBalance(tokenAddress, holderAddress);
 *
 * ─── WebSocket events reference ────────────────────────────────────────────────
 *
 *   CONNECTED         — initial handshake      { chainId, height }
 *   NEW_BLOCK         — new block committed    { index, hash, timestamp, transactionCount, consensusType, validator }
 *   NEW_TRANSACTION   — tx added to mempool    { hash, type, from, to }
 *   USER_VERIFIED     — user biometric reg     { address, verificationId, blockIndex, blockHash }
 *   UBI_CLAIMED       — UBI disbursement       { address, amount, blockIndex, blockHash }
 *   TRANSFER          — ANKH transfer          { from, to, amount, blockIndex, blockHash }
 *
 * ─── Address format ────────────────────────────────────────────────────────────
 *
 *   'ankh_' + first-40-hex-chars-of-SHA256(uncompressed-secp256k1-public-key)
 *   Example: ankh_3a9f2c1d8e7b4f0a6c5d2e1f8a9b0c3d4e5f6a7b
 *
 * ─── Submitting pre-signed transactions ───────────────────────────────────────
 *
 *   Use POST /api/v1/transactions with a signed Transaction JSON object.
 *   The node verifies the secp256k1 signature (ECDSA on secp256k1, SHA256 of tx hash).
 *   Transaction schema: { type, from, to, value, fee, nonce, data, signature, timestamp }
 *   Signature schema:   { r, s, recoveryParam }
 */

/* global fetch, WebSocket, module */

class AnkhSDK {
  /**
   * @param {object}  options
   * @param {string}  [options.nodeUrl='http://localhost:3001']  – Base URL of the ANKH node
   * @param {boolean} [options.autoReconnect=true]              – Auto-reconnect WebSocket on close
   * @param {number}  [options.reconnectDelayMs=3000]           – Reconnect delay in ms
   */
  constructor({ nodeUrl = 'http://localhost:3001', autoReconnect = true, reconnectDelayMs = 3000 } = {}) {
    this.nodeUrl = nodeUrl.replace(/\/$/, '');
    this.autoReconnect = autoReconnect;
    this.reconnectDelayMs = reconnectDelayMs;

    this._ws = null;
    this._wsReady = false;
    this._listeners = new Map();
  }

  // ════════════════════════════════════════════════════════════════
  //  Wallet
  // ════════════════════════════════════════════════════════════════

  /**
   * Generate a new ANKH wallet keypair via the node.
   * The node returns the keypair but does NOT store the private key.
   * Store `privateKey` securely (encrypted localStorage, hardware wallet, etc.).
   *
   * For production use, generate the keypair client-side with noble-secp256k1:
   *   https://github.com/paulmillr/noble-secp256k1
   *
   * @returns {Promise<{ address: string, publicKey: string, privateKey: string }>}
   */
  generateWallet() {
    return this._post('/api/v1/wallet/generate', {});
  }

  /**
   * Derive an ANKH address from an uncompressed secp256k1 public key (hex).
   * Use this when you generate the keypair client-side.
   *
   * @param   {string} publicKeyHex  – 130-char hex (04 + X + Y)
   * @returns {Promise<string>}        ankh_... address
   */
  async deriveAddress(publicKeyHex) {
    const data = await this._get(`/api/v1/wallet/derive?publicKey=${publicKeyHex}`);
    return data.address;
  }

  // ════════════════════════════════════════════════════════════════
  //  Account
  // ════════════════════════════════════════════════════════════════

  /**
   * Get ANKH balance for an address.
   * @returns {Promise<{ address: string, raw: string, formatted: string }>}
   *   raw = balance in wei (18 decimals),  formatted = "X.XXXX ANKH"
   */
  async getBalance(address) {
    const d = await this._get(`/api/v1/accounts/${address}/balance`);
    return { address: d.address, raw: d.balance, formatted: d.balanceFormatted };
  }

  /**
   * Get full account state (balance, nonce, isVerified, stakedAmount, …)
   * @returns {Promise<object>}
   */
  getAccount(address) {
    return this._get(`/api/v1/accounts/${address}`);
  }

  /**
   * Get recent transactions for an address.
   * @param   {string} address
   * @param   {number} [limit=20]  – max 100
   * @returns {Promise<Array<{hash, type, from, to, value, fee, timestamp, blockIndex, blockHash, direction}>>}
   *   direction: 'IN' | 'OUT'
   */
  getTransactions(address, limit = 20) {
    return this._get(`/api/v1/accounts/${address}/transactions?limit=${limit}`);
  }

  // ════════════════════════════════════════════════════════════════
  //  Transfers
  // ════════════════════════════════════════════════════════════════

  /**
   * Send ANKH to another address (trusted-node path — no client signature needed).
   * The node verifies the sender has sufficient balance and commits the transfer.
   *
   * @param   {string}        from    – Sender ankh_ address
   * @param   {string}        to      – Recipient ankh_ address
   * @param   {number|string} amount  – Amount in ANKH (decimal) or wei (integer string)
   * @returns {Promise<{ txHash, blockIndex, blockHash, from, to, amount, amountFormatted }>}
   */
  send(from, to, amount) {
    return this._post('/api/v1/send', { from, to, amount });
  }

  /**
   * Submit a pre-signed transaction (self-sovereign wallet path).
   * Sign the transaction client-side with the sender's secp256k1 private key
   * before calling this method.
   *
   * Transaction JSON format:
   *   { type, from, to, value, fee, nonce, data, signature: { r, s, recoveryParam }, timestamp }
   *
   * @param   {object} signedTx  – Fully-signed transaction object
   * @returns {Promise<{ hash: string }>}
   */
  submitTransaction(signedTx) {
    return this._post('/api/v1/transactions', signedTx);
  }

  // ════════════════════════════════════════════════════════════════
  //  UBI
  // ════════════════════════════════════════════════════════════════

  /**
   * Get UBI status for a verified user.
   * @returns {Promise<{ canClaim, monthsClaimed, nextClaimAvailable, monthlyAmount, status, … }>}
   */
  getUBIStatus(address) {
    return this._get(`/api/v1/ubi/${address}/status`);
  }

  /**
   * Claim the monthly UBI disbursement.
   * User must be biometrically verified first.
   * @returns {Promise<{ amount, blockIndex, blockHash, … }>}
   */
  claimUBI(address) {
    return this._post(`/api/v1/ubi/${address}/claim`, {});
  }

  /** Global UBI distribution statistics */
  getUBIStats() {
    return this._get('/api/v1/ubi/stats');
  }

  // ════════════════════════════════════════════════════════════════
  //  Chain
  // ════════════════════════════════════════════════════════════════

  /**
   * Chain configuration — useful for SDK initialisation in external wallets.
   * Returns: chainId, chainName, addressPrefix, cryptoCurve, signatureAlgorithm,
   *          consensusType, blockTime, nativeToken, nativeDecimals, apiVersion, …
   */
  getChainConfig() {
    return this._get('/api/v1/chain-config');
  }

  /** Live chain info (height, stateRoot, activeValidators, …) */
  getChainInfo() {
    return this._get('/api/v1/info');
  }

  /** Aggregate statistics */
  getStats() {
    return this._get('/api/v1/stats');
  }

  /** Latest block */
  getLatestBlock() {
    return this._get('/api/v1/blocks/latest');
  }

  /**
   * Get block by index or hash.
   * @param {number|string} indexOrHash
   */
  getBlock(indexOrHash) {
    return this._get(`/api/v1/blocks/${indexOrHash}`);
  }

  /**
   * Get multiple blocks.
   * @param {number} [limit=10]
   * @param {number} [offset=0]
   */
  getBlocks(limit = 10, offset = 0) {
    return this._get(`/api/v1/blocks?limit=${limit}&offset=${offset}`);
  }

  // ════════════════════════════════════════════════════════════════
  //  Verification
  // ════════════════════════════════════════════════════════════════

  /**
   * Check whether an address has completed biometric verification.
   * @returns {Promise<{ isVerified, verificationId?, registrationTimestamp?, ageVerification? }>}
   */
  getVerificationStatus(address) {
    return this._get(`/api/v1/verify/${address}/status`);
  }

  // ════════════════════════════════════════════════════════════════
  //  Tokens (ARC-20)
  // ════════════════════════════════════════════════════════════════

  /** List all tokens on the chain */
  getTokens() {
    return this._get('/api/v1/tokens');
  }

  /**
   * Get token info by contract address or symbol.
   * @param {string} identifier – token address or symbol
   */
  getToken(identifier) {
    return this._get(`/api/v1/tokens/${identifier}`);
  }

  /**
   * Get token balance for a holder.
   * @param {string} tokenAddress
   * @param {string} holderAddress
   */
  getTokenBalance(tokenAddress, holderAddress) {
    return this._get(`/api/v1/tokens/${tokenAddress}/balance/${holderAddress}`);
  }

  /** Token tier requirements and stake amounts */
  getTokenTiers() {
    return this._get('/api/v1/tokens/tiers');
  }

  // ════════════════════════════════════════════════════════════════
  //  Validators
  // ════════════════════════════════════════════════════════════════

  /** List active validators */
  getValidators() {
    return this._get('/api/v1/validators');
  }

  /**
   * Get top validators by stake.
   * @param {number} [count=21]
   */
  getTopValidators(count = 21) {
    return this._get(`/api/v1/validators/top?count=${count}`);
  }

  // ════════════════════════════════════════════════════════════════
  //  Sidechains
  // ════════════════════════════════════════════════════════════════

  /** List all registered sidechains */
  getSidechains() {
    return this._get('/api/v1/sidechains');
  }

  /**
   * Get sidechain details.
   * @param {string} chainId
   */
  getSidechain(chainId) {
    return this._get(`/api/v1/sidechains/${chainId}`);
  }

  // ════════════════════════════════════════════════════════════════
  //  Network
  // ════════════════════════════════════════════════════════════════

  /** Connected P2P peers and network stats */
  getNetworkPeers() {
    return this._get('/api/v1/network/peers');
  }

  /** USD peg status */
  getPegStatus() {
    return this._get('/api/v1/peg/status');
  }

  // ════════════════════════════════════════════════════════════════
  //  WebSocket (real-time events)
  // ════════════════════════════════════════════════════════════════

  /**
   * Open a persistent WebSocket connection to the node.
   * Auto-reconnects on disconnect (unless autoReconnect: false).
   *
   * Events: 'NEW_BLOCK', 'NEW_TRANSACTION', 'USER_VERIFIED', 'UBI_CLAIMED', 'TRANSFER', '*'
   *
   * @returns {Promise<void>}  resolves once the connection is open
   */
  connect() {
    const wsUrl = this.nodeUrl.replace(/^http/, 'ws');

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        this._ws = ws;
        this._wsReady = true;
        this._emit('connect', {});
        resolve();
      };

      ws.onerror = (err) => {
        if (!this._wsReady) reject(err);
        this._emit('error', err);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this._emit(msg.type, msg);
          this._emit('*', msg);
        } catch { /* ignore malformed messages */ }
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

  /** Close the WebSocket connection (disables auto-reconnect). */
  disconnect() {
    this.autoReconnect = false;
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  /**
   * Subscribe to a chain event.
   *
   * @param   {string}   eventType  – Event name or '*' for all events
   * @param   {Function} handler    – Called with the event payload
   * @returns {Function}              Unsubscribe function
   *
   * @example
   *   const unsub = sdk.on('NEW_BLOCK', block => console.log(block.index));
   *   unsub(); // stop listening
   */
  on(eventType, handler) {
    if (!this._listeners.has(eventType)) {
      this._listeners.set(eventType, new Set());
    }
    this._listeners.get(eventType).add(handler);
    return () => this.off(eventType, handler);
  }

  /**
   * Unsubscribe a handler.
   * @param {string}   eventType
   * @param {Function} handler
   */
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
    const res = await fetch(`${this.nodeUrl}${path}`);
    const json = await res.json();
    if (!json.success && json.error) throw new Error(json.error);
    return json.data ?? json;
  }

  async _post(path, body) {
    const res = await fetch(`${this.nodeUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const json = await res.json();
    if (!json.success && json.error) throw new Error(json.error);
    return json.data ?? json;
  }
}

// ════════════════════════════════════════════════════════════════
//  Static helpers (no SDK instance needed)
// ════════════════════════════════════════════════════════════════

/**
 * Generate a random ANKH address (no private key).
 * Useful for watch-only wallets or testing.
 * @returns {string}  ankh_... address
 */
AnkhSDK.generateRandomAddress = function () {
  const bytes = new Uint8Array(20);
  const c = (typeof globalThis !== 'undefined' && globalThis.crypto)
    ? globalThis.crypto
    : require('crypto').webcrypto;
  c.getRandomValues(bytes);
  return 'ankh_' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
};

/**
 * Format a raw wei balance (BigInt string) as human-readable ANKH.
 * @param   {string|bigint} raw  – balance in wei (18 decimals)
 * @param   {number} [dp=4]      – decimal places
 * @returns {string}               e.g. "5,185.1852 ANKH"
 */
AnkhSDK.formatBalance = function (raw, dp = 4) {
  const n = Number(BigInt(raw)) / 1e18;
  return n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }) + ' ANKH';
};

/**
 * Parse a human-readable ANKH amount to raw wei string.
 * @param   {number|string} ankh  – e.g. 5185.19
 * @returns {string}               raw wei string
 */
AnkhSDK.parseAmount = function (ankh) {
  return String(BigInt(Math.round(Number(ankh) * 1e18)));
};

// ── Export ──────────────────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AnkhSDK;
}
