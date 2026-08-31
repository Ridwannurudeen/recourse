import { Transaction, getAddress, isHexString, keccak256 } from "ethers";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const UINT256_MAX = (1n << 256n) - 1n;

export class OperatorIncidentError extends Error {
  constructor(message) {
    super(message);
    this.name = "OperatorIncidentError";
  }
}

function unsignedInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Invalid ${label}`);
  }
  return number;
}

function nonnegativeBigInt(value, label, { positive = false } = {}) {
  let parsed;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`Invalid ${label}`);
  }
  if (parsed < 0n || (positive && parsed === 0n)) {
    throw new Error(`Invalid ${label}`);
  }
  return parsed;
}

function validateTransactionFeePolicy(policy) {
  if (
    policy?.transactionType !== "eip1559" &&
    policy?.transactionType !== "legacy"
  ) {
    throw new Error("Transaction fee policy type must be eip1559 or legacy");
  }
  const normalized = {
    transactionType: policy.transactionType,
    maximumGasLimit: nonnegativeBigInt(
      policy.maximumGasLimit,
      "maximum transaction gas limit",
      { positive: true },
    ),
    maximumNativeFee: nonnegativeBigInt(
      policy.maximumNativeFee,
      "maximum native transaction fee",
      { positive: true },
    ),
  };
  if (policy.transactionType === "eip1559") {
    if (policy.maximumGasPrice !== undefined) {
      throw new Error(
        "Transaction fee policy mixes legacy and EIP-1559 fields",
      );
    }
    normalized.maximumFeePerGas = nonnegativeBigInt(
      policy.maximumFeePerGas,
      "maximum transaction fee per gas",
      { positive: true },
    );
    normalized.maximumPriorityFeePerGas = nonnegativeBigInt(
      policy.maximumPriorityFeePerGas,
      "maximum transaction priority fee per gas",
      { positive: true },
    );
    if (normalized.maximumPriorityFeePerGas > normalized.maximumFeePerGas) {
      throw new Error(
        "Maximum transaction priority fee exceeds maximum fee per gas",
      );
    }
    if (
      normalized.maximumGasLimit * normalized.maximumFeePerGas >
      normalized.maximumNativeFee
    ) {
      throw new Error("Transaction fee policy exceeds its maximum native fee");
    }
  } else {
    if (
      policy.maximumFeePerGas !== undefined ||
      policy.maximumPriorityFeePerGas !== undefined
    ) {
      throw new Error(
        "Transaction fee policy mixes legacy and EIP-1559 fields",
      );
    }
    normalized.maximumGasPrice = nonnegativeBigInt(
      policy.maximumGasPrice,
      "maximum transaction gas price",
      { positive: true },
    );
    if (
      normalized.maximumGasLimit * normalized.maximumGasPrice >
      normalized.maximumNativeFee
    ) {
      throw new Error("Transaction fee policy exceeds its maximum native fee");
    }
  }
  return normalized;
}

function normalizeTransactionFees(input, feePolicy, label) {
  const policy = validateTransactionFeePolicy(feePolicy);
  const type = Number(input.type);
  const gasLimit = nonnegativeBigInt(input.gasLimit, `${label} gas limit`, {
    positive: true,
  });
  if (gasLimit > policy.maximumGasLimit) {
    throw new Error(`${label} gas limit exceeds the configured maximum`);
  }
  if (policy.transactionType === "eip1559") {
    if (type !== 2 || input.gasPrice != null) {
      throw new Error(`${label} must use an EIP-1559 transaction`);
    }
    const maxFeePerGas = nonnegativeBigInt(
      input.maxFeePerGas,
      `${label} maximum fee per gas`,
      { positive: true },
    );
    const maxPriorityFeePerGas = nonnegativeBigInt(
      input.maxPriorityFeePerGas,
      `${label} maximum priority fee per gas`,
      { positive: true },
    );
    if (
      maxFeePerGas > policy.maximumFeePerGas ||
      maxPriorityFeePerGas > policy.maximumPriorityFeePerGas ||
      maxPriorityFeePerGas > maxFeePerGas
    ) {
      throw new Error(`${label} EIP-1559 fees exceed the configured maximum`);
    }
    if (gasLimit * maxFeePerGas > policy.maximumNativeFee) {
      throw new Error(`${label} exceeds the configured maximum native fee`);
    }
    return {
      type: 2,
      gasLimit,
      gasPrice: null,
      maxFeePerGas,
      maxPriorityFeePerGas,
    };
  }
  if (
    type !== 0 ||
    input.gasPrice == null ||
    input.maxFeePerGas != null ||
    input.maxPriorityFeePerGas != null
  ) {
    throw new Error(`${label} must use a legacy transaction`);
  }
  const gasPrice = nonnegativeBigInt(input.gasPrice, `${label} gas price`, {
    positive: true,
  });
  if (gasPrice > policy.maximumGasPrice) {
    throw new Error(`${label} gas price exceeds the configured maximum`);
  }
  if (gasLimit * gasPrice > policy.maximumNativeFee) {
    throw new Error(`${label} exceeds the configured maximum native fee`);
  }
  return {
    type: 0,
    gasLimit,
    gasPrice,
    maxFeePerGas: null,
    maxPriorityFeePerGas: null,
  };
}

function bytes32(value, label) {
  if (!isHexString(value, 32)) throw new Error(`Invalid ${label}`);
  return value.toLowerCase();
}

function byteLength(value, label) {
  if (!isHexString(value)) throw new Error(`Invalid ${label}`);
  return (value.length - 2) / 2;
}

function addressFromTopic(value) {
  const normalized = bytes32(value, "subject topic");
  if (BigInt(normalized) >> 160n !== 0n) return undefined;
  return getAddress(`0x${normalized.slice(-40)}`);
}

function normalizeTransactionIntent(input, signerAddress, label, feePolicy) {
  const from = getAddress(input.from ?? signerAddress);
  if (from !== signerAddress) throw new Error(`${label} signer mismatch`);
  const to = getAddress(input.to);
  const chainId = nonnegativeBigInt(input.chainId, `${label} chain ID`, {
    positive: true,
  });
  const nonce = unsignedInteger(input.nonce, `${label} nonce`);
  const data = input.data ?? "0x";
  if (!isHexString(data)) throw new Error(`Invalid ${label} calldata`);
  const value = nonnegativeBigInt(input.value ?? 0, `${label} value`);
  const intent = {
    chainId,
    from,
    to,
    nonce,
    dataHash: keccak256(data),
    value,
  };
  if (feePolicy !== undefined) {
    Object.assign(intent, normalizeTransactionFees(input, feePolicy, label));
  }
  return intent;
}

function transactionMatchesIntent(transaction, intent) {
  return Boolean(
    transaction.from &&
    transaction.to &&
    getAddress(transaction.from) === intent.from &&
    getAddress(transaction.to) === intent.to &&
    transaction.chainId === intent.chainId &&
    transaction.nonce === intent.nonce &&
    keccak256(transaction.data) === intent.dataHash &&
    transaction.value === intent.value &&
    (intent.type === undefined ||
      (Number(transaction.type) === intent.type &&
        transaction.gasLimit === intent.gasLimit &&
        (intent.type === 2
          ? transaction.gasPrice == null &&
            transaction.maxFeePerGas === intent.maxFeePerGas &&
            transaction.maxPriorityFeePerGas === intent.maxPriorityFeePerGas
          : transaction.gasPrice === intent.gasPrice &&
            transaction.maxFeePerGas == null &&
            transaction.maxPriorityFeePerGas == null))),
  );
}

export function atomicWriteJson(path, value) {
  const target = resolve(path);
  const temporary = `${target}.${process.pid}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(
      descriptor,
      `${JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item), 2)}\n`,
      "utf8",
    );
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, target);
    if (process.platform === "linux") {
      const directory = openSync(dirname(target), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

export function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

export function acquireProcessLock(path, metadata = {}) {
  const target = resolve(path);
  const token = randomUUID();
  const record = {
    schemaVersion: 1,
    pid: process.pid,
    token,
    startedAt: new Date().toISOString(),
    ...metadata,
  };
  let descriptor;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = openSync(target, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      fsyncSync(descriptor);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        if (descriptor !== undefined) {
          closeSync(descriptor);
          descriptor = undefined;
          if (existsSync(target)) unlinkSync(target);
        }
        throw error;
      }
      const existingText = readFileSync(target, "utf8");
      let existing;
      try {
        existing = JSON.parse(existingText);
      } catch {
        throw new Error(
          `Operator lock at ${target} is unreadable; refusing to steal it`,
        );
      }
      if (
        existing?.schemaVersion !== 1 ||
        !Number.isSafeInteger(existing.pid) ||
        existing.pid <= 0 ||
        typeof existing.token !== "string"
      ) {
        throw new Error(
          `Operator lock at ${target} is invalid; refusing to steal it`,
        );
      }
      try {
        process.kill(existing.pid, 0);
        throw new Error(`Operator lock already exists at ${target}`);
      } catch (probeError) {
        if (probeError?.code !== "ESRCH") throw probeError;
      }
      if (readFileSync(target, "utf8") !== existingText) {
        throw new Error(
          `Operator lock at ${target} changed during stale-lock recovery`,
        );
      }
      const stalePath = `${target}.stale.${existing.pid}.${existing.token}`;
      renameSync(target, stalePath);
      unlinkSync(stalePath);
    }
  }
  if (descriptor === undefined)
    throw new Error(`Unable to acquire operator lock at ${target}`);
  let released = false;
  return {
    path: target,
    release() {
      if (released) return;
      released = true;
      closeSync(descriptor);
      if (!existsSync(target)) return;
      const current = JSON.parse(readFileSync(target, "utf8"));
      if (current.token !== token) {
        throw new Error(`Operator lock ownership changed at ${target}`);
      }
      unlinkSync(target);
    },
  };
}

