/**
 * UBI Engine
 *
 * Manages Universal Basic Income distribution for the Ankh blockchain.
 * Handles lifetime allocations, monthly vesting, and claim processing.
 */

const crypto = require('crypto');
const GenesisConfig = require('../core/GenesisConfig');

class UBIEngine {
  constructor(stateManager) {
    this.stateManager = stateManager;

    // Economic parameters
    this.lifetimeValueUSD = GenesisConfig.LIFETIME_VALUE_USD;
    this.distributionMonths = GenesisConfig.DISTRIBUTION_MONTHS;
    this.monthlyAmount = GenesisConfig.calculateMonthlyUBI();
    this.vestingStartAge = GenesisConfig.VESTING_START_AGE;
    this.vestingEndAge = GenesisConfig.VESTING_END_AGE;

    // Statistics
    this.stats = {
      totalDistributed: 0n,
      totalClaims: 0,
      totalVerifiedUsers: 0,
      averageClaimAmount: 0n,
      claimsByMonth: new Map()
    };
  }

  /**
   * Initialize UBI allocation for a newly verified user
   */
  initializeAllocation(address, verificationTimestamp = Date.now()) {
    const allocation = {
      address,
      verificationId: crypto.randomUUID(),

      // Allocation amounts
      lifetimeAllocation: this.lifetimeValueUSD * GenesisConfig.DECIMAL_MULTIPLIER,
      monthlyAmount: this.monthlyAmount,

      // Vesting schedule
      vestingStartDate: verificationTimestamp,
      vestingEndDate: verificationTimestamp + (this.distributionMonths * 30 * 24 * 60 * 60 * 1000),

      // Claim tracking
      monthsClaimed: 0,
      totalClaimed: 0n,
      lastClaimTimestamp: null,
      nextClaimAvailable: verificationTimestamp, // Can claim immediately

      // Status
      status: 'ACTIVE',
      pausedAt: null,
      pauseReason: null,

      // Metadata
      createdAt: verificationTimestamp,
      updatedAt: verificationTimestamp
    };

    this.stateManager.ubiAllocations.set(address, allocation);
    this.stats.totalVerifiedUsers++;

    return allocation;
  }

  /**
   * Process UBI claim for an address
   */
  processClaim(address) {
    const allocation = this.stateManager.ubiAllocations.get(address);

    if (!allocation) {
      throw new Error('No UBI allocation found. User must be verified first.');
    }

    if (allocation.status !== 'ACTIVE') {
      throw new Error(`UBI allocation is ${allocation.status}: ${allocation.pauseReason || 'unknown reason'}`);
    }

    const now = Date.now();

    // Check if claim is available
    if (now < allocation.nextClaimAvailable) {
      const waitMs = allocation.nextClaimAvailable - now;
      const waitDays = Math.ceil(waitMs / (24 * 60 * 60 * 1000));
      throw new Error(`Next claim available in ${waitDays} days`);
    }

    // Check if allocation exhausted
    if (allocation.monthsClaimed >= this.distributionMonths) {
      throw new Error('Lifetime UBI allocation has been fully distributed');
    }

    // Calculate claim amount
    const claimAmount = allocation.monthlyAmount;

    // Update allocation
    allocation.monthsClaimed++;
    allocation.totalClaimed += claimAmount;
    allocation.lastClaimTimestamp = now;
    allocation.nextClaimAvailable = now + (30 * 24 * 60 * 60 * 1000); // Next month
    allocation.updatedAt = now;

    // Credit account
    this.stateManager.updateBalance(address, claimAmount);

    // Update stats
    this.stats.totalDistributed += claimAmount;
    this.stats.totalClaims++;

    const monthKey = new Date(now).toISOString().substring(0, 7); // YYYY-MM
    const monthStats = this.stats.claimsByMonth.get(monthKey) || { claims: 0, amount: 0n };
    monthStats.claims++;
    monthStats.amount += claimAmount;
    this.stats.claimsByMonth.set(monthKey, monthStats);

    return {
      claimId: crypto.randomUUID(),
      address,
      amount: claimAmount,
      monthsClaimed: allocation.monthsClaimed,
      remainingMonths: this.distributionMonths - allocation.monthsClaimed,
      totalClaimed: allocation.totalClaimed,
      remainingAllocation: allocation.lifetimeAllocation - allocation.totalClaimed,
      nextClaimAvailable: allocation.nextClaimAvailable,
      timestamp: now
    };
  }

