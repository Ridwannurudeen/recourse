import "dotenv/config";
import { Contract, Interface, JsonRpcProvider, getAddress } from "ethers";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  buildDiscoveryReport,
  mapInBatches,
  metricsFromCheckpoint,
  retainRecentEvents,
  sortAndDedupeEvents,
  updateMetricCheckpoint,
} from "./job-discovery-core.mjs";
import { atomicWriteJson } from "./operator-core.mjs";

export const PROOF_JOBS_ABI = [
  "event JobCreated(uint256 indexed jobId,address indexed sponsor,address indexed facility,uint256 policyId,bytes32 requirementsDigest,uint256 escrow)",
  "event EvidenceCommitted(uint256 indexed jobId,address indexed hunter,bytes32 indexed evidenceDigest,bytes32 commitment,uint64 revealDeadlineBlock)",
  "event ProofAccepted(uint256 indexed jobId,address indexed hunter,uint8 outcomeLevel,uint32 successfulProofs)",
  "event ProcessedProofReleased(uint256 indexed jobId,address indexed hunter,bytes32 indexed evidenceDigest)",
  "event JobFinalized(uint256 indexed jobId,uint8 state,uint256 sponsorRefund)",
  "event CommitmentSlashed(uint256 indexed jobId,address indexed hunter,uint256 bond)",
  "event CommitmentReleased(uint256 indexed jobId,address indexed hunter,uint256 bond)",
  "function getJob(uint256 jobId) view returns (tuple(address sponsor,address token,address facility,uint256 policyId,bytes32 requirementsDigest,uint64 expiry,uint64 revealWindowBlocks,uint32 maxSuccessfulProofs,uint32 successfulProofs,uint256 proofReimbursement,uint256 outcomeReward,uint256 commitBond,uint256 escrowRemaining,uint8 rewardOutcomeThreshold,uint8 state))",
];

const POLICY_KERNEL_ABI = [
  "function policyOf(address facility,uint256 policyId) view returns (address evaluator,bytes32 configHash,bytes manifestBytes)",
];

const EVENT_HISTORY_POLICY_ABI = [
  "function configurationOf(address facility,uint256 policyId) view returns (tuple(uint64 sourceChain,address emitter,bytes32 eventSignature,address subject,uint64 startSourceBlock,uint64 endSourceBlock,uint8 topicCount,uint8 subjectTopicIndex,uint16 dataLength,uint16 observedValueOffset,uint8 observationKind,uint8 evidenceKind,uint64 freshnessPeriod,tuple(uint8 outcome,uint16 creditLimitBps,uint16 futureDrawFeeBps,bool freezePendingDraw,bool requireFreshEvidence,bool terminate) effect))",
];

const MULTI_CHAIN_EVENT_POLICY_ABI = [
  "function configurationOf(address facility,uint256 policyId) view returns (tuple(address subject,uint64 freshnessPeriod,uint32 watchThreshold,uint32 restrictedThreshold,uint32 marginThreshold,uint32 breachThreshold,tuple(uint8 outcome,uint16 creditLimitBps,uint16 futureDrawFeeBps,bool freezePendingDraw,bool requireFreshEvidence,bool terminate) watchEffect,tuple(uint8 outcome,uint16 creditLimitBps,uint16 futureDrawFeeBps,bool freezePendingDraw,bool requireFreshEvidence,bool terminate) restrictedEffect,tuple(uint8 outcome,uint16 creditLimitBps,uint16 futureDrawFeeBps,bool freezePendingDraw,bool requireFreshEvidence,bool terminate) marginEffect,tuple(uint8 outcome,uint16 creditLimitBps,uint16 futureDrawFeeBps,bool freezePendingDraw,bool requireFreshEvidence,bool terminate) breachEffect,tuple(uint64 sourceChain,address emitter,bytes32 eventSignature,uint64 startSourceBlock,uint64 endSourceBlock,uint8 topicCount,uint8 subjectTopicIndex,uint16 dataLength,uint16 observedValueOffset,uint8 observationKind,uint32 riskWeight)[] rules))",
];

