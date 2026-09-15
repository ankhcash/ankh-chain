/**
 * FrameQuality
 *
 * Measures whether a submitted frame is good enough to enrol a person from.
 *
 * Why this matters more here than in KYC
 * --------------------------------------
 * A document check is 1:1 — one comparison, one decision, and a mediocre frame
 * costs you a retry. Enrolment here is 1:N against the whole register, so the
 * same mediocre frame is compared against every person already enrolled. A
 * blurred or badly-lit capture widens the genuine-pair distance distribution,
 * which is the distribution that has to stay clear of the impostor one for the
 * register to mean anything. Rejecting the frame costs the user four seconds.
 * Accepting it costs everybody a permanently weaker register entry.
 *
 * Determinism
 * -----------
 * Every metric below is plain arithmetic over the decoded RGB buffer and the
 * landmark array. No model, no randomness, no floating-point reduction whose
 * order depends on hardware. Two nodes handed the same bytes compute the same
 * numbers, which is what lets a peer reach the same accept/reject decision
 * rather than merely a similar one.
 *
 * The metrics
 * -----------
 *   interocular  distance in pixels between the eye centres. The honest measure
 *                of how much face the model actually got; a 1280x720 frame of
 *                someone standing across the room carries less face than a
 *                640x480 frame at arm's length.
 *   sharpness    variance of the Laplacian over the face crop. Falls off hard
 *                under motion blur and soft focus, which are what a hurried
 *                capture produces.
 *   brightness   mean luma of the face crop, plus the share of pixels pinned at
 *                0 or 255. Clipped pixels carry no information at all, and a
 *                face that is half blown out is half missing.
 *   yaw / roll   head pose from the landmarks. The recognition head is trained
 *                on roughly frontal faces; off-axis captures are a large part of
 *                real-world false rejection.
 */

const GenesisConfig = require('../core/GenesisConfig');

// Rec. 601 luma, integer weights so the result is identical everywhere.
function luma(r, g, b) {
  return (299 * r + 587 * g + 114 * b) / 1000;
}

/**
 * Variance of the 4-neighbour Laplacian over a rectangular crop.
 *
 * Sampled on a fixed stride rather than every pixel: the statistic is stable
 * well before exhaustive sampling, and the stride is a constant so it stays
 * deterministic.
 */
function laplacianVariance(rgb, width, height, box) {
  const x0 = Math.max(1, Math.floor(box.x));
  const y0 = Math.max(1, Math.floor(box.y));
  const x1 = Math.min(width - 2, Math.floor(box.x + box.width));
  const y1 = Math.min(height - 2, Math.floor(box.y + box.height));
  if (x1 <= x0 || y1 <= y0) return 0;

  const stride = Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / 96));
  const at = (x, y) => {
    const i = (y * width + x) * 3;
    return luma(rgb[i], rgb[i + 1], rgb[i + 2]);
  };

  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = y0; y <= y1; y += stride) {
    for (let x = x0; x <= x1; x += stride) {
      const lap = 4 * at(x, y) - at(x - 1, y) - at(x + 1, y) - at(x, y - 1) - at(x, y + 1);
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (n < 16) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** Mean luma over a crop, and the share of pixels pinned at either end. */
function exposure(rgb, width, height, box) {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(width - 1, Math.floor(box.x + box.width));
  const y1 = Math.min(height - 1, Math.floor(box.y + box.height));
  if (x1 <= x0 || y1 <= y0) return { mean: 0, clipped: 1 };

  const stride = Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / 96));
  let sum = 0;
  let clipped = 0;
  let n = 0;
  for (let y = y0; y <= y1; y += stride) {
    for (let x = x0; x <= x1; x += stride) {
      const i = (y * width + x) * 3;
      const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2];
      const l = luma(r, g, b);
      sum += l;
      if ((r <= 2 && g <= 2 && b <= 2) || (r >= 253 && g >= 253 && b >= 253)) clipped++;
      n++;
    }
  }
  return n === 0 ? { mean: 0, clipped: 1 } : { mean: sum / n, clipped: clipped / n };
}

/** Mean of a contiguous run of landmark points. */
function centroid(points, from, to) {
  let x = 0, y = 0;
  for (let i = from; i <= to; i++) { x += points[i].x; y += points[i].y; }
  const n = to - from + 1;
  return { x: x / n, y: y / n };
}

/**
 * Head pose from the 68-point landmark set.
 *
 * Yaw is read from how far the nose tip has slid toward one jaw edge: dead
 * centre is 0, a full profile approaches 1. Roll is the tilt of the eye line.
 * Both are approximations — a real solution would fit a 3-D model — but they
 * are monotone in the quantity that matters and cost nothing to compute.
 */
function pose(landmarks) {
  const leftEye = centroid(landmarks, 36, 41);
  const rightEye = centroid(landmarks, 42, 47);
  const nose = landmarks[30];
  const jawL = landmarks[0];
  const jawR = landmarks[16];

  const dl = Math.abs(nose.x - jawL.x);
  const dr = Math.abs(jawR.x - nose.x);
  const yaw = (dl + dr) > 0 ? Math.abs(dl - dr) / (dl + dr) : 1;

  const dx = rightEye.x - leftEye.x;
  const dy = rightEye.y - leftEye.y;
  const roll = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);

  const interocular = Math.sqrt(dx * dx + dy * dy);

  return { yaw, roll, interocular };
}

