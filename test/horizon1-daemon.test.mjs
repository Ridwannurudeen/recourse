import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { AbiCoder, getAddress, keccak256 } from "ethers";
import {
  assertProofPreflight,
  assertProvenTransactionMatchesSource,
  computeEvidenceDigest,
  computeJobCommitment,
  encodeKernelProof,
  validateResumeState,
} from "../daemon/horizon1-core.mjs";
import { recoverHorizon1TargetState } from "../daemon/horizon1-recovery.mjs";
import { runHorizon1Job } from "../daemon/horizon1-runner.mjs";

const HASH = (byte) => `0x${byte.repeat(32)}`;
const HUNTER = getAddress("0x0000000000000000000000000000000000000B0b");
const FACILITY = getAddress("0x000000000000000000000000000000000000fac1");
const SOURCE_HASH = HASH("ab");
const REQUIREMENTS = HASH("cd");

function proofFixture() {
  return {
    chainKey: 3,
    height: 25_839_959,
    encodedTransaction: "0x1234",
    merkleProof: {
      root: HASH("11"),
      siblings: [
        { hash: HASH("22"), isLeft: true },
        { hash: HASH("33"), isLeft: false },
      ],
    },
    continuityProof: {
      lowerEndpointDigest: HASH("44"),
      roots: [HASH("55"), HASH("66")],
    },
  };
}

function resumeFixture() {
  const proof = encodeKernelProof(proofFixture());
  const evidenceDigest = computeEvidenceDigest(proof);
  const salt = HASH("77");
  return {
    version: 1,
    phase: "committed",
    chainId: 102031,
    jobId: "1",
    hunter: HUNTER,
    facility: FACILITY,
    policyId: "1",
    requirementsDigest: REQUIREMENTS,
    sourceTransactionHash: SOURCE_HASH,
    sourceHeight: 25_839_959,
    proof,
    evidenceDigest,
    salt,
    commitment: computeJobCommitment(1n, HUNTER, evidenceDigest, salt),
    commitBlock: 5_377_800,
    commitTransactionHash: HASH("88"),
  };
}

function encodedSourceTransaction({ logData = "0x1234" } = {}) {
  const coder = AbiCoder.defaultAbiCoder();
  const common = coder.encode(
    ["uint64", "uint64", "address", "bool", "address", "uint256", "bytes"],
    [7, 100_000, HUNTER, false, FACILITY, 9, "0xabcd"],
  );
  const receipt = coder.encode(
    [
      "uint8",
      "uint64",
      "tuple(address address_,bytes32[] topics,bytes data)[]",
      "bytes",
    ],
    [1, 42_000, [[FACILITY, [HASH("11")], logData]], "0xabcd"],
  );
  return coder.encode(["uint8", "bytes[]"], [2, [common, "0x", receipt]]);
}

const EXPECTED = {
  chainId: 102031,
  jobId: 1n,
  hunter: HUNTER,
  facility: FACILITY,
  policyId: 1n,
  requirementsDigest: REQUIREMENTS,
  sourceTransactionHash: SOURCE_HASH,
  sourceHeight: 25_839_959,
};

test("encodeKernelProof matches the exact Solidity proof tuple", () => {
  const fixture = proofFixture();
  const proof = encodeKernelProof(fixture);
  const [chainKey, height, encodedTransaction, merkleProof, continuityProof] =
    AbiCoder.defaultAbiCoder().decode(
      [
        "uint64",
        "uint64",
        "bytes",
        "tuple(bytes32 root, tuple(bytes32 hash, bool isLeft)[] siblings)",
        "tuple(bytes32 lowerEndpointDigest, bytes32[] roots)",
      ],
      proof,
    );

  assert.equal(chainKey, 3n);
  assert.equal(height, 25_839_959n);
  assert.equal(encodedTransaction, fixture.encodedTransaction);
  assert.equal(merkleProof.root, fixture.merkleProof.root);
  assert.deepEqual([...merkleProof.siblings[0]], [HASH("22"), true]);
  assert.deepEqual([...merkleProof.siblings[1]], [HASH("33"), false]);
  assert.equal(
    continuityProof.lowerEndpointDigest,
    fixture.continuityProof.lowerEndpointDigest,
  );
  assert.deepEqual([...continuityProof.roots], fixture.continuityProof.roots);
});

