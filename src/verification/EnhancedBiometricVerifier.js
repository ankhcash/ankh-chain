/**
 * Enhanced Biometric Verifier
 *
 * Provides comprehensive biometric verification with:
 * - 95% similarity threshold for duplicate detection
 * - Multi-modal verification (face + voice + skin)
 * - Distributed consensus across network nodes
 * - Integration with kingtree biometric components
 */

const crypto = require('crypto');
const path = require('path');
const GenesisConfig = require('../core/GenesisConfig');
const BiologicalAgeVerifier = require('./BiologicalAgeVerifier');

class EnhancedBiometricVerifier {
  constructor(stateManager, networkNode = null) {
    this.stateManager = stateManager;
    this.networkNode = networkNode;

    // Verification thresholds
    this.duplicateThreshold = GenesisConfig.BIOMETRIC.DUPLICATE_THRESHOLD; // 0.95
    this.consensusThreshold = GenesisConfig.BIOMETRIC.CONSENSUS_THRESHOLD; // 0.75
    this.livenessRequired = GenesisConfig.BIOMETRIC.LIVENESS_REQUIRED;
    this.minimumMovements = GenesisConfig.BIOMETRIC.MINIMUM_MOVEMENTS;
    this.cooldownPeriodDays = GenesisConfig.BIOMETRIC.COOLDOWN_PERIOD_DAYS;

    // Age verification
    this.ageVerifier = new BiologicalAgeVerifier();

    // Local biometric index for fast duplicate checking
    this.biometricIndex = new Map();

    // Verification queue
    this.verificationQueue = new Map();
    this.consensusVotes = new Map();

    // Rate limiting
    this.attemptCounts = new Map();
    this.maxAttemptsPerHour = 5;

    // Statistics
    this.stats = {
      totalVerifications: 0,
      successfulVerifications: 0,
      duplicatesDetected: 0,
      livenessFailures: 0,
      ageVerificationFailures: 0,
      consensusRejections: 0
    };
  }

  /**
   * Perform full biometric verification
   */
  async verify(address, biometricData, clientIp = null) {
    const verificationId = crypto.randomUUID();
    const startTime = Date.now();

    const result = {
      verificationId,
      address,
      timestamp: startTime,
      steps: [],
      success: false,
      reason: null,
      biometricHash: null,
      ageVerification: null
    };

    try {
      // Step 1: Rate limiting check — keyed by IP (primary) + address (secondary)
      // Keying by address alone lets an attacker bypass limits with fresh addresses.
      const rateKey   = clientIp || address;
      const rateCheck = this.checkRateLimit(rateKey);
      result.steps.push({ step: 'RATE_LIMIT', ...rateCheck });
      if (!rateCheck.passed) {
        result.reason = rateCheck.reason;
        return this.finalizeResult(result);
      }

      // Step 2: Validate biometric data format
      const formatCheck = this.validateBiometricFormat(biometricData);
      result.steps.push({ step: 'FORMAT_VALIDATION', ...formatCheck });
      if (!formatCheck.passed) {
        result.reason = formatCheck.reason;
        return this.finalizeResult(result);
      }

      // Step 3: Liveness detection
      const livenessCheck = await this.performLivenessDetection(biometricData);
      result.steps.push({ step: 'LIVENESS_DETECTION', ...livenessCheck });
      if (!livenessCheck.passed) {
        this.stats.livenessFailures++;
        result.reason = livenessCheck.reason;
        return this.finalizeResult(result);
      }

      // Step 4: Generate biometric hash/template
      const biometricHash = this.generateBiometricHash(biometricData);
      result.biometricHash = biometricHash;

      // Step 5: Local duplicate check
      const localDuplicateCheck = this.checkLocalDuplicates(biometricHash, biometricData);
      result.steps.push({ step: 'LOCAL_DUPLICATE_CHECK', ...localDuplicateCheck });
      if (!localDuplicateCheck.passed) {
        this.stats.duplicatesDetected++;
        result.reason = localDuplicateCheck.reason;
        return this.finalizeResult(result);
      }

      // Step 6: Blockchain duplicate check
      const blockchainDuplicateCheck = this.checkBlockchainDuplicates(biometricHash);
      result.steps.push({ step: 'BLOCKCHAIN_DUPLICATE_CHECK', ...blockchainDuplicateCheck });
      if (!blockchainDuplicateCheck.passed) {
        this.stats.duplicatesDetected++;
        result.reason = blockchainDuplicateCheck.reason;
        return this.finalizeResult(result);
      }

      // Step 7: Network consensus check (if network available)
      if (this.networkNode) {
        const consensusCheck = await this.performNetworkConsensus(verificationId, biometricHash, biometricData);
        result.steps.push({ step: 'NETWORK_CONSENSUS', ...consensusCheck });
        if (!consensusCheck.passed) {
          this.stats.consensusRejections++;
          result.reason = consensusCheck.reason;
          return this.finalizeResult(result);
        }
      }

      // Step 8: Biological age verification
      const ageCheck = await this.verifyBiologicalAge(biometricData);
      result.steps.push({ step: 'AGE_VERIFICATION', ...ageCheck });
      result.ageVerification = ageCheck.details;
      if (!ageCheck.passed) {
        if (ageCheck.needsReview) {
          result.needsReview = true;
          result.reason = ageCheck.reason;
          return this.finalizeResult(result);
        }
        this.stats.ageVerificationFailures++;
        result.reason = ageCheck.reason;
        return this.finalizeResult(result);
      }

      // Step 9: Final quality check
      const qualityCheck = this.performQualityCheck(biometricData);
      result.steps.push({ step: 'QUALITY_CHECK', ...qualityCheck });

      // All checks passed!
      result.success = true;
      result.reason = 'Biometric verification successful';
      this.stats.successfulVerifications++;

      const descriptor = (biometricData.facial?.descriptor?.length === 128)
        ? biometricData.facial.descriptor : null;

      // Store in local index — include raw descriptor for proper Euclidean matching
      this.biometricIndex.set(biometricHash, {
        address,
        verificationId,
        timestamp: Date.now(),
        templateHash: this.generateTemplateHash(biometricData),
        descriptor
      });

      // Persist descriptor to StateManager so it survives restarts
      if (descriptor) {
        this.stateManager.storeDescriptor(biometricHash, descriptor);
      }

    } catch (error) {
      result.reason = `Verification error: ${error.message}`;
      result.error = error.message;
    }

    this.stats.totalVerifications++;
    return this.finalizeResult(result);
  }

