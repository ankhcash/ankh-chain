# Ankh Chain

**Universal Basic Income Blockchain for Humanity**

Ankh Chain is a native blockchain that distributes Universal Basic Income (UBI) to every biometrically verified human on Earth. It supports up to 10 billion people, each receiving a lifetime allocation of $2,800,000 distributed over 45 years — funded entirely through biometric-gated issuance, not pre-mine or ICO.

---

## Table of Contents

1. [Economics & Design](#economics--design)
2. [Architecture](#architecture)
3. [Mainnet Endpoints](#mainnet-endpoints)
4. [Running a Node](#running-a-node)
5. [SDK — Build Wallets & dApps](#sdk--build-wallets--dapps)
6. [Biometric Verification](#biometric-verification)
7. [UBI Claims](#ubi-claims)
8. [Tokens (ARC-20)](#tokens-arc-20)
9. [Sidechains — Institutional Integration](#sidechains--institutional-integration)
10. [Governance](#governance)
11. [Ethereum Bridge](#ethereum-bridge)
12. [Validators & Staking](#validators--staking)
13. [API Reference](#api-reference)
14. [WebSocket Events](#websocket-events)
15. [Data Persistence](#data-persistence)
16. [Environment Variables](#environment-variables)
17. [Troubleshooting](#troubleshooting)
18. [Security Model](#security-model)

---

## Economics & Design

| Parameter | Value |
|---|---|
| **1 ANKH** | $1 USD (stablecoin peg) |
| **Lifetime allocation** | $2,800,000 per verified person |
| **Monthly UBI** | ~5,185.19 ANKH / month |
| **Distribution period** | 540 months (45 years) |
| **Max population** | 10,000,000,000 |
| **Max total supply** | 2.8 × 10³⁴ ANKH (10B × $2.8M × 10¹⁸ decimals) |
| **Genesis reserve** | 2.8 × 10³³ ANKH (10% stability buffer) |
| **Issuance model** | Biometric-gated only — no pre-mine, no ICO issuance |
| **Block time** | 3 seconds (main chain) / 1–2 seconds (sidechains) |
| **Consensus** | Hybrid DPoS (main) + PoA (institutional sidechains) |

### Supply model

ANKH can only enter circulation when a verified human claims their monthly UBI. The genesis reserve is released only via on-chain governance with full audit trail (`RESERVE_RELEASE` transactions).

**Reserve allocation:**

| Reserve | Share | Purpose |
|---|---|---|
| Main | 95% | Primary UBI stability buffer |
| Foundation | 2% | Protocol development |
| Development | 1% | Infrastructure |
| Ecosystem | 1% | Grants and integrations |
| Emergency | 1% | Crisis response |

### Fee distribution

- Transfer fee: 0.1% of amount
- 50% of fees burned (deflationary pressure)
- 50% of fees paid to active block validators

---

## Architecture

```
ankh_chain/
├── server.js                          # Node entry point + failover logic
├── ankh-sdk.js                        # Zero-dependency browser/Node.js SDK
└── src/
    ├── core/
    │   ├── AnkhBlockchain.js          # Block validation, tx execution, production
    │   ├── Block.js                   # Block structure + signing
    │   ├── Transaction.js             # All 20 transaction types
    │   ├── StateManager.js            # Accounts, UBI, tokens, sidechains (persisted)
    │   └── GenesisConfig.js           # All chain constants (frozen at genesis)
    ├── economics/
    │   ├── UBIEngine.js               # UBI allocation lifecycle
    │   └── USDPegMechanism.js         # Price stability + oracle management
    ├── verification/
    │   ├── EnhancedBiometricVerifier.js  # 9-step liveness + duplicate pipeline
    │   ├── BiologicalAgeVerifier.js      # Age estimation (face + voice + skin)
    │   └── KingtreeAdapter.js            # Integration layer
    ├── contracts/
    │   ├── standards/ARC20.js         # ARC-20 token standard
    │   └── TokenFactory.js            # Token creation + tiered approval
    ├── sidechain/
    │   └── SidechainManager.js        # PoA sidechain lifecycle
    ├── network/
    │   └── P2PNetwork.js              # Gossip, block sync, peer discovery
    ├── bridge/
    │   └── EthereumBridge.js          # ETH ↔ ANKH multi-sig bridge
    └── api/
        └── AnkhChainAPI.js            # Express REST + WebSocket API
```

### How blocks flow

```
User submits tx → API → mempool
Block producer picks txs → executes each tx → updates StateManager
→ signs block (secp256k1) → broadcasts to peers via P2P
Peers receive → validate signature + state root → add to chain
→ emit peerBlockAdded → failover step-down resets timer
```

### Transaction types

| Type | Description |
|---|---|
| `TRANSFER` | Send ANKH between addresses |
| `UBI_CLAIM` | Monthly UBI disbursement |
| `BIOMETRIC_REGISTRATION` | Register a verified human |
| `TOKEN_CREATE` | Create an ARC-20 token |
| `TOKEN_TRANSFER` | Transfer ARC-20 tokens |
| `TOKEN_MINT` | Mint additional tokens (if mintable) |
| `TOKEN_BURN` | Burn tokens (if burnable) |
| `STAKE` | Stake ANKH as a validator |
| `UNSTAKE` | Begin 21-day unbonding |
| `GOVERNANCE_PROPOSE` | Submit a governance proposal |
| `GOVERNANCE_VOTE` | Vote on a proposal |
| `SIDECHAIN_CREATE` | Register a new sidechain |
| `SIDECHAIN_ANCHOR` | Commit sidechain state root to main chain |
| `BRIDGE_LOCK` | Lock ANKH for cross-chain transfer |
| `BRIDGE_RELEASE` | Release ANKH after cross-chain burn |
| `NODE_REGISTER` | Register a node as a trusted verifier |
| `RESERVE_RELEASE` | Disburse from reserve wallet (governance-gated) |
| `AGE_VERIFICATION` | Supplementary age evidence |
| `CONTRACT_DEPLOY` | Deploy a smart contract |
| `CONTRACT_CALL` | Call a smart contract |

---

## Mainnet Endpoints

| Service | URL |
|---|---|
| REST API | `https://api.ankh.cash/api/v1/` |
| WebSocket | `wss://api.ankh.cash` |
| SDK (browser) | `https://api.ankh.cash/ankh-sdk.js` |
| P2P bootstrap | `ws://p2p.ankh.cash:6002` |
| Chain download | `https://api.ankh.cash/api/v1/chain/download` |

Third-party nodes and sidechain operators: set `ANKH_NODE_URL=https://api.ankh.cash` in your `.env`.

---

## Running a Node

### Quick start

```bash
git clone https://github.com/ankhcash/ankh-chain
cd ankh-chain
npm install
npm start
```

The node starts on port `3001` (API + WebSocket) and `6002` (P2P). On first startup it:

1. Generates a persistent secp256k1 node identity keypair (`data/node_identity.json`)
2. Loads or creates the genesis block
3. Connects to `ws://p2p.ankh.cash:6002` and syncs the chain
4. Determines its role based on peer count, then begins operating

### Node roles

| Role | When | Behavior |
|---|---|---|
| **Block producer** | `BLOCK_PRODUCER=true` or no peers at startup | Produces a block every 3 seconds |
| **Relay node** | Connected to peers at startup | Validates and forwards blocks; no production |
| **Emergency producer** | No block arrives for 120–180s (relay nodes) | Temporarily produces until primary returns |

Relay nodes never produce blocks directly. If the primary goes offline and no block arrives for ~120–180 seconds (random per-node jitter prevents competing producers), any relay promotes itself to emergency producer. When the primary reconnects and produces a block, the relay automatically steps down.

### Producer vs relay — the decision

```
BLOCK_PRODUCER=true     → always produce (designated primary)
BLOCK_PRODUCER=false    → always relay (no production, no failover ever)
(unset) + has peers     → relay mode + emergency failover enabled
(unset) + no peers      → wait 60s for peers; if none appear, produce
```

`VALIDATOR_ADDRESS` / `VALIDATOR_PRIVATE_KEY` give a node a **stable signing identity** across restarts. They do not force production — set `BLOCK_PRODUCER=true` if this node should be the primary producer.

### Running a public seed node

Open firewall ports `3001` (API) and `6002` (P2P). Share your address as `ws://your-ip:6002`.

```bash
SEED_PEERS=ws://p2p.ankh.cash:6002 npm start
```

### Private / isolated network (development)

```bash
SEED_PEERS= npm start   # no peers → will produce immediately as sole node
```

### Multi-node setup (producer + standby relays)

```bash
# Server A — designated block producer
BLOCK_PRODUCER=true \
VALIDATOR_ADDRESS=ankh_youraddress \
VALIDATOR_PRIVATE_KEY=your_hex_private_key \
SEED_PEERS=ws://server-b:6002,ws://server-c:6002 \
npm start

# Server B — relay + failover standby (no BLOCK_PRODUCER set)
SEED_PEERS=ws://server-a:6002,ws://server-c:6002 \
npm start

# Server C — relay + failover standby
SEED_PEERS=ws://server-a:6002,ws://server-b:6002 \
npm start
```

All three relay servers have failover enabled. If server A goes down, one relay promotes to emergency producer after ~120–180s. When A returns and produces a block, the emergency producer steps down automatically.

### Graceful shutdown

`Ctrl+C` or `SIGTERM` triggers:
1. Stop block production
2. Save all state to `data/`
3. Close P2P connections
4. Stop API server

Always allow the node to save cleanly. Killing with `SIGKILL` risks state divergence between `chain.json` (blocks) and the JSON state files.

---

## SDK — Build Wallets & dApps

The ANKH SDK is a zero-dependency JavaScript library for browsers and Node.js, served directly from every node.

### Load the SDK

```html
<!-- Browser — mainnet -->
<script src="https://api.ankh.cash/ankh-sdk.js"></script>

<!-- Browser — local dev -->
<script src="http://localhost:3001/ankh-sdk.js"></script>
```

```js
// Node.js
const AnkhSDK = require('./ankh-sdk');
```

### Initialize

```js
const sdk = new AnkhSDK({ nodeUrl: 'https://api.ankh.cash' });   // mainnet
const sdk = new AnkhSDK({ nodeUrl: 'http://localhost:3001' });    // local dev
```

### Wallets

```js
// Generate a new wallet — private key returned once, never stored on node
const wallet = await sdk.generateWallet();
// → { address: 'ankh_3a9f...', publicKey: '04...', privateKey: 'f3a7...' }

// Fully client-side (no network call)
const wallet = await AnkhSDK.createWallet();

// Import from existing private key
const wallet = sdk.importWallet('your_hex_private_key');
```

### Signed operations (recommended)

```js
sdk.setPrivateKey(wallet.privateKey);   // all mutating calls auto-sign

await sdk.send(wallet.address, 'ankh_recipient...', 100);
await sdk.stake(wallet.address, 10000);
await sdk.claimUBI(wallet.address);
await sdk.createToken({
  creator:       wallet.address,
  name:          'MyToken',
  symbol:        'MTK',
  tier:          1,
  initialSupply: '1000000',
  mintable:      true
});
```

### AnkhWallet convenience class

```js
const w = new AnkhWallet(sdk, wallet.address, wallet.privateKey);

const bal = await w.getBalance();          // → { raw: bigint, formatted: '100.00 ANKH' }
await w.send('ankh_recipient...', 50);
await w.stake(10000);
await w.claimUBI();
w.on('TRANSFER', tx => console.log('Received', tx.amount, 'ANKH'));
```

### Querying chain state

```js
const info    = await sdk.getChainInfo();          // height, chainId, validators
const stats   = await sdk.getStats();              // users, UBI distributed, tokens
const acct    = await sdk.getAccount(address);     // balance, nonce, isVerified
const balance = await sdk.getBalance(address);     // { raw, formatted }
const status  = await sdk.getUBIStatus(address);   // monthsClaimed, canClaim, nextClaimAvailable
const block   = await sdk.getLatestBlock();
const block   = await sdk.getBlock(12345);
const tokens  = await sdk.getTokens();
const token   = await sdk.getToken('MTK');          // by symbol or token address
const chains  = await sdk.getSidechains();
const chain   = await sdk.getSidechain('my-gov-1');
const nodes   = await sdk.getNodes();               // registered node operators
const peers   = await sdk.getNetworkPeers();
```

### Real-time events

```js
await sdk.connect();   // open WebSocket connection

sdk.on('NEW_BLOCK',         block => console.log('Block', block.index));
sdk.on('TRANSFER',          tx    => { if (tx.to === myAddr) notify(tx); });
sdk.on('USER_VERIFIED',     ev    => console.log('Verified', ev.address));
sdk.on('UBI_CLAIMED',       ev    => console.log('UBI claimed', ev.address, ev.amount));
sdk.on('TOKEN_CREATED',     ev    => console.log('New token', ev.symbol));
sdk.on('SIDECHAIN_CREATED', ev    => console.log('New chain', ev.chainId));
sdk.on('SIDECHAIN_ANCHORED',ev    => console.log('Anchor', ev.chainId, ev.anchorHeight));
sdk.on('GOVERNANCE_PASSED', ev    => console.log('Proposal passed', ev.title));
sdk.on('BRIDGE_LOCK',       ev    => console.log('Bridge lock', ev.amount));

sdk.disconnect();
```

### Important: signing and the node registry

The SDK uses a pure-JS secp256k1 implementation. For standard user operations (transfers, UBI claims, token creation) this is fine.

For **`NODE_REGISTER` transactions** — which the node verifies using the `elliptic` npm library — you must use `Transaction.sign()` from the `ankh_chain` directory directly. Both produce valid ECDSA signatures, but the `recoveryParam` can differ, causing the node to reconstruct the wrong address and reject the transaction.

```js
// In your ankh-chain directory (not browser code)
const Transaction = require('./src/core/Transaction');
const tx = new Transaction({ type: 'NODE_REGISTER', ... });
tx.sign(nodeIdentity.privateKey);   // calls elliptic directly — guaranteed match
```

---

## Biometric Verification

Verification establishes that an address belongs to a unique living human. It must succeed before an address can claim UBI, create institutional tokens, or propose sidechains.

### Requirements

- **7 live movements** including: `center`, `left`, `right`, `blink`, `smile` (plus 2 more)
- **Blink score** ≥ 0.75 (detects photo / printed face spoofing)
- **Sequence duration** 8–300 seconds (detects replay attacks — must be live)
- **Timing variance** std dev ≥ 50ms across movements (detects scripted/robotic timing)
- **Image quality** ≥ 0.5
- **Estimated biological age** ≥ 20 (with ±2-year buffer; 18–20 range goes to manual review)
- **No duplicate** — Euclidean distance must be > 0.6 from any existing 128-d face descriptor in the registry

### Verification pipeline (9 steps)

1. **Rate limit** — 5 attempts / hour per IP and per address
2. **Format validation** — check required fields
3. **Liveness detection** — 7 movements, blink score, timing variance, sequence duration
4. **Biometric hash** — SHA256 of 128-d face descriptor
5. **Local duplicate check** — exact hash match + Euclidean distance against all stored descriptors
6. **Blockchain duplicate check** — StateManager registry
7. **Network consensus** — 75% of connected peers must independently approve (fails open if network unreachable)
8. **Biological age** — facial + voice + skin analysis, weighted combination
9. **Quality check** — minimum image quality threshold

### API request

```
POST /api/v1/verify
Content-Type: application/json
```

```json
{
  "address": "ankh_youraddress",
  "biometricData": {
    "facial": {
      "descriptor": [0.12, -0.34, 0.56, "... 128 float values total"],
      "landmarks": ["... 68-point array, optional but improves accuracy"],
      "quality": 0.85,
      "sequence": [
        { "type": "center", "timestamp": 1700000000000, "score": 0.95 },
        { "type": "left",   "timestamp": 1700000002100, "score": 0.88 },
        { "type": "right",  "timestamp": 1700000004300, "score": 0.91 },
        { "type": "blink",  "timestamp": 1700000006800, "score": 0.92 },
        { "type": "smile",  "timestamp": 1700000009200, "score": 0.87 },
        { "type": "up",     "timestamp": 1700000011500, "score": 0.84 },
        { "type": "down",   "timestamp": 1700000013900, "score": 0.86 }
      ]
    },
    "voice": {
      "fundamentalFrequency": 142,
      "jitter": 0.03,
      "harmonicsToNoiseRatio": 18
    },
    "skin": {
      "textureUniformity": 0.72,
      "poreSize": 0.41,
      "elasticity": 0.68
    }
  }
}
```

### API response

```json
{
  "success": true,
  "data": {
    "verificationId": "uuid",
    "address": "ankh_...",
    "steps": ["liveness_passed", "no_duplicate", "age_verified"],
    "ageVerification": {
      "eligible": true,
      "estimatedAge": 34,
      "confidence": 0.87,
      "needsReview": false
    }
  }
}
```

### Age eligibility logic

| Estimated age | Confidence | Result |
|---|---|---|
| ≥ 20, confidence ≥ 0.70 | — | Approved |
| 18–20, confidence ≥ 0.90 | High | Approved |
| 18–20, confidence < 0.90 | Low | Manual review queue |
| < 16 (below min − 2yr buffer) | — | Rejected |
| Any age, confidence < 0.70 | Very low | Rejected or review |

---

## UBI Claims

Once verified, an address can claim one monthly UBI payment every 30 days, for up to 540 months (45 years).

```
GET  /api/v1/ubi/:address/status
POST /api/v1/ubi/:address/claim
```

### Status response

```json
{
  "success": true,
  "data": {
    "address":              "ankh_...",
    "isVerified":           true,
    "canClaim":             true,
    "monthsClaimed":        3,
    "remainingMonths":      537,
    "nextClaimAvailable":   "2026-04-19T00:00:00.000Z",
    "lifetimeAllocation":   "2800000000000000000000000",
    "totalClaimed":         "15555570000000000000000",
    "monthlyAmount":        "5185190000000000000000",
    "status":               "ACTIVE"
  }
}
```

### SDK usage

```js
const status = await sdk.getUBIStatus('ankh_youraddress');
if (status.data.canClaim) {
  const result = await sdk.claimUBI('ankh_youraddress');
  console.log('Claimed:', result.data.amount, 'ANKH');
  console.log('Next claim:', result.data.nextClaimAvailable);
}
```

### Allocation states

| State | Meaning |
|---|---|
| `ACTIVE` | Normal — claims allowed |
| `PAUSED` | Fraud investigation — claims suspended, resumes if cleared |
| `TERMINATED` | Permanent revocation — all remaining months forfeited |

---

## Tokens (ARC-20)

All Ankh Chain tokens follow the ARC-20 standard (fully ERC-20 compatible). All amounts use 18 decimal places.

### Token tiers

| Tier | Stake required | Max supply | Approval | Extra capabilities |
|---|---|---|---|---|
| **Community** | 100 ANKH | 1,000,000 tokens | Automatic | Basic transfer |
| **Standard** | 10,000 ANKH | Unlimited | 24-hour review + governance vote | Mintable, burnable, pausable |
| **Institutional** | 100,000 ANKH | Unlimited | Governance vote | + Can propose sidechains |
| **Sovereign** | 0 (treaty required) | Unlimited | Council approval | + National currency, full PoA |

Stake is locked for the life of the token. Reserved symbols (`ANKH`, `BTC`, `ETH`, `USD`, `EUR`, `GBP`) cannot be used.

### Create a token

```js
const result = await sdk.createToken({
  creator:             'ankh_youraddress',
  name:                'My Token',
  symbol:              'MTK',
  decimals:            18,
  initialSupply:       '1000000',    // human units (divided by 10^18 internally)
  maxSupply:           '10000000',   // null = unlimited
  stake:               '10000',      // ANKH to lock — determines tier automatically
  mintable:            true,
  burnable:            true,
  pausable:            false,
  verifiedHoldersOnly: false,        // if true, only verified humans can hold
  description:         'My token description',
  website:             'https://example.com'
});

// Community tier → active immediately
// Standard tier  → 24h review window opens
// Institutional  → governance vote begins
```

### Token operations

```js
// Transfer
await sdk.transferToken(tokenAddress, fromAddress, toAddress, '500');

// Mint (if mintable — creator has mint rights by default)
await sdk.mintToken(tokenAddress, minterAddress, recipientAddress, '1000');

// Burn (if burnable)
await sdk.burnToken(tokenAddress, holderAddress, '250');

// Query
const token   = await sdk.getToken('MTK');                       // by symbol
const balance = await sdk.getTokenBalance(tokenAddress, holder); // holder balance
```

---

## Sidechains — Institutional Integration

Governments and organisations can operate their own PoA sidechain that inherits the ANKH main chain's biometric identity layer. Citizens verified on the main chain are instantly recognized on all sidechains — one verification, valid everywhere.

### What sidechains inherit from the main chain

- **Identity** — `isVerified` status for every `ankh_` address, checked live
- **Sybil resistance** — benefit distribution automatically skips unverified addresses
- **Verification infrastructure** — biometrics run on registered main-chain nodes; no separate biometric system needed

### What sidechains control independently

- Native currency (name, symbol, supply)
- Payment amounts, schedules, and benefit types
- Block production (their own PoA authority nodes)
- Authority management (add/remove validators)
- Geographic or eligibility rules (via metadata)

---

### Step-by-step: launching a sidechain

#### Step 1 — Register your node as a trusted operator

This lets your node sign biometric registration proofs and submit anchor transactions to the main chain. The registration must be signed using `Transaction.sign()` from the `ankh_chain` directory — not the browser SDK — to ensure cryptographic compatibility.

```js
// register-node.js  (run inside ankh-chain/ directory)
require('dotenv').config();
const Transaction = require('./src/core/Transaction');
const fs = require('fs');

const ANKH_NODE_URL = process.env.ANKH_NODE_URL || 'https://api.ankh.cash';

async function main() {
  const ident = JSON.parse(fs.readFileSync('./data/node_identity.json', 'utf8'));
  const acct  = await (await fetch(`${ANKH_NODE_URL}/api/v1/accounts/${ident.address}`)).json();
  const nonce = acct.data?.nonce ?? 0;

  const tx = new Transaction({
    type:      'NODE_REGISTER',
    from:      ident.address,
    to:        'node_registry',
    value: 0n, fee: 0n, nonce,
    data:      { publicKey: ident.publicKey },
    timestamp: Date.now()
  });
  tx.sign(ident.privateKey);   // must use Transaction.sign(), not SDK

  const res = await fetch(`${ANKH_NODE_URL}/api/v1/transactions`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(tx)
  });
  console.log(await res.json());
}
main().catch(console.error);
```

```bash
ANKH_NODE_URL=https://api.ankh.cash node register-node.js

# Confirm registration
curl https://api.ankh.cash/api/v1/nodes
```

---

#### Step 2 — Check creator eligibility

```js
const ANKH_NODE_URL  = 'https://api.ankh.cash';
const creatorAddress = 'ankh_yourcreatoraddress';

const [statusRes, nodesRes] = await Promise.all([
  fetch(`${ANKH_NODE_URL}/api/v1/verify/status/${creatorAddress}`).then(r => r.json()),
  fetch(`${ANKH_NODE_URL}/api/v1/nodes`).then(r => r.json())
]);

const isVerified       = statusRes.data?.isVerified;
const isRegisteredNode = nodesRes.data?.some(n => n.address === creatorAddress);

// SOVEREIGN tier: verified human OR registered node operator
// Other tiers: must be biometrically verified
if (!isVerified && !isRegisteredNode) {
  throw new Error(
    'SOVEREIGN: run register-node.js first, OR complete biometric verification at ankh.cash'
  );
}
```

---

#### Step 3 — Propose the sidechain

```js
// propose-chain.js
require('dotenv').config();
const AnkhSDK = require('./ankh-sdk');

const sdk = new AnkhSDK({ nodeUrl: process.env.ANKH_NODE_URL || 'https://api.ankh.cash' });

async function main() {
  const creatorAddress = process.env.CREATOR_ANKH_ADDRESS;

  const result = await sdk.proposeSidechain({
    creator:         creatorAddress,
    name:            'Republic of Exampleland',
    chainId:         'exampleland-sovereign-1',  // must be globally unique
    tier:            'SOVEREIGN',
    institutionType: 'government',               // 'government' | 'organization' | 'cooperative'
    authorities: [
      {
        address: creatorAddress,
        name:    'Primary Authority Node',
        role:    'validator'
      }
    ],
    blockTime:      2000,   // ms between sidechain blocks
    nativeCurrency: {
      name:          'Exampleland Coin',
      symbol:        'EXC',
      decimals:      18,
      initialSupply: 0
    },
    metadata: {
      country:   'EX',
      region:    'Example Region',
      website:   'https://example.gov',
      ubiAmount: '500 EXC/month'
    }
  });

  console.log('Proposal result:', JSON.stringify(result.data, null, 2));
}
main().catch(console.error);
```

```bash
CREATOR_ANKH_ADDRESS=ankh_... ANKH_NODE_URL=https://api.ankh.cash node propose-chain.js
```

**SOVEREIGN tier:** requires Foundation council multi-sig approval. A threshold of Foundation members must each independently sign and submit an approval before the chain activates. See [Foundation council setup](#foundation-council-setup) below.

**INSTITUTIONAL tier:** requires a single Foundation council member approval.

**Other tiers (STANDARD/COMMUNITY):** require ≥5 governance votes with ≥66% approval:
```js
await sdk.voteOnSidechainProposal(proposalId, voterAddress, true, 'Approved');
```

---

#### Step 4 — Submit citizen verifications through your node

Your registered node signs `BIOMETRIC_REGISTRATION` transactions. Verifications are written to the **ANKH main chain** — making citizens visible to all sidechains automatically.

```
POST https://api.ankh.cash/api/v1/verify
Content-Type: application/json

{
  "address": "ankh_citizenaddress",
  "biometricData": { ... }
}
```

The node's secp256k1 public key is embedded in the `verificationProof` of each registration. Peers verify this proof against `registered_nodes.json` to confirm the verification came from a legitimate operator.

---

#### Step 5 — Distribute sidechain benefits

Only verified addresses receive payments. Unverified addresses are silently skipped — they are not an error.

```js
await sdk.distributeSidechainBenefits(
  'exampleland-sovereign-1',    // your chainId
  authorityAddress,             // must be in the sidechain's authorities list
  [
    'ankh_citizen1...',
    'ankh_citizen2...',
    'ankh_citizen3...'
  ],
  [
    '500000000000000000000',    // 500 EXC per citizen (18 decimals)
    '500000000000000000000',
    '500000000000000000000'
  ],
  'MONTHLY_BENEFIT'             // arbitrary label recorded on-chain
);
```

---

#### Step 6 — Anchor sidechain state to the main chain

Anchoring commits a cryptographic state root of your sidechain to the ANKH main chain every N blocks. This provides trustless auditability — anyone can verify your sidechain's history without running your node.

> **Critical:** anchor calls must target `https://api.ankh.cash`, NOT `localhost` or your own node. Your sidechain runs on your server; the anchor must be submitted to the ANKH mainnet.

```js
// anchor.js — run periodically from your sidechain node (every 100 blocks recommended)

const ANKH_MAINNET_URL  = 'https://api.ankh.cash';   // mainnet, not your own node
const SIDECHAIN_ID      = 'exampleland-sovereign-1';
const AUTHORITY_ADDRESS = 'ankh_yourauthorityaddress'; // exact address from your proposal

async function anchorToMainnet(blockHeight, stateRoot) {
  let response, result;
  try {
    response = await fetch(
      `${ANKH_MAINNET_URL}/api/v1/sidechains/${SIDECHAIN_ID}/anchor`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from:         AUTHORITY_ADDRESS,  // must match a registered authority address
          anchorHash:   stateRoot,          // SHA256 hash of your sidechain's current state
          anchorHeight: blockHeight         // your sidechain's block number
        })
      }
    );
    result = await response.json();
  } catch (err) {
    console.error(`[Anchor] Network error at height ${blockHeight}:`, err.message);
    return false;
  }

  // Always check the response — do not log success before confirming
  if (!result.success) {
    console.error(`[Anchor] FAILED at height ${blockHeight}: ${result.error}`);
    return false;
  }

  console.log(`[Anchor] Block ${blockHeight} anchored → mainnet block #${result.data.blockIndex}`);
  return true;
}

// Wire into your block production loop:
if (blockHeight % 100 === 0) {
  const stateRoot = computeStateRoot();   // your state hash function
  await anchorToMainnet(blockHeight, stateRoot);
}
```

**Verify the anchor landed:**

```bash
curl https://api.ankh.cash/api/v1/sidechains/exampleland-sovereign-1 \
  | jq '{ lastAnchorBlock: .data.lastAnchorBlock, lastAnchorHash: .data.lastAnchorHash }'
```

---

#### Common anchor errors

| Error message | Cause | Fix |
|---|---|---|
| `SIDECHAIN_ANCHOR: sidechain X not found` | Sidechain not registered on mainnet | Complete steps 1–3 first |
| `SIDECHAIN_ANCHOR: caller is not an authority` | `from` address not in authorities list | Use the exact `ankh_` address from your `authorities` array in step 3 |
| `from, anchorHash, and anchorHeight are required` | Missing fields | Check your request body |
| Connection refused / timeout | Wrong URL — posting to localhost instead of mainnet | Set `ANKH_MAINNET_URL=https://api.ankh.cash` |

**Quick connectivity test:**

```bash
curl -X POST https://api.ankh.cash/api/v1/sidechains/your-chain-id/anchor \
  -H "Content-Type: application/json" \
  -d '{"from":"ankh_yourauthority","anchorHash":"test","anchorHeight":1}'
# Should return: {"success":true,"data":{"blockIndex":...}}
```

---

### Sidechain tiers

| Tier | Stake | Eligibility | Approval | Capabilities |
|---|---|---|---|---|
| **SOVEREIGN** | 500,000 ANKH | Biometrically verified | Foundation council M-of-N multi-sig | National currency, full PoA control |
| **INSTITUTIONAL** | 100,000 ANKH | Biometrically verified | Single Foundation council member | Custom token + sidechain |
| **STANDARD** | 10,000 ANKH | Biometrically verified | 24h review + governance vote | Custom rules |
| **COMMUNITY** | 100 ANKH | Biometrically verified | Auto | Basic |

### What the `from` address must be

The `from` field in anchor requests, and the `distributor` field in benefit distribution, must be an address listed in your sidechain's `authorities` array. Check your current authorities:

```bash
curl https://api.ankh.cash/api/v1/sidechains/your-chain-id | jq '.data.authorities[].address'
```

---

## Foundation council setup

The Ankh Foundation council governs SOVEREIGN and INSTITUTIONAL sidechain approvals. It is an M-of-N secp256k1 multi-sig: a configurable threshold of council members must each independently sign an approval before a SOVEREIGN chain activates.

The council is stored in `data/foundation_council.json`. **This file contains public keys only** and is safe to commit. Private keys are never stored on the server.

### Generate council keypairs

Run this **once** on a secure, preferably air-gapped machine:

```bash
# 3 members, 2-of-3 threshold (default)
node scripts/generate-foundation-keys.js

# Custom: 5 members, 3-of-5 threshold
node scripts/generate-foundation-keys.js 5 3
```

The script prints each member's private key to stdout and writes the public council file to `data/foundation_council.json`. Distribute each private key to its respective member through a secure channel. **Private keys cannot be recovered** — store them in a hardware wallet or encrypted vault.

### Query council status

```bash
curl https://api.ankh.cash/api/v1/sidechains/council
```

```json
{
  "success": true,
  "data": {
    "type": "foundation",
    "threshold": 2,
    "totalMembers": 3,
    "members": [
      { "name": "Ankh Foundation Member 1", "address": "ankh_..." }
    ],
    "description": "2-of-3 Foundation council required for SOVEREIGN approval"
  }
}
```

If no council is configured (`members` is empty), the node falls back to registered node-operator approval for backward compatibility.

### Approving a SOVEREIGN proposal

Each required Foundation member runs the signing helper:

```bash
FOUNDATION_PRIVATE_KEY=<hex> node scripts/approve-proposal.js <proposalId>
# Against a specific node:
FOUNDATION_PRIVATE_KEY=<hex> node scripts/approve-proposal.js <proposalId> https://api.ankh.cash
```

Or POST directly:

```bash
# 1. Build the message and sign it (secp256k1 / SHA-256)
#    message = JSON.stringify({ action: 'APPROVE_SIDECHAIN', proposalId, timestamp })
#    sig = secp256k1.sign(sha256(message))

curl -X POST https://api.ankh.cash/api/v1/sidechains/proposals/<proposalId>/approve \
  -H "Content-Type: application/json" \
  -d '{
    "timestamp": 1234567890000,
    "signature": {
      "publicKey": "<uncompressed-hex>",
      "r": "<hex>",
      "s": "<hex>"
    }
  }'
```

The node verifies the signature, checks council membership, and records the vote. When the threshold is reached the chain status changes to `APPROVED` automatically.

```json
{ "success": true, "data": { "status": "APPROVED", "sidechain": { "chainId": "..." } } }
```

Before threshold:
```json
{ "success": true, "data": { "foundationApprovals": 1, "required": 2, "status": "PENDING" } }
```

---

## Governance

On-chain proposals for protocol changes. Requires ≥100,000 ANKH to propose, 7-day voting window, 66% supermajority (minimum 10 votes) to pass.

### Propose

```js
await sdk.proposeGovernance(address, {
  title:       'Increase monthly UBI by 2%',
  description: 'Full rationale...',
  type:        'PARAMETER_CHANGE',
  params:      { key: 'MONTHLY_UBI_AMOUNT', value: '...' }
});
```

**Proposal types:**

| Type | Description |
|---|---|
| `PARAMETER_CHANGE` | Modify a chain constant |
| `PROTOCOL_UPGRADE` | Schedule a node upgrade |
| `RESERVE_RELEASE` | Disburse from a reserve wallet |
| `VALIDATOR_SLASH` | Penalize a misbehaving validator |
| `EMERGENCY` | Fast-track critical fix (24-hour window) |

### Vote and execute

```js
await sdk.voteGovernance(address, proposalId, 'YES');   // 'YES' | 'NO' | 'ABSTAIN'

// After proposal passes the 7-day window with 66% YES:
await sdk.executeGovernance(proposalId);
```

### Lifecycle

```
PROPOSED → ACTIVE (7 days) → PASSED / REJECTED / EXPIRED → EXECUTED
```

### API

```
GET  /api/v1/governance/proposals?status=ACTIVE   → filter by status
GET  /api/v1/governance/proposals/:id
POST /api/v1/governance/propose
POST /api/v1/governance/vote
POST /api/v1/governance/proposals/:id/execute
```

---

## Ethereum Bridge

Transfer value between the native ANKH chain and Ethereum (ERC-20 ANKH).

```js
// Native → Ethereum: lock ANKH native → receive ANKH ERC-20 on ETH
await sdk.bridgeLock(address, 500, 'ethereum', '0xYourEthAddress');

// Ethereum → Native: burn ANKH ERC-20 on ETH → release native ANKH
await sdk.bridgeRelease('ankh_recipient...', 500, ethBurnTxHash);
```

**Constraints:**

| Parameter | Value |
|---|---|
| Minimum amount | 100 ANKH |
| Bridge fee | 0.1% |
| Multi-sig threshold | 2-of-N validators |
| Expiration window | 24 hours after lock |

```
GET  /api/v1/bridge/status             → volume, fees, active validators
GET  /api/v1/bridge/deposits/:lockId   → status of a specific deposit
POST /api/v1/bridge/lock               → initiate lock (Native → ETH)
POST /api/v1/bridge/release            → release (ETH burn → Native)
```

---

## Validators & Staking

Validators produce blocks in DPoS rounds. The top 21 staked validators are active in each epoch (100 blocks).

### Stake

```js
// Stake to become a validator (minimum 10,000 ANKH)
await sdk.stake(address, 10000);

// Delegate to an existing validator
await sdk.stake(address, 5000, validatorAddress);

// Unstake (begins 21-day unbonding)
await sdk.unstake(address, 5000);
```

### Query

```
GET /api/v1/validators           → all validators (stake, blocksProduced, rewards)
GET /api/v1/validators/top       → top 21 (active epoch set)
```

### Rewards and penalties

- **Rewards:** 50% of transaction fees, distributed proportional to stake per block produced
- **Slashing:** 10% stake reduction for producing invalid blocks or equivocation
- **Deactivation:** automatic when stake falls below 10,000 ANKH minimum

---

## API Reference

All endpoints prefixed `/api/v1`. Token amounts in raw units (18 decimal places) unless noted. BigInt values returned as strings.

### Health & Chain Info

```
GET  /health                              → { status: 'ok' }
GET  /api/v1/info                         → { chainId, height, latestBlockHash, pendingTxs, validators }
GET  /api/v1/stats                        → { totalVerifiedUsers, totalUBIDistributed, chainHeight, connectedPeers, ... }
GET  /api/v1/chain-config                 → All GenesisConfig constants
GET  /api/v1/genesis                      → Genesis block
```

### Blocks

```
GET  /api/v1/blocks/latest                → Latest block
GET  /api/v1/blocks/:index                → Block by index
GET  /api/v1/blocks/hash/:hash            → Block by hash
GET  /api/v1/blocks?limit=50&offset=0     → Paginated blocks
```

### Accounts

```
GET  /api/v1/accounts/:address            → { address, balance, nonce, isVerified, stakedAmount }
GET  /api/v1/accounts/:address/balance    → { address, balance, balanceFormatted }
GET  /api/v1/accounts/:address/transactions?limit=50
```

### Transfers & Transactions

```
POST /api/v1/send                         → Trusted send { from, to, amount }
POST /api/v1/transactions                 → Submit pre-signed tx { type, from, to, value, fee, data, signature }
GET  /api/v1/transactions/pending         → Current mempool
GET  /api/v1/transactions/:id             → Transaction by ID
```

### UBI

```
GET  /api/v1/ubi/stats                    → Global UBI statistics
GET  /api/v1/ubi/:address/status          → { canClaim, monthsClaimed, remainingMonths, nextClaimAvailable, ... }
POST /api/v1/ubi/:address/claim           → Claim monthly UBI → { claimId, amount, nextClaimAvailable }
```

### Biometric Verification

```
POST /api/v1/verify                       → { address, biometricData } → { verificationId, steps, ageVerification }
GET  /api/v1/verify/:address/status       → { isVerified, verificationId, verifiedAt }
```

### Tokens (ARC-20)

```
GET  /api/v1/tokens                       → All tokens
GET  /api/v1/tokens/tiers                 → Tier requirements (stake, approval)
GET  /api/v1/tokens/:identifier           → Token by address or symbol
POST /api/v1/tokens/create                → { creator, name, symbol, stake, initialSupply, ... }
GET  /api/v1/tokens/:address/balance/:holder
POST /api/v1/tokens/:address/mint         → { from, toAddress, amount }  — mintable only
POST /api/v1/tokens/:address/burn         → { from, amount }             — burnable only
POST /api/v1/tokens/:address/transfer     → { from, to, amount }
```

### Validators & Staking

```
GET  /api/v1/validators                   → All validators
GET  /api/v1/validators/top?count=21      → Top N by stake
POST /api/v1/validators/stake             → { from, amount, validator? }
POST /api/v1/validators/unstake           → { from, amount }
```

### Governance

```
GET  /api/v1/governance/proposals?status=ACTIVE
GET  /api/v1/governance/proposals/:id
POST /api/v1/governance/propose           → { from, title, description, type, params }
POST /api/v1/governance/vote              → { from, proposalId, vote }  — YES|NO|ABSTAIN
POST /api/v1/governance/proposals/:id/execute
```

### Sidechains

```
GET  /api/v1/sidechains                          → All registered sidechains
GET  /api/v1/sidechains/:chainId                 → Detail: lastAnchorBlock, authorities, metadata
POST /api/v1/sidechains/propose                  → { creator, name, chainId, tier, authorities, nativeCurrency, ... }
GET  /api/v1/sidechains/proposals                → Pending proposals
GET  /api/v1/sidechains/proposals/:id            → Single proposal detail
GET  /api/v1/sidechains/council                  → Foundation council info (threshold, members, type)
POST /api/v1/sidechains/proposals/:id/approve    → Foundation council approval (SOVEREIGN/INSTITUTIONAL)
                                                    Body: { timestamp, signature: { publicKey, r, s } }
POST /api/v1/sidechains/proposals/:id/vote       → Node-operator vote (STANDARD/COMMUNITY)
                                                    Body: { voter, approve, reason }
POST /api/v1/sidechains/:chainId/anchor          → { from, anchorHash, anchorHeight }
POST /api/v1/sidechains/:chainId/distribute      → { distributor, recipients[], amounts[], benefitType }
```

### Bridge

```
GET  /api/v1/bridge/status                → Bridge volume, fees, multi-sig validators
POST /api/v1/bridge/lock                  → { from, amount, targetChain, targetAddress }
GET  /api/v1/bridge/deposits/:lockId      → Lock/withdrawal status
POST /api/v1/bridge/release               → { to, amount, lockTxHash }
```

### Nodes & Network

```
GET  /api/v1/nodes                        → All registered node operators
GET  /api/v1/nodes/:identifier            → By public key (hex) or ankh_ address
GET  /api/v1/network/peers                → Connected peers (nodeId, height, users, address)
GET  /api/v1/peg/status                   → { currentPrice, deviation, isStable, collateralRatio }
GET  /api/v1/peg/history?limit=100        → Price history
```

---

## WebSocket Events

Connect to `wss://api.ankh.cash` (mainnet) or `ws://localhost:3001` (local).

| Event | Payload |
|---|---|
| `CONNECTED` | `{ chainId, height }` |
| `NEW_BLOCK` | `{ index, hash, timestamp, transactionCount, validator }` |
| `NEW_TRANSACTION` | `{ hash, type, from, to }` |
| `USER_VERIFIED` | `{ address, verificationId, blockIndex }` |
| `UBI_CLAIMED` | `{ address, amount, monthsClaimed, blockIndex }` |
| `TRANSFER` | `{ from, to, amount, blockIndex }` |
| `TOKEN_CREATED` | `{ symbol, tokenAddress, creator, tier }` |
| `SIDECHAIN_CREATED` | `{ chainId, name, institutionType }` |
| `SIDECHAIN_ANCHORED` | `{ chainId, anchorHeight, anchorHash, mainnetBlockIndex }` |
| `GOVERNANCE_PROPOSE` | `{ proposalId, type, title, proposer }` |
| `GOVERNANCE_VOTE` | `{ proposalId, voter, vote, currentStatus }` |
| `GOVERNANCE_PASSED` | `{ proposalId, type, title }` |
| `GOVERNANCE_REJECTED` | `{ proposalId }` |
| `BRIDGE_LOCK` | `{ from, amount, targetChain, targetAddress }` |
| `BRIDGE_RELEASE` | `{ to, amount, lockTxHash }` |

---

## Data Persistence

All state is written to `data/` on graceful shutdown and periodically during operation.

| File | Contents |
|---|---|
| `chain.json` | Full blockchain — all blocks and transactions |
| `node_identity.json` | Node secp256k1 keypair — **back up, never share `privateKey`** |
| `accounts.json` | Balances, nonces, verification flags |
| `verified_users.json` | Biometric registry (hash → address) |
| `ubi_allocations.json` | UBI claim history per address |
| `tokens.json` | ARC-20 token states and holder balances |
| `validators.json` | Validator stakes, delegations, slashing history |
| `sidechains.json` | Registered sidechains + anchor history |
| `governance.json` | Proposals and votes |
| `biometric_descriptors.json` | 128-dimensional face embeddings (max 500K in memory, ~300MB) |
| `registered_nodes.json` | Trusted node secp256k1 public keys |
| `reserve_wallets.json` | Reserve addresses (written once at genesis) |
| `stats.json` | Global chain statistics |
| `processed_bridge_locks.json` | Bridge double-spend prevention set |

### BigInt serialization

All token amounts (18 decimals) are BigInt internally. They are stored as `"123n"` strings in JSON and deserialized automatically on load. REST API responses convert BigInt to plain strings.

### Biometric descriptor memory

The node loads up to 500,000 face descriptors into RAM (~300MB). Beyond this, the oldest descriptors are evicted and duplicate detection is degraded for those users. On high-population nodes, plan for this and consider sharding the descriptor store as the network grows.

---

## Environment Variables

```env
# Storage
DATA_DIR=./data                      # Where to persist chain state

# Networking
API_PORT=3001                        # REST + WebSocket port
P2P_PORT=6002                        # P2P gossip port
ENABLE_P2P=true                      # false = API-only mode (no sync)
SEED_PEERS=ws://p2p.ankh.cash:6002   # Bootstrap peers (comma-separated ws:// URLs)

# Block production
BLOCK_PRODUCER=true                  # Force production as primary producer
# BLOCK_PRODUCER=false               # Force relay-only (no production, no failover)
# (unset)                            # Auto: produce if no peers, relay otherwise

# Validator identity (auto-generated if omitted)
VALIDATOR_ADDRESS=ankh_...           # Stable signing address across restarts
VALIDATOR_PRIVATE_KEY=hex...         # Corresponding secp256k1 private key

# For sidechain operators (set in your .env)
ANKH_NODE_URL=https://api.ankh.cash  # Mainnet API target for anchors and registration
CREATOR_ANKH_ADDRESS=ankh_...        # Your sidechain creator address
```

---

## Troubleshooting

### Failover loop: `No block for Xs — promoting → stepping down → repeat`

**Cause:** Relay node promotes to emergency producer because no block arrives, then a peer reconnects but doesn't produce any blocks, so the relay steps down — then the gap timer fires again.

**Solutions:**
- Ensure your designated primary has `BLOCK_PRODUCER=true` and is reachable
- Single-node setup: start without seed peers so it enters production immediately:
  ```bash
  SEED_PEERS= npm start
  ```
- Check that the primary's P2P port (6002) is open and reachable from relay nodes

---

### Sidechain anchor fails: `caller is not an authority`

**Cause:** The `from` address in your anchor request doesn't match any authority in the sidechain registry.

```bash
# Check your registered authorities
curl https://api.ankh.cash/api/v1/sidechains/your-chain-id | jq '.data.authorities[].address'
```

Use the exact address shown. The authority address is the `ankh_` address, not a public key or node ID.

---

### Anchor calls appear to succeed but `lastAnchorBlock` stays null

**Cause:** Your anchor code logs "anchored" before `await`-ing the HTTP response. The actual request is either failing silently or going to the wrong URL (e.g., `http://localhost:3001` on your own server instead of `https://api.ankh.cash`).

**Test directly:**
```bash
curl -X POST https://api.ankh.cash/api/v1/sidechains/your-chain-id/anchor \
  -H "Content-Type: application/json" \
  -d '{"from":"ankh_yourauthority","anchorHash":"test","anchorHeight":1}'
```

If this returns `{"success":true,...}` and the mainnet shows `lastAnchorBlock: 1`, your code has the wrong URL or isn't checking the response.

**Fix:** Set `ANKH_MAINNET_URL=https://api.ankh.cash` and always `await` and check `result.success` before logging.

---

### Node registration fails (signature mismatch / wrong address recovered)

**Cause:** Using the SDK to sign `NODE_REGISTER` instead of `Transaction.sign()`.

**Fix:** Use `Transaction.sign()` from the `ankh_chain` directory:
```js
const Transaction = require('./src/core/Transaction');
const tx = new Transaction({ type: 'NODE_REGISTER', ... });
tx.sign(nodeIdentity.privateKey);  // uses same elliptic library as verifier
```

---

### P2P port conflict: `EADDRINUSE` on port 6002

The node handles this gracefully and continues in API-only mode (no P2P sync). To resolve:

```bash
lsof -i :6002       # find what's using the port
kill <PID>          # stop it, then restart node
# or use a different port:
P2P_PORT=6003 npm start
```

---

### State wrong after restart (balances / allocations look old)

**Cause:** Node was killed without saving state (`SIGKILL`), leaving `data/` files from a prior checkpoint while `chain.json` has newer blocks.

**Fix:** The node replays `chain.json` on startup and rebuilds state. If `chain.json` is corrupted, restore from a peer:
```bash
# Download chain from mainnet, then restart
curl https://api.ankh.cash/api/v1/chain/download -o data/chain.json
npm start
```

---

### Biometric duplicate detection degraded

**Cause:** More than 500,000 verified users — the node can no longer hold all 128-d descriptors in RAM.

**Symptom in logs:**
```
[StateManager] X descriptors on disk — loaded most recent 500000. Duplicate detection may miss oldest Y users.
```

**Fix:** Upgrade to a host with more RAM, or shard the `biometric_descriptors.json` across specialized nodes. The chain continues operating — only historical duplicate detection (for the oldest users) is degraded.

---

### Verification rejected: `Network consensus failed`

**Cause:** Fewer than 3 peers available, or fewer than 75% voted to approve.

The verifier fails **open** (allows the verification) when the network is completely unreachable. Consensus is only required when peers are connected but vote against approval.

**Fix:** Ensure your verification node has ≥3 stable peer connections before accepting public verifications.

---

## Security Model

### Cryptography

- **Signatures:** secp256k1 ECDSA (same algorithm as Bitcoin and Ethereum)
- **Hashing:** SHA256 for block hashes, transaction IDs, biometric hashes, state roots
- **Key derivation:** None — keys are generated randomly via `elliptic` and never derived from passwords or passphrases
- **Key recovery:** Public key reconstructed from (signature, message hash) at verification time — never stored separately

### Block security

- Every block is signed by the producing validator's secp256k1 key
- Peers verify signature + state root + transaction merkle root before accepting
- Fork detection: blocks with incorrect `previousHash` are immediately rejected
- Trusted node key set grows as peers exchange signed blocks — new nodes inherit trust from the network

### Biometric security

- **128-dimensional face descriptor:** ~0.001% false positive rate at 0.6 Euclidean threshold (face-api standard)
- **Liveness detection:** 7 distinct movements + blink scoring + timing variance defeats photo, video, and replay attacks
- **Network consensus:** 75% of peers must independently approve — prevents single-node fraud
- **Verification proof:** secp256k1 signature from a registered node is embedded in every `BIOMETRIC_REGISTRATION` — proves verification ran through a legitimate operator node
- **Rate limiting:** 5 attempts/hour/IP prevents biometric scanning attacks

### UBI security

- **Global supply cap:** `MAX_TOTAL_SUPPLY` enforced at every claim — minting beyond cap is impossible
- **Monthly cooldown:** 30-day lock enforced at transaction execution in StateManager — cannot be bypassed by re-submitting
- **Allocation history:** on-chain and immutable — cannot be modified without a validator-signed block
- **Fraud response chain:** pause → investigate → resume or terminate, each step recorded on-chain

### Node and network security

- **Node identity:** persisted secp256k1 keypair in `data/node_identity.json` — back up, restrict file permissions
- **Peer banning:** nodes sending invalid data are banned for the session
- **Rate limiting:** max 1000 messages/peer/minute, per-peer counters reset after 60s
- **Self-connection rejection:** nodes recognize and reject connections to themselves

### Reserve security

- 5 reserve wallets, each with a distinct address
- Every disbursement requires a `RESERVE_RELEASE` transaction with a stated reason
- All reserve releases are permanently recorded in the blockchain
- Emergency reserve requires 66% governance supermajority to access

---

## Relationship to the Ethereum ICO

| Aspect | Native Ankh Chain | Ethereum ICO |
|---|---|---|
| Purpose | UBI distribution to humanity | Fundraising |
| Token | Native ANKH (1 ANKH = $1) | ANKH ERC-20 (market price) |
| Issuance | Biometric-gated only | Purchase only |
| Supply | Dynamic (demand-based, biometric-gated) | Fixed 9 billion |
| Verification | Required for UBI | Not required |

The ETH bridge transfers value between the two. The native chain is the canonical UBI distribution system; the ETH token is a derivative instrument for liquidity and fundraising.

---

## License

MIT
