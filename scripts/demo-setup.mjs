import 'dotenv/config';
import { Contract, Wallet, formatEther, getAddress, parseEther } from 'ethers';
import { readFileSync } from 'node:fs';
import { getProvider } from './lib/proofs.mjs';

const EXPECTED_CHAIN_ID = 102031n;
const COVENANT_ID = 1n;
const FACILITY_LIMIT = parseEther('1000');
const BOND_REQUIRED = parseEther('200');
const DRAW_AMOUNT = parseEther('400');
const DRAW_FEE_BPS = 200;
const DRAW_DELAY_BLOCKS = 10;
const MATURITY_DISTANCE = 100_000;
const ROLE_TARGETS = [
  ['lender', 'LENDER', parseEther('1100')],
  ['borrower', 'BORROWER', parseEther('300')],
  ['hunter', 'HUNTER', parseEther('100')],
];

function artifact(name) {
  return JSON.parse(readFileSync(`out/${name}.sol/${name}.json`, 'utf8'));
}

async function send(label, transactionPromise) {
  const transaction = await transactionPromise;
  const receipt = await transaction.wait();
  if (receipt.status !== 1) throw new Error(`${label} failed`);
  console.log(`${label}: ${receipt.hash}`);
  return receipt;
}

const provider = getProvider();
const network = await provider.getNetwork();
if (network.chainId !== EXPECTED_CHAIN_ID) {
  throw new Error(`Wrong network: expected ${EXPECTED_CHAIN_ID}, got ${network.chainId}`);
}

const deployments = JSON.parse(readFileSync('deployments.json', 'utf8'));
const evidence = JSON.parse(readFileSync('docs/demo-evidence.json', 'utf8'));
if (evidence.chainKey !== 3 || evidence.txs.length !== 5) throw new Error('Unexpected locked evidence set');

const deployer = new Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
if (deployer.address !== getAddress(process.env.DEPLOYER_ADDRESS)) {
  throw new Error('Deployer key does not match DEPLOYER_ADDRESS');
}

const roles = new Map();
for (const [name, prefix] of ROLE_TARGETS) {
  const wallet = new Wallet(process.env[`${prefix}_PRIVATE_KEY`], provider);
  if (wallet.address !== getAddress(process.env[`${prefix}_ADDRESS`])) {
    throw new Error(`${name} key does not match ${prefix}_ADDRESS`);
  }
  roles.set(name, wallet);
}
if (new Set([deployer.address, ...[...roles.values()].map((wallet) => wallet.address)]).size !== 4) {
  throw new Error('Deployer and role addresses must be distinct');
}

const facilityArtifact = artifact('RecourseFacility');
const adjudicatorArtifact = artifact('AttestcoinAdjudicator');
const covenantArtifact = artifact('OutflowCapCovenant');
const facility = new Contract(deployments.facility, facilityArtifact.abi, provider);
const adjudicator = new Contract(deployments.adjudicator, adjudicatorArtifact.abi, provider);
const covenant = new Contract(deployments.outflowCovenant, covenantArtifact.abi, provider);

const code = await Promise.all(
  [deployments.facility, deployments.adjudicator, deployments.outflowCovenant].map((address) =>
    provider.getCode(address),
  ),
);
if (code.some((value) => value === '0x')) throw new Error('A deployment address has no bytecode');
if ((await facility.adjudicator()) !== getAddress(deployments.adjudicator)) {
  throw new Error('Facility adjudicator wiring mismatch');
}
if (
  (await adjudicator.covenantOf(deployments.facilityId, COVENANT_ID)) !==
  getAddress('0x0000000000000000000000000000000000000000')
) {
  throw new Error('Facility covenant slot is already registered');
}
const existing = await facility.facilityOf(deployments.facilityId);
if (existing.lender !== getAddress('0x0000000000000000000000000000000000000000')) {
  throw new Error(`Facility ${deployments.facilityId} is already initialized`);
}

for (const [name, , target] of ROLE_TARGETS) {
  const wallet = roles.get(name);
  const balance = await provider.getBalance(wallet.address);
  if (balance < target) {
    await send(
      `fund ${name} (${formatEther(target - balance)} tCTC)`,
      deployer.sendTransaction({ to: wallet.address, value: target - balance }),
    );
  }
}

const lender = roles.get('lender');
const borrower = roles.get('borrower');
const maturityBlock = (await provider.getBlockNumber()) + MATURITY_DISTANCE;
const openReceipt = await send(
  'openFacility',
  facility
    .connect(deployer)
    .openFacility(
      lender.address,
      borrower.address,
      FACILITY_LIMIT,
      BOND_REQUIRED,
      DRAW_FEE_BPS,
      maturityBlock,
      DRAW_DELAY_BLOCKS,
    ),
);
const opened = openReceipt.logs
  .map((log) => {
    try {
      return facility.interface.parseLog(log);
    } catch {
      return null;
    }
  })
  .find((log) => log?.name === 'FacilityOpened');
if (!opened || opened.args.facilityId !== BigInt(deployments.facilityId)) {
  throw new Error('Opened facility ID does not match deployments.json');
}

await send(
  'registerCovenant',
  adjudicator.connect(lender).registerCovenant(deployments.facilityId, COVENANT_ID, deployments.outflowCovenant),
);
await send(
  'configure outflow covenant',
  covenant
    .connect(lender)
    .configure(
      deployments.facilityId,
      evidence.chainKey,
      evidence.token,
      evidence.treasury,
      evidence.startSourceBlock,
      evidence.endSourceBlock,
      evidence.capBaseUnits,
    ),
);
await send(
  'fundAsLender',
  facility.connect(lender).fundAsLender(deployments.facilityId, { value: FACILITY_LIMIT }),
);
await send(
  'postBond',
  facility.connect(borrower).postBond(deployments.facilityId, { value: BOND_REQUIRED }),
);
await send('activate', facility.connect(borrower).activate(deployments.facilityId));
await send('requestDraw', facility.connect(borrower).requestDraw(deployments.facilityId, DRAW_AMOUNT));

const requested = await facility.facilityOf(deployments.facilityId);
while ((await provider.getBlockNumber()) < Number(requested.drawReadyAtBlock)) {
  const current = await provider.getBlockNumber();
  console.log(`waiting for draw block ${requested.drawReadyAtBlock} (current ${current})`);
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}

await send('executeDraw', facility.connect(borrower).executeDraw(deployments.facilityId));
const configuredCovenant = await adjudicator.covenantOf(deployments.facilityId, COVENANT_ID);
const state = await facility.state(deployments.facilityId);
const debt = await facility.outstandingDebt(deployments.facilityId);
const available = await facility.availableCredit(deployments.facilityId);
const finalFacility = await facility.facilityOf(deployments.facilityId);
if (configuredCovenant !== getAddress(deployments.outflowCovenant)) throw new Error('Covenant registration mismatch');
if (state !== 1n) throw new Error(`Expected Active state, got ${state}`);
if (finalFacility.drawnPrincipal !== DRAW_AMOUNT) throw new Error('Drawn principal mismatch');
if (debt !== parseEther('408')) throw new Error(`Expected 408 tCTC debt, got ${formatEther(debt)}`);
if (available !== parseEther('600')) throw new Error(`Expected 600 tCTC available, got ${formatEther(available)}`);
console.log(`facility ${deployments.facilityId}: Active, debt=${formatEther(debt)}, available=${formatEther(available)}`);
