import 'dotenv/config';
import {
  AbiCoder,
  Interface,
  Wallet,
  ZeroAddress,
  ZeroHash,
  formatEther,
  formatUnits,
  getAddress,
  id,
  keccak256,
  parseEther,
  parseUnits,
} from 'ethers';
import { readFileSync, writeFileSync } from 'node:fs';
import { computeConfigHash } from '../daemon/core.mjs';
import { getAttestedHeight, getProvider, getSourceProvider } from './lib/proofs.mjs';
import { contractFromArtifact, send } from './lib/setup.mjs';

const EXPECTED_CHAIN_ID = 102031n;
const FACILITY_ID = 2n;
const COVENANT_ID = 1n;
const CHAIN_KEY = 3;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const TREASURY = '0x000000000004444c5dc75cb358380d2e3de08a90';
const SOURCE_BLOCK_MARGIN = 64;
const SOURCE_BLOCK_RANGE = 600;
const CAP_BASE_UNITS = parseUnits('100', 6);
const TREASURY_SAMPLE_BLOCKS = 40;
const MIN_SAMPLE_TRANSACTIONS = 10;
const FACILITY_LIMIT = parseEther('1000');
const BOND_REQUIRED = parseEther('200');
const DRAW_AMOUNT = parseEther('400');
const DRAW_FEE_BPS = 200;
const DRAW_DELAY_BLOCKS = 10;
const MATURITY_DISTANCE = 100_000;
const LENDER_TARGET_BALANCE = parseEther('1100');

const provider = getProvider();
const sourceProvider = getSourceProvider(CHAIN_KEY);
const network = await provider.getNetwork();
if (network.chainId !== EXPECTED_CHAIN_ID) {
  throw new Error(`Wrong network: expected ${EXPECTED_CHAIN_ID}, got ${network.chainId}`);
}

const deployments = JSON.parse(readFileSync('deployments.json', 'utf8'));
const deployer = new Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
const lender = new Wallet(process.env.LENDER_PRIVATE_KEY, provider);
const borrower = new Wallet(process.env.BORROWER_PRIVATE_KEY, provider);
for (const [name, wallet, address] of [
  ['deployer', deployer, process.env.DEPLOYER_ADDRESS],
  ['lender', lender, process.env.LENDER_ADDRESS],
  ['borrower', borrower, process.env.BORROWER_ADDRESS],
]) {
  if (wallet.address !== getAddress(address)) throw new Error(`${name} key does not match configured address`);
}
if (new Set([deployer.address, lender.address, borrower.address]).size !== 3) {
  throw new Error('Deployer, lender, and borrower addresses must be distinct');
}

const facility = contractFromArtifact(deployments.facility, 'RecourseFacility', provider);
const adjudicator = contractFromArtifact(deployments.adjudicator, 'AttestcoinAdjudicator', provider);
const covenant = contractFromArtifact(deployments.outflowCovenant, 'OutflowCapCovenant', provider);
const deployedCode = await Promise.all(
  [deployments.facility, deployments.adjudicator, deployments.outflowCovenant].map((address) =>
    provider.getCode(address),
  ),
);
if (deployedCode.some((code) => code === '0x')) throw new Error('A deployment address has no bytecode');
if ((await facility.adjudicator()) !== getAddress(deployments.adjudicator)) {
  throw new Error('Facility adjudicator wiring mismatch');
}
if ((await adjudicator.covenantOf(FACILITY_ID, COVENANT_ID)) !== ZeroAddress) {
  throw new Error(`Facility ${FACILITY_ID} covenant slot is already registered`);
}
if ((await facility.facilityOf(FACILITY_ID)).lender !== ZeroAddress) {
  throw new Error(`Facility ${FACILITY_ID} is already initialized`);
}

const latestSourceBlock = await sourceProvider.getBlockNumber();
const sampleStartBlock = latestSourceBlock - TREASURY_SAMPLE_BLOCKS + 1;
const transferInterface = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const treasuryTopic = AbiCoder.defaultAbiCoder().encode(['address'], [TREASURY]);
const recentLogs = await sourceProvider.getLogs({
  address: USDC,
  topics: [id('Transfer(address,address,uint256)'), treasuryTopic],
  fromBlock: sampleStartBlock,
  toBlock: latestSourceBlock,
});
const recentOutflows = recentLogs.filter((log) => {
  const transfer = transferInterface.parseLog(log);
  return transfer.args.to !== getAddress(TREASURY);
});
const distinctTransactions = new Set(recentOutflows.map((log) => log.transactionHash));
const sampledOutflow = recentOutflows.reduce(
  (total, log) => total + transferInterface.parseLog(log).args.value,
  0n,
);
if (distinctTransactions.size < MIN_SAMPLE_TRANSACTIONS) {
  throw new Error(
    `Treasury activity too low: ${distinctTransactions.size} transactions in ${TREASURY_SAMPLE_BLOCKS} blocks`,
  );
}
console.log(
  `treasury ${TREASURY}: ${distinctTransactions.size} outbound USDC transactions, ` +
    `${recentOutflows.length} transfers, ${formatUnits(sampledOutflow, 6)} USDC in blocks ` +
    `${sampleStartBlock}..${latestSourceBlock}`,
);

