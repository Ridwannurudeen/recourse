import { Contract, getAddress } from 'ethers';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const EXPECTED_V3_CHAIN_ID = 102031;
export const EXPECTED_V3_VERIFIER = '0x0000000000000000000000000000000000000FD2';
export const CORE_CONTRACT_NAMES = [
  'PolicyKernelV2',
  'PolicyRegistryV1',
  'CappedPilotFactoryV1',
  'MultiChainEventPolicyV1',
  'ProofJobsV1',
];

const ROLE_NAMES = ['deployer', 'lender', 'borrower', 'guardian'];
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function nonzeroAddress(value, label) {
  const address = getAddress(value);
  if (address === ZERO_ADDRESS) throw new Error(`${label} must not be the zero address`);
  return address;
}

function requiredObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requiredArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

function nonnegativeInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${label} must be a nonnegative integer no greater than ${maximum}`);
  }
  return value;
}

function positiveDecimal(value, label) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${label} must be a positive base-10 integer string`);
  }
  return BigInt(value);
}

function roleAddress(roles, role, label) {
  if (!ROLE_NAMES.includes(role)) throw new Error(`${label} has unknown role ${role}`);
  return roles[role];
}

function normalizeBalanceRequirements(requirements, roles) {
  const nativeBalances = requiredArray(requirements.nativeBalances, 'requirements.nativeBalances').map(
    (requirement, index) => {
      const value = requiredObject(requirement, `requirements.nativeBalances[${index}]`);
      return {
        role: value.role,
        address: roleAddress(roles, value.role, `requirements.nativeBalances[${index}]`),
        minimumWei: positiveDecimal(value.minimumWei, `requirements.nativeBalances[${index}].minimumWei`),
      };
    },
  );
  const assetBalances = requiredArray(requirements.assetBalances, 'requirements.assetBalances').map(
    (requirement, index) => {
      const value = requiredObject(requirement, `requirements.assetBalances[${index}]`);
      return {
        role: value.role,
        address: roleAddress(roles, value.role, `requirements.assetBalances[${index}]`),
        minimumBaseUnits: positiveDecimal(
          value.minimumBaseUnits,
          `requirements.assetBalances[${index}].minimumBaseUnits`,
        ),
      };
    },
  );
  const assetAllowances = requiredArray(requirements.assetAllowances, 'requirements.assetAllowances').map(
    (requirement, index) => {
      const value = requiredObject(requirement, `requirements.assetAllowances[${index}]`);
      return {
        ownerRole: value.ownerRole,
        owner: roleAddress(roles, value.ownerRole, `requirements.assetAllowances[${index}]`),
        spender: getAddress(value.spender),
        minimumBaseUnits: positiveDecimal(
          value.minimumBaseUnits,
          `requirements.assetAllowances[${index}].minimumBaseUnits`,
        ),
      };
    },
  );
  return { nativeBalances, assetBalances, assetAllowances };
}

