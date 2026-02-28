/**
 * Ankh Chain Block
 *
 * Represents a single block in the Ankh blockchain.
 * Supports both DPoS (main chain) and PoA (sidechains) consensus.
 */

const crypto = require('crypto');

class Block {
  constructor({
    index,
    timestamp,
    transactions,
    previousHash,
    validator,
    validatorSignature,
    stateRoot,
    transactionsRoot,
    receiptsRoot,
    consensusType = 'DPOS',
    sidechainId = null,
    extraData = {}
  }) {
    this.version = 1;
    this.index = index;
    this.timestamp = timestamp || Date.now();
    this.transactions = transactions || [];
    this.previousHash = previousHash;
    this.validator = validator;                    // Address of block producer
    this.validatorSignature = validatorSignature;  // Signature proving validator produced block
    this.stateRoot = stateRoot || this.calculateStateRoot();
    this.transactionsRoot = transactionsRoot || this.calculateTransactionsRoot();
    this.receiptsRoot = receiptsRoot || null;
    this.consensusType = consensusType;            // 'DPOS' or 'POA'
    this.sidechainId = sidechainId;                // null for main chain
    this.extraData = extraData;                    // Additional metadata
    this.hash = this.calculateHash();
  }

  /**
   * Calculate block hash
   */
  calculateHash() {
    const data = JSON.stringify({
      version: this.version,
      index: this.index,
      timestamp: this.timestamp,
      transactionsRoot: this.transactionsRoot,
      previousHash: this.previousHash,
      validator: this.validator,
      stateRoot: this.stateRoot,
      consensusType: this.consensusType,
      sidechainId: this.sidechainId,
      extraData: this.extraData
    });

    return '0x' + crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Calculate Merkle root of transactions
   */
  calculateTransactionsRoot() {
    if (this.transactions.length === 0) {
      return '0x' + crypto.createHash('sha256').update('empty').digest('hex');
    }

    const hashes = this.transactions.map(tx =>
      typeof tx.hash === 'string' ? tx.hash : tx.calculateHash?.() || JSON.stringify(tx)
    );

    return this.buildMerkleRoot(hashes);
  }

  /**
   * Calculate state root (simplified - would be Patricia trie in production)
   */
  calculateStateRoot() {
    // In production, this would be a Patricia Merkle Trie root
    // For now, we hash the transaction effects
    const stateChanges = this.transactions.map(tx => ({
      from: tx.from,
      to: tx.to,
      value: tx.value?.toString(),
      type: tx.type
    }));

    return '0x' + crypto.createHash('sha256')
      .update(JSON.stringify(stateChanges))
      .digest('hex');
  }

  /**
   * Build Merkle root from array of hashes
   */
  buildMerkleRoot(hashes) {
    if (hashes.length === 0) return null;
    if (hashes.length === 1) return hashes[0];

    const nextLevel = [];
    for (let i = 0; i < hashes.length; i += 2) {
      const left = hashes[i];
      const right = hashes[i + 1] || left; // Duplicate last if odd
      const combined = crypto.createHash('sha256')
        .update(left + right)
        .digest('hex');
      nextLevel.push('0x' + combined);
    }

    return this.buildMerkleRoot(nextLevel);
  }

  /**
   * Verify block integrity
   */
  isValid() {
    // Check hash matches
    if (this.hash !== this.calculateHash()) {
      return { valid: false, reason: 'Invalid block hash' };
    }

    // Check transactions root
    if (this.transactionsRoot !== this.calculateTransactionsRoot()) {
      return { valid: false, reason: 'Invalid transactions root' };
    }

    // Check timestamp is reasonable
    const now = Date.now();
    const fiveMinutes = 5 * 60 * 1000;
    if (this.timestamp > now + fiveMinutes) {
      return { valid: false, reason: 'Block timestamp too far in future' };
    }

    return { valid: true };
  }

  /**
   * Sign block as validator
   */
  sign(privateKey) {
    const EC = require('elliptic').ec;
    const ec = new EC('secp256k1');
    const keyPair = ec.keyFromPrivate(privateKey, 'hex');

    const messageHash = crypto.createHash('sha256')
      .update(this.hash)
      .digest('hex');

    const signature = keyPair.sign(messageHash);
    this.validatorSignature = {
      r: signature.r.toString('hex'),
      s: signature.s.toString('hex'),
      recoveryParam: signature.recoveryParam
    };

    return this.validatorSignature;
  }

  /**
   * Verify validator signature
   */
  verifySignature(publicKey) {
    if (!this.validatorSignature) return false;

    try {
      const EC = require('elliptic').ec;
      const ec = new EC('secp256k1');
      const key = ec.keyFromPublic(publicKey, 'hex');

      const messageHash = crypto.createHash('sha256')
        .update(this.hash)
        .digest('hex');

      return key.verify(messageHash, this.validatorSignature);
    } catch (error) {
      return false;
    }
  }

  /**
   * Get block size in bytes
   */
  getSize() {
    return Buffer.byteLength(JSON.stringify(this), 'utf8');
  }

  /**
   * Serialize block for storage/transmission
   */
  toJSON() {
    return {
      version: this.version,
      index: this.index,
      timestamp: this.timestamp,
      hash: this.hash,
      previousHash: this.previousHash,
      validator: this.validator,
      validatorSignature: this.validatorSignature,
      stateRoot: this.stateRoot,
      transactionsRoot: this.transactionsRoot,
      receiptsRoot: this.receiptsRoot,
      consensusType: this.consensusType,
      sidechainId: this.sidechainId,
      transactions: this.transactions.map(tx => tx.toJSON?.() || tx),
      extraData: this.extraData
    };
  }

  /**
   * Deserialize block from JSON
   */
  static fromJSON(json) {
    const Transaction = require('./Transaction');

    return new Block({
      index: json.index,
      timestamp: json.timestamp,
      transactions: json.transactions.map(tx => Transaction.fromJSON(tx)),
      previousHash: json.previousHash,
      validator: json.validator,
      validatorSignature: json.validatorSignature,
      stateRoot: json.stateRoot,
      transactionsRoot: json.transactionsRoot,
      receiptsRoot: json.receiptsRoot,
      consensusType: json.consensusType,
      sidechainId: json.sidechainId,
      extraData: json.extraData
    });
  }

  /**
   * Create genesis block
   */
  static createGenesis(config) {
    const GenesisConfig = require('./GenesisConfig');

    return new Block({
      index: 0,
      timestamp: config?.timestamp || GenesisConfig.GENESIS_TIMESTAMP,
      transactions: [],
      previousHash: GenesisConfig.GENESIS_HASH,
      validator: 'genesis',
      validatorSignature: null,
      consensusType: 'GENESIS',
      extraData: {
        chainId: GenesisConfig.CHAIN_ID,
        chainName: GenesisConfig.CHAIN_NAME,
        version: GenesisConfig.CHAIN_VERSION,
        maxPopulation: GenesisConfig.MAX_GLOBAL_POPULATION.toString(),
        lifetimeValue: GenesisConfig.LIFETIME_VALUE_USD.toString(),
        message: 'Ankh Chain Genesis - Universal Basic Income for Humanity'
      }
    });
  }
}

module.exports = Block;
