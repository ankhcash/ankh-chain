/**
 * Ankh Native Blockchain
 *
 * The core blockchain implementation with hybrid DPoS/PoA consensus.
 * Manages block production, validation, and chain state.
 */

const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const EventEmitter = require('events');
const Block = require('./Block');
const Transaction = require('./Transaction');
const StateManager = require('./StateManager');
const GenesisConfig = require('./GenesisConfig');

class AnkhBlockchain extends EventEmitter {
  constructor(options = {}) {
    super();

    this.chain = [];
    this.pendingTransactions = [];
    this.stateManager = new StateManager(options.dataDir || './data');

    // Consensus state
    this.currentEpoch = 0;
    this.currentSlot = 0;
    this.activeValidators = [];
    this.validatorSchedule = [];

    // Configuration
    this.dataDir = options.dataDir || './data';
    this.chainFile = path.join(this.dataDir, 'chain.json');

    // Block production
    this.isProducingBlocks = false;
    this.blockProductionInterval = null;
    this.lastBlockTime = 0;

    // Transaction pool limits
    this.maxPendingTransactions = GenesisConfig.NETWORK.TRANSACTION_POOL_SIZE;
  }

  /**
   * Initialize the blockchain
   */
  async initialize() {
    await fs.mkdir(this.dataDir, { recursive: true });
    await this.stateManager.initialize();
    await this.loadChain();

    if (this.chain.length === 0) {
      const genesis = Block.createGenesis();
      this.chain.push(genesis);
      await this.saveChain();
    }

    // Update validators from state
    this.activeValidators = this.stateManager.getTopValidators();

    return this;
  }

  // ============================================
  // Chain Management
  // ============================================

  /**
   * Get latest block
   */
  getLatestBlock() {
    return this.chain[this.chain.length - 1];
  }

  /**
   * Get block by index
   */
  getBlockByIndex(index) {
    return this.chain[index];
  }

  /**
   * Get block by hash
   */
  getBlockByHash(hash) {
    return this.chain.find(block => block.hash === hash);
  }

  /**
   * Get chain height
   */
  getHeight() {
    return this.chain.length - 1;
  }

  /**
   * Get chain info
   */
  getChainInfo() {
    const latest = this.getLatestBlock();
    return {
      chainId: GenesisConfig.CHAIN_ID,
      chainName: GenesisConfig.CHAIN_NAME,
      height: this.getHeight(),
      latestBlockHash: latest.hash,
      latestBlockTime: latest.timestamp,
      pendingTransactions: this.pendingTransactions.length,
      activeValidators: this.activeValidators.length,
      currentEpoch: this.currentEpoch,
      stateRoot: this.stateManager.stateRoot
    };
  }

  // ============================================
  // Transaction Management
  // ============================================

  /**
   * Add transaction to pending pool
   */
  addTransaction(transaction) {
    // Validate transaction
    const validation = transaction.validate();
    if (!validation.valid) {
      throw new Error(`Invalid transaction: ${validation.reason}`);
    }

    // Verify signature (unless system transaction)
    if (transaction.from !== 'system' && !transaction.verifySignature()) {
      throw new Error('Invalid transaction signature');
    }

    // Check nonce
    const account = this.stateManager.getAccount(transaction.from);
    if (transaction.nonce !== account.nonce) {
      throw new Error(`Invalid nonce: expected ${account.nonce}, got ${transaction.nonce}`);
    }

    // Check balance for transfers
    if (transaction.value > 0n || transaction.fee > 0n) {
      const total = transaction.getTotalCost();
      if (account.balance < total) {
        throw new Error(`Insufficient balance: has ${account.balance}, needs ${total}`);
      }
    }

    // Check pool size
    if (this.pendingTransactions.length >= this.maxPendingTransactions) {
      throw new Error('Transaction pool full');
    }

    // Check for duplicate
    if (this.pendingTransactions.find(tx => tx.hash === transaction.hash)) {
      throw new Error('Duplicate transaction');
    }

    this.pendingTransactions.push(transaction);
    this.emit('transaction', transaction);

    return transaction.hash;
  }

  /**
   * Get pending transactions for block
   */
  getPendingTransactions(limit = 1000) {
    // Sort by fee (highest first) then by timestamp
    return this.pendingTransactions
      .sort((a, b) => {
        const feeDiff = b.fee - a.fee;
        if (feeDiff !== 0n) return feeDiff > 0n ? 1 : -1;
        return a.timestamp - b.timestamp;
      })
      .slice(0, limit);
  }

