# Ankh Chain

**Universal Basic Income Blockchain for Humanity**

Ankh Chain is a native blockchain that distributes Universal Basic Income (UBI) to biometrically verified humans worldwide. It supports a maximum population of 10 billion people, each receiving a lifetime allocation of $2,800,000 distributed over 45 years.

## Key Features

### Economics
- **1 ANKH = $1 USD** — Stablecoin peg
- **$2.8M Lifetime Allocation** per verified person
- **~$5,185 Monthly UBI** distributed over 540 months (45 years)
- **10 Billion Max Population** capacity
- **2.8 × 10¹⁶ ANKH Max Total Supply** — `10B people × $2.8M/person`, issued on-demand via UBI only
- **2.8 × 10¹⁵ ANKH Genesis Reserve** — 10% of max supply (proportional to 1B-person fluctuation buffer / 10B population)
- **Supply is biometric-gated** — ANKH can only enter circulation through verified human claims; no pre-mine, no ICO issuance

### Consensus
- **Hybrid DPoS/PoA** — Main chain uses Delegated Proof of Stake (21 validators)
- **Institutional Sidechains** — Governments and organisations use Proof of Authority
- **3-second block time** on main chain; 1-second on sidechains

### Verification
- **Biological Age Verification** — No government documents required
- **Multi-modal Biometrics** — Face + Voice + Skin analysis
- **95% Duplicate Detection** threshold (128-dimensional Euclidean distance)
- **Stateless-friendly** — Supports undocumented individuals

### Token Standards (ARC)
- **ARC-20** — Fungible subtokens (like ERC-20)
- **ARC-721** — NFTs (like ERC-721)
- **Tiered Creation** — Community, Standard, Institutional, Sovereign

---

## Quick Start

```bash
cd ankh_chain
npm install
npm start

# Custom ports
API_PORT=3001 P2P_PORT=6002 npm start
```

---

## SDK — Build wallets and dApps

The ANKH SDK is a **zero-dependency** JavaScript library (browser + Node.js) served directly from every node. It includes built-in secp256k1 signing — no external crypto library needed.

```html
<!-- Browser -->
<script src="http://localhost:3001/ankh-sdk.js"></script>
```

```js
// Node.js
const AnkhSDK = require('./ankh-sdk');
const { AnkhWallet } = require('./ankh-sdk');
```

### Wallet

```js
const sdk = new AnkhSDK({ nodeUrl: 'http://localhost:3001' });

// Generate wallet — private key returned once, never stored on node
const wallet = await sdk.generateWallet();
// → { address: 'ankh_3a9f...', publicKey: '04...', privateKey: 'f3a7...' }

// Or fully client-side (no network call)
const wallet = await AnkhSDK.createWallet();
```

### Signed operations (recommended for production)

```js
sdk.setPrivateKey(wallet.privateKey);   // all mutating calls auto-sign

await sdk.send(wallet.address, 'ankh_recipient...', 100);
await sdk.stake(wallet.address, 10000);
await sdk.claimUBI(wallet.address);
await sdk.createToken({ creator: wallet.address, name: 'MyToken', symbol: 'MTK',
                        tier: 1, initialSupply: '1000000', mintable: true });
```

### AnkhWallet convenience class

```js
const w = new AnkhWallet(sdk, wallet.address, wallet.privateKey);

await w.getBalance();                          // → { raw, formatted }
await w.send('ankh_recipient...', 50);
await w.stake(10000);
await w.claimUBI();
w.on('TRANSFER', tx => console.log('Received', tx.amount, 'ANKH'));
```

### Real-time events

```js
await sdk.connect();
sdk.on('NEW_BLOCK',      block => console.log('Block',   block.index));
sdk.on('TRANSFER',       tx    => { if (tx.to === myAddr) notify(tx); });
sdk.on('USER_VERIFIED',  ev    => console.log('Verified', ev.address));
sdk.on('UBI_CLAIMED',    ev    => console.log('UBI',      ev.address));
sdk.on('TOKEN_CREATED',  ev    => console.log('Token',    ev.symbol));
sdk.on('GOVERNANCE_PASSED', ev => console.log('Passed',   ev.title));
```

---

## Sidechains — Institutional Integration Guide

