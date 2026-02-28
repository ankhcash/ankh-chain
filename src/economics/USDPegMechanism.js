/**
 * USD Peg Mechanism
 *
 * Maintains the 1 ANKH = $1 USD peg through a hybrid system:
 * - Collateralized backing (treasury reserves)
 * - Oracle price feeds
 * - Supply control mechanisms
 * - Stability fees
 */

const EventEmitter = require('events');
const GenesisConfig = require('../core/GenesisConfig');

class USDPegMechanism extends EventEmitter {
  constructor(stateManager) {
    super();

    this.stateManager = stateManager;

    // Target peg: 1 ANKH = $1 USD
    this.targetPrice = 1.0;
    this.acceptableDeviation = 0.02; // 2% acceptable deviation

    // Oracle configuration
    this.oracles = new Map();
    this.oracleThreshold = 3; // Minimum oracles needed
    this.lastOracleUpdate = null;
    this.currentPrice = 1.0;
    this.priceHistory = [];

    // Collateral reserves
    this.reserves = {
      usd: 0n,                    // USD stablecoin reserves (USDT, USDC, etc.)
      eth: 0n,                    // ETH reserves (valued in USD)
      btc: 0n,                    // BTC reserves (valued in USD)
      totalValueUSD: 0n           // Total collateral in USD
    };

    // Target collateralization ratio
    this.targetCollateralRatio = 1.0;    // 100% backed
    this.minimumCollateralRatio = 0.5;   // 50% minimum before intervention
    this.currentCollateralRatio = 0;

    // Stability mechanisms
    this.stabilityFeeRate = 0.001;       // 0.1% stability fee when over-peg
    this.redemptionFeeRate = 0.001;      // 0.1% redemption fee
    this.isStabilityModeActive = false;

    // Statistics
    this.stats = {
      totalRedemptions: 0,
      totalStabilityFees: 0n,
      priceDeviations: [],
      interventions: []
    };
  }

  /**
   * Register price oracle
   */
  registerOracle(oracleId, oracleAddress, weight = 1) {
    this.oracles.set(oracleId, {
      id: oracleId,
      address: oracleAddress,
      weight,
      lastPrice: this.targetPrice,
      lastUpdate: null,
      isActive: true,
      reliability: 1.0
    });

    return this.oracles.get(oracleId);
  }

  /**
   * Update price from oracle
   */
  updateOraclePrice(oracleId, price, timestamp = Date.now()) {
    const oracle = this.oracles.get(oracleId);
    if (!oracle) throw new Error('Oracle not found');
    if (!oracle.isActive) throw new Error('Oracle is inactive');

    oracle.lastPrice = price;
    oracle.lastUpdate = timestamp;

    // Recalculate aggregate price
    this.calculateAggregatePrice();

    return oracle;
  }

  /**
   * Calculate weighted average price from all oracles
   */
  calculateAggregatePrice() {
    const activeOracles = Array.from(this.oracles.values())
      .filter(o => o.isActive && o.lastUpdate && Date.now() - o.lastUpdate < 60 * 60 * 1000);

    if (activeOracles.length < this.oracleThreshold) {
      // Not enough oracles, maintain current price
      this.emit('oracleWarning', {
        message: 'Insufficient active oracles',
        activeCount: activeOracles.length,
        required: this.oracleThreshold
      });
      return this.currentPrice;
    }

    // Calculate weighted average
    let totalWeight = 0;
    let weightedSum = 0;

    for (const oracle of activeOracles) {
      const adjustedWeight = oracle.weight * oracle.reliability;
      weightedSum += oracle.lastPrice * adjustedWeight;
      totalWeight += adjustedWeight;
    }

    const newPrice = weightedSum / totalWeight;

    // Record price history
    this.priceHistory.push({
      price: newPrice,
      timestamp: Date.now(),
      oracleCount: activeOracles.length
    });

    // Keep only last 1000 price points
    if (this.priceHistory.length > 1000) {
      this.priceHistory = this.priceHistory.slice(-1000);
    }

    // Check deviation
    const deviation = Math.abs(newPrice - this.targetPrice) / this.targetPrice;
    if (deviation > this.acceptableDeviation) {
      this.handlePriceDeviation(newPrice, deviation);
    }

    this.currentPrice = newPrice;
    this.lastOracleUpdate = Date.now();

    this.emit('priceUpdate', {
      price: newPrice,
      deviation,
      timestamp: Date.now()
    });

    return newPrice;
  }

