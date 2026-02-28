/**
 * Ankh Chain State Manager
 *
 * Manages the global state of the blockchain including:
 * - Account balances
 * - Verified users registry
 * - UBI allocations and claims
 * - Token registries
 * - Validator stakes
 * - Contract states
 */

const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const GenesisConfig = require('./GenesisConfig');

class StateManager {
  constructor(dataDir = './data') {
    this.dataDir = dataDir;

    // Core State Maps
    this.accounts = new Map();              // address -> AccountState
    this.verifiedUsers = new Map();         // biometricHash -> VerifiedUser
    this.ubiAllocations = new Map();        // address -> UBIAllocation
    this.tokens = new Map();                // tokenAddress -> TokenState
    this.validators = new Map();            // address -> ValidatorState
    this.sidechains = new Map();            // chainId -> SidechainState
    this.pendingReviews = new Map();        // id -> PendingReview (age edge cases)

    // Indexes
    this.addressToBiometric = new Map();    // address -> biometricHash
    this.biometricToAddress = new Map();    // biometricHash -> address
    this.tokenSymbolToAddress = new Map();  // symbol -> tokenAddress

    // Biometric descriptor store (biometricHash -> Float32 descriptor array)
    // Persisted separately so EnhancedBiometricVerifier can rebuild its index after restart
    this.biometricDescriptors = new Map();

    // Statistics
    this.stats = {
      totalVerifiedUsers: 0,
      totalUBIDistributed: 0n,
      totalTokensCreated: 0,
      totalSidechains: 0,
      totalTransactions: 0,
      currentBlockHeight: 0
    };

    // State root (Merkle root of all state)
    this.stateRoot = null;
  }

  /**
   * Initialize state manager
   */
  async initialize() {
    await this.ensureDataDir();
    await this.loadState();
    return this;
  }

