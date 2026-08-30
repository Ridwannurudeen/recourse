import "dotenv/config";
import {
  Contract,
  JsonRpcProvider,
  isHexString,
  solidityPackedKeccak256,
} from "ethers";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, resolve } from "node:path";
import { discoverProofJobs, writeDiscoveryReport } from "./job-discovery.mjs";
import { runHorizon1Job } from "./horizon1-runner.mjs";
import {
  acquireProcessLock,
  abortableDelay,
  atomicWriteJson,
  eventLogFilter,
  jobAllowed,
  nextBackoff,
  operatorStatus,
  qualifyReceipt,
  readJson,
  statePathForJob,
  validateOperatorConfig,
} from "./operator-core.mjs";
import {
  getAttestedHeight,
  getSourceProvider,
} from "../scripts/lib/proofs.mjs";

const DEFAULT_CONFIG_PATH = "daemon/operator-config.example.json";
const DEFAULT_DEPLOYMENT_PATH = "deployments-horizon1.json";
const DEFAULT_DATA_DIRECTORY = "daemon/operator-data";
const EXPECTED_SOURCE_CHAIN_ID = 1n;
export const OPERATOR_LIMITS = Object.freeze({
  maxLogsPerCycle: 512,
  maxCandidatesPerJob: 256,
  maxRetainedHistory: 1_024,
});
const KERNEL_EXECUTION_ABI = [
  "function safeStaleProofRelease() view returns (bool)",
  "function isProcessed(address facility,uint256 policyId,bytes32 queryId) view returns (bool)",
  "function latestSourcePosition(address facility,uint256 policyId,uint64 chainKey) view returns (bool recorded,uint64 blockHeight,uint64 transactionIndex)",
];

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
    minRevealWindowBlocks: config.minRevealWindowBlocks,
    minSecondsToExpiry: config.minSecondsToExpiry,
    maxCommitBond: config.maxCommitBond.toString(),
    minProofReimbursement: config.minProofReimbursement.toString(),
    minRewardToBondBps: config.minRewardToBondBps,
    exclusiveSigner: config.exclusiveSigner,
  };
}

function rangeLimitError(error) {
  return /range|too many|more than|response size|result limit|query limit/i.test(
    error?.message || String(error),
  );
}

