import 'dotenv/config';
import { Interface, formatUnits, id } from 'ethers';
import { writeFileSync } from 'node:fs';
import { getSourceProvider, getAttestedHeight, fetchBatchProof } from './lib/proofs.mjs';

const CHAIN_KEY = 3;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const TRANSFER = id('Transfer(address,address,uint256)');
const WINDOW = 30;
const iface = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);

const eth = getSourceProvider(CHAIN_KEY);
const attested = await getAttestedHeight(CHAIN_KEY);
const to = attested - 5;
const from = to - WINDOW;

const bySender = new Map();
for (let b = from; b <= to; b++) {
  const logs = await eth.getLogs({ fromBlock: b, toBlock: b, address: USDC, topics: [TRANSFER] });
  for (const log of logs) {
    const parsed = iface.parseLog({ topics: log.topics, data: log.data });
    const sender = parsed.args.from.toLowerCase();
    if (parsed.args.to.toLowerCase() === sender) continue;
    if (!bySender.has(sender)) bySender.set(sender, new Map());
    const seen = bySender.get(sender);
    if (!seen.has(log.transactionHash)) {
      seen.set(log.transactionHash, {
        hash: log.transactionHash, block: log.blockNumber,
        valueBaseUnits: parsed.args.value.toString(), to: parsed.args.to,
      });
    }
  }
}

const candidates = [...bySender.entries()]
  .map(([treasury, seen]) => ({ treasury, txs: [...seen.values()].sort((a, b) => a.block - b.block) }))
  .filter((c) => c.txs.length >= 4)
  .sort((a, b) => b.txs.length - a.txs.length);

if (candidates.length === 0) {
  throw new Error('No treasury with >=4 outbound txs in window. Raise WINDOW to 60 and retry.');
}

const chosen = candidates[0];
const txs = chosen.txs.slice(0, 8);
const total = txs.reduce((s, t) => s + BigInt(t.valueBaseUnits), 0n);
const largest = txs.reduce((m, t) => (BigInt(t.valueBaseUnits) > m ? BigInt(t.valueBaseUnits) : m), 0n);
if (largest >= total) throw new Error('Largest single transfer is not below the cumulative total.');
const cap = largest + (total - largest) / 2n; // strictly between largest and total

const evidence = {
  chainKey: CHAIN_KEY, token: USDC, treasury: chosen.treasury,
  startSourceBlock: txs[0].block, endSourceBlock: txs[txs.length - 1].block,
  capBaseUnits: cap.toString(), expectedTotalBaseUnits: total.toString(), txs,
};

const proof = await fetchBatchProof(CHAIN_KEY, txs.map((t) => t.hash));
const calldataBytes = proof.continuityProof.roots.length * 32
  + proof.txBytes.reduce((s, b) => s + (b.length - 2) / 2, 0);
console.log(`treasury ${chosen.treasury}`);
console.log(`  txs=${txs.length} blocks ${evidence.startSourceBlock}..${evidence.endSourceBlock}`);
console.log(`  largest=${formatUnits(largest, 6)} cap=${formatUnits(cap, 6)} total=${formatUnits(total, 6)} USDC`);
console.log(`  continuityRoots=${proof.continuityProof.roots.length} calldata=${(calldataBytes / 1024).toFixed(1)}KB`);
if (calldataBytes > 15360) throw new Error('Calldata exceeds the ~15KB safe budget. Narrow the window.');

writeFileSync('docs/demo-evidence.json', JSON.stringify(evidence, null, 2));
console.log('Wrote docs/demo-evidence.json');
