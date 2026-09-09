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
  Inconsistent: "inconsistent",
});

export const EXTENSION_DEPLOYMENT = Object.freeze({
  contracts: Object.freeze({
    OperatorServiceVerifierV1: "0x44B3e639722650902a11EB26151cBaB039f67a23",
    OperatorMarketV1: "0x649A73302861fcDf641Aa4cBe5e7eD58d0363337",
    PortfolioPoolV1: "0x7dd538A9ab77a4d2953b28f3bCe710145a0eC8C2",
    CappedPilotFactoryV1: "0xA5997C4c212eE27B774a7dBa1E5081a9355A16c0",
    PortfolioMandateV1: "0x49306adA3decC50D08D11B403A120cd6FD5501D3",
  }),
  deploymentBlocks: Object.freeze({
    OperatorServiceVerifierV1: 5459750,
    OperatorMarketV1: 5459763,
    PortfolioPoolV1: 5459775,
    CappedPilotFactoryV1: 5459784,
    PortfolioMandateV1: 5459793,
  }),
  attestor: "0xeCf1BeeF05450f1E2A2adAb86b61ccC2D6235369",
  token: "0x3c6eF93E1d2C539c5EFefbBc51cc6a1E120fBf77",
  activatedReleaseId:
    "0xad31a01779b7c8c8651e1fecbb15b6d177c25dbd637c99d7496c2c2a0b7d221a",
});

const EXTENSION_READS = Object.freeze({
  verifier: {
    name: "OperatorServiceVerifierV1",
    fields: { attestor: "address" },
  },
  market: {
    name: "OperatorMarketV1",
    fields: {
      verifier: "address",
      token: "address",
      minimumOperatorBond: "uint256",
      quoteCount: "uint256",
    },
  },
  pool: {
    name: "PortfolioPoolV1",
    fields: {
      status: "uint8",
      mandate: "address",
      asset: "address",
      createdFacilityCount: "uint256",
      maximumPoolAssets: "uint256",
      fundingDeadline: "uint64",
      investorCount: "uint256",
      allocatedFacilityCount: "uint256",
      totalDeposited: "uint256",
      totalAllocatedPrincipal: "uint256",
    },
  },
  mandate: {
    name: "PortfolioMandateV1",
    fields: {
      requiredActionAdapterKind: "bytes32",
      requiredReleaseId: "bytes32",
      requiredPolicySetCommitment: "bytes32",
      requiredEvidenceKind: "uint8",
      factory: "address",
    },
  },
  factory: {
    name: "CappedPilotFactoryV1",
    fields: { lender: "address", facilityCount: "uint256" },
  },
});

