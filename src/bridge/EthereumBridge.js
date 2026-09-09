/**
 * Ethereum Bridge
 *
 * Bridges the native Ankh Chain with the Ethereum derivative (ANKH).
 * Enables two-way token transfers between chains.
 */

const crypto = require('crypto');
const EventEmitter = require('events');
const GenesisConfig = require('../core/GenesisConfig');

class EthereumBridge extends EventEmitter {
  constructor(stateManager, blockchain) {
    super();

    this.stateManager = stateManager;
    this.blockchain = blockchain;

    // Bridge configuration
    this.config = {
      ethChainId: GenesisConfig.BRIDGE.ETH_CHAIN_ID,
      confirmationBlocks: GenesisConfig.BRIDGE.CONFIRMATION_BLOCKS,
      minBridgeAmount: GenesisConfig.BRIDGE.MIN_BRIDGE_AMOUNT,
      bridgeFeePercent: GenesisConfig.BRIDGE.BRIDGE_FEE_PERCENT
    };

    // Bridge state
    this.pendingDeposits = new Map();   // lockId -> deposit info
    this.pendingWithdrawals = new Map(); // withdrawalId -> withdrawal info
    this.completedTransfers = new Map();

    // Validators for multi-sig
    this.validators = new Set();
    this.requiredSignatures = 2;

    // Statistics
    this.stats = {
      totalDeposits: 0,
      totalWithdrawals: 0,
      totalVolume: 0n,
      totalFees: 0n
    };
  }

  /**
   * Add bridge validator
   */
  addValidator(address) {
    this.validators.add(address);
    return Array.from(this.validators);
  }

  /**
   * Remove bridge validator
   */
  removeValidator(address) {
    this.validators.delete(address);
    return Array.from(this.validators);
  }

  // ============================================
  // Native → Ethereum (Lock & Mint)
  // ============================================

  /**
   * Initiate lock on native chain (to mint ANKH on Ethereum)
   */
  async initiateLock(from, amount, ethTargetAddress) {
    amount = BigInt(amount);

    // Validate amount
    if (amount < this.config.minBridgeAmount) {
      throw new Error(`Minimum bridge amount is ${this.config.minBridgeAmount}`);
    }

    // Validate sender balance
    const balance = this.stateManager.getBalance(from);
    if (balance < amount) {
      throw new Error('Insufficient balance');
    }

    // Calculate fee
    const fee = (amount * BigInt(Math.floor(this.config.bridgeFeePercent * 10000))) / 10000n;
    const netAmount = amount - fee;

    // Lock tokens
    this.stateManager.updateBalance(from, -amount);

    const lockId = crypto.randomUUID();

    const deposit = {
      lockId,
      from,
      amount: amount.toString(),
      fee: fee.toString(),
      netAmount: netAmount.toString(),
      ethTargetAddress,
      status: 'PENDING',
      signatures: [],
      createdAt: Date.now(),
      expiresAt: Date.now() + (24 * 60 * 60 * 1000) // 24 hours
    };

    this.pendingDeposits.set(lockId, deposit);

    this.emit('LockInitiated', {
      lockId,
      from,
      amount: amount.toString(),
      ethTargetAddress
    });

    return deposit;
  }

  /**
   * Canonical message a validator signs to approve minting against a lock.
   *
   * Every field that determines where value goes is bound into the message, so
   * a signature cannot be lifted from one lock and replayed against another
   * with a different recipient or amount.
   */
  static lockMessage(deposit) {
    return JSON.stringify({
      action: 'BRIDGE_LOCK',
      lockId: deposit.lockId,
      from: deposit.from,
      amount: deposit.amount,
      netAmount: deposit.netAmount,
      ethTargetAddress: deposit.ethTargetAddress
    });
  }

  /** Canonical message a validator signs to approve a withdrawal release. */
  static withdrawalMessage(withdrawal) {
    return JSON.stringify({
      action: 'BRIDGE_WITHDRAWAL',
      withdrawalId: withdrawal.withdrawalId,
      ethTxHash: withdrawal.ethTxHash,
      from: withdrawal.from,
      amount: withdrawal.amount,
      ankhTargetAddress: withdrawal.ankhTargetAddress
    });
  }

  /**
   * Verify a bridge validator's signature over a canonical message.
   *
   * Both sign paths previously did no cryptographic verification at all: they
   * confirmed the *address* was in the validator set and then stored whatever
   * `signature` value the caller supplied, counting it toward the threshold.
   * Anyone able to reach the method could therefore accumulate the full quorum
   * by naming validators and passing arbitrary bytes — the multisig protected
   * nothing. The signature must prove that this validator authorized this
   * specific operation.
   */
  _verifyValidatorSignature(validatorAddress, message, signature) {
    const ActionAuth = require('../core/ActionAuth');
    if (!signature || typeof signature !== 'object') {
      return { valid: false, reason: 'Signature must be an object {publicKey, r, s}' };
    }
    // ActionAuth.verify also confirms the public key derives to this exact
    // validator address, so one validator cannot sign as another.
    return ActionAuth.verify(validatorAddress, message, signature);
  }

