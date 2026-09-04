import "dotenv/config";
import {
  Contract,
  JsonRpcProvider,
  isHexString,
  solidityPackedKeccak256,
} from "ethers";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { discoverProofJobs, writeDiscoveryReport } from "./job-discovery.mjs";
import { assertMatchingLogSets } from "./job-discovery-core.mjs";
import { runHorizon1Job } from "./horizon1-runner.mjs";
import { runV3Job } from "./v3-runner.mjs";
import {
  V3_ACTIVATION_GENERATION,
  activationDiscoveryDeployments,
  assertV3OperatorBinding,
  multiRuleExecutionConfigurations,
} from "./v3-core.mjs";
import {
  acquireProcessLock,
  abortableDelay,
  atomicWriteJson,
  eventLogFilter,
  isMainModule,
  jobAllowed,
  nextBackoff,
  operatorStatus,
  qualifyReceipt,
  readJson,
  statePathForJob,
  validateOperatorConfig,
} from "./operator-core.mjs";
export { isMainModule as isOperatorMainModule } from "./operator-core.mjs";
import {
  getAttestedHeight,
  getSourceNetwork,
  getSourceProvider,
} from "../scripts/lib/proofs.mjs";

const DEFAULT_CONFIG_PATH = "daemon/operator-config.example.json";
const DEFAULT_DEPLOYMENT_PATH = "deployments-horizon1.json";
const DEFAULT_DATA_DIRECTORY = "daemon/operator-data";
const V3_STATE_NAMESPACE = "generation-activation-commitment-v1";
export const OPERATOR_LIMITS = Object.freeze({
  maxLogsPerCycle: 512,
  maxCandidatesPerJob: 256,
  maxRetainedHistory: 1_024,
});
const KERNEL_EXECUTION_ABI = [
  "function safeStaleProofRelease() view returns (bool)",
  "function isProcessed(address facility,uint256 policyId,bytes32 queryId) view returns (bool)",
  "function latestSourcePosition(address facility,uint256 policyId,uint64 chainKey) view returns (bool recorded,uint64 blockHeight,uint64 transactionIndex)",
  "function sourceOrderingOf(address facility,uint256 policyId) view returns (uint8)",
];
const STRICTLY_INCREASING_SOURCE_ORDERING = 0;
const UNIQUE_ONLY_SOURCE_ORDERING = 1;

function errorMessage(error) {
  return (
    error?.shortMessage || error?.reason || error?.message || String(error)
  );
}

function log(message) {
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

function policyKey(facility, policyId) {
  return `${facility.toLowerCase()}:${BigInt(policyId)}`;
}

function boundedTail(values) {
  return values.slice(-OPERATOR_LIMITS.maxRetainedHistory);
}

function executionPolicy(config) {
  return {
    targetConfirmations: config.targetConfirmations,
    recoveryBlocks: config.recoveryBlocks,
    blockTimeMs: config.blockTimeMs,
    minRevealWindowBlocks: config.minRevealWindowBlocks,
    minSecondsToExpiry: config.minSecondsToExpiry,
    maxCommitBond: config.maxCommitBond.toString(),
    minProofReimbursement: config.minProofReimbursement.toString(),
    minRewardToBondBps: config.minRewardToBondBps,
    feePolicy:
      config.feePolicy.transactionType === "eip1559"
        ? {
            transactionType: "eip1559",
            maximumGasLimit: config.feePolicy.maximumGasLimit.toString(),
            maximumNativeFee: config.feePolicy.maximumNativeFee.toString(),
            maximumFeePerGas: config.feePolicy.maximumFeePerGas.toString(),
            maximumPriorityFeePerGas:
              config.feePolicy.maximumPriorityFeePerGas.toString(),
          }
        : {
            transactionType: "legacy",
            maximumGasLimit: config.feePolicy.maximumGasLimit.toString(),
            maximumNativeFee: config.feePolicy.maximumNativeFee.toString(),
            maximumGasPrice: config.feePolicy.maximumGasPrice.toString(),
          },
    exclusiveSigner: config.exclusiveSigner,
  };
}

function rangeLimitError(error) {
  return /range|too many|more than|response size|result limit|query limit/i.test(
    error?.message || String(error),
  );
}

export async function verifySourceCursor(provider, state) {
  if (state?.lastScannedBlock === null || state?.lastScannedBlock === undefined)
    return;
  const block = await provider.getBlock(state.lastScannedBlock);
  if (
    !block ||
    block.hash.toLowerCase() !== state.lastScannedBlockHash.toLowerCase()
  ) {
    throw new Error(
      `Source cursor for job ${state.jobId} is no longer canonical at block ${state.lastScannedBlock}`,
    );
  }
}

export async function assertEthereumMainnetProvider(provider) {
  const network = await provider.getNetwork();
  if (network.chainId !== 1n) {
    throw new Error(
      `Refusing source chain ${network.chainId}; expected Ethereum mainnet chain 1`,
    );
  }
  return true;
}

export async function assertSourceProviderIdentity(
  provider,
  expectedEvmChainId,
  sourceChain,
) {
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(expectedEvmChainId)) {
    throw new Error(
      `Refusing EVM chain ${network.chainId} for source key ${sourceChain}; expected ${expectedEvmChainId}`,
    );
  }
  return true;
}