Governments and organisations can create PoA sidechains that inherit the main chain's **biometric identity layer** while running their own payment rules, block production, and native currency.

### Creator eligibility

Before proposing a sidechain, the creator address must satisfy one of:

| Tier | Eligibility |
|---|---|
| **SOVEREIGN** (governments) | Biometrically verified on ANKH main chain **or** registered as a node operator |
| **INSTITUTIONAL / STANDARD / COMMUNITY** | Biometrically verified on ANKH main chain |

**Sovereign tier bypass:** If your government node is registered (`NODE_REGISTER` tx confirmed), that same address can propose the sidechain immediately — no personal biometric required. Running chain infrastructure is accepted as proof of institutional identity.

Check eligibility before proposing:
```js
const nodes  = await sdk.getNodes();
const status = await sdk.getVerificationStatus(creatorAddress);
const isRegisteredNode = nodes.data?.some(n => n.address === creatorAddress);

if (!status.data?.isVerified && !isRegisteredNode) {
  // For SOVEREIGN tier: register your node first (step 1 below)
  // For other tiers: complete biometric verification at ankh.cash
  throw new Error('Creator not eligible');
}
```

> **Identity association:** Biometric verification on the main chain sets `isVerified = true` permanently on that address. Any sidechain that reads that address instantly sees the verified status — there is no separate linking step. One verification, valid everywhere.

---

### Step-by-step: launching a government sidechain

#### Step 1 — Register your node as a trusted verifier

This allows your node to sign biometric registration proofs and submit them to the main chain on behalf of citizens. **Use `Transaction.sign()` directly** — not the SDK's built-in signer — to ensure the `elliptic` library matches the server's signature verifier:

```js
// register-node.js  (run in your ankh-chain directory)
require('dotenv').config();
const Transaction = require('./src/core/Transaction');
const fs          = require('fs');
const NODE_URL    = process.env.ANKH_NODE_URL || 'http://localhost:3001';

async function main() {
  const ident = JSON.parse(fs.readFileSync('./data/node_identity.json', 'utf8'));
  const nonce = (await (await fetch(`${NODE_URL}/api/v1/accounts/${ident.address}`)).json()).data?.nonce ?? 0;

  const tx = new Transaction({
    type: 'NODE_REGISTER', from: ident.address, to: 'node_registry',
    value: '0', fee: '0', nonce,
    data: { publicKey: ident.publicKey }, timestamp: Date.now()
  });
  tx.sign(ident.privateKey);

  const res = await fetch(`${NODE_URL}/api/v1/transactions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tx)
  });
  console.log(await res.json());
}
main().catch(console.error);
```

```bash
node register-node.js
# Verify it landed:
curl http://localhost:3001/api/v1/nodes
```

> **Why not `sdk.registerNode()`?** The SDK ships a pure-JS secp256k1 implementation using a non-RFC-6979 k-derivation scheme. The ANKH node verifies signatures using the `elliptic` npm library (RFC 6979). While both produce valid ECDSA signatures, the `recoveryParam` values may differ, causing `recoverPubKey` to reconstruct the wrong address and reject the tx. `Transaction.sign()` calls `elliptic` directly — same library, guaranteed match.

#### Step 2 — Propose the sidechain

```js
// propose-chain.js
require('dotenv').config();
const AnkhSDK = require('./ankh-sdk');

const sdk = new AnkhSDK({ nodeUrl: process.env.ANKH_NODE_URL || 'http://localhost:3001' });

