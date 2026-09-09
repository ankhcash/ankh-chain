/**
 * ServerFaceVerifier
 *
 * Re-derives a face descriptor server-side from the submitted image.
 *
 * Why this exists
 * ---------------
 * Every biometric signal the node judged previously — the 128-d descriptor, the
 * liveness scores, the estimated age — was computed in the browser and posted as
 * JSON. Nothing bound any of it to a real camera, so a hand-written HTTP request
 * carrying a synthetic descriptor and a plausible liveness sequence could mint a
 * verified identity. Descriptor-shape validation raises the bar but cannot close
 * it: an attacker who mimics the statistics still passes.
 *
 * The only durable fix is for the node to compute the descriptor itself from the
 * submitted image and ignore whatever the client claimed. That is what this does.
 *
 * Deployment
 * ----------
 * Requires @vladmandic/face-api plus a tfjs backend, and roughly 200–300 MB of
 * additional RSS once the models are resident. It is therefore opt-in via
 * ANKH_SERVER_SIDE_FACE=1 rather than on by default, so a node that has not been
 * provisioned for it keeps running instead of crash-looping on a missing module.
 * `available()` reports whether the stack actually loaded.
 */

const path = require('path');
const fs = require('fs');

const DESCRIPTOR_DIMS = 128;

class ServerFaceVerifier {
  constructor(options = {}) {
    this.modelPath = options.modelPath || ServerFaceVerifier.defaultModelPath();
    this.faceapi = null;
    this.tf = null;
    this.ready = false;
    this.loadError = null;
    this._loadPromise = null;
    this.detectorOpts = null;
  }

  /** Models ship inside the face-api package; fall back to a local ./models dir. */
  static defaultModelPath() {
    const candidates = [
      path.join(__dirname, '../../../node_modules/@vladmandic/face-api/model'),
      path.join(__dirname, '../../node_modules/@vladmandic/face-api/model'),
      path.join(__dirname, '../../../models'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return candidates[0];
  }

  /**
   * Lazily load tfjs + face-api + weights. Never throws: a failure is recorded
   * and reported through `available()` so the caller can decide what to do.
   */
  async init() {
    if (this.ready || this.loadError) return this.ready;
    if (this._loadPromise) return this._loadPromise;

    this._loadPromise = (async () => {
      try {
        // Prefer the native backend; fall back to pure-JS if it is not built.
        try {
          this.tf = require('@tensorflow/tfjs-node');
        } catch {
          this.tf = require('@tensorflow/tfjs');
        }
        this.faceapi = require('@vladmandic/face-api');

        if (!fs.existsSync(this.modelPath)) {
          throw new Error(`model directory not found: ${this.modelPath}`);
        }

        await this.faceapi.nets.tinyFaceDetector.loadFromDisk(this.modelPath);
        await this.faceapi.nets.faceLandmark68Net.loadFromDisk(this.modelPath);
        await this.faceapi.nets.faceRecognitionNet.loadFromDisk(this.modelPath);
        await this.faceapi.nets.ageGenderNet.loadFromDisk(this.modelPath);

        this.detectorOpts = new this.faceapi.TinyFaceDetectorOptions({
          inputSize: 320,
          scoreThreshold: 0.5
        });

        this.ready = true;
        console.log(`[ServerFaceVerifier] Models loaded from ${this.modelPath} — server-side face verification ACTIVE`);
        return true;
      } catch (err) {
        this.loadError = err.message;
        console.warn(
          `[ServerFaceVerifier] Server-side face verification unavailable: ${err.message}. ` +
          `Install @vladmandic/face-api and @tensorflow/tfjs-node in ankh_chain to enable it.`
        );
        return false;
      } finally {
        this._loadPromise = null;
      }
    })();

    return this._loadPromise;
  }

  available() {
    return this.ready;
  }

  /** Decode a data: URI or bare base64 image into a tensor. */
  _decodeImage(image) {
    if (typeof image !== 'string' || image.length === 0) {
      throw new Error('no image supplied');
    }
    const comma = image.indexOf(',');
    const b64 = image.startsWith('data:') && comma !== -1 ? image.slice(comma + 1) : image;
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 1024) throw new Error('image too small to contain a face');
    if (buf.length > 8 * 1024 * 1024) throw new Error('image exceeds 8 MB limit');
    return this.tf.node
      ? this.tf.node.decodeImage(buf, 3)
      : this.faceapi.tf.node.decodeImage(buf, 3);
  }

  /**
   * Compute the descriptor for the single face in `image`.
   * @returns {{descriptor: number[], age: number, genderProbability: number,
   *            detectionScore: number}}
   */
  async analyze(image) {
    if (!this.ready) throw new Error('server-side face verification not initialised');

    let tensor = null;
    try {
      tensor = this._decodeImage(image);

      const detections = await this.faceapi
        .detectAllFaces(tensor, this.detectorOpts)
        .withFaceLandmarks()
        .withFaceDescriptors()
        .withAgeAndGender();

      if (!detections || detections.length === 0) {
        throw new Error('no face detected in the submitted image');
      }
      if (detections.length > 1) {
        throw new Error(`${detections.length} faces detected — exactly one required`);
      }

      const d = detections[0];
      const descriptor = Array.from(d.descriptor);
      if (descriptor.length !== DESCRIPTOR_DIMS) {
        throw new Error('descriptor extraction produced an unexpected shape');
      }

      return {
        descriptor,
        age: d.age,
        genderProbability: d.genderProbability,
        detectionScore: d.detection?.score ?? 0
      };
    } finally {
      if (tensor && typeof tensor.dispose === 'function') tensor.dispose();
    }
  }

  static euclidean(a, b) {
    let sum = 0;
    for (let i = 0; i < DESCRIPTOR_DIMS; i++) {
      const d = a[i] - b[i];
      sum += d * d;
    }
    return Math.sqrt(sum);
  }
}

module.exports = ServerFaceVerifier;
