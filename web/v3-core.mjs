const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const ZERO_HASH = `0x${"00".repeat(32)}`;
const ACTIVATED_STATUSES = new Set([1, 2, 3, 5]);

export const DeploymentTruth = Object.freeze({
  Deployed: "deployed",
  Empty: "empty",
  Configured: "configured",
  Activated: "activated",
  SourceOnly: "source-only",
  ExternalGated: "external-gated",
  Unavailable: "unavailable",
});

const EXTERNAL_GATES = Object.freeze([
  "Independent security review",
  "Named pilot counterparties",
  "Legal and compliance sign-off",
  "Asset custody and servicing",
  "Provisioned proof operators",
  "Qualified multi-chain evidence transport",
]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

function safeCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

function address(value, label) {
  if (typeof value !== "string" || !ADDRESS.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

function bytes32(value, label) {
  if (typeof value !== "string" || !BYTES32.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value.toLowerCase();
}

function amount(value, label) {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error();
    return parsed;
  } catch {
    throw new TypeError(`Invalid ${label}`);
  }
}

function normalizedAddress(value, label) {
  return address(value, label).toLowerCase();
}

export async function anchorV3Snapshot(
  provider,
  expectedChainId,
  blockNumber,
  readPinned,
) {
  if (
    !provider ||
    typeof provider.send !== "function" ||
    typeof provider.getBlock !== "function"
  ) {
    throw new TypeError("Invalid V3 provider");
  }
  safeCount(expectedChainId, "expectedChainId");
  safeCount(blockNumber, "blockNumber");
  if (typeof readPinned !== "function") {
    throw new TypeError("Invalid V3 pinned reader");
  }
  const actualChainId = Number(BigInt(await provider.send("eth_chainId", [])));
  if (actualChainId !== expectedChainId) {
    throw new RangeError(
      `RPC chain ID ${actualChainId} does not match ${expectedChainId}`,
    );
  }
  const initial = await provider.getBlock(blockNumber);
  if (!initial || Number(initial.number) !== blockNumber) {
    throw new TypeError(`V3 anchor block ${blockNumber} is unavailable`);
  }
  const initialHash = bytes32(initial.hash, "V3 anchor block hash");
  const blockTimestamp = safeCount(
    Number(initial.timestamp),
    "V3 anchor block timestamp",
  );
  const value = await readPinned(blockNumber, {
    chainId: actualChainId,
    blockNumber,
    blockHash: initialHash,
    blockTimestamp,
  });
  const final = await provider.getBlock(blockNumber);
  if (
    !final ||
    Number(final.number) !== blockNumber ||
    bytes32(final.hash, "V3 final block hash") !== initialHash
  ) {
    throw new Error(`Block ${blockNumber} changed during the V3 read`);
  }
  return {
    anchor: {
      chainId: actualChainId,
      blockNumber,
      blockHash: initialHash,
      blockTimestamp,
    },
    value,
  };
}

function summarizeFacility(value, index) {
  const facility = object(value, `facilities[${index}]`);
  const status = safeCount(facility.status, `facilities[${index}].status`);
  if (status > 5) throw new TypeError(`Invalid facilities[${index}].status`);
  const policyCount = safeCount(
    facility.policyCount,
    `facilities[${index}].policyCount`,
  );
  const configuredPolicies = safeCount(
    facility.multiChainPoliciesConfigured,
    `facilities[${index}].multiChainPoliciesConfigured`,
  );
  if (configuredPolicies > policyCount) {
    throw new TypeError(`Inconsistent facilities[${index}] policy counts`);
  }
  const commitment = bytes32(
    facility.policySetCommitment,
    `facilities[${index}].policySetCommitment`,
  );
  const configured =
    policyCount > 0 && configuredPolicies > 0 && commitment !== ZERO_HASH;
  const activated = configured && ACTIVATED_STATUSES.has(status);
  return {
    address: address(facility.address, `facilities[${index}].address`),
    status,
    policyCount,
    configuredPolicies,
    policySetCommitment: commitment,
    configured,
    activated,
    truth: activated
      ? DeploymentTruth.Activated
      : configured
        ? DeploymentTruth.Configured
        : DeploymentTruth.Deployed,
  };
}

export function summarizeV3Snapshot(value) {
  const snapshot = object(value, "V3 snapshot");
  const anchor = object(snapshot.anchor, "anchor");
  const chainId = safeCount(anchor.chainId, "anchor.chainId");
  const blockNumber = safeCount(anchor.blockNumber, "anchor.blockNumber");
  const blockTimestamp = safeCount(
    anchor.blockTimestamp,
    "anchor.blockTimestamp",
  );
  const blockHash = bytes32(anchor.blockHash, "anchor.blockHash");
  if (!Array.isArray(snapshot.contracts) || snapshot.contracts.length === 0) {
    throw new TypeError("Invalid contracts");
  }
  const contracts = snapshot.contracts.map((entry, index) => {
    const contract = object(entry, `contracts[${index}]`);
    if (typeof contract.name !== "string" || contract.name.length === 0) {
      throw new TypeError(`Invalid contracts[${index}].name`);
    }
    if (typeof contract.hasCode !== "boolean") {
      throw new TypeError(`Invalid contracts[${index}].hasCode`);
    }
    return {
      name: contract.name,
      address: address(contract.address, `contracts[${index}].address`),
      hasCode: contract.hasCode,
      truth: contract.hasCode
        ? DeploymentTruth.Deployed
        : DeploymentTruth.Unavailable,
    };
  });
  const contractNames = new Set(contracts.map(({ name }) => name));
  if (contractNames.size !== contracts.length) {
    throw new TypeError("Duplicate contract names");
  }

  const kernel = object(snapshot.kernel, "kernel");
  const proofJobs = normalizedAddress(kernel.proofJobs, "kernel.proofJobs");
  const expectedProofJobs = normalizedAddress(
    kernel.expectedProofJobs,
    "kernel.expectedProofJobs",
  );
  if (typeof kernel.safeStaleProofRelease !== "boolean") {
    throw new TypeError("Invalid kernel.safeStaleProofRelease");
  }
  const coreDeployment =
    contracts.every(({ hasCode }) => hasCode) &&
    proofJobs === expectedProofJobs &&
    kernel.safeStaleProofRelease
      ? DeploymentTruth.Deployed
      : DeploymentTruth.Unavailable;

  const factory = object(snapshot.factory, "factory");
  const facilityCount = safeCount(
    factory.facilityCount,
    "factory.facilityCount",
  );
  const maximumFacilityCount = safeCount(
    factory.maximumFacilityCount,
    "factory.maximumFacilityCount",
  );
  if (facilityCount > maximumFacilityCount) {
    throw new TypeError("Factory count exceeds its configured cap");
  }
  if (typeof factory.creationPaused !== "boolean") {
    throw new TypeError("Invalid factory.creationPaused");
  }
  const totalFacilityLimit = amount(
    factory.totalFacilityLimit,
    "factory.totalFacilityLimit",
  );
  const maximumTotalLimit = amount(
    factory.maximumTotalLimit,
    "factory.maximumTotalLimit",
  );
  if (totalFacilityLimit > maximumTotalLimit) {
    throw new TypeError("Factory total exceeds its configured cap");
  }
  if (!Array.isArray(snapshot.facilities)) {
    throw new TypeError("Invalid facilities");
  }
  if (snapshot.facilities.length !== facilityCount) {
    throw new TypeError("Incomplete facility inventory");
  }
  const facilities = snapshot.facilities.map(summarizeFacility);
  const configuredFacilities = facilities.filter(
    ({ configured }) => configured,
  ).length;
  const activatedFacilities = facilities.filter(
    ({ activated }) => activated,
  ).length;
  const factoryState =
    facilityCount === 0
      ? DeploymentTruth.Empty
      : activatedFacilities > 0
        ? DeploymentTruth.Activated
        : configuredFacilities > 0
          ? DeploymentTruth.Configured
          : DeploymentTruth.Deployed;

  const registryReleaseCount = safeCount(
    snapshot.registryReleaseCount,
    "registryReleaseCount",
  );
  const nextProofJobId = amount(snapshot.nextProofJobId, "nextProofJobId");
  if (nextProofJobId === 0n) {
    throw new TypeError("Invalid nextProofJobId");
  }
  if (!Array.isArray(snapshot.localCapabilities)) {
    throw new TypeError("Invalid localCapabilities");
  }
  const localCapabilities = snapshot.localCapabilities.map((entry, index) => {
    const capability = object(entry, `localCapabilities[${index}]`);
    if (typeof capability.name !== "string" || capability.name.length === 0) {
      throw new TypeError(`Invalid localCapabilities[${index}].name`);
    }
    if (capability.deploymentAddress === null) {
      return {
        name: capability.name,
        deploymentAddress: null,
        truth: DeploymentTruth.SourceOnly,
      };
    }
    return {
      name: capability.name,
      deploymentAddress: address(
        capability.deploymentAddress,
        `localCapabilities[${index}].deploymentAddress`,
      ),
      truth:
        capability.hasCode === true
          ? DeploymentTruth.Deployed
          : DeploymentTruth.Unavailable,
    };
  });

  return {
    anchor: { chainId, blockNumber, blockHash, blockTimestamp },
    contracts,
    coreDeployment,
    factoryState,
    facilityCount,
    maximumFacilityCount,
    totalFacilityLimit,
    maximumTotalLimit,
    creationPaused: factory.creationPaused,
    facilities,
    configuredFacilities,
    activatedFacilities,
    registryReleaseCount,
    registryState:
      registryReleaseCount === 0
        ? DeploymentTruth.Empty
        : DeploymentTruth.Deployed,
    proofJobCount: nextProofJobId - 1n,
    proofJobState:
      nextProofJobId === 1n ? DeploymentTruth.Empty : DeploymentTruth.Deployed,
    localCapabilities,
    externalGates: EXTERNAL_GATES.map((name) => ({
      name,
      truth: DeploymentTruth.ExternalGated,
    })),
  };
}
