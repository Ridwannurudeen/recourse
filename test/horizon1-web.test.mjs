import assert from "node:assert/strict";
import test from "node:test";

import {
  capacitySegments,
  createCompletionPollingLoop,
  createLatestAsyncRunner,
  createdJobIds,
  formatBaseUnits,
  formatUnixTimestamp,
  loadFacilityJobs,
  normalizeTokenSymbol,
  outcomeLabel,
  partitionFacilityCatalog,
  queryFilterInBlockPages,
  registeredPolicyIds,
  statusLabel,
} from "../web/horizon1-core.mjs";
import { readFacilityCatalog } from "../web/app-core.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function loadDashboardModule() {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      ethers: {
        Contract: class {},
        JsonRpcProvider: class {},
      },
    },
  });
  try {
    return await import("../web/horizon1.js?anchor-regression");
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow);
    } else {
      delete globalThis.window;
    }
  }
}

test("formatBaseUnits preserves exact six-decimal asset values", () => {
  assert.equal(formatBaseUnits(40_800_000_000n, 6, 2), "40,800.00");
  assert.equal(formatBaseUnits(1_234_567n, 6, 6), "1.234567");
  assert.equal(formatBaseUnits(999n, 6, 2), "0.00");
});

test("capacitySegments separates drawn, available, and policy-frozen capacity", () => {
  assert.deepEqual(
    capacitySegments({
      facilityLimit: 100_000n,
      drawnPrincipal: 40_000n,
      availableCredit: 35_000n,
    }),
    { drawnBps: 4_000, availableBps: 3_500, frozenBps: 2_500 },
  );
});

test("capacitySegments handles a zero limit without division", () => {
  assert.deepEqual(
    capacitySegments({
      facilityLimit: 0n,
      drawnPrincipal: 0n,
      availableCredit: 0n,
    }),
    { drawnBps: 0, availableBps: 0, frozenBps: 0 },
  );
});

test("contract enum labels remain aligned with Horizon 1", () => {
  assert.equal(statusLabel(1), "Active");
  assert.equal(statusLabel(5), "Terminated");
  assert.equal(outcomeLabel(3), "Margin called");
  assert.equal(outcomeLabel(5), "Cured");
  assert.equal(outcomeLabel(99), "Unknown");
  assert.equal(outcomeLabel(0, false), "Awaiting evidence");
});

test("normalizeTokenSymbol rejects markup from an external token contract", () => {
  assert.equal(normalizeTokenSymbol("rUSD"), "rUSD");
  assert.equal(normalizeTokenSymbol("<img src=x onerror=alert(1)>"), "TOKEN");
  assert.equal(normalizeTokenSymbol(""), "TOKEN");
});

test("registeredPolicyIds follows canonical registration order and deduplicates IDs", () => {
  const policy = (policyId, blockNumber, transactionIndex, index) => ({
    args: { policyId },
    blockNumber,
    transactionIndex,
    index,
  });

  assert.deepEqual(
    registeredPolicyIds([
      policy(9n, 12, 0, 1),
      policy(7n, 10, 1, 0),
      policy(7n, 10, 1, 0),
      policy(8n, 10, 1, 1),
    ]),
    [7n, 8n, 9n],
  );
});

test("createdJobIds keeps only canonically ordered jobs for the selected facility", () => {
  const selected = "0x0000000000000000000000000000000000000001";
  const other = "0x0000000000000000000000000000000000000002";
  const created = (jobId, facility, blockNumber, index) => ({
    args: { jobId, facility },
    blockNumber,
    transactionIndex: 0,
    index,
  });

  assert.deepEqual(
    createdJobIds(
      [
        created(3n, selected, 12, 0),
        created(9n, other, 10, 0),
        created(2n, selected, 10, 1),
        created(2n, selected, 10, 1),
      ],
      selected,
    ),
    [2n, 3n],
  );
});

