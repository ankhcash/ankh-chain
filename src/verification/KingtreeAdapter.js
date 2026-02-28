/**
 * Kingtree Adapter
 *
 * Integration layer that adapts the existing kingtree_full biometric
 * components for use with the Ankh native blockchain.
 *
 * This adapter uses the kingtree biometric engine internally but
 * exposes a clean interface without kingtree branding.
 */

const path = require('path');

class KingtreeAdapter {
  constructor() {
    this.kingtreePath = path.join(__dirname, '../../../kingtree_full/src');
    this.serializer = null;
    this.dataStore = null;
    this.distributedVerifier = null;
    this.initialized = false;
  }

  /**
   * Initialize kingtree components
   */
  async initialize() {
    try {
      // Load kingtree components
      const BiometricBlockchainSerializer = require(
        path.join(this.kingtreePath, 'biometric/BiometricBlockchainSerializer')
      );
      const BiometricDataStore = require(
        path.join(this.kingtreePath, 'biometric/BiometricDataStore')
      );

      this.serializer = new BiometricBlockchainSerializer();
      this.dataStore = new BiometricDataStore();

      // Initialize data store
      await this.dataStore.initialize?.();

      this.initialized = true;
      console.log('Kingtree adapter initialized successfully');

      return true;
    } catch (error) {
      console.warn(`Kingtree components not available: ${error.message}`);
      console.warn('Using standalone biometric verification');
      this.initialized = false;
      return false;
    }
  }

  /**
   * Check if kingtree is available
   */
  isAvailable() {
    return this.initialized;
  }

  /**
   * Serialize biometric data for blockchain storage
   * Uses kingtree serializer if available, otherwise uses simplified version
   */
  async serializeBiometricData(userId, biometricData) {
    if (this.serializer) {
      try {
        return await this.serializer.serializeBiometricForBlockchain(userId, biometricData);
      } catch (error) {
        console.warn(`Kingtree serialization failed: ${error.message}`);
      }
    }

    // Fallback: simplified serialization
    return this.simplifiedSerialization(userId, biometricData);
  }

  /**
   * Simplified biometric serialization (fallback)
   */
  simplifiedSerialization(userId, biometricData) {
    const crypto = require('crypto');
    const zlib = require('zlib');

    // Extract key features
    const template = {
      version: '2.0',
      userId,
      timestamp: Date.now(),
      biometricTemplates: {
        face: biometricData.facial ? {
          sequenceMetadata: biometricData.facial.sequence?.map(s => ({
            type: s.type,
            quality: s.quality || 0.8
          })) || [],
          quality: biometricData.facial.quality || 0.85,
          liveness: {
            confidence: biometricData.facial.livenessScore || 0.9,
            movementValidated: true
          },
          templateHash: crypto.createHash('sha256')
            .update(JSON.stringify(biometricData.facial))
            .digest('hex')
        } : null,
        voice: biometricData.voice ? {
          templateHash: crypto.createHash('sha256')
            .update(JSON.stringify(biometricData.voice))
            .digest('hex')
        } : null
      },
      verification: {
        quality: biometricData.quality || 0.85,
        livenessScore: biometricData.livenessScore || 0.9
      }
    };

    // Compress
    const jsonString = JSON.stringify(template);
    const compressed = zlib.gzipSync(Buffer.from(jsonString));
    const encoded = compressed.toString('base64');

    return {
      data: encoded,
      hash: crypto.createHash('sha256').update(jsonString).digest('hex'),
      originalSize: jsonString.length,
      compressedSize: encoded.length,
      compressionRatio: jsonString.length / encoded.length
    };
  }

  /**
   * Check for duplicate biometric using kingtree data store
   */
  async checkDuplicate(biometricData) {
    if (this.dataStore && this.dataStore.checkDuplicate) {
      try {
        return await this.dataStore.checkDuplicate(biometricData);
      } catch (error) {
        console.warn(`Kingtree duplicate check failed: ${error.message}`);
      }
    }

    // Fallback: no duplicate check available
    return {
      isDuplicate: false,
      confidence: 0,
      message: 'Kingtree data store not available for duplicate check'
    };
  }

  /**
   * Validate liveness using kingtree engine
   */
  async validateLiveness(biometricData) {
    if (this.dataStore && this.dataStore.validateLiveness) {
      try {
        return await this.dataStore.validateLiveness(biometricData);
      } catch (error) {
        console.warn(`Kingtree liveness validation failed: ${error.message}`);
      }
    }

    // Fallback: basic liveness validation
    return this.basicLivenessValidation(biometricData);
  }

  /**
   * Basic liveness validation (fallback)
   */
  basicLivenessValidation(biometricData) {
    const facial = biometricData.facial;

    if (!facial || !facial.sequence) {
      return {
        isLive: false,
        confidence: 0,
        reason: 'No liveness sequence provided'
      };
    }

    const sequence = facial.sequence;

    // Check minimum movements
    if (sequence.length < 5) {
      return {
        isLive: false,
        confidence: 0.3,
        reason: 'Insufficient liveness movements'
      };
    }

    // Check movement variety
    const movementTypes = new Set(sequence.map(s => s.type));
    if (movementTypes.size < 2) {
      return {
        isLive: false,
        confidence: 0.4,
        reason: 'Insufficient movement variety'
      };
    }

    // Check for blink
    if (!movementTypes.has('blink')) {
      return {
        isLive: false,
        confidence: 0.5,
        reason: 'Blink not detected'
      };
    }

    // Check timing (detect video playback)
    const timings = [];
    for (let i = 1; i < sequence.length; i++) {
      timings.push(sequence[i].timestamp - sequence[i - 1].timestamp);
    }

    const avgTiming = timings.reduce((a, b) => a + b, 0) / timings.length;
    const variance = timings.reduce((sum, t) => sum + Math.pow(t - avgTiming, 2), 0) / timings.length;

    if (Math.sqrt(variance) < 50) {
      return {
        isLive: false,
        confidence: 0.6,
        reason: 'Suspicious timing pattern (possible replay)'
      };
    }

    // Calculate confidence based on movement quality
    const avgQuality = sequence.reduce((sum, s) => sum + (s.score || 0.7), 0) / sequence.length;

    return {
      isLive: true,
      confidence: Math.min(0.95, avgQuality * 1.1),
      movements: sequence.length,
      movementTypes: Array.from(movementTypes)
    };
  }

