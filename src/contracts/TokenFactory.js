/**
 * Token Factory
 *
 * Handles tiered token creation on the Ankh blockchain:
 * - Community Tier: 100 ANKH stake, auto-approved
 * - Standard Tier: 10,000 ANKH stake, 24hr review period
 * - Institutional Tier: 100,000 ANKH stake + governance vote
 * - Sovereign Tier: Government entities with council approval
 */

const crypto = require('crypto');
const EventEmitter = require('events');
const ARC20Token = require('./standards/ARC20');
const GenesisConfig = require('../core/GenesisConfig');

class TokenFactory extends EventEmitter {
  constructor(stateManager, blockchain) {
    super();

    this.stateManager = stateManager;
    this.blockchain = blockchain;

    // Token registry
    this.tokens = new Map();
    this.symbolRegistry = new Map();

    // Pending approvals
    this.pendingTokens = new Map();
    this.communityFlags = new Map();

    // Governance
    this.governanceVotes = new Map();

    // Statistics
    this.stats = {
      totalTokensCreated: 0,
      tokensByTier: {
        COMMUNITY: 0,
        STANDARD: 0,
        INSTITUTIONAL: 0,
        SOVEREIGN: 0
      },
      totalStakeLocked: 0n,
      rejectedTokens: 0
    };
  }

  /**
   * Create a new token
   */
  async createToken(creator, params) {
    // Validate creator is verified
    if (!this.stateManager.getAccount(creator).isVerified) {
      throw new Error('Token creator must be a verified user');
    }

    // Validate symbol uniqueness
    if (this.symbolRegistry.has(params.symbol)) {
      throw new Error(`Token symbol "${params.symbol}" already exists`);
    }

    // Reserved symbols
    const reservedSymbols = ['ANKH', 'BTC', 'ETH', 'USD', 'EUR', 'GBP'];
    if (reservedSymbols.includes(params.symbol.toUpperCase())) {
      throw new Error(`Symbol "${params.symbol}" is reserved`);
    }

    // Determine tier
    const tier = this.determineTier(params.stake || 0n);
    if (!tier) {
      throw new Error(`Insufficient stake. Minimum: ${GenesisConfig.TOKEN_TIERS.COMMUNITY.STAKE_REQUIRED} ANKH`);
    }

    const tierConfig = GenesisConfig.TOKEN_TIERS[tier];

    // Check max supply for community tier
    if (tier === 'COMMUNITY' && params.initialSupply) {
      const supply = BigInt(params.initialSupply);
      if (supply > tierConfig.MAX_SUPPLY) {
        throw new Error(`Community tier max supply is ${tierConfig.MAX_SUPPLY}`);
      }
    }

    // Lock stake
    const stake = BigInt(params.stake || tierConfig.STAKE_REQUIRED);
    const account = this.stateManager.getAccount(creator);
    if (account.balance < stake) {
      throw new Error(`Insufficient balance for stake: has ${account.balance}, needs ${stake}`);
    }

    // Create token object
    const tokenParams = {
      name: params.name,
      symbol: params.symbol.toUpperCase(),
      decimals: params.decimals || 18,
      initialSupply: params.initialSupply || 0,
      maxSupply: params.maxSupply,
      creator,
      creatorBiometricHash: this.stateManager.addressToBiometric.get(creator),
      tier,
      mintable: params.mintable || false,
      burnable: params.burnable || false,
      pausable: params.pausable || false,
      verifiedHoldersOnly: params.verifiedHoldersOnly || false,
      description: params.description,
      website: params.website,
      metadata: params.metadata
    };

    const token = new ARC20Token(tokenParams, this.stateManager);

    // Handle based on tier
    if (tierConfig.AUTO_APPROVED) {
      return this.finalizeTokenCreation(token, creator, stake);
    }

    // Add to pending for review
    return this.addToPending(token, creator, stake, tier);
  }

