import { Contract, getAddress } from "ethers";
import {
  policyKernelV1Abi,
  policyRegistryV1Abi,
  proofJobsV1Abi,
  recourseFacilityFactoryV2Abi,
  recourseFacilityV2Abi,
  verifiedCreditStateV1Abi,
} from "./abis.mjs";

function contract(address, abi, runner) {
  if (!runner) throw new TypeError("A contract runner is required");
  return new Contract(getAddress(address), abi, runner);
}

function indexedLength(value, label) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError(`Invalid ${label}`);
  return Number(value);
}

async function currentBlockNumber(provider) {
  if (typeof provider.getBlockNumber !== "function")
    throw new TypeError(
      "A blockTag or provider with getBlockNumber is required",
    );
  return provider.getBlockNumber();
}

async function snapshotBlockTag(runner, blockTag) {
  const provider = runner.provider ?? runner;
  if (blockTag === undefined || blockTag === "latest")
    return currentBlockNumber(provider);
  if (blockTag === null) throw new TypeError("Invalid blockTag");
  if (blockTag === "pending")
    throw new TypeError("A pending blockTag cannot provide a pinned snapshot");
  if (blockTag === "earliest") return 0;
  if (blockTag === "safe" || blockTag === "finalized") {
    if (typeof provider.getBlock !== "function")
      throw new TypeError(
        `A provider with getBlock is required for ${blockTag}`,
      );
    const block = await provider.getBlock(blockTag);
    if (block === null) throw new RangeError(`Unable to resolve ${blockTag}`);
    return block.number;
  }
  if (typeof blockTag === "number") {
    if (!Number.isSafeInteger(blockTag))
      throw new TypeError("Invalid blockTag");
    if (blockTag >= 0) return blockTag;
    const resolved = (await currentBlockNumber(provider)) + blockTag;
    if (resolved < 0) throw new RangeError("Invalid blockTag");
    return resolved;
  }
  if (typeof blockTag === "bigint" && blockTag < 0n) {
    const resolved = BigInt(await currentBlockNumber(provider)) + blockTag;
    if (resolved < 0n) throw new RangeError("Invalid blockTag");
    return resolved;
  }
  return blockTag;
}

async function beginSnapshot(runner, requestedBlockTag) {
  const provider = runner.provider ?? runner;
  if (typeof provider.getBlock !== "function")
    throw new TypeError(
      "A provider with getBlock is required for immutable snapshots",
    );
  const resolvedBlockTag = await snapshotBlockTag(runner, requestedBlockTag);
  const block = await provider.getBlock(resolvedBlockTag);
  if (
    block === null ||
    !Number.isSafeInteger(block.number) ||
    block.number < 0 ||
    typeof block.hash !== "string"
  ) {
    throw new RangeError(`Unable to anchor block ${String(resolvedBlockTag)}`);
  }
  return {
    provider,
    blockTag: block.number,
    expectedHash: block.hash.toLowerCase(),
  };
}

async function assertSnapshot(snapshot) {
  const block = await snapshot.provider.getBlock(snapshot.blockTag);
  if (
    block === null ||
    typeof block.hash !== "string" ||
    block.hash.toLowerCase() !== snapshot.expectedHash
  ) {
    throw new Error(
      `Block ${snapshot.blockTag} changed while the SDK snapshot was being read`,
    );
  }
}

