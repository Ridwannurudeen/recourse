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
import { proofJobsV1Abi } from "../sdk/src/abis.mjs";
import {
  assertExactHashMultiset,
  fetchBatchProof,
  getLatestAttestation,
  getProvider,
  getSourceNetwork,
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
import {
  assertHorizon1BroadcastStillValid,
  recoverHorizon1TargetState,
} from "./horizon1-recovery.mjs";
import { serializeMultiChainConfiguration } from "./job-discovery.mjs";
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
import {
  V3_CHAIN_ID,
  activationDiscoveryDeployments,
  assertActivatedV3Job,
  loadHunterPrivateKey,
  multiRuleExecutionConfigurations,
} from "./v3-core.mjs";

const OPEN_JOB_STATE = 0n;
const REVEAL_GAS_LIMIT = 1_500_000n;
const DEFAULT_STATE_FILE = "daemon/v3-state.json";
const ERC20_ABI = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
];
const KERNEL_ABI = [
  "function safeStaleProofRelease() view returns (bool)",
  "function verifier() view returns (address)",
  "function proofJobs() view returns (address)",
  "function policyOf(address facility,uint256 policyId) view returns (address evaluator,bytes32 configHash,bytes manifestBytes)",
  "function canPublishJob(address facility,address sponsor,address token,uint256 policyId,bytes32 requirementsDigest) view returns (bool)",
  "function evaluateProofJob(address facility,uint256 policyId,bytes32 requirementsDigest,bytes proof,address hunter) returns (bool accepted,uint8 outcomeLevel)",
];
const MULTI_CHAIN_POLICY_ABI = [
  "function configHash(address facility,uint256 policyId) view returns (bytes32)",
  "function configurationOf(address facility,uint256 policyId) view returns (tuple(address subject,uint64 freshnessPeriod,uint32 watchThreshold,uint32 restrictedThreshold,uint32 marginThreshold,uint32 breachThreshold,tuple(uint8 outcome,uint16 creditLimitBps,uint16 futureDrawFeeBps,bool freezePendingDraw,bool requireFreshEvidence,bool terminate) watchEffect,tuple(uint8 outcome,uint16 creditLimitBps,uint16 futureDrawFeeBps,bool freezePendingDraw,bool requireFreshEvidence,bool terminate) restrictedEffect,tuple(uint8 outcome,uint16 creditLimitBps,uint16 futureDrawFeeBps,bool freezePendingDraw,bool requireFreshEvidence,bool terminate) marginEffect,tuple(uint8 outcome,uint16 creditLimitBps,uint16 futureDrawFeeBps,bool freezePendingDraw,bool requireFreshEvidence,bool terminate) breachEffect,tuple(uint64 sourceChain,address emitter,bytes32 eventSignature,uint64 startSourceBlock,uint64 endSourceBlock,uint8 topicCount,uint8 subjectTopicIndex,uint16 dataLength,uint16 observedValueOffset,uint8 observationKind,uint32 riskWeight)[] rules))",
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
  process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

function errorMessage(error) {
  return (
    error?.shortMessage || error?.reason || error?.message || String(error)
  );
}

function sameAddress(left, right) {
  return getAddress(left) === getAddress(right);
}

function transactionHash(value) {
  if (!isHexString(value, 32))
    throw new Error("Invalid source transaction hash");
  return value.toLowerCase();
}

function readInputs() {
  const sourceTransactionHash = transactionHash(
    process.argv[2] || process.env.HORIZON1_SOURCE_TX_HASH,
  );
  const activationPath = resolve(
    process.env.RECOURSE_ACTIVATION_FILE || "activation-v3.json",
  );
  const statePath = resolve(
    process.env.HORIZON1_STATE_FILE || DEFAULT_STATE_FILE,
  );
  const manifest = JSON.parse(readFileSync(activationPath, "utf8"));
  const deployments = activationDiscoveryDeployments(manifest);
  const jobId = BigInt(
    process.argv[3] || process.env.HORIZON1_JOB_ID || deployments.proofJobId,
  );
  if (jobId !== BigInt(deployments.proofJobId)) {
    throw new Error("V3 job ID does not match the activation manifest");
  }
  const sourceNetwork = getSourceNetwork(
    process.argv[4] || process.env.RECOURSE_SOURCE_CHAIN,
  );
  const activatedNetwork = deployments.sourceNetworks[sourceNetwork.chainKey];
  if (
    !activatedNetwork ||
    activatedNetwork.evmChainId !== sourceNetwork.evmChainId ||
    activatedNetwork.rpcUrlEnvironment !== sourceNetwork.rpcUrlEnvironment
  ) {
    throw new Error(
      `Source chain key ${sourceNetwork.chainKey} is not exactly bound by the activation manifest`,
    );
  }
  return {
    deployments,
    jobId,
    sourceNetwork,
    sourceTransactionHash,
    statePath,
  };
}

function validateV3ResumeState(state, expected) {
  if (BigInt(state?.sourceChain) !== BigInt(expected.sourceChain)) {
    throw new Error("Resume source chain mismatch");
  }
  return validateResumeState(state, expected);
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
  if (!stopping) return;
  const error = new Error("Shutdown requested at a durable journal boundary");
  error.name = "AbortError";
  throw error;
}

async function main() {
  const {
    deployments,
    jobId,
    sourceNetwork: expectedSourceNetwork,
    sourceTransactionHash,
    statePath,
  } = readInputs();
  const chainKey = expectedSourceNetwork.chainKey;
  const hasResumeState = existsSync(statePath);
  const executionPolicy = readExecutionPolicy();
  const confirmationPolicy = {
    targetConfirmations: executionPolicy.targetConfirmations,
    maxReceiptPolls:
      executionPolicy.targetConfirmations + executionPolicy.recoveryBlocks,
    receiptPollIntervalMs: executionPolicy.blockTimeMs,
    signal: shutdownController.signal,
    feePolicy: executionPolicy.feePolicy,
  };
  const provider = getProvider();
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(V3_CHAIN_ID)) {
    throw new Error(
      `Refusing CC3 chain ${network.chainId}; expected ${V3_CHAIN_ID}`,
    );
  }

  if (!process.env.HUNTER_ADDRESS) {
    throw new Error("HUNTER_ADDRESS is required");
  }
  const hunter = new Wallet(loadHunterPrivateKey(), provider);
  if (!sameAddress(hunter.address, process.env.HUNTER_ADDRESS)) {
    throw new Error("Hunter signing credential does not match HUNTER_ADDRESS");
  }
  if (!sameAddress(hunter.address, deployments.activation.roles.hunter)) {
    throw new Error("Hunter signer does not match the activation manifest");
  }

  const jobsRead = new Contract(
    deployments.proofJobs,
    proofJobsV1Abi,
    provider,
  );
  const jobs = jobsRead.connect(hunter);
  const kernel = new Contract(deployments.policyKernel, KERNEL_ABI, provider);
  const multiChainPolicy = new Contract(
    deployments.multiChainEventPolicy,
    MULTI_CHAIN_POLICY_ABI,
    provider,
  );
  const [job, latestBlock, safeStaleRelease, wiredProofJobs, registration] =
    await Promise.all([
      jobsRead.getJob(jobId),
      provider.getBlock("latest"),
      kernel.safeStaleProofRelease(),
      kernel.proofJobs(),
      kernel.policyOf(deployments.demonstrationFacility, deployments.policyId),
    ]);
  if (!latestBlock) throw new Error("Latest CC3 block is unavailable");
  if (safeStaleRelease !== true) {
    throw new Error("Kernel does not guarantee safe stale-proof bond release");
  }
  if (!sameAddress(wiredProofJobs, deployments.proofJobs)) {
    throw new Error("V3 kernel ProofJobs wiring does not match activation");
  }
  if (
    !sameAddress(registration.evaluator, deployments.multiChainEventPolicy) ||
    registration.configHash.toLowerCase() !== deployments.policyConfigHash
  ) {
    throw new Error("V3 policy registration does not match activation");
  }
  assertActivatedV3Job({ ...job, jobId }, deployments);
  if (!hasResumeState) {
    assertJobEconomics(job, executionPolicy, latestBlock.timestamp);
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
    } else if (kind === "claim") {
      request = await jobs.claim.populateTransaction(job.token);
    } else {
      throw new Error(`Unknown transaction journal kind: ${kind}`);
    }
    return {
      chainId: V3_CHAIN_ID,
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
      chainId: V3_CHAIN_ID,
      jobId,
      hunter: hunter.address,
      facility: job.facility,
      policyId: job.policyId,
      requirementsDigest: job.requirementsDigest,
      sourceChain: chainKey,
      sourceTransactionHash,
      sourceHeight: storedState.sourceHeight,
    };
    state = validateV3ResumeState(storedState, targetExpectedState);
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
      `V3 target-chain recovery reached ${recovery.status} for job ${jobId}.`,
    );
    if (
      recovery.status !== "needs-source" ||
      process.env.RECOURSE_RECOVERY_ONLY === "1"
    ) {
      return;
    }
  }

  const [onChainConfigHash, onChainConfiguration] = await Promise.all([
    multiChainPolicy.configHash(job.facility, job.policyId),
    multiChainPolicy.configurationOf(job.facility, job.policyId),
  ]);
  if (onChainConfigHash.toLowerCase() !== deployments.policyConfigHash) {
    throw new Error("V3 policy configuration hash does not match activation");
  }
  const configurations = multiRuleExecutionConfigurations(
    serializeMultiChainConfiguration(onChainConfiguration),
  ).filter(({ sourceChain }) => BigInt(sourceChain) === BigInt(chainKey));
  if (configurations.length === 0) {
    throw new Error(
      `V3 policy has no rule for activated source chain key ${chainKey}`,
    );
  }
  const sourceProvider = getSourceProvider(chainKey);
  const sourceNetwork = await sourceProvider.getNetwork();
  if (sourceNetwork.chainId !== BigInt(expectedSourceNetwork.evmChainId)) {
    throw new Error(
      `Refusing EVM chain ${sourceNetwork.chainId} for source key ${chainKey}; expected ${expectedSourceNetwork.evmChainId}`,
    );
  }
  const [sourceReceipt, sourceTransaction] = await Promise.all([
    sourceProvider.getTransactionReceipt(sourceTransactionHash),
    sourceProvider.getTransaction(sourceTransactionHash),
  ]);
  if (!sourceReceipt || !sourceTransaction) {
    throw new Error(
      `Source transaction or receipt unavailable for ${sourceTransactionHash}`,
    );
  }
  if (
    sourceReceipt.hash?.toLowerCase() !== sourceTransactionHash ||
    sourceTransaction.hash?.toLowerCase() !== sourceTransactionHash ||
    !sourceReceipt.blockHash
  ) {
    throw new Error(
      "Source receipt identity does not match the requested transaction",
    );
  }
  if (sourceReceipt.status !== 1) {
    throw new Error("Refusing a failed source transaction receipt");
  }
  const sourceBlock = await sourceProvider.getBlock(sourceReceipt.blockNumber);
  if (
    !sourceBlock?.hash ||
    sourceBlock.hash.toLowerCase() !== sourceReceipt.blockHash.toLowerCase()
  ) {
    throw new Error("Source receipt block is no longer canonical");
  }
  const qualifications = configurations.map((configuration) => ({
    ruleIndex: configuration.ruleIndex,
    qualification: qualifyReceipt(sourceReceipt, configuration),
  }));
  if (!qualifications.some(({ qualification }) => qualification.qualified)) {
    throw new Error(
      "Source transaction is not exact V3 policy evidence for its source chain",
    );
  }
  const expectedState = {
    chainId: V3_CHAIN_ID,
    jobId,
    hunter: hunter.address,
    facility: job.facility,
    policyId: job.policyId,
    requirementsDigest: job.requirementsDigest,
    sourceChain: chainKey,
    sourceTransactionHash,
    sourceHeight: sourceReceipt.blockNumber,
  };
  if (state) state = validateV3ResumeState(state, expectedState);
  if (job.state !== OPEN_JOB_STATE) throw new Error("V3 proof job is not open");
  if (job.expiry <= BigInt(latestBlock.timestamp)) {
    throw new Error("V3 proof job has expired");
  }
  const publicationValid = await kernel.canPublishJob(
    job.facility,
    job.sponsor,
    job.token,
    job.policyId,
    job.requirementsDigest,
  );
  if (!publicationValid) {
    throw new Error("V3 proof job is no longer authorized by its facility");
  }

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
      batch.merkleProofs.length !== 1 ||
      batch.heights[0] !== sourceReceipt.blockNumber
    ) {
      throw new Error(
        "Proof response does not match the requested V3 transaction",
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
    const verifierAddress = await kernel.verifier();
    const verifier = new Contract(
      verifierAddress,
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
    if (
      commitment !==
      (await jobsRead.computeCommitment(
        jobId,
        hunter.address,
        evidenceDigest,
        salt,
      ))
    ) {
      throw new Error("Local V3 commitment encoding mismatch");
    }
    state = validateV3ResumeState(
      {
        version: 3,
        phase: "prepared",
        chainId: V3_CHAIN_ID,
        jobId: jobId.toString(),
        hunter: hunter.address,
        facility: job.facility,
        policyId: job.policyId.toString(),
        requirementsDigest: job.requirementsDigest,
        sourceChain: chainKey.toString(),
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
        feePolicy: executionPolicy.feePolicy,
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
          beforeBroadcast: () =>
            assertHorizon1BroadcastStillValid({
              kind: "approval",
              provider,
              jobsRead,
              hunter,
              jobId,
              state,
            }),
          ...confirmationPolicy,
        })
      ).state;
    } else {
      state = { ...state, phase: "approved", pending: null };
      atomicWriteJson(statePath, state);
    }
    state = validateV3ResumeState(state, expectedState);
  }

  if (state.phase === "approved") {
    const [preCommitJob, preCommitBlock, balance, allowance] =
      await Promise.all([
        jobsRead.getJob(jobId),
        provider.getBlock("latest"),
        token.balanceOf(hunter.address),
        token.allowance(hunter.address, deployments.proofJobs),
      ]);
    if (!preCommitBlock) throw new Error("Latest CC3 block is unavailable");
    assertActivatedV3Job({ ...preCommitJob, jobId }, deployments);
    if (preCommitJob.state !== OPEN_JOB_STATE) {
      throw new Error("V3 proof job finalized before commitment");
    }
    assertCommitReady({
      job: preCommitJob,
      policy: executionPolicy,
      currentTimestamp: preCommitBlock.timestamp,
      balance,
      allowance,
    });
    assertCanStartTransaction();
    state = await prepareJournaledTransaction({
      kind: "commit",
      signer: hunter,
      feePolicy: executionPolicy.feePolicy,
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
        beforeBroadcast: () =>
          assertHorizon1BroadcastStillValid({
            kind: "commit",
            provider,
            jobsRead,
            hunter,
            jobId,
            state,
          }),
        ...confirmationPolicy,
      })
    ).state;
    state = validateV3ResumeState(state, expectedState);
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
  log(`V3 target-chain execution reached ${recovery.status} for job ${jobId}.`);
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
