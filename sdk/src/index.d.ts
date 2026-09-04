import type { BlockTag, ContractRunner, InterfaceAbi } from "ethers";

export type Address = string;
export type Hex = string;
export type UintLike = bigint | number | string;

export interface ReadSnapshotOptions {
  blockTag?: BlockTag;
}

export interface ReadFacilityPolicyCatalogOptions extends ReadSnapshotOptions {
  fromBlock?: number;
  pageSize?: number;
  maxPages?: number;
  cursor?: FacilityPolicyCatalogCursor;
}

export interface ReadPolicyRegistryCatalogOptions extends ReadSnapshotOptions {
  start?: number;
  limit?: number;
  cursor?: PolicyRegistryCatalogCursor;
}

export interface BlockContinuation {
  blockNumber: number;
  blockHash: Hex;
}

export interface PolicyRegistryCatalogCursor extends BlockContinuation {
  nextIndex: number;
}

export interface FacilityPolicyCatalogCursor extends BlockContinuation {
  originalFromBlock: number;
  nextBlock: number;
}

export interface PolicyRegistryReleaseCursor extends BlockContinuation {
  runtimeNextIndex: number;
  deploymentNextIndex: number;
}

export interface PolicyRegistryAuditCursor extends BlockContinuation {
  nextIndex: number;
}

export interface CappedPilotFactoryCursor extends BlockContinuation {
  nextIndex: number;
}

export interface OperatorMarketCursor extends BlockContinuation {
  nextIndex: number;
}

export interface PortfolioPoolCursor extends BlockContinuation {
  nextCreatedFacilityIndex: number;
  nextCandidateIndex: number;
  nextInvestorIndex: number;
}

export interface ReadPolicyRegistryReleaseOptions extends ReadSnapshotOptions {
  detailLimit?: number;
  cursor?: PolicyRegistryReleaseCursor;
}

export interface ReadPolicyRegistryAuditScopeOptions extends ReadSnapshotOptions {
  limit?: number;
  cursor?: PolicyRegistryAuditCursor;
}

export interface ReadCappedPilotFactoryOptions extends ReadSnapshotOptions {
  limit?: number;
  cursor?: CappedPilotFactoryCursor;
}

export interface ReadOperatorMarketOptions extends ReadSnapshotOptions {
  limit?: number;
  cursor?: OperatorMarketCursor;
  claimableAccounts?: Address[];
}

export interface ReadPortfolioPoolOptions extends ReadSnapshotOptions {
  detailLimit?: number;
  cursor?: PortfolioPoolCursor;
}

export type ReadPortfolioMandateOptions = ReadSnapshotOptions &
  (
    | { facility?: undefined; deploymentId?: undefined }
    | { facility: Address; deploymentId: Hex }
  );

export declare const PolicyOutcome: Readonly<{
  Eligible: 0;
  Watch: 1;
  Restricted: 2;
  MarginCalled: 3;
  Breached: 4;
  Cured: 5;
}>;
export declare const ObservationKind: Readonly<{
  Ownership: 0;
  Collateral: 1;
  Position: 2;
  Liability: 3;
  Behaviour: 4;
}>;
export declare const EvidenceKind: Readonly<{
  TransactionControl: 0;
  EventDelta: 1;
  EventTransition: 2;
}>;
export declare const FacilityStatus: Readonly<{
  Created: 0;
  Active: 1;
  Repaid: 2;
  Defaulted: 3;
  Cancelled: 4;
  Terminated: 5;
}>;
export declare const ProofJobState: Readonly<{
  Open: 0;
  OutcomeReached: 1;
  AttemptsExhausted: 2;
  Expired: 3;
}>;
export declare const AuditScope: Readonly<{
  Release: 0;
  Deployment: 1;
}>;
export declare const PortfolioEligibilityCode: Readonly<{
  Eligible: 0;
  UnknownFacility: 1;
  WrongAsset: 2;
  WrongKernel: 3;
  InvalidStatus: 4;
  FacilityLimitExceeded: 5;
  BondBelowMinimum: 6;
  DrawFeeExceeded: 7;
  InvalidMaturity: 8;
  PolicySetMismatch: 9;
  UnknownRelease: 10;
  InvalidDeployment: 11;
  MissingEvidenceKind: 12;
  MissingActionAdapter: 13;
}>;
export declare const PortfolioPoolStatus: Readonly<{
  Configuring: 0;
  Funding: 1;
  Active: 2;
  Finalized: 3;
  Cancelled: 4;
}>;
export declare const SourceOrdering: Readonly<{
  StrictlyIncreasing: 0;
  UniqueOnly: 1;
}>;
export declare const PortfolioPoolAllocationCode: Readonly<{
  Eligible: 0;
  NotManager: 1;
  WrongStatus: 2;
  FundingExpired: 3;
  CandidateNotRegistered: 4;
  AllocationAlreadySettled: 5;
  InvalidFacility: 6;
  InvalidAmount: 7;
  IneligibleFacility: 8;
}>;
export declare const PilotCreationCode: Readonly<{
  Eligible: 0;
  NotLender: 1;
  CreationPaused: 2;
  FacilityCountExceeded: 3;
  FacilityLimitExceeded: 4;
  TotalLimitExceeded: 5;
  InvalidBond: 6;
  InvalidDrawFee: 7;
  InvalidMaturity: 8;
}>;
export declare const OperatorServiceKind: Readonly<{
  Monitoring: 0;
  ProofConstruction: 1;
  Submission: 2;
  Delivery: 3;
}>;
export declare const OperatorQuoteStatus: Readonly<{
  Open: 0;
  Accepted: 1;
  Settled: 2;
  Cancelled: 3;
  Expired: 4;
}>;

export interface PolicyEffectInput {
  outcome: UintLike;
  creditLimitBps: UintLike;
  futureDrawFeeBps: UintLike;
  freezePendingDraw: boolean;
  requireFreshEvidence: boolean;
  terminate: boolean;
}

export interface PolicyEffect {
  outcome: bigint;
  creditLimitBps: bigint;
  futureDrawFeeBps: bigint;
  freezePendingDraw: boolean;
  requireFreshEvidence: boolean;
  terminate: boolean;
}

