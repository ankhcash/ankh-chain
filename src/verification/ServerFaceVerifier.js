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
const FrameQuality = require('./FrameQuality');
const GenesisConfig = require('../core/GenesisConfig');

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
        // WASM backend rather than @tensorflow/tfjs-node: no native build, and
        // measured on the deployment box it loads the models in ~340 ms for
        // ~69 MB RSS, which every node can afford. Determinism was verified
        // before choosing this: identical input gives bit-identical descriptors
        // on the same backend, and wasm-vs-cpu differ by 7.5e-7 Euclidean —
        // roughly six orders of magnitude below the 0.6 same-person threshold,
        // so independent nodes reach the same verdict.
        this.tf = require('@tensorflow/tfjs');
        try {
          const wasmBackend = require('@tensorflow/tfjs-backend-wasm');
          wasmBackend.setWasmPaths(
            path.join(path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm/package.json')), 'dist/')
          );
          await this.tf.setBackend('wasm');
        } catch {
          await this.tf.setBackend('cpu');   // slower, still deterministic enough
        }
        await this.tf.ready();

        // The package's default entry hard-requires @tensorflow/tfjs-node.
        // Load the node-wasm build directly so no native module is needed.
        try {
          this.faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
        } catch {
          this.faceapi = require('@vladmandic/face-api');
        }

        if (!fs.existsSync(this.modelPath)) {
          throw new Error(`model directory not found: ${this.modelPath}`);
        }

        await this.faceapi.nets.tinyFaceDetector.loadFromDisk(this.modelPath);
        await this.faceapi.nets.faceLandmark68Net.loadFromDisk(this.modelPath);
        await this.faceapi.nets.faceRecognitionNet.loadFromDisk(this.modelPath);
        await this.faceapi.nets.ageGenderNet.loadFromDisk(this.modelPath);

        // 512, not 320.
        //
        // Real captures were being refused as "face detected too weakly", one of
        // them at 0.59 against a floor of 0.60. The captures were not the
        // problem: at inputSize 320 the detector is starved of resolution and
        // scores low on faces it can see perfectly well. Measured over face-api's
        // own sample images:
        //
        //   320  median score 0.664   38% of faces fall below the 0.60 gate
        //   416  median score 0.779   17%
        //   512  median score 0.796    5%
        //
        // and the cost of the larger input is nil — 696 / 652 / 721 ms per frame
        // across the three sizes, because the recognition and age heads dominate
        // the pass, not the detector. So the fix is to stop starving the
        // measurement rather than to lower the bar it has to clear.
        this.detectorOpts = new this.faceapi.TinyFaceDetectorOptions({
          inputSize: 512,
          scoreThreshold: 0.5
        });

        this.ready = true;
        console.log(
          `[ServerFaceVerifier] Models loaded from ${this.modelPath} on "${this.tf.getBackend()}" — ` +
          `server-side face verification ACTIVE`
        );
        return true;
      } catch (err) {
        this.loadError = err.message;
        console.warn(
          `[ServerFaceVerifier] Server-side face verification unavailable: ${err.message}. ` +
          `Install @tensorflow/tfjs, @tensorflow/tfjs-backend-wasm, @vladmandic/face-api and jpeg-js.`
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

  /**
   * Decode a data: URI or bare base64 image into a tensor.
   *
   * tf.node.decodeImage is unavailable without the native backend, so JPEG and
   * PNG are decoded in pure JS. Decoding is exact, so every node turns the same
   * bytes into the same pixels — a prerequisite for them to agree on the
   * descriptor derived from it.
   */
  _decodeImage(image) {
    if (typeof image !== 'string' || image.length === 0) {
      throw new Error('no image supplied');
    }
    const comma = image.indexOf(',');
    const b64 = image.startsWith('data:') && comma !== -1 ? image.slice(comma + 1) : image;
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 1024) throw new Error('image too small to contain a face');
    if (buf.length > 8 * 1024 * 1024) throw new Error('image exceeds 8 MB limit');

    const isPng = buf[0] === 0x89 && buf[1] === 0x50;
    let width, height, data;

    if (isPng) {
      const { PNG } = require('pngjs');
      const png = PNG.sync.read(buf);
      width = png.width; height = png.height; data = png.data;   // RGBA
    } else {
      const jpeg = require('jpeg-js');
      const raw = jpeg.decode(buf, { useTArray: true });
      width = raw.width; height = raw.height; data = raw.data;   // RGBA
    }

    if (!width || !height) throw new Error('could not decode image');
    if (width < 64 || height < 64) throw new Error(`image too small (${width}x${height})`);
    if (width > 4096 || height > 4096) throw new Error(`image too large (${width}x${height})`);

    // Drop the alpha channel — the models take 3-channel input.
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      rgb[j] = data[i]; rgb[j + 1] = data[i + 1]; rgb[j + 2] = data[i + 2];
    }
    // The raw buffer is handed back alongside the tensor: the quality gates read
    // the same pixels the model reads, and decoding twice would be both slower
    // and a chance for the two views to disagree.
    return { tensor: this.tf.tensor3d(rgb, [height, width, 3], 'int32'), rgb, width, height };
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
      const decoded = this._decodeImage(image);
      tensor = decoded.tensor;

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

      const landmarks = d.landmarks?.positions?.map(pt => ({ x: pt.x, y: pt.y })) || null;
      const box = d.detection?.box
        ? { x: d.detection.box.x, y: d.detection.box.y, width: d.detection.box.width, height: d.detection.box.height }
        : null;

      // Quality is measured from the node's own pixels, not reported by the
      // client. A client that scores its own capture will always score it well.
      const quality = FrameQuality.assess({
        rgb: decoded.rgb,
        width: decoded.width,
        height: decoded.height,
        landmarks,
        box,
        detectionScore: d.detection?.score ?? 0
      });

      return {
        descriptor,
        age: d.age,
        genderProbability: d.genderProbability,
        detectionScore: d.detection?.score ?? 0,
        landmarks,
        box,
        quality
      };
    } finally {
      if (tensor && typeof tensor.dispose === 'function') tensor.dispose();
    }
  }

  /**
   * Analyse a set of frames of the same person and fuse them into one embedding.
   *
   * The pipeline, in the order that matters:
   *
   *   1. Every frame is analysed and quality-gated on its own. A frame that is
   *      blurred, badly lit, too small or too far off-axis is dropped with a
   *      reason, not silently averaged into the result where it would drag the
   *      fused vector away from the person's true centre.
   *   2. The survivors are checked against each other. A set assembled from more
   *      than one person — the obvious way to attack a fusion scheme — shows up
   *      as a large pairwise distance and is rejected. Outliers within a
   *      plausible set are trimmed rather than failing the whole capture.
   *   3. What is left is averaged and renormalised. That is the enrolled vector.
   *
   * Step 2 is why this is worth doing beyond accuracy: single-frame enrolment
   * has no way to notice that the descriptor and the image it came from are a
   * one-off. A cohesive set is a much harder thing to fabricate than one frame.
   *
   * @param {string[]} frames  data: URIs or bare base64, in capture order
   * @returns {{descriptor, accepted, rejected, cohesion, age, detectionScore, quality}}
   */
  async analyzeFrames(frames) {
    if (!this.ready) throw new Error('server-side face verification not initialised');
    if (!Array.isArray(frames) || frames.length === 0) throw new Error('no frames supplied');

    const C = GenesisConfig.BIOMETRIC;
    const capped = frames.slice(0, C.FRAMES_MAX);

    const accepted = [];
    const rejected = [];

    for (let i = 0; i < capped.length; i++) {
      let analysis;
      try {
        analysis = await this.analyze(capped[i]);
      } catch (err) {
        rejected.push({ index: i, reason: err.message });
        continue;
      }
      if (!analysis.quality.passed) {
        // reason is the sanitised, user-facing sentence; detail carries the
        // measurements and stays on this node.
        rejected.push({
          index: i,
          reason: analysis.quality.reason,
          detail: analysis.quality.detail || analysis.quality.reason,
          metrics: analysis.quality.metrics
        });
        continue;
      }
      accepted.push({ index: i, ...analysis });
    }

    if (rejected.length) {
      // Logged whenever anything was refused, not only when everything was.
      // A submission that loses four of six frames is the interesting case and
      // it was passing through silently.
      console.log('[FrameQuality] ' + accepted.length + ' accepted, ' + rejected.length +
        ' rejected — ' + rejected.map(r => `#${r.index}: ${r.detail || r.reason}`).join('; '));
    }

    if (accepted.length === 0) {
      const why = rejected.length ? rejected[0].reason : 'No usable frames were captured.';
      // Measurements go to the log, never to the submitter.
      console.log('[FrameQuality] all frames rejected — ' +
        rejected.map(r => `#${r.index}: ${r.detail}`).join('; '));
      const err = new Error(why);
      err.publicReason = why;
      throw err;
    }

    // ── Trim outliers, then judge what remains ──────────────────────────────
    // Each frame is scored by its mean distance to the others; the worst is
    // dropped while the set is still too spread out to be one person. Ties
    // break on index, so every node trims the same frame in the same order.
    const dist = (a, b) => ServerFaceVerifier.euclidean(a.descriptor, b.descriptor);
    let pool = accepted.slice();
    const spread = (set) => {
      let max = 0;
      for (let i = 0; i < set.length; i++) {
        for (let j = i + 1; j < set.length; j++) max = Math.max(max, dist(set[i], set[j]));
      }
      return max;
    };

    while (pool.length > C.FRAMES_MIN_ACCEPTED && spread(pool) > C.FRAME_COHESION_MAX) {
      let worst = 0;
      let worstMean = -1;
      for (let i = 0; i < pool.length; i++) {
        let sum = 0;
        for (let j = 0; j < pool.length; j++) if (i !== j) sum += dist(pool[i], pool[j]);
        const mean = sum / (pool.length - 1);
        if (mean > worstMean) { worstMean = mean; worst = i; }
      }
      rejected.push({
        index: pool[worst].index,
        reason: 'One frame did not match the rest of the capture.',
        detail: `frame inconsistent, mean distance ${worstMean.toFixed(3)}`
      });
      pool = pool.filter((_, i) => i !== worst);
    }

    const cohesion = pool.length > 1 ? spread(pool) : 0;
    if (cohesion > C.FRAME_COHESION_MAX) {
      throw new Error(
        `frames are not of the same face (spread ${cohesion.toFixed(3)} > ${C.FRAME_COHESION_MAX}) — ` +
        `capture rejected`
      );
    }

    // ── Fuse ────────────────────────────────────────────────────────────────
    // Summed in index order so the floating-point result is reproducible, then
    // averaged. Deliberately NOT renormalised.
    //
    // This used to divide through by the norm, to keep the fused vector "on the
    // unit sphere the recognition head emits onto". face-api does not emit onto
    // the unit sphere: measured across its own bundled sample faces, ||d|| runs
    // 1.3766 to 1.5054 with a mean of 1.4571. Renormalising did not keep the
    // vector in distribution, it moved it out of one, and two things broke:
    //
    //   The fused descriptor came out at ||d|| exactly 1.0000 and failed the
    //   node's own integrity floor of 1.05, so a node rejected the descriptor it
    //   had just derived itself and reported it as a configuration fault.
    //
    //   SAME_PERSON_THRESHOLD is 0.6 because that is face-api's calibrated
    //   distance on its native scale. Shrinking every vector by a factor of
    //   ~1.46 shrinks the distances between them by the same factor, so 0.6 on
    //   unit vectors behaves like ~0.87 on the real scale — far more permissive
    //   than intended, which is the direction that matches two different people
    //   to each other.
    //
    // Averaging alone already keeps the result in distribution: the mean of
    // several vectors of norm ~1.45 pointing nearly the same way has a norm just
    // under 1.45, which is exactly where a single frame's descriptor sits.
    pool.sort((a, b) => a.index - b.index);
    const fused = new Array(DESCRIPTOR_DIMS).fill(0);
    for (const f of pool) {
      for (let i = 0; i < DESCRIPTOR_DIMS; i++) fused[i] += f.descriptor[i];
    }
    for (let i = 0; i < DESCRIPTOR_DIMS; i++) fused[i] /= pool.length;

    // Age and detection score are taken as the median and the mean of the
    // accepted frames — the median because age estimates are noisy enough that
    // one bad frame should not move the answer.
    const ages = pool.map(f => f.age).sort((a, b) => a - b);
    const age = ages.length % 2 ? ages[(ages.length - 1) / 2]
                                : (ages[ages.length / 2 - 1] + ages[ages.length / 2]) / 2;

    return {
      descriptor: fused,
      age,
      genderProbability: pool[0].genderProbability,
      detectionScore: pool.reduce((s, f) => s + f.detectionScore, 0) / pool.length,
      quality: pool.reduce((s, f) => s + f.quality.score, 0) / pool.length,
      accepted: pool.map(f => ({ index: f.index, score: f.quality.score, metrics: f.quality.metrics })),
      rejected,
      cohesion,
      frameCount: pool.length
    };
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
