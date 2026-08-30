import { getAddress } from "ethers";

const OPERATOR_EVENTS = new Set([
  "EvidenceCommitted",
  "ProofAccepted",
  "ProcessedProofReleased",
  "CommitmentSlashed",
  "CommitmentReleased",
]);

function eventPosition(event) {
  return [event.blockNumber, event.transactionIndex, event.logIndex];
}

function compareEvents(left, right) {
  const leftPosition = eventPosition(left);
  const rightPosition = eventPosition(right);
  for (let index = 0; index < leftPosition.length; index += 1) {
    if (leftPosition[index] !== rightPosition[index]) {
      return leftPosition[index] - rightPosition[index];
    }
  }
  return left.transactionHash.localeCompare(right.transactionHash);
}

function eventKey(event) {
  return `${event.blockHash.toLowerCase()}:${event.transactionHash.toLowerCase()}:${event.logIndex}`;
}

function ratio(numerator, denominator) {
  return {
    numerator,
    denominator,
    value: denominator === 0 ? null : numerator / denominator,
  };
}

export function summarizeDistribution(values) {
  if (values.length === 0) {
    return {
      count: 0,
      minimum: null,
      maximum: null,
      average: null,
    };
  }
  let total = 0;
  let minimum = values[0];
  let maximum = values[0];
  for (const value of values) {
    total += value;
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
  }
  return {
    count: values.length,
    minimum,
    maximum,
    average: total / values.length,
  };
}

function emptyDistributionCheckpoint() {
  return { count: 0, total: 0, minimum: null, maximum: null };
}

function addDistributionValue(distribution, value) {
  if (!Number.isSafeInteger(value)) {
    throw new Error("Invalid metric distribution value");
  }
  distribution.count += 1;
  distribution.total += value;
  distribution.minimum =
    distribution.minimum === null
      ? value
      : Math.min(distribution.minimum, value);
  distribution.maximum =
    distribution.maximum === null
      ? value
      : Math.max(distribution.maximum, value);
}

function distributionFromCheckpoint(distribution) {
  return {
    count: distribution.count,
    minimum: distribution.minimum,
    maximum: distribution.maximum,
    average:
      distribution.count === 0 ? null : distribution.total / distribution.count,
  };
}

