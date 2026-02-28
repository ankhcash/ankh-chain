/**
 * Sidechain Manager
 *
 * Manages institutional PoA sidechains for governments and organizations.
 * Features:
 * - PoA consensus with designated authorities
 * - Anchoring to main Ankh chain for security
 * - Custom native currencies
 * - Government/institutional benefit distribution
 */

const crypto = require('crypto');
const EventEmitter = require('events');
const GenesisConfig = require('../core/GenesisConfig');
const Block = require('../core/Block');

class SidechainManager extends EventEmitter {
  constructor(stateManager, mainBlockchain) {
    super();

    this.stateManager = stateManager;
    this.mainBlockchain = mainBlockchain;

    // Sidechain registry
    this.sidechains = new Map();

    // Pending proposals
    this.pendingProposals = new Map();

    // Anchor checkpoints
    this.anchors = new Map(); // chainId -> latest anchor

    // Statistics
    this.stats = {
      totalSidechains: 0,
      activeSidechains: 0,
      totalAnchors: 0,
      sidechainsByType: {}
    };
  }

  /**
   * Propose a new sidechain
   */
  proposeChain(creator, params) {
    // Validate creator
    const account = this.stateManager.getAccount(creator);
    if (!account.isVerified) {
      throw new Error('Sidechain creator must be verified');
    }

    // Check stake for institutional/sovereign tier
    const tierConfig = GenesisConfig.TOKEN_TIERS[params.tier || 'INSTITUTIONAL'];
    if (account.balance < tierConfig.STAKE_REQUIRED) {
      throw new Error(`Insufficient stake for ${params.tier} sidechain`);
    }

    // Validate chain ID uniqueness
    if (this.sidechains.has(params.chainId)) {
      throw new Error('Chain ID already exists');
    }

    // Validate authorities
    if (!params.authorities || params.authorities.length < GenesisConfig.CONSENSUS.POA.MIN_AUTHORITIES) {
      throw new Error(`Minimum ${GenesisConfig.CONSENSUS.POA.MIN_AUTHORITIES} authorities required`);
    }

    const proposalId = crypto.randomUUID();

    const proposal = {
      proposalId,
      chainId: params.chainId,
      name: params.name,
      creator,
      tier: params.tier || 'INSTITUTIONAL',
      institutionType: params.institutionType, // 'government', 'organization', 'cooperative'
      authorities: params.authorities,
      nativeCurrency: params.nativeCurrency || {
        name: params.name + ' Token',
        symbol: params.chainId.substring(0, 4).toUpperCase(),
        decimals: 18,
        initialSupply: 0
      },
      blockTime: params.blockTime || GenesisConfig.CONSENSUS.POA.BLOCK_TIME_MS,
      stake: tierConfig.STAKE_REQUIRED,
      status: 'PENDING',
      votes: [],
      approvals: 0,
      rejections: 0,
      submittedAt: Date.now(),
      metadata: params.metadata || {}
    };

    // Sovereign tier requires council approval
    if (params.tier === 'SOVEREIGN') {
      proposal.requiresCouncilApproval = true;
    }

    this.pendingProposals.set(proposalId, proposal);

    this.emit('ProposalCreated', {
      proposalId,
      chainId: params.chainId,
      name: params.name,
      tier: params.tier
    });

    return proposal;
  }

  /**
   * Vote on sidechain proposal
   */
  voteOnProposal(proposalId, voter, approve, reason) {
    const proposal = this.pendingProposals.get(proposalId);
    if (!proposal) throw new Error('Proposal not found');
    if (proposal.status !== 'PENDING') throw new Error('Proposal is not pending');

    // Verify voter
    const account = this.stateManager.getAccount(voter);
    if (!account.isVerified) {
      throw new Error('Voter must be verified');
    }

    // Check if already voted
    if (proposal.votes.some(v => v.voter === voter)) {
      throw new Error('Already voted on this proposal');
    }

    proposal.votes.push({
      voter,
      approve,
      reason,
      timestamp: Date.now()
    });

    if (approve) {
      proposal.approvals++;
    } else {
      proposal.rejections++;
    }

    // Check consensus
    const totalVotes = proposal.approvals + proposal.rejections;
    const approvalRatio = proposal.approvals / Math.max(totalVotes, 1);

    // Need at least 5 votes and 66% approval for institutional
    if (totalVotes >= 5 && approvalRatio >= 0.66) {
      return this.approveProposal(proposalId);
    }

    // Reject if clearly failing
    if (totalVotes >= 5 && approvalRatio <= 0.34) {
      return this.rejectProposal(proposalId, 'Insufficient approval votes');
    }

    return {
      proposalId,
      approvals: proposal.approvals,
      rejections: proposal.rejections,
      status: 'PENDING'
    };
  }

