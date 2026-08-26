import { AbiCoder, getAddress, isHexString, keccak256 } from "ethers";

export const KERNEL_PROOF_TYPES = [
  "uint64",
  "uint64",
  "bytes",
  "tuple(bytes32 root, tuple(bytes32 hash, bool isLeft)[] siblings)",
  "tuple(bytes32 lowerEndpointDigest, bytes32[] roots)",
];

const coder = AbiCoder.defaultAbiCoder();

function requireBytes32(value, label) {
  if (!isHexString(value, 32)) throw new Error(`Invalid ${label}`);
  return value.toLowerCase();
}

function requireTransactionHash(value, label) {
  return requireBytes32(value, label);
}

function requireUnsignedInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new Error(`Invalid ${label}`);
  return number;
}

function requireBigInt(value, label) {
  try {
    const number = BigInt(value);
    if (number < 0n) throw new Error();
    return number;
  } catch {
    throw new Error(`Invalid ${label}`);
  }
}

export function encodeKernelProof({
  chainKey,
  height,
  encodedTransaction,
  merkleProof,
  continuityProof,
}) {
  if (!isHexString(encodedTransaction))
    throw new Error("Invalid encoded transaction");
  return coder.encode(KERNEL_PROOF_TYPES, [
    chainKey,
    height,
    encodedTransaction,
    merkleProof,
    continuityProof,
  ]);
}

export function computeEvidenceDigest(proof) {
  if (!isHexString(proof)) throw new Error("Invalid proof");
  return keccak256(proof);
}

export function computeJobCommitment(jobId, hunter, evidenceDigest, salt) {
  return keccak256(
    coder.encode(
      ["uint256", "address", "bytes32", "bytes32"],
      [
        jobId,
        getAddress(hunter),
        requireBytes32(evidenceDigest, "evidence digest"),
        requireBytes32(salt, "salt"),
      ],
    ),
  );
}

export function validateResumeState(state, expected) {
  if (!state || state.version !== 1)
    throw new Error("Invalid resume state version");
  if (state.phase !== "committed" && state.phase !== "revealed") {
    throw new Error("Invalid resume state phase");
  }

  const chainId = requireUnsignedInteger(state.chainId, "chain ID");
  if (chainId !== expected.chainId) throw new Error("Resume chain ID mismatch");

  const jobId = requireBigInt(state.jobId, "job ID");
  if (jobId !== BigInt(expected.jobId))
    throw new Error("Resume job ID mismatch");
  const policyId = requireBigInt(state.policyId, "policy ID");
  if (policyId !== BigInt(expected.policyId))
    throw new Error("Resume policy ID mismatch");

  const hunter = getAddress(state.hunter);
  if (hunter !== getAddress(expected.hunter))
    throw new Error("Resume hunter mismatch");
  const facility = getAddress(state.facility);
  if (facility !== getAddress(expected.facility))
    throw new Error("Resume facility mismatch");

  const requirementsDigest = requireBytes32(
    state.requirementsDigest,
    "requirements digest",
  );
  if (
    requirementsDigest !==
    requireBytes32(expected.requirementsDigest, "expected requirements digest")
  ) {
    throw new Error("Resume requirements digest mismatch");
  }
  const sourceTransactionHash = requireTransactionHash(
    state.sourceTransactionHash,
    "source transaction hash",
  );
  if (
    sourceTransactionHash !==
    requireTransactionHash(
      expected.sourceTransactionHash,
      "expected source transaction hash",
    )
  ) {
    throw new Error("Resume source transaction mismatch");
  }

  const sourceHeight = requireUnsignedInteger(
    state.sourceHeight,
    "source height",
  );
  if (
    expected.sourceHeight !== undefined &&
    sourceHeight !==
      requireUnsignedInteger(expected.sourceHeight, "expected source height")
  ) {
    throw new Error("Resume source height mismatch");
  }
  if (!isHexString(state.proof)) throw new Error("Invalid resume proof");
  const evidenceDigest = requireBytes32(
    state.evidenceDigest,
    "evidence digest",
  );
  if (evidenceDigest !== computeEvidenceDigest(state.proof)) {
    throw new Error("Resume evidence digest does not match proof");
  }
  const salt = requireBytes32(state.salt, "salt");
  const commitment = requireBytes32(state.commitment, "commitment");
  if (
    commitment !== computeJobCommitment(jobId, hunter, evidenceDigest, salt)
  ) {
    throw new Error("Resume commitment mismatch");
  }

  const commitBlock = requireUnsignedInteger(state.commitBlock, "commit block");
  if (commitBlock === 0) throw new Error("Invalid commit block");
  const commitTransactionHash = requireTransactionHash(
    state.commitTransactionHash,
    "commit transaction hash",
  );
  let revealTransactionHash;
  if (state.phase === "revealed") {
    revealTransactionHash = requireTransactionHash(
      state.revealTransactionHash,
      "reveal transaction hash",
    );
  }

  return {
    ...state,
    chainId,
    jobId,
    hunter,
    facility,
    policyId,
    requirementsDigest,
    sourceTransactionHash,
    sourceHeight,
    evidenceDigest,
    salt,
    commitment,
    commitBlock,
    commitTransactionHash,
    revealTransactionHash,
  };
}
