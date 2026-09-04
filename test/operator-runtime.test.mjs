import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { getAddress, id } from "ethers";
import {
  OPERATOR_LIMITS,
  assertEthereumMainnetProvider,
  assertExecutionKernelCapability,
  executeQueuedCandidates,
  executionStatePath,
  isOperatorMainModule,
  prefilterExecutionCandidates,
  recoverExistingExecutionJournals,
  runOperatorCycle,
  runOperatorService,
  scanJobEvidence,
} from "../daemon/operator.mjs";

const ADDRESS = (suffix) =>
  getAddress(`0x${"0".repeat(40 - suffix.length)}${suffix}`);
const FACILITY = ADDRESS("fac1");
const TOKEN = ADDRESS("1000");
const SUBJECT = ADDRESS("b0b");
const OTHER = ADDRESS("a11");
const TRANSACTION_HASH = `0x${"11".repeat(32)}`;
const BLOCK_HASH = `0x${"22".repeat(32)}`;
const SIGNATURE = id("Observed(address,uint256)");
const FEE_POLICY = {
  transactionType: "legacy",
  maximumGasLimit: "200000",
  maximumGasPrice: "2",
  maximumNativeFee: "400000",
};

test("operator entrypoint recognizes an immutable module reached through the current symlink", () => {
  const releasePath = resolve(
    join(tmpdir(), "recourse-release", "daemon", "operator.mjs"),
  );
  const currentPath = resolve(
    join(tmpdir(), "recourse-current", "daemon", "operator.mjs"),
  );
  const canonicalize = (path) =>
    resolve(path) === currentPath ? releasePath : resolve(path);

  assert.equal(
    isOperatorMainModule(
      pathToFileURL(releasePath).href,
      currentPath,
      canonicalize,
    ),
    true,
  );
  assert.equal(
    isOperatorMainModule(
      pathToFileURL(releasePath).href,
      join(tmpdir(), "other.mjs"),
      canonicalize,
    ),
    false,
  );
});