test("loadFacilityJobs pages long log ranges and hydrates only matching jobs at the pinned block", async () => {
  const selected = "0x0000000000000000000000000000000000000001";
  const other = "0x0000000000000000000000000000000000000002";
  const calls = { filters: [], queries: [], jobs: [] };
  const proofJobs = {
    filters: {
      JobCreated: (...args) => {
        calls.filters.push(args);
        return { args };
      },
    },
    queryFilter: async (...args) => {
      calls.queries.push(args);
      const fromBlock = args[1];
      if (fromBlock === 100) {
        return [
          {
            args: { jobId: 4n, facility: selected },
            blockNumber: 105,
            transactionIndex: 0,
            index: 0,
          },
        ];
      }
      if (fromBlock === 2_100) {
        return [
          {
            args: { jobId: 99n, facility: other },
            blockNumber: 2_106,
            transactionIndex: 0,
            index: 0,
          },
          {
            args: { jobId: 6n, facility: selected },
            blockNumber: 4_099,
            transactionIndex: 0,
            index: 1,
          },
        ];
      }
      return [
        {
          args: { jobId: 8n, facility: selected },
          blockNumber: 4_200,
          transactionIndex: 0,
          index: 0,
        },
      ];
    },
    getJob: async (...args) => {
      calls.jobs.push(args);
      return { facility: selected };
    },
  };

  assert.deepEqual(await loadFacilityJobs(proofJobs, selected, 100, 4_250), [
    { id: 4n, job: { facility: selected } },
    { id: 6n, job: { facility: selected } },
    { id: 8n, job: { facility: selected } },
  ]);
  assert.deepEqual(calls.filters, [[null, null, selected]]);
  assert.deepEqual(calls.queries, [
    [{ args: [null, null, selected] }, 100, 2_099],
    [{ args: [null, null, selected] }, 2_100, 4_099],
    [{ args: [null, null, selected] }, 4_100, 4_250],
  ]);
  assert.deepEqual(calls.jobs, [
    [4n, { blockTag: 4_250 }],
    [6n, { blockTag: 4_250 }],
    [8n, { blockTag: 4_250 }],
  ]);
});

test("legacy event-history reads are bounded and concurrent", async () => {
  const calls = { queries: [], facilities: [] };
  let activeQueries = 0;
  let peakQueries = 0;
  const facility = {
    queryFilter: async (_filter, fromBlock, toBlock) => {
      calls.queries.push([fromBlock, toBlock]);
      if (toBlock - fromBlock + 1 > 2_000) {
        throw new Error("query timeout of 10 seconds exceeded");
      }
      activeQueries += 1;
      peakQueries = Math.max(peakQueries, activeQueries);
      await new Promise((resolve) => setImmediate(resolve));
      activeQueries -= 1;
      return fromBlock === 5_371_433
        ? [
            { args: { facilityId: 2n } },
            { args: { facilityId: 1n } },
            { args: { facilityId: 2n } },
          ]
        : [];
    },
    facilityOf: async (facilityId, overrides) => {
      calls.facilities.push([facilityId, overrides]);
      return {
        lender: "0x0000000000000000000000000000000000000001",
        facilityLimit: 1n,
        state: facilityId,
      };
    },
  };

  assert.deepEqual(
    await readFacilityCatalog({
      facility,
      filter: {},
      deploymentBlock: 5_371_433,
      blockNumber: 5_377_434,
      stateNames: ["Created", "Active", "Breached"],
      zeroAddress: "0x0000000000000000000000000000000000000000",
    }),
    [
      {
        facilityId: 1,
        data: {
          lender: "0x0000000000000000000000000000000000000001",
          facilityLimit: 1n,
          state: 1,
        },
        stateName: "Active",
      },
      {
        facilityId: 2,
        data: {
          lender: "0x0000000000000000000000000000000000000001",
          facilityLimit: 1n,
          state: 2,
        },
        stateName: "Breached",
      },
    ],
  );
  assert.deepEqual(calls.queries, [
    [5_371_433, 5_373_432],
    [5_373_433, 5_375_432],
    [5_375_433, 5_377_432],
    [5_377_433, 5_377_434],
  ]);
  assert.deepEqual(calls.facilities, [
    [1, { blockTag: 5_377_434 }],
    [2, { blockTag: 5_377_434 }],
  ]);
  assert.equal(peakQueries, 4);
});

test("paged event-history reads reject concurrency that cannot advance", async () => {
  await assert.rejects(
    () => queryFilterInBlockPages({ queryFilter: async () => [] }, {}, 1, 2, Number.NaN),
    /concurrency must be a positive safe integer/,
  );
});

test("formatUnixTimestamp renders uint64 values outside the Date range without throwing", () => {
  assert.equal(formatUnixTimestamp(0n), "Not constrained");
  assert.equal(
    formatUnixTimestamp(18_446_744_073_709_551_615n),
    "Unix 18446744073709551615 (outside JavaScript Date range)",
  );
  assert.match(formatUnixTimestamp(1_700_000_000n), /2023/);
});

