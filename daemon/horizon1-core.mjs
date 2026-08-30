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

export function assertProvenTransactionMatchesSource({
  encodedTransaction,
  sourceTransaction,
  sourceReceipt,
}) {
  if (!isHexString(encodedTransaction)) {
    throw new Error("Invalid encoded source transaction");
  }
  const [transactionType, chunks] = coder.decode(
    ["uint8", "bytes[]"],
    encodedTransaction,
  );
  const type = Number(transactionType);
  const expectedChunks = type <= 2 ? 3 : 4;
  if (type < 0 || type > 4 || chunks.length !== expectedChunks) {
    throw new Error("Invalid encoded source transaction layout");
  }
  const [nonce, gasLimit, from, toIsNull, to, value, data] = coder.decode(
    ["uint64", "uint64", "address", "bool", "address", "uint256", "bytes"],
    chunks[0],
  );
  if (
    Number(nonce) !== sourceTransaction.nonce ||
    gasLimit !== BigInt(sourceTransaction.gasLimit) ||
    getAddress(from) !== getAddress(sourceTransaction.from) ||
    Boolean(toIsNull) !== (sourceTransaction.to === null) ||
    (!toIsNull && getAddress(to) !== getAddress(sourceTransaction.to)) ||
    value !== BigInt(sourceTransaction.value) ||
    data.toLowerCase() !== sourceTransaction.data.toLowerCase()
  ) {
    throw new Error(
      "Proved transaction fields do not match the canonical source transaction",
    );
  }
  const [status, gasUsed, logs, logsBloom] = coder.decode(
    [
      "uint8",
      "uint64",
      "tuple(address address_,bytes32[] topics,bytes data)[]",
      "bytes",
    ],
    chunks[type <= 2 ? 2 : 3],
  );
  if (
    Number(status) !== sourceReceipt.status ||
    gasUsed !== BigInt(sourceReceipt.gasUsed) ||
    logsBloom.toLowerCase() !== sourceReceipt.logsBloom.toLowerCase()
  ) {
    throw new Error(
      "Proved receipt fields do not match the canonical source receipt",
    );
  }
  if (
    logs.length !== sourceReceipt.logs.length ||
    logs.some((log, index) => {
      const canonical = sourceReceipt.logs[index];
      return (
        getAddress(log.address_) !== getAddress(canonical.address) ||
        log.data.toLowerCase() !== canonical.data.toLowerCase() ||
        log.topics.length !== canonical.topics.length ||
        log.topics.some(
          (topic, topicIndex) =>
            topic.toLowerCase() !== canonical.topics[topicIndex].toLowerCase(),
        )
      );
    })
  ) {
    throw new Error(
      "Proved receipt logs do not match the canonical source receipt",
    );
  }
  return true;
}

export async function assertProofPreflight({
  verifier,
  kernel,
  chainKey,
  height,
  encodedTransaction,
  merkleProof,
  continuityProof,
  expectedTransactionIndex,
  facility,
  policyId,
  requirementsDigest,
  proof,
  hunter,
  proofJobs,
}) {
  const verified = await verifier.verify.staticCall(
    chainKey,
    height,
    encodedTransaction,
    merkleProof,
    continuityProof,
  );
  if (verified !== true) throw new Error("Native proof preflight failed");
  const transactionIndex = await verifier.calculateTxIndex(merkleProof);
  if (transactionIndex !== BigInt(expectedTransactionIndex)) {
    throw new Error(
      "Proof transaction index does not match the canonical receipt",
    );
  }
  const evaluation = await kernel.evaluateProofJob.staticCall(
    facility,
    policyId,
    requirementsDigest,
    proof,
    hunter,
    { from: proofJobs },
  );
  if ((evaluation.accepted ?? evaluation[0]) !== true) {
    throw new Error("Kernel proof preflight did not accept the exact evidence");
  }
  return true;
}

export function validateResumeState(state, expected) {
  if (
    !state ||
    (state.version !== 1 && state.version !== 2 && state.version !== 3)
  )
    throw new Error("Invalid resume state version");
  if (
    state.phase !== "prepared" &&
    state.phase !== "approved" &&
    state.phase !== "committed" &&
    state.phase !== "released" &&
    state.phase !== "incident" &&
    state.phase !== "revealed"
  ) {
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
  let sourceTransactionIndex;
  let attestation;
  if (state.version === 3) {
    sourceTransactionIndex = requireUnsignedInteger(
      state.sourceTransactionIndex,
      "source transaction index",
    );
    const attestationHeight = requireUnsignedInteger(
      state.attestation?.height,
      "attestation height",
    );
    if (attestationHeight < sourceHeight) {
      throw new Error("Attestation does not cover the source height");
    }
    attestation = {
      height: attestationHeight,
      hash: requireBytes32(state.attestation?.hash, "attestation hash"),
      isAttestation: state.attestation?.isAttestation === true,
    };
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

  let commitBlock;
  let commitTransactionHash;
  if (
    state.phase === "committed" ||
    state.phase === "released" ||
    state.phase === "incident" ||
    state.phase === "revealed"
  ) {
    commitBlock = requireUnsignedInteger(state.commitBlock, "commit block");
    if (commitBlock === 0) throw new Error("Invalid commit block");
    commitTransactionHash = requireTransactionHash(
      state.commitTransactionHash,
      "commit transaction hash",
    );
  }
  let revealTransactionHash;
  if (state.phase === "revealed") {
    revealTransactionHash = requireTransactionHash(
      state.revealTransactionHash,
      "reveal transaction hash",
    );
  }
  if (
    state.phase === "incident" &&
    (typeof state.incident?.reason !== "string" ||
      state.incident.reason.trim().length === 0)
  ) {
    throw new Error("Invalid incident reason");
  }

  let pending = null;
  if (state.pending !== undefined && state.pending !== null) {
    const expectedKinds =
      state.phase === "prepared"
        ? ["approval"]
        : state.phase === "approved"
          ? ["commit"]
          : state.phase === "committed"
            ? ["reveal", "release"]
            : [];
    if (!expectedKinds.includes(state.pending.kind)) {
      throw new Error("Invalid pending transaction phase");
    }
    const transactionHash = requireTransactionHash(
      state.pending.transactionHash,
      "pending transaction hash",
    );
    if (!isHexString(state.pending.rawTransaction)) {
      throw new Error("Invalid pending raw transaction");
    }
    if (keccak256(state.pending.rawTransaction) !== transactionHash) {
      throw new Error("Pending transaction hash mismatch");
    }
    pending = { ...state.pending, transactionHash };
  }

  return {
    ...state,
    version: state.version === 3 ? 3 : 2,
    chainId,
    jobId,
    hunter,
    facility,
    policyId,
    requirementsDigest,
    sourceTransactionHash,
    sourceHeight,
    sourceTransactionIndex,
    attestation,
    evidenceDigest,
    salt,
    commitment,
    commitBlock,
    commitTransactionHash,
    revealTransactionHash,
    pending,
  };
}
