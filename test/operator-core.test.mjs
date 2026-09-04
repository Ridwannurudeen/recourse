import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Interface, Transaction, Wallet, getAddress, id } from "ethers";
import {
  OperatorIncidentError,
  acquireProcessLock,
  abortableDelay,
  assertCommitReady,
  assertJobEconomics,
  eventLogFilter,
  jobAllowed,
  nextBackoff,
  prepareJournaledTransaction,
  qualifyReceipt,
  reconcileJournaledTransaction,
  validateExecutionPolicy,
  validateOperatorConfig,
} from "../daemon/operator-core.mjs";

const ADDRESS = (suffix) =>
  getAddress(`0x${"0".repeat(40 - suffix.length)}${suffix}`);
const FACILITY = ADDRESS("fac1");
const TOKEN = ADDRESS("1000");
const SUBJECT = ADDRESS("b0b");
const OTHER = ADDRESS("a11");
const SIGNATURE = id("Transfer(address,address,uint256)");
const FEE_POLICY = {
  transactionType: "legacy",
  maximumGasLimit: "200000",
  maximumGasPrice: "2",
  maximumNativeFee: "400000",
};

const CONFIGURATION = {
  sourceChain: "3",
  emitter: TOKEN,
  eventSignature: SIGNATURE,
  subject: SUBJECT,
  startSourceBlock: "100",
  endSourceBlock: "200",
  topicCount: 3,
  subjectTopicIndex: 1,
  dataLength: 64,
  observedValueOffset: 32,
};

function topicAddress(address) {
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
}

