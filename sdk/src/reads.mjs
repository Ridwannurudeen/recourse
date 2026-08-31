import { Contract, Interface, getAddress } from "ethers";
import {
  cappedPilotFactoryV1Abi,
  multiChainEventPolicyV1Abi,
  operatorMarketV1Abi,
  policyKernelV1Abi,
  policyKernelV2Abi,
  policyRegistryV1Abi,
  portfolioMandateV1Abi,
  portfolioPoolV1Abi,
  proofJobsV1Abi,
  recourseDemoUsdAbi,
  recourseFacilityFactoryV2Abi,
  recourseFacilityV2Abi,
  verifiedCreditStateV1Abi,
} from "./abis.mjs";

const MAX_UINT64 = (1n << 64n) - 1n;

function uint64(value, label, { positive = false } = {}) {
  if (
    (typeof value !== "bigint" &&
      typeof value !== "number" &&
      typeof value !== "string") ||
    (typeof value === "string" && value.trim() === "") ||
    (typeof value === "number" && !Number.isSafeInteger(value))
  ) {
    throw new TypeError(`Invalid ${label}`);
  }
  let result;
  try {
    result = BigInt(value);
  } catch {
    throw new TypeError(`Invalid ${label}`);
  }
  if (result < (positive ? 1n : 0n) || result > MAX_UINT64) {
    throw new RangeError(`Invalid ${label}`);
  }
  return result;
}

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

async function beginSnapshot(runner, requestedBlockTag, expectedHash) {
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
  const normalizedHash = block.hash.toLowerCase();
  if (
    expectedHash !== undefined &&
    (typeof expectedHash !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(expectedHash) ||
      normalizedHash !== expectedHash.toLowerCase())
  ) {
    throw new Error(
      `Block ${block.number} does not match the continuation hash`,
    );
  }
  return {
    provider,
    blockTag: block.number,
    expectedHash: normalizedHash,
  };
}

function continuation(value, nextField, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  if (!Number.isSafeInteger(value.blockNumber) || value.blockNumber < 0) {
    throw new TypeError(`Invalid ${label}.blockNumber`);
  }
  if (
    typeof value.blockHash !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(value.blockHash)
  ) {
    throw new TypeError(`Invalid ${label}.blockHash`);
  }
  if (!Number.isSafeInteger(value[nextField]) || value[nextField] < 0) {
    throw new TypeError(`Invalid ${label}.${nextField}`);
  }
  return value;
}

function portfolioPoolContinuation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid portfolio pool cursor");
  }
  if (!Number.isSafeInteger(value.blockNumber) || value.blockNumber < 0) {
    throw new TypeError("Invalid portfolio pool cursor.blockNumber");
  }
  if (
    typeof value.blockHash !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(value.blockHash)
  ) {
    throw new TypeError("Invalid portfolio pool cursor.blockHash");
  }
  for (const field of [
    "nextCreatedFacilityIndex",
    "nextCandidateIndex",
    "nextInvestorIndex",
  ]) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      throw new TypeError(`Invalid portfolio pool cursor.${field}`);
    }
  }
  return value;
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
  const cursor = options.cursor;
  if (cursor !== undefined) {
    continuation(cursor, "runtimeNextIndex", "release cursor");
    if (
      !Number.isSafeInteger(cursor.deploymentNextIndex) ||
      cursor.deploymentNextIndex < 0
    ) {
      throw new TypeError("Invalid release cursor.deploymentNextIndex");
    }
    if (options.blockTag !== undefined) {
      throw new TypeError("A release cursor cannot be combined with blockTag");
    }
  }
  const detailLimit = options.detailLimit ?? 25;
  if (
    !Number.isSafeInteger(detailLimit) ||
    detailLimit < 1 ||
    detailLimit > 100
  ) {
    throw new TypeError("Invalid detailLimit");
  }
  const snapshot = await beginSnapshot(
    runner,
    cursor?.blockNumber ?? options.blockTag,
    cursor?.blockHash,
  );
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
  const totalRuntimeVariants = indexedLength(
    runtimeVariantCount,
    "runtimeVariantCount",
  );
  const totalDeployments = indexedLength(deploymentCount, "deploymentCount");
  const runtimeStart = cursor?.runtimeNextIndex ?? 0;
  const deploymentStart = cursor?.deploymentNextIndex ?? 0;
  const runtimeEnd = Math.min(totalRuntimeVariants, runtimeStart + detailLimit);
  const deploymentEnd = Math.min(
    totalDeployments,
    deploymentStart + detailLimit,
  );
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
          { length: Math.max(0, runtimeEnd - runtimeStart) },
          (_, offset) =>
            registry.runtimeVariantAt(
              releaseId,
              runtimeStart + offset,
              overrides,
            ),
        ),
      ),
      Promise.all(
        Array.from(
          { length: Math.max(0, deploymentEnd - deploymentStart) },
          (_, offset) =>
            registry.deploymentAt(
              releaseId,
              deploymentStart + offset,
              overrides,
            ),
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
    blockHash: snapshot.expectedHash,
    releaseId,
    release,
    evidenceKinds,
    actionAdapters,
    runtimeVariants,
    deployments,
    runtimeVariantTotalCount: totalRuntimeVariants,
    deploymentTotalCount: totalDeployments,
    nextCursor:
      runtimeEnd < totalRuntimeVariants || deploymentEnd < totalDeployments
        ? {
            blockNumber: blockTag,
            blockHash: snapshot.expectedHash,
            runtimeNextIndex: runtimeEnd,
            deploymentNextIndex: deploymentEnd,
          }
        : null,
  };
}

