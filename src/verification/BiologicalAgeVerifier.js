/**
 * Biological Age Verifier
 *
 * Estimates biological age using multiple methods:
 * - Facial feature analysis (primary)
 * - Voice maturity analysis
 * - Skin texture analysis
 *
 * Designed to work without government documents for stateless individuals.
 */

const crypto = require('crypto');
const GenesisConfig = require('../core/GenesisConfig');

class BiologicalAgeVerifier {
  constructor() {
    // Age estimation thresholds
    this.maturityAge = GenesisConfig.VESTING_START_AGE; // 18
    this.biologicalAgeMin = GenesisConfig.BIOMETRIC.BIOLOGICAL_AGE_MIN; // 20 (with buffer)
    this.ageBuffer = GenesisConfig.BIOMETRIC.AGE_ESTIMATION_BUFFER; // ±2 years

    // Confidence thresholds
    this.highConfidenceThreshold = 0.9;
    this.mediumConfidenceThreshold = 0.7;
    this.manualReviewThreshold = GenesisConfig.BIOMETRIC.MANUAL_REVIEW_THRESHOLD; // 0.88

    // Feature weights for combined estimation
    this.featureWeights = {
      facial: 0.50,      // 50% weight to facial analysis
      voice: 0.30,       // 30% weight to voice analysis
      skin: 0.20         // 20% weight to skin texture
    };

    // Statistics
    this.stats = {
      totalVerifications: 0,
      approved: 0,
      rejected: 0,
      manualReview: 0
    };
  }

  /**
   * Perform comprehensive age verification
   */
  async verifyAge(biometricData) {
    const verificationId = crypto.randomUUID();
    const startTime = Date.now();

    const results = {
      verificationId,
      timestamp: startTime,
      analyses: {},
      combinedEstimate: null,
      confidence: 0,
      eligible: false,
      needsReview: false,
      reason: null
    };

    try {
      // 1. Facial Age Analysis
      if (biometricData.facial) {
        results.analyses.facial = this.analyzeFacialAge(biometricData.facial);
      }

      // 2. Voice Age Analysis
      if (biometricData.voice && GenesisConfig.BIOMETRIC.VOICE_VERIFICATION_ENABLED) {
        results.analyses.voice = this.analyzeVoiceAge(biometricData.voice);
      }

      // 3. Skin Texture Analysis
      if (biometricData.skin && GenesisConfig.BIOMETRIC.SKIN_ANALYSIS_ENABLED) {
        results.analyses.skin = this.analyzeSkinAge(biometricData.skin);
      }

      // Calculate combined estimate
      results.combinedEstimate = this.calculateCombinedEstimate(results.analyses);
      results.confidence = this.calculateCombinedConfidence(results.analyses);

      // Determine eligibility
      const eligibility = this.determineEligibility(
        results.combinedEstimate,
        results.confidence
      );

      results.eligible = eligibility.eligible;
      results.needsReview = eligibility.needsReview;
      results.reason = eligibility.reason;

      // Update stats
      this.stats.totalVerifications++;
      if (results.eligible) {
        this.stats.approved++;
      } else if (results.needsReview) {
        this.stats.manualReview++;
      } else {
        this.stats.rejected++;
      }

    } catch (error) {
      results.error = error.message;
      results.eligible = false;
      results.reason = 'Verification error: ' + error.message;
    }

    results.processingTimeMs = Date.now() - startTime;

    return results;
  }