export function validateOperatorSourceNetworks(
  input,
  sourceChains,
  environment = process.env,
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Source network configuration must be an object");
  }
  const expected = [...sourceChains].sort(
    (left, right) => Number(left) - Number(right),
  );
  const supplied = Object.keys(input).sort(
    (left, right) => Number(left) - Number(right),
  );
  if (
    supplied.length !== expected.length ||
    supplied.some((chain, index) => chain !== expected[index])
  ) {
    throw new Error(
      "Source network configuration must exactly match the source-chain allowlist",
    );
  }
  return new Map(
    expected.map((chainKey) => {
      const expectedNetwork = getSourceNetwork(chainKey);
      const item = input[chainKey];
      const evmChainId = Number(item?.evmChainId);
      if (!Number.isSafeInteger(evmChainId) || evmChainId <= 0) {
        throw new Error(`Invalid EVM chain ID for source key ${chainKey}`);
      }
      const rpcUrlEnvironment = item?.rpcUrlEnvironment;
      if (
        typeof rpcUrlEnvironment !== "string" ||
        !/^[A-Z][A-Z0-9_]*$/.test(rpcUrlEnvironment)
      ) {
        throw new Error(`Invalid RPC environment for source key ${chainKey}`);
      }
      if (evmChainId !== expectedNetwork.evmChainId) {
        throw new Error(
          `CC3 source key ${chainKey} must bind to EVM chain ${expectedNetwork.evmChainId}`,
        );
      }
      if (rpcUrlEnvironment !== expectedNetwork.rpcUrlEnvironment) {
        throw new Error(
          `CC3 source key ${chainKey} must use ${expectedNetwork.rpcUrlEnvironment}`,
        );
      }
      const rpcUrl = environment[rpcUrlEnvironment];
      if (typeof rpcUrl !== "string" || rpcUrl.length === 0) {
        throw new Error(
          `${rpcUrlEnvironment} is required for source key ${chainKey}`,
        );
      }
      let parsed;
      try {
        parsed = new URL(rpcUrl);
      } catch {
        throw new Error(`Invalid RPC URL for source key ${chainKey}`);
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error(`Invalid RPC URL protocol for source key ${chainKey}`);
      }
      const secondaryRpcUrlEnvironment =
        item?.secondaryRpcUrlEnvironment ?? `${rpcUrlEnvironment}_SECONDARY`;
      if (!/^[A-Z][A-Z0-9_]*$/.test(secondaryRpcUrlEnvironment)) {
        throw new Error(
          `Invalid secondary RPC environment for source key ${chainKey}`,
        );
      }
      const secondaryRpcUrl = environment[secondaryRpcUrlEnvironment];
      if (secondaryRpcUrl !== undefined) {
        let secondaryParsed;
        try {
          secondaryParsed = new URL(secondaryRpcUrl);
        } catch {
          throw new Error(
            `Invalid secondary RPC URL for source key ${chainKey}`,
          );
        }
        if (
          (secondaryParsed.protocol !== "https:" &&
            secondaryParsed.protocol !== "http:") ||
          secondaryParsed.href === parsed.href
        ) {
          throw new Error(
            `Secondary RPC URL for source key ${chainKey} must be an independent HTTP endpoint`,
          );
        }
      }
      return [
        chainKey,
        {
          evmChainId,
          rpcUrlEnvironment,
          rpcUrl,
          secondaryRpcUrlEnvironment,
          secondaryRpcUrl,
        },
      ];
    }),
  );
}

export async function assertExecutionKernelCapability(
  provider,
  kernelAddress,
  kernelFactory = (address, abi, runner) => new Contract(address, abi, runner),
) {
  const kernel = kernelFactory(kernelAddress, KERNEL_EXECUTION_ABI, provider);
  let safe;
  try {
    safe = await kernel.safeStaleProofRelease();
  } catch {
    throw new Error(
      "Execution requires a kernel exposing safeStaleProofRelease()",
    );
  }
  if (safe !== true) {
    throw new Error("Kernel does not guarantee safe stale-proof bond release");
  }
  return kernel;
}