function word(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function matchingLog(value, overrides = {}) {
  return {
    address: TOKEN,
    topics: [SIGNATURE, topicAddress(SUBJECT), topicAddress(OTHER)],
    data: `0x${word(7)}${word(value)}`,
    ...overrides,
  };
}

function operatorConfig(overrides = {}) {
  return {
    schemaVersion: 1,
    execution: "read-only",
    pollIntervalMs: 1_000,
    maxBackoffMs: 8_000,
    maxSourceBlocksPerPoll: 500,
    targetConfirmations: 2,
    recoveryBlocks: 3,
    exclusiveSigner: false,
    economics: {
      maxCommitBond: "10",
      minProofReimbursement: "20",
      minRewardToBondBps: 20_000,
      minRevealWindowBlocks: 5,
      minSecondsToExpiry: 60,
    },
    transactionPolicy: { feePolicy: FEE_POLICY },
    allowlists: {
      facilities: [FACILITY],
      policyIds: ["7"],
      tokens: [TOKEN],
      sourceChains: ["3"],
    },
    ...overrides,
  };
}

test("operator configuration defaults to no authority and requires explicit allowlists", () => {
  const parsed = validateOperatorConfig(operatorConfig());

  assert.equal(parsed.execution, "read-only");
  assert.equal(parsed.facilities.has(FACILITY), true);
  assert.throws(
    () =>
      validateOperatorConfig(
        operatorConfig({
          execution: "enabled",
          exclusiveSigner: true,
          allowlists: {
            facilities: [],
            policyIds: ["7"],
            tokens: [TOKEN],
            sourceChains: ["3"],
          },
        }),
      ),
    /allowlist must not be empty/,
  );
  const multiChain = validateOperatorConfig(
    operatorConfig({
      allowlists: {
        facilities: [FACILITY],
        policyIds: ["7"],
        tokens: [TOKEN],
        sourceChains: ["1", "3"],
      },
    }),
  );
  assert.deepEqual([...multiChain.sourceChains], ["1", "3"]);
  assert.throws(
    () =>
      validateOperatorConfig(
        operatorConfig({
          allowlists: {
            facilities: [FACILITY],
            policyIds: ["7"],
            tokens: [TOKEN],
            sourceChains: ["4"],
          },
        }),
      ),
    /supports only CC3 source chain keys 1 and 3/,
  );
  assert.throws(
    () =>
      validateOperatorConfig(
        operatorConfig({ execution: "enabled", exclusiveSigner: false }),
      ),
    /exclusive signer/,
  );
});

test("execution economics require enough reveal recovery time and conservative reward coverage", () => {
  assert.throws(
    () =>
      validateExecutionPolicy({
        targetConfirmations: 6,
        recoveryBlocks: 12,
        minRevealWindowBlocks: 17,
        minSecondsToExpiry: 60,
        maxCommitBond: "10",
        minProofReimbursement: "20",
        minRewardToBondBps: 20_000,
        exclusiveSigner: true,
      }),
    /cover target confirmations and recovery blocks/,
  );
  assert.throws(
    () =>
      validateExecutionPolicy({
        targetConfirmations: 6,
        recoveryBlocks: 12,
        blockTimeMs: 500,
        minRevealWindowBlocks: 18,
        minSecondsToExpiry: 60,
        maxCommitBond: "10",
        minProofReimbursement: "20",
        minRewardToBondBps: 20_000,
        exclusiveSigner: true,
      }),
    /invalid block time/i,
  );
  const policy = validateOperatorConfig(operatorConfig());
  assert.equal(policy.blockTimeMs, 15_000);
  assert.equal(
    validateOperatorConfig(operatorConfig({ blockTimeMs: 20_000 })).blockTimeMs,
    20_000,
  );
  const safeJob = {
    commitBond: "10",
    proofReimbursement: "20",
    revealWindowBlocks: "5",
    expiry: "1000",
  };
  assert.equal(assertJobEconomics(safeJob, policy, 940), true);
  for (const unsafe of [
    { ...safeJob, commitBond: "11" },
    { ...safeJob, proofReimbursement: "19" },
    { ...safeJob, revealWindowBlocks: "4" },
    { ...safeJob, expiry: "999" },
  ]) {
    assert.throws(() => assertJobEconomics(unsafe, policy, 940));
  }
});

test("pre-commit funding accepts an exact bond and rejects stale economics or allowance", () => {
  const policy = validateOperatorConfig(operatorConfig());
  const job = {
    commitBond: "10",
    proofReimbursement: "20",
    revealWindowBlocks: "5",
    expiry: "1000",
  };
  assert.equal(
    assertCommitReady({
      job,
      policy,
      currentTimestamp: 940,
      balance: 10n,
      allowance: 10n,
    }),
    true,
  );
  assert.throws(
    () =>
      assertCommitReady({
        job,
        policy,
        currentTimestamp: 940,
        balance: 9n,
        allowance: 10n,
      }),
    /balance/,
  );
  assert.throws(
    () =>
      assertCommitReady({
        job,
        policy,
        currentTimestamp: 940,
        balance: 10n,
        allowance: 9n,
      }),
    /allowance/,
  );
});

test("job selection requires every allowlist and the live requirements digest", () => {
  const allowlists = validateOperatorConfig(operatorConfig());
  const digest = `0x${"11".repeat(32)}`;
  const job = {
    state: "Open",
    facility: FACILITY,
    token: TOKEN,
    policyId: "7",
    requirementsDigest: digest,
    commitBond: "10",
    proofReimbursement: "20",
    revealWindowBlocks: "5",
    expiry: "1000",
  };
  const policy = { configHash: digest, configuration: CONFIGURATION };

  assert.equal(jobAllowed(job, policy, allowlists, 900), true);
  assert.equal(
    jobAllowed({ ...job, facility: OTHER }, policy, allowlists),
    false,
  );
  assert.equal(
    jobAllowed(
      job,
      { ...policy, configHash: `0x${"22".repeat(32)}` },
      allowlists,
    ),
    false,
  );
});

test("event filter and receipt qualification match the exact Solidity policy boundary", () => {
  assert.deepEqual(eventLogFilter(CONFIGURATION), {
    address: TOKEN,
    topics: [SIGNATURE.toLowerCase(), topicAddress(SUBJECT), null],
  });
  const qualified = qualifyReceipt(
    {
      status: 1,
      blockNumber: 200,
      logs: [
        matchingLog(10),
        matchingLog(15),
        matchingLog(100, { address: OTHER }),
        matchingLog(100, { data: `0x${word(100)}` }),
        matchingLog(100, {
          topics: [SIGNATURE, topicAddress(OTHER), topicAddress(SUBJECT)],
        }),
      ],
    },
    CONFIGURATION,
  );

  assert.deepEqual(qualified, {
    qualified: true,
    observedValue: 25n,
    matchingLogs: 2,
  });
  assert.deepEqual(
    qualifyReceipt(
      { status: 1, blockNumber: 99, logs: [matchingLog(1)] },
      CONFIGURATION,
    ),
    { qualified: false, reason: "outside policy window" },
  );
  assert.deepEqual(
    qualifyReceipt(
      {
        status: 1,
        blockNumber: 100,
        logs: [
          matchingLog(1, {
            topics: [SIGNATURE, `0x${"ff".repeat(32)}`, topicAddress(OTHER)],
          }),
        ],
      },
      CONFIGURATION,
    ),
    { qualified: false, reason: "no exact policy event match" },
  );
  assert.deepEqual(
    qualifyReceipt(
      {
        status: 1,
        blockNumber: 100,
        logs: [matchingLog((1n << 256n) - 1n), matchingLog(1)],
      },
      CONFIGURATION,
    ),
    {
      qualified: true,
      observedValue: (1n << 256n) - 1n,
      matchingLogs: 2,
    },
  );
});

test("duplicate operator instances are refused until the owning lock releases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-operator-lock-"));
  const lockPath = join(directory, "operator.lock");
  const lock = acquireProcessLock(lockPath, { mode: "test" });
  try {
    assert.throws(() => acquireProcessLock(lockPath), /already exists/);
    const metadata = JSON.parse(await readFile(lockPath, "utf8"));
    assert.equal(metadata.pid, process.pid);
  } finally {
    lock.release();
  }
  const second = acquireProcessLock(lockPath);
  second.release();
  await rm(directory, { recursive: true, force: true });
});