export interface CreditObservation {
  kind: bigint;
  evidenceKind: bigint;
  sourceChain: bigint;
  sourceBlock: bigint;
  transactionIndex: bigint;
  subject: Address;
  emitter: Address;
  observedValue: bigint;
  proofTime: bigint;
  expiry: bigint;
  evidenceDigest: Hex;
  policyEffectHash: Hex;
}

export interface EventHistoryManifest {
  sourceChain: UintLike;
  emitter: Address;
  eventSignature: Hex;
  subject: Address;
  startSourceBlock: UintLike;
  endSourceBlock: UintLike;
  topicCount: number;
  subjectTopicIndex: number;
  dataLength: number;
  observedValueOffset: number;
  observationKind: number;
  evidenceKind: number;
  freshnessPeriod: UintLike;
  effect: PolicyEffectInput;
}

export interface MerkleProof {
  root: Hex;
  siblings: Array<{ hash: Hex; isLeft: boolean }>;
}

export interface ContinuityProof {
  lowerEndpointDigest: Hex;
  roots: Hex[];
}

export interface KernelProofInput {
  chainKey: UintLike;
  height: UintLike;
  encodedTransaction: Hex;
  merkleProof: MerkleProof;
  continuityProof: ContinuityProof;
}

export interface StoredPolicyEffect {
  effect: PolicyEffectInput;
  evidenceExpiry: UintLike;
}

export interface FacilitySimulationInput {
  initialDrawFeeBps: UintLike;
  facilityLimit: UintLike;
  drawnPrincipal: UintLike;
  status: UintLike;
  lenderDrawPaused: boolean;
  borrowerDrawPaused: boolean;
  timestamp: UintLike;
  policies: StoredPolicyEffect[];
}

export interface FacilitySimulation {
  policyOutcome: number;
  creditLimitBps: number;
  futureDrawFeeBps: number;
  freshEvidenceRequired: boolean;
  evidenceValidUntil: bigint;
  incidentPaused: boolean;
  effectiveLimit: bigint;
  availableCredit: bigint;
}

export interface MultiChainRuleInput {
  sourceChain: UintLike;
  emitter: Address;
  eventSignature: Hex;
  startSourceBlock: UintLike;
  endSourceBlock: UintLike;
  topicCount: UintLike;
  subjectTopicIndex: UintLike;
  dataLength: UintLike;
  observedValueOffset: UintLike;
  observationKind: UintLike;
  riskWeight: UintLike;
}

export interface MultiChainRule {
  sourceChain: bigint;
  emitter: Address;
  eventSignature: Hex;
  startSourceBlock: bigint;
  endSourceBlock: bigint;
  topicCount: number;
  subjectTopicIndex: number;
  dataLength: number;
  observedValueOffset: number;
  observationKind: number;
  riskWeight: bigint;
}

export interface MultiChainConfigurationInput {
  subject: Address;
  freshnessPeriod: UintLike;
  watchThreshold: UintLike;
  restrictedThreshold: UintLike;
  marginThreshold: UintLike;
  breachThreshold: UintLike;
  watchEffect: PolicyEffectInput;
  restrictedEffect: PolicyEffectInput;
  marginEffect: PolicyEffectInput;
  breachEffect: PolicyEffectInput;
  rules: MultiChainRuleInput[];
}

export interface MultiChainConfiguration {
  subject: Address;
  freshnessPeriod: bigint;
  watchThreshold: bigint;
  restrictedThreshold: bigint;
  marginThreshold: bigint;
  breachThreshold: bigint;
  watchEffect: PolicyEffect;
  restrictedEffect: PolicyEffect;
  marginEffect: PolicyEffect;
  breachEffect: PolicyEffect;
  rules: MultiChainRule[];
}

export interface CappedPilotFacilityRequest {
  facilityLimit: UintLike;
  bondRequired: UintLike;
  drawFeeBps: UintLike;
  maturityBlock: UintLike;
  drawDelayBlocks: UintLike;
}

export interface CappedPilotFactorySimulationInput {
  factory: {
    lender: Address;
    creationPaused: boolean;
    facilityCount: UintLike;
    totalFacilityLimit: UintLike;
    maximumFacilityLimit: UintLike;
    maximumTotalLimit: UintLike;
    minimumBondBps: UintLike;
    maximumDrawFeeBps: UintLike;
    maximumMaturityBlocks: UintLike;
    maximumDrawDelayBlocks: UintLike;
    maximumFacilityCount: UintLike;
  };
  request: CappedPilotFacilityRequest;
  sender: Address;
  blockNumber: UintLike;
}

export interface DefaultLossSettlementInput {
  lender: Address;
  sender: Address;
  status: UintLike;
  maturityBlock?: UintLike;
  blockNumber?: UintLike;
  bondPosted: UintLike;
  outstandingDebt: UintLike;
  lenderClaimable: UintLike;
  borrowerClaimable: UintLike;
}

export interface OperatorQuoteInput {
  serviceKind: UintLike;
  intendedSponsor: Address;
  requirementsDigest: Hex;
  price: UintLike;
  operatorBond: UintLike;
  quoteExpiry: UintLike;
  serviceDuration: UintLike;
}

export interface OperatorAgreementQuoteInput extends OperatorQuoteInput {
  operator: Address;
  acceptedAt: UintLike;
  deliveryDeadline: UintLike;
}

export interface OperatorQuote {
  operator: Address;
  intendedSponsor: Address;
  sponsor: Address;
  serviceKind: bigint;
  status: bigint;
  quoteExpiry: bigint;
  serviceDuration: bigint;
  acceptedAt: bigint;
  deliveryDeadline: bigint;
  price: bigint;
  operatorBond: bigint;
  requirementsDigest: Hex;
  deliveryDigest: Hex;
}

