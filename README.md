# Ankh Chain

**Universal Basic Income Blockchain for Humanity**

Ankh Chain is a native blockchain that distributes Universal Basic Income (UBI) to biometrically verified humans worldwide. It supports a maximum population of 10 billion people, each receiving a lifetime allocation of $2,800,000 distributed over 45 years.

## Key Features

### Economics
- **1 ANKH = $1 USD** — Stablecoin peg
- **$2.8M Lifetime Allocation** per verified person
- **~$5,185 Monthly UBI** distributed over 540 months (45 years)
- **10 Billion Max Population** capacity

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

### How it works

1. **Register your node** as a trusted verifier on the main chain — this allows your node to submit biometric registrations on behalf of citizens.

```js
sdk.setPrivateKey(nodePrivKey);
await sdk.registerNode(nodeAddress, nodePublicKeyHex);
```

2. **Propose a sidechain** (requires staked ANKH — 100k for INSTITUTIONAL tier).

```js
const proposal = await sdk.proposeSidechain({
  creator: address,
  name:    'Nigeria Welfare Chain',
  chainId: 'ng-welfare-1',
  authorities: [{ address, name: 'Federal Node 1', role: 'validator' }],
  institutionType: 'government',   // 'government' | 'organization' | 'cooperative'
  stake: 100000,
  nativeCurrency: { name: 'eNaira', symbol: 'eNGN', decimals: 18, initialSupply: 0 }
});
```

3. **Verified users vote** to approve (≥5 votes, ≥66% approval required).

```js
await sdk.voteOnSidechainProposal(proposal.proposalId, voterAddress, true);
```

4. **Submit biometric registrations** through your node — verifications are written to the **main chain**, making the user visible to all sidechains automatically.

```js
// Your node signs BIOMETRIC_REGISTRATION transactions — the main chain
// validates them because your node is registered in step 1.
// Citizens verified this way can claim main-chain UBI AND receive sidechain benefits.
```

5. **Distribute benefits** to verified citizens — unverified addresses are silently skipped.

```js
await sdk.distributeSidechainBenefits(
  'ng-welfare-1',
  authorityAddress,
  ['ankh_abc...', 'ankh_def...'],        // recipient list
  ['5000000000000000000000', ...],        // amounts in raw units (18 decimals)
  'MONTHLY_WELFARE'                       // benefit type label, recorded on-chain
);
```

6. **Anchor sidechain state** to the main chain every N blocks (trustless checkpointing).

```js
await sdk.anchorSidechain('ng-welfare-1', authorityAddress, blockHash, blockHeight);
```

### Sidechain tiers

| Tier | Stake | Approval | Use case |
|---|---|---|---|
| Community | 100 ANKH | Auto | Co-ops, communities |
| Standard | 10,000 ANKH | 24h review | SMEs, NGOs |
| Institutional | 100,000 ANKH | Governance vote | Corporations, banks |
| Sovereign | Treaty | Council approval | Nation-states |

### What sidechains inherit from the main chain
- **Identity** — `isVerified` status for every address, checked in real time
- **Sybil resistance** — benefit distribution automatically skips unverified addresses
- **No verification infrastructure needed** — biometrics run on registered main-chain nodes

### What sidechains control themselves
- Payment amounts and schedules
- Native currency name, symbol, supply
- Block production (their own PoA validators)
- Authority management (add/remove validators)

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
GET  /api/v1/governance/proposals?status=   Filter: ACTIVE | PASSED | REJECTED | EXPIRED
GET  /api/v1/governance/proposals/:id
POST /api/v1/governance/propose             { from, title, description, type, params }
POST /api/v1/governance/vote                { from, proposalId, vote }   vote: YES|NO|ABSTAIN
```

### Bridge
```
POST /api/v1/bridge/lock                    { from, amount, targetChain, targetAddress }
POST /api/v1/bridge/release                 { to, amount, lockTxHash }
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
