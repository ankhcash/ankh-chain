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

    // Start P2P Network
    if (this.network) {
      await this.network.start();

      // Connect to seed peers
      for (const peer of this.options.seedPeers) {
        try {
          await this.network.connectToPeer(peer);
          console.log(`Connected to seed peer: ${peer}`);
        } catch (error) {
          console.warn(`Failed to connect to seed peer ${peer}: ${error.message}`);
        }
      }
    }

    // Register this node's identity key on-chain so it can sign verificationProofs.
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

    // Start block production if validator credentials provided, else auto-generate one
    let validatorAddress = this.options.validatorAddress;
    let validatorPrivateKey = this.options.validatorPrivateKey;

    if (!validatorAddress || !validatorPrivateKey) {
      // Auto-generate a secp256k1 keypair so the node can produce DPoS blocks immediately.
      // This allows a single bootstrapping node to commit pending TRANSFER transactions
      // without requiring the operator to manually create a validator keypair.
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
      console.log(`Auto-generated bootstrap validator: ${validatorAddress}`);
    }

    const startBlockProduction = () => {
      if (validatorAddress && validatorPrivateKey && !this.blockchain.isProducingBlocks) {
        console.log(`Starting block production as validator: ${validatorAddress}`);
        this.blockchain.startBlockProduction(validatorAddress, validatorPrivateKey);
      }
    };

    // If any connected peer is far ahead, wait for state sync before producing blocks.
    // This prevents the node from forking against the main chain during initial sync.
    const myHeight = this.blockchain.getHeight() || 0;
    let syncNeeded = false;
    if (this.network) {
      for (const [, peer] of this.network.peers) {
        if ((peer.height || 0) > myHeight) { syncNeeded = true; break; }
      }
    }

    if (syncNeeded && this.network) {
      console.log('Far behind peers — deferring block production until state sync completes...');
      this.network.once('stateSynced', () => {
        console.log('State sync done — starting block production');
        startBlockProduction();
      });
      // Safety fallback: start anyway after 2 minutes if sync never fires
      setTimeout(() => startBlockProduction(), 120_000);
    } else {
      startBlockProduction();
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