  /**
   * Calculate claimable amount (including any missed months)
   */
  calculateClaimableAmount(address) {
    const allocation = this.stateManager.ubiAllocations.get(address);
    if (!allocation) return { claimable: 0n, months: 0 };

    if (allocation.status !== 'ACTIVE') {
      return { claimable: 0n, months: 0, reason: allocation.pauseReason };
    }

    const now = Date.now();
    if (now < allocation.nextClaimAvailable) {
      return { claimable: 0n, months: 0 };
    }

    // Calculate how many months could be claimed
    const msSinceLastClaim = now - (allocation.lastClaimTimestamp || allocation.vestingStartDate);
    const monthsSinceLastClaim = Math.floor(msSinceLastClaim / (30 * 24 * 60 * 60 * 1000));
    const remainingMonths = this.distributionMonths - allocation.monthsClaimed;
    const claimableMonths = Math.min(monthsSinceLastClaim, remainingMonths, 1); // Max 1 month at a time

    return {
      claimable: allocation.monthlyAmount * BigInt(claimableMonths),
      months: claimableMonths
    };
  }

  /**
   * Get UBI status for an address
   */
  getStatus(address) {
    const allocation = this.stateManager.ubiAllocations.get(address);
    if (!allocation) return null;

    const now = Date.now();
    const canClaim = allocation.status === 'ACTIVE' &&
      now >= allocation.nextClaimAvailable &&
      allocation.monthsClaimed < this.distributionMonths;

    const vestingProgress = allocation.monthsClaimed / this.distributionMonths;
    const remainingAllocation = allocation.lifetimeAllocation - allocation.totalClaimed;

    return {
      address,
      status: allocation.status,

      // Amounts
      lifetimeAllocation: allocation.lifetimeAllocation.toString(),
      monthlyAmount: allocation.monthlyAmount.toString(),
      totalClaimed: allocation.totalClaimed.toString(),
      remainingAllocation: remainingAllocation.toString(),

      // Progress
      monthsClaimed: allocation.monthsClaimed,
      remainingMonths: this.distributionMonths - allocation.monthsClaimed,
      vestingProgress: (vestingProgress * 100).toFixed(2) + '%',

      // Timing
      vestingStartDate: allocation.vestingStartDate,
      vestingEndDate: allocation.vestingEndDate,
      lastClaimTimestamp: allocation.lastClaimTimestamp,
      nextClaimAvailable: allocation.nextClaimAvailable,

      // Claim info
      canClaim,
      waitTimeMs: canClaim ? 0 : Math.max(0, allocation.nextClaimAvailable - now)
    };
  }

  /**
   * Pause UBI allocation (for fraud investigation, etc.)
   */
  pauseAllocation(address, reason, adminAddress) {
    const allocation = this.stateManager.ubiAllocations.get(address);
    if (!allocation) throw new Error('Allocation not found');

    allocation.status = 'PAUSED';
    allocation.pausedAt = Date.now();
    allocation.pauseReason = reason;
    allocation.pausedBy = adminAddress;
    allocation.updatedAt = Date.now();

    return allocation;
  }

  /**
   * Resume paused allocation
   */
  resumeAllocation(address, adminAddress) {
    const allocation = this.stateManager.ubiAllocations.get(address);
    if (!allocation) throw new Error('Allocation not found');
    if (allocation.status !== 'PAUSED') throw new Error('Allocation is not paused');

    allocation.status = 'ACTIVE';
    allocation.pausedAt = null;
    allocation.pauseReason = null;
    allocation.resumedBy = adminAddress;
    allocation.resumedAt = Date.now();
    allocation.updatedAt = Date.now();

    return allocation;
  }

  /**
   * Terminate allocation permanently (for confirmed fraud)
   */
  terminateAllocation(address, reason, adminAddress) {
    const allocation = this.stateManager.ubiAllocations.get(address);
    if (!allocation) throw new Error('Allocation not found');

    allocation.status = 'TERMINATED';
    allocation.terminatedAt = Date.now();
    allocation.terminationReason = reason;
    allocation.terminatedBy = adminAddress;
    allocation.updatedAt = Date.now();

    // The remaining allocation is returned to the pool (not distributed)
    return {
      allocation,
      forfeitedAmount: allocation.lifetimeAllocation - allocation.totalClaimed
    };
  }

