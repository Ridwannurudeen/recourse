import type { BlockTag } from "ethers";
import type {
  CreditObservation,
  EventHistoryManifest,
  FacilityRead,
  FacilitySimulationInput,
  FacilityPolicyCatalogCursor,
  PolicyRegistryAuditCursor,
  PolicyRegistryAuditScopeRead,
  PolicyRegistryCatalogCursor,
  PolicyRegistryReleaseRead,
  PolicyRegistryReleaseCursor,
  PolicyRegistryCatalogRead,
  PolicyEffect,
  PortfolioMandateSimulationInput,
  ProofCommitment,
  ProofJob,
  PublishPolicyRegistryReleaseRequest,
  ReadSnapshotOptions,
  RegistryAuditArtifact,
  RegistryDeploymentRecord,
  RegistryPackageRelease,
  RegistryRuntimeVariant,
  buildPolicyRegistryCalldata,
  decodeEventHistoryManifest,
  readFacilityPolicyCatalog,
  readCreditState,
  readFacilityFactory,
  readPolicyRegistration,
  readPolicyRegistryAuditArtifact,
  readPolicyRegistryCatalog,
  readPolicyRegistryDeployment,
  readPolicyRegistryRuntimeVariant,
  readProofJob,
  simulatePortfolioMandateEligibility,
} from "@recourse/sdk";

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