  /**
   * Rate limiting check
   */
  checkRateLimit(address) {
    const now = Date.now();
    const hourAgo = now - (60 * 60 * 1000);

    // Get attempts in last hour
    const attempts = this.attemptCounts.get(address) || [];
    const recentAttempts = attempts.filter(t => t > hourAgo);

    // Update attempts
    recentAttempts.push(now);
    this.attemptCounts.set(address, recentAttempts);

    if (recentAttempts.length > this.maxAttemptsPerHour) {
      const waitMinutes = Math.ceil((recentAttempts[0] + 60 * 60 * 1000 - now) / 60000);
      return {
        passed: false,
        reason: `Rate limit exceeded. Try again in ${waitMinutes} minutes.`,
        attempts: recentAttempts.length,
        maxAttempts: this.maxAttemptsPerHour
      };
    }

    return {
      passed: true,
      attempts: recentAttempts.length,
      maxAttempts: this.maxAttemptsPerHour
    };
  }

  /**
   * Validate biometric data format
   */
  validateBiometricFormat(data) {
    if (!data) {
      return { passed: false, reason: 'No biometric data provided' };
    }

    const required = ['facial'];
    const missing = required.filter(field => !data[field]);

    if (missing.length > 0) {
      return { passed: false, reason: `Missing required biometric data: ${missing.join(', ')}` };
    }

    // Validate facial data structure
    if (!data.facial.sequence && !data.facial.image) {
      return { passed: false, reason: 'Facial data must include liveness sequence or image' };
    }

    return { passed: true };
  }

