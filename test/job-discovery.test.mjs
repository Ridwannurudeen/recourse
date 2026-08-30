import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Interface, getAddress } from "ethers";
import {
  buildDiscoveryReport,
  deriveOperatorMetrics,
  mapInBatches,
  metricsFromCheckpoint,
  retainRecentEvents,
  sortAndDedupeEvents,
  summarizeDistribution,
  updateMetricCheckpoint,
} from "../daemon/job-discovery-core.mjs";
import { PROOF_JOBS_ABI, discoverProofJobs } from "../daemon/job-discovery.mjs";

const HASH = (byte) => `0x${byte.repeat(32)}`;
const JOBS = getAddress("0x0000000000000000000000000000000000000100");
const KERNEL = getAddress("0x0000000000000000000000000000000000000200");
const POLICY = getAddress("0x0000000000000000000000000000000000000300");
const TOKEN = getAddress("0x0000000000000000000000000000000000000400");
const FACILITY = getAddress("0x0000000000000000000000000000000000000500");
const SPONSOR = getAddress("0x0000000000000000000000000000000000000600");
const ALICE = getAddress("0x0000000000000000000000000000000000000a11");
const BOB = getAddress("0x0000000000000000000000000000000000000b0b");
const REQUIREMENTS = HASH("aa");

function event(
  name,
  jobId,
  operator,
  blockNumber,
  transactionIndex,
  logIndex,
  timestamp,
) {
  const result = {
    name,
    jobId: String(jobId),
    blockNumber,
    blockHash: HASH(blockNumber.toString(16).padStart(2, "0")),
    transactionHash: HASH(
      (transactionIndex + 16).toString(16).padStart(2, "0"),
    ),
    transactionIndex,
    logIndex,
    timestamp,
  };
  if (operator) result.operator = operator;
  return result;
}

test("event ordering and deduplication are deterministic", () => {
  const created = event("JobCreated", 1, undefined, 10, 0, 0, 100);
  const committed = event("EvidenceCommitted", 1, ALICE, 11, 1, 0, 112);
  assert.deepEqual(
    sortAndDedupeEvents([committed, created, { ...committed }]),
    [created, committed],
  );
});

test("operator metrics use only observable chain outcomes", () => {
  const events = [
    event("JobCreated", 1, undefined, 10, 0, 0, 100),
    event("JobCreated", 2, undefined, 20, 0, 0, 200),
    event("EvidenceCommitted", 1, ALICE, 12, 0, 0, 124),
    event("EvidenceCommitted", 1, BOB, 13, 0, 0, 136),
    event("ProofAccepted", 1, ALICE, 14, 0, 0, 148),
    event("ProcessedProofReleased", 1, BOB, 15, 0, 0, 160),
    event("JobFinalized", 1, undefined, 14, 0, 1, 148),
    event("EvidenceCommitted", 2, BOB, 22, 0, 0, 224),
    event("CommitmentSlashed", 2, BOB, 30, 0, 0, 320),
  ];
  const metrics = deriveOperatorMetrics(events);

  assert.deepEqual(metrics.coverage, {
    numerator: 2,
    denominator: 2,
    value: 1,
  });
  assert.deepEqual(metrics.commitLatencyBlocks, {
    count: 2,
    minimum: 2,
    maximum: 2,
    average: 2,
  });
  assert.deepEqual(metrics.commitLatencySeconds, {
    count: 2,
    minimum: 24,
    maximum: 24,
    average: 24,
  });
  assert.deepEqual(metrics.acceptedValidRevealRate, {
    numerator: 1,
    denominator: 2,
    value: 0.5,
  });
  assert.equal(metrics.completedJobs, 1);
  assert.deepEqual(
    metrics.operators.map((operator) => operator.operator),
    [ALICE, BOB],
  );
  assert.equal(metrics.operators[0].acceptedProofs, 1);
  assert.equal(metrics.operators[1].processedProofReleases, 1);
  assert.equal(metrics.operators[1].slashes, 1);
  assert.equal(Object.hasOwn(metrics, "invalidProofs"), false);
  assert.equal(Object.hasOwn(metrics.operators[0], "reputation"), false);
});

test("empty reports use explicit null rates instead of invented performance", () => {
  const report = buildDiscoveryReport({
    chainId: 102031,
    contractAddress: JOBS,
    fromBlock: 1,
    toBlock: 9,
    eventsTruncated: true,
    confirmations: 12,
    events: [],
    jobs: [],
    policies: [],
  });

  assert.deepEqual(report.metrics.coverage, {
    numerator: 0,
    denominator: 0,
    value: null,
  });
  assert.equal(report.metrics.commitLatencySeconds.average, null);
  assert.equal(report.scan.eventsTruncated, true);
  assert.match(report.limitations[0], /reverted/i);
  assert.match(report.limitations.join(" "), /bounded recent event window/i);
});