export async function scanJobEvidence({
  sourceProvider,
  secondarySourceProvider,
  job,
  policy,
  statePath,
  attestedHeight,
  maxSourceBlocks,
  expectedSourceChainId = 1,
}) {
  const grouped = policy.configurations !== undefined;
  const configurations = grouped
    ? policy.configurations
    : [policy.configuration];
  if (!Array.isArray(configurations) || configurations.length === 0) {
    throw new Error("Evidence policy must contain at least one configuration");
  }
  const sourceChain = BigInt(configurations[0].sourceChain).toString();
  const ruleIndexes = new Set();
  for (const configuration of configurations) {
    if (BigInt(configuration.sourceChain).toString() !== sourceChain) {
      throw new Error(
        "Evidence scan configurations must share one source chain",
      );
    }
    if (grouped) {
      const ruleIndex = Number(configuration.ruleIndex);
      if (
        !Number.isSafeInteger(ruleIndex) ||
        ruleIndex < 0 ||
        ruleIndexes.has(ruleIndex)
      ) {
        throw new Error("Evidence scan rule indexes must be unique integers");
      }
      ruleIndexes.add(ruleIndex);
    }
  }
  await assertSourceProviderIdentity(
    sourceProvider,
    expectedSourceChainId,
    sourceChain,
  );
  if (secondarySourceProvider) {
    await assertSourceProviderIdentity(
      secondarySourceProvider,
      expectedSourceChainId,
      sourceChain,
    );
  }
  const stored = existsSync(statePath) ? readJson(statePath) : undefined;
  if (stored) {
    if (
      stored.schemaVersion !== (grouped ? 2 : 1) ||
      stored.jobId !== job.jobId ||
      stored.facility.toLowerCase() !== job.facility.toLowerCase() ||
      stored.requirementsDigest.toLowerCase() !==
        job.requirementsDigest.toLowerCase() ||
      (grouped && stored.sourceChain !== sourceChain)
    ) {
      throw new Error(`Operator state mismatch for job ${job.jobId}`);
    }
    await verifySourceCursor(sourceProvider, stored);
  }
  const startWindow = Math.min(
    ...configurations.map(({ startSourceBlock }) => Number(startSourceBlock)),
  );
  const endWindow = Math.max(
    ...configurations.map(({ endSourceBlock }) => Number(endSourceBlock)),
  );
  const fromBlock = Math.max(
    stored?.nextSourceBlock ?? startWindow,
    startWindow,
  );
  const toBlock = Math.min(
    Number(attestedHeight),
    endWindow,
    fromBlock + maxSourceBlocks - 1,
  );
  const initialState = () => ({
    schemaVersion: grouped ? 2 : 1,
    jobId: job.jobId,
    facility: job.facility,
    policyId: job.policyId,
    requirementsDigest: job.requirementsDigest,
    ...(grouped ? { sourceChain } : {}),
    nextSourceBlock: fromBlock,
    lastScannedBlock: null,
    lastScannedBlockHash: null,
    candidates: [],
    completedTransactionHashes: [],
    skippedCandidates: [],
    incidents: [],
  });
  if (toBlock < fromBlock) {
    return {
      state: stored ?? initialState(),
      added: [],
    };
  }
  let state = stored ?? initialState();
  const added = [];
  let logCount = 0;

  async function scanRange(rangeStart, rangeEnd) {
    if (
      logCount >= OPERATOR_LIMITS.maxLogsPerCycle ||
      state.candidates.length >= OPERATOR_LIMITS.maxCandidatesPerJob
    ) {
      return false;
    }
    const initialAnchor = await sourceProvider.getBlock(rangeEnd);
    if (!initialAnchor)
      throw new Error(`Source block ${rangeEnd} is unavailable`);
    const queried = [];
    try {
      for (const configuration of configurations) {
        const queryStart = Math.max(
          rangeStart,
          Number(configuration.startSourceBlock),
        );
        const queryEnd = Math.min(
          rangeEnd,
          Number(configuration.endSourceBlock),
        );
        if (queryEnd < queryStart) continue;
        const filter = {
          ...eventLogFilter(configuration),
          fromBlock: queryStart,
          toBlock: queryEnd,
        };
        const [logs, secondaryLogs] = await Promise.all([
          sourceProvider.getLogs(filter),
          secondarySourceProvider?.getLogs(filter),
        ]);
        if (secondarySourceProvider) {
          assertMatchingLogSets(
            logs,
            secondaryLogs,
            `source key ${sourceChain} blocks ${queryStart}..${queryEnd}`,
          );
        }
        queried.push({ configuration, logs });
      }
    } catch (error) {
      if (rangeStart === rangeEnd || !rangeLimitError(error)) throw error;
      const midpoint = Math.floor((rangeStart + rangeEnd) / 2);
      const leftCompleted = await scanRange(rangeStart, midpoint);
      return leftCompleted ? scanRange(midpoint + 1, rangeEnd) : false;
    }
    const returnedLogs = queried.flatMap(({ logs: matches }) => matches);
    const logsByIdentity = new Map();
    for (const log of returnedLogs) {
      if (
        !isHexString(log.transactionHash, 32) ||
        !isHexString(log.blockHash, 32) ||
        !Number.isSafeInteger(log.blockNumber) ||
        log.blockNumber < rangeStart ||
        log.blockNumber > rangeEnd
      ) {
        throw new Error(
          "Canonical source log is missing transaction or block identity",
        );
      }
      const logIndex = Number.isSafeInteger(log.index)
        ? log.index
        : Number.isSafeInteger(log.logIndex)
          ? log.logIndex
          : null;
      const identity = JSON.stringify([
        log.blockHash.toLowerCase(),
        log.transactionHash.toLowerCase(),
        logIndex,
        log.address?.toLowerCase() ?? null,
        log.topics?.map((topic) => topic.toLowerCase()) ?? null,
        log.data?.toLowerCase() ?? null,
      ]);
      if (!logsByIdentity.has(identity)) logsByIdentity.set(identity, log);
    }
    const logs = [...logsByIdentity.values()];
    if (logCount + logs.length > OPERATOR_LIMITS.maxLogsPerCycle) {
      if (rangeStart === rangeEnd) {
        if (logs.length > OPERATOR_LIMITS.maxLogsPerCycle) {
          throw new Error("Source log limit exceeded for a single block");
        }
        return false;
      }
      const midpoint = Math.floor((rangeStart + rangeEnd) / 2);
      const leftCompleted = await scanRange(rangeStart, midpoint);
      return leftCompleted ? scanRange(midpoint + 1, rangeEnd) : false;
    }
    const hashes = [
      ...new Set(
        logs.map(({ transactionHash }) => transactionHash.toLowerCase()),
      ),
    ];
    const priorHashes = new Set([
      ...state.candidates.map(({ transactionHash }) => transactionHash),
      ...state.completedTransactionHashes,
    ]);
    const newHashes = hashes.filter((hash) => !priorHashes.has(hash));
    if (
      state.candidates.length + newHashes.length >
      OPERATOR_LIMITS.maxCandidatesPerJob
    ) {
      if (rangeStart === rangeEnd) {
        if (newHashes.length > OPERATOR_LIMITS.maxCandidatesPerJob) {
          throw new Error("Source candidate limit exceeded for a single block");
        }
        return false;
      }
      const midpoint = Math.floor((rangeStart + rangeEnd) / 2);
      const leftCompleted = await scanRange(rangeStart, midpoint);
      return leftCompleted ? scanRange(midpoint + 1, rangeEnd) : false;
    }
    const rangeAdded = [];
    for (const transactionHash of newHashes) {
      const receipt =
        await sourceProvider.getTransactionReceipt(transactionHash);
      const matchingLogs = logs.filter(
        (log) => log.transactionHash.toLowerCase() === transactionHash,
      );
      if (
        !receipt ||
        !receipt.hash ||
        receipt.hash.toLowerCase() !== transactionHash ||
        !receipt.blockHash ||
        matchingLogs.some(
          (log) =>
            log.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
            log.blockNumber !== receipt.blockNumber,
        )
      ) {
        throw new Error(
          `Receipt for canonical source log ${transactionHash} is missing or inconsistent`,
        );
      }
      if (receipt.status !== 1) {
        throw new Error(
          `Canonical source log ${transactionHash} belongs to a failed receipt`,
        );
      }
      const results = configurations.map((configuration) => ({
        configuration,
        result: qualifyReceipt(receipt, configuration),
      }));
      const qualified = results.filter(({ result }) => result.qualified);
      if (qualified.length === 0) {
        throw new Error(
          `RPC log filter returned receipt ${transactionHash} without an exact policy event`,
        );
      }
      const candidate = {
        transactionHash,
        sourceChain,
        blockNumber: receipt.blockNumber,
        transactionIndex: receipt.index,
        discoveredAt: new Date().toISOString(),
      };
      if (grouped) {
        candidate.matchedRuleIndexes = qualified
          .map(({ configuration }) => configuration.ruleIndex)
          .sort((left, right) => left - right);
        candidate.ruleMatches = qualified
          .map(({ configuration, result }) => ({
            ruleIndex: configuration.ruleIndex,
            observedValue: result.observedValue.toString(),
            matchingLogs: result.matchingLogs,
          }))
          .sort((left, right) => left.ruleIndex - right.ruleIndex);
      } else {
        candidate.observedValue = qualified[0].result.observedValue.toString();
        candidate.matchingLogs = qualified[0].result.matchingLogs;
      }
      rangeAdded.push(candidate);
    }
    rangeAdded.sort(
      (left, right) =>
        left.blockNumber - right.blockNumber ||
        left.transactionIndex - right.transactionIndex,
    );
    const finalAnchor = await sourceProvider.getBlock(rangeEnd);
    if (
      !finalAnchor ||
      finalAnchor.hash.toLowerCase() !== initialAnchor.hash.toLowerCase()
    ) {
      throw new Error(`Source scan head changed at block ${rangeEnd}`);
    }
    logCount += logs.length;
    added.push(...rangeAdded);
    state = {
      ...state,
      nextSourceBlock: rangeEnd + 1,
      lastScannedBlock: rangeEnd,
      lastScannedBlockHash: finalAnchor.hash.toLowerCase(),
      candidates: [...state.candidates, ...rangeAdded],
      completedTransactionHashes: boundedTail(state.completedTransactionHashes),
      skippedCandidates: boundedTail(state.skippedCandidates),
      incidents: boundedTail(state.incidents),
    };
    atomicWriteJson(statePath, state);
    return true;
  }

  await scanRange(fromBlock, toBlock);
  return { state, added };
}