/**
 * Score one frame and say whether it is fit to enrol from.
 *
 * @returns {{passed, score, reason, metrics}} — `score` is a 0–1 summary for
 *          logging and for the review band; the pass/fail decision is made by
 *          the individual gates, not by the summary.
 */
function assess({ rgb, width, height, landmarks, box, detectionScore }) {
  const Q = GenesisConfig.BIOMETRIC.FRAME_QUALITY;
  const metrics = {
    detectionScore: Number(detectionScore) || 0,
    interocular: 0,
    yaw: 1,
    roll: 90,
    sharpness: 0,
    brightness: 0,
    clipped: 1
  };

  if (!Array.isArray(landmarks) || landmarks.length !== 68) {
    return fail('Your face could not be read in that frame — try again facing the camera.',
      'landmarks unavailable');
  }

  const p = pose(landmarks);
  metrics.interocular = p.interocular;
  metrics.yaw = p.yaw;
  metrics.roll = p.roll;

  // Crop around the face for the pixel statistics. Falls back to a box derived
  // from the landmarks when the detector's box is missing.
  let crop = box;
  if (!crop || !crop.width || !crop.height) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pt of landmarks) {
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
    }
    crop = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  metrics.sharpness = laplacianVariance(rgb, width, height, crop);
  const ex = exposure(rgb, width, height, crop);
  metrics.brightness = ex.mean;
  metrics.clipped = ex.clipped;

  // Two messages per failure, deliberately.
  //
  // `reason` is what the person is shown. It says what to DO and carries no
  // measurement and no threshold. Telling a submitter "sharpness 48 < 55" hands
  // an attacker the dial and its exact setting: they can tune a presentation
  // against the gate by reading the rejections, and every rejection is a free
  // oracle reading. `detail` keeps those numbers for the node's own log, where
  // they are needed to diagnose and to calibrate.
  const fail = (reason, detail) => ({ passed: false, reason, detail: detail || reason, score: 0, metrics });

  if (metrics.detectionScore < Q.DETECTION_SCORE_MIN) {
    return fail(
      'Your face was not clearly visible — face the camera directly in even light.',
      `detection score ${metrics.detectionScore.toFixed(2)} < ${Q.DETECTION_SCORE_MIN}`);
  }
  if (metrics.interocular < Q.INTEROCULAR_MIN_PX) {
    return fail(
      'Move closer to the camera so your face fills more of the frame.',
      `interocular ${metrics.interocular.toFixed(0)}px < ${Q.INTEROCULAR_MIN_PX}`);
  }
  if (metrics.yaw > Q.YAW_MAX) {
    return fail(
      'Face the camera directly — your head was turned too far to one side.',
      `yaw ${metrics.yaw.toFixed(2)} > ${Q.YAW_MAX}`);
  }
  if (metrics.roll > Q.ROLL_MAX_DEG) {
    return fail(
      'Hold your head upright — it was tilted too far.',
      `roll ${metrics.roll.toFixed(0)} > ${Q.ROLL_MAX_DEG}`);
  }
  if (metrics.sharpness < Q.SHARPNESS_MIN) {
    return fail(
      'The image was blurred — hold the camera steady and let it focus.',
      `sharpness ${metrics.sharpness.toFixed(0)} < ${Q.SHARPNESS_MIN}`);
  }
  if (metrics.brightness < Q.BRIGHTNESS_MIN || metrics.brightness > Q.BRIGHTNESS_MAX) {
    return fail(
      'The lighting was too dark or too bright — face an even light source.',
      `brightness ${metrics.brightness.toFixed(0)} outside ${Q.BRIGHTNESS_MIN}-${Q.BRIGHTNESS_MAX}`);
  }
  if (metrics.clipped > Q.CLIPPED_MAX) {
    return fail(
      'Part of your face was lost to glare or shadow — avoid backlighting.',
      `clipped ${(metrics.clipped * 100).toFixed(0)}%`);
  }

  // Summary score: each gate contributes how far past its own floor the frame
  // got, capped at 1. Used for ranking and for the review band, never as a gate.
  const norm = (v, lo, hi) => Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  const score = Math.min(1, (
    norm(metrics.detectionScore, Q.DETECTION_SCORE_MIN, 1) * 0.2 +
    norm(metrics.interocular, Q.INTEROCULAR_MIN_PX, Q.INTEROCULAR_MIN_PX * 3) * 0.2 +
    norm(metrics.sharpness, Q.SHARPNESS_MIN, Q.SHARPNESS_MIN * 6) * 0.25 +
    (1 - norm(metrics.yaw, 0, Q.YAW_MAX)) * 0.15 +
    (1 - norm(metrics.roll, 0, Q.ROLL_MAX_DEG)) * 0.1 +
    (1 - norm(metrics.clipped, 0, Q.CLIPPED_MAX)) * 0.1
  ));

  return { passed: true, score: parseFloat(score.toFixed(4)), metrics };
}

module.exports = { assess, pose, laplacianVariance, exposure };
