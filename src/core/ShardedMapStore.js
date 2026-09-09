/**
 * ShardedMapStore
 *
 * A Map-compatible state container that persists across many small shard files
 * instead of one monolithic JSON array.
 *
 * Why
 * ---
 * The previous StateManager serialised each state map with a single
 * `JSON.stringify(Array.from(map.entries()))`. That builds the entire file as
 * one JavaScript string, and V8 caps strings at MAX_STRING_LENGTH
 * (536,870,888 chars). Measured against live data:
 *
 *   verified_users   810 B/entry  -> throws at   ~662,000 entries
 *   ubi_allocations  689 B/entry  -> throws at   ~779,000 entries
 *   accounts         379 B/entry  -> throws at ~1,416,000 entries
 *
 * Past that point every save throws "Invalid string length" and all subsequent
 * state is lost on restart. A chain meant to serve a national population — and
 * eventually billions — cannot have a hard ceiling below one million accounts.
 *
 * How
 * ---
 * Entries are distributed over N shards by a stable hash of the key. Each shard
 * is its own small JSON file, so no single string ever approaches the V8 limit:
 * with 4,096 shards, one billion 810-byte entries yields ~198 MB per shard, and
 * shard count can be raised further without touching callers.
 *
 * Writes are incremental in the way a Merkle-trie-backed chain is incremental:
 * only shards actually touched since the last save are rewritten, so committing
 * a block that changes 50 accounts writes a handful of small files rather than
 * re-serialising the entire world.
 *
 * Reads are served from memory (the full map is resident), so lookup semantics
 * and cost are identical to the Map this replaces.
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SHARDS = 4096;

/** BigInt-aware JSON round-trip, matching StateManager's existing on-disk format. */
const encodeValue = (v) => JSON.stringify(v, (_, val) =>
  typeof val === 'bigint' ? val.toString() + 'n' : val instanceof Map ? Array.from(val) : val
);

const decodeValue = (str) => JSON.parse(str, (_, v) => {
  if (typeof v === 'string' && /^-?\d+n$/.test(v)) return BigInt(v.slice(0, -1));
  return v;
});

class ShardedMapStore {
  /**
   * @param {string} dataDir      chain data directory
   * @param {string} name         logical name, e.g. 'accounts'
   * @param {object} [opts]
   * @param {number} [opts.shards] shard count (power of two recommended)
   */
  constructor(dataDir, name, opts = {}) {
    this.name = name;
    this.shardCount = opts.shards || DEFAULT_SHARDS;
    this.dir = path.join(dataDir, 'state', name);
    this.legacyPath = path.join(dataDir, `${name}.json`);

    /**
     * One Map per shard rather than a single flat Map.
     *
     * Rewriting a shard then touches only that shard's own entries. With a flat
     * Map, save() had to scan all N entries to discover which belonged to the
     * dirty shards — ~2 s per block at 1.5M users even when one account changed.
     * @type {Array<Map<string, any>|null>}
     */
    this.shards = new Array(this.shardCount).fill(null);
    this._size = 0;

    /** shard index -> true when it needs rewriting */
    this.dirty = new Set();

    /** shard index -> sha256 of last written content, to skip no-op writes */
    this.digests = new Map();

    /**
     * Order-independent running commitment over all entries.
     *
     * StateManager's hashMap() hashes entries in iteration order, which is fine
     * for a Map but wrong here: shards load in filename order, so a reloaded
     * store iterates differently and would produce a different state root for
     * identical state — peers would reject each other's snapshots.
     *
     * It is also O(N) per block. Re-hashing every account on every block is
     * already impractical at national scale; XOR-accumulating a per-entry digest
     * makes the commitment O(1) to update and O(1) to read, and independent of
     * order by construction.
     */
    this.accumulator = Buffer.alloc(32);

    /**
     * key -> 16-byte digest of the value as last folded into the accumulator.
     *
     * Needed because XOR is only reversible if the previous contribution is
     * known, and callers mutate stored objects in place (StateManager's
     * updateBalance does `account.balance = ...` on the object returned by
     * get()). Without this the accumulator silently drifts from reality.
     */
    this.entryDigests = new Map();

    /** keys touched since the last commitment()/save() */
    this.dirtyKeys = new Set();

    this._shardWidth = String(this.shardCount - 1).length;
  }

