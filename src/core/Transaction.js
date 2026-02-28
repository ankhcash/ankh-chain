/**
 * Ankh Chain Transaction
 *
 * Represents all transaction types in the Ankh blockchain:
 * - TRANSFER: Standard ANKH transfers
 * - UBI_CLAIM: Monthly UBI claims
 * - BIOMETRIC_REGISTRATION: New user verification
 * - TOKEN_CREATE: ARC-20/721 token creation
 * - TOKEN_TRANSFER: Sub-token transfers
 * - STAKE: Validator staking
 * - UNSTAKE: Validator unstaking
 * - GOVERNANCE_VOTE: Governance participation
 * - SIDECHAIN_CREATE: Institutional sidechain creation
 * - BRIDGE_LOCK: Lock tokens for bridge to ETH
 * - BRIDGE_RELEASE: Release tokens from ETH bridge
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

class Transaction {
  // Transaction Types
  static TYPES = {
    TRANSFER: 'TRANSFER',
    UBI_CLAIM: 'UBI_CLAIM',
    BIOMETRIC_REGISTRATION: 'BIOMETRIC_REGISTRATION',
    TOKEN_CREATE: 'TOKEN_CREATE',
    TOKEN_TRANSFER: 'TOKEN_TRANSFER',
    TOKEN_MINT: 'TOKEN_MINT',
    TOKEN_BURN: 'TOKEN_BURN',
    STAKE: 'STAKE',
    UNSTAKE: 'UNSTAKE',
    GOVERNANCE_PROPOSE: 'GOVERNANCE_PROPOSE',
    GOVERNANCE_VOTE: 'GOVERNANCE_VOTE',
    SIDECHAIN_CREATE: 'SIDECHAIN_CREATE',
    SIDECHAIN_ANCHOR: 'SIDECHAIN_ANCHOR',
    BRIDGE_LOCK: 'BRIDGE_LOCK',
    BRIDGE_RELEASE: 'BRIDGE_RELEASE',
    CONTRACT_DEPLOY: 'CONTRACT_DEPLOY',
    CONTRACT_CALL: 'CONTRACT_CALL',
    AGE_VERIFICATION: 'AGE_VERIFICATION'
  };

  constructor({
    type,
    from,
    to,
    value,
    fee,
    nonce,
    data,
    signature,
    timestamp,
    id
  }) {
    this.id = id || uuidv4();
    this.type = type;
    this.from = from;                  // Sender address
    this.to = to;                      // Recipient address (or contract)
    this.value = BigInt(value || 0);   // Amount in ANKH (wei equivalent)
    this.fee = BigInt(fee || 0);       // Transaction fee
    this.nonce = nonce || 0;           // Sender's transaction count
    this.data = data || {};            // Type-specific payload
    this.signature = signature || null;
    this.timestamp = timestamp || Date.now();
    this.hash = this.calculateHash();
  }

  /**
   * Calculate transaction hash
   */
  calculateHash() {
    const hashData = {
      type: this.type,
      from: this.from,
      to: this.to,
      value: this.value.toString(),
      fee: this.fee.toString(),
      nonce: this.nonce,
      data: this.data,
      timestamp: this.timestamp
    };

    return '0x' + crypto.createHash('sha256')
      .update(JSON.stringify(hashData))
      .digest('hex');
  }

  /**
   * Sign transaction with private key
   */
  sign(privateKey) {
    const EC = require('elliptic').ec;
    const ec = new EC('secp256k1');
    const keyPair = ec.keyFromPrivate(privateKey, 'hex');

    const messageHash = crypto.createHash('sha256')
      .update(this.hash)
      .digest('hex');

    const signature = keyPair.sign(messageHash);
    this.signature = {
      r: signature.r.toString('hex'),
      s: signature.s.toString('hex'),
      recoveryParam: signature.recoveryParam
    };

    return this.signature;
  }

  /**
   * Verify transaction signature
   */
  verifySignature() {
    if (!this.signature || !this.from) return false;

    // System transactions don't need signatures
    if (this.from === 'system' || this.from === 'genesis') return true;

    try {
      const EC = require('elliptic').ec;
      const ec = new EC('secp256k1');

      const messageHash = crypto.createHash('sha256')
        .update(this.hash)
        .digest('hex');

      // Recover public key from signature
      const signature = {
        r: this.signature.r,
        s: this.signature.s,
        recoveryParam: this.signature.recoveryParam
      };

      const publicKey = ec.recoverPubKey(
        Buffer.from(messageHash, 'hex'),
        signature,
        signature.recoveryParam
      );

      // Verify the recovered address matches 'from'
      const recoveredAddress = this.publicKeyToAddress(publicKey.encode('hex'));
      return recoveredAddress === this.from;
    } catch (error) {
      return false;
    }
  }

  /**
   * Convert public key to address
   */
  publicKeyToAddress(publicKey) {
    const hash = crypto.createHash('sha256')
      .update(Buffer.from(publicKey, 'hex'))
      .digest('hex');

    return 'ankh_' + hash.substring(0, 40);
  }

  /**
   * Validate transaction based on type
   */
  validate() {
    // Basic validation
    if (!this.type || !Transaction.TYPES[this.type]) {
      return { valid: false, reason: 'Invalid transaction type' };
    }

    if (!this.from) {
      return { valid: false, reason: 'Missing sender address' };
    }

    if (this.value < 0n) {
      return { valid: false, reason: 'Negative value not allowed' };
    }

    if (this.fee < 0n) {
      return { valid: false, reason: 'Negative fee not allowed' };
    }

    // Type-specific validation
    switch (this.type) {
      case Transaction.TYPES.TRANSFER:
        return this.validateTransfer();

      case Transaction.TYPES.UBI_CLAIM:
        return this.validateUBIClaim();

      case Transaction.TYPES.BIOMETRIC_REGISTRATION:
        return this.validateBiometricRegistration();

      case Transaction.TYPES.TOKEN_CREATE:
        return this.validateTokenCreate();

      case Transaction.TYPES.STAKE:
      case Transaction.TYPES.UNSTAKE:
        return this.validateStaking();

      default:
        return { valid: true };
    }
  }

  validateTransfer() {
    if (!this.to) {
      return { valid: false, reason: 'Missing recipient address' };
    }
    if (this.value <= 0n) {
      return { valid: false, reason: 'Transfer value must be positive' };
    }
    return { valid: true };
  }

  validateUBIClaim() {
    if (!this.data.verificationId) {
      return { valid: false, reason: 'Missing verification ID for UBI claim' };
    }
    if (!this.data.claimMonth) {
      return { valid: false, reason: 'Missing claim month' };
    }
    return { valid: true };
  }

  validateBiometricRegistration() {
    if (!this.data.biometricHash) {
      return { valid: false, reason: 'Missing biometric hash' };
    }
    if (!this.data.ageVerification) {
      return { valid: false, reason: 'Missing age verification' };
    }
    return { valid: true };
  }

  validateTokenCreate() {
    if (!this.data.name || !this.data.symbol) {
      return { valid: false, reason: 'Missing token name or symbol' };
    }
    if (!this.data.tier) {
      return { valid: false, reason: 'Missing token tier' };
    }
    return { valid: true };
  }

  validateStaking() {
    if (this.value <= 0n) {
      return { valid: false, reason: 'Stake amount must be positive' };
    }
    return { valid: true };
  }

  /**
   * Get total cost (value + fee)
   */
  getTotalCost() {
    return this.value + this.fee;
  }

  /**
   * Serialize for storage/transmission
   */
  toJSON() {
    return {
      id: this.id,
      type: this.type,
      from: this.from,
      to: this.to,
      value: this.value.toString(),
      fee: this.fee.toString(),
      nonce: this.nonce,
      data: this.data,
      signature: this.signature,
      timestamp: this.timestamp,
      hash: this.hash
    };
  }

  /**
   * Deserialize from JSON
   */
  static fromJSON(json) {
    return new Transaction({
      id: json.id,
      type: json.type,
      from: json.from,
      to: json.to,
      value: json.value,
      fee: json.fee,
      nonce: json.nonce,
      data: json.data,
      signature: json.signature,
      timestamp: json.timestamp
    });
  }

  // ============================================
  // Factory Methods for Common Transaction Types
  // ============================================

  /**
   * Create a transfer transaction
   */
  static createTransfer(from, to, value, fee, nonce) {
    return new Transaction({
      type: Transaction.TYPES.TRANSFER,
      from,
      to,
      value,
      fee,
      nonce
    });
  }

  /**
   * Create a UBI claim transaction
   */
  static createUBIClaim(from, verificationId, claimMonth, amount, fee, nonce) {
    return new Transaction({
      type: Transaction.TYPES.UBI_CLAIM,
      from,
      to: from, // UBI goes to self
      value: amount,
      fee,
      nonce,
      data: {
        verificationId,
        claimMonth,
        claimType: 'MONTHLY_UBI'
      }
    });
  }

  /**
   * Create biometric registration transaction
   */
  static createBiometricRegistration(address, biometricData, ageVerification, fee, nonce) {
    return new Transaction({
      type: Transaction.TYPES.BIOMETRIC_REGISTRATION,
      from: address,
      to: 'system',
      value: 0n,
      fee,
      nonce,
      data: {
        biometricHash: biometricData.hash,
        biometricTemplateHash: biometricData.templateHash,
        ageVerification: {
          estimatedAge: ageVerification.estimatedAge,
          confidenceScore: ageVerification.confidenceScore,
          method: ageVerification.method,
          timestamp: Date.now()
        },
        livenessScore: biometricData.livenessScore,
        qualityScore: biometricData.qualityScore
      }
    });
  }

  /**
   * Create token creation transaction
   */
  static createTokenCreation(from, tokenParams, stake, fee, nonce) {
    return new Transaction({
      type: Transaction.TYPES.TOKEN_CREATE,
      from,
      to: 'token_factory',
      value: stake,
      fee,
      nonce,
      data: {
        name: tokenParams.name,
        symbol: tokenParams.symbol,
        decimals: tokenParams.decimals || 18,
        initialSupply: tokenParams.initialSupply?.toString() || '0',
        maxSupply: tokenParams.maxSupply?.toString() || null,
        tier: tokenParams.tier,
        mintable: tokenParams.mintable || false,
        burnable: tokenParams.burnable || false,
        pausable: tokenParams.pausable || false,
        metadata: tokenParams.metadata || {}
      }
    });
  }

  /**
   * Create staking transaction
   */
  static createStake(from, amount, validatorAddress, fee, nonce) {
    return new Transaction({
      type: Transaction.TYPES.STAKE,
      from,
      to: validatorAddress || 'staking_contract',
      value: amount,
      fee,
      nonce,
      data: {
        action: 'DELEGATE',
        validator: validatorAddress
      }
    });
  }

  /**
   * Create sidechain creation transaction
   */
  static createSidechain(from, sidechainParams, stake, fee, nonce) {
    return new Transaction({
      type: Transaction.TYPES.SIDECHAIN_CREATE,
      from,
      to: 'sidechain_factory',
      value: stake,
      fee,
      nonce,
      data: {
        name: sidechainParams.name,
        chainId: sidechainParams.chainId,
        consensusType: 'POA',
        authorities: sidechainParams.authorities,
        blockTime: sidechainParams.blockTime || 1000,
        nativeCurrency: sidechainParams.nativeCurrency,
        institutionType: sidechainParams.institutionType, // 'government', 'organization', etc.
        metadata: sidechainParams.metadata || {}
      }
    });
  }

  /**
   * Create bridge lock transaction
   */
  static createBridgeLock(from, amount, targetChain, targetAddress, fee, nonce) {
    return new Transaction({
      type: Transaction.TYPES.BRIDGE_LOCK,
      from,
      to: 'bridge_contract',
      value: amount,
      fee,
      nonce,
      data: {
        targetChain,
        targetAddress,
        lockTimestamp: Date.now()
      }
    });
  }
}

module.exports = Transaction;