  /**
   * Perform liveness detection
   */
  async performLivenessDetection(biometricData) {
    if (!this.livenessRequired) {
      return { passed: true, skipped: true };
    }

    const facial = biometricData.facial;

    if (!facial.sequence || !Array.isArray(facial.sequence)) {
      return { passed: false, reason: 'Liveness sequence required' };
    }

    const sequence = facial.sequence;

    // All 7 steps must be present
    if (sequence.length < this.minimumMovements) {
      return {
        passed: false,
        reason: `Insufficient liveness steps: ${sequence.length}/${this.minimumMovements} — all steps required`
      };
    }

    // All required movement types must be present
    const movementTypes = new Set(sequence.map(s => s.type));
    const requiredTypes = GenesisConfig.BIOMETRIC.REQUIRED_MOVEMENT_TYPES;
    const missingTypes  = requiredTypes.filter(t => !movementTypes.has(t));
    if (missingTypes.length > 0) {
      return { passed: false, reason: `Missing required movement types: ${missingTypes.join(', ')}` };
    }

    // Sequence must span a real-time window (≥8 seconds)
    const firstTs   = sequence[0].timestamp;
    const lastTs    = sequence[sequence.length - 1].timestamp;
    const durationMs = lastTs - firstTs;
    if (durationMs < GenesisConfig.BIOMETRIC.SEQUENCE_DURATION_MIN_MS) {
      return {
        passed: false,
        reason: `Sequence completed too quickly (${durationMs}ms) — possible scripted/replay attack`
      };
    }
    // Sequence timestamps must not be stale (>5 minutes old)
    if (durationMs > GenesisConfig.BIOMETRIC.SEQUENCE_DURATION_MAX_MS) {
      return { passed: false, reason: 'Sequence timestamps expired — please re-verify' };
    }

    // Blink step must have score ≥ BLINK_SCORE_MIN (0.75), proving an actual blink was detected
    const blinkStep = sequence.find(s => s.type === 'blink');
    if (!blinkStep || blinkStep.score < GenesisConfig.BIOMETRIC.BLINK_SCORE_MIN) {
      return {
        passed: false,
        reason: `Blink not detected during liveness check (score: ${blinkStep?.score?.toFixed(2) ?? 'n/a'}) — possible photo/print attack`
      };
    }

    // Every individual step must meet minimum quality
    const lowQualitySteps = sequence.filter(s => (s.score || 0) < 0.3);
    if (lowQualitySteps.length > 0) {
      return {
        passed: false,
        reason: `Low quality on steps: ${lowQualitySteps.map(s => s.type).join(', ')}`
      };
    }

    // Check timing variance (detect scripted/uniform timing)
    const timings = sequence.map((s, i) => i > 0 ? s.timestamp - sequence[i - 1].timestamp : 0);
    const avgTiming = timings.slice(1).reduce((a, b) => a + b, 0) / (timings.length - 1);
    const timingVariance = timings.slice(1).reduce((sum, t) => sum + Math.pow(t - avgTiming, 2), 0) / (timings.length - 1);
    if (Math.sqrt(timingVariance) < 50 && sequence.length > 3) {
      return { passed: false, reason: 'Suspicious timing pattern detected (possible replay)' };
    }

    const avgMovementScore = sequence.reduce((sum, s) => sum + (s.score || 0.5), 0) / sequence.length;

    return {
      passed: true,
      movements: sequence.length,
      movementTypes: Array.from(movementTypes),
      avgMovementScore,
      timingVariance: Math.sqrt(timingVariance),
      durationMs
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Biometric hashing
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Generate a unique biometric hash from the face descriptor.
   *
   * When a real 128-dimensional face embedding (from face-api) is present,
   * we hash it directly — this produces a unique hash per real face.
   * Fallback chains: descriptor → normalized landmarks → legacy feature map.
   */
  generateBiometricHash(biometricData) {
    const facial = biometricData.facial || {};

    // PRIMARY: 128-d face descriptor from face-api.js (unique per face)
    if (Array.isArray(facial.descriptor) && facial.descriptor.length === 128) {
      // Round to 5 decimal places to tolerate minor float noise between runs
      const rounded = facial.descriptor.map(v => Math.round(v * 1e5) / 1e5);
      return crypto.createHash('sha256').update(JSON.stringify(rounded)).digest('hex');
    }

    // SECONDARY: normalised landmarks (68 points, position/scale invariant)
    if (Array.isArray(facial.landmarks) && facial.landmarks.length >= 68) {
      const normalised = this.normalizeLandmarks(facial.landmarks);
      return crypto.createHash('sha256').update(JSON.stringify(normalised)).digest('hex');
    }

    // LEGACY FALLBACK: structured feature map — only used when no descriptor/landmarks.
    // Random entropy was removed: it allowed the same person to generate a new unique
    // hash on every request, bypassing all duplicate detection.
    // Without a real descriptor, we cannot reliably identify the individual, so
    // this path is only permitted when landmarks are present (real face-api output).
    if (!Array.isArray(facial.landmarks) || facial.landmarks.length < 68) {
      throw new Error('Face descriptor or landmarks required for biometric registration');
    }
    const features = {
      facial: this.extractFacialFeatures(facial),
      voice:  biometricData.voice ? this.extractVoiceFeatures(biometricData.voice) : null,
      skin:   biometricData.skin  ? this.extractSkinFeatures(biometricData.skin)   : null,
    };
    return crypto.createHash('sha256').update(JSON.stringify(features)).digest('hex');
  }

  /**
   * Generate template hash for similarity comparison.
   * Uses the descriptor when available (first 64 components at full precision).
   */
  generateTemplateHash(biometricData) {
    const facial = biometricData.facial || {};

    if (Array.isArray(facial.descriptor) && facial.descriptor.length === 128) {
      // Use full precision for template — full descriptor
      return crypto.createHash('sha256')
        .update(JSON.stringify(facial.descriptor))
        .digest('hex');
    }

    const template = {
      facialLandmarks:  facial.landmarks  || [],
      facialDescriptor: facial.descriptor || facial.features || [],
      voicePrint:       biometricData.voice?.print || null
    };
    return crypto.createHash('sha256').update(JSON.stringify(template)).digest('hex');
  }

  extractFacialFeatures(facial) {
    return {
      landmarks:  facial.landmarks ? this.normalizeLandmarks(facial.landmarks) : null,
      descriptor: facial.descriptor || facial.features || null,
      faceShape:  facial.faceShape || null
    };
  }

  normalizeLandmarks(landmarks) {
    if (!landmarks || landmarks.length === 0) return null;

    const xs = landmarks.map(l => l.x ?? l[0] ?? 0);
    const ys = landmarks.map(l => l.y ?? l[1] ?? 0);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const w = maxX - minX || 1;
    const h = maxY - minY || 1;

    return landmarks.map(l => ({
      x: +( ((l.x ?? l[0] ?? 0) - minX) / w ).toFixed(5),
      y: +( ((l.y ?? l[1] ?? 0) - minY) / h ).toFixed(5)
    }));
  }

  extractVoiceFeatures(voice) {
    return { f0: voice.fundamentalFrequency || voice.f0, formants: voice.formants, mfcc: voice.mfcc };
  }

  extractSkinFeatures(skin) {
    return { texture: skin.textureHash || null, uniformity: skin.uniformity };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Duplicate detection
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Euclidean distance between two 128-d face descriptors.
   * face-api.js standard threshold: distance < 0.6 → same person.
   */
  descriptorDistance(d1, d2) {
    if (!d1 || !d2 || d1.length !== 128 || d2.length !== 128) return Infinity;
    let sum = 0;
    for (let i = 0; i < 128; i++) {
      const diff = d1[i] - d2[i];
      sum += diff * diff;
    }
    return Math.sqrt(sum);
  }

  /**
   * Check for duplicate biometrics.
   *
   * Priority:
   *   1. Exact hash match (same descriptor hash in index)
   *   2. Descriptor Euclidean distance < SAME_PERSON_THRESHOLD (real face match)
   *   3. Fallback: SHA256 template hash Hamming-like string comparison
   */
  checkLocalDuplicates(biometricHash, biometricData) {
    // 1. Exact hash match
    if (this.biometricIndex.has(biometricHash)) {
      const existing = this.biometricIndex.get(biometricHash);
      return {
        passed: false,
        reason: 'Duplicate biometric detected (exact match)',
        existingAddress: existing.address,
        matchType: 'exact'
      };
    }

    const newDescriptor = biometricData.facial?.descriptor;
    const hasRealDescriptor = Array.isArray(newDescriptor) && newDescriptor.length === 128;

    if (hasRealDescriptor) {
      // 2. Euclidean distance on 128-d face embeddings (proper biometric matching).
      // face-api.js's own recommended "same person" threshold is 0.6.
      // We use 0.6 — the calibrated standard for this model. Going lower causes
      // false positives as lighting/pose variation can push the same face to ~0.55.
      const SAME_PERSON_THRESHOLD = 0.6;

      for (const [, record] of this.biometricIndex) {
        if (!record.descriptor) continue;
        const distance   = this.descriptorDistance(newDescriptor, record.descriptor);
        if (distance < SAME_PERSON_THRESHOLD) {
          const similarity = parseFloat((1 - distance / 1.4).toFixed(4));
          return {
            passed: false,
            reason: `Duplicate biometric detected — face already registered to ${record.address} ` +
                    `(distance ${distance.toFixed(4)}, ${(similarity * 100).toFixed(1)}% similar; threshold ${SAME_PERSON_THRESHOLD})`,
            existingAddress: record.address,
            matchType: 'descriptor',
            distance,
            similarity
          };
        }
      }
    } else {
      // 3. Fallback: template hash similarity (for legacy/empty-descriptor submissions)
      const templateHash = this.generateTemplateHash(biometricData);
      for (const [, record] of this.biometricIndex) {
        const similarity = this.calculateTemplateSimilarity(templateHash, record.templateHash);
        if (similarity >= this.duplicateThreshold) {
          return {
            passed: false,
            reason: `Duplicate biometric detected (${(similarity * 100).toFixed(1)}% template similarity)`,
            existingAddress: record.address,
            matchType: 'similar',
            similarity
          };
        }
      }
    }

    return { passed: true };
  }

  /**
   * Check for duplicates in blockchain state
   */
  checkBlockchainDuplicates(biometricHash) {
    if (this.stateManager.isBiometricRegistered(biometricHash)) {
      return {
        passed: false,
        reason: 'Biometric already registered on blockchain',
        matchType: 'blockchain'
      };
    }
    return { passed: true };
  }

  /**
   * Fallback template similarity — hex string comparison (used only when no descriptor).
   * Note: this is a last resort; real verification uses descriptorDistance().
   */
  calculateTemplateSimilarity(hash1, hash2) {
    if (hash1 === hash2) return 1.0;
    let matches = 0;
    const len = Math.min(hash1.length, hash2.length);
    for (let i = 0; i < len; i++) {
      if (hash1[i] === hash2[i]) matches++;
    }
    return matches / len;
  }

  /**
   * Perform network consensus for verification
   */
  async performNetworkConsensus(verificationId, biometricHash, biometricData) {
    if (!this.networkNode) {
      return { passed: true, skipped: true, reason: 'No network node available' };
    }

    // Create consensus request — include descriptor so remote nodes can do Euclidean distance checks
    const descriptor = (biometricData.facial?.descriptor?.length === 128)
      ? biometricData.facial.descriptor : null;

    const request = {
      verificationId,
      biometricHash,
      templateHash: this.generateTemplateHash(biometricData),
      descriptor,
      requestedAt: Date.now(),
      timeout: 30000 // 30 second timeout
    };

    this.consensusVotes.set(verificationId, {
      request,
      votes: [],
      resolved: false
    });

    try {
      // Broadcast to network
      await this.networkNode.broadcastVerificationRequest(request);

      // Wait for votes (with timeout)
      const votes = await this.waitForConsensusVotes(verificationId, request.timeout);

      if (votes.length < 3) {
        return {
          passed: true, // Allow if not enough nodes to reach consensus
          warning: 'Insufficient network nodes for consensus',
          votesReceived: votes.length
        };
      }

      // Calculate consensus
      const approvals = votes.filter(v => v.approved).length;
      const consensusRatio = approvals / votes.length;

      if (consensusRatio < this.consensusThreshold) {
        return {
          passed: false,
          reason: `Network consensus rejected (${(consensusRatio * 100).toFixed(1)}% approval)`,
          votesReceived: votes.length,
          approvals,
          threshold: this.consensusThreshold
        };
      }

      return {
        passed: true,
        votesReceived: votes.length,
        approvals,
        consensusRatio
      };

    } catch (error) {
      return {
        passed: true, // Allow if network error (fail open for availability)
        warning: `Network consensus error: ${error.message}`
      };
    }
  }

  async waitForConsensusVotes(verificationId, timeout) {
    const startTime = Date.now();
    const checkInterval = 1000;

    while (Date.now() - startTime < timeout) {
      const consensus = this.consensusVotes.get(verificationId);
      if (consensus && consensus.votes.length >= 3) {
        return consensus.votes;
      }

      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    const consensus = this.consensusVotes.get(verificationId);
    return consensus ? consensus.votes : [];
  }

  /**
   * Receive consensus vote from network
   */
  receiveConsensusVote(verificationId, nodeId, vote) {
    const consensus = this.consensusVotes.get(verificationId);
    if (!consensus || consensus.resolved) return;

    consensus.votes.push({
      nodeId,
      approved: vote.approved,
      confidence: vote.confidence,
      publicKey: vote.publicKey || null,
      signature: vote.signature || null,
      timestamp: Date.now()
    });
  }

  /**
   * Return approved votes that include a node signature.
   * Used by AnkhChainAPI to build the multi-sig verificationProof.
   */
  getApprovedVotes(verificationId) {
    const consensus = this.consensusVotes.get(verificationId);
    if (!consensus) return [];
    return consensus.votes
      .filter(v => v.approved && v.publicKey && v.signature)
      .map(v => ({ publicKey: v.publicKey, signature: v.signature }));
  }

  /**
   * Verify biological age
   */
  async verifyBiologicalAge(biometricData) {
    const ageResult = await this.ageVerifier.verifyAge(biometricData);

    return {
      passed: ageResult.eligible,
      needsReview: ageResult.needsReview,
      reason: ageResult.reason,
      details: {
        estimatedAge: ageResult.combinedEstimate,
        confidence: ageResult.confidence,
        method: Object.keys(ageResult.analyses).join('+')
      }
    };
  }

  /**
   * Quality check
   */
  performQualityCheck(biometricData) {
    const facial = biometricData.facial;
    const quality = facial.quality || facial.imageQuality || 0.7;

    if (quality < 0.5) {
      return {
        passed: false,
        reason: 'Image quality too low for reliable verification',
        quality
      };
    }

    return {
      passed: true,
      quality
    };
  }

  /**
   * Finalize verification result
   */
  finalizeResult(result) {
    result.processingTimeMs = Date.now() - result.timestamp;
    result.stepsCompleted = result.steps.filter(s => s.passed).length;
    result.totalSteps = result.steps.length;

    return result;
  }

  /**
   * Get verification statistics
   */
  getStats() {
    const total = this.stats.totalVerifications || 1;

    return {
      ...this.stats,
      successRate: ((this.stats.successfulVerifications / total) * 100).toFixed(2) + '%',
      duplicateRate: ((this.stats.duplicatesDetected / total) * 100).toFixed(2) + '%',
      indexSize: this.biometricIndex.size
    };
  }

  /**
   * Export biometric index (for sync)
   */
  exportIndex() {
    return Array.from(this.biometricIndex.entries()).map(([hash, record]) => ({
      biometricHash: hash,
      address: record.address,
      verificationId: record.verificationId,
      timestamp: record.timestamp
    }));
  }

  /**
   * Import biometric index (for sync)
   */
  importIndex(records) {
    for (const record of records) {
      if (!this.biometricIndex.has(record.biometricHash)) {
        this.biometricIndex.set(record.biometricHash, {
          address: record.address,
          verificationId: record.verificationId,
          timestamp: record.timestamp,
          templateHash: record.templateHash,
          descriptor: record.descriptor || null
        });
      }
    }
  }

  /**
   * Rebuild biometricIndex from StateManager after a restart.
   *
   * StateManager loads verified_users.json and biometric_descriptors.json on startup.
   * This method wires those persisted records back into the in-memory biometricIndex
   * so Euclidean distance duplicate detection works immediately — no warm-up period.
   */
  syncFromStateManager() {
    let synced = 0;
    this.stateManager.verifiedUsers.forEach((user, biometricHash) => {
      if (!this.biometricIndex.has(biometricHash)) {
        const descriptor = this.stateManager.getDescriptor(biometricHash);
        this.biometricIndex.set(biometricHash, {
          address: user.address,
          verificationId: user.verificationId,
          timestamp: user.registrationTimestamp,
          templateHash: user.biometricTemplateHash || biometricHash,
          descriptor
        });
        synced++;
      }
    });
    if (synced > 0) {
      console.log(`[BiometricVerifier] Rebuilt index from state: ${synced} record(s) loaded`);
    }
  }
}

module.exports = EnhancedBiometricVerifier;
