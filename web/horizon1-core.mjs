const STATUS_LABELS = Object.freeze([
  "Created",
  "Active",
  "Repaid",
  "Defaulted",
  "Cancelled",
  "Terminated",
]);

const OUTCOME_LABELS = Object.freeze([
  "Eligible",
  "Watch",
  "Restricted",
  "Margin called",
  "Breached",
  "Cured",
]);
const MAX_DATE_SECONDS = 8_640_000_000_000n;
const EVENT_QUERY_BLOCKS = 2_000;

export function statusLabel(status) {
  return STATUS_LABELS[Number(status)] ?? "Unknown";
}

export function outcomeLabel(outcome, applied = true) {
  if (!applied) return "Awaiting evidence";
  return OUTCOME_LABELS[Number(outcome)] ?? "Unknown";
}

export function normalizeTokenSymbol(symbol) {
  return typeof symbol === "string" && /^[A-Za-z0-9._-]{1,16}$/.test(symbol)
    ? symbol
    : "TOKEN";
}

export function createLatestAsyncRunner() {
  let generation = 0;
  return async function runLatest(load, { success, failure }) {
    const requestGeneration = ++generation;
    try {
      const value = await load();
      if (requestGeneration !== generation) return false;
      success(value);
      return true;
    } catch (error) {
      if (requestGeneration !== generation) return false;
      failure(error);
      return true;
    }
  };
}

export function createCompletionPollingLoop(run, schedule, delay) {
  async function poll() {
    try {
      await run();
    } finally {
      schedule(poll, delay);
    }
  }
  return poll;
}

export function formatUnixTimestamp(value) {
  const seconds = BigInt(value);
  if (seconds === 0n) return "Not constrained";
  if (seconds < 0n || seconds > MAX_DATE_SECONDS) {
    return `Unix ${seconds} (outside JavaScript Date range)`;
  }
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(Number(seconds) * 1000));
}

export function registeredPolicyIds(events) {
  const ordered = [...events].sort((left, right) => {
    if (left.blockNumber !== right.blockNumber) {
      return left.blockNumber - right.blockNumber;
    }
    if (left.transactionIndex !== right.transactionIndex) {
      return left.transactionIndex - right.transactionIndex;
    }
    return left.index - right.index;
  });
  const seen = new Set();
  const policyIds = [];
  for (const event of ordered) {
    const policyId = BigInt(event.args.policyId);
    const key = policyId.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    policyIds.push(policyId);
  }
  return policyIds;
}

export function createdJobIds(events, facility) {
  const normalizedFacility = facility.toLowerCase();
  const ordered = [...events].sort((left, right) => {
    if (left.blockNumber !== right.blockNumber) {
      return left.blockNumber - right.blockNumber;
    }
    if (left.transactionIndex !== right.transactionIndex) {
      return left.transactionIndex - right.transactionIndex;
    }
    return left.index - right.index;
  });
  const seen = new Set();
  const jobIds = [];
  for (const event of ordered) {
    if (event.args.facility.toLowerCase() !== normalizedFacility) continue;
    const jobId = BigInt(event.args.jobId);
    const key = jobId.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    jobIds.push(jobId);
  }
  return jobIds;
}

export async function queryFilterInBlockPages(
  contract,
  filter,
  fromBlock,
  toBlock,
  concurrency = 1,
) {
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new Error("Event query concurrency must be a positive safe integer.");
  }
  const ranges = [];
  for (
    let pageStart = fromBlock;
    pageStart <= toBlock;
    pageStart += EVENT_QUERY_BLOCKS
  ) {
    ranges.push([
      pageStart,
      Math.min(toBlock, pageStart + EVENT_QUERY_BLOCKS - 1),
    ]);
  }

  const events = [];
  for (let offset = 0; offset < ranges.length; offset += concurrency) {
    const pages = await Promise.all(
      ranges
        .slice(offset, offset + concurrency)
        .map(([pageStart, pageEnd]) =>
          contract.queryFilter(filter, pageStart, pageEnd),
        ),
    );
    for (const page of pages) events.push(...page);
  }
  return events;
}

export async function loadFacilityJobs(
  proofJobs,
  facility,
  deploymentBlock,
  blockTag,
) {
  const events = await queryFilterInBlockPages(
    proofJobs,
    proofJobs.filters.JobCreated(null, null, facility),
    deploymentBlock,
    blockTag,
  );
  const jobIds = createdJobIds(events, facility);
  return Promise.all(
    jobIds.map(async (jobId) => ({
      id: jobId,
      job: await proofJobs.getJob(jobId, { blockTag }),
    })),
  );
}

export function partitionFacilityCatalog(
  facilities,
  expectedKernel,
  expectedCreditState,
) {
  const normalizedKernel = expectedKernel.toLowerCase();
  const normalizedCreditState = expectedCreditState.toLowerCase();
  const supported = [];
  const unsupported = [];
  for (const facility of facilities) {
    const destination =
      facility.kernel.toLowerCase() === normalizedKernel &&
      facility.creditState?.toLowerCase() === normalizedCreditState
        ? supported
        : unsupported;
    destination.push(facility);
  }
  return { supported, unsupported };
}

export function formatBaseUnits(value, decimals, displayDecimals = 2) {
  const amount = BigInt(value);
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const fraction = amount % scale;
  const shown = Math.min(displayDecimals, decimals);
  if (shown === 0) return whole.toLocaleString("en-US");

  const fractionText = fraction
    .toString()
    .padStart(decimals, "0")
    .slice(0, shown);
  return `${whole.toLocaleString("en-US")}.${fractionText}`;
}

export function capacitySegments({
  facilityLimit,
  drawnPrincipal,
  availableCredit,
}) {
  const limit = BigInt(facilityLimit);
  if (limit === 0n) {
    return { drawnBps: 0, availableBps: 0, frozenBps: 0 };
  }

  const drawn = BigInt(drawnPrincipal);
  const available = BigInt(availableCredit);
  const drawnBps = Number((drawn * 10_000n) / limit);
  const availableBps = Number((available * 10_000n) / limit);
  return {
    drawnBps,
    availableBps,
    frozenBps: Math.max(0, 10_000 - drawnBps - availableBps),
  };
}
