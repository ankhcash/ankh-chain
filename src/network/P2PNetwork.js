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

    // High-watermark: the highest verified-user count ever announced by any peer.
    // Used to detect rogue snapshots that would delete users we know exist.
    this._highWatermarkUsers = 0;

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

    // Keep a running high-watermark of the maximum user count seen across all peers.
    if (peerVerifiedUsers > this._highWatermarkUsers) {
      this._highWatermarkUsers = peerVerifiedUsers;
    }
    if (ourVerifiedUsers > this._highWatermarkUsers) {
      this._highWatermarkUsers = ourVerifiedUsers;
    }

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
        // Peer has more blocks and equal/more users — sync from them.
        // Honour the same 5-minute cooldown as _requestSnapshotThrottled so a
        // rapid reconnect cycle doesn't flood us with repeated full snapshots.
        const now = Date.now();
        if (!this._lastSnapshotRequest || now - this._lastSnapshotRequest >= 300_000) {
          this._lastSnapshotRequest = now;
          this._syncInProgress = true;
          this.sendToPeer(peerId, { type: 'GET_STATE_SNAPSHOT' });
        }
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
      if (theirUsers > this._highWatermarkUsers) this._highWatermarkUsers = theirUsers;
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
          console.log(`[P2P] Block #${block.index} from peer ${peerId.slice(0, 8)} | hash: ${block.hash.slice(0, 12)}...`);
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
   * Sends verifiedUsers, accounts, ubiAllocations, biometricDescriptors,
   * biometricToAddress, registeredNodes, validators, reserveAddresses,
   * sidechains, tokens, and governance in 500-entry chunks, then
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
    sendChunks('reserveAddresses',    Array.from(sm.reserveAddresses.entries()));
    sendChunks('sidechains',          Array.from(sm.sidechains.entries()));
    sendChunks('tokens',              Array.from(sm.tokens.entries()));
    sendChunks('governance',          Array.from(sm.governance.entries()));

    const latestBlock = this.blockchain.getLatestBlock();
    const safeStats = JSON.parse(JSON.stringify(sm.stats, bigintReplacer));

    // Ensure state root reflects current state before sending (may already be current)
    const stateRoot = sm.stateRoot || sm.calculateStateRoot();

    this.send(socket, {
      type: 'STATE_SYNC_DONE',
      stats: safeStats,
      latestBlock: latestBlock ? latestBlock.toJSON() : null,
      stateRoot,        // cryptographic commitment — receiver verifies after applying snapshot
      height: this.blockchain.getHeight(),
      apiBaseUrl: null  // receiver builds URL from stored peer.apiBaseUrl
    });

    console.log(`[P2P] Served state snapshot to ${peerId}: ${sm.verifiedUsers.size} users, height ${this.blockchain.getHeight()}, stateRoot ${stateRoot.slice(0, 14)}...`);
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
      // NOTE: must not be destPath + '.tmp' — saveChain() uses chain.json.tmp as
      // its append journal and unlinks it after every block, which would delete
      // an in-progress download using the same name.
      const tmpPath = destPath + '.download';
      // Ensure data directory exists before opening the write stream.
      // If missing, createWriteStream would silently fail to create the file,
      // causing ENOENT when the genesis validation tries to open tmpPath.
      try { fsSync.mkdirSync(require('path').dirname(destPath), { recursive: true }); } catch {}
      const file = fsSync.createWriteStream(tmpPath);

      // Track whether the HTTP error handler already ran cleanup+reject.
      // Without this flag, file.close() in the error handler triggers file's
      // 'finish' event, which then tries to open the already-deleted tmpPath
      // and calls reject() a second time with ENOENT — masking the real error.
      let settled = false;
      const settle = (fn) => { if (!settled) { settled = true; fn(); } };

      const req = client.get(url, (res) => {
        if (res.statusCode !== 200) {
          file.close();
          fsSync.unlink(tmpPath, () => {});
          return settle(() => reject(new Error(`HTTP ${res.statusCode} from ${url}`)));
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
            if (settled) return; // error handler already ran — skip validation

            // Guard: if zero bytes were received the stream never wrote to disk.
            // Node.js createWriteStream creates the file lazily on first write,
            // so a 0-byte response leaves tmpPath non-existent → ENOENT on open.
            if (received === 0) {
              fsSync.unlink(tmpPath, () => {});
              return settle(() => reject(new Error('Chain download returned 0 bytes — peer chain file may be unavailable')));
            }

            // Validate the downloaded file starts with the correct genesis block
            // before replacing chain.json. Protects against partial/fork chains
            // served by peers that themselves had incomplete history.
            try {
              // Read the first ~4 KB — genesis block has no transactions, fits easily
              const headBuf = Buffer.alloc(4096);
              const headFd  = fsSync.openSync(tmpPath, 'r');
              const headRead = fsSync.readSync(headFd, headBuf, 0, 4096, 0);
              fsSync.closeSync(headFd);
              const head = headBuf.toString('utf8', 0, headRead);

              // Extract the first JSON object from the array
              const firstObjStart = head.indexOf('{');
              if (firstObjStart === -1) throw new Error('no JSON object in downloaded chain');
              // Find its closing brace (simple scan — genesis has no nested arrays)
              let depth = 0, firstObjEnd = -1;
              for (let i = firstObjStart; i < head.length; i++) {
                if (head[i] === '{') depth++;
                else if (head[i] === '}') { if (--depth === 0) { firstObjEnd = i; break; } }
              }
              if (firstObjEnd === -1) throw new Error('genesis block object not closed in first 4KB');
              const firstBlock = JSON.parse(head.slice(firstObjStart, firstObjEnd + 1));

              if (firstBlock.index !== 0) {
                fsSync.unlink(tmpPath, () => {});
                return settle(() => reject(new Error(
                  `Downloaded chain starts at block ${firstBlock.index}, not genesis (0) — discarded`
                )));
              }

              const GenesisConfig = require('../core/GenesisConfig');
              const expectedTs = GenesisConfig.GENESIS_TIMESTAMP;
              if (firstBlock.timestamp !== expectedTs) {
                fsSync.unlink(tmpPath, () => {});
                return settle(() => reject(new Error(
                  `Downloaded chain genesis timestamp ${firstBlock.timestamp} ≠ expected ${expectedTs} — discarded`
                )));
              }
            } catch (valErr) {
              fsSync.unlink(tmpPath, () => {});
              return settle(() => reject(new Error(`Chain validation failed: ${valErr.message}`)));
            }

            // Verify block hash linkage before installing the file
            this._verifyChainHashLinkage(tmpPath, received, (chainErr) => {
              if (chainErr) {
                fsSync.unlink(tmpPath, () => {});
                return settle(() => reject(chainErr));
              }
              fsSync.rename(tmpPath, destPath, (err) => {
                if (err) return settle(() => reject(err));
                console.log(`[P2P] Chain file verified and installed: ${Math.round(received / 1e6)}MB`);
                settle(() => resolve());
              });
            });
          });
        });

      }).on('error', (err) => {
        // Mark settled first so the file's 'finish' event (triggered by file.close())
        // does not attempt to open the already-deleted tmpPath and emit a confusing ENOENT.
        settle(() => reject(err));
        file.close();
        fsSync.unlink(tmpPath, () => {});
      });

      // Extend socket timeout for large file downloads — default is too short
      // and causes mid-transfer TCP resets that manifest as confusing ENOENT errors.
      req.on('socket', (socket) => {
        socket.setTimeout(300_000); // 5 minutes
        socket.on('timeout', () => req.destroy(new Error('Chain download socket timeout after 5 minutes')));
      });
    });
  }

  /**
   * Verify block hash linkage in a downloaded chain.json file.
   * Reads the file in streaming 256KB chunks and extracts each block's
   * {index, hash, previousHash} using regex (avoids full JSON parse).
   * For files >100MB, samples every 50th block to stay fast.
   * Calls cb(null) on success or cb(Error) on first broken link.
   */
  _verifyChainHashLinkage(filePath, fileSize, cb) {
    const fsSync = require('fs');
    const CHUNK = 256 * 1024; // 256 KB read window
    const SAMPLE = fileSize > 100 * 1024 * 1024 ? 50 : 1; // sample every N blocks for large files

    // Regex to extract index, hash, previousHash from a block object.
    // Matches the first occurrence of each field in the block — safe because
    // nested transaction objects use different field names.
    const idxRe     = /"index"\s*:\s*(\d+)/;
    const hashRe    = /"hash"\s*:\s*"(0x[0-9a-f]+)"/;
    const prevRe    = /"previousHash"\s*:\s*"(0x[0-9a-f]+)"/;

    const fd = fsSync.openSync(filePath, 'r');
    let buf        = Buffer.alloc(CHUNK * 2); // double-buffer to handle block boundaries
    let bufContent = '';
    let filePos    = 0;
    let prevHash   = null; // hash of the last accepted block
    let prevIndex  = -1;
    let blockCount = 0;

    try {
      while (filePos < fileSize) {
        const toRead = Math.min(CHUNK, fileSize - filePos);
        const read   = fsSync.readSync(fd, buf, 0, toRead, filePos);
        if (read === 0) break;
        filePos += read;

        // Append new chunk to leftover from last iteration
        bufContent += buf.toString('utf8', 0, read);

        // Process all complete block objects in the buffer
        // A block starts at `\n{` and we find the matching `\n}` or `\n},`
        let searchFrom = 0;
        while (true) {
          const blockStart = bufContent.indexOf('\n{', searchFrom);
          if (blockStart === -1) break;

          // Find end: next `\n}` followed by `,` or end-of-array `\n]`
          const blockEnd = bufContent.indexOf('\n}', blockStart + 2);
          if (blockEnd === -1) break; // block straddles chunk boundary — wait for next read

          const blockStr = bufContent.slice(blockStart, blockEnd + 2);

          const idxM  = idxRe.exec(blockStr);
          const hashM = hashRe.exec(blockStr);
          const prevM = prevRe.exec(blockStr);

          if (idxM && hashM && prevM) {
            const idx  = parseInt(idxM[1], 10);
            const hash = hashM[1];
            const prev = prevM[1];

            blockCount++;
            const shouldCheck = (blockCount % SAMPLE === 0) || idx <= 1;

            if (shouldCheck) {
              if (prevHash !== null && prev !== prevHash) {
                fsSync.closeSync(fd);
                return cb(new Error(
                  `Hash chain broken at block ${idx}: previousHash=${prev.slice(0,14)}… ≠ expected ${prevHash.slice(0,14)}…`
                ));
              }
              prevHash  = hash;
              prevIndex = idx;
            }
          }

          searchFrom = blockEnd + 2;
        }

        // Keep only unparsed tail for next iteration
        bufContent = bufContent.slice(searchFrom);
      }

      fsSync.closeSync(fd);
      console.log(`[P2P] Hash chain OK: verified ${blockCount} blocks (sample 1/${SAMPLE}), last #${prevIndex}`);
      cb(null);
    } catch (e) {
      try { fsSync.closeSync(fd); } catch {}
      cb(new Error(`Hash chain verification error: ${e.message}`));
    }
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
        validators: [],
        reserveAddresses: [],
        sidechains: [],
        tokens: [],
        governance: []
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

    // ── Snapshot sanity checks ────────────────────────────────────────────────
    const incomingUserCount    = (buf.verifiedUsers        || []).length;
    const incomingAccountCount = (buf.accounts             || []).length;
    const incomingDescCount    = (buf.biometricDescriptors || []).length;
    const currentUserCount     = sm.verifiedUsers.size;
    const knownMaxUsers        = Math.max(currentUserCount, this._highWatermarkUsers);

    // 1. High-watermark: never accept a snapshot that would delete users we know exist.
    //    Protects against a reset main node pushing 0-user snapshots to relay nodes.
    //    Allow up to 1% shrinkage for natural churn / race conditions.
    const minimumAcceptable = Math.floor(knownMaxUsers * 0.99);
    if (knownMaxUsers > 0 && incomingUserCount < minimumAcceptable) {
      console.warn(`[P2P] Rejecting state snapshot from ${peerId}: ${incomingUserCount} users < high-watermark ${knownMaxUsers} — possible data loss or rogue node`);
      this._incomingSyncBuffer = null;
      this._syncInProgress = false;
      this.emit('stateSynced', { peerId, height: data.height, rejected: true });
      return;
    }

    // 2. Internal consistency: every verified user must have an account.
    //    accounts < users means the snapshot is incomplete or corrupted.
    if (incomingUserCount > 0 && incomingAccountCount < incomingUserCount) {
      console.warn(`[P2P] Rejecting state snapshot from ${peerId}: ${incomingAccountCount} accounts < ${incomingUserCount} users — snapshot internally inconsistent`);
      this._incomingSyncBuffer = null;
      this._syncInProgress = false;
      this.emit('stateSynced', { peerId, height: data.height, rejected: true });
      return;
    }

    // 3. Warn (don't reject) if biometric descriptors are well below user count —
    //    duplicate detection will be degraded but the node can still function.
    if (incomingUserCount > 100 && incomingDescCount < incomingUserCount * 0.80) {
      console.warn(`[P2P] Warning: snapshot from ${peerId} has only ${incomingDescCount} biometric descriptors for ${incomingUserCount} users — duplicate detection degraded`);
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

    if (buf.reserveAddresses?.length) {
      sm.reserveAddresses = new Map(buf.reserveAddresses);
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

    if (buf.sidechains?.length) {
      sm.sidechains = new Map(buf.sidechains);
    }

    if (buf.tokens?.length) {
      sm.tokens = new Map(reviveBigInts(buf.tokens).map(([addr, token]) => {
        if (token.holders && Array.isArray(token.holders)) {
          token.holders = new Map(token.holders);
        }
        return [addr, token];
      }));
      // Rebuild symbol → address index
      sm.tokenSymbolToAddress = new Map();
      sm.tokens.forEach((token, addr) => {
        if (token.symbol) sm.tokenSymbolToAddress.set(token.symbol, addr);
      });
    }

    if (buf.governance?.length) {
      sm.governance = new Map(buf.governance);
    }

    if (data.stats) {
      sm.stats = { ...sm.stats, ...reviveBigInts(data.stats) };
    }

    // ── State Root Verification ───────────────────────────────────────────────
    // Compute a state root from the data we just applied and compare against
    // what the peer claims it sent. A mismatch means the snapshot was corrupted
    // in transit or the peer is serving tampered state.
    if (data.stateRoot) {
      const localRoot = sm.calculateStateRoot();
      if (localRoot !== data.stateRoot) {
        console.error(
          `[P2P] State root mismatch from ${peerId}: ` +
          `local=${localRoot.slice(0, 14)}… peer=${data.stateRoot.slice(0, 14)}… — rejecting snapshot`
        );
        // Roll back to whatever was on disk before this sync
        try { await sm.loadState(); } catch (e) {
          console.error(`[P2P] Rollback loadState failed: ${e.message}`);
        }
        this._incomingSyncBuffer = null;
        this._syncInProgress = false;
        this.emit('stateSynced', { peerId, height: data.height, rejected: true });
        return;
      }
      console.log(`[P2P] State root verified ✓ (${localRoot.slice(0, 14)}…)`);
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

    // Rebuild the biometricVerifier's in-memory duplicate-detection index from the
    // freshly synced state.  Without this, fraud checks use an empty index until restart.
    if (this.biometricVerifier && typeof this.biometricVerifier.syncFromStateManager === 'function') {
      this.biometricVerifier.syncFromStateManager();
    }

    // Update high-watermark now that we have the final synced count
    if (sm.verifiedUsers.size > this._highWatermarkUsers) {
      this._highWatermarkUsers = sm.verifiedUsers.size;
    }

    this._syncInProgress = false;

    // Reset lastBlockTime so the failover watcher doesn't immediately fire and
    // create a competing fork on top of the just-synced chain tip.
    if (this.blockchain) {
      this.blockchain.lastBlockTime = Date.now();
      // Rebuild validator schedule from the freshly synced state so the primary
      // producer doesn't get stuck in missed-slot fill mode after every sync.
      this.blockchain.activeValidators = this.blockchain.stateManager.getTopValidators();
      this.blockchain.updateValidatorSchedule();
    }

    console.log(`[P2P] State snapshot sync complete from ${peerId}. Height: ${data.height}, Users: ${sm.verifiedUsers.size}`);
    this.emit('stateSynced', { peerId, height: data.height });

    const peer = this.peers.get(peerId);
    if (peer) peer.verifiedUsers = sm.verifiedUsers.size;

    const apiBaseUrl = peer?.apiBaseUrl || data.apiBaseUrl;
    const peerHasUsers = (peer?.verifiedUsers || 0) > 0;
    if (apiBaseUrl && peerHasUsers && this.blockchain?.chainFile && !this._chainFileDownloaded && !this._downloadInProgress) {
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