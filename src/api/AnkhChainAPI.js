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
    this.app.use(helmet());
    this.app.use(cors());
    this.app.use(compression());
    this.app.use(express.json({ limit: '10mb' }));

    // Rate limiting
    const limiter = rateLimit({
      windowMs: 60 * 1000, // 1 minute
      max: 100, // 100 requests per minute
      message: { error: 'Too many requests, please try again later' }
    });
    this.app.use(limiter);

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

    router.get('/stats', (req, res) => {
      res.json({
        success: true,
        data: this.blockchain.getStats()
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

    router.post('/verify', async (req, res) => {
      try {
        const { address, biometricData } = req.body;

        if (!address || !biometricData) {
          return res.status(400).json({
            success: false,
            error: 'Address and biometricData required'
          });
        }

        const result = await this.biometricVerifier.verify(address, biometricData);

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

          const tx = Transaction.createBiometricRegistration(
            address,
            {
              hash: result.biometricHash,
              templateHash: result.biometricHash,
              livenessScore,
              qualityScore
            },
            ageVerificationNorm,
            0n,     // fee
            nonce
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

    router.get('/verify/:address/status', (req, res) => {
      const user = this.blockchain.getVerifiedUser(req.params.address);

      if (!user) {
        return res.json({
          success: true,
          data: { isVerified: false }
        });
      }

      res.json({
        success: true,
        data: {
          isVerified: true,
          verificationId: user.verificationId,
          registrationTimestamp: user.registrationTimestamp,
          ageVerification: user.ageVerification
        }
      });
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

    // ============================================
    // Send — requires secp256k1 signature from the sender's private key
    // ============================================

    // Helper: verify a secp256k1 signature and confirm publicKey → from address
    const verifySendSignature = (body) => {
      const { from, to, amount, timestamp, signature } = body;
      if (!signature || !signature.publicKey || !signature.r || !signature.s) return false;
      try {
        const { ec: EC } = require('elliptic');
        const ec = new EC('secp256k1');

        // Derive address from claimed public key — must match `from`
        const pubBytes = Buffer.from(signature.publicKey, 'hex');
        const derived  = 'ankh_' + crypto
          .createHash('sha256')
          .update(pubBytes)
          .digest('hex')
          .substring(0, 40);
        if (derived !== from) return false;

        // Reconstruct the exact message the client signed
        const message = JSON.stringify({ from, to, amount: String(amount), timestamp });
        const msgHash = crypto.createHash('sha256').update(message).digest();
        const key     = ec.keyFromPublic(signature.publicKey, 'hex');
        return key.verify(msgHash, { r: signature.r, s: signature.s });
      } catch (_) {
        return false;
      }
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

        // Commit immediately as a SYSTEM block (trusted-node path, bypasses signature check)
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
        const { address, amount, validatorAddress } = req.body;

        if (!address || !amount) {
          return res.status(400).json({ success: false, error: 'address and amount are required' });
        }
        if (!address.startsWith('ankh_')) {
          return res.status(400).json({ success: false, error: 'Invalid ANKH address format' });
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
        const { address, amount, validatorAddress } = req.body;

        if (!address) {
          return res.status(400).json({ success: false, error: 'address is required' });
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
        const tx = new (require('../core/Transaction'))({
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
        const result = await this.tokenFactory.createToken(req.body.creator, req.body);
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

    // ============================================
    // Sidechains
    // ============================================

    router.get('/sidechains', (req, res) => {
      res.json({
        success: true,
        data: this.sidechainManager.getAllSidechains()
      });
    });

    router.get('/sidechains/:chainId', (req, res) => {
      const sidechain = this.sidechainManager.getSidechain(req.params.chainId);

      if (!sidechain) {
        return res.status(404).json({ success: false, error: 'Sidechain not found' });
      }

      res.json({ success: true, data: sidechain });
    });

    router.post('/sidechains/propose', async (req, res) => {
      try {
        const result = this.sidechainManager.proposeChain(req.body.creator, req.body);
        res.json({ success: true, data: result });
      } catch (error) {
        res.status(400).json({ success: false, error: error.message });
      }
    });

    router.get('/sidechains/proposals', (req, res) => {
      res.json({
        success: true,
        data: this.sidechainManager.getPendingProposals()
      });
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

module.exports = AnkhChainAPI;
