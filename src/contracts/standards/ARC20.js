/**
 * ARC-20: Ankh Token Standard
 *
 * Similar to ERC-20 but with Ankh-specific features:
 * - Tiered token creation (Community, Standard, Institutional, Sovereign)
 * - Creator biometric linking for accountability
 * - Optional verification requirements for holders
 * - Built-in anti-scam protections
 */

const crypto = require('crypto');
const EventEmitter = require('events');
const GenesisConfig = require('../../core/GenesisConfig');

class ARC20Token extends EventEmitter {
  constructor(params, stateManager) {
    super();

    // Token identity
    this.address = params.address || this.generateAddress(params);
    this.name = params.name;
    this.symbol = params.symbol;
    this.decimals = params.decimals || 18;

    // Supply
    this.totalSupply = BigInt(params.initialSupply || 0);
    this.maxSupply = params.maxSupply ? BigInt(params.maxSupply) : null;

    // Creation metadata
    this.creator = params.creator;
    this.creatorBiometricHash = params.creatorBiometricHash;
    this.tier = params.tier;
    this.createdAt = params.createdAt || Date.now();
    this.createdAtBlock = params.createdAtBlock || 0;

    // Token capabilities
    this.mintable = params.mintable || false;
    this.burnable = params.burnable || false;
    this.pausable = params.pausable || false;
    this.verifiedHoldersOnly = params.verifiedHoldersOnly || false;

    // State
    this.paused = false;
    this.balances = new Map();
    this.allowances = new Map(); // owner -> (spender -> amount)

    // Governance
    this.owner = params.creator;
    this.minters = new Set([params.creator]);
    this.pausers = new Set([params.creator]);

    // Metadata
    this.metadata = {
      description: params.description || '',
      website: params.website || '',
      logo: params.logo || '',
      social: params.social || {},
      ...params.metadata
    };

    // Anti-scam features
    this.flagCount = 0;
    this.flaggedBy = new Set();
    this.auditStatus = 'UNAUDITED';
    this.auditReport = null;

    // State manager for verification checks
    this.stateManager = stateManager;

    // Initialize creator balance
    if (this.totalSupply > 0n) {
      this.balances.set(this.creator, this.totalSupply);
    }
  }

  /**
   * Generate deterministic token address
   */
  generateAddress(params) {
    const data = `${params.creator}:${params.symbol}:${Date.now()}:${Math.random()}`;
    return 'ankh_arc20_' + crypto.createHash('sha256').update(data).digest('hex').substring(0, 32);
  }

  // ============================================
  // ERC-20 Compatible Interface
  // ============================================

  /**
   * Get total supply
   */
  getTotalSupply() {
    return this.totalSupply;
  }

  /**
   * Get balance of address
   */
  balanceOf(address) {
    return this.balances.get(address) || 0n;
  }

  /**
   * Transfer tokens
   */
  transfer(from, to, amount) {
    this.requireNotPaused();
    this.requireVerifiedIfNeeded(from);
    this.requireVerifiedIfNeeded(to);

    amount = BigInt(amount);

    const fromBalance = this.balanceOf(from);
    if (fromBalance < amount) {
      throw new Error(`Insufficient balance: has ${fromBalance}, needs ${amount}`);
    }

    this.balances.set(from, fromBalance - amount);
    this.balances.set(to, (this.balanceOf(to)) + amount);

    this.emit('Transfer', { from, to, amount: amount.toString() });

    return true;
  }

  /**
   * Approve spender
   */
  approve(owner, spender, amount) {
    this.requireNotPaused();

    amount = BigInt(amount);

    if (!this.allowances.has(owner)) {
      this.allowances.set(owner, new Map());
    }
    this.allowances.get(owner).set(spender, amount);

    this.emit('Approval', { owner, spender, amount: amount.toString() });

    return true;
  }

  /**
   * Get allowance
   */
  allowance(owner, spender) {
    if (!this.allowances.has(owner)) return 0n;
    return this.allowances.get(owner).get(spender) || 0n;
  }

  /**
   * Transfer from (with allowance)
   */
  transferFrom(spender, from, to, amount) {
    this.requireNotPaused();
    this.requireVerifiedIfNeeded(from);
    this.requireVerifiedIfNeeded(to);

    amount = BigInt(amount);

    const currentAllowance = this.allowance(from, spender);
    if (currentAllowance < amount) {
      throw new Error(`Insufficient allowance: has ${currentAllowance}, needs ${amount}`);
    }

    // Reduce allowance
    this.allowances.get(from).set(spender, currentAllowance - amount);

    // Perform transfer
    return this.transfer(from, to, amount);
  }

