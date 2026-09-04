import type { BlockTag } from "ethers";
import type {
  CappedPilotFactorySimulationInput,
  CreditObservation,
  DefaultLossSettlementInput,
  EventHistoryManifest,
  FacilityRead,
  FacilitySimulationInput,
  FacilityPolicyCatalogCursor,
  MultiChainConfiguration,
  MultiChainConfigurationInput,
  OperatorQuote,
  OperatorQuoteInput,
  PolicyRegistryAuditCursor,
  PolicyRegistryAuditScopeRead,
  PolicyRegistryCatalogCursor,
  PolicyRegistryReleaseRead,
  PolicyRegistryReleaseCursor,
  PolicyRegistryCatalogRead,
  PolicyEffect,
  PortfolioMandateSimulationInput,
  PortfolioPoolAllocationSimulationInput,
  PortfolioPoolCursor,
  PortfolioPoolDistributionSimulationInput,
  PortfolioPoolRead,
  ProofCommitment,
  ProofJob,
  PublishPolicyRegistryReleaseRequest,
  ReadSnapshotOptions,
  RegistryAuditArtifact,
  RegistryDeploymentRecord,
  RegistryPackageRelease,
  RegistryRuntimeVariant,
  buildV3Calldata,
  buildPortfolioPoolCalldata,
  buildPolicyRegistryCalldata,
  computeOperatorAgreementId,
  decodeEventHistoryManifest,
  readFacilityPolicyCatalog,
  readCreditState,
  readFacilityFactory,
  readCappedPilotFactory,
  readMultiChainPolicy,
  readOperatorMarket,
  readPolicyKernelV2,
  readPolicyRegistration,
  readPolicyRegistrationV2,
  readPolicyRegistryAuditArtifact,
  readPolicyRegistryCatalog,
  readPolicyRegistryDeployment,
  readPolicyRegistryRuntimeVariant,
  readProofJob,
  readPortfolioMandate,
  readPortfolioPool,
  simulateCappedPilotFacilityCreation,
  simulateDefaultLossSettlement,
  simulateMultiChainRisk,
  simulatePortfolioMandateEligibility,
  simulatePortfolioPoolAllocation,
  simulatePortfolioPoolDistribution,
  validateMultiChainConfiguration,
} from "recourse-protocol-sdk";

declare const facility: FacilityRead;

const decodedEffect: PolicyEffect = facility.policyEffects[0].effect;
const decodedOutcome: bigint = decodedEffect.outcome;
const decodedCreditLimitBps: bigint = decodedEffect.creditLimitBps;
const decodedFutureDrawFeeBps: bigint = decodedEffect.futureDrawFeeBps;
const facilitySnapshotBlock: BlockTag = facility.blockTag;

const inputEffect: EventHistoryManifest["effect"] = {
  outcome: 1,
  creditLimitBps: 9_000,
  futureDrawFeeBps: 250,
  freezePendingDraw: false,
  requireFreshEvidence: false,
  terminate: false,
};

const simulation: FacilitySimulationInput = {
  initialDrawFeeBps: 200,
  facilityLimit: 100_000n,
  drawnPrincipal: 40_000n,
  status: 1,
  lenderDrawPaused: false,
  borrowerDrawPaused: false,
  timestamp: 1_000,
  policies: [{ effect: inputEffect, evidenceExpiry: 2_000 }],
};

void decodedOutcome;
void decodedCreditLimitBps;
void decodedFutureDrawFeeBps;
void facilitySnapshotBlock;
void simulation;

declare const mandateSimulationInput: PortfolioMandateSimulationInput;
type MandateSimulationResult = ReturnType<
  typeof simulatePortfolioMandateEligibility
>;
declare const mandateSimulationResult: MandateSimulationResult;
const mandateEligibilityCode: number = mandateSimulationResult;

void mandateSimulationInput;
void mandateEligibilityCode;

type CreditStateRead = Awaited<ReturnType<typeof readCreditState>>;
type ProofJobRead = Awaited<ReturnType<typeof readProofJob>>;
type FacilityFactoryRead = Awaited<ReturnType<typeof readFacilityFactory>>;
type PolicyRegistrationRead = Awaited<
  ReturnType<typeof readPolicyRegistration>
>;
type RegistryRuntimeVariantRead = Awaited<
  ReturnType<typeof readPolicyRegistryRuntimeVariant>
>;
type RegistryDeploymentRead = Awaited<
  ReturnType<typeof readPolicyRegistryDeployment>
>;
type RegistryAuditArtifactRead = Awaited<
  ReturnType<typeof readPolicyRegistryAuditArtifact>
>;
type FacilityPolicyCatalogRead = Awaited<
  ReturnType<typeof readFacilityPolicyCatalog>
>;
declare const creditStateRead: CreditStateRead;
declare const proofJobRead: ProofJobRead;
declare const facilityFactoryRead: FacilityFactoryRead;
declare const policyRegistrationRead: PolicyRegistrationRead;
declare const registryRuntimeVariantRead: RegistryRuntimeVariantRead;
declare const registryDeploymentRead: RegistryDeploymentRead;
declare const registryAuditArtifactRead: RegistryAuditArtifactRead;
declare const facilityPolicyCatalogRead: FacilityPolicyCatalogRead;