test("anchored dashboard reads commit a snapshot when the block hash stays stable", async () => {
  const { readAtStableBlock } = await loadDashboardModule();
  const calls = [];
  const provider = {
    getBlock: async (blockNumber) => {
      calls.push(`block:${blockNumber}`);
      return { number: blockNumber, hash: "0xabc123" };
    },
  };

  const result = await readAtStableBlock(provider, 42, async (blockTag) => {
    calls.push(`read:${blockTag}`);
    return "snapshot";
  });

  assert.deepEqual(result, {
    block: { number: 42, hash: "0xabc123" },
    value: "snapshot",
  });
  assert.deepEqual(calls, ["block:42", "read:42", "block:42"]);
});

test("anchored dashboard reads reject a snapshot when the block hash changes", async () => {
  const { readAtStableBlock } = await loadDashboardModule();
  const hashes = ["0xabc123", "0xdef456"];
  const provider = {
    getBlock: async (blockNumber) => ({
      number: blockNumber,
      hash: hashes.shift(),
    }),
  };

  await assert.rejects(
    readAtStableBlock(provider, 42, async () => "stale snapshot"),
    /Block 42 changed while the dashboard snapshot was being read\./,
  );
});

test("anchored dashboard reads reject a snapshot when the final block is missing", async () => {
  const { readAtStableBlock } = await loadDashboardModule();
  const blocks = [{ number: 42, hash: "0xabc123" }, null];
  const provider = {
    getBlock: async () => blocks.shift(),
  };

  await assert.rejects(
    readAtStableBlock(provider, 42, async () => "stale snapshot"),
    /Block 42 changed while the dashboard snapshot was being read\./,
  );
});

test("latest async runner ignores stale successes and stale errors", async () => {
  const runLatest = createLatestAsyncRunner();
  const staleSuccess = deferred();
  const latestSuccess = deferred();
  const committed = [];
  const failed = [];
  const handlers = {
    success: (value) => committed.push(value),
    failure: (error) => failed.push(error.message),
  };

  const first = runLatest(() => staleSuccess.promise, handlers);
  const second = runLatest(() => latestSuccess.promise, handlers);
  staleSuccess.resolve("stale");
  assert.equal(await first, false);
  assert.deepEqual(committed, []);
  latestSuccess.resolve("latest");
  assert.equal(await second, true);
  assert.deepEqual(committed, ["latest"]);

  const staleFailure = deferred();
  const recovery = deferred();
  const third = runLatest(() => staleFailure.promise, handlers);
  const fourth = runLatest(() => recovery.promise, handlers);
  staleFailure.reject(new Error("stale failure"));
  assert.equal(await third, false);
  assert.deepEqual(failed, []);
  recovery.resolve("recovered");
  assert.equal(await fourth, true);
  assert.deepEqual(committed, ["latest", "recovered"]);
});

test("completion polling never schedules the next refresh before the current one settles", async () => {
  const first = deferred();
  const second = deferred();
  const pending = [first, second];
  const scheduled = [];
  let refreshes = 0;
  const poll = createCompletionPollingLoop(
    () => {
      const current = pending[refreshes];
      refreshes += 1;
      return current.promise;
    },
    (callback, delay) => scheduled.push({ callback, delay }),
    30_000,
  );

  const firstCycle = poll();
  assert.equal(refreshes, 1);
  assert.deepEqual(scheduled, []);
  first.resolve();
  await firstCycle;
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 30_000);

  const secondCycle = scheduled[0].callback();
  assert.equal(refreshes, 2);
  assert.equal(scheduled.length, 1);
  second.reject(new Error("read failed"));
  await assert.rejects(secondCycle, /read failed/);
  assert.equal(scheduled.length, 2);
});

test("partitionFacilityCatalog filters entries to the configured kernel and credit state", () => {
  const configuredKernel = "0x00000000000000000000000000000000000000aA";
  const configuredCreditState = "0x00000000000000000000000000000000000000cC";
  const supported = {
    address: "0x0000000000000000000000000000000000000001",
    kernel: "0x00000000000000000000000000000000000000AA",
    creditState: "0x00000000000000000000000000000000000000CC",
  };
  const otherKernel = {
    address: "0x0000000000000000000000000000000000000002",
    kernel: "0x00000000000000000000000000000000000000bb",
    creditState: null,
  };
  const otherCreditState = {
    address: "0x0000000000000000000000000000000000000003",
    kernel: "0x00000000000000000000000000000000000000AA",
    creditState: "0x00000000000000000000000000000000000000dd",
  };

  assert.deepEqual(
    partitionFacilityCatalog(
      [otherKernel, otherCreditState, supported],
      configuredKernel,
      configuredCreditState,
    ),
    {
      supported: [supported],
      unsupported: [otherKernel, otherCreditState],
    },
  );
});