export interface PortfolioMandateSimulationInput {
  mandate: {
    asset: Address;
    kernel: Address;
    requiredReleaseId: Hex;
    requiredPolicySetCommitment: Hex;
    requiredEvidenceKind: UintLike;
    requiredActionAdapterKind: Hex;
    maximumFacilityLimit: UintLike;
    minimumBondBps: UintLike;
    maximumDrawFeeBps: UintLike;
    maximumRemainingMaturityBlocks: UintLike;
  };
  facility: {
    address: Address;
    asset: Address;
    kernel: Address;
    status: UintLike;
    facilityLimit: UintLike;
    bondRequired: UintLike;
    initialDrawFeeBps: UintLike;
    maturityBlock: UintLike;
    policySetCommitment: Hex;
  };
  deployment: {
    exists: boolean;
    releaseId: Hex;
    chainId: UintLike;
    kernel: Address;
    facility: Address;
    evaluator: Address;
    configHash: Hex;
    manifestHash: Hex;
  };
  releaseExists: boolean;
  factoryRecognized: boolean;
  evidenceKindDeclared: boolean;
  actionAdapters: Array<{ adapterKind: Hex }>;
  chainId: UintLike;
  blockNumber: UintLike;
}

export interface PortfolioPoolAllocationSimulationInput {
  pool: {
    address: Address;
    manager: Address;
    status: UintLike;
    fundingDeadline: UintLike;
    assetBalance: UintLike;
    totalAllocatedPrincipal: UintLike;
    allocatedFacilityCount: UintLike;
  };
  allocation: {
    registered: boolean;
    settled: boolean;
    principal: UintLike;
  };
  facility: {
    lender: Address;
    facilityLimit: UintLike;
    lenderFunded: UintLike;
    bondRequired: UintLike;
    bondPosted: UintLike;
  };
  sender: Address;
  timestamp: UintLike;
  amount: UintLike;
  mandateEligibilityCode: UintLike;
}

export interface PortfolioPoolDistributionSimulationInput {
  status: UintLike;
  assetBalance: UintLike;
  totalDistributed: UintLike;
  totalClaimed: UintLike;
  totalSupply: UintLike;
  investors: Array<{
    account: Address;
    shares: UintLike;
    claimable: UintLike;
  }>;
}

export interface PortfolioPoolAllocation {
  deploymentId: Hex;
  principal: bigint;
  recovered: bigint;
  realizedLoss: bigint;
  registered: boolean;
  settled: boolean;
}

export interface PortfolioPoolRead {
  address: Address;
  blockTag: BlockTag;
  blockHash: Hex;
  asset: Address;
  assetBalance: bigint;
  maximumInvestors: bigint;
  manager: Address;
  maximumPoolAssets: bigint;
  maximumServiceBudget: bigint;
  maximumServiceJobDuration: bigint;
  maximumFacilityCount: bigint;
  fundingDeadline: bigint;
  recoveryDelayBlocks: bigint;
  mandate: Address;
  proofJobsVenue: Address;
  status: bigint;
  totalDeposited: bigint;
  totalAllocatedPrincipal: bigint;
  totalRecovered: bigint;
  totalRealizedLoss: bigint;
  totalServiceEscrowed: bigint;
  totalServiceRecovered: bigint;
  allocatedFacilityCount: bigint;
  settledFacilityCount: bigint;
  totalDistributed: bigint;
  totalClaimed: bigint;
  name: string;
  symbol: string;
  decimals: bigint;
  totalSupply: bigint;
  createdFacilityTotalCount: number;
  candidateTotalCount: number;
  investorTotalCount: number;
  createdFacilityStart: number;
  candidateStart: number;
  investorStart: number;
  createdFacilities: Address[];
  candidates: Array<{
    facility: Address;
    allocation: PortfolioPoolAllocation;
  }>;
  investors: Array<{
    account: Address;
    shares: bigint;
    claimable: bigint;
    claimedAssets: bigint;
  }>;
  nextCursor: PortfolioPoolCursor | null;
}

export interface PolicyDeployment {
  chainId: number;
  address: Address;
  blockNumber: number;
  transactionHash: Hex;
  codeHash: Hex;
}

export interface PolicyAudit {
  auditor: Address;
  release: string;
  chainId: number;
  deployment: Address;
  codeHash: Hex;
  reportUri: string;
  reportHash: Hex;
}

export interface ActionAdapter {
  kind: string;
  chainId: number;
  address: Address;
  codeHash: Hex;
}

export interface PolicyPackage {
  format: "recourse-policy-package";
  version: 1;
  id: string;
  name: string;
  release: string;
  policyKind: string;
  supportedEvidenceKinds: Array<
    "transaction-control" | "event-delta" | "event-transition"
  >;
  actionAdapters: ActionAdapter[];
  implementation: { chainId: number; address: Address; codeHash: Hex };
  audits: PolicyAudit[];
  deployments: PolicyDeployment[];
}

export interface RegistryActionAdapterDeclaration {
  adapterKind: Hex;
  specificationHash: Hex;
  metadataURI: string;
}

export interface RegistryPackageRelease {
  issuer: Address;
  packageName: string;
  version: string;
  referenceImplementation: Address;
  buildArtifactHash: Hex;
  referenceRuntimeCodeHash: Hex;
  referenceVariantId: Hex;
  metadataHash: Hex;
  releaseContentHash: Hex;
  releasedAt: bigint;
  exists: boolean;
}

export interface RegistryRuntimeVariant {
  releaseId: Hex;
  implementation: Address;
  runtimeCodeHash: Hex;
  constructorArgumentsHash: Hex;
  approvedAt: bigint;
  exists: boolean;
}

export interface RegistryAuditArtifact {
  scope: bigint;
  releaseId: Hex;
  deploymentId: Hex;
  scopeHash: Hex;
  auditor: Address;
  artifactHash: Hex;
  artifactURI: string;
  publishedAt: bigint;
  exists: boolean;
}

export interface RegistryDeploymentRecord {
  releaseId: Hex;
  chainId: bigint;
  kernel: Address;
  facility: Address;
  policyId: bigint;
  evaluator: Address;
  runtimeVariantId: Hex;
  runtimeCodeHash: Hex;
  constructorArgumentsHash: Hex;
  configHash: Hex;
  manifestHash: Hex;
  attester: Address;
  recordedAt: bigint;
  exists: boolean;
}

export interface PublishPolicyRegistryReleaseRequest {
  packageName: string;
  version: string;
  referenceImplementation: Address;
  buildArtifactHash: Hex;
  referenceConstructorArgumentsHash: Hex;
  metadataHash: Hex;
  evidenceKinds: UintLike[];
  actionAdapters: RegistryActionAdapterDeclaration[];
}