  /**
   * Determine token tier based on stake
   */
  determineTier(stake) {
    stake = BigInt(stake);

    const tiers = ['SOVEREIGN', 'INSTITUTIONAL', 'STANDARD', 'COMMUNITY'];

    for (const tier of tiers) {
      if (stake >= GenesisConfig.TOKEN_TIERS[tier].STAKE_REQUIRED) {
        return tier;
      }
    }

    return null;
  }

  /**
   * Add token to pending queue
   */
  addToPending(token, creator, stake, tier) {
    const pendingId = crypto.randomUUID();
    const tierConfig = GenesisConfig.TOKEN_TIERS[tier];

    const pending = {
      id: pendingId,
      token: token.toJSON(),
      creator,
      stake: stake.toString(),
      tier,
      status: 'PENDING',
      submittedAt: Date.now(),
      reviewDeadline: Date.now() + (tierConfig.REVIEW_PERIOD_HOURS * 60 * 60 * 1000),
      communityFlags: [],
      governanceVotes: [],
      approvalCount: 0,
      rejectionCount: 0
    };

    this.pendingTokens.set(pendingId, pending);

    this.emit('TokenPending', {
      pendingId,
      symbol: token.symbol,
      tier,
      reviewDeadline: pending.reviewDeadline
    });

    return {
      status: 'PENDING',
      pendingId,
      message: `Token pending review. Review period: ${tierConfig.REVIEW_PERIOD_HOURS} hours`,
      reviewDeadline: pending.reviewDeadline
    };
  }

  /**
   * Finalize token creation
   */
  async finalizeTokenCreation(token, creator, stake) {
    // Lock stake from creator
    this.stateManager.updateBalance(creator, -stake);

    // Register token
    this.tokens.set(token.address, token);
    this.symbolRegistry.set(token.symbol, token.address);

    // Update state manager
    this.stateManager.registerToken(token.address, token.toJSON(), creator);

    // Update stats
    this.stats.totalTokensCreated++;
    this.stats.tokensByTier[token.tier]++;
    this.stats.totalStakeLocked += stake;

    this.emit('TokenCreated', {
      address: token.address,
      symbol: token.symbol,
      name: token.name,
      tier: token.tier,
      creator
    });

    return {
      status: 'CREATED',
      address: token.address,
      symbol: token.symbol,
      token: token.getInfo()
    };
  }

  /**
   * Community flag a pending token
   */
  flagPendingToken(pendingId, flagger, reason) {
    const pending = this.pendingTokens.get(pendingId);
    if (!pending) throw new Error('Pending token not found');
    if (pending.status !== 'PENDING') throw new Error('Token is no longer pending');

    // Verify flagger is verified user
    if (!this.stateManager.getAccount(flagger).isVerified) {
      throw new Error('Only verified users can flag tokens');
    }

    // Check if already flagged by this user
    if (pending.communityFlags.some(f => f.flagger === flagger)) {
      throw new Error('Already flagged by this user');
    }

    pending.communityFlags.push({
      flagger,
      reason,
      timestamp: Date.now()
    });

    // Auto-reject if too many flags
    if (pending.communityFlags.length >= 10) {
      return this.rejectPendingToken(pendingId, 'AUTO_REJECTED', 'Community flagged');
    }

    this.emit('TokenFlagged', {
      pendingId,
      flagger,
      totalFlags: pending.communityFlags.length
    });

    return { flagCount: pending.communityFlags.length };
  }

