export const policyEffectTuple =
  "tuple(uint8 outcome,uint16 creditLimitBps,uint16 futureDrawFeeBps,bool freezePendingDraw,bool requireFreshEvidence,bool terminate)";
export const creditObservationTuple =
  "tuple(uint8 kind,uint8 evidenceKind,uint64 sourceChain,uint64 sourceBlock,uint64 transactionIndex,address subject,address emitter,uint256 observedValue,uint64 proofTime,uint64 expiry,bytes32 evidenceDigest,bytes32 policyEffectHash)";
export const eventHistoryConfigurationTuple = `tuple(uint64 sourceChain,address emitter,bytes32 eventSignature,address subject,uint64 startSourceBlock,uint64 endSourceBlock,uint8 topicCount,uint8 subjectTopicIndex,uint16 dataLength,uint16 observedValueOffset,uint8 observationKind,uint8 evidenceKind,uint64 freshnessPeriod,${policyEffectTuple} effect)`;
export const proofJobParamsTuple =
  "tuple(address token,address facility,uint256 policyId,bytes32 requirementsDigest,uint64 expiry,uint64 revealWindowBlocks,uint32 maxSuccessfulProofs,uint256 proofReimbursement,uint256 outcomeReward,uint256 commitBond,uint8 rewardOutcomeThreshold)";
export const proofJobTuple =
  "tuple(address sponsor,address token,address facility,uint256 policyId,bytes32 requirementsDigest,uint64 expiry,uint64 revealWindowBlocks,uint32 maxSuccessfulProofs,uint32 successfulProofs,uint256 proofReimbursement,uint256 outcomeReward,uint256 commitBond,uint256 escrowRemaining,uint8 rewardOutcomeThreshold,uint8 state)";
export const proofCommitmentTuple =
  "tuple(bytes32 digest,bytes32 evidenceDigest,uint64 committedBlock,uint64 revealDeadlineBlock,uint256 bond)";
export const merkleProofTuple =
  "tuple(bytes32 root,tuple(bytes32 hash,bool isLeft)[] siblings)";
export const continuityProofTuple =
  "tuple(bytes32 lowerEndpointDigest,bytes32[] roots)";
export const provenTransactionTuple =
  "tuple(uint64 chainKey,uint64 blockHeight,uint64 txIndex,bytes encodedTransaction)";
export const policyResultTuple = `tuple(${policyEffectTuple} effect,uint8 observationKind,uint8 evidenceKind,uint64 sourceBlock,uint64 transactionIndex,address subject,address emitter,uint256 observedValue,uint64 freshnessPeriod)`;
export const policyRegistryActionAdapterTuple =
  "tuple(bytes32 adapterKind,bytes32 specificationHash,string metadataURI)";
export const policyRegistryPackageReleaseTuple =
  "tuple(address issuer,string packageName,string version,address referenceImplementation,bytes32 buildArtifactHash,bytes32 referenceRuntimeCodeHash,bytes32 referenceVariantId,bytes32 metadataHash,bytes32 releaseContentHash,uint64 releasedAt,bool exists)";
export const policyRegistryRuntimeVariantTuple =
  "tuple(bytes32 releaseId,address implementation,bytes32 runtimeCodeHash,bytes32 constructorArgumentsHash,uint64 approvedAt,bool exists)";
export const policyRegistryAuditArtifactTuple =
  "tuple(uint8 scope,bytes32 releaseId,bytes32 deploymentId,bytes32 scopeHash,address auditor,bytes32 artifactHash,string artifactURI,uint64 publishedAt,bool exists)";
export const policyRegistryDeploymentRecordTuple =
  "tuple(bytes32 releaseId,uint256 chainId,address kernel,address facility,uint256 policyId,address evaluator,bytes32 runtimeVariantId,bytes32 runtimeCodeHash,bytes32 constructorArgumentsHash,bytes32 configHash,bytes32 manifestHash,address attester,uint64 recordedAt,bool exists)";

