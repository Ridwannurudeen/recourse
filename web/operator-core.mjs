const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const JOB_STATES = new Set([
  "Open",
  "OutcomeReached",
  "AttemptsExhausted",
  "Expired",
]);
const EVENT_NAMES = new Set([
  "JobCreated",
  "EvidenceCommitted",
  "ProofAccepted",
  "ProcessedProofReleased",
  "JobFinalized",
  "CommitmentSlashed",
]);

export const MAX_OPERATOR_REPORT_BYTES = 1_000_000;
const LIMITS = Object.freeze({
  jobs: 500,
  policies: 500,
  events: 1_000,
  operators: 500,
  limitations: 32,
  limitationLength: 512,
});

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`Invalid ${label}`);
  return value;
}

function array(value, label, maximum) {
  if (!Array.isArray(value) || value.length > maximum)
    throw new TypeError(`Invalid ${label}`);
  return value;
}

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`Invalid ${label}`);
  return value;
}

function decimal(value, label) {
  if (typeof value !== "string" || !DECIMAL.test(value))
    throw new TypeError(`Invalid ${label}`);
  return value;
}

function address(value, label) {
  if (typeof value !== "string" || !ADDRESS.test(value))
    throw new TypeError(`Invalid ${label}`);
  return value;
}

function bytes32(value, label) {
  if (typeof value !== "string" || !BYTES32.test(value))
    throw new TypeError(`Invalid ${label}`);
  return value;
}

function ratio(value, label, numerator, denominator) {
  const result = object(value, label);
  count(result.numerator, `${label}.numerator`);
  count(result.denominator, `${label}.denominator`);
  if (result.numerator !== numerator || result.denominator !== denominator)
    throw new TypeError(`Inconsistent ${label}`);
  const expected = denominator === 0 ? null : numerator / denominator;
  if (
    result.value !== expected &&
    !(
      typeof result.value === "number" &&
      expected !== null &&
      Math.abs(result.value - expected) < Number.EPSILON
    )
  ) {
    throw new TypeError(`Inconsistent ${label}.value`);
  }
}

function distribution(value, label) {
  const result = object(value, label);
  count(result.count, `${label}.count`);
  if (result.count === 0) {
    if (
      result.minimum !== null ||
      result.maximum !== null ||
      result.average !== null
    )
      throw new TypeError(`Inconsistent ${label}`);
    return;
  }
  for (const key of ["minimum", "maximum", "average"]) {
    if (!Number.isFinite(result[key]) || result[key] < 0)
      throw new TypeError(`Invalid ${label}.${key}`);
  }
  if (
    result.minimum > result.maximum ||
    result.average < result.minimum ||
    result.average > result.maximum
  )
    throw new TypeError(`Inconsistent ${label}`);
}

function validateOperator(operator, index, jobsCreated) {
  const label = `metrics.operators[${index}]`;
  object(operator, label);
  address(operator.operator, `${label}.operator`);
  for (const key of [
    "jobsCovered",
    "commitments",
    "acceptedProofs",
    "processedProofReleases",
    "validReveals",
    "slashes",
    "releases",
  ])
    count(operator[key], `${label}.${key}`);
  if (
    operator.jobsCovered > jobsCreated ||
    operator.validReveals !==
      operator.acceptedProofs + operator.processedProofReleases
  )
    throw new TypeError(`Inconsistent ${label}`);
  ratio(
    operator.coverage,
    `${label}.coverage`,
    operator.jobsCovered,
    jobsCreated,
  );
  ratio(
    operator.acceptedValidRevealRate,
    `${label}.acceptedValidRevealRate`,
    operator.acceptedProofs,
    operator.validReveals,
  );
  distribution(
    operator.responseLatencyBlocks,
    `${label}.responseLatencyBlocks`,
  );
  distribution(
    operator.responseLatencySeconds,
    `${label}.responseLatencySeconds`,
  );
}