  /**
   * Vote on pending token (for governance-required tokens)
   */
  voteOnToken(pendingId, voter, approve, reason) {
    const pending = this.pendingTokens.get(pendingId);
    if (!pending) throw new Error('Pending token not found');
    if (pending.status !== 'PENDING') throw new Error('Token is no longer pending');

    // Verify voter is verified and has stake (governance participant)
    const account = this.stateManager.getAccount(voter);
    if (!account.isVerified) {
      throw new Error('Only verified users can vote');
    }

    // For now, allow any verified user to vote
    // In production, would check governance stake/delegation

    // Check if already voted
    if (pending.governanceVotes.some(v => v.voter === voter)) {
      throw new Error('Already voted on this token');
    }

    pending.governanceVotes.push({
      voter,
      approve,
      reason,
      timestamp: Date.now()
    });

    if (approve) {
      pending.approvalCount++;
    } else {
      pending.rejectionCount++;
    }

    // Check if consensus reached
    const totalVotes = pending.approvalCount + pending.rejectionCount;
    if (totalVotes >= 10) {
      const approvalRatio = pending.approvalCount / totalVotes;
      if (approvalRatio >= 0.66) {
        return this.approvePendingToken(pendingId, 'GOVERNANCE_APPROVED');
      } else if (approvalRatio <= 0.34) {
        return this.rejectPendingToken(pendingId, 'GOVERNANCE_REJECTED', 'Insufficient approval votes');
      }
    }

    this.emit('TokenVote', {
      pendingId,
      voter,
      approve,
      approvalCount: pending.approvalCount,
      rejectionCount: pending.rejectionCount
    });

    return {
      approvalCount: pending.approvalCount,
      rejectionCount: pending.rejectionCount
    };
  }

  /**
   * Process pending tokens (called periodically)
   */
  async processPendingTokens() {
    const now = Date.now();
    const results = [];

    for (const [pendingId, pending] of this.pendingTokens) {
      if (pending.status !== 'PENDING') continue;

      const tierConfig = GenesisConfig.TOKEN_TIERS[pending.tier];

      // Check if review period has passed
      if (now >= pending.reviewDeadline) {
        // Standard tier: auto-approve if no flags
        if (pending.tier === 'STANDARD' && pending.communityFlags.length < 3) {
          results.push(await this.approvePendingToken(pendingId, 'AUTO_APPROVED_AFTER_REVIEW'));
        }
        // Institutional/Sovereign: require explicit approval
        else if (pending.tier === 'INSTITUTIONAL' || pending.tier === 'SOVEREIGN') {
          if (!tierConfig.REQUIRES_GOVERNANCE_VOTE || pending.approvalCount > pending.rejectionCount) {
            results.push(await this.approvePendingToken(pendingId, 'APPROVED_BY_GOVERNANCE'));
          }
        }
      }
    }

    return results;
  }

  /**
   * Approve pending token
   */
  async approvePendingToken(pendingId, reason) {
    const pending = this.pendingTokens.get(pendingId);
    if (!pending) throw new Error('Pending token not found');

    pending.status = 'APPROVED';
    pending.resolvedAt = Date.now();
    pending.resolution = reason;

    // Recreate token and finalize
    const token = ARC20Token.fromJSON(pending.token, this.stateManager);
    const result = await this.finalizeTokenCreation(
      token,
      pending.creator,
      BigInt(pending.stake)
    );

    return {
      pendingId,
      ...result,
      resolution: reason
    };
  }

  /**
   * Reject pending token
   */
  rejectPendingToken(pendingId, status, reason) {
    const pending = this.pendingTokens.get(pendingId);
    if (!pending) throw new Error('Pending token not found');

    pending.status = status;
    pending.resolvedAt = Date.now();
    pending.resolution = reason;

    // Refund stake (minus fee for spam prevention)
    const stake = BigInt(pending.stake);
    const fee = stake / 10n; // 10% fee for rejected tokens
    const refund = stake - fee;

    this.stateManager.updateBalance(pending.creator, refund);

    this.stats.rejectedTokens++;

    this.emit('TokenRejected', {
      pendingId,
      symbol: pending.token.symbol,
      reason,
      refund: refund.toString()
    });

    return {
      status: 'REJECTED',
      reason,
      refund: refund.toString()
    };
  }

  // ============================================
  // Query Methods
  // ============================================

  /**
   * Get token by address
   */
  getToken(address) {
    return this.tokens.get(address);
  }

  /**
   * Get token by symbol
   */
  getTokenBySymbol(symbol) {
    const address = this.symbolRegistry.get(symbol.toUpperCase());
    return address ? this.tokens.get(address) : null;
  }

