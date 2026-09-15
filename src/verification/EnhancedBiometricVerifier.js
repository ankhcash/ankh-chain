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

/**
 * Collect the frames a submission offers.
 *
 * Older clients send a single `image`; the capture UI sends `frames`. Both are
 * accepted, and `image` is folded in as one more frame when both are present so
 * nothing a client bothered to send is thrown away. Duplicates are dropped —
 * the same frame sent twice would otherwise look like corroboration.
 */
function collectFrames(facial) {
  const out = [];
  const seen = new Set();
  const push = (f) => {
    if (typeof f !== 'string' || f.length < 64) return;
    // Key on a bounded slice: data URIs run to hundreds of kilobytes and the
    // head plus tail is more than enough to tell two captures apart.
    const key = f.length + ':' + f.slice(0, 64) + f.slice(-64);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(f);
  };

  if (Array.isArray(facial.frames)) facial.frames.forEach(push);
  push(facial.image);
  return out.slice(0, GenesisConfig.BIOMETRIC.FRAMES_MAX);
}

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

    // Metadata index: biometricHash -> {address, verificationId, timestamp, templateHash}.
    // Descriptors are NOT duplicated here — they live once in
    // stateManager.biometricDescriptors (BiometricStore), which owns matching.
    // Keeping two copies previously doubled memory and let the two drift apart.
    this.biometricIndex = new Map();

    // address -> timestamp of last completed verification, for cooldown enforcement
    this.lastVerificationAt = new Map();

    // Verification queue
    this.verificationQueue = new Map();
    this.consensusVotes = new Map();

    // Rate limiting. Entries were previously never evicted, so the map grew
    // without bound for the lifetime of the process; sweep it periodically.
    this.attemptCounts = new Map();
    this.maxAttemptsPerHour = 5;
    this.lastSweepAt = Date.now();
    this.sweepIntervalMs = 10 * 60 * 1000;

    // Statistics
    this.stats = {
      totalVerifications: 0,
      successfulVerifications: 0,
      duplicatesDetected: 0,
      heldForReview: 0,
      livenessFailures: 0,
      ageVerificationFailures: 0,
      consensusRejections: 0,
      forgedDescriptorsRejected: 0,
      serverInferenceRejections: 0,
      cooldownRejections: 0
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

      // Step 2b: Re-verification cooldown
      const cooldownCheck = this.checkCooldown(address);
      result.steps.push({ step: 'COOLDOWN', ...cooldownCheck });
      if (!cooldownCheck.passed) {
        this.stats.cooldownRejections++;
        result.reason = cooldownCheck.reason;
        return this.finalizeResult(result);
      }

      // Step 2c: Descriptor integrity.
      //
      // This gate only means something when the client's descriptor is the one
      // that gets committed. With SERVER_SIDE_INFERENCE on, the node recomputes
      // the descriptor from the image and discards the client's entirely — so
      // rejecting a person here turns them away over a value the system was
      // about to throw out, while buying no security at all. The check still
      // runs, because a client descriptor that looks nothing like model output
      // is worth recording, but it cannot be the thing that fails the person.
      const serverSideWillReplace = GenesisConfig.BIOMETRIC.SERVER_SIDE_INFERENCE;

      if (biometricData.facial?.descriptor !== undefined) {
        const integrityCheck = this.validateDescriptorIntegrity(biometricData.facial.descriptor);
        result.steps.push({
          step: 'DESCRIPTOR_INTEGRITY',
          ...integrityCheck,
          ...(serverSideWillReplace && !integrityCheck.passed
            ? { enforced: false, note: 'client descriptor is replaced by server-side re-derivation' }
            : {})
        });
        if (!integrityCheck.passed && !serverSideWillReplace) {
          this.stats.forgedDescriptorsRejected++;
          result.reason = integrityCheck.reason;
          return this.finalizeResult(result);
        }
      }

      // Step 2d: Optional server-side re-derivation of the descriptor from the
      // submitted image. When enabled this replaces the client's descriptor,
      // which is what actually defeats a forged POST.
      if (serverSideWillReplace) {
        const serverCheck = await this.performServerSideInference(biometricData);
        result.steps.push({ step: 'SERVER_SIDE_INFERENCE', ...serverCheck });
        if (!serverCheck.passed) {
          this.stats.serverInferenceRejections++;
          result.reason = serverCheck.reason;
          return this.finalizeResult(result);
        }

        // Now validate what will actually be committed. This is the node's own
        // model output, so a failure here is a bug or a misconfiguration on this
        // node rather than anything the submitter did — say so, instead of
        // reporting it as a forged descriptor.
        const derivedCheck = this.validateDescriptorIntegrity(biometricData.facial?.descriptor);
        result.steps.push({ step: 'DERIVED_DESCRIPTOR_INTEGRITY', ...derivedCheck });
        if (!derivedCheck.passed) {
          result.reason =
            `Node-derived descriptor failed its own integrity check (${derivedCheck.reason}). ` +
            `This is a node configuration fault, not a problem with the submission.`;
          return this.finalizeResult(result);
        }
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
        // A borderline match is held, not counted as a duplicate: calling it one
        // would both misreport the statistic and tell the person they are already
        // registered when nobody has actually established that.
        if (localDuplicateCheck.needsReview) {
          this.stats.heldForReview = (this.stats.heldForReview || 0) + 1;
          result.needsReview = true;
        } else {
          this.stats.duplicatesDetected++;
        }
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
        const consensusCheck = await this.performNetworkConsensus(verificationId, biometricHash, biometricData, address);
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

      // ── This node's own capture measurement ──────────────────────────────
      // Built here, after every check has passed, because the attestation has
      // to state what was measured across the whole pipeline — frames, quality,
      // liveness and age — not just the parts one step happened to see. It is
      // returned unsigned; the API signs it with the node key, which is the only
      // component that holds one.
      const captureAnalysis = biometricData.facial?._captureAnalysis;
      if (GenesisConfig.BIOMETRIC.CAPTURE_ATTESTATION.PRODUCE && captureAnalysis) {
        const CaptureAttestation = require('../core/CaptureAttestation');
        result.captureMeasurement = CaptureAttestation.measure({
          address,
          biometricHash,
          analysis: captureAnalysis.analysis,
          drift: captureAnalysis.drift,
          framesSubmitted: captureAnalysis.framesSubmitted,
          sequence: biometricData.facial?.sequence,
          age: { estimate: ageCheck.details?.estimatedAge, confidence: ageCheck.details?.confidence }
        });
      }

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

      // Start the re-verification cooldown for this address.
      this.lastVerificationAt.set(address, Date.now());

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

    // Evict keys with no recent attempts. Without this the map retained an
    // entry for every IP ever seen, for the life of the process.
    if (now - this.lastSweepAt > this.sweepIntervalMs) {
      for (const [key, times] of this.attemptCounts) {
        if (!times.some(t => t > hourAgo)) this.attemptCounts.delete(key);
      }
      const cooldownMs = this.cooldownPeriodDays * 24 * 60 * 60 * 1000;
      for (const [addr, at] of this.lastVerificationAt) {
        if (now - at > cooldownMs) this.lastVerificationAt.delete(addr);
      }
      this.lastSweepAt = now;
    }

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
    if (!data.facial.sequence && !data.facial.image && !Array.isArray(data.facial.frames)) {
      return { passed: false, reason: 'Facial data must include liveness sequence or image' };
    }

    return { passed: true };
  }

  /**
   * Re-derive the descriptor server-side and substitute it for the client's.
   *
   * On success `biometricData.facial.descriptor` is *replaced* with the node's
   * own computation, so everything downstream (hashing, duplicate matching,
   * registration) commits to what the server saw rather than what the client
   * claimed. The client's descriptor is kept only to report drift.
   */
  async performServerSideInference(biometricData) {
    if (!this.serverFaceVerifier) {
      const ServerFaceVerifier = require('./ServerFaceVerifier');
      this.serverFaceVerifier = new ServerFaceVerifier();
      await this.serverFaceVerifier.init();
    }

    if (!this.serverFaceVerifier.available()) {
      // Configured on but unavailable. Fail closed: with inference enabled the
      // operator has declared client descriptors untrusted, so silently
      // accepting them would defeat the point.
      return {
        passed: false,
        reason: 'Server-side face verification is enabled but unavailable on this node — ' +
                'registration refused rather than trusting a client-supplied descriptor',
        unavailable: true
      };
    }

    const facial = biometricData.facial || {};
    const frames = collectFrames(facial);

    if (!frames.length) {
      return { passed: false, reason: 'An image is required when server-side face verification is enabled' };
    }

    // Fusion when the capture supplied a set, single-frame when it supplied one.
    // Both paths are kept because a node has no control over what a given client
    // sends; the fused path is simply better, and the capture UI always uses it.
    let analysis;
    let fusion = null;
    try {
      if (GenesisConfig.BIOMETRIC.MULTI_FRAME_ENABLED && frames.length > 1) {
        analysis = await this.serverFaceVerifier.analyzeFrames(frames);
        fusion = {
          framesSubmitted: frames.length,
          framesAccepted: analysis.frameCount,
          framesRejected: analysis.rejected.map(r => ({ index: r.index, reason: r.reason })),
          cohesion: parseFloat(analysis.cohesion.toFixed(4)),
          quality: parseFloat(analysis.quality.toFixed(4))
        };
        if (analysis.frameCount < GenesisConfig.BIOMETRIC.FRAMES_MIN_ACCEPTED) {
          const why = analysis.rejected.length ? analysis.rejected[0].reason : 'insufficient usable frames';
          return {
            passed: false,
            fusion,
            reason: `Only ${analysis.frameCount} of ${frames.length} frames were usable ` +
                    `(need ${GenesisConfig.BIOMETRIC.FRAMES_MIN_ACCEPTED}) — ${why}`
          };
        }
      } else {
        analysis = await this.serverFaceVerifier.analyze(frames[0]);
        if (analysis.quality && !analysis.quality.passed) {
          return { passed: false, reason: `Capture quality insufficient: ${analysis.quality.reason}` };
        }
      }
    } catch (err) {
      return { passed: false, reason: `Server-side face analysis failed: ${err.message}` };
    }

    const clientDescriptor = Array.isArray(facial.descriptor) && facial.descriptor.length === 128
      ? facial.descriptor
      : null;

    let drift = null;
    if (clientDescriptor) {
      const ServerFaceVerifier = require('./ServerFaceVerifier');
      drift = ServerFaceVerifier.euclidean(clientDescriptor, analysis.descriptor);
      if (drift > GenesisConfig.BIOMETRIC.SERVER_CLIENT_MAX_DRIFT) {
        return {
          passed: false,
          reason: `Submitted descriptor does not match the submitted image ` +
                  `(distance ${drift.toFixed(4)} > ${GenesisConfig.BIOMETRIC.SERVER_CLIENT_MAX_DRIFT}) — ` +
                  `descriptor was not derived from this face`,
          drift
        };
      }
    }

    // Authoritative substitution — downstream steps now use the server's vector.
    facial.descriptor = analysis.descriptor;
    facial.serverVerified = true;
    // Age likewise comes from the server's own inference, not the client's claim.
    facial.ageEstimate = analysis.age;
    facial.ageConfidence = Math.min(0.95, Math.max(0.5, analysis.detectionScore));

    // Downstream quality checks read the server's measurement, not the client's.
    facial.serverQuality = fusion ? fusion.quality
      : (analysis.quality ? analysis.quality.score : null);
    if (fusion) facial.fusedFrameCount = fusion.framesAccepted;

    // Kept for the capture attestation, which can only be built once liveness
    // and age have also been decided. Non-enumerable so it never lands in an API
    // response or a log line by accident — it holds per-frame measurements.
    Object.defineProperty(facial, '_captureAnalysis', {
      value: { analysis, framesSubmitted: frames.length, drift: drift || 0 },
      enumerable: false, configurable: true, writable: true
    });

    return {
      passed: true,
      drift,
      fusion,
      detectionScore: analysis.detectionScore,
      serverAge: Math.round(analysis.age)
    };
  }



  /**
   * Validate that a descriptor could plausibly have come from face-api's
   * recognition head, before it is trusted for matching or registration.
   *
   * The recognition net emits L2-normalised 128-d embeddings, so a genuine
   * descriptor has ||d|| ≈ 1, small individual components, and high variety
   * across dimensions. A hand-rolled or randomly generated array posted
   * straight at /verify fails at least one of these.
   *
   * This raises the cost of forging a descriptor; it does not eliminate it —
   * an attacker who mimics the statistics still passes. Only server-side
   * re-derivation from the image (SERVER_SIDE_INFERENCE) closes that gap.
   */
  validateDescriptorIntegrity(descriptor) {
    const C = GenesisConfig.BIOMETRIC;

    if (!Array.isArray(descriptor) || descriptor.length !== 128) {
      return { passed: false, reason: 'Descriptor must be a 128-element array' };
    }

    let sumSq = 0;
    let maxAbs = 0;
    const distinct = new Set();

    for (let i = 0; i < 128; i++) {
      const v = descriptor[i];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        return { passed: false, reason: `Descriptor contains a non-finite value at index ${i}` };
      }
      sumSq += v * v;
      const abs = Math.abs(v);
      if (abs > maxAbs) maxAbs = abs;
      distinct.add(v.toFixed(6));
    }

    const norm = Math.sqrt(sumSq);
    if (norm < C.DESCRIPTOR_NORM_MIN || norm > C.DESCRIPTOR_NORM_MAX) {
      return {
        passed: false,
        reason: `Descriptor is not a valid face embedding (L2 norm ${norm.toFixed(4)}, ` +
                `expected ${C.DESCRIPTOR_NORM_MIN}–${C.DESCRIPTOR_NORM_MAX}) — not face-api output`
      };
    }

    if (maxAbs > C.DESCRIPTOR_COMPONENT_MAX) {
      return {
        passed: false,
        reason: `Descriptor has an implausible component magnitude (${maxAbs.toFixed(4)} > ${C.DESCRIPTOR_COMPONENT_MAX})`
      };
    }

    if (distinct.size < C.DESCRIPTOR_MIN_DISTINCT) {
      return {
        passed: false,
        reason: `Descriptor is degenerate (${distinct.size} distinct values, expected >= ${C.DESCRIPTOR_MIN_DISTINCT})`
      };
    }

    return { passed: true, norm: parseFloat(norm.toFixed(4)), maxComponent: parseFloat(maxAbs.toFixed(4)) };
  }

  /**
   * Enforce the re-verification cooldown.
   *
   * COOLDOWN_PERIOD_DAYS was previously read into a field and never used, so an
   * address could be re-submitted indefinitely. Applies to addresses that have
   * already completed a verification — a failed attempt does not lock anyone
   * out, so a user with poor lighting can simply retry.
   */
  checkCooldown(address) {
    const cooldownMs = this.cooldownPeriodDays * 24 * 60 * 60 * 1000;

    let last = this.lastVerificationAt.get(address);
    if (last === undefined) {
      // Fall back to on-chain registration time so the cooldown survives restarts.
      const hash = this.stateManager.addressToBiometric?.get(address);
      const user = hash ? this.stateManager.verifiedUsers.get(hash) : null;
      last = user?.registrationTimestamp;
    }
    if (!last) return { passed: true };

    const elapsed = Date.now() - last;
    if (elapsed < cooldownMs) {
      const daysLeft = Math.ceil((cooldownMs - elapsed) / (24 * 60 * 60 * 1000));
      return {
        passed: false,
        reason: `Address already verified — re-verification allowed in ${daysLeft} day(s) ` +
                `(${this.cooldownPeriodDays}-day cooldown)`
      };
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
    // 1. Exact hash match — same descriptor bytes already registered.
    if (this.stateManager.biometricDescriptors.has(biometricHash) ||
        this.biometricIndex.has(biometricHash)) {
      const existing = this.biometricIndex.get(biometricHash);
      return {
        passed: false,
        reason: 'Duplicate biometric detected (exact match)',
        existingAddress: existing?.address ||
          this.stateManager.biometricToAddress.get(biometricHash) || null,
        matchType: 'exact'
      };
    }

    const newDescriptor = biometricData.facial?.descriptor;
    const hasRealDescriptor = Array.isArray(newDescriptor) && newDescriptor.length === 128;

    if (hasRealDescriptor) {
      // 2. Exact nearest-match over the sharded descriptor store.
      //    Single shared index, so this can no longer disagree with the
      //    duplicate check that runs during block execution.
      const threshold = GenesisConfig.BIOMETRIC.SAME_PERSON_THRESHOLD;
      const band = GenesisConfig.BIOMETRIC.REVIEW_BAND || 0;

      // Search out to the far edge of the adjudication band, so a face that
      // lands just outside the match threshold is seen rather than silently
      // treated as a stranger.
      const match = this.stateManager.findDuplicateDescriptor(newDescriptor, threshold + band);

      if (match && band > 0 && match.distance >= threshold) {
        // Neither clearly the same person nor clearly a different one. At
        // register scale this band holds both a returning person whose capture
        // drifted and a genuine stranger who happens to sit close, and guessing
        // between them auto-issues or auto-denies a lifetime entitlement.
        //
        // The address that was nearly matched is deliberately NOT returned. The
        // submitter is, by definition, probably not that person, and handing
        // them somebody else's address because their faces are similar is a
        // disclosure with no upside. It goes to the node's log, where an
        // operator adjudicating the case can see it.
        console.warn(
          `[biometric] held for review: candidate near ${match.address} at distance ` +
          `${match.distance.toFixed(4)} (match <${threshold}, band to ${(threshold + band).toFixed(2)})`
        );
        return {
          passed: false,
          needsReview: true,
          reason: 'This capture is close enough to an existing registration that it cannot be ' +
                  'confirmed as a new person automatically. It has been held for review rather ' +
                  'than approved or refused.',
          matchType: 'review'
        };
      }

      if (match) {
        const similarity = parseFloat((1 - match.distance / 1.4).toFixed(4));
        return {
          passed: false,
          reason: `Duplicate biometric detected — face already registered to ${match.address} ` +
                  `(distance ${match.distance.toFixed(4)}, ${(similarity * 100).toFixed(1)}% similar; threshold ${threshold})`,
          existingAddress: match.address,
          matchType: 'descriptor',
          distance: match.distance,
          similarity
        };
      }
    } else {
      // 3. Fallback: template hash similarity (legacy/empty-descriptor submissions).
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
  async performNetworkConsensus(verificationId, biometricHash, biometricData, address) {
    if (!this.networkNode) {
      // A third fail-open path, distinct from the two the audit identified: when
      // no network node is attached the consensus step is skipped entirely and
      // silently reported as passing. In production the verifier is currently
      // constructed without one, so "decentralized biometric consensus" is not
      // actually running — every registration is decided by this node alone.
      //
      // This is surfaced rather than made fatal, because failing closed here
      // would halt all verification on a deployment that has never had consensus
      // wired. It is counted and reported through /verification/stats so the gap
      // is visible instead of implied to be working.
      this.stats.consensusSkipped = (this.stats.consensusSkipped || 0) + 1;
      if (!this._warnedNoConsensus) {
        console.warn(
          '[BiometricVerifier] No network node attached — biometric consensus is ' +
          'NOT running. Registrations are decided by this node alone.'
        );
        this._warnedNoConsensus = true;
      }
      return {
        passed: true,
        skipped: true,
        singleNodeOnly: true,
        reason: 'No network node attached — consensus not performed, this node decided alone'
      };
    }

    // Create consensus request — include descriptor so remote nodes can do Euclidean distance checks
    const descriptor = (biometricData.facial?.descriptor?.length === 128)
      ? biometricData.facial.descriptor : null;

    const request = {
      verificationId,
      biometricHash,
      templateHash: this.generateTemplateHash(biometricData),
      descriptor,
      // Peers need the image to derive the descriptor themselves. Sending only
      // the descriptor would have every peer vote on this node's computation,
      // which is not consensus — it is one node's result counted several times.
      image: biometricData.facial?.image || null,
      // The whole frame set, not just one of them: a peer that fuses a different
      // subset computes a different vector and votes on something the submitting
      // node never proposed. Consensus requires the same input, not similar input.
      frames: collectFrames(biometricData.facial || {}),
      // Peers measure liveness and bind their attestation to the address, so
      // both have to travel with the request. Without them a peer can only
      // attest to the imagery, and the liveness half of the standard would
      // still rest on the submitting node alone.
      address,
      sequence: biometricData.facial?.sequence || [],
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

      const minVotes = GenesisConfig.BIOMETRIC.CONSENSUS_MIN_VOTES;
      if (votes.length < minVotes) {
        // Fail closed: no agreement, no monetary entitlement.
        if (!GenesisConfig.BIOMETRIC.CONSENSUS_FAIL_OPEN) {
          return {
            passed: false,
            reason: `Insufficient network consensus (${votes.length}/${minVotes} nodes responded) — ` +
                    `verification creates a lifetime allocation and cannot be approved without agreement`,
            votesReceived: votes.length
          };
        }
        console.warn(
          `[BiometricVerifier] SOLO MODE: approving verification with only ${votes.length}/${minVotes} ` +
          `consensus votes because ANKH_ALLOW_SOLO_VERIFICATION=1. This is unsafe for production.`
        );
        return {
          passed: true,
          warning: 'Approved without network consensus (solo mode override)',
          votesReceived: votes.length,
          soloOverride: true
        };
      }

      // Calculate consensus
      const approvals = votes.filter(v => v.approved).length;
      const consensusRatio = approvals / votes.length;
      // How many peers actually ran the model rather than only checking their
      // index. An approval from a peer that re-derived the descriptor is a much
      // stronger statement than one that merely failed to find a duplicate.
      const derivedVotes = votes.filter(v => v.independentlyDerived).length;

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
        consensusRatio,
        independentlyDerived: derivedVotes,
        allIndependent: derivedVotes === votes.length
      };

    } catch (error) {
      // A network failure is indistinguishable from a deliberate partition, so
      // it cannot be treated as approval.
      if (!GenesisConfig.BIOMETRIC.CONSENSUS_FAIL_OPEN) {
        return {
          passed: false,
          reason: `Network consensus unavailable (${error.message}) — verification refused`,
          error: error.message
        };
      }
      console.warn(`[BiometricVerifier] SOLO MODE: consensus error ignored — ${error.message}`);
      return {
        passed: true,
        warning: `Network consensus error: ${error.message}`,
        soloOverride: true
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
      attestation: vote.attestation || null,
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
   * Capture attestations gathered from peers during the consensus round.
   *
   * These are what let a validator that never saw the images confirm the
   * capture met the standard: each one is a registered node's signed statement
   * of what it independently measured.
   */
  getCaptureAttestations(verificationId) {
    const consensus = this.consensusVotes.get(verificationId);
    if (!consensus) return [];
    return consensus.votes
      .filter(v => v.approved && v.attestation)
      .map(v => v.attestation);
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

    // Prefer the figure this node measured from the pixels. A client-reported
    // quality score is self-assessment: every submission claims to be good.
    const serverMeasured = typeof facial.serverQuality === 'number';
    const quality = serverMeasured
      ? facial.serverQuality
      : (facial.quality || facial.imageQuality || 0.7);

    if (quality < 0.5) {
      return {
        passed: false,
        reason: 'Image quality too low for reliable verification',
        quality,
        source: serverMeasured ? 'server' : 'client'
      };
    }

    return {
      passed: true,
      quality,
      source: serverMeasured ? 'server' : 'client',
      fusedFrameCount: facial.fusedFrameCount || 1
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
      indexSize: this.stateManager.biometricDescriptors.size,
      metadataIndexSize: this.biometricIndex.size,
      rateLimitKeys: this.attemptCounts.size,
      consensusSkipped: this.stats.consensusSkipped || 0,
      consensusActive: !!this.networkNode,
      consensusFailOpen: GenesisConfig.BIOMETRIC.CONSENSUS_FAIL_OPEN,
      serverSideInference: GenesisConfig.BIOMETRIC.SERVER_SIDE_INFERENCE
        ? (this.serverFaceVerifier?.available() ? 'active' : 'enabled-unavailable')
        : 'disabled',
      descriptorStore: this.stateManager.biometricDescriptors.getStats()
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
          templateHash: record.templateHash
        });
      }
      // Descriptors belong to the shared store, which owns matching.
      if (record.descriptor) {
        this.stateManager.storeDescriptor(record.biometricHash, record.descriptor);
      }
    }
  }

  /**
   * Restore the metadata index from StateManager after a restart.
   *
   * StateManager loads verified_users.json and the sharded descriptor store on startup.
   * This method wires those persisted records back into the in-memory biometricIndex
   * so Euclidean distance duplicate detection works immediately — no warm-up period.
   */
  syncFromStateManager() {
    // Descriptors now live in a single shared BiometricStore that StateManager
    // loads (uncapped) at startup, so there is no separate index to rebuild —
    // matching reads straight from it. This only restores the lightweight
    // metadata map used for exact-hash lookups and stats.
    let synced = 0;
    this.stateManager.verifiedUsers.forEach((user, biometricHash) => {
      if (!this.biometricIndex.has(biometricHash)) {
        this.biometricIndex.set(biometricHash, {
          address: user.address,
          verificationId: user.verificationId,
          timestamp: user.registrationTimestamp,
          templateHash: user.biometricTemplateHash || biometricHash
        });
        synced++;
      }
    });
    if (synced > 0) {
      console.log(
        `[BiometricVerifier] Metadata index restored: ${synced} record(s); ` +
        `${this.stateManager.biometricDescriptors.size.toLocaleString()} descriptor(s) available for matching`
      );
    }
    return synced;
  }
}

module.exports = EnhancedBiometricVerifier;