export interface PolicyRegistryReleaseRead {
  address: Address;
  blockTag: BlockTag;
  blockHash: Hex;
  releaseId: Hex;
  release: RegistryPackageRelease;
  evidenceKinds: bigint[];
  actionAdapters: RegistryActionAdapterDeclaration[];
  runtimeVariants: Array<{
    runtimeVariantId: Hex;
    variant: RegistryRuntimeVariant;
  }>;
  deployments: Array<{
    deploymentId: Hex;
    deployment: RegistryDeploymentRecord;
  }>;
  runtimeVariantTotalCount: number;
  deploymentTotalCount: number;
  nextCursor: PolicyRegistryReleaseCursor | null;
}

export interface PolicyRegistryAuditScopeRead {
  address: Address;
  blockTag: BlockTag;
  blockHash: Hex;
  scope: UintLike;
  scopeId: Hex;
  scopeHash: Hex;
  totalCount: number;
  start: number;
  nextCursor: PolicyRegistryAuditCursor | null;
  artifacts: Array<{ artifactId: Hex; artifact: RegistryAuditArtifact }>;
}

export interface PolicyRegistryCatalogRead {
  address: Address;
  blockTag: BlockTag;
  blockHash: Hex;
  totalCount: number;
  start: number;
  nextIndex: number | null;
  nextCursor: PolicyRegistryCatalogCursor | null;
  truncated: boolean;
  releases: Array<{
    releaseId: Hex;
    release: RegistryPackageRelease;
  }>;
}

export interface FacilityPolicyRegistration {
  policyId: bigint;
  evaluator: Address;
  configHash: Hex;
  manifest: Hex;
  blockNumber: number;
  transactionIndex: number;
  logIndex: number;
  transactionHash: Hex;
}

export interface FacilityPolicyCatalogRead {
  address: Address;
  blockTag: BlockTag;
  blockHash: Hex;
  facility: Address;
  fromBlock: number;
  originalFromBlock: number;
  scannedToBlock: number;
  nextBlock: number | null;
  historyComplete: boolean;
  nextCursor: FacilityPolicyCatalogCursor | null;
  registrations: FacilityPolicyRegistration[];
}

export interface CreateFacilityRequest {
  asset: Address;
  kernel: Address;
  lender: Address;
  borrower: Address;
  facilityLimit: UintLike;
  bondRequired: UintLike;
  drawFeeBps: UintLike;
  maturityBlock: UintLike;
  drawDelayBlocks: UintLike;
}

export interface ProofJobParams {
  token: Address;
  facility: Address;
  policyId: UintLike;
  requirementsDigest: Hex;
  expiry: UintLike;
  revealWindowBlocks: UintLike;
  maxSuccessfulProofs: UintLike;
  proofReimbursement: UintLike;
  outcomeReward: UintLike;
  commitBond: UintLike;
  rewardOutcomeThreshold: UintLike;
}

export interface ProofJob {
  sponsor: Address;
  token: Address;
  facility: Address;
  policyId: bigint;
  requirementsDigest: Hex;
  expiry: bigint;
  revealWindowBlocks: bigint;
  maxSuccessfulProofs: bigint;
  successfulProofs: bigint;
  proofReimbursement: bigint;
  outcomeReward: bigint;
  commitBond: bigint;
  escrowRemaining: bigint;
  rewardOutcomeThreshold: bigint;
  state: bigint;
}

export interface ProofCommitment {
  digest: Hex;
  evidenceDigest: Hex;
  committedBlock: bigint;
  revealDeadlineBlock: bigint;
  bond: bigint;
}

export interface ReadProofJobOptions extends ReadSnapshotOptions {
  hunter?: Address;
  evidenceDigest?: Hex;
  claimableAccount?: Address;
}

export declare const policyEffectTuple: string;
export declare const creditObservationTuple: string;
export declare const eventHistoryConfigurationTuple: string;
export declare const proofJobParamsTuple: string;
export declare const proofJobTuple: string;
export declare const proofCommitmentTuple: string;
export declare const merkleProofTuple: string;
export declare const continuityProofTuple: string;
export declare const provenTransactionTuple: string;
export declare const policyResultTuple: string;
export declare const policyRegistryActionAdapterTuple: string;
export declare const policyRegistryPackageReleaseTuple: string;
export declare const policyRegistryRuntimeVariantTuple: string;
export declare const policyRegistryAuditArtifactTuple: string;
export declare const policyRegistryDeploymentRecordTuple: string;
export declare const multiChainRuleTuple: string;
export declare const multiChainConfigurationTuple: string;
export declare const operatorQuoteTuple: string;
export declare const portfolioPoolAllocationTuple: string;
export declare const KERNEL_PROOF_TYPES: readonly string[];
export declare const policyKernelV1Abi: InterfaceAbi;
export declare const verifiedCreditStateV1Abi: InterfaceAbi;
export declare const proofJobsV1Abi: InterfaceAbi;
export declare const recourseFacilityV2Abi: InterfaceAbi;
export declare const recourseFacilityFactoryV2Abi: InterfaceAbi;
export declare const eventHistoryPolicyV1Abi: InterfaceAbi;
export declare const recourseDemoUsdAbi: InterfaceAbi;
export declare const policyRegistryV1Abi: InterfaceAbi;
export declare const portfolioMandateV1Abi: InterfaceAbi;
export declare const portfolioPoolV1Abi: InterfaceAbi;
export declare const cappedPilotFactoryV1Abi: InterfaceAbi;
export declare const recourseFacilityV3Abi: InterfaceAbi;
export declare const policyKernelV2Abi: InterfaceAbi;
export declare const multiChainEventPolicyV1Abi: InterfaceAbi;
export declare const operatorMarketV1Abi: InterfaceAbi;
export declare const horizon1Abis: Readonly<Record<string, InterfaceAbi>>;
export declare const v3Abis: Readonly<Record<string, InterfaceAbi>>;

