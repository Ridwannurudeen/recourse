import type { BlockTag } from "ethers";
import type {
  CreditObservation,
  EventHistoryManifest,
  FacilityRead,
  FacilitySimulationInput,
  PolicyRegistryAuditScopeRead,
  PolicyRegistryReleaseRead,
  PolicyEffect,
  ProofCommitment,
  ProofJob,
  PublishPolicyRegistryReleaseRequest,
  ReadSnapshotOptions,
  RegistryAuditArtifact,
  RegistryDeploymentRecord,
  RegistryPackageRelease,
  RegistryRuntimeVariant,
  readCreditState,
  readFacilityFactory,
  readPolicyRegistration,
  readPolicyRegistryAuditArtifact,
  readPolicyRegistryDeployment,
  readPolicyRegistryRuntimeVariant,
  readProofJob,
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
declare const creditStateRead: CreditStateRead;
declare const proofJobRead: ProofJobRead;
declare const facilityFactoryRead: FacilityFactoryRead;
declare const policyRegistrationRead: PolicyRegistrationRead;
declare const registryRuntimeVariantRead: RegistryRuntimeVariantRead;
declare const registryDeploymentRead: RegistryDeploymentRead;
declare const registryAuditArtifactRead: RegistryAuditArtifactRead;

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

void registryReleasedAt;
void registryApprovedAt;
void registryChainId;
void registryScope;
void registryReleaseSnapshotBlock;
void registryAuditSnapshotBlock;
void publishReleaseRequest;
