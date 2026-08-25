import { AbiCoder, keccak256, solidityPackedKeccak256 } from 'ethers';
import { summarizeQualifyingTransfers } from '../scripts/lib/evidence.mjs';

export function computeConfigHash(config) {
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ['uint64', 'address', 'address', 'uint64', 'uint64', 'uint256'],
      [
        config.chainKey,
        config.token,
        config.treasury,
        config.startSourceBlock,
        config.endSourceBlock,
        config.capBaseUnits,
      ],
    ),
  );
}

export function queryId(chainKey, blockHeight, transactionIndex) {
  return solidityPackedKeccak256(
    ['uint64', 'uint64', 'uint64'],
    [chainKey, blockHeight, transactionIndex],
  );
}

export function evaluateReceipt(receipt, config) {
  if (receipt.blockNumber < config.startSourceBlock || receipt.blockNumber > config.endSourceBlock) {
    return { qualified: false, reason: 'outside covenant window' };
  }
  if (receipt.status !== 1) return { qualified: false, reason: 'transaction reverted' };

  const summary = summarizeQualifyingTransfers(receipt.logs, config.token, config.treasury);
  if (!summary) return { qualified: false, reason: 'no matching outflow' };

  return {
    qualified: true,
    amount: BigInt(summary.valueBaseUnits),
    qualifyingTransferCount: summary.qualifyingTransferCount,
    recipient: summary.to,
  };
}

function orderCandidates(left, right) {
  return left.blockNumber - right.blockNumber || left.transactionIndex - right.transactionIndex;
}

export async function reconcileCandidates({
  facilityState,
  onChainAccumulated,
  capBaseUnits,
  chainKey,
  candidates,
  isProcessed,
}) {
  if (facilityState !== 1n) {
    return {
      active: false,
      processed: [],
      pending: [],
      batch: [],
      runningTotal: BigInt(onChainAccumulated),
      breached: false,
    };
  }

  const processed = [];
  const pending = [];
  for (const candidate of [...candidates].sort(orderCandidates)) {
    const qid = queryId(chainKey, candidate.blockNumber, candidate.transactionIndex);
    const reconciled = { ...candidate, queryId: qid };
    if (await isProcessed(qid)) processed.push(reconciled);
    else pending.push(reconciled);
  }

  let runningTotal = BigInt(onChainAccumulated);
  const batch = [];
  for (const candidate of pending) {
    runningTotal += BigInt(candidate.amount);
    batch.push(candidate);
    if (runningTotal > BigInt(capBaseUnits)) break;
  }

  return {
    active: true,
    processed,
    pending,
    batch,
    runningTotal,
    breached: runningTotal > BigInt(capBaseUnits),
  };
}