export async function prefilterExecutionCandidates({
  kernel,
  state,
  job,
  sourceChain,
  sourceOrderingCache = new Map(),
}) {
  const key = policyKey(job.facility, job.policyId);
  let sourceOrdering = sourceOrderingCache.get(key);
  if (sourceOrdering === undefined) {
    sourceOrdering = Number(
      await kernel.sourceOrderingOf(job.facility, job.policyId),
    );
    if (
      sourceOrdering !== STRICTLY_INCREASING_SOURCE_ORDERING &&
      sourceOrdering !== UNIQUE_ONLY_SOURCE_ORDERING
    ) {
      throw new Error(`Unsupported source ordering ${sourceOrdering}`);
    }
    sourceOrderingCache.set(key, sourceOrdering);
  }
  const latest =
    sourceOrdering === STRICTLY_INCREASING_SOURCE_ORDERING
      ? await kernel.latestSourcePosition(
          job.facility,
          job.policyId,
          sourceChain,
        )
      : undefined;
  const retained = [];
  for (const candidate of state.candidates) {
    const queryId = solidityPackedKeccak256(
      ["uint64", "uint64", "uint64"],
      [sourceChain, candidate.blockNumber, candidate.transactionIndex],
    );
    const processed = await kernel.isProcessed(
      job.facility,
      job.policyId,
      queryId,
    );
    const stale =
      sourceOrdering === STRICTLY_INCREASING_SOURCE_ORDERING &&
      latest.recorded &&
      (BigInt(candidate.blockNumber) < latest.blockHeight ||
        (BigInt(candidate.blockNumber) === latest.blockHeight &&
          BigInt(candidate.transactionIndex) <= latest.transactionIndex));
    if (processed || stale) {
      state.skippedCandidates ??= [];
      state.skippedCandidates.push({
        ...candidate,
        reason: processed ? "already-processed" : "stale-source-position",
        skippedAt: new Date().toISOString(),
      });
      state.skippedCandidates = boundedTail(state.skippedCandidates);
    } else {
      retained.push(candidate);
    }
  }
  state.candidates = retained;
  return state;
}