export async function readPolicyRegistryCatalog(address, runner, options = {}) {
  const registry = contract(address, policyRegistryV1Abi, runner);
  const cursor =
    options.cursor === undefined
      ? undefined
      : continuation(options.cursor, "nextIndex", "catalog cursor");
  if (
    cursor &&
    (options.blockTag !== undefined || options.start !== undefined)
  ) {
    throw new TypeError(
      "A catalog cursor cannot be combined with blockTag or start",
    );
  }
  if (!cursor && options.start !== undefined && options.start !== 0) {
    throw new TypeError(
      "A nonzero catalog start requires a continuation cursor",
    );
  }
  const snapshot = await beginSnapshot(
    runner,
    cursor?.blockNumber ?? options.blockTag,
    cursor?.blockHash,
  );
  const { blockTag } = snapshot;
  const overrides = { blockTag };
  const count = await registry.releaseCount(overrides);
  const totalCount = indexedLength(count, "release count");
  const start = cursor?.nextIndex ?? options.start ?? 0;
  const limit = options.limit ?? 25;
  if (!Number.isSafeInteger(start) || start < 0) {
    throw new TypeError("Invalid catalog start");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("Invalid catalog limit");
  }
  const end = Math.min(totalCount, start + limit);
  const releaseIds = await Promise.all(
    Array.from({ length: Math.max(0, end - start) }, (_, offset) =>
      registry.releaseAt(start + offset, overrides),
    ),
  );
  const releases = await Promise.all(
    releaseIds.map(async (releaseId) => ({
      releaseId,
      release: await registry.packageRelease(releaseId, overrides),
    })),
  );
  await assertSnapshot(snapshot);
  return {
    address: getAddress(address),
    blockTag,
    blockHash: snapshot.expectedHash,
    totalCount,
    start,
    nextIndex: end < totalCount ? end : null,
    nextCursor:
      end < totalCount
        ? {
            blockNumber: blockTag,
            blockHash: snapshot.expectedHash,
            nextIndex: end,
          }
        : null,
    truncated: end < totalCount,
    releases,
  };
}

