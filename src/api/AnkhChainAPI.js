/**
 * Ankh Chain API
 *
 * REST and WebSocket API for the Ankh Native Blockchain.
 * Provides endpoints for:
 * - Wallet operations
 * - UBI claims
 * - Biometric verification
 * - Token operations
 * - Sidechain management
 * - Chain queries
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const GenesisConfig = require('../core/GenesisConfig');

/**
 * Read whole blocks from the tail of chain.json.
 *
 * The file is a pretty-printed JSON array appended to in place. Every value
 * nested inside a block is indented, so a `{` sitting at column zero is a block
 * boundary and nothing else — which makes the scan independent of whichever
 * field a block happens to start with. Parsing the tail this way avoids loading
 * a multi-gigabyte file, and a block truncated by the window edge is skipped
 * rather than throwing.
 */
function readChainTail(chainFile, maxBytes) {
  const fsSync = require('fs');
  let fd = null;
  try {
    const stat = fsSync.statSync(chainFile);
    const len = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(len);
    fd = fsSync.openSync(chainFile, 'r');
    fsSync.readSync(fd, buf, 0, len, stat.size - len);
    const text = buf.toString('utf8');

    const marker = '\n{\n';
    const starts = [];
    let i = text.indexOf(marker);
    while (i !== -1) { starts.push(i + 1); i = text.indexOf(marker, i + 1); }

    const blocks = [];
    for (let k = 0; k < starts.length; k++) {
      const from = starts[k];
      const to = k + 1 < starts.length ? starts[k + 1] : text.length;
      let slice = text.slice(from, to).trimEnd();
      if (slice.endsWith(']')) slice = slice.slice(0, -1).trimEnd();
      if (slice.endsWith(',')) slice = slice.slice(0, -1);
      try { blocks.push(JSON.parse(slice)); } catch { /* truncated tail block */ }
    }
    return blocks;
  } catch {
    return [];
  } finally {
    if (fd !== null) { try { fsSync.closeSync(fd); } catch {} }
  }
}