export function validateOperatorReport(
  value,
  {
    now = Date.now(),
    staleAfterSeconds = 300,
    futureToleranceSeconds = 120,
  } = {},
) {
  const report = object(value, "operator report");
  if (report.schemaVersion !== 3)
    throw new TypeError("Unsupported operator report schema");
  if (typeof report.generatedAt !== "string" || report.generatedAt.length > 64)
    throw new TypeError("Invalid generatedAt");
  const generatedAt = Date.parse(report.generatedAt);
  if (
    !Number.isFinite(generatedAt) ||
    new Date(generatedAt).toISOString() !== report.generatedAt
  )
    throw new TypeError("Invalid generatedAt");
  if (!Number.isSafeInteger(report.chainId) || report.chainId <= 0)
    throw new TypeError("Invalid chainId");
  address(report.proofJobs, "proofJobs");
  const scan = object(report.scan, "scan");
  count(scan.fromBlock, "scan.fromBlock");
  if (!Number.isSafeInteger(scan.toBlock) || scan.toBlock < -1)
    throw new TypeError("Invalid scan.toBlock");
  count(scan.historyFromBlock, "scan.historyFromBlock");
  count(scan.stateBlock, "scan.stateBlock");
  bytes32(scan.stateBlockHash, "scan.stateBlockHash");
  count(scan.stateBlockTimestamp, "scan.stateBlockTimestamp");
  count(scan.confirmations, "scan.confirmations");
  if (
    typeof scan.historyComplete !== "boolean" ||
    typeof scan.eventsTruncated !== "boolean" ||
    (scan.eventsFromBlock !== null &&
      (!Number.isSafeInteger(scan.eventsFromBlock) || scan.eventsFromBlock < 0))
  )
    throw new TypeError("Invalid scan coverage fields");
  if (
    scan.historyFromBlock > scan.fromBlock ||
    scan.toBlock > scan.stateBlock ||
    (scan.toBlock >= 0 && scan.fromBlock > scan.toBlock)
  )
    throw new TypeError("Inconsistent scan range");

  const jobs = array(report.jobs, "jobs", LIMITS.jobs);
  const policies = array(report.policies, "policies", LIMITS.policies);
  const events = array(report.events, "events", LIMITS.events);
  const limitations = array(
    report.limitations,
    "limitations",
    LIMITS.limitations,
  );
  const metrics = object(report.metrics, "metrics");
  limitations.forEach((limitation, index) => {
    if (
      typeof limitation !== "string" ||
      limitation.length === 0 ||
      limitation.length > LIMITS.limitationLength
    )
      throw new TypeError(`Invalid limitations[${index}]`);
  });
  jobs.forEach((job, index) => {
    const label = `jobs[${index}]`;
    object(job, label);
    decimal(job.jobId, `${label}.jobId`);
    address(job.facility, `${label}.facility`);
    address(job.token, `${label}.token`);
    decimal(job.successfulProofs, `${label}.successfulProofs`);
    decimal(job.maxSuccessfulProofs, `${label}.maxSuccessfulProofs`);
    decimal(job.escrowRemaining, `${label}.escrowRemaining`);
    if (!JOB_STATES.has(job.state))
      throw new TypeError(`Invalid ${label}.state`);
    if (BigInt(job.successfulProofs) > BigInt(job.maxSuccessfulProofs))
      throw new TypeError(`Inconsistent ${label} proof count`);
  });
  policies.forEach((policy, index) => {
    const label = `policies[${index}]`;
    object(policy, label);
    address(policy.facility, `${label}.facility`);
    address(policy.evaluator, `${label}.evaluator`);
    decimal(policy.policyId, `${label}.policyId`);
  });
  events.forEach((event, index) => {
    const label = `events[${index}]`;
    object(event, label);
    if (!EVENT_NAMES.has(event.name))
      throw new TypeError(`Invalid ${label}.name`);
    decimal(event.jobId, `${label}.jobId`);
    count(event.blockNumber, `${label}.blockNumber`);
    bytes32(event.blockHash, `${label}.blockHash`);
    bytes32(event.transactionHash, `${label}.transactionHash`);
    count(event.transactionIndex, `${label}.transactionIndex`);
    count(event.logIndex, `${label}.logIndex`);
    count(event.timestamp, `${label}.timestamp`);
    if (event.operator !== undefined)
      address(event.operator, `${label}.operator`);
    if (event.blockNumber > scan.stateBlock)
      throw new TypeError(`Inconsistent ${label}.blockNumber`);
  });
  const firstEventBlock =
    events.length === 0
      ? null
      : Math.min(...events.map(({ blockNumber }) => blockNumber));
  if (scan.eventsFromBlock !== firstEventBlock)
    throw new TypeError("Inconsistent scan.eventsFromBlock");

  for (const key of [
    "jobsCreated",
    "jobsCovered",
    "commitments",
    "acceptedProofs",
    "processedProofReleases",
    "validReveals",
    "completedJobs",
    "slashes",
    "releases",
  ])
    count(metrics[key], `metrics.${key}`);
  if (
    metrics.jobsCreated !== jobs.length ||
    metrics.jobsCovered > metrics.jobsCreated ||
    metrics.completedJobs > metrics.jobsCreated ||
    metrics.validReveals !==
      metrics.acceptedProofs + metrics.processedProofReleases
  )
    throw new TypeError("Inconsistent operator metrics");
  ratio(
    metrics.coverage,
    "metrics.coverage",
    metrics.jobsCovered,
    metrics.jobsCreated,
  );
  ratio(
    metrics.acceptedValidRevealRate,
    "metrics.acceptedValidRevealRate",
    metrics.acceptedProofs,
    metrics.validReveals,
  );
  ratio(
    metrics.completionRate,
    "metrics.completionRate",
    metrics.completedJobs,
    metrics.jobsCreated,
  );
  distribution(metrics.commitLatencyBlocks, "metrics.commitLatencyBlocks");
  distribution(metrics.commitLatencySeconds, "metrics.commitLatencySeconds");
  const operators = array(
    metrics.operators,
    "metrics.operators",
    LIMITS.operators,
  );
  const operatorAddresses = new Set();
  operators.forEach((operator, index) => {
    validateOperator(operator, index, metrics.jobsCreated);
    const key = operator.operator.toLowerCase();
    if (operatorAddresses.has(key))
      throw new TypeError(`Duplicate metrics.operators[${index}].operator`);
    operatorAddresses.add(key);
  });
  for (const key of [
    "commitments",
    "acceptedProofs",
    "processedProofReleases",
    "validReveals",
    "slashes",
    "releases",
  ]) {
    const total = operators.reduce((sum, operator) => sum + operator[key], 0);
    count(total, `metrics.${key} operator sum`);
    if (total !== metrics[key])
      throw new TypeError(`Inconsistent metrics.${key}`);
  }

  if (!Number.isFinite(now) || now < 0) throw new TypeError("Invalid now");
  if (!Number.isSafeInteger(staleAfterSeconds) || staleAfterSeconds < 1)
    throw new TypeError("Invalid staleAfterSeconds");
  if (
    !Number.isSafeInteger(futureToleranceSeconds) ||
    futureToleranceSeconds < 0
  )
    throw new TypeError("Invalid futureToleranceSeconds");
  const reportAgeSeconds = Math.max(0, Math.floor((now - generatedAt) / 1_000));
  const stateAgeSeconds = Math.max(
    0,
    Math.floor(now / 1_000 - scan.stateBlockTimestamp),
  );
  const reportFuture = generatedAt > now + futureToleranceSeconds * 1_000;
  const stateFuture =
    scan.stateBlockTimestamp * 1_000 > now + futureToleranceSeconds * 1_000;
  return {
    report,
    generatedAt,
    reportAgeSeconds,
    stateAgeSeconds,
    reportFuture,
    stateFuture,
    reportStale: reportAgeSeconds > staleAfterSeconds,
    stale: stateAgeSeconds > staleAfterSeconds || stateFuture,
    partial: !scan.historyComplete,
    truncated: scan.eventsTruncated,
  };
}