export async function readFacilityPolicyCatalog(
  address,
  runner,
  facilityAddress,
  options = {},
) {
  const cursor =
    options.cursor === undefined
      ? undefined
      : continuation(options.cursor, "nextBlock", "policy catalog cursor");
  if (cursor !== undefined) {
    if (
      !Number.isSafeInteger(cursor.originalFromBlock) ||
      cursor.originalFromBlock < 0 ||
      cursor.nextBlock < cursor.originalFromBlock
    ) {
      throw new TypeError("Invalid policy catalog cursor.originalFromBlock");
    }
    if (options.blockTag !== undefined || options.fromBlock !== undefined) {
      throw new TypeError(
        "A policy catalog cursor cannot be combined with blockTag or fromBlock",
      );
    }
  }
  const snapshot = await beginSnapshot(
    runner,
    cursor?.blockNumber ?? options.blockTag,
    cursor?.blockHash,
  );
  const { blockTag, provider } = snapshot;
  if (typeof provider.getLogs !== "function") {
    throw new TypeError("A provider with getLogs is required");
  }
  const fromBlock = cursor?.nextBlock ?? options.fromBlock;
  const originalFromBlock = cursor?.originalFromBlock ?? fromBlock;
  const pageSize = options.pageSize ?? 2_000;
  const maxPages = options.maxPages ?? 25;
  if (!Number.isSafeInteger(fromBlock) || fromBlock < 0) {
    throw new TypeError("A non-negative fromBlock is required");
  }
  if (originalFromBlock > blockTag || fromBlock > blockTag + 1) {
    throw new TypeError("Policy catalog range starts after its snapshot block");
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100_000) {
    throw new TypeError("Invalid pageSize");
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) {
    throw new TypeError("Invalid maxPages");
  }

  const kernelAddress = getAddress(address);
  const facility = getAddress(facilityAddress);
  const iface = new Interface(policyKernelV1Abi);
  const event = iface.getEvent("PolicyRegistered");
  const topics = iface.encodeFilterTopics(event, [facility]);
  const logs = [];
  let scannedToBlock = fromBlock - 1;
  let pages = 0;
  for (
    let pageStart = fromBlock;
    pageStart <= blockTag && pages < maxPages;
    pageStart += pageSize
  ) {
    const pageEnd = Math.min(blockTag, pageStart + pageSize - 1);
    logs.push(
      ...(await provider.getLogs({
        address: kernelAddress,
        topics,
        fromBlock: pageStart,
        toBlock: pageEnd,
      })),
    );
    scannedToBlock = pageEnd;
    pages += 1;
  }
  logs.sort((left, right) => {
    if (left.blockNumber !== right.blockNumber) {
      return left.blockNumber - right.blockNumber;
    }
    if (left.transactionIndex !== right.transactionIndex) {
      return left.transactionIndex - right.transactionIndex;
    }
    return left.index - right.index;
  });

  const kernel = contract(address, policyKernelV1Abi, runner);
  const seen = new Set();
  const registrations = [];
  for (const log of logs) {
    const parsed = iface.parseLog(log);
    if (parsed === null) continue;
    const policyId = parsed.args.policyId;
    const key = policyId.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    const current = await kernel.policyOf(facility, policyId, { blockTag });
    if (
      current.evaluator.toLowerCase() !== parsed.args.evaluator.toLowerCase() ||
      current.configHash.toLowerCase() !==
        parsed.args.configHash.toLowerCase() ||
      current.manifestBytes.toLowerCase() !== parsed.args.manifest.toLowerCase()
    ) {
      throw new Error(`Policy ${key} registration does not match pinned state`);
    }
    registrations.push({
      policyId,
      evaluator: current.evaluator,
      configHash: current.configHash,
      manifest: current.manifestBytes,
      blockNumber: log.blockNumber,
      transactionIndex: log.transactionIndex,
      logIndex: log.index,
      transactionHash: log.transactionHash,
    });
  }
  await assertSnapshot(snapshot);
  return {
    address: kernelAddress,
    blockTag,
    blockHash: snapshot.expectedHash,
    facility,
    fromBlock,
    originalFromBlock,
    scannedToBlock: Math.min(blockTag, Math.max(fromBlock - 1, scannedToBlock)),
    nextBlock:
      scannedToBlock < blockTag
        ? Math.max(fromBlock, scannedToBlock + 1)
        : null,
    historyComplete: scannedToBlock >= blockTag || fromBlock > blockTag,
    nextCursor:
      scannedToBlock < blockTag
        ? {
            blockNumber: blockTag,
            blockHash: snapshot.expectedHash,
            originalFromBlock,
            nextBlock: Math.max(fromBlock, scannedToBlock + 1),
          }
        : null,
    registrations,
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
  const cursor =
    options.cursor === undefined
      ? undefined
      : continuation(options.cursor, "nextIndex", "audit cursor");
  if (cursor && options.blockTag !== undefined) {
    throw new TypeError("An audit cursor cannot be combined with blockTag");
  }
  const limit = options.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("Invalid audit limit");
  }
  const snapshot = await beginSnapshot(
    runner,
    cursor?.blockNumber ?? options.blockTag,
    cursor?.blockHash,
  );
  const { blockTag } = snapshot;
  const overrides = { blockTag };
  const [scopeHash, artifactCount] = await Promise.all([
    registry.auditScopeHash(scope, scopeId, overrides),
    registry.auditArtifactCount(scope, scopeId, overrides),
  ]);
  const totalCount = indexedLength(artifactCount, "auditArtifactCount");
  const start = cursor?.nextIndex ?? 0;
  const end = Math.min(totalCount, start + limit);
  const artifactIds = await Promise.all(
    Array.from({ length: Math.max(0, end - start) }, (_, offset) =>
      registry.auditArtifactAt(scope, scopeId, start + offset, overrides),
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
    blockHash: snapshot.expectedHash,
    scope,
    scopeId,
    scopeHash,
    totalCount,
    start,
    nextCursor:
      end < totalCount
        ? {
            blockNumber: blockTag,
            blockHash: snapshot.expectedHash,
            nextIndex: end,
          }
        : null,
    artifacts,
  };
}

export async function readCappedPilotFactory(address, runner, options = {}) {
  const factory = contract(address, cappedPilotFactoryV1Abi, runner);
  const cursor =
    options.cursor === undefined
      ? undefined
      : continuation(options.cursor, "nextIndex", "factory cursor");
  if (cursor && options.blockTag !== undefined) {
    throw new TypeError("A factory cursor cannot be combined with blockTag");
  }
  const limit = options.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("Invalid factory limit");
  }
  const snapshot = await beginSnapshot(
    runner,
    cursor?.blockNumber ?? options.blockTag,
    cursor?.blockHash,
  );
  const { blockTag } = snapshot;
  const overrides = { blockTag };
  const [
    asset,
    kernel,
    lender,
    borrower,
    guardian,
    maximumFacilityLimit,
    maximumTotalLimit,
    minimumBondBps,
    maximumDrawFeeBps,
    maximumMaturityBlocks,
    maximumDrawDelayBlocks,
    maximumFacilityCount,
    creationPaused,
    totalFacilityLimit,
    facilityCount,
  ] = await Promise.all([
    factory.asset(overrides),
    factory.kernel(overrides),
    factory.lender(overrides),
    factory.borrower(overrides),
    factory.guardian(overrides),
    factory.maximumFacilityLimit(overrides),
    factory.maximumTotalLimit(overrides),
    factory.minimumBondBps(overrides),
    factory.maximumDrawFeeBps(overrides),
    factory.maximumMaturityBlocks(overrides),
    factory.maximumDrawDelayBlocks(overrides),
    factory.maximumFacilityCount(overrides),
    factory.creationPaused(overrides),
    factory.totalFacilityLimit(overrides),
    factory.facilityCount(overrides),
  ]);
  const totalCount = indexedLength(facilityCount, "facility count");
  const start = cursor?.nextIndex ?? 0;
  const end = Math.min(totalCount, start + limit);
  const facilities = await Promise.all(
    Array.from({ length: Math.max(0, end - start) }, (_, offset) =>
      factory.facilityAt(start + offset, overrides),
    ),
  );
  await assertSnapshot(snapshot);
  return {
    address: getAddress(address),
    blockTag,
    blockHash: snapshot.expectedHash,
    asset,
    kernel,
    lender,
    borrower,
    guardian,
    maximumFacilityLimit,
    maximumTotalLimit,
    minimumBondBps,
    maximumDrawFeeBps,
    maximumMaturityBlocks,
    maximumDrawDelayBlocks,
    maximumFacilityCount,
    creationPaused,
    totalFacilityLimit,
    totalCount,
    start,
    facilities,
    nextCursor:
      end < totalCount
        ? {
            blockNumber: blockTag,
            blockHash: snapshot.expectedHash,
            nextIndex: end,
          }
        : null,
  };
}

