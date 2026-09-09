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
const BiometricStore = require('./BiometricStore');
const ShardedMapStore = require('./ShardedMapStore');

class StateManager {
  constructor(dataDir = './data') {
    this.dataDir = dataDir;

    // Core State Maps
    //
    // accounts / verifiedUsers / ubiAllocations are ShardedMapStore rather than
    // Map. They are the maps that grow with population, and serialising any of
    // them as one JSON string hit V8's 536 MB MAX_STRING_LENGTH: measured on
    // live data that was a hard crash at ~662k verified users, ~779k UBI
    // allocations and ~1.4M accounts, after which no state could be saved at
    // all. Sharding removes the ceiling and makes writes incremental — the same
    // reason Ethereum keeps state in a key-value trie instead of one blob.
    // They keep the full Map interface, so callers are unchanged.
    this.accounts = new ShardedMapStore(dataDir, 'accounts');
    this.verifiedUsers = new ShardedMapStore(dataDir, 'verified_users');
    this.ubiAllocations = new ShardedMapStore(dataDir, 'ubi_allocations');
    this.tokens = new Map();                // tokenAddress -> TokenState
    this.validators = new Map();            // address -> ValidatorState
    this.sidechains = new Map();            // chainId -> SidechainState
    this.pendingReviews = new Map();        // id -> PendingReview (age edge cases)

    // Indexes
    this.addressToBiometric = new Map();    // address -> biometricHash
    this.biometricToAddress = new Map();    // biometricHash -> address
    this.tokenSymbolToAddress = new Map();  // symbol -> tokenAddress

    // Biometric descriptor store (biometricHash -> Float32Array(128)).
    // Sharded, uncapped and consensus-committed — see BiometricStore. Persisted
    // separately so EnhancedBiometricVerifier can rebuild its index after restart.
    this.biometricDescriptors = new BiometricStore(dataDir);

    // Registered node registry (publicKey -> {address, registeredAt, isActive})
    // Only nodes in this registry can sign BIOMETRIC_REGISTRATION verificationProofs.
    this.registeredNodes = new Map();

    // Reserve wallet addresses (type -> ankh_ address).
    // Loaded from data/reserve_wallets.json on startup.
    // Keys: 'main' | 'foundation' | 'development' | 'ecosystem' | 'emergency'
    this.reserveAddresses = new Map();

    // On-chain governance proposals (proposalId -> proposal object)
    this.governance = new Map();

    // Bridge double-spend prevention — tracks processed BRIDGE_LOCK hashes
    this.processedBridgeLocks = new Set();

    // Persistence bookkeeping
    this._saveChain = null;       // in-flight save promise (serialises writers)
    this._saveRequested = false;  // a save was asked for while one was running
    this._fileDigests = new Map();// file -> sha256 of last successfully written content
    this._saveSeq = 0;

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
    // BiometricStore validates shape/finiteness and accepts both plain arrays
    // (from the network) and Float32Array (in-memory).
    return this.biometricDescriptors.set(biometricHash, descriptor);
  }

  /**
   * Find an already-registered face within `threshold` of this descriptor.
   * Exact search — used on both the API and the block-execution path, so a
   * duplicate cannot enter state via either route.
   *
   * @returns {{hash: string, address: string, distance: number}|null}
   */
  findDuplicateDescriptor(descriptor, threshold) {
    const match = this.biometricDescriptors.findDuplicate(
      descriptor,
      threshold,
      // Orphaned descriptors (no registered user) must not block a registration.
      (hash) => this.biometricToAddress.has(hash)
    );
    if (!match) return null;
    return {
      hash: match.hash,
      address: this.biometricToAddress.get(match.hash) || null,
      distance: match.distance
    };
  }

  /**
   * Retrieve the descriptor for a given biometric hash (may be null for legacy records).
   */
  getDescriptor(biometricHash) {
    return this.biometricDescriptors.get(biometricHash) || null;
  }

  // ── Node Registry ─────────────────────────────────────────────────────────