  /**
   * Remove transactions that are in a block
   */
  removeTransactions(transactions) {
    const hashes = new Set(transactions.map(tx => tx.hash));
    this.pendingTransactions = this.pendingTransactions.filter(
      tx => !hashes.has(tx.hash)
    );
  }

  // ============================================
  // Block Production (DPoS)
  // ============================================

  /**
   * Create new block
   */
  createBlock(validatorAddress, validatorPrivateKey) {
    const transactions = this.getPendingTransactions();
    const previousBlock = this.getLatestBlock();

    const block = new Block({
      index: previousBlock.index + 1,
      timestamp: Date.now(),
      transactions,
      previousHash: previousBlock.hash,
      validator: validatorAddress,
      consensusType: 'DPOS'
    });

    // Sign the block
    if (validatorPrivateKey) {
      block.sign(validatorPrivateKey);
    }

    return block;
  }

  /**
   * Add block to chain
   */
  async addBlock(block) {
    // Validate block
    const validation = this.validateBlock(block);
    if (!validation.valid) {
      throw new Error(`Invalid block: ${validation.reason}`);
    }

    // Execute transactions and update state
    for (const tx of block.transactions) {
      await this.executeTransaction(tx);
    }

    // Add to chain
    this.chain.push(block);
    this.stateManager.stats.currentBlockHeight = block.index;
    this.stateManager.stats.totalTransactions += block.transactions.length;

    // Remove executed transactions from pool
    this.removeTransactions(block.transactions);

    // Release any stake whose unbonding period has matured
    this.stateManager.processMaturedUnbondings();

    // Calculate new state root
    this.stateManager.calculateStateRoot();

    // Save state
    await Promise.all([
      this.saveChain(),
      this.stateManager.saveState()
    ]);

    // Update epoch if needed
    if (block.index % GenesisConfig.CONSENSUS.DPOS.EPOCH_LENGTH === 0) {
      this.currentEpoch++;
      this.updateValidatorSchedule();
    }

    this.emit('block', block);

    return block;
  }

  /**
   * Commit a system-initiated block immediately.
   *
   * Used for protocol-level operations (biometric registration, UBI claims) that
   * originate from the node itself rather than from user-signed transactions.
   * Bypasses DPoS validator requirements — these blocks use consensusType: 'SYSTEM'.
   *
   * On-chain proof: each verification/claim is permanently recorded in the chain
   * and synced to peers via P2P block propagation, giving cryptographic proof
   * of who was verified and when.
   *
   * @param {Transaction[]} transactions  - Already-constructed Transaction objects
   * @returns {{ block: Block, receipts: Array }}
   */
  async commitSystemBlock(transactions) {
    const previousBlock = this.getLatestBlock();
    const receipts = [];

    // Execute each transaction (updates stateManager in-place).
    // executeTransaction catches internal errors into receipt.status = 'FAILED'.
    // We re-throw here so the API route gets a proper error response.
    for (const tx of transactions) {
      const receipt = await this.executeTransaction(tx);
      receipts.push(receipt);
      if (receipt.status === 'FAILED') {
        throw new Error(receipt.error || 'System transaction execution failed');
      }
    }

    const block = new Block({
      index: previousBlock.index + 1,
      timestamp: Date.now(),
      transactions,
      previousHash: previousBlock.hash,
      validator: 'system',
      consensusType: 'SYSTEM'
    });

    this.chain.push(block);
    this.stateManager.stats.currentBlockHeight = block.index;
    this.stateManager.stats.totalTransactions += transactions.length;

    this.removeTransactions(transactions);

    // Release any stake whose unbonding period has matured
    this.stateManager.processMaturedUnbondings();

    this.stateManager.calculateStateRoot();

    await Promise.all([
      this.saveChain(),
      this.stateManager.saveState()
    ]);

    this.emit('block', block);
    return { block, receipts };
  }