  /**
   * Approve sidechain proposal
   */
  async approveProposal(proposalId) {
    const proposal = this.pendingProposals.get(proposalId);
    if (!proposal) throw new Error('Proposal not found');

    proposal.status = 'APPROVED';
    proposal.approvedAt = Date.now();

    // Lock stake from creator
    this.stateManager.updateBalance(proposal.creator, -proposal.stake);

    // Create sidechain
    const sidechain = this.createSidechain(proposal);

    this.emit('ProposalApproved', {
      proposalId,
      chainId: sidechain.chainId
    });

    return {
      status: 'APPROVED',
      sidechain
    };
  }

  /**
   * Reject sidechain proposal
   */
  rejectProposal(proposalId, reason) {
    const proposal = this.pendingProposals.get(proposalId);
    if (!proposal) throw new Error('Proposal not found');

    proposal.status = 'REJECTED';
    proposal.rejectedAt = Date.now();
    proposal.rejectionReason = reason;

    this.emit('ProposalRejected', {
      proposalId,
      reason
    });

    return {
      status: 'REJECTED',
      reason
    };
  }

  /**
   * Create sidechain from approved proposal
   */
  createSidechain(proposal) {
    const sidechain = {
      chainId: proposal.chainId,
      name: proposal.name,
      creator: proposal.creator,
      institutionType: proposal.institutionType,
      tier: proposal.tier,

      // Consensus
      consensusType: 'POA',
      authorities: new Map(proposal.authorities.map(a => [
        a.address,
        {
          address: a.address,
          name: a.name,
          role: a.role || 'validator',
          active: true,
          blocksProduced: 0,
          lastBlockTime: null
        }
      ])),
      authorityThreshold: GenesisConfig.CONSENSUS.POA.AUTHORITY_APPROVAL_THRESHOLD,
      blockTime: proposal.blockTime,

      // Native currency
      nativeCurrency: proposal.nativeCurrency,
      totalSupply: BigInt(proposal.nativeCurrency.initialSupply || 0),

      // Chain state
      chain: [this.createSidechainGenesis(proposal)],
      pendingTransactions: [],
      balances: new Map(),
      accounts: new Map(),

      // Main chain anchoring
      lastAnchorBlock: 0,
      lastAnchorHash: null,
      anchorFrequency: 100, // Anchor every 100 blocks

      // Status
      isActive: true,
      createdAt: Date.now(),
      metadata: proposal.metadata,

      // Statistics
      stats: {
        totalTransactions: 0,
        totalBlocks: 1,
        totalAccounts: 0
      }
    };

    this.sidechains.set(sidechain.chainId, sidechain);

    // Register in main state
    this.stateManager.registerSidechain(sidechain.chainId, {
      name: sidechain.name,
      authorities: proposal.authorities,
      blockTime: sidechain.blockTime,
      nativeCurrency: sidechain.nativeCurrency,
      institutionType: sidechain.institutionType,
      metadata: sidechain.metadata
    }, proposal.creator);

    // Update stats
    this.stats.totalSidechains++;
    this.stats.activeSidechains++;
    this.stats.sidechainsByType[sidechain.institutionType] =
      (this.stats.sidechainsByType[sidechain.institutionType] || 0) + 1;

    this.emit('SidechainCreated', {
      chainId: sidechain.chainId,
      name: sidechain.name,
      institutionType: sidechain.institutionType
    });

    return sidechain;
  }

  /**
   * Create genesis block for sidechain
   */
  createSidechainGenesis(proposal) {
    return new Block({
      index: 0,
      timestamp: Date.now(),
      transactions: [],
      previousHash: GenesisConfig.GENESIS_HASH,
      validator: 'genesis',
      consensusType: 'POA',
      sidechainId: proposal.chainId,
      extraData: {
        chainId: proposal.chainId,
        name: proposal.name,
        institutionType: proposal.institutionType,
        authorities: proposal.authorities.map(a => a.address),
        nativeCurrency: proposal.nativeCurrency,
        message: `${proposal.name} Sidechain Genesis`
      }
    });
  }

