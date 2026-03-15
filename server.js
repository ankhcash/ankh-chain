/**
 * Ankh Chain Node Server
 *
 * Main entry point for running an Ankh Native Blockchain node.
 * Initializes all components and starts the API server.
 */

const path = require('path');
const fs   = require('fs');

// Core components
const AnkhBlockchain = require('./src/core/AnkhBlockchain');
const StateManager = require('./src/core/StateManager');
const GenesisConfig = require('./src/core/GenesisConfig');

// Economics
const UBIEngine = require('./src/economics/UBIEngine');
const USDPegMechanism = require('./src/economics/USDPegMechanism');

// Verification
const EnhancedBiometricVerifier = require('./src/verification/EnhancedBiometricVerifier');
const BiologicalAgeVerifier = require('./src/verification/BiologicalAgeVerifier');

// Contracts
const TokenFactory = require('./src/contracts/TokenFactory');

// Sidechain
const SidechainManager = require('./src/sidechain/SidechainManager');

// Network
const P2PNetwork = require('./src/network/P2PNetwork');

// Bridge
const EthereumBridge = require('./src/bridge/EthereumBridge');

// API
const AnkhChainAPI = require('./src/api/AnkhChainAPI');

// ─── Node Identity ────────────────────────────────────────────────────────────
/**
 * Load or create a persistent secp256k1 node identity keypair.
 *
 * The keypair is written to data/node_identity.json on first run and reloaded
 * on every subsequent start. The private key is used to sign every
 * BIOMETRIC_REGISTRATION transaction committed by this node, so peers can
 * cryptographically verify that a given registration went through a legitimate
 * node's verification pipeline rather than being injected via a simulation
 * script or direct state manipulation.
 */
function loadOrCreateNodeIdentity(dataDir) {
  const { ec: EC } = require('elliptic');
  const crypto = require('crypto');
  const ec = new EC('secp256k1');

  const identityPath = path.join(dataDir, 'node_identity.json');

  if (fs.existsSync(identityPath)) {
    const saved = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
    console.log(`[Node Identity] Loaded from ${identityPath}`);
    console.log(`[Node Identity] Address: ${saved.address}`);
    return saved;
  }

  // First run — generate and persist
  fs.mkdirSync(dataDir, { recursive: true });
  const keyPair     = ec.genKeyPair();
  const privateKey  = keyPair.getPrivate('hex');
  const publicKey   = keyPair.getPublic('hex');
  const address     = 'ankh_' + crypto
    .createHash('sha256')
    .update(Buffer.from(publicKey, 'hex'))
    .digest('hex')
    .substring(0, 40);

  const identity = { privateKey, publicKey, address };
  fs.writeFileSync(identityPath, JSON.stringify(identity, null, 2));
  console.log(`[Node Identity] Generated and saved to ${identityPath}`);
  console.log(`[Node Identity] Address: ${address}`);
  return identity;
}

class AnkhChainNode {
  constructor(options = {}) {
    this.options = {
      dataDir: options.dataDir || path.join(__dirname, 'data'),
      apiPort: options.apiPort || GenesisConfig.NETWORK.DEFAULT_PORT,
      p2pPort: options.p2pPort || GenesisConfig.NETWORK.P2P_PORT,
      enableP2P: options.enableP2P !== false,
      seedPeers: options.seedPeers || [],
      validatorAddress: options.validatorAddress,
      validatorPrivateKey: options.validatorPrivateKey,
      ...options
    };

    // Node identity — loaded during initialize()
    this.nodeIdentity = null;

    // Component references
    this.stateManager = null;
    this.blockchain = null;
    this.ubiEngine = null;
    this.pegMechanism = null;
    this.biometricVerifier = null;
    this.tokenFactory = null;
    this.sidechainManager = null;
    this.network = null;
    this.bridge = null;
    this.api = null;

    this.isRunning = false;
  }

