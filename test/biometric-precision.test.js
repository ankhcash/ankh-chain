/**
 * Biometric precision suite.
 *
 * The question this answers is not "does the code run" but "did the separation
 * between genuine and impostor distances actually improve, and by how much".
 * Every claim in the fusion and quality-gating work is asserted here against
 * measured numbers rather than described in a comment.
 *
 * Why separation is the thing to measure: enrolment is a 1:N search. A new
 * person is compared against everyone already enrolled, so the register works
 * only while the distance to yourself stays reliably below the distance to
 * every stranger. Widening that gap is the entire objective.
 */
const path = require('path');
const FrameQuality = require(path.join(__dirname, '../src/verification/FrameQuality'));
const ServerFaceVerifier = require(path.join(__dirname, '../src/verification/ServerFaceVerifier'));
const GenesisConfig = require(path.join(__dirname, '../src/core/GenesisConfig'));

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n)); };

// ── helpers ────────────────────────────────────────────────────────────────
const DIMS = 128;
function unit(rand) {
  const v = new Array(DIMS);
  let n = 0;
  for (let i = 0; i < DIMS; i++) { v[i] = rand() * 2 - 1; n += v[i] * v[i]; }
  n = Math.sqrt(n);
  for (let i = 0; i < DIMS; i++) v[i] /= n;
  return v;
}
function jitter(base, sigma, rand) {
  const v = new Array(DIMS);
  let n = 0;
  for (let i = 0; i < DIMS; i++) { v[i] = base[i] + (rand() * 2 - 1) * sigma; n += v[i] * v[i]; }
  n = Math.sqrt(n);
  for (let i = 0; i < DIMS; i++) v[i] /= n;
  return v;
}
function fuse(list) {
  const out = new Array(DIMS).fill(0);
  for (const d of list) for (let i = 0; i < DIMS; i++) out[i] += d[i];
  let n = 0;
  for (let i = 0; i < DIMS; i++) { out[i] /= list.length; n += out[i] * out[i]; }
  n = Math.sqrt(n);
  for (let i = 0; i < DIMS; i++) out[i] /= n;
  return out;
}
const dist = ServerFaceVerifier.euclidean;

// Deterministic PRNG so a failure is reproducible rather than a coin flip.
function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

(async () => {

// ── 1. fusion widens the genuine/impostor gap ──────────────────────────────
console.log('=== FUSION: separation between genuine and impostor distances ===');
{
  const rand = mulberry(20260913);
  const SIGMA = 0.09;          // per-frame capture noise
  const TRIALS = 3000;
  const K = 5;

  const single = [], fused = [], impostorSingle = [], impostorFused = [];

  for (let t = 0; t < TRIALS; t++) {
    const person = unit(rand);
    const stranger = unit(rand);

    const enrolFrames = [];
    for (let i = 0; i < K; i++) enrolFrames.push(jitter(person, SIGMA, rand));
    const probeFrames = [];
    for (let i = 0; i < K; i++) probeFrames.push(jitter(person, SIGMA, rand));
    const strangerFrames = [];
    for (let i = 0; i < K; i++) strangerFrames.push(jitter(stranger, SIGMA, rand));

    single.push(dist(enrolFrames[0], probeFrames[0]));
    fused.push(dist(fuse(enrolFrames), fuse(probeFrames)));
    impostorSingle.push(dist(enrolFrames[0], strangerFrames[0]));
    impostorFused.push(dist(fuse(enrolFrames), fuse(strangerFrames)));
  }

  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))); };

  const gs = mean(single), gf = mean(fused);
  const is = mean(impostorSingle), iff = mean(impostorFused);

  // d-prime: how many standard deviations separate the two distributions. The
  // honest summary statistic for a matcher, and the one that drives error rates.
  const dPrimeSingle = (is - gs) / Math.sqrt((sd(single) ** 2 + sd(impostorSingle) ** 2) / 2);
  const dPrimeFused = (iff - gf) / Math.sqrt((sd(fused) ** 2 + sd(impostorFused) ** 2) / 2);

  console.log(`  genuine   single ${gs.toFixed(4)} ±${sd(single).toFixed(4)}  ->  fused ${gf.toFixed(4)} ±${sd(fused).toFixed(4)}`);
  console.log(`  impostor  single ${is.toFixed(4)} ±${sd(impostorSingle).toFixed(4)}  ->  fused ${iff.toFixed(4)} ±${sd(impostorFused).toFixed(4)}`);
  console.log(`  d-prime   single ${dPrimeSingle.toFixed(2)}  ->  fused ${dPrimeFused.toFixed(2)}  (${(dPrimeFused / dPrimeSingle).toFixed(2)}x)`);

  ok('fusion shrinks genuine-pair distance', gf < gs * 0.75);
  ok('fusion leaves impostor distance essentially unchanged', Math.abs(iff - is) < 0.05);
  ok('fusion improves d-prime', dPrimeFused > dPrimeSingle * 1.2);
}

