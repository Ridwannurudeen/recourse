import 'dotenv/config';
import { Interface, dataLength, formatUnits, id } from 'ethers';
import { writeFileSync } from 'node:fs';
import pkg from '@gluwa/usc-sdk';
import { summarizeQualifyingTransfers } from './lib/evidence.mjs';
import { assertExactHashMultiset, getSourceProvider, getProvider, getAttestedHeight, fetchBatchProof } from './lib/proofs.mjs';

const { blockProver } = pkg;
const CHAIN_KEY = 3;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const TRANSFER = id('Transfer(address,address,uint256)');
const WINDOW = 40;          // blocks scanned; simple receipts tolerate this span
const MAX_LOGS = 3;         // reject router-style transactions
// Roots plus encoded transactions only; this excludes Merkle proofs and ABI overhead.
const MAX_APPROXIMATE_PROOF_BYTES = 20480;
const iface = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);

const eth = getSourceProvider(CHAIN_KEY);
const attested = await getAttestedHeight(CHAIN_KEY);
const hi = attested - 5;
const lo = hi - WINDOW;

const bySender = new Map();
for (let b = lo; b <= hi; b++) {
  const logs = await eth.getLogs({ fromBlock: b, toBlock: b, address: USDC, topics: [TRANSFER] });
  for (const log of logs) {
    if (log.topics.length !== 3 || dataLength(log.data) !== 32) continue;
    const parsed = iface.parseLog({ topics: log.topics, data: log.data });
    const sender = parsed.args.from.toLowerCase();
    if (parsed.args.to.toLowerCase() === sender) continue;
    if (!bySender.has(sender)) bySender.set(sender, new Map());
    const seen = bySender.get(sender);
    if (!seen.has(log.transactionHash)) {
      seen.set(log.transactionHash, {
        hash: log.transactionHash, block: log.blockNumber,
      });
    }
  }
}

// Rank by receipt simplicity. This is the step the first version of this plan got wrong.
const candidates = [];
for (const [treasury, seen] of bySender) {
  const txs = [...seen.values()].sort((a, b) => a.block - b.block);
  if (txs.length < 4) continue;
  const sampled = [];
  for (const tx of txs.slice(0, 8)) {
    const receipt = await eth.getTransactionReceipt(tx.hash);
    const summary = summarizeQualifyingTransfers(receipt.logs, USDC, treasury);
    if (summary) sampled.push({ ...tx, ...summary, logCount: receipt.logs.length });
  }
  const simple = sampled.filter((t) => t.logCount <= MAX_LOGS);
  if (simple.length < 4) continue;
  const avgLogs = simple.reduce((s, t) => s + t.logCount, 0) / simple.length;
  candidates.push({ treasury, txs: simple, avgLogs });
}
candidates.sort((a, b) => a.avgLogs - b.avgLogs);
if (candidates.length === 0) {
  throw new Error(`No treasury with >=4 simple (<=${MAX_LOGS} log) outbound txs. Raise WINDOW and retry.`);
}

const verifier = new blockProver.PrecompileBlockProver(getProvider());

for (const candidate of candidates.slice(0, 5)) {
  for (const n of [6, 5, 4]) {
    const txs = candidate.txs.slice(0, n);
    if (txs.length < n) continue;
    const total = txs.reduce((s, t) => s + BigInt(t.valueBaseUnits), 0n);
    const largest = txs.reduce((m, t) => (BigInt(t.valueBaseUnits) > m ? BigInt(t.valueBaseUnits) : m), 0n);
    if (largest >= total) continue;                 // need a cumulative-only breach
    const cap = largest + (total - largest) / 2n;   // strictly between largest and total
    if (!(largest < cap && cap < total)) continue;

    const proof = await fetchBatchProof(CHAIN_KEY, txs.map((t) => t.hash));
    assertExactHashMultiset(txs.map((t) => t.hash), proof.txHashes);
    const approximateProofBytes = proof.continuityProof.roots.length * 32
      + proof.txBytes.reduce((s, b) => s + (b.length - 2) / 2, 0);
    if (approximateProofBytes > MAX_APPROXIMATE_PROOF_BYTES) continue;

    const ok = await verifier.verifyBatch(CHAIN_KEY, proof.heights, proof.txBytes,
      proof.merkleProofs, proof.continuityProof);
    if (!ok) continue;

    const evidence = {
      chainKey: CHAIN_KEY, token: USDC, treasury: candidate.treasury,
      startSourceBlock: txs[0].block, endSourceBlock: txs[txs.length - 1].block,
      capBaseUnits: cap.toString(), expectedTotalBaseUnits: total.toString(), txs,
    };
    writeFileSync('docs/demo-evidence.json', JSON.stringify(evidence, null, 2));
    console.log(`treasury ${candidate.treasury} (avgLogs=${candidate.avgLogs.toFixed(1)})`);
    console.log(`  txs=${n} blocks ${evidence.startSourceBlock}..${evidence.endSourceBlock}`);
    console.log(`  largest=${formatUnits(largest, 6)} cap=${formatUnits(cap, 6)} total=${formatUnits(total, 6)} USDC`);
    console.log(`  roots=${proof.continuityProof.roots.length} approximateProofSize=${(approximateProofBytes / 1024).toFixed(1)}KB verifyBatch=true`);
    console.log('Wrote docs/demo-evidence.json');
    process.exit(0);
  }
}
throw new Error('No candidate satisfied cap + approximate proof-size + verifyBatch. Raise WINDOW and retry.');
