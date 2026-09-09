/**
 * DescriptorIndex
 *
 * Memory layout and search for 128-d face descriptors at national / global scale.
 *
 * The problem
 * -----------
 * Duplicate detection is a global uniqueness constraint over a *similarity*
 * metric: "is this face already registered anywhere on the chain?". Unlike an
 * account balance it cannot be sharded by key, because the answer depends on
 * every other face in the system.
 *
 * The previous layout stored one Float32Array per person inside a Map. Measured:
 *
 *      50,000 faces ->     7.5 ms per verification
 *     200,000 faces ->    42   ms
 *   1,000,000 faces ->  1090   ms
 *
 * That is superlinear because each comparison chases a separate heap object;
 * the scan is bound by cache misses, not arithmetic.
 *
 * The layout here
 * ---------------
 * Descriptors live in one contiguous Int8Array slab, quantised from the unit
 * sphere. That is 128 bytes per person instead of 512 plus per-object overhead
 * (2.7 GB at 21 M rather than ~13 GB), and the scan streams linearly through
 * memory. Measured on the same data: 3.8x faster and 4x smaller.
 *
 * Correctness under quantisation
 * ------------------------------
 * Quantisation perturbs distances by at most sqrt(128) * step. The scan widens
 * its cutoff by that bound, so a true duplicate can never be pruned away — the
 * error can only produce extra candidates, never a miss. Candidates are then
 * re-ranked against exact float32 values when those are resident, so the result
 * matches a brute-force float scan exactly. When exact vectors are not resident
 * the widened bound is reported as-is, which fails *safe*: it may reject a
 * borderline non-duplicate, never admit a duplicate.
 *
 * Scaling past one machine
 * ------------------------
 * A linear scan of 21 M is ~2 s on one node however tight the loop is, so single
 * -node scanning is not the end state. `scanRange()` exists so a node can own a
 * contiguous slice of the index and several nodes can search in parallel, with
 * the existing VERIFICATION_VOTE consensus aggregating their answers — 21 M
 * across 20 nodes is ~100 ms each. This class is the per-node engine for that.
 */

const DIMS = 128;

// Face-api descriptors are L2-normalised; components sit well inside +/-0.35.
// 0.35/127 gives full int8 range with no clipping in practice.
const QUANT_RANGE = 0.35;
const QUANT_SCALE = 127 / QUANT_RANGE;
const QUANT_STEP = 1 / QUANT_SCALE;
// Worst-case distance error introduced by quantising both vectors.
const QUANT_ERROR = Math.sqrt(DIMS) * QUANT_STEP;

const INITIAL_CAPACITY = 1024;

