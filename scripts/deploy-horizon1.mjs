import 'dotenv/config';
import {
  Contract,
  ContractFactory,
  Wallet,
  getAddress,
  id,
  parseUnits,
  ZeroHash,
} from 'ethers';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { getProvider, getSourceProvider } from './lib/proofs.mjs';
import { send } from './lib/setup.mjs';

const EXPECTED_CHAIN_ID = 102031n;
const EXPECTED_VERIFIER = '0x0000000000000000000000000000000000000FD2';
const CHAIN_KEY = 3;
const POLICY_ID = 1n;
const MAINNET_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const FACILITY_LIMIT = parseUnits('100000', 6);
const BOND_REQUIRED = parseUnits('20000', 6);
const DRAW_AMOUNT = parseUnits('40000', 6);
const DRAW_FEE_BPS = 200;
const DRAW_DELAY_BLOCKS = 1;
const MATURITY_DISTANCE = 100_000;
const MONITORING_WINDOW = 10_000;

function artifact(name) {
  return JSON.parse(readFileSync(`out/${name}.sol/${name}.json`, 'utf8'));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function deploy(name, signer, args = []) {
  const contractArtifact = artifact(name);
  const factory = new ContractFactory(contractArtifact.abi, contractArtifact.bytecode.object, signer);
  const contract = await factory.deploy(...args);
  const receipt = await contract.deploymentTransaction().wait();
  if (receipt.status !== 1) throw new Error(`${name} deployment failed`);
  const address = await contract.getAddress();
  console.log(`${name}: ${address} (${receipt.hash})`);
  return { contract, address, receipt };
}

function wallet(name, keyName, addressName, provider) {
  const signer = new Wallet(process.env[keyName], provider);
  if (signer.address !== getAddress(process.env[addressName])) {
    throw new Error(`${name} key does not match ${addressName}`);
  }
  return signer;
}

const legacyDeployments = readFileSync('deployments.json');
const legacyDeploymentsSha256 = sha256(legacyDeployments);
const provider = getProvider();
const network = await provider.getNetwork();
if (network.chainId !== EXPECTED_CHAIN_ID) {
  throw new Error(`Wrong network: expected ${EXPECTED_CHAIN_ID}, got ${network.chainId}`);
}
const verifier = getAddress(process.env.BLOCK_PROVER_PRECOMPILE);
if (verifier !== EXPECTED_VERIFIER) throw new Error(`Unexpected verifier: ${verifier}`);

const deployer = wallet('deployer', 'DEPLOYER_PRIVATE_KEY', 'DEPLOYER_ADDRESS', provider);
const lender = wallet('lender', 'LENDER_PRIVATE_KEY', 'LENDER_ADDRESS', provider);
const borrower = wallet('borrower', 'BORROWER_PRIVATE_KEY', 'BORROWER_ADDRESS', provider);
const hunter = wallet('hunter', 'HUNTER_PRIVATE_KEY', 'HUNTER_ADDRESS', provider);
if (new Set([deployer.address, lender.address, borrower.address, hunter.address]).size !== 4) {
  throw new Error('Horizon 1 role addresses must be distinct');
}

const demoAssetDeployment = await deploy('RecourseDemoUSD', deployer, [
  lender.address,
  borrower.address,
  hunter.address,
]);
const kernelDeployment = await deploy('PolicyKernelV1', deployer, [verifier]);
const factoryDeployment = await deploy('RecourseFacilityFactoryV2', deployer, [deployer.address]);
const policyDeployment = await deploy('EventHistoryPolicyV1', deployer, [kernelDeployment.address]);
const jobsDeployment = await deploy('ProofJobsV1', deployer, [kernelDeployment.address]);

await send('setProofJobs', kernelDeployment.contract.setProofJobs(jobsDeployment.address));

const currentBlock = await provider.getBlockNumber();
const createReceipt = await send(
  'createFacility',
  factoryDeployment.contract.createFacility(
    demoAssetDeployment.address,
    kernelDeployment.address,
    lender.address,
    borrower.address,
    FACILITY_LIMIT,
    BOND_REQUIRED,
    DRAW_FEE_BPS,
    currentBlock + MATURITY_DISTANCE,
    DRAW_DELAY_BLOCKS,
  ),
);
const created = createReceipt.logs
  .map((log) => {
    try {
      return factoryDeployment.contract.interface.parseLog(log);
    } catch {
      return null;
    }
  })
  .find((log) => log?.name === 'FacilityCreated');
if (!created) throw new Error('FacilityCreated event missing');
const facilityAddress = getAddress(created.args.facility);

const sourceProvider = getSourceProvider(CHAIN_KEY);
const sourceHead = await sourceProvider.getBlockNumber();
const configuration = {
  sourceChain: CHAIN_KEY,
  emitter: MAINNET_USDC,
  eventSignature: id('Transfer(address,address,uint256)'),
  subject: borrower.address,
  startSourceBlock: sourceHead + 1,
  endSourceBlock: sourceHead + MONITORING_WINDOW,
  topicCount: 3,
  subjectTopicIndex: 1,
  dataLength: 32,
  observedValueOffset: 0,
  observationKind: 4,
  evidenceKind: 1,
  freshnessPeriod: 86_400,
  effect: {
    outcome: 3,
    creditLimitBps: 5_000,
    futureDrawFeeBps: 400,
    freezePendingDraw: true,
    requireFreshEvidence: true,
    terminate: false,
  },
};
await send(
  'configurePolicy',
  policyDeployment.contract.connect(lender).configure(facilityAddress, POLICY_ID, configuration),
);
await send(
  'registerPolicy',
  kernelDeployment.contract.connect(lender).registerPolicy(facilityAddress, POLICY_ID, policyDeployment.address),
);

const facility = new Contract(facilityAddress, artifact('RecourseFacilityV2').abi, provider);
const asset = demoAssetDeployment.contract;
await send('approve lender funding', asset.connect(lender).approve(facilityAddress, FACILITY_LIMIT));
await send('fundAsLender', facility.connect(lender).fundAsLender(FACILITY_LIMIT));
await send('approve borrower bond', asset.connect(borrower).approve(facilityAddress, BOND_REQUIRED));
await send('postBond', facility.connect(borrower).postBond(BOND_REQUIRED));
const policySetCommitment = await kernelDeployment.contract.policySetCommitment(facilityAddress);
await send('activate', facility.connect(borrower).activate(policySetCommitment));
await send('requestDraw', facility.connect(borrower).requestDraw(DRAW_AMOUNT));
await send('executeDraw', facility.connect(borrower).executeDraw());

const configHash = await policyDeployment.contract.configHash(facilityAddress, POLICY_ID);
const manifest = await policyDeployment.contract.manifest(facilityAddress, POLICY_ID);
const reimbursement = parseUnits('25', 6);
const outcomeReward = parseUnits('100', 6);
const maxSuccessfulProofs = 3;
const jobEscrow = reimbursement * BigInt(maxSuccessfulProofs) + outcomeReward;
const latestCc3Block = await provider.getBlock('latest');
if (!latestCc3Block) throw new Error('Latest CC3 block unavailable');
await send('approve proof-job escrow', asset.connect(lender).approve(jobsDeployment.address, jobEscrow));
const jobReceipt = await send(
  'create proof job',
  jobsDeployment.contract.connect(lender).createJob({
    token: demoAssetDeployment.address,
    facility: facilityAddress,
    policyId: POLICY_ID,
    requirementsDigest: configHash,
    expiry: latestCc3Block.timestamp + 7 * 24 * 60 * 60,
    revealWindowBlocks: 30,
    maxSuccessfulProofs,
    proofReimbursement: reimbursement,
    outcomeReward,
    commitBond: parseUnits('10', 6),
    rewardOutcomeThreshold: 3,
  }),
);
const jobCreated = jobReceipt.logs
  .map((log) => {
    try {
      return jobsDeployment.contract.interface.parseLog(log);
    } catch {
      return null;
    }
  })
  .find((log) => log?.name === 'JobCreated');
if (!jobCreated) throw new Error('JobCreated event missing');
const jobId = jobCreated.args.jobId;

const deployedAddresses = [
  demoAssetDeployment.address,
  kernelDeployment.address,
  factoryDeployment.address,
  policyDeployment.address,
  jobsDeployment.address,
  facilityAddress,
];
const code = await Promise.all(deployedAddresses.map((address) => provider.getCode(address)));
if (code.some((value) => value === '0x')) throw new Error('A Horizon 1 deployment has no bytecode');
if ((await facility.kernel()) !== kernelDeployment.address) throw new Error('Facility kernel mismatch');
if ((await facility.asset()) !== demoAssetDeployment.address) throw new Error('Facility asset mismatch');
if ((await kernelDeployment.contract.proofJobs()) !== jobsDeployment.address) throw new Error('ProofJobs wiring mismatch');
if ((await jobsDeployment.contract.kernel()) !== kernelDeployment.address) throw new Error('Jobs kernel mismatch');
if ((await policyDeployment.contract.context()) !== kernelDeployment.address) throw new Error('Policy context mismatch');
if ((await facility.status()) !== 1n) throw new Error('Demonstration facility is not Active');
if ((await facility.drawnPrincipal()) !== DRAW_AMOUNT) throw new Error('Demonstration draw mismatch');
if ((await facility.outstandingDebt()) !== parseUnits('40800', 6)) throw new Error('Demonstration debt mismatch');
if ((await facility.availableCredit()) !== parseUnits('60000', 6)) throw new Error('Available credit mismatch');
if ((await factoryDeployment.contract.isFacility(facilityAddress)) !== true) throw new Error('Factory index mismatch');
if (manifest === '0x' || configHash === ZeroHash) throw new Error('Public manifest missing');
if (sha256(readFileSync('deployments.json')) !== legacyDeploymentsSha256) {
  throw new Error('Legacy deployments.json changed during Horizon 1 deployment');
}

const deploymentRecord = {
  generation: 'horizon-1',
  chainId: Number(network.chainId),
  verifier,
  demoAsset: demoAssetDeployment.address,
  demoAssetKind: 'fixed-supply testnet demonstration token; not a production stablecoin',
  policyKernel: kernelDeployment.address,
  verifiedCreditState: await kernelDeployment.contract.creditState(),
  facilityFactory: factoryDeployment.address,
  eventHistoryPolicy: policyDeployment.address,
  proofJobs: jobsDeployment.address,
  demonstrationFacility: facilityAddress,
  policyId: POLICY_ID.toString(),
  policyConfigHash: configHash,
  policySetCommitment,
  proofJobId: jobId.toString(),
  sourceWindow: {
    chainKey: CHAIN_KEY,
    startBlock: configuration.startSourceBlock,
    endBlock: configuration.endSourceBlock,
  },
  demonstration: {
    facilityLimit: FACILITY_LIMIT.toString(),
    bondRequired: BOND_REQUIRED.toString(),
    drawnPrincipal: DRAW_AMOUNT.toString(),
    outstandingDebt: parseUnits('40800', 6).toString(),
    denominationDecimals: 6,
  },
  deploymentBlock: jobReceipt.blockNumber,
  legacyDeploymentsSha256,
};
writeFileSync('deployments-horizon1.json', `${JSON.stringify(deploymentRecord, null, 2)}\n`);
console.log(`deployments-horizon1.json written at block ${jobReceipt.blockNumber}`);
