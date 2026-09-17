/**
 * Ankh Chain Genesis Configuration
 *
 * Defines the foundational parameters for the Ankh Native Blockchain,
 * including economic model, consensus rules, and UBI distribution parameters.
 */

const crypto = require('crypto');

const GenesisConfig = {
  // Chain Identity
  //
  // CONSENSUS-CRITICAL. Nodes only accept blocks and snapshots from peers on the
  // same chain id, so this is what keeps a throwaway development chain from ever
  // being mistaken for mainnet. It defaults to mainnet and only changes when
  // ANKH_CHAIN_ID is set explicitly — which `server.js --dev` does, pointing it
  // at 'ankh-devnet-1'. Never set it on a node that talks to mainnet peers.
  CHAIN_ID: process.env.ANKH_CHAIN_ID || 'ankh-mainnet-1',
  CHAIN_NAME: 'Ankh Chain',
  CHAIN_SYMBOL: 'ANKH',
  CHAIN_VERSION: '1.0.0',

  // Genesis Block — fixed timestamp ensures deterministic genesis hash across all nodes
  GENESIS_TIMESTAMP: 1772242800000, // 2026-02-28T01:40:00.000Z — ANKH Chain genesis
  GENESIS_HASH: '0x0000000000000000000000000000000000000000000000000000000000000000',

  // Population & Supply Economics
  MAX_GLOBAL_POPULATION: 10_000_000_000n,                    // 10 billion humans
  LIFETIME_VALUE_USD: 2_800_000n,                            // $2.8M per person
  // MAX_TOTAL_SUPPLY in raw 18-decimal units (same unit as all balances):
  //   10,000,000,000 people × $2,800,000/person × 10^18 = 2.8 × 10^34
  MAX_TOTAL_SUPPLY: 10_000_000_000n * 2_800_000n * (10n ** 18n),
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
    MINIMUM_MOVEMENTS: 7,                                    // All 7 liveness steps required
    REQUIRED_MOVEMENT_TYPES: ['center', 'left', 'right', 'blink', 'smile'], // All must be present
    BLINK_REQUIRED: true,
    BLINK_SCORE_MIN: 0.75,                                   // Blink score < 0.75 = no actual blink detected
    TURN_MOVEMENT_MIN: 0.06,                                 // 6% face-width minimum nose displacement
    SEQUENCE_DURATION_MIN_MS: 8000,                          // Steps must span ≥8 seconds
    SEQUENCE_DURATION_MAX_MS: 300000,                        // Sequence timestamps can't be >5 min old
    AGE_ESTIMATION_BUFFER: 2,                                // ±2 years buffer
    BIOLOGICAL_AGE_MIN: 20,                                  // Estimated 20+ = approved (buffer for 18)
    MANUAL_REVIEW_THRESHOLD: 0.88,                           // 88-95% flagged for review
    COOLDOWN_PERIOD_DAYS: 30,                               // 30 days between verification attempts
    VOICE_VERIFICATION_ENABLED: true,
    SKIN_ANALYSIS_ENABLED: true,

    // ── Face matching ───────────────────────────────────────────────────────
    // face-api.js calibrated "same person" Euclidean distance on its 128-d
    // embedding. Single source of truth for every duplicate check so the API
    // path and the block-execution path can never drift apart.
    SAME_PERSON_THRESHOLD: 0.6,

    // ── Descriptors as consensus state ──────────────────────────────────────
    // Descriptors already decide consensus outcomes: executeBiometricRegistration
    // rejects a transaction based on them, so two nodes holding different
    // descriptor sets will accept different blocks. Committing them to the state
    // root makes that divergence detectable instead of silent.
    //
    // It is a CONSENSUS-AFFECTING change: a node with this on and a peer with it
    // off compute different state roots and will reject each other's state-sync
    // snapshots. Left OFF so it can be deployed to a live network without
    // breaking peers, then switched on across every node together.
    // Enable with ANKH_COMMIT_DESCRIPTORS=1 once the whole network is upgraded.
    COMMIT_DESCRIPTORS_TO_STATE_ROOT: process.env.ANKH_COMMIT_DESCRIPTORS === '1',

    // ── Descriptor integrity ────────────────────────────────────────────────
    // Plausibility bounds on a submitted descriptor. These reject cheap
    // forgeries — a hand-rolled or randomly generated vector posted straight at
    // the API — and nothing more. They are not a security control: an attacker
    // who matches the statistics still passes, and only SERVER_SIDE_INFERENCE
    // closes that gap. Because they cannot buy much, they are set permissively;
    // rejecting a real human is far more costly than admitting a forgery that
    // still has to clear liveness, duplicate search and consensus voting.
    //
    // CALIBRATION. The previous values (norm 0.85–1.15, component 0.45) were
    // taken from the premise that face-api emits L2-normalised embeddings. It
    // does not. Measured over face-api's own bundled sample faces on the wasm
    // backend — 22 descriptors from 6 images:
    //
    //     L2 norm      min 1.3766   max 1.5054   mean 1.4571
    //     max |d[i]|   observed up to 0.4635
    //
    // Every one of those 22 real descriptors failed the old norm gate, and
    // several also exceeded the old component cap. The only vectors that could
    // pass were the unit-norm ones simulate-verifications.js generates, which
    // divides by the norm by construction — so the bounds were calibrated
    // against synthetic data that could not fail them, and no real face ever
    // got through. A live capture reported in the field measured 1.2878, below
    // the sample range, so the floor allows generous headroom beneath it.
    //
    // The floor still sits above 1.0, which is where a naive forgery lands: a
    // normalised random vector is exactly 1.0, and an unnormalised one is about
    // sqrt(128/3) ≈ 6.53. Both are still rejected.
    //
    // Scope: this gate runs only on the node that receives the submission.
    // Voting peers re-derive the descriptor from the imagery and vote on frame
    // quality and drift; they never re-run this check. So it does not affect
    // block consensus and a node can be corrected on its own. It is still
    // admission policy, and a network running mixed bounds will accept a person
    // at one node and turn them away at another, so roll it out everywhere.
    DESCRIPTOR_NORM_MIN: 1.05,
    DESCRIPTOR_NORM_MAX: 1.95,
    DESCRIPTOR_COMPONENT_MAX: 0.85,   // observed to 0.4635; a one-hot vector is still rejected
    DESCRIPTOR_MIN_DISTINCT: 96,      // guards against padded/constant vectors

    // ── Active illumination challenge ───────────────────────────────────────
    // The node picks a random colour sequence after the session opens; the
    // client's screen flashes it while capturing. A recording cannot satisfy a
    // sequence chosen after it was made, a display barely reacts to light
    // falling on it, and a flat print reacts uniformly instead of like a face.
    // See src/verification/LivenessChallenge.js.
    //
    // ENFORCE is off deliberately. The thresholds are calibrated against a
    // simulation, not real cameras, and the last gate that shipped on synthetic
    // calibration rejected every real face for months. Advisory first: the
    // analyser runs and records what it measured without being able to turn
    // anyone away. Read the logged numbers from real sessions, then enforce.
    LIVENESS_CHALLENGE: {
      ENABLED: process.env.ANKH_FLASH_CHALLENGE !== '0',
      ENFORCE: process.env.ANKH_ENFORCE_FLASH === '1',

      // Depth is required on /verify/resolve even while full enforcement is off.
      //
      // Resolve is the endpoint that turns a face into an address, so leaving it
      // unguarded means a photograph of someone reveals which address is theirs.
      // Enrolment can afford to wait for calibration — a false rejection there
      // costs a new user one retry — but resolve cannot, and it has a fallback:
      // whoever is refused can still unlock with their password.
      //
      // Only the spatial signal is enforced, because it is the one with real
      // margin. Measured: live faces returned 0.165 and 0.277 against a 0.015
      // floor, roughly a tenfold clearance, while a flat surface simulates at
      // 0.0005. The temporal and response signals sit much closer to their
      // thresholds on real cameras and would reject genuine people, so they stay
      // advisory until clean sessions say otherwise.
      //
      // What this stops: photographs, printouts, and video replayed on a screen —
      // anything flat. What it does not stop: a sculpted 3-D mask, or a real
      // person compelled to look at the lens. Depth is not intent.
      REQUIRE_DEPTH_ON_RESOLVE: process.env.ANKH_RESOLVE_ALLOW_FLAT !== '1'
    },

    // ── Server-side re-derivation ───────────────────────────────────────────
    // When enabled the node recomputes the descriptor from the submitted image
    // and ignores the client's, which is the only way to stop a forged POST.
    // Off by default: it needs the face-api/tfjs stack installed and enough RAM.
    // Enable with ANKH_SERVER_SIDE_FACE=1 once dependencies are provisioned.
    SERVER_SIDE_INFERENCE: process.env.ANKH_SERVER_SIDE_FACE === '1',
    // Max distance allowed between the client's descriptor and the server's
    // re-derivation of the same image before the submission is rejected.
    SERVER_CLIENT_MAX_DRIFT: 0.35,

    // ── Multi-frame fusion ──────────────────────────────────────────────────
    // A single frame carries one draw of every nuisance variable there is:
    // expression, blink phase, focus, exposure, the exact angle of the head.
    // The embedding it produces sits some distance from the person's own centre
    // in embedding space, and that scatter is the genuine-pair distribution —
    // the one that has to stay clear of the impostor distribution.
    //
    // Averaging k embeddings of the same face and renormalising shrinks that
    // scatter roughly as 1/sqrt(k) for the part of the error that is independent
    // between frames, while leaving the distance between different people
    // essentially where it was. The separation margin widens for free; no new
    // model, no new dependency, four extra seconds of capture.
    //
    // It also closes an attack that a single frame cannot: the frames are
    // checked against each other, so a set stitched together from more than one
    // person is rejected on cohesion before it ever reaches matching.
    MULTI_FRAME_ENABLED: process.env.ANKH_MULTI_FRAME !== '0',
    FRAMES_REQUESTED: 5,              // what the capture UI collects
    FRAMES_MIN_ACCEPTED: 3,           // enrol from fewer than this and fusion buys little
    FRAMES_MAX: 8,                    // hard cap: each frame is a model pass
    // Largest distance allowed between any two accepted frames.
    //
    // Set just inside SAME_PERSON_THRESHOLD, which is the only defensible place
    // for it: frames that would not match each other as the same person have no
    // business being averaged into one identity. Genuine within-session spread
    // runs higher than intuition suggests — the smile frame moves the embedding
    // more than anything else in the capture — so a tighter bound rejects real
    // people, while two different faces sit around 1.41 and are nowhere near it.
    // Frames beyond the radius are trimmed before the set is judged.
    FRAME_COHESION_MAX: 0.55,

    // ── Per-frame quality gates ─────────────────────────────────────────────
    // Deliberately stated in units a person can act on, because every one of
    // these becomes an instruction shown at capture time: move closer, hold
    // still, face the camera, fix the lighting.
    FRAME_QUALITY: {
      DETECTION_SCORE_MIN: 0.60,
      INTEROCULAR_MIN_PX: 42,         // eye-to-eye pixels; the real resolution of the face
      YAW_MAX: 0.34,                  // 0 = square on, 1 = full profile
      ROLL_MAX_DEG: 22,
      SHARPNESS_MIN: 55,              // variance of Laplacian over the face crop
      BRIGHTNESS_MIN: 45,             // mean luma 0–255
      BRIGHTNESS_MAX: 225,
      CLIPPED_MAX: 0.12,              // share of face pixels at pure black or pure white
    },

    // ── Adjudication band ───────────────────────────────────────────────────
    // Below SAME_PERSON_THRESHOLD is a match; far above it is a stranger. The
    // span just above the threshold is neither, and at register scale it is the
    // span where both kinds of error concentrate: a returning person whose
    // capture drifted, and a genuine stranger who happens to sit close.
    //
    // Auto-deciding that band is a coin flip with a $2.8M entitlement on one
    // side and a locked-out person on the other. It is held for review instead.
    // Set REVIEW_BAND to 0 to restore straight threshold behaviour.
    REVIEW_BAND: 0.08,

    // ── Network consensus on verification ───────────────────────────────────
    // Verification mints a $2.8M lifetime entitlement, so it must fail CLOSED:
    // if the network cannot agree that this face is new, no allocation is
    // created. Previously both the "not enough votes" and the "network error"
    // paths returned passed:true, meaning an attacker who could partition or
    // simply outlast the 30s timeout got their registration approved by default.
    //
    // A node running alone (bootstrap, or a private deployment) genuinely cannot
    // reach consensus. That is allowed only via an explicit operator override,
    // which is logged on every use, rather than being the silent default.
    CONSENSUS_MIN_VOTES: 3,
    CONSENSUS_FAIL_OPEN: process.env.ANKH_ALLOW_SOLO_VERIFICATION === '1',

    // ── Capture fidelity ────────────────────────────────────────────────────
    // Everything above is enforced by the node that RECEIVES a capture. None of
    // it was enforced by the nodes that later accept the block, which meant the
    // network's real standard was whatever its least strict node applied: a node
    // running modified code could skip fusion and the quality gates, write a
    // flattering qualityScore into the transaction, and have the rest of the
    // network accept it on one signature.
    //
    // A capture attestation closes that. Each node that independently ran the
    // model signs a statement of what it measured, and every validator re-checks
    // those numbers against its own thresholds before accepting the block. See
    // CaptureAttestation.js for why each attester signs its own measurement
    // rather than a shared digest.
    CAPTURE_ATTESTATION: {
      // Always attach attestations. Producing them is free and non-breaking, and
      // they have to be flowing through the network before enforcing them can
      // possibly succeed.
      PRODUCE: process.env.ANKH_ATTEST_CAPTURE !== '0',

      // Enforcement is CONSENSUS-AFFECTING and therefore off until every node is
      // upgraded. A node that enforces while a peer does not will reject that
      // peer's blocks and the chain splits. Roll out in three steps: deploy with
      // PRODUCE on everywhere, confirm attestations are present on new
      // registrations across the network, then switch ENFORCE on everywhere.
      // Enable with ANKH_ENFORCE_ATTESTATION=1.
      ENFORCE: process.env.ANKH_ENFORCE_ATTESTATION === '1',

      // Distinct registered nodes whose measurements must stand up. Two means a
      // single compromised or modified node cannot mint a registration on its
      // own, which is the property that was missing. Raise it as the operator
      // set grows — it is the number that decides how many keys an attacker
      // needs, and it is the honest measure of how distributed the register is.
      MIN_SIGNERS: parseInt(process.env.ANKH_ATTESTATION_MIN_SIGNERS || '2', 10),

      // Bound on how many will even be examined, so a malformed transaction
      // cannot make validators do unbounded signature work.
      MAX_ATTESTATIONS: 32,
    },

    // Refuse a capture that was not multi-frame fused. Off during rollout so
    // that clients still running the old single-frame capture path keep working;
    // turn on with ANKH_REQUIRE_FUSED=1 once the updated page is everywhere.
    REQUIRE_FUSED_CAPTURE: process.env.ANKH_REQUIRE_FUSED === '1',
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
      STAKE_REQUIRED: 500_000n * (10n ** 18n),              // 500,000 ANKH (5× institutional)
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


  RESERVES: {
    MAIN_AMOUNT:        2_660_000_000_000_000n * (10n ** 18n), // 2.66Q — population fluctuation buffer (95%)
    FOUNDATION_AMOUNT:    56_000_000_000_000n * (10n ** 18n),  // 56T   — governance & operations (2%)
    DEVELOPMENT_AMOUNT:   28_000_000_000_000n * (10n ** 18n),  // 28T   — protocol development (1%)
    ECOSYSTEM_AMOUNT:     28_000_000_000_000n * (10n ** 18n),  // 28T   — ecosystem grants (1%)
    EMERGENCY_AMOUNT:     28_000_000_000_000n * (10n ** 18n),  // 28T   — crisis response (1%)
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