  /**
   * Initialize all components
   */
  async initialize() {
    console.log('╔═══════════════════════════════════════════════════════════════╗');
    console.log('║                    ANKH CHAIN NODE                             ║');
    console.log('║           Universal Basic Income for Humanity                  ║');
    console.log('╚═══════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`Chain ID: ${GenesisConfig.CHAIN_ID}`);
    console.log(`Version: ${GenesisConfig.CHAIN_VERSION}`);
    console.log(`Data Directory: ${this.options.dataDir}`);
    console.log('');

    // Load or create node identity keypair (used to sign biometric verifications)
    this.nodeIdentity = loadOrCreateNodeIdentity(this.options.dataDir);

    // Initialize State Manager
    console.log('[1/9] Initializing State Manager...');
    this.stateManager = new StateManager(this.options.dataDir);
    await this.stateManager.initialize();

    // Initialize Blockchain
    console.log('[2/9] Initializing Blockchain...');
    this.blockchain = new AnkhBlockchain({
      dataDir: this.options.dataDir,
      // Seed the trusted node key set with this node's own public key.
      // Peer nodes accumulate trusted keys as they encounter signed blocks.
      trustedNodeKeys: [this.nodeIdentity.publicKey]
    });
    this.blockchain.stateManager = this.stateManager;
    await this.blockchain.initialize();

    // Initialize UBI Engine
    console.log('[3/9] Initializing UBI Engine...');
    this.ubiEngine = new UBIEngine(this.stateManager);

    // Initialize USD Peg Mechanism
    console.log('[4/9] Initializing USD Peg Mechanism...');
    this.pegMechanism = new USDPegMechanism(this.stateManager);

    // Initialize Biometric Verifier
    console.log('[5/9] Initializing Biometric Verifier...');
    this.biometricVerifier = new EnhancedBiometricVerifier(this.stateManager);
    // Rebuild in-memory biometricIndex from persisted state so Euclidean distance
    // duplicate detection works immediately after a restart (no warm-up period needed).
    this.biometricVerifier.syncFromStateManager();

    // Initialize Token Factory
    console.log('[6/9] Initializing Token Factory...');
    this.tokenFactory = new TokenFactory(this.stateManager, this.blockchain);

    // Initialize Sidechain Manager
    console.log('[7/9] Initializing Sidechain Manager...');
    this.sidechainManager = new SidechainManager(this.stateManager, this.blockchain);

    // Initialize Ethereum Bridge
    console.log('[8/9] Initializing Ethereum Bridge...');
    this.bridge = new EthereumBridge(this.stateManager, this.blockchain);

    // Initialize P2P Network (if enabled)
    if (this.options.enableP2P) {
      console.log('[9/9] Initializing P2P Network...');
      this.network = new P2PNetwork({
        port: this.options.p2pPort,
        nodeId: this.options.nodeId,
        apiPort: this.options.apiPort
      });
      this.network.setBlockchain(this.blockchain);
      this.network.setBiometricVerifier(this.biometricVerifier);
      this.network.setNodeIdentity(this.nodeIdentity);
    } else {
      console.log('[9/9] P2P Network disabled');
    }

    console.log('');
    console.log('All components initialized successfully!');

    return this;
  }

  /**
   * Start the node
   */
  async start() {
    if (this.isRunning) {
      console.log('Node is already running');
      return;
    }

    console.log('');
    console.log('Starting Ankh Chain Node...');

    const explicitProducer = process.env.BLOCK_PRODUCER === 'true';
    const explicitRelay    = process.env.BLOCK_PRODUCER === 'false';
    const hasValidatorCreds = !!(this.options.validatorAddress && this.options.validatorPrivateKey);

    // Always generate validator keys up front — relay nodes hold them in reserve for failover.
    let validatorAddress = this.options.validatorAddress;
    let validatorPrivateKey = this.options.validatorPrivateKey;
    if (!validatorAddress || !validatorPrivateKey) {
      const { ec: EC } = require('elliptic');
      const crypto = require('crypto');
      const ec = new EC('secp256k1');
      const keyPair = ec.genKeyPair();
      validatorPrivateKey = keyPair.getPrivate('hex');
      const pubKeyHex = keyPair.getPublic('hex');
      validatorAddress = 'ankh_' + crypto
        .createHash('sha256')
        .update(Buffer.from(pubKeyHex, 'hex'))
        .digest('hex')
        .substring(0, 40);
    }

    // Start P2P Network and attempt seed peer connections FIRST.
    // We determine producer vs relay role AFTER connecting so self-connections
    // (which are rejected by completePeerConnection) don't count as real peers.
    if (this.network) {
      await this.network.start();

      for (const peer of this.options.seedPeers) {
        try {
          await this.network.connectToPeer(peer);
          console.log(`Connected to seed peer: ${peer}`);
        } catch (error) {
          console.warn(`Failed to connect to seed peer ${peer}: ${error.message}`);
        }
      }
    }

    // Block production rules (evaluated AFTER connection attempts):
    //   1. BLOCK_PRODUCER=false  → always relay, never produce
    //   2. BLOCK_PRODUCER=true   → always produce
    //   3. VALIDATOR_ADDRESS set → produce
    //   4. Has actual connected peers → relay (joined existing network)
    //   5. No actual peers (all failed or self) → produce (bootstrap node)
    //
    // Self-connections are rejected in completePeerConnection so peers.size
    // accurately reflects real external peers after the loop above.
    const hasRealPeers = this.network ? this.network.peers.size > 0 : false;
    const blockProducerEnabled = !explicitRelay && (explicitProducer || hasValidatorCreds || !hasRealPeers);

    if (blockProducerEnabled) {
      console.log(`Auto-generated bootstrap validator: ${validatorAddress}`);
    } else {
      console.log(`Auto-generated failover validator (standby): ${validatorAddress}`);
    }

    const startBlockProduction = () => {
      if (!blockProducerEnabled) {
        console.log(`Running as relay node — connected to ${this.network?.peers.size || 0} peer(s)`);
        return;
      }
      if (validatorAddress && validatorPrivateKey && !this.blockchain.isProducingBlocks) {
        console.log(`Starting block production as validator: ${validatorAddress}`);
        this.blockchain.startBlockProduction(validatorAddress, validatorPrivateKey);
      }
    };

    // BLOCKING sync wait — must complete before node registration or block production.
    // This prevents committing a fork block while the chain is being replaced by sync.
    if (this.network?._syncInProgress) {
      console.log('Far behind peers — waiting for state sync to complete...');
      await new Promise((resolve) => {
        let timer;
        const done = () => { clearTimeout(timer); resolve(); };
        this.network.once('stateSynced', done);
        // 2-minute safety fallback if STATE_SYNC_DONE never arrives
        timer = setTimeout(() => {
          this.network.removeListener('stateSynced', done);
          console.log('Sync timeout — proceeding anyway');
          done();
        }, 120_000);
      });
      console.log(`Sync complete. Chain height: ${this.blockchain.getHeight()}`);
    }

    // Register this node's identity key on-chain (safe now — sync is complete).
    // Idempotent — executeNodeRegister is a no-op if already registered.
    if (this.nodeIdentity && !this.stateManager.isNodeRegistered(this.nodeIdentity.publicKey)) {
      const Transaction = require('./src/core/Transaction');
      const regTx = Transaction.createNodeRegister(
        this.nodeIdentity.address,
        this.nodeIdentity.publicKey,
        0n,  // fee — bootstrap registration is free
        0    // nonce
      );
      try {
        await this.blockchain.commitSystemBlock([regTx]);
        console.log(`[Node Registry] Registered node key: ${this.nodeIdentity.address}`);
      } catch (err) {
        console.warn(`[Node Registry] Registration skipped: ${err.message}`);
      }
    }

    startBlockProduction();

    // ── Failover watcher (relay nodes only) ──────────────────────────────────
    // If no block arrives for BLOCK_GAP_MS, promote this relay to an emergency
    // producer. Step down the moment a peer block arrives (main producer returned).
    if (!blockProducerEnabled && !explicitRelay && this.network) {
      this.blockchain.lastBlockTime = Date.now(); // seed with now so gap starts from here
      let emergencyMode = false;
      const BLOCK_GAP_MS = 120_000; // 2 minutes without a block → take over

      const failoverCheck = () => {
        if (!this.isRunning) return;
        const gap = Date.now() - (this.blockchain.lastBlockTime || 0);
        if (!emergencyMode && gap > BLOCK_GAP_MS) {
          console.log(`[Failover] No block for ${Math.round(gap / 1000)}s — promoting to emergency producer`);
          emergencyMode = true;
          this.blockchain.startBlockProduction(validatorAddress, validatorPrivateKey);
        }
      };

      // Delay first check by 3 minutes so initial sync has time to complete.
      setTimeout(() => {
        if (!this.isRunning) return;
        this._failoverTimer = setInterval(failoverCheck, 30_000);
      }, 180_000);

      const stepDown = (reason) => {
        if (!emergencyMode) return;
        console.log(`[Failover] ${reason} — stepping down from emergency production`);
        emergencyMode = false;
        this.blockchain.stopBlockProduction();
        // Request fresh state from the reconnected peer so we're on the same chain
        this._syncInProgress = false;
      };

      this.network.on('peerBlockAdded', ({ blockIndex }) => {
        this.blockchain.lastBlockTime = Date.now();
        stepDown(`Peer block #${blockIndex} received`);
      });

      // Step down immediately when a peer reconnects with equal/more users.
      // This fires when the main producer comes back after a restart,
      // even if the chains have diverged (so we don't wait for a block to arrive).
      this.network.on('peerConnected', ({ peerId }) => {
        if (!emergencyMode) return;
        this.blockchain.lastBlockTime = Date.now();
        const peer = this.network.peers.get(peerId);
        const peerUsers = peer?.verifiedUsers || 0;
        const ourUsers = this.stateManager.verifiedUsers.size;
        if (peerUsers >= ourUsers) {
          stepDown(`Peer ${peerId.slice(0, 8)} reconnected (${peerUsers} users)`);
        }
      });
    }

    // Initialize API Server
    this.api = new AnkhChainAPI(this);
    await this.api.start(this.options.apiPort);

    this.isRunning = true;

    // Print status
    this.printStatus();

    // Setup graceful shutdown
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  /**
   * Print node status
   */
  printStatus() {
    console.log('');
    console.log('════════════════════════════════════════════════════════════════');
    console.log('                     NODE STATUS                                  ');
    console.log('════════════════════════════════════════════════════════════════');
    console.log('');
    console.log(`  API Server:     http://localhost:${this.options.apiPort}`);
    console.log(`  WebSocket:      ws://localhost:${this.options.apiPort}`);
    if (this.network) {
      console.log(`  P2P Port:       ${this.options.p2pPort}`);
    }
    console.log('');
    console.log('  Chain Status:');
    console.log(`    Height:       ${this.blockchain.getHeight()}`);
    console.log(`    Validators:   ${this.stateManager.validators.size}`);
    console.log(`    Verified:     ${this.stateManager.stats.totalVerifiedUsers}`);
    console.log(`    Tokens:       ${this.stateManager.tokens.size}`);
    console.log(`    Sidechains:   ${this.stateManager.sidechains.size}`);
    console.log('');
    console.log('  Economics:');
    console.log(`    Max Pop:      ${GenesisConfig.MAX_GLOBAL_POPULATION.toLocaleString()}`);
    console.log(`    Lifetime:     $${GenesisConfig.LIFETIME_VALUE_USD.toLocaleString()} per person`);
    console.log(`    Monthly UBI:  $${(Number(GenesisConfig.MONTHLY_UBI_AMOUNT) / 1e18).toFixed(2)}`);
    console.log(`    USD Peg:      1 ANKH = $1`);
    console.log('');
    console.log('════════════════════════════════════════════════════════════════');
    console.log('');
    console.log('API Endpoints:');
    console.log(`  GET  /health                       - Health check`);
    console.log(`  GET  /api/v1/info                  - Chain info`);
    console.log(`  GET  /api/v1/stats                 - Statistics`);
    console.log(`  GET  /api/v1/blocks/latest         - Latest block`);
    console.log(`  GET  /api/v1/accounts/:address     - Account info`);
    console.log(`  GET  /api/v1/ubi/:address/status   - UBI status`);
    console.log(`  POST /api/v1/ubi/:address/claim    - Claim UBI`);
    console.log(`  POST /api/v1/verify                - Biometric verification`);
    console.log(`  GET  /api/v1/tokens                - List tokens`);
    console.log(`  POST /api/v1/tokens/create         - Create token`);
    console.log(`  GET  /api/v1/sidechains            - List sidechains`);
    console.log(`  GET  /api/v1/validators            - List validators`);
    console.log(`  GET  /api/v1/peg/status            - USD peg status`);
    console.log('');
    console.log('Press Ctrl+C to shutdown');
    console.log('');
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    console.log('');
    console.log('Shutting down Ankh Chain Node...');

    this.isRunning = false;

    // Cancel failover watcher
    if (this._failoverTimer) {
      clearInterval(this._failoverTimer);
      this._failoverTimer = null;
    }

    // Stop block production
    this.blockchain.stopBlockProduction();

    // Save state
    console.log('Saving state...');
    await this.stateManager.saveState();
    await this.blockchain.saveChain();

    // Stop network
    if (this.network) {
      this.network.stop();
    }

    // Stop API
    if (this.api) {
      await this.api.stop();
    }

    console.log('Node shutdown complete');
    process.exit(0);
  }

  /**
   * Get node status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      chainInfo: this.blockchain.getChainInfo(),
      stats: this.blockchain.getStats(),
      network: this.network ? this.network.getStats() : null,
      ubi: this.ubiEngine.getGlobalStats(),
      peg: this.pegMechanism.getPegStatus()
    };
  }
}

// Main execution
async function main() {
  const node = new AnkhChainNode({
    dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
    apiPort: parseInt(process.env.API_PORT) || 3001,
    p2pPort: parseInt(process.env.P2P_PORT) || 6002,
    enableP2P: process.env.ENABLE_P2P !== 'false',
    seedPeers: process.env.SEED_PEERS
      ? process.env.SEED_PEERS.split(',').map(s => s.trim()).filter(Boolean)
      : GenesisConfig.NETWORK.SEED_PEERS,
    validatorAddress: process.env.VALIDATOR_ADDRESS,
    validatorPrivateKey: process.env.VALIDATOR_PRIVATE_KEY
  });

  try {
    await node.initialize();
    await node.start();
  } catch (error) {
    console.error('Failed to start Ankh Chain Node:', error);
    process.exit(1);
  }
}

// Export for programmatic use
module.exports = AnkhChainNode;

// Run if executed directly
if (require.main === module) {
  main();
}