  async ensureDataDir() {
    const dirs = [
      this.dataDir,
      path.join(this.dataDir, 'accounts'),
      path.join(this.dataDir, 'verified'),
      path.join(this.dataDir, 'tokens'),
      path.join(this.dataDir, 'validators'),
      path.join(this.dataDir, 'sidechains')
    ];

    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
    }
  }

  // ============================================
  // Account Management
  // ============================================

  /**
   * Get or create account state
   */
  getAccount(address) {
    if (!this.accounts.has(address)) {
      this.accounts.set(address, {
        address,
        balance: 0n,
        nonce: 0,
        isVerified: false,
        verificationId: null,
        stakedAmount: 0n,
        createdAt: Date.now(),
        lastActivity: Date.now()
      });
    }
    return this.accounts.get(address);
  }

  /**
   * Get account balance
   */
  getBalance(address) {
    return this.getAccount(address).balance;
  }

  /**
   * Update account balance
   */
  updateBalance(address, amount) {
    const account = this.getAccount(address);
    account.balance = BigInt(account.balance) + BigInt(amount);
    account.lastActivity = Date.now();

    if (account.balance < 0n) {
      throw new Error(`Insufficient balance for ${address}`);
    }

    return account.balance;
  }

  /**
   * Transfer between accounts
   */
  transfer(from, to, amount, fee = 0n) {
    amount = BigInt(amount);
    fee = BigInt(fee);
    const total = amount + fee;

    const fromAccount = this.getAccount(from);
    if (fromAccount.balance < total) {
      throw new Error(`Insufficient balance: has ${fromAccount.balance}, needs ${total}`);
    }

    this.updateBalance(from, -total);
    this.updateBalance(to, amount);

    // Handle fee (burn 50%, validators 50%)
    if (fee > 0n) {
      const burnAmount = fee / 2n;
      const validatorAmount = fee - burnAmount;
      // Burned amount just disappears
      // Validator rewards handled by consensus
      this.stats.totalFeesBurned = (this.stats.totalFeesBurned || 0n) + burnAmount;
    }

    return { from: fromAccount.balance, to: this.getBalance(to) };
  }

  /**
   * Increment account nonce
   */
  incrementNonce(address) {
    const account = this.getAccount(address);
    account.nonce++;
    return account.nonce;
  }

  // ============================================
  // User Verification & UBI
  // ============================================

  /**
   * Register verified user
   */
  registerVerifiedUser(address, biometricData, ageVerification) {
    const biometricHash = biometricData.hash;

    // Check for duplicate biometric
    if (this.biometricToAddress.has(biometricHash)) {
      throw new Error('Biometric already registered');
    }

    const verificationId = crypto.randomUUID();

    const verifiedUser = {
      verificationId,
      address,
      biometricHash,
      biometricTemplateHash: biometricData.templateHash,
      ageVerification: {
        estimatedAge: ageVerification.estimatedAge,
        confidenceScore: ageVerification.confidenceScore,
        verifiedAt: Date.now(),
        method: ageVerification.method
      },
      registrationTimestamp: Date.now(),
      lifetimeAllocation: GenesisConfig.LIFETIME_VALUE_USD * GenesisConfig.DECIMAL_MULTIPLIER,
      monthsClaimed: 0,
      totalClaimed: 0n,
      lastClaimTimestamp: null,
      status: 'ACTIVE'
    };

    // Store mappings
    this.verifiedUsers.set(biometricHash, verifiedUser);
    this.addressToBiometric.set(address, biometricHash);
    this.biometricToAddress.set(biometricHash, address);

    // Store descriptor so any node that syncs this block can perform
    // Euclidean distance duplicate detection — critical for fraud prevention
    if (Array.isArray(biometricData.descriptor) && biometricData.descriptor.length === 128) {
      this.storeDescriptor(biometricHash, biometricData.descriptor);
    }

    // Update account
    const account = this.getAccount(address);
    account.isVerified = true;
    account.verificationId = verificationId;

    // Initialize UBI allocation
    this.ubiAllocations.set(address, {
      address,
      verificationId,
      lifetimeAllocation: verifiedUser.lifetimeAllocation,
      monthlyAmount: GenesisConfig.calculateMonthlyUBI(),
      monthsClaimed: 0,
      totalClaimed: 0n,
      nextClaimAvailable: Date.now(), // Can claim immediately after verification
      vestingStartDate: Date.now(),
      vestingEndDate: Date.now() + (GenesisConfig.DISTRIBUTION_YEARS * 365 * 24 * 60 * 60 * 1000)
    });

    this.stats.totalVerifiedUsers++;

    return verifiedUser;
  }

  /**
   * Check if biometric is already registered
   */
  isBiometricRegistered(biometricHash) {
    return this.biometricToAddress.has(biometricHash);
  }

  /**
   * Persist a raw 128-d face descriptor alongside its biometric hash.
   * Called by EnhancedBiometricVerifier after successful verification.
   */
  storeDescriptor(biometricHash, descriptor) {
    if (Array.isArray(descriptor) && descriptor.length === 128) {
      this.biometricDescriptors.set(biometricHash, descriptor);
    }
  }

  /**
   * Retrieve the descriptor for a given biometric hash (may be null for legacy records).
   */
  getDescriptor(biometricHash) {
    return this.biometricDescriptors.get(biometricHash) || null;
  }

  /**
   * Get verified user by address
   */
  getVerifiedUser(address) {
    const biometricHash = this.addressToBiometric.get(address);
    if (!biometricHash) return null;
    return this.verifiedUsers.get(biometricHash);
  }

  /**
   * Process UBI claim
   */
  processUBIClaim(address) {
    const allocation = this.ubiAllocations.get(address);
    if (!allocation) {
      throw new Error('No UBI allocation found for address');
    }

    // Check if claim is available
    const now = Date.now();
    if (now < allocation.nextClaimAvailable) {
      const waitTime = allocation.nextClaimAvailable - now;
      throw new Error(`UBI claim not yet available. Wait ${Math.ceil(waitTime / 1000 / 60)} minutes`);
    }

    // Check if all months claimed
    if (allocation.monthsClaimed >= GenesisConfig.DISTRIBUTION_MONTHS) {
      throw new Error('Lifetime UBI allocation exhausted');
    }

    const claimAmount = allocation.monthlyAmount;

    // Update allocation
    allocation.monthsClaimed++;
    allocation.totalClaimed += claimAmount;
    allocation.nextClaimAvailable = now + (GenesisConfig.CLAIM_FREQUENCY_SECONDS * 1000);

    // Credit account
    this.updateBalance(address, claimAmount);

    // Update verified user record
    const user = this.getVerifiedUser(address);
    if (user) {
      user.monthsClaimed = allocation.monthsClaimed;
      user.totalClaimed = allocation.totalClaimed;
      user.lastClaimTimestamp = now;
    }

    this.stats.totalUBIDistributed += claimAmount;

    return {
      amount: claimAmount,
      monthsClaimed: allocation.monthsClaimed,
      totalClaimed: allocation.totalClaimed,
      remainingMonths: GenesisConfig.DISTRIBUTION_MONTHS - allocation.monthsClaimed,
      nextClaimAvailable: allocation.nextClaimAvailable
    };
  }

  /**
   * Get UBI allocation status
   */
  getUBIStatus(address) {
    const allocation = this.ubiAllocations.get(address);
    if (!allocation) return null;

    const now = Date.now();
    const canClaim = now >= allocation.nextClaimAvailable &&
      allocation.monthsClaimed < GenesisConfig.DISTRIBUTION_MONTHS;

    return {
      ...allocation,
      canClaim,
      remainingMonths: GenesisConfig.DISTRIBUTION_MONTHS - allocation.monthsClaimed,
      remainingAllocation: allocation.lifetimeAllocation - allocation.totalClaimed,
      monthlyAmount: allocation.monthlyAmount.toString(),
      totalClaimed: allocation.totalClaimed.toString(),
      lifetimeAllocation: allocation.lifetimeAllocation.toString()
    };
  }

  // ============================================
  // Token Management
  // ============================================

  /**
   * Register new token
   */
  registerToken(tokenAddress, tokenData, creatorAddress) {
    if (this.tokens.has(tokenAddress)) {
      throw new Error('Token address already exists');
    }

    if (this.tokenSymbolToAddress.has(tokenData.symbol)) {
      throw new Error('Token symbol already exists');
    }

    const token = {
      address: tokenAddress,
      name: tokenData.name,
      symbol: tokenData.symbol,
      decimals: tokenData.decimals || 18,
      totalSupply: BigInt(tokenData.initialSupply || 0),
      maxSupply: tokenData.maxSupply ? BigInt(tokenData.maxSupply) : null,
      creator: creatorAddress,
      creatorBiometricHash: this.addressToBiometric.get(creatorAddress),
      tier: tokenData.tier,
      mintable: tokenData.mintable || false,
      burnable: tokenData.burnable || false,
      pausable: tokenData.pausable || false,
      paused: false,
      holders: new Map(), // address -> balance
      createdAt: Date.now(),
      metadata: tokenData.metadata || {}
    };

    // Set initial supply to creator
    if (token.totalSupply > 0n) {
      token.holders.set(creatorAddress, token.totalSupply);
    }

    this.tokens.set(tokenAddress, token);
    this.tokenSymbolToAddress.set(tokenData.symbol, tokenAddress);
    this.stats.totalTokensCreated++;

    return token;
  }

  /**
   * Get token by address or symbol
   */
  getToken(identifier) {
    // Try as address first
    if (this.tokens.has(identifier)) {
      return this.tokens.get(identifier);
    }

    // Try as symbol
    const address = this.tokenSymbolToAddress.get(identifier);
    if (address) {
      return this.tokens.get(address);
    }

    return null;
  }

  /**
   * Transfer token
   */
  transferToken(tokenAddress, from, to, amount) {
    const token = this.tokens.get(tokenAddress);
    if (!token) throw new Error('Token not found');
    if (token.paused) throw new Error('Token is paused');

    amount = BigInt(amount);
    const fromBalance = token.holders.get(from) || 0n;

    if (fromBalance < amount) {
      throw new Error('Insufficient token balance');
    }

    token.holders.set(from, fromBalance - amount);
    token.holders.set(to, (token.holders.get(to) || 0n) + amount);

    return {
      from: token.holders.get(from),
      to: token.holders.get(to)
    };
  }

  /**
   * Get token balance
   */
  getTokenBalance(tokenAddress, address) {
    const token = this.tokens.get(tokenAddress);
    if (!token) return 0n;
    return token.holders.get(address) || 0n;
  }

  // ============================================
  // Validator Management
  // ============================================

  /**
   * Register validator
   */
  registerValidator(address, stake, metadata = {}) {
    stake = BigInt(stake);

    if (stake < GenesisConfig.CONSENSUS.DPOS.MIN_VALIDATOR_STAKE) {
      throw new Error(`Minimum stake required: ${GenesisConfig.CONSENSUS.DPOS.MIN_VALIDATOR_STAKE}`);
    }

    // Lock stake from account
    const account = this.getAccount(address);
    if (account.balance < stake) {
      throw new Error('Insufficient balance for staking');
    }

    this.updateBalance(address, -stake);

    const validator = {
      address,
      stake,
      delegatedStake: 0n,
      totalStake: stake,
      blocksProduced: 0,
      blocksValidated: 0,
      rewards: 0n,
      slashings: 0,
      isActive: true,
      registeredAt: Date.now(),
      lastBlockTime: null,
      delegators: new Map(), // address -> amount
      metadata
    };

    this.validators.set(address, validator);
    account.stakedAmount = stake;

    return validator;
  }

  /**
   * Delegate to validator
   */
  delegateToValidator(from, validatorAddress, amount) {
    amount = BigInt(amount);

    const validator = this.validators.get(validatorAddress);
    if (!validator) throw new Error('Validator not found');
    if (!validator.isActive) throw new Error('Validator is not active');

    // Lock stake from delegator
    const account = this.getAccount(from);
    if (account.balance < amount) {
      throw new Error('Insufficient balance for delegation');
    }

    this.updateBalance(from, -amount);

    // Add to validator's delegated stake
    const currentDelegation = validator.delegators.get(from) || 0n;
    validator.delegators.set(from, currentDelegation + amount);
    validator.delegatedStake += amount;
    validator.totalStake += amount;

    account.stakedAmount = (account.stakedAmount || 0n) + amount;

    return validator;
  }

  /**
   * Get top validators by stake
   */
  getTopValidators(count = GenesisConfig.CONSENSUS.DPOS.VALIDATOR_COUNT) {
    const validators = Array.from(this.validators.values())
      .filter(v => v.isActive)
      .sort((a, b) => {
        if (b.totalStake > a.totalStake) return 1;
        if (b.totalStake < a.totalStake) return -1;
        return 0;
      });

    return validators.slice(0, count);
  }

  /**
   * Process any validators whose unbonding period has matured and release their stake.
   * Called after every block so funds are never locked beyond the 21-day window.
   * Returns the number of unbondings released.
   */
  processMaturedUnbondings() {
    const now = Date.now();
    let released = 0;

    for (const [address, validator] of this.validators) {
      if (
        validator.unbondingAmount && validator.unbondingAmount > 0n &&
        validator.unbondingEndTime && now >= validator.unbondingEndTime
      ) {
        // Credit stake back to balance
        this.updateBalance(address, validator.unbondingAmount);

        // Reduce account's stakedAmount record
        const account = this.getAccount(address);
        account.stakedAmount = (account.stakedAmount || 0n) - validator.unbondingAmount;
        if (account.stakedAmount < 0n) account.stakedAmount = 0n;

        // Clear unbonding fields
        validator.unbondingAmount = 0n;
        validator.unbondingStartTime = null;
        validator.unbondingEndTime = null;

        released++;
      }
    }

    return released;
  }

  /**
   * Slash validator
   */
  slashValidator(address, reason) {
    const validator = this.validators.get(address);
    if (!validator) throw new Error('Validator not found');

    const slashAmount = (validator.stake * BigInt(GenesisConfig.CONSENSUS.DPOS.SLASH_PERCENT)) / 100n;

    validator.stake -= slashAmount;
    validator.totalStake -= slashAmount;
    validator.slashings++;

    // If stake drops below minimum, deactivate
    if (validator.stake < GenesisConfig.CONSENSUS.DPOS.MIN_VALIDATOR_STAKE) {
      validator.isActive = false;
    }

    return { slashed: slashAmount, reason };
  }

  // ============================================
  // Sidechain Management
  // ============================================

  /**
   * Register sidechain
   */
  registerSidechain(chainId, sidechainData, creatorAddress) {
    if (this.sidechains.has(chainId)) {
      throw new Error('Sidechain ID already exists');
    }

    const sidechain = {
      chainId,
      name: sidechainData.name,
      consensusType: 'POA',
      authorities: sidechainData.authorities,
      authorityThreshold: GenesisConfig.CONSENSUS.POA.AUTHORITY_APPROVAL_THRESHOLD,
      blockTime: sidechainData.blockTime || GenesisConfig.CONSENSUS.POA.BLOCK_TIME_MS,
      nativeCurrency: sidechainData.nativeCurrency || {
        name: sidechainData.name + ' Token',
        symbol: chainId.toUpperCase().substring(0, 4),
        decimals: 18
      },
      creator: creatorAddress,
      institutionType: sidechainData.institutionType,
      createdAt: Date.now(),
      lastAnchorBlock: null,
      lastAnchorHash: null,
      isActive: true,
      metadata: sidechainData.metadata || {}
    };

    this.sidechains.set(chainId, sidechain);
    this.stats.totalSidechains++;

    return sidechain;
  }

  /**
   * Anchor sidechain state to main chain
   */
  anchorSidechain(chainId, blockHeight, stateRoot) {
    const sidechain = this.sidechains.get(chainId);
    if (!sidechain) throw new Error('Sidechain not found');

    sidechain.lastAnchorBlock = blockHeight;
    sidechain.lastAnchorHash = stateRoot;
    sidechain.lastAnchorTime = Date.now();

    return sidechain;
  }

  // ============================================
  // Pending Reviews (Age Edge Cases)
  // ============================================

  /**
   * Add pending review for age verification edge case
   */
  addPendingReview(address, biometricData, ageVerification) {
    const reviewId = crypto.randomUUID();

    this.pendingReviews.set(reviewId, {
      reviewId,
      address,
      biometricHash: biometricData.hash,
      ageVerification,
      submittedAt: Date.now(),
      status: 'PENDING',
      reviewNotes: [],
      reviewer: null,
      resolvedAt: null
    });

    return reviewId;
  }

  /**
   * Resolve pending review
   */
  resolvePendingReview(reviewId, approved, reviewerAddress, notes) {
    const review = this.pendingReviews.get(reviewId);
    if (!review) throw new Error('Review not found');

    review.status = approved ? 'APPROVED' : 'REJECTED';
    review.reviewer = reviewerAddress;
    review.reviewNotes.push(notes);
    review.resolvedAt = Date.now();

    if (approved) {
      // Register the user
      const biometricData = {
        hash: review.biometricHash,
        templateHash: review.biometricHash // Simplified
      };
      this.registerVerifiedUser(review.address, biometricData, {
        ...review.ageVerification,
        manuallyApproved: true,
        reviewer: reviewerAddress
      });
    }

    return review;
  }

  // ============================================
  // State Persistence
  // ============================================

  /**
   * Calculate state root
   */
  calculateStateRoot() {
    const stateData = {
      accountsHash: this.hashMap(this.accounts),
      verifiedUsersHash: this.hashMap(this.verifiedUsers),
      tokensHash: this.hashMap(this.tokens),
      validatorsHash: this.hashMap(this.validators),
      sidechainsHash: this.hashMap(this.sidechains),
      stats: this.stats
    };

    this.stateRoot = '0x' + crypto.createHash('sha256')
      .update(JSON.stringify(stateData, (_, val) =>
        typeof val === 'bigint' ? val.toString() : val
      ))
      .digest('hex');

    return this.stateRoot;
  }

  hashMap(map) {
    const entries = Array.from(map.entries()).map(([k, v]) => ({
      key: k,
      value: typeof v === 'object' ? JSON.stringify(v, (_, val) =>
        typeof val === 'bigint' ? val.toString() : val
      ) : v
    }));
    return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  }

  /**
   * Save state to disk
   */
  async saveState() {
    const serialize = (obj) => JSON.stringify(obj, (_, v) =>
      typeof v === 'bigint' ? v.toString() + 'n' : v instanceof Map ? Array.from(v) : v
    , 2);

    await Promise.all([
      fs.writeFile(
        path.join(this.dataDir, 'accounts.json'),
        serialize(Array.from(this.accounts.entries()))
      ),
      fs.writeFile(
        path.join(this.dataDir, 'verified_users.json'),
        serialize(Array.from(this.verifiedUsers.entries()))
      ),
      fs.writeFile(
        path.join(this.dataDir, 'ubi_allocations.json'),
        serialize(Array.from(this.ubiAllocations.entries()))
      ),
      fs.writeFile(
        path.join(this.dataDir, 'tokens.json'),
        serialize(Array.from(this.tokens.entries()))
      ),
      fs.writeFile(
        path.join(this.dataDir, 'validators.json'),
        serialize(Array.from(this.validators.entries()))
      ),
      fs.writeFile(
        path.join(this.dataDir, 'sidechains.json'),
        serialize(Array.from(this.sidechains.entries()))
      ),
      fs.writeFile(
        path.join(this.dataDir, 'stats.json'),
        serialize(this.stats)
      ),
      fs.writeFile(
        path.join(this.dataDir, 'biometric_descriptors.json'),
        JSON.stringify(Array.from(this.biometricDescriptors.entries()), null, 2)
      )
    ]);
  }

  /**
   * Load state from disk
   */
  async loadState() {
    const deserialize = (str) => JSON.parse(str, (_, v) => {
      if (typeof v === 'string' && v.endsWith('n')) {
        return BigInt(v.slice(0, -1));
      }
      return v;
    });

    const loadFile = async (filename) => {
      try {
        const data = await fs.readFile(path.join(this.dataDir, filename), 'utf8');
        return deserialize(data);
      } catch {
        return null;
      }
    };

    const [accounts, verifiedUsers, ubiAllocations, tokens, validators, sidechains, stats, biometricDescriptorsRaw] =
      await Promise.all([
        loadFile('accounts.json'),
        loadFile('verified_users.json'),
        loadFile('ubi_allocations.json'),
        loadFile('tokens.json'),
        loadFile('validators.json'),
        loadFile('sidechains.json'),
        loadFile('stats.json'),
        loadFile('biometric_descriptors.json')
      ]);

    if (accounts) this.accounts = new Map(accounts);
    if (verifiedUsers) this.verifiedUsers = new Map(verifiedUsers);
    if (ubiAllocations) this.ubiAllocations = new Map(ubiAllocations);
    if (tokens) {
      this.tokens = new Map(tokens.map(([addr, token]) => {
        if (token.holders && Array.isArray(token.holders)) {
          token.holders = new Map(token.holders);
        }
        return [addr, token];
      }));
      // Rebuild symbol index
      this.tokens.forEach((token, addr) => {
        this.tokenSymbolToAddress.set(token.symbol, addr);
      });
    }
    if (validators) {
      this.validators = new Map(validators.map(([addr, validator]) => {
        if (validator.delegators && Array.isArray(validator.delegators)) {
          validator.delegators = new Map(validator.delegators);
        }
        return [addr, validator];
      }));
    }
    if (sidechains) this.sidechains = new Map(sidechains);
    if (stats) this.stats = stats;

    if (biometricDescriptorsRaw) {
      this.biometricDescriptors = new Map(biometricDescriptorsRaw);
    }

    // Rebuild indexes
    this.verifiedUsers.forEach((user, hash) => {
      this.addressToBiometric.set(user.address, hash);
      this.biometricToAddress.set(hash, user.address);
    });
  }

  /**
   * Get global statistics
   */
  getStats() {
    return {
      ...this.stats,
      totalUBIDistributed: this.stats.totalUBIDistributed?.toString() || '0',
      totalAccounts: this.accounts.size,
      totalValidators: this.validators.size,
      activeValidators: Array.from(this.validators.values()).filter(v => v.isActive).length,
      pendingReviews: this.pendingReviews.size
    };
  }
}

module.exports = StateManager;