export const policyKernelV1Abi = [
  "function verifier() view returns (address)",
  "function creditState() view returns (address)",
  "function owner() view returns (address)",
  "function proofJobs() view returns (address)",
  "function policySetCommitment(address facility) view returns (bytes32)",
  "function registerPolicy(address facility,uint256 policyId,address evaluator)",
  `function submitSingle(address facility,uint256 policyId,uint64 chainKey,uint64 height,bytes encodedTransaction,${merkleProofTuple} merkleProof,${continuityProofTuple} continuityProof) returns (uint8 outcome)`,
  `function submitBatch(address facility,uint256 policyId,uint64 chainKey,uint64[] heights,bytes[] encodedTransactions,${merkleProofTuple}[] merkleProofs,${continuityProofTuple} sharedContinuityProof) returns (uint8 outcome)`,
  "function setProofJobs(address proofJobs)",
  "function incidentPaused(address facility) view returns (bool)",
  "function canPublishJob(address facility,address sponsor,address token,uint256 policyId,bytes32 requirementsDigest) view returns (bool)",
  "function evaluateProofJob(address facility,uint256 policyId,bytes32 requirementsDigest,bytes proof,address hunter) returns (bool accepted,uint8 outcomeLevel)",
  "function policyOf(address facility,uint256 policyId) view returns (address evaluator,bytes32 configHash,bytes manifestBytes)",
  "function lenderOf(address facility) view returns (address)",
  "function isPolicyRegistered(address facility,uint256 policyId) view returns (bool)",
  "function queryId(uint64 chainKey,uint64 blockHeight,uint64 txIndex) pure returns (bytes32)",
  "function isProcessed(address facility,uint256 policyId,bytes32 qid) view returns (bool)",
  "function latestSourcePosition(address facility,uint256 policyId) view returns (bool recorded,uint64 blockHeight,uint64 transactionIndex)",
  "event PolicyRegistered(address indexed facility,uint256 indexed policyId,address indexed evaluator,bytes32 configHash,bytes manifest)",
  "event EvidenceAccepted(address indexed facility,uint256 indexed policyId,bytes32 indexed queryId,address submitter,uint8 outcome)",
];

export const verifiedCreditStateV1Abi = [
  "function kernel() view returns (address)",
  `function recordObservation(address facility,uint256 policyId,${creditObservationTuple} observation) returns (uint256 observationId)`,
  "function observationCount(address facility,address borrower) view returns (uint256)",
  `function observationAt(address facility,address borrower,uint256 observationId) view returns (uint256 policyId,${creditObservationTuple} observation)`,
  `function latestObservation(address facility,address borrower,uint8 kind) view returns (bool exists,uint256 policyId,${creditObservationTuple} observation)`,
  "function isFresh(address facility,address borrower,uint8 kind) view returns (bool)",
  "event ObservationRecorded(address indexed facility,address indexed borrower,uint256 indexed observationId,uint256 policyId,uint8 kind,bytes32 evidenceDigest)",
];

export const proofJobsV1Abi = [
  "function kernel() view returns (address)",
  "function nextJobId() view returns (uint256)",
  `function createJob(${proofJobParamsTuple} params) returns (uint256 jobId)`,
  "function commitEvidence(uint256 jobId,bytes32 evidenceDigest,bytes32 commitment)",
  "function revealEvidence(uint256 jobId,bytes32 evidenceDigest,bytes32 salt,bytes proof)",
  "function slashExpiredCommit(uint256 jobId,address hunter)",
  "function releaseCommit(uint256 jobId)",
  "function finalizeExpired(uint256 jobId)",
  "function claim(address token)",
  "function computeCommitment(uint256 jobId,address hunter,bytes32 evidenceDigest,bytes32 salt) pure returns (bytes32)",
  `function getJob(uint256 jobId) view returns (${proofJobTuple})`,
  `function getCommitment(uint256 jobId,address hunter) view returns (${proofCommitmentTuple})`,
  "function evidenceReservedBy(uint256 jobId,bytes32 evidenceDigest) view returns (address)",
  "function claimable(address token,address account) view returns (uint256)",
  "event JobCreated(uint256 indexed jobId,address indexed sponsor,address indexed facility,uint256 policyId,bytes32 requirementsDigest,uint256 escrow)",
  "event EvidenceCommitted(uint256 indexed jobId,address indexed hunter,bytes32 indexed evidenceDigest,bytes32 commitment,uint64 revealDeadlineBlock)",
  "event ProofAccepted(uint256 indexed jobId,address indexed hunter,uint8 outcomeLevel,uint32 successfulProofs)",
  "event ProcessedProofReleased(uint256 indexed jobId,address indexed hunter,bytes32 indexed evidenceDigest)",
  "event JobFinalized(uint256 indexed jobId,uint8 state,uint256 sponsorRefund)",
  "event CommitmentSlashed(uint256 indexed jobId,address indexed hunter,uint256 bond)",
  "event CommitmentReleased(uint256 indexed jobId,address indexed hunter,uint256 bond)",
  "event Claimed(address indexed token,address indexed account,uint256 amount)",
];