export async function readPolicyKernelV2(address, runner, options = {}) {
  const kernel = contract(address, policyKernelV2Abi, runner);
  const snapshot = await beginSnapshot(runner, options.blockTag);
  const { blockTag } = snapshot;
  const overrides = { blockTag };
  const [verifier, creditState, owner, proofJobs, safeStaleProofRelease] =
    await Promise.all([
      kernel.verifier(overrides),
      kernel.creditState(overrides),
      kernel.owner(overrides),
      kernel.proofJobs(overrides),
      kernel.safeStaleProofRelease(overrides),
    ]);
  await assertSnapshot(snapshot);
  return {
    address: getAddress(address),
    blockTag,
    blockHash: snapshot.expectedHash,
    verifier,
    creditState,
    owner,
    proofJobs,
    safeStaleProofRelease,
  };
}

export async function readPolicyRegistrationV2(
  address,
  runner,
  facilityAddress,
  policyId,
  chainKeys = [],
  options = {},
) {
  if (!Array.isArray(chainKeys) || chainKeys.length > 32) {
    throw new TypeError("Invalid chainKeys");
  }
  const normalizedChainKeys = chainKeys.map((chainKey, index) =>
    uint64(chainKey, `chainKeys[${index}]`, { positive: true }),
  );
  if (
    new Set(normalizedChainKeys.map((chainKey) => chainKey.toString())).size !==
    normalizedChainKeys.length
  ) {
    throw new TypeError("Duplicate chainKeys");
  }
  const kernel = contract(address, policyKernelV2Abi, runner);
  const snapshot = await beginSnapshot(runner, options.blockTag);
  const { blockTag } = snapshot;
  const overrides = { blockTag };
  const facility = getAddress(facilityAddress);
  const [
    registered,
    registration,
    policySetCommitment,
    sourceOrdering,
    sourcePositions,
  ] = await Promise.all([
    kernel.isPolicyRegistered(facility, policyId, overrides),
    kernel.policyOf(facility, policyId, overrides),
    kernel.policySetCommitment(facility, overrides),
    kernel.sourceOrderingOf(facility, policyId, overrides),
    Promise.all(
      normalizedChainKeys.map(async (chainKey) => {
        const position = await kernel.latestSourcePosition(
          facility,
          policyId,
          chainKey,
          overrides,
        );
        return {
          chainKey,
          recorded: position.recorded,
          blockHeight: position.blockHeight,
          transactionIndex: position.transactionIndex,
        };
      }),
    ),
  ]);
  await assertSnapshot(snapshot);
  return {
    address: getAddress(address),
    blockTag,
    blockHash: snapshot.expectedHash,
    facility,
    policyId: BigInt(policyId),
    registered,
    evaluator: registration.evaluator,
    configHash: registration.configHash,
    manifest: registration.manifestBytes,
    policySetCommitment,
    sourceOrdering,
    sourcePositions,
  };
}

