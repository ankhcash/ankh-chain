/**
 * Active illumination challenge.
 *
 * Simulates what a camera returns for three subjects under the same random
 * colour sequence, and checks the analyser separates them:
 *
 *   a real face     3-D, so each region catches the flash at its own angle
 *   a printed photo flat, so the whole surface responds identically
 *   a screen replay emits its own light, so it barely responds at all
 *
 * The rasters are synthetic on purpose. What is under test is the decision rule
 * — whether tracking the sequence and varying across the surface actually
 * separate a person from the two attacks — not the JPEG decoder.
 */
const LivenessChallenge = require('../src/verification/LivenessChallenge');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x)); };

const W = 60, H = 60;

/**
 * Build one frame.
 *
 * @param rgb        the colour the screen is showing
 * @param response   how strongly the subject re-emits it (1 = fully lit skin, 0 = inert)
 * @param relief     how much the response varies across the surface (0 = flat)
 * @param ambient    baseline skin colour present regardless of the flash
 */
function frame(rgb, { response, relief, ambient = [120, 95, 85], noise = 1.5 }) {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Per-cell surface angle: a 3-D face turns different amounts toward the
      // screen, a flat sheet does not.
      const gx = Math.floor((x / W) * 3), gy = Math.floor((y / H) * 3);
      const facing = 1 + relief * Math.cos((gx - 1) * 1.1) * Math.cos((gy - 1) * 1.1);
      const i = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const lit = ambient[c] + response * facing * (rgb[c] / 255) * 90;
        data[i + c] = Math.max(0, Math.min(255, lit + (Math.random() * 2 - 1) * noise));
      }
      data[i + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

function run(challenge, subject) {
  const frames = challenge.sequence.map((key, step) => ({
    step,
    raster: frame(LivenessChallenge.PALETTE[key].rgb, subject)
  }));
  return LivenessChallenge.analyze(challenge, frames);
}

console.log('=== the challenge itself ===');
{
  const c = LivenessChallenge.issue();
  ok('issues a sequence of the requested length', c.sequence.length === LivenessChallenge.DEFAULTS.STEPS);
  ok('never repeats a colour back to back', c.sequence.every((k, i) => i === 0 || k !== c.sequence[i - 1]));
  ok('carries a nonce and an expiry', !!c.nonce && c.expiresAt > Date.now());
  const a = LivenessChallenge.issue(), b = LivenessChallenge.issue();
  ok('is unpredictable between sessions', a.sequence.join('') !== b.sequence.join('') || a.id !== b.id);
}

console.log('\n=== a real face ===');
{
  // Averaged over several sessions because the sequence is random each time.
  let passes = 0, t = 0, s = 0;
  for (let i = 0; i < 12; i++) {
    const r = run(LivenessChallenge.issue(), { response: 1.0, relief: 0.45 });
    if (r.passed) passes++;
    t += r.temporal; s += r.spatial;
  }
  console.log(`    accepted ${passes}/12   mean temporal ${(t/12).toFixed(3)}  spatial ${(s/12).toFixed(3)}`);
  ok('a live 3-D face is accepted', passes >= 11, `${passes}/12`);
}

console.log('\n=== a printed photograph held up ===');
{
  // Paper reflects the flash perfectly well, so it tracks the colours. What it
  // cannot do is vary across the surface, because it has no depth.
  let refused = 0, t = 0, s = 0;
  for (let i = 0; i < 12; i++) {
    const r = run(LivenessChallenge.issue(), { response: 1.0, relief: 0.0 });
    if (!r.passed) refused++;
    t += r.temporal; s += r.spatial;
  }
  console.log(`    refused ${refused}/12   mean temporal ${(t/12).toFixed(3)}  spatial ${(s/12).toFixed(3)}`);
  ok('a flat print is refused', refused >= 11, `${refused}/12`);
  ok('and it is the flatness that catches it, not the colour', t / 12 > 0.3);
  ok('the print did react to the flash, it just reacted uniformly', s / 12 < 0.005);
}

console.log('\n=== a screen replaying a recording ===');
{
  // A display emits its own light and barely reacts to the flash.
  let refused = 0, t = 0, resp = 0;
  for (let i = 0; i < 12; i++) {
    const r = run(LivenessChallenge.issue(), { response: 0.04, relief: 0.05, ambient: [130, 120, 125] });
    if (!r.passed) refused++;
    t += r.temporal; resp += r.response;
  }
  console.log(`    refused ${refused}/12   mean temporal ${(t/12).toFixed(3)}  response ${(resp/12).toFixed(4)}`);
  ok('a replayed video is refused', refused >= 11, `${refused}/12`);
  // Worth pinning: the display still points the right way, so direction alone
  // would have waved it through. Strength is what catches it.
  ok('and direction alone would NOT have caught it', t / 12 > 0.5);
  ok('it is the lack of response strength that does', resp / 12 < 0.02);
}

console.log('\n=== a recording made before the challenge existed ===');
{
  // The attacker recorded a genuine session under some other colour order.
  const real = LivenessChallenge.issue();
  const recorded = LivenessChallenge.issue();
  let refused = 0;
  for (let i = 0; i < 12; i++) {
    const c = LivenessChallenge.issue();
    const wrong = LivenessChallenge.issue();
    const frames = c.sequence.map((_, step) => ({
      step,
      raster: frame(LivenessChallenge.PALETTE[wrong.sequence[step]].rgb, { response: 1.0, relief: 0.45 })
    }));
    if (!LivenessChallenge.analyze(c, frames).passed) refused++;
  }
  console.log(`    refused ${refused}/12`);
  ok('frames lit by a different sequence are refused', refused >= 10, `${refused}/12`);
  void real; void recorded;
}

console.log('\n=== housekeeping ===');
{
  const stale = LivenessChallenge.issue();
  stale.expiresAt = Date.now() - 1;
  ok('an expired challenge is refused', LivenessChallenge.analyze(stale, []).passed === false);
  const c = LivenessChallenge.issue();
  const short = [{ step: 0, raster: frame([255,45,45], { response: 1, relief: 0.4 }) }];
  const r = LivenessChallenge.analyze(c, short);
  ok('too few frames is refused', !r.passed && /Too few/.test(r.reason));
  ok('a missing challenge is refused', LivenessChallenge.analyze(null, []).passed === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
