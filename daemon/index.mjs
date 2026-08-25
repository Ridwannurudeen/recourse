import "dotenv/config";
import {
  AbiCoder,
  Contract,
  Wallet,
  formatEther,
  formatUnits,
  getAddress,
  id,
} from "ethers";
import { readFileSync } from "node:fs";
import {
  computeConfigHash,
  evaluateReceipt,
  reconcileCandidates,
} from "./core.mjs";
import {
  assertExactHashMultiset,
  fetchBatchProof,
  getAttestedHeight,
  getProvider,
  getSourceProvider,
  prewarm,
} from "../scripts/lib/proofs.mjs";

const EXPECTED_CHAIN_ID = 102031n;
const FACILITY_ID = 2n;
const COVENANT_ID = 1n;
const SCAN_RANGE = 5;
const POLL_INTERVAL_MS = 15_000;
const MAX_BACKOFF_MS = 60_000;
const GAS_LIMIT = 1_500_000n;
const STATE_NAMES = [
  "Created",
  "Active",
  "Repaid",
  "Breached",
  "Defaulted",
  "Cancelled",
];
const TRANSFER_TOPIC = id("Transfer(address,address,uint256)");

class RefusalError extends Error {}

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

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function retryRpc(label, operation) {
  let backoff = POLL_INTERVAL_MS;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RefusalError) throw error;
      log(
        `${label} failed: ${errorMessage(error)}. Retrying in ${backoff / 1000} seconds.`,
      );
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }
}

function formatState(state) {
  return STATE_NAMES[Number(state)] ?? `Unknown(${state})`;
}

function formatUsdc(value) {
  return formatUnits(value, 6);
}

function loadConfig() {
  const config = JSON.parse(readFileSync("daemon/config.json", "utf8"));
  return {
    ...config,
    chainKey: Number(config.chainKey),
    startSourceBlock: Number(config.startSourceBlock),
    endSourceBlock: Number(config.endSourceBlock),
    capBaseUnits: BigInt(config.capBaseUnits),
  };
}