  // ── Shard routing ─────────────────────────────────────────────────────────

  /**
   * Stable shard for a key. Uses sha256 rather than the key's own prefix so
   * that structured keys (all addresses starting "ankh_") still spread evenly.
   */
  shardOf(key) {
    // FNV-1a. Shard routing only needs uniform spread, not collision
    // resistance, and this sits on a hot path — get() and set() call it on
    // every account touch, where a SHA-256 per call is pure overhead.
    // Structured keys (every address starts "ankh_") still spread evenly
    // because FNV mixes every byte into the low bits.
    const str = String(key);
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0) % this.shardCount;
  }

  _shardFile(idx) {
    return path.join(this.dir, `s${String(idx).padStart(this._shardWidth, '0')}.json`);
  }

  // ── Map-compatible surface ────────────────────────────────────────────────

  get size() { return this._size; }

  /** Shard map for a key; creates it on demand when `create` is set. */
  _shard(key, create = false) {
    const idx = this.shardOf(key);
    let m = this.shards[idx];
    if (!m && create) { m = new Map(); this.shards[idx] = m; }
    return m;
  }

  /**
   * Returns the live stored object.
   *
   * The caller may mutate it in place — StateManager does exactly that — and
   * neither the shard tracker nor the commitment can observe that afterwards.
   * So a read marks the key dirty: the cost is an occasional redundant shard
   * write, versus silently failing to persist a balance change. Use peek() on
   * paths that are genuinely read-only.
   */
  get(key) {
    const m = this._shard(key);
    if (m && m.has(key)) this._markDirty(key);
    return m ? m.get(key) : undefined;
  }

  /** Read without marking dirty. Only for values that will not be mutated. */
  peek(key) {
    const m = this._shard(key);
    return m ? m.get(key) : undefined;
  }

  has(key) {
    const m = this._shard(key);
    return m ? m.has(key) : false;
  }

  *entries() {
    for (const m of this.shards) {
      if (!m) continue;
      yield* m.entries();
    }
  }

  *keys() { for (const [k] of this.entries()) yield k; }
  *values() { for (const [, v] of this.entries()) yield v; }
  forEach(fn, thisArg) { for (const [k, v] of this.entries()) fn.call(thisArg, v, k, this); }
  [Symbol.iterator]() { return this.entries(); }

  /** sha256(key || encoded value) — the unit of the running commitment. */
  _entryDigest(key, value) {
    return crypto.createHash('sha256')
      .update(String(key))
      .update(encodeValue(value))
      .digest()
      .subarray(0, 16);
  }

  _accumulate(digest) {
    for (let i = 0; i < 16; i++) this.accumulator[i] ^= digest[i];
  }

  _markDirty(key) {
    this.dirtyKeys.add(key);
    this.dirty.add(this.shardOf(key));
  }

  set(key, value) {
    const m = this._shard(key, true);
    if (!m.has(key)) this._size++;
    m.set(key, value);
    this._markDirty(key);
    return this;
  }

  delete(key) {
    const m = this._shard(key);
    if (!m || !m.has(key)) return false;
    m.delete(key);
    this._size--;
    this._markDirty(key);
    return true;
  }

  clear() {
    for (const k of this.keys()) this._markDirty(k);
    this.shards.fill(null);
    this._size = 0;
    return this;
  }

  /**
   * Fold every touched key into the running accumulator.
   *
   * Cost is proportional to what changed, not to the population — the same
   * property a Merkle trie gets from only recomputing changed subtrees. The
   * previous implementation re-hashed every entry on every block.
   */
  _settle() {
    if (this.dirtyKeys.size === 0) return;
    for (const key of this.dirtyKeys) {
      const prev = this.entryDigests.get(key);
      if (prev) this._accumulate(prev);            // XOR out the stale contribution
      const m = this._shard(key);
      if (m && m.has(key)) {
        const d = this._entryDigest(key, m.get(key));
        this._accumulate(d);                        // XOR in the current one
        this.entryDigests.set(key, d);
      } else {
        this.entryDigests.delete(key);
      }
    }
    this.dirtyKeys.clear();
  }

  /**
   * Order-independent commitment over the whole store, for the state root.
   * Order-independent by construction (XOR), so it survives shards loading in
   * a different order than they were written.
   */
  commitment() {
    this._settle();
    return crypto.createHash('sha256')
      .update(this.accumulator)
      .update(String(this._size))
      .digest('hex');
  }

  /**
   * Replace all contents in one go.
   *
   * P2P state sync previously did `sm.accounts = new Map(entries)`, which would
   * silently swap this store out for a plain Map and lose all persistence.
   * Callers use this instead; StateManager exposes it via replaceMap().
   */
  replaceAll(entries) {
    this.clear();
    for (const [k, v] of entries) this.set(k, v);
    return this;
  }

  /** Mark every populated shard dirty — used after a bulk load or migration. */
  markAllDirty() {
    for (const key of this.keys()) this.dirty.add(this.shardOf(key));
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  /**
   * Write shards that changed since the last save.
   *
   * Each shard goes to a uniquely-named temp file then renames into place, so
   * concurrent writers cannot collide on a temp path and a crash mid-write
   * leaves the previous shard intact.
   */
  async save(force = false) {
    this._settle();
    await fs.mkdir(this.dir, { recursive: true });

    const targets = force
      ? new Set(Array.from({ length: this.shardCount }, (_, i) => i))
      : new Set(this.dirty);
    if (targets.size === 0) return { shardsWritten: 0, entries: this._size };

    // Each dirty shard already holds exactly its own entries — no global scan.
    const buckets = new Map();
    for (const idx of targets) {
      const m = this.shards[idx];
      buckets.set(idx, m ? Array.from(m.entries()) : []);
    }

    const stamp = `${process.pid}.${Date.now()}`;
    let written = 0;
    const failures = [];

    // Write in bounded parallel batches. A full save touches every shard
    // (first run after migration), and doing 4,096 writes strictly in series
    // is dominated by per-file latency rather than by the data itself.
    const CONCURRENCY = 64;
    const pending = [];
    const flush = async () => {
      if (pending.length === 0) return;
      const batch = pending.splice(0, pending.length);
      await Promise.all(batch);
    };

    for (const [idx, rows] of buckets) {
      const live = this._shardFile(idx);
      // Serialise per-entry, so no single string can approach the V8 cap even
      // if one shard grows unexpectedly large.
      const body = rows.length === 0
        ? '[]'
        : '[' + rows.map(([k, v]) => JSON.stringify(k) + ':' + encodeValue(v)).join(',\n') + ']';

      const digest = crypto.createHash('sha256').update(body).digest('hex');
      if (!force && this.digests.get(idx) === digest) { this.dirty.delete(idx); continue; }

      const tmp = `${live}.${stamp}.${idx}.tmp`;
      pending.push((async () => {
        try {
          if (rows.length === 0) {
            await fs.unlink(live).catch(() => {});
            this.digests.delete(idx);
          } else {
            await fs.writeFile(tmp, body);
            await fs.rename(tmp, live);
            this.digests.set(idx, digest);
          }
          this.dirty.delete(idx);
          written++;
        } catch (err) {
          await fs.unlink(tmp).catch(() => {});
          failures.push(`${this.name}/s${idx}: ${err.message}`);
        }
      })());
      if (pending.length >= CONCURRENCY) await flush();
    }
    await flush();

    if (failures.length) {
      throw new Error(`ShardedMapStore(${this.name}) failed on ${failures.length} shard(s): ${failures[0]}`);
    }
    return { shardsWritten: written, entries: this._size };
  }

  /** Parse the `"key":value,\n` shard body without ever holding a huge string per entry. */
  static _parseShard(body) {
    const out = [];
    const trimmed = body.trim();
    if (trimmed === '[]' || trimmed === '') return out;
    const inner = trimmed.slice(1, -1); // strip [ ]
    for (const line of inner.split(',\n')) {
      const sep = line.indexOf('":');
      if (sep === -1) continue;
      const key = JSON.parse(line.slice(0, sep + 1));
      out.push([key, decodeValue(line.slice(sep + 2))]);
    }
    return out;
  }

  async load() {
    this.shards.fill(null);
    this._size = 0;
    this.dirty.clear();
    this.digests.clear();
    this.accumulator = Buffer.alloc(32);
    this.entryDigests.clear();
    this.dirtyKeys.clear();

    let files = [];
    try {
      files = (await fs.readdir(this.dir)).filter(f => /^s\d+\.json$/.test(f));
    } catch {
      return { loaded: 0, migrated: false };
    }

    for (const file of files) {
      const full = path.join(this.dir, file);
      let body;
      try {
        body = await fs.readFile(full, 'utf8');
      } catch (err) {
        console.error(`[${this.name}] Unreadable shard ${file}: ${err.message}`);
        continue;
      }
      let rows;
      try {
        rows = ShardedMapStore._parseShard(body);
      } catch (err) {
        console.error(`[${this.name}] Corrupt shard ${file}: ${err.message} — skipped`);
        continue;
      }
      const idx = parseInt(file.slice(1), 10);
      this.digests.set(idx, crypto.createHash('sha256').update(body).digest('hex'));
      for (const [k, v] of rows) {
        let m = this.shards[idx];
        if (!m) { m = new Map(); this.shards[idx] = m; }
        if (!m.has(k)) this._size++;
        m.set(k, v);
        const d = this._entryDigest(k, v);
        this._accumulate(d);
        this.entryDigests.set(k, d);
      }
    }

    return { loaded: this._size, migrated: false };
  }

  /**
   * One-time import of the legacy monolithic `<name>.json`.
   *
   * Reads with a streaming-friendly guard: if the legacy file is larger than the
   * V8 string cap it cannot be read as a string at all, which is exactly the
   * failure this class exists to prevent — in that case the operator is told to
   * migrate from a backup rather than the node silently starting up empty.
   */
  async migrateLegacy() {
    if (this._size > 0) return { migrated: 0, skipped: true };
    if (!fsSync.existsSync(this.legacyPath)) return { migrated: 0, skipped: true };

    const MAX = require('buffer').constants.MAX_STRING_LENGTH;
    const size = fsSync.statSync(this.legacyPath).size;
    if (size >= MAX) {
      throw new Error(
        `${this.name}.json is ${(size / 1e9).toFixed(2)} GB, beyond the ${(MAX / 1e9).toFixed(2)} GB ` +
        `string limit — it cannot be read in one piece. Restore from a sharded backup.`
      );
    }

    let raw;
    try {
      raw = decodeValue(await fs.readFile(this.legacyPath, 'utf8'));
    } catch (err) {
      console.error(`[${this.name}] Legacy migration failed: ${err.message}`);
      return { migrated: 0, skipped: true };
    }
    if (!Array.isArray(raw)) return { migrated: 0, skipped: true };

    for (const [k, v] of raw) this.set(k, v);
    this.markAllDirty();
    await this.save();

    console.log(
      `[${this.name}] Migrated ${this._size.toLocaleString()} entries from legacy JSON ` +
      `into ${this.shardCount}-way sharded state`
    );
    return { migrated: this._size, skipped: false };
  }

  getStats() {
    return {
      entries: this._size,
      shards: this.shardCount,
      dirtyShards: this.dirty.size,
      avgPerShard: Math.ceil(this._size / this.shardCount)
    };
  }
}

ShardedMapStore.DEFAULT_SHARDS = DEFAULT_SHARDS;
module.exports = ShardedMapStore;