export async function readMultiChainPolicy(
  address,
  runner,
  facilityAddress,
  policyId,
  options = {},
) {
  const policy = contract(address, multiChainEventPolicyV1Abi, runner);
  const snapshot = await beginSnapshot(runner, options.blockTag);
  const { blockTag } = snapshot;
  const overrides = { blockTag };
  const facility = getAddress(facilityAddress);
  const [
    context,
    maximumRules,
    policyKind,
    sourceOrdering,
    configured,
    configHash,
    manifest,
    riskScore,
  ] = await Promise.all([
    policy.context(overrides),
    policy.MAXIMUM_RULES(overrides),
    policy.policyKind(overrides),
    policy.sourceOrdering(overrides),
    policy.isConfigured(facility, policyId, overrides),
    policy.configHash(facility, policyId, overrides),
    policy.manifest(facility, policyId, overrides),
    policy.riskScore(facility, policyId, overrides),
  ]);
  const configuration = configured
    ? await policy.configurationOf(facility, policyId, overrides)
    : undefined;
  await assertSnapshot(snapshot);
  return {
    address: getAddress(address),
    blockTag,
    blockHash: snapshot.expectedHash,
    facility,
    policyId: BigInt(policyId),
    context,
    maximumRules,
    policyKind,
    sourceOrdering,
    configured,
    configHash,
    manifest,
    riskScore,
    configuration,
  };
}