export declare function encodeKernelProof(input: KernelProofInput): Hex;
export declare function computeEvidenceDigest(proof: Hex): Hex;
export declare function encodeJobCommitment(
  jobId: UintLike,
  hunter: Address,
  evidenceDigest: Hex,
  salt: Hex,
): Hex;
export declare function computeJobCommitment(
  jobId: UintLike,
  hunter: Address,
  evidenceDigest: Hex,
  salt: Hex,
): Hex;
export declare function validateEventHistoryManifest(
  value: EventHistoryManifest,
): EventHistoryManifest;
export declare function encodeEventHistoryManifest(
  value: EventHistoryManifest,
): Hex;
export declare function hashEventHistoryManifest(
  value: EventHistoryManifest,
): Hex;
export declare function decodeEventHistoryManifest(
  manifestBytes: Hex,
): EventHistoryManifest;
export declare function validateEventHistoryManifestBinding(
  manifestBytes: Hex,
  expectedConfigHash: Hex,
): { manifest: EventHistoryManifest; manifestHash: Hex };
export declare function validateMultiChainConfiguration(
  value: MultiChainConfigurationInput,
): MultiChainConfiguration;
export declare function encodeMultiChainConfiguration(
  value: MultiChainConfigurationInput,
): Hex;
export declare function hashMultiChainConfiguration(
  value: MultiChainConfigurationInput,
): Hex;
export declare function decodeMultiChainConfiguration(
  configurationBytes: Hex,
): MultiChainConfiguration;
export declare function simulateMultiChainRisk(value: {
  configuration: MultiChainConfigurationInput;
  currentScore: UintLike;
  ruleMatchCounts: UintLike[];
}): {
  priorScore: bigint;
  newScore: bigint;
  matchedRuleIndexes: number[];
  effect: PolicyEffect;
};
export declare function simulateFacilityPolicyState(
  input: FacilitySimulationInput,
): FacilitySimulation;
export declare function simulateCappedPilotFacilityCreation(
  input: CappedPilotFactorySimulationInput,
): {
  code: number;
  minimumBond: bigint;
  totalFacilityLimitAfter: bigint;
};
export declare function simulateDefaultLossSettlement(
  input: DefaultLossSettlementInput,
): {
  lenderRecovery: bigint;
  borrowerExcess: bigint;
  bondPosted: 0n;
  outstandingDebt: bigint;
  lenderClaimable: bigint;
  borrowerClaimable: bigint;
};
export declare function simulatePortfolioPoolAllocation(
  input: PortfolioPoolAllocationSimulationInput,
): {
  code: number;
  allocationPrincipalAfter: bigint;
  totalAllocatedPrincipalAfter: bigint;
  allocatedFacilityCountAfter: bigint;
};
export declare function simulatePortfolioPoolDistribution(
  input: PortfolioPoolDistributionSimulationInput,
): {
  code: number;
  amount: bigint;
  reserved: bigint;
  totalDistributedAfter: bigint;
  investors: Array<{
    account: Address;
    amount: bigint;
    claimableAfter: bigint;
  }>;
};
export declare function simulatePortfolioMandateEligibility(
  input: PortfolioMandateSimulationInput,
): number;
export declare function validatePolicyPackage(
  value: PolicyPackage,
): PolicyPackage;
export declare function canonicalizePolicyPackage(value: PolicyPackage): string;
export declare function hashPolicyPackage(value: PolicyPackage): Hex;
export declare function computeOperatorAgreementId(value: {
  market: Address;
  chainId: UintLike;
  quoteId: UintLike;
  sponsor: Address;
  quote: OperatorAgreementQuoteInput;
}): Hex;
export declare function encodeCreateCappedPilotFacility(
  value: CappedPilotFacilityRequest,
): Hex;
export declare function encodeSetCappedPilotCreationPaused(
  paused: boolean,
): Hex;
export declare function encodeConfigureMultiChainPolicy(value: {
  facility: Address;
  policyId: UintLike;
  configuration: MultiChainConfigurationInput;
}): Hex;
export declare function encodeSetPolicyKernelV2ProofJobs(
  proofJobs: Address,
): Hex;
export declare function encodeFundFacility(amount: UintLike): Hex;
export declare function encodePostFacilityBond(amount: UintLike): Hex;
export declare function encodeRequestFacilityDraw(amount: UintLike): Hex;
export declare function encodeExecuteFacilityDraw(): Hex;
export declare function encodeRepayFacility(amount: UintLike): Hex;
export declare function encodeMarkFacilityDefaulted(): Hex;
export declare function encodeCancelFacility(): Hex;
export declare function encodeLenderWithdraw(): Hex;
export declare function encodeClaimBorrowerRefund(): Hex;
export declare function encodeSetFacilityDrawPaused(paused: boolean): Hex;
export declare function encodeSettleDefaultLoss(): Hex;
export declare function encodePostOperatorQuote(value: OperatorQuoteInput): Hex;
export declare function encodeAcceptOperatorQuote(quoteId: UintLike): Hex;
export declare function encodeSettleOperatorQuote(
  quoteId: UintLike,
  deliveryDigest: Hex,
  evidence: Hex,
): Hex;
export declare function encodeCancelOperatorQuote(quoteId: UintLike): Hex;
export declare function encodeExpireOperatorQuote(quoteId: UintLike): Hex;
export declare function encodeOperatorWithdrawal(): Hex;
export declare function encodeSetPortfolioPoolMandate(mandate: Address): Hex;
export declare function encodeCreatePortfolioPoolFacility(
  value: CappedPilotFacilityRequest,
): Hex;
export declare function encodeConfigureAndRegisterPortfolioPoolPolicy(value: {
  facility: Address;
  policyId: UintLike;
  evaluator: Address;
  configurationCall: Hex;
}): Hex;
export declare function encodeAuthorizePortfolioPoolRemedyPolicy(value: {
  facility: Address;
  policyId: UintLike;
  coordinator: Address;
}): Hex;
export declare function encodePublishPortfolioPoolRemedyIntent(value: {
  facility: Address;
  policyId: UintLike;
  actionData: Hex;
}): Hex;
export declare function encodeReplacePortfolioPoolRemedyIntent(value: {
  facility: Address;
  policyId: UintLike;
}): Hex;
export declare function encodeRegisterPortfolioPoolCandidate(value: {
  facility: Address;
  deploymentId: Hex;
}): Hex;
export declare function encodeRegisterPortfolioPoolInvestor(
  investor: Address,
): Hex;
export declare function encodeSetPortfolioPoolProofJobsVenue(
  proofJobs: Address,
): Hex;
export declare function encodeOpenPortfolioPoolFunding(): Hex;
export declare function encodePortfolioPoolDeposit(amount: UintLike): Hex;
export declare function encodePortfolioPoolFundingWithdrawal(
  amount: UintLike,
): Hex;
export declare function encodeCancelPortfolioPoolFunding(): Hex;
export declare function encodeActivatePortfolioPool(): Hex;
export declare function encodePortfolioPoolAllocation(
  facility: Address,
  amount: UintLike,
): Hex;
export declare function encodeSetPortfolioPoolFacilityDrawPaused(
  facility: Address,
  paused: boolean,
): Hex;
export declare function encodeCreatePortfolioPoolProofJob(
  params: ProofJobParams,
): Hex;
export declare function encodeRecoverPortfolioPoolProofJobFunds(): Hex;
export declare function encodeHarvestPortfolioPoolFacility(
  facility: Address,
): Hex;
export declare function encodeSettlePortfolioPoolAllocation(
  facility: Address,
): Hex;
export declare function encodeFinalizePortfolioPool(): Hex;
export declare function encodeDistributePortfolioPoolAvailable(): Hex;
export declare function encodeClaimPortfolioPoolAssets(): Hex;
export declare function encodeCreateFacility(value: CreateFacilityRequest): Hex;
export declare function encodeConfigureEventHistoryPolicy(value: {
  facility: Address;
  policyId: UintLike;
  configuration: EventHistoryManifest;
}): Hex;
export declare function encodeRegisterPolicy(value: {
  facility: Address;
  policyId: UintLike;
  evaluator: Address;
}): Hex;
export declare function encodeActivateFacility(expectedPolicySet: Hex): Hex;
export declare function encodeCreateProofJob(params: ProofJobParams): Hex;
export declare function encodeCommitEvidence(
  jobId: UintLike,
  evidenceDigest: Hex,
  commitment: Hex,
): Hex;
export declare function encodeRevealEvidence(
  jobId: UintLike,
  evidenceDigest: Hex,
  salt: Hex,
  proof: Hex,
): Hex;
export declare function encodeSlashExpiredProofCommit(
  jobId: UintLike,
  hunter: Address,
): Hex;
export declare function encodeReleaseProofCommit(jobId: UintLike): Hex;
export declare function encodeFinalizeExpiredProofJob(jobId: UintLike): Hex;
export declare function encodeClaimProofJobs(token: Address): Hex;
export declare function encodePublishPolicyRegistryRelease(
  value: PublishPolicyRegistryReleaseRequest,
): Hex;
export declare function encodeApprovePolicyRegistryRuntimeVariant(value: {
  releaseId: Hex;
  implementation: Address;
  constructorArgumentsHash: Hex;
}): Hex;
export declare function encodeRecordPolicyRegistryDeployment(value: {
  releaseId: Hex;
  kernel: Address;
  facility: Address;
  policyId: UintLike;
  runtimeVariantId: Hex;
}): Hex;
export declare function encodePublishPolicyRegistryAuditArtifact(value: {
  scope: UintLike;
  scopeId: Hex;
  artifactHash: Hex;
  artifactURI: string;
}): Hex;
export declare function buildPolicyRegistryCalldata(requests: {
  publishRelease?: PublishPolicyRegistryReleaseRequest;
  approveRuntimeVariants?: Array<{
    releaseId: Hex;
    implementation: Address;
    constructorArgumentsHash: Hex;
  }>;
  recordDeployments?: Array<{
    releaseId: Hex;
    kernel: Address;
    facility: Address;
    policyId: UintLike;
    runtimeVariantId: Hex;
  }>;
  publishAuditArtifacts?: Array<{
    scope: UintLike;
    scopeId: Hex;
    artifactHash: Hex;
    artifactURI: string;
  }>;
}): {
  publishRelease?: Hex;
  approveRuntimeVariants?: Hex[];
  recordDeployments?: Hex[];
  publishAuditArtifacts?: Hex[];
};
export declare function buildHorizon1Calldata(requests: {
  createFacility?: CreateFacilityRequest;
  configurePolicy?: {
    facility: Address;
    policyId: UintLike;
    configuration: EventHistoryManifest;
  };
  registerPolicy?: {
    facility: Address;
    policyId: UintLike;
    evaluator: Address;
  };
  activateFacility?: { expectedPolicySet: Hex };
  createProofJob?: ProofJobParams;
  commitEvidence?: { jobId: UintLike; evidenceDigest: Hex; commitment: Hex };
  revealEvidence?: {
    jobId: UintLike;
    evidenceDigest: Hex;
    salt: Hex;
    proof: Hex;
  };
}): Record<string, Hex>;
export declare function buildV3Calldata(requests: {
  createPilotFacility?: CappedPilotFacilityRequest;
  setCreationPaused?: boolean;
  configureMultiChainPolicy?: {
    facility: Address;
    policyId: UintLike;
    configuration: MultiChainConfigurationInput;
  };
  registerPolicy?: {
    facility: Address;
    policyId: UintLike;
    evaluator: Address;
  };
  setProofJobs?: { proofJobs: Address };
  fundFacility?: { amount: UintLike };
  postFacilityBond?: { amount: UintLike };
  activateFacility?: { expectedPolicySet: Hex };
  requestFacilityDraw?: { amount: UintLike };
  executeFacilityDraw?: boolean;
  repayFacility?: { amount: UintLike };
  markFacilityDefaulted?: boolean;
  cancelFacility?: boolean;
  lenderWithdraw?: boolean;
  claimBorrowerRefund?: boolean;
  setFacilityDrawPaused?: boolean;
  settleDefaultLoss?: boolean;
  createProofJob?: ProofJobParams;
  slashExpiredProofCommit?: { jobId: UintLike; hunter: Address };
  releaseProofCommit?: { jobId: UintLike };
  finalizeExpiredProofJob?: { jobId: UintLike };
  claimProofJobs?: { token: Address };
  postOperatorQuote?: OperatorQuoteInput;
  acceptOperatorQuote?: { quoteId: UintLike };
  settleOperatorQuote?: {
    quoteId: UintLike;
    deliveryDigest: Hex;
    evidence: Hex;
  };
  cancelOperatorQuote?: { quoteId: UintLike };
  expireOperatorQuote?: { quoteId: UintLike };
  withdrawOperatorClaim?: boolean;
}): Partial<
  Record<
    | "createPilotFacility"
    | "setCreationPaused"
    | "configureMultiChainPolicy"
    | "registerPolicy"
    | "setProofJobs"
    | "fundFacility"
    | "postFacilityBond"
    | "activateFacility"
    | "requestFacilityDraw"
    | "executeFacilityDraw"
    | "repayFacility"
    | "markFacilityDefaulted"
    | "cancelFacility"
    | "lenderWithdraw"
    | "claimBorrowerRefund"
    | "setFacilityDrawPaused"
    | "settleDefaultLoss"
    | "createProofJob"
    | "slashExpiredProofCommit"
    | "releaseProofCommit"
    | "finalizeExpiredProofJob"
    | "claimProofJobs"
    | "postOperatorQuote"
    | "acceptOperatorQuote"
    | "settleOperatorQuote"
    | "cancelOperatorQuote"
    | "expireOperatorQuote"
    | "withdrawOperatorClaim",
    Hex
  >