export async function verifySourceCursor(provider, state) {
  if (!state?.lastScannedBlock) return;
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
  if (network.chainId !== EXPECTED_SOURCE_CHAIN_ID) {
    throw new Error(
      `Refusing source chain ${network.chainId}; expected Ethereum mainnet chain 1`,
    );
  }
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
  job,
  policy,
  statePath,
  attestedHeight,
  maxSourceBlocks,
}) {
  await assertEthereumMainnetProvider(sourceProvider);
  const configuration = policy.configuration;
  const stored = existsSync(statePath) ? readJson(statePath) : undefined;
  if (stored) {
    if (
      stored.schemaVersion !== 1 ||
      stored.jobId !== job.jobId ||
      stored.facility.toLowerCase() !== job.facility.toLowerCase() ||
      stored.requirementsDigest.toLowerCase() !==
        job.requirementsDigest.toLowerCase()
    ) {
      throw new Error(`Operator state mismatch for job ${job.jobId}`);
    }
    await verifySourceCursor(sourceProvider, stored);
  }
  const startWindow = Number(configuration.startSourceBlock);
  const endWindow = Number(configuration.endSourceBlock);
  const fromBlock = Math.max(
    stored?.nextSourceBlock ?? startWindow,
    startWindow,
  );
  const toBlock = Math.min(
    Number(attestedHeight),
    endWindow,
    fromBlock + maxSourceBlocks - 1,
  );
  if (toBlock < fromBlock) {
    return {
      state: stored ?? {
        schemaVersion: 1,
        jobId: job.jobId,
        facility: job.facility,
        policyId: job.policyId,
        requirementsDigest: job.requirementsDigest,
        nextSourceBlock: fromBlock,
        lastScannedBlock: null,
        lastScannedBlockHash: null,
        candidates: [],
        completedTransactionHashes: [],
        skippedCandidates: [],
        incidents: [],
      },
      added: [],
    };
  }
  let state = stored ?? {
    schemaVersion: 1,
    jobId: job.jobId,
    facility: job.facility,
    policyId: job.policyId,
    requirementsDigest: job.requirementsDigest,
    nextSourceBlock: fromBlock,
    lastScannedBlock: null,
    lastScannedBlockHash: null,
    candidates: [],
    completedTransactionHashes: [],
    skippedCandidates: [],
    incidents: [],
  };
  const added = [];
  let logCount = 0;
  const filter = eventLogFilter(configuration);

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
    let logs;
    try {
      logs = await sourceProvider.getLogs({
        ...filter,
        fromBlock: rangeStart,
        toBlock: rangeEnd,
      });
    } catch (error) {
      if (rangeStart === rangeEnd || !rangeLimitError(error)) throw error;
      const midpoint = Math.floor((rangeStart + rangeEnd) / 2);
      const leftCompleted = await scanRange(rangeStart, midpoint);
      return leftCompleted ? scanRange(midpoint + 1, rangeEnd) : false;
    }
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
    for (const log of logs) {
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
      const result = qualifyReceipt(receipt, configuration);
      if (!result.qualified) {
        throw new Error(
          `RPC log filter returned receipt ${transactionHash} without an exact policy event`,
        );
      }
      rangeAdded.push({
        transactionHash,
        blockNumber: receipt.blockNumber,
        transactionIndex: receipt.index,
        observedValue: result.observedValue.toString(),
        matchingLogs: result.matchingLogs,
        discoveredAt: new Date().toISOString(),
      });
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
}) {
  const latest = await kernel.latestSourcePosition(
    job.facility,
    job.policyId,
    sourceChain,
  );
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

export function executionStatePath(directory, chainId, jobId, transactionHash) {
  if (!isHexString(transactionHash, 32)) {
    throw new Error("Invalid execution source transaction hash");
  }
  return resolve(
    directory,
    `${Number(chainId)}-${BigInt(jobId)}-${transactionHash.slice(2).toLowerCase()}.json`,
  );
}

export async function executeQueuedCandidates({
  state,
  statePath,
  chainId,
  jobId,
  jobsDirectory,
  deploymentPath,
  signal,
  executeJob,
  executionPolicy,
}) {
  for (const candidate of [...state.candidates]) {
    if (signal.aborted) break;
    const result = await executeJob({
      transactionHash: candidate.transactionHash,
      jobId,
      statePath: executionStatePath(
        jobsDirectory,
        chainId,
        jobId,
        candidate.transactionHash,
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
}) {
  const prefix = `${Number(chainId)}-`;
  const pattern = new RegExp(`^${prefix}(\\d+)-([0-9a-fA-F]{64})\\.json$`);
  const recovered = [];
  for (const entry of readdirSync(jobsDirectory, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    if (signal.aborted || !entry.isFile()) break;
    const match = pattern.exec(entry.name);
    if (!match) continue;
    const statePath = resolve(jobsDirectory, entry.name);
    const state = readJson(statePath);
    const transactionHash = `0x${match[2].toLowerCase()}`;
    if (
      BigInt(state.jobId) !== BigInt(match[1]) ||
      state.sourceTransactionHash?.toLowerCase() !== transactionHash
    ) {
      throw new Error(
        `Execution journal filename does not match ${entry.name}`,
      );
    }
    if (
      state.phase === "revealed" ||
      state.phase === "released" ||
      state.phase === "incident" ||
      (!state.pending && state.phase !== "committed")
    ) {
      continue;
    }
    const result = await executeJob({
      transactionHash,
      jobId: match[1],
      statePath,
      deploymentPath,
      signal,
      executionPolicy: policy,
      recoveryOnly: true,
    });
    recovered.push({ jobId: match[1], transactionHash, result });
  }
  return recovered;
}

export async function runOperatorCycle({
  provider,
  deployments,
  paths,
  config,
  signal,
  sourceProviderForChain = getSourceProvider,
  attestedHeightForChain = getAttestedHeight,
  executeJob = runHorizon1Job,
  executionKernelForProvider = assertExecutionKernelCapability,
}) {
  const policy = executionPolicy(config);
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
      executeJob,
      executionPolicy: policy,
    });
  }
  const sourceProviders = new Map();
  for (const sourceChain of config.sourceChains) {
    const chainKey = Number(sourceChain);
    const sourceProvider = sourceProviderForChain(chainKey);
    await assertEthereumMainnetProvider(sourceProvider);
    sourceProviders.set(chainKey, sourceProvider);
  }
  const report = await discoverProofJobs({
    provider,
    deployments,
    cursorPath: paths.discoveryCursor,
    confirmations: config.confirmations,
    chunkSize: config.discoveryChunkSize,
  });
  writeDiscoveryReport(paths.discoveryReport, report);
  const policies = new Map(
    report.policies.map((policy) => [
      policyKey(policy.facility, policy.policyId),
      policy,
    ]),
  );
  const summaries = [];
  for (const job of report.jobs) {
    if (signal.aborted) break;
    const policy = policies.get(policyKey(job.facility, job.policyId));
    if (!jobAllowed(job, policy, config, report.scan.stateBlockTimestamp)) {
      continue;
    }
    const sourceChain = Number(policy.configuration.sourceChain);
    const sourceProvider = sourceProviders.get(sourceChain);
    const statePath = statePathForJob(
      paths.jobsDirectory,
      report.chainId,
      job.jobId,
    );
    const attestedHeight = await attestedHeightForChain(sourceChain);
    const { state, added } = await scanJobEvidence({
      sourceProvider,
      job,
      policy,
      statePath,
      attestedHeight,
      maxSourceBlocks: config.maxSourceBlocksPerPoll,
    });
    if (config.execution === "enabled" && !signal.aborted) {
      await prefilterExecutionCandidates({
        kernel: executionKernel,
        state,
        job,
        sourceChain,
      });
      atomicWriteJson(statePath, state);
      await executeQueuedCandidates({
        state,
        statePath,
        chainId: report.chainId,
        jobId: job.jobId,
        jobsDirectory: paths.jobsDirectory,
        deploymentPath: paths.deployments,
        signal,
        executeJob,
        executionPolicy: policy,
      });
    }
    summaries.push({
      jobId: job.jobId,
      mode: config.execution,
      newlyQualified: added.length,
      queued: state.candidates.length,
      completed: state.completedTransactionHashes.length,
      skipped: state.skippedCandidates.length,
      incidents: state.incidents.length,
      scannedThrough: state.lastScannedBlock,
    });
  }
  return { report, jobs: summaries };
}

export async function runOperatorService({
  provider,
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

function runtimeInputs() {
  const configPath = resolve(
    process.env.RECOURSE_OPERATOR_CONFIG || DEFAULT_CONFIG_PATH,
  );
  const deploymentPath = resolve(
    process.env.HORIZON1_DEPLOYMENTS_FILE || DEFAULT_DEPLOYMENT_PATH,
  );
  const dataDirectory = resolve(
    process.env.RECOURSE_OPERATOR_DATA_DIRECTORY || DEFAULT_DATA_DIRECTORY,
  );
  mkdirSync(dataDirectory, { recursive: true });
  const deployments = JSON.parse(readFileSync(deploymentPath, "utf8"));
  const rawConfig = JSON.parse(readFileSync(configPath, "utf8"));
  const config = {
    ...validateOperatorConfig(rawConfig),
    confirmations: rawConfig.confirmations ?? 12,
    discoveryChunkSize: rawConfig.discoveryChunkSize ?? 2_000,
  };
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

export function isOperatorMainModule(
  moduleUrl,
  argvPath,
  canonicalize = realpathSync,
) {
  if (!argvPath) return false;
  return (
    canonicalize(resolve(argvPath)) === canonicalize(fileURLToPath(moduleUrl))
  );
}

async function main() {
  if (!process.env.CREDITCOIN_RPC_URL)
    throw new Error("CREDITCOIN_RPC_URL is required");
  if (!process.env.ETH_MAINNET_RPC_URL) {
    throw new Error("ETH_MAINNET_RPC_URL is required");
  }
  const inputs = runtimeInputs();
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
      ...inputs,
      signal: controller.signal,
    });
  } finally {
    lock.release();
  }
}

if (isOperatorMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