export async function readOperatorMarket(address, runner, options = {}) {
  const market = contract(address, operatorMarketV1Abi, runner);
  const cursor =
    options.cursor === undefined
      ? undefined
      : continuation(options.cursor, "nextIndex", "operator market cursor");
  if (cursor && options.blockTag !== undefined) {
    throw new TypeError(
      "An operator market cursor cannot be combined with blockTag",
    );
  }
  const limit = options.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("Invalid operator market limit");
  }
  const claimableAccounts = options.claimableAccounts ?? [];
  if (!Array.isArray(claimableAccounts) || claimableAccounts.length > 100) {
    throw new TypeError("Invalid claimableAccounts");
  }
  const accounts = claimableAccounts.map((account) => getAddress(account));
  if (new Set(accounts).size !== accounts.length) {
    throw new TypeError("Duplicate claimableAccounts");
  }
  const snapshot = await beginSnapshot(
    runner,
    cursor?.blockNumber ?? options.blockTag,
    cursor?.blockHash,
  );
  const { blockTag } = snapshot;
  const overrides = { blockTag };
  const [
    token,
    verifier,
    minimumOperatorBond,
    maximumQuoteDuration,
    maximumServiceDuration,
    quoteCount,
  ] = await Promise.all([
    market.token(overrides),
    market.verifier(overrides),
    market.minimumOperatorBond(overrides),
    market.maximumQuoteDuration(overrides),
    market.maximumServiceDuration(overrides),
    market.quoteCount(overrides),
  ]);
  const quoteTotalCount = indexedLength(quoteCount, "quote count");
  const start = cursor?.nextIndex ?? 0;
  const end = Math.min(quoteTotalCount, start + limit);
  const [quotes, claimable] = await Promise.all([
    Promise.all(
      Array.from({ length: Math.max(0, end - start) }, async (_, offset) => {
        const quoteId = start + offset;
        return {
          quoteId: BigInt(quoteId),
          quote: await market.quoteAt(quoteId, overrides),
        };
      }),
    ),
    Promise.all(
      accounts.map(async (account) => ({
        account,
        amount: await market.claimable(account, overrides),
      })),
    ),
  ]);
  await assertSnapshot(snapshot);
  return {
    address: getAddress(address),
    blockTag,
    blockHash: snapshot.expectedHash,
    token,
    verifier,
    minimumOperatorBond,
    maximumQuoteDuration,
    maximumServiceDuration,
    quoteTotalCount,
    start,
    quotes,
    claimable,
    nextCursor:
      end < quoteTotalCount
        ? {
            blockNumber: blockTag,
            blockHash: snapshot.expectedHash,
            nextIndex: end,
          }
        : null,
  };
}