test("metric distributions handle histories beyond the spread argument limit", () => {
  const values = Array.from({ length: 200_000 }, (_, index) => index % 5);

  assert.deepEqual(summarizeDistribution(values), {
    count: 200_000,
    minimum: 0,
    maximum: 4,
    average: 2,
  });
});

test("partial histories never publish lifecycle numerators without observed creations", () => {
  const metrics = deriveOperatorMetrics([
    event("EvidenceCommitted", 1, ALICE, 12, 0, 0, 124),
    event("JobFinalized", 1, undefined, 14, 0, 1, 148),
  ]);

  assert.equal(metrics.jobsCovered, 0);
  assert.deepEqual(metrics.coverage, {
    numerator: 0,
    denominator: 0,
    value: null,
  });
  assert.equal(metrics.completedJobs, 0);
  assert.deepEqual(metrics.completionRate, {
    numerator: 0,
    denominator: 0,
    value: null,
  });
  assert.equal(metrics.commitments, 1);
});

test("metric checkpoints preserve exact cumulative metrics without retaining raw history", () => {
  const firstWindow = [
    event("JobCreated", 1, undefined, 10, 0, 0, 100),
    event("EvidenceCommitted", 1, ALICE, 12, 0, 0, 124),
  ];
  const secondWindow = [
    event("ProofAccepted", 1, ALICE, 14, 0, 0, 148),
    event("JobFinalized", 1, undefined, 14, 0, 1, 148),
  ];
  const firstCheckpoint = updateMetricCheckpoint(undefined, firstWindow);
  const finalCheckpoint = updateMetricCheckpoint(firstCheckpoint, secondWindow);

  assert.deepEqual(
    metricsFromCheckpoint(finalCheckpoint),
    deriveOperatorMetrics([...firstWindow, ...secondWindow]),
  );
  assert.equal(Object.hasOwn(finalCheckpoint, "events"), false);
  assert.deepEqual(
    finalCheckpoint.jobs.map(({ jobId }) => jobId),
    ["1"],
  );
});

test("recent event retention is bounded and reports truncation honestly", () => {
  const created = event("JobCreated", 1, undefined, 10, 0, 0, 100);
  const committed = event("EvidenceCommitted", 1, ALICE, 11, 0, 0, 112);
  const accepted = event("ProofAccepted", 1, ALICE, 12, 0, 0, 124);

  const retained = retainRecentEvents(
    [created, committed],
    [accepted],
    2,
    false,
  );
  assert.deepEqual(retained.events, [committed, accepted]);
  assert.equal(retained.truncated, true);
});

test("mapInBatches preserves order and caps concurrent hydration", async () => {
  let active = 0;
  let maximumActive = 0;
  const values = await mapInBatches([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await Promise.resolve();
    active -= 1;
    return value * 2;
  });

  assert.deepEqual(values, [2, 4, 6, 8, 10]);
  assert.equal(maximumActive, 2);
});