export function executionStatePath(
  directory,
  chainId,
  jobId,
  transactionHash,
  sourceChain,
) {
  if (!isHexString(transactionHash, 32)) {
    throw new Error("Invalid execution source transaction hash");
  }
  const sourceSegment =
    sourceChain === undefined
      ? ""
      : `-source-${BigInt(sourceChain).toString()}`;
  return resolve(
    directory,
    `${Number(chainId)}-${BigInt(jobId)}${sourceSegment}-${transactionHash.slice(2).toLowerCase()}.json`,
  );
}

export function sourceStatePathForJob(directory, chainId, jobId, sourceChain) {
  return resolve(
    directory,
    `${Number(chainId)}-${BigInt(jobId)}-source-${BigInt(sourceChain)}.json`,
  );
}

export async function executeQueuedCandidates({
  state,
  statePath,
  chainId,
  sourceChain,
  jobId,
  jobsDirectory,
  deploymentPath,
  signal,
  executeJob,
  executionPolicy,
}) {
  const attempted = new Set();
  for (const candidate of [...state.candidates]) {
    if (signal.aborted) break;
    const normalizedHash = candidate.transactionHash.toLowerCase();
    if (attempted.has(normalizedHash)) continue;
    attempted.add(normalizedHash);
    if (
      sourceChain !== undefined &&
      BigInt(candidate.sourceChain) !== BigInt(sourceChain)
    ) {
      throw new Error(
        `Queued candidate source ${candidate.sourceChain} does not match source ${sourceChain}`,
      );
    }
    const result = await executeJob({
      transactionHash: candidate.transactionHash,
      ...(sourceChain === undefined
        ? {}
        : { sourceChain: Number(sourceChain) }),
      jobId,
      statePath: executionStatePath(
        jobsDirectory,
        chainId,
        jobId,
        candidate.transactionHash,
        sourceChain,
      ),
      deploymentPath,
      signal,
      executionPolicy,
    });
    if (result?.status === "aborted") break;
    state.candidates = state.candidates.filter(
      ({ transactionHash }) => transactionHash !== candidate.transactionHash,
    );
    if (result?.status === "incident") {
      state.incidents ??= [];
      state.incidents.push({
        ...candidate,
        reason: result.reason,
        recordedAt: new Date().toISOString(),
      });
      state.incidents = boundedTail(state.incidents);
    } else if (
      !state.completedTransactionHashes.includes(candidate.transactionHash)
    ) {
      state.completedTransactionHashes.push(candidate.transactionHash);
      state.completedTransactionHashes = boundedTail(
        state.completedTransactionHashes,
      );
    }
    atomicWriteJson(statePath, state);
  }
  return state;
}