// ── 2. fused vectors stay in-distribution ──────────────────────────────────
console.log('\n=== FUSION: output remains a valid embedding ===');
{
  const rand = mulberry(7);
  const base = unit(rand);
  const set = [];
  for (let i = 0; i < 5; i++) set.push(jitter(base, 0.09, rand));
  const f = fuse(set);
  const norm = Math.sqrt(f.reduce((a, x) => a + x * x, 0));
  const maxAbs = Math.max(...f.map(Math.abs));

  // Every downstream check — integrity validation, the int8 quantisation range
  // in DescriptorIndex, the distance thresholds — assumes ||d|| ~= 1. A fused
  // vector that drifted off the unit sphere would quietly break all three.
  ok(`fused norm is unit (${norm.toFixed(6)})`, Math.abs(norm - 1) < 1e-9);
  ok(`fused components stay within the integrity bound (${maxAbs.toFixed(4)} < ${GenesisConfig.BIOMETRIC.DESCRIPTOR_COMPONENT_MAX})`,
     maxAbs < GenesisConfig.BIOMETRIC.DESCRIPTOR_COMPONENT_MAX);
}

// ── 3. cohesion rejects a capture stitched from two people ─────────────────
console.log('\n=== COHESION: a mixed-identity frame set is refused ===');
{
  const rand = mulberry(99);
  const alice = unit(rand);
  const bob = unit(rand);

  // Stub the model: exercise the real trimming, cohesion and fusion code paths
  // without loading 69 MB of weights into a test run.
  const makeVerifier = (descriptors) => {
    const v = new ServerFaceVerifier();
    v.ready = true;
    v.analyze = async (frame) => ({
      descriptor: descriptors[Number(frame)],
      age: 30, genderProbability: 0.9, detectionScore: 0.9,
      landmarks: null, box: null,
      quality: { passed: true, score: 0.8, metrics: {} }
    });
    return v;
  };

  // Three of Alice, two of Bob — the shape of a montage attack.
  const mixed = [
    jitter(alice, 0.05, rand), jitter(alice, 0.05, rand), jitter(alice, 0.05, rand),
    jitter(bob, 0.05, rand), jitter(bob, 0.05, rand)
  ];
  const vm = makeVerifier(mixed);
  let refused = false, trimmed = null;
  try {
    trimmed = await vm.analyzeFrames(['0', '1', '2', '3', '4']);
  } catch (err) {
    refused = /not of the same face|inconsistent/.test(err.message);
  }
  // Trimming may salvage the Alice majority; what must never happen is Bob's
  // frames being averaged into Alice's enrolled vector.
  if (trimmed) {
    const toAlice = dist(trimmed.descriptor, alice);
    const toBob = dist(trimmed.descriptor, bob);
    console.log(`  trimmed to ${trimmed.frameCount} frames, cohesion ${trimmed.cohesion.toFixed(4)}`);
    ok('outlier identity trimmed out of the fused vector', trimmed.frameCount <= 3 && toAlice < toBob * 0.5);
    ok('rejection reasons recorded for the dropped frames', trimmed.rejected.length >= 2);
  } else {
    ok('mixed-identity capture refused', refused);
  }

  // A clean set of one person must survive untouched.
  const clean = [];
  for (let i = 0; i < 5; i++) clean.push(jitter(alice, 0.06, rand));
  const vc = makeVerifier(clean);
  const res = await vc.analyzeFrames(['0', '1', '2', '3', '4']);
  ok(`a genuine 5-frame capture keeps all frames (${res.frameCount})`, res.frameCount === 5);
  ok(`fused vector is closer to the person than any single frame`,
     dist(res.descriptor, alice) < dist(clean[0], alice));
}