function count(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function jobId(value, label) {
  const string = String(value);
  let parsed;
  try {
    parsed = BigInt(string);
  } catch {
    throw new Error(`Invalid ${label}`);
  }
  if (parsed <= 0n || parsed.toString() !== string) {
    throw new Error(`Invalid ${label}`);
  }
  return string;
}

function loadDistributionCheckpoint(value, label) {
  if (!value || typeof value !== "object") throw new Error(`Invalid ${label}`);
  const loaded = {
    count: count(value.count, `${label} count`),
    total: value.total,
    minimum: value.minimum,
    maximum: value.maximum,
  };
  if (!Number.isFinite(loaded.total)) throw new Error(`Invalid ${label} total`);
  if (loaded.count === 0) {
    if (
      loaded.total !== 0 ||
      loaded.minimum !== null ||
      loaded.maximum !== null
    ) {
      throw new Error(`Invalid ${label} empty distribution`);
    }
  } else if (
    !Number.isSafeInteger(loaded.minimum) ||
    !Number.isSafeInteger(loaded.maximum) ||
    loaded.minimum > loaded.maximum
  ) {
    throw new Error(`Invalid ${label} range`);
  }
  return loaded;
}

function emptyMetricState() {
  return {
    jobs: new Map(),
    operators: new Map(),
    commitments: 0,
    acceptedProofs: 0,
    processedProofReleases: 0,
    slashes: 0,
    releases: 0,
    commitLatencyBlocks: emptyDistributionCheckpoint(),
    commitLatencySeconds: emptyDistributionCheckpoint(),
  };
}

function emptyMetricOperator(operator) {
  return {
    operator,
    jobsCovered: new Set(),
    commitments: 0,
    acceptedProofs: 0,
    processedProofReleases: 0,
    slashes: 0,
    releases: 0,
    responseLatencyBlocks: emptyDistributionCheckpoint(),
    responseLatencySeconds: emptyDistributionCheckpoint(),
  };
}

function loadMetricState(checkpoint) {
  if (checkpoint === undefined) return emptyMetricState();
  if (!checkpoint || checkpoint.version !== 1) {
    throw new Error("Invalid metric checkpoint version");
  }
  if (!Array.isArray(checkpoint.jobs) || !Array.isArray(checkpoint.operators)) {
    throw new Error("Invalid metric checkpoint collections");
  }
  const state = emptyMetricState();
  for (const stored of checkpoint.jobs) {
    const id = jobId(stored?.jobId, "metric checkpoint job ID");
    if (state.jobs.has(id)) throw new Error("Duplicate metric checkpoint job");
    if (
      !Number.isSafeInteger(stored.blockNumber) ||
      stored.blockNumber < 0 ||
      (stored.timestamp !== null &&
        (!Number.isSafeInteger(stored.timestamp) || stored.timestamp < 0)) ||
      typeof stored.covered !== "boolean" ||
      typeof stored.completed !== "boolean"
    ) {
      throw new Error("Invalid metric checkpoint job");
    }
    state.jobs.set(id, { ...stored, jobId: id });
  }
  for (const stored of checkpoint.operators) {
    const operator = getAddress(stored?.operator);
    if (state.operators.has(operator)) {
      throw new Error("Duplicate metric checkpoint operator");
    }
    if (!Array.isArray(stored.jobsCovered)) {
      throw new Error("Invalid metric checkpoint operator jobs");
    }
    const jobsCovered = new Set(
      stored.jobsCovered.map((id) =>
        jobId(id, "metric checkpoint covered job ID"),
      ),
    );
    if (
      jobsCovered.size !== stored.jobsCovered.length ||
      [...jobsCovered].some((id) => !state.jobs.has(id))
    ) {
      throw new Error("Invalid metric checkpoint operator coverage");
    }
    state.operators.set(operator, {
      operator,
      jobsCovered,
      commitments: count(stored.commitments, "operator commitments"),
      acceptedProofs: count(stored.acceptedProofs, "operator proofs"),
      processedProofReleases: count(
        stored.processedProofReleases,
        "operator processed releases",
      ),
      slashes: count(stored.slashes, "operator slashes"),
      releases: count(stored.releases, "operator releases"),
      responseLatencyBlocks: loadDistributionCheckpoint(
        stored.responseLatencyBlocks,
        "operator block latency",
      ),
      responseLatencySeconds: loadDistributionCheckpoint(
        stored.responseLatencySeconds,
        "operator time latency",
      ),
    });
  }
  state.commitments = count(checkpoint.commitments, "checkpoint commitments");
  state.acceptedProofs = count(checkpoint.acceptedProofs, "checkpoint proofs");
  state.processedProofReleases = count(
    checkpoint.processedProofReleases,
    "checkpoint processed releases",
  );
  state.slashes = count(checkpoint.slashes, "checkpoint slashes");
  state.releases = count(checkpoint.releases, "checkpoint releases");
  state.commitLatencyBlocks = loadDistributionCheckpoint(
    checkpoint.commitLatencyBlocks,
    "checkpoint block latency",
  );
  state.commitLatencySeconds = loadDistributionCheckpoint(
    checkpoint.commitLatencySeconds,
    "checkpoint time latency",
  );
  return state;
}

function serializeMetricState(state) {
  const orderedJobs = [...state.jobs.values()].sort((left, right) =>
    BigInt(left.jobId) < BigInt(right.jobId) ? -1 : 1,
  );
  const orderedOperators = [...state.operators.values()]
    .sort((left, right) => left.operator.localeCompare(right.operator))
    .map((operator) => ({
      operator: operator.operator,
      jobsCovered: [...operator.jobsCovered].sort((left, right) =>
        BigInt(left) < BigInt(right) ? -1 : 1,
      ),
      commitments: operator.commitments,
      acceptedProofs: operator.acceptedProofs,
      processedProofReleases: operator.processedProofReleases,
      slashes: operator.slashes,
      releases: operator.releases,
      responseLatencyBlocks: operator.responseLatencyBlocks,
      responseLatencySeconds: operator.responseLatencySeconds,
    }));
  return {
    version: 1,
    jobs: orderedJobs,
    operators: orderedOperators,
    commitments: state.commitments,
    acceptedProofs: state.acceptedProofs,
    processedProofReleases: state.processedProofReleases,
    slashes: state.slashes,
    releases: state.releases,
    commitLatencyBlocks: state.commitLatencyBlocks,
    commitLatencySeconds: state.commitLatencySeconds,
  };
}

export async function mapInBatches(values, batchSize, mapper) {
  count(batchSize, "batch size");
  if (batchSize === 0) throw new Error("Invalid batch size");
  const results = [];
  for (let offset = 0; offset < values.length; offset += batchSize) {
    results.push(
      ...(await Promise.all(
        values
          .slice(offset, offset + batchSize)
          .map((value, index) => mapper(value, offset + index)),
      )),
    );
  }
  return results;
}

export function retainRecentEvents(
  previousEvents,
  newEvents,
  limit,
  previouslyTruncated,
) {
  count(limit, "event retention limit");
  if (limit === 0) throw new Error("Invalid event retention limit");
  const ordered = sortAndDedupeEvents([...previousEvents, ...newEvents]);
  const truncated = previouslyTruncated || ordered.length > limit;
  return {
    events: ordered.length > limit ? ordered.slice(-limit) : ordered,
    truncated,
  };
}

export function sortAndDedupeEvents(events) {
  const unique = new Map();
  for (const event of events) {
    if (!Number.isSafeInteger(event.blockNumber) || event.blockNumber < 0) {
      throw new Error("Invalid event block number");
    }
    if (
      !Number.isSafeInteger(event.transactionIndex) ||
      event.transactionIndex < 0
    ) {
      throw new Error("Invalid event transaction index");
    }
    if (!Number.isSafeInteger(event.logIndex) || event.logIndex < 0) {
      throw new Error("Invalid event log index");
    }
    if (!event.blockHash || !event.transactionHash) {
      throw new Error("Event is missing its canonical chain position");
    }
    const normalized = { ...event, jobId: String(event.jobId) };
    if (event.operator) normalized.operator = getAddress(event.operator);
    else delete normalized.operator;
    const key = eventKey(normalized);
    if (!unique.has(key)) unique.set(key, normalized);
  }
  return [...unique.values()].sort(compareEvents);
}

export function updateMetricCheckpoint(checkpoint, inputEvents) {
  const state = loadMetricState(checkpoint);
  const events = sortAndDedupeEvents(inputEvents);
  for (const event of events) {
    if (event.name !== "JobCreated" || state.jobs.has(event.jobId)) continue;
    state.jobs.set(event.jobId, {
      jobId: event.jobId,
      blockNumber: event.blockNumber,
      timestamp: Number.isSafeInteger(event.timestamp) ? event.timestamp : null,
      covered: false,
      completed: false,
    });
  }
  for (const event of events) {
    let operator;
    if (OPERATOR_EVENTS.has(event.name)) {
      if (!event.operator) throw new Error(`${event.name} has no operator`);
      if (!state.operators.has(event.operator)) {
        state.operators.set(
          event.operator,
          emptyMetricOperator(event.operator),
        );
      }
      operator = state.operators.get(event.operator);
    }
    const job = state.jobs.get(event.jobId);
    if (event.name === "EvidenceCommitted") {
      state.commitments += 1;
      operator.commitments += 1;
      if (!job) continue;
      if (!job.covered) {
        job.covered = true;
        addDistributionValue(
          state.commitLatencyBlocks,
          event.blockNumber - job.blockNumber,
        );
        if (
          Number.isSafeInteger(event.timestamp) &&
          Number.isSafeInteger(job.timestamp)
        ) {
          addDistributionValue(
            state.commitLatencySeconds,
            event.timestamp - job.timestamp,
          );
        }
      }
      if (!operator.jobsCovered.has(event.jobId)) {
        operator.jobsCovered.add(event.jobId);
        addDistributionValue(
          operator.responseLatencyBlocks,
          event.blockNumber - job.blockNumber,
        );
        if (
          Number.isSafeInteger(event.timestamp) &&
          Number.isSafeInteger(job.timestamp)
        ) {
          addDistributionValue(
            operator.responseLatencySeconds,
            event.timestamp - job.timestamp,
          );
        }
      }
    } else if (event.name === "ProofAccepted") {
      state.acceptedProofs += 1;
      operator.acceptedProofs += 1;
    } else if (event.name === "ProcessedProofReleased") {
      state.processedProofReleases += 1;
      operator.processedProofReleases += 1;
    } else if (event.name === "CommitmentSlashed") {
      state.slashes += 1;
      operator.slashes += 1;
    } else if (event.name === "CommitmentReleased") {
      state.releases += 1;
      operator.releases += 1;
    } else if (event.name === "JobFinalized" && job) {
      job.completed = true;
    }
  }
  return serializeMetricState(state);
}

export function metricsFromCheckpoint(checkpoint) {
  const state = loadMetricState(checkpoint);
  const jobsCreated = state.jobs.size;
  const jobsCovered = [...state.jobs.values()].filter(
    ({ covered }) => covered,
  ).length;
  const completedJobs = [...state.jobs.values()].filter(
    ({ completed }) => completed,
  ).length;
  const validReveals = state.acceptedProofs + state.processedProofReleases;
  return {
    jobsCreated,
    jobsCovered,
    coverage: ratio(jobsCovered, jobsCreated),
    commitments: state.commitments,
    acceptedProofs: state.acceptedProofs,
    processedProofReleases: state.processedProofReleases,
    validReveals,
    acceptedValidRevealRate: ratio(state.acceptedProofs, validReveals),
    completedJobs,
    completionRate: ratio(completedJobs, jobsCreated),
    slashes: state.slashes,
    releases: state.releases,
    commitLatencyBlocks: distributionFromCheckpoint(state.commitLatencyBlocks),
    commitLatencySeconds: distributionFromCheckpoint(
      state.commitLatencySeconds,
    ),
    operators: [...state.operators.values()]
      .sort((left, right) => left.operator.localeCompare(right.operator))
      .map((operator) => {
        const operatorValidReveals =
          operator.acceptedProofs + operator.processedProofReleases;
        return {
          operator: operator.operator,
          jobsCovered: operator.jobsCovered.size,
          coverage: ratio(operator.jobsCovered.size, jobsCreated),
          commitments: operator.commitments,
          acceptedProofs: operator.acceptedProofs,
          processedProofReleases: operator.processedProofReleases,
          validReveals: operatorValidReveals,
          acceptedValidRevealRate: ratio(
            operator.acceptedProofs,
            operatorValidReveals,
          ),
          slashes: operator.slashes,
          releases: operator.releases,
          responseLatencyBlocks: distributionFromCheckpoint(
            operator.responseLatencyBlocks,
          ),
          responseLatencySeconds: distributionFromCheckpoint(
            operator.responseLatencySeconds,
          ),
        };
      }),
  };
}

export function deriveOperatorMetrics(inputEvents) {
  return metricsFromCheckpoint(updateMetricCheckpoint(undefined, inputEvents));
}

export function buildDiscoveryReport({
  chainId,
  contractAddress,
  fromBlock,
  toBlock,
  historyFromBlock = fromBlock,
  stateBlock = null,
  historyComplete = false,
  eventsTruncated = false,
  confirmations,
  events,
  jobs,
  policies,
  metrics,
}) {
  const orderedEvents = sortAndDedupeEvents(events);
  return {
    schemaVersion: 2,
    chainId: Number(chainId),
    proofJobs: getAddress(contractAddress),
    scan: {
      fromBlock,
      toBlock,
      historyFromBlock,
      stateBlock,
      historyComplete,
      eventsTruncated,
      eventsFromBlock: orderedEvents[0]?.blockNumber ?? null,
      confirmations,
    },
    events: orderedEvents,
    jobs: [...jobs].sort((left, right) =>
      BigInt(left.jobId) === BigInt(right.jobId)
        ? 0
        : BigInt(left.jobId) < BigInt(right.jobId)
          ? -1
          : 1,
    ),
    policies: [...policies].sort((left, right) => {
      const facility = left.facility.localeCompare(right.facility);
      if (facility !== 0) return facility;
      return BigInt(left.policyId) === BigInt(right.policyId)
        ? 0
        : BigInt(left.policyId) < BigInt(right.policyId)
          ? -1
          : 1;
    }),
    metrics: metrics ?? deriveOperatorMetrics(orderedEvents),
    limitations: [
      "Reverted invalid or irrelevant reveals emit no event, so this report does not claim an invalid-proof count or false-positive rate.",
      "ProcessedProofReleased proves only that a valid proof had already been processed; it is not counted as an accepted proof.",
      "Coverage means at least one observed commitment for a job whose creation is present in the retained history range; it is not an uptime or censorship claim.",
      ...(!historyComplete
        ? [
            "The retained history starts after contract deployment, so lifecycle rates exclude jobs whose creation is not present and do not describe complete contract history.",
          ]
        : []),
      ...(eventsTruncated
        ? [
            "The events array is a bounded recent event window; cumulative metrics come from the validated checkpoint and include earlier scanned events.",
          ]
        : []),
      "No quotes, costs, reputation, profitability, or operator economics are inferred from these events.",
    ],
  };
}