const attestedHeight = await getAttestedHeight(CHAIN_KEY);
const startSourceBlock = attestedHeight + SOURCE_BLOCK_MARGIN;
const endSourceBlock = startSourceBlock + SOURCE_BLOCK_RANGE;
if (startSourceBlock <= latestSourceBlock) {
  throw new Error(
    `Configured margin is stale: start ${startSourceBlock} is not ahead of mainnet ${latestSourceBlock}`,
  );
}
const config = {
  chainKey: CHAIN_KEY,
  token: USDC,
  treasury: TREASURY,
  startSourceBlock,
  endSourceBlock,
  capBaseUnits: CAP_BASE_UNITS.toString(),
};
console.log(
  `attested=${attestedHeight}, mainnet=${latestSourceBlock}, window=${startSourceBlock}..${endSourceBlock}, ` +
    `cap=${formatUnits(CAP_BASE_UNITS, 6)} USDC`,
);

const expectedFacilityId = await facility
  .connect(deployer)
  .openFacility.staticCall(
    lender.address,
    borrower.address,
    FACILITY_LIMIT,
    BOND_REQUIRED,
    DRAW_FEE_BPS,
    (await provider.getBlockNumber()) + MATURITY_DISTANCE,
    DRAW_DELAY_BLOCKS,
  );
if (expectedFacilityId !== FACILITY_ID) {
  throw new Error(`Expected next facility ID ${FACILITY_ID}, got ${expectedFacilityId}`);
}

const lenderBalance = await provider.getBalance(lender.address);
if (lenderBalance < LENDER_TARGET_BALANCE) {
  await send(
    `top up lender (${formatEther(LENDER_TARGET_BALANCE - lenderBalance)} tCTC)`,
    deployer.sendTransaction({ to: lender.address, value: LENDER_TARGET_BALANCE - lenderBalance }),
  );
}

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
if (!opened || opened.args.facilityId !== FACILITY_ID) {
  throw new Error(`Opened facility ID does not equal ${FACILITY_ID}`);
}

const expectedConfigHash = computeConfigHash(config);
await send(
  'configure outflow covenant',
  covenant
    .connect(lender)
    .configure(
      FACILITY_ID,
      config.chainKey,
      config.token,
      config.treasury,
      config.startSourceBlock,
      config.endSourceBlock,
      config.capBaseUnits,
    ),
);
const configuredHash = await covenant.configHash(FACILITY_ID);
if (configuredHash !== expectedConfigHash) {
  throw new Error(`Config hash mismatch after configure: local=${expectedConfigHash} on-chain=${configuredHash}`);
}

await send(
  'registerCovenant',
  adjudicator.connect(lender).registerCovenant(FACILITY_ID, COVENANT_ID, deployments.outflowCovenant),
);
const expectedCommitment = keccak256(
  AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'uint256', 'address', 'bytes32'],
    [ZeroHash, COVENANT_ID, deployments.outflowCovenant, expectedConfigHash],
  ),
);
const commitment = await adjudicator.covenantSetCommitment(FACILITY_ID);
if (commitment !== expectedCommitment) {
  throw new Error(`Covenant commitment mismatch: local=${expectedCommitment} on-chain=${commitment}`);
}

await send('fundAsLender', facility.connect(lender).fundAsLender(FACILITY_ID, { value: FACILITY_LIMIT }));
await send('postBond', facility.connect(borrower).postBond(FACILITY_ID, { value: BOND_REQUIRED }));
await send('activate', facility.connect(borrower).activate(FACILITY_ID, expectedCommitment));
await send('requestDraw', facility.connect(borrower).requestDraw(FACILITY_ID, DRAW_AMOUNT));

const requested = await facility.facilityOf(FACILITY_ID);
while ((await provider.getBlockNumber()) < Number(requested.drawReadyAtBlock)) {
  const currentBlock = await provider.getBlockNumber();
  console.log(`waiting for draw block ${requested.drawReadyAtBlock} (current ${currentBlock})`);
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}
await send('executeDraw', facility.connect(borrower).executeDraw(FACILITY_ID));

const [state, debt, available, finalFacility, finalConfigHash] = await Promise.all([
  facility.state(FACILITY_ID),
  facility.outstandingDebt(FACILITY_ID),
  facility.availableCredit(FACILITY_ID),
  facility.facilityOf(FACILITY_ID),
  covenant.configHash(FACILITY_ID),
]);
if (state !== 1n) throw new Error(`Expected Active state, got ${state}`);
if (finalFacility.drawnPrincipal !== DRAW_AMOUNT) throw new Error('Drawn principal mismatch');
if (debt !== parseEther('408')) throw new Error(`Expected 408 tCTC debt, got ${formatEther(debt)}`);
if (available !== parseEther('600')) throw new Error(`Expected 600 tCTC available, got ${formatEther(available)}`);
if (finalConfigHash !== expectedConfigHash) {
  throw new Error(`Final config hash mismatch: local=${expectedConfigHash} on-chain=${finalConfigHash}`);
}

writeFileSync('daemon/config.json', `${JSON.stringify(config, null, 2)}\n`);
const writtenConfig = JSON.parse(readFileSync('daemon/config.json', 'utf8'));
const writtenHash = computeConfigHash(writtenConfig);
if (writtenHash !== finalConfigHash) {
  throw new Error(`Written config hash mismatch: local=${writtenHash} on-chain=${finalConfigHash}`);
}
console.log(
  `facility ${FACILITY_ID}: Active, funded=${formatEther(finalFacility.lenderFunded)}, ` +
    `bond=${formatEther(finalFacility.bondPosted)}, drawn=${formatEther(finalFacility.drawnPrincipal)}, ` +
    `debt=${formatEther(debt)}, available=${formatEther(available)} tCTC`,
);
console.log(`config hash matched: ${writtenHash}`);
