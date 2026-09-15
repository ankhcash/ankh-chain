/**
 * LivenessChallenge — active illumination presentation-attack detection.
 *
 * The problem this solves
 * ----------------------
 * Everything the client reports about liveness is a claim. Server-side
 * inference proves "this image contains this face"; it does not prove the image
 * came from a camera pointed at a living person just now. An attacker does not
 * fight the recognition model — they bypass the camera, feeding a virtual
 * camera from a recording or a generated video. That passes server-side
 * inference perfectly, and a central verification service would not help,
 * because it would be looking at the same submitted pixels.
 *
 * How this closes it
 * ------------------
 * The node picks a random colour sequence *after* the session opens and the
 * client's screen flashes it while capturing. Two independent things are then
 * measured on the returned frames:
 *
 *   Temporal   Does the light falling on the face track the sequence the node
 *              chose? Nothing recorded earlier can, because the sequence did
 *              not exist when it was recorded. A replayed video also fails
 *              outright: a display emits its own light and barely responds to
 *              illumination falling on it.
 *
 *   Spatial    Do different parts of the face respond differently? A real face
 *              is a 3-D object — brow, nose and cheeks catch light at different
 *              angles, so the response varies across the surface. A printed
 *              photograph is flat and responds almost uniformly, which is what
 *              separates it from a person even though paper reflects the flash
 *              perfectly well.
 *
 * Measurements are taken as deviations from the session's own mean rather than
 * as absolute colours, so skin tone, ambient light and the camera's automatic
 * white balance divide out. What is left is how the surface reacted.
 *
 * Limits, stated plainly: this raises presentation attacks from "post some
 * JSON" to "defeat a per-session optical challenge in real time". It is not a
 * substitute for hardware attestation of the capture path, which is the only
 * thing that establishes the frames came from a real camera at all.
 */

'use strict';

const crypto = require('crypto');

// Saturated primaries, far apart in chroma so the response is easy to separate
// from noise. Black is included as a low-light step: its absence of response is
// as informative as a primary's presence.
const PALETTE = {
  R: { hex: '#ff2d2d', rgb: [255, 45, 45] },
  G: { hex: '#2dff2d', rgb: [45, 255, 45] },
  B: { hex: '#2d2dff', rgb: [45, 45, 255] },
  W: { hex: '#ffffff', rgb: [255, 255, 255] },
  K: { hex: '#101010', rgb: [16, 16, 16] }
};

/**
 * Thresholds.
 *
 * CALIBRATION, stated up front because the last gate that skipped this rejected
 * 100% of real faces for months: these numbers come from a simulation of how a
 * lit 3-D surface, a flat print and a self-illuminated display respond to the
 * flash — NOT from real captures. The separation they rest on is large and
 * structural rather than marginal:
 *
 *              response            spatial
 *   real face  0.051 - 0.145       0.040 - 0.046
 *   print      0.059 - 0.144       0.0004 - 0.001     <- flat, fails spatial
 *   display    0.003 - 0.006       0.009 - 0.038      <- inert, fails response
 *
 * so the thresholds sit in wide gaps, not on top of a distribution edge.
 *
 * FIRST REAL SESSIONS. Two captures from one live user, both from sessions whose
 * frames were too poor to enrol, so treat them as a worst case rather than as
 * typical:
 *
 *   temporal 0.857 / 0.667     response 0.0166 / 0.0439     spatial 0.165 / 0.277
 *
 * Spatial came back roughly five times stronger than the simulation predicted -
 * a real face has far more relief than the model gave it - so that threshold has
 * room to spare. Temporal and response came back weaker, which is what prompted
 * the longer hold: the camera had not settled when the frame was taken. These
 * are two samples from degraded captures and are not a calibration. ENFORCE
 * stays off until clean sessions say otherwise; the analyser records what it saw
 * and cannot turn anyone away.
 */
const DEFAULTS = {
  STEPS: 8,
  // Raised from 320 ms after the first real sessions came back with weak
  // temporal and response numbers. A webcam's auto-exposure is still hunting
  // that soon after the light changes, so the frame was being taken mid-
  // adjustment and the colour it recorded was a blend of two steps. The fix is
  // to give the sensor time to settle, not to lower the bar it has to clear.
  HOLD_MS: 450,
  TTL_MS: 120000,        // a challenge is useless after two minutes
  // Identification rate over the R/G/B steps. A genuine session names every one
  // correctly, so this allows one miss out of six for real-world noise. It is
  // also the security parameter: a replayed recording was lit by whatever
  // sequence was shown when it was made, so it has a (1/3)^6 chance of matching
  // this one -- about 1 in 729 per attempt, which the per-address cooldown and
  // rate limiter then have to hold down.
  TEMPORAL_MIN: 0.85,
  RESPONSE_MIN: 0.020,   // strength: did the surface react at all (displays do not)
  SPATIAL_MIN: 0.015,    // variation: did it react differently across itself (prints do not)
  MIN_FRAMES: 5,
  MIN_HUE_STEPS: 6     // R/G/B steps the sequence must contain to be scorable
};