  /**
   * Get global UBI statistics
   */
  getGlobalStats() {
    const allocations = Array.from(this.stateManager.ubiAllocations.values());

    const activeAllocations = allocations.filter(a => a.status === 'ACTIVE');
    const pausedAllocations = allocations.filter(a => a.status === 'PAUSED');
    const terminatedAllocations = allocations.filter(a => a.status === 'TERMINATED');

    const totalAllocated = allocations.reduce((sum, a) => sum + a.lifetimeAllocation, 0n);
    const totalClaimed = allocations.reduce((sum, a) => sum + a.totalClaimed, 0n);
    const totalRemaining = totalAllocated - totalClaimed;

    // Calculate maximum possible supply
    const maxPopulation = GenesisConfig.MAX_GLOBAL_POPULATION;
    const maxPossibleSupply = maxPopulation * this.lifetimeValueUSD * GenesisConfig.DECIMAL_MULTIPLIER;

    // Calculate current issuance
    const currentIssuance = totalClaimed;
    const issuancePercent = maxPossibleSupply > 0n
      ? (Number(currentIssuance * 10000n / maxPossibleSupply) / 100).toFixed(4)
      : '0';

    return {
      // Population
      verifiedUsers: allocations.length,
      activeUsers: activeAllocations.length,
      pausedUsers: pausedAllocations.length,
      terminatedUsers: terminatedAllocations.length,
      maxPopulation: maxPopulation.toString(),
      populationPercent: ((allocations.length / Number(maxPopulation)) * 100).toFixed(8),

      // Supply
      maxPossibleSupply: maxPossibleSupply.toString(),
      totalAllocated: totalAllocated.toString(),
      totalClaimed: totalClaimed.toString(),
      totalRemaining: totalRemaining.toString(),
      currentIssuance: currentIssuance.toString(),
      issuancePercent,

      // Distribution
      totalClaims: this.stats.totalClaims,
      averageClaimsPerUser: allocations.length > 0
        ? (this.stats.totalClaims / allocations.length).toFixed(2)
        : '0',

      // Economics
      lifetimeValuePerPerson: this.lifetimeValueUSD.toString(),
      monthlyUBIAmount: this.monthlyAmount.toString(),
      distributionPeriodMonths: this.distributionMonths,
      vestingStartAge: this.vestingStartAge,
      vestingEndAge: this.vestingEndAge
    };
  }

  /**
   * Simulate future UBI distribution
   */
  simulateDistribution(years = 10, newUsersPerYear = 100_000_000) {
    const simulation = {
      years: [],
      totalDistributed: 0n,
      totalUsers: 0
    };

    let cumulativeUsers = this.stats.totalVerifiedUsers;
    let cumulativeDistributed = this.stats.totalDistributed;

    for (let year = 1; year <= years; year++) {
      cumulativeUsers += newUsersPerYear;

      // Each existing user claims 12 months
      const yearlyDistribution = BigInt(cumulativeUsers) * this.monthlyAmount * 12n;
      cumulativeDistributed += yearlyDistribution;

      simulation.years.push({
        year,
        newUsers: newUsersPerYear,
        totalUsers: cumulativeUsers,
        yearlyDistribution: yearlyDistribution.toString(),
        cumulativeDistribution: cumulativeDistributed.toString()
      });
    }

    simulation.totalDistributed = cumulativeDistributed;
    simulation.totalUsers = cumulativeUsers;

    return simulation;
  }

  /**
   * Export allocation data (for auditing)
   */
  exportAllocations() {
    return Array.from(this.stateManager.ubiAllocations.entries()).map(([address, allocation]) => ({
      address,
      status: allocation.status,
      monthsClaimed: allocation.monthsClaimed,
      totalClaimed: allocation.totalClaimed.toString(),
      remainingAllocation: (allocation.lifetimeAllocation - allocation.totalClaimed).toString(),
      vestingStartDate: new Date(allocation.vestingStartDate).toISOString(),
      vestingEndDate: new Date(allocation.vestingEndDate).toISOString(),
      lastClaimTimestamp: allocation.lastClaimTimestamp
        ? new Date(allocation.lastClaimTimestamp).toISOString()
        : null
    }));
  }
}

module.exports = UBIEngine;