test("evidence digest and job commitment bind proof, job, hunter, and salt", () => {
  const proof = encodeKernelProof(proofFixture());
  const evidenceDigest = computeEvidenceDigest(proof);
  const salt = HASH("77");

  assert.equal(evidenceDigest, keccak256(proof));
  assert.equal(
    computeJobCommitment(1n, HUNTER, evidenceDigest, salt),
    keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ["uint256", "address", "bytes32", "bytes32"],
        [1n, HUNTER, evidenceDigest, salt],
      ),
    ),
  );
  assert.notEqual(
    computeJobCommitment(1n, HUNTER, evidenceDigest, salt),
    computeJobCommitment(
      1n,
      getAddress("0x0000000000000000000000000000000000000ca7"),
      evidenceDigest,
      salt,
    ),
  );
});

test("proved EVM bytes must exactly match the canonical source transaction and receipt", () => {
  const encodedTransaction = encodedSourceTransaction();
  const sourceTransaction = {
    nonce: 7,
    gasLimit: 100_000n,
    from: HUNTER,
    to: FACILITY,
    value: 9n,
    data: "0xabcd",
  };
  const sourceReceipt = {
    status: 1,
    gasUsed: 42_000n,
    logsBloom: "0xabcd",
    logs: [{ address: FACILITY, topics: [HASH("11")], data: "0x1234" }],
  };
  assert.equal(
    assertProvenTransactionMatchesSource({
      encodedTransaction,
      sourceTransaction,
      sourceReceipt,
    }),
    true,
  );
  assert.throws(
    () =>
      assertProvenTransactionMatchesSource({
        encodedTransaction: encodedSourceTransaction({ logData: "0x5678" }),
        sourceTransaction,
        sourceReceipt,
      }),
    /receipt logs do not match/,
  );
});

test("proof preflight binds native transaction index and full kernel evaluation", async () => {
  const argumentsSeen = [];
  const input = {
    verifier: {
      verify: { staticCall: async () => true },
      calculateTxIndex: async () => 4n,
    },
    kernel: {
      evaluateProofJob: {
        staticCall: async (...args) => {
          argumentsSeen.push(args);
          return [true, 2n];
        },
      },
    },
    chainKey: 3,
    height: 100,
    encodedTransaction: encodedSourceTransaction(),
    merkleProof: { root: HASH("22"), siblings: [] },
    continuityProof: { lowerEndpointDigest: HASH("33"), roots: [HASH("44")] },
    expectedTransactionIndex: 4,
    facility: FACILITY,
    policyId: 1,
    requirementsDigest: REQUIREMENTS,
    proof: encodeKernelProof({
      chainKey: 3,
      height: 100,
      encodedTransaction: encodedSourceTransaction(),
      merkleProof: { root: HASH("22"), siblings: [] },
      continuityProof: { lowerEndpointDigest: HASH("33"), roots: [HASH("44")] },
    }),
    hunter: HUNTER,
    proofJobs: FACILITY,
  };
  assert.equal(await assertProofPreflight(input), true);
  assert.equal(argumentsSeen[0].at(-1).from, FACILITY);
  await assert.rejects(
    assertProofPreflight({
      ...input,
      verifier: {
        verify: { staticCall: async () => true },
        calculateTxIndex: async () => 5n,
      },
    }),
    /transaction index does not match/,
  );
});

test("validateResumeState accepts an internally and externally bound committed state", () => {
  const state = resumeFixture();
  const validated = validateResumeState(state, EXPECTED);

  assert.equal(validated.jobId, 1n);
  assert.equal(validated.policyId, 1n);
  assert.equal(validated.sourceHeight, 25_839_959);
  assert.equal(validated.commitBlock, 5_377_800);
  assert.equal(validated.commitment, state.commitment);
});