class LivenessChallenge {
  /**
   * Mint a challenge. The sequence is random per session and never repeats a
   * colour twice in a row, so every step is a real transition to measure.
   */
  static issue(opts = {}) {
    const steps = opts.steps || DEFAULTS.STEPS;
    const keys = Object.keys(PALETTE);
    const HUES = ['R', 'G', 'B'];
    const seq = [];
    while (seq.length < steps) {
      const remaining = steps - seq.length;
      const huesSoFar = seq.filter(x => HUES.includes(x)).length;
      // Only R/G/B can be identified from the reflected colour, so the sequence
      // has to contain enough of them to score against. Once the remaining
      // slots are all that stand between us and MIN_HUE_STEPS, stop offering
      // the luminance-only colours.
      const mustBeHue = (DEFAULTS.MIN_HUE_STEPS - huesSoFar) >= remaining;
      const pool = mustBeHue ? HUES : keys;
      const k = pool[crypto.randomInt(pool.length)];
      if (seq.length && seq[seq.length - 1] === k) continue;
      // One dark step, so a display's self-emission has somewhere to show
      // itself, but never a mostly-dark sequence.
      if (k === 'K' && seq.filter(x => x === 'K').length >= 1) continue;
      seq.push(k);
    }
    const now = Date.now();
    return {
      id: crypto.randomBytes(16).toString('hex'),
      nonce: crypto.randomBytes(16).toString('hex'),
      sequence: seq,
      colors: seq.map(k => PALETTE[k].hex),
      holdMs: opts.holdMs || DEFAULTS.HOLD_MS,
      issuedAt: now,
      expiresAt: now + (opts.ttlMs || DEFAULTS.TTL_MS)
    };
  }