  /**
   * Analyze facial features for age estimation.
   *
   * When the frontend provides a real ML age estimate (from face-api.js
   * AgeGenderNet), use it directly with high confidence.  Otherwise fall
   * back to the landmark-geometry heuristic.
   */
  analyzeFacialAge(facialData) {
    // ── ML age estimate path (face-api.js AgeGenderNet) ───────────────────
    const mlAge  = facialData.ageEstimate;
    const mlConf = facialData.ageConfidence;

    if (mlAge > 0 && mlConf > 0) {
      const estimatedAge = Math.max(15, Math.min(90, Math.round(mlAge)));
      // Blend ML confidence with face detection quality
      const quality    = facialData.quality || 0.8;
      const confidence = Math.min(0.94, mlConf * 0.85 + quality * 0.15);

      return {
        method: 'ML_FACIAL_ESTIMATION',
        estimatedAge,
        confidence: parseFloat(confidence.toFixed(4)),
        features: {
          mlEstimate:        mlAge,
          wrinkleScore:      facialData.wrinkleScore      || null,
          skinElasticity:    facialData.skinElasticity    || null,
          jawlineDefinition: facialData.jawlineDefinition || null,
          nasolabialFolds:   facialData.nasolabialFolds   || null,
          foreheadLines:     facialData.foreheadLines     || null,
        },
        rawScore: mlAge
      };
    }

    // ── Landmark-geometry heuristic (fallback) ────────────────────────────
    const features = {
      wrinkleScore:      facialData.wrinkleScore      || this.estimateWrinkles(facialData),
      skinElasticity:    facialData.skinElasticity    || this.estimateSkinElasticity(facialData),
      facialStructure:   facialData.facialStructure   || this.analyzeFacialStructure(facialData),
      eyeAreaAge:        facialData.eyeAreaAge        || this.analyzeEyeArea(facialData),
      foreheadLines:     facialData.foreheadLines     || 0,
      nasolabialFolds:   facialData.nasolabialFolds   || 0,
      jawlineDefinition: facialData.jawlineDefinition || 0.5
    };

    let baseAge = 20;
    baseAge += features.wrinkleScore * 40;
    baseAge += (1 - features.skinElasticity) * 30;
    baseAge += features.nasolabialFolds * 20;
    baseAge += features.foreheadLines * 15;
    baseAge += (1 - features.jawlineDefinition) * 10;

    const estimatedAge  = Math.max(15, Math.min(80, Math.round(baseAge)));
    const featureClarity = facialData.quality || 0.8;
    const confidence    = this.calculateFeatureConfidence(features, featureClarity);

    return {
      method: 'FACIAL_LANDMARK_HEURISTIC',
      estimatedAge,
      confidence,
      features,
      rawScore: baseAge
    };
  }

  /**
   * Analyze voice characteristics for age estimation
   */
  analyzeVoiceAge(voiceData) {
    const features = {
      // Voice characteristics that change with age
      fundamentalFrequency: voiceData.f0 || voiceData.fundamentalFrequency || 150,
      jitter: voiceData.jitter || 0.01,        // Voice stability
      shimmer: voiceData.shimmer || 0.03,      // Amplitude variation
      harmonicsToNoise: voiceData.hnr || 20,   // Voice clarity
      formantFrequencies: voiceData.formants || [500, 1500, 2500],
      speechRate: voiceData.speechRate || 120, // Words per minute
      pausePatterns: voiceData.pausePatterns || 'normal'
    };

    // Voice-based age estimation
    let estimatedAge = 25; // Base assumption

    // Fundamental frequency (higher in children, lower in adults)
    // Adult male: 85-180 Hz, Adult female: 165-255 Hz
    // Children: 250-400 Hz
    if (features.fundamentalFrequency > 250) {
      estimatedAge -= 10; // Likely younger
    } else if (features.fundamentalFrequency < 120) {
      estimatedAge += 10; // Likely older male
    }

    // Voice stability (jitter increases with age)
    estimatedAge += features.jitter * 200;

    // Harmonics-to-noise ratio (decreases with age)
    if (features.harmonicsToNoise < 15) {
      estimatedAge += 10;
    } else if (features.harmonicsToNoise > 25) {
      estimatedAge -= 5;
    }

    // Normalize
    estimatedAge = Math.max(15, Math.min(80, Math.round(estimatedAge)));

    // Voice analysis confidence
    const sampleQuality = voiceData.quality || 0.7;
    const confidence = Math.min(0.85, sampleQuality * 0.9);

    return {
      method: 'VOICE_ANALYSIS',
      estimatedAge,
      confidence,
      features,
      gender: features.fundamentalFrequency > 165 ? 'female_likely' : 'male_likely'
    };
  }

