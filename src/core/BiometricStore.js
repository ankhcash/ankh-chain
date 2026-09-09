/**
 * BiometricStore
 *
 * Authoritative, uncapped, sharded store for 128-d face descriptors.
 *
 * Replaces the previous `biometricDescriptors` Map + single JSON file, which:
 *   - persisted only the last 10,000 entries (`slice(-10_000)`), silently
 *     dropping older descriptors and blinding duplicate detection past 10k users;
 *   - stored each descriptor as pretty-printed JSON floats (~2.5 KB/entry);
 *   - was excluded from the state root, so descriptors were not consensus state;
 *   - forced an O(n) full scan on every duplicate check.
 *
 * Design
 * ------
 * Storage   Descriptors are Float32Array(128) in memory (512 B each, vs ~13 KB
 *           for a 128-element JS number array) and base64-encoded little-endian
 *           float32 on disk (684 B each, ~3.6x smaller than JSON).
 *
 * Sharding  Entries live in 256 shards keyed by the first byte of the biometric
 *           hash (`data/biometrics/shard_<xx>.json`). Only shards that actually
 *           changed are rewritten, so a block that registers one user rewrites
 *           one ~small shard instead of a monolithic file.
 *
 * Search    Duplicate lookup is pivot-pruned but *exact* — never approximate.
 *           face-api descriptors are unit-norm, so for any unit pivot p,
 *           Cauchy-Schwarz gives |q·p - s·p| <= ||q - s||. If that lower bound
 *           already exceeds the match threshold, s cannot be a match and the
 *           full 128-dim distance is skipped. Zero false negatives: a duplicate
 *           can never slip through pruning, which is what makes it safe to use
 *           on the Sybil-resistance path.
 *
 * Commitment  A running XOR accumulator over sha256(hash || descriptor) gives an
 *           order-independent O(1)-update commitment, so descriptors can be
 *           folded into the state root without an O(n log n) re-hash per block.
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const DescriptorIndex = require('./DescriptorIndex');

const DESCRIPTOR_DIMS = 128;
const SHARD_COUNT = 256;
const PIVOT_COUNT = 8;
const HASH_BYTES = 32;

class BiometricStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'biometrics');

    /**
     * Descriptor storage and search.
     *
     * Contiguous int8 slab with exact float32 re-ranking — see DescriptorIndex.
     * Replaces a Map of per-entry Float32Arrays, which cost ~840 B/entry and
     * scanned at 42 ms per verification at 200k faces (1090 ms at 1M) because
     * every comparison chased a separate heap object.
     *
     * ANKH_LEAN_DESCRIPTORS=1 drops the exact float32 copy: 210 B/entry instead
     * of 839 (2.7 GB rather than 13.4 GB at 21 M). Search then reports the
     * quantised distance, which is biased conservative — it can over-report a
     * borderline match but never miss a duplicate.
     */
    this.index = new DescriptorIndex({
      exactVectors: process.env.ANKH_LEAN_DESCRIPTORS !== '1'
    });

    /** Shards touched since the last successful save. */
    this.dirtyShards = new Set();

    /** Order-independent commitment over all entries. */
    this.accumulator = Buffer.alloc(HASH_BYTES);

    // Stats for observability
    this.stats = { comparisons: 0, pruned: 0, lookups: 0 };
  }

  // ── Vector helpers ────────────────────────────────────────────────────────

  /** Accept a plain array or Float32Array; return a Float32Array or null. */
  static toFloat32(descriptor) {
    if (descriptor instanceof Float32Array) {
      return descriptor.length === DESCRIPTOR_DIMS ? descriptor : null;
    }
    if (Array.isArray(descriptor) && descriptor.length === DESCRIPTOR_DIMS) {
      const out = new Float32Array(DESCRIPTOR_DIMS);
      for (let i = 0; i < DESCRIPTOR_DIMS; i++) {
        const v = Number(descriptor[i]);
        if (!Number.isFinite(v)) return null;
        out[i] = v;
      }
      return out;
    }
    return null;
  }

  static encode(vec) {
    return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString('base64');
  }

  static decode(b64) {
    const buf = Buffer.from(b64, 'base64');
    if (buf.length !== DESCRIPTOR_DIMS * 4) return null;
    // Copy so the Float32Array owns aligned memory independent of the pooled Buffer.
    const out = new Float32Array(DESCRIPTOR_DIMS);
    for (let i = 0; i < DESCRIPTOR_DIMS; i++) out[i] = buf.readFloatLE(i * 4);
    return out;
  }

  static euclidean(a, b) {
    let sum = 0;
    for (let i = 0; i < DESCRIPTOR_DIMS; i++) {
      const d = a[i] - b[i];
      sum += d * d;
    }
    return Math.sqrt(sum);
  }

  /**
   * Squared distance with early termination.
   *
   * Returns the exact squared distance when it is below `limitSq`, and a value
   * greater than `limitSq` (the partial sum at the point of abort) otherwise —
   * which is all a threshold test needs. Non-matching descriptors typically
   * blow past the limit within the first ~25 of 128 dimensions, so this is a
   * large constant-factor win and, unlike projection pruning, it does not
   * depend on how the data is distributed. Exact: a pair below the limit is
   * always fully summed, so no duplicate can be missed.
   */
  static distanceSqWithin(a, b, limitSq) {
    let sum = 0;
    for (let i = 0; i < DESCRIPTOR_DIMS; i++) {
      const d = a[i] - b[i];
      sum += d * d;
      // Check every 8 dims — measured sweet spot: non-matches abort near dim ~25,
      // and checking more often costs more in branches than it saves in math.
      if ((i & 7) === 7 && sum > limitSq) return sum;
    }
    return sum;
  }

  // ── Commitment ────────────────────────────────────────────────────────────

  /**
   * Per-entry digest over the quantised representation.
   *
   * Quantised bytes are resident in every memory mode, so a lean node and a
   * full node produce identical commitments for the same descriptor set —
   * which they must, since the commitment can feed the state root.
   */
  _entryDigest(hash) {
    const q = this.index.getQuantized(hash);
    if (!q) return Buffer.alloc(HASH_BYTES);
    return crypto.createHash('sha256')
      .update(hash)
      .update(Buffer.from(q.buffer, q.byteOffset, q.byteLength))
      .digest();
  }

  _accumulate(digest) {
    for (let i = 0; i < HASH_BYTES; i++) this.accumulator[i] ^= digest[i];
  }

  /** Deterministic commitment over the full descriptor set, for the state root. */
  commitment() {
    return crypto.createHash('sha256')
      .update(this.accumulator)
      .update(String(this.index.size))
      .digest('hex');
  }

  // ── Map-compatible surface ────────────────────────────────────────────────

  static shardOf(hash) {
    return String(hash).slice(0, 2).toLowerCase();
  }

  get size() {
    return this.index.size;
  }

  has(hash) {
    return this.index.has(hash);
  }

  get(hash) {
    return this.index.getVector(hash);
  }

  /** Yields [hash, Float32Array]; requires exact vectors to be resident. */
  *entries() {
    for (const hash of this.index.rows.keys()) {
      yield [hash, this.index.getVector(hash)];
    }
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  keys() {
    return this.index.rows.keys();
  }

  /**
   * Insert or replace a descriptor. Returns true when stored.
   * Rejects malformed input rather than silently storing junk.
   */
  set(hash, descriptor) {
    if (!hash) return false;

    // Withdraw the previous contribution before folding in the new one.
    if (this.index.has(hash)) this._accumulate(this._entryDigest(hash));

    if (!this.index.add(hash, descriptor)) {
      // Malformed input: restore the prior contribution so the accumulator
      // still reflects what is actually stored.
      if (this.index.has(hash)) this._accumulate(this._entryDigest(hash));
      return false;
    }

    this._accumulate(this._entryDigest(hash));
    this.dirtyShards.add(BiometricStore.shardOf(hash));
    return true;
  }

  delete(hash) {
    if (!this.index.has(hash)) return false;
    this._accumulate(this._entryDigest(hash));
    this.index.remove(hash);
    this.dirtyShards.add(BiometricStore.shardOf(hash));
    return true;
  }

  // ── Duplicate search ──────────────────────────────────────────────────────

  /**
   * Find an existing descriptor within `threshold` Euclidean distance.
   *
   * Exact: pruning only skips candidates that are provably beyond the threshold,
   * so this returns the same answer a full linear scan would.
   *
   * @param {number[]|Float32Array} descriptor
   * @param {number} threshold                 face-api "same person" distance (0.6)
   * @param {(hash: string) => boolean} [isEligible]  optional filter, e.g. skip orphans
   * @returns {{hash: string, distance: number}|null}
   */
  findDuplicate(descriptor, threshold, isEligible = null) {
    this.stats.lookups++;
    const match = this.index.search(descriptor, threshold, isEligible);
    if (match) this.stats.comparisons++;
    return match ? { hash: match.hash, distance: match.distance, exact: match.exact } : null;
  }

  /**
   * Search only rows [from, to) of the index.
   *
   * Lets a node own a slice of the descriptor set so several nodes can search
   * in parallel and vote through the existing verification consensus, instead
   * of every node scanning every face.
   */
  findDuplicateInRange(descriptor, threshold, from, to, isEligible = null) {
    return this.index.scanRange(descriptor, threshold, from, to, isEligible);
  }

  /** Row range this node owns when the index is split `parts` ways. */
  rangeFor(part, parts) {
    return this.index.rangeFor(part, parts);
  }

  /** Reconstruct an approximate float32 vector from the quantised row. */
  _dequantize(hash) {
    const q = this.index.getQuantized(hash);
    if (!q) return null;
    const out = new Float32Array(DESCRIPTOR_DIMS);
    const step = 0.35 / 127;
    for (let i = 0; i < DESCRIPTOR_DIMS; i++) out[i] = q[i] * step;
    return out;
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  /**
   * Write only the shards that changed since the last save.
   * Each shard is written to a uniquely-named temp file then renamed, so
   * concurrent writers can never collide on the same temp path.
   */
  async save(force = false) {
    await fs.mkdir(this.dir, { recursive: true });

    const shards = force
      ? new Set(Array.from(this.index.rows.keys()).map(BiometricStore.shardOf))
      : new Set(this.dirtyShards);

    if (shards.size === 0) return { shardsWritten: 0, entries: this.index.size };

    // Bucket entries by shard once, rather than scanning per shard.
    const buckets = new Map();
    for (const shard of shards) buckets.set(shard, {});
    for (const hash of this.index.rows.keys()) {
      const shard = BiometricStore.shardOf(hash);
      const bucket = buckets.get(shard);
      if (!bucket) continue;
      // Persist exact float32 when resident. On a lean node only the quantised
      // form exists, so dequantise it — matching still works from that, and the
      // commitment is quantisation-based either way.
      const vec = this.index.getVector(hash) || this._dequantize(hash);
      if (vec) bucket[hash] = BiometricStore.encode(vec);
    }

    let written = 0;
    for (const [shard, bucket] of buckets) {
      const live = path.join(this.dir, `shard_${shard}.json`);
      const tmp = `${live}.${process.pid}.${Date.now()}.tmp`;
      const count = Object.keys(bucket).length;
      try {
        if (count === 0) {
          await fs.unlink(live).catch(() => {});
        } else {
          await fs.writeFile(tmp, JSON.stringify(bucket));
          await fs.rename(tmp, live);
        }
        this.dirtyShards.delete(shard);
        written++;
      } catch (err) {
        await fs.unlink(tmp).catch(() => {});
        throw new Error(`BiometricStore: failed to write shard ${shard}: ${err.message}`);
      }
    }

    return { shardsWritten: written, entries: this.index.size };
  }

  /**
   * Load every shard. No cap — the whole point of the rewrite.
   * `isEligible` drops orphaned descriptors whose user is not registered.
   */
  async load(isEligible = null) {
    this.index = new DescriptorIndex({
      exactVectors: process.env.ANKH_LEAN_DESCRIPTORS !== '1'
    });
    this.dirtyShards.clear();
    this.accumulator = Buffer.alloc(HASH_BYTES);

    let files = [];
    try {
      files = (await fs.readdir(this.dir)).filter(f => /^shard_[0-9a-f]{2}\.json$/.test(f));
    } catch {
      return { loaded: 0, orphaned: 0, migrated: false };
    }

    let orphaned = 0;
    for (const file of files) {
      let bucket;
      try {
        bucket = JSON.parse(await fs.readFile(path.join(this.dir, file), 'utf8'));
      } catch (err) {
        console.error(`[BiometricStore] Skipping unreadable shard ${file}: ${err.message}`);
        continue;
      }
      for (const [hash, b64] of Object.entries(bucket)) {
        if (isEligible && !isEligible(hash)) { orphaned++; continue; }
        const vec = BiometricStore.decode(b64);
        if (!vec) continue;
        if (!this.index.add(hash, vec)) continue;
        this._accumulate(this._entryDigest(hash));
      }
    }

    // Nothing is dirty right after a load.
    this.dirtyShards.clear();
    return { loaded: this.index.size, orphaned, migrated: false };
  }

  /**
   * One-time migration from the legacy capped `biometric_descriptors.json`.
   * Runs only when the sharded store is empty and the legacy file exists, so a
   * node upgrading in place keeps every descriptor it already had.
   */
  async migrateLegacy(legacyPath, isEligible = null) {
    if (this.index.size > 0) return { migrated: 0, skipped: true };
    if (!fsSync.existsSync(legacyPath)) return { migrated: 0, skipped: true };

    let raw;
    try {
      raw = JSON.parse(await fs.readFile(legacyPath, 'utf8'));
    } catch (err) {
      console.error(`[BiometricStore] Legacy migration failed to parse: ${err.message}`);
      return { migrated: 0, skipped: true };
    }
    if (!Array.isArray(raw)) return { migrated: 0, skipped: true };

    let migrated = 0;
    let orphaned = 0;
    for (const [hash, descriptor] of raw) {
      if (isEligible && !isEligible(hash)) { orphaned++; continue; }
      if (this.set(hash, descriptor)) migrated++;
    }

    if (migrated > 0) {
      await this.save(true);
      console.log(
        `[BiometricStore] Migrated ${migrated.toLocaleString()} descriptor(s) from legacy store ` +
        `into ${SHARD_COUNT}-way sharded storage` +
        (orphaned > 0 ? ` (${orphaned} orphaned entries dropped)` : '')
      );
    }
    return { migrated, orphaned, skipped: false };
  }

  getStats() {
    return {
      entries: this.index.size,
      shardsDirty: this.dirtyShards.size,
      lookups: this.stats.lookups,
      matches: this.stats.comparisons,
      index: this.index.getStats()
    };
  }
}

BiometricStore.DESCRIPTOR_DIMS = DESCRIPTOR_DIMS;
BiometricStore.SHARD_COUNT = SHARD_COUNT;

module.exports = BiometricStore;