export function parseOperatorReport(text, options) {
  if (typeof text !== "string") throw new TypeError("Invalid report text");
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    throw new TypeError("Operator report is not valid JSON");
  }
  return validateOperatorReport(report, options);
}

export function resolveOperatorReportUrl(locationHref, configuredPath) {
  if (typeof configuredPath !== "string" || configuredPath.length === 0)
    throw new TypeError("Invalid configured operator report path");
  const location = new URL(locationHref);
  const report = new URL(configuredPath, location);
  if (!/^https?:$/.test(report.protocol) || report.origin !== location.origin)
    throw new TypeError(
      "Operator report must use a configured same-origin path",
    );
  return report.href;
}

export async function readBoundedResponseText(
  response,
  maximumBytes = MAX_OPERATOR_REPORT_BYTES,
) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
    throw new TypeError("Invalid report response-size cap");
  const declared = response.headers?.get?.("content-length");
  if (
    declared !== null &&
    declared !== undefined &&
    (!DECIMAL.test(declared) || Number(declared) > maximumBytes)
  )
    throw new TypeError("Operator report exceeds the response-size cap");
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new TypeError("Operator report exceeds the response-size cap");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumBytes)
    throw new TypeError("Operator report exceeds the response-size cap");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function verifyConfiguredOperatorAnchor(
  validated,
  { provider, chainId, proofJobs },
) {
  const { report } = validated;
  if (
    report.chainId !== chainId ||
    report.proofJobs.toLowerCase() !== proofJobs.toLowerCase()
  )
    throw new TypeError(
      "Operator report does not match the configured deployment",
    );
  const actualChainId = Number(BigInt(await provider.send("eth_chainId", [])));
  if (actualChainId !== chainId) throw new TypeError("RPC chain ID mismatch");
  const block = await provider.getBlock(report.scan.stateBlock);
  if (!block || typeof block.hash !== "string")
    throw new TypeError("Operator report anchor block is unavailable");
  if (block.hash.toLowerCase() !== report.scan.stateBlockHash.toLowerCase())
    throw new TypeError("Operator report anchor hash does not match RPC");
  if (Number(block.timestamp) !== report.scan.stateBlockTimestamp)
    throw new TypeError("Operator report anchor timestamp does not match RPC");
  return { chainId: actualChainId, blockHash: block.hash.toLowerCase() };
}

export function summarizeOperatorReport(validated) {
  const { report } = validated;
  const openJobs = report.jobs.filter(({ state }) => state === "Open").length;
  const acceptingJobs = report.jobs.filter(
    ({ state, successfulProofs, maxSuccessfulProofs }) =>
      state === "Open" &&
      BigInt(successfulProofs) < BigInt(maxSuccessfulProofs),
  ).length;
  return {
    jobs: report.jobs.length,
    openJobs,
    acceptingJobs,
    policies: report.policies.length,
    events: report.events.length,
    operators: report.metrics.operators.length,
    commitments: report.metrics.commitments,
    acceptedProofs: report.metrics.acceptedProofs,
    completedJobs: report.metrics.completedJobs,
  };
}

export function shortHex(value, lead = 6, tail = 4) {
  if (typeof value !== "string" || value.length <= lead + tail + 1)
    return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}
