/**
 * Type definitions for the Ankh Chain SDK.
 *
 * Amounts exist in two forms and mixing them up is the easiest mistake to make
 * against this chain: `RawAmount` is an integer string in 18-decimal base units
 * (what the chain stores and what every `value` field carries), while a
 * `HumanAmount` is what a person types. `AnkhSDK.parseAmount` converts one to
 * the other exactly. Methods here take human amounts unless the name says raw.
 */

/** Integer string in 18-decimal base units, e.g. "1000000000000000000" = 1 ANKH. */
export type RawAmount = string;

/** A human-readable quantity of ANKH, e.g. 5185.19, "100", or 1n. */
export type HumanAmount = number | string | bigint;

/** An Ankh address: "ankh_" followed by 40 hex characters. */
export type Address = string;

/** Uncompressed secp256k1 public key hex, 130 characters beginning "04". */
export type PublicKeyHex = string;

export type TransactionType =
  | 'TRANSFER' | 'UBI_CLAIM' | 'BIOMETRIC_REGISTRATION'
  | 'TOKEN_CREATE' | 'TOKEN_TRANSFER' | 'TOKEN_MINT' | 'TOKEN_BURN'
  | 'STAKE' | 'UNSTAKE'
  | 'GOVERNANCE_PROPOSE' | 'GOVERNANCE_VOTE'
  | 'SIDECHAIN_CREATE' | 'SIDECHAIN_ANCHOR'
  | 'BRIDGE_LOCK' | 'BRIDGE_RELEASE'
  | 'CONTRACT_DEPLOY' | 'CONTRACT_CALL'
  | 'NODE_REGISTER' | 'RESERVE_RELEASE';

export type TokenTier = 'COMMUNITY' | 'STANDARD' | 'INSTITUTIONAL' | 'SOVEREIGN';

export type ChainEvent =
  | 'NEW_BLOCK' | 'TRANSFER' | 'USER_VERIFIED' | 'UBI_CLAIMED'
  | 'TOKEN_CREATED' | 'SIDECHAIN_CREATED' | 'SIDECHAIN_ANCHORED'
  | 'GOVERNANCE_PASSED' | 'BRIDGE_LOCK';

export interface Signature {
  r: string;
  s: string;
  /** Bit 0 is the parity of R.y; bit 1 is set when R.x was reduced mod N. */
  recoveryParam: number;
}

export interface Wallet {
  address: Address;
  publicKey: PublicKeyHex;
  /** Returned once and never stored by a node. */
  privateKey: string;
}

export interface Transaction {
  id: string;
  type: TransactionType;
  from: Address | 'system' | 'genesis';
  to: Address | string;
  value: RawAmount;
  fee: RawAmount;
  nonce: number;
  data: Record<string, unknown>;
  timestamp: number;
  hash: string;
  signature: Signature | null;
}

export interface Balance {
  address: Address;
  /** Raw 18-decimal base units. */
  raw: RawAmount;
  /** Display string, e.g. "5185.1852 ANKH". */
  formatted: string;
}

export interface Account {
  address: Address;
  balance: RawAmount;
  nonce: number;
  isVerified: boolean;
  stakedAmount?: RawAmount;
}

export interface ChainInfo {
  chainId: string;
  chainName: string;
  height: number;
  latestBlockHash: string;
  latestBlockTime: number;
  pendingTransactions: number;
  activeValidators: number;
  currentEpoch: number;
  stateRoot: string;
}

export interface Block {
  version: number;
  index: number;
  timestamp: number;
  hash: string;
  previousHash: string;
  validator: Address;
  validatorSignature: Signature;
  stateRoot: string;
  transactions?: Transaction[];
}

export interface UBIStatus {
  canClaim: boolean;
  monthsClaimed: number;
  remainingMonths: number;
  nextClaimAvailable: number | null;
  monthlyAmount?: RawAmount;
}

export interface TokenTierInfo {
  tier: TokenTier;
  name: string;
  stakeRequired: RawAmount;
  maxSupply: RawAmount | 'Unlimited';
  requiresVerification?: boolean;
  autoApproved?: boolean;
  reviewPeriodHours?: number;
  canCreateSidechain?: boolean;
}

export interface CreateTokenParams {
  creator: Address;
  name: string;
  symbol: string;
  decimals?: number;
  initialSupply?: HumanAmount;
  maxSupply?: HumanAmount | null;
  /**
   * ANKH to lock. This determines the tier — pass `tier` only to override the
   * value recorded on the transaction; the factory still derives the real tier
   * from the stake.
   */
  stake?: HumanAmount;
  /** @deprecated Alias for `stake`, kept for older callers. */
  stakeAmount?: HumanAmount;
  tier?: TokenTier;
  mintable?: boolean;
  burnable?: boolean;
  pausable?: boolean;
  verifiedHoldersOnly?: boolean;
  description?: string;
  website?: string;
  metadata?: Record<string, unknown>;
}