  // ============================================
  // ARC-20 Extended Functions
  // ============================================

  /**
   * Mint new tokens (if mintable)
   */
  mint(minter, to, amount) {
    if (!this.mintable) {
      throw new Error('Token is not mintable');
    }
    if (!this.minters.has(minter)) {
      throw new Error('Address is not authorized to mint');
    }
    this.requireNotPaused();
    this.requireVerifiedIfNeeded(to);

    amount = BigInt(amount);

    // Check max supply
    if (this.maxSupply !== null && this.totalSupply + amount > this.maxSupply) {
      throw new Error(`Minting would exceed max supply of ${this.maxSupply}`);
    }

    this.totalSupply += amount;
    this.balances.set(to, (this.balanceOf(to)) + amount);

    this.emit('Mint', { minter, to, amount: amount.toString() });
    this.emit('Transfer', { from: 'mint', to, amount: amount.toString() });

    return true;
  }

  /**
   * Burn tokens (if burnable)
   */
  burn(from, amount) {
    if (!this.burnable) {
      throw new Error('Token is not burnable');
    }
    this.requireNotPaused();

    amount = BigInt(amount);

    const balance = this.balanceOf(from);
    if (balance < amount) {
      throw new Error(`Insufficient balance to burn: has ${balance}, wants to burn ${amount}`);
    }

    this.balances.set(from, balance - amount);
    this.totalSupply -= amount;

    this.emit('Burn', { from, amount: amount.toString() });
    this.emit('Transfer', { from, to: 'burn', amount: amount.toString() });

    return true;
  }

  /**
   * Pause all transfers (if pausable)
   */
  pause(pauser) {
    if (!this.pausable) {
      throw new Error('Token is not pausable');
    }
    if (!this.pausers.has(pauser)) {
      throw new Error('Address is not authorized to pause');
    }

    this.paused = true;
    this.emit('Paused', { by: pauser });

    return true;
  }

  /**
   * Unpause transfers
   */
  unpause(pauser) {
    if (!this.pausers.has(pauser)) {
      throw new Error('Address is not authorized to unpause');
    }

    this.paused = false;
    this.emit('Unpaused', { by: pauser });

    return true;
  }

  /**
   * Check if holder is verified (for verified-only tokens)
   */
  isVerifiedHolder(address) {
    if (!this.stateManager) return true;
    const account = this.stateManager.getAccount(address);
    return account && account.isVerified;
  }

  /**
   * Get holder's verification timestamp
   */
  getVerificationTimestamp(address) {
    if (!this.stateManager) return null;
    const user = this.stateManager.getVerifiedUser(address);
    return user ? user.registrationTimestamp : null;
  }

  // ============================================
  // Governance Functions
  // ============================================

  /**
   * Transfer ownership
   */
  transferOwnership(currentOwner, newOwner) {
    if (currentOwner !== this.owner) {
      throw new Error('Only owner can transfer ownership');
    }

    this.owner = newOwner;
    this.emit('OwnershipTransferred', { from: currentOwner, to: newOwner });

    return true;
  }

  /**
   * Add minter
   */
  addMinter(owner, minter) {
    if (owner !== this.owner) {
      throw new Error('Only owner can add minters');
    }

    this.minters.add(minter);
    this.emit('MinterAdded', { minter, by: owner });

    return true;
  }

  /**
   * Remove minter
   */
  removeMinter(owner, minter) {
    if (owner !== this.owner) {
      throw new Error('Only owner can remove minters');
    }

    this.minters.delete(minter);
    this.emit('MinterRemoved', { minter, by: owner });

    return true;
  }

  // ============================================
  // Anti-Scam Features
  // ============================================

  /**
   * Flag token as suspicious (community protection)
   */
  flag(flagger, reason) {
    if (this.flaggedBy.has(flagger)) {
      throw new Error('Already flagged by this address');
    }

    // Flagger must be verified
    if (this.stateManager && !this.isVerifiedHolder(flagger)) {
      throw new Error('Only verified users can flag tokens');
    }

    this.flaggedBy.add(flagger);
    this.flagCount++;

    this.emit('Flagged', {
      flagger,
      reason,
      totalFlags: this.flagCount
    });

    return this.flagCount;
  }

  /**
   * Submit audit report
   */
  submitAudit(auditor, status, report) {
    // In production, would verify auditor credentials
    this.auditStatus = status; // 'PASSED', 'FAILED', 'PENDING'
    this.auditReport = {
      auditor,
      status,
      report,
      timestamp: Date.now()
    };

    this.emit('AuditSubmitted', this.auditReport);

    return this.auditReport;
  }

  // ============================================
  // Helper Methods
  // ============================================