async function main() {
  const creatorAddress = process.env.CREATOR_ANKH_ADDRESS;

  // Confirm eligibility
  const [statusRes, nodesRes] = await Promise.all([
    sdk.getVerificationStatus(creatorAddress),
    sdk.getNodes()
  ]);
  const isVerified       = statusRes.data?.isVerified;
  const isRegisteredNode = nodesRes.data?.some(n => n.address === creatorAddress);

  if (!isVerified && !isRegisteredNode) {
    throw new Error(
      'Creator must be biometrically verified (ankh.cash) ' +
      'OR a registered node operator (run register-node.js first)'
    );
  }

  const result = await sdk.proposeSidechain({
    creator:         creatorAddress,
    name:            'My Government Chain',
    chainId:         'my-gov-chain-1',
    tier:            'SOVEREIGN',
    institutionType: 'government',
    authorities:     [{ address: creatorAddress, name: 'Authority Node 1', role: 'validator' }],
    blockTime:       1000,
    nativeCurrency:  { name: 'GovToken', symbol: 'GTK', decimals: 18, initialSupply: 0 },
    metadata:        { website: 'https://example.gov' }
  });

  console.log('Sidechain proposed:', result.data);
}
main().catch(console.error);
```

#### Step 3 — Get governance approval (non-SOVEREIGN tiers)

SOVEREIGN tier sidechains do not require a community vote. For other tiers (≥5 votes, ≥66% YES):

```js
await sdk.voteOnSidechainProposal(proposalId, voterAddress, true, 'Approved');
```

#### Step 4 — Submit citizen biometric verifications through your node

Your registered node signs `BIOMETRIC_REGISTRATION` transactions on behalf of citizens. Verifications are written to the **main chain** — making citizens visible to all sidechains automatically.

```js
// Citizen verification goes to main chain via your registered node.
// The node's public key in the verificationProof is checked against registered_nodes.json.
// Once verified, isVerified = true for that address everywhere — no re-verification needed.
POST /api/v1/verify  { address, biometricData, livenessSteps }
```

#### Step 5 — Distribute sidechain benefits

Only verified addresses receive payments. Unverified addresses are silently skipped.

```js
await sdk.distributeSidechainBenefits(
  'my-gov-chain-1',
  authorityAddress,
  ['ankh_abc...', 'ankh_def...'],         // recipient ankh_ addresses
  ['4000000000000000000000', ...],         // 4,000 GTK per recipient (18 decimals)
  'MONTHLY_BENEFIT'                        // recorded on-chain as benefit type
);
```

#### Step 6 — Anchor sidechain state to main chain

Checkpoint your sidechain's block hashes to the main chain every N blocks for trustless auditability:

```js
await sdk.anchorSidechain('my-gov-chain-1', authorityAddress, blockHash, blockHeight);
```

---

### Sidechain tiers

| Tier | Stake required | Creator eligibility | Approval |
|---|---|---|---|
| **SOVEREIGN** | 0 ANKH | Verified human **or** registered node operator | None (instant) |
| **INSTITUTIONAL** | 100,000 ANKH | Biometrically verified | Governance vote |
| **STANDARD** | 10,000 ANKH | Biometrically verified | 24h review |
| **COMMUNITY** | 100 ANKH | Biometrically verified | Auto |

### What sidechains inherit from the main chain
- **Identity** — `isVerified` status for every address, checked live from main chain state
- **Sybil resistance** — benefit distribution automatically skips unverified addresses
- **Verification infrastructure** — biometrics run on registered main-chain nodes; no separate system needed

### What sidechains control themselves
- Payment amounts, schedules, and benefit types
- Native currency name, symbol, total supply
- Block production (their own PoA validators)
- Authority management (add/remove validators)
- Geographic or custom eligibility rules (via metadata)

---

## Governance

On-chain proposals for protocol changes. Requires ≥100k ANKH to propose, 7-day voting window, 66% supermajority to pass.

```js
await sdk.proposeGovernance(address, {
  title: 'Increase monthly UBI by 2%',
  description: '...',
  type: 'PARAMETER_CHANGE',
  params: { key: 'MONTHLY_UBI_AMOUNT', value: '...' }
});

await sdk.voteGovernance(address, proposalId, 'YES');  // 'YES' | 'NO' | 'ABSTAIN'
```

---

## Bridge (ETH ↔ ANKH)

```js
// Lock ANKH on native chain → receive ANKH on Ethereum
await sdk.bridgeLock(address, 500, 'ethereum', '0xYourEthAddress');

