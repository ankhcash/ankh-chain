# Ankh Chain

**Universal Basic Income Blockchain for Humanity**

Ankh Chain is a native blockchain that distributes Universal Basic Income (UBI) to biometrically verified humans worldwide. It supports a maximum population of 10 billion people, each receiving a lifetime allocation of $2,800,000 distributed over 45 years.

## Key Features

### Economics
- **1 ANKH = $1 USD** - Stablecoin peg
- **$2.8M Lifetime Allocation** per verified person
- **~$5,185 Monthly UBI** distributed over 540 months
- **10 Billion Max Population** capacity

### Consensus
- **Hybrid DPoS/PoA** - Main chain uses Delegated Proof of Stake
- **Institutional Sidechains** - Governments/organizations use Proof of Authority
- **3-second Block Time** on main chain

### Verification
- **Biological Age Verification** - No government documents required
- **Multi-modal Biometrics** - Face + Voice + Skin analysis
- **95% Duplicate Detection** threshold
- **Stateless-friendly** - Supports undocumented individuals

### Token Standards (ARC)
- **ARC-20** - Fungible tokens (like ERC-20)
- **ARC-721** - NFTs (like ERC-721)
- **Tiered Creation** - Community, Standard, Institutional, Sovereign

## Quick Start

```bash
# Install dependencies
cd ankh_chain
npm install

# Start node
npm start

# Or with environment variables
API_PORT=3001 P2P_PORT=6002 npm start
```

## SDK — Build wallets in minutes

The ANKH SDK is a zero-dependency JavaScript library served directly from every node.

```html
<!-- Include from any running node -->
<script src="http://localhost:3001/ankh-sdk.js"></script>
```

```js
// Node.js
const AnkhSDK = require('./ankh-sdk');

const sdk = new AnkhSDK({ nodeUrl: 'http://localhost:3001' });

// Generate wallet (private key returned, never stored on node)
const wallet = await sdk.generateWallet();
// → { address: 'ankh_3a9f...', publicKey: '04...', privateKey: 'f3a7...' }

// Balance
const { formatted } = await sdk.getBalance(wallet.address);

// Send ANKH (no signing required — trusted-node path)
await sdk.send(wallet.address, 'ankh_recipient...', 100);

// UBI
const status = await sdk.getUBIStatus(wallet.address);
if (status.canClaim) await sdk.claimUBI(wallet.address);

// Real-time events
await sdk.connect();
sdk.on('TRANSFER',   tx    => console.log('Payment', tx.amount));
sdk.on('NEW_BLOCK',  block => console.log('Block',   block.index));
sdk.on('UBI_CLAIMED', ev   => console.log('UBI claimed by', ev.address));
```

### Self-sovereign wallets (advanced)