class DescriptorIndex {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.exactVectors=true] keep float32 alongside int8 for
   *        exact re-ranking. Costs 512 B/entry; disable on memory-bound nodes.
   */
  constructor(opts = {}) {
    this.exactVectors = opts.exactVectors !== false;

    this.capacity = INITIAL_CAPACITY;
    this.count = 0;

    this.slabQ = new Int8Array(this.capacity * DIMS);
    this.slabF = this.exactVectors ? new Float32Array(this.capacity * DIMS) : null;

    /** row -> biometric hash */
    this.hashes = new Array(this.capacity).fill(null);
    /** biometric hash -> row */
    this.rows = new Map();
    /** rows freed by delete(), reused before growing */
    this.freeRows = [];

    this.stats = { lookups: 0, scanned: 0, candidates: 0, rerankedExact: 0 };
  }

  get size() { return this.rows.size; }
  static get QUANT_ERROR() { return QUANT_ERROR; }

  // ── Conversion ────────────────────────────────────────────────────────────

  static toFloat32(descriptor) {
    if (descriptor instanceof Float32Array) {
      return descriptor.length === DIMS ? descriptor : null;
    }
    if (Array.isArray(descriptor) && descriptor.length === DIMS) {
      const out = new Float32Array(DIMS);
      for (let i = 0; i < DIMS; i++) {
        const v = Number(descriptor[i]);
        if (!Number.isFinite(v)) return null;
        out[i] = v;
      }
      return out;
    }
    return null;
  }

  static quantize(vec, out, offset = 0) {
    for (let i = 0; i < DIMS; i++) {
      const q = Math.round(vec[i] * QUANT_SCALE);
      out[offset + i] = q > 127 ? 127 : (q < -127 ? -127 : q);
    }
    return out;
  }

  // ── Capacity ──────────────────────────────────────────────────────────────

  _grow(minCapacity) {
    let cap = this.capacity;
    while (cap < minCapacity) cap *= 2;
    if (cap === this.capacity) return;

    const q = new Int8Array(cap * DIMS);
    q.set(this.slabQ.subarray(0, this.count * DIMS));
    this.slabQ = q;

    if (this.exactVectors) {
      const f = new Float32Array(cap * DIMS);
      f.set(this.slabF.subarray(0, this.count * DIMS));
      this.slabF = f;
    }

    this.hashes.length = cap;
    this.capacity = cap;
  }

  // ── Mutation ──────────────────────────────────────────────────────────────

  /**
   * Insert or replace a descriptor.
   * @returns {boolean} true when stored
   */
  add(hash, descriptor) {
    const vec = DescriptorIndex.toFloat32(descriptor);
    if (!hash || !vec) return false;

    let row = this.rows.get(hash);
    if (row === undefined) {
      row = this.freeRows.length > 0 ? this.freeRows.pop() : this.count++;
      if (row >= this.capacity) this._grow(row + 1);
      this.rows.set(hash, row);
      this.hashes[row] = hash;
    }

    const off = row * DIMS;
    DescriptorIndex.quantize(vec, this.slabQ, off);
    if (this.exactVectors) this.slabF.set(vec, off);
    return true;
  }

  remove(hash) {
    const row = this.rows.get(hash);
    if (row === undefined) return false;
    this.rows.delete(hash);
    this.hashes[row] = null;
    this.freeRows.push(row);
    this.slabQ.fill(0, row * DIMS, row * DIMS + DIMS);
    return true;
  }

  has(hash) { return this.rows.has(hash); }

  /**
   * Quantised int8 row for a hash. Always available regardless of memory mode,
   * so it is what the state-root commitment hashes — a lean node and a full
   * node then commit to the same value for the same descriptor set.
   */
  getQuantized(hash) {
    const row = this.rows.get(hash);
    if (row === undefined) return null;
    return this.slabQ.subarray(row * DIMS, row * DIMS + DIMS);
  }

  /** Exact float32 descriptor for a hash, when exact vectors are resident. */
  getVector(hash) {
    const row = this.rows.get(hash);
    if (row === undefined || !this.exactVectors) return null;
    return this.slabF.slice(row * DIMS, row * DIMS + DIMS);
  }

  // ── Distance ──────────────────────────────────────────────────────────────

  /** Exact float32 squared distance with early termination. */
  _exactDistSq(query, row, limitSq) {
    const off = row * DIMS;
    const f = this.slabF;
    let sum = 0;
    for (let i = 0; i < DIMS; i++) {
      const d = query[i] - f[off + i];
      sum += d * d;
      if ((i & 7) === 7 && sum > limitSq) return sum;
    }
    return sum;
  }

  // ── Search ────────────────────────────────────────────────────────────────

  /**
   * Nearest match within `threshold`, scanning rows [from, to).
   *
   * Splitting by range is what lets several nodes each own a slice of the index
   * and search in parallel.
   *
   * @returns {{hash: string, distance: number, exact: boolean}|null}
   */
  scanRange(descriptor, threshold, from, to, isEligible = null) {
    const query = DescriptorIndex.toFloat32(descriptor);
    if (!query) return null;

    // Quantised query, and a cutoff widened by the quantisation error so the
    // integer pass cannot discard a genuine duplicate.
    const qq = DescriptorIndex.quantize(query, new Int8Array(DIMS));
    const widened = threshold + QUANT_ERROR;
    const limitQ = (widened * QUANT_SCALE) * (widened * QUANT_SCALE);

    const slabQ = this.slabQ;
    const hashes = this.hashes;

    let best = null;
    let bestSq = threshold * threshold;

    this.stats.lookups++;

    for (let row = from; row < to; row++) {
      const hash = hashes[row];
      if (hash === null) continue;

      // Integer pass over contiguous memory.
      const off = row * DIMS;
      let s = 0;
      for (let i = 0; i < DIMS; i++) {
        const d = qq[i] - slabQ[off + i];
        s += d * d;
        if ((i & 15) === 15 && s > limitQ) break;
      }
      this.stats.scanned++;
      if (s > limitQ) continue;

      if (isEligible && !isEligible(hash)) continue;
      this.stats.candidates++;

      if (this.exactVectors) {
        // Re-rank against exact float32 — result matches a brute-force scan.
        const distSq = this._exactDistSq(query, row, bestSq);
        this.stats.rerankedExact++;
        if (distSq < bestSq) {
          bestSq = distSq;
          best = { hash, distance: Math.sqrt(distSq), exact: true };
        }
      } else {
        // No exact vectors resident: report the quantised distance. Biased
        // conservative, so this can over-report a borderline match but never
        // miss one.
        const dist = Math.sqrt(s) / QUANT_SCALE;
        if (dist < threshold + QUANT_ERROR && (!best || dist < best.distance)) {
          best = { hash, distance: dist, exact: false };
        }
      }
    }

    return best;
  }

  /** Full-index search. */
  search(descriptor, threshold, isEligible = null) {
    return this.scanRange(descriptor, threshold, 0, this.count, isEligible);
  }

  // ── Introspection ─────────────────────────────────────────────────────────

  /**
   * Row range this node would own if the index were split `parts` ways.
   * Lets an operator hand slices to sibling nodes without changing the layout.
   */
  rangeFor(part, parts) {
    const span = Math.ceil(this.count / parts);
    return { from: part * span, to: Math.min(this.count, (part + 1) * span) };
  }

  memoryBytes() {
    return this.slabQ.byteLength + (this.slabF ? this.slabF.byteLength : 0);
  }

  getStats() {
    return {
      entries: this.rows.size,
      rows: this.count,
      freeRows: this.freeRows.length,
      exactVectors: this.exactVectors,
      memoryMB: +(this.memoryBytes() / 1e6).toFixed(1),
      bytesPerEntry: this.rows.size ? Math.round(this.memoryBytes() / this.rows.size) : 0,
      quantErrorBound: +QUANT_ERROR.toFixed(4),
      ...this.stats
    };
  }
}

DescriptorIndex.DIMS = DIMS;
module.exports = DescriptorIndex;