export function parseV3DeploymentArguments(args) {
  const parsed = {
    broadcast: false,
    configPath: 'config/v3-cc3.json',
    manifestPath: 'deployments-v3.json',
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--broadcast') {
      parsed.broadcast = true;
    } else if (argument === '--config' || argument === '--manifest') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a path`);
      if (argument === '--config') parsed.configPath = value;
      else parsed.manifestPath = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return parsed;
}

export function validateV3DeploymentConfig(input) {
  const config = requiredObject(input, 'config');
  if (config.generation !== 'v3-core') throw new Error('generation must be v3-core');
  if (config.chainId !== EXPECTED_V3_CHAIN_ID) {
    throw new Error(`chainId must be ${EXPECTED_V3_CHAIN_ID}`);
  }
  const verifier = getAddress(config.verifier);
  if (verifier !== EXPECTED_V3_VERIFIER) throw new Error(`verifier must be ${EXPECTED_V3_VERIFIER}`);

  const assetInput = requiredObject(config.asset, 'asset');
  const asset = {
    address: nonzeroAddress(assetInput.address, 'asset.address'),
    decimals: nonnegativeInteger(assetInput.decimals, 'asset.decimals', 255),
  };
  const roleInput = requiredObject(config.roles, 'roles');
  const roles = Object.fromEntries(
    ROLE_NAMES.map((role) => [role, nonzeroAddress(roleInput[role], `roles.${role}`)]),
  );
  if (new Set(Object.values(roles)).size !== ROLE_NAMES.length) {
    throw new Error('V3 deployment roles must be distinct');
  }

  const boundsInput = requiredObject(config.pilotBounds, 'pilotBounds');
  const pilotBounds = {
    maximumFacilityLimit: positiveDecimal(boundsInput.maximumFacilityLimit, 'pilotBounds.maximumFacilityLimit'),
    maximumTotalLimit: positiveDecimal(boundsInput.maximumTotalLimit, 'pilotBounds.maximumTotalLimit'),
    minimumBondBps: positiveInteger(boundsInput.minimumBondBps, 'pilotBounds.minimumBondBps', 10_000),
    maximumDrawFeeBps: nonnegativeInteger(
      boundsInput.maximumDrawFeeBps,
      'pilotBounds.maximumDrawFeeBps',
      10_000,
    ),
    maximumMaturityBlocks: positiveInteger(
      boundsInput.maximumMaturityBlocks,
      'pilotBounds.maximumMaturityBlocks',
      Number.MAX_SAFE_INTEGER,
    ),
    maximumDrawDelayBlocks: nonnegativeInteger(
      boundsInput.maximumDrawDelayBlocks,
      'pilotBounds.maximumDrawDelayBlocks',
      0xffffffff,
    ),
    maximumFacilityCount: positiveInteger(boundsInput.maximumFacilityCount, 'pilotBounds.maximumFacilityCount', 0xffff),
  };
  if (pilotBounds.maximumTotalLimit < pilotBounds.maximumFacilityLimit) {
    throw new Error('pilotBounds.maximumTotalLimit must be at least maximumFacilityLimit');
  }

  const requirements = normalizeBalanceRequirements(requiredObject(config.requirements, 'requirements'), roles);
  return { generation: config.generation, chainId: config.chainId, verifier, asset, roles, pilotBounds, requirements };
}

export function readV3DeploymentConfig(path) {
  return validateV3DeploymentConfig(JSON.parse(readFileSync(path, 'utf8')));
}

export function readCoreArtifacts(rootDirectory = process.cwd()) {
  return Object.fromEntries(
    CORE_CONTRACT_NAMES.map((name) => {
      const path = resolve(rootDirectory, 'out', `${name}.sol`, `${name}.json`);
      if (!existsSync(path)) throw new Error(`Missing contract artifact: ${path}`);
      return [name, JSON.parse(readFileSync(path, 'utf8'))];
    }),
  );
}

function validateArtifacts(artifacts) {
  for (const name of CORE_CONTRACT_NAMES) {
    const artifact = artifacts[name];
    if (!artifact || !Array.isArray(artifact.abi)) throw new Error(`${name} artifact ABI is missing`);
    const bytecode = artifact.bytecode?.object;
    if (typeof bytecode !== 'string' || !/^0x[0-9a-fA-F]+$/.test(bytecode) || bytecode === '0x') {
      throw new Error(`${name} artifact bytecode is missing`);
    }
  }
}

export async function runV3Preflight({ provider, signer, verifier, asset, config, artifacts }) {
  validateArtifacts(artifacts);
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(config.chainId)) {
    throw new Error(`Wrong network: expected ${config.chainId}, got ${network.chainId}`);
  }
  const deployer = getAddress(await signer.getAddress());
  if (deployer !== config.roles.deployer) throw new Error('Deployer key does not match configured deployer address');

  const [emptyProofIndex, assetCode, decimals] = await Promise.all([
    verifier.calculateTxIndex([`0x${'00'.repeat(32)}`, []]),
    provider.getCode(config.asset.address),
    asset.decimals(),
  ]);
  if (emptyProofIndex !== 0n) throw new Error('Native verifier returned an invalid empty-proof index');
  if (assetCode === '0x') throw new Error(`Asset has no bytecode at ${config.asset.address}`);
  if (Number(decimals) !== config.asset.decimals) {
    throw new Error(`Asset decimals mismatch: expected ${config.asset.decimals}, got ${decimals}`);
  }

  for (const requirement of config.requirements.nativeBalances) {
    const balance = await provider.getBalance(requirement.address);
    if (balance < requirement.minimumWei) {
      throw new Error(`Insufficient native balance for ${requirement.role}`);
    }
  }
  for (const requirement of config.requirements.assetBalances) {
    const balance = await asset.balanceOf(requirement.address);
    if (balance < requirement.minimumBaseUnits) {
      throw new Error(`Insufficient asset balance for ${requirement.role}`);
    }
  }
  for (const requirement of config.requirements.assetAllowances) {
    const allowance = await asset.allowance(requirement.owner, requirement.spender);
    if (allowance < requirement.minimumBaseUnits) {
      throw new Error(`Insufficient asset allowance for ${requirement.ownerRole}`);
    }
  }

  return {
    chainId: config.chainId,
    deployer,
    verifierPrecompileResponsive: true,
    assetCodePresent: true,
    checkedNativeBalances: config.requirements.nativeBalances.length,
    checkedAssetBalances: config.requirements.assetBalances.length,
    checkedAssetAllowances: config.requirements.assetAllowances.length,
    checkedArtifacts: CORE_CONTRACT_NAMES.length,
  };
}

function sameAddress(actual, expected, label) {
  if (getAddress(actual) !== getAddress(expected)) throw new Error(`${label} mismatch`);
}

export async function verifyV3Deployment({ provider, signerAddress, config, artifacts, addresses }) {
  const contracts = Object.fromEntries(
    CORE_CONTRACT_NAMES.map((name) => [name, new Contract(addresses[name], artifacts[name].abi, provider)]),
  );
  const creditState = await contracts.PolicyKernelV2.creditState();
  const codeAddresses = [...Object.values(addresses), creditState];
  const code = await Promise.all(codeAddresses.map((address) => provider.getCode(address)));
  if (code.some((value) => value === '0x')) throw new Error('A V3 core deployment has no bytecode');

  sameAddress(await contracts.PolicyKernelV2.verifier(), config.verifier, 'Kernel verifier');
  sameAddress(await contracts.PolicyKernelV2.owner(), signerAddress, 'Kernel owner');
  sameAddress(await contracts.PolicyKernelV2.proofJobs(), addresses.ProofJobsV1, 'Kernel ProofJobs');
  if ((await contracts.PolicyKernelV2.safeStaleProofRelease()) !== true) {
    throw new Error('Kernel stale-proof release safety is disabled');
  }
  sameAddress(await contracts.CappedPilotFactoryV1.asset(), config.asset.address, 'Factory asset');
  sameAddress(await contracts.CappedPilotFactoryV1.kernel(), addresses.PolicyKernelV2, 'Factory kernel');
  sameAddress(await contracts.CappedPilotFactoryV1.lender(), config.roles.lender, 'Factory lender');
  sameAddress(await contracts.CappedPilotFactoryV1.borrower(), config.roles.borrower, 'Factory borrower');
  sameAddress(await contracts.CappedPilotFactoryV1.guardian(), config.roles.guardian, 'Factory guardian');
  if ((await contracts.CappedPilotFactoryV1.maximumFacilityLimit()) !== config.pilotBounds.maximumFacilityLimit) {
    throw new Error('Factory maximumFacilityLimit mismatch');
  }
  if ((await contracts.CappedPilotFactoryV1.maximumTotalLimit()) !== config.pilotBounds.maximumTotalLimit) {
    throw new Error('Factory maximumTotalLimit mismatch');
  }
  if (Number(await contracts.CappedPilotFactoryV1.minimumBondBps()) !== config.pilotBounds.minimumBondBps) {
    throw new Error('Factory minimumBondBps mismatch');
  }
  if (Number(await contracts.CappedPilotFactoryV1.maximumDrawFeeBps()) !== config.pilotBounds.maximumDrawFeeBps) {
    throw new Error('Factory maximumDrawFeeBps mismatch');
  }
  if (Number(await contracts.CappedPilotFactoryV1.maximumMaturityBlocks()) !== config.pilotBounds.maximumMaturityBlocks) {
    throw new Error('Factory maximumMaturityBlocks mismatch');
  }
  if (Number(await contracts.CappedPilotFactoryV1.maximumDrawDelayBlocks()) !== config.pilotBounds.maximumDrawDelayBlocks) {
    throw new Error('Factory maximumDrawDelayBlocks mismatch');
  }
  if (Number(await contracts.CappedPilotFactoryV1.maximumFacilityCount()) !== config.pilotBounds.maximumFacilityCount) {
    throw new Error('Factory maximumFacilityCount mismatch');
  }
  if ((await contracts.CappedPilotFactoryV1.facilityCount()) !== 0n) throw new Error('Factory is not empty');
  if ((await contracts.CappedPilotFactoryV1.totalFacilityLimit()) !== 0n) throw new Error('Factory limit is not empty');
  if ((await contracts.CappedPilotFactoryV1.creationPaused()) !== false) throw new Error('Factory creation is paused');
  sameAddress(await contracts.MultiChainEventPolicyV1.context(), addresses.PolicyKernelV2, 'Policy context');
  sameAddress(await contracts.ProofJobsV1.kernel(), addresses.PolicyKernelV2, 'ProofJobs kernel');
  return { creditState: getAddress(creditState) };
}

export function reserveV3Manifest(path) {
  const lockPath = `${path}.lock`;
  const temporaryPath = `${path}.tmp`;
  try {
    writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`V3 deployment lock already exists: ${lockPath}`);
    throw error;
  }

  try {
    if (existsSync(path)) throw new Error(`V3 deployment manifest already exists: ${path}`);
    if (existsSync(temporaryPath)) {
      throw new Error(`V3 temporary manifest already exists: ${temporaryPath}`);
    }
  } catch (error) {
    unlinkSync(lockPath);
    throw error;
  }

  let released = false;
  return () => {
    if (released) return;
    unlinkSync(lockPath);
    released = true;
  };
}

export function atomicWriteJson(path, value) {
  const temporaryPath = `${path}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    renameSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}
