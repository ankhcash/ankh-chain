'use strict';

/**
 * SidechainChain
 *
 * Per-sidechain block persistence. Each active sidechain gets its own
 * chain.json file and state.json file under data/sidechains/{chainId}/.
 *
 * Uses the same two-phase atomic append pattern as AnkhBlockchain so
 * sidechain blocks survive node crashes without corruption.
 *
 * Files:
 *   {dataDir}/sidechains/{chainId}/chain.json   — append-only block log
 *   {dataDir}/sidechains/{chainId}/state.json   — balances, verified set
 */

const path   = require('path');
const fs     = require('fs').promises;
const fsSync = require('fs');
const crypto = require('crypto');

class SidechainChain {
  constructor(dataDir, chainId) {
    this.chainId    = chainId;
    this.dir        = path.join(dataDir, 'sidechains', chainId);
    this.chainFile  = path.join(this.dir, 'chain.json');
    this.stateFile  = path.join(this.dir, 'state.json');
    this.latestBlock = null;
    this.height      = 0;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async initialize() {
    await fs.mkdir(this.dir, { recursive: true });

    // Clean up any stale journal from a previous crash
    try { fsSync.unlinkSync(this.chainFile + '.tmp'); } catch {}

    await this.loadChain();
  }

  // ── Block persistence ──────────────────────────────────────────────────────

  /**
   * Append a block to chain.json using the same two-phase atomic write as
   * AnkhBlockchain.saveChain() so a mid-write crash leaves the file intact.
   */
  async appendBlock(block) {
    const blockJson = JSON.stringify(block.toJSON ? block.toJSON() : block, null, 2);
    const tmpPath   = this.chainFile + '.tmp';

    try {
      const stat = await fs.stat(this.chainFile);

      // Find closing `]` in last 20 bytes
      const tailBytes = Math.min(stat.size, 20);
      const readFd    = fsSync.openSync(this.chainFile, 'r');
      const tailBuf   = Buffer.alloc(tailBytes);
      fsSync.readSync(readFd, tailBuf, 0, tailBytes, stat.size - tailBytes);
      fsSync.closeSync(readFd);

      const relPos = tailBuf.toString('utf8').lastIndexOf(']');
      if (relPos === -1) return;
      const closePos   = stat.size - tailBytes + relPos;
      const appendBuf  = Buffer.from(',\n' + blockJson + '\n]', 'utf8');

      // Phase 1: journal
      fsSync.writeFileSync(tmpPath, appendBuf);
      const jFd = fsSync.openSync(tmpPath, 'r+');
      fsSync.fdatasyncSync(jFd);
      fsSync.closeSync(jFd);

      // Phase 2: truncate + write
      const writeFd = fsSync.openSync(this.chainFile, 'r+');
      fsSync.ftruncateSync(writeFd, closePos);
      fsSync.writeSync(writeFd, appendBuf, 0, appendBuf.length, closePos);
      fsSync.fdatasyncSync(writeFd);
      fsSync.closeSync(writeFd);

      try { fsSync.unlinkSync(tmpPath); } catch {}

    } catch {
      // First block — create fresh file
      fsSync.writeFileSync(this.chainFile, '[\n' + blockJson + '\n]');
      const freshFd = fsSync.openSync(this.chainFile, 'r+');
      fsSync.fdatasyncSync(freshFd);
      fsSync.closeSync(freshFd);
    }

    this.latestBlock = block;
    this.height      = block.index !== undefined ? block.index : this.height + 1;
  }

  /**
   * Tail-read the last block from chain.json without loading the full file.
   */
  async loadChain() {
    try {
      const stat = await fs.stat(this.chainFile);
      if (stat.size === 0) return;

      const tailBytes = Math.min(stat.size, 1024 * 1024);
      const fd  = fsSync.openSync(this.chainFile, 'r');
      const buf = Buffer.alloc(tailBytes);
      fsSync.readSync(fd, buf, 0, tailBytes, stat.size - tailBytes);
      fsSync.closeSync(fd);

      const tail      = buf.toString('utf8');
      const lastStart = tail.lastIndexOf('\n{');
      if (lastStart === -1) return;

      const snippet   = tail.slice(lastStart + 1).replace(/[\],\s]+$/, '').trim();
      const blockData = JSON.parse(snippet);

      this.latestBlock = blockData;
      this.height      = blockData.index || 0;
    } catch {
      // No chain file yet — fresh sidechain
    }
  }

  /**
   * Read a specific block by scanning chain.json. Only used for REST queries.
   * For high-volume use, sidechains should maintain a block index separately.
   */
  async getBlockByIndex(targetIndex) {
    try {
      const raw    = await fs.readFile(this.chainFile, 'utf8');
      const blocks = JSON.parse(raw);
      return blocks.find(b => b.index === targetIndex) || null;
    } catch {
      return null;
    }
  }

  getLatestBlock() {
    return this.latestBlock;
  }

  // ── State persistence ──────────────────────────────────────────────────────

  /**
   * Persist sidechain state atomically via rename.
   * state: { balances: Map<address,BigInt>, verifiedAddresses: Set<address>,
   *          biometricHashes: Map<address,string>, lastAnchorBlock, lastAnchorHash }
   */
  async saveState(state) {
    const tmpPath = this.stateFile + '.tmp';

    const serialized = JSON.stringify({
      balances:          [...state.balances.entries()].map(([a, v]) => [a, v.toString() + 'n']),
      verifiedAddresses: [...state.verifiedAddresses],
      biometricHashes:   [...state.biometricHashes.entries()],
      lastAnchorBlock:   state.lastAnchorBlock || 0,
      lastAnchorHash:    state.lastAnchorHash  || null
    }, null, 2);

    fsSync.writeFileSync(tmpPath, serialized);
    fsSync.renameSync(tmpPath, this.stateFile);
  }

  /**
   * Load sidechain state from disk.
   * Returns { balances, verifiedAddresses, biometricHashes, lastAnchorBlock, lastAnchorHash }
   */
  async loadState() {
    const empty = {
      balances:          new Map(),
      verifiedAddresses: new Set(),
      biometricHashes:   new Map(),
      lastAnchorBlock:   0,
      lastAnchorHash:    null
    };

    try {
      const raw  = await fs.readFile(this.stateFile, 'utf8');
      const data = JSON.parse(raw);

      const reviveBigInt = v => (typeof v === 'string' && v.endsWith('n'))
        ? BigInt(v.slice(0, -1)) : BigInt(v || 0);

      return {
        balances:          new Map(data.balances.map(([a, v]) => [a, reviveBigInt(v)])),
        verifiedAddresses: new Set(data.verifiedAddresses || []),
        biometricHashes:   new Map(data.biometricHashes   || []),
        lastAnchorBlock:   data.lastAnchorBlock || 0,
        lastAnchorHash:    data.lastAnchorHash  || null
      };
    } catch {
      return empty;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Compute a state root from current balances + verified set.
   * Included in sidechain blocks and anchor transactions.
   */
  static computeStateRoot(balances, verifiedAddresses) {
    const data = JSON.stringify({
      balances:  [...balances.entries()].map(([a, v]) => [a, v.toString()]).sort(),
      verified:  [...verifiedAddresses].sort()
    });
    return '0x' + crypto.createHash('sha256').update(data).digest('hex');
  }
}

module.exports = SidechainChain;
