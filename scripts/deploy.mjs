import 'dotenv/config';
import { Contract, ContractFactory, Wallet, getAddress } from 'ethers';
import { readFileSync, writeFileSync } from 'node:fs';
import { getProvider } from './lib/proofs.mjs';

const EXPECTED_CHAIN_ID = 102031n;
const EXPECTED_VERIFIER = '0x0000000000000000000000000000000000000FD2';
const FACILITY_ID = 1;

function artifact(name) {
  return JSON.parse(readFileSync(`out/${name}.sol/${name}.json`, 'utf8'));
}

async function deploy(name, contractArtifact, signer, args = []) {
  const factory = new ContractFactory(contractArtifact.abi, contractArtifact.bytecode.object, signer);
  const contract = await factory.deploy(...args);
  const receipt = await contract.deploymentTransaction().wait();
  if (receipt.status !== 1) throw new Error(`${name} deployment failed`);
  console.log(`${name}: ${await contract.getAddress()} (${receipt.hash})`);
  return { contract, receipt };
}

const provider = getProvider();
const network = await provider.getNetwork();
if (network.chainId !== EXPECTED_CHAIN_ID) {
  throw new Error(`Wrong network: expected ${EXPECTED_CHAIN_ID}, got ${network.chainId}`);
}

const verifier = getAddress(process.env.BLOCK_PROVER_PRECOMPILE);
if (verifier !== EXPECTED_VERIFIER) throw new Error(`Unexpected BlockProver precompile: ${verifier}`);

const deployer = new Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
if (deployer.address !== getAddress(process.env.DEPLOYER_ADDRESS)) {
  throw new Error('Deployer key does not match DEPLOYER_ADDRESS');
}

const facilityArtifact = artifact('RecourseFacility');
const adjudicatorArtifact = artifact('AttestcoinAdjudicator');
const covenantArtifact = artifact('OutflowCapCovenant');

const facilityDeployment = await deploy('RecourseFacility', facilityArtifact, deployer);
const facilityAddress = await facilityDeployment.contract.getAddress();

const adjudicatorDeployment = await deploy('AttestcoinAdjudicator', adjudicatorArtifact, deployer, [
  verifier,
  facilityAddress,
]);
const adjudicatorAddress = await adjudicatorDeployment.contract.getAddress();

const setAdjudicator = await facilityDeployment.contract.setAdjudicator(adjudicatorAddress);
const setAdjudicatorReceipt = await setAdjudicator.wait();
if (setAdjudicatorReceipt.status !== 1) throw new Error('setAdjudicator failed');
console.log(`setAdjudicator: ${setAdjudicatorReceipt.hash}`);

const covenantDeployment = await deploy('OutflowCapCovenant', covenantArtifact, deployer, [facilityAddress]);
const outflowCovenantAddress = await covenantDeployment.contract.getAddress();

const facility = new Contract(facilityAddress, facilityArtifact.abi, provider);
const adjudicator = new Contract(adjudicatorAddress, adjudicatorArtifact.abi, provider);
const covenant = new Contract(outflowCovenantAddress, covenantArtifact.abi, provider);
const code = await Promise.all(
  [facilityAddress, adjudicatorAddress, outflowCovenantAddress].map((address) => provider.getCode(address)),
);
if (code.some((value) => value === '0x')) throw new Error('A deployed contract has no bytecode');
if ((await facility.adjudicator()) !== adjudicatorAddress) throw new Error('Facility adjudicator wiring mismatch');
if ((await adjudicator.verifier()) !== verifier) throw new Error('Adjudicator verifier wiring mismatch');
if ((await adjudicator.facility()) !== facilityAddress) throw new Error('Adjudicator facility wiring mismatch');
if ((await covenant.facility()) !== facilityAddress) throw new Error('Covenant facility wiring mismatch');

const deployments = {
  facility: facilityAddress,
  adjudicator: adjudicatorAddress,
  outflowCovenant: outflowCovenantAddress,
  facilityId: FACILITY_ID,
  blockNumber: covenantDeployment.receipt.blockNumber,
};
writeFileSync('deployments.json', `${JSON.stringify(deployments, null, 2)}\n`);
console.log(`deployments.json written at block ${deployments.blockNumber}`);