>;

export declare function buildPortfolioPoolCalldata(requests: {
  setMandate?: { mandate: Address };
  createFacility?: CappedPilotFacilityRequest;
  configureAndRegisterPolicy?: {
    facility: Address;
    policyId: UintLike;
    evaluator: Address;
    configurationCall: Hex;
  };
  authorizeRemedyPolicy?: {
    facility: Address;
    policyId: UintLike;
    coordinator: Address;
  };
  publishRemedyIntent?: {
    facility: Address;
    policyId: UintLike;
    actionData: Hex;
  };
  replaceRemedyIntent?: { facility: Address; policyId: UintLike };
  registerCandidate?: { facility: Address; deploymentId: Hex };
  registerInvestor?: { investor: Address };
  setProofJobsVenue?: { proofJobs: Address };
  openFunding?: boolean;
  deposit?: { amount: UintLike };
  withdrawFunding?: { amount: UintLike };
  cancelFunding?: boolean;
  activate?: boolean;
  allocate?: { facility: Address; amount: UintLike };
  setFacilityDrawPaused?: { facility: Address; paused: boolean };
  createProofJob?: ProofJobParams;
  recoverProofJobFunds?: boolean;
  harvest?: { facility: Address };
  settleAllocation?: { facility: Address };
  finalize?: boolean;
  distributeAvailable?: boolean;
  claim?: boolean;
}): Partial<
  Record<
    | "setMandate"
    | "createFacility"
    | "configureAndRegisterPolicy"
    | "authorizeRemedyPolicy"
    | "publishRemedyIntent"
    | "replaceRemedyIntent"
    | "registerCandidate"
    | "registerInvestor"
    | "setProofJobsVenue"
    | "openFunding"
    | "deposit"
    | "withdrawFunding"
    | "cancelFunding"
    | "activate"
    | "allocate"
    | "setFacilityDrawPaused"
    | "createProofJob"
    | "recoverProofJobFunds"
    | "harvest"
    | "settleAllocation"
    | "finalize"
    | "distributeAvailable"
    | "claim",
    Hex
  >