  /** Mean RGB of a rectangular region of a decoded RGBA raster. */
  static _meanRGB(raster, x0, y0, x1, y1) {
    const { width, data } = raster;
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      let i = (y * width + x0) * 4;
      for (let x = x0; x < x1; x++, i += 4) {
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
      }
    }
    return n ? [r / n, g / n, b / n] : [0, 0, 0];
  }

  /**
   * Chroma: colour with brightness divided out, then mean-centred.
   *
   * Exposure changes between frames — the camera reacts to the flash by
   * stopping down — so raw channel values move together and say nothing about
   * hue. Dividing by total intensity removes that, and centring leaves only
   * which channel is over-represented.
   */
  static _chroma(rgb) {
    const sum = rgb[0] + rgb[1] + rgb[2];
    if (sum < 1e-6) return [0, 0, 0];
    const n = rgb.map(v => v / sum);
    const m = (n[0] + n[1] + n[2]) / 3;
    return [n[0] - m, n[1] - m, n[2] - m];
  }

  static _sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  static _norm(v) { return Math.hypot(v[0], v[1], v[2]); }
  static _cos(a, b) {
    const na = this._norm(a), nb = this._norm(b);
    if (na < 1e-9 || nb < 1e-9) return 0;
    return (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (na * nb);
  }

  /**
   * Score a set of flash frames against the challenge that produced them.
   *
   * @param {object} challenge  as returned by issue()
   * @param {Array}  frames     [{ step, raster }] — raster is {width,height,data(RGBA)}
   * @param {object} [thresholds]
   */
  static analyze(challenge, frames, thresholds = {}) {
    const T = { ...DEFAULTS, ...thresholds };

    if (!challenge || !Array.isArray(challenge.sequence)) {
      return { passed: false, reason: 'No challenge supplied', temporal: 0, spatial: 0 };
    }
    if (Date.now() > challenge.expiresAt) {
      return { passed: false, reason: 'Challenge expired — please retry', temporal: 0, spatial: 0 };
    }
    if (!Array.isArray(frames) || frames.length < T.MIN_FRAMES) {
      return {
        passed: false,
        reason: `Too few illumination frames (${frames ? frames.length : 0}, need ${T.MIN_FRAMES})`,
        temporal: 0, spatial: 0
      };
    }

    // Per-frame measurements over the central region, where the face sits after
    // the capture crop, plus a 3x3 grid for the spatial test.
    const whole = [];
    const cells = [];
    for (const f of frames) {
      const R = f.raster;
      if (!R || !R.width || !R.height) continue;
      const x0 = Math.floor(R.width * 0.25), x1 = Math.floor(R.width * 0.75);
      const y0 = Math.floor(R.height * 0.2), y1 = Math.floor(R.height * 0.85);
      whole.push({ step: f.step, chroma: this._chroma(this._meanRGB(R, x0, y0, x1, y1)) });

      const gw = Math.floor((x1 - x0) / 3), gh = Math.floor((y1 - y0) / 3);
      const grid = [];
      for (let gy = 0; gy < 3; gy++) {
        for (let gx = 0; gx < 3; gx++) {
          const cx0 = x0 + gx * gw, cy0 = y0 + gy * gh;
          grid.push(this._chroma(this._meanRGB(R, cx0, cy0, cx0 + gw, cy0 + gh)));
        }
      }
      cells.push({ step: f.step, grid });
    }

    if (whole.length < T.MIN_FRAMES) {
      return { passed: false, reason: 'Illumination frames could not be decoded', temporal: 0, spatial: 0 };
    }

    // ── Temporal: does the face's chroma move the way the sequence asked? ──
    const sessionMean = [0, 1, 2].map(i => whole.reduce((a, w) => a + w.chroma[i], 0) / whole.length);
    const expectedMean = [0, 1, 2].map(i =>
      whole.reduce((a, w) => a + this._chroma(PALETTE[challenge.sequence[w.step]].rgb)[i], 0) / whole.length);

    // Scored as identification, not similarity: for each frame, which colour in
    // the palette does the observed light look most like? Then count how often
    // that is the colour actually shown.
    //
    // Averaging a cosine was too forgiving. Two random sequences share some
    // steps by chance — with a five-colour palette a wrong recording lines up
    // about a fifth of the time — and a handful of coincidental matches could
    // drag the mean over the line. Identification has no such slack: a genuine
    // session names nearly every colour correctly, and a recording made under
    // some other sequence lands near chance.
    // Only the true hues are identifiable. White and black are almost pure
    // luminance — their chroma is close to zero, so asking "which colour does
    // this look like?" of a white step is asking about a direction that barely
    // exists, and the answer is noise. Including them was pulling genuine
    // sessions down toward chance and lifting wrong ones up to meet them. They
    // still earn their place in the sequence: both drive the response
    // measurement, and the dark step is where a display's self-emission shows.
    const hueKeys = ['R', 'G', 'B'];
    let correct = 0, counted = 0, travel = 0;
    for (const w of whole) {
      const key = challenge.sequence[w.step];
      if (!key) continue;
      const observed = this._sub(w.chroma, sessionMean);
      travel += this._norm(observed);
      // A dark step carries no hue to identify; it contributes to response and
      // spatial only, so scoring it here would just add noise.
      if (!hueKeys.includes(key)) continue;

      let best = null, bestCos = -Infinity;
      for (const cand of hueKeys) {
        const dir = this._sub(this._chroma(PALETTE[cand].rgb), expectedMean);
        const c = this._cos(dir, observed);
        if (c > bestCos) { bestCos = c; best = cand; }
      }
      if (best === key) correct++;
      counted++;
    }
    const temporal = counted ? correct / counted : 0;

    // How *strongly* the surface answered, independent of direction.
    //
    // Direction alone is not enough. A display barely reacts to light falling on
    // it — it is emitting its own — but the little it does react still points
    // the right way, so cosine similarity alone scores a replayed video about as
    // well as a face. Magnitude is what separates a surface that was genuinely
    // lit by the screen from one that merely drifted in the right direction.
    const response = whole.length ? travel / whole.length : 0;

    // ── Spatial: does the response vary across the surface? ──
    // Per cell, how far its chroma travels across the session. A 3-D face gives
    // a spread of magnitudes; a flat print gives nearly the same everywhere.
    const cellTravel = [];
    for (let c = 0; c < 9; c++) {
      const series = cells.map(f => f.grid[c]).filter(Boolean);
      if (series.length < 2) continue;
      const mean = [0, 1, 2].map(i => series.reduce((a, s) => a + s[i], 0) / series.length);
      const travel = series.reduce((a, s) => a + this._norm(this._sub(s, mean)), 0) / series.length;
      cellTravel.push(travel);
    }
    let spatial = 0;
    if (cellTravel.length >= 4) {
      const m = cellTravel.reduce((a, v) => a + v, 0) / cellTravel.length;
      if (m > 1e-9) {
        const sd = Math.sqrt(cellTravel.reduce((a, v) => a + (v - m) ** 2, 0) / cellTravel.length);
        spatial = sd / m;   // relative spread, so overall brightness divides out
      }
    }

    // Three independent things have to hold, because each attack fails a
    // different one: a recording made earlier misses the direction, a display
    // misses the strength, a print misses the variation across the surface.
    const passed =
      temporal >= T.TEMPORAL_MIN &&
      response >= T.RESPONSE_MIN &&
      spatial  >= T.SPATIAL_MIN;

    let reason = null;
    if (!passed) {
      const bits = [];
      if (temporal < T.TEMPORAL_MIN) bits.push('the light on your face did not follow the on-screen colours');
      if (response < T.RESPONSE_MIN) bits.push('your face barely reacted to the screen light, as a display would');
      if (spatial  < T.SPATIAL_MIN)  bits.push('the surface responded flatly, as a printed photo would');
      reason =
        `Liveness challenge failed — ${bits.join('; ')}. ` +
        `Hold the device steady, let the screen light reach your face, and avoid strong backlighting.`;
    }
    return {
      passed,
      reason,
      temporal: Number(temporal.toFixed(4)),
      response: Number(response.toFixed(5)),
      spatial: Number(spatial.toFixed(4)),
      framesUsed: whole.length
    };
  }
}

LivenessChallenge.PALETTE = PALETTE;
LivenessChallenge.DEFAULTS = DEFAULTS;

module.exports = LivenessChallenge;