  /**
   * Register a node's public key. Called by executeNodeRegister.
   */
  registerNode(publicKey, address) {
    this.registeredNodes.set(publicKey, {
      address,
      registeredAt: Date.now(),
      isActive: true
    });
  }

  /**
   * Returns true if the given secp256k1 public key belongs to a registered, active node.
   */
  isNodeRegistered(publicKey) {
    const node = this.registeredNodes.get(publicKey);
    return !!(node && node.isActive);
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

    // Global supply cap — enforced here so both the blockchain tx path and the
    // API path are covered. MAX_TOTAL_SUPPLY is in raw 18-decimal units.
    if (this.stats.totalUBIDistributed + claimAmount > GenesisConfig.MAX_TOTAL_SUPPLY) {
      throw new Error('Global UBI supply cap reached (2.8×10¹⁶ ANKH). No further issuance possible.');
    }

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
    // Full state commitment — every map that represents ground-truth state is included.
    // biometricDescriptors are included via BiometricStore's running accumulator:
    // this is a biometric chain, so the descriptor set is consensus state, not an
    // off-chain cache. The accumulator makes that O(1) per block instead of a
    // full re-hash of every descriptor.
    // stats omitted (derived counters, not ground truth).
    // NOTE: this formula changed when state moved to sharded stores. The old
    // one hashed every account, verified user and UBI allocation in iteration
    // order on every block — O(N) per block, and order-dependent, so a node
    // that reloaded from shards computed a different root for identical state.
    // biometricToAddress is no longer committed separately: it is a pure index
    // over verifiedUsers, so verifiedUsersHash already covers it.
    // Every node on the network must run the same formula.
    const bigintReplacer = (_, val) => typeof val === 'bigint' ? val.toString() : val;
    const stateData = {
      // O(1) running commitments — hashMap() re-hashes every entry, which is
      // both order-dependent (wrong once state loads from shards) and O(N) per
      // block, i.e. ~50M entry hashes every 3s at national scale.
      accountsHash:        this.accounts.commitment(),
      verifiedUsersHash:   this.verifiedUsers.commitment(),
      ubiAllocationsHash:  this.ubiAllocations.commitment(),
      tokensHash:          this.hashMap(this.tokens),
      validatorsHash:      this.hashMap(this.validators),
      sidechainsHash:      this.hashMap(this.sidechains),
      registeredNodesHash: this.hashMap(this.registeredNodes),
      governanceHash:      this.hashMap(this.governance),
      reserveHash:         this.hashMap(this.reserveAddresses),
    };

    // Consensus-affecting; see GenesisConfig.BIOMETRIC.COMMIT_DESCRIPTORS_TO_STATE_ROOT.
    // Every node on the network must agree on this setting.
    if (GenesisConfig.BIOMETRIC.COMMIT_DESCRIPTORS_TO_STATE_ROOT) {
      stateData.biometricsHash = this.biometricDescriptors.commitment();
    }

    this.stateRoot = '0x' + crypto.createHash('sha256')
      .update(JSON.stringify(stateData, bigintReplacer))
      .digest('hex');

    return this.stateRoot;
  }

  /**
   * Hash a small map independently of iteration order.
   *
   * Sorting by key matters because several of these maps are rebuilt during
   * load and would otherwise enumerate differently than they were written,
   * producing a different state root for identical state. Only used for maps
   * that stay small (tokens, validators, sidechains, nodes, governance,
   * reserves) — the population-scale maps use their own O(changed) commitment.
   */
  hashMap(map) {
    const entries = Array.from(map.entries()).sort((a, b) =>
      String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0
    ).map(([k, v]) => ({
      key: k,
      value: typeof v === 'object' ? JSON.stringify(v, (_, val) =>
        typeof val === 'bigint' ? val.toString() : val
      ) : v
    }));
    return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  }