const decodedObservation: CreditObservation =
  creditStateRead.observations[0].observation;
const decodedObservationKind: bigint = decodedObservation.kind;
const decodedLatestObservation: CreditObservation | undefined =
  creditStateRead.latest?.observation;
const decodedJob: ProofJob = proofJobRead.job;
const decodedJobState: bigint = decodedJob.state;
const decodedCommitment: ProofCommitment | undefined = proofJobRead.commitment;
const decodedCommittedBlock: bigint | undefined =
  decodedCommitment?.committedBlock;
const snapshotOptions: ReadSnapshotOptions = { blockTag: 12_345 };
const otherSnapshotBlocks: BlockTag[] = [
  facilityFactoryRead.blockTag,
  policyRegistrationRead.blockTag,
  registryRuntimeVariantRead.blockTag,
  registryDeploymentRead.blockTag,
  registryAuditArtifactRead.blockTag,
  facilityPolicyCatalogRead.blockTag,
];

void decodedObservationKind;
void decodedLatestObservation;
void decodedJobState;
void decodedCommittedBlock;
void snapshotOptions;
void otherSnapshotBlocks;

declare const registryRead: PolicyRegistryReleaseRead;
declare const registryAuditScope: PolicyRegistryAuditScopeRead;

const registryRelease: RegistryPackageRelease = registryRead.release;
const registryReleasedAt: bigint = registryRelease.releasedAt;
const registryVariant: RegistryRuntimeVariant =
  registryRead.runtimeVariants[0].variant;
const registryApprovedAt: bigint = registryVariant.approvedAt;
const registryDeployment: RegistryDeploymentRecord =
  registryRead.deployments[0].deployment;
const registryChainId: bigint = registryDeployment.chainId;
const registryArtifact: RegistryAuditArtifact =
  registryAuditScope.artifacts[0].artifact;
const registryScope: bigint = registryArtifact.scope;
const registryReleaseSnapshotBlock: BlockTag = registryRead.blockTag;
const registryAuditSnapshotBlock: BlockTag = registryAuditScope.blockTag;

const publishReleaseRequest: PublishPolicyRegistryReleaseRequest = {
  packageName: "event-history",
  version: "1.0.0",
  referenceImplementation: "0x0000000000000000000000000000000000000001",
  buildArtifactHash: `0x${"11".repeat(32)}`,
  referenceConstructorArgumentsHash: `0x${"22".repeat(32)}`,
  metadataHash: `0x${"33".repeat(32)}`,
  evidenceKinds: [1, 2n],
  actionAdapters: [],
};

declare const registryCatalog: PolicyRegistryCatalogRead;
const registryCatalogPage = registryCatalog.releases;
const registryCatalogNext: number | null = registryCatalog.nextIndex;
const registryCatalogCursor: PolicyRegistryCatalogCursor | null =
  registryCatalog.nextCursor;
const registryReleaseCursor: PolicyRegistryReleaseCursor | null =
  registryRead.nextCursor;
const registryAuditCursor: PolicyRegistryAuditCursor | null =
  registryAuditScope.nextCursor;
const facilityCatalogCursor: FacilityPolicyCatalogCursor | null =
  facilityPolicyCatalogRead.nextCursor;
type DecodedManifest = ReturnType<typeof decodeEventHistoryManifest>;
declare const decodedManifest: DecodedManifest;
const typedManifest: EventHistoryManifest = decodedManifest;
type RegistryCalls = ReturnType<typeof buildPolicyRegistryCalldata>;
declare const registryCalls: RegistryCalls;
const publishedReleaseCall: string | undefined = registryCalls.publishRelease;
type RegistryCatalogRead = Awaited<
  ReturnType<typeof readPolicyRegistryCatalog>
>;
declare const inferredRegistryCatalog: RegistryCatalogRead;

void registryReleasedAt;
void registryApprovedAt;
void registryChainId;
void registryScope;
void registryReleaseSnapshotBlock;
void registryAuditSnapshotBlock;
void publishReleaseRequest;
void registryCatalogPage;
void registryCatalogNext;
void registryCatalogCursor;
void registryReleaseCursor;
void registryAuditCursor;
void facilityCatalogCursor;
void decodedManifest;
void typedManifest;
void registryCalls;
void publishedReleaseCall;
void inferredRegistryCatalog;