function topicAddress(address) {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

function word(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

const JOB = {
  jobId: "7",
  facility: FACILITY,
  token: TOKEN,
  policyId: "3",
  requirementsDigest: `0x${"33".repeat(32)}`,
  state: "Open",
};

const POLICY = {
  configHash: JOB.requirementsDigest,
  configuration: {
    sourceChain: "3",
    emitter: TOKEN,
    eventSignature: SIGNATURE,
    subject: SUBJECT,
    startSourceBlock: "100",
    endSourceBlock: "200",
    topicCount: 2,
    subjectTopicIndex: 1,
    dataLength: 32,
    observedValueOffset: 0,
  },
};

function sourceProvider(blockHash = BLOCK_HASH) {
  return {
    getNetwork: async () => ({ chainId: 1n }),
    getLogs: async ({ fromBlock, toBlock, address, topics }) => {
      assert.equal(fromBlock, 100);
      assert.equal(toBlock, 100);
      assert.equal(address, TOKEN);
      assert.deepEqual(topics, [
        SIGNATURE.toLowerCase(),
        topicAddress(SUBJECT),
      ]);
      return [
        {
          transactionHash: TRANSACTION_HASH,
          blockHash,
          blockNumber: 100,
        },
      ];
    },
    getTransactionReceipt: async () => ({
      hash: TRANSACTION_HASH,
      status: 1,
      blockNumber: 100,
      blockHash,
      index: 4,
      logs: [
        {
          address: TOKEN,
          topics: [SIGNATURE, topicAddress(SUBJECT)],
          data: `0x${word(42)}`,
        },
        {
          address: TOKEN,
          topics: [SIGNATURE, topicAddress(OTHER)],
          data: `0x${word(100)}`,
        },
      ],
    }),
    getBlock: async (height) => ({ number: height, hash: blockHash }),
  };
}

test("source RPC chain identity and kernel release capability fail closed", async () => {
  await assert.rejects(
    assertEthereumMainnetProvider({
      getNetwork: async () => ({ chainId: 11155111n }),
    }),
    /expected Ethereum mainnet chain 1/,
  );
  await assert.rejects(
    assertExecutionKernelCapability({}, FACILITY, () => ({
      safeStaleProofRelease: async () => {
        throw new Error("unknown selector");
      },
    })),
    /requires a kernel exposing/,
  );
  await assert.rejects(
    assertExecutionKernelCapability({}, FACILITY, () => ({
      safeStaleProofRelease: async () => false,
    })),
    /does not guarantee/,
  );
});

test("job scanning persists exact qualified evidence and rejects a changed source cursor on restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-operator-scan-"));
  const statePath = join(directory, "job.json");
  try {
    const first = await scanJobEvidence({
      sourceProvider: sourceProvider(),
      job: JOB,
      policy: POLICY,
      statePath,
      attestedHeight: 100,
      maxSourceBlocks: 50,
    });
    assert.equal(first.added.length, 1);
    assert.equal(first.state.candidates[0].observedValue, "42");
    assert.equal(first.state.lastScannedBlockHash, BLOCK_HASH);
    assert.deepEqual(
      JSON.parse(await readFile(statePath, "utf8")),
      first.state,
    );

    await assert.rejects(
      scanJobEvidence({
        sourceProvider: sourceProvider(`0x${"ff".repeat(32)}`),
        job: JOB,
        policy: POLICY,
        statePath,
        attestedHeight: 100,
        maxSourceBlocks: 50,
      }),
      /no longer canonical/,
    );
    assert.deepEqual(
      JSON.parse(await readFile(statePath, "utf8")),
      first.state,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("source log withholding mismatch fails without advancing the evidence cursor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-operator-rpc-"));
  const statePath = join(directory, "job.json");
  try {
    await assert.rejects(
      scanJobEvidence({
        sourceProvider: sourceProvider(),
        secondarySourceProvider: {
          ...sourceProvider(),
          getLogs: async () => [],
        },
        job: JOB,
        policy: POLICY,
        statePath,
        attestedHeight: 100,
        maxSourceBlocks: 50,
      }),
      /RPC log cross-check mismatch/,
    );
    await assert.rejects(readFile(statePath, "utf8"), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("multi-rule scanning keeps one chain cursor and hydrates a matching transaction once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-operator-rules-"));
  const statePath = join(directory, "job-source-3.json");
  let receiptReads = 0;
  const secondSignature = id("Flagged(address,uint256)");
  const provider = sourceProvider();
  provider.getLogs = async ({ topics }) => [
    {
      transactionHash: TRANSACTION_HASH,
      blockHash: BLOCK_HASH,
      blockNumber: 100,
      topics,
    },
  ];
  provider.getTransactionReceipt = async () => {
    receiptReads += 1;
    return {
      hash: TRANSACTION_HASH,
      status: 1,
      blockNumber: 100,
      blockHash: BLOCK_HASH,
      index: 4,
      logs: [
        {
          address: TOKEN,
          topics: [SIGNATURE, topicAddress(SUBJECT)],
          data: `0x${word(42)}`,
        },
        {
          address: TOKEN,
          topics: [secondSignature, topicAddress(SUBJECT)],
          data: `0x${word(7)}`,
        },
      ],
    };
  };
  try {
    const result = await scanJobEvidence({
      sourceProvider: provider,
      job: JOB,
      policy: {
        ...POLICY,
        configurations: [
          { ...POLICY.configuration, ruleIndex: 0 },
          {
            ...POLICY.configuration,
            eventSignature: secondSignature,
            ruleIndex: 1,
          },
        ],
      },
      statePath,
      attestedHeight: 100,
      maxSourceBlocks: 50,
    });
    assert.equal(receiptReads, 1);
    assert.equal(result.state.schemaVersion, 2);
    assert.equal(result.state.sourceChain, "3");
    assert.equal(result.state.nextSourceBlock, 101);
    assert.equal(result.added.length, 1);
    assert.deepEqual(result.added[0].matchedRuleIndexes, [0, 1]);
    assert.deepEqual(
      result.added[0].ruleMatches.map(({ ruleIndex, observedValue }) => ({
        ruleIndex,
        observedValue,
      })),
      [
        { ruleIndex: 0, observedValue: "42" },
        { ruleIndex: 1, observedValue: "7" },
      ],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("multi-rule scanning accepts a shared RPC filter when only the exact data-length rule qualifies", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "recourse-operator-shared-filter-"),
  );
  const statePath = join(directory, "job-source-3.json");
  let receiptReads = 0;
  const provider = sourceProvider();
  provider.getTransactionReceipt = async () => {
    receiptReads += 1;
    return {
      hash: TRANSACTION_HASH,
      status: 1,
      blockNumber: 100,
      blockHash: BLOCK_HASH,
      index: 4,
      logs: [
        {
          address: TOKEN,
          topics: [SIGNATURE, topicAddress(SUBJECT)],
          data: `0x${word(42)}`,
        },
      ],
    };
  };
  try {
    const result = await scanJobEvidence({
      sourceProvider: provider,
      job: JOB,
      policy: {
        ...POLICY,
        configurations: [
          { ...POLICY.configuration, ruleIndex: 0 },
          { ...POLICY.configuration, dataLength: 64, ruleIndex: 1 },
        ],
      },
      statePath,
      attestedHeight: 100,
      maxSourceBlocks: 50,
    });
    assert.equal(receiptReads, 1);
    assert.equal(result.added.length, 1);
    assert.deepEqual(result.added[0].matchedRuleIndexes, [0]);
    assert.deepEqual(result.added[0].ruleMatches, [
      { ruleIndex: 0, observedValue: "42", matchingLogs: 1 },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a mid-scan source reorg queues nothing and never advances the durable cursor", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "recourse-operator-mid-reorg-"),
  );
  const statePath = join(directory, "job.json");
  const provider = sourceProvider();
  let anchorReads = 0;
  provider.getBlock = async (height) => {
    anchorReads += 1;
    return {
      number: height,
      hash: anchorReads === 1 ? BLOCK_HASH : `0x${"ff".repeat(32)}`,
    };
  };
  try {
    await assert.rejects(
      scanJobEvidence({
        sourceProvider: provider,
        job: JOB,
        policy: POLICY,
        statePath,
        attestedHeight: 100,
        maxSourceBlocks: 50,
      }),
      /scan head changed/,
    );
    await assert.rejects(readFile(statePath, "utf8"), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing or receipt-inconsistent canonical logs fail without writing a cursor", async () => {
  for (const [label, mutate, expected] of [
    [
      "missing",
      (provider) => {
        provider.getTransactionReceipt = async () => null;
      },
      /missing or inconsistent/,
    ],
    [
      "block mismatch",
      (provider) => {
        provider.getTransactionReceipt = async () => ({
          hash: TRANSACTION_HASH,
          status: 1,
          blockNumber: 101,
          blockHash: `0x${"55".repeat(32)}`,
          index: 4,
          logs: [],
        });
      },
      /missing or inconsistent/,
    ],
  ]) {
    const directory = await mkdtemp(
      join(tmpdir(), `recourse-operator-${label.replace(" ", "-")}-`),
    );
    const statePath = join(directory, "job.json");
    const provider = sourceProvider();
    mutate(provider);
    try {
      await assert.rejects(
        scanJobEvidence({
          sourceProvider: provider,
          job: JOB,
          policy: POLICY,
          statePath,
          attestedHeight: 100,
          maxSourceBlocks: 50,
        }),
        expected,
      );
      await assert.rejects(readFile(statePath, "utf8"), /ENOENT/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("source range caps are bisected and each bounded subrange advances durably", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-operator-bisect-"));
  const statePath = join(directory, "job.json");
  const calls = [];
  const provider = {
    getNetwork: async () => ({ chainId: 1n }),
    getLogs: async ({ fromBlock, toBlock }) => {
      calls.push([fromBlock, toBlock]);
      if (toBlock > fromBlock)
        throw new Error("query returned more than 10000 results");
      return [];
    },
    getBlock: async (height) => ({ number: height, hash: BLOCK_HASH }),
  };
  try {
    const result = await scanJobEvidence({
      sourceProvider: provider,
      job: JOB,
      policy: POLICY,
      statePath,
      attestedHeight: 103,
      maxSourceBlocks: 4,
    });
    assert.equal(result.state.nextSourceBlock, 104);
    assert.deepEqual(calls, [
      [100, 103],
      [100, 101],
      [100, 100],
      [101, 101],
      [102, 103],
      [102, 102],
      [103, 103],
    ]);
    assert.equal(
      JSON.parse(await readFile(statePath, "utf8")).nextSourceBlock,
      104,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a single-block log flood fails closed without cursor or candidate growth", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-operator-flood-"));
  const statePath = join(directory, "job.json");
  const provider = {
    getNetwork: async () => ({ chainId: 1n }),
    getLogs: async () =>
      Array.from(
        { length: OPERATOR_LIMITS.maxLogsPerCycle + 1 },
        (_, index) => ({
          transactionHash: `0x${index.toString(16).padStart(64, "0")}`,
          blockHash: BLOCK_HASH,
          blockNumber: 100,
        }),
      ),
    getBlock: async (height) => ({ number: height, hash: BLOCK_HASH }),
  };
  try {
    await assert.rejects(
      scanJobEvidence({
        sourceProvider: provider,
        job: JOB,
        policy: POLICY,
        statePath,
        attestedHeight: 100,
        maxSourceBlocks: 1,
      }),
      /log limit/,
    );
    await assert.rejects(readFile(statePath, "utf8"), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a full candidate queue drains before the pinned source block advances", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-operator-budget-"));
  const statePath = join(directory, "job.json");
  const candidates = Array.from(
    { length: OPERATOR_LIMITS.maxCandidatesPerJob },
    (_, index) => ({
      transactionHash: `0x${(index + 1).toString(16).padStart(64, "0")}`,
      blockNumber: 99,
      transactionIndex: index,
    }),
  );
  await writeFile(
    statePath,
    `${JSON.stringify({
      schemaVersion: 1,
      jobId: JOB.jobId,
      facility: JOB.facility,
      policyId: JOB.policyId,
      requirementsDigest: JOB.requirementsDigest,
      nextSourceBlock: 100,
      lastScannedBlock: 99,
      lastScannedBlockHash: BLOCK_HASH,
      candidates,
      completedTransactionHashes: [],
      skippedCandidates: [],
      incidents: [],
    })}\n`,
    "utf8",
  );
  try {
    const budgeted = await scanJobEvidence({
      sourceProvider: sourceProvider(),
      job: JOB,
      policy: POLICY,
      statePath,
      attestedHeight: 100,
      maxSourceBlocks: 1,
    });
    assert.equal(budgeted.added.length, 0);
    assert.equal(budgeted.state.nextSourceBlock, 100);

    const executed = [];
    await executeQueuedCandidates({
      state: budgeted.state,
      statePath,
      chainId: 102031,
      jobId: JOB.jobId,
      jobsDirectory: directory,
      deploymentPath: "deployments-horizon1.json",
      signal: { aborted: false },
      executeJob: async ({ transactionHash }) => executed.push(transactionHash),
    });
    assert.equal(executed.length, OPERATOR_LIMITS.maxCandidatesPerJob);

    const resumed = await scanJobEvidence({
      sourceProvider: sourceProvider(),
      job: JOB,
      policy: POLICY,
      statePath,
      attestedHeight: 100,
      maxSourceBlocks: 1,
    });
    assert.equal(resumed.added.length, 1);
    assert.equal(resumed.state.nextSourceBlock, 101);
    assert.equal(resumed.state.candidates[0].transactionHash, TRANSACTION_HASH);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup reconciles target journals before unavailable source discovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-target-first-"));
  const executionPath = join(
    directory,
    `102031-7-${TRANSACTION_HASH.slice(2)}.json`,
  );
  await writeFile(
    executionPath,
    `${JSON.stringify({
      version: 2,
      phase: "committed",
      chainId: 102031,
      jobId: "7",
      sourceTransactionHash: TRANSACTION_HASH,
    })}\n`,
    "utf8",
  );
  const order = [];
  try {
    await assert.rejects(
      runOperatorCycle({
        provider: {},
        deployments: { chainId: 102031, policyKernel: FACILITY },
        paths: {
          jobsDirectory: directory,
          deployments: "deployments-horizon1.json",
          discoveryCursor: join(directory, "cursor.json"),
          discoveryReport: join(directory, "report.json"),
        },
        config: {
          execution: "enabled",
          sourceChains: new Set(["3"]),
          targetConfirmations: 2,
          recoveryBlocks: 3,
          minRevealWindowBlocks: 5,
          minSecondsToExpiry: 60,
          maxCommitBond: 10n,
          minProofReimbursement: 20n,
          minRewardToBondBps: 20_000,
          feePolicy: FEE_POLICY,
          exclusiveSigner: true,
        },
        signal: { aborted: false },
        executionKernelForProvider: async () => ({}),
        executeJob: async ({ recoveryOnly, statePath }) => {
          order.push("target-recovery");
          assert.equal(recoveryOnly, true);
          assert.equal(statePath, executionPath);
        },
        sourceProviderForChain: () => {
          order.push("source");
          throw new Error("source unavailable");
        },
      }),
      /source unavailable/,
    );
    assert.deepEqual(order, ["target-recovery", "source"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("execution prefilter removes processed and stale candidates before signing", async () => {
  const state = {
    candidates: [
      {
        transactionHash: TRANSACTION_HASH,
        blockNumber: 99,
        transactionIndex: 8,
      },
      {
        transactionHash: `0x${"44".repeat(32)}`,
        blockNumber: 100,
        transactionIndex: 3,
      },
      {
        transactionHash: `0x${"55".repeat(32)}`,
        blockNumber: 101,
        transactionIndex: 1,
      },
    ],
    skippedCandidates: [],
  };
  let processedReads = 0;
  await prefilterExecutionCandidates({
    kernel: {
      sourceOrderingOf: async () => 0n,
      latestSourcePosition: async () => ({
        recorded: true,
        blockHeight: 100n,
        transactionIndex: 3n,
      }),
      isProcessed: async () => {
        processedReads += 1;
        return processedReads === 1;
      },
    },
    state,
    job: JOB,
    sourceChain: 3,
  });
  assert.deepEqual(
    state.candidates.map(({ transactionHash }) => transactionHash),
    [`0x${"55".repeat(32)}`],
  );
  assert.deepEqual(
    state.skippedCandidates.map(({ reason }) => reason),
    ["already-processed", "stale-source-position"],
  );
});

test("UniqueOnly retains an earlier unprocessed candidate while strict ordering rejects it", async () => {
  const earlier = {
    transactionHash: TRANSACTION_HASH,
    blockNumber: 100,
    transactionIndex: 1,
  };
  for (const [ordering, expectedCount, expectedReason] of [
    [0n, 0, "stale-source-position"],
    [1n, 1, undefined],
  ]) {
    let orderingReads = 0;
    let latestReads = 0;
    const sourceOrderingCache = new Map();
    const state = { candidates: [earlier], skippedCandidates: [] };
    await prefilterExecutionCandidates({
      kernel: {
        sourceOrderingOf: async (facility, policyId) => {
          orderingReads += 1;
          assert.equal(facility, JOB.facility);
          assert.equal(policyId, JOB.policyId);
          return ordering;
        },
        latestSourcePosition: async () => {
          latestReads += 1;
          return {
            recorded: true,
            blockHeight: 100n,
            transactionIndex: 2n,
          };
        },
        isProcessed: async () => false,
      },
      state,
      job: JOB,
      sourceChain: 3,
      sourceOrderingCache,
    });
    assert.equal(orderingReads, 1);
    assert.equal(latestReads, ordering === 0n ? 1 : 0);
    assert.equal(state.candidates.length, expectedCount);
    assert.equal(state.skippedCandidates[0]?.reason, expectedReason);
    if (ordering === 1n) {
      const secondChainState = {
        candidates: [{ ...earlier, transactionHash: `0x${"66".repeat(32)}` }],
        skippedCandidates: [],
      };
      await prefilterExecutionCandidates({
        kernel: {
          sourceOrderingOf: async () => {
            orderingReads += 1;
            return ordering;
          },
          latestSourcePosition: async () => {
            latestReads += 1;
            throw new Error("UniqueOnly must not read a stale-position cursor");
          },
          isProcessed: async () => false,
        },
        state: secondChainState,
        job: JOB,
        sourceChain: 1,
        sourceOrderingCache,
      });
      assert.equal(orderingReads, 1);
      assert.equal(latestReads, 0);
      assert.equal(secondChainState.candidates.length, 1);
    }
  }
});

test("startup resumes terminal journals until claim settlement is durably complete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-claim-recovery-"));
  const statePath = join(
    directory,
    `102031-7-${TRANSACTION_HASH.slice(2)}.json`,
  );
  const calls = [];
  try {
    await writeFile(
      statePath,
      `${JSON.stringify({
        version: 2,
        phase: "revealed",
        chainId: 102031,
        jobId: "7",
        sourceTransactionHash: TRANSACTION_HASH,
        claimSettlementComplete: false,
      })}\n`,
      "utf8",
    );
    await recoverExistingExecutionJournals({
      jobsDirectory: directory,
      chainId: 102031,
      deploymentPath: "deployments-horizon1.json",
      signal: { aborted: false },
      executeJob: async ({ recoveryOnly }) => {
        calls.push(recoveryOnly);
      },
      executionPolicy: {},
    });
    assert.deepEqual(calls, [true]);

    await writeFile(
      statePath,
      `${JSON.stringify({
        version: 2,
        phase: "revealed",
        chainId: 102031,
        jobId: "7",
        sourceTransactionHash: TRANSACTION_HASH,
        claimSettlementComplete: true,
      })}\n`,
      "utf8",
    );
    await recoverExistingExecutionJournals({
      jobsDirectory: directory,
      chainId: 102031,
      deploymentPath: "deployments-horizon1.json",
      signal: { aborted: false },
      executeJob: async () => calls.push("unexpected"),
      executionPolicy: {},
    });
    assert.deepEqual(calls, [true]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("multiple evidence executions use transaction-bound journals and restart the unfinished candidate", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "recourse-operator-execution-"),
  );
  const statePath = join(directory, "queue.json");
  const secondHash = `0x${"44".repeat(32)}`;
  const state = {
    candidates: [
      { transactionHash: TRANSACTION_HASH },
      { transactionHash: secondHash },
    ],
    completedTransactionHashes: [],
  };
  const attemptedPaths = [];
  try {
    await assert.rejects(
      executeQueuedCandidates({
        state,
        statePath,
        chainId: 102031,
        jobId: "7",
        jobsDirectory: directory,
        deploymentPath: "deployments-horizon1.json",
        signal: { aborted: false },
        executeJob: async ({ transactionHash, statePath: executionPath }) => {
          attemptedPaths.push([transactionHash, executionPath]);
          if (transactionHash === secondHash) throw new Error("interrupted");
        },
      }),
      /interrupted/,
    );
    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(persisted.completedTransactionHashes, [TRANSACTION_HASH]);
    assert.deepEqual(
      persisted.candidates.map(({ transactionHash }) => transactionHash),
      [secondHash],
    );
    assert.notEqual(attemptedPaths[0][1], attemptedPaths[1][1]);

    const secondAttemptPath = attemptedPaths[1][1];
    await executeQueuedCandidates({
      state: persisted,
      statePath,
      chainId: 102031,
      jobId: "7",
      jobsDirectory: directory,
      deploymentPath: "deployments-horizon1.json",
      signal: { aborted: false },
      executeJob: async ({ transactionHash, statePath: executionPath }) => {
        assert.equal(transactionHash, secondHash);
        assert.equal(executionPath, secondAttemptPath);
      },
    });
    const completed = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(completed.candidates, []);
    assert.deepEqual(completed.completedTransactionHashes, [
      TRANSACTION_HASH,
      secondHash,
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("V3 execution journals are unique by source chain and pass that binding to execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-operator-sources-"));
  const pathOne = executionStatePath(
    directory,
    102031,
    "7",
    TRANSACTION_HASH,
    1,
  );
  const pathThree = executionStatePath(
    directory,
    102031,
    "7",
    TRANSACTION_HASH,
    3,
  );
  assert.notEqual(pathOne, pathThree);
  assert.match(pathOne, /102031-7-source-1-/);
  assert.match(pathThree, /102031-7-source-3-/);

  const seen = [];
  try {
    for (const sourceChain of [1, 3]) {
      await executeQueuedCandidates({
        state: {
          sourceChain: String(sourceChain),
          candidates: [
            {
              sourceChain: String(sourceChain),
              transactionHash: TRANSACTION_HASH,
            },
          ],
          completedTransactionHashes: [],
          incidents: [],
        },
        statePath: join(directory, `queue-${sourceChain}.json`),
        chainId: 102031,
        sourceChain,
        jobId: "7",
        jobsDirectory: directory,
        deploymentPath: "activation-v3.json",
        signal: { aborted: false },
        executeJob: async (input) => seen.push(input),
      });
    }
    assert.deepEqual(
      seen.map(({ sourceChain }) => sourceChain),
      [1, 3],
    );
    assert.notEqual(seen[0].statePath, seen[1].statePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("service shutdown finishes cleanly after the current cycle and writes health status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-operator-stop-"));
  const controller = new AbortController();
  let cycles = 0;
  const statusPath = join(directory, "status.json");
  try {
    await runOperatorService({
      provider: {},
      deployments: {},
      paths: { status: statusPath },
      config: {
        execution: "read-only",
        pollIntervalMs: 1,
        maxBackoffMs: 4,
      },
      signal: controller.signal,
      dependencies: {
        runCycle: async () => {
          cycles += 1;
          controller.abort();
          return { jobs: [{ jobId: "7", mode: "read-only" }] };
        },
      },
    });
    const status = JSON.parse(await readFile(statusPath, "utf8"));
    assert.equal(cycles, 1);
    assert.equal(status.healthy, false);
    assert.equal(status.lifecycle, "stopped");
    assert.ok(status.stoppedAt);
    assert.equal(status.mode, "read-only");
    assert.equal(status.jobs[0].jobId, "7");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("transient cycle failure is reported, retried with bounded delay, and cleared after recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-operator-retry-"));
  const controller = new AbortController();
  let cycles = 0;
  const statusPath = join(directory, "status.json");
  try {
    await runOperatorService({
      provider: {},
      deployments: {},
      paths: { status: statusPath },
      config: {
        execution: "read-only",
        pollIntervalMs: 1,
        maxBackoffMs: 2,
      },
      signal: controller.signal,
      dependencies: {
        runCycle: async () => {
          cycles += 1;
          if (cycles === 1) throw new Error("temporary RPC failure");
          controller.abort();
          return { jobs: [] };
        },
      },
    });
    const status = JSON.parse(await readFile(statusPath, "utf8"));
    assert.equal(cycles, 2);
    assert.equal(status.healthy, false);
    assert.equal(status.lifecycle, "stopped");
    assert.ok(status.stoppedAt);
    assert.equal(status.lastError, null);
    assert.ok(status.lastSuccessAt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
