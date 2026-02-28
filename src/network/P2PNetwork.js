/**
 * P2P Network
 *
 * Handles peer-to-peer communication for the Ankh blockchain:
 * - Peer discovery and management
 * - Block and transaction propagation
 * - Chain synchronization
 * - Consensus messaging
 * - Biometric verification consensus
 */

const WebSocket = require('ws');
const crypto = require('crypto');
const EventEmitter = require('events');
const GenesisConfig = require('../core/GenesisConfig');

class P2PNetwork extends EventEmitter {
  constructor(options = {}) {
    super();

    this.nodeId = options.nodeId || crypto.randomUUID();
    this.port = options.port || GenesisConfig.NETWORK.P2P_PORT;
    this.maxPeers = options.maxPeers || GenesisConfig.NETWORK.MAX_PEERS;

    // Peer management
    this.peers = new Map();           // peerId -> { socket, info }
    this.knownPeers = new Set();      // Known peer addresses
    this.bannedPeers = new Set();     // Banned peer IDs

    // Message handling
    this.messageHandlers = new Map();
    this.pendingMessages = new Map(); // For request/response pattern
    this.messageTimeout = 30000;      // 30 second timeout

    // Rate limiting
    this.messageRates = new Map();    // peerId -> { count, resetTime }
    this.maxMessagesPerMinute = 100;

    // Server
    this.server = null;
    this.isRunning = false;

    // Blockchain reference
    this.blockchain = null;
    this.biometricVerifier = null;

    // Statistics
    this.stats = {
      totalMessagesSent: 0,
      totalMessagesReceived: 0,
      peersConnected: 0,
      peersDisconnected: 0,
      syncRequests: 0
    };

    this.registerDefaultHandlers();
  }

  /**
   * Set blockchain reference
   */
  setBlockchain(blockchain) {
    this.blockchain = blockchain;
  }

  /**
   * Set biometric verifier reference
   */
  setBiometricVerifier(verifier) {
    this.biometricVerifier = verifier;
  }