declare const multiChainInput: MultiChainConfigurationInput;
declare const pilotInput: CappedPilotFactorySimulationInput;
declare const defaultLossInput: DefaultLossSettlementInput;
declare const operatorQuoteInput: OperatorQuoteInput;
type NormalizedMultiChain = ReturnType<typeof validateMultiChainConfiguration>;
declare const normalizedMultiChain: NormalizedMultiChain;
const typedMultiChain: MultiChainConfiguration = normalizedMultiChain;
type MultiChainSimulation = ReturnType<typeof simulateMultiChainRisk>;
declare const multiChainSimulation: MultiChainSimulation;
const multiChainScore: bigint = multiChainSimulation.newScore;
type PilotSimulation = ReturnType<typeof simulateCappedPilotFacilityCreation>;
declare const pilotSimulation: PilotSimulation;
const pilotCode: number = pilotSimulation.code;
type DefaultLossSimulation = ReturnType<typeof simulateDefaultLossSettlement>;
declare const defaultLossSimulation: DefaultLossSimulation;
const lenderRecovery: bigint = defaultLossSimulation.lenderRecovery;
type AgreementId = ReturnType<typeof computeOperatorAgreementId>;
declare const agreementId: AgreementId;
type V3Calls = ReturnType<typeof buildV3Calldata>;
declare const v3Calls: V3Calls;
const pilotCall: string | undefined = v3Calls.createPilotFacility;
type CappedPilotFactoryRead = Awaited<
  ReturnType<typeof readCappedPilotFactory>
>;
type PolicyKernelV2Read = Awaited<ReturnType<typeof readPolicyKernelV2>>;
type PolicyRegistrationV2Read = Awaited<
  ReturnType<typeof readPolicyRegistrationV2>
>;
type MultiChainPolicyRead = Awaited<ReturnType<typeof readMultiChainPolicy>>;
type OperatorMarketRead = Awaited<ReturnType<typeof readOperatorMarket>>;
type PortfolioMandateRead = Awaited<ReturnType<typeof readPortfolioMandate>>;
declare const cappedPilotFactoryRead: CappedPilotFactoryRead;
declare const policyKernelV2Read: PolicyKernelV2Read;
declare const policyRegistrationV2Read: PolicyRegistrationV2Read;
declare const multiChainPolicyRead: MultiChainPolicyRead;
declare const operatorMarketRead: OperatorMarketRead;
declare const portfolioMandateRead: PortfolioMandateRead;
const marketQuote: OperatorQuote | undefined =
  operatorMarketRead.quotes[0]?.quote;
const factoryContinuationBlock: number | undefined =
  cappedPilotFactoryRead.nextCursor?.blockNumber;
const kernelProofJobs: string = policyKernelV2Read.proofJobs;
const registeredSourceChain: bigint | undefined =
  policyRegistrationV2Read.sourcePositions[0]?.chainKey;
const registeredSourceOrdering: bigint =
  policyRegistrationV2Read.sourceOrdering;
const configuredMultiChain: MultiChainConfiguration | undefined =
  multiChainPolicyRead.configuration;
const multiChainSourceOrdering: bigint = multiChainPolicyRead.sourceOrdering;
const mandateEligibility: bigint | undefined =
  portfolioMandateRead.eligibilityCode;

void operatorQuoteInput;
void pilotInput;
void defaultLossInput;
void normalizedMultiChain;
void typedMultiChain;
void multiChainScore;
void pilotCode;
void lenderRecovery;
void agreementId;
void pilotCall;
void marketQuote;
void factoryContinuationBlock;
void kernelProofJobs;
void registeredSourceChain;
void registeredSourceOrdering;
void configuredMultiChain;
void multiChainSourceOrdering;
void mandateEligibility;

declare const poolAllocationInput: PortfolioPoolAllocationSimulationInput;
declare const poolDistributionInput: PortfolioPoolDistributionSimulationInput;
type PoolAllocationSimulation = ReturnType<
  typeof simulatePortfolioPoolAllocation
>;
type PoolDistributionSimulation = ReturnType<
  typeof simulatePortfolioPoolDistribution
>;
declare const poolAllocationSimulation: PoolAllocationSimulation;
declare const poolDistributionSimulation: PoolDistributionSimulation;
const poolAllocationCode: number = poolAllocationSimulation.code;
const poolDistributedAmount: bigint = poolDistributionSimulation.amount;
type PortfolioPoolCalls = ReturnType<typeof buildPortfolioPoolCalldata>;
declare const portfolioPoolCalls: PortfolioPoolCalls;
const poolAllocationCall: string | undefined = portfolioPoolCalls.allocate;
const poolPublishRemedyCall: string | undefined =
  portfolioPoolCalls.publishRemedyIntent;
const poolReplaceRemedyCall: string | undefined =
  portfolioPoolCalls.replaceRemedyIntent;
type InferredPortfolioPoolRead = Awaited<ReturnType<typeof readPortfolioPool>>;
declare const inferredPortfolioPoolRead: InferredPortfolioPoolRead;
const portfolioPoolRead: PortfolioPoolRead = inferredPortfolioPoolRead;
const poolCursor: PortfolioPoolCursor | null = portfolioPoolRead.nextCursor;
const realizedLoss: bigint =
  portfolioPoolRead.candidates[0].allocation.realizedLoss;

void poolAllocationInput;
void poolDistributionInput;
void poolAllocationCode;
void poolDistributedAmount;
void poolAllocationCall;
void poolPublishRemedyCall;
void poolReplaceRemedyCall;
void poolCursor;
void realizedLoss;