  /**
   * Validate block
   */
  validateBlock(block) {
    // Check block integrity
    const blockValidation = block.isValid();
    if (!blockValidation.valid) {
      return blockValidation;
    }

    // Check previous hash
    const previousBlock = this.getLatestBlock();
    if (block.previousHash !== previousBlock.hash) {
      return { valid: false, reason: 'Invalid previous hash' };
    }

    // Check block index
    if (block.index !== previousBlock.index + 1) {
      return { valid: false, reason: 'Invalid block index' };
    }

    // Check timestamp
    if (block.timestamp <= previousBlock.timestamp) {
      return { valid: false, reason: 'Block timestamp must be after previous block' };
    }

    // Allow SYSTEM blocks — node-initiated protocol operations (registration, UBI claims)
    // These are self-authorized and bypass DPoS validator requirements.
    if (block.consensusType === 'SYSTEM') {
      return { valid: true };
    }

    // Check validator (DPoS)
    if (block.consensusType === 'DPOS') {
      const isActiveValidator = this.activeValidators.some(
        v => v.address === block.validator
      );
      // When no validators are registered yet, allow any producer (bootstrapping)
      if (!isActiveValidator && this.activeValidators.length > 0 && block.validator !== 'genesis') {
        return { valid: false, reason: 'Block producer is not an active validator' };
      }
    }

    // Validate all transactions
    for (const tx of block.transactions) {
      const txValidation = tx.validate();
      if (!txValidation.valid) {
        return { valid: false, reason: `Invalid transaction: ${txValidation.reason}` };
      }
    }

    return { valid: true };
  }

  /**
   * Update validator schedule for new epoch
   */
  updateValidatorSchedule() {
    this.activeValidators = this.stateManager.getTopValidators();

    // Create round-robin schedule
    this.validatorSchedule = [];
    const slotsPerEpoch = GenesisConfig.CONSENSUS.DPOS.EPOCH_LENGTH;

    for (let i = 0; i < slotsPerEpoch; i++) {
      const validatorIndex = i % this.activeValidators.length;
      this.validatorSchedule.push(this.activeValidators[validatorIndex]?.address);
    }

    this.emit('epochChange', {
      epoch: this.currentEpoch,
      validators: this.activeValidators.map(v => v.address)
    });
  }

  /**
   * Get current block producer
   */
  getCurrentBlockProducer() {
    const slotInEpoch = this.getHeight() % GenesisConfig.CONSENSUS.DPOS.EPOCH_LENGTH;
    return this.validatorSchedule[slotInEpoch];
  }

  /**
   * Start block production
   */
  startBlockProduction(validatorAddress, validatorPrivateKey) {
    if (this.isProducingBlocks) return;

    this.isProducingBlocks = true;
    const blockTime = GenesisConfig.CONSENSUS.DPOS.BLOCK_TIME_MS;

    this.blockProductionInterval = setInterval(async () => {
      const currentProducer = this.getCurrentBlockProducer();

      // Only produce if it's our turn
      if (currentProducer === validatorAddress || this.activeValidators.length === 0) {
        try {
          const block = this.createBlock(validatorAddress, validatorPrivateKey);
          if (block.transactions.length > 0 || Date.now() - this.lastBlockTime > blockTime * 10) {
            await this.addBlock(block);
            this.lastBlockTime = Date.now();
          }
        } catch (error) {
          this.emit('error', error);
        }
      }
    }, blockTime);
  }

  /**
   * Stop block production
   */
  stopBlockProduction() {
    this.isProducingBlocks = false;
    if (this.blockProductionInterval) {
      clearInterval(this.blockProductionInterval);
      this.blockProductionInterval = null;
    }
  }

  // ============================================
  // Transaction Execution
  // ============================================

  /**
   * Execute transaction and update state
   */
  async executeTransaction(tx) {
    const receipt = {
      transactionHash: tx.hash,
      blockNumber: this.getHeight() + 1,
      status: 'SUCCESS',
      gasUsed: 0n,
      logs: []
    };

    try {
      switch (tx.type) {
        case Transaction.TYPES.TRANSFER:
          await this.executeTransfer(tx);
          break;

        case Transaction.TYPES.UBI_CLAIM:
          await this.executeUBIClaim(tx);
          break;

        case Transaction.TYPES.BIOMETRIC_REGISTRATION:
          await this.executeBiometricRegistration(tx);
          break;

        case Transaction.TYPES.TOKEN_CREATE:
          await this.executeTokenCreate(tx);
          break;

        case Transaction.TYPES.TOKEN_TRANSFER:
          await this.executeTokenTransfer(tx);
          break;

        case Transaction.TYPES.STAKE:
          await this.executeStake(tx);
          break;

        case Transaction.TYPES.UNSTAKE:
          await this.executeUnstake(tx);
          break;

        case Transaction.TYPES.SIDECHAIN_CREATE:
          await this.executeSidechainCreate(tx);
          break;

        case Transaction.TYPES.BRIDGE_LOCK:
          await this.executeBridgeLock(tx);
          break;

        default:
          // Generic transaction - just deduct fee
          if (tx.fee > 0n) {
            this.stateManager.updateBalance(tx.from, -tx.fee);
          }
      }

      // Increment nonce
      this.stateManager.incrementNonce(tx.from);

    } catch (error) {
      receipt.status = 'FAILED';
      receipt.error = error.message;
    }

    return receipt;
  }