Generate the keypair yourself using **[noble-secp256k1](https://github.com/paulmillr/noble-secp256k1)** or **elliptic.js**, then derive the ANKH address:

```
GET /api/v1/wallet/derive?publicKey=04<x><y>
→ { address: 'ankh_...', publicKey: '04...' }
```

Sign transactions client-side and submit:
```
POST /api/v1/transactions   { type, from, to, value, fee, nonce, data, signature: { r, s, recoveryParam } }
```

Address derivation: `'ankh_' + SHA256(uncompressed-secp256k1-pubkey).hex.slice(0, 40)`

---

## API Reference

### Chain
```
GET  /health                          Health check
GET  /api/v1/chain-config             Chain config for SDK/wallet bootstrapping
GET  /api/v1/info                     Live chain info (height, stateRoot, validators…)
GET  /api/v1/stats                    Aggregate statistics
GET  /api/v1/genesis                  Genesis configuration
```

### Blocks
```
GET  /api/v1/blocks/latest            Latest block
GET  /api/v1/blocks/:index            Block by index
GET  /api/v1/blocks?limit=&offset=    List blocks (paginated)
```

### Wallet & Accounts
```
POST /api/v1/wallet/generate          Generate secp256k1 keypair + address
GET  /api/v1/wallet/derive?publicKey= Derive ankh_ address from public key
GET  /api/v1/accounts/:address        Account state (balance, nonce, isVerified…)
GET  /api/v1/accounts/:address/balance              Balance in ANKH
GET  /api/v1/accounts/:address/transactions?limit=  Transaction history
```

### Transfers
```
POST /api/v1/send                     Trusted send { from, to, amount }
POST /api/v1/transactions             Submit pre-signed transaction
GET  /api/v1/transactions/pending     Mempool
```

### UBI
```
GET  /api/v1/ubi/stats                Global UBI distribution stats
GET  /api/v1/ubi/:address/status      UBI status (canClaim, monthsClaimed…)
POST /api/v1/ubi/:address/claim       Claim monthly UBI
```

### Verification
```
POST /api/v1/verify                   Biometric verification (submits on-chain)
GET  /api/v1/verify/:address/status   Verification status
```

### Tokens (ARC-20)
```
GET  /api/v1/tokens                   List all tokens
GET  /api/v1/tokens/tiers             Tier requirements
GET  /api/v1/tokens/:identifier       Token info (address or symbol)
POST /api/v1/tokens/create            Create token
GET  /api/v1/tokens/:address/balance/:holder   Token balance
```

### Sidechains
```
GET  /api/v1/sidechains               List sidechains
POST /api/v1/sidechains/propose       Propose new sidechain
GET  /api/v1/sidechains/:chainId      Sidechain info
```

### Validators & Network
```
GET  /api/v1/validators               Active validators
GET  /api/v1/validators/top?count=    Top validators by stake
GET  /api/v1/network/peers            Connected P2P peers
GET  /api/v1/peg/status               USD peg status
```

### WebSocket events

Connect to `ws://node:3001` and listen for:

| Event | Payload |
|-------|---------|
| `CONNECTED` | `{ chainId, height }` |
| `NEW_BLOCK` | `{ index, hash, timestamp, transactionCount, consensusType, validator }` |
| `NEW_TRANSACTION` | `{ hash, type, from, to }` |
| `USER_VERIFIED` | `{ address, verificationId, blockIndex, blockHash }` |
| `UBI_CLAIMED` | `{ address, amount, blockIndex, blockHash }` |
| `TRANSFER` | `{ from, to, amount, blockIndex, blockHash }` |

## Architecture

```
ankh_chain/
├── server.js                     # Main entry point
├── src/
│   ├── core/                     # Blockchain core
│   │   ├── AnkhBlockchain.js     # Main blockchain
│   │   ├── Block.js              # Block structure
│   │   ├── Transaction.js        # Transaction types
│   │   ├── StateManager.js       # State management
│   │   └── GenesisConfig.js      # Genesis parameters
│   ├── economics/
│   │   ├── UBIEngine.js          # UBI distribution
│   │   └── USDPegMechanism.js    # Price stability
│   ├── verification/
│   │   ├── BiologicalAgeVerifier.js    # Age estimation
│   │   ├── EnhancedBiometricVerifier.js # Biometric verification
│   │   └── KingtreeAdapter.js    # Integration layer
│   ├── contracts/
│   │   ├── standards/
│   │   │   └── ARC20.js          # Token standard
│   │   └── TokenFactory.js       # Token creation
│   ├── sidechain/
│   │   └── SidechainManager.js   # Institutional sidechains
│   ├── network/
│   │   └── P2PNetwork.js         # Peer-to-peer
│   ├── bridge/
│   │   └── EthereumBridge.js     # ETH bridge
│   └── api/
│       └── AnkhChainAPI.js       # REST/WebSocket API
└── data/                         # Blockchain data
```

## Token Tiers

| Tier | Stake Required | Max Supply | Approval |
|------|---------------|------------|----------|
| Community | 100 ANKH | 1M tokens | Auto |
| Standard | 10,000 ANKH | Unlimited | 24hr review |
| Institutional | 100,000 ANKH | Unlimited | Governance vote |
| Sovereign | Treaty | Unlimited | Council approval |

## Sidechains

Governments and institutions can create PoA sidechains for:
- National benefit distribution
- Regional currencies
- Organizational tokens
- Cooperative systems

## Relationship to ETH ICO

The Ethereum ICO (ANKH) is a **derivative** of this native chain:

| Aspect | Native Ankh Chain | Ethereum ICO |
|--------|------------------|--------------|
| Purpose | UBI distribution | Fundraising |
| Token | Native ANKH | ANKH |
| Issuance | Biometric only | Purchase |
| Supply | Dynamic | Fixed 9B |
| Value | $1 peg | Market |

A bridge enables transfers between chains.

## Running a Node

### How nodes find the network

When your node starts it connects to the bootstrap seed peers hardcoded in `GenesisConfig.NETWORK.SEED_PEERS` (default: `ws://p2p.ankh.cash:6002`). It then:

1. **Handshakes** — verifies `chainId === 'ankh-mainnet-1'` (wrong chain = rejected)
2. **Syncs** — if the peer has more blocks, downloads them in batches of 100
3. **Discovers** — requests peer lists via gossip, fans out to the full network

No configuration needed for standard setups — `npm start` and you join automatically.

### Running a public / seed node

Open ports `3001` (API) and `6002` (P2P) in your firewall, then start normally. Share your address with others as `ws://your-ip-or-domain:6002`.

```bash
# Override which seed nodes to connect to
SEED_PEERS=ws://yournode.example.com:6002,ws://192.168.1.5:6002 npm start

# Isolated / private network (no outbound seed connections)
SEED_PEERS= npm start
```

## Environment Variables

```env
DATA_DIR=./data                          # Data directory
API_PORT=3001                            # REST + WebSocket API port
P2P_PORT=6002                            # P2P network port
ENABLE_P2P=true                          # Enable P2P networking
SEED_PEERS=ws://p2p.ankh.cash:6002       # Comma-separated bootstrap peers (default: genesis list)
VALIDATOR_ADDRESS=                       # Validator address (auto-generated if omitted)
VALIDATOR_PRIVATE_KEY=                   # Validator private key (auto-generated if omitted)
```

## License

MIT