export const recourseFacilityV2Abi = [
  "function asset() view returns (address)",
  "function kernel() view returns (address)",
  "function lender() view returns (address)",
  "function borrower() view returns (address)",
  "function facilityLimit() view returns (uint256)",
  "function bondRequired() view returns (uint256)",
  "function initialDrawFeeBps() view returns (uint16)",
  "function maturityBlock() view returns (uint64)",
  "function drawDelayBlocks() view returns (uint32)",
  "function status() view returns (uint8)",
  "function policyOutcome() view returns (uint8)",
  "function creditLimitBps() view returns (uint16)",
  "function futureDrawFeeBps() view returns (uint16)",
  "function evidenceValidUntil() view returns (uint64)",
  "function freshEvidenceRequired() view returns (bool)",
  "function lenderDrawPaused() view returns (bool)",
  "function borrowerDrawPaused() view returns (bool)",
  "function lenderFunded() view returns (uint256)",
  "function bondPosted() view returns (uint256)",
  "function drawnPrincipal() view returns (uint256)",
  "function outstandingDebt() view returns (uint256)",
  "function pendingDrawAmount() view returns (uint256)",
  "function drawReadyAtBlock() view returns (uint256)",
  "function lenderClaimable() view returns (uint256)",
  "function borrowerClaimable() view returns (uint256)",
  "function incidentPaused() view returns (bool)",
  "function availableCredit() view returns (uint256)",
  "function policyCount() view returns (uint256)",
  "function policyIdAt(uint256 index) view returns (uint256)",
  `function policyEffectOf(uint256 policyId) view returns (${policyEffectTuple} effect,uint64 evidenceExpiry,bool exists)`,
  "function fundAsLender(uint256 amount)",
  "function postBond(uint256 amount)",
  "function activate(bytes32 expectedPolicySet)",
  "function requestDraw(uint256 amount)",
  "function executeDraw()",
  "function repay(uint256 amount)",
  "function markDefaulted()",
  "function cancel()",
  "function lenderWithdraw()",
  "function claimBorrowerRefund()",
  "function setDrawPaused(bool paused)",
  `function applyPolicyEffect(uint256 policyId,${policyEffectTuple} effect,uint64 evidenceExpiry)`,
  "event Activated(bytes32 indexed policySetCommitment)",
  "event BondPosted(uint256 amount)",
  "event BorrowerClaimed(uint256 amount)",
  "event DrawExecuted(uint256 amount,uint256 fee)",
  "event DrawPauseSet(address indexed party,bool paused)",
  "event DrawRequested(uint256 amount,uint256 readyAtBlock)",
  "event LenderClaimed(uint256 amount)",
  "event LenderFunded(uint256 amount)",
  "event PolicyEffectApplied(uint256 indexed policyId,uint8 indexed outcome,uint16 creditLimitBps,uint16 futureDrawFeeBps)",
  "event Repaid(uint256 amount,uint256 outstandingDebt)",
];