  // ============================================
  // Sidechain Operations
  // ============================================

  /**
   * Produce block on sidechain (by authority)
   */
  async produceBlock(chainId, authorityAddress) {
    const sidechain = this.sidechains.get(chainId);
    if (!sidechain) throw new Error('Sidechain not found');
    if (!sidechain.isActive) throw new Error('Sidechain is not active');

    // Verify authority
    const authority = sidechain.authorities.get(authorityAddress);
    if (!authority || !authority.active) {
      throw new Error('Not an active authority for this sidechain');
    }

    const previousBlock = sidechain.chain[sidechain.chain.length - 1];
    const transactions = sidechain.pendingTransactions.splice(0, 1000);

    const block = new Block({
      index: previousBlock.index + 1,
      timestamp: Date.now(),
      transactions,
      previousHash: previousBlock.hash,
      validator: authorityAddress,
      consensusType: 'POA',
      sidechainId: chainId
    });

    // Add to chain
    sidechain.chain.push(block);

    // Update authority stats
    authority.blocksProduced++;
    authority.lastBlockTime = Date.now();

    // Update sidechain stats
    sidechain.stats.totalBlocks++;
    sidechain.stats.totalTransactions += transactions.length;

    // Check if anchoring needed
    if (block.index % sidechain.anchorFrequency === 0) {
      await this.anchorToMainChain(chainId, block);
    }

    this.emit('SidechainBlock', {
      chainId,
      blockNumber: block.index,
      transactionCount: transactions.length,
      authority: authorityAddress
    });

    return block;
  }

  /**
   * Anchor sidechain state to main chain
   */
  async anchorToMainChain(chainId, block) {
    const sidechain = this.sidechains.get(chainId);
    if (!sidechain) throw new Error('Sidechain not found');

    // Create anchor transaction on main chain
    const stateRoot = this.calculateSidechainStateRoot(sidechain);

    const anchorData = {
      chainId,
      blockHeight: block.index,
      blockHash: block.hash,
      stateRoot,
      timestamp: Date.now()
    };

    // Store anchor
    sidechain.lastAnchorBlock = block.index;
    sidechain.lastAnchorHash = stateRoot;

    this.anchors.set(chainId, anchorData);

    // Record on main state
    this.stateManager.anchorSidechain(chainId, block.index, stateRoot);

    this.stats.totalAnchors++;

    this.emit('SidechainAnchored', anchorData);

    return anchorData;
  }

  /**
   * Calculate sidechain state root
   */
  calculateSidechainStateRoot(sidechain) {
    const stateData = {
      balances: Array.from(sidechain.balances.entries())
        .map(([k, v]) => [k, v.toString()]),
      accounts: sidechain.stats.totalAccounts,
      transactions: sidechain.stats.totalTransactions,
      blocks: sidechain.stats.totalBlocks
    };

    return crypto.createHash('sha256')
      .update(JSON.stringify(stateData))
      .digest('hex');
  }

  // ============================================
  // Authority Management
  // ============================================

  /**
   * Add authority to sidechain
   */
  addAuthority(chainId, requester, newAuthority) {
    const sidechain = this.sidechains.get(chainId);
    if (!sidechain) throw new Error('Sidechain not found');

    // Check requester is creator or existing authority
    if (requester !== sidechain.creator && !sidechain.authorities.has(requester)) {
      throw new Error('Not authorized to add authorities');
    }

    sidechain.authorities.set(newAuthority.address, {
      address: newAuthority.address,
      name: newAuthority.name,
      role: newAuthority.role || 'validator',
      active: true,
      blocksProduced: 0,
      lastBlockTime: null,
      addedAt: Date.now(),
      addedBy: requester
    });

    this.emit('AuthorityAdded', {
      chainId,
      authority: newAuthority.address,
      addedBy: requester
    });

    return sidechain.authorities.get(newAuthority.address);
  }