export async function readV3Extensions(provider, Contract, blockTag) {
  safeCount(blockTag, "extension blockTag");
  const entries = await Promise.all(
    Object.entries(EXTENSION_READS).map(async ([key, { name, fields }]) => {
      const address = EXTENSION_DEPLOYMENT.contracts[name];
      let hasCode = false;
      try {
        hasCode = (await provider.getCode(address, blockTag)) !== "0x";
        if (!hasCode)
          return {
            key,
            contract: { name, address, hasCode },
            value: null,
            error: `${name}: no runtime code`,
          };
        const contract = new Contract(
          address,
          Object.entries(fields).map(
            ([field, type]) => `function ${field}() view returns (${type})`,
          ),
          provider,
        );
        const values = await Promise.all(
          Object.keys(fields).map(async (field) => [
            field,
            await contract[field]({ blockTag }),
          ]),
        );
        const value = Object.fromEntries(values);
        if (key === "pool") {
          value.facilityCount = value.createdFacilityCount;
          delete value.createdFacilityCount;
          const token = new Contract(
            value.asset,
            ["function balanceOf(address account) view returns (uint256)"],
            provider,
          );
          value.assetBalance = await token.balanceOf(address, { blockTag });
        }
        return { key, contract: { name, address, hasCode }, value };
      } catch (error) {
        return {
          key,
          contract: { name, address, hasCode },
          value: null,
          error: `${name}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }),
  );
  return {
    contracts: entries.map((entry) => entry.contract),
    ...Object.fromEntries(entries.map((entry) => [entry.key, entry.value])),
    errors: entries.filter((entry) => entry.error).map((entry) => entry.error),
  };
}

export function summarizeV3Extensions(value) {
  const unavailable = (issues) => ({
    ...value,
    truth: DeploymentTruth.Unavailable,
    issues,
    poolStatement: "Pool state unavailable",
    marketStatement: "Market state unavailable",
    mandateStatement: "Mandate state unavailable",
  });
  if (!value || !Array.isArray(value.contracts))
    return unavailable(["Extension snapshot unavailable"]);
  if (value.errors?.length) return unavailable(value.errors);
  const missing = Object.entries(EXTENSION_READS).filter(
    ([key, { name }]) =>
      !value[key] ||
      !value.contracts.some((entry) => entry.name === name && entry.hasCode),
  );
  if (missing.length)
    return unavailable(
      missing.map(
        ([, { name }]) => `${name}: state or runtime code unavailable`,
      ),
    );
  try {
    const { verifier, market, pool, mandate, factory } = value;
    const pinned = EXTENSION_DEPLOYMENT;
    const issues = [];
    for (const [label, actual, expected] of [
      [
        "market.verifier",
        market.verifier,
        pinned.contracts.OperatorServiceVerifierV1,
      ],
      ["pool.mandate", pool.mandate, pinned.contracts.PortfolioMandateV1],
      [
        "mandate.factory",
        mandate.factory,
        pinned.contracts.CappedPilotFactoryV1,
      ],
      ["factory.lender", factory.lender, pinned.contracts.PortfolioPoolV1],
      ["verifier.attestor", verifier.attestor, pinned.attestor],
      ["market.token", market.token, pinned.token],
      ["pool.asset", pool.asset, pinned.token],
    ]) {
      if (normalizedAddress(actual, label) !== expected.toLowerCase())
        issues.push(`${label} does not match the manifest`);
    }
    for (const entry of value.contracts) {
      if (
        normalizedAddress(entry.address, entry.name) !==
        pinned.contracts[entry.name]?.toLowerCase()
      )
        issues.push(`${entry.name} address does not match the manifest`);
    }
    if (
      bytes32(mandate.requiredReleaseId, "requiredReleaseId") !==
      pinned.activatedReleaseId
    )
      issues.push(
        "mandate.requiredReleaseId does not match the activated release",
      );
    bytes32(mandate.requiredPolicySetCommitment, "requiredPolicySetCommitment");
    const adapterKind = bytes32(
      mandate.requiredActionAdapterKind,
      "requiredActionAdapterKind",
    );
    const quoteCount = amount(market.quoteCount, "quoteCount");
    const status = safeCount(Number(pool.status), "pool.status");
    if (status > 4) throw new TypeError("Invalid pool.status");
    const facilityCount = amount(pool.facilityCount, "pool.facilityCount");
    if (
      facilityCount !== amount(factory.facilityCount, "factory.facilityCount")
    )
      issues.push("Pool and factory facility counts differ");
    const emptyPool =
      status === 0 &&
      facilityCount === 0n &&
      amount(pool.totalDeposited, "totalDeposited") === 0n &&
      amount(pool.totalAllocatedPrincipal, "totalAllocatedPrincipal") === 0n &&
      amount(pool.assetBalance, "assetBalance") === 0n &&
      amount(pool.allocatedFacilityCount, "allocatedFacilityCount") === 0n;
    return {
      ...value,
      truth: issues.length
        ? DeploymentTruth.Inconsistent
        : DeploymentTruth.Deployed,
      issues,
      poolStatement: issues.length
        ? "Pool deployment inconsistent"
        : emptyPool
          ? "Deployed · Configuring · no facilities, no capital, no allocation"
          : `Deployed · ${["Configuring", "Funding", "Active", "Finalized", "Cancelled"][status]} · ${facilityCount} facilities · ${pool.totalDeposited} raw units deposited · ${pool.totalAllocatedPrincipal} raw units allocated`,
      marketStatement: issues.length
        ? "Market deployment inconsistent"
        : quoteCount === 0n
          ? "Deployed · empty · single project-operated attestor"
          : `Deployed · ${quoteCount} quotes · single project-operated attestor`,
      mandateStatement: issues.length
        ? "Mandate deployment inconsistent"
        : adapterKind === ZERO_HASH
          ? "No action adapter required by this mandate"
          : `Required action adapter kind: ${adapterKind}`,
    };
  } catch (error) {
    return unavailable([
      error instanceof Error ? error.message : String(error),
    ]);
  }
}

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
  const registeredPolicies = safeCount(
    facility.registeredPolicies,
    `facilities[${index}].registeredPolicies`,
  );
  const appliedEffects = safeCount(
    facility.appliedEffects,
    `facilities[${index}].appliedEffects`,
  );
  const configuredPolicies = safeCount(
    facility.multiChainPoliciesConfigured,
    `facilities[${index}].multiChainPoliciesConfigured`,
  );
  if (configuredPolicies > registeredPolicies) {
    throw new TypeError(`Inconsistent facilities[${index}] policy counts`);
  }
  const commitment = bytes32(
    facility.policySetCommitment,
    `facilities[${index}].policySetCommitment`,
  );
  const configured =
    registeredPolicies > 0 &&
    configuredPolicies > 0 &&
    commitment !== ZERO_HASH;
  const activated = configured && ACTIVATED_STATUSES.has(status);
  return {
    address: address(facility.address, `facilities[${index}].address`),
    status,
    registeredPolicies,
    appliedEffects,
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
    extensions: summarizeV3Extensions(snapshot.extensions),
    externalGates: EXTERNAL_GATES.map((name) => ({
      name,
      truth: DeploymentTruth.ExternalGated,
    })),
  };
}