  /**
   * Start P2P server
   */
  start() {
    return new Promise((resolve, reject) => {
      this.server = new WebSocket.Server({ port: this.port });

      this.server.on('listening', () => {
        this.isRunning = true;
        console.log(`P2P server listening on port ${this.port}`);
        resolve();
      });

      this.server.on('connection', (socket, req) => {
        this.handleIncomingConnection(socket, req);
      });

      this.server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          // Port already in use — P2P networking disabled but API still works
          console.warn(`P2P port ${this.port} already in use. Running in API-only mode (no P2P networking).`);
          this.isRunning = false;
          resolve(); // Don't crash — API server can still function
        } else {
          reject(error);
        }
      });
    });
  }

  /**
   * Stop P2P server
   */
  stop() {
    this.isRunning = false;

    // Close all peer connections
    for (const [peerId, peer] of this.peers) {
      peer.socket.close();
    }
    this.peers.clear();

    // Close server
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  /**
   * Handle incoming connection
   */
  handleIncomingConnection(socket, req) {
    const tempId = crypto.randomUUID();

    socket.on('message', (data) => {
      this.handleMessage(tempId, socket, data);
    });

    socket.on('close', () => {
      this.handleDisconnection(tempId);
    });

    socket.on('error', (error) => {
      console.error(`Peer error: ${error.message}`);
    });

    // Request peer info
    this.send(socket, {
      type: 'HANDSHAKE_REQUEST',
      nodeId: this.nodeId,
      chainId: GenesisConfig.CHAIN_ID,
      version: GenesisConfig.CHAIN_VERSION,
      timestamp: Date.now()
    });
  }

  /**
   * Connect to peer
   */
  connectToPeer(address) {
    return new Promise((resolve, reject) => {
      if (this.peers.size >= this.maxPeers) {
        reject(new Error('Max peers reached'));
        return;
      }

      if (this.knownPeers.has(address) && this.isPeerConnected(address)) {
        reject(new Error('Already connected to peer'));
        return;
      }

      const socket = new WebSocket(address);

      socket.on('open', () => {
        this.send(socket, {
          type: 'HANDSHAKE_REQUEST',
          nodeId: this.nodeId,
          chainId: GenesisConfig.CHAIN_ID,
          version: GenesisConfig.CHAIN_VERSION,
          height: this.blockchain?.getHeight() || 0,
          timestamp: Date.now()
        });
      });

      socket.on('message', (data) => {
        const message = JSON.parse(data);
        if (message.type === 'HANDSHAKE_RESPONSE') {
          this.completePeerConnection(socket, message, address);
          resolve(message.nodeId);
        }
        this.handleMessage(message.nodeId, socket, data);
      });

      socket.on('close', () => {
        this.handleDisconnection(address);
      });

      socket.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Complete peer connection after handshake
   */
  completePeerConnection(socket, info, address) {
    const peerId = info.nodeId;

    // Check if banned
    if (this.bannedPeers.has(peerId)) {
      socket.close();
      return;
    }

    // Check chain ID
    if (info.chainId !== GenesisConfig.CHAIN_ID) {
      this.send(socket, { type: 'INCOMPATIBLE_CHAIN' });
      socket.close();
      return;
    }

    this.peers.set(peerId, {
      socket,
      address,
      nodeId: peerId,
      version: info.version,
      height: info.height || 0,
      connectedAt: Date.now(),
      lastMessage: Date.now()
    });

    this.knownPeers.add(address);
    this.stats.peersConnected++;

    this.emit('peerConnected', { peerId, address });

    // Sync if they have more blocks
    if (info.height > (this.blockchain?.getHeight() || 0)) {
      this.requestChainSync(peerId);
    }
  }

  /**
   * Handle disconnection
   */
  handleDisconnection(peerId) {
    if (this.peers.has(peerId)) {
      this.peers.delete(peerId);
      this.stats.peersDisconnected++;
      this.emit('peerDisconnected', { peerId });
    }
  }

  /**
   * Check if peer is connected
   */
  isPeerConnected(address) {
    for (const peer of this.peers.values()) {
      if (peer.address === address) return true;
    }
    return false;
  }

  // ============================================
  // Message Handling
  // ============================================

  /**
   * Register default message handlers
   */
  registerDefaultHandlers() {
    // Handshake
    this.on('HANDSHAKE_REQUEST', (peerId, socket, data) => {
      this.send(socket, {
        type: 'HANDSHAKE_RESPONSE',
        nodeId: this.nodeId,
        chainId: GenesisConfig.CHAIN_ID,
        version: GenesisConfig.CHAIN_VERSION,
        height: this.blockchain?.getHeight() || 0,
        timestamp: Date.now()
      });
      this.completePeerConnection(socket, data, null);
    });

    // Ping/Pong
    this.on('PING', (peerId, socket, data) => {
      this.send(socket, { type: 'PONG', timestamp: Date.now() });
    });

    // Chain sync
    this.on('CHAIN_REQUEST', (peerId, socket, data) => {
      this.handleChainRequest(peerId, socket, data);
    });

    this.on('CHAIN_RESPONSE', (peerId, socket, data) => {
      this.handleChainResponse(peerId, data);
    });

    // Block broadcast
    this.on('NEW_BLOCK', (peerId, socket, data) => {
      this.handleNewBlock(peerId, data);
    });

    // Transaction broadcast
    this.on('NEW_TRANSACTION', (peerId, socket, data) => {
      this.handleNewTransaction(peerId, data);
    });

    // Biometric verification consensus
    this.on('VERIFICATION_REQUEST', (peerId, socket, data) => {
      this.handleVerificationRequest(peerId, socket, data);
    });

    this.on('VERIFICATION_VOTE', (peerId, socket, data) => {
      this.handleVerificationVote(peerId, data);
    });

    // Peer discovery
    this.on('GET_PEERS', (peerId, socket, data) => {
      this.send(socket, {
        type: 'PEERS_LIST',
        peers: Array.from(this.knownPeers)
      });
    });

    this.on('PEERS_LIST', (peerId, socket, data) => {
      for (const peerAddress of data.peers) {
        if (!this.knownPeers.has(peerAddress)) {
          this.knownPeers.add(peerAddress);
        }
      }
    });
  }

  /**
   * Handle incoming message
   */
  handleMessage(peerId, socket, rawData) {
    try {
      const data = JSON.parse(rawData);

      // Rate limiting
      if (!this.checkRateLimit(peerId)) {
        console.warn(`Rate limit exceeded for peer ${peerId}`);
        return;
      }

      // Update peer activity
      if (this.peers.has(peerId)) {
        this.peers.get(peerId).lastMessage = Date.now();
      }

      this.stats.totalMessagesReceived++;

      // Emit for handlers
      this.emit(data.type, peerId, socket, data);

      // Check pending messages (request/response)
      if (data.requestId && this.pendingMessages.has(data.requestId)) {
        const pending = this.pendingMessages.get(data.requestId);
        pending.resolve(data);
        this.pendingMessages.delete(data.requestId);
      }

    } catch (error) {
      console.error(`Error handling message: ${error.message}`);
    }
  }

  /**
   * Check rate limit for peer
   */
  checkRateLimit(peerId) {
    const now = Date.now();
    const rate = this.messageRates.get(peerId) || { count: 0, resetTime: now + 60000 };

    if (now > rate.resetTime) {
      rate.count = 0;
      rate.resetTime = now + 60000;
    }

    rate.count++;
    this.messageRates.set(peerId, rate);

    return rate.count <= this.maxMessagesPerMinute;
  }

  /**
   * Send message to socket
   */
  send(socket, message) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      this.stats.totalMessagesSent++;
    }
  }

  /**
   * Send to specific peer
   */
  sendToPeer(peerId, message) {
    const peer = this.peers.get(peerId);
    if (peer) {
      this.send(peer.socket, message);
    }
  }

  /**
   * Broadcast to all peers
   */
  broadcast(message, excludePeerId = null) {
    for (const [peerId, peer] of this.peers) {
      if (peerId !== excludePeerId) {
        this.send(peer.socket, message);
      }
    }
  }

  /**
   * Send request and wait for response
   */
  async request(peerId, message, timeout = this.messageTimeout) {
    const requestId = crypto.randomUUID();
    message.requestId = requestId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingMessages.delete(requestId);
        reject(new Error('Request timeout'));
      }, timeout);

      this.pendingMessages.set(requestId, {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        }
      });

      this.sendToPeer(peerId, message);
    });
  }

  // ============================================
  // Chain Synchronization
  // ============================================

  /**
   * Request chain sync from peer
   */
  async requestChainSync(peerId) {
    this.stats.syncRequests++;

    const currentHeight = this.blockchain?.getHeight() || 0;

    this.sendToPeer(peerId, {
      type: 'CHAIN_REQUEST',
      fromHeight: currentHeight + 1,
      batchSize: GenesisConfig.NETWORK.BLOCK_SYNC_BATCH_SIZE
    });
  }

  /**
   * Handle chain request
   */
  handleChainRequest(peerId, socket, data) {
    const { fromHeight, batchSize } = data;

    if (!this.blockchain) {
      this.send(socket, { type: 'CHAIN_RESPONSE', blocks: [], hasMore: false });
      return;
    }

    const blocks = [];
    const maxHeight = this.blockchain.getHeight();
    const endHeight = Math.min(fromHeight + batchSize - 1, maxHeight);

    for (let i = fromHeight; i <= endHeight; i++) {
      const block = this.blockchain.getBlockByIndex(i);
      if (block) {
        blocks.push(block.toJSON());
      }
    }

    this.send(socket, {
      type: 'CHAIN_RESPONSE',
      blocks,
      hasMore: endHeight < maxHeight,
      requestId: data.requestId
    });
  }

  /**
   * Handle chain response
   */
  async handleChainResponse(peerId, data) {
    const { blocks, hasMore } = data;

    if (!this.blockchain || blocks.length === 0) return;

    const Block = require('../core/Block');

    for (const blockData of blocks) {
      try {
        const block = Block.fromJSON(blockData);
        await this.blockchain.addBlock(block);
      } catch (error) {
        console.error(`Error adding synced block: ${error.message}`);
        break;
      }
    }

    // Continue syncing if more blocks available
    if (hasMore) {
      this.requestChainSync(peerId);
    }
  }

  // ============================================
  // Block & Transaction Propagation
  // ============================================

  /**
   * Broadcast new block
   */
  broadcastBlock(block) {
    this.broadcast({
      type: 'NEW_BLOCK',
      block: block.toJSON()
    });
  }

  /**
   * Handle new block from peer
   */
  async handleNewBlock(peerId, data) {
    if (!this.blockchain) return;

    const Block = require('../core/Block');

    try {
      const block = Block.fromJSON(data.block);

      // Validate and add
      const currentHeight = this.blockchain.getHeight();

      if (block.index === currentHeight + 1) {
        await this.blockchain.addBlock(block);

        // Re-broadcast to other peers
        this.broadcast({ type: 'NEW_BLOCK', block: data.block }, peerId);
      } else if (block.index > currentHeight + 1) {
        // We're behind, request sync
        this.requestChainSync(peerId);
      }
    } catch (error) {
      console.error(`Error processing new block: ${error.message}`);
    }
  }

  /**
   * Broadcast new transaction
   */
  broadcastTransaction(transaction) {
    this.broadcast({
      type: 'NEW_TRANSACTION',
      transaction: transaction.toJSON()
    });
  }

  /**
   * Handle new transaction from peer
   */
  handleNewTransaction(peerId, data) {
    if (!this.blockchain) return;

    const Transaction = require('../core/Transaction');

    try {
      const tx = Transaction.fromJSON(data.transaction);

      // Add to pending pool
      this.blockchain.addTransaction(tx);

      // Re-broadcast to other peers
      this.broadcast({ type: 'NEW_TRANSACTION', transaction: data.transaction }, peerId);

    } catch (error) {
      // Transaction might already exist or be invalid
    }
  }

  // ============================================
  // Biometric Verification Consensus
  // ============================================

  /**
   * Broadcast verification request for consensus.
   * Includes the 128-d descriptor so remote nodes can perform Euclidean distance checks.
   */
  broadcastVerificationRequest(request) {
    this.broadcast({
      type: 'VERIFICATION_REQUEST',
      verificationId: request.verificationId,
      biometricHash: request.biometricHash,
      templateHash: request.templateHash,
      descriptor: request.descriptor || null,   // Float32[128] — enables distance-based dedup on peers
      timestamp: Date.now()
    });
  }

  /**
   * Handle verification request from peer.
   *
   * Priority:
   *  1. Exact hash match in local biometricIndex → reject (known duplicate)
   *  2. Euclidean distance < 0.55 against any stored descriptor → reject (face match)
   *  3. Neither → approve
   */
  handleVerificationRequest(peerId, socket, data) {
    if (!this.biometricVerifier) return;

    let isDuplicate = false;
    let confidence = 0.9;

    // 1. Exact hash match
    if (this.biometricVerifier.biometricIndex.has(data.biometricHash)) {
      isDuplicate = true;
      confidence = 0;
    }

    // 2. Euclidean distance check when descriptor is available
    if (!isDuplicate && Array.isArray(data.descriptor) && data.descriptor.length === 128) {
      const SAME_PERSON_THRESHOLD = 0.55;
      for (const [, record] of this.biometricVerifier.biometricIndex) {
        if (!record.descriptor) continue;
        const distance = this.biometricVerifier.descriptorDistance(data.descriptor, record.descriptor);
        if (distance < SAME_PERSON_THRESHOLD) {
          isDuplicate = true;
          confidence = 0;
          break;
        }
      }
    }

    // Send vote
    this.send(socket, {
      type: 'VERIFICATION_VOTE',
      verificationId: data.verificationId,
      approved: !isDuplicate,
      confidence,
      nodeId: this.nodeId,
      timestamp: Date.now()
    });
  }

  /**
   * Handle verification vote from peer
   */
  handleVerificationVote(peerId, data) {
    if (!this.biometricVerifier) return;

    this.biometricVerifier.receiveConsensusVote(
      data.verificationId,
      peerId,
      {
        approved: data.approved,
        confidence: data.confidence
      }
    );
  }

  // ============================================
  // Peer Management
  // ============================================

  /**
   * Get connected peers
   */
  getConnectedPeers() {
    return Array.from(this.peers.entries()).map(([id, peer]) => ({
      nodeId: id,
      address: peer.address,
      version: peer.version,
      height: peer.height,
      connectedAt: peer.connectedAt,
      lastMessage: peer.lastMessage
    }));
  }

  /**
   * Get peer count
   */
  getPeerCount() {
    return this.peers.size;
  }

  /**
   * Ban peer
   */
  banPeer(peerId, reason) {
    this.bannedPeers.add(peerId);

    const peer = this.peers.get(peerId);
    if (peer) {
      peer.socket.close();
      this.peers.delete(peerId);
    }

    this.emit('peerBanned', { peerId, reason });
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      connectedPeers: this.peers.size,
      knownPeers: this.knownPeers.size,
      bannedPeers: this.bannedPeers.size,
      isRunning: this.isRunning
    };
  }

  /**
   * Discover peers
   */
  async discoverPeers() {
    // Request peer lists from connected peers
    for (const [peerId] of this.peers) {
      this.sendToPeer(peerId, { type: 'GET_PEERS' });
    }
  }
}

module.exports = P2PNetwork;