export async function readPortfolioMandate(address, runner, options = {}) {
  if (
    (options.facility === undefined) !==
    (options.deploymentId === undefined)
  ) {
    throw new TypeError("facility and deploymentId must be supplied together");
  }
  const mandate = contract(address, portfolioMandateV1Abi, runner);
  const snapshot = await beginSnapshot(runner, options.blockTag);
  const { blockTag } = snapshot;
  const overrides = { blockTag };
  const [
    factory,
    registry,
    asset,
    kernel,
    requiredReleaseId,
    requiredPolicySetCommitment,
    requiredEvidenceKind,
    requiredActionAdapterKind,
    maximumFacilityLimit,
    minimumBondBps,
    maximumDrawFeeBps,
    maximumRemainingMaturityBlocks,
  ] = await Promise.all([
    mandate.factory(overrides),
    mandate.registry(overrides),
    mandate.asset(overrides),
    mandate.kernel(overrides),
    mandate.requiredReleaseId(overrides),
    mandate.requiredPolicySetCommitment(overrides),
    mandate.requiredEvidenceKind(overrides),
    mandate.requiredActionAdapterKind(overrides),
    mandate.maximumFacilityLimit(overrides),
    mandate.minimumBondBps(overrides),
    mandate.maximumDrawFeeBps(overrides),
    mandate.maximumRemainingMaturityBlocks(overrides),
  ]);
  const eligibilityCode =
    options.facility === undefined
      ? undefined
      : await mandate.evaluate(
          getAddress(options.facility),
          options.deploymentId,
          overrides,
        );
  await assertSnapshot(snapshot);
  return {
    address: getAddress(address),
    blockTag,
    blockHash: snapshot.expectedHash,
    factory,
    registry,
    asset,
    kernel,
    requiredReleaseId,
    requiredPolicySetCommitment,
    requiredEvidenceKind,
    requiredActionAdapterKind,
    maximumFacilityLimit,
    minimumBondBps,
    maximumDrawFeeBps,
    maximumRemainingMaturityBlocks,
    facility:
      options.facility === undefined ? undefined : getAddress(options.facility),
    deploymentId: options.deploymentId,
    eligibilityCode,
  };
}