  /**
   * Handle price deviation from peg
   */
  handlePriceDeviation(price, deviation) {
    const isOverPeg = price > this.targetPrice;

    this.stats.priceDeviations.push({
      price,
      deviation,
      direction: isOverPeg ? 'OVER' : 'UNDER',
      timestamp: Date.now()
    });

    if (isOverPeg) {
      // Price above peg: increase supply pressure
      this.activateStabilityMode('OVER_PEG');
    } else {
      // Price below peg: reduce supply, use reserves
      this.activateStabilityMode('UNDER_PEG');
    }

    this.emit('deviationAlert', {
      price,
      deviation,
      direction: isOverPeg ? 'OVER' : 'UNDER',
      action: isOverPeg ? 'INCREASE_SUPPLY' : 'USE_RESERVES'
    });
  }

  /**
   * Activate stability mechanisms
   */
  activateStabilityMode(mode) {
    this.isStabilityModeActive = true;

    const intervention = {
      mode,
      activatedAt: Date.now(),
      price: this.currentPrice,
      actions: []
    };

    switch (mode) {
      case 'OVER_PEG':
        // When price is above $1, we want to bring it down
        // - Reduce redemption fees to encourage selling
        // - Increase stability fees for holding
        intervention.actions.push('REDUCE_REDEMPTION_FEE');
        intervention.actions.push('INCREASE_STABILITY_FEE');
        break;

      case 'UNDER_PEG':
        // When price is below $1, we want to bring it up
        // - Use reserves to buy back ANKH
        // - Increase redemption fees to discourage selling
        intervention.actions.push('RESERVE_BUYBACK');
        intervention.actions.push('INCREASE_REDEMPTION_FEE');
        break;
    }

    this.stats.interventions.push(intervention);
    this.emit('stabilityIntervention', intervention);
  }

  /**
   * Deactivate stability mode
   */
  deactivateStabilityMode() {
    this.isStabilityModeActive = false;
    this.emit('stabilityRestored', {
      price: this.currentPrice,
      timestamp: Date.now()
    });
  }

  /**
   * Add to collateral reserves
   */
  addReserves(type, amount, valueInUSD) {
    amount = BigInt(amount);
    valueInUSD = BigInt(valueInUSD);

    switch (type.toLowerCase()) {
      case 'usd':
        this.reserves.usd += amount;
        this.reserves.totalValueUSD += amount;
        break;

      case 'eth':
        this.reserves.eth += amount;
        this.reserves.totalValueUSD += valueInUSD;
        break;

      case 'btc':
        this.reserves.btc += amount;
        this.reserves.totalValueUSD += valueInUSD;
        break;

      default:
        throw new Error('Unknown reserve type');
    }

    this.updateCollateralRatio();

    this.emit('reserveAdded', {
      type,
      amount: amount.toString(),
      valueInUSD: valueInUSD.toString(),
      totalReserves: this.reserves.totalValueUSD.toString()
    });
  }

  /**
   * Update collateralization ratio
   */
  updateCollateralRatio() {
    // Get total circulating supply
    const stats = this.stateManager.getStats();
    const totalUBIDistributed = BigInt(stats.totalUBIDistributed || 0);

    if (totalUBIDistributed === 0n) {
      this.currentCollateralRatio = 1.0;
      return;
    }

    // Collateral ratio = reserves / circulating supply
    this.currentCollateralRatio = Number(this.reserves.totalValueUSD) / Number(totalUBIDistributed);

    if (this.currentCollateralRatio < this.minimumCollateralRatio) {
      this.emit('collateralWarning', {
        ratio: this.currentCollateralRatio,
        minimum: this.minimumCollateralRatio,
        reserves: this.reserves.totalValueUSD.toString()
      });
    }
  }

