import assert from "node:assert/strict";
import test from "node:test";
import { AbiCoder, getAddress, keccak256 } from "ethers";
import {
  computeEvidenceDigest,
  computeJobCommitment,
  encodeKernelProof,
  validateResumeState,
} from "../daemon/horizon1-core.mjs";

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

test("validateResumeState accepts an internally and externally bound committed state", () => {
  const state = resumeFixture();
  const validated = validateResumeState(state, EXPECTED);

  assert.equal(validated.jobId, 1n);
  assert.equal(validated.policyId, 1n);
  assert.equal(validated.sourceHeight, 25_839_959);
  assert.equal(validated.commitBlock, 5_377_800);
  assert.equal(validated.commitment, state.commitment);
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