test("a demonstrably dead process lock is recovered but malformed ownership is never stolen", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "recourse-operator-stale-lock-"),
  );
  const lockPath = join(directory, "operator.lock");
  try {
    await writeFile(
      lockPath,
      `${JSON.stringify({ schemaVersion: 1, pid: 2_147_483_647, token: "dead", startedAt: "2026-01-01T00:00:00.000Z" })}\n`,
      "utf8",
    );
    const recovered = acquireProcessLock(lockPath);
    assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, process.pid);
    recovered.release();

    await writeFile(lockPath, "not-json\n", "utf8");
    assert.throws(() => acquireProcessLock(lockPath), /refusing to steal/);
    assert.equal(await readFile(lockPath, "utf8"), "not-json\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a transaction journal is durable before broadcast and resumes the same signed transaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-operator-journal-"));
  const statePath = join(directory, "job.json");
  const wallet = Wallet.createRandom();
  const populated = {
    to: TOKEN,
    data: "0xabcd",
    nonce: 9,
    chainId: 102031,
    type: 0,
    gasLimit: 100_000,
    gasPrice: 1,
  };
  const calls = [];
  try {
    const prepared = await prepareJournaledTransaction({
      kind: "commit",
      signer: {
        populateTransaction: async (request) => {
          calls.push(["populate", request]);
          return populated;
        },
        signTransaction: async (request) => {
          calls.push(["sign", request]);
          return wallet.signTransaction(request);
        },
        getAddress: async () => wallet.address,
      },
      request: { to: TOKEN, data: "0xabcd" },
      feePolicy: FEE_POLICY,
      state: { schemaVersion: 2, phase: "prepared" },
      statePath,
    });
    const persistedBeforeBroadcast = JSON.parse(
      await readFile(statePath, "utf8"),
    );
    const { transactionHash, rawTransaction } =
      persistedBeforeBroadcast.pending;
    assert.equal(persistedBeforeBroadcast.pending.from, wallet.address);
    assert.equal(persistedBeforeBroadcast.pending.to, TOKEN);
    assert.equal(persistedBeforeBroadcast.pending.chainId, "102031");
    assert.equal(persistedBeforeBroadcast.pending.nonce, 9);
    assert.deepEqual(calls, [
      ["populate", { to: TOKEN, data: "0xabcd", type: 0 }],
      ["sign", populated],
    ]);

    let broadcasts = 0;
    let receiptReads = 0;
    const blockHash = `0x${"45".repeat(32)}`;
    const reconciled = await reconcileJournaledTransaction({
      provider: {
        getNetwork: async () => ({ chainId: 102031n }),
        getTransactionReceipt: async () => {
          receiptReads += 1;
          return receiptReads === 1
            ? null
            : {
                hash: transactionHash,
                status: 1,
                blockNumber: 44,
                blockHash,
              };
        },
        getTransaction: async () =>
          broadcasts > 0 ? Transaction.from(rawTransaction) : null,
        getTransactionCount: async () => 9,
        getBlockNumber: async () => 44,
        getBlock: async () => ({ hash: blockHash }),
        broadcastTransaction: async (raw) => {
          broadcasts += 1;
          assert.equal(raw, rawTransaction);
        },
      },
      state: prepared,
      statePath,
      kind: "commit",
      successPhase: "committed",
      feePolicy: FEE_POLICY,
      delay: async () => {},
    });
    assert.equal(broadcasts, 1);
    assert.equal(reconciled.state.phase, "committed");
    assert.equal(reconciled.state.commitTransactionHash, transactionHash);
    assert.equal(reconciled.state.commitBlock, 44);
    assert.equal(reconciled.state.pending, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a signer cannot substitute a different self-consistent transaction", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "recourse-signer-substitute-"),
  );
  const statePath = join(directory, "job.json");
  const wallet = Wallet.createRandom();
  try {
    await assert.rejects(
      prepareJournaledTransaction({
        kind: "commit",
        signer: {
          populateTransaction: async () => ({
            to: TOKEN,
            data: "0xabcd",
            value: 0,
            nonce: 9,
            chainId: 102031,
            type: 0,
            gasLimit: 100_000,
            gasPrice: 1,
          }),
          signTransaction: async () =>
            wallet.signTransaction({
              to: OTHER,
              data: "0xabcd",
              value: 0,
              nonce: 9,
              chainId: 102031,
              type: 0,
              gasLimit: 100_000,
              gasPrice: 1,
            }),
          getAddress: async () => wallet.address,
        },
        request: { to: TOKEN, data: "0xabcd" },
        feePolicy: FEE_POLICY,
        state: { schemaVersion: 2, phase: "approved" },
        statePath,
      }),
      /signed transaction does not match the populated intent/i,
    );
    await assert.rejects(readFile(statePath, "utf8"), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("RPC-populated transactions cannot exceed the approved fee envelope", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-fee-envelope-"));
  const wallet = Wallet.createRandom();
  try {
    for (const [label, populated, expected] of [
      [
        "gas price",
        {
          to: TOKEN,
          nonce: 1,
          chainId: 102031,
          type: 0,
          gasLimit: 100_000,
          gasPrice: 3,
        },
        /gas price exceeds the configured maximum/,
      ],
      [
        "gas limit",
        {
          to: TOKEN,
          nonce: 1,
          chainId: 102031,
          type: 0,
          gasLimit: 200_001,
          gasPrice: 1,
        },
        /gas limit exceeds the configured maximum/,
      ],
      [
        "fee mode",
        {
          to: TOKEN,
          nonce: 1,
          chainId: 102031,
          type: 2,
          gasLimit: 100_000,
          maxFeePerGas: 1,
          maxPriorityFeePerGas: 1,
        },
        /must use a legacy transaction/,
      ],
    ]) {
      const statePath = join(directory, `${label.replace(" ", "-")}.json`);
      let signed = 0;
      await assert.rejects(
        prepareJournaledTransaction({
          kind: "commit",
          signer: {
            populateTransaction: async () => populated,
            signTransaction: async () => {
              signed += 1;
              return wallet.signTransaction(populated);
            },
            getAddress: async () => wallet.address,
          },
          request: { to: TOKEN },
          feePolicy: FEE_POLICY,
          state: { schemaVersion: 2, phase: "approved" },
          statePath,
        }),
        expected,
      );
      assert.equal(signed, 0);
      await assert.rejects(readFile(statePath, "utf8"), /ENOENT/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("journaled fee fields are signed exactly and live validity is rechecked before first broadcast", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-fee-journal-"));
  const statePath = join(directory, "job.json");
  const wallet = Wallet.createRandom();
  const populated = {
    to: TOKEN,
    nonce: 4,
    chainId: 102031,
    type: 0,
    gasLimit: 100_000,
    gasPrice: 1,
  };
  try {
    const prepared = await prepareJournaledTransaction({
      kind: "commit",
      signer: {
        populateTransaction: async () => populated,
        signTransaction: async (request) => wallet.signTransaction(request),
        getAddress: async () => wallet.address,
      },
      request: { to: TOKEN },
      feePolicy: FEE_POLICY,
      state: { schemaVersion: 2, phase: "approved" },
      statePath,
    });
    await assert.rejects(
      reconcileJournaledTransaction({
        provider: {},
        state: {
          ...prepared,
          pending: { ...prepared.pending, gasPrice: "2" },
        },
        statePath,
        kind: "commit",
        successPhase: "committed",
        feePolicy: FEE_POLICY,
      }),
      /signed transaction journal metadata mismatch/i,
    );

    let checks = 0;
    let broadcasts = 0;
    await assert.rejects(
      reconcileJournaledTransaction({
        provider: {
          getNetwork: async () => ({ chainId: 102031n }),
          getTransactionReceipt: async () => null,
          getTransaction: async () => null,
          getTransactionCount: async () => 4,
          broadcastTransaction: async () => {
            broadcasts += 1;
          },
        },
        state: prepared,
        statePath,
        kind: "commit",
        successPhase: "committed",
        feePolicy: FEE_POLICY,
        maxReceiptPolls: 1,
        beforeBroadcast: async () => {
          checks += 1;
          throw new OperatorIncidentError("live approval expired");
        },
      }),
      /live approval expired/,
    );
    assert.equal(checks, 1);
    assert.equal(broadcasts, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("receipt reconciliation after a crash never rebroadcasts an already-mined transaction", async () => {
  const wallet = Wallet.createRandom();
  const rawTransaction = await wallet.signTransaction({
    to: TOKEN,
    nonce: 3,
    chainId: 102031,
    type: 0,
    gasLimit: 100_000,
    gasPrice: 1,
  });
  const prepared = await prepareJournaledTransaction({
    kind: "reveal",
    signer: {
      populateTransaction: async () => ({
        to: TOKEN,
        nonce: 3,
        chainId: 102031,
        type: 0,
        gasLimit: 100_000,
        gasPrice: 1,
      }),
      signTransaction: async () => rawTransaction,
      getAddress: async () => wallet.address,
    },
    request: {},
    feePolicy: FEE_POLICY,
    state: { schemaVersion: 2, phase: "committed" },
    statePath: join(tmpdir(), `recourse-prepared-${process.pid}.json`),
  });
  const transactionHash = prepared.pending.transactionHash;
  const blockHash = `0x${"46".repeat(32)}`;
  let broadcasts = 0;
  let preBroadcastChecks = 0;
  const result = await reconcileJournaledTransaction({
    provider: {
      getNetwork: async () => ({ chainId: 102031n }),
      getTransactionReceipt: async (hash) => {
        assert.equal(hash, transactionHash);
        return { hash: transactionHash, status: 1, blockNumber: 45, blockHash };
      },
      getBlockNumber: async () => 45,
      getBlock: async () => ({ hash: blockHash }),
      getTransaction: async () => Transaction.from(rawTransaction),
      broadcastTransaction: async () => {
        broadcasts += 1;
      },
    },
    state: prepared,
    statePath: join(tmpdir(), `recourse-reconciled-${process.pid}.json`),
    kind: "reveal",
    successPhase: "revealed",
    feePolicy: FEE_POLICY,
    beforeBroadcast: async () => {
      preBroadcastChecks += 1;
      throw new Error("already-public transactions must not be re-authorized");
    },
  });
  assert.equal(broadcasts, 0);
  assert.equal(preBroadcastChecks, 0);
  assert.equal(result.state.revealBlock, 45);
  await rm(join(tmpdir(), `recourse-reconciled-${process.pid}.json`), {
    force: true,
  });
  await rm(join(tmpdir(), `recourse-prepared-${process.pid}.json`), {
    force: true,
  });
});

test("a mined revert retains decoded replay data for incident handling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-revert-data-"));
  const statePath = join(directory, "job.json");
  const wallet = Wallet.createRandom();
  const rawTransaction = await wallet.signTransaction({
    to: TOKEN,
    nonce: 3,
    chainId: 102031,
    type: 0,
    gasLimit: 100_000,
    gasPrice: 1,
  });
  const prepared = await prepareJournaledTransaction({
    kind: "commit",
    signer: {
      populateTransaction: async () => ({
        to: TOKEN,
        nonce: 3,
        chainId: 102031,
        type: 0,
        gasLimit: 100_000,
        gasPrice: 1,
      }),
      signTransaction: async () => rawTransaction,
      getAddress: async () => wallet.address,
    },
    request: {},
    feePolicy: FEE_POLICY,
    state: { schemaVersion: 2, phase: "approved" },
    statePath,
  });
  const revertData = new Interface(["error Error(string)"]).encodeErrorResult(
    "Error",
    ["reservation lost"],
  );
  try {
    await assert.rejects(
      reconcileJournaledTransaction({
        provider: {
          getNetwork: async () => ({ chainId: 102031n }),
          getTransactionReceipt: async () => ({
            hash: prepared.pending.transactionHash,
            status: 0,
            blockNumber: 45,
            blockHash: `0x${"46".repeat(32)}`,
          }),
          call: async (request) => {
            assert.equal(request.blockTag, 45);
            throw { data: revertData };
          },
        },
        state: prepared,
        statePath,
        kind: "commit",
        successPhase: "committed",
        feePolicy: FEE_POLICY,
      }),
      (error) => {
        assert.equal(error instanceof OperatorIncidentError, true);
        assert.deepEqual(error.revert, {
          data: revertData,
          name: "Error",
          args: ["reservation lost"],
          reason: "reservation lost",
        });
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("journal reconciliation waits for target confirmations and detects a shallow reorg", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-confirmations-"));
  const statePath = join(directory, "job.json");
  const wallet = Wallet.createRandom();
  const rawTransaction = await wallet.signTransaction({
    to: TOKEN,
    nonce: 5,
    chainId: 102031,
    type: 0,
    gasLimit: 100_000,
    gasPrice: 1,
  });
  const prepared = await prepareJournaledTransaction({
    kind: "commit",
    signer: {
      populateTransaction: async () => ({
        to: TOKEN,
        nonce: 5,
        chainId: 102031,
        type: 0,
        gasLimit: 100_000,
        gasPrice: 1,
      }),
      signTransaction: async () => rawTransaction,
      getAddress: async () => wallet.address,
    },
    request: {},
    feePolicy: FEE_POLICY,
    state: { schemaVersion: 2, phase: "approved" },
    statePath,
  });
  const receipt = {
    hash: prepared.pending.transactionHash,
    status: 1,
    blockNumber: 50,
    blockHash: `0x${"66".repeat(32)}`,
  };
  let head = 49;
  let delays = 0;
  const provider = {
    getNetwork: async () => ({ chainId: 102031n }),
    getTransactionReceipt: async () => receipt,
    getBlockNumber: async () => {
      head += 1;
      return head;
    },
    getBlock: async () => ({ hash: receipt.blockHash }),
    getTransaction: async () => Transaction.from(rawTransaction),
  };
  try {
    const confirmed = await reconcileJournaledTransaction({
      provider,
      state: prepared,
      statePath,
      kind: "commit",
      successPhase: "committed",
      feePolicy: FEE_POLICY,
      targetConfirmations: 3,
      maxReceiptPolls: 4,
      delay: async () => {
        delays += 1;
      },
    });
    assert.equal(delays, 2);
    assert.equal(confirmed.state.phase, "committed");

    await writeFile(
      statePath,
      `${JSON.stringify(prepared, null, 2)}\n`,
      "utf8",
    );
    await assert.rejects(
      reconcileJournaledTransaction({
        provider: {
          ...provider,
          getBlockNumber: async () => 52,
          getBlock: async () => ({ hash: `0x${"77".repeat(32)}` }),
        },
        state: prepared,
        statePath,
        kind: "commit",
        successPhase: "committed",
        feePolicy: FEE_POLICY,
        targetConfirmations: 3,
        maxReceiptPolls: 1,
      }),
      OperatorIncidentError,
    );
    assert.notEqual(
      JSON.parse(await readFile(statePath, "utf8")).pending,
      null,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a missing journaled transaction with an advanced signer nonce becomes an incident", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-nonce-incident-"));
  const statePath = join(directory, "job.json");
  const wallet = Wallet.createRandom();
  const rawTransaction = await wallet.signTransaction({
    to: TOKEN,
    nonce: 6,
    chainId: 102031,
    type: 0,
    gasLimit: 100_000,
    gasPrice: 1,
  });
  const prepared = await prepareJournaledTransaction({
    kind: "reveal",
    signer: {
      populateTransaction: async () => ({
        to: TOKEN,
        nonce: 6,
        chainId: 102031,
        type: 0,
        gasLimit: 100_000,
        gasPrice: 1,
      }),
      signTransaction: async () => rawTransaction,
      getAddress: async () => wallet.address,
    },
    request: {},
    feePolicy: FEE_POLICY,
    state: { schemaVersion: 2, phase: "committed" },
    statePath,
  });
  let broadcasts = 0;
  try {
    await assert.rejects(
      reconcileJournaledTransaction({
        provider: {
          getNetwork: async () => ({ chainId: 102031n }),
          getTransactionReceipt: async () => null,
          getTransaction: async () => null,
          getTransactionCount: async (_from, tag) => (tag === "latest" ? 7 : 7),
          broadcastTransaction: async () => {
            broadcasts += 1;
          },
        },
        state: prepared,
        statePath,
        kind: "reveal",
        successPhase: "revealed",
        feePolicy: FEE_POLICY,
        maxReceiptPolls: 1,
      }),
      /nonce 6 was advanced or replaced/,
    );
    assert.equal(broadcasts, 0);
    assert.ok(JSON.parse(await readFile(statePath, "utf8")).pending);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("abortable delay removes its abort listener when the timer wins", async () => {
  const controller = new AbortController();
  const { signal } = controller;
  const originalAdd = signal.addEventListener.bind(signal);
  const originalRemove = signal.removeEventListener.bind(signal);
  let listeners = 0;
  signal.addEventListener = (...args) => {
    listeners += 1;
    return originalAdd(...args);
  };
  signal.removeEventListener = (...args) => {
    listeners -= 1;
    return originalRemove(...args);
  };
  await abortableDelay(1, signal);
  assert.equal(listeners, 0);
});

test("bounded retry backoff resets externally and never exceeds its cap", () => {
  assert.equal(nextBackoff(undefined, 1_000, 8_000), 1_000);
  assert.equal(nextBackoff(1_000, 1_000, 8_000), 2_000);
  assert.equal(nextBackoff(8_000, 1_000, 8_000), 8_000);
});