  /**
   * Redeem ANKH for USD (or USD equivalent)
   */
  async processRedemption(address, ankhAmount) {
    ankhAmount = BigInt(ankhAmount);

    // Check if reserves are sufficient
    if (this.reserves.totalValueUSD < ankhAmount) {
      throw new Error('Insufficient reserves for redemption');
    }

    // Calculate fee
    const fee = (ankhAmount * BigInt(Math.floor(this.redemptionFeeRate * 10000))) / 10000n;
    const netAmount = ankhAmount - fee;

    // Burn the ANKH tokens
    this.stateManager.updateBalance(address, -ankhAmount);

    // Reduce reserves
    this.reserves.usd -= netAmount;
    this.reserves.totalValueUSD -= netAmount;

    // Track stats
    this.stats.totalRedemptions++;
    this.stats.totalStabilityFees += fee;

    this.updateCollateralRatio();

    return {
      redeemed: ankhAmount.toString(),
      fee: fee.toString(),
      netAmount: netAmount.toString(),
      remainingReserves: this.reserves.totalValueUSD.toString()
    };
  }

  /**
   * Get current peg status
   */
  getPegStatus() {
    const deviation = Math.abs(this.currentPrice - this.targetPrice) / this.targetPrice;
    const isStable = deviation <= this.acceptableDeviation;

    return {
      targetPrice: this.targetPrice,
      currentPrice: this.currentPrice,
      deviation: (deviation * 100).toFixed(4) + '%',
      isStable,
      isStabilityModeActive: this.isStabilityModeActive,

      reserves: {
        usd: this.reserves.usd.toString(),
        eth: this.reserves.eth.toString(),
        btc: this.reserves.btc.toString(),
        totalValueUSD: this.reserves.totalValueUSD.toString()
      },

      collateralization: {
        current: (this.currentCollateralRatio * 100).toFixed(2) + '%',
        target: (this.targetCollateralRatio * 100).toFixed(2) + '%',
        minimum: (this.minimumCollateralRatio * 100).toFixed(2) + '%'
      },

      fees: {
        stability: (this.stabilityFeeRate * 100).toFixed(2) + '%',
        redemption: (this.redemptionFeeRate * 100).toFixed(2) + '%'
      },

      oracles: {
        active: Array.from(this.oracles.values()).filter(o => o.isActive).length,
        total: this.oracles.size,
        required: this.oracleThreshold
      },

      lastUpdate: this.lastOracleUpdate
    };
  }

  /**
   * Get price history
   */
  getPriceHistory(limit = 100) {
    return this.priceHistory.slice(-limit);
  }

  /**
   * Get intervention history
   */
  getInterventionHistory(limit = 50) {
    return this.stats.interventions.slice(-limit);
  }

  /**
   * Simulate price impact of large transaction
   */
  simulatePriceImpact(ankhAmount) {
    ankhAmount = BigInt(ankhAmount);

    // Get current circulating supply
    const stats = this.stateManager.getStats();
    const circulatingSupply = BigInt(stats.totalUBIDistributed || 1);

    // Calculate impact as percentage of supply
    const impactPercent = Number(ankhAmount * 10000n / circulatingSupply) / 100;

    // Simplified price impact model
    const estimatedPriceChange = impactPercent * 0.01; // 1% supply = 0.01% price impact

    return {
      amount: ankhAmount.toString(),
      circulatingSupply: circulatingSupply.toString(),
      supplyPercent: impactPercent.toFixed(6) + '%',
      estimatedPriceImpact: (estimatedPriceChange * 100).toFixed(6) + '%',
      newEstimatedPrice: (this.currentPrice * (1 - estimatedPriceChange)).toFixed(6)
    };
  }
}

module.exports = USDPegMechanism;
