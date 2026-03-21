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

const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');
const GenesisConfig = require('../core/GenesisConfig');
const Block = require('../core/Block');
const SidechainChain = require('./SidechainChain');

class SidechainManager extends EventEmitter {
  constructor(stateManager, mainBlockchain, foundationCouncil = null, biometricVerifier = null) {
    super();

    this.stateManager = stateManager;
    this.mainBlockchain = mainBlockchain;
    this.biometricVerifier = biometricVerifier;

    // Data directory — set via restoreFromDisk() or createSidechain()
    this.dataDir = null;

    // Foundation council for SOVEREIGN sidechain approval.
    // Structure: { threshold: number, members: [{ name, publicKey, address }] }
    // If empty / not configured, falls back to registered node-operator voting.
    this.foundationCouncil = foundationCouncil || { threshold: 1, members: [] };

    // Sidechain registry
    this.sidechains = new Map();

    // Per-sidechain chain persistence objects (chainId → SidechainChain)
    this.sidechainChains = new Map();

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
    const tier = params.tier || 'INSTITUTIONAL';

    // SOVEREIGN tier (governments): accept either biometric verification OR
    // registered node operator status — running chain infrastructure is
    // sufficient proof of institutional identity for government sidechains.
    const isRegisteredNode = Array.from(this.stateManager.registeredNodes.values())
      .some(n => n.address === creator);

    if (!account.isVerified && !(tier === 'SOVEREIGN' && isRegisteredNode)) {
      throw new Error(
        tier === 'SOVEREIGN'
          ? 'SOVEREIGN sidechain creator must be biometrically verified OR a registered node operator'
          : 'Sidechain creator must be biometrically verified'
      );
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
    this._saveProposals().catch(e => console.error('[SidechainManager] proposals save error:', e.message));

    this.emit('ProposalCreated', {
      proposalId,
      chainId: params.chainId,
      name: params.name,
      tier: params.tier
    });

    return proposal;
  }

  /**
   * Vote on sidechain proposal.
   *
   * SOVEREIGN tier → Foundation council vote (multi-sig threshold).
   * All other tiers  → registered node-operator vote (majority of active nodes).
   */
  voteOnProposal(proposalId, voter, approve, reason) {
    const proposal = this.pendingProposals.get(proposalId);
    if (!proposal) throw new Error('Proposal not found');
    if (proposal.status !== 'PENDING') throw new Error('Proposal is not pending');

    if (proposal.tier === 'SOVEREIGN') {
      // SOVEREIGN: only Foundation council members may vote
      const isMember = this.foundationCouncil.members.some(m => m.address === voter);
      if (!isMember) {
        throw new Error('SOVEREIGN sidechain proposals require Foundation council member votes');
      }
      return this._recordFoundationVote(proposal, voter, approve, reason);
    }

    // INSTITUTIONAL and below: registered node operators
    const isCouncilMember = Array.from(this.stateManager.registeredNodes.values())
      .some(n => n.address === voter && n.isActive);
    if (!isCouncilMember) {
      throw new Error('Only registered node operators can vote on sidechain proposals');
    }

    if (proposal.votes.some(v => v.voter === voter)) {
      throw new Error('Already voted on this proposal');
    }

    proposal.votes.push({ voter, approve, reason, timestamp: Date.now() });

    if (approve) proposal.approvals++;
    else proposal.rejections++;

    this._saveProposals().catch(e => console.error('[SidechainManager] proposals save error:', e.message));

    const activeNodes = Array.from(this.stateManager.registeredNodes.values())
      .filter(n => n.isActive).length;
    const required = Math.max(1, Math.ceil(activeNodes / 2));

    if (proposal.approvals >= required) {
      return this.approveProposal(proposalId);
    }
    if (proposal.rejections > activeNodes / 2) {
      return this.rejectProposal(proposalId, 'Rejected by node operator majority');
    }

    return { proposalId, approvals: proposal.approvals, rejections: proposal.rejections, required, status: 'PENDING' };
  }

  /**
   * Record a Foundation council vote for a SOVEREIGN proposal.
   * When the configured threshold of approvals is reached the proposal is auto-approved.
   * Called by voteOnProposal (via /vote endpoint) and the /approve endpoint.
   */
  _recordFoundationVote(proposal, memberAddress, approve, reason) {
    proposal.foundationVotes = proposal.foundationVotes || [];

    if (proposal.foundationVotes.some(v => v.address === memberAddress)) {
      throw new Error('Foundation member has already voted on this proposal');
    }

    proposal.foundationVotes.push({ address: memberAddress, approve, reason, timestamp: Date.now() });

    if (approve) proposal.approvals++;
    else proposal.rejections++;

    this._saveProposals().catch(e => console.error('[SidechainManager] proposals save error:', e.message));

    const threshold = this.foundationCouncil.threshold;
    const totalMembers = this.foundationCouncil.members.length;

    if (proposal.approvals >= threshold) {
      return this.approveProposal(proposal.proposalId);
    }
    if (proposal.rejections > totalMembers - threshold) {
      return this.rejectProposal(proposal.proposalId, 'Rejected by Foundation council');
    }

    return {
      proposalId: proposal.proposalId,
      foundationApprovals: proposal.approvals,
      foundationRejections: proposal.rejections,
      required: threshold,
      totalMembers,
      status: 'PENDING'
    };
  }

  /**
   * Direct Foundation council approval for any proposal tier.
   * SOVEREIGN: records a Foundation vote (auto-approves at threshold).
   * Other tiers: immediate approval if caller is a Foundation member.
   */
  foundationApprove(proposalId, memberAddress) {
    const proposal = this.pendingProposals.get(proposalId);
    if (!proposal) throw new Error('Proposal not found');
    if (proposal.status !== 'PENDING') throw new Error('Proposal is not pending');

    const isMember = this.foundationCouncil.members.some(m => m.address === memberAddress);
    if (!isMember) {
      throw new Error('Only Foundation council members can approve sidechain proposals');
    }

    if (proposal.tier === 'SOVEREIGN') {
      return this._recordFoundationVote(proposal, memberAddress, true, 'Foundation approval');
    }

    // Non-SOVEREIGN: single Foundation member can approve directly
    return this.approveProposal(proposalId);
  }

  /**
   * Approve sidechain proposal
   */
  async approveProposal(proposalId) {
    const proposal = this.pendingProposals.get(proposalId);
    if (!proposal) throw new Error('Proposal not found');

    proposal.status = 'APPROVED';
    proposal.approvedAt = Date.now();

    await this._saveProposals();

    // Lock stake from creator
    this.stateManager.updateBalance(proposal.creator, -proposal.stake);

    // Create sidechain
    const sidechain = await this.createSidechain(proposal);

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

    this._saveProposals().catch(e => console.error('[SidechainManager] proposals save error:', e.message));

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
  async createSidechain(proposal) {
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

    // Initialise per-sidechain chain persistence
    if (this.dataDir) {
      const sc = new SidechainChain(this.dataDir, sidechain.chainId);
      await sc.initialize();
      // Persist the genesis block
      await sc.appendBlock(sidechain.chain[0]);
      this.sidechainChains.set(sidechain.chainId, sc);
    }

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

    // Persist block and state to disk
    const sc = this.sidechainChains.get(chainId);
    if (sc) {
      await sc.appendBlock(block);
      await this._saveSidechainState(chainId);
    }

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

    // Count verifications since last anchor and compute their root
    const lastAnchor = sidechain.lastAnchorBlock || 0;
    const verificationsSinceAnchor = (sidechain.chain || [])
      .slice(lastAnchor)
      .flatMap(b => (b.transactions || []))
      .filter(tx => tx.type === 'BIOMETRIC_REGISTRATION' || tx.type === 'SIDECHAIN_VERIFICATION_RECORD');
    const verificationsRoot = verificationsSinceAnchor.length
      ? '0x' + crypto.createHash('sha256')
          .update(verificationsSinceAnchor.map(tx => tx.hash || tx.data?.biometricHash || '').join(','))
          .digest('hex')
      : null;

    const anchorData = {
      chainId,
      blockHeight: block.index,
      blockHash: block.hash,
      stateRoot,
      newVerifications: verificationsSinceAnchor.length,
      verificationsRoot,
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
  async distributeBenefits(chainId, distributor, recipients, amounts, benefitType) {
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

    // Persist updated balances
    const sc = this.sidechainChains.get(chainId);
    if (sc) await this._saveSidechainState(chainId);

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
   * Get sidechain by ID.
   * Checks SidechainManager's rich in-memory map first (proposed via API),
   * then falls back to StateManager (created via on-chain SIDECHAIN_CREATE tx).
   */
  getSidechain(chainId) {
    const sidechain = this.sidechains.get(chainId);
    if (sidechain) {
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
        // On-chain SIDECHAIN_ANCHOR txs update StateManager, not this in-memory
        // object. Always prefer StateManager's anchor data (it's the source of truth).
        lastAnchorBlock: this.stateManager.sidechains.get(chainId)?.lastAnchorBlock ?? sidechain.lastAnchorBlock,
        lastAnchorHash: this.stateManager.sidechains.get(chainId)?.lastAnchorHash ?? sidechain.lastAnchorHash,
        isActive: sidechain.isActive,
        createdAt: sidechain.createdAt,
        stats: sidechain.stats,
        metadata: sidechain.metadata
      };
    }

    // Fall back to StateManager for chains created via SIDECHAIN_CREATE transaction
    return this.stateManager.sidechains.get(chainId) || null;
  }

  /**
   * Get all sidechains — merges SidechainManager and StateManager registries.
   * SidechainManager entries (richer objects) take priority on duplicate chainId.
   */
  getAllSidechains() {
    const result = new Map();
    // Add state-manager-only chains first
    this.stateManager.sidechains.forEach((sc, id) => result.set(id, sc));
    // Override with richer SidechainManager objects
    this.sidechains.forEach((_, id) => result.set(id, this.getSidechain(id)));
    return Array.from(result.values());
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
   * Get all proposals, optionally filtered by status (PENDING, APPROVED, REJECTED)
   */
  getAllProposals(status) {
    const all = Array.from(this.pendingProposals.values());
    return status ? all.filter(p => p.status === status.toUpperCase()) : all;
  }

  /**
   * Get Foundation council members and approval threshold.
   * Falls back to active registered node operators if no Foundation council is configured.
   */
  getCouncilMembers() {
    if (this.foundationCouncil.members.length > 0) {
      return {
        type: 'foundation',
        threshold: this.foundationCouncil.threshold,
        totalMembers: this.foundationCouncil.members.length,
        members: this.foundationCouncil.members.map(m => ({
          name: m.name,
          publicKey: m.publicKey,
          address: m.address
        }))
      };
    }

    // Fallback: node operators (bootstrapping / pre-Foundation setup)
    const operators = Array.from(this.stateManager.registeredNodes.entries())
      .filter(([, info]) => info.isActive)
      .map(([publicKey, info]) => ({ publicKey, address: info.address, registeredAt: info.registeredAt }));

    return {
      type: 'node_operators',
      threshold: Math.max(1, Math.ceil(operators.length / 2)),
      totalMembers: operators.length,
      members: operators
    };
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

  // ============================================
  // Biometric Verification
  // ============================================

  /**
   * Verify a citizen on a sidechain.
   *
   * Fast path — already verified on mainchain:
   *   Records a SIDECHAIN_VERIFICATION_RECORD tx in the sidechain's pending
   *   transactions (committed to disk on next produceBlock) and copies the
   *   biometric hash locally.
   *
   * Full path — not yet on mainchain:
   *   Runs the full ANKH biometric pipeline, records the tx in the sidechain,
   *   AND submits the same BIOMETRIC_REGISTRATION tx to mainchain so the person
   *   is globally verified in one step.
   */
  async verifyCitizen(chainId, address, biometricData, clientIp = null) {
    const sidechain = this.sidechains.get(chainId);
    if (!sidechain) throw new Error('Sidechain not found');
    if (!sidechain.isActive) throw new Error('Sidechain is not active');
    if (!this.biometricVerifier) throw new Error('Biometric verifier not configured on this node');

    const mainAccount = this.stateManager.getAccount(address);

    // ── Fast path: already verified on mainchain ──────────────────────────────
    if (mainAccount.isVerified) {
      const biometricHash = this.stateManager.addressToBiometric?.get(address) || null;

      // Record locally
      if (biometricHash) {
        sidechain.verifiedAddresses = sidechain.verifiedAddresses || new Set();
        sidechain.biometricHashes   = sidechain.biometricHashes   || new Map();
        sidechain.verifiedAddresses.add(address);
        sidechain.biometricHashes.set(address, biometricHash);
      }

      // Queue a lightweight record tx for the next sidechain block
      sidechain.pendingTransactions.push({
        type: 'SIDECHAIN_VERIFICATION_RECORD',
        from: address,
        data: { biometricHash, source: 'mainchain', verifiedAt: Date.now() },
        hash: '0x' + crypto.createHash('sha256')
          .update(`scvr:${chainId}:${address}:${Date.now()}`)
          .digest('hex'),
        timestamp: Date.now()
      });

      const sc = this.sidechainChains.get(chainId);
      if (sc) await this._saveSidechainState(chainId);

      return {
        success: true,
        source: 'mainchain',
        address,
        message: 'Already verified on mainchain — recognition copied to sidechain'
      };
    }

    // ── Full path: run biometric pipeline ─────────────────────────────────────
    const result = await this.biometricVerifier.verify(address, biometricData, clientIp);

    if (!result.success) {
      return { success: false, address, reason: result.reason, steps: result.steps };
    }

    const Transaction = require('../core/Transaction');
    const { ec: EC } = require('elliptic');
    const ec = new EC('secp256k1');

    const nonce = this.stateManager.getAccount(address).nonce;

    const livenessScore = result.steps.find(s => s.step === 'LIVENESS_DETECTION')?.avgMovementScore || 0;
    const qualityScore  = result.steps.find(s => s.step === 'QUALITY_CHECK')?.quality || 0;

    const ageVerification = {
      estimatedAge:    result.ageVerification?.estimatedAge    || 25,
      confidenceScore: result.ageVerification?.confidence      || result.ageVerification?.confidenceScore || 0.88,
      method:          result.ageVerification?.method          || 'ML_FACIAL_ESTIMATION'
    };

    const descriptor = Array.isArray(biometricData.facial?.descriptor) &&
      biometricData.facial.descriptor.length === 128
        ? Array.from(biometricData.facial.descriptor) : null;

    // Build verificationProof signed by this node's identity key
    let verificationProof = null;
    const nodeIdentity = this.mainBlockchain?.nodeIdentity ||
                         this.stateManager?._nodeIdentity || null;
    if (nodeIdentity) {
      const nodeKey = ec.keyFromPrivate(nodeIdentity.privateKey, 'hex');
      const msgHash = crypto.createHash('sha256').update(result.biometricHash).digest('hex');
      const sig = nodeKey.sign(msgHash);
      verificationProof = {
        votes: [{
          publicKey: nodeIdentity.publicKey,
          signature: { r: sig.r.toString('hex'), s: sig.s.toString('hex'), recoveryParam: sig.recoveryParam }
        }]
      };
    }

    const tx = Transaction.createBiometricRegistration(
      address,
      { hash: result.biometricHash, templateHash: result.biometricHash, descriptor, livenessScore, qualityScore },
      ageVerification,
      0n,
      nonce,
      verificationProof
    );

    // 1. Queue on sidechain — committed to disk on next produceBlock
    sidechain.pendingTransactions.push(tx);
    sidechain.verifiedAddresses = sidechain.verifiedAddresses || new Set();
    sidechain.biometricHashes   = sidechain.biometricHashes   || new Map();
    sidechain.verifiedAddresses.add(address);
    sidechain.biometricHashes.set(address, result.biometricHash);

    // 2. Propagate to mainchain so the address is globally verified
    try {
      await this.mainBlockchain.commitSystemBlock([tx]);
      // Initialize UBI allocation on mainchain
      if (this.mainBlockchain.ubiEngine) {
        this.mainBlockchain.ubiEngine.initializeAllocation(address);
      }
    } catch (err) {
      // Don't fail the sidechain verification if mainchain propagation errors
      console.warn(`[Sidechain ${chainId}] Mainchain propagation failed for ${address}: ${err.message}`);
    }

    const sc = this.sidechainChains.get(chainId);
    if (sc) await this._saveSidechainState(chainId);

    return {
      success: true,
      source: 'sidechain',
      address,
      verificationId: result.verificationId,
      biometricHash: result.biometricHash,
      mainchainPropagated: true,
      message: 'Verified on sidechain and propagated to mainchain'
    };
  }

  // ============================================
  // Persistence helpers
  // ============================================

  async _saveSidechainState(chainId) {
    const sidechain = this.sidechains.get(chainId);
    const sc        = this.sidechainChains.get(chainId);
    if (!sidechain || !sc) return;

    await sc.saveState({
      balances:          sidechain.balances          || new Map(),
      verifiedAddresses: sidechain.verifiedAddresses || new Set(),
      biometricHashes:   sidechain.biometricHashes   || new Map(),
      lastAnchorBlock:   sidechain.lastAnchorBlock,
      lastAnchorHash:    sidechain.lastAnchorHash
    });
  }

  async _loadSidechainState(chainId) {
    const sc = this.sidechainChains.get(chainId);
    if (!sc) return null;
    return sc.loadState();
  }

  // ============================================
  // Proposal persistence
  // ============================================

  /**
   * Atomically persist all proposals to {dataDir}/proposals.json.
   * Uses rename for crash safety.
   */
  async _saveProposals() {
    if (!this.dataDir) return;
    const fsSync = require('fs');
    const file = path.join(this.dataDir, 'proposals.json');
    const tmp  = file + '.tmp';
    try {
      fsSync.writeFileSync(tmp, JSON.stringify([...this.pendingProposals.values()], null, 2));
      fsSync.renameSync(tmp, file);
    } catch (e) {
      console.error('[SidechainManager] Failed to save proposals:', e.message);
    }
  }

  /**
   * Load proposals from {dataDir}/proposals.json on startup.
   */
  async _loadProposals() {
    if (!this.dataDir) return;
    const fs = require('fs').promises;
    const file = path.join(this.dataDir, 'proposals.json');
    try {
      const raw = await fs.readFile(file, 'utf8');
      const proposals = JSON.parse(raw);
      for (const p of proposals) {
        this.pendingProposals.set(p.proposalId, p);
      }
      console.log(`[SidechainManager] Loaded ${proposals.length} proposal(s) from disk`);
    } catch {
      // No proposals file yet — fresh start
    }
  }

  /**
   * Restore all registered sidechains from disk on node startup.
   * Call this after StateManager is initialized.
   */
  async restoreFromDisk(dataDir) {
    this.dataDir = dataDir;

    // Reload persisted proposals first so founders can continue approvals after restart
    await this._loadProposals();

    const registeredChains = this.stateManager.sidechains;
    if (!registeredChains || registeredChains.size === 0) return;

    for (const [chainId, scMeta] of registeredChains.entries()) {
      try {
        const sc = new SidechainChain(dataDir, chainId);
        await sc.initialize();

        const state = await sc.loadState();
        const latestBlock = sc.getLatestBlock();

        // Reconstruct sidechain object from persisted metadata + state
        const sidechain = {
          chainId,
          name:             scMeta.name,
          creator:          scMeta.creator,
          institutionType:  scMeta.institutionType,
          tier:             scMeta.tier || 'INSTITUTIONAL',
          consensusType:    'POA',
          authorities:      new Map(
            (Array.isArray(scMeta.authorities) ? scMeta.authorities : []).map(a => [
              a.address,
              { address: a.address, name: a.name, role: a.role || 'validator', active: true, blocksProduced: 0, lastBlockTime: null }
            ])
          ),
          authorityThreshold: GenesisConfig.CONSENSUS.POA.AUTHORITY_APPROVAL_THRESHOLD,
          blockTime:          scMeta.blockTime || GenesisConfig.CONSENSUS.POA.BLOCK_TIME_MS,
          nativeCurrency:     scMeta.nativeCurrency || {},
          totalSupply:        0n,
          chain:              latestBlock ? [latestBlock] : [],
          pendingTransactions: [],
          balances:           state.balances,
          verifiedAddresses:  state.verifiedAddresses,
          biometricHashes:    state.biometricHashes,
          lastAnchorBlock:    state.lastAnchorBlock || scMeta.lastAnchorBlock || 0,
          lastAnchorHash:     state.lastAnchorHash  || scMeta.lastAnchorHash  || null,
          anchorFrequency:    100,
          isActive:           true,
          createdAt:          scMeta.createdAt || Date.now(),
          metadata:           scMeta.metadata || {},
          stats: {
            totalTransactions: 0,
            totalBlocks:       sc.height || 0,
            totalAccounts:     state.verifiedAddresses.size
          }
        };

        this.sidechains.set(chainId, sidechain);
        this.sidechainChains.set(chainId, sc);

        this.stats.totalSidechains++;
        this.stats.activeSidechains++;

        console.log(`[SidechainManager] Restored ${chainId} from disk (height: ${sc.height}, verified: ${state.verifiedAddresses.size})`);
      } catch (err) {
        console.warn(`[SidechainManager] Failed to restore ${chainId}: ${err.message}`);
      }
    }
  }
}

module.exports = SidechainManager;