const JOB_STATES = ["Open", "OutcomeReached", "AttemptsExhausted", "Expired"];
const DEFAULT_CONFIRMATIONS = 12;
const DEFAULT_CHUNK_SIZE = 2_000;
const DEFAULT_CURSOR_PATH = "daemon/job-discovery-cursor.json";
const HYDRATION_BATCH_SIZE = 25;
const EVENT_RETENTION_LIMIT = 1_000;
const EVENT_NAMES = new Set([
  "JobCreated",
  "EvidenceCommitted",
  "ProofAccepted",
  "ProcessedProofReleased",
  "JobFinalized",
  "CommitmentSlashed",
  "CommitmentReleased",
]);

function unsignedInteger(value, label, { positive = false } = {}) {
  const number = Number(value);
  if (
    !Number.isSafeInteger(number) ||
    number < 0 ||
    (positive && number === 0)
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return number;
}

function bigintString(value) {
  return BigInt(value).toString();
}

function canonicalBigintString(value, label, { positive = false } = {}) {
  const string = String(value);
  let parsed;
  try {
    parsed = BigInt(string);
  } catch {
    throw new Error(`Invalid ${label}`);
  }
  if (
    parsed < 0n ||
    (positive && parsed === 0n) ||
    parsed.toString() !== string
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return string;
}

function readCursor(path, deployments, confirmations) {
  if (!existsSync(path)) return undefined;
  const cursor = JSON.parse(readFileSync(path, "utf8"));
  if (cursor.version !== 2 && cursor.version !== 3) {
    throw new Error("Invalid discovery cursor version");
  }
  if (cursor.chainId !== Number(deployments.chainId)) {
    throw new Error("Discovery cursor chain mismatch");
  }
  if (
    getAddress(cursor.contractAddress) !== getAddress(deployments.proofJobs)
  ) {
    throw new Error("Discovery cursor contract mismatch");
  }
  if (cursor.confirmations !== confirmations) {
    throw new Error("Discovery cursor confirmation depth mismatch");
  }
  const nextBlock = unsignedInteger(
    cursor.nextBlock,
    "discovery cursor next block",
  );
  const lastScannedBlock = unsignedInteger(
    cursor.lastScannedBlock,
    "discovery cursor block",
  );
  const historyFromBlock = unsignedInteger(
    cursor.historyFromBlock,
    "discovery cursor history block",
  );
  if (
    nextBlock !== lastScannedBlock + 1 ||
    historyFromBlock > lastScannedBlock
  ) {
    throw new Error("Invalid discovery cursor block range");
  }
  if (typeof cursor.historyComplete !== "boolean") {
    throw new Error("Invalid discovery cursor history completeness");
  }
  const deploymentBlock = unsignedInteger(
    deployments.deploymentBlock,
    "deployment block",
  );
  if (cursor.historyComplete !== historyFromBlock <= deploymentBlock) {
    throw new Error("Invalid discovery cursor history completeness");
  }
  if (
    typeof cursor.lastScannedBlockHash !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(cursor.lastScannedBlockHash)
  ) {
    throw new Error("Invalid discovery cursor block hash");
  }
  if (
    cursor.version === 3 &&
    (!Number.isSafeInteger(cursor.lastScannedBlockTimestamp) ||
      cursor.lastScannedBlockTimestamp < 0)
  ) {
    throw new Error("Invalid discovery cursor block timestamp");
  }
  if (!Array.isArray(cursor.events))
    throw new Error("Invalid discovery cursor events");
  if (
    typeof cursor.eventsTruncated !== "boolean" ||
    !Array.isArray(cursor.jobs) ||
    !Array.isArray(cursor.policies)
  ) {
    throw new Error("Invalid discovery cursor retained state");
  }
  cursor.events = sortAndDedupeEvents(cursor.events);
  if (
    cursor.events.some(
      (event) =>
        event.blockNumber < historyFromBlock ||
        event.blockNumber > lastScannedBlock,
    )
  ) {
    throw new Error("Invalid discovery cursor event range");
  }
  metricsFromCheckpoint(cursor.metrics);
  const jobIds = new Set();
  const policyKeys = new Set();
  for (const job of cursor.jobs) {
    const id = canonicalBigintString(job?.jobId, "discovery cursor job ID", {
      positive: true,
    });
    if (jobIds.has(id)) throw new Error("Duplicate discovery cursor job");
    getAddress(job.sponsor);
    getAddress(job.token);
    const facility = getAddress(job.facility);
    const policyId = canonicalBigintString(
      job.policyId,
      "discovery cursor policy ID",
    );
    if (
      !Number.isSafeInteger(job.stateValue) ||
      JOB_STATES[job.stateValue] !== job.state
    ) {
      throw new Error("Invalid discovery cursor job state");
    }
    jobIds.add(id);
    policyKeys.add(`${facility.toLowerCase()}:${policyId}`);
  }
  if (
    cursor.events.some(
      (event) =>
        !jobIds.has(
          canonicalBigintString(event.jobId, "discovery cursor event job ID", {
            positive: true,
          }),
        ),
    ) ||
    cursor.metrics.jobs.some(({ jobId }) => !jobIds.has(jobId))
  ) {
    throw new Error("Invalid discovery cursor job cache");
  }
  const cachedPolicyKeys = new Set();
  for (const policy of cursor.policies) {
    const key = `${getAddress(policy?.facility).toLowerCase()}:${canonicalBigintString(policy?.policyId, "discovery cursor policy ID")}`;
    if (cachedPolicyKeys.has(key)) {
      throw new Error("Duplicate discovery cursor policy");
    }
    getAddress(policy.evaluator);
    cachedPolicyKeys.add(key);
  }
  if ([...policyKeys].some((key) => !cachedPolicyKeys.has(key))) {
    throw new Error("Invalid discovery cursor policy cache");
  }
  return cursor;
}

function eventFields(parsed) {
  const args = parsed.args;
  if (parsed.name === "JobCreated") {
    return {
      sponsor: getAddress(args.sponsor),
      facility: getAddress(args.facility),
      policyId: bigintString(args.policyId),
      requirementsDigest: args.requirementsDigest.toLowerCase(),
      escrow: bigintString(args.escrow),
    };
  }
  if (parsed.name === "EvidenceCommitted") {
    return {
      operator: getAddress(args.hunter),
      evidenceDigest: args.evidenceDigest.toLowerCase(),
      commitment: args.commitment.toLowerCase(),
      revealDeadlineBlock: bigintString(args.revealDeadlineBlock),
    };
  }
  if (parsed.name === "ProofAccepted") {
    return {
      operator: getAddress(args.hunter),
      outcomeLevel: Number(args.outcomeLevel),
      successfulProofs: Number(args.successfulProofs),
    };
  }
  if (parsed.name === "ProcessedProofReleased") {
    return {
      operator: getAddress(args.hunter),
      evidenceDigest: args.evidenceDigest.toLowerCase(),
    };
  }
  if (parsed.name === "JobFinalized") {
    return {
      state: JOB_STATES[Number(args.state)],
      stateValue: Number(args.state),
      sponsorRefund: bigintString(args.sponsorRefund),
    };
  }
  return {
    operator: getAddress(args.hunter),
    bond: bigintString(args.bond),
  };
}

function serializeJob(jobId, job) {
  const stateValue = Number(job.state);
  return {
    jobId: bigintString(jobId),
    sponsor: getAddress(job.sponsor),
    token: getAddress(job.token),
    facility: getAddress(job.facility),
    policyId: bigintString(job.policyId),
    requirementsDigest: job.requirementsDigest.toLowerCase(),
    expiry: bigintString(job.expiry),
    revealWindowBlocks: bigintString(job.revealWindowBlocks),
    maxSuccessfulProofs: bigintString(job.maxSuccessfulProofs),
    successfulProofs: bigintString(job.successfulProofs),
    proofReimbursement: bigintString(job.proofReimbursement),
    outcomeReward: bigintString(job.outcomeReward),
    commitBond: bigintString(job.commitBond),
    escrowRemaining: bigintString(job.escrowRemaining),
    rewardOutcomeThreshold: Number(job.rewardOutcomeThreshold),
    state: JOB_STATES[stateValue],
    stateValue,
  };
}

function serializeConfiguration(configuration) {
  return {
    sourceChain: bigintString(configuration.sourceChain),
    emitter: getAddress(configuration.emitter),
    eventSignature: configuration.eventSignature.toLowerCase(),
    subject: getAddress(configuration.subject),
    startSourceBlock: bigintString(configuration.startSourceBlock),
    endSourceBlock: bigintString(configuration.endSourceBlock),
    topicCount: Number(configuration.topicCount),
    subjectTopicIndex: Number(configuration.subjectTopicIndex),
    dataLength: Number(configuration.dataLength),
    observedValueOffset: Number(configuration.observedValueOffset),
    observationKind: Number(configuration.observationKind),
    evidenceKind: Number(configuration.evidenceKind),
    freshnessPeriod: bigintString(configuration.freshnessPeriod),
    effect: {
      outcome: Number(configuration.effect.outcome),
      creditLimitBps: Number(configuration.effect.creditLimitBps),
      futureDrawFeeBps: Number(configuration.effect.futureDrawFeeBps),
      freezePendingDraw: configuration.effect.freezePendingDraw,
      requireFreshEvidence: configuration.effect.requireFreshEvidence,
      terminate: configuration.effect.terminate,
    },
  };
}

function serializeEffect(effect) {
  return {
    outcome: Number(effect.outcome),
    creditLimitBps: Number(effect.creditLimitBps),
    futureDrawFeeBps: Number(effect.futureDrawFeeBps),
    freezePendingDraw: effect.freezePendingDraw,
    requireFreshEvidence: effect.requireFreshEvidence,
    terminate: effect.terminate,
  };
}

export function serializeMultiChainConfiguration(configuration) {
  return {
    kind: "multi-chain-event-v1",
    subject: getAddress(configuration.subject),
    freshnessPeriod: bigintString(configuration.freshnessPeriod),
    watchThreshold: Number(configuration.watchThreshold),
    restrictedThreshold: Number(configuration.restrictedThreshold),
    marginThreshold: Number(configuration.marginThreshold),
    breachThreshold: Number(configuration.breachThreshold),
    watchEffect: serializeEffect(configuration.watchEffect),
    restrictedEffect: serializeEffect(configuration.restrictedEffect),
    marginEffect: serializeEffect(configuration.marginEffect),
    breachEffect: serializeEffect(configuration.breachEffect),
    rules: [...configuration.rules].map((rule) => ({
      sourceChain: bigintString(rule.sourceChain),
      emitter: getAddress(rule.emitter),
      eventSignature: rule.eventSignature.toLowerCase(),
      startSourceBlock: bigintString(rule.startSourceBlock),
      endSourceBlock: bigintString(rule.endSourceBlock),
      topicCount: Number(rule.topicCount),
      subjectTopicIndex: Number(rule.subjectTopicIndex),
      dataLength: Number(rule.dataLength),
      observedValueOffset: Number(rule.observedValueOffset),
      observationKind: Number(rule.observationKind),
      riskWeight: Number(rule.riskWeight),
    })),
  };
}

async function canonicalBlocks(provider, logs) {
  const heights = new Set(logs.map((log) => log.blockNumber));
  const blocks = new Map();
  await mapInBatches([...heights], HYDRATION_BATCH_SIZE, async (height) => {
    const block = await provider.getBlock(height);
    if (!block) throw new Error(`Block ${height} is unavailable`);
    blocks.set(height, block);
  });
  for (const log of logs) {
    const block = blocks.get(log.blockNumber);
    if (block.hash.toLowerCase() !== log.blockHash.toLowerCase()) {
      throw new Error(`Log at block ${log.blockNumber} is not canonical`);
    }
  }
  return blocks;
}

async function hydrateJobs(jobsContract, jobIds, stateBlock) {
  return mapInBatches(jobIds, HYDRATION_BATCH_SIZE, async (id) =>
    serializeJob(id, await jobsContract.getJob(id, { blockTag: stateBlock })),
  );
}

async function hydratePolicies(
  kernelContract,
  policyContract,
  multiChainPolicyContract,
  deployments,
  policyKeys,
  stateBlock,
) {
  return mapInBatches(
    policyKeys,
    HYDRATION_BATCH_SIZE,
    async ({ facility, policyId }) => {
      const policy = await kernelContract.policyOf(facility, policyId, {
        blockTag: stateBlock,
      });
      const evaluator = getAddress(policy.evaluator);
      const hydrated = {
        facility,
        policyId,
        evaluator,
        configHash: policy.configHash.toLowerCase(),
        manifest: policy.manifestBytes,
      };
      if (
        deployments.eventHistoryPolicy &&
        evaluator === getAddress(deployments.eventHistoryPolicy)
      ) {
        hydrated.configuration = serializeConfiguration(
          await policyContract.configurationOf(facility, policyId, {
            blockTag: stateBlock,
          }),
        );
      } else if (
        deployments.multiChainEventPolicy &&
        evaluator === getAddress(deployments.multiChainEventPolicy)
      ) {
        hydrated.configuration = serializeMultiChainConfiguration(
          await multiChainPolicyContract.configurationOf(facility, policyId, {
            blockTag: stateBlock,
          }),
        );
      }
      return hydrated;
    },
  );
}

function jobRecordKey(job) {
  return job.jobId;
}

function policyRecordKey(policy) {
  return `${policy.facility.toLowerCase()}:${policy.policyId}`;
}

function mergeRecords(existing, updated, key) {
  const merged = new Map(existing.map((record) => [key(record), record]));
  for (const record of updated) merged.set(key(record), record);
  return [...merged.values()];
}

export async function discoverProofJobs({
  provider,
  deployments,
  cursorPath,
  fromBlock,
  toBlock,
  confirmations = DEFAULT_CONFIRMATIONS,
  chunkSize = DEFAULT_CHUNK_SIZE,
  jobsContract,
  kernelContract,
  policyContract,
  multiChainPolicyContract,
}) {
  confirmations = unsignedInteger(confirmations, "confirmation depth", {
    positive: true,
  });
  chunkSize = unsignedInteger(chunkSize, "log chunk size", { positive: true });
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(deployments.chainId)) {
    throw new Error(
      `Refusing chain ${network.chainId}; expected ${deployments.chainId}`,
    );
  }
  const resolvedCursorPath = resolve(cursorPath || DEFAULT_CURSOR_PATH);
  const cursor = readCursor(resolvedCursorPath, deployments, confirmations);
  let cursorBlock;
  if (cursor) {
    cursorBlock = await provider.getBlock(cursor.lastScannedBlock);
    if (
      !cursorBlock ||
      cursorBlock.hash.toLowerCase() !==
        cursor.lastScannedBlockHash.toLowerCase()
    ) {
      throw new Error("Discovery cursor is no longer on the canonical chain");
    }
  }

  const latestBlock = await provider.getBlockNumber();
  const confirmedHead = latestBlock - confirmations;
  const deploymentBlock = unsignedInteger(
    deployments.deploymentBlock,
    "deployment block",
  );
  const explicitFromBlock =
    fromBlock === undefined
      ? undefined
      : unsignedInteger(fromBlock, "from block");
  if (
    cursor &&
    explicitFromBlock !== undefined &&
    explicitFromBlock !== cursor.nextBlock
  ) {
    throw new Error(
      "Explicit from block must match discovery cursor next block",
    );
  }
  const start = unsignedInteger(
    explicitFromBlock ?? cursor?.nextBlock ?? deploymentBlock,
    "from block",
  );
  const historyFromBlock = cursor?.historyFromBlock ?? start;
  const historyComplete =
    cursor?.historyComplete ?? historyFromBlock <= deploymentBlock;
  const requestedEnd =
    toBlock === undefined
      ? confirmedHead
      : unsignedInteger(toBlock, "to block");
  const end = Math.min(requestedEnd, confirmedHead);
  const jobs =
    jobsContract ||
    new Contract(deployments.proofJobs, PROOF_JOBS_ABI, provider);
  const kernel =
    kernelContract ||
    new Contract(deployments.policyKernel, POLICY_KERNEL_ABI, provider);
  const eventHistory =
    policyContract ||
    (deployments.eventHistoryPolicy
      ? new Contract(
          deployments.eventHistoryPolicy,
          EVENT_HISTORY_POLICY_ABI,
          provider,
        )
      : undefined);
  const multiChainPolicy =
    multiChainPolicyContract ||
    (deployments.multiChainEventPolicy
      ? new Contract(
          deployments.multiChainEventPolicy,
          MULTI_CHAIN_EVENT_POLICY_ABI,
          provider,
        )
      : undefined);
  if (end < start) {
    const stateBlock = cursor?.lastScannedBlock ?? null;
    const checkpoint = cursor?.metrics ?? updateMetricCheckpoint(undefined, []);
    return buildDiscoveryReport({
      chainId: deployments.chainId,
      contractAddress: deployments.proofJobs,
      fromBlock: start,
      toBlock: end,
      historyFromBlock,
      stateBlock,
      stateBlockHash: cursorBlock?.hash?.toLowerCase() ?? null,
      stateBlockTimestamp: cursorBlock?.timestamp ?? null,
      historyComplete,
      eventsTruncated: cursor?.eventsTruncated ?? false,
      confirmations,
      events: cursor?.events ?? [],
      jobs: cursor?.jobs ?? [],
      policies: cursor?.policies ?? [],
      metrics: metricsFromCheckpoint(checkpoint),
    });
  }
  const scanAnchor = await provider.getBlock(end);
  if (!scanAnchor) throw new Error(`Block ${end} is unavailable`);
  const iface = new Interface(PROOF_JOBS_ABI);
  let retained = {
    events: cursor?.events ?? [],
    truncated: cursor?.eventsTruncated ?? false,
  };
  let checkpoint = cursor?.metrics;
  const changedJobIds = new Set();
  for (let chunkStart = start; chunkStart <= end; chunkStart += chunkSize) {
    const chunkEnd = Math.min(end, chunkStart + chunkSize - 1);
    const logs = await provider.getLogs({
      address: deployments.proofJobs,
      fromBlock: chunkStart,
      toBlock: chunkEnd,
    });
    const blocks = await canonicalBlocks(provider, logs);
    const events = [];
    for (const log of logs) {
      const parsed = iface.parseLog(log);
      if (!parsed || !EVENT_NAMES.has(parsed.name)) continue;
      events.push({
        name: parsed.name,
        jobId: bigintString(parsed.args.jobId),
        blockNumber: log.blockNumber,
        blockHash: log.blockHash.toLowerCase(),
        transactionHash: log.transactionHash.toLowerCase(),
        transactionIndex: log.transactionIndex,
        logIndex: log.index,
        timestamp: blocks.get(log.blockNumber).timestamp,
        ...eventFields(parsed),
      });
    }
    const windowEvents = sortAndDedupeEvents(events);
    retained = retainRecentEvents(
      retained.events,
      windowEvents,
      EVENT_RETENTION_LIMIT,
      retained.truncated,
    );
    checkpoint = updateMetricCheckpoint(checkpoint, windowEvents);
    for (const { jobId } of windowEvents) changedJobIds.add(jobId);
  }
  const cachedJobs = cursor?.jobs ?? [];
  const orderedChangedJobIds = [...changedJobIds].sort((left, right) =>
    BigInt(left) < BigInt(right) ? -1 : 1,
  );
  const refreshedJobs = await hydrateJobs(jobs, orderedChangedJobIds, end);
  const allJobs = mergeRecords(cachedJobs, refreshedJobs, jobRecordKey);
  const cachedPolicies = cursor?.policies ?? [];
  const cachedPolicyKeys = new Set(cachedPolicies.map(policyRecordKey));
  const missingPolicies = new Map();
  for (const job of allJobs) {
    const key = `${job.facility.toLowerCase()}:${job.policyId}`;
    if (!cachedPolicyKeys.has(key)) {
      missingPolicies.set(key, {
        facility: job.facility,
        policyId: job.policyId,
      });
    }
  }
  const refreshedPolicies = await hydratePolicies(
    kernel,
    eventHistory,
    multiChainPolicy,
    deployments,
    [...missingPolicies.values()],
    end,
  );
  const allPolicies = mergeRecords(
    cachedPolicies,
    refreshedPolicies,
    policyRecordKey,
  );
  const finalBlock = await provider.getBlock(end);
  if (
    !finalBlock ||
    finalBlock.hash.toLowerCase() !== scanAnchor.hash.toLowerCase()
  ) {
    throw new Error(
      "Discovery scan head changed before the cursor was written",
    );
  }
  const report = buildDiscoveryReport({
    chainId: deployments.chainId,
    contractAddress: deployments.proofJobs,
    fromBlock: start,
    toBlock: end,
    historyFromBlock,
    stateBlock: end,
    stateBlockHash: finalBlock.hash.toLowerCase(),
    stateBlockTimestamp: finalBlock.timestamp,
    historyComplete,
    eventsTruncated: retained.truncated,
    confirmations,
    events: retained.events,
    jobs: allJobs,
    policies: allPolicies,
    metrics: metricsFromCheckpoint(checkpoint),
  });
  atomicWriteJson(resolvedCursorPath, {
    version: 3,
    chainId: Number(deployments.chainId),
    contractAddress: getAddress(deployments.proofJobs),
    historyFromBlock,
    historyComplete,
    nextBlock: end + 1,
    lastScannedBlock: end,
    lastScannedBlockHash: finalBlock.hash.toLowerCase(),
    lastScannedBlockTimestamp: finalBlock.timestamp,
    confirmations,
    eventsTruncated: retained.truncated,
    events: report.events,
    jobs: report.jobs,
    policies: report.policies,
    metrics: checkpoint,
  });
  return report;
}

function optionalBlock(value, label) {
  return value === undefined || value === ""
    ? undefined
    : unsignedInteger(value, label);
}

export function writeDiscoveryReport(path, report) {
  atomicWriteJson(resolve(path), report);
}

function outputPathFromArgs(args) {
  let outputPath = process.env.HORIZON1_DISCOVERY_OUTPUT_FILE;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--output") {
      throw new Error(`Unknown discovery argument: ${args[index]}`);
    }
    if (index + 1 >= args.length || args[index + 1].startsWith("--")) {
      throw new Error("--output requires a path");
    }
    outputPath = args[index + 1];
    index += 1;
  }
  return outputPath ? resolve(outputPath) : undefined;
}

