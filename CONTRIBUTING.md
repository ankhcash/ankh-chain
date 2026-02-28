# Contributing to Ankh Chain

Thank you for your interest in contributing to Ankh Chain — the native blockchain powering Universal Basic Income for humanity.

## Ways to Contribute

- **Bug reports** — something broken or behaving unexpectedly
- **Feature suggestions** — ideas for improvements or new capabilities
- **Code contributions** — bug fixes, optimizations, new features via pull request
- **Security reports** — vulnerabilities (see Security section below)
- **Documentation** — improving README, API docs, or adding examples
- **Running a node** — decentralizing the network is itself a contribution

---

## Before You Start

1. **Search existing issues** first — your bug or idea may already be tracked
2. **Open an issue before a large PR** — discuss the approach before spending time coding
3. **Small, focused PRs are preferred** — one concern per PR makes review faster

---

## Consensus-Critical Code

Changes to the following files require **extra scrutiny** and will not be merged without thorough discussion and community review. These define the protocol itself — all nodes must agree:

| File | Why it matters |
|------|----------------|
| `src/core/GenesisConfig.js` | Chain parameters, economics, network rules |
| `src/economics/UBIEngine.js` | UBI calculation and issuance logic |
| `src/verification/EnhancedBiometricVerifier.js` | Human uniqueness guarantee |
| `src/core/AnkhBlockchain.js` | Block validation and chain rules |
| `src/core/StateManager.js` | State transitions and account model |

A breaking change to any of these requires a coordinated hard fork. Propose changes in an issue first and expect a longer review timeline.

---

## Development Setup

```bash
git clone https://github.com/ankhcash/ankh-chain
cd ankh-chain
npm install
npm start
```

The node starts on port 3001 (API) and 6002 (P2P). By default it connects to the mainnet bootstrap node. To run in isolation:

```bash
SEED_PEERS= npm start
```

---

## Submitting a Pull Request

1. Fork the repo and create a branch from `main`
2. Name your branch descriptively: `fix/unbonding-release`, `feat/transaction-indexing`
3. Make your changes with clear, focused commits
4. Test your changes against a running node
5. Open a PR with the provided template filled out

### PR checklist
- [ ] Describe what the change does and why
- [ ] Note any consensus-critical impact
- [ ] Include steps to test the change
- [ ] Keep the scope focused — one fix or feature per PR

---

## Security Vulnerabilities

**Do not open a public issue for security vulnerabilities.**

Report them privately to: **security@ankh.cash**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix if you have one

We aim to acknowledge reports within 48 hours and resolve critical issues within 7 days.

---

## Code Style

- Node.js / ES2020+ (no transpilation)
- 2-space indentation
- Descriptive variable names — avoid abbreviations in critical logic
- BigInt for all token amounts (18 decimal places)
- Add comments for non-obvious economic or cryptographic logic

---

## License

By contributing, you agree your contributions are licensed under the MIT License.