test("discovery scans only the confirmed range, hydrates state, and resumes atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-discovery-"));
  const cursorPath = join(directory, "cursor.json");
  const iface = new Interface(PROOF_JOBS_ABI);
  const encodedCreated = iface.encodeEventLog(iface.getEvent("JobCreated"), [
    1n,
    SPONSOR,
    FACILITY,
    0n,
    REQUIREMENTS,
    300n,
  ]);
  const encodedCommitted = iface.encodeEventLog(
    iface.getEvent("EvidenceCommitted"),
    [1n, ALICE, HASH("bb"), HASH("cc"), 130n],
  );
  const encodedAccepted = iface.encodeEventLog(
    iface.getEvent("ProofAccepted"),
    [1n, ALICE, 3n, 1n],
  );
  const logs = [
    {
      address: JOBS,
      ...encodedCreated,
      blockNumber: 110,
      blockHash: HASH("10"),
      transactionHash: HASH("20"),
      transactionIndex: 0,
      index: 0,
    },
    {
      address: JOBS,
      ...encodedCommitted,
      blockNumber: 120,
      blockHash: HASH("11"),
      transactionHash: HASH("21"),
      transactionIndex: 0,
      index: 0,
    },
    {
      address: JOBS,
      ...encodedAccepted,
      blockNumber: 145,
      blockHash: HASH("12"),
      transactionHash: HASH("22"),
      transactionIndex: 0,
      index: 0,
    },
  ];
  const ranges = [];
  const operations = [];
  const getJobCalls = [];
  const policyOfCalls = [];
  const configurationOfCalls = [];
  const provider = {
    getNetwork: async () => ({ chainId: 102031n }),
    getBlockNumber: async () => 150,
    getLogs: async ({ fromBlock, toBlock }) => {
      ranges.push([fromBlock, toBlock]);
      operations.push(`logs:${fromBlock}-${toBlock}`);
      return logs.filter(
        (log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock,
      );
    },
    getBlock: async (blockNumber) => {
      operations.push(`block:${blockNumber}`);
      return {
        number: blockNumber,
        hash:
          blockNumber === 110
            ? HASH("10")
            : blockNumber === 120
              ? HASH("11")
              : blockNumber === 145
                ? HASH("12")
                : blockNumber === 138
                  ? HASH("fe")
                  : HASH("fd"),
        timestamp: blockNumber * 10,
      };
    },
  };
  const jobsContract = {
    getJob: async (...args) => {
      getJobCalls.push(args);
      return {
        sponsor: SPONSOR,
        token: TOKEN,
        facility: FACILITY,
        policyId: 0n,
        requirementsDigest: REQUIREMENTS,
        expiry: 9_999n,
        revealWindowBlocks: 10n,
        maxSuccessfulProofs: 3n,
        successfulProofs: 0n,
        proofReimbursement: 5n,
        outcomeReward: 10n,
        commitBond: 2n,
        escrowRemaining: 25n,
        rewardOutcomeThreshold: 4n,
        state: 0n,
      };
    },
  };
  const kernelContract = {
    policyOf: async (...args) => {
      policyOfCalls.push(args);
      return {
        evaluator: POLICY,
        configHash: REQUIREMENTS,
        manifestBytes: "0x1234",
      };
    },
  };
  const policyContract = {
    configurationOf: async (...args) => {
      configurationOfCalls.push(args);
      return {
        sourceChain: 3n,
        emitter: TOKEN,
        eventSignature: HASH("dd"),
        subject: FACILITY,
        startSourceBlock: 1n,
        endSourceBlock: 2n,
        topicCount: 3n,
        subjectTopicIndex: 1n,
        dataLength: 32n,
        observedValueOffset: 0n,
        observationKind: 0n,
        evidenceKind: 0n,
        freshnessPeriod: 60n,
        effect: {
          outcome: 1n,
          creditLimitBps: 9_000n,
          futureDrawFeeBps: 0n,
          freezePendingDraw: true,
          requireFreshEvidence: true,
          terminate: false,
        },
      };
    },
  };

  try {
    const first = await discoverProofJobs({
      provider,
      deployments: {
        chainId: 102031,
        deploymentBlock: 100,
        proofJobs: JOBS,
        policyKernel: KERNEL,
        eventHistoryPolicy: POLICY,
      },
      cursorPath,
      confirmations: 12,
      chunkSize: 20,
      jobsContract,
      kernelContract,
      policyContract,
    });

    assert.equal(first.scan.toBlock, 138);
    assert.equal(first.scan.stateBlock, 138);
    assert.equal(first.scan.historyComplete, true);
    assert.deepEqual(ranges, [
      [100, 119],
      [120, 138],
    ]);
    assert.ok(
      operations.indexOf("block:110") < operations.indexOf("logs:120-138"),
    );
    assert.equal(first.jobs[0].policyId, "0");
    assert.equal(first.policies[0].configuration.sourceChain, "3");
    assert.deepEqual(getJobCalls.at(-1), ["1", { blockTag: 138 }]);
    assert.deepEqual(policyOfCalls.at(-1), [FACILITY, "0", { blockTag: 138 }]);
    assert.deepEqual(configurationOfCalls.at(-1), [
      FACILITY,
      "0",
      { blockTag: 138 },
    ]);
    const cursor = JSON.parse(await readFile(cursorPath, "utf8"));
    assert.equal(cursor.version, 2);
    assert.equal(cursor.chainId, 102031);
    assert.equal(cursor.contractAddress, JOBS);
    assert.equal(cursor.historyFromBlock, 100);
    assert.equal(cursor.historyComplete, true);
    assert.equal(cursor.nextBlock, 139);
    assert.equal(cursor.lastScannedBlock, 138);
    assert.equal(cursor.lastScannedBlockHash, HASH("fe"));
    assert.equal(cursor.confirmations, 12);
    assert.equal(cursor.eventsTruncated, false);
    assert.deepEqual(cursor.events, first.events);
    assert.deepEqual(cursor.jobs, first.jobs);
    assert.deepEqual(cursor.policies, first.policies);
    assert.deepEqual(metricsFromCheckpoint(cursor.metrics), first.metrics);

    const callsBeforeIdle = getJobCalls.length;
    const policyCallsAfterFirst = policyOfCalls.length;
    const configurationCallsAfterFirst = configurationOfCalls.length;
    const idle = await discoverProofJobs({
      provider,
      deployments: {
        chainId: 102031,
        deploymentBlock: 100,
        proofJobs: JOBS,
        policyKernel: KERNEL,
        eventHistoryPolicy: POLICY,
      },
      cursorPath,
      confirmations: 12,
      chunkSize: 20,
      jobsContract,
      kernelContract,
      policyContract,
    });
    assert.equal(idle.scan.fromBlock, 139);
    assert.equal(idle.scan.toBlock, 138);
    assert.equal(idle.scan.stateBlock, 138);
    assert.equal(getJobCalls.length, callsBeforeIdle);
    assert.equal(policyOfCalls.length, policyCallsAfterFirst);
    assert.equal(configurationOfCalls.length, configurationCallsAfterFirst);

    await writeFile(
      cursorPath,
      `${JSON.stringify({ ...cursor, nextBlock: 140 }, null, 2)}\n`,
      "utf8",
    );
    await assert.rejects(
      discoverProofJobs({
        provider,
        deployments: {
          chainId: 102031,
          deploymentBlock: 100,
          proofJobs: JOBS,
          policyKernel: KERNEL,
          eventHistoryPolicy: POLICY,
        },
        cursorPath,
        confirmations: 12,
        chunkSize: 20,
        jobsContract,
        kernelContract,
        policyContract,
      }),
      /cursor block range/,
    );
    await writeFile(cursorPath, `${JSON.stringify(cursor, null, 2)}\n`, "utf8");

    const canonicalGetBlock = provider.getBlock;
    provider.getBlock = async (blockNumber) =>
      blockNumber === 138
        ? { number: blockNumber, hash: HASH("99"), timestamp: 1_380 }
        : canonicalGetBlock(blockNumber);
    await assert.rejects(
      discoverProofJobs({
        provider,
        deployments: {
          chainId: 102031,
          deploymentBlock: 100,
          proofJobs: JOBS,
          policyKernel: KERNEL,
          eventHistoryPolicy: POLICY,
        },
        cursorPath,
        confirmations: 12,
        chunkSize: 20,
        jobsContract,
        kernelContract,
        policyContract,
      }),
      /canonical chain/,
    );

    provider.getBlock = canonicalGetBlock;
    provider.getBlockNumber = async () => 160;
    let scanHeadReads = 0;
    provider.getBlock = async (blockNumber) => {
      if (blockNumber !== 148) return canonicalGetBlock(blockNumber);
      scanHeadReads += 1;
      const block = await canonicalGetBlock(blockNumber);
      return scanHeadReads === 1 ? block : { ...block, hash: HASH("98") };
    };
    await assert.rejects(
      discoverProofJobs({
        provider,
        deployments: {
          chainId: 102031,
          deploymentBlock: 100,
          proofJobs: JOBS,
          policyKernel: KERNEL,
          eventHistoryPolicy: POLICY,
        },
        cursorPath,
        confirmations: 12,
        chunkSize: 20,
        jobsContract,
        kernelContract,
        policyContract,
      }),
      /scan head changed/,
    );
    assert.equal(JSON.parse(await readFile(cursorPath, "utf8")).nextBlock, 139);

    provider.getBlock = canonicalGetBlock;
    ranges.length = 0;
    const resumed = await discoverProofJobs({
      provider,
      deployments: {
        chainId: 102031,
        deploymentBlock: 100,
        proofJobs: JOBS,
        policyKernel: KERNEL,
        eventHistoryPolicy: POLICY,
      },
      cursorPath,
      confirmations: 12,
      chunkSize: 20,
      jobsContract,
      kernelContract,
      policyContract,
    });
    assert.deepEqual(ranges, [[139, 148]]);
    assert.equal(resumed.scan.fromBlock, 139);
    assert.equal(resumed.scan.historyFromBlock, 100);
    assert.equal(resumed.scan.stateBlock, 148);
    assert.equal(resumed.scan.historyComplete, true);
    assert.equal(resumed.events.length, 3);
    assert.equal(resumed.metrics.jobsCreated, 1);
    assert.equal(resumed.metrics.acceptedProofs, 1);
    assert.deepEqual(resumed.metrics.coverage, {
      numerator: 1,
      denominator: 1,
      value: 1,
    });
    assert.deepEqual(getJobCalls.at(-1), ["1", { blockTag: 148 }]);
    assert.equal(policyOfCalls.length, policyCallsAfterFirst);
    assert.equal(configurationOfCalls.length, configurationCallsAfterFirst);

    await assert.rejects(
      discoverProofJobs({
        provider,
        deployments: {
          chainId: 102031,
          deploymentBlock: 100,
          proofJobs: JOBS,
          policyKernel: KERNEL,
          eventHistoryPolicy: POLICY,
        },
        cursorPath,
        fromBlock: 155,
        confirmations: 12,
        chunkSize: 20,
        jobsContract,
        kernelContract,
        policyContract,
      }),
      /must match discovery cursor next block/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