/** A challenge minted by the node for one capture session. */
export interface LivenessChallenge {
  enabled: boolean;
  id?: string;
  /** Colours to show full-screen, in order, one frame captured under each. */
  colors?: string[];
  holdMs?: number;
  expiresAt?: number;
}

/** Frames captured under a challenge, returned with the submission. */
export interface LivenessProof {
  challengeId?: string;
  flashFrames?: Array<{ step: number; image: string }>;
}

export interface FaceResolution {
  found: boolean;
  address?: Address;
  isVerified?: boolean;
  balance?: RawAmount;
  /** States plainly that this is identification, not custody. */
  note?: string;
}

export interface SDKOptions {
  /** Defaults to https://api.ankh.cash */
  nodeUrl?: string;
  autoReconnect?: boolean;
  reconnectDelayMs?: number;
}

export interface TxResult {
  hash: string;
  [key: string]: unknown;
}

export declare class AnkhWallet {
  constructor(sdk: AnkhSDK, address: Address, privateKey: string);
  readonly address: Address;
  getBalance(): Promise<Balance>;
  send(to: Address, amount: HumanAmount): Promise<TxResult>;
  stake(amount: HumanAmount): Promise<TxResult>;
  unstake(amount: HumanAmount): Promise<TxResult>;
  claimUBI(): Promise<TxResult>;
  on(event: ChainEvent, handler: (payload: any) => void): void;
}

export declare class AnkhSDK {
  constructor(options?: SDKOptions);

  readonly nodeUrl: string;

  // ── keys ──────────────────────────────────────────────────────────────────
  setPrivateKey(privateKeyHex: string): void;
  /** Delegate signing to an external signer (hardware wallet, KMS, extension). */
  setSignerAsync(fn: (messageHashHex: string) => Promise<Signature>): void;
  clearKey(): void;

  generateWallet(): Promise<Wallet>;
  deriveAddress(publicKeyHex: PublicKeyHex): Promise<Address>;

  // ── accounts ──────────────────────────────────────────────────────────────
  getBalance(address: Address): Promise<Balance>;
  getAccount(address: Address): Promise<Account>;
  getTransactions(address: Address, limit?: number): Promise<Transaction[]>;

  // ── transfers ─────────────────────────────────────────────────────────────
  send(from: Address, to: Address, amount: HumanAmount, opts?: Record<string, unknown>): Promise<TxResult>;
  submitTransaction(signedTx: Transaction): Promise<TxResult>;
  getPendingTransactions(): Promise<Transaction[]>;
  buildTransaction(fields: Partial<Transaction> & { type: TransactionType; from: string }): Promise<Transaction>;
  signTransaction(tx: Transaction, privateKeyHex?: string): Promise<Transaction>;

  // ── UBI ───────────────────────────────────────────────────────────────────
  getUBIStatus(address: Address): Promise<UBIStatus>;
  claimUBI(address: Address): Promise<TxResult>;
  getUBIStats(): Promise<Record<string, unknown>>;

  // ── staking ───────────────────────────────────────────────────────────────
  stake(address: Address, amount: HumanAmount, validatorAddress?: Address): Promise<TxResult>;
  unstake(address: Address, amount: HumanAmount, validatorAddress?: Address): Promise<TxResult>;
  getValidators(): Promise<unknown[]>;
  getTopValidators(count?: number): Promise<unknown[]>;

  // ── tokens ────────────────────────────────────────────────────────────────
  getTokens(): Promise<unknown[]>;
  getToken(identifier: string): Promise<unknown>;
  getTokenBalance(tokenAddress: string, holderAddress: Address): Promise<unknown>;
  getTokenTiers(): Promise<TokenTierInfo[]>;
  getPendingTokens(): Promise<unknown[]>;
  createToken(params: CreateTokenParams): Promise<TxResult>;
  transferToken(tokenAddress: string, from: Address, to: Address, amount: HumanAmount, opts?: Record<string, unknown>): Promise<TxResult>;
  mintToken(tokenAddress: string, toAddress: Address, amount: HumanAmount, opts?: Record<string, unknown>): Promise<TxResult>;
  burnToken(tokenAddress: string, fromAddress: Address, amount: HumanAmount, opts?: Record<string, unknown>): Promise<TxResult>;