async function main() {
  const config = loadConfig();
  const deployments = JSON.parse(readFileSync("deployments.json", "utf8"));
  const provider = getProvider();
  const sourceProvider = getSourceProvider(config.chainKey);
  const facility = new Contract(
    deployments.facility,
    artifact("RecourseFacility").abi,
    provider,
  );
  const covenant = new Contract(
    deployments.outflowCovenant,
    artifact("OutflowCapCovenant").abi,
    provider,
  );
  const adjudicatorRead = new Contract(
    deployments.adjudicator,
    artifact("AttestcoinAdjudicator").abi,
    provider,
  );

  log(`Starting the autonomous hunter for facility ${FACILITY_ID}.`);
  log(
    `The covenant caps outbound USDC transfers from treasury ${config.treasury} at ` +
      `${formatUsdc(config.capBaseUnits)} USDC during Ethereum blocks ` +
      `${config.startSourceBlock}..${config.endSourceBlock}.`,
  );

  const localHash = computeConfigHash(config);
  await retryRpc("Startup verification", async () => {
    const [network, sourceNetwork, committedHash, registeredCovenant] =
      await Promise.all([
        provider.getNetwork(),
        sourceProvider.getNetwork(),
        covenant.configHash(FACILITY_ID),
        adjudicatorRead.covenantOf(FACILITY_ID, COVENANT_ID),
      ]);
    if (network.chainId !== EXPECTED_CHAIN_ID) {
      throw new RefusalError(
        `Refusing to run on chain ${network.chainId}; expected Creditcoin ${EXPECTED_CHAIN_ID}`,
      );
    }
    if (sourceNetwork.chainId !== 1n) {
      throw new RefusalError(
        `Refusing to scan source chain ${sourceNetwork.chainId}; expected Ethereum mainnet chain 1`,
      );
    }
    if (
      getAddress(registeredCovenant) !== getAddress(deployments.outflowCovenant)
    ) {
      throw new RefusalError(
        `Refusing to run: facility ${FACILITY_ID} covenant ${COVENANT_ID} is ${registeredCovenant}, ` +
          `not ${deployments.outflowCovenant}`,
      );
    }
    if (localHash !== committedHash) {
      throw new RefusalError(
        `Refusing to run: daemon/config.json hashes to ${localHash}, but facility ${FACILITY_ID} ` +
          `commits to ${committedHash}. The watcher would enforce a different covenant.`,
      );
    }
  });
  log(
    `Configuration verified: local hash ${localHash} matches the on-chain commitment.`,
  );

  const hunter = new Wallet(process.env.HUNTER_PRIVATE_KEY, provider);
  if (hunter.address !== getAddress(process.env.HUNTER_ADDRESS)) {
    throw new Error(
      "Refusing to run: HUNTER_PRIVATE_KEY does not match HUNTER_ADDRESS",
    );
  }
  const adjudicator = adjudicatorRead.connect(hunter);

  let stopping = false;
  process.once("SIGINT", () => {
    stopping = true;
    log(
      "Shutdown requested; the daemon will stop after the current RPC operation.",
    );
  });
  process.once("SIGTERM", () => {
    stopping = true;
    log(
      "Shutdown requested; the daemon will stop after the current RPC operation.",
    );
  });

  const candidates = new Map();
  let nextBlock = config.startSourceBlock;
  let finalizedThrough = config.startSourceBlock - 1;
  let backoff = POLL_INTERVAL_MS;
  let submissionAttempted = false;
  const treasuryTopic = AbiCoder.defaultAbiCoder().encode(
    ["address"],
    [config.treasury],
  );

  async function scanBlocks(rangeStart, rangeEnd, finalizing) {
    for (
      let block = rangeStart;
      block <= rangeEnd && !stopping;
      block += SCAN_RANGE
    ) {
      const chunkEnd = Math.min(block + SCAN_RANGE - 1, rangeEnd);
      if (finalizing) {
        for (const [hash, candidate] of candidates) {
          if (
            candidate.blockNumber >= block &&
            candidate.blockNumber <= chunkEnd
          ) {
            candidates.delete(hash);
          }
        }
      }
      const transferLogs = await sourceProvider.getLogs({
        address: config.token,
        topics: [TRANSFER_TOPIC, treasuryTopic],
        fromBlock: block,
        toBlock: chunkEnd,
      });
      const transactionHashes = [
        ...new Set(transferLogs.map((entry) => entry.transactionHash)),
      ];
      log(
        `${finalizing ? "Finalized scan of" : "Scanned"} Ethereum blocks ${block}..${chunkEnd}: ` +
          (transactionHashes.length === 0
            ? "no USDC transaction originated from the watched treasury."
            : `${transactionHashes.length} USDC transaction(s) originated from the watched treasury.`),
      );

      for (const hash of transactionHashes) {
        if (candidates.has(hash)) continue;
        const receipt = await sourceProvider.getTransactionReceipt(hash);
        if (!receipt) throw new Error(`Receipt unavailable for ${hash}`);
        const result = evaluateReceipt(receipt, config);
        if (!result.qualified) {
          log(`Transaction ${hash} did not qualify: ${result.reason}.`);
          continue;
        }

        const candidate = {
          hash,
          blockNumber: receipt.blockNumber,
          transactionIndex: receipt.index,
          amount: result.amount,
          qualifyingTransferCount: result.qualifyingTransferCount,
          recipient: result.recipient,
        };
        candidates.set(hash, candidate);
        log(
          `Transaction ${hash} qualified at block ${candidate.blockNumber}, index ` +
            `${candidate.transactionIndex}: ${candidate.qualifyingTransferCount} matching transfer(s), ` +
            `${formatUsdc(candidate.amount)} USDC sent out to ${candidate.recipient}.`,
        );
      }
    }
  }

  while (!stopping) {
    try {
      const [state, debt, available, accumulated, attestedHeight, mainnetHead] =
        await Promise.all([
          facility.state(FACILITY_ID),
          facility.outstandingDebt(FACILITY_ID),
          facility.availableCredit(FACILITY_ID),
          covenant.accumulated(FACILITY_ID),
          getAttestedHeight(config.chainKey),
          sourceProvider.getBlockNumber(),
        ]);

      log(
        `Facility ${FACILITY_ID} is ${formatState(state)}: debt ${formatEther(debt)} tCTC, ` +
          `available credit ${formatEther(available)} tCTC, accumulated outflow ` +
          `${formatUsdc(accumulated)} of ${formatUsdc(config.capBaseUnits)} USDC.`,
      );
      log(
        `Ethereum head is ${mainnetHead}; Attestcoin currently covers through ${attestedHeight}.`,
      );

      if (state !== 1n) {
        log(
          `Facility ${FACILITY_ID} is no longer Active; it is ${formatState(state)}. ` +
            "The hunter has nothing further to submit and is exiting cleanly.",
        );
        return;
      }

      const finalizedScanThrough = Math.min(
        attestedHeight,
        mainnetHead,
        config.endSourceBlock,
      );
      if (finalizedThrough < finalizedScanThrough) {
        await scanBlocks(finalizedThrough + 1, finalizedScanThrough, true);
        finalizedThrough = finalizedScanThrough;
        nextBlock = Math.max(nextBlock, finalizedThrough + 1);
      }

      const scanThrough = Math.min(mainnetHead, config.endSourceBlock);
      if (nextBlock <= scanThrough) {
        await scanBlocks(nextBlock, scanThrough, false);
        nextBlock = scanThrough + 1;
      }

      const seen = [...candidates.values()];
      const provable = seen.filter(
        (candidate) => candidate.blockNumber <= attestedHeight,
      );
      const waiting = seen.length - provable.length;
      const reconciliation = await reconcileCandidates({
        facilityState: state,
        onChainAccumulated: accumulated,
        capBaseUnits: config.capBaseUnits,
        chainKey: config.chainKey,
        candidates: provable,
        isProcessed: (query) =>
          adjudicatorRead.isProcessed(FACILITY_ID, COVENANT_ID, query),
      });

      log(
        `Seen ${seen.length} qualifying transfer(s), ${provable.length} provable, waiting on attestation ` +
          `for ${waiting}. The provable unprocessed running total is ` +
          `${formatUsdc(reconciliation.runningTotal)} of ${formatUsdc(config.capBaseUnits)} USDC.`,
      );
      if (waiting > 0) {
        const firstWaitingBlock = Math.min(
          ...seen
            .filter((candidate) => candidate.blockNumber > attestedHeight)
            .map((candidate) => candidate.blockNumber),
        );
        log(
          `Attestation must reach block ${firstWaitingBlock} before the earliest waiting transfer can be used; ` +
            `current coverage is ${attestedHeight}.`,
        );
      }

      if (reconciliation.breached) {
        const finalState = await facility.state(FACILITY_ID);
        const finalAccumulated = await covenant.accumulated(FACILITY_ID);
        const finalReconciliation = await reconcileCandidates({
          facilityState: finalState,
          onChainAccumulated: finalAccumulated,
          capBaseUnits: config.capBaseUnits,
          chainKey: config.chainKey,
          candidates: provable,
          isProcessed: (query) =>
            adjudicatorRead.isProcessed(FACILITY_ID, COVENANT_ID, query),
        });
        if (!finalReconciliation.active) continue;
        if (!finalReconciliation.breached) {
          log(
            "On-chain reconciliation changed before submission; no breach batch is needed now.",
          );
          continue;
        }

        const hashes = finalReconciliation.batch.map(
          (candidate) => candidate.hash,
        );
        log(
          `Decision: the provable total ${formatUsdc(finalReconciliation.runningTotal)} USDC exceeds the ` +
            `${formatUsdc(config.capBaseUnits)} USDC cap. Fetching proofs for ${hashes.length} ` +
            "unprocessed transaction(s).",
        );
        await prewarm(config.chainKey, hashes);
        const proof = await fetchBatchProof(config.chainKey, hashes);
        assertExactHashMultiset(hashes, proof.txHashes);
        if (
          proof.heights.length !== hashes.length ||
          proof.txBytes.length !== hashes.length ||
          proof.merkleProofs.length !== hashes.length
        ) {
          throw new Error(
            "Batch proof cardinality does not match the requested transactions",
          );
        }
        log(
          "Proof hash binding verified. Submitting the breach batch as the configured hunter.",
        );

        if (stopping) {
          log(
            "Shutdown was requested while proofs were fetched; no transaction will be broadcast.",
          );
          continue;
        }
        const [confirmedNonce, pendingNonce] = await Promise.all([
          provider.getTransactionCount(hunter.address, "latest"),
          provider.getTransactionCount(hunter.address, "pending"),
        ]);
        if (pendingNonce !== confirmedNonce) {
          log(
            `Hunter nonce ${confirmedNonce} already has a pending transaction. Waiting for it to resolve ` +
              "before any breach submission, so a restart cannot double-submit.",
          );
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        submissionAttempted = true;
        let transaction;
        try {
          transaction = await adjudicator.submitBatch(
            FACILITY_ID,
            COVENANT_ID,
            config.chainKey,
            proof.heights,
            proof.txBytes,
            proof.merkleProofs,
            proof.continuityProof,
            { gasLimit: GAS_LIMIT, nonce: confirmedNonce },
          );
          log(
            `Breach transaction broadcast: ${transaction.hash}. Waiting for confirmation.`,
          );
          const receipt = await transaction.wait();
          if (receipt.status !== 1)
            throw new Error(`Transaction ${transaction.hash} reverted`);
          const [resultingState, resultingAccumulated] = await retryRpc(
            "Post-submission state read",
            () =>
              Promise.all([
                facility.state(FACILITY_ID),
                covenant.accumulated(FACILITY_ID),
              ]),
          );
          log(
            `Breach transaction ${receipt.hash} confirmed using ${receipt.gasUsed} gas. ` +
              `Facility ${FACILITY_ID} is now ${formatState(resultingState)}; on-chain accumulated outflow is ` +
              `${formatUsdc(resultingAccumulated)} USDC.`,
          );
          continue;
        } catch (error) {
          const hash = transaction?.hash;
          if (hash) {
            const receipt = await provider
              .getTransactionReceipt(hash)
              .catch(() => null);
            if (receipt) {
              throw new Error(
                `Submission ${hash} was mined with status ${receipt.status}; refusing to send a second transaction`,
              );
            }
          }
          throw new Error(
            `Submission outcome is uncertain (${errorMessage(error)}); refusing to retry and risk a duplicate`,
          );
        }
      }

      if (
        attestedHeight >= config.endSourceBlock &&
        nextBlock > config.endSourceBlock &&
        waiting === 0
      ) {
        log(
          `The covenant window has closed and every seen transfer is attested. The total did not exceed the cap; ` +
            `facility ${FACILITY_ID} remains Active. Exiting cleanly.`,
        );
        return;
      }

      backoff = POLL_INTERVAL_MS;
      await sleep(POLL_INTERVAL_MS);
    } catch (error) {
      if (submissionAttempted) throw error;
      log(
        `RPC or proof service error: ${errorMessage(error)}. Retrying in ${backoff / 1000} seconds.`,
      );
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }

  log("Daemon stopped cleanly.");
}

main().catch((error) => {
  log(errorMessage(error));
  process.exitCode = 1;
});
