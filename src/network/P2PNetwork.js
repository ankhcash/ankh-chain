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
    this.apiPort = options.apiPort || GenesisConfig.NETWORK.DEFAULT_PORT || 3001;
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
    this.maxMessagesPerMinute = 1000; // high enough for block sync bursts

    // Server
    this.server = null;
    this.isRunning = false;

    // State sync tracking — set true when GET_STATE_SNAPSHOT is sent,
    // cleared when STATE_SYNC_DONE is fully processed.
    this._syncInProgress = false;

    // Blockchain reference
    this.blockchain = null;
    this.biometricVerifier = null;

    // Node identity — used to sign VERIFICATION_VOTE responses so peers can
    // verify that the approving node is in the registered node registry.
    this.nodeIdentity = null;

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
   * Set this node's secp256k1 identity so VERIFICATION_VOTE responses are signed.
   */
  setNodeIdentity(identity) {
    this.nodeIdentity = identity;
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
        // Periodically request peer lists from connected peers to grow the mesh
        this._discoveryTimer = setInterval(() => {
          if (this.isRunning) this.discoverPeers();
        }, GenesisConfig.NETWORK.PEER_DISCOVERY_INTERVAL_MS);

        // Reconnect to any known peer that dropped (e.g. main node restarted).
        // Runs every 30s — this is what makes the step-down work after Node 0 returns.
        this._reconnectTimer = setInterval(() => {
          if (!this.isRunning) return;
          for (const peerAddress of this.knownPeers) {
            if (!this.isPeerConnected(peerAddress)) {
              this.connectToPeer(peerAddress).catch(() => {});
            }
          }
        }, 30_000);

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

    if (this._discoveryTimer) {
      clearInterval(this._discoveryTimer);
      this._discoveryTimer = null;
    }

    if (this._reconnectTimer) {
      clearInterval(this._reconnectTimer);
      this._reconnectTimer = null;
    }

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
    // Store remote IP so we can reconstruct the peer's P2P address later
    socket._remoteIp = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');

    socket.on('message', (data) => {
      this.handleMessage(tempId, socket, data);
    });

    socket.on('close', () => {
      this.handleDisconnection(tempId);
    });

    socket.on('error', (error) => {
      console.error(`Peer error: ${error.message}`);
    });

    // Request peer info — include our own P2P port so peers can share our address
    this.send(socket, {
      type: 'HANDSHAKE_REQUEST',
      nodeId: this.nodeId,
      chainId: GenesisConfig.CHAIN_ID,
      version: GenesisConfig.CHAIN_VERSION,
      height: this.blockchain?.getHeight() || 0,
      verifiedUsers: this.blockchain?.stateManager?.verifiedUsers?.size || 0,
      p2pPort: this.port,
      apiPort: this.apiPort,
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
          verifiedUsers: this.blockchain?.stateManager?.verifiedUsers?.size || 0,
          p2pPort: this.port,
          apiPort: this.apiPort,
          timestamp: Date.now()
        });
      });

      let realPeerId = null;
      socket.on('message', (data) => {
        const message = JSON.parse(data);
        if (message.type === 'HANDSHAKE_RESPONSE') {
          realPeerId = message.nodeId;
          this.completePeerConnection(socket, message, address);
          resolve(message.nodeId);
        }
        this.handleMessage(realPeerId || message.nodeId, socket, data);
      });

      socket.on('close', () => {
        // realPeerId is set once HANDSHAKE_RESPONSE arrives; the peer Map is keyed
        // by nodeId so we must use realPeerId — not the raw address string — to
        // correctly remove the entry and unblock the reconnect timer.
        this.handleDisconnection(realPeerId || address);
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

    // Reject self-connections (our own nodeId connecting back)
    if (peerId === this.nodeId) {
      socket.close();
      return;
    }

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

    // For inbound connections (address=null), reconstruct the peer's P2P address
    // using their remote IP and the p2pPort they announced in the handshake
    if (!address && info.p2pPort && socket._remoteIp) {
      address = `ws://${socket._remoteIp}:${info.p2pPort}`;
    }

    // Derive the peer's API base URL from their announced apiPort + their address host
    let apiBaseUrl = null;
    if (info.apiPort) {
      const host = address
        ? address.replace(/^ws:\/\//, '').replace(/:\d+$/, '')
        : socket._remoteIp || null;
      if (host) apiBaseUrl = `http://${host}:${info.apiPort}`;
    }

    const peerVerifiedUsers = info.verifiedUsers || 0;
    const ourVerifiedUsers = this.blockchain?.stateManager?.verifiedUsers?.size || 0;

    this.peers.set(peerId, {
      socket,
      address,
      nodeId: peerId,
      version: info.version,
      height: info.height || 0,
      verifiedUsers: peerVerifiedUsers,
      apiBaseUrl,
      connectedAt: Date.now(),
      lastMessage: Date.now()
    });

    // Replace any placeholder close handler (registered with tempId before handshake)
    // with one that uses the real peerId so the Map entry gets properly removed.
    socket.removeAllListeners('close');
    socket.on('close', () => {
      this.handleDisconnection(peerId);
    });

    if (address) this.knownPeers.add(address);
    this.stats.peersConnected++;

    this.emit('peerConnected', { peerId, address });

    if (info.height > (this.blockchain?.getHeight() || 0)) {
      if (ourVerifiedUsers > 0 && peerVerifiedUsers < ourVerifiedUsers) {
        // Peer is ahead on height but behind on users — signal them to sync FROM us
        console.log(`[P2P] Peer ${peerId} ahead on height but has ${peerVerifiedUsers} users vs our ${ourVerifiedUsers} — sending SYNC_FROM_ME`);
        this.sendToPeer(peerId, { type: 'SYNC_FROM_ME', users: ourVerifiedUsers });
      } else if (!this._syncInProgress) {
        // Peer has more blocks and equal/more users — sync from them
        this._syncInProgress = true;
        this.sendToPeer(peerId, { type: 'GET_STATE_SNAPSHOT' });
      }
    } else if (ourVerifiedUsers > peerVerifiedUsers && ourVerifiedUsers > 0) {
      // We have same/more height but more users — peer needs our state
      this.sendToPeer(peerId, { type: 'SYNC_FROM_ME', users: ourVerifiedUsers });
    }

    // Request their peer list to discover more nodes
    setTimeout(() => this.sendToPeer(peerId, { type: 'GET_PEERS' }), 1000);
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
      if (peer.address === address && peer.socket.readyState === WebSocket.OPEN) return true;
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
        verifiedUsers: this.blockchain?.stateManager?.verifiedUsers?.size || 0,
        apiPort: this.apiPort,
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
        if (!peerAddress) continue;
        if (!this.knownPeers.has(peerAddress) && !this.isPeerConnected(peerAddress)) {
          this.knownPeers.add(peerAddress);
          // Actually connect to newly discovered peers
          if (this.peers.size < this.maxPeers) {
            this.connectToPeer(peerAddress).catch(() => {});
          }
        }
      }
    });

    // Peer signals that they have more users and we should sync from them
    this.on('SYNC_FROM_ME', (peerId, socket, data) => {
      const ourUsers = this.blockchain?.stateManager?.verifiedUsers?.size || 0;
      const theirUsers = data.users || 0;
      if (theirUsers > ourUsers && !this._syncInProgress) {
        console.log(`[P2P] Peer ${peerId} has ${theirUsers} users vs our ${ourUsers} — requesting their snapshot`);
        this._syncInProgress = true;
        this.sendToPeer(peerId, { type: 'GET_STATE_SNAPSHOT' });
      }
    });

    // State snapshot sync
    this.on('GET_STATE_SNAPSHOT', (peerId, socket, data) => {
      this.handleStateSnapshotRequest(peerId, socket, data);
    });

    this.on('STATE_CHUNK', (peerId, socket, data) => {
      this.handleStateChunk(peerId, socket, data);
    });

    this.on('STATE_SYNC_DONE', (peerId, socket, data) => {
      this.handleStateSyncDone(peerId, socket, data);
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

    if (!this.blockchain) return;
    if (blocks.length === 0) {
      // Peer couldn't serve these blocks (not in memory after restart) — fall back
      this.sendToPeer(peerId, { type: 'GET_STATE_SNAPSHOT' });
      return;
    }

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
        try {
          await this.blockchain.addBlock(block);
          // Track last block time so failover watcher knows the chain is alive
          this.blockchain.lastBlockTime = Date.now();
          console.log(`[P2P] Block #${block.index} from peer ${peerId.slice(0, 8)} | hash: 0x${block.hash.slice(0, 10)}...`);
          // Notify server-level failover watcher that a peer is producing
          this.emit('peerBlockAdded', { peerId, blockIndex: block.index });
          // Re-broadcast to other peers
          this.broadcast({ type: 'NEW_BLOCK', block: data.block }, peerId);
        } catch (addError) {
          // Fork detected — request full state snapshot (block replay unreliable
          // after restart since only tail block is in memory)
          if (addError.message && addError.message.includes('Invalid previous hash')) {
            this._requestSnapshotThrottled(peerId);
          }
        }
      } else if (block.index > currentHeight + 1) {
        // We're behind — request full state snapshot (rate limited)
        this._requestSnapshotThrottled(peerId);
      } else if (block.index === currentHeight) {
        // Same height — possible fork, check if our hash matches
        const ourLatest = this.blockchain.getLatestBlock();
        if (ourLatest && ourLatest.hash !== block.previousHash) {
          this._requestSnapshotThrottled(peerId);
        }
      }
    } catch (error) {
      // Silently ignore parse errors
    }
  }

  /**
   * Request a state snapshot from a peer, throttled to once every 5 minutes.
   * Skips if a sync is already in progress or if the peer has fewer users than us.
   */
  _requestSnapshotThrottled(peerId) {
    if (this._syncInProgress) return;

    const peer = this.peers.get(peerId);
    const peerUsers = peer?.verifiedUsers || 0;
    const ourUsers = this.blockchain?.stateManager?.verifiedUsers?.size || 0;
    if (ourUsers > 0 && peerUsers < ourUsers) return; // peer is not authoritative

    const now = Date.now();
    if (this._lastSnapshotRequest && now - this._lastSnapshotRequest < 300_000) return; // 5-min cooldown

    this._lastSnapshotRequest = now;
    this._syncInProgress = true;
    this.sendToPeer(peerId, { type: 'GET_STATE_SNAPSHOT' });
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

    // Sign the biometricHash if this node is approving — the signature is included
    // in the VERIFICATION_VOTE so the submitting node can build a multi-sig proof.
    let nodePublicKey = null;
    let nodeSignature = null;

    if (!isDuplicate && this.nodeIdentity && data.biometricHash) {
      try {
        const { ec: EC } = require('elliptic');
        const ec = new EC('secp256k1');
        const key = ec.keyFromPrivate(this.nodeIdentity.privateKey, 'hex');
        const msgHash = crypto.createHash('sha256').update(data.biometricHash).digest('hex');
        const sig = key.sign(msgHash);
        nodePublicKey = this.nodeIdentity.publicKey;
        nodeSignature = {
          r: sig.r.toString('hex'),
          s: sig.s.toString('hex'),
          recoveryParam: sig.recoveryParam
        };
      } catch { /* skip if key unavailable */ }
    }

    // Send vote (including signature when approving)
    this.send(socket, {
      type: 'VERIFICATION_VOTE',
      verificationId: data.verificationId,
      approved: !isDuplicate,
      confidence,
      nodeId: this.nodeId,
      nodePublicKey,
      nodeSignature,
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
        confidence: data.confidence,
        publicKey: data.nodePublicKey || null,
        signature: data.nodeSignature || null
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

  // ============================================
  // State Snapshot Sync
  // ============================================

  /**
   * Serve a full state snapshot to a syncing peer.
   * Sends the verifiedUsers, accounts, ubiAllocations, biometricDescriptors,
   * biometricToAddress, and registeredNodes maps in 500-entry chunks, then
   * finalises with STATE_SYNC_DONE containing the latest block and stats.
   */
  handleStateSnapshotRequest(peerId, socket, _data) {
    const sm = this.blockchain?.stateManager;
    if (!sm) {
      this.send(socket, { type: 'STATE_SYNC_DONE', error: 'No state manager available' });
      return;
    }

    // Replacer that converts BigInt → "123n" and Map → [[k,v],…]
    const bigintReplacer = (_, v) => {
      if (typeof v === 'bigint') return v.toString() + 'n';
      if (v instanceof Map) return Array.from(v.entries());
      return v;
    };

    const sendChunks = (chunkType, entries) => {
      const CHUNK_SIZE = 500;
      for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
        const slice = entries.slice(i, i + CHUNK_SIZE);
        // Pre-serialise so BigInts and Maps become JSON-safe
        const safeSlice = JSON.parse(JSON.stringify(slice, bigintReplacer));
        this.send(socket, {
          type: 'STATE_CHUNK',
          chunkType,
          data: safeSlice,
          offset: i,
          total: entries.length
        });
      }
    };

    sendChunks('verifiedUsers',       Array.from(sm.verifiedUsers.entries()));
    sendChunks('accounts',            Array.from(sm.accounts.entries()));
    sendChunks('ubiAllocations',      Array.from(sm.ubiAllocations.entries()));
    sendChunks('biometricDescriptors',Array.from(sm.biometricDescriptors.entries()));
    sendChunks('biometricToAddress',  Array.from(sm.biometricToAddress.entries()));
    sendChunks('registeredNodes',     Array.from(sm.registeredNodes.entries()));
    sendChunks('validators',          Array.from(sm.validators.entries()));

    const latestBlock = this.blockchain.getLatestBlock();
    const safeStats = JSON.parse(JSON.stringify(sm.stats, bigintReplacer));

    this.send(socket, {
      type: 'STATE_SYNC_DONE',
      stats: safeStats,
      latestBlock: latestBlock ? latestBlock.toJSON() : null,
      height: this.blockchain.getHeight(),
      apiBaseUrl: null  // receiver builds URL from stored peer.apiBaseUrl
    });

    console.log(`[P2P] Served state snapshot to ${peerId}: ${sm.verifiedUsers.size} users, height ${this.blockchain.getHeight()}`);
  }

  /**
   * Stream-download chain.json from a peer's HTTP API directly to disk.
   * Uses Node's http module to avoid buffering the entire file in memory.
   */
  _downloadChainFile(apiBaseUrl, destPath) {
    return new Promise((resolve, reject) => {
      const url = `${apiBaseUrl}/api/v1/chain/download`;
      const http = require('http');
      const https = require('https');
      const fsSync = require('fs');

      console.log(`[P2P] Downloading chain file from ${url}...`);

      const client = url.startsWith('https') ? https : http;
      const tmpPath = destPath + '.tmp';
      const file = fsSync.createWriteStream(tmpPath);

      client.get(url, (res) => {
        if (res.statusCode !== 200) {
          file.close();
          fsSync.unlink(tmpPath, () => {});
          return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        }

        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        let lastLog = 0;

        res.on('data', (chunk) => {
          received += chunk.length;
          const now = Date.now();
          if (total && now - lastLog > 5000) {
            lastLog = now;
            console.log(`[P2P] Chain download: ${Math.round(received / total * 100)}% (${Math.round(received / 1e6)}MB)`);
          }
        });

        res.pipe(file);

        file.on('finish', () => {
          file.close(() => {
            // Ensure destination directory exists before rename
            const path = require('path');
            try { fsSync.mkdirSync(path.dirname(destPath), { recursive: true }); } catch {}
            fsSync.rename(tmpPath, destPath, (err) => {
              if (err) return reject(err);
              console.log(`[P2P] Chain file download complete: ${Math.round(received / 1e6)}MB`);
              resolve();
            });
          });
        });

      }).on('error', (err) => {
        file.close();
        fsSync.unlink(tmpPath, () => {});
        reject(err);
      });
    });
  }

  /**
   * Accumulate an incoming STATE_CHUNK into a per-instance buffer.
   */
  handleStateChunk(_peerId, _socket, data) {
    if (!this._incomingSyncBuffer) {
      this._incomingSyncBuffer = {
        verifiedUsers: [],
        accounts: [],
        ubiAllocations: [],
        biometricDescriptors: [],
        biometricToAddress: [],
        registeredNodes: [],
        validators: []
      };
    }
    const buf = this._incomingSyncBuffer;
    if (Array.isArray(buf[data.chunkType])) {
      buf[data.chunkType].push(...data.data);
    }
  }

  /**
   * Apply the accumulated state snapshot and finalise sync.
   */
  async handleStateSyncDone(peerId, _socket, data) {
    if (data.error) {
      console.error(`[P2P] State snapshot failed: ${data.error}`);
      this._incomingSyncBuffer = null;
      this._syncInProgress = false;
      this.emit('stateSynced', { peerId, height: data.height || 0, rejected: true });
      return;
    }

    const sm = this.blockchain?.stateManager;
    if (!sm) {
      this._syncInProgress = false;
      this.emit('stateSynced', { peerId, height: data.height || 0, rejected: true });
      return;
    }

    const buf = this._incomingSyncBuffer || {};

    // Reject snapshots that would wipe our state — a peer with fewer verified users
    // than we already have is not authoritative (e.g. a fresh node that hasn't synced yet).
    const incomingUserCount = (buf.verifiedUsers || []).length;
    const currentUserCount = sm.verifiedUsers.size;
    if (currentUserCount > 0 && incomingUserCount < currentUserCount) {
      console.warn(`[P2P] Rejecting state snapshot from ${peerId}: incoming has ${incomingUserCount} users vs our ${currentUserCount} — keeping our state`);
      this._incomingSyncBuffer = null;
      this._syncInProgress = false;
      this.emit('stateSynced', { peerId, height: data.height, rejected: true });
      return;
    }

    // Recursively convert "123n" strings back to BigInt
    const reviveBigInts = (obj) => {
      if (typeof obj === 'string' && /^\d+n$/.test(obj)) return BigInt(obj.slice(0, -1));
      if (Array.isArray(obj)) return obj.map(reviveBigInts);
      if (obj && typeof obj === 'object') {
        const out = {};
        for (const k of Object.keys(obj)) out[k] = reviveBigInts(obj[k]);
        return out;
      }
      return obj;
    };

    if (buf.verifiedUsers?.length) {
      sm.verifiedUsers = new Map(reviveBigInts(buf.verifiedUsers));
    }
    if (buf.accounts?.length) {
      sm.accounts = new Map(reviveBigInts(buf.accounts));
    }
    if (buf.ubiAllocations?.length) {
      sm.ubiAllocations = new Map(reviveBigInts(buf.ubiAllocations));
    }
    if (buf.biometricDescriptors?.length) {
      sm.biometricDescriptors = new Map(buf.biometricDescriptors);
    }
    if (buf.biometricToAddress?.length) {
      sm.biometricToAddress = new Map(buf.biometricToAddress);
      // Rebuild reverse index
      sm.addressToBiometric = new Map(
        buf.biometricToAddress.map(([hash, addr]) => [addr, hash])
      );
    }
    if (buf.registeredNodes?.length) {
      sm.registeredNodes = new Map(buf.registeredNodes);
    }

    if (buf.validators?.length) {
      // validators have delegators as nested Map — deserialise as array-of-pairs
      sm.validators = new Map(reviveBigInts(buf.validators).map(([addr, v]) => {
        if (v.delegators && Array.isArray(v.delegators)) {
          v.delegators = new Map(v.delegators);
        }
        return [addr, v];
      }));
    }

    if (data.stats) {
      sm.stats = { ...sm.stats, ...reviveBigInts(data.stats) };
    }

    // Apply latest block so our chain tip matches the main node
    if (data.latestBlock) {
      const Block = require('../core/Block');
      try {
        const block = Block.fromJSON(data.latestBlock);
        this.blockchain.chain = [block];
        await this.blockchain.saveChain();
      } catch (e) {
        console.error(`[P2P] State sync: failed to apply latest block: ${e.message}`);
      }
    }

    // Persist synced state to disk
    try {
      await sm.saveState();
    } catch (e) {
      console.error(`[P2P] State sync: failed to save state: ${e.message}`);
    }

    this._incomingSyncBuffer = null;

    this._syncInProgress = false;
    console.log(`[P2P] State snapshot sync complete from ${peerId}. Height: ${data.height}, Users: ${sm.verifiedUsers.size}`);
    this.emit('stateSynced', { peerId, height: data.height });

    // Update peer's known user count now that we've seen their state
    const peer = this.peers.get(peerId);
    if (peer) peer.verifiedUsers = sm.verifiedUsers.size;

    // Download full chain.json from peer's HTTP API — only once per startup to get block history.
    // Skip if already downloaded or if another download is in progress.
    const apiBaseUrl = peer?.apiBaseUrl || data.apiBaseUrl;
    if (apiBaseUrl && this.blockchain?.chainFile && !this._chainFileDownloaded && !this._downloadInProgress) {
      this._downloadInProgress = true;
      this._downloadChainFile(apiBaseUrl, this.blockchain.chainFile)
        .then(() => { this._chainFileDownloaded = true; this._downloadInProgress = false; })
        .catch(e => {
          this._downloadInProgress = false;
          console.error(`[P2P] Chain file download failed: ${e.message}`);
        });
    }
  }
}

module.exports = P2PNetwork;