export const recourseFacilityFactoryV2Abi = [
  "function guardian() view returns (address)",
  "function creationPaused() view returns (bool)",
  "function isFacility(address facility) view returns (bool)",
  "function facilityCount() view returns (uint256)",
  "function facilityAt(uint256 index) view returns (address)",
  "function setCreationPaused(bool paused)",
  "function createFacility(address asset,address kernel,address lender,address borrower,uint256 facilityLimit,uint256 bondRequired,uint16 drawFeeBps,uint64 maturityBlock,uint32 drawDelayBlocks) returns (address facility)",
  "event CreationPauseSet(bool paused)",
  "event FacilityCreated(address indexed facility,address indexed lender,address indexed borrower,address asset,address kernel)",
];

export const eventHistoryPolicyV1Abi = [
  "function context() view returns (address)",
  `function configure(address facility,uint256 policyId,${eventHistoryConfigurationTuple} configuration)`,
  `function evaluate(address facility,uint256 policyId,${provenTransactionTuple}[] proven) view returns (${policyResultTuple} result)`,
  "function isConfigured(address facility,uint256 policyId) view returns (bool)",
  `function configurationOf(address facility,uint256 policyId) view returns (${eventHistoryConfigurationTuple})`,
  "function configHash(address facility,uint256 policyId) view returns (bytes32)",
  "function manifest(address facility,uint256 policyId) view returns (bytes)",
  "function policyKind() pure returns (string)",
  "event PolicyConfigured(address indexed facility,uint256 indexed policyId,bytes32 indexed configurationHash)",
];

export const recourseDemoUsdAbi = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() pure returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 value) returns (bool)",
  "function transfer(address to,uint256 value) returns (bool)",
  "function transferFrom(address from,address to,uint256 value) returns (bool)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event Approval(address indexed owner,address indexed spender,uint256 value)",
];

