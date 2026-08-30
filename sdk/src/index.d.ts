import type { BlockTag, ContractRunner, InterfaceAbi } from "ethers";

export type Address = string;
export type Hex = string;
export type UintLike = bigint | number | string;

export interface ReadSnapshotOptions {
  blockTag?: BlockTag;
}

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
}

export interface PolicyRegistryAuditScopeRead {
  address: Address;
  blockTag: BlockTag;
  scope: UintLike;
  scopeId: Hex;
  scopeHash: Hex;
  artifacts: Array<{ artifactId: Hex; artifact: RegistryAuditArtifact }>;
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
export declare const KERNEL_PROOF_TYPES: readonly string[];
export declare const policyKernelV1Abi: InterfaceAbi;
export declare const verifiedCreditStateV1Abi: InterfaceAbi;
export declare const proofJobsV1Abi: InterfaceAbi;
export declare const recourseFacilityV2Abi: InterfaceAbi;
export declare const recourseFacilityFactoryV2Abi: InterfaceAbi;
export declare const eventHistoryPolicyV1Abi: InterfaceAbi;
export declare const recourseDemoUsdAbi: InterfaceAbi;
export declare const policyRegistryV1Abi: InterfaceAbi;
export declare const horizon1Abis: Readonly<Record<string, InterfaceAbi>>;

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
export declare function simulateFacilityPolicyState(
  input: FacilitySimulationInput,
): FacilitySimulation;
export declare function validatePolicyPackage(
  value: PolicyPackage,
): PolicyPackage;
export declare function canonicalizePolicyPackage(value: PolicyPackage): string;
export declare function hashPolicyPackage(value: PolicyPackage): Hex;
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
  options?: ReadSnapshotOptions,
): Promise<PolicyRegistryReleaseRead>;
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
  options?: ReadSnapshotOptions,
): Promise<PolicyRegistryAuditScopeRead>;