  async executeTransfer(tx) {
    this.stateManager.transfer(tx.from, tx.to, tx.value, tx.fee);
  }

  async executeUBIClaim(tx) {
    const result = this.stateManager.processUBIClaim(tx.from);

    // Deduct fee if any
    if (tx.fee > 0n) {
      this.stateManager.updateBalance(tx.from, -tx.fee);
    }

    return result;
  }

  async executeBiometricRegistration(tx) {
    const { biometricHash, biometricTemplateHash, descriptor, ageVerification, livenessScore, qualityScore } = tx.data;

    // Check duplicate
    if (this.stateManager.isBiometricRegistered(biometricHash)) {
      throw new Error('Biometric already registered');
    }

    // Validate age
    const ageCheck = GenesisConfig.isAgeEligible(
      ageVerification.estimatedAge,
      ageVerification.confidenceScore
    );

    if (!ageCheck.eligible) {
      if (ageCheck.needsReview) {
        // Add to pending reviews
        this.stateManager.addPendingReview(tx.from, {
          hash: biometricHash,
          templateHash: biometricTemplateHash
        }, ageVerification);
        throw new Error('Age verification requires manual review');
      }
      throw new Error(ageCheck.reason);
    }

    // Register user — descriptor travels in the transaction so syncing nodes
    // can rebuild their biometric index and perform duplicate detection
    this.stateManager.registerVerifiedUser(tx.from, {
      hash: biometricHash,
      templateHash: biometricTemplateHash,
      descriptor: descriptor || null,
      livenessScore,
      qualityScore
    }, ageVerification);

    // Deduct fee
    if (tx.fee > 0n) {
      this.stateManager.updateBalance(tx.from, -tx.fee);
    }
  }

  async executeTokenCreate(tx) {
    const { name, symbol, decimals, initialSupply, maxSupply, tier, mintable, burnable, pausable, metadata } = tx.data;

    // Generate token address
    const tokenAddress = 'ankh_token_' + crypto.createHash('sha256')
      .update(tx.from + symbol + Date.now())
      .digest('hex')
      .substring(0, 32);

    // Lock stake
    this.stateManager.updateBalance(tx.from, -tx.value);

    // Register token
    const token = this.stateManager.registerToken(tokenAddress, {
      name,
      symbol,
      decimals,
      initialSupply,
      maxSupply,
      tier,
      mintable,
      burnable,
      pausable,
      metadata
    }, tx.from);

    // Deduct fee
    if (tx.fee > 0n) {
      this.stateManager.updateBalance(tx.from, -tx.fee);
    }

    return token;
  }

  async executeTokenTransfer(tx) {
    const { tokenAddress } = tx.data;
    this.stateManager.transferToken(tokenAddress, tx.from, tx.to, tx.value);

    if (tx.fee > 0n) {
      this.stateManager.updateBalance(tx.from, -tx.fee);
    }
  }

  async executeStake(tx) {
    const validatorAddress = tx.to === 'staking_contract' ? tx.from : tx.to;

    if (tx.from === validatorAddress) {
      // Self-stake: becoming a validator
      this.stateManager.registerValidator(tx.from, tx.value, tx.data);
    } else {
      // Delegation
      this.stateManager.delegateToValidator(tx.from, validatorAddress, tx.value);
    }

    // Update active validators
    this.activeValidators = this.stateManager.getTopValidators();
  }