  /**
   * Store biometric template using kingtree
   */
  async storeTemplate(userId, template) {
    if (this.dataStore && this.dataStore.storeTemplate) {
      try {
        return await this.dataStore.storeTemplate(userId, template);
      } catch (error) {
        console.warn(`Kingtree template storage failed: ${error.message}`);
      }
    }

    // Fallback: return success (storage handled by StateManager)
    return {
      stored: true,
      method: 'state_manager',
      userId
    };
  }

  /**
   * Compare biometric templates
   */
  async compareTemplates(template1, template2, threshold = 0.95) {
    // Simple hash-based comparison
    // In production, kingtree would do proper feature matching

    if (template1.hash && template2.hash) {
      if (template1.hash === template2.hash) {
        return { similarity: 1.0, isMatch: true };
      }
    }

    // Calculate similarity based on template features
    const similarity = this.calculateTemplateSimilarity(template1, template2);

    return {
      similarity,
      isMatch: similarity >= threshold,
      threshold
    };
  }

  /**
   * Calculate template similarity
   */
  calculateTemplateSimilarity(template1, template2) {
    // Simplified similarity calculation
    // In production, this would use proper biometric matching algorithms

    let matches = 0;
    let total = 0;

    // Compare face templates
    if (template1.biometricTemplates?.face && template2.biometricTemplates?.face) {
      total++;
      if (template1.biometricTemplates.face.templateHash ===
        template2.biometricTemplates.face.templateHash) {
        matches++;
      }
    }

    // Compare voice templates
    if (template1.biometricTemplates?.voice && template2.biometricTemplates?.voice) {
      total++;
      if (template1.biometricTemplates.voice.templateHash ===
        template2.biometricTemplates.voice.templateHash) {
        matches++;
      }
    }

    if (total === 0) return 0;
    return matches / total;
  }

  /**
   * Extract face features for comparison
   */
  extractFaceFeatures(facialData) {
    const crypto = require('crypto');

    // Extract normalized features
    const features = {
      landmarks: facialData.landmarks || [],
      descriptor: facialData.descriptor || facialData.features || [],
      faceShape: facialData.faceShape || 'unknown',
      quality: facialData.quality || 0.8
    };

    // Create feature hash
    const featureHash = crypto.createHash('sha256')
      .update(JSON.stringify(features))
      .digest('hex');

    return {
      features,
      hash: featureHash,
      extractedAt: Date.now()
    };
  }

  /**
   * Get quality score for biometric data
   */
  getQualityScore(biometricData) {
    let totalScore = 0;
    let count = 0;

    // Facial quality
    if (biometricData.facial) {
      const facialQuality = biometricData.facial.quality ||
        biometricData.facial.imageQuality || 0.7;
      totalScore += facialQuality;
      count++;

      // Bonus for good liveness
      if (biometricData.facial.livenessScore > 0.8) {
        totalScore += 0.1;
      }
    }

    // Voice quality
    if (biometricData.voice) {
      const voiceQuality = biometricData.voice.quality || 0.7;
      totalScore += voiceQuality;
      count++;
    }

    // Skin quality
    if (biometricData.skin) {
      const skinQuality = biometricData.skin.quality || 0.7;
      totalScore += skinQuality;
      count++;
    }

    if (count === 0) return 0;

    const avgQuality = totalScore / count;

    // Bonus for multi-modal verification
    const multiModalBonus = count > 1 ? (count - 1) * 0.05 : 0;

    return Math.min(1, avgQuality + multiModalBonus);
  }

  /**
   * Format biometric data for API response
   */
  formatForResponse(biometricData, includeDetails = false) {
    const response = {
      hasface: !!biometricData.facial,
      hasVoice: !!biometricData.voice,
      hasSkin: !!biometricData.skin,
      quality: this.getQualityScore(biometricData),
      modalities: []
    };

    if (biometricData.facial) response.modalities.push('face');
    if (biometricData.voice) response.modalities.push('voice');
    if (biometricData.skin) response.modalities.push('skin');

    if (includeDetails) {
      response.details = {
        facial: biometricData.facial ? {
          livenessScore: biometricData.facial.livenessScore,
          quality: biometricData.facial.quality,
          movementCount: biometricData.facial.sequence?.length || 0
        } : null,
        voice: biometricData.voice ? {
          quality: biometricData.voice.quality,
          duration: biometricData.voice.duration
        } : null
      };
    }

    return response;
  }
}

// Singleton instance
let instance = null;

module.exports = {
  KingtreeAdapter,

  getInstance: () => {
    if (!instance) {
      instance = new KingtreeAdapter();
    }
    return instance;
  },

  initialize: async () => {
    const adapter = module.exports.getInstance();
    return await adapter.initialize();
  }
};