  /**
   * Remove authority from sidechain
   */
  removeAuthority(chainId, requester, authorityAddress) {
    const sidechain = this.sidechains.get(chainId);
    if (!sidechain) throw new Error('Sidechain not found');

    // Check minimum authorities
    if (sidechain.authorities.size <= GenesisConfig.CONSENSUS.POA.MIN_AUTHORITIES) {
      throw new Error('Cannot remove: minimum authorities required');
    }

    // Check requester is creator
    if (requester !== sidechain.creator) {
      throw new Error('Only creator can remove authorities');
    }

    const authority = sidechain.authorities.get(authorityAddress);
    if (!authority) throw new Error('Authority not found');

    authority.active = false;
    authority.removedAt = Date.now();
    authority.removedBy = requester;

    this.emit('AuthorityRemoved', {
      chainId,
      authority: authorityAddress,
      removedBy: requester
    });

    return { removed: authorityAddress };
  }

  // ============================================
  // Benefit Distribution (for governments)
  // ============================================

  /**
   * Distribute benefits on sidechain
   */
  distributeBenefits(chainId, distributor, recipients, amounts, benefitType) {
    const sidechain = this.sidechains.get(chainId);
    if (!sidechain) throw new Error('Sidechain not found');

    // Verify distributor is authority
    if (!sidechain.authorities.has(distributor)) {
      throw new Error('Distributor must be a sidechain authority');
    }

    // Verify recipients are verified on main chain
    const verifiedRecipients = [];
    const unverifiedRecipients = [];

    for (let i = 0; i < recipients.length; i++) {
      const recipient = recipients[i];
      const amount = BigInt(amounts[i]);

      const account = this.stateManager.getAccount(recipient);
      if (account.isVerified) {
        verifiedRecipients.push({ address: recipient, amount });

        // Credit on sidechain
        const currentBalance = sidechain.balances.get(recipient) || 0n;
        sidechain.balances.set(recipient, currentBalance + amount);
        sidechain.totalSupply += amount;
      } else {
        unverifiedRecipients.push(recipient);
      }
    }

    // Create distribution record
    const distribution = {
      id: crypto.randomUUID(),
      chainId,
      distributor,
      benefitType,
      recipients: verifiedRecipients.length,
      totalAmount: verifiedRecipients.reduce((sum, r) => sum + r.amount, 0n),
      timestamp: Date.now()
    };

    this.emit('BenefitsDistributed', {
      ...distribution,
      totalAmount: distribution.totalAmount.toString(),
      unverifiedSkipped: unverifiedRecipients.length
    });

    return {
      distribution,
      verifiedRecipients: verifiedRecipients.length,
      unverifiedSkipped: unverifiedRecipients.length
    };
  }

  // ============================================
  // Query Methods
  // ============================================

  /**
   * Get sidechain by ID
   */
  getSidechain(chainId) {
    const sidechain = this.sidechains.get(chainId);
    if (!sidechain) return null;

    return {
      chainId: sidechain.chainId,
      name: sidechain.name,
      creator: sidechain.creator,
      institutionType: sidechain.institutionType,
      tier: sidechain.tier,
      consensusType: sidechain.consensusType,
      blockTime: sidechain.blockTime,
      nativeCurrency: sidechain.nativeCurrency,
      totalSupply: sidechain.totalSupply.toString(),
      authorities: Array.from(sidechain.authorities.values()).map(a => ({
        address: a.address,
        name: a.name,
        role: a.role,
        active: a.active,
        blocksProduced: a.blocksProduced
      })),
      lastAnchorBlock: sidechain.lastAnchorBlock,
      lastAnchorHash: sidechain.lastAnchorHash,
      isActive: sidechain.isActive,
      createdAt: sidechain.createdAt,
      stats: sidechain.stats,
      metadata: sidechain.metadata
    };
  }

  /**
   * Get all sidechains
   */
  getAllSidechains() {
    return Array.from(this.sidechains.keys()).map(id => this.getSidechain(id));
  }

  /**
   * Get sidechains by institution type
   */
  getSidechainsByType(institutionType) {
    return Array.from(this.sidechains.values())
      .filter(s => s.institutionType === institutionType)
      .map(s => this.getSidechain(s.chainId));
  }

  /**
   * Get pending proposals
   */
  getPendingProposals() {
    return Array.from(this.pendingProposals.values())
      .filter(p => p.status === 'PENDING');
  }

  /**
   * Get sidechain balance
   */
  getSidechainBalance(chainId, address) {
    const sidechain = this.sidechains.get(chainId);
    if (!sidechain) return 0n;
    return sidechain.balances.get(address) || 0n;
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      pendingProposals: this.getPendingProposals().length
    };
  }
}

module.exports = SidechainManager;