  /**
   * Analyze skin texture for age estimation
   */
  analyzeSkinAge(skinData) {
    const features = {
      // Skin characteristics
      textureUniformity: skinData.uniformity || 0.7,
      poreSize: skinData.poreSize || 'medium',
      pigmentation: skinData.pigmentation || 0.2,
      elasticityScore: skinData.elasticity || 0.8,
      hydrationLevel: skinData.hydration || 0.7,
      fineLinesScore: skinData.fineLines || 0.1
    };

    let estimatedAge = 25;

    // Texture uniformity decreases with age
    estimatedAge += (1 - features.textureUniformity) * 30;

    // Pore size typically increases
    const poreSizeMultiplier = {
      'small': 0,
      'medium': 10,
      'large': 20
    };
    estimatedAge += poreSizeMultiplier[features.poreSize] || 10;

    // Pigmentation irregularities increase with age
    estimatedAge += features.pigmentation * 25;

    // Elasticity decreases
    estimatedAge += (1 - features.elasticityScore) * 30;

    // Fine lines increase
    estimatedAge += features.fineLinesScore * 40;

    // Normalize
    estimatedAge = Math.max(15, Math.min(80, Math.round(estimatedAge)));

    const imageQuality = skinData.quality || 0.75;
    const confidence = Math.min(0.80, imageQuality * 0.85);

    return {
      method: 'SKIN_ANALYSIS',
      estimatedAge,
      confidence,
      features
    };
  }

  /**
   * Calculate combined age estimate from multiple analyses
   */
  calculateCombinedEstimate(analyses) {
    let weightedSum = 0;
    let totalWeight = 0;

    // Apply weights to each analysis method
    for (const [method, result] of Object.entries(analyses)) {
      if (!result || !result.estimatedAge) continue;

      const weight = this.featureWeights[method.toLowerCase()] || 0.1;
      const confidenceAdjustedWeight = weight * result.confidence;

      weightedSum += result.estimatedAge * confidenceAdjustedWeight;
      totalWeight += confidenceAdjustedWeight;
    }

    if (totalWeight === 0) return null;

    return Math.round(weightedSum / totalWeight);
  }

  /**
   * Calculate combined confidence score
   */
  calculateCombinedConfidence(analyses) {
    const confidences = Object.values(analyses)
      .filter(a => a && a.confidence)
      .map(a => a.confidence);

    if (confidences.length === 0) return 0;

    // Weighted average of confidences
    // More methods = higher overall confidence
    const avgConfidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;
    const methodBonus = Math.min(0.1, (confidences.length - 1) * 0.05); // Bonus for multiple methods

    return Math.min(0.99, avgConfidence + methodBonus);
  }

  /**
   * Determine eligibility based on estimated age and confidence
   */
  determineEligibility(estimatedAge, confidence) {
    if (estimatedAge === null) {
      return {
        eligible: false,
        needsReview: false,
        reason: 'Unable to estimate age from provided biometric data'
      };
    }

    // High confidence, clearly adult
    if (estimatedAge >= this.biologicalAgeMin && confidence >= this.mediumConfidenceThreshold) {
      return {
        eligible: true,
        needsReview: false,
        reason: `Age verified biologically: estimated ${estimatedAge} years (${(confidence * 100).toFixed(1)}% confidence)`
      };
    }

    // High confidence, clearly under age
    if (estimatedAge < this.maturityAge - this.ageBuffer && confidence >= this.highConfidenceThreshold) {
      return {
        eligible: false,
        needsReview: false,
        reason: `Below age of maturity: estimated ${estimatedAge} years`
      };
    }

    // Edge case: estimated 18-20 with medium confidence
    if (estimatedAge >= this.maturityAge && estimatedAge < this.biologicalAgeMin) {
      if (confidence >= this.highConfidenceThreshold) {
        // High confidence in edge case - approve
        return {
          eligible: true,
          needsReview: false,
          reason: `Age verified with high confidence: estimated ${estimatedAge} years (${(confidence * 100).toFixed(1)}% confidence)`
        };
      }

      // Medium confidence in edge case - manual review
      return {
        eligible: false,
        needsReview: true,
        reason: `Edge case requires manual review: estimated ${estimatedAge} years (${(confidence * 100).toFixed(1)}% confidence)`
      };
    }

    // Low confidence cases
    if (confidence < this.mediumConfidenceThreshold) {
      if (estimatedAge >= this.biologicalAgeMin) {
        // Likely adult but low confidence
        return {
          eligible: false,
          needsReview: true,
          reason: `Low confidence verification: estimated ${estimatedAge} years (${(confidence * 100).toFixed(1)}% confidence)`
        };
      }

      return {
        eligible: false,
        needsReview: false,
        reason: `Unable to verify age with sufficient confidence`
      };
    }

    // Default: not eligible, no review
    return {
      eligible: false,
      needsReview: false,
      reason: `Age verification failed: estimated ${estimatedAge} years`
    };
  }