// Release ANKH on native chain from a confirmed ETH-side lock
await sdk.bridgeRelease('ankh_recipient...', 500, lockTxHash);
```

---

## API Reference

### Chain
```
GET  /health
GET  /api/v1/chain-config
GET  /api/v1/info
GET  /api/v1/stats
GET  /api/v1/genesis
```

### Blocks
```
GET  /api/v1/blocks/latest
GET  /api/v1/blocks/:index
GET  /api/v1/blocks?limit=&offset=
```

### Wallet & Accounts
```
POST /api/v1/wallet/generate
GET  /api/v1/wallet/derive?publicKey=
GET  /api/v1/accounts/:address
GET  /api/v1/accounts/:address/balance
GET  /api/v1/accounts/:address/transactions?limit=
```

### Transfers
```
POST /api/v1/send                           Trusted send { from, to, amount }
POST /api/v1/transactions                   Submit pre-signed transaction
GET  /api/v1/transactions/pending           Mempool
```

### UBI
```
GET  /api/v1/ubi/stats
GET  /api/v1/ubi/:address/status            { canClaim, monthsClaimed, remainingMonths, nextClaimAvailable }
POST /api/v1/ubi/:address/claim
```

### Verification
```
POST /api/v1/verify                         Biometric verification
GET  /api/v1/verify/:address/status
```

### Tokens (ARC-20)
```
GET  /api/v1/tokens
GET  /api/v1/tokens/tiers
GET  /api/v1/tokens/:identifier             By address or symbol
POST /api/v1/tokens/create
GET  /api/v1/tokens/:address/balance/:holder
POST /api/v1/tokens/:address/mint           { from, toAddress, amount }  — mintable tokens only
POST /api/v1/tokens/:address/burn           { from, amount }             — burnable tokens only
POST /api/v1/tokens/:address/transfer       { from, to, amount }
```

### Sidechains
```
GET  /api/v1/sidechains
GET  /api/v1/sidechains/proposals           Pending proposals
POST /api/v1/sidechains/propose             { creator, name, chainId, authorities, institutionType, stake, ... }
POST /api/v1/sidechains/proposals/:id/vote  { voter, approve, reason }
GET  /api/v1/sidechains/:chainId
POST /api/v1/sidechains/:chainId/anchor     { from, anchorHash, anchorHeight }
POST /api/v1/sidechains/:chainId/distribute { distributor, recipients[], amounts[], benefitType }
```

### Governance
```
GET  /api/v1/governance/proposals?status=        Filter: ACTIVE | PASSED | REJECTED | EXPIRED | EXECUTED
GET  /api/v1/governance/proposals/:id
POST /api/v1/governance/propose                  { from, title, description, type, params }
POST /api/v1/governance/vote                     { from, proposalId, vote }   vote: YES|NO|ABSTAIN
POST /api/v1/governance/proposals/:id/execute    { executor? }  — only PASSED proposals
```

### Bridge
```
POST /api/v1/bridge/lock                    { from, amount, targetChain, targetAddress }
POST /api/v1/bridge/release                 { to, amount, lockTxHash }
```

### Nodes
```
GET  /api/v1/nodes                          List all registered node operators
GET  /api/v1/nodes/:identifier              Lookup by public key (hex) or ankh_ address
```

### Validators & Network
```
GET  /api/v1/validators
GET  /api/v1/validators/top?count=
GET  /api/v1/network/peers
GET  /api/v1/peg/status
GET  /api/v1/peg/history?limit=
```

### WebSocket events

Connect to `ws://node:3001` and listen for:

| Event | Payload |
|---|---|
| `CONNECTED` | `{ chainId, height }` |
| `NEW_BLOCK` | `{ index, hash, timestamp, transactionCount, validator }` |
| `NEW_TRANSACTION` | `{ hash, type, from, to }` |
| `USER_VERIFIED` | `{ address, verificationId, blockIndex }` |
| `UBI_CLAIMED` | `{ address, amount, blockIndex }` |
| `TRANSFER` | `{ from, to, amount, blockIndex }` |
| `TOKEN_CREATED` | `{ symbol, tokenAddress, creator }` |
| `SIDECHAIN_CREATED` | `{ chainId, name, institutionType }` |
| `GOVERNANCE_PROPOSE` | `{ proposalId, type, title, proposer }` |
| `GOVERNANCE_VOTE` | `{ proposalId, voter, vote, status }` |
| `GOVERNANCE_PASSED` | `{ proposalId, type, title }` |
| `GOVERNANCE_REJECTED` | `{ proposalId }` |
| `BRIDGE_LOCK` | `{ from, amount, targetChain, targetAddress }` |
| `BRIDGE_RELEASE` | `{ to, amount, lockTxHash }` |

---

## Architecture

