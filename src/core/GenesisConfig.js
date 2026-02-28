/**
 * Ankh Chain Genesis Configuration
 *
 * Defines the foundational parameters for the Ankh Native Blockchain,
 * including economic model, consensus rules, and UBI distribution parameters.
 */

const crypto = require('crypto');

const GenesisConfig = {
  // Chain Identity
  CHAIN_ID: 'ankh-mainnet-1',
  CHAIN_NAME: 'Ankh Chain',
  CHAIN_SYMBOL: 'ANKH',
  CHAIN_VERSION: '1.0.0',

  // Genesis Block — fixed timestamp ensures deterministic genesis hash across all nodes
  GENESIS_TIMESTAMP: 1740528000000, // 2026-02-26T04:00:00.000Z — ANKH Chain genesis
  GENESIS_HASH: '0x0000000000000000000000000000000000000000000000000000000000000000',

  // Population & Supply Economics
  MAX_GLOBAL_POPULATION: 10_000_000_000n,                    // 10 billion humans
  LIFETIME_VALUE_USD: 2_800_000n,                            // $2.8M per person
  MAX_TOTAL_SUPPLY: 10_000_000_000n * 2_800_000n,           // 28 quadrillion ANKH
  USD_PEG: 1n,                                               // 1 ANKH = $1 USD

  // UBI Distribution Parameters
  DISTRIBUTION_YEARS: 45,                                    // 45 years
  DISTRIBUTION_MONTHS: 540,                                  // 540 months
  MONTHLY_UBI_AMOUNT: 5185_190000000000000000n,             // ~5185.19 ANKH (18 decimals)
  VESTING_START_AGE: 18,                                     // Age of maturity
  VESTING_END_AGE: 63,                                       // End of distribution
  CLAIM_FREQUENCY_SECONDS: 30 * 24 * 60 * 60,               // Monthly (30 days)

  // Token Decimals (like ETH)
  DECIMALS: 18,
  DECIMAL_MULTIPLIER: 10n ** 18n,

  // Consensus: Hybrid DPoS + PoA
  CONSENSUS: {
    TYPE: 'HYBRID_DPOS_POA',

    // DPoS Parameters (Main Chain)
    DPOS: {
      VALIDATOR_COUNT: 21,                                   // Top 21 validators
      BLOCK_TIME_MS: 3000,                                   // 3 second blocks
      EPOCH_LENGTH: 100,                                     // Blocks per epoch
      MIN_VALIDATOR_STAKE: 10000n * (10n ** 18n),           // 10,000 ANKH to validate
      VALIDATOR_REWARD_PERCENT: 1,                           // 1% of transaction fees
      SLASH_PERCENT: 10,                                     // 10% slash for misbehavior
      UNBONDING_PERIOD_DAYS: 21,                            // 21 days to unbond stake
    },

    // PoA Parameters (Institutional Sidechains)
    POA: {
      MIN_AUTHORITIES: 3,                                    // Minimum 3 authorities
      AUTHORITY_APPROVAL_THRESHOLD: 0.67,                    // 67% must approve blocks
      BLOCK_TIME_MS: 1000,                                   // 1 second blocks (faster for institutions)
      REQUIRES_GOVERNANCE_APPROVAL: true,
    }
  },

  // Biometric Verification
  BIOMETRIC: {
    DUPLICATE_THRESHOLD: 0.95,                               // 95% similarity = duplicate
    CONSENSUS_THRESHOLD: 0.75,                               // 75% of nodes must agree
    LIVENESS_REQUIRED: true,
    MINIMUM_MOVEMENTS: 5,                                    // 5 liveness movements
    BLINK_REQUIRED: true,
    AGE_ESTIMATION_BUFFER: 2,                                // ±2 years buffer
    BIOLOGICAL_AGE_MIN: 20,                                  // Estimated 20+ = approved (buffer for 18)
    MANUAL_REVIEW_THRESHOLD: 0.88,                           // 88-95% flagged for review
    COOLDOWN_PERIOD_DAYS: 30,                               // 30 days between verification attempts
    VOICE_VERIFICATION_ENABLED: true,
    SKIN_ANALYSIS_ENABLED: true,
  },

  // Token Creation Tiers
  TOKEN_TIERS: {
    COMMUNITY: {
      NAME: 'Community',
      STAKE_REQUIRED: 100n * (10n ** 18n),                  // 100 ANKH
      MAX_SUPPLY: 1_000_000n * (10n ** 18n),                // 1M tokens max
      REQUIRES_VERIFICATION: true,
      AUTO_APPROVED: true,
      COOLDOWN_HOURS: 0,
    },
    STANDARD: {
      NAME: 'Standard',
      STAKE_REQUIRED: 10_000n * (10n ** 18n),               // 10,000 ANKH
      MAX_SUPPLY: null,                                      // Unlimited
      REQUIRES_VERIFICATION: true,
      AUTO_APPROVED: false,
      REVIEW_PERIOD_HOURS: 24,
      COMMUNITY_FLAG_ENABLED: true,
    },
    INSTITUTIONAL: {
      NAME: 'Institutional',
      STAKE_REQUIRED: 100_000n * (10n ** 18n),              // 100,000 ANKH
      MAX_SUPPLY: null,
      REQUIRES_KYC_ORG: true,
      REQUIRES_GOVERNANCE_VOTE: true,
      CAN_CREATE_SIDECHAIN: true,
      CUSTOM_CONSENSUS_ALLOWED: true,
    },
    SOVEREIGN: {
      NAME: 'Sovereign',
      STAKE_REQUIRED: 0n,                                    // No stake for governments
      MAX_SUPPLY: null,
      REQUIRES_TREATY: true,
      REQUIRES_COUNCIL_APPROVAL: true,
      CAN_CREATE_NATIONAL_CURRENCY: true,
      FULL_POA_CONTROL: true,
    }
  },

  // Network
  NETWORK: {
    DEFAULT_PORT: 3001,
    P2P_PORT: 6002,
    MAX_PEERS: 50,
    PEER_DISCOVERY_INTERVAL_MS: 30000,
    BLOCK_SYNC_BATCH_SIZE: 100,
    TRANSACTION_POOL_SIZE: 10000,
    MAX_BLOCK_SIZE_BYTES: 2 * 1024 * 1024,                  // 2MB blocks

    // Bootstrap seed nodes — well-known peers new nodes connect to on first start.
    // Override with SEED_PEERS env var (comma-separated ws:// URLs).
    SEED_PEERS: [
      'ws://p2p.ankh.cash:6002',                            // Primary bootstrap node
    ],
  },

  // Transaction Fees
  FEES: {
    BASE_FEE: 1000000000000000n,                            // 0.001 ANKH base fee
    TRANSFER_FEE_PERCENT: 0.001,                            // 0.1% transfer fee
    TOKEN_CREATION_FEE: 10n * (10n ** 18n),                 // 10 ANKH to create token
    SIDECHAIN_CREATION_FEE: 1000n * (10n ** 18n),           // 1000 ANKH for sidechain
    FEE_BURN_PERCENT: 50,                                    // 50% of fees burned
    FEE_VALIDATOR_PERCENT: 50,                               // 50% to validators
  },

  // Reserve Allocations
  RESERVES: {
    FOUNDATION_PERCENT: 2,                                   // 2% foundation reserve
    DEVELOPMENT_PERCENT: 1,                                  // 1% development fund
    ECOSYSTEM_PERCENT: 1,                                    // 1% ecosystem grants
    EMERGENCY_PERCENT: 1,                                    // 1% emergency fund
    // Remaining 95% for UBI distribution
  },

  // Governance
  GOVERNANCE: {
    PROPOSAL_THRESHOLD: 100_000n * (10n ** 18n),            // 100k ANKH to propose
    VOTING_PERIOD_DAYS: 7,
    QUORUM_PERCENT: 10,                                      // 10% participation required
    APPROVAL_THRESHOLD_PERCENT: 66,                          // 66% approval needed
    EXECUTION_DELAY_DAYS: 2,
  },

  // Bridge (to ETH derivative)
  BRIDGE: {
    ETH_CHAIN_ID: 1,                                         // Ethereum mainnet
    SEPOLIA_CHAIN_ID: 11155111,                             // Sepolia testnet
    CONFIRMATION_BLOCKS: 12,                                 // Wait 12 ETH blocks
    MIN_BRIDGE_AMOUNT: 100n * (10n ** 18n),                 // Min 100 ANKH to bridge
    BRIDGE_FEE_PERCENT: 0.1,                                // 0.1% bridge fee
  },

  /**
   * Generate deterministic genesis block hash
   */
  generateGenesisHash() {
    const data = JSON.stringify({
      chainId: this.CHAIN_ID,
      timestamp: this.GENESIS_TIMESTAMP,
      maxPopulation: this.MAX_GLOBAL_POPULATION.toString(),
      lifetimeValue: this.LIFETIME_VALUE_USD.toString(),
      version: this.CHAIN_VERSION
    });
    return '0x' + crypto.createHash('sha256').update(data).digest('hex');
  },

  /**
   * Calculate monthly UBI for a user based on their allocation
   */
  calculateMonthlyUBI(lifetimeAllocation = this.LIFETIME_VALUE_USD) {
    return (lifetimeAllocation * this.DECIMAL_MULTIPLIER) / BigInt(this.DISTRIBUTION_MONTHS);
  },

  /**
   * Calculate remaining allocation for a user
   */
  calculateRemainingAllocation(claimedMonths) {
    const remainingMonths = BigInt(this.DISTRIBUTION_MONTHS - claimedMonths);
    return this.calculateMonthlyUBI() * remainingMonths;
  },

  /**
   * Validate age eligibility
   */
  isAgeEligible(estimatedAge, confidenceScore) {
    // With buffer: if estimated age is 20+ with decent confidence, approve
    if (estimatedAge >= this.BIOMETRIC.BIOLOGICAL_AGE_MIN && confidenceScore >= 0.7) {
      return { eligible: true, reason: 'Age verified biologically' };
    }

    // Edge case: 18-20 estimated, needs higher confidence or manual review
    if (estimatedAge >= this.VESTING_START_AGE && estimatedAge < this.BIOMETRIC.BIOLOGICAL_AGE_MIN) {
      if (confidenceScore >= 0.9) {
        return { eligible: true, reason: 'Age verified with high confidence' };
      }
      return { eligible: false, reason: 'Manual review required', needsReview: true };
    }

    return { eligible: false, reason: 'Below age of maturity' };
  },

  /**
   * Get token tier by stake amount
   */
  getTokenTier(stakeAmount) {
    if (stakeAmount >= this.TOKEN_TIERS.INSTITUTIONAL.STAKE_REQUIRED) {
      return 'INSTITUTIONAL';
    }
    if (stakeAmount >= this.TOKEN_TIERS.STANDARD.STAKE_REQUIRED) {
      return 'STANDARD';
    }
    if (stakeAmount >= this.TOKEN_TIERS.COMMUNITY.STAKE_REQUIRED) {
      return 'COMMUNITY';
    }
    return null;
  }
};

// Freeze to prevent modifications
Object.freeze(GenesisConfig);
Object.freeze(GenesisConfig.CONSENSUS);
Object.freeze(GenesisConfig.CONSENSUS.DPOS);
Object.freeze(GenesisConfig.CONSENSUS.POA);
Object.freeze(GenesisConfig.BIOMETRIC);
Object.freeze(GenesisConfig.TOKEN_TIERS);
Object.freeze(GenesisConfig.NETWORK);
Object.freeze(GenesisConfig.FEES);
Object.freeze(GenesisConfig.RESERVES);
Object.freeze(GenesisConfig.GOVERNANCE);
Object.freeze(GenesisConfig.BRIDGE);

module.exports = GenesisConfig;