  // ── sidechains & governance ───────────────────────────────────────────────
  getSidechains(): Promise<unknown[]>;
  getSidechain(chainId: string): Promise<unknown>;
  getSidechainProposals(): Promise<unknown[]>;
  proposeSidechain(params: Record<string, unknown>): Promise<TxResult>;
  voteOnSidechainProposal(proposalId: string, voter: Address, approve: boolean, reason?: string): Promise<unknown>;
  anchorSidechain(sidechainId: string, from: Address, anchorHash: string, anchorHeight: number, opts?: Record<string, unknown>): Promise<TxResult>;
  distributeSidechainBenefits(chainId: string, distributor: Address, recipients: Address[], amounts: HumanAmount[], benefitType: string): Promise<unknown>;
  getGovernanceProposals(status?: string): Promise<unknown[]>;
  getGovernanceProposal(proposalId: string): Promise<unknown>;
  proposeGovernance(from: Address, proposal: Record<string, unknown>, opts?: Record<string, unknown>): Promise<TxResult>;
  voteGovernance(from: Address, proposalId: string, vote: boolean | string, opts?: Record<string, unknown>): Promise<TxResult>;
  executeGovernanceProposal(proposalId: string, executor: Address): Promise<unknown>;

  // ── nodes, bridge, verification ───────────────────────────────────────────
  registerNode(address: Address, publicKey: PublicKeyHex, opts?: Record<string, unknown>): Promise<TxResult>;
  getNodes(): Promise<unknown[]>;
  getNode(identifier: string): Promise<unknown>;
  bridgeLock(from: Address, amount: HumanAmount, targetChain: string, targetAddress: string, opts?: Record<string, unknown>): Promise<TxResult>;
  bridgeRelease(to: Address, amount: HumanAmount, lockTxHash: string, opts?: Record<string, unknown>): Promise<TxResult>;
  releaseReserve(params: Record<string, unknown>): Promise<TxResult>;
  getVerificationStatus(address: Address): Promise<unknown>;
  verify(address: Address, biometricData: Record<string, unknown>, opts?: LivenessProof): Promise<unknown>;

  /** Ask the node for a per-session illumination challenge. */
  getLivenessChallenge(): Promise<LivenessChallenge>;
  /**
   * Resolve a face to the address it is registered to.
   * Returns an address, never a key: this identifies an account, it does not
   * grant control of one. Signing still needs the device's private key.
   */
  resolveFace(biometricData: Record<string, unknown>, opts?: LivenessProof): Promise<FaceResolution>;
  /** resolveFace plus the account, so a wallet view can render in one call. */
  signInWithFace(biometricData: Record<string, unknown>, opts?: LivenessProof):
    Promise<{ found: boolean; address: Address | null; account: Account | null; note?: string }>;

  // ── chain ─────────────────────────────────────────────────────────────────
  getChainInfo(): Promise<ChainInfo>;
  getChainConfig(): Promise<Record<string, unknown>>;
  getGenesis(): Promise<Block>;
  getStats(): Promise<Record<string, unknown>>;
  getHealth(): Promise<{ status: string; chainId: string; height: number; timestamp: number }>;
  getLatestBlock(): Promise<Block>;
  getBlock(indexOrHash: number | string): Promise<Block>;
  getBlocks(limit?: number, offset?: number): Promise<Block[]>;
  getNetworkPeers(): Promise<unknown[]>;
  getPegStatus(): Promise<unknown>;
  getPegHistory(limit?: number): Promise<unknown[]>;

  // ── realtime ──────────────────────────────────────────────────────────────
  connect(): Promise<void>;
  disconnect(): void;
  subscribe(channel: string): void;
  unsubscribe(channel: string): void;
  ping(): void;
  on(eventType: ChainEvent | string, handler: (payload: any) => void): void;
  off(eventType: ChainEvent | string, handler: (payload: any) => void): void;

  // ── statics ───────────────────────────────────────────────────────────────

  /** SDK version. Builds below 2.0.1 produced invalid keys and signatures. */
  static readonly VERSION: string;

  static TX_TYPES: Record<TransactionType, TransactionType>;

  /** Create a wallet entirely client-side — no network call. */
  static createWallet(): Promise<Wallet>;
  static walletFromPrivateKey(privateKeyHex: string): Promise<Wallet>;
  static addressFromPublicKey(publicKeyHex: PublicKeyHex): Promise<Address>;

  /** Exact decimal conversion to raw 18-decimal base units. */
  static parseAmount(ankh: HumanAmount): RawAmount;
  static formatBalance(raw: RawAmount | bigint, decimalPlaces?: number): string;

  /** Random address with no private key — watch-only or test use. */
  static generateRandomAddress(): Address;

  static crypto: {
    publicKeyFromPrivate(privateKeyHex: string): PublicKeyHex;
    sign(messageHashHex: string, privateKeyHex: string): Promise<Signature>;
    sha256(data: string | Uint8Array): Promise<string>;
    hexToBytes(hex: string): Uint8Array;
    bytesToHex(bytes: Uint8Array): string;
    randomBytes32(): Uint8Array;
  };
}

export default AnkhSDK;