export async function readFacility(address, runner, options = {}) {
  const facility = contract(address, recourseFacilityV2Abi, runner);
  const snapshot = await beginSnapshot(runner, options.blockTag);
  const { blockTag } = snapshot;
  const overrides = { blockTag };
  const [
    asset,
    kernel,
    lender,
    borrower,
    facilityLimit,
    bondRequired,
    initialDrawFeeBps,
    maturityBlock,
    drawDelayBlocks,
    status,
    policyOutcome,
    creditLimitBps,
    futureDrawFeeBps,
    evidenceValidUntil,
    freshEvidenceRequired,
    lenderDrawPaused,
    borrowerDrawPaused,
    lenderFunded,
    bondPosted,
    drawnPrincipal,
    outstandingDebt,
    pendingDrawAmount,
    drawReadyAtBlock,
    lenderClaimable,
    borrowerClaimable,
    availableCredit,
    policyCount,
  ] = await Promise.all([
    facility.asset(overrides),
    facility.kernel(overrides),
    facility.lender(overrides),
    facility.borrower(overrides),
    facility.facilityLimit(overrides),
    facility.bondRequired(overrides),
    facility.initialDrawFeeBps(overrides),
    facility.maturityBlock(overrides),
    facility.drawDelayBlocks(overrides),
    facility.status(overrides),
    facility.policyOutcome(overrides),
    facility.creditLimitBps(overrides),
    facility.futureDrawFeeBps(overrides),
    facility.evidenceValidUntil(overrides),
    facility.freshEvidenceRequired(overrides),
    facility.lenderDrawPaused(overrides),
    facility.borrowerDrawPaused(overrides),
    facility.lenderFunded(overrides),
    facility.bondPosted(overrides),
    facility.drawnPrincipal(overrides),
    facility.outstandingDebt(overrides),
    facility.pendingDrawAmount(overrides),
    facility.drawReadyAtBlock(overrides),
    facility.lenderClaimable(overrides),
    facility.borrowerClaimable(overrides),
    facility.availableCredit(overrides),
    facility.policyCount(overrides),
  ]);
  const policyIds = await Promise.all(
    Array.from(
      { length: indexedLength(policyCount, "policy count") },
      (_, index) => facility.policyIdAt(index, overrides),
    ),
  );
  const policyEffects = await Promise.all(
    policyIds.map(async (policyId) => {
      const [effect, evidenceExpiry, exists] = await facility.policyEffectOf(
        policyId,
        overrides,
      );
      return { policyId, effect, evidenceExpiry, exists };
    }),
  );
  await assertSnapshot(snapshot);
  return {
    address: getAddress(address),
    blockTag,
    asset,
    kernel,
    lender,
    borrower,
    facilityLimit,
    bondRequired,
    initialDrawFeeBps,
    maturityBlock,
    drawDelayBlocks,
    status,
    policyOutcome,
    creditLimitBps,
    futureDrawFeeBps,
    evidenceValidUntil,
    freshEvidenceRequired,
    lenderDrawPaused,
    borrowerDrawPaused,
    incidentPaused: lenderDrawPaused || borrowerDrawPaused,
    lenderFunded,
    bondPosted,
    drawnPrincipal,
    outstandingDebt,
    pendingDrawAmount,
    drawReadyAtBlock,
    lenderClaimable,
    borrowerClaimable,
    availableCredit,
    policyEffects,
  };
}

export async function readFacilityFactory(address, runner, options = {}) {
  const factory = contract(address, recourseFacilityFactoryV2Abi, runner);
  const snapshot = await beginSnapshot(runner, options.blockTag);
  const { blockTag } = snapshot;
  const overrides = { blockTag };
  const [guardian, creationPaused, facilityCount] = await Promise.all([
    factory.guardian(overrides),
    factory.creationPaused(overrides),
    factory.facilityCount(overrides),
  ]);
  const facilities = await Promise.all(
    Array.from(
      { length: indexedLength(facilityCount, "facility count") },
      (_, index) => factory.facilityAt(index, overrides),
    ),
  );
  await assertSnapshot(snapshot);
  return {
    address: getAddress(address),
    blockTag,
    guardian,
    creationPaused,
    facilities,
  };
}

