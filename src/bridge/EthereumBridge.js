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
   * Process burn event from Ethereum (to release ANKH on native)
   */
  processBurnEvent(ethTxHash, from, amount, ankhTargetAddress) {
    amount = BigInt(amount);

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