  /**
   * Save state to disk.
   *
   * Serialised and coalescing. Previously this was a bare async function called
   * from block production (every ~33s), the /verify API path and P2P sync with
   * no mutual exclusion. Two overlapping runs each wrote `<name>.tmp` and then
   * both tried to rename it, so the loser hit ENOENT — the live server logged
   * 4,846 such failures — and the surviving files could come from two different
   * snapshots, leaving state torn across files.
   *
   * Now: one save runs at a time; concurrent callers coalesce into a single
   * follow-up pass and all await the same settled result.
   */
  saveState() {
    this._saveRequested = true;
    if (this._saveChain) return this._saveChain;

    this._saveChain = (async () => {
      try {
        // Loop so requests arriving mid-save are folded into one extra pass
        // rather than queueing an unbounded chain of writes.
        while (this._saveRequested) {
          this._saveRequested = false;
          await this._writeStateOnce();
        }
      } finally {
        this._saveChain = null;
      }
    })();

    return this._saveChain;
  }

  /**
   * Single serialised state write.
   *
   * Only files whose content actually changed are rewritten. Blocks are
   * usually empty, so this turns a ~46 MB full-state rewrite every 33 seconds
   * (~1.1 TB over 8 days on the live node) into near-zero steady-state I/O.
   *
   * Temp files carry a unique suffix so that even an unexpected concurrent
   * writer cannot collide on the same path.
   */
  async _writeStateOnce() {
    const serialize = (obj) => JSON.stringify(obj, (_, v) =>
      typeof v === 'bigint' ? v.toString() + 'n' : v instanceof Map ? Array.from(v) : v
    , 2);

    const files = {
      'tokens.json':                 serialize(Array.from(this.tokens.entries())),
      'validators.json':             serialize(Array.from(this.validators.entries())),
      'sidechains.json':             serialize(Array.from(this.sidechains.entries())),
      'stats.json':                  serialize(this.stats),
      'registered_nodes.json':       JSON.stringify(Array.from(this.registeredNodes.entries()), null, 2),
      'governance.json':             serialize(Array.from(this.governance.entries())),
      'processed_bridge_locks.json': JSON.stringify(Array.from(this.processedBridgeLocks), null, 2),
    };
    if (this.reserveAddresses.size > 0) {
      files['reserve_wallets.json'] = JSON.stringify(Object.fromEntries(this.reserveAddresses), null, 2);
    }

    // Skip files whose serialized bytes are identical to the last successful write.
    const pending = [];
    for (const [name, content] of Object.entries(files)) {
      const digest = crypto.createHash('sha256').update(content).digest('hex');
      if (this._fileDigests.get(name) === digest) continue;
      pending.push({ name, content, digest });
    }

    const stamp = `${process.pid}.${Date.now()}.${(this._saveSeq = (this._saveSeq || 0) + 1)}`;

    // Phase 1: write all temp files (does not disturb live files).
    await Promise.all(pending.map(f =>
      fs.writeFile(path.join(this.dataDir, `${f.name}.${stamp}.tmp`), f.content)
    ));

    // Phase 2: rename each temp into place. POSIX rename is atomic per file.
    const results = await Promise.allSettled(pending.map(f =>
      fs.rename(
        path.join(this.dataDir, `${f.name}.${stamp}.tmp`),
        path.join(this.dataDir, f.name)
      )
    ));

    // Only record a digest once its rename actually succeeded, so a failed file
    // is retried on the next save instead of being assumed clean.
    const failed = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        this._fileDigests.set(pending[i].name, pending[i].digest);
      } else {
        failed.push(`${pending[i].name}: ${r.reason?.message || r.reason}`);
        fs.unlink(path.join(this.dataDir, `${pending[i].name}.${stamp}.tmp`)).catch(() => {});
      }
    });

    // The population-scale maps and the descriptor store persist themselves,
    // sharded and uncapped — no single string, no ceiling.
    let biometrics = { shardsWritten: 0 };
    let shardedWritten = 0;
    for (const [label, store] of [
      ['accounts', this.accounts],
      ['verified_users', this.verifiedUsers],
      ['ubi_allocations', this.ubiAllocations],
    ]) {
      try {
        shardedWritten += (await store.save()).shardsWritten;
      } catch (err) {
        failed.push(`${label}: ${err.message}`);
      }
    }
    try {
      biometrics = await this.biometricDescriptors.save();
    } catch (err) {
      failed.push(`biometrics: ${err.message}`);
    }

    if (failed.length > 0) {
      console.error(`[StateManager] state write failed for ${failed.length} file(s): ${failed.join('; ')}`);
    }

    return {
      filesWritten: pending.length - failed.length,
      stateShards: shardedWritten,
      biometricShards: biometrics.shardsWritten
    };
  }

  /**
   * Load state from disk
   */
  async loadState() {
    // Remove any stale .tmp files left by a crash during a state write.
    // Temp names now carry a pid/timestamp suffix, so sweep by pattern rather
    // than by a fixed list. Live files are untouched by this.
    try {
      const stale = (await fs.readdir(this.dataDir)).filter(f => f.endsWith('.tmp'));
      await Promise.all(
        stale.map(f => fs.unlink(path.join(this.dataDir, f)).catch(() => {}))
      );
      if (stale.length > 0) {
        console.log(`[StateManager] Cleaned ${stale.length} stale temp file(s) from a previous run`);
      }
    } catch { /* data dir may not exist yet */ }

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

    // Population-scale maps load from their shard directories, migrating the
    // legacy single-file form on first run after upgrade.
    for (const store of [this.accounts, this.verifiedUsers, this.ubiAllocations]) {
      await store.load();
      await store.migrateLegacy();
    }
    console.log(
      `[StateManager] Sharded state loaded: ` +
      `${this.accounts.size.toLocaleString()} accounts, ` +
      `${this.verifiedUsers.size.toLocaleString()} verified users, ` +
      `${this.ubiAllocations.size.toLocaleString()} UBI allocations`
    );

    const [tokens, validators, sidechains, stats, registeredNodesRaw, reserveWalletsRaw, governanceRaw, bridgeLocksRaw] =
      await Promise.all([
        loadFile('tokens.json'),
        loadFile('validators.json'),
        loadFile('sidechains.json'),
        loadFile('stats.json'),
        loadFile('registered_nodes.json'),
        loadFile('reserve_wallets.json'),
        loadFile('governance.json'),
        loadFile('processed_bridge_locks.json')
      ]);

    // accounts / verifiedUsers / ubiAllocations were loaded above from their
    // shard directories — they are ShardedMapStore instances and must never be
    // reassigned to a plain Map, which would drop their persistence.
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

    // ── Biometric descriptors ────────────────────────────────────────────────
    // Sharded and uncapped. The old path persisted only the last 10,000
    // descriptors and loaded at most 500,000, which silently blinded duplicate
    // detection for everyone outside that window — a Sybil hole that opened as
    // soon as the population passed the cap.
    const stillRegistered = (hash) => this.verifiedUsers.has(hash);
    const loaded = await this.biometricDescriptors.load(stillRegistered);

    // First run after upgrade: fold the legacy file into the sharded store.
    if (loaded.loaded === 0) {
      await this.biometricDescriptors.migrateLegacy(
        path.join(this.dataDir, 'biometric_descriptors.json'),
        stillRegistered
      );
    }

    if (loaded.orphaned > 0) {
      console.log(`[StateManager] Dropped ${loaded.orphaned} orphaned biometric descriptor(s) with no registered user`);
    }
    console.log(`[StateManager] Biometric descriptors loaded: ${this.biometricDescriptors.size.toLocaleString()} (uncapped, ${require('./BiometricStore').SHARD_COUNT}-way sharded)`);

    if (registeredNodesRaw) {
      this.registeredNodes = new Map(registeredNodesRaw);
    }

    if (reserveWalletsRaw) {
      this.reserveAddresses = new Map(Object.entries(reserveWalletsRaw));
    }

    if (governanceRaw) {
      this.governance = new Map(governanceRaw);
    }

    if (bridgeLocksRaw) {
      this.processedBridgeLocks = new Set(bridgeLocksRaw);
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