```
ankh_chain/
├── server.js                     # Entry point
├── ankh-sdk.js                   # Zero-dependency SDK (browser + Node.js)
└── src/
    ├── core/
    │   ├── AnkhBlockchain.js     # Main blockchain + all transaction handlers
    │   ├── Block.js              # Block structure
    │   ├── Transaction.js        # Transaction types & factory methods
    │   ├── StateManager.js       # Persisted state (accounts, tokens, sidechains,
    │   │                         #   governance, bridge locks, verified users)
    │   └── GenesisConfig.js      # Genesis parameters (frozen)
    ├── economics/
    │   ├── UBIEngine.js          # UBI distribution logic
    │   └── USDPegMechanism.js    # Price stability
    ├── verification/
    │   ├── EnhancedBiometricVerifier.js  # Liveness, duplicate detection, age
    │   ├── BiologicalAgeVerifier.js      # Age estimation from biometrics
    │   └── KingtreeAdapter.js            # Integration layer
    ├── contracts/
    │   ├── standards/ARC20.js    # ARC-20 token standard
    │   └── TokenFactory.js       # Token creation
    ├── sidechain/
    │   └── SidechainManager.js   # PoA sidechain lifecycle + benefit distribution
    ├── network/
    │   └── P2PNetwork.js         # Peer-to-peer gossip + block sync
    ├── bridge/
    │   └── EthereumBridge.js     # ETH ↔ ANKH bridge
    └── api/
        └── AnkhChainAPI.js       # REST + WebSocket API
```

### Persisted data (`data/`)

| File | Contents |
|---|---|
| `chain.json` | Full block chain |
| `accounts.json` | All account balances and nonces |
| `verified_users.json` | Biometric registry |
| `ubi_allocations.json` | UBI claim history per address |
| `tokens.json` | ARC-20 token states and holder balances |
| `validators.json` | Validator stakes and delegations |
| `sidechains.json` | Registered sidechains |
| `governance.json` | On-chain proposals and votes |
| `processed_bridge_locks.json` | Bridge double-spend prevention |
| `biometric_descriptors.json` | 128-dim face vectors for duplicate detection |
| `registered_nodes.json` | Trusted node public keys |
| `reserve_wallets.json` | Reserve wallet addresses |

---

## Token Tiers

| Tier | Stake Required | Max Supply | Approval |
|---|---|---|---|
| Community | 100 ANKH | 1M tokens | Auto |
| Standard | 10,000 ANKH | Unlimited | 24h review |
| Institutional | 100,000 ANKH | Unlimited | Governance vote |
| Sovereign | Treaty | Unlimited | Council approval |

---

## Running a Node

### How nodes find the network

On startup the node connects to bootstrap peers in `GenesisConfig.NETWORK.SEED_PEERS` (`ws://p2p.ankh.cash:6002`), then:

1. **Handshakes** — verifies `chainId === 'ankh-mainnet-1'`
2. **Syncs** — downloads missing blocks in batches of 100
3. **Discovers** — requests peer lists via gossip

```bash
# Override seed peers
SEED_PEERS=ws://yournode.example.com:6002,ws://192.168.1.5:6002 npm start

# Isolated / private network
SEED_PEERS= npm start
```

### Running a public / seed node

Open ports `3001` (API) and `6002` (P2P) in your firewall. Share your address as `ws://your-ip:6002`.

---

## Environment Variables

```env
DATA_DIR=./data                    # Data directory
API_PORT=3001                      # REST + WebSocket API port
P2P_PORT=6002                      # P2P port
ENABLE_P2P=true                    # Enable P2P networking
SEED_PEERS=ws://p2p.ankh.cash:6002 # Bootstrap peers (comma-separated)
VALIDATOR_ADDRESS=                 # Auto-generated if omitted
VALIDATOR_PRIVATE_KEY=             # Auto-generated if omitted
```

---

## Relationship to the ETH ICO

The Ethereum ICO (ANKH token) is a **derivative** of this native chain:

| Aspect | Native Ankh Chain | Ethereum ICO |
|---|---|---|
| Purpose | UBI distribution | Fundraising |
| Token | Native ANKH | ANKH (ERC-20) |
| Issuance | Biometric only | Purchase |
| Supply | Dynamic (biometric-gated) | Fixed 9B |
| Value | $1 peg | Market price |

A bridge enables transfers between chains.

---

## License

MIT