  /**
   * Sign lock (by validator)
   */
  signLock(lockId, validatorAddress, signature) {
    if (!this.validators.has(validatorAddress)) {
      throw new Error('Not a valid bridge validator');
    }

    const deposit = this.pendingDeposits.get(lockId);
    if (!deposit) throw new Error('Lock not found');
    if (deposit.status !== 'PENDING') throw new Error('Lock already processed');

    // Check if already signed by this validator
    if (deposit.signatures.some(s => s.validator === validatorAddress)) {
      throw new Error('Already signed by this validator');
    }

    const check = this._verifyValidatorSignature(
      validatorAddress, EthereumBridge.lockMessage(deposit), signature
    );
    if (!check.valid) {
      throw new Error(`Invalid bridge signature: ${check.reason}`);
    }

    deposit.signatures.push({
      validator: validatorAddress,
      signature,
      timestamp: Date.now()
    });

    // Check if enough signatures
    if (deposit.signatures.length >= this.requiredSignatures) {
      deposit.status = 'READY_FOR_MINT';
      deposit.readyAt = Date.now();

      this.emit('LockReady', {
        lockId,
        signatures: deposit.signatures.length,
        ethTargetAddress: deposit.ethTargetAddress,
        netAmount: deposit.netAmount
      });
    }

    return deposit;
  }

  /**
   * Confirm mint on Ethereum (called after ANKH minted)
   */
  confirmMint(lockId, ethTxHash) {
    const deposit = this.pendingDeposits.get(lockId);
    if (!deposit) throw new Error('Lock not found');

    deposit.status = 'COMPLETED';
    deposit.ethTxHash = ethTxHash;
    deposit.completedAt = Date.now();

    this.completedTransfers.set(lockId, deposit);
    this.pendingDeposits.delete(lockId);

    // Update stats
    this.stats.totalDeposits++;
    this.stats.totalVolume += BigInt(deposit.amount);
    this.stats.totalFees += BigInt(deposit.fee);

    this.emit('MintConfirmed', {
      lockId,
      ethTxHash,
      amount: deposit.netAmount
    });

    return deposit;
  }

  // ============================================
  // Ethereum → Native (Burn & Release)
  // ============================================

  /**
   * Supply an independent verifier that proves an Ethereum burn actually
   * happened before native ANKH is released against it.
   *
   * The verifier receives {ethTxHash, from, amount, ankhTargetAddress} and must
   * resolve to {valid, reason?} having established, against Ethereum itself,
   * that the transaction exists, succeeded, burned this amount of ANKH to the
   * expected contract, and has enough confirmations.
   *
   * @param {(claim: object) => Promise<{valid: boolean, reason?: string}>} verifier
   */
  setEthereumVerifier(verifier) {
    if (typeof verifier !== 'function') throw new Error('Verifier must be a function');
    this._ethereumVerifier = verifier;
  }

  /**
   * Process burn event from Ethereum (to release ANKH on native).
   *
   * This method used to accept the claim on trust: given an ethTxHash, a from
   * address and an amount, it created a pending withdrawal without establishing
   * that the Ethereum transaction existed, succeeded, burned that amount, burned
   * ANKH specifically, went to the right contract, had confirmations, or had not
   * already been redeemed. Anyone able to call it could mint native ANKH by
   * naming a plausible transaction hash.
   *
   * There is no Ethereum light client here yet, so rather than approximate one,
   * the untrusted path is closed: without a configured verifier this throws.
   * Replay is prevented independently by recording each redeemed ethTxHash.
   */
  async processBurnEvent(ethTxHash, from, amount, ankhTargetAddress) {
    amount = BigInt(amount);

    if (!ethTxHash || typeof ethTxHash !== 'string') {
      throw new Error('A valid Ethereum transaction hash is required');
    }

    // Replay protection: one burn, one release, ever.
    const redeemed = this.stateManager?.processedBridgeLocks;
    if (redeemed?.has(ethTxHash)) {
      throw new Error(`Ethereum transaction ${ethTxHash} has already been redeemed`);
    }

    if (typeof this._ethereumVerifier !== 'function') {
      throw new Error(
        'Refusing to release ANKH: no Ethereum burn verifier is configured. ' +
        'Burn claims cannot be accepted on trust — call setEthereumVerifier() with a ' +
        'verifier that independently proves the burn against Ethereum.'
      );
    }

    const proof = await this._ethereumVerifier({ ethTxHash, from, amount, ankhTargetAddress });
    if (!proof?.valid) {
      throw new Error(`Ethereum burn could not be verified: ${proof?.reason || 'unknown reason'}`);
    }

    // Mark redeemed before creating the withdrawal so a concurrent duplicate
    // claim for the same hash cannot slip through behind this one.
    redeemed?.add(ethTxHash);

    const withdrawalId = crypto.randomUUID();

    const withdrawal = {
      withdrawalId,
      ethTxHash,
      from, // Ethereum address
      amount: amount.toString(),
      ankhTargetAddress,
      status: 'PENDING',
      signatures: [],
      createdAt: Date.now()
    };

    this.pendingWithdrawals.set(withdrawalId, withdrawal);

    this.emit('BurnReceived', {
      withdrawalId,
      ethTxHash,
      amount: amount.toString(),
      ankhTargetAddress
    });

    return withdrawal;
  }