class AnkhChainAPI {
  constructor(ankh) {
    this.blockchain = ankh.blockchain;
    this.stateManager = ankh.stateManager;
    this.network = ankh.network;
    this.biometricVerifier = ankh.biometricVerifier;
    this.ubiEngine = ankh.ubiEngine;
    this.tokenFactory = ankh.tokenFactory;
    this.sidechainManager = ankh.sidechainManager;
    this.pegMechanism = ankh.pegMechanism;
    this.nodeIdentity = ankh.nodeIdentity;        // secp256k1 keypair for signing verificationProofs
    this.foundationCouncil = ankh.foundationCouncil || { threshold: 1, members: [] };

    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });

    this.wsClients = new Set();

    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();

    // Patch res.json to handle BigInt serialization (BigInt not natively serializable)
    this.app.set('json replacer', (_, v) => typeof v === 'bigint' ? v.toString() : v);
  }

  /**
   * Setup Express middleware
   */
  setupMiddleware() {
    // Trust reverse proxy so X-Forwarded-For is handled correctly by rate limiter
    this.app.set('trust proxy', 1);

    this.app.use(helmet());
    this.app.use(cors());
    this.app.use(compression());
    this.app.use(express.json({ limit: '10mb' }));

    // Rate limiting
    const limiter = rateLimit({
      windowMs: 60 * 1000,
      max: 300,
      message: { error: 'Too many requests, please try again later' }
    });
    this.app.use(limiter);

    // The general limit (300/min) is sized for reads. These routes each cost
    // real money or real work — they stake funds, create chains, or run face
    // inference — so they get their own much tighter budget per IP.
    const writeLimiter = rateLimit({
      windowMs: 60 * 1000,
      max: 10,
      message: { success: false, error: 'Too many write requests — slow down' },
    });
    for (const path of [
      '/api/v1/sidechains/propose',
      '/api/v1/tokens/create',
      '/api/v1/stake',
      '/api/v1/unstake',
      '/api/v1/governance/propose',
      '/api/v1/governance/vote',
      '/api/v1/send',
    ]) {
      this.app.use(path, writeLimiter);
    }

    // Personhood is a public lookup others build on, so it gets a higher
    // ceiling than writes but a lower one than general reads — it should be
    // usable by an application without becoming a way to enumerate the register.
    this.app.use('/api/v1/personhood', rateLimit({
      windowMs: 60 * 1000,
      max: 60,
      message: { success: false, error: 'Personhood lookup rate exceeded' },
    }));

    // Request logging
    this.app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const duration = Date.now() - start;
        if (duration > 1000) {
          console.log(`Slow request: ${req.method} ${req.path} - ${duration}ms`);
        }
      });
      next();
    });
  }

  /**
   * Setup API routes
   */
  setupRoutes() {
    const router = express.Router();

    // ============================================
    // Chain Info
    // ============================================

    router.get('/info', (req, res) => {
      res.json({
        success: true,
        data: this.blockchain.getChainInfo()
      });
    });

    // ============================================
    // Faucet — development chains only
    // ============================================
    //
    // Funding alone is not enough to unblock a developer: TokenFactory and
    // SIDECHAIN_CREATE both refuse an account that is not biometrically
    // verified, so on a throwaway chain the faucet marks the account verified
    // too. That is precisely why it must never be reachable on mainnet — it
    // would mint supply and hand out personhood for free.
    //
    // Two independent gates, because either one alone is a single typo away
    // from being catastrophic: the flag must be on AND the chain must not be
    // mainnet. `server.js --dev` sets both.
    const faucetEnabled = () =>
      process.env.ANKH_FAUCET === '1' && GenesisConfig.CHAIN_ID !== 'ankh-mainnet-1';

    const faucetLast = new Map();          // address → timestamp of last drip
    const FAUCET_AMOUNT = 1_000_000n * (10n ** 18n);   // clears every tier, incl. SOVEREIGN
    const FAUCET_COOLDOWN_MS = 60 * 60 * 1000;

    // The routes are registered only when the faucet is actually on. Registering
    // them always and refusing per-request would leave code that mints supply and
    // grants personhood reachable in the mainnet process, with a single boolean
    // between it and free money. On mainnet these handlers do not exist at all.
    if (faucetEnabled()) {

    router.get('/faucet', (req, res) => {
      res.json({
        success: true,
        data: {
          enabled: faucetEnabled(),
          chainId: GenesisConfig.CHAIN_ID,
          amount: FAUCET_AMOUNT.toString(),
          amountFormatted: '1000000 ANKH',
          cooldownMs: FAUCET_COOLDOWN_MS,
          marksVerified: true
        }
      });
    });

    router.post('/faucet', (req, res) => {
      if (!faucetEnabled()) {
        return res.status(403).json({
          success: false,
          error: GenesisConfig.CHAIN_ID === 'ankh-mainnet-1'
            ? 'Faucet is permanently disabled on mainnet'
            : 'Faucet is disabled. Start the node with --faucet or --dev.'
        });
      }

      const { address } = req.body || {};
      if (typeof address !== 'string' || !/^ankh_[0-9a-f]{40}$/.test(address)) {
        return res.status(400).json({ success: false, error: 'address must be an ankh_ address (40 hex chars)' });
      }

      const now = Date.now();
      const last = faucetLast.get(address) || 0;
      if (now - last < FAUCET_COOLDOWN_MS) {
        return res.status(429).json({
          success: false,
          error: 'Cooldown active',
          retryAfterMs: FAUCET_COOLDOWN_MS - (now - last)
        });
      }

      try {
        this.stateManager.updateBalance(address, FAUCET_AMOUNT);

        // Give the account personhood so it can create tokens and sidechains.
        // The digest is random rather than derived from a face: on a dev chain
        // there is nothing to be unique against, and it must never collide with
        // a real registration.
        const account = this.stateManager.getAccount(address);
        if (!account.isVerified) {
          const digest = crypto.randomBytes(32).toString('hex');
          try {
            this.stateManager.registerVerifiedUser(
              address,
              { hash: digest, templateHash: digest, descriptor: null },
              { estimatedAge: 30, confidenceScore: 0.9 }
            );
          } catch { /* already registered — the flag below is what matters */ }
          this.stateManager.getAccount(address).isVerified = true;
        }

        faucetLast.set(address, now);
        const balance = this.stateManager.getAccount(address).balance;

        res.json({
          success: true,
          data: {
            address,
            funded: FAUCET_AMOUNT.toString(),
            balance: balance.toString(),
            isVerified: true,
            chainId: GenesisConfig.CHAIN_ID
          }
        });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    }   // end faucet routes — absent entirely unless enabled

    // Biometric subsystem health — verification outcomes, descriptor store size
    // and duplicate-search efficiency. Previously there was no way to observe
    // any of this from outside the process.
    router.get('/verification/stats', (req, res) => {
      if (!this.biometricVerifier) {
        return res.status(503).json({ success: false, error: 'Biometric verifier not initialised' });
      }
      res.json({ success: true, data: this.biometricVerifier.getStats() });
    });

    router.get('/stats', (req, res) => {
      const networkStats = this.network?.getStats() || {};
      res.json({
        success: true,
        data: {
          ...this.blockchain.getStats(),
          connectedPeers: networkStats.connectedPeers || 0,
          knownPeers: networkStats.knownPeers || 0
        }
      });
    });

    router.get('/genesis', (req, res) => {
      res.json({
        success: true,
        data: {
          chainId: GenesisConfig.CHAIN_ID,
          chainName: GenesisConfig.CHAIN_NAME,
          maxPopulation: GenesisConfig.MAX_GLOBAL_POPULATION.toString(),
          lifetimeValue: GenesisConfig.LIFETIME_VALUE_USD.toString(),
          monthlyUBI: GenesisConfig.MONTHLY_UBI_AMOUNT.toString(),
          distributionMonths: GenesisConfig.DISTRIBUTION_MONTHS,
          vestingStartAge: GenesisConfig.VESTING_START_AGE,
          consensus: GenesisConfig.CONSENSUS,
          tokenTiers: this.tokenFactory.getTierRequirements()
        }
      });
    });

    // ============================================
    // Blocks
    // ============================================

    router.get('/blocks/latest', (req, res) => {
      const block = this.blockchain.getLatestBlock();
      res.json({ success: true, data: block.toJSON() });
    });

    router.get('/blocks/:index', (req, res) => {
      const index = parseInt(req.params.index);
      const block = this.blockchain.getBlockByIndex(index);

      if (!block) {
        return res.status(404).json({ success: false, error: 'Block not found' });
      }

      res.json({ success: true, data: block.toJSON() });
    });

    router.get('/blocks', (req, res) => {
      const limit = Math.min(parseInt(req.query.limit) || 10, 100);
      const offset = parseInt(req.query.offset) || 0;
      const height = this.blockchain.getHeight();

      const blocks = [];
      for (let i = height - offset; i > height - offset - limit && i >= 0; i--) {
        const block = this.blockchain.getBlockByIndex(i);
        if (block) {
          blocks.push({
            index: block.index,
            hash: block.hash,
            timestamp: block.timestamp,
            transactionCount: block.transactions.length,
            validator: block.validator
          });
        }
      }

      res.json({ success: true, data: { blocks, total: height + 1 } });
    });

    // ============================================
    // Accounts
    // ============================================

    router.get('/accounts/:address', (req, res) => {
      const account = this.blockchain.getAccount(req.params.address);
      res.json({ success: true, data: account });
    });

    router.get('/accounts/:address/balance', (req, res) => {
      const balance = this.stateManager.getBalance(req.params.address);
      res.json({
        success: true,
        data: {
          address: req.params.address,
          balance: balance.toString(),
          balanceFormatted: (Number(balance) / 1e18).toFixed(4) + ' ANKH'
        }
      });
    });

    // ============================================
    // UBI
    // ============================================

    router.get('/ubi/stats', (req, res) => {
      res.json({
        success: true,
        data: this.ubiEngine.getGlobalStats()
      });
    });

    router.get('/ubi/:address/status', (req, res) => {
      const status = this.ubiEngine.getStatus(req.params.address);

      if (!status) {
        return res.status(404).json({
          success: false,
          error: 'No UBI allocation found. User must be verified first.'
        });
      }

      res.json({ success: true, data: status });
    });

    router.post('/ubi/:address/claim', async (req, res) => {
      try {
        const claimAddress = req.params.address;
        const Transaction = require('../core/Transaction');

        // Look up the user's verification record for the on-chain tx data
        const verifiedUser = this.stateManager.getVerifiedUser(claimAddress);
        if (!verifiedUser) {
          return res.status(404).json({
            success: false,
            error: 'No UBI allocation found. User must be verified first.'
          });
        }

        const allocation = this.stateManager.ubiAllocations.get(claimAddress);
        if (!allocation) {
          return res.status(404).json({
            success: false,
            error: 'No UBI allocation found. User must be verified first.'
          });
        }

        const nonce = this.stateManager.getAccount(claimAddress).nonce;
        const claimMonth = (allocation.monthsClaimed || 0) + 1;

        const tx = Transaction.createUBIClaim(
          claimAddress,
          verifiedUser.verificationId,
          claimMonth,
          allocation.monthlyAmount,  // amount (BigInt)
          0n,                         // fee
          nonce
        );

        // Commit to blockchain — executeUBIClaim → stateManager.processUBIClaim
        // which credits the balance and advances nextClaimAvailable
        const { block } = await this.blockchain.commitSystemBlock([tx]);

        // Build response from updated state
        const ubiStatus = this.stateManager.getUBIStatus(claimAddress);

        // Broadcast update
        this.broadcastToClients({
          type: 'UBI_CLAIMED',
          address: claimAddress,
          amount: allocation.monthlyAmount.toString(),
          blockIndex: block.index,
          blockHash: block.hash
        });

        res.json({
          success: true,
          data: {
            ...ubiStatus,
            // Keep 'amount' for frontend compatibility (claimNativeUBI reads result.amount)
            amount: allocation.monthlyAmount.toString(),
            blockIndex: block.index,
            blockHash: block.hash
          }
        });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // ============================================
    // Verification
    // ============================================

    // ============================================
    // Active illumination challenge
    // ============================================
    //
    // The node chooses a random colour sequence per session. The client's screen
    // flashes it during capture and returns the frames, and the node checks the
    // light on the face actually followed the sequence *it* picked — something
    // no recording made beforehand can do. See LivenessChallenge for the full
    // reasoning and for what this does and does not establish.
    const LivenessChallenge = require('../verification/LivenessChallenge');
    const challenges = new Map();   // id -> challenge, swept on issue

    router.post('/verify/challenge', (req, res) => {
      if (!GenesisConfig.BIOMETRIC.LIVENESS_CHALLENGE.ENABLED) {
        return res.json({ success: true, data: { enabled: false } });
      }
      const now = Date.now();
      for (const [id, c] of challenges) if (c.expiresAt < now) challenges.delete(id);
      // A challenge is single-use and short-lived, so an unbounded map is not a
      // risk, but cap it anyway rather than trust that.
      if (challenges.size > 10000) {
        return res.status(503).json({ success: false, error: 'Too many challenges in flight — retry shortly' });
      }
      const challenge = LivenessChallenge.issue();
      challenges.set(challenge.id, challenge);
      res.json({
        success: true,
        data: {
          enabled: true,
          id: challenge.id,
          colors: challenge.colors,      // what the screen must show, in order
          holdMs: challenge.holdMs,
          expiresAt: challenge.expiresAt
        }
      });
    });

    /** Decode the client's flash frames and score them against their challenge. */
    const scoreFlashChallenge = (challengeId, flashFrames) => {
      if (!GenesisConfig.BIOMETRIC.LIVENESS_CHALLENGE.ENABLED) return null;
      if (!challengeId) return { passed: false, reason: 'No liveness challenge was requested', skipped: true };

      const challenge = challenges.get(challengeId);
      // Single use: consumed whether it passes or fails, so a captured sequence
      // cannot be replayed against the same id.
      challenges.delete(challengeId);
      if (!challenge) return { passed: false, reason: 'Liveness challenge not found or already used' };

      if (!Array.isArray(flashFrames) || !flashFrames.length) {
        return { passed: false, reason: 'No illumination frames were submitted' };
      }

      // jpeg-js is a declared dependency, but a node with an incomplete install
      // must not take the whole endpoint down over an optional check. Without a
      // decoder the challenge simply cannot be scored: advisory mode carries on
      // and says so, enforcing mode fails closed rather than waving it through.
      let jpeg;
      try {
        jpeg = require('jpeg-js');
      } catch {
        return {
          passed: false,
          unavailable: true,
          reason: 'This node cannot decode illumination frames (jpeg-js missing) — run npm install'
        };
      }

      const rasters = [];
      for (const f of flashFrames.slice(0, 16)) {
        try {
          const b64 = String(f.image || '').split(',').pop();
          const buf = Buffer.from(b64, 'base64');
          if (buf.length > 3_000_000) continue;
          const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
          rasters.push({ step: Number(f.step), raster: img });
        } catch { /* a frame that will not decode simply does not count */ }
      }
      return LivenessChallenge.analyze(challenge, rasters);
    };

    router.post('/verify', async (req, res) => {
      try {
        const { address, biometricData } = req.body;

        if (!address || !biometricData) {
          return res.status(400).json({
            success: false,
            error: 'Address and biometricData required'
          });
        }

        const clientIp = req.ip || req.socket?.remoteAddress || null;
        const startedAt = Date.now();

        // Scored before the heavy pipeline runs, because when this is enforced
        // it is the cheapest way to turn away a presentation attack.
        const flash = scoreFlashChallenge(req.body.challengeId, req.body.flashFrames);
        if (flash) {
          console.log(
            `[Flash] ${flash.passed ? 'pass' : 'fail'} ${address} ` +
            `temporal=${flash.temporal ?? 'n/a'} response=${flash.response ?? 'n/a'} ` +
            `spatial=${flash.spatial ?? 'n/a'} frames=${flash.framesUsed ?? 0}` +
            (flash.passed ? '' : ` reason=${JSON.stringify(flash.reason || '')}`) +
            (GenesisConfig.BIOMETRIC.LIVENESS_CHALLENGE.ENFORCE ? '' : ' (advisory)')
          );
          if (!flash.passed && GenesisConfig.BIOMETRIC.LIVENESS_CHALLENGE.ENFORCE) {
            // A node that cannot decode frames is misconfigured, not a submitter
            // mounting an attack — say which it is rather than accusing them.
            return res.status(flash.unavailable ? 503 : 400).json({
              success: false,
              error: flash.reason,
              step: 'LIVENESS_CHALLENGE'
            });
          }
        }

        const result = await this.biometricVerifier.verify(address, biometricData, clientIp);

        // Record the outcome. Nothing here logged what happened, so a user
        // reporting "verification failed" left no trace on the node at all and
        // the only way to find out why was to guess. The step that failed and
        // the reason are what make a support report actionable.
        //
        // Deliberately excludes every biometric value: no descriptor, no
        // landmarks, no image. Those are the things that must never reach a log
        // file. The address is already public on-chain, so it is safe to keep
        // and is what ties a report to a session.
        try {
          const ms = Date.now() - startedAt;
          const steps = Array.isArray(result.steps) ? result.steps : [];
          const trail = steps.map(s => `${s.step}:${s.passed ? 'ok' : 'FAIL'}`).join(' ');
          const failedAt = steps.find(s => s.passed === false)?.step || (result.success ? null : 'UNKNOWN');
          console.log(
            `[Verify] ${result.success ? 'PASS' : 'FAIL'} ${address} ${ms}ms` +
            (result.success ? '' : ` at=${failedAt} reason=${JSON.stringify(result.reason || '')}`) +
            ` steps=[${trail}]`
          );
        } catch { /* logging must never break a verification */ }

        if (result.success) {
          const Transaction = require('../core/Transaction');

          // Build a BIOMETRIC_REGISTRATION transaction.
          // from = user's address so executeBiometricRegistration registers the right person.
          // Fee = 0 (first-time verification is free).
          // Nonce = current nonce for this address (may be 0 for a brand-new account).
          const nonce = this.stateManager.getAccount(address).nonce;
          const livenessScore = result.steps.find(s => s.step === 'LIVENESS_DETECTION')?.avgMovementScore || 0;
          const qualityScore  = result.steps.find(s => s.step === 'QUALITY_CHECK')?.quality || 0;

          // Normalise ageVerification field names for executeBiometricRegistration
          // The verifier returns { estimatedAge, confidence, method } but the
          // transaction executor and GenesisConfig.isAgeEligible use { estimatedAge, confidenceScore }
          const ageVerificationNorm = {
            estimatedAge:    result.ageVerification?.estimatedAge || 25,
            confidenceScore: result.ageVerification?.confidence   || result.ageVerification?.confidenceScore || 0.88,
            method:          result.ageVerification?.method       || 'ML_FACIAL_ESTIMATION'
          };

          const descriptor = Array.isArray(biometricData.facial?.descriptor) &&
            biometricData.facial.descriptor.length === 128
              ? Array.from(biometricData.facial.descriptor) : null;

          // Build multi-sig verificationProof: this node's signature + any registered peer
          // votes collected during the P2P consensus round that runs inside verify().
          // executeBiometricRegistration will verify each signature against the registry.
          let verificationProof = null;
          if (this.nodeIdentity) {
            const { ec: EC } = require('elliptic');
            const ec = new EC('secp256k1');
            const nodeKey = ec.keyFromPrivate(this.nodeIdentity.privateKey, 'hex');
            const msgHash = crypto.createHash('sha256').update(result.biometricHash).digest('hex');
            const sig = nodeKey.sign(msgHash);
            const ownVote = {
              publicKey: this.nodeIdentity.publicKey,
              signature: { r: sig.r.toString('hex'), s: sig.s.toString('hex'), recoveryParam: sig.recoveryParam }
            };

            // Peer votes collected via VERIFICATION_REQUEST/VOTE consensus
            const peerVotes = result.verificationId
              ? (this.biometricVerifier.getApprovedVotes(result.verificationId) || [])
              : [];

            // ── Capture attestations ────────────────────────────────────
            // This node signs what it measured, and attaches what each peer
            // independently measured. Together these are what let a validator
            // that never saw the images confirm the capture met the standard,
            // instead of taking this node's word for it.
            const attestations = [];
            if (GenesisConfig.BIOMETRIC.CAPTURE_ATTESTATION.PRODUCE && result.captureMeasurement) {
              const CaptureAttestation = require('../core/CaptureAttestation');
              try {
                attestations.push(CaptureAttestation.sign(result.captureMeasurement, this.nodeIdentity));
              } catch (err) {
                console.warn(`[API] could not sign capture attestation: ${err.message}`);
              }
            }
            if (result.verificationId) {
              attestations.push(...(this.biometricVerifier.getCaptureAttestations(result.verificationId) || []));
            }

            verificationProof = { votes: [ownVote, ...peerVotes], attestations };
          }

          const tx = Transaction.createBiometricRegistration(
            address,
            {
              hash: result.biometricHash,
              templateHash: result.biometricHash,
              descriptor,
              livenessScore,
              qualityScore
            },
            ageVerificationNorm,
            0n,     // fee
            nonce,
            verificationProof
          );

          // Commit to blockchain — creates a SYSTEM block, saves chain + state
          const { block } = await this.blockchain.commitSystemBlock([tx]);

          // Initialize UBI allocation with richer fields (status:'ACTIVE', pause hooks, etc.)
          // This overwrites the simpler allocation created inside registerVerifiedUser.
          this.ubiEngine.initializeAllocation(address);
          await this.stateManager.saveState();

          this.broadcastToClients({
            type: 'USER_VERIFIED',
            address,
            verificationId: result.verificationId,
            blockIndex: block.index,
            blockHash: block.hash
          });
        }

        res.json({ success: true, data: result });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // ── Capture fidelity report ───────────────────────────────────────────
    //
    // Answers the question an operator actually needs answered before trusting
    // the register: are registrations being captured to the standard, and can I
    // check that rather than assume it?
    //
    // It re-validates the attestations on recent registrations using THIS node's
    // thresholds — the same code path block validation uses — and reports what
    // it found. Nothing here is taken from the producing node's say-so.
    //
    // It is also the cutover instrument: `readyToEnforce` says whether turning
    // ANKH_ENFORCE_ATTESTATION on would start rejecting live traffic.
    router.get('/fidelity', (req, res) => {
      try {
        const CaptureAttestation = require('../core/CaptureAttestation');
        const cfg = GenesisConfig.BIOMETRIC.CAPTURE_ATTESTATION;
        // The in-memory chain keeps only blocks since startup, so sampling it
        // would report on a handful of blocks and call it the network's state.
        // Read the tail of chain.json instead and say plainly how far back the
        // sample actually reached.
        const mb = Math.min(Math.max(parseInt(req.query.mb, 10) || 12, 1), 128);
        const chain = readChainTail(this.blockchain.chainFile, mb * 1024 * 1024);
        const start = 0;
        const enforceRegistry = this.stateManager.registeredNodes.size > 0;
        const isRegistered = (pk) => !enforceRegistry ||
          this.stateManager.isNodeRegistered(pk) || this.blockchain.trustedNodeKeys.has(pk);

        let total = 0, attested = 0, wouldPass = 0;
        const signerCounts = {};
        const failures = [];

        for (let i = start; i < chain.length; i++) {
          for (const tx of (chain[i].transactions || [])) {
            if (tx.type !== 'BIOMETRIC_REGISTRATION') continue;
            total++;
            const atts = tx.data?.verificationProof?.attestations;
            if (!Array.isArray(atts) || atts.length === 0) continue;
            attested++;

            const check = CaptureAttestation.validateSet(atts, {
              address: tx.from,
              biometricHash: tx.data?.biometricHash,
              descriptor: tx.data?.descriptor,
              isRegistered
            });
            signerCounts[check.signers] = (signerCounts[check.signers] || 0) + 1;
            if (check.valid) wouldPass++;
            else if (failures.length < 10) {
              failures.push({ block: chain[i].index, address: tx.from, reason: check.reason });
            }
          }
        }

        res.json({
          success: true,
          data: {
            posture: {
              producingAttestations: cfg.PRODUCE,
              enforcingAttestations: cfg.ENFORCE,
              minSigners: cfg.MIN_SIGNERS,
              requiresFusedCapture: GenesisConfig.BIOMETRIC.REQUIRE_FUSED_CAPTURE,
              serverSideInference: GenesisConfig.BIOMETRIC.SERVER_SIDE_INFERENCE,
              consensusMinVotes: GenesisConfig.BIOMETRIC.CONSENSUS_MIN_VOTES,
              registeredNodes: this.stateManager.registeredNodes.size
            },
            thresholds: {
              samePerson: GenesisConfig.BIOMETRIC.SAME_PERSON_THRESHOLD,
              reviewBand: GenesisConfig.BIOMETRIC.REVIEW_BAND,
              frameCohesionMax: GenesisConfig.BIOMETRIC.FRAME_COHESION_MAX,
              framesMinAccepted: GenesisConfig.BIOMETRIC.FRAMES_MIN_ACCEPTED,
              frameQuality: GenesisConfig.BIOMETRIC.FRAME_QUALITY
            },
            sampled: {
              blocks: chain.length,
              fromBlock: chain.length ? chain[0].index : null,
              toBlock: chain.length ? chain[chain.length - 1].index : null,
              megabytesScanned: mb,
              registrations: total,
              withAttestations: attested,
              wouldPassEnforcement: wouldPass,
              signerDistribution: signerCounts
            },
            // True only when every sampled registration would survive
            // enforcement. Switching on before this is true means rejecting
            // registrations that the network already accepted.
            readyToEnforce: total > 0 && wouldPass === total,
            failures
          }
        });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    router.get('/verify/:address/status', (req, res) => {
      const user = this.blockchain.getVerifiedUser(req.params.address);

      if (!user) {
        return res.json({
          success: true,
          data: { isVerified: false }
        });
      }

      // Age estimate and verification id are deliberately not returned: this
      // endpoint is public and unauthenticated, so anyone could otherwise read
      // any person's estimated age off their address. Callers that need proof of
      // personhood should use /personhood/:address, which returns a signed
      // attestation and no personal detail at all.
      res.json({
        success: true,
        data: {
          isVerified: true,
          registrationTimestamp: user.registrationTimestamp,
          ageEligible: !!user.ageVerification
        }
      });
    });

    // ── Proof of personhood as a service ──────────────────────────────────
    //
    // The point of this chain is a register of unique humans. That register is
    // only useful to anyone else if they can query it without running a node
    // and without taking our word for the answer.
    //
    // So the response carries a signature from the answering node over a
    // canonical claim. A caller verifies it by checking the signature against
    // the public key, confirming the key derives to the node address, and
    // confirming that node appears in the on-chain registry at /nodes. At no
    // point do they have to trust this server — and no biometric data, age,
    // verification id or allocation detail is exposed.
    router.get('/personhood/:address', (req, res) => {
      const address = req.params.address;
      if (!address || !address.startsWith('ankh_')) {
        return res.status(400).json({ success: false, error: 'Invalid ANKH address' });
      }

      const user = this.blockchain.getVerifiedUser(address);
      const isHuman = !!user;

      // Month granularity only. An exact registration timestamp is close to a
      // unique identifier and is not needed to answer the question.
      const since = isHuman && user.registrationTimestamp
        ? new Date(user.registrationTimestamp).toISOString().slice(0, 7)
        : null;

      const issuedAt = Date.now();
      const expiresAt = issuedAt + 5 * 60 * 1000;
      const claim = JSON.stringify({ address, isHuman, since, issuedAt, expiresAt });

      let attestation = null;
      const identity = this.blockchain.nodeIdentity;
      if (identity?.privateKey) {
        try {
          const { ec: EC } = require('elliptic');
          const ec = new EC('secp256k1');
          const key = ec.keyFromPrivate(identity.privateKey, 'hex');
          const msgHash = crypto.createHash('sha256').update(claim).digest('hex');
          const sig = key.sign(msgHash);
          attestation = {
            claim,
            nodeAddress: identity.address,
            publicKey: identity.publicKey,
            signature: { r: sig.r.toString(16).padStart(64, '0'), s: sig.s.toString(16).padStart(64, '0') },
            algorithm: 'secp256k1/sha256',
            verifyWith: '/api/v1/nodes — the signing node must appear there and be active'
          };
        } catch (err) {
          console.warn('[Personhood] could not sign attestation:', err.message);
        }
      }

      res.json({ success: true, data: { address, isHuman, since, issuedAt, expiresAt, attestation } });
    });

    // ── Sign in with ANKH ─────────────────────────────────────────────────
    //
    // /personhood/:address answers "is this a person", but on its own that is
    // not a login: anyone can name someone else's address. To prove the visitor
    // *controls* the address, they sign a challenge this node issued.
    //
    // The relying site never handles a key, never sees biometric data, and does
    // not have to trust this node either — the result is signed, and the signer
    // is checkable against the on-chain node registry.
    router.post('/personhood/challenge', (req, res) => {
      const { address } = req.body || {};
      if (!address || !address.startsWith('ankh_')) {
        return res.status(400).json({ success: false, error: 'Invalid ANKH address' });
      }
      const nonce = crypto.randomBytes(24).toString('hex');
      const issuedAt = Date.now();
      const expiresAt = issuedAt + 5 * 60 * 1000;
      // Stateless: the challenge carries its own integrity tag, so nothing has
      // to be remembered between the two requests and any node can verify a
      // challenge another issued.
      const payload = JSON.stringify({ address, nonce, issuedAt, expiresAt });
      const tag = crypto.createHmac('sha256', this._challengeSecret()).update(payload).digest('hex');
      res.json({ success: true, data: { challenge: payload, tag, expiresAt } });
    });

    router.post('/personhood/verify', (req, res) => {
      const { challenge, tag, signature } = req.body || {};
      if (!challenge || !tag || !signature) {
        return res.status(400).json({ success: false, error: 'challenge, tag and signature are required' });
      }

      // The challenge must be one we issued and must not have been edited.
      const expected = crypto.createHmac('sha256', this._challengeSecret()).update(challenge).digest('hex');
      if (!crypto.timingSafeEqual(Buffer.from(tag), Buffer.from(expected))) {
        return res.status(400).json({ success: false, error: 'Challenge was not issued by this node' });
      }

      let parsed;
      try { parsed = JSON.parse(challenge); } catch { return res.status(400).json({ success: false, error: 'Malformed challenge' }); }
      if (Date.now() > parsed.expiresAt) {
        return res.status(400).json({ success: false, error: 'Challenge expired' });
      }

      // The signature must come from the key that owns the address.
      const ActionAuth = require('../core/ActionAuth');
      const auth = ActionAuth.verify(parsed.address, challenge, signature);
      if (!auth.valid) {
        return res.status(401).json({ success: false, error: `Signature rejected: ${auth.reason}` });
      }

      const user = this.blockchain.getVerifiedUser(parsed.address);
      res.json({
        success: true,
        data: {
          address: parsed.address,
          controlsAddress: true,
          isHuman: !!user,
          since: user?.registrationTimestamp
            ? new Date(user.registrationTimestamp).toISOString().slice(0, 7) : null,
          verifiedAt: Date.now(),
        },
      });
    });

    // Batch form, so an application checking many accounts does not have to
    // make one request per account. Capped to keep it from becoming a way to
    // enumerate the register.
    router.post('/personhood/batch', (req, res) => {
      const list = Array.isArray(req.body?.addresses) ? req.body.addresses : null;
      if (!list) return res.status(400).json({ success: false, error: 'addresses[] required' });
      if (list.length > 100) return res.status(400).json({ success: false, error: 'Maximum 100 addresses per request' });

      const results = list.map(a => ({
        address: a,
        isHuman: typeof a === 'string' && a.startsWith('ankh_') ? !!this.blockchain.getVerifiedUser(a) : false
      }));
      res.json({ success: true, data: { results, checked: results.length } });
    });

    // ============================================
    // Reserve
    // ============================================

    /**
     * POST /reserve/release
     * Release funds from a named reserve wallet.
     *
     * Body:
     *   reserveType  — 'main' | 'foundation' | 'development' | 'ecosystem' | 'emergency'
     *   toAddress    — destination ankh_ address
     *   amount       — amount in ANKH (e.g. "1000.5")
     *   reason       — human-readable reason (recorded on-chain)
     *   signature    — { r, s } signed by the reserve wallet's private key over
     *                  SHA256(reserveType + toAddress + rawAmount)
     */
    router.post('/reserve/release', async (req, res) => {
      try {
        const { reserveType, toAddress, amount, reason, signature } = req.body;

        if (!reserveType || !toAddress || !amount || !signature?.r || !signature?.s) {
          return res.status(400).json({ success: false, error: 'Missing required fields: reserveType, toAddress, amount, signature {r,s}' });
        }

        const reserveAddress = this.stateManager.reserveAddresses.get(reserveType);
        if (!reserveAddress) {
          return res.status(400).json({ success: false, error: `Unknown reserve type: ${reserveType}. Valid: main, foundation, development, ecosystem, emergency` });
        }

        // Verify signature — must be signed by the reserve wallet's private key
        const crypto      = require('crypto');
        const { ec: EC }  = require('elliptic');
        const rawAmount   = BigInt(Math.round(parseFloat(amount) * 1e18)).toString();
        const msgHash     = crypto.createHash('sha256')
          .update(reserveType + toAddress + rawAmount)
          .digest('hex');

        // Recover public key from the reserve address to verify
        const reserveAccount = this.stateManager.getAccount(reserveAddress);
        const storedPubKey   = reserveAccount?.publicKey;
        if (!storedPubKey) {
          return res.status(403).json({ success: false, error: 'Reserve wallet public key not registered on-chain. Send a TRANSFER from the reserve address first to register it.' });
        }

        const ec  = new EC('secp256k1');
        const key = ec.keyFromPublic(storedPubKey, 'hex');
        if (!key.verify(msgHash, { r: signature.r, s: signature.s })) {
          return res.status(403).json({ success: false, error: 'Invalid signature — must be signed by the reserve wallet private key' });
        }

        const Transaction = require('../core/Transaction');
        const account     = this.stateManager.getAccount(reserveAddress);
        const tx = Transaction.createReserveRelease(
          reserveAddress,
          toAddress,
          BigInt(rawAmount),
          reserveType,
          reason || '',
          0n,
          account.nonce
        );

        const { block } = await this.blockchain.commitSystemBlock([tx]);

        res.json({
          success: true,
          data: {
            blockIndex:  block.index,
            txHash:      tx.hash,
            reserveType,
            from:        reserveAddress,
            to:          toAddress,
            amount:      (Number(rawAmount) / 1e18).toFixed(4) + ' ANKH',
            reason:      reason || ''
          }
        });
      } catch (err) {
        res.status(400).json({ success: false, error: err.message });
      }
    });

    // ============================================
    // Transactions
    // ============================================

    router.post('/transactions', async (req, res) => {
      try {
        const Transaction = require('../core/Transaction');
        const tx = Transaction.fromJSON(req.body);

        const hash = this.blockchain.addTransaction(tx);

        // Broadcast to network
        if (this.network) {
          this.network.broadcastTransaction(tx);
        }

        res.json({ success: true, data: { hash } });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    router.get('/transactions/pending', (req, res) => {
      const pending = this.blockchain.pendingTransactions.map(tx => tx.toJSON());
      res.json({ success: true, data: pending });
    });

    // Look up a confirmed transaction by hash — scans chain from tip backwards
    router.get('/transactions/:hash', (req, res) => {
      const targetHash = req.params.hash;
      const chain = this.blockchain.chain;
      for (let i = chain.length - 1; i >= 0; i--) {
        const block = chain[i];
        const tx = block.transactions.find(t => t.hash === targetHash);
        if (tx) {
          return res.json({
            success: true,
            data: {
              ...tx.toJSON(),
              blockIndex: block.index,
              blockHash: block.hash,
              blockTimestamp: block.timestamp,
              confirmed: true
            }
          });
        }
      }
      // Not in chain — check mempool
      const pending = this.blockchain.pendingTransactions.find(t => t.hash === targetHash);
      if (pending) {
        return res.json({ success: true, data: { ...pending.toJSON(), confirmed: false, blockIndex: null } });
      }
      res.status(404).json({ success: false, error: 'Transaction not found' });
    });

    // ============================================
    // Send — requires secp256k1 signature from the sender's private key
    // ============================================

    // Helper: verify a secp256k1 signature and confirm publicKey → address.
    // message is a JSON-stringified object; the address field is checked against
    // the derived address from the public key.
    const verifySignedAction = (address, message, signature) => {
      if (!signature || !signature.publicKey || !signature.r || !signature.s) return false;
      try {
        const { ec: EC } = require('elliptic');
        const ec = new EC('secp256k1');

        // Derive address from claimed public key — must match `address`
        const pubBytes = Buffer.from(signature.publicKey, 'hex');
        const derived  = 'ankh_' + crypto
          .createHash('sha256')
          .update(pubBytes)
          .digest('hex')
          .substring(0, 40);
        if (derived !== address) {
          console.warn('[Auth] publicKey→address mismatch: derived', derived, 'expected', address);
          return false;
        }

        const msgHash = crypto.createHash('sha256').update(message).digest();
        const key     = ec.keyFromPublic(signature.publicKey, 'hex');
        const ok      = key.verify(msgHash, { r: signature.r, s: signature.s });
        if (!ok) console.warn('[Auth] signature invalid for address', address);
        return ok;
      } catch (err) {
        console.warn('[Auth] signature verify error:', err.message);
        return false;
      }
    };

    // Helper: verify a secp256k1 signature and confirm publicKey → from address
    const verifySendSignature = (body) => {
      const ActionAuth = require('../core/ActionAuth');
      const { from, to, amount, timestamp, signature } = body;
      const message = ActionAuth.transferMessage({ from, to, amount, timestamp });
      return ActionAuth.verify(from, message, signature).valid;
    };

    router.post('/send', async (req, res) => {
      try {
        const Transaction = require('../core/Transaction');
        const { from, to, amount, timestamp, signature } = req.body;

        if (!from || !to || !amount) {
          return res.status(400).json({
            success: false,
            error: 'from, to, and amount are required'
          });
        }
        if (from === to) {
          return res.status(400).json({ success: false, error: 'Cannot send to yourself' });
        }

        // Validate addresses
        if (!from.startsWith('ankh_') || !to.startsWith('ankh_')) {
          return res.status(400).json({ success: false, error: 'Invalid ANKH address format' });
        }

        // Reject unsigned requests
        if (!verifySendSignature(req.body)) {
          return res.status(401).json({ success: false, error: 'Invalid or missing signature' });
        }

        // Reject replayed transactions (timestamp must be within 5 minutes)
        if (!timestamp || Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) {
          return res.status(400).json({ success: false, error: 'Request timestamp expired' });
        }

        // Parse amount — accept ANKH (decimal) or raw wei string
        let rawAmount;
        try {
          // If value contains a decimal point, treat as ANKH units (1 ANKH = 1e18 wei)
          if (String(amount).includes('.')) {
            rawAmount = BigInt(Math.round(parseFloat(amount) * 1e18));
          } else {
            rawAmount = BigInt(amount);
          }
        } catch {
          return res.status(400).json({ success: false, error: 'Invalid amount' });
        }

        if (rawAmount <= 0n) {
          return res.status(400).json({ success: false, error: 'Amount must be positive' });
        }

        // Check sender balance
        const fromBalance = this.stateManager.getBalance(from);
        if (fromBalance < rawAmount) {
          return res.status(400).json({
            success: false,
            error: `Insufficient balance: have ${(Number(fromBalance) / 1e18).toFixed(4)} ANKH, need ${(Number(rawAmount) / 1e18).toFixed(4)} ANKH`
          });
        }

        const nonce = this.stateManager.getAccount(from).nonce;
        const tx = Transaction.createTransfer(from, to, rawAmount, 0n, nonce);

        // Attach the sender's signature to the transaction itself. Previously the
        // signature was checked here and thrown away, so the block carried no
        // proof the transfer was authorized and peers had to take this node's
        // word for it. Now the authorization is part of the chain: every node
        // re-verifies it in validateBlockTransactions, and it stays auditable.
        tx.data = {
          ...(tx.data || {}),
          auth: {
            publicKey: signature.publicKey,
            r: signature.r,
            s: signature.s,
            timestamp,
            amount: String(amount)   // exactly as signed, before wei conversion
          }
        };
        tx.hash = tx.calculateHash();

        const { block } = await this.blockchain.commitSystemBlock([tx]);

        this.broadcastToClients({
          type: 'TRANSFER',
          from,
          to,
          amount: rawAmount.toString(),
          blockIndex: block.index,
          blockHash: block.hash
        });

        res.json({
          success: true,
          data: {
            txHash: tx.hash,
            blockIndex: block.index,
            blockHash: block.hash,
            from,
            to,
            amount: rawAmount.toString(),
            amountFormatted: (Number(rawAmount) / 1e18).toFixed(4) + ' ANKH'
          }
        });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // ============================================
    // Staking (trusted-node path)
    // ============================================

    // Stake ANKH to become a validator (self-stake) or delegate to an existing validator.
    // Body: { address, amount, validatorAddress? }
    //   - If validatorAddress is omitted or equals address → self-stake (registers as validator)
    //   - If validatorAddress is a different address       → delegation
    router.post('/stake', async (req, res) => {
      try {
        const Transaction = require('../core/Transaction');
        const { address, amount, validatorAddress, timestamp, signature } = req.body;

        if (!address || !amount) {
          return res.status(400).json({ success: false, error: 'address and amount are required' });
        }
        if (!address.startsWith('ankh_')) {
          return res.status(400).json({ success: false, error: 'Invalid ANKH address format' });
        }

        // Require a valid secp256k1 signature from the staker's private key
        if (!timestamp || Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) {
          return res.status(400).json({ success: false, error: 'Request timestamp expired or missing' });
        }
        const stakeMsg = JSON.stringify({ address, action: 'STAKE', amount: String(amount), validatorAddress: validatorAddress || address, timestamp });
        if (!verifySignedAction(address, stakeMsg, signature)) {
          return res.status(401).json({ success: false, error: 'Invalid or missing signature' });
        }

        let rawAmount;
        try {
          rawAmount = String(amount).includes('.')
            ? BigInt(Math.round(parseFloat(amount) * 1e18))
            : BigInt(amount);
        } catch {
          return res.status(400).json({ success: false, error: 'Invalid amount' });
        }

        if (rawAmount <= 0n) {
          return res.status(400).json({ success: false, error: 'Amount must be positive' });
        }

        const balance = this.stateManager.getBalance(address);
        if (balance < rawAmount) {
          return res.status(400).json({
            success: false,
            error: `Insufficient balance: have ${(Number(balance) / 1e18).toFixed(4)} ANKH, need ${(Number(rawAmount) / 1e18).toFixed(4)} ANKH`
          });
        }

        const targetValidator = validatorAddress || address;
        const nonce = this.stateManager.getAccount(address).nonce;
        const tx = Transaction.createStake(address, rawAmount, targetValidator, 0n, nonce);
        const { block } = await this.blockchain.commitSystemBlock([tx]);

        // Refresh active validators
        this.blockchain.activeValidators = this.stateManager.getTopValidators();

        this.broadcastToClients({
          type: 'VALIDATOR_UPDATE',
          address,
          validatorAddress: targetValidator,
          action: 'STAKE',
          amount: rawAmount.toString(),
          blockIndex: block.index
        });

        const isSelf = targetValidator === address;
        res.json({
          success: true,
          data: {
            txHash: tx.hash,
            blockIndex: block.index,
            blockHash: block.hash,
            address,
            validatorAddress: targetValidator,
            action: isSelf ? 'SELF_STAKE' : 'DELEGATION',
            amount: rawAmount.toString(),
            amountFormatted: (Number(rawAmount) / 1e18).toFixed(4) + ' ANKH',
            minValidatorStake: GenesisConfig.CONSENSUS.DPOS.MIN_VALIDATOR_STAKE.toString()
          }
        });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // Begin unstaking — starts the 21-day unbonding period.
    // Body: { address, amount?, validatorAddress? }
    //   amount defaults to full stake if omitted
    router.post('/unstake', async (req, res) => {
      try {
        const Transaction = require('../core/Transaction');
        const { address, amount, validatorAddress, timestamp, signature } = req.body;

        if (!address) {
          return res.status(400).json({ success: false, error: 'address is required' });
        }

        // Require a valid secp256k1 signature from the staker's private key
        if (!timestamp || Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) {
          return res.status(400).json({ success: false, error: 'Request timestamp expired or missing' });
        }
        const unstakeMsg = JSON.stringify({ address, action: 'UNSTAKE', amount: String(amount || ''), validatorAddress: validatorAddress || address, timestamp });
        if (!verifySignedAction(address, unstakeMsg, signature)) {
          return res.status(401).json({ success: false, error: 'Invalid or missing signature' });
        }

        const targetValidator = validatorAddress || address;
        const validator = this.stateManager.validators.get(targetValidator);
        if (!validator) {
          return res.status(404).json({ success: false, error: 'No active stake found for this address' });
        }

        let rawAmount;
        if (amount) {
          try {
            rawAmount = String(amount).includes('.')
              ? BigInt(Math.round(parseFloat(amount) * 1e18))
              : BigInt(amount);
          } catch {
            return res.status(400).json({ success: false, error: 'Invalid amount' });
          }
        } else {
          // Default to full self-stake
          rawAmount = validator.stake;
        }

        if (rawAmount <= 0n) {
          return res.status(400).json({ success: false, error: 'Amount must be positive' });
        }
        if (rawAmount > validator.stake) {
          return res.status(400).json({
            success: false,
            error: `Cannot unstake more than staked: staked ${(Number(validator.stake) / 1e18).toFixed(4)} ANKH`
          });
        }

        const unbondingDays = GenesisConfig.CONSENSUS.DPOS.UNBONDING_PERIOD_DAYS;
        const unbondingEnds = Date.now() + unbondingDays * 24 * 60 * 60 * 1000;

        const nonce = this.stateManager.getAccount(address).nonce;
        const tx = new Transaction({
          type: 'UNSTAKE',
          from: address,
          to: targetValidator,
          value: rawAmount,
          fee: 0n,
          nonce,
          data: { validator: targetValidator, action: 'UNDELEGATE' }
        });

        const { block } = await this.blockchain.commitSystemBlock([tx]);

        this.broadcastToClients({
          type: 'VALIDATOR_UPDATE',
          address,
          validatorAddress: targetValidator,
          action: 'UNSTAKE',
          amount: rawAmount.toString(),
          blockIndex: block.index
        });

        res.json({
          success: true,
          data: {
            txHash: tx.hash,
            blockIndex: block.index,
            blockHash: block.hash,
            address,
            validatorAddress: targetValidator,
            action: 'UNSTAKE_INITIATED',
            amount: rawAmount.toString(),
            amountFormatted: (Number(rawAmount) / 1e18).toFixed(4) + ' ANKH',
            unbondingDays,
            unbondingEnds,
            message: `Stake will be returned in ${unbondingDays} days on ${new Date(unbondingEnds).toDateString()}`
          }
        });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // ============================================
    // Transaction History
    // ============================================
    router.get('/accounts/:address/transactions', (req, res) => {
      const { address } = req.params;
      const limit = Math.min(parseInt(req.query.limit) || 20, 100);

      const txs = [];
      // Scan from most-recent block backwards
      for (let i = this.blockchain.chain.length - 1; i >= 0 && txs.length < limit; i--) {
        const block = this.blockchain.chain[i];
        for (const tx of block.transactions) {
          if (tx.from === address || tx.to === address) {
            txs.push({
              hash: tx.hash,
              type: tx.type,
              from: tx.from,
              to: tx.to,
              value: tx.value.toString(),
              fee: tx.fee.toString(),
              timestamp: tx.timestamp,
              blockIndex: block.index,
              blockHash: block.hash,
              direction: tx.to === address ? 'IN' : 'OUT'
            });
          }
        }
      }

      res.json({ success: true, data: txs });
    });

    // ============================================
    // Tokens (ARC-20)
    // ============================================

    router.get('/tokens', (req, res) => {
      res.json({
        success: true,
        data: this.tokenFactory.getAllTokens()
      });
    });

    router.get('/tokens/tiers', (req, res) => {
      res.json({
        success: true,
        data: this.tokenFactory.getTierRequirements()
      });
    });

    router.get('/tokens/:identifier', (req, res) => {
      const token = this.tokenFactory.getToken(req.params.identifier) ||
        this.tokenFactory.getTokenBySymbol(req.params.identifier);

      if (!token) {
        return res.status(404).json({ success: false, error: 'Token not found' });
      }

      res.json({ success: true, data: token.getInfo() });
    });

    router.post('/tokens/create', async (req, res) => {
      try {
        const { creator, name, symbol, timestamp, signature } = req.body;
        if (!creator || !name || !symbol) {
          return res.status(400).json({ success: false, error: 'creator, name and symbol are required' });
        }

        // Creation stakes the creator's ANKH and issues supply in their name, so
        // it has to be proven to come from them. This route previously took
        // `creator` from the request body and acted on it unverified.
        if (!timestamp || Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) {
          return res.status(400).json({ success: false, error: 'Request timestamp expired or missing' });
        }
        const createMsg = JSON.stringify({ address: creator, action: 'TOKEN_CREATE', name, symbol, timestamp });
        if (!verifySignedAction(creator, createMsg, signature)) {
          return res.status(401).json({ success: false, error: 'Invalid or missing signature' });
        }

        const result = await this.tokenFactory.createToken(creator, req.body);
        res.json({ success: true, data: result });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    router.get('/tokens/:address/balance/:holder', (req, res) => {
      const balance = this.stateManager.getTokenBalance(
        req.params.address,
        req.params.holder
      );

      res.json({
        success: true,
        data: {
          token: req.params.address,
          holder: req.params.holder,
          balance: balance.toString()
        }
      });
    });

    router.get('/tokens/pending', (req, res) => {
      res.json({
        success: true,
        data: this.tokenFactory.getPendingTokens()
      });
    });

    // Mint additional supply of a subtoken (creator only, token must be mintable)
    router.post('/tokens/:address/mint', async (req, res) => {
      try {
        const { from, toAddress, amount } = req.body;
        if (!from || !amount) return res.status(400).json({ success: false, error: 'from and amount are required' });
        const Transaction = require('../core/Transaction');
        const nonce = this.stateManager.getAccount(from).nonce;
        const tx = new Transaction({
          type: Transaction.TYPES.TOKEN_MINT,
          from, to: toAddress || from, value: 0n, fee: 0n, nonce,
          data: { tokenAddress: req.params.address, amount: String(amount) }
        });
        const { block } = await this.blockchain.commitSystemBlock([tx]);
        const token = this.stateManager.tokens.get(req.params.address);
        res.json({ success: true, data: { tokenAddress: req.params.address, totalSupply: token?.totalSupply, blockIndex: block.index } });
      } catch (err) {
        res.status(400).json({ success: false, error: err.message });
      }
    });

    // Burn tokens (caller must hold the balance, token must be burnable)
    router.post('/tokens/:address/burn', async (req, res) => {
      try {
        const { from, amount } = req.body;
        if (!from || !amount) return res.status(400).json({ success: false, error: 'from and amount are required' });
        const Transaction = require('../core/Transaction');
        const nonce = this.stateManager.getAccount(from).nonce;
        const tx = new Transaction({
          type: Transaction.TYPES.TOKEN_BURN,
          from, to: 'burn', value: 0n, fee: 0n, nonce,
          data: { tokenAddress: req.params.address, amount: String(amount) }
        });
        const { block } = await this.blockchain.commitSystemBlock([tx]);
        const token = this.stateManager.tokens.get(req.params.address);
        res.json({ success: true, data: { tokenAddress: req.params.address, totalSupply: token?.totalSupply, blockIndex: block.index } });
      } catch (err) {
        res.status(400).json({ success: false, error: err.message });
      }
    });

    // Transfer subtoken (convenience endpoint — also accepted via POST /transactions)
    router.post('/tokens/:address/transfer', async (req, res) => {
      try {
        const { from, to, amount } = req.body;
        if (!from || !to || !amount) return res.status(400).json({ success: false, error: 'from, to, and amount are required' });
        const Transaction = require('../core/Transaction');
        const nonce = this.stateManager.getAccount(from).nonce;
        const tx = new Transaction({
          type: Transaction.TYPES.TOKEN_TRANSFER,
          from, to, value: 0n, fee: 0n, nonce,
          data: { tokenAddress: req.params.address, amount: String(amount) }
        });
        const { block } = await this.blockchain.commitSystemBlock([tx]);
        res.json({ success: true, data: { tokenAddress: req.params.address, from, to, amount, blockIndex: block.index } });
      } catch (err) {
        res.status(400).json({ success: false, error: err.message });
      }
    });

    // ============================================
    // Bridge
    // ============================================

    // Release ANKH to a recipient after a confirmed bridge lock on the ETH side
    router.post('/bridge/release', async (req, res) => {
      try {
        const { to, amount, lockTxHash } = req.body;
        if (!to || !amount || !lockTxHash) {
          return res.status(400).json({ success: false, error: 'to, amount, and lockTxHash are required' });
        }
        const Transaction = require('../core/Transaction');
        const rawAmount = BigInt(Math.round(Number(amount) * 1e18));
        const tx = new Transaction({
          type: Transaction.TYPES.BRIDGE_RELEASE,
          from: 'bridge_contract', to, value: rawAmount, fee: 0n, nonce: 0,
          data: { lockTxHash, releaseTimestamp: Date.now() }
        });
        const { block } = await this.blockchain.commitSystemBlock([tx]);
        const balance   = this.stateManager.getAccount(to).balance;
        res.json({ success: true, data: { to, amount, lockTxHash, newBalance: balance.toString(), blockIndex: block.index } });
      } catch (err) {
        res.status(400).json({ success: false, error: err.message });
      }
    });

    // Anchor a sidechain block hash to the main chain
    router.post('/sidechains/:chainId/anchor', async (req, res) => {
      try {
        const { from, anchorHash, anchorHeight } = req.body;
        console.log(`[Anchor] ${req.params.chainId} — from=${from} height=${anchorHeight} hash=${String(anchorHash).slice(0, 16)}...`);
        if (!from || !anchorHash || anchorHeight === undefined) {
          console.error(`[Anchor] REJECTED — missing fields. from=${from} anchorHash=${anchorHash} anchorHeight=${anchorHeight}`);
          return res.status(400).json({ success: false, error: 'from, anchorHash, and anchorHeight are required' });
        }
        const sc = this.stateManager.sidechains.get(req.params.chainId);
        if (!sc) {
          console.error(`[Anchor] REJECTED — sidechain '${req.params.chainId}' not found in StateManager`);
        } else {
          console.log(`[Anchor] sidechain found, authorities=${JSON.stringify(sc.authorities)}`);
        }
        const Transaction = require('../core/Transaction');
        const nonce = this.stateManager.getAccount(from).nonce;
        const tx = new Transaction({
          type: Transaction.TYPES.SIDECHAIN_ANCHOR,
          from, to: 'sidechain_factory', value: 0n, fee: 0n, nonce,
          data: { sidechainId: req.params.chainId, anchorHash, anchorHeight }
        });
        const { block } = await this.blockchain.commitSystemBlock([tx]);
        console.log(`[Anchor] SUCCESS ${req.params.chainId} height=${anchorHeight} committed in mainnet block #${block.index}`);
        res.json({ success: true, data: { chainId: req.params.chainId, anchorHash, anchorHeight, blockIndex: block.index } });
      } catch (err) {
        console.error(`[Anchor] FAILED ${req.params.chainId} — ${err.message}`);
        res.status(400).json({ success: false, error: err.message });
      }
    });

    // ============================================
    // Sidechains
    // ============================================

    router.get('/sidechains', (req, res) => {
      res.json({
        success: true,
        data: this.sidechainManager.getAllSidechains()
      });
    });

    // Static paths must be registered before /:chainId to avoid Express swallowing them
    router.post('/sidechains/propose', async (req, res) => {
      try {
        const { creator, chainId, name, timestamp, signature } = req.body;
        if (!creator || !chainId || !name) {
          return res.status(400).json({ success: false, error: 'creator, chainId and name are required' });
        }

        // A proposal stakes the creator's ANKH, and COMMUNITY tier now creates a
        // live chain immediately — so an unproven `creator` meant anyone could
        // spend a verified person's stake and put a chain in their name.
        if (!timestamp || Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) {
          return res.status(400).json({ success: false, error: 'Request timestamp expired or missing' });
        }
        const proposeMsg = JSON.stringify({ address: creator, action: 'SIDECHAIN_PROPOSE', chainId, name, timestamp });
        if (!verifySignedAction(creator, proposeMsg, signature)) {
          return res.status(401).json({ success: false, error: 'Invalid or missing signature' });
        }

        const result = await this.sidechainManager.proposeChain(creator, req.body);
        res.json({ success: true, data: result });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    router.get('/sidechains/proposals', (req, res) => {
      // ?status=PENDING|APPROVED|REJECTED  (omit for all)
      res.json({
        success: true,
        data: this.sidechainManager.getAllProposals(req.query.status)
      });
    });

    // Foundation council — governs SOVEREIGN sidechain approvals
    router.get('/sidechains/council', (_req, res) => {
      const council = this.sidechainManager.getCouncilMembers();
      res.json({
        success: true,
        data: {
          ...council,
          description: council.type === 'foundation'
            ? `Foundation council: ${council.threshold}-of-${council.totalMembers} signatures required for SOVEREIGN approval`
            : `Node operator council (fallback): ${council.threshold}-of-${council.totalMembers} majority required`
        }
      });
    });

    router.get('/sidechains/proposals/:proposalId', (req, res) => {
      const proposal = this.sidechainManager.pendingProposals.get(req.params.proposalId);
      if (!proposal) {
        return res.status(404).json({ success: false, error: 'Proposal not found' });
      }
      res.json({ success: true, data: proposal });
    });

    // Foundation council approval (multi-sig for SOVEREIGN, single-sig for other tiers).
    //
    // For SOVEREIGN proposals: each Foundation member calls this independently.
    //   The proposal is activated once the configured threshold of approvals is reached.
    //   Response includes { status: 'PENDING', foundationApprovals, required } until threshold.
    //
    // For INSTITUTIONAL and below: a single Foundation member signature approves immediately.
    //
    // Fallback (no Foundation council configured): any registered node operator can approve.
    //
    // Body: { timestamp, signature: { publicKey, r, s } }
    router.post('/sidechains/proposals/:proposalId/approve', async (req, res) => {
      try {
        const { proposalId } = req.params;
        const { timestamp, signature } = req.body;

        if (!signature?.publicKey || !signature?.r || !signature?.s || !timestamp) {
          return res.status(400).json({ success: false, error: 'signature { publicKey, r, s } and timestamp required' });
        }
        if (Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) {
          return res.status(400).json({ success: false, error: 'Request timestamp expired' });
        }

        // Verify secp256k1 signature over { action, proposalId, timestamp }
        const { ec: EC } = require('elliptic');
        const ec = new EC('secp256k1');
        const message = JSON.stringify({ action: 'APPROVE_SIDECHAIN', proposalId, timestamp });
        const msgHash = crypto.createHash('sha256').update(message).digest();
        let key;
        try {
          key = ec.keyFromPublic(signature.publicKey, 'hex');
        } catch {
          return res.status(400).json({ success: false, error: 'Invalid publicKey format' });
        }
        if (!key.verify(msgHash, { r: signature.r, s: signature.s })) {
          return res.status(403).json({ success: false, error: 'Invalid signature' });
        }

        // Derive signer address from submitted public key
        const pubBytes = Buffer.from(signature.publicKey, 'hex');
        const signerAddress = 'ankh_' + crypto
          .createHash('sha256').update(pubBytes).digest('hex').substring(0, 40);

        const hasFoundation = this.foundationCouncil.members.length > 0;

        if (hasFoundation) {
          // Foundation council configured — signer must be a Foundation member
          const isMember = this.foundationCouncil.members.some(m => m.address === signerAddress);
          if (!isMember) {
            return res.status(403).json({
              success: false,
              error: 'Signer is not a Foundation council member. See GET /api/v1/sidechains/council for the member list.'
            });
          }

          const result = await this.sidechainManager.foundationApprove(proposalId, signerAddress);

          if (result.status === 'APPROVED') {
            this.broadcastToClients({
              type: 'SIDECHAIN_APPROVED',
              proposalId,
              chainId: result.sidechain?.chainId,
              approvedBy: signerAddress
            });
          }

          return res.json({ success: true, data: { ...result, approvedBy: signerAddress } });
        }

        // ── Fallback: no Foundation council — registered node operator approval ──
        const isNodeOperator = Array.from(this.stateManager.registeredNodes.values())
          .some(n => n.address === signerAddress && n.isActive);
        if (!isNodeOperator) {
          return res.status(403).json({
            success: false,
            error: 'No Foundation council configured. Signer must be a registered node operator.'
          });
        }

        const result = await this.sidechainManager.approveProposal(proposalId);

        this.broadcastToClients({
          type: 'SIDECHAIN_APPROVED',
          proposalId,
          chainId: result.sidechain?.chainId,
          approvedBy: signerAddress
        });

        res.json({ success: true, data: { ...result, approvedBy: signerAddress } });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    router.post('/sidechains/proposals/:proposalId/vote', (req, res) => {
      try {
        const { voter, approve, reason } = req.body;
        const result = this.sidechainManager.voteOnProposal(
          req.params.proposalId, voter, approve, reason
        );
        res.json({ success: true, data: result });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    router.post('/sidechains/:chainId/distribute', async (req, res) => {
      try {
        const { distributor, recipients, amounts, benefitType } = req.body;
        const result = await this.sidechainManager.distributeBenefits(
          req.params.chainId, distributor, recipients, amounts, benefitType
        );
        // BigInt totalAmount → string for JSON
        result.distribution.totalAmount = result.distribution.totalAmount.toString();
        res.json({ success: true, data: result });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // Biometric verification for sidechain citizens.
    // Same pipeline as POST /verify — verified on sidechain chain AND propagated to mainchain.
    router.post('/sidechains/:chainId/verify', async (req, res) => {
      try {
        const { address, biometricData } = req.body;
        if (!address || !biometricData) {
          return res.status(400).json({ success: false, error: 'address and biometricData required' });
        }
        const clientIp = req.ip || req.socket?.remoteAddress || null;
        const result = await this.sidechainManager.verifyCitizen(
          req.params.chainId, address, biometricData, clientIp
        );
        if (result.success) {
          this.broadcastToClients({ type: 'SIDECHAIN_USER_VERIFIED', chainId: req.params.chainId, address });
        }
        res.json({ success: result.success, data: result });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    // Latest block on a sidechain
    router.get('/sidechains/:chainId/blocks/latest', (req, res) => {
      const sc = this.sidechainManager.sidechainChains.get(req.params.chainId);
      if (!sc) return res.status(404).json({ success: false, error: 'Sidechain not found or not persisted' });
      const block = sc.getLatestBlock();
      if (!block) return res.status(404).json({ success: false, error: 'No blocks yet' });
      res.json({ success: true, data: block });
    });

    // Block by index on a sidechain
    router.get('/sidechains/:chainId/blocks/:index', async (req, res) => {
      try {
        const sc = this.sidechainManager.sidechainChains.get(req.params.chainId);
        if (!sc) return res.status(404).json({ success: false, error: 'Sidechain not found or not persisted' });
        const block = await sc.getBlockByIndex(parseInt(req.params.index, 10));
        if (!block) return res.status(404).json({ success: false, error: 'Block not found' });
        res.json({ success: true, data: block });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    router.get('/sidechains/:chainId', (req, res) => {
      const sidechain = this.sidechainManager.getSidechain(req.params.chainId);

      if (!sidechain) {
        return res.status(404).json({ success: false, error: 'Sidechain not found' });
      }

      res.json({ success: true, data: sidechain });
    });

    // ============================================
    // Validators
    // ============================================

    router.get('/validators', (req, res) => {
      res.json({
        success: true,
        data: this.blockchain.getValidators()
      });
    });

    router.get('/validators/top', (req, res) => {
      const count = parseInt(req.query.count) || 21;
      const validators = this.stateManager.getTopValidators(count);

      res.json({
        success: true,
        data: validators.map(v => ({
          address: v.address,
          stake: v.stake.toString(),
          totalStake: v.totalStake.toString(),
          isActive: v.isActive,
          blocksProduced: v.blocksProduced
        }))
      });
    });

    // ============================================
    // USD Peg
    // ============================================

    router.get('/peg/status', (req, res) => {
      res.json({
        success: true,
        data: this.pegMechanism.getPegStatus()
      });
    });

    router.get('/peg/history', (req, res) => {
      const limit = parseInt(req.query.limit) || 100;
      res.json({
        success: true,
        data: this.pegMechanism.getPriceHistory(limit)
      });
    });

    // ============================================
    // Governance
    // ============================================

    // List all proposals (filter by ?status=ACTIVE|PASSED|REJECTED|EXPIRED)
    router.get('/governance/proposals', (req, res) => {
      const governance = this.stateManager.governance;
      let proposals = Array.from(governance.values());
      if (req.query.status) {
        proposals = proposals.filter(p => p.status === req.query.status.toUpperCase());
      }
      // Sort newest first
      proposals.sort((a, b) => b.createdAt - a.createdAt);
      res.json({ success: true, data: proposals });
    });

    // Get single proposal
    router.get('/governance/proposals/:id', (req, res) => {
      const proposal = (this.stateManager.governance).get(req.params.id);
      if (!proposal) return res.status(404).json({ success: false, error: 'Proposal not found' });
      res.json({ success: true, data: proposal });
    });

    // Submit a proposal (unsigned — for trusted-node dev use)
    router.post('/governance/propose', async (req, res) => {
      try {
        const { from, title, description, type, params, timestamp, signature } = req.body;
        if (!from || !title || !type) {
          return res.status(400).json({ success: false, error: 'from, title, and type are required' });
        }

        // This endpoint accepted an arbitrary `from` with no proof of ownership,
        // so anyone could file a governance proposal in anyone else's name. The
        // staking route already required a signature; governance did not.
        if (!timestamp || Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) {
          return res.status(400).json({ success: false, error: 'Request timestamp expired or missing' });
        }
        const proposeMsg = JSON.stringify({ address: from, action: 'GOVERNANCE_PROPOSE', title, type, timestamp });
        if (!verifySignedAction(from, proposeMsg, signature)) {
          return res.status(401).json({ success: false, error: 'Invalid or missing signature' });
        }

        const Transaction = require('../core/Transaction');
        const nonce = this.stateManager.getAccount(from).nonce;
        const tx = new Transaction({
          type: Transaction.TYPES.GOVERNANCE_PROPOSE,
          from, to: 'governance', value: 0n, fee: 0n, nonce,
          data: { title, description, type, params: params || {} }
        });
        const { block } = await this.blockchain.commitSystemBlock([tx]);
        const proposalId = block.transactions?.[0]?.data?.proposalId ||
          Array.from(this.stateManager.governance.keys()).pop();
        res.json({ success: true, data: { proposalId, blockIndex: block.index } });
      } catch (err) {
        res.status(400).json({ success: false, error: err.message });
      }
    });

    // Cast a vote (unsigned — for trusted-node dev use)
    router.post('/governance/vote', async (req, res) => {
      try {
        const { from, proposalId, vote, timestamp, signature } = req.body;
        if (!from || !proposalId || !vote) {
          return res.status(400).json({ success: false, error: 'from, proposalId, and vote are required' });
        }

        // Same hole as propose: an unsigned `from` meant anyone could cast a
        // vote as any address, which makes the whole tally meaningless.
        if (!timestamp || Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) {
          return res.status(400).json({ success: false, error: 'Request timestamp expired or missing' });
        }
        const voteMsg = JSON.stringify({ address: from, action: 'GOVERNANCE_VOTE', proposalId, vote, timestamp });
        if (!verifySignedAction(from, voteMsg, signature)) {
          return res.status(401).json({ success: false, error: 'Invalid or missing signature' });
        }

        const Transaction = require('../core/Transaction');
        const nonce = this.stateManager.getAccount(from).nonce;
        const tx = new Transaction({
          type: Transaction.TYPES.GOVERNANCE_VOTE,
          from, to: 'governance', value: 0n, fee: 0n, nonce,
          data: { proposalId, vote }
        });
        const { block } = await this.blockchain.commitSystemBlock([tx]);
        const proposal = (this.stateManager.governance).get(proposalId);
        res.json({ success: true, data: { proposalId, status: proposal?.status, blockIndex: block.index } });
      } catch (err) {
        res.status(400).json({ success: false, error: err.message });
      }
    });

    // ============================================
    // Network
    // ============================================

    router.get('/network/peers', (req, res) => {
      if (!this.network) {
        return res.json({ success: true, data: { peers: [], message: 'Network not initialized' } });
      }

      res.json({
        success: true,
        data: {
          peers: this.network.getConnectedPeers(),
          stats: this.network.getStats()
        }
      });
    });

    // ============================================
    // Wallet Utilities
    // ============================================

    // Generate a new secp256k1 keypair. The node returns it but does NOT store the private key.
    router.post('/wallet/generate', (req, res) => {
      const { ec: EC } = require('elliptic');
      const ec = new EC('secp256k1');
      const keyPair = ec.genKeyPair();
      const privateKey = keyPair.getPrivate('hex');
      const publicKey  = keyPair.getPublic('hex');  // uncompressed, 130-char hex
      const address    = 'ankh_' + crypto
        .createHash('sha256')
        .update(Buffer.from(publicKey, 'hex'))
        .digest('hex')
        .substring(0, 40);

      res.json({
        success: true,
        data: { address, publicKey, privateKey }
      });
    });

    // Derive an ANKH address from an uncompressed secp256k1 public key (hex).
    router.get('/wallet/derive', (req, res) => {
      const { publicKey } = req.query;
      if (!publicKey || !/^[0-9a-fA-F]{66,130}$/.test(publicKey)) {
        return res.status(400).json({ success: false, error: 'publicKey must be a hex-encoded secp256k1 public key' });
      }
      const address = 'ankh_' + crypto
        .createHash('sha256')
        .update(Buffer.from(publicKey, 'hex'))
        .digest('hex')
        .substring(0, 40);
      res.json({ success: true, data: { address, publicKey } });
    });

    // ============================================
    // Chain Configuration  (for SDK/wallet bootstrapping)
    // ============================================

    router.get('/chain-config', (req, res) => {
      res.json({
        success: true,
        data: {
          // Identification
          chainId:              GenesisConfig.CHAIN_ID,
          chainName:            GenesisConfig.CHAIN_NAME,
          chainVersion:         GenesisConfig.CHAIN_VERSION,

          // Address format
          addressPrefix:        'ankh_',
          addressAlgorithm:     'SHA256(uncompressed-secp256k1-pubkey)[0..39]',
          cryptoCurve:          'secp256k1',
          signatureAlgorithm:   'ECDSA-SHA256',

          // Native token
          nativeToken:          'ANKH',
          nativeDecimals:       18,
          nativeSymbol:         'ANKH',

          // Economics
          monthlyUBI:           GenesisConfig.MONTHLY_UBI_AMOUNT.toString(),
          distributionMonths:   GenesisConfig.DISTRIBUTION_MONTHS,
          lifetimeValueUSD:     GenesisConfig.LIFETIME_VALUE_USD,
          maxPopulation:        GenesisConfig.MAX_GLOBAL_POPULATION.toString(),

          // Consensus
          consensusType:        GenesisConfig.CONSENSUS.TYPE,
          blockTimeMs:          GenesisConfig.CONSENSUS.DPOS?.BLOCK_TIME_MS,
          epochLength:          GenesisConfig.CONSENSUS.DPOS?.EPOCH_LENGTH,
          maxValidators:        GenesisConfig.CONSENSUS.DPOS?.MAX_VALIDATORS,

          // API
          apiVersion:           'v1',
          sdkUrl:               '/ankh-sdk.js',

          // Trusted-send support (no client signing required)
          trustedSend:          true,
          trustedSendEndpoint:  '/api/v1/send',

          // WebSocket events
          wsEvents: [
            'CONNECTED', 'NEW_BLOCK', 'NEW_TRANSACTION',
            'USER_VERIFIED', 'UBI_CLAIMED', 'TRANSFER'
          ]
        }
      });
    });

    // Chain file download — streams chain.json directly from disk for P2P sync
    router.get('/chain/download', (_req, res) => {
      const fs = require('fs');
      const chainFile = this.blockchain.chainFile;
      if (!chainFile) {
        return res.status(404).json({ success: false, error: 'Chain file not configured' });
      }
      const stat = (() => { try { return fs.statSync(chainFile); } catch { return null; } })();
      if (!stat) {
        return res.status(404).json({ success: false, error: 'Chain file not found' });
      }
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Disposition', 'attachment; filename="chain.json"');
      // Cap the stream at the stat'd size: saveChain() appends blocks in place,
      // so the file can grow mid-stream. Extra bytes past Content-Length make the
      // client's HTTP parser fail with "Parse Error: Expected HTTP/".
      fs.createReadStream(chainFile, { end: stat.size - 1 }).pipe(res);
    });

    // ============================================
    // Registered Nodes
    // ============================================

    // List all nodes that have submitted a NODE_REGISTER transaction
    router.get('/nodes', (req, res) => {
      const nodes = Array.from(this.stateManager.registeredNodes.entries()).map(([publicKey, info]) => ({
        publicKey,
        address: info.address,
        registeredAt: info.registeredAt,
        isActive: info.isActive
      }));
      res.json({ success: true, data: nodes });
    });

    // Check if a specific public key or address is a registered node
    router.get('/nodes/:identifier', (req, res) => {
      const id = req.params.identifier;
      // Try by public key first, then by address
      let entry = this.stateManager.registeredNodes.get(id);
      if (!entry) {
        for (const [pk, info] of this.stateManager.registeredNodes.entries()) {
          if (info.address === id) { entry = { publicKey: pk, ...info }; break; }
        }
      }
      if (!entry) return res.status(404).json({ success: false, error: 'Node not found' });
      res.json({ success: true, data: entry });
    });

    // ============================================
    // Bridge Lock (trusted-node path — no private key required)
    // ============================================

    router.post('/bridge/lock', async (req, res) => {
      try {
        const { from, amount, targetChain, targetAddress } = req.body;
        if (!from || !amount || !targetChain || !targetAddress) {
          return res.status(400).json({ success: false, error: 'from, amount, targetChain, and targetAddress are required' });
        }
        const Transaction = require('../core/Transaction');
        const rawAmount = BigInt(Math.round(Number(amount) * 1e18));
        const nonce = this.stateManager.getAccount(from).nonce;
        const tx = new Transaction({
          type: Transaction.TYPES.BRIDGE_LOCK,
          from, to: 'bridge_contract', value: rawAmount, fee: 0n, nonce,
          data: { targetChain, targetAddress, lockTimestamp: Date.now() }
        });
        const { block } = await this.blockchain.commitSystemBlock([tx]);
        const balance = this.stateManager.getAccount(from).balance;
        res.json({ success: true, data: { from, amount, targetChain, targetAddress, newBalance: balance.toString(), blockIndex: block.index } });
      } catch (err) {
        res.status(400).json({ success: false, error: err.message });
      }
    });

    // ============================================
    // Governance — Execute a passed proposal
    // ============================================

    router.post('/governance/proposals/:id/execute', async (req, res) => {
      try {
        const proposal = this.stateManager.governance.get(req.params.id);
        if (!proposal) return res.status(404).json({ success: false, error: 'Proposal not found' });
        if (proposal.status !== 'PASSED') {
          return res.status(400).json({ success: false, error: `Proposal is ${proposal.status} — only PASSED proposals can be executed` });
        }
        proposal.status    = 'EXECUTED';
        proposal.executedAt = Date.now();
        proposal.executedBy = req.body.executor || 'system';
        await this.stateManager.saveState();
        this.blockchain.emit('governanceExecuted', { proposalId: req.params.id, type: proposal.type, title: proposal.title });
        res.json({ success: true, data: { proposalId: req.params.id, status: 'EXECUTED', executedAt: proposal.executedAt } });
      } catch (err) {
        res.status(400).json({ success: false, error: err.message });
      }
    });

    // Mount router
    this.app.use('/api/v1', router);

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        chainId: GenesisConfig.CHAIN_ID,
        height: this.blockchain.getHeight(),
        timestamp: Date.now()
      });
    });

    // Serve the ANKH SDK JS file so wallet devs can include it via:
    //   <script src="http://node:3001/ankh-sdk.js"></script>
    const sdkPath = path.join(__dirname, '../../ankh-sdk.js');
    this.app.get('/ankh-sdk.js', (req, res) => {
      res.setHeader('Content-Type', 'application/javascript');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.sendFile(sdkPath);
    });

    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({ success: false, error: 'Endpoint not found' });
    });

    // Error handler
    this.app.use((err, req, res, next) => {
      console.error('API Error:', err);
      res.status(500).json({ success: false, error: 'Internal server error' });
    });
  }

  /**
   * Setup WebSocket
   */
  setupWebSocket() {
    this.wss.on('connection', (ws) => {
      this.wsClients.add(ws);

      // Send initial state
      ws.send(JSON.stringify({
        type: 'CONNECTED',
        chainId: GenesisConfig.CHAIN_ID,
        height: this.blockchain.getHeight()
      }));

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data);
          this.handleWsMessage(ws, message);
        } catch (error) {
          ws.send(JSON.stringify({ type: 'ERROR', error: 'Invalid message format' }));
        }
      });

      ws.on('close', () => {
        this.wsClients.delete(ws);
      });
    });

    // Subscribe to blockchain events
    this.blockchain.on('block', (block) => {
      // Push to all connected frontend clients
      this.broadcastToClients({
        type: 'NEW_BLOCK',
        block: {
          index: block.index,
          hash: block.hash,
          timestamp: block.timestamp,
          transactionCount: block.transactions.length,
          consensusType: block.consensusType,
          validator: block.validator
        }
      });

      // Push to all P2P peers so every node gets the block in real-time
      // (not just when they request a chain sync on connect)
      if (this.network && this.network.isRunning) {
        this.network.broadcastBlock(block);
      }
    });

    this.blockchain.on('transaction', (tx) => {
      this.broadcastToClients({
        type: 'NEW_TRANSACTION',
        transaction: {
          hash: tx.hash,
          type: tx.type,
          from: tx.from,
          to: tx.to
        }
      });
    });
  }

  /**
   * Handle WebSocket message
   */
  handleWsMessage(ws, message) {
    switch (message.type) {
      case 'SUBSCRIBE':
        // Handle subscription
        ws.subscriptions = ws.subscriptions || new Set();
        ws.subscriptions.add(message.channel);
        ws.send(JSON.stringify({ type: 'SUBSCRIBED', channel: message.channel }));
        break;

      case 'UNSUBSCRIBE':
        if (ws.subscriptions) {
          ws.subscriptions.delete(message.channel);
        }
        ws.send(JSON.stringify({ type: 'UNSUBSCRIBED', channel: message.channel }));
        break;

      case 'PING':
        ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
        break;

      default:
        ws.send(JSON.stringify({ type: 'UNKNOWN_MESSAGE' }));
    }
  }

  /**
   * Broadcast to all WebSocket clients
   */
  broadcastToClients(message) {
    const data = JSON.stringify(message);
    for (const client of this.wsClients) {
      if (client.readyState === 1) { // OPEN
        client.send(data);
      }
    }
  }

  /**
   * Start API server
   */
  start(port = GenesisConfig.NETWORK.DEFAULT_PORT) {
    return new Promise((resolve) => {
      this.server.listen(port, () => {
        console.log(`Ankh Chain API server running on port ${port}`);
        console.log(`WebSocket available on ws://localhost:${port}`);
        resolve();
      });
    });
  }

  /**
   * Stop API server
   */
  stop() {
    return new Promise((resolve) => {
      this.server.close(() => {
        console.log('API server stopped');
        resolve();
      });
    });
  }
}

// Challenges are HMAC-tagged so they need no server-side storage. The key is
// per-process and ephemeral by design: a restart invalidating in-flight
// challenges is harmless — they last five minutes — and it means there is no
// long-lived secret on disk to leak.
AnkhChainAPI.prototype._challengeSecret = function () {
  if (!this.__challengeSecret) {
    this.__challengeSecret = require('crypto').randomBytes(32);
  }
  return this.__challengeSecret;
};

module.exports = AnkhChainAPI;