export async function readCreditState(
  address,
  runner,
  facilityAddress,
  borrowerAddress,
  kind,
  options = {},
) {
  const state = contract(address, verifiedCreditStateV1Abi, runner);
  const snapshot = await beginSnapshot(runner, options.blockTag);
  const { blockTag } = snapshot;
  const overrides = { blockTag };
  const facility = getAddress(facilityAddress);
  const borrower = getAddress(borrowerAddress);
  const [kernel, count] = await Promise.all([
    state.kernel(overrides),
    state.observationCount(facility, borrower, overrides),
  ]);
  const observations = await Promise.all(
    Array.from(
      { length: indexedLength(count, "observation count") },
      async (_, observationId) => {
        const [policyId, observation] = await state.observationAt(
          facility,
          borrower,
          observationId,
          overrides,
        );
        return { observationId: BigInt(observationId), policyId, observation };
      },
    ),
  );
  let latest;
  if (kind !== undefined) {
    const [[exists, policyId, observation], fresh] = await Promise.all([
      state.latestObservation(facility, borrower, kind, overrides),
      state.isFresh(facility, borrower, kind, overrides),
    ]);
    latest = { exists, policyId, observation, fresh };
  }
  await assertSnapshot(snapshot);
  return {
    address: getAddress(address),
    blockTag,
    kernel,
    facility,
    borrower,
    observations,
    latest,
  };
}

export async function readProofJob(address, runner, jobId, options = {}) {
  const jobs = contract(address, proofJobsV1Abi, runner);
  const snapshot = await beginSnapshot(runner, options.blockTag);
  const { blockTag } = snapshot;
  const overrides = { blockTag };
  const [kernel, job] = await Promise.all([
    jobs.kernel(overrides),
    jobs.getJob(jobId, overrides),
  ]);
  const result = {
    address: getAddress(address),
    blockTag,
    kernel,
    jobId: BigInt(jobId),
    job,
  };
  if (options.hunter !== undefined) {
    result.hunter = getAddress(options.hunter);
    result.commitment = await jobs.getCommitment(
      jobId,
      result.hunter,
      overrides,
    );
  }
  if (options.evidenceDigest !== undefined) {
    result.evidenceReservedBy = await jobs.evidenceReservedBy(
      jobId,
      options.evidenceDigest,
      overrides,
    );
  }
  if (options.claimableAccount !== undefined) {
    result.claimable = await jobs.claimable(
      job.token,
      getAddress(options.claimableAccount),
      overrides,
    );
  }
  await assertSnapshot(snapshot);
  return result;
}

export async function readPolicyRegistration(
  address,
  runner,
  facility,
  policyId,
  options = {},
) {
  const kernel = contract(address, policyKernelV1Abi, runner);
  const snapshot = await beginSnapshot(runner, options.blockTag);
  const { blockTag } = snapshot;
  const overrides = { blockTag };
  const [registration, policySetCommitment, latestSourcePosition] =
    await Promise.all([
      kernel.policyOf(facility, policyId, overrides),
      kernel.policySetCommitment(facility, overrides),
      kernel.latestSourcePosition(facility, policyId, overrides),
    ]);
  await assertSnapshot(snapshot);
  return {
    address: getAddress(address),
    blockTag,
    facility: getAddress(facility),
    policyId: BigInt(policyId),
    evaluator: registration.evaluator,
    configHash: registration.configHash,
    manifest: registration.manifestBytes,
    policySetCommitment,
    latestSourcePosition: {
      recorded: latestSourcePosition.recorded,
      blockHeight: latestSourcePosition.blockHeight,
      transactionIndex: latestSourcePosition.transactionIndex,
    },
  };
}