  /**
   * Get all tokens
   */
  getAllTokens() {
    return Array.from(this.tokens.values()).map(t => t.getInfo());
  }

  /**
   * Get pending tokens
   */
  getPendingTokens() {
    return Array.from(this.pendingTokens.values())
      .filter(p => p.status === 'PENDING');
  }

  /**
   * Get tokens by creator
   */
  getTokensByCreator(creator) {
    return Array.from(this.tokens.values())
      .filter(t => t.creator === creator)
      .map(t => t.getInfo());
  }

  /**
   * Get tokens by tier
   */
  getTokensByTier(tier) {
    return Array.from(this.tokens.values())
      .filter(t => t.tier === tier)
      .map(t => t.getInfo());
  }

  /**
   * Get factory statistics
   */
  getStats() {
    return {
      ...this.stats,
      totalStakeLocked: this.stats.totalStakeLocked.toString(),
      pendingTokens: this.getPendingTokens().length,
      totalSymbols: this.symbolRegistry.size
    };
  }

  /**
   * Get tier requirements
   */
  getTierRequirements() {
    return Object.entries(GenesisConfig.TOKEN_TIERS).map(([tier, config]) => ({
      tier,
      name: config.NAME,
      stakeRequired: config.STAKE_REQUIRED.toString(),
      maxSupply: config.MAX_SUPPLY?.toString() || 'Unlimited',
      requiresVerification: config.REQUIRES_VERIFICATION,
      autoApproved: config.AUTO_APPROVED,
      reviewPeriodHours: config.REVIEW_PERIOD_HOURS || 0,
      canCreateSidechain: config.CAN_CREATE_SIDECHAIN || false
    }));
  }

  // ============================================
  // Token Operations
  // ============================================

  /**
   * Transfer tokens
   */
  transferToken(tokenAddress, from, to, amount) {
    const token = this.tokens.get(tokenAddress);
    if (!token) throw new Error('Token not found');

    return token.transfer(from, to, amount);
  }

  /**
   * Approve token spending
   */
  approveToken(tokenAddress, owner, spender, amount) {
    const token = this.tokens.get(tokenAddress);
    if (!token) throw new Error('Token not found');

    return token.approve(owner, spender, amount);
  }

  /**
   * Transfer tokens from
   */
  transferTokenFrom(tokenAddress, spender, from, to, amount) {
    const token = this.tokens.get(tokenAddress);
    if (!token) throw new Error('Token not found');

    return token.transferFrom(spender, from, to, amount);
  }

  /**
   * Mint tokens (if allowed)
   */
  mintToken(tokenAddress, minter, to, amount) {
    const token = this.tokens.get(tokenAddress);
    if (!token) throw new Error('Token not found');

    return token.mint(minter, to, amount);
  }

  /**
   * Burn tokens (if allowed)
   */
  burnToken(tokenAddress, from, amount) {
    const token = this.tokens.get(tokenAddress);
    if (!token) throw new Error('Token not found');

    return token.burn(from, amount);
  }

  // ============================================
  // Serialization
  // ============================================

  /**
   * Export factory state
   */
  toJSON() {
    return {
      tokens: Array.from(this.tokens.entries()).map(([addr, token]) => [addr, token.toJSON()]),
      symbolRegistry: Array.from(this.symbolRegistry.entries()),
      pendingTokens: Array.from(this.pendingTokens.entries()),
      stats: {
        ...this.stats,
        totalStakeLocked: this.stats.totalStakeLocked.toString()
      }
    };
  }

  /**
   * Import factory state
   */
  fromJSON(json) {
    this.tokens = new Map(
      json.tokens.map(([addr, data]) => [addr, ARC20Token.fromJSON(data, this.stateManager)])
    );
    this.symbolRegistry = new Map(json.symbolRegistry);
    this.pendingTokens = new Map(json.pendingTokens);
    this.stats = {
      ...json.stats,
      totalStakeLocked: BigInt(json.stats.totalStakeLocked)
    };
  }
}

module.exports = TokenFactory;