  /**
   * Sign withdrawal (by validator)
   */
  signWithdrawal(withdrawalId, validatorAddress, signature) {
    if (!this.validators.has(validatorAddress)) {
      throw new Error('Not a valid bridge validator');
    }

    const withdrawal = this.pendingWithdrawals.get(withdrawalId);
    if (!withdrawal) throw new Error('Withdrawal not found');
    if (withdrawal.status !== 'PENDING') throw new Error('Withdrawal already processed');

    if (withdrawal.signatures.some(s => s.validator === validatorAddress)) {
      throw new Error('Already signed by this validator');
    }

    const wCheck = this._verifyValidatorSignature(
      validatorAddress, EthereumBridge.withdrawalMessage(withdrawal), signature
    );
    if (!wCheck.valid) {
      throw new Error(`Invalid bridge signature: ${wCheck.reason}`);
    }

    withdrawal.signatures.push({
      validator: validatorAddress,
      signature,
      timestamp: Date.now()
    });

    // Check if enough signatures
    if (withdrawal.signatures.length >= this.requiredSignatures) {
      this.executeRelease(withdrawalId);
    }

    return withdrawal;
  }

  /**
   * Execute release of tokens on native chain
   */
  executeRelease(withdrawalId) {
    const withdrawal = this.pendingWithdrawals.get(withdrawalId);
    if (!withdrawal) throw new Error('Withdrawal not found');

    const amount = BigInt(withdrawal.amount);

    // Credit tokens on native chain
    this.stateManager.updateBalance(withdrawal.ankhTargetAddress, amount);

    withdrawal.status = 'COMPLETED';
    withdrawal.completedAt = Date.now();

    this.completedTransfers.set(withdrawalId, withdrawal);
    this.pendingWithdrawals.delete(withdrawalId);

    // Update stats
    this.stats.totalWithdrawals++;
    this.stats.totalVolume += amount;

    this.emit('ReleaseCompleted', {
      withdrawalId,
      amount: withdrawal.amount,
      ankhTargetAddress: withdrawal.ankhTargetAddress
    });

    return withdrawal;
  }

  // ============================================
  // Query Methods
  // ============================================

  /**
   * Get pending deposits
   */
  getPendingDeposits() {
    return Array.from(this.pendingDeposits.values());
  }

  /**
   * Get pending withdrawals
   */
  getPendingWithdrawals() {
    return Array.from(this.pendingWithdrawals.values());
  }

  /**
   * Get transfer by ID
   */
  getTransfer(id) {
    return this.pendingDeposits.get(id) ||
      this.pendingWithdrawals.get(id) ||
      this.completedTransfers.get(id);
  }

  /**
   * Get bridge statistics
   */
  getStats() {
    return {
      ...this.stats,
      totalVolume: this.stats.totalVolume.toString(),
      totalFees: this.stats.totalFees.toString(),
      pendingDeposits: this.pendingDeposits.size,
      pendingWithdrawals: this.pendingWithdrawals.size,
      completedTransfers: this.completedTransfers.size,
      validators: this.validators.size
    };
  }

  /**
   * Get bridge configuration
   */
  getConfig() {
    return {
      ...this.config,
      minBridgeAmount: this.config.minBridgeAmount.toString(),
      requiredSignatures: this.requiredSignatures,
      validators: Array.from(this.validators)
    };
  }

  // ============================================
  // Cleanup
  // ============================================

  /**
   * Clean up expired locks
   */
  cleanupExpiredLocks() {
    const now = Date.now();
    const expired = [];

    for (const [lockId, deposit] of this.pendingDeposits) {
      if (deposit.expiresAt < now && deposit.status === 'PENDING') {
        // Refund locked tokens
        this.stateManager.updateBalance(deposit.from, BigInt(deposit.amount));
        deposit.status = 'EXPIRED';
        expired.push(lockId);

        this.emit('LockExpired', { lockId, from: deposit.from });
      }
    }

    // Remove expired
    for (const lockId of expired) {
      this.pendingDeposits.delete(lockId);
    }

    return expired.length;
  }
}

module.exports = EthereumBridge;
