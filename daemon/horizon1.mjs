import "dotenv/config";
import {
  Contract,
  Wallet,
  getAddress,
  hexlify,
  isHexString,
  randomBytes,
} from "ethers";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertExactHashMultiset,
  fetchBatchProof,
  getLatestAttestation,
  getProvider,
  getSourceProvider,
} from "../scripts/lib/proofs.mjs";
import {
  assertProofPreflight,
  assertProvenTransactionMatchesSource,
  computeEvidenceDigest,
  computeJobCommitment,
  encodeKernelProof,
  validateResumeState,
} from "./horizon1-core.mjs";
import { recoverHorizon1TargetState } from "./horizon1-recovery.mjs";
import {
  OperatorIncidentError,
  assertCommitReady,
  assertJobEconomics,
  atomicWriteJson,
  prepareJournaledTransaction,
  qualifyReceipt,
  reconcileJournaledTransaction,
  validateExecutionPolicy,
} from "./operator-core.mjs";

const EXPECTED_CHAIN_ID = 102031n;
const EXPECTED_SOURCE_CHAIN_ID = 1n;
const OPEN_JOB_STATE = 0n;
const REVEAL_GAS_LIMIT = 1_500_000n;
const DEFAULT_STATE_FILE = "daemon/horizon1-state.json";
const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
];
const NATIVE_VERIFIER_ABI = [
  "function verify(uint64 chainKey,uint64 height,bytes encodedTransaction,tuple(bytes32 root,tuple(bytes32 hash,bool isLeft)[] siblings) merkleProof,tuple(bytes32 lowerEndpointDigest,bytes32[] roots) continuityProof) view returns (bool)",
  "function calculateTxIndex(tuple(bytes32 root,tuple(bytes32 hash,bool isLeft)[] siblings) merkleProof) view returns (uint64)",
];
let stopping = false;
const shutdownController = new AbortController();
process.on("SIGINT", () => {
  stopping = true;
  shutdownController.abort();
});
process.on("SIGTERM", () => {
  stopping = true;
  shutdownController.abort();
});

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function errorMessage(error) {
  return (
    error?.shortMessage || error?.reason || error?.message || String(error)
  );
}

function artifact(name) {
  return JSON.parse(readFileSync(`out/${name}.sol/${name}.json`, "utf8"));
}

function sameAddress(left, right) {
  return getAddress(left) === getAddress(right);
}

function requireTransactionHash(value, label) {
  if (!isHexString(value, 32)) throw new Error(`Invalid ${label}`);
  return value.toLowerCase();
}

function readInputs() {
  const sourceTransactionHash = requireTransactionHash(
    process.argv[2] || process.env.HORIZON1_SOURCE_TX_HASH,
    "source transaction hash",
  );
  const deploymentPath = resolve(
    process.env.HORIZON1_DEPLOYMENTS_FILE || "deployments-horizon1.json",
  );
  const statePath = resolve(
    process.env.HORIZON1_STATE_FILE || DEFAULT_STATE_FILE,
  );
  const deployments = JSON.parse(readFileSync(deploymentPath, "utf8"));
  const jobId = BigInt(
    process.argv[3] || process.env.HORIZON1_JOB_ID || deployments.proofJobId,
  );
  if (jobId <= 0n) throw new Error("Invalid proof job ID");
  return { deployments, jobId, sourceTransactionHash, statePath };
}

function readExecutionPolicy() {
  if (!process.env.RECOURSE_EXECUTION_POLICY_JSON) {
    throw new Error("RECOURSE_EXECUTION_POLICY_JSON is required for execution");
  }
  return validateExecutionPolicy(
    JSON.parse(process.env.RECOURSE_EXECUTION_POLICY_JSON),
  );
}

function assertCanStartTransaction() {
  if (stopping) {
    const error = new Error("Shutdown requested at a durable journal boundary");
    error.name = "AbortError";
    throw error;
  }
}