>;

export interface FacilityRead {
  address: Address;
  blockTag: BlockTag;
  asset: Address;
  kernel: Address;
  lender: Address;
  borrower: Address;
  facilityLimit: bigint;
  bondRequired: bigint;
  initialDrawFeeBps: bigint;
  maturityBlock: bigint;
  drawDelayBlocks: bigint;
  status: bigint;
  policyOutcome: bigint;
  creditLimitBps: bigint;
  futureDrawFeeBps: bigint;
  evidenceValidUntil: bigint;
  freshEvidenceRequired: boolean;
  lenderDrawPaused: boolean;
  borrowerDrawPaused: boolean;
  incidentPaused: boolean;
  lenderFunded: bigint;
  bondPosted: bigint;
  drawnPrincipal: bigint;
  outstandingDebt: bigint;
  pendingDrawAmount: bigint;
  drawReadyAtBlock: bigint;
  lenderClaimable: bigint;
  borrowerClaimable: bigint;
  availableCredit: bigint;
  policyEffects: Array<{
    policyId: bigint;
    effect: PolicyEffect;
    evidenceExpiry: bigint;
    exists: boolean;
  }>;
}

export declare function readFacility(
  address: Address,
  runner: ContractRunner,
  options?: ReadSnapshotOptions,
): Promise<FacilityRead>;
export declare function readFacilityFactory(
  address: Address,
  runner: ContractRunner,
  options?: ReadSnapshotOptions,
): Promise<{
  address: Address;
  blockTag: BlockTag;
  guardian: Address;
  creationPaused: boolean;
  facilities: Address[];
}>;
export declare function readCreditState(
  address: Address,
  runner: ContractRunner,
  facility: Address,
  borrower: Address,
  kind?: UintLike,
  options?: ReadSnapshotOptions,
): Promise<{
  address: Address;
  blockTag: BlockTag;
  kernel: Address;
  facility: Address;
  borrower: Address;
  observations: Array<{
    observationId: bigint;
    policyId: bigint;
    observation: CreditObservation;
  }>;
  latest?: {
    exists: boolean;
    policyId: bigint;
    observation: CreditObservation;
    fresh: boolean;
  };
}>;
export declare function readProofJob(
  address: Address,
  runner: ContractRunner,
  jobId: UintLike,
  options?: ReadProofJobOptions,
): Promise<{
  address: Address;
  blockTag: BlockTag;
  kernel: Address;
  jobId: bigint;
  job: ProofJob;
  hunter?: Address;
  commitment?: ProofCommitment;
  evidenceReservedBy?: Address;
  claimable?: bigint;
}>;
export declare function readPolicyRegistration(
  address: Address,
  runner: ContractRunner,
  facility: Address,
  policyId: UintLike,
  options?: ReadSnapshotOptions,
): Promise<{
  address: Address;
  blockTag: BlockTag;
  facility: Address;
  policyId: bigint;
  evaluator: Address;
  configHash: Hex;
  manifest: Hex;
  policySetCommitment: Hex;
  latestSourcePosition: {
    recorded: boolean;
    blockHeight: bigint;
    transactionIndex: bigint;
  };
}>;
export declare function readPolicyRegistryRelease(
  address: Address,
  runner: ContractRunner,
  releaseId: Hex,
  options?: ReadPolicyRegistryReleaseOptions,
): Promise<PolicyRegistryReleaseRead>;
export declare function readPolicyRegistryCatalog(
  address: Address,
  runner: ContractRunner,
  options?: ReadPolicyRegistryCatalogOptions,
): Promise<PolicyRegistryCatalogRead>;
export declare function readFacilityPolicyCatalog(
  address: Address,
  runner: ContractRunner,
  facility: Address,
  options: ReadFacilityPolicyCatalogOptions,
): Promise<FacilityPolicyCatalogRead>;
export declare function readPolicyRegistryRuntimeVariant(
  address: Address,
  runner: ContractRunner,
  runtimeVariantId: Hex,
  options?: ReadSnapshotOptions,
): Promise<{
  address: Address;
  blockTag: BlockTag;
  runtimeVariantId: Hex;
  variant: RegistryRuntimeVariant;
}>;
export declare function readPolicyRegistryDeployment(
  address: Address,
  runner: ContractRunner,
  deploymentId: Hex,
  options?: ReadSnapshotOptions,
): Promise<{
  address: Address;
  blockTag: BlockTag;
  deploymentId: Hex;
  deployment: RegistryDeploymentRecord;
}>;
export declare function readPolicyRegistryAuditArtifact(
  address: Address,
  runner: ContractRunner,
  artifactId: Hex,
  options?: ReadSnapshotOptions,
): Promise<{
  address: Address;
  blockTag: BlockTag;
  artifactId: Hex;
  artifact: RegistryAuditArtifact;
}>;
export declare function readPolicyRegistryAuditScope(
  address: Address,
  runner: ContractRunner,
  scope: UintLike,
  scopeId: Hex,
  options?: ReadPolicyRegistryAuditScopeOptions,
): Promise<PolicyRegistryAuditScopeRead>;
export declare function readCappedPilotFactory(
  address: Address,
  runner: ContractRunner,
  options?: ReadCappedPilotFactoryOptions,
): Promise<{
  address: Address;
  blockTag: BlockTag;
  blockHash: Hex;
  asset: Address;
  kernel: Address;
  lender: Address;
  borrower: Address;
  guardian: Address;
  maximumFacilityLimit: bigint;
  maximumTotalLimit: bigint;
  minimumBondBps: bigint;
  maximumDrawFeeBps: bigint;
  maximumMaturityBlocks: bigint;
  maximumDrawDelayBlocks: bigint;
  maximumFacilityCount: bigint;
  creationPaused: boolean;
  totalFacilityLimit: bigint;
  totalCount: number;
  start: number;
  facilities: Address[];
  nextCursor: CappedPilotFactoryCursor | null;
}>;
export declare function readPolicyKernelV2(
  address: Address,
  runner: ContractRunner,
  options?: ReadSnapshotOptions,
): Promise<{
  address: Address;
  blockTag: BlockTag;
  blockHash: Hex;
  verifier: Address;
  creditState: Address;
  owner: Address;
  proofJobs: Address;
  safeStaleProofRelease: boolean;
}>;
export declare function readPolicyRegistrationV2(
  address: Address,
  runner: ContractRunner,
  facilityAddress: Address,
  policyId: UintLike,
  chainKeys?: UintLike[],
  options?: ReadSnapshotOptions,
): Promise<{
  address: Address;
  blockTag: BlockTag;
  blockHash: Hex;
  facility: Address;
  policyId: bigint;
  registered: boolean;
  evaluator: Address;
  configHash: Hex;
  manifest: Hex;
  policySetCommitment: Hex;
  sourceOrdering: bigint;
  sourcePositions: Array<{
    chainKey: bigint;
    recorded: boolean;
    blockHeight: bigint;
    transactionIndex: bigint;
  }>;
}>;
export declare function readMultiChainPolicy(
  address: Address,
  runner: ContractRunner,
  facilityAddress: Address,
  policyId: UintLike,
  options?: ReadSnapshotOptions,
): Promise<{
  address: Address;
  blockTag: BlockTag;
  blockHash: Hex;
  facility: Address;
  policyId: bigint;
  context: Address;
  maximumRules: bigint;
  policyKind: string;
  sourceOrdering: bigint;
  configured: boolean;
  configHash: Hex;
  manifest: Hex;
  riskScore: bigint;
  configuration?: MultiChainConfiguration;
}>;
export declare function readOperatorMarket(
  address: Address,
  runner: ContractRunner,
  options?: ReadOperatorMarketOptions,
): Promise<{
  address: Address;
  blockTag: BlockTag;
  blockHash: Hex;
  token: Address;
  verifier: Address;
  minimumOperatorBond: bigint;
  maximumQuoteDuration: bigint;
  maximumServiceDuration: bigint;
  quoteTotalCount: number;
  start: number;
  quotes: Array<{ quoteId: bigint; quote: OperatorQuote }>;
  claimable: Array<{ account: Address; amount: bigint }>;
  nextCursor: OperatorMarketCursor | null;
}>;
export declare function readPortfolioMandate(
  address: Address,
  runner: ContractRunner,
  options?: ReadPortfolioMandateOptions,
): Promise<{
  address: Address;
  blockTag: BlockTag;
  blockHash: Hex;
  factory: Address;
  registry: Address;
  asset: Address;
  kernel: Address;
  requiredReleaseId: Hex;
  requiredPolicySetCommitment: Hex;
  requiredEvidenceKind: bigint;
  requiredActionAdapterKind: Hex;
  maximumFacilityLimit: bigint;
  minimumBondBps: bigint;
  maximumDrawFeeBps: bigint;
  maximumRemainingMaturityBlocks: bigint;
  facility?: Address;
  deploymentId?: Hex;
  eligibilityCode?: bigint;
}>;
export declare function readPortfolioPool(
  address: Address,
  runner: ContractRunner,
  options?: ReadPortfolioPoolOptions,
): Promise<PortfolioPoolRead>;