export async function readPolicyRegistryRelease(
  address,
  runner,
  releaseId,
  options = {},
) {
  const registry = contract(address, policyRegistryV1Abi, runner);
  const snapshot = await beginSnapshot(runner, options.blockTag);
  const { blockTag } = snapshot;
  const overrides = { blockTag };
  const [
    release,
    evidenceKindCount,
    actionAdapterCount,
    runtimeVariantCount,
    deploymentCount,
  ] = await Promise.all([
    registry.packageRelease(releaseId, overrides),
    registry.evidenceKindCount(releaseId, overrides),
    registry.actionAdapterCount(releaseId, overrides),
    registry.runtimeVariantCount(releaseId, overrides),
    registry.deploymentCount(releaseId, overrides),
  ]);
  const [evidenceKinds, actionAdapters, runtimeVariantIds, deploymentIds] =
    await Promise.all([
      Promise.all(
        Array.from(
          { length: indexedLength(evidenceKindCount, "evidenceKindCount") },
          (_, index) => registry.evidenceKindAt(releaseId, index, overrides),
        ),
      ),
      Promise.all(
        Array.from(
          { length: indexedLength(actionAdapterCount, "actionAdapterCount") },
          (_, index) => registry.actionAdapterAt(releaseId, index, overrides),
        ),
      ),
      Promise.all(
        Array.from(
          { length: indexedLength(runtimeVariantCount, "runtimeVariantCount") },
          (_, index) => registry.runtimeVariantAt(releaseId, index, overrides),
        ),
      ),
      Promise.all(
        Array.from(
          { length: indexedLength(deploymentCount, "deploymentCount") },
          (_, index) => registry.deploymentAt(releaseId, index, overrides),
        ),
      ),
    ]);
  const [runtimeVariants, deployments] = await Promise.all([
    Promise.all(
      runtimeVariantIds.map(async (runtimeVariantId) => ({
        runtimeVariantId,
        variant: await registry.runtimeVariant(runtimeVariantId, overrides),
      })),
    ),
    Promise.all(
      deploymentIds.map(async (deploymentId) => ({
        deploymentId,
        deployment: await registry.deploymentRecord(deploymentId, overrides),
      })),
    ),
  ]);
  await assertSnapshot(snapshot);
  return {
    address: getAddress(address),
    blockTag,
    releaseId,
    release,
    evidenceKinds,
    actionAdapters,
    runtimeVariants,
    deployments,
  };
}

export async function readPolicyRegistryRuntimeVariant(
  address,
  runner,
  runtimeVariantId,
  options = {},
) {
  const registry = contract(address, policyRegistryV1Abi, runner);
  const snapshot = await beginSnapshot(runner, options.blockTag);
  const { blockTag } = snapshot;
  const overrides = { blockTag };
  const variant = await registry.runtimeVariant(runtimeVariantId, overrides);
  await assertSnapshot(snapshot);
  return {
    address: getAddress(address),
    blockTag,
    runtimeVariantId,
    variant,
  };
}

export async function readPolicyRegistryDeployment(
  address,
  runner,
  deploymentId,
  options = {},
) {
  const registry = contract(address, policyRegistryV1Abi, runner);
  const snapshot = await beginSnapshot(runner, options.blockTag);
  const { blockTag } = snapshot;
  const overrides = { blockTag };
  const deployment = await registry.deploymentRecord(deploymentId, overrides);
  await assertSnapshot(snapshot);
  return {
    address: getAddress(address),
    blockTag,
    deploymentId,
    deployment,
  };
}

export async function readPolicyRegistryAuditArtifact(
  address,
  runner,
  artifactId,
  options = {},
) {
  const registry = contract(address, policyRegistryV1Abi, runner);
  const snapshot = await beginSnapshot(runner, options.blockTag);
  const { blockTag } = snapshot;
  const overrides = { blockTag };
  const artifact = await registry.auditArtifact(artifactId, overrides);
  await assertSnapshot(snapshot);
  return {
    address: getAddress(address),
    blockTag,
    artifactId,
    artifact,
  };
}

export async function readPolicyRegistryAuditScope(
  address,
  runner,
  scope,
  scopeId,
  options = {},
) {
  const registry = contract(address, policyRegistryV1Abi, runner);
  const snapshot = await beginSnapshot(runner, options.blockTag);
  const { blockTag } = snapshot;
  const overrides = { blockTag };
  const [scopeHash, artifactCount] = await Promise.all([
    registry.auditScopeHash(scope, scopeId, overrides),
    registry.auditArtifactCount(scope, scopeId, overrides),
  ]);
  const artifactIds = await Promise.all(
    Array.from(
      { length: indexedLength(artifactCount, "auditArtifactCount") },
      (_, index) => registry.auditArtifactAt(scope, scopeId, index, overrides),
    ),
  );
  const artifacts = await Promise.all(
    artifactIds.map(async (artifactId) => ({
      artifactId,
      artifact: await registry.auditArtifact(artifactId, overrides),
    })),
  );
  await assertSnapshot(snapshot);
  return {
    address: getAddress(address),
    blockTag,
    scope,
    scopeId,
    scopeHash,
    artifacts,
  };
}