export function normalizeAllowlist(values, label, normalize = String) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${label} allowlist must not be empty`);
  }
  return new Set(values.map((value) => normalize(value)));
}

export function validateExecutionPolicy(policy) {
  const targetConfirmations = unsignedInteger(
    policy?.targetConfirmations,
    "target confirmations",
  );
  const recoveryBlocks = unsignedInteger(
    policy?.recoveryBlocks,
    "recovery blocks",
  );
  const minRevealWindowBlocks = unsignedInteger(
    policy?.minRevealWindowBlocks,
    "minimum reveal window",
  );
  if (
    targetConfirmations === 0 ||
    recoveryBlocks === 0 ||
    minRevealWindowBlocks < targetConfirmations + recoveryBlocks
  ) {
    throw new Error(
      "Minimum reveal window must cover target confirmations and recovery blocks",
    );
  }
  const minSecondsToExpiry = unsignedInteger(
    policy?.minSecondsToExpiry,
    "minimum seconds to expiry",
  );
  if (minSecondsToExpiry === 0) {
    throw new Error("Invalid minimum seconds to expiry");
  }
  const maxCommitBond = nonnegativeBigInt(
    policy?.maxCommitBond,
    "maximum commit bond",
    { positive: true },
  );
  const minProofReimbursement = nonnegativeBigInt(
    policy?.minProofReimbursement,
    "minimum proof reimbursement",
    { positive: true },
  );
  const minRewardToBondBps = unsignedInteger(
    policy?.minRewardToBondBps,
    "minimum reward-to-bond ratio",
  );
  if (minRewardToBondBps === 0) {
    throw new Error("Invalid minimum reward-to-bond ratio");
  }
  if (policy?.exclusiveSigner !== true) {
    throw new Error("Execution requires an exclusive signer policy");
  }
  const feePolicy = validateTransactionFeePolicy(policy?.feePolicy);
  return {
    targetConfirmations,
    recoveryBlocks,
    minRevealWindowBlocks,
    minSecondsToExpiry,
    maxCommitBond,
    minProofReimbursement,
    minRewardToBondBps,
    feePolicy,
    exclusiveSigner: true,
  };
}

export function validateOperatorConfig(config) {
  if (!config || config.schemaVersion !== 1) {
    throw new Error("Invalid operator configuration version");
  }
  const execution = config.execution === "enabled" ? "enabled" : "read-only";
  if (config.execution !== execution) {
    throw new Error("Execution must be 'read-only' or 'enabled'");
  }
  const facilities = normalizeAllowlist(
    config.allowlists?.facilities,
    "Facility",
    (value) => getAddress(value),
  );
  const policyIds = normalizeAllowlist(
    config.allowlists?.policyIds,
    "Policy",
    (value) => BigInt(value).toString(),
  );
  const tokens = normalizeAllowlist(
    config.allowlists?.tokens,
    "Token",
    (value) => getAddress(value),
  );
  const sourceChains = normalizeAllowlist(
    config.allowlists?.sourceChains,
    "Source chain",
    (value) => BigInt(value).toString(),
  );
  if (
    [...sourceChains].some(
      (sourceChain) => sourceChain !== "1" && sourceChain !== "3",
    )
  ) {
    throw new Error(
      "This operator supports only CC3 source chain keys 1 and 3",
    );
  }
  const pollIntervalMs = unsignedInteger(
    config.pollIntervalMs,
    "poll interval",
  );
  const maxBackoffMs = unsignedInteger(config.maxBackoffMs, "maximum backoff");
  if (pollIntervalMs < 1_000 || maxBackoffMs < pollIntervalMs) {
    throw new Error("Invalid operator polling bounds");
  }
  const maxSourceBlocksPerPoll = unsignedInteger(
    config.maxSourceBlocksPerPoll,
    "source scan size",
  );
  if (maxSourceBlocksPerPoll === 0) throw new Error("Invalid source scan size");
  const executionPolicy = validateExecutionPolicy({
    targetConfirmations: config.targetConfirmations,
    recoveryBlocks: config.recoveryBlocks,
    minRevealWindowBlocks: config.economics?.minRevealWindowBlocks,
    minSecondsToExpiry: config.economics?.minSecondsToExpiry,
    maxCommitBond: config.economics?.maxCommitBond,
    minProofReimbursement: config.economics?.minProofReimbursement,
    minRewardToBondBps: config.economics?.minRewardToBondBps,
    feePolicy: config.transactionPolicy?.feePolicy,
    exclusiveSigner: execution === "enabled" ? config.exclusiveSigner : true,
  });
  return {
    execution,
    facilities,
    policyIds,
    tokens,
    sourceChains,
    pollIntervalMs,
    maxBackoffMs,
    maxSourceBlocksPerPoll,
    ...executionPolicy,
    exclusiveSigner: config.exclusiveSigner === true,
  };
}

export function assertJobEconomics(job, config, currentTimestamp) {
  const commitBond = nonnegativeBigInt(job.commitBond, "job commit bond", {
    positive: true,
  });
  const proofReimbursement = nonnegativeBigInt(
    job.proofReimbursement,
    "job proof reimbursement",
    { positive: true },
  );
  const revealWindowBlocks = unsignedInteger(
    job.revealWindowBlocks,
    "job reveal window",
  );
  const expiry = nonnegativeBigInt(job.expiry, "job expiry", {
    positive: true,
  });
  const now = nonnegativeBigInt(currentTimestamp, "current timestamp");
  if (commitBond > config.maxCommitBond) {
    throw new Error("Job commit bond exceeds the configured maximum");
  }
  if (proofReimbursement < config.minProofReimbursement) {
    throw new Error("Job proof reimbursement is below the configured minimum");
  }
  if (
    (proofReimbursement * 10_000n) / commitBond <
    BigInt(config.minRewardToBondBps)
  ) {
    throw new Error("Job reward-to-bond ratio is below the configured minimum");
  }
  if (revealWindowBlocks < config.minRevealWindowBlocks) {
    throw new Error(
      "Job reveal window is below the configured recovery minimum",
    );
  }
  if (expiry <= now || expiry - now < BigInt(config.minSecondsToExpiry)) {
    throw new Error("Job expiry is inside the configured safety window");
  }
  return true;
}

export function assertCommitReady({
  job,
  policy,
  currentTimestamp,
  balance,
  allowance,
}) {
  assertJobEconomics(job, policy, currentTimestamp);
  const commitBond = nonnegativeBigInt(job.commitBond, "job commit bond", {
    positive: true,
  });
  if (nonnegativeBigInt(balance, "hunter balance") < commitBond) {
    throw new Error("Hunter balance is below the required commit bond");
  }
  if (nonnegativeBigInt(allowance, "hunter allowance") < commitBond) {
    throw new Error(
      "Confirmed bond approval did not establish the required allowance",
    );
  }
  return true;
}

export function jobAllowed(
  job,
  policy,
  allowlists,
  currentTimestamp = Math.floor(Date.now() / 1_000),
) {
  const configuration = policy?.configuration;
  const structurallyAllowed = Boolean(
    job?.state === "Open" &&
    configuration &&
    allowlists.facilities.has(getAddress(job.facility)) &&
    allowlists.policyIds.has(BigInt(job.policyId).toString()) &&
    allowlists.tokens.has(getAddress(job.token)) &&
    allowlists.sourceChains.has(BigInt(configuration.sourceChain).toString()) &&
    job.requirementsDigest.toLowerCase() === policy.configHash.toLowerCase(),
  );
  if (!structurallyAllowed) return false;
  try {
    assertJobEconomics(job, allowlists, currentTimestamp);
    return true;
  } catch {
    return false;
  }
}

export function eventLogFilter(configuration) {
  const topicCount = unsignedInteger(configuration.topicCount, "topic count");
  const subjectIndex = unsignedInteger(
    configuration.subjectTopicIndex,
    "subject topic index",
  );
  if (
    topicCount < 2 ||
    topicCount > 4 ||
    subjectIndex === 0 ||
    subjectIndex >= topicCount
  ) {
    throw new Error("Invalid policy topic configuration");
  }
  const topics = Array(topicCount).fill(null);
  topics[0] = bytes32(configuration.eventSignature, "event signature");
  topics[subjectIndex] =
    `0x${"0".repeat(24)}${getAddress(configuration.subject).slice(2).toLowerCase()}`;
  return { address: getAddress(configuration.emitter), topics };
}

export function qualifyReceipt(receipt, configuration) {
  const start = unsignedInteger(
    configuration.startSourceBlock,
    "source start block",
  );
  const end = unsignedInteger(configuration.endSourceBlock, "source end block");
  if (!receipt || receipt.status !== 1) {
    return { qualified: false, reason: "transaction reverted" };
  }
  if (receipt.blockNumber < start || receipt.blockNumber > end) {
    return { qualified: false, reason: "outside policy window" };
  }
  const emitter = getAddress(configuration.emitter);
  const subject = getAddress(configuration.subject);
  const signature = bytes32(configuration.eventSignature, "event signature");
  const topicCount = unsignedInteger(configuration.topicCount, "topic count");
  const subjectIndex = unsignedInteger(
    configuration.subjectTopicIndex,
    "subject topic index",
  );
  const expectedDataLength = unsignedInteger(
    configuration.dataLength,
    "data length",
  );
  const offset = unsignedInteger(
    configuration.observedValueOffset,
    "observed value offset",
  );
  if (offset % 32 !== 0 || offset + 32 > expectedDataLength) {
    throw new Error("Invalid observed value offset");
  }
  let observedValue = 0n;
  let matchingLogs = 0;
  for (const log of receipt.logs ?? []) {
    if (
      getAddress(log.address) !== emitter ||
      log.topics.length !== topicCount ||
      bytes32(log.topics[0], "log signature") !== signature ||
      byteLength(log.data, "log data") !== expectedDataLength ||
      addressFromTopic(log.topics[subjectIndex]) !== subject
    ) {
      continue;
    }
    const startIndex = 2 + offset * 2;
    const value = BigInt(`0x${log.data.slice(startIndex, startIndex + 64)}`);
    if (observedValue > UINT256_MAX - value) {
      observedValue = UINT256_MAX;
    } else {
      observedValue += value;
    }
    matchingLogs += 1;
  }
  if (matchingLogs === 0) {
    return { qualified: false, reason: "no exact policy event match" };
  }
  return { qualified: true, observedValue, matchingLogs };
}

export function nextBackoff(current, initial, maximum) {
  const base = current === undefined ? initial : current * 2;
  return Math.min(base, maximum);
}

export function validatePendingTransaction(
  pending,
  expectedKind,
  expectedIntent,
  feePolicy,
) {
  if (!pending || pending.kind !== expectedKind) {
    throw new Error(`Missing ${expectedKind} transaction journal`);
  }
  const transactionHash = bytes32(pending.transactionHash, "transaction hash");
  if (!isHexString(pending.rawTransaction)) {
    throw new Error("Invalid raw transaction journal");
  }
  if (keccak256(pending.rawTransaction) !== transactionHash) {
    throw new Error("Transaction journal hash mismatch");
  }
  const transaction = Transaction.from(pending.rawTransaction);
  const from = getAddress(pending.from);
  const to = getAddress(pending.to);
  const chainId = nonnegativeBigInt(pending.chainId, "transaction chain ID", {
    positive: true,
  });
  const nonce = unsignedInteger(pending.nonce, "transaction nonce");
  const dataHash = bytes32(pending.dataHash, "transaction calldata hash");
  const value = nonnegativeBigInt(pending.value, "transaction value");
  const fees = normalizeTransactionFees(
    pending,
    feePolicy,
    "journaled transaction",
  );
  const intent = { chainId, from, to, nonce, dataHash, value, ...fees };
  if (
    transaction.hash?.toLowerCase() !== transactionHash ||
    !transactionMatchesIntent(transaction, intent)
  ) {
    throw new Error("Signed transaction journal metadata mismatch");
  }
  if (expectedIntent) {
    const expected = normalizeTransactionIntent(
      {
        ...expectedIntent,
        nonce: expectedIntent.nonce ?? nonce,
      },
      from,
      "expected transaction",
    );
    if (
      expected.chainId !== chainId ||
      expected.from !== from ||
      expected.to !== to ||
      expected.nonce !== nonce ||
      expected.dataHash !== dataHash ||
      expected.value !== value
    ) {
      throw new OperatorIncidentError(
        `${expectedKind} transaction journal does not match its lifecycle call`,
      );
    }
  }
  return {
    ...pending,
    transactionHash,
    from,
    to,
    chainId,
    nonce,
    dataHash,
    value,
    ...fees,
  };
}

export async function prepareJournaledTransaction({
  kind,
  signer,
  request,
  feePolicy,
  state,
  statePath,
}) {
  const normalizedFeePolicy = validateTransactionFeePolicy(feePolicy);
  const populated = await signer.populateTransaction({
    ...request,
    type: normalizedFeePolicy.transactionType === "eip1559" ? 2 : 0,
  });
  const signerAddress = getAddress(
    typeof signer.getAddress === "function"
      ? await signer.getAddress()
      : signer.address,
  );
  const intent = normalizeTransactionIntent(
    populated,
    signerAddress,
    "populated transaction",
    normalizedFeePolicy,
  );
  const rawTransaction = await signer.signTransaction(populated);
  const transaction = Transaction.from(rawTransaction);
  const transactionHash = transaction.hash?.toLowerCase();
  if (!transactionHash || !transactionMatchesIntent(transaction, intent)) {
    throw new Error("Signed transaction does not match the populated intent");
  }
  const journaled = {
    ...state,
    pending: {
      kind,
      transactionHash,
      rawTransaction,
      chainId: intent.chainId.toString(),
      from: intent.from,
      to: intent.to,
      nonce: intent.nonce,
      dataHash: intent.dataHash,
      value: intent.value.toString(),
      type: intent.type,
      gasLimit: intent.gasLimit.toString(),
      gasPrice: intent.gasPrice?.toString() ?? null,
      maxFeePerGas: intent.maxFeePerGas?.toString() ?? null,
      maxPriorityFeePerGas: intent.maxPriorityFeePerGas?.toString() ?? null,
    },
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJson(statePath, journaled);
  return journaled;
}

export async function reconcileJournaledTransaction({
  provider,
  state,
  statePath,
  kind,
  successPhase,
  targetConfirmations = 1,
  maxReceiptPolls = 20,
  receiptPollIntervalMs = 1_000,
  signal = new AbortController().signal,
  delay = abortableDelay,
  expectedIntent,
  feePolicy,
  beforeBroadcast = async () => {},
}) {
  const pending = validatePendingTransaction(
    state.pending,
    kind,
    expectedIntent,
    feePolicy,
  );
  const network = await provider.getNetwork();
  if (network.chainId !== pending.chainId) {
    throw new OperatorIncidentError(
      `${kind} journal chain ${pending.chainId} does not match provider chain ${network.chainId}`,
    );
  }
  targetConfirmations = unsignedInteger(
    targetConfirmations,
    "target confirmations",
  );
  maxReceiptPolls = unsignedInteger(maxReceiptPolls, "receipt poll limit");
  if (targetConfirmations === 0 || maxReceiptPolls === 0) {
    throw new Error("Invalid transaction confirmation policy");
  }
  let broadcastAttempted = false;
  let receipt;
  let canonicallyConfirmed = false;
  for (let attempt = 0; attempt < maxReceiptPolls; attempt += 1) {
    if (signal.aborted) {
      const error = new Error(
        `${kind} reconciliation stopped at a durable journal boundary`,
      );
      error.name = "AbortError";
      throw error;
    }
    receipt = await provider.getTransactionReceipt(pending.transactionHash);
    if (receipt) {
      if (
        !receipt.hash ||
        receipt.hash.toLowerCase() !== pending.transactionHash
      ) {
        throw new OperatorIncidentError(
          `${kind} transaction receipt identity does not match its journal`,
        );
      }
      if (receipt.status !== 1) {
        const error = new OperatorIncidentError(
          `${kind} transaction ${pending.transactionHash} reverted`,
        );
        error.receipt = receipt;
        throw error;
      }
      const confirmedThrough = await provider.getBlockNumber();
      const requiredBlock = receipt.blockNumber + targetConfirmations - 1;
      if (confirmedThrough >= requiredBlock) {
        const [canonicalBlock, confirmedReceipt, confirmedTransaction] =
          await Promise.all([
            provider.getBlock(receipt.blockNumber),
            provider.getTransactionReceipt(pending.transactionHash),
            provider.getTransaction(pending.transactionHash),
          ]);
        if (
          !canonicalBlock ||
          !canonicalBlock.hash ||
          !confirmedReceipt ||
          !confirmedReceipt.hash ||
          confirmedReceipt.hash.toLowerCase() !== pending.transactionHash ||
          !receipt.blockHash ||
          !confirmedReceipt.blockHash ||
          canonicalBlock.hash.toLowerCase() !==
            receipt.blockHash.toLowerCase() ||
          confirmedReceipt.blockHash.toLowerCase() !==
            receipt.blockHash.toLowerCase() ||
          confirmedReceipt.blockNumber !== receipt.blockNumber ||
          confirmedReceipt.status !== 1 ||
          !confirmedTransaction ||
          confirmedTransaction.hash?.toLowerCase() !==
            pending.transactionHash ||
          !transactionMatchesIntent(confirmedTransaction, pending)
        ) {
          throw new OperatorIncidentError(
            `${kind} transaction receipt changed before canonical confirmation`,
          );
        }
        receipt = confirmedReceipt;
        canonicallyConfirmed = true;
        break;
      }
    } else {
      const [known, confirmedNonce, pendingNonce] = await Promise.all([
        provider.getTransaction(pending.transactionHash),
        provider.getTransactionCount(pending.from, "latest"),
        provider.getTransactionCount(pending.from, "pending"),
      ]);
      if (
        !known &&
        (confirmedNonce > pending.nonce || pendingNonce > pending.nonce)
      ) {
        throw new OperatorIncidentError(
          `${kind} transaction nonce ${pending.nonce} was advanced or replaced`,
        );
      }
      if (
        known &&
        (known.hash?.toLowerCase() !== pending.transactionHash ||
          !transactionMatchesIntent(known, pending))
      ) {
        throw new OperatorIncidentError(
          `${kind} pending transaction does not match its journal`,
        );
      }
      if (!known && !broadcastAttempted) {
        await beforeBroadcast();
        await provider.broadcastTransaction(pending.rawTransaction);
        broadcastAttempted = true;
      }
    }
    await delay(receiptPollIntervalMs, signal);
  }
  if (!canonicallyConfirmed) {
    throw new Error(
      `${kind} transaction remains pending after ${maxReceiptPolls} bounded receipt polls`,
    );
  }
  const reconciled = {
    ...state,
    phase: successPhase,
    pending: null,
    [`${kind}TransactionHash`]: pending.transactionHash,
    [`${kind}Block`]: receipt.blockNumber,
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJson(statePath, reconciled);
  return { state: reconciled, receipt };
}

export function abortableDelay(milliseconds, signal) {
  return new Promise((resolvePromise) => {
    if (signal.aborted) {
      resolvePromise();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolvePromise();
    };
    const timeout = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export function operatorStatus({
  mode,
  lifecycle = "running",
  startedAt,
  stoppedAt = null,
  lastSuccessAt,
  lastError,
  jobs,
}) {
  return {
    schemaVersion: 1,
    mode,
    lifecycle,
    processId: process.pid,
    startedAt,
    stoppedAt,
    checkedAt: new Date().toISOString(),
    healthy: lifecycle === "running" && lastError === null,
    lastSuccessAt,
    lastError,
    jobs,
  };
}

export function statePathForJob(directory, chainId, jobId) {
  const safeChain = unsignedInteger(chainId, "chain ID");
  const safeJob = BigInt(jobId);
  if (safeJob <= 0n) throw new Error("Invalid job ID");
  return resolve(directory, `${safeChain}-${safeJob}.json`);
}