test("schema v3 resume state retains the source index and attestation digest", () => {
  const state = {
    ...resumeFixture(),
    version: 3,
    sourceTransactionIndex: 4,
    attestation: {
      height: 25_839_960,
      hash: HASH("42"),
      isAttestation: true,
    },
  };
  const validated = validateResumeState(state, EXPECTED);
  assert.equal(validated.sourceTransactionIndex, 4);
  assert.deepEqual(validated.attestation, state.attestation);
  assert.throws(
    () =>
      validateResumeState(
        { ...state, attestation: { ...state.attestation, hash: "0x1234" } },
        EXPECTED,
      ),
    /attestation hash/,
  );
  assert.throws(
    () =>
      validateResumeState(
        {
          ...state,
          attestation: {
            ...state.attestation,
            height: state.sourceHeight - 1,
          },
        },
        EXPECTED,
      ),
    /does not cover/,
  );
});

test("validateResumeState rejects lost salts, altered proofs, and deployment mismatches", () => {
  const state = resumeFixture();

  assert.throws(
    () => validateResumeState({ ...state, salt: "0x1234" }, EXPECTED),
    /salt/,
  );
  assert.throws(
    () => validateResumeState({ ...state, proof: "0x5678" }, EXPECTED),
    /evidence digest/,
  );
  assert.throws(
    () => validateResumeState({ ...state, commitment: HASH("99") }, EXPECTED),
    /commitment/,
  );
  assert.throws(
    () =>
      validateResumeState(state, {
        ...EXPECTED,
        requirementsDigest: HASH("ee"),
      }),
    /requirements digest/,
  );
  assert.throws(
    () =>
      validateResumeState(state, {
        ...EXPECTED,
        sourceTransactionHash: HASH("ff"),
      }),
    /source transaction/,
  );
  assert.throws(
    () => validateResumeState(state, { ...EXPECTED, sourceHeight: 25_839_960 }),
    /source height/,
  );
});

test("validateResumeState accepts revealed state only with a reveal transaction hash", () => {
  const state = {
    ...resumeFixture(),
    phase: "revealed",
    revealTransactionHash: HASH("99"),
  };
  assert.equal(validateResumeState(state, EXPECTED).phase, "revealed");
  assert.throws(
    () =>
      validateResumeState(
        { ...state, revealTransactionHash: undefined },
        EXPECTED,
      ),
    /reveal transaction/,
  );
});

test("validateResumeState binds each pre-broadcast journal to its exact lifecycle phase", () => {
  const rawTransaction = "0x1234";
  const transactionHash = keccak256(rawTransaction);
  const prepared = {
    ...resumeFixture(),
    version: 2,
    phase: "prepared",
    commitBlock: undefined,
    commitTransactionHash: undefined,
    pending: {
      kind: "approval",
      transactionHash,
      rawTransaction,
    },
  };
  const validated = validateResumeState(prepared, EXPECTED);
  assert.equal(validated.phase, "prepared");
  assert.equal(validated.pending.transactionHash, transactionHash);
  assert.throws(
    () =>
      validateResumeState(
        { ...prepared, pending: { ...prepared.pending, kind: "reveal" } },
        EXPECTED,
      ),
    /pending transaction phase/,
  );
  assert.throws(
    () =>
      validateResumeState(
        {
          ...prepared,
          pending: { ...prepared.pending, transactionHash: HASH("99") },
        },
        EXPECTED,
      ),
    /journal hash mismatch|transaction hash mismatch/i,
  );
});

test("a committed restart remains valid without re-proving the already-posted bond balance", () => {
  const committed = resumeFixture();
  const resumed = validateResumeState(committed, EXPECTED);
  assert.equal(resumed.phase, "committed");
  assert.equal(resumed.commitTransactionHash, committed.commitTransactionHash);
  assert.equal(Object.hasOwn(resumed, "balance"), false);
});

