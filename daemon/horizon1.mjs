import "dotenv/config";
import {
  Contract,
  Wallet,
  getAddress,
  hexlify,
  isHexString,
  randomBytes,
} from "ethers";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertExactHashMultiset,
  fetchBatchProof,
  getAttestedHeight,
  getProvider,
  getSourceProvider,
} from "../scripts/lib/proofs.mjs";
import {
  computeEvidenceDigest,
  computeJobCommitment,
  encodeKernelProof,
  validateResumeState,
} from "./horizon1-core.mjs";

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

function atomicWriteState(path, state) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  const serialized = JSON.stringify(
    state,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
  writeFileSync(temporaryPath, `${serialized}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  renameSync(temporaryPath, path);
}

async function sendTransaction(label, send) {
  let transaction;
  try {
    transaction = await send();
    log(`${label} broadcast: ${transaction.hash}. Waiting for confirmation.`);
    const receipt = await transaction.wait();
    if (receipt.status !== 1)
      throw new Error(`${label} ${transaction.hash} reverted`);
    return receipt;
  } catch (error) {
    if (transaction?.hash) {
      throw new Error(
        `${label} outcome for ${transaction.hash} is uncertain (${errorMessage(error)}); refusing to retry`,
      );
    }
    throw error;
  }
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

async function main() {
  const { deployments, jobId, sourceTransactionHash, statePath } = readInputs();
  if (BigInt(deployments.chainId) !== EXPECTED_CHAIN_ID) {
    throw new Error(
      `Refusing deployment record for chain ${deployments.chainId}; expected ${EXPECTED_CHAIN_ID}`,
    );
  }

  const chainKey = Number(deployments.sourceWindow.chainKey);
  const provider = getProvider();
  const sourceProvider = getSourceProvider(chainKey);
  const [network, sourceNetwork] = await Promise.all([
    provider.getNetwork(),
    sourceProvider.getNetwork(),
  ]);
  if (network.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(
      `Refusing CC3 chain ${network.chainId}; expected ${EXPECTED_CHAIN_ID}`,
    );
  }
  if (sourceNetwork.chainId !== EXPECTED_SOURCE_CHAIN_ID) {
    throw new Error(
      `Refusing source chain ${sourceNetwork.chainId}; expected Ethereum mainnet chain 1`,
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
    artifact("PolicyKernelV1").abi,
    provider,
  );
  const job = await jobsRead.getJob(jobId);
  const policy = await kernel.policyOf(job.facility, job.policyId);
  const latestBlock = await provider.getBlock("latest");
  if (!latestBlock) throw new Error("Latest CC3 block is unavailable");

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
  if (
    policy.configHash.toLowerCase() !==
    deployments.policyConfigHash.toLowerCase()
  ) {
    throw new Error("Refusing policy with a different configuration digest");
  }
  if (policy.evaluator === "0x0000000000000000000000000000000000000000") {
    throw new Error("Refusing an unregistered policy");
  }
  const sourceReceipt = await sourceProvider.getTransactionReceipt(
    sourceTransactionHash,
  );
  if (!sourceReceipt)
    throw new Error(`Source receipt unavailable for ${sourceTransactionHash}`);
  if (sourceReceipt.status !== 1)
    throw new Error("Refusing a failed source transaction receipt");
  if (
    sourceReceipt.blockNumber < Number(deployments.sourceWindow.startBlock) ||
    sourceReceipt.blockNumber > Number(deployments.sourceWindow.endBlock)
  ) {
    throw new Error(
      "Source transaction is outside the configured policy window",
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

  let state;
  if (existsSync(statePath)) {
    state = validateResumeState(
      JSON.parse(readFileSync(statePath, "utf8")),
      expectedState,
    );
    log(
      `Resuming proof job ${jobId} from the committed state in ${statePath}.`,
    );
    if (state.phase === "revealed") {
      const receipt = await provider.getTransactionReceipt(
        state.revealTransactionHash,
      );
      if (!receipt || receipt.status !== 1) {
        throw new Error(
          "Stored reveal transaction is not confirmed successfully on CC3",
        );
      }
      log(
        `Reveal ${state.revealTransactionHash} is already confirmed; nothing remains to do.`,
      );
      return;
    }
  }

  if (job.state !== OPEN_JOB_STATE) throw new Error("Proof job is not open");
  if (job.expiry <= BigInt(latestBlock.timestamp))
    throw new Error("Proof job has expired");
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
    const attestedHeight = await getAttestedHeight(chainKey);
    if (attestedHeight < sourceReceipt.blockNumber) {
      throw new Error(
        `Attestcoin covers through ${attestedHeight}, below source block ${sourceReceipt.blockNumber}`,
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

    const token = new Contract(job.token, ERC20_ABI, hunter);
    const [balance, allowance] = await Promise.all([
      token.balanceOf(hunter.address),
      token.allowance(hunter.address, deployments.proofJobs),
    ]);
    if (balance < job.commitBond)
      throw new Error("Hunter balance is below the required commit bond");
    if (allowance < job.commitBond) {
      await sendTransaction("Bond approval", () =>
        token.approve(deployments.proofJobs, job.commitBond),
      );
    }

    const commitReceipt = await sendTransaction("Evidence commitment", () =>
      jobs.commitEvidence(jobId, evidenceDigest, commitment),
    );
    const storedCommitment = await jobsRead.getCommitment(
      jobId,
      hunter.address,
    );
    if (
      storedCommitment.digest !== commitment ||
      storedCommitment.evidenceDigest !== evidenceDigest ||
      storedCommitment.committedBlock !== BigInt(commitReceipt.blockNumber) ||
      storedCommitment.bond !== job.commitBond
    ) {
      throw new Error(
        "On-chain commitment does not match the submitted evidence",
      );
    }

    state = validateResumeState(
      {
        version: 1,
        phase: "committed",
        chainId: Number(EXPECTED_CHAIN_ID),
        jobId: jobId.toString(),
        hunter: hunter.address,
        facility: job.facility,
        policyId: job.policyId.toString(),
        requirementsDigest: job.requirementsDigest,
        sourceTransactionHash,
        sourceHeight: sourceReceipt.blockNumber,
        proof,
        evidenceDigest,
        salt,
        commitment,
        commitBlock: commitReceipt.blockNumber,
        commitTransactionHash: commitReceipt.hash,
      },
      expectedState,
    );
    atomicWriteState(statePath, state);
    log(`Commit state persisted atomically to ${statePath}.`);
  }

  const storedCommitment = await jobsRead.getCommitment(jobId, hunter.address);
  if (
    storedCommitment.digest !== state.commitment ||
    storedCommitment.evidenceDigest !== state.evidenceDigest ||
    storedCommitment.committedBlock !== BigInt(state.commitBlock) ||
    storedCommitment.bond === 0n
  ) {
    throw new Error("Stored resume state does not match the live commitment");
  }
  if (storedCommitment.revealDeadlineBlock < BigInt(state.commitBlock + 1)) {
    throw new Error("Live commitment has no valid reveal window");
  }

  const revealBlock = state.commitBlock + 1;
  const currentBlock = await provider.getBlockNumber();
  if (currentBlock < revealBlock) {
    log(`Waiting for CC3 block ${revealBlock} before revealing.`);
    await provider.waitForBlock(revealBlock);
  }
  const blockBeforeReveal = await provider.getBlockNumber();
  if (BigInt(blockBeforeReveal) > storedCommitment.revealDeadlineBlock) {
    throw new Error("Commitment reveal window has elapsed");
  }

  const revealReceipt = await sendTransaction("Evidence reveal", () =>
    jobs.revealEvidence(jobId, state.evidenceDigest, state.salt, state.proof, {
      gasLimit: REVEAL_GAS_LIMIT,
    }),
  );
  const revealedState = {
    ...state,
    phase: "revealed",
    revealTransactionHash: revealReceipt.hash,
  };
  validateResumeState(revealedState, expectedState);
  atomicWriteState(statePath, revealedState);
  log(`Reveal ${revealReceipt.hash} confirmed; proof job ${jobId} completed.`);
}

main().catch((error) => {
  log(errorMessage(error));
  process.exitCode = 1;
});