async function main() {
  const outputPath = outputPathFromArgs(process.argv.slice(2));
  const deploymentPath = resolve(
    process.env.HORIZON1_DISCOVERY_DEPLOYMENTS_FILE ||
      "deployments-horizon1.json",
  );
  const deployments = JSON.parse(readFileSync(deploymentPath, "utf8"));
  if (!process.env.CREDITCOIN_RPC_URL) {
    throw new Error("CREDITCOIN_RPC_URL is required");
  }
  const report = await discoverProofJobs({
    provider: new JsonRpcProvider(process.env.CREDITCOIN_RPC_URL),
    deployments,
    cursorPath: resolve(
      process.env.HORIZON1_DISCOVERY_CURSOR_FILE || DEFAULT_CURSOR_PATH,
    ),
    fromBlock: optionalBlock(
      process.env.HORIZON1_DISCOVERY_FROM_BLOCK,
      "from block",
    ),
    toBlock: optionalBlock(process.env.HORIZON1_DISCOVERY_TO_BLOCK, "to block"),
    confirmations:
      process.env.HORIZON1_DISCOVERY_CONFIRMATIONS || DEFAULT_CONFIRMATIONS,
    chunkSize: process.env.HORIZON1_DISCOVERY_CHUNK_SIZE || DEFAULT_CHUNK_SIZE,
  });
  if (outputPath) writeDiscoveryReport(outputPath, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}