test("release recovery journals are valid only while a commitment is committed", () => {
  const rawTransaction = "0x1234";
  const transactionHash = keccak256(rawTransaction);
  const releasing = {
    ...resumeFixture(),
    version: 2,
    pending: { kind: "release", transactionHash, rawTransaction },
  };
  assert.equal(
    validateResumeState(releasing, EXPECTED).pending.kind,
    "release",
  );
  assert.throws(
    () =>
      validateResumeState(
        {
          ...releasing,
          phase: "revealed",
          revealTransactionHash: HASH("99"),
        },
        EXPECTED,
      ),
    /pending transaction phase/,
  );
});

test("incident resume state requires a durable reason", () => {
  assert.throws(
    () =>
      validateResumeState(
        { ...resumeFixture(), phase: "incident", incident: undefined },
        EXPECTED,
      ),
    /incident reason/,
  );
  const state = {
    ...resumeFixture(),
    phase: "incident",
    incident: {
      reason: "reveal deadline elapsed",
      recordedAt: "2026-08-30T00:00:00.000Z",
    },
  };
  assert.equal(validateResumeState(state, EXPECTED).phase, "incident");
});

test("runner forwards abort to the child and reports a durable-boundary stop", async () => {
  const controller = new AbortController();
  const child = new EventEmitter();
  let killedWith;
  child.kill = (signal) => {
    killedWith = signal;
    queueMicrotask(() => child.emit("exit", 4, null));
  };
  const resultPromise = runHorizon1Job({
    transactionHash: SOURCE_HASH,
    jobId: 1,
    statePath: "daemon/operator-data/test-state.json",
    deploymentPath: "deployments-horizon1.json",
    signal: controller.signal,
    executionPolicy: { targetConfirmations: 2 },
    spawnProcess: () => child,
  });
  controller.abort();
  assert.deepEqual(await resultPromise, { status: "aborted" });
  assert.equal(killedWith, "SIGTERM");
});

test("offline committed recovery releases a job finalized while the operator was stopped", async () => {
  const state = resumeFixture();
  const calls = [];
  const result = await recoverHorizon1TargetState({
    provider: { getBlockNumber: async () => 5_377_801 },
    jobsRead: {
      getJob: async () => ({ state: 1n }),
      getCommitment: async () => ({ bond: 10n }),
    },
    jobs: {
      releaseCommit: {
        populateTransaction: async (jobId) => {
          calls.push(["release", jobId]);
          return { to: FACILITY, data: "0x1234" };
        },
      },
    },
    hunter: { address: HUNTER },
    jobId: 1n,
    state,
    statePath: "unused.json",
    expectedState: EXPECTED,
    confirmationPolicy: {},
    assertCanStartTransaction: () => {},
    prepareTransaction: async ({ state: current }) => ({
      ...current,
      pending: { kind: "release" },
    }),
    reconcileTransaction: async ({ state: current }) => ({
      state: { ...current, phase: "released", pending: null },
    }),
  });
  assert.equal(result.status, "released");
  assert.deepEqual(calls, [["release", 1n]]);
});

test("pending reveal journal reconciles using only target-chain dependencies", async () => {
  const state = {
    ...resumeFixture(),
    pending: { kind: "reveal" },
  };
  const result = await recoverHorizon1TargetState({
    provider: {},
    jobsRead: {
      getJob: async () => {
        throw new Error(
          "must not read source or job after reveal reconciliation",
        );
      },
    },
    jobs: {},
    hunter: { address: HUNTER },
    jobId: 1n,
    state,
    statePath: "unused.json",
    expectedState: EXPECTED,
    confirmationPolicy: {},
    assertCanStartTransaction: () => {},
    reconcileTransaction: async () => ({
      state: {
        ...state,
        phase: "revealed",
        pending: null,
        revealTransactionHash: HASH("99"),
      },
    }),
  });
  assert.equal(result.status, "revealed");
});