export async function recoverExistingExecutionJournals({
  jobsDirectory,
  chainId,
  deploymentPath,
  signal,
  executeJob,
  executionPolicy: policy,
  requireSourceChain = false,
  sourceChains,
}) {
  const prefix = `${Number(chainId)}-`;
  const pattern = new RegExp(
    `^${prefix}(\\d+)(?:-source-(\\d+))?-([0-9a-fA-F]{64})\\.json$`,
  );
  const allowedSources = sourceChains
    ? new Set([...sourceChains].map((value) => BigInt(value).toString()))
    : undefined;
  const recovered = [];
  for (const entry of readdirSync(jobsDirectory, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    if (signal.aborted || !entry.isFile()) break;
    const match = pattern.exec(entry.name);
    if (!match) continue;
    const statePath = resolve(jobsDirectory, entry.name);
    const state = readJson(statePath);
    const sourceChain = match[2];
    const transactionHash = `0x${match[3].toLowerCase()}`;
    if (requireSourceChain && sourceChain === undefined) {
      throw new Error(
        `V3 execution journal is missing its source chain: ${entry.name}`,
      );
    }
    if (
      sourceChain !== undefined &&
      (!allowedSources?.has(sourceChain) ||
        BigInt(state.sourceChain).toString() !== sourceChain)
    ) {
      throw new Error(
        `Execution journal source chain does not match ${entry.name}`,
      );
    }
    if (
      BigInt(state.jobId) !== BigInt(match[1]) ||
      state.sourceTransactionHash?.toLowerCase() !== transactionHash
    ) {
      throw new Error(
        `Execution journal filename does not match ${entry.name}`,
      );
    }
    const terminalClaimPending =
      (state.phase === "revealed" || state.phase === "released") &&
      state.claimSettlementComplete !== true;
    if (
      state.phase === "incident" ||
      ((state.phase === "revealed" || state.phase === "released") &&
        state.claimSettlementComplete === true) ||
      (!state.pending && state.phase !== "committed" && !terminalClaimPending)
    ) {
      continue;
    }
    const result = await executeJob({
      transactionHash,
      jobId: match[1],
      ...(sourceChain === undefined
        ? {}
        : { sourceChain: Number(sourceChain) }),
      statePath,
      deploymentPath,
      signal,
      executionPolicy: policy,
      recoveryOnly: true,
    });
    recovered.push({
      jobId: match[1],
      ...(sourceChain === undefined ? {} : { sourceChain }),
      transactionHash,
      result,
    });
  }
  return recovered;
}

export async function runOperatorCycle({
  provider,
  secondaryProvider,
  deployments,
  paths,
  config,
  signal,
  sourceProviderForChain = getSourceProvider,
  attestedHeightForChain = getAttestedHeight,
  executeJob,
  executionKernelForProvider = assertExecutionKernelCapability,
  discoverJobs = discoverProofJobs,
  writeReport = writeDiscoveryReport,
  scanEvidence = scanJobEvidence,
  executeCandidates = executeQueuedCandidates,
}) {
  const validatedExecutionPolicy = executionPolicy(config);
  const jobExecutor =
    executeJob ||
    (deployments.generation === V3_ACTIVATION_GENERATION
      ? runV3Job
      : runHorizon1Job);
  const isV3 = deployments.generation === V3_ACTIVATION_GENERATION;
  const executionKernel =
    config.execution === "enabled"
      ? await executionKernelForProvider(provider, deployments.policyKernel)
      : undefined;
  if (config.execution === "enabled") {
    await recoverExistingExecutionJournals({
      jobsDirectory: paths.jobsDirectory,
      chainId: deployments.chainId,
      deploymentPath: paths.deployments,
      signal,
      executeJob: jobExecutor,
      executionPolicy: validatedExecutionPolicy,
      requireSourceChain: isV3,
      sourceChains: config.sourceChains,
    });
  }
  const sourceProviders = new Map();
  if (
    config.sourceNetworks &&
    (config.sourceNetworks.size !== config.sourceChains.size ||
      [...config.sourceNetworks.keys()].some(
        (sourceChain) => !config.sourceChains.has(sourceChain),
      ))
  ) {
    throw new Error(
      "Configured source networks must exactly match the source-chain allowlist",
    );
  }
  for (const sourceChain of config.sourceChains) {
    const expected = getSourceNetwork(sourceChain);
    const configured = config.sourceNetworks?.get(sourceChain) ?? expected;
    if (
      Number(configured.evmChainId) !== expected.evmChainId ||
      configured.rpcUrlEnvironment !== expected.rpcUrlEnvironment
    ) {
      throw new Error(
        `Source network binding for CC3 key ${sourceChain} does not match its documented EVM network`,
      );
    }
    const sourceProvider = sourceProviderForChain(expected.chainKey, {
      [configured.rpcUrlEnvironment]: configured.rpcUrl,
    });
    await assertSourceProviderIdentity(
      sourceProvider,
      expected.evmChainId,
      sourceChain,
    );
    sourceProviders.set(sourceChain, {
      provider: sourceProvider,
      secondaryProvider: configured.secondaryRpcUrl
        ? sourceProviderForChain(expected.chainKey, {
            [configured.rpcUrlEnvironment]: configured.secondaryRpcUrl,
          })
        : undefined,
      evmChainId: expected.evmChainId,
    });
    if (sourceProviders.get(sourceChain).secondaryProvider) {
      await assertSourceProviderIdentity(
        sourceProviders.get(sourceChain).secondaryProvider,
        expected.evmChainId,
        sourceChain,
      );
    }
  }
  const report = await discoverJobs({
    provider,
    secondaryProvider,
    deployments,
    cursorPath: paths.discoveryCursor,
    confirmations: config.confirmations,
    chunkSize: config.discoveryChunkSize,
  });
  writeReport(paths.discoveryReport, report);
  const policies = new Map(
    report.policies.map((policy) => [
      policyKey(policy.facility, policy.policyId),
      policy,
    ]),
  );
  const sourceOrderingCache = new Map();
  const summaries = [];
  for (const job of report.jobs) {
    if (signal.aborted) break;
    const hydratedPolicy = policies.get(policyKey(job.facility, job.policyId));
    if (
      deployments.generation === V3_ACTIVATION_GENERATION &&
      BigInt(job.jobId) !== BigInt(deployments.proofJobId)
    ) {
      continue;
    }
    if (!hydratedPolicy?.configuration) continue;
    const configurations = isV3
      ? multiRuleExecutionConfigurations(hydratedPolicy.configuration)
      : [hydratedPolicy.configuration];
    if (
      configurations.some(
        (configuration) =>
          !jobAllowed(
            job,
            { ...hydratedPolicy, configuration },
            config,
            report.scan.stateBlockTimestamp,
          ),
      )
    ) {
      continue;
    }
    const groups = new Map();
    for (const configuration of configurations) {
      const sourceChain = BigInt(configuration.sourceChain).toString();
      const group = groups.get(sourceChain) ?? [];
      group.push(configuration);
      groups.set(sourceChain, group);
    }
    const orderedGroups = [...groups.entries()].sort(
      ([left], [right]) => Number(left) - Number(right),
    );
    for (const [sourceChain, group] of orderedGroups) {
      if (signal.aborted) break;
      const source = sourceProviders.get(sourceChain);
      if (!source) {
        throw new Error(`Missing source provider for CC3 key ${sourceChain}`);
      }
      const statePath = isV3
        ? sourceStatePathForJob(
            paths.jobsDirectory,
            report.chainId,
            job.jobId,
            sourceChain,
          )
        : statePathForJob(paths.jobsDirectory, report.chainId, job.jobId);
      const attestedHeight = await attestedHeightForChain(Number(sourceChain));
      const normalizedPolicy = isV3
        ? { ...hydratedPolicy, configurations: group }
        : { ...hydratedPolicy, configuration: group[0] };
      const { state, added } = await scanEvidence({
        sourceProvider: source.provider,
        secondarySourceProvider: source.secondaryProvider,
        job,
        policy: normalizedPolicy,
        statePath,
        attestedHeight,
        maxSourceBlocks: config.maxSourceBlocksPerPoll,
        expectedSourceChainId: source.evmChainId,
      });
      if (config.execution === "enabled" && !signal.aborted) {
        await prefilterExecutionCandidates({
          kernel: executionKernel,
          state,
          job,
          sourceChain: Number(sourceChain),
          sourceOrderingCache,
        });
        atomicWriteJson(statePath, state);
        await executeCandidates({
          state,
          statePath,
          chainId: report.chainId,
          ...(isV3 ? { sourceChain: Number(sourceChain) } : {}),
          jobId: job.jobId,
          jobsDirectory: paths.jobsDirectory,
          deploymentPath: paths.deployments,
          signal,
          executeJob: jobExecutor,
          executionPolicy: validatedExecutionPolicy,
        });
      }
      summaries.push({
        jobId: job.jobId,
        ...(isV3 ? { sourceChain } : {}),
        mode: config.execution,
        newlyQualified: added.length,
        queued: state.candidates.length,
        completed: state.completedTransactionHashes.length,
        skipped: state.skippedCandidates.length,
        incidents: state.incidents.length,
        scannedThrough: state.lastScannedBlock,
      });
    }
  }
  return { report, jobs: summaries };
}

export async function runOperatorService({
  provider,
  secondaryProvider,
  deployments,
  paths,
  config,
  signal,
  dependencies = {},
}) {
  const { runCycle = runOperatorCycle, ...cycleDependencies } = dependencies;
  const startedAt = new Date().toISOString();
  let backoff;
  let lastSuccessAt = null;
  let lastError = null;
  let jobs = [];
  while (!signal.aborted) {
    try {
      const result = await runCycle({
        provider,
        secondaryProvider,
        deployments,
        paths,
        config,
        signal,
        ...cycleDependencies,
      });
      jobs = result.jobs;
      lastSuccessAt = new Date().toISOString();
      lastError = null;
      backoff = undefined;
      atomicWriteJson(
        paths.status,
        operatorStatus({
          mode: config.execution,
          startedAt,
          lastSuccessAt,
          lastError,
          jobs,
        }),
      );
      if (!signal.aborted) await abortableDelay(config.pollIntervalMs, signal);
    } catch (error) {
      lastError = errorMessage(error);
      backoff = nextBackoff(
        backoff,
        config.pollIntervalMs,
        config.maxBackoffMs,
      );
      atomicWriteJson(
        paths.status,
        operatorStatus({
          mode: config.execution,
          startedAt,
          lastSuccessAt,
          lastError,
          jobs,
        }),
      );
      log(`${lastError}; retrying in ${backoff} ms`);
      if (!signal.aborted) await abortableDelay(backoff, signal);
    }
  }
  atomicWriteJson(
    paths.status,
    operatorStatus({
      mode: config.execution,
      lifecycle: "stopped",
      startedAt,
      stoppedAt: new Date().toISOString(),
      lastSuccessAt,
      lastError,
      jobs,
    }),
  );
}

export function runtimeInputs(environment = process.env) {
  const configPath = resolve(
    environment.RECOURSE_OPERATOR_CONFIG || DEFAULT_CONFIG_PATH,
  );
  const rawConfig = JSON.parse(readFileSync(configPath, "utf8"));
  const deploymentPath = resolve(
    rawConfig.deploymentManifest ||
      environment.HORIZON1_DEPLOYMENTS_FILE ||
      DEFAULT_DEPLOYMENT_PATH,
  );
  const dataRoot = resolve(
    environment.RECOURSE_OPERATOR_DATA_DIRECTORY || DEFAULT_DATA_DIRECTORY,
  );
  const manifestBytes = readFileSync(deploymentPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.generation === V3_ACTIVATION_GENERATION) {
    if (!/^[0-9a-f]{64}$/.test(rawConfig.deploymentManifestSha256 ?? "")) {
      throw new Error(
        "V3 operator configuration requires a lowercase deploymentManifestSha256",
      );
    }
    const actualManifestSha256 = createHash("sha256")
      .update(manifestBytes)
      .digest("hex");
    if (actualManifestSha256 !== rawConfig.deploymentManifestSha256) {
      throw new Error("V3 activation manifest SHA-256 mismatch");
    }
    if (
      !isHexString(rawConfig.activationConfigCommitment, 32) ||
      rawConfig.activationConfigCommitment.toLowerCase() !==
        manifest.configCommitment?.toLowerCase()
    ) {
      throw new Error("V3 activation config commitment mismatch");
    }
    if (rawConfig.stateNamespace !== V3_STATE_NAMESPACE) {
      throw new Error(
        `V3 operator stateNamespace must be ${V3_STATE_NAMESPACE}`,
      );
    }
  }
  const deployments =
    manifest.generation === V3_ACTIVATION_GENERATION
      ? activationDiscoveryDeployments(manifest)
      : manifest;
  const validatedInput =
    deployments.generation === V3_ACTIVATION_GENERATION &&
    rawConfig.bindAllowlistsToActivation === true
      ? {
          ...rawConfig,
          allowlists: {
            facilities: [deployments.demonstrationFacility],
            policyIds: [deployments.policyId],
            tokens: [deployments.demoAsset],
            sourceChains: [
              ...new Set(
                manifest.policy.configuration.rules.map(({ sourceChain }) =>
                  BigInt(sourceChain).toString(),
                ),
              ),
            ],
          },
        }
      : rawConfig;
  const validatedConfig = validateOperatorConfig(validatedInput);
  const sourceNetworkInput =
    deployments.generation === V3_ACTIVATION_GENERATION
      ? manifest.policy.sourceNetworks
      : (rawConfig.sourceNetworks ??
        Object.fromEntries(
          [...validatedConfig.sourceChains].map((sourceChain) => {
            const network = getSourceNetwork(sourceChain);
            return [
              sourceChain,
              {
                evmChainId: network.evmChainId,
                rpcUrlEnvironment: network.rpcUrlEnvironment,
              },
            ];
          }),
        ));
  const config = {
    ...validatedConfig,
    sourceNetworks: validateOperatorSourceNetworks(
      sourceNetworkInput,
      validatedConfig.sourceChains,
      environment,
    ),
    confirmations: rawConfig.confirmations ?? 12,
    discoveryChunkSize: rawConfig.discoveryChunkSize ?? 2_000,
  };
  if (
    config.execution === "enabled" &&
    [...config.sourceNetworks.values()].some(
      ({ secondaryRpcUrl }) => secondaryRpcUrl === undefined,
    )
  ) {
    throw new Error(
      "Execution requires an independent secondary RPC endpoint for every source chain",
    );
  }
  if (deployments.generation === V3_ACTIVATION_GENERATION) {
    assertV3OperatorBinding(manifest, config);
  }
  const dataDirectory =
    deployments.generation === V3_ACTIVATION_GENERATION
      ? resolve(
          dataRoot,
          V3_ACTIVATION_GENERATION,
          manifest.configCommitment.slice(2).toLowerCase(),
        )
      : dataRoot;
  mkdirSync(dataDirectory, { recursive: true });
  return {
    deployments,
    config,
    paths: {
      deployments: deploymentPath,
      discoveryCursor: resolve(dataDirectory, "discovery-cursor.json"),
      discoveryReport: resolve(dataDirectory, "discovery-report.json"),
      jobsDirectory: dataDirectory,
      status: resolve(dataDirectory, "status.json"),
      lock: resolve(dataDirectory, "operator.lock"),
    },
  };
}

async function main() {
  if (!process.env.CREDITCOIN_RPC_URL)
    throw new Error("CREDITCOIN_RPC_URL is required");
  const inputs = runtimeInputs();
  const secondaryUrl = process.env.CREDITCOIN_RPC_URL_SECONDARY;
  if (inputs.config.execution === "enabled" && !secondaryUrl) {
    throw new Error(
      "Execution requires CREDITCOIN_RPC_URL_SECONDARY for log cross-checking",
    );
  }
  let secondaryProvider;
  if (secondaryUrl) {
    const primary = new URL(process.env.CREDITCOIN_RPC_URL);
    const secondary = new URL(secondaryUrl);
    if (
      !["https:", "http:"].includes(secondary.protocol) ||
      primary.href === secondary.href
    ) {
      throw new Error(
        "CREDITCOIN_RPC_URL_SECONDARY must be an independent HTTP RPC endpoint",
      );
    }
    secondaryProvider = new JsonRpcProvider(secondary.href);
  }
  const lock = acquireProcessLock(inputs.paths.lock, {
    mode: inputs.config.execution,
    config: basename(
      process.env.RECOURSE_OPERATOR_CONFIG || DEFAULT_CONFIG_PATH,
    ),
  });
  const controller = new AbortController();
  const stop = (signal) => {
    log(
      `${signal} received; stopping after the current read or transaction reconciliation.`,
    );
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await runOperatorService({
      provider: new JsonRpcProvider(process.env.CREDITCOIN_RPC_URL),
      secondaryProvider,
      ...inputs,
      signal: controller.signal,
    });
  } finally {
    lock.release();
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