export const policyRegistryV1Abi = [
  "function MAX_ACTION_ADAPTERS() view returns (uint256)",
  "function MAX_AUDIT_URI_BYTES() view returns (uint256)",
  "function MAX_EVIDENCE_KINDS() view returns (uint256)",
  "function MAX_METADATA_URI_BYTES() view returns (uint256)",
  "function MAX_PACKAGE_NAME_BYTES() view returns (uint256)",
  "function MAX_VERSION_BYTES() view returns (uint256)",
  `function actionAdapterAt(bytes32 releaseId,uint256 index) view returns (${policyRegistryActionAdapterTuple})`,
  "function actionAdapterCount(bytes32 releaseId) view returns (uint256)",
  "function approveRuntimeVariant(bytes32 releaseId,address implementation,bytes32 constructorArgumentsHash) returns (bytes32 runtimeVariantId)",
  `function auditArtifact(bytes32 artifactId) view returns (${policyRegistryAuditArtifactTuple})`,
  "function auditArtifactAt(uint8 scope,bytes32 scopeId,uint256 index) view returns (bytes32)",
  "function auditArtifactCount(uint8 scope,bytes32 scopeId) view returns (uint256)",
  "function auditScopeHash(uint8 scope,bytes32 scopeId) view returns (bytes32)",
  "function declaresEvidenceKind(bytes32 releaseId,uint8 evidenceKind) view returns (bool)",
  "function deploymentAt(bytes32 releaseId,uint256 index) view returns (bytes32)",
  "function deploymentCount(bytes32 releaseId) view returns (uint256)",
  `function deploymentRecord(bytes32 deploymentId) view returns (${policyRegistryDeploymentRecordTuple})`,
  "function evidenceKindAt(bytes32 releaseId,uint256 index) view returns (uint8)",
  "function evidenceKindCount(bytes32 releaseId) view returns (uint256)",
  `function packageRelease(bytes32 releaseId) view returns (${policyRegistryPackageReleaseTuple})`,
  "function publishAuditArtifact(uint8 scope,bytes32 scopeId,bytes32 artifactHash,string artifactURI) returns (bytes32 artifactId)",
  `function publishRelease(string packageName,string version,address referenceImplementation,bytes32 buildArtifactHash,bytes32 referenceConstructorArgumentsHash,bytes32 metadataHash,uint8[] evidenceKinds,${policyRegistryActionAdapterTuple}[] actionAdapters) returns (bytes32 releaseId)`,
  "function recordDeployment(bytes32 releaseId,address kernel,address facility,uint256 policyId,bytes32 runtimeVariantId) returns (bytes32 deploymentId)",
  "function releaseIdOf(address issuer,string packageName,string version) pure returns (bytes32)",
  `function runtimeVariant(bytes32 runtimeVariantId) view returns (${policyRegistryRuntimeVariantTuple})`,
  "function runtimeVariantAt(bytes32 releaseId,uint256 index) view returns (bytes32)",
  "function runtimeVariantCount(bytes32 releaseId) view returns (uint256)",
  "function runtimeVariantIdOf(bytes32 releaseId,bytes32 runtimeCodeHash,bytes32 constructorArgumentsHash) pure returns (bytes32)",
  "event AuditArtifactPublished(bytes32 indexed artifactId,uint8 indexed scope,bytes32 indexed scopeId,address auditor,bytes32 scopeHash,bytes32 artifactHash,string artifactURI)",
  "event PackageReleasePublished(bytes32 indexed releaseId,address indexed issuer,address indexed referenceImplementation,bytes32 buildArtifactHash,bytes32 referenceRuntimeCodeHash,bytes32 referenceVariantId,bytes32 releaseContentHash)",
  "event PolicyDeploymentRecorded(bytes32 indexed deploymentId,bytes32 indexed releaseId,address indexed kernel,address facility,uint256 policyId,address evaluator,bytes32 runtimeVariantId,bytes32 configHash)",
  "event RuntimeVariantApproved(bytes32 indexed runtimeVariantId,bytes32 indexed releaseId,address indexed implementation,bytes32 runtimeCodeHash,bytes32 constructorArgumentsHash)",
  "error ActionAdapterLimitExceeded()",
  "error AuditArtifactAlreadyPublished()",
  "error AuditArtifactURITooLong()",
  "error ConstructorArgumentsHashMismatch()",
  "error DeploymentAlreadyRecorded()",
  "error DeploymentNotFound()",
  "error DuplicateActionAdapterDeclaration()",
  "error DuplicateEvidenceKind()",
  "error EmptyPackageName()",
  "error EmptyVersion()",
  "error EvidenceKindLimitExceeded()",
  "error FacilityKernelMismatch()",
  "error InvalidActionAdapterDeclaration()",
  "error InvalidAuditArtifact()",
  "error InvalidBuildArtifactHash()",
  "error InvalidConstructorArgumentsHash()",
  "error InvalidFacility()",
  "error InvalidRegisteredConfiguration()",
  "error MetadataURITooLong()",
  "error NoEvidenceKinds()",
  "error NoRuntimeCode()",
  "error NotReleaseIssuer()",
  "error PackageNameTooLong()",
  "error PolicyNotRegistered()",
  "error ReleaseAlreadyPublished()",
  "error ReleaseNotFound()",
  "error RuntimeVariantAlreadyApproved()",
  "error RuntimeVariantMismatch()",
  "error RuntimeVariantNotApproved()",
  "error TimestampOverflow()",
  "error VersionTooLong()",
  "error ZeroMetadataHash()",
];

export const horizon1Abis = Object.freeze({
  PolicyKernelV1: policyKernelV1Abi,
  VerifiedCreditStateV1: verifiedCreditStateV1Abi,
  ProofJobsV1: proofJobsV1Abi,
  RecourseFacilityV2: recourseFacilityV2Abi,
  RecourseFacilityFactoryV2: recourseFacilityFactoryV2Abi,
  EventHistoryPolicyV1: eventHistoryPolicyV1Abi,
  RecourseDemoUSD: recourseDemoUsdAbi,
  PolicyRegistryV1: policyRegistryV1Abi,
});