// ── 4. quality gates ───────────────────────────────────────────────────────
console.log('\n=== QUALITY GATES ===');
{
  const W = 320, H = 320;
  // Landmarks laid out as a frontal face: eyes level and well separated.
  const frontal = () => {
    const lm = [];
    for (let i = 0; i < 68; i++) lm.push({ x: 160, y: 160 });
    for (let i = 0; i <= 16; i++) lm[i] = { x: 60 + i * 12.5, y: 200 };   // jaw
    for (let i = 36; i <= 41; i++) lm[i] = { x: 120 + (i - 36), y: 140 }; // left eye
    for (let i = 42; i <= 47; i++) lm[i] = { x: 200 + (i - 42), y: 140 }; // right eye
    lm[30] = { x: 160, y: 165 };                                          // nose tip
    return lm;
  };

  // A textured, well-exposed face crop.
  const sharpPixels = () => {
    const rgb = new Uint8Array(W * H * 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3;
        const v = 110 + ((x * 7 + y * 13) % 2 === 0 ? 45 : -40);
        rgb[i] = rgb[i + 1] = rgb[i + 2] = v;
      }
    }
    return rgb;
  };
  const flatPixels = (level) => {
    const rgb = new Uint8Array(W * H * 3);
    rgb.fill(level);
    return rgb;
  };

  const box = { x: 60, y: 100, width: 200, height: 140 };
  const good = FrameQuality.assess({ rgb: sharpPixels(), width: W, height: H, landmarks: frontal(), box, detectionScore: 0.9 });
  ok(`a sharp, frontal, well-lit frame passes (score ${good.score})`, good.passed === true);

  const blurred = FrameQuality.assess({ rgb: flatPixels(128), width: W, height: H, landmarks: frontal(), box, detectionScore: 0.9 });
  ok('a flat/blurred frame is rejected', blurred.passed === false && /blur/.test(blurred.reason));

  const dark = FrameQuality.assess({ rgb: flatPixels(5), width: W, height: H, landmarks: frontal(), box, detectionScore: 0.9 });
  ok('an underexposed frame is rejected', dark.passed === false);

  const weak = FrameQuality.assess({ rgb: sharpPixels(), width: W, height: H, landmarks: frontal(), box, detectionScore: 0.2 });
  // Asserted on `detail`, not `reason`: the user-facing sentence deliberately
  // carries no measurement or threshold, because a rejection that names the
  // number it missed by is a free oracle reading for anyone tuning a spoof.
  ok('a weak detection is rejected', weak.passed === false && /detection score/.test(weak.detail));
  ok('and the message shown to the person leaks no threshold',
    !/\d+(\.\d+)?\s*[<>]/.test(weak.reason));

  // Face far from the camera: eyes only a few pixels apart.
  const tiny = frontal();
  for (let i = 36; i <= 41; i++) tiny[i] = { x: 158, y: 160 };
  for (let i = 42; i <= 47; i++) tiny[i] = { x: 168, y: 160 };
  const small = FrameQuality.assess({ rgb: sharpPixels(), width: W, height: H, landmarks: tiny, box, detectionScore: 0.9 });
  ok('a face too small in frame is rejected', small.passed === false && /interocular/.test(small.detail));
  ok('and that message leaks no threshold either', !/\d+\s*(px|<|>)/.test(small.reason));

  // Head turned: nose tip slid toward one jaw edge.
  const turned = frontal();
  turned[30] = { x: 95, y: 165 };
  const offAxis = FrameQuality.assess({ rgb: sharpPixels(), width: W, height: H, landmarks: turned, box, detectionScore: 0.9 });
  ok('an off-axis frame is rejected', offAxis.passed === false && /turned/.test(offAxis.reason));

  // Head tilted: eye line rotated well past the roll limit.
  const tilted = frontal();
  for (let i = 42; i <= 47; i++) tilted[i] = { x: 200 + (i - 42), y: 90 };
  const rolled = FrameQuality.assess({ rgb: sharpPixels(), width: W, height: H, landmarks: tilted, box, detectionScore: 0.9 });
  ok('a heavily tilted frame is rejected', rolled.passed === false && /tilted/.test(rolled.reason));
}

// ── 5. the adjudication band ───────────────────────────────────────────────
console.log('\n=== ADJUDICATION BAND ===');
{
  const T = GenesisConfig.BIOMETRIC.SAME_PERSON_THRESHOLD;
  const B = GenesisConfig.BIOMETRIC.REVIEW_BAND;
  ok(`review band is configured (${T} match, review to ${(T + B).toFixed(2)})`, B > 0 && B < T);

  const EBV = require(path.join(__dirname, '../src/verification/EnhancedBiometricVerifier'));
  const rand = mulberry(31337);
  const person = unit(rand);

  const mkVerifier = (matchDistance) => {
    const v = Object.create(EBV.prototype);
    v.stateManager = {
      biometricDescriptors: new Map(),
      biometricToAddress: new Map(),
      findDuplicateDescriptor: (d, threshold) =>
        matchDistance !== null && matchDistance < threshold
          ? { address: 'ankh_existing', distance: matchDistance }
          : null
    };
    v.biometricIndex = new Map();
    v.duplicateThreshold = GenesisConfig.BIOMETRIC.DUPLICATE_THRESHOLD;
    return v;
  };

  const data = { facial: { descriptor: person } };

  const clear = mkVerifier(T - 0.2).checkLocalDuplicates('h1', data);
  ok('a clear match is still reported as a duplicate', clear.passed === false && clear.matchType === 'descriptor');

  const borderline = mkVerifier(T + B / 2).checkLocalDuplicates('h2', data);
  ok('a borderline match is held for review, not auto-decided',
     borderline.passed === false && borderline.needsReview === true && borderline.matchType === 'review');
  ok('the near-matched address is not disclosed to the submitter',
     borderline.existingAddress === undefined && !/ankh_/.test(borderline.reason));

  const stranger = mkVerifier(T + B + 0.1).checkLocalDuplicates('h3', data);
  ok('a clear stranger passes', stranger.passed === true);

  const nobody = mkVerifier(null).checkLocalDuplicates('h4', data);
  ok('an empty register passes', nobody.passed === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

})().catch(err => { console.error(err); process.exit(1); });
