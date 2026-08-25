import 'dotenv/config';
import { Contract, Wallet, formatEther, getAddress, parseEther } from 'ethers';
import { readFileSync } from 'node:fs';
import { fetchBatchProof, getProvider, prewarm } from './lib/proofs.mjs';

const EXPECTED_CHAIN_ID = 102031n;
const COVENANT_ID = 1n;
const EXPECTED_TOTAL = 274_790_000n;
const GAS_LIMIT = 1_500_000n;
const STATE_NAMES = ['Created', 'Active', 'Repaid', 'Breached', 'Defaulted', 'Cancelled'];

function artifact(name) {
  return JSON.parse(readFileSync(`out/${name}.sol/${name}.json`, 'utf8'));
}

const provider = getProvider();
const network = await provider.getNetwork();
if (network.chainId !== EXPECTED_CHAIN_ID) {
  throw new Error(`Wrong network: expected ${EXPECTED_CHAIN_ID}, got ${network.chainId}`);
}

const deployments = JSON.parse(readFileSync('deployments.json', 'utf8'));
const evidence = JSON.parse(readFileSync('docs/demo-evidence.json', 'utf8'));
const hashes = evidence.txs.map((transaction) => transaction.hash);
if (evidence.chainKey !== 3 || hashes.length !== 5 || BigInt(evidence.expectedTotalBaseUnits) !== EXPECTED_TOTAL) {
  throw new Error('Unexpected locked evidence set');
}

const hunter = new Wallet(process.env.HUNTER_PRIVATE_KEY, provider);
if (hunter.address !== getAddress(process.env.HUNTER_ADDRESS)) {
  throw new Error('Hunter key does not match HUNTER_ADDRESS');
}

const facility = new Contract(deployments.facility, artifact('RecourseFacility').abi, provider);
const adjudicator = new Contract(deployments.adjudicator, artifact('AttestcoinAdjudicator').abi, hunter);
const beforeState = await facility.state(deployments.facilityId);
const beforeDebt = await facility.outstandingDebt(deployments.facilityId);
const beforeAvailable = await facility.availableCredit(deployments.facilityId);
const beforeFacility = await facility.facilityOf(deployments.facilityId);
const hunterBefore = await provider.getBalance(hunter.address);
if (beforeState !== 1n) throw new Error(`Expected Active state, got ${STATE_NAMES[Number(beforeState)]}`);
if (beforeDebt !== parseEther('408')) throw new Error(`Expected 408 tCTC debt, got ${formatEther(beforeDebt)}`);
if (beforeAvailable !== parseEther('600')) {
  throw new Error(`Expected 600 tCTC available credit, got ${formatEther(beforeAvailable)}`);
}
if (beforeFacility.bondPosted !== parseEther('200')) {
  throw new Error(`Expected 200 tCTC bond, got ${formatEther(beforeFacility.bondPosted)}`);
}

console.log(`before: state=${STATE_NAMES[Number(beforeState)]} debt=${formatEther(beforeDebt)} hunter=${formatEther(hunterBefore)}`);
console.log(`prewarming ${hashes.length} proofs`);
await prewarm(evidence.chainKey, hashes);
console.log('fetching batch proof');
const proof = await fetchBatchProof(evidence.chainKey, hashes);
if (
  proof.heights.length !== hashes.length ||
  proof.txBytes.length !== hashes.length ||
  proof.merkleProofs.length !== hashes.length
) {
  throw new Error('Batch proof cardinality mismatch');
}
const expectedHeights = evidence.txs.map((transaction) => transaction.block).sort((a, b) => a - b);
const actualHeights = [...proof.heights].sort((a, b) => a - b);
if (actualHeights.some((height, index) => height !== expectedHeights[index])) {
  throw new Error('Batch proof heights do not match the locked evidence');
}

const args = [
  deployments.facilityId,
  COVENANT_ID,
  evidence.chainKey,
  proof.heights,
  proof.txBytes,
  proof.merkleProofs,
  proof.continuityProof,
];
const transaction = await adjudicator.submitBatch(...args, { gasLimit: GAS_LIMIT });
console.log(`submitBatch: ${transaction.hash}`);
const receipt = await transaction.wait();
if (receipt.status !== 1) throw new Error('submitBatch failed');

const afterState = await facility.state(deployments.facilityId);
const afterDebt = await facility.outstandingDebt(deployments.facilityId);
const afterAvailable = await facility.availableCredit(deployments.facilityId);
const hunterAfter = await provider.getBalance(hunter.address);
const accumulated = await new Contract(
  deployments.outflowCovenant,
  artifact('OutflowCapCovenant').abi,
  provider,
).accumulated(deployments.facilityId);
const hunterPayout = hunterAfter + receipt.fee - hunterBefore;

if (afterState !== 3n) throw new Error(`Expected Breached state, got ${STATE_NAMES[Number(afterState)]}`);
if (afterDebt !== parseEther('248')) throw new Error(`Expected 248 tCTC debt, got ${formatEther(afterDebt)}`);
if (afterAvailable !== 0n) throw new Error(`Expected zero available credit, got ${formatEther(afterAvailable)}`);
if (hunterPayout !== parseEther('40')) throw new Error(`Expected 40 tCTC hunter payout, got ${formatEther(hunterPayout)}`);
if (accumulated !== EXPECTED_TOTAL) throw new Error(`Expected accumulated ${EXPECTED_TOTAL}, got ${accumulated}`);

console.log(`after: state=${STATE_NAMES[Number(afterState)]} debt=${formatEther(afterDebt)} hunter=${formatEther(hunterAfter)}`);
console.log(`hunter payout=${formatEther(hunterPayout)} tCTC (net balance change plus ${formatEther(receipt.fee)} tCTC gas)`);
console.log(`availableCredit=${formatEther(afterAvailable)} accumulated=${accumulated}`);
console.log(`gas used=${receipt.gasUsed}`);
console.log(`breach transaction=${receipt.hash}`);