  // ============================================
  // Helper Methods (Feature Extraction)
  // ============================================

  estimateWrinkles(facialData) {
    // Would use deep learning in production
    // For now, use normalized value if provided
    if (facialData.wrinkleIndex !== undefined) {
      return Math.max(0, Math.min(1, facialData.wrinkleIndex));
    }
    return 0.2; // Default assumption: some wrinkles
  }

  estimateSkinElasticity(facialData) {
    if (facialData.elasticityIndex !== undefined) {
      return Math.max(0, Math.min(1, facialData.elasticityIndex));
    }
    return 0.7; // Default: good elasticity
  }

  analyzeFacialStructure(facialData) {
    // Facial bone structure analysis
    return {
      maturityLevel: facialData.maturityLevel || 0.7,
      symmetry: facialData.symmetry || 0.9,
      proportions: facialData.proportions || 'adult'
    };
  }

  analyzeEyeArea(facialData) {
    // Eye area ages distinctly
    return {
      crowsFeet: facialData.crowsFeet || 0.1,
      underEyeHollows: facialData.underEyeHollows || 0.2,
      droopiness: facialData.eyelidDroop || 0.1
    };
  }

  calculateFeatureConfidence(features, baseQuality) {
    // Calculate confidence based on feature extraction quality
    const featureCount = Object.keys(features).length;
    const featureQuality = Math.min(1, featureCount / 7); // 7 expected features

    return Math.min(0.95, baseQuality * featureQuality * 1.1);
  }

  // ============================================
  // Additional Utilities
  // ============================================

  /**
   * Get verification statistics
   */
  getStats() {
    const total = this.stats.totalVerifications || 1;

    return {
      ...this.stats,
      approvalRate: ((this.stats.approved / total) * 100).toFixed(2) + '%',
      rejectionRate: ((this.stats.rejected / total) * 100).toFixed(2) + '%',
      manualReviewRate: ((this.stats.manualReview / total) * 100).toFixed(2) + '%'
    };
  }

  /**
   * Request additional verification data for edge cases
   */
  requestAdditionalData(currentAnalyses) {
    const missing = [];

    if (!currentAnalyses.facial) {
      missing.push({
        type: 'facial',
        reason: 'Facial image required for primary age estimation',
        requirements: ['front-facing', 'good lighting', 'neutral expression']
      });
    }

    if (!currentAnalyses.voice && GenesisConfig.BIOMETRIC.VOICE_VERIFICATION_ENABLED) {
      missing.push({
        type: 'voice',
        reason: 'Voice sample improves verification accuracy',
        requirements: ['5-10 seconds', 'clear speech', 'quiet environment']
      });
    }

    if (!currentAnalyses.skin && GenesisConfig.BIOMETRIC.SKIN_ANALYSIS_ENABLED) {
      missing.push({
        type: 'skin',
        reason: 'Skin analysis provides additional age markers',
        requirements: ['close-up', 'natural lighting', 'no makeup if possible']
      });
    }

    return missing;
  }

  /**
   * Validate biometric data format
   */
  validateBiometricData(data) {
    const errors = [];

    if (!data) {
      return { valid: false, errors: ['No biometric data provided'] };
    }

    // At minimum, facial data is required
    if (!data.facial) {
      errors.push('Facial data is required for age verification');
    } else {
      if (!data.facial.landmarks && !data.facial.features) {
        errors.push('Facial data must include landmarks or features');
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
}

module.exports = BiologicalAgeVerifier;
