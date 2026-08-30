import 'dotenv/config';
import { Contract, ContractFactory, JsonRpcProvider, Wallet, getCreateAddress } from 'ethers';
import {
  CORE_CONTRACT_NAMES,
  atomicWriteJson,
  parseV3DeploymentArguments,
  readCoreArtifacts,
  readV3DeploymentConfig,
  reserveV3Manifest,
  runV3Preflight,
  verifyV3Deployment,
} from './lib/v3-deployment.mjs';

const ASSET_ABI = [
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
];
const VERIFIER_ABI = [
  'function calculateTxIndex((bytes32 root,(bytes32 hash,bool isLeft)[] siblings) proof) view returns (uint64)',
];

function requireEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function constructorArguments(config, kernelAddress) {
  return {
    PolicyKernelV2: [config.verifier],
    PolicyRegistryV1: [],
    CappedPilotFactoryV1: [
      config.asset.address,
      kernelAddress,
      config.roles.lender,
      config.roles.borrower,
      config.roles.guardian,
      config.pilotBounds.maximumFacilityLimit,
      config.pilotBounds.maximumTotalLimit,
      config.pilotBounds.minimumBondBps,
      config.pilotBounds.maximumDrawFeeBps,
      config.pilotBounds.maximumMaturityBlocks,
      config.pilotBounds.maximumDrawDelayBlocks,
      config.pilotBounds.maximumFacilityCount,
    ],
    MultiChainEventPolicyV1: [kernelAddress],
    ProofJobsV1: [kernelAddress],
  };
}

async function predictDeployments(provider, signer, config, artifacts) {
  const deployer = await signer.getAddress();
  const nonce = await provider.getTransactionCount(deployer, 'pending');
  const addresses = Object.fromEntries(
    CORE_CONTRACT_NAMES.map((name, index) => [name, getCreateAddress({ from: deployer, nonce: nonce + index })]),
  );
  const args = constructorArguments(config, addresses.PolicyKernelV2);
  for (const name of CORE_CONTRACT_NAMES) {
    const factory = new ContractFactory(artifacts[name].abi, artifacts[name].bytecode.object, signer);
    const transaction = await factory.getDeployTransaction(...args[name]);
    if (!transaction.data || transaction.data === '0x') throw new Error(`${name} deployment transaction is empty`);
  }
  return { startingNonce: nonce, addresses };
}

async function deploy(name, signer, artifact, args) {
  const factory = new ContractFactory(artifact.abi, artifact.bytecode.object, signer);
  const contract = await factory.deploy(...args);
  const transaction = contract.deploymentTransaction();
  const receipt = await transaction.wait();
  if (receipt.status !== 1) throw new Error(`${name} deployment failed`);
  const address = await contract.getAddress();
  console.log(`${name}: ${address} (${receipt.hash})`);
  return { contract, address, transactionHash: receipt.hash, blockNumber: receipt.blockNumber };
}

const options = parseV3DeploymentArguments(process.argv.slice(2));
const config = readV3DeploymentConfig(options.configPath);
const artifacts = readCoreArtifacts();
const provider = new JsonRpcProvider(requireEnvironment('CREDITCOIN_RPC_URL'));
const signer = new Wallet(requireEnvironment('DEPLOYER_PRIVATE_KEY'), provider);
const verifier = new Contract(config.verifier, VERIFIER_ABI, provider);
const asset = new Contract(config.asset.address, ASSET_ABI, provider);
const preflight = await runV3Preflight({ provider, signer, verifier, asset, config, artifacts });
const prediction = await predictDeployments(provider, signer, config, artifacts);

if (!options.broadcast) {
  console.log(
    JSON.stringify(
      {
        mode: 'dry-run',
        preflight,
        startingNonce: prediction.startingNonce,
        predictedContracts: prediction.addresses,
        transactionsBroadcast: 0,
        manifestWritten: false,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const releaseManifestReservation = reserveV3Manifest(options.manifestPath);
const args = constructorArguments(config, prediction.addresses.PolicyKernelV2);
const deployments = {};
for (const name of CORE_CONTRACT_NAMES) {
  deployments[name] = await deploy(name, signer, artifacts[name], args[name]);
  if (deployments[name].address !== prediction.addresses[name]) {
    throw new Error(`${name} address differs from the preflight prediction`);
  }
}
const wiringTransaction = await deployments.PolicyKernelV2.contract.setProofJobs(deployments.ProofJobsV1.address);
const wiringReceipt = await wiringTransaction.wait();
if (wiringReceipt.status !== 1) throw new Error('setProofJobs failed');
console.log(`setProofJobs: ${wiringReceipt.hash}`);

const addresses = Object.fromEntries(CORE_CONTRACT_NAMES.map((name) => [name, deployments[name].address]));
const verification = await verifyV3Deployment({
  provider,
  signerAddress: preflight.deployer,
  config,
  artifacts,
  addresses,
});
const manifest = {
  generation: config.generation,
  chainId: config.chainId,
  verifier: config.verifier,
  asset: config.asset,
  roles: config.roles,
  pilotBounds: {
    ...config.pilotBounds,
    maximumFacilityLimit: config.pilotBounds.maximumFacilityLimit.toString(),
    maximumTotalLimit: config.pilotBounds.maximumTotalLimit.toString(),
  },
  contracts: {
    policyKernel: addresses.PolicyKernelV2,
    verifiedCreditState: verification.creditState,
    policyRegistry: addresses.PolicyRegistryV1,
    cappedPilotFactory: addresses.CappedPilotFactoryV1,
    multiChainEventPolicy: addresses.MultiChainEventPolicyV1,
    proofJobs: addresses.ProofJobsV1,
  },
  transactions: {
    policyKernel: deployments.PolicyKernelV2.transactionHash,
    policyRegistry: deployments.PolicyRegistryV1.transactionHash,
    cappedPilotFactory: deployments.CappedPilotFactoryV1.transactionHash,
    multiChainEventPolicy: deployments.MultiChainEventPolicyV1.transactionHash,
    proofJobs: deployments.ProofJobsV1.transactionHash,
    setProofJobs: wiringReceipt.hash,
  },
  deploymentBlocks: Object.fromEntries(
    CORE_CONTRACT_NAMES.map((name) => [name, deployments[name].blockNumber]),
  ),
  wiringVerifiedAtBlock: await provider.getBlockNumber(),
  activation: {
    facilitiesCreated: 0,
    policiesConfigured: 0,
    registryClaimsPublished: 0,
    assetsTransferred: '0',
  },
};
atomicWriteJson(options.manifestPath, manifest);
releaseManifestReservation();
console.log(`${options.manifestPath} written after bytecode and wiring verification`);