  async executeUnstake(tx) {
    // Handle unstaking (with unbonding period)
    const validator = this.stateManager.validators.get(tx.data.validator || tx.from);
    if (!validator) throw new Error('Validator not found');

    // Mark for unbonding (funds released after unbonding period)
    validator.unbondingAmount = tx.value;
    validator.unbondingStartTime = Date.now();
    validator.unbondingEndTime = Date.now() +
      (GenesisConfig.CONSENSUS.DPOS.UNBONDING_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  }

  async executeSidechainCreate(tx) {
    const { name, chainId, authorities, blockTime, nativeCurrency, institutionType, metadata } = tx.data;

    // Lock stake
    this.stateManager.updateBalance(tx.from, -tx.value);

    // Register sidechain
    const sidechain = this.stateManager.registerSidechain(chainId, {
      name,
      authorities,
      blockTime,
      nativeCurrency,
      institutionType,
      metadata
    }, tx.from);

    // Deduct fee
    if (tx.fee > 0n) {
      this.stateManager.updateBalance(tx.from, -tx.fee);
    }

    return sidechain;
  }

  async executeBridgeLock(tx) {
    const { targetChain, targetAddress } = tx.data;

    // Lock tokens
    this.stateManager.updateBalance(tx.from, -tx.value);

    // Record bridge lock (bridge contract would handle the rest)
    const lockId = crypto.randomUUID();

    // Emit event for bridge to process
    this.emit('bridgeLock', {
      lockId,
      from: tx.from,
      amount: tx.value,
      targetChain,
      targetAddress,
      timestamp: Date.now()
    });

    return lockId;
  }

  // ============================================
  // Chain Persistence
  // ============================================

  /**
   * Save chain to disk
   */
  async saveChain() {
    const chainData = this.chain.map(block => block.toJSON());
    await fs.writeFile(this.chainFile, JSON.stringify(chainData, null, 2));
  }

  /**
   * Load chain from disk
   */
  async loadChain() {
    try {
      const data = await fs.readFile(this.chainFile, 'utf8');
      const chainData = JSON.parse(data);
      this.chain = chainData.map(blockData => Block.fromJSON(blockData));

      // Calculate current epoch
      this.currentEpoch = Math.floor(
        this.getHeight() / GenesisConfig.CONSENSUS.DPOS.EPOCH_LENGTH
      );
    } catch {
      this.chain = [];
    }
  }

  /**
   * Validate entire chain
   */
  isChainValid() {
    for (let i = 1; i < this.chain.length; i++) {
      const currentBlock = this.chain[i];
      const previousBlock = this.chain[i - 1];

      // Check block validity
      if (!currentBlock.isValid().valid) {
        return { valid: false, reason: `Invalid block at index ${i}` };
      }

      // Check chain linkage
      if (currentBlock.previousHash !== previousBlock.hash) {
        return { valid: false, reason: `Broken chain at index ${i}` };
      }
    }

    return { valid: true };
  }

  // ============================================
  // Query Methods
  // ============================================

  /**
   * Get account info
   */
  getAccount(address) {
    const account = this.stateManager.getAccount(address);
    const ubiStatus = this.stateManager.getUBIStatus(address);

    return {
      ...account,
      balance: account.balance.toString(),
      stakedAmount: account.stakedAmount?.toString() || '0',
      ubi: ubiStatus
    };
  }

  /**
   * Get verified user info
   */
  getVerifiedUser(address) {
    return this.stateManager.getVerifiedUser(address);
  }

  /**
   * Get all tokens
   */
  getTokens() {
    return Array.from(this.stateManager.tokens.values()).map(token => ({
      address: token.address,
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
      totalSupply: token.totalSupply.toString(),
      creator: token.creator,
      tier: token.tier,
      holdersCount: token.holders.size
    }));
  }

  /**
   * Get validators
   */
  getValidators() {
    return Array.from(this.stateManager.validators.values()).map(v => ({
      address: v.address,
      stake: v.stake.toString(),
      delegatedStake: v.delegatedStake.toString(),
      totalStake: v.totalStake.toString(),
      isActive: v.isActive,
      blocksProduced: v.blocksProduced,
      delegatorsCount: v.delegators.size
    }));
  }

  /**
   * Get sidechains
   */
  getSidechains() {
    return Array.from(this.stateManager.sidechains.values());
  }

  /**
   * Get blockchain statistics
   */
  getStats() {
    return {
      ...this.stateManager.getStats(),
      chainHeight: this.getHeight(),
      pendingTransactions: this.pendingTransactions.length,
      activeValidators: this.activeValidators.length,
      currentEpoch: this.currentEpoch,
      genesisConfig: {
        maxPopulation: GenesisConfig.MAX_GLOBAL_POPULATION.toString(),
        lifetimeValue: GenesisConfig.LIFETIME_VALUE_USD.toString(),
        monthlyUBI: GenesisConfig.MONTHLY_UBI_AMOUNT.toString(),
        distributionMonths: GenesisConfig.DISTRIBUTION_MONTHS
      }
    };
  }
}

module.exports = AnkhBlockchain;