export async function readPortfolioPool(address, runner, options = {}) {
  const pool = contract(address, portfolioPoolV1Abi, runner);
  const cursor =
    options.cursor === undefined
      ? undefined
      : portfolioPoolContinuation(options.cursor);
  if (cursor && options.blockTag !== undefined) {
    throw new TypeError(
      "A portfolio pool cursor cannot be combined with blockTag",
    );
  }
  const detailLimit = options.detailLimit ?? 25;
  if (
    !Number.isSafeInteger(detailLimit) ||
    detailLimit < 1 ||
    detailLimit > 100
  ) {
    throw new TypeError("Invalid portfolio pool detailLimit");
  }
  const snapshot = await beginSnapshot(
    runner,
    cursor?.blockNumber ?? options.blockTag,
    cursor?.blockHash,
  );
  const { blockTag } = snapshot;
  const overrides = { blockTag };
  const asset = await pool.asset(overrides);
  const assetContract = contract(asset, recourseDemoUsdAbi, runner);
  const [
    maximumInvestors,
    manager,
    maximumPoolAssets,
    maximumServiceBudget,
    maximumServiceJobDuration,
    maximumFacilityCount,
    fundingDeadline,
    recoveryDelayBlocks,
    mandate,
    proofJobsVenue,
    status,
    totalDeposited,
    totalAllocatedPrincipal,
    totalRecovered,
    totalRealizedLoss,
    totalServiceEscrowed,
    totalServiceRecovered,
    allocatedFacilityCount,
    settledFacilityCount,
    totalDistributed,
    totalClaimed,
    name,
    symbol,
    decimals,
    totalSupply,
    createdFacilityCount,
    candidateCount,
    investorCount,
    assetBalance,
  ] = await Promise.all([
    pool.MAXIMUM_INVESTORS(overrides),
    pool.manager(overrides),
    pool.maximumPoolAssets(overrides),
    pool.maximumServiceBudget(overrides),
    pool.maximumServiceJobDuration(overrides),
    pool.maximumFacilityCount(overrides),
    pool.fundingDeadline(overrides),
    pool.recoveryDelayBlocks(overrides),
    pool.mandate(overrides),
    pool.proofJobsVenue(overrides),
    pool.status(overrides),
    pool.totalDeposited(overrides),
    pool.totalAllocatedPrincipal(overrides),
    pool.totalRecovered(overrides),
    pool.totalRealizedLoss(overrides),
    pool.totalServiceEscrowed(overrides),
    pool.totalServiceRecovered(overrides),
    pool.allocatedFacilityCount(overrides),
    pool.settledFacilityCount(overrides),
    pool.totalDistributed(overrides),
    pool.totalClaimed(overrides),
    pool.name(overrides),
    pool.symbol(overrides),
    pool.decimals(overrides),
    pool.totalSupply(overrides),
    pool.createdFacilityCount(overrides),
    pool.candidateCount(overrides),
    pool.investorCount(overrides),
    assetContract.balanceOf(getAddress(address), overrides),
  ]);
  const createdFacilityTotalCount = indexedLength(
    createdFacilityCount,
    "created facility count",
  );
  const candidateTotalCount = indexedLength(candidateCount, "candidate count");
  const investorTotalCount = indexedLength(investorCount, "investor count");
  const createdFacilityStart = cursor?.nextCreatedFacilityIndex ?? 0;
  const candidateStart = cursor?.nextCandidateIndex ?? 0;
  const investorStart = cursor?.nextInvestorIndex ?? 0;
  if (
    createdFacilityStart > createdFacilityTotalCount ||
    candidateStart > candidateTotalCount ||
    investorStart > investorTotalCount
  ) {
    throw new RangeError("Portfolio pool cursor exceeds snapshot counts");
  }
  const createdFacilityEnd = Math.min(
    createdFacilityTotalCount,
    createdFacilityStart + detailLimit,
  );
  const candidateEnd = Math.min(
    candidateTotalCount,
    candidateStart + detailLimit,
  );
  const investorEnd = Math.min(investorTotalCount, investorStart + detailLimit);
  const [createdFacilities, candidates, investors] = await Promise.all([
    Promise.all(
      Array.from(
        {
          length: createdFacilityEnd - createdFacilityStart,
        },
        (_, offset) =>
          pool.createdFacilityAt(createdFacilityStart + offset, overrides),
      ),
    ),
    Promise.all(
      Array.from(
        { length: candidateEnd - candidateStart },
        async (_, offset) => {
          const facility = await pool.candidateAt(
            candidateStart + offset,
            overrides,
          );
          const allocation = await pool.allocationOf(facility, overrides);
          return {
            facility,
            allocation: {
              deploymentId: allocation.deploymentId,
              principal: allocation.principal,
              recovered: allocation.recovered,
              realizedLoss: allocation.realizedLoss,
              registered: allocation.registered,
              settled: allocation.settled,
            },
          };
        },
      ),
    ),
    Promise.all(
      Array.from({ length: investorEnd - investorStart }, async (_, offset) => {
        const account = await pool.investorAt(
          investorStart + offset,
          overrides,
        );
        const [shares, claimable, claimedAssets] = await Promise.all([
          pool.balanceOf(account, overrides),
          pool.claimable(account, overrides),
          pool.claimedAssets(account, overrides),
        ]);
        return { account, shares, claimable, claimedAssets };
      }),
    ),
  ]);
  await assertSnapshot(snapshot);
  const hasMore =
    createdFacilityEnd < createdFacilityTotalCount ||
    candidateEnd < candidateTotalCount ||
    investorEnd < investorTotalCount;
  return {
    address: getAddress(address),
    blockTag,
    blockHash: snapshot.expectedHash,
    asset,
    assetBalance,
    maximumInvestors,
    manager,
    maximumPoolAssets,
    maximumServiceBudget,
    maximumServiceJobDuration,
    maximumFacilityCount,
    fundingDeadline,
    recoveryDelayBlocks,
    mandate,
    proofJobsVenue,
    status,
    totalDeposited,
    totalAllocatedPrincipal,
    totalRecovered,
    totalRealizedLoss,
    totalServiceEscrowed,
    totalServiceRecovered,
    allocatedFacilityCount,
    settledFacilityCount,
    totalDistributed,
    totalClaimed,
    name,
    symbol,
    decimals,
    totalSupply,
    createdFacilityTotalCount,
    candidateTotalCount,
    investorTotalCount,
    createdFacilityStart,
    candidateStart,
    investorStart,
    createdFacilities,
    candidates,
    investors,
    nextCursor: hasMore
      ? {
          blockNumber: blockTag,
          blockHash: snapshot.expectedHash,
          nextCreatedFacilityIndex: createdFacilityEnd,
          nextCandidateIndex: candidateEnd,
          nextInvestorIndex: investorEnd,
        }
      : null,
  };
}