async function main() {
  const { deployments, jobId, sourceTransactionHash, statePath } = readInputs();
  const hasResumeState = existsSync(statePath);
  const executionPolicy = readExecutionPolicy();
  const confirmationPolicy = {
    targetConfirmations: executionPolicy.targetConfirmations,
    maxReceiptPolls:
      executionPolicy.targetConfirmations + executionPolicy.recoveryBlocks,
    receiptPollIntervalMs: 1_000,
    signal: shutdownController.signal,
  };
  if (BigInt(deployments.chainId) !== EXPECTED_CHAIN_ID) {
    throw new Error(
      `Refusing deployment record for chain ${deployments.chainId}; expected ${EXPECTED_CHAIN_ID}`,
    );
  }

  const chainKey = Number(deployments.sourceWindow.chainKey);
  if (chainKey !== 3) {
    throw new Error(
      "This Horizon 1 runner supports only source chain key 3 (Ethereum mainnet)",
    );
  }
  const provider = getProvider();
  const network = await provider.getNetwork();
  if (network.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(
      `Refusing CC3 chain ${network.chainId}; expected ${EXPECTED_CHAIN_ID}`,
    );
  }

  if (!process.env.HUNTER_PRIVATE_KEY || !process.env.HUNTER_ADDRESS) {
    throw new Error("HUNTER_PRIVATE_KEY and HUNTER_ADDRESS are required");
  }
  const hunter = new Wallet(process.env.HUNTER_PRIVATE_KEY, provider);
  if (!sameAddress(hunter.address, process.env.HUNTER_ADDRESS)) {
    throw new Error(
      "Refusing to run: HUNTER_PRIVATE_KEY does not match HUNTER_ADDRESS",
    );
  }

  const jobsRead = new Contract(
    deployments.proofJobs,
    artifact("ProofJobsV1").abi,
    provider,
  );
  const jobs = jobsRead.connect(hunter);
  const kernel = new Contract(
    deployments.policyKernel,
    [
      ...artifact("PolicyKernelV1").abi,
      "function safeStaleProofRelease() view returns (bool)",
    ],
    provider,
  );
  const job = await jobsRead.getJob(jobId);
  const latestBlock = await provider.getBlock("latest");
  if (!latestBlock) throw new Error("Latest CC3 block is unavailable");
  let safeStaleRelease;
  try {
    safeStaleRelease = await kernel.safeStaleProofRelease();
  } catch {
    throw new Error(
      "Execution requires a kernel exposing safeStaleProofRelease()",
    );
  }
  if (safeStaleRelease !== true) {
    throw new Error("Kernel does not guarantee safe stale-proof bond release");
  }
  if (!hasResumeState) {
    assertJobEconomics(job, executionPolicy, latestBlock.timestamp);
  }

  if (!sameAddress(job.facility, deployments.demonstrationFacility)) {
    throw new Error("Refusing job for a different facility");
  }
  if (!sameAddress(job.token, deployments.demoAsset)) {
    throw new Error("Refusing job with a different denomination token");
  }
  if (job.policyId !== BigInt(deployments.policyId)) {
    throw new Error("Refusing job for a different policy");
  }
  if (
    job.requirementsDigest.toLowerCase() !==
    deployments.policyConfigHash.toLowerCase()
  ) {
    throw new Error("Refusing job with a different requirements digest");
  }
  const token = new Contract(job.token, ERC20_ABI, hunter);
  const expectedIntentForKind = async (kind, currentState) => {
    let request;
    if (kind === "approval") {
      request = await token.approve.populateTransaction(
        deployments.proofJobs,
        job.commitBond,
      );
    } else if (kind === "commit") {
      request = await jobs.commitEvidence.populateTransaction(
        jobId,
        currentState.evidenceDigest,
        currentState.commitment,
      );
    } else if (kind === "reveal") {
      request = await jobs.revealEvidence.populateTransaction(
        jobId,
        currentState.evidenceDigest,
        currentState.salt,
        currentState.proof,
        { gasLimit: REVEAL_GAS_LIMIT },
      );
    } else if (kind === "release") {
      request = await jobs.releaseCommit.populateTransaction(jobId);
    } else {
      throw new Error(`Unknown transaction journal kind: ${kind}`);
    }
    return {
      chainId: EXPECTED_CHAIN_ID,
      from: hunter.address,
      to: request.to,
      data: request.data ?? "0x",
      value: request.value ?? 0,
    };
  };

  let state;
  if (hasResumeState) {
    const storedState = JSON.parse(readFileSync(statePath, "utf8"));
    const targetExpectedState = {
      chainId: Number(EXPECTED_CHAIN_ID),
      jobId,
      hunter: hunter.address,
      facility: job.facility,
      policyId: job.policyId,
      requirementsDigest: job.requirementsDigest,
      sourceTransactionHash,
      sourceHeight: storedState.sourceHeight,
    };
    state = validateResumeState(storedState, targetExpectedState);
    const recovery = await recoverHorizon1TargetState({
      provider,
      jobsRead,
      jobs,
      hunter,
      jobId,
      state,
      statePath,
      expectedState: targetExpectedState,
      confirmationPolicy,
      assertCanStartTransaction,
      expectedIntentForKind,
    });
    state = recovery.state;
    log(
      `Target-chain recovery reached ${recovery.status} for proof job ${jobId}.`,
    );
    if (
      recovery.status !== "needs-source" ||
      process.env.RECOURSE_RECOVERY_ONLY === "1"
    ) {
      return;
    }
  }

  const sourceProvider = getSourceProvider(chainKey);
  const sourceNetwork = await sourceProvider.getNetwork();
  if (sourceNetwork.chainId !== EXPECTED_SOURCE_CHAIN_ID) {
    throw new Error(
      `Refusing source chain ${sourceNetwork.chainId}; expected Ethereum mainnet chain 1`,
    );
  }
  const eventHistoryPolicy = new Contract(
    deployments.eventHistoryPolicy,
    artifact("EventHistoryPolicyV1").abi,
    provider,
  );
  const [policy, policyConfiguration, sourceReceipt, sourceTransaction] =
    await Promise.all([
      kernel.policyOf(job.facility, job.policyId),
      eventHistoryPolicy.configurationOf(job.facility, job.policyId),
      sourceProvider.getTransactionReceipt(sourceTransactionHash),
      sourceProvider.getTransaction(sourceTransactionHash),
    ]);
  if (
    policy.configHash.toLowerCase() !==
    deployments.policyConfigHash.toLowerCase()
  ) {
    throw new Error("Refusing policy with a different configuration digest");
  }
  if (policy.evaluator === "0x0000000000000000000000000000000000000000") {
    throw new Error("Refusing an unregistered policy");
  }
  if (!sameAddress(policy.evaluator, deployments.eventHistoryPolicy)) {
    throw new Error("Refusing a policy not evaluated by EventHistoryPolicyV1");
  }
  if (!sourceReceipt || !sourceTransaction) {
    throw new Error(
      `Source transaction or receipt unavailable for ${sourceTransactionHash}`,
    );
  }
  if (
    !sourceReceipt.hash ||
    sourceReceipt.hash.toLowerCase() !== sourceTransactionHash ||
    !sourceTransaction.hash ||
    sourceTransaction.hash.toLowerCase() !== sourceTransactionHash ||
    !sourceReceipt.blockHash
  ) {
    throw new Error(
      "Source receipt identity does not match the requested transaction",
    );
  }
  if (sourceReceipt.status !== 1)
    throw new Error("Refusing a failed source transaction receipt");
  const sourceBlock = await sourceProvider.getBlock(sourceReceipt.blockNumber);
  if (
    !sourceBlock?.hash ||
    sourceBlock.hash.toLowerCase() !== sourceReceipt.blockHash.toLowerCase()
  ) {
    throw new Error("Source receipt block is no longer canonical");
  }
  if (
    sourceReceipt.blockNumber < Number(deployments.sourceWindow.startBlock) ||
    sourceReceipt.blockNumber > Number(deployments.sourceWindow.endBlock)
  ) {
    throw new Error(
      "Source transaction is outside the configured policy window",
    );
  }
  const qualification = qualifyReceipt(sourceReceipt, policyConfiguration);
  if (!qualification.qualified) {
    throw new Error(
      `Source transaction is not exact policy evidence: ${qualification.reason}`,
    );
  }
  const expectedState = {
    chainId: Number(EXPECTED_CHAIN_ID),
    jobId,
    hunter: hunter.address,
    facility: job.facility,
    policyId: job.policyId,
    requirementsDigest: job.requirementsDigest,
    sourceTransactionHash,
    sourceHeight: sourceReceipt.blockNumber,
  };
  if (state) state = validateResumeState(state, expectedState);

  if (job.state !== OPEN_JOB_STATE) throw new Error("Proof job is not open");
  if (job.expiry <= BigInt(latestBlock.timestamp)) {
    throw new Error("Proof job has expired");
  }
  const publicationValid = await kernel.canPublishJob(
    job.facility,
    job.sponsor,
    job.token,
    job.policyId,
    job.requirementsDigest,
  );
  if (!publicationValid)
    throw new Error("Proof job is no longer authorized by its facility");

  if (!state) {
    const attestation = await getLatestAttestation(chainKey);
    if (
      attestation.exists !== true ||
      !isHexString(attestation.hash, 32) ||
      !Number.isSafeInteger(attestation.height) ||
      attestation.height < sourceReceipt.blockNumber
    ) {
      throw new Error(
        `Attestcoin has no valid attestation covering source block ${sourceReceipt.blockNumber}`,
      );
    }
    if (
      attestation.height === sourceReceipt.blockNumber &&
      attestation.hash.toLowerCase() !== sourceReceipt.blockHash.toLowerCase()
    ) {
      throw new Error(
        "Attested source digest does not match the canonical block",
      );
    }
    const batch = await fetchBatchProof(chainKey, [sourceTransactionHash]);
    assertExactHashMultiset([sourceTransactionHash], batch.txHashes);
    if (
      batch.heights.length !== 1 ||
      batch.txBytes.length !== 1 ||
      batch.merkleProofs.length !== 1
    ) {
      throw new Error(
        "Proof response cardinality does not match the requested transaction",
      );
    }
    if (batch.heights[0] !== sourceReceipt.blockNumber) {
      throw new Error(
        "Proven source height does not match the successful receipt",
      );
    }

    const proof = encodeKernelProof({
      chainKey,
      height: batch.heights[0],
      encodedTransaction: batch.txBytes[0],
      merkleProof: batch.merkleProofs[0],
      continuityProof: batch.continuityProof,
    });
    assertProvenTransactionMatchesSource({
      encodedTransaction: batch.txBytes[0],
      sourceTransaction,
      sourceReceipt,
    });
    const verifier = new Contract(
      deployments.verifier,
      NATIVE_VERIFIER_ABI,
      provider,
    );
    await assertProofPreflight({
      verifier,
      kernel,
      chainKey,
      height: batch.heights[0],
      encodedTransaction: batch.txBytes[0],
      merkleProof: batch.merkleProofs[0],
      continuityProof: batch.continuityProof,
      expectedTransactionIndex: sourceReceipt.index,
      facility: job.facility,
      policyId: job.policyId,
      requirementsDigest: job.requirementsDigest,
      proof,
      hunter: hunter.address,
      proofJobs: deployments.proofJobs,
    });
    const evidenceDigest = computeEvidenceDigest(proof);
    const salt = hexlify(randomBytes(32));
    const commitment = computeJobCommitment(
      jobId,
      hunter.address,
      evidenceDigest,
      salt,
    );
    const onChainCommitment = await jobsRead.computeCommitment(
      jobId,
      hunter.address,
      evidenceDigest,
      salt,
    );
    if (commitment !== onChainCommitment)
      throw new Error("Local commitment encoding mismatch");
    state = validateResumeState(
      {
        version: 3,
        phase: "prepared",
        chainId: Number(EXPECTED_CHAIN_ID),
        jobId: jobId.toString(),
        hunter: hunter.address,
        facility: job.facility,
        policyId: job.policyId.toString(),
        requirementsDigest: job.requirementsDigest,
        sourceTransactionHash,
        sourceHeight: sourceReceipt.blockNumber,
        sourceTransactionIndex: sourceReceipt.index,
        attestation: {
          height: attestation.height,
          hash: attestation.hash.toLowerCase(),
          isAttestation: attestation.isAttestation === true,
        },
        proof,
        evidenceDigest,
        salt,
        commitment,
        pending: null,
      },
      expectedState,
    );
    atomicWriteJson(statePath, state);
    log(
      `Proof, salt, and commitment persisted before any transaction broadcast to ${statePath}.`,
    );
  }

  if (state.phase === "prepared") {
    const allowance = await token.allowance(
      hunter.address,
      deployments.proofJobs,
    );
    if (allowance < job.commitBond) {
      assertCanStartTransaction();
      state = await prepareJournaledTransaction({
        kind: "approval",
        signer: hunter,
        request: await token.approve.populateTransaction(
          deployments.proofJobs,
          job.commitBond,
        ),
        state,
        statePath,
      });
      state = (
        await reconcileJournaledTransaction({
          provider,
          state,
          statePath,
          kind: "approval",
          successPhase: "approved",
          expectedIntent: await expectedIntentForKind("approval", state),
          ...confirmationPolicy,
        })
      ).state;
    } else {
      state = { ...state, phase: "approved", pending: null };
      atomicWriteJson(statePath, state);
    }
    state = validateResumeState(state, expectedState);
  }

  if (state.phase === "approved") {
    const [preCommitJob, preCommitBlock, balance, liveAllowance] =
      await Promise.all([
        jobsRead.getJob(jobId),
        provider.getBlock("latest"),
        token.balanceOf(hunter.address),
        token.allowance(hunter.address, deployments.proofJobs),
      ]);
    if (!preCommitBlock) throw new Error("Latest CC3 block is unavailable");
    if (preCommitJob.state !== OPEN_JOB_STATE) {
      throw new Error("Proof job finalized before commitment");
    }
    assertCommitReady({
      job: preCommitJob,
      policy: executionPolicy,
      currentTimestamp: preCommitBlock.timestamp,
      balance,
      allowance: liveAllowance,
    });
    assertCanStartTransaction();
    state = await prepareJournaledTransaction({
      kind: "commit",
      signer: hunter,
      request: await jobs.commitEvidence.populateTransaction(
        jobId,
        state.evidenceDigest,
        state.commitment,
      ),
      state,
      statePath,
    });
    state = (
      await reconcileJournaledTransaction({
        provider,
        state,
        statePath,
        kind: "commit",
        successPhase: "committed",
        expectedIntent: await expectedIntentForKind("commit", state),
        ...confirmationPolicy,
      })
    ).state;
    state = validateResumeState(state, expectedState);
  }

  const recovery = await recoverHorizon1TargetState({
    provider,
    jobsRead,
    jobs,
    hunter,
    jobId,
    state,
    statePath,
    expectedState,
    confirmationPolicy,
    assertCanStartTransaction,
    expectedIntentForKind,
  });
  log(
    `Target-chain execution reached ${recovery.status} for proof job ${jobId}.`,
  );
}

main().catch((error) => {
  log(errorMessage(error));
  process.exitCode =
    error instanceof OperatorIncidentError
      ? 3
      : error?.name === "AbortError"
        ? 4
        : 1;
});