  requireNotPaused() {
    if (this.paused) {
      throw new Error('Token transfers are paused');
    }
  }

  requireVerifiedIfNeeded(address) {
    if (this.verifiedHoldersOnly && address !== 'mint' && address !== 'burn') {
      if (!this.isVerifiedHolder(address)) {
        throw new Error('Token requires verified holders only');
      }
    }
  }

  /**
   * Get holder count
   */
  getHolderCount() {
    return Array.from(this.balances.entries())
      .filter(([_, balance]) => balance > 0n)
      .length;
  }

  /**
   * Get top holders
   */
  getTopHolders(limit = 10) {
    return Array.from(this.balances.entries())
      .filter(([_, balance]) => balance > 0n)
      .sort((a, b) => {
        if (b[1] > a[1]) return 1;
        if (b[1] < a[1]) return -1;
        return 0;
      })
      .slice(0, limit)
      .map(([address, balance]) => ({
        address,
        balance: balance.toString(),
        percentage: ((Number(balance) / Number(this.totalSupply)) * 100).toFixed(4)
      }));
  }

  /**
   * Get token info
   */
  getInfo() {
    return {
      address: this.address,
      name: this.name,
      symbol: this.symbol,
      decimals: this.decimals,
      totalSupply: this.totalSupply.toString(),
      maxSupply: this.maxSupply?.toString() || null,
      creator: this.creator,
      tier: this.tier,
      createdAt: this.createdAt,

      capabilities: {
        mintable: this.mintable,
        burnable: this.burnable,
        pausable: this.pausable,
        verifiedHoldersOnly: this.verifiedHoldersOnly
      },

      state: {
        paused: this.paused,
        holderCount: this.getHolderCount()
      },

      security: {
        flagCount: this.flagCount,
        auditStatus: this.auditStatus
      },

      metadata: this.metadata
    };
  }

  /**
   * Serialize for storage
   */
  toJSON() {
    return {
      address: this.address,
      name: this.name,
      symbol: this.symbol,
      decimals: this.decimals,
      totalSupply: this.totalSupply.toString(),
      maxSupply: this.maxSupply?.toString() || null,
      creator: this.creator,
      creatorBiometricHash: this.creatorBiometricHash,
      tier: this.tier,
      createdAt: this.createdAt,
      createdAtBlock: this.createdAtBlock,
      mintable: this.mintable,
      burnable: this.burnable,
      pausable: this.pausable,
      verifiedHoldersOnly: this.verifiedHoldersOnly,
      paused: this.paused,
      owner: this.owner,
      minters: Array.from(this.minters),
      pausers: Array.from(this.pausers),
      balances: Array.from(this.balances.entries()).map(([k, v]) => [k, v.toString()]),
      allowances: Array.from(this.allowances.entries()).map(([owner, spenders]) => [
        owner,
        Array.from(spenders.entries()).map(([k, v]) => [k, v.toString()])
      ]),
      metadata: this.metadata,
      flagCount: this.flagCount,
      flaggedBy: Array.from(this.flaggedBy),
      auditStatus: this.auditStatus,
      auditReport: this.auditReport
    };
  }

  /**
   * Deserialize from storage
   */
  static fromJSON(json, stateManager) {
    const token = new ARC20Token({
      address: json.address,
      name: json.name,
      symbol: json.symbol,
      decimals: json.decimals,
      initialSupply: 0, // We'll set balances directly
      maxSupply: json.maxSupply,
      creator: json.creator,
      creatorBiometricHash: json.creatorBiometricHash,
      tier: json.tier,
      createdAt: json.createdAt,
      createdAtBlock: json.createdAtBlock,
      mintable: json.mintable,
      burnable: json.burnable,
      pausable: json.pausable,
      verifiedHoldersOnly: json.verifiedHoldersOnly,
      metadata: json.metadata
    }, stateManager);

    token.totalSupply = BigInt(json.totalSupply);
    token.paused = json.paused;
    token.owner = json.owner;
    token.minters = new Set(json.minters);
    token.pausers = new Set(json.pausers);

    // Restore balances
    token.balances = new Map(json.balances.map(([k, v]) => [k, BigInt(v)]));

    // Restore allowances
    token.allowances = new Map(json.allowances.map(([owner, spenders]) => [
      owner,
      new Map(spenders.map(([k, v]) => [k, BigInt(v)]))
    ]));

    token.flagCount = json.flagCount;
    token.flaggedBy = new Set(json.flaggedBy);
    token.auditStatus = json.auditStatus;
    token.auditReport = json.auditReport;

    return token;
  }
}

module.exports = ARC20Token;
