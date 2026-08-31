import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ContractFactory,
  Interface,
  Transaction,
  Wallet,
  ZeroAddress,
  getAddress,
  getCreateAddress,
  keccak256,
} from "ethers";
import {
  buildV3ExtensionDeploymentPlan,
  buildV3ExtensionLiveExecutionPlan,
  completeV3ExtensionJournal,
  createV3ExtensionApproval,
  initializeV3ExtensionJournal,
  parseV3ExtensionArguments,
  prepareV3ExtensionStep,
  qualifyV3ExtensionDeployment,
  readV3ExtensionArtifacts,
  readV3ExtensionInputs,
  reconcileV3ExtensionStep,
  validateV3ExtensionApproval,
  validateV3ExtensionConfig,
  validateV3ExtensionManifest,
  verifyV3ExtensionApprovalAnchor,
  verifyV3ExtensionTransactions,
} from "../scripts/lib/v3-extension-deployment.mjs";

const ADDRESS = (suffix) =>
  getAddress(`0x${"0".repeat(40 - suffix.length)}${suffix}`);
const HASH = (nibble) => `0x${nibble.repeat(64)}`;
const SHA256 = (value) => createHash("sha256").update(value).digest("hex");
const CHAIN_ID = 102031;
const STARTING_NONCE = 7;
const ASSET = ADDRESS("a1");
const POLICY_KERNEL = ADDRESS("b1");
const POLICY_REGISTRY = ADDRESS("b2");
const REMEDY_COORDINATOR = ADDRESS("c1");
const REMEDY_TRANSPORT = ADDRESS("c2");
const OPERATOR_VERIFIER = ADDRESS("d1");
const MANAGER = ADDRESS("e1");
const BORROWER = ADDRESS("e2");
const GUARDIAN = ADDRESS("e3");
const PREREQUISITE_CODE = {
  asset: "0x60006000526001601ff3",
  policyKernel: "0x60016000526001601ff3",
  policyRegistry: "0x60026000526001601ff3",
  remedyCoordinator: "0x60036000526001601ff3",
  remedyTransport: "0x60046000526001601ff3",
  operatorVerifier: "0x60056000526001601ff3",
};

const GENERATIONS = [
  "v3-closed-loop-v1",
  "v3-operator-market-v1",
  "v3-portfolio-core-v1",
];

const ARTIFACT_NAMES = {
  "v3-closed-loop-v1": ["ClosedLoopPolicyV1"],
  "v3-operator-market-v1": ["OperatorMarketV1"],
  "v3-portfolio-core-v1": [
    "PortfolioPoolV1",
    "CappedPilotFactoryV1",
    "PortfolioMandateV1",
  ],
};

const CONSTRUCTOR_TYPES = {
  ClosedLoopPolicyV1: ["address", "address"],
  OperatorMarketV1: ["address", "address", "uint256", "uint64", "uint64"],
  PortfolioPoolV1: [
    "address",
    "address",
    "uint256",
    "uint256",
    "uint64",
    "uint16",
    "uint64",
    "uint64",
  ],
  CappedPilotFactoryV1: [
    "address",
    "address",
    "address",
    "address",
    "address",
    "uint256",
    "uint256",
    "uint16",
    "uint16",
    "uint64",
    "uint32",
    "uint16",
  ],
  PortfolioMandateV1: [
    "address",
    "address",
    "address",
    "address",
    "bytes32",
    "bytes32",
    "uint8",
    "bytes32",
    "uint256",
    "uint16",
    "uint16",
    "uint64",
  ],
};

const IMMUTABLE_COUNTS = {
  ClosedLoopPolicyV1: 2,
  OperatorMarketV1: 5,
  PortfolioPoolV1: 9,
  CappedPilotFactoryV1: 12,
  PortfolioMandateV1: 12,
};

const POLICY_REGISTRY_READ_ABI = [
  "function packageRelease(bytes32 releaseId) view returns ((address issuer,string packageName,string version,address referenceImplementation,bytes32 buildArtifactHash,bytes32 referenceRuntimeCodeHash,bytes32 referenceVariantId,bytes32 metadataHash,bytes32 releaseContentHash,uint64 releasedAt,bool exists))",
  "function declaresEvidenceKind(bytes32 releaseId,uint8 evidenceKind) view returns (bool)",
  "function actionAdapterCount(bytes32 releaseId) view returns (uint256)",
  "function actionAdapterAt(bytes32 releaseId,uint256 index) view returns ((bytes32 adapterKind,bytes32 specificationHash,string metadataURI))",
];

function artifact(name) {
  const index = Object.keys(CONSTRUCTOR_TYPES).indexOf(name) + 1;
  let deployedObject = `60${index.toString(16).padStart(2, "0")}`;
  const immutableReferences = {};
  for (
    let immutableIndex = 0;
    immutableIndex < IMMUTABLE_COUNTS[name];
    immutableIndex += 1
  ) {
    immutableReferences[immutableIndex + 1] = [
      { start: deployedObject.length / 2, length: 32 },
    ];
    deployedObject += "00".repeat(32);
  }
  deployedObject += "6000f3";
  return {
    abi: [
      {
        type: "constructor",
        stateMutability: "nonpayable",
        inputs: CONSTRUCTOR_TYPES[name].map((type, inputIndex) => ({
          name: `value${inputIndex}`,
          type,
        })),
      },
      ...(name === "PortfolioPoolV1"
        ? [
            {
              type: "function",
              name: "setMandate",
              stateMutability: "nonpayable",
              inputs: [{ name: "mandate_", type: "address" }],
              outputs: [],
            },
          ]
        : []),
    ],
    bytecode: {
      object: `0x60${index.toString(16).padStart(2, "0")}6000f3`,
    },
    deployedBytecode: {
      object: `0x${deployedObject}`,
      immutableReferences,
      linkReferences: {},
    },
  };
}

function manifestBytes(manifest) {
  return `${JSON.stringify(manifest)}\n`;
}

function prerequisiteManifests() {
  return {
    core: {
      schemaVersion: 2,
      generation: "v3-core",
      status: "deployed-qualified",
      chainId: CHAIN_ID,
      asset: { address: ASSET, decimals: 6 },
      contracts: {
        policyKernel: POLICY_KERNEL,
        policyRegistry: POLICY_REGISTRY,
        cappedPilotFactory: ADDRESS("b3"),
        multiChainEventPolicy: ADDRESS("b4"),
        proofJobs: ADDRESS("b5"),
        verifiedCreditState: ADDRESS("b6"),
      },
      runtimeCodeHashes: {
        PolicyKernelV2: keccak256(PREREQUISITE_CODE.policyKernel),
        PolicyRegistryV1: keccak256(PREREQUISITE_CODE.policyRegistry),
      },
    },
    remedy: {
      schemaVersion: 1,
      generation: "usc-remedy-v1",
      status: "deployed-dedicated-inbox-route",
      sourceChainId: CHAIN_ID,
      contracts: {
        coordinator: REMEDY_COORDINATOR,
        transport: REMEDY_TRANSPORT,
      },
      routeQualification: {
        runtimeCodeHashes: {
          coordinator: keccak256(PREREQUISITE_CODE.remedyCoordinator),
          transport: keccak256(PREREQUISITE_CODE.remedyTransport),
        },
      },
    },
    verifier: {
      schemaVersion: 1,
      generation: "operator-service-verifier-v1",
      status: "deployed-qualified",
      chainId: CHAIN_ID,
      contract: {
        address: OPERATOR_VERIFIER,
        runtimeCodeKeccak256: keccak256(PREREQUISITE_CODE.operatorVerifier),
      },
    },
  };
}

function relevantManifests(generation, manifests = prerequisiteManifests()) {
  if (generation === "v3-closed-loop-v1") {
    return { core: manifests.core, remedy: manifests.remedy };
  }
  if (generation === "v3-operator-market-v1") {
    return { verifier: manifests.verifier };
  }
  return { core: manifests.core };
}

function prerequisiteReference(name, manifest) {
  return {
    path: `${name}.json`,
    sha256: SHA256(manifestBytes(manifest)),
  };
}

function rawConfig(generation, deployer = ADDRESS("f1")) {
  const manifests = prerequisiteManifests();
  const common = {
    schemaVersion: 1,
    generation,
    chainId: CHAIN_ID,
    deployer,
    rpcUrlEnvironment: "RECOURSE_CC3_RPC_URL",
    privateKeyEnvironment: "RECOURSE_V3_EXTENSION_PRIVATE_KEY",
    expectedStartingNonce: STARTING_NONCE,
    artifacts: Object.fromEntries(
      (ARTIFACT_NAMES[generation] ?? []).map((name, index) => [
        name,
        {
          path: `artifacts/${name}.json`,
          keccak256: HASH((index + 1).toString(16)),
        },
      ]),
    ),
    transactionPolicy: {
      targetConfirmations: 2,
      maximumReceiptPolls: 4,
      feePolicy: {
        transactionType: "eip1559",
        maximumGasLimit: "500000",
        maximumFeePerGas: "100",
        maximumPriorityFeePerGas: "10",
        maximumTotalFeeWei: "50000000",
      },
    },
    requirements: { minimumNativeWei: "1000000" },
  };
  if (generation === "v3-closed-loop-v1") {
    return {
      ...common,
      prerequisites: {
        core: prerequisiteReference("core", manifests.core),
        remedy: prerequisiteReference("remedy", manifests.remedy),
      },
      closedLoop: {
        context: POLICY_KERNEL,
        coordinator: REMEDY_COORDINATOR,
      },
    };
  }
  if (generation === "v3-operator-market-v1") {
    return {
      ...common,
      prerequisites: {
        verifier: prerequisiteReference("verifier", manifests.verifier),
      },
      asset: {
        address: ASSET,
        decimals: 6,
        runtimeCodeKeccak256: keccak256(PREREQUISITE_CODE.asset),
      },
      operatorMarket: {
        token: ASSET,
        verifier: OPERATOR_VERIFIER,
        minimumOperatorBond: "1000000",
        maximumQuoteDuration: 86400,
        maximumServiceDuration: 172800,
      },
    };
  }
  return {
    ...common,
    prerequisites: {
      core: prerequisiteReference("core", manifests.core),
    },
    asset: {
      address: ASSET,
      decimals: 6,
      runtimeCodeKeccak256: keccak256(PREREQUISITE_CODE.asset),
    },
    roles: { manager: deployer, borrower: BORROWER, guardian: GUARDIAN },
    portfolio: {
      pool: {
        maximumPoolAssets: "1000000000",
        maximumServiceBudget: "10000000",
        maximumServiceJobDuration: 86400,
        maximumFacilityCount: 3,
        fundingDeadline: 4000000000,
        recoveryDelayBlocks: 100,
      },
      factory: {
        maximumFacilityLimit: "300000000",
        maximumTotalLimit: "900000000",
        minimumBondBps: 2000,
        maximumDrawFeeBps: 400,
        maximumMaturityBlocks: 100000,
        maximumDrawDelayBlocks: 50,
        maximumFacilityCount: 3,
      },
      mandate: {
        requiredReleaseId: HASH("a"),
        requiredPolicySetCommitment: HASH("b"),
        requiredEvidenceKind: 1,
        requiredActionAdapterKind: HASH("c"),
        maximumFacilityLimit: "300000000",
        minimumBondBps: 2000,
        maximumDrawFeeBps: 400,
        maximumRemainingMaturityBlocks: 90000,
      },
      safety: { minimumFundingWindowSeconds: 86400 },
    },
  };
}

function normalizedConfig(generation, deployer) {
  return validateV3ExtensionConfig(
    rawConfig(generation, deployer),
    relevantManifests(generation),
  );
}

function loadedArtifacts(config) {
  return Object.fromEntries(
    ARTIFACT_NAMES[config.generation].map((name) => [
      name,
      { artifact: artifact(name), hash: config.artifacts[name].keccak256 },
    ]),
  );
}

async function deploymentPlan(generation, deployer) {
  const config = normalizedConfig(generation, deployer);
  const artifacts = loadedArtifacts(config);
  const plan = await buildV3ExtensionDeploymentPlan({ config, artifacts });
  return { config, artifacts, plan };
}

function policyRegistryContractFactory(
  config,
  plan,
  state,
  calls = [],
  overrides = {},
) {
  const base = contractFactory(config, plan, overrides);
  const expected = new Interface(POLICY_REGISTRY_READ_ABI);
  const option = { blockTag: 500 };
  const release = config.portfolio.mandate.requiredReleaseId;
  const record = (name, args) => {
    calls.push({ name, args });
  };
  const registry = {
    packageRelease: async (...args) => {
      record("packageRelease", args);
      return {
        issuer: ADDRESS("771"),
        packageName: "recourse-portfolio-policy",
        version: "1.0.0",
        referenceImplementation: ADDRESS("772"),
        buildArtifactHash: HASH("1"),
        referenceRuntimeCodeHash: HASH("2"),
        referenceVariantId: HASH("3"),
        metadataHash: HASH("4"),
        releaseContentHash: HASH("5"),
        releasedAt: 900n,
        exists: state.releaseExists !== false,
      };
    },
    declaresEvidenceKind: async (...args) => {
      record("declaresEvidenceKind", args);
      return state.evidenceDeclared !== false;
    },
    actionAdapterCount: async (...args) => {
      record("actionAdapterCount", args);
      return state.adapterPresent === false ? 0n : 1n;
    },
    actionAdapterAt: async (...args) => {
      record("actionAdapterAt", args);
      return {
        adapterKind:
          state.adapterKind ??
          config.portfolio.mandate.requiredActionAdapterKind,
        specificationHash: HASH("6"),
        metadataURI: "ipfs://recourse-portfolio-adapter",
      };
    },
  };
  return (address, abi, runner) => {
    if (getAddress(address) !== POLICY_REGISTRY) {
      return base(address, abi, runner);
    }
    const supplied = new Interface(abi);
    for (const name of [
      "packageRelease",
      "declaresEvidenceKind",
      "actionAdapterCount",
      "actionAdapterAt",
    ]) {
      assert.equal(
        supplied.getFunction(name).selector,
        expected.getFunction(name).selector,
      );
    }
    assert.equal(release, config.portfolio.mandate.requiredReleaseId);
    assert.deepEqual(option, { blockTag: 500 });
    return registry;
  };
}

async function deployData(name, arguments_) {
  const value = artifact(name);
  return (
    await new ContractFactory(
      value.abi,
      value.bytecode.object,
    ).getDeployTransaction(...arguments_)
  ).data;
}

function prerequisiteCode(address) {
  return new Map([
    [ASSET, PREREQUISITE_CODE.asset],
    [POLICY_KERNEL, PREREQUISITE_CODE.policyKernel],
    [POLICY_REGISTRY, PREREQUISITE_CODE.policyRegistry],
    [REMEDY_COORDINATOR, PREREQUISITE_CODE.remedyCoordinator],
    [REMEDY_TRANSPORT, PREREQUISITE_CODE.remedyTransport],
    [OPERATOR_VERIFIER, PREREQUISITE_CODE.operatorVerifier],
  ]).get(getAddress(address));
}

function deploymentProvider({ config, plan, artifacts, deployed = false }) {
  const predictedCode = new Map(
    Object.entries(plan.predictedContracts).map(([name, address]) => [
      address,
      artifacts[name].artifact.deployedBytecode.object,
    ]),
  );
  return {
    getNetwork: async () => ({ chainId: BigInt(CHAIN_ID) }),
    getBlock: async () => ({
      number: deployed ? 600 : 500,
      hash: deployed ? HASH("e") : HASH("d"),
      timestamp: deployed ? 1_100 : 1_000,
    }),
    getTransactionCount: async () =>
      STARTING_NONCE + (deployed ? plan.steps.length : 0),
    getBalance: async () => 10_000_000n,
    getCode: async (address) => {
      const normalized = getAddress(address);
      const dependency = prerequisiteCode(normalized);
      if (dependency) return dependency;
      return deployed ? (predictedCode.get(normalized) ?? "0x") : "0x";
    },
  };
}

function contractFactory(config, plan, overrides = {}) {
  const contracts = new Map();
  if (config.generation === "v3-closed-loop-v1") {
    contracts.set(plan.predictedContracts.ClosedLoopPolicyV1, {
      context: async () => POLICY_KERNEL,
      coordinator: async () => REMEDY_COORDINATOR,
      sourceOrdering: async () => 0n,
    });
  } else if (config.generation === "v3-operator-market-v1") {
    contracts.set(plan.predictedContracts.OperatorMarketV1, {
      token: async () => ASSET,
      verifier: async () => OPERATOR_VERIFIER,
      minimumOperatorBond: async () =>
        config.operatorMarket.minimumOperatorBond,
      maximumQuoteDuration: async () =>
        config.operatorMarket.maximumQuoteDuration,
      maximumServiceDuration: async () =>
        config.operatorMarket.maximumServiceDuration,
      quoteCount: async () => 0n,
    });
  } else {
    const pool = plan.predictedContracts.PortfolioPoolV1;
    const factory = plan.predictedContracts.CappedPilotFactoryV1;
    const mandate = plan.predictedContracts.PortfolioMandateV1;
    contracts.set(pool, {
      asset: async () => ASSET,
      manager: async () => config.roles.manager,
      maximumPoolAssets: async () => config.portfolio.pool.maximumPoolAssets,
      maximumServiceBudget: async () =>
        config.portfolio.pool.maximumServiceBudget,
      maximumServiceJobDuration: async () =>
        config.portfolio.pool.maximumServiceJobDuration,
      maximumFacilityCount: async () =>
        config.portfolio.pool.maximumFacilityCount,
      fundingDeadline: async () => config.portfolio.pool.fundingDeadline,
      recoveryDelayBlocks: async () =>
        config.portfolio.pool.recoveryDelayBlocks,
      mandate: async () => mandate,
      proofJobsVenue: async () => ZeroAddress,
      status: async () => 0n,
      totalDeposited: async () => 0n,
      totalAllocatedPrincipal: async () => 0n,
      totalRecovered: async () => 0n,
      totalRealizedLoss: async () => 0n,
      totalServiceEscrowed: async () => 0n,
      totalServiceRecovered: async () => 0n,
      allocatedFacilityCount: async () => 0n,
      settledFacilityCount: async () => 0n,
      totalDistributed: async () => 0n,
      totalClaimed: async () => 0n,
      totalSupply: async () => 0n,
      createdFacilityCount: async () => 0n,
      candidateCount: async () => 0n,
      investorCount: async () => 0n,
    });
    contracts.set(factory, {
      asset: async () => ASSET,
      kernel: async () => POLICY_KERNEL,
      lender: async () => pool,
      borrower: async () => BORROWER,
      guardian: async () => GUARDIAN,
      maximumFacilityLimit: async () =>
        config.portfolio.factory.maximumFacilityLimit,
      maximumTotalLimit: async () => config.portfolio.factory.maximumTotalLimit,
      minimumBondBps: async () => config.portfolio.factory.minimumBondBps,
      maximumDrawFeeBps: async () => config.portfolio.factory.maximumDrawFeeBps,
      maximumMaturityBlocks: async () =>
        config.portfolio.factory.maximumMaturityBlocks,
      maximumDrawDelayBlocks: async () =>
        config.portfolio.factory.maximumDrawDelayBlocks,
      maximumFacilityCount: async () =>
        config.portfolio.factory.maximumFacilityCount,
      creationPaused: async () => false,
      totalFacilityLimit: async () => 0n,
      facilityCount: async () => 0n,
    });
    contracts.set(mandate, {
      factory: async () => factory,
      registry: async () => POLICY_REGISTRY,
      asset: async () => ASSET,
      kernel: async () => POLICY_KERNEL,
      requiredReleaseId: async () => config.portfolio.mandate.requiredReleaseId,
      requiredPolicySetCommitment: async () =>
        config.portfolio.mandate.requiredPolicySetCommitment,
      requiredEvidenceKind: async () =>
        config.portfolio.mandate.requiredEvidenceKind,
      requiredActionAdapterKind: async () =>
        config.portfolio.mandate.requiredActionAdapterKind,
      maximumFacilityLimit: async () =>
        config.portfolio.mandate.maximumFacilityLimit,
      minimumBondBps: async () => config.portfolio.mandate.minimumBondBps,
      maximumDrawFeeBps: async () => config.portfolio.mandate.maximumDrawFeeBps,
      maximumRemainingMaturityBlocks: async () =>
        config.portfolio.mandate.maximumRemainingMaturityBlocks,
    });
  }
  if (config.asset) {
    contracts.set(config.asset.address, {
      decimals: async () => config.asset.decimals,
      balanceOf: async () => 0n,
    });
  }
  for (const [address, values] of Object.entries(overrides)) {
    contracts.set(getAddress(address), {
      ...(contracts.get(getAddress(address)) ?? {}),
      ...values,
    });
  }
  return (address) => contracts.get(getAddress(address));
}

async function liveFixture(generation = "v3-closed-loop-v1") {
  const wallet = Wallet.createRandom();
  const { config, artifacts, plan } = await deploymentPlan(
    generation,
    wallet.address,
  );
  const signer = {
    getAddress: async () => wallet.address,
    populateTransaction: async (request) => ({
      ...request,
      type: 2,
      gasLimit: 120000n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    }),
    signTransaction: (request) => wallet.signTransaction(request),
  };
  const qualification = await qualifyV3ExtensionDeployment({
    provider: deploymentProvider({ config, plan, artifacts }),
    config,
    plan,
    artifacts,
    contractFactory:
      generation === "v3-portfolio-core-v1"
        ? policyRegistryContractFactory(config, plan, {})
        : contractFactory(config, plan),
  });
  const executionPlan = await buildV3ExtensionLiveExecutionPlan({
    config,
    plan,
    signer,
  });
  const approval = createV3ExtensionApproval({
    config,
    plan,
    qualification,
    executionPlan,
    now: qualification.blockTimestamp,
  });
  return {
    wallet,
    config,
    artifacts,
    plan,
    signer,
    qualification,
    executionPlan,
    approval,
  };
}

test("V3 extension config accepts only the three exact generations and binds prerequisite manifests", () => {
  for (const generation of GENERATIONS) {
    const config = normalizedConfig(generation);
    assert.equal(config.generation, generation);
    assert.equal(config.chainId, CHAIN_ID);
    if (generation === "v3-portfolio-core-v1") {
      assert.equal(
        config.asset.runtimeCodeKeccak256,
        keccak256(PREREQUISITE_CODE.asset),
      );
    }
  }

  const unknown = rawConfig("v3-closed-loop-v1");
  unknown.generation = "v3-core";
  assert.throws(
    () =>
      validateV3ExtensionConfig(
        unknown,
        relevantManifests("v3-closed-loop-v1"),
      ),
    /generation|allowlist/,
  );

  const traversing = rawConfig("v3-closed-loop-v1");
  traversing.prerequisites.core.path = "../core.json";
  assert.throws(
    () =>
      validateV3ExtensionConfig(
        traversing,
        relevantManifests("v3-closed-loop-v1"),
      ),
    /prerequisite|path|relative/,
  );

  for (const rootedPath of [
    "\\outside.json",
    "\\\\server\\share\\core.json",
    "D:outside.json",
  ]) {
    const rooted = rawConfig("v3-closed-loop-v1");
    rooted.prerequisites.core.path = rootedPath;
    assert.throws(
      () =>
        validateV3ExtensionConfig(
          rooted,
          relevantManifests("v3-closed-loop-v1"),
        ),
      /prerequisite|path|relative/,
    );
  }

  const unpinned = rawConfig("v3-closed-loop-v1");
  unpinned.prerequisites.core.sha256 = "abc";
  assert.throws(
    () =>
      validateV3ExtensionConfig(
        unpinned,
        relevantManifests("v3-closed-loop-v1"),
      ),
    /sha256|SHA-256/,
  );

  const wrongContext = rawConfig("v3-closed-loop-v1");
  wrongContext.closedLoop.context = ADDRESS("bad1");
  assert.throws(
    () =>
      validateV3ExtensionConfig(
        wrongContext,
        relevantManifests("v3-closed-loop-v1"),
      ),
    /context|policy kernel|core manifest/,
  );

  for (const field of ["schemaVersion", "status"]) {
    const unqualifiedManifests = prerequisiteManifests();
    delete unqualifiedManifests.core[field];
    assert.throws(
      () =>
        validateV3ExtensionConfig(
          rawConfig("v3-closed-loop-v1"),
          relevantManifests("v3-closed-loop-v1", unqualifiedManifests),
        ),
      /core prerequisite manifest identity mismatch/,
    );
  }

  const wrongAsset = rawConfig("v3-portfolio-core-v1");
  wrongAsset.asset.address = ADDRESS("bad2");
  assert.throws(
    () =>
      validateV3ExtensionConfig(
        wrongAsset,
        relevantManifests("v3-portfolio-core-v1"),
      ),
    /asset|core manifest/,
  );

  const unpinnedPortfolioAsset = rawConfig("v3-portfolio-core-v1");
  delete unpinnedPortfolioAsset.asset.runtimeCodeKeccak256;
  assert.throws(
    () =>
      validateV3ExtensionConfig(
        unpinnedPortfolioAsset,
        relevantManifests("v3-portfolio-core-v1"),
      ),
    /asset|runtime|code hash/,
  );
});

test("checked-in V3 extension examples are valid JSON but remain explicitly unauthorized", () => {
  const examples = [
    ["config/v3-closed-loop.example.json", "v3-closed-loop-v1"],
    ["config/v3-operator-market.example.json", "v3-operator-market-v1"],
    ["config/v3-portfolio-core.example.json", "v3-portfolio-core-v1"],
  ];
  const objectShape = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return "value";
    }
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, objectShape(value[key])]),
    );
  };

  for (const [path, generation] of examples) {
    const example = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(example.generation, generation);
    assert.deepEqual(objectShape(example), objectShape(rawConfig(generation)));
    assert.ok(
      (JSON.stringify(example).match(/REPLACE_WITH_[A-Z0-9_]+/g) ?? []).length >
        0,
    );
    assert.throws(
      () => validateV3ExtensionConfig(example, relevantManifests(generation)),
      /deployer must not be a placeholder/,
    );
  }
});

test("the file-reading boundary verifies each prerequisite path and raw SHA-256", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "recourse-v3-extension-inputs-"),
  );
  const manifests = prerequisiteManifests();
  const input = rawConfig("v3-closed-loop-v1");
  const configPath = join(directory, "extension.json");
  try {
    for (const name of ["core", "remedy"]) {
      const raw = manifestBytes(manifests[name]);
      writeFileSync(join(directory, `${name}.json`), raw, "utf8");
      input.prerequisites[name].sha256 = SHA256(raw);
    }
    writeFileSync(configPath, `${JSON.stringify(input)}\n`, "utf8");

    const result = await readV3ExtensionInputs(configPath, directory);
    assert.equal(result.config.generation, "v3-closed-loop-v1");
    assert.deepEqual(result.prerequisiteManifests, {
      core: manifests.core,
      remedy: manifests.remedy,
    });

    writeFileSync(
      join(directory, "remedy.json"),
      `${JSON.stringify({ ...manifests.remedy, status: "changed" })}\n`,
      "utf8",
    );
    await assert.rejects(
      async () => readV3ExtensionInputs(configPath, directory),
      /SHA-256|sha256|hash mismatch/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("artifact loading pins the exact generation set, raw hashes, and constructor ABI", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "recourse-v3-extension-artifacts-"),
  );
  const artifactDirectory = join(directory, "artifacts");
  const input = rawConfig("v3-closed-loop-v1");
  const name = "ClosedLoopPolicyV1";
  mkdirSync(artifactDirectory);
  try {
    let raw = `${JSON.stringify(artifact(name))}\n`;
    writeFileSync(join(artifactDirectory, `${name}.json`), raw, "utf8");
    input.artifacts[name].keccak256 = keccak256(Buffer.from(raw));
    let config = validateV3ExtensionConfig(
      input,
      relevantManifests(input.generation),
    );
    const loaded = await readV3ExtensionArtifacts(config, directory);
    assert.deepEqual(Object.keys(loaded), [name]);
    assert.equal(loaded[name].hash, input.artifacts[name].keccak256);

    writeFileSync(join(artifactDirectory, `${name}.json`), `${raw} `, "utf8");
    await assert.rejects(
      async () => readV3ExtensionArtifacts(config, directory),
      /artifact hash mismatch/,
    );

    const invalid = artifact(name);
    invalid.abi[0].inputs[0].type = "uint256";
    raw = `${JSON.stringify(invalid)}\n`;
    writeFileSync(join(artifactDirectory, `${name}.json`), raw, "utf8");
    input.artifacts[name].keccak256 = keccak256(Buffer.from(raw));
    config = validateV3ExtensionConfig(
      input,
      relevantManifests(input.generation),
    );
    await assert.rejects(
      async () => readV3ExtensionArtifacts(config, directory),
      /ClosedLoopPolicyV1 constructor ABI mismatch/,
    );

    const extra = rawConfig("v3-closed-loop-v1");
    extra.artifacts.OperatorMarketV1 = {
      path: "artifacts/OperatorMarketV1.json",
      keccak256: HASH("f"),
    };
    assert.throws(
      () =>
        validateV3ExtensionConfig(extra, relevantManifests(extra.generation)),
      /artifact set|unexpected artifact|exact/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("closed-loop planning contains exactly one CREATE bound to core and remedy manifests", async () => {
  const { config, plan } = await deploymentPlan("v3-closed-loop-v1");
  const predicted = getCreateAddress({
    from: config.deployer,
    nonce: STARTING_NONCE,
  });
  assert.deepEqual(Object.keys(plan.predictedContracts), [
    "ClosedLoopPolicyV1",
  ]);
  assert.deepEqual(
    plan.steps.map(({ name, nonce, to }) => [name, nonce, to]),
    [["ClosedLoopPolicyV1", STARTING_NONCE, null]],
  );
  assert.equal(plan.predictedContracts.ClosedLoopPolicyV1, predicted);
  assert.equal(
    plan.steps[0].data,
    await deployData("ClosedLoopPolicyV1", [POLICY_KERNEL, REMEDY_COORDINATOR]),
  );
  assert.equal(plan.steps[0].predictedContract, predicted);
  assert.match(plan.planCommitment, /^0x[0-9a-f]{64}$/);
});

test("operator-market planning requires one exact non-placeholder verifier manifest", async () => {
  const valid = rawConfig("v3-operator-market-v1");
  const manifests = relevantManifests(valid.generation);

  const placeholder = structuredClone(valid);
  placeholder.operatorMarket.verifier = ZeroAddress;
  assert.throws(
    () => validateV3ExtensionConfig(placeholder, manifests),
    /verifier|zero|placeholder/,
  );

  const mismatch = structuredClone(valid);
  mismatch.operatorMarket.verifier = ADDRESS("bad3");
  assert.throws(
    () => validateV3ExtensionConfig(mismatch, manifests),
    /verifier|manifest/,
  );

  const unqualified = structuredClone(manifests);
  unqualified.verifier.contract.runtimeCodeKeccak256 = HASH("0");
  assert.throws(
    () => validateV3ExtensionConfig(valid, unqualified),
    /verifier|runtime|code hash/,
  );

  const unpinnedToken = structuredClone(valid);
  delete unpinnedToken.asset.runtimeCodeKeccak256;
  assert.throws(
    () => validateV3ExtensionConfig(unpinnedToken, manifests),
    /asset|token|runtime|code hash/,
  );

  const { config, plan } = await deploymentPlan("v3-operator-market-v1");
  assert.deepEqual(
    plan.steps.map(({ name }) => name),
    ["OperatorMarketV1"],
  );
  assert.equal(
    plan.steps[0].data,
    await deployData("OperatorMarketV1", [
      ASSET,
      OPERATOR_VERIFIER,
      config.operatorMarket.minimumOperatorBond,
      config.operatorMarket.maximumQuoteDuration,
      config.operatorMarket.maximumServiceDuration,
    ]),
  );
});

test("portfolio planning fixes pool, pool-lender factory, mandate, and one-way wiring order", async () => {
  const { config, artifacts, plan } = await deploymentPlan(
    "v3-portfolio-core-v1",
  );
  const pool = getCreateAddress({
    from: config.deployer,
    nonce: STARTING_NONCE,
  });
  const factory = getCreateAddress({
    from: config.deployer,
    nonce: STARTING_NONCE + 1,
  });
  const mandate = getCreateAddress({
    from: config.deployer,
    nonce: STARTING_NONCE + 2,
  });
  assert.deepEqual(plan.predictedContracts, {
    PortfolioPoolV1: pool,
    CappedPilotFactoryV1: factory,
    PortfolioMandateV1: mandate,
  });
  assert.equal(config.roles.manager, config.deployer);
  assert.equal(plan.steps[3].from, config.roles.manager);
  assert.deepEqual(
    plan.steps.map(({ name, nonce, to }) => [name, nonce, to]),
    [
      ["PortfolioPoolV1", STARTING_NONCE, null],
      ["CappedPilotFactoryV1", STARTING_NONCE + 1, null],
      ["PortfolioMandateV1", STARTING_NONCE + 2, null],
      ["setMandate", STARTING_NONCE + 3, pool],
    ],
  );
  assert.equal(
    plan.steps[0].data,
    await deployData("PortfolioPoolV1", [
      ASSET,
      config.roles.manager,
      config.portfolio.pool.maximumPoolAssets,
      config.portfolio.pool.maximumServiceBudget,
      config.portfolio.pool.maximumServiceJobDuration,
      config.portfolio.pool.maximumFacilityCount,
      config.portfolio.pool.fundingDeadline,
      config.portfolio.pool.recoveryDelayBlocks,
    ]),
  );
  assert.equal(
    plan.steps[1].data,
    await deployData("CappedPilotFactoryV1", [
      ASSET,
      POLICY_KERNEL,
      pool,
      BORROWER,
      GUARDIAN,
      config.portfolio.factory.maximumFacilityLimit,
      config.portfolio.factory.maximumTotalLimit,
      config.portfolio.factory.minimumBondBps,
      config.portfolio.factory.maximumDrawFeeBps,
      config.portfolio.factory.maximumMaturityBlocks,
      config.portfolio.factory.maximumDrawDelayBlocks,
      config.portfolio.factory.maximumFacilityCount,
    ]),
  );
  assert.equal(
    plan.steps[2].data,
    await deployData("PortfolioMandateV1", [
      factory,
      POLICY_REGISTRY,
      ASSET,
      POLICY_KERNEL,
      config.portfolio.mandate.requiredReleaseId,
      config.portfolio.mandate.requiredPolicySetCommitment,
      config.portfolio.mandate.requiredEvidenceKind,
      config.portfolio.mandate.requiredActionAdapterKind,
      config.portfolio.mandate.maximumFacilityLimit,
      config.portfolio.mandate.minimumBondBps,
      config.portfolio.mandate.maximumDrawFeeBps,
      config.portfolio.mandate.maximumRemainingMaturityBlocks,
    ]),
  );
  assert.equal(
    plan.steps[3].data,
    new Interface(artifacts.PortfolioPoolV1.artifact.abi).encodeFunctionData(
      "setMandate",
      [mandate],
    ),
  );
  assert.equal(plan.steps[3].predictedContract, null);

  const wrongManager = rawConfig("v3-portfolio-core-v1");
  wrongManager.roles.manager = MANAGER;
  assert.throws(
    () =>
      validateV3ExtensionConfig(
        wrongManager,
        relevantManifests(wrongManager.generation),
      ),
    /manager|deployer/,
  );
});

test("live execution enforces fee ceilings and preserves every approved transaction field", async () => {
  const { config, plan, signer, executionPlan } = await liveFixture();
  assert.deepEqual(
    executionPlan.steps.map(
      ({ type, gasLimit, gasPrice, maxFeePerGas, maxPriorityFeePerGas }) => ({
        type,
        gasLimit,
        gasPrice,
        maxFeePerGas,
        maxPriorityFeePerGas,
      }),
    ),
    [
      {
        type: 2,
        gasLimit: "120000",
        gasPrice: null,
        maxFeePerGas: "2",
        maxPriorityFeePerGas: "1",
      },
    ],
  );

  await assert.rejects(
    () =>
      buildV3ExtensionLiveExecutionPlan({
        config,
        plan,
        signer: {
          ...signer,
          populateTransaction: async (request) => ({
            ...request,
            type: 2,
            gasLimit: 120000n,
            maxFeePerGas: 101n,
            maxPriorityFeePerGas: 1n,
          }),
        },
      }),
    /maximumFeePerGas|fee cap|configured maximum/,
  );
  await assert.rejects(
    () =>
      buildV3ExtensionLiveExecutionPlan({
        config,
        plan,
        signer: {
          ...signer,
          populateTransaction: async (request) => ({
            ...request,
            data: "0x1234",
            type: 2,
            gasLimit: 120000n,
            maxFeePerGas: 2n,
            maxPriorityFeePerGas: 1n,
          }),
        },
      }),
    /transaction intent|changed|does not match/,
  );
  await assert.rejects(
    () =>
      buildV3ExtensionLiveExecutionPlan({
        config,
        plan,
        signer: {
          ...signer,
          populateTransaction: async (request) => ({
            ...request,
            type: 2,
            gasLimit: 500001n,
            maxFeePerGas: 2n,
            maxPriorityFeePerGas: 1n,
          }),
        },
      }),
    /gas limit|maximumGasLimit|configured maximum/,
  );
});

test("human approval binds the prerequisite, plan, fees, and qualification and then expires", async () => {
  const { config, plan, qualification, approval } = await liveFixture();
  assert.equal(
    validateV3ExtensionApproval({
      approval,
      config,
      plan,
      qualification,
      now: qualification.blockTimestamp + 1,
    }),
    approval,
  );
  assert.throws(
    () =>
      validateV3ExtensionApproval({
        approval,
        config,
        plan,
        qualification,
        now: approval.validUntil + 1,
      }),
    /expired/,
  );
  const shiftedWindow = {
    ...approval,
    issuedAt: approval.issuedAt + 3_600,
    validUntil: approval.validUntil + 3_600,
  };
  assert.throws(
    () =>
      validateV3ExtensionApproval({
        approval: shiftedWindow,
        config,
        plan,
        qualification,
        now: shiftedWindow.issuedAt + 1,
      }),
    /approval|commitment|changed/,
  );
  assert.throws(
    () =>
      validateV3ExtensionApproval({
        approval,
        config,
        plan,
        qualification: { ...qualification, blockHash: HASH("f") },
        now: qualification.blockTimestamp + 1,
      }),
    /qualification|approval|changed/,
  );
  const changedPlan = structuredClone(plan);
  changedPlan.prerequisites = {
    ...changedPlan.prerequisites,
    core: {
      ...changedPlan.prerequisites.core,
      sha256: "f".repeat(64),
    },
  };
  assert.throws(
    () =>
      validateV3ExtensionApproval({
        approval,
        config,
        plan: changedPlan,
        qualification,
        now: qualification.blockTimestamp + 1,
      }),
    /plan|prerequisite|commitment/,
  );
});

test("expired partial extension approval renews only for the exact journal checkpoint", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "recourse-v3-extension-renewal-"),
  );
  const manifestPath = join(directory, "deployment.json");
  const fixture = await liveFixture("v3-portfolio-core-v1");
  const { wallet, config, plan, qualification, approval } = fixture;
  try {
    let { path, journal } = initializeV3ExtensionJournal({
      manifestPath,
      config,
      plan,
      qualification,
      approval,
    });
    journal = await prepareV3ExtensionStep({
      journal,
      journalPath: path,
      stepIndex: 0,
      signer: fixture.signer,
    });
    const firstTransaction = Transaction.from(
      journal.steps[0].intent.rawTransaction,
    );
    const firstReceipt = {
      hash: firstTransaction.hash,
      status: 1,
      blockNumber: 700,
      blockHash: HASH("7"),
      contractAddress: plan.steps[0].predictedContract,
    };
    ({ journal } = await reconcileV3ExtensionStep({
      journal,
      journalPath: path,
      stepIndex: 0,
      provider: {
        getNetwork: async () => ({ chainId: BigInt(config.chainId) }),
        getTransactionReceipt: async () => firstReceipt,
        getTransaction: async () => firstTransaction,
        getBlockNumber: async () => 701,
        getBlock: async () => ({
          number: firstReceipt.blockNumber,
          hash: firstReceipt.blockHash,
        }),
      },
      targetConfirmations: 2,
      maximumReceiptPolls: 2,
      delay: async () => {},
    }));
    journal = await prepareV3ExtensionStep({
      journal,
      journalPath: path,
      stepIndex: 1,
      signer: fixture.signer,
    });

    const renewedQualification = {
      ...qualification,
      blockNumber: 701,
      blockHash: HASH("8"),
      blockTimestamp: approval.validUntil + 1,
      pendingNonce: plan.steps[1].nonce,
    };
    const renewedApproval = createV3ExtensionApproval({
      config,
      plan,
      qualification: renewedQualification,
      executionPlan: fixture.executionPlan,
      now: renewedQualification.blockTimestamp,
      journal,
    });
    assert.deepEqual(
      renewedApproval.renewal.remainingSteps,
      plan.steps.slice(1).map(({ name }) => name),
    );
    assert.equal(
      renewedApproval.renewal.checkpoint[1].transactionHash,
      journal.steps[1].intent.transactionHash,
    );
    assert.equal(
      validateV3ExtensionApproval({
        approval: renewedApproval,
        config,
        plan,
        qualification: renewedQualification,
        now: renewedApproval.issuedAt + 1,
        journal,
      }),
      renewedApproval,
    );

    const regressed = structuredClone(journal);
    regressed.steps[0].status = "prepared";
    assert.throws(
      () =>
        validateV3ExtensionApproval({
          approval: renewedApproval,
          config,
          plan,
          qualification: renewedQualification,
          now: renewedApproval.issuedAt + 1,
          journal: regressed,
        }),
      /regressed|receipt|journal/,
    );
    const substituted = structuredClone(journal);
    substituted.steps[1].intent.transactionHash = HASH("f");
    assert.throws(
      () =>
        validateV3ExtensionApproval({
          approval: renewedApproval,
          config,
          plan,
          qualification: renewedQualification,
          now: renewedApproval.issuedAt + 1,
          journal: substituted,
        }),
      /regressed|journal|transaction/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("approval anchor verification rejects a changed canonical block before broadcast", async () => {
  const { approval } = await liveFixture();
  const provider = {
    getNetwork: async () => ({ chainId: BigInt(CHAIN_ID) }),
    getBlock: async () => ({
      number: approval.qualification.blockNumber,
      hash: approval.qualification.blockHash,
      timestamp: approval.qualification.blockTimestamp,
    }),
  };
  assert.equal(
    await verifyV3ExtensionApprovalAnchor({
      approval,
      provider,
    }),
    true,
  );
  await assert.rejects(
    () =>
      verifyV3ExtensionApprovalAnchor({
        approval,
        provider: {
          ...provider,
          getBlock: async () => ({
            number: approval.qualification.blockNumber,
            hash: HASH("f"),
            timestamp: approval.qualification.blockTimestamp,
          }),
        },
      }),
    /anchor|canonical|hash/,
  );
});

test("qualification proves prerequisite code, empty predictions, deployed runtime, immutables, and initial state", async () => {
  for (const generation of GENERATIONS) {
    const { config, artifacts, plan } = await deploymentPlan(generation);
    const makeContract =
      generation === "v3-portfolio-core-v1"
        ? policyRegistryContractFactory(config, plan, {})
        : contractFactory(config, plan);
    const predeployment = await qualifyV3ExtensionDeployment({
      provider: deploymentProvider({ config, plan, artifacts }),
      config,
      plan,
      artifacts,
      contractFactory: makeContract,
    });
    assert.equal(predeployment.pendingNonce, STARTING_NONCE);
    assert.deepEqual(
      Object.values(predeployment.predictedCodeHashes),
      Object.values(plan.predictedContracts).map(() => null),
    );

    const deployed = await qualifyV3ExtensionDeployment({
      provider: deploymentProvider({ config, plan, artifacts, deployed: true }),
      config,
      plan,
      artifacts,
      contractFactory: makeContract,
      deploymentComplete: true,
      deploymentProgress: plan.steps.map((step) => ({
        ...step,
        status: "confirmed",
      })),
    });
    assert.ok(deployed.runtimeQualification);
    assert.ok(deployed.stateQualification);
    assert.equal(deployed.pendingNonce, STARTING_NONCE + plan.steps.length);
  }

  const closed = await deploymentPlan("v3-closed-loop-v1");
  const closedAddress = closed.plan.predictedContracts.ClosedLoopPolicyV1;
  await assert.rejects(
    () =>
      qualifyV3ExtensionDeployment({
        provider: deploymentProvider({ ...closed, deployed: true }),
        ...closed,
        contractFactory: contractFactory(closed.config, closed.plan, {
          [closedAddress]: { coordinator: async () => ADDRESS("bad4") },
        }),
        deploymentComplete: true,
        deploymentProgress: closed.plan.steps.map((step) => ({
          ...step,
          status: "confirmed",
        })),
      }),
    /coordinator|immutable|state mismatch/,
  );

  const portfolio = await deploymentPlan("v3-portfolio-core-v1");
  const poolAddress = portfolio.plan.predictedContracts.PortfolioPoolV1;
  await assert.rejects(
    () =>
      qualifyV3ExtensionDeployment({
        provider: deploymentProvider({ ...portfolio, deployed: true }),
        ...portfolio,
        contractFactory: policyRegistryContractFactory(
          portfolio.config,
          portfolio.plan,
          {},
          [],
          { [poolAddress]: { mandate: async () => ZeroAddress } },
        ),
        deploymentComplete: true,
        deploymentProgress: portfolio.plan.steps.map((step) => ({
          ...step,
          status: "confirmed",
        })),
      }),
    /mandate|wiring|state mismatch/,
  );
});

test("market qualification pins token runtime while permitting unsolicited token surplus", async () => {
  const market = await deploymentPlan("v3-operator-market-v1");
  const marketAddress = market.plan.predictedContracts.OperatorMarketV1;
  const deployedProvider = deploymentProvider({ ...market, deployed: true });
  const qualified = await qualifyV3ExtensionDeployment({
    provider: deployedProvider,
    ...market,
    contractFactory: contractFactory(market.config, market.plan, {
      [ASSET]: { balanceOf: async () => 123n },
    }),
    deploymentComplete: true,
  });
  assert.equal(qualified.stateQualification.quoteCount, "0");
  assert.equal(qualified.stateQualification.tokenBalance, "123");

  await assert.rejects(
    () =>
      qualifyV3ExtensionDeployment({
        provider: {
          ...deployedProvider,
          getCode: async (address, blockTag) =>
            getAddress(address) === ASSET
              ? "0x60096000526001601ff3"
              : deployedProvider.getCode(address, blockTag),
        },
        ...market,
        contractFactory: contractFactory(market.config, market.plan),
        deploymentComplete: true,
      }),
    /token|asset|runtime/,
  );
});

test("portfolio qualification proves its immutable release evidence and adapter prerequisites", async () => {
  const portfolio = await deploymentPlan("v3-portfolio-core-v1");
  const calls = [];
  const qualification = await qualifyV3ExtensionDeployment({
    provider: deploymentProvider({ ...portfolio }),
    ...portfolio,
    contractFactory: policyRegistryContractFactory(
      portfolio.config,
      portfolio.plan,
      {},
      calls,
    ),
  });
  assert.equal(qualification.registryQualification.releaseExists, true);
  assert.equal(qualification.registryQualification.evidenceKindDeclared, true);
  assert.equal(qualification.registryQualification.actionAdapterMatched, true);
  assert.equal(
    qualification.prerequisiteCodeHashes.asset,
    portfolio.config.asset.runtimeCodeKeccak256,
  );
  assert.deepEqual(
    calls.map(({ name }) => name),
    [
      "packageRelease",
      "declaresEvidenceKind",
      "actionAdapterCount",
      "actionAdapterAt",
    ],
  );
  for (const state of [
    { releaseExists: false },
    { evidenceDeclared: false },
    { adapterPresent: false },
    { adapterKind: HASH("d") },
  ]) {
    await assert.rejects(
      () =>
        qualifyV3ExtensionDeployment({
          provider: deploymentProvider({ ...portfolio }),
          ...portfolio,
          contractFactory: policyRegistryContractFactory(
            portfolio.config,
            portfolio.plan,
            state,
          ),
        }),
      /release|evidence|action adapter|adapter kind/,
    );
  }

  const deployedProvider = deploymentProvider({
    ...portfolio,
    deployed: true,
  });
  await assert.rejects(
    () =>
      qualifyV3ExtensionDeployment({
        provider: {
          ...deployedProvider,
          getCode: async (address, blockTag) =>
            getAddress(address) === ASSET
              ? "0x60096000526001601ff3"
              : deployedProvider.getCode(address, blockTag),
        },
        ...portfolio,
        contractFactory: policyRegistryContractFactory(
          portfolio.config,
          portfolio.plan,
          {},
        ),
        deploymentComplete: true,
      }),
    /portfolio asset runtime mismatch/,
  );
  await assert.rejects(
    () =>
      qualifyV3ExtensionDeployment({
        provider: deployedProvider,
        ...portfolio,
        contractFactory: policyRegistryContractFactory(
          portfolio.config,
          portfolio.plan,
          {},
          [],
          { [ASSET]: { balanceOf: async () => 1n } },
        ),
        deploymentComplete: true,
      }),
    /pool token balance|initial token balance/,
  );
});

test("the journal persists signed raw intent before broadcast, recovers canonically, and never rebroadcasts", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "recourse-v3-extension-journal-"),
  );
  const manifestPath = join(directory, "deployment.json");
  const fixture = await liveFixture();
  const { wallet, config, plan, qualification, approval } = fixture;
  try {
    let { path, journal } = initializeV3ExtensionJournal({
      manifestPath,
      config,
      plan,
      qualification,
      approval,
    });
    assert.throws(
      () => completeV3ExtensionJournal(journal, path, manifestPath),
      /unfinished/,
    );
    await assert.rejects(
      () =>
        prepareV3ExtensionStep({
          journal,
          journalPath: path,
          stepIndex: 0,
          signer: {
            getAddress: async () => wallet.address,
            signTransaction: (request) =>
              wallet.signTransaction({ ...request, nonce: request.nonce + 1 }),
          },
        }),
      /signed transaction|does not match|nonce/,
    );

    journal = await prepareV3ExtensionStep({
      journal,
      journalPath: path,
      stepIndex: 0,
      signer: fixture.signer,
    });
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(persisted.steps[0].status, "prepared");
    assert.equal(
      persisted.steps[0].intent.rawTransaction,
      journal.steps[0].intent.rawTransaction,
    );

    const transaction = Transaction.from(
      journal.steps[0].intent.rawTransaction,
    );
    const receipt = {
      hash: transaction.hash,
      status: 1,
      blockNumber: 700,
      blockHash: HASH("a"),
      contractAddress: plan.predictedContracts.ClosedLoopPolicyV1,
    };
    let broadcasts = 0;
    const minedProvider = {
      getNetwork: async () => ({ chainId: BigInt(CHAIN_ID) }),
      getTransactionReceipt: async () => receipt,
      getTransaction: async () => transaction,
      getBlockNumber: async () => 701,
      getBlock: async () => ({ number: 700, hash: receipt.blockHash }),
      broadcastTransaction: async () => {
        broadcasts += 1;
      },
    };
    await assert.rejects(
      () =>
        reconcileV3ExtensionStep({
          journal,
          journalPath: path,
          stepIndex: 0,
          provider: {
            ...minedProvider,
            getBlock: async () => ({ number: 700, hash: HASH("b") }),
          },
          targetConfirmations: 2,
          maximumReceiptPolls: 2,
          delay: async () => {},
        }),
      /canonical/,
    );
    assert.equal(broadcasts, 0);

    let receiptPolls = 0;
    const provider = {
      ...minedProvider,
      getTransactionReceipt: async () => {
        receiptPolls += 1;
        return receiptPolls === 1 ? null : receipt;
      },
      getTransaction: async () => (receiptPolls === 1 ? null : transaction),
      getTransactionCount: async () => STARTING_NONCE,
    };
    let result = await reconcileV3ExtensionStep({
      journal,
      journalPath: path,
      stepIndex: 0,
      provider,
      targetConfirmations: 2,
      maximumReceiptPolls: 2,
      delay: async () => {},
      beforeBroadcast: async () => {
        const beforeBroadcast = JSON.parse(readFileSync(path, "utf8"));
        assert.equal(beforeBroadcast.steps[0].status, "prepared");
        assert.equal(
          beforeBroadcast.steps[0].intent.rawTransaction,
          journal.steps[0].intent.rawTransaction,
        );
      },
    });
    journal = result.journal;
    assert.equal(result.broadcast, true);
    assert.equal(broadcasts, 1);
    assert.equal(journal.steps[0].status, "confirmed");
    assert.equal(journal.steps[0].intent.rawTransaction, undefined);
    assert.equal(journal.steps[0].receipt.blockHash, receipt.blockHash);

    result = await reconcileV3ExtensionStep({
      journal,
      journalPath: path,
      stepIndex: 0,
      provider,
      targetConfirmations: 2,
      maximumReceiptPolls: 2,
      delay: async () => {},
    });
    assert.equal(result.broadcast, false);
    assert.equal(broadcasts, 1);

    const complete = completeV3ExtensionJournal(
      result.journal,
      path,
      manifestPath,
    );
    assert.equal(complete.phase, "complete");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).phase, "complete");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("manifest and transaction verification require an exact separate generation and canonical signed CREATE", async () => {
  const fixture = await liveFixture();
  const { wallet, config, artifacts, plan, executionPlan } = fixture;
  const step = executionPlan.steps[0];
  const rawTransaction = await wallet.signTransaction({
    type: step.type,
    chainId: step.chainId,
    nonce: step.nonce,
    data: step.data,
    value: step.value,
    gasLimit: step.gasLimit,
    maxFeePerGas: step.maxFeePerGas,
    maxPriorityFeePerGas: step.maxPriorityFeePerGas,
  });
  const transaction = Transaction.from(rawTransaction);
  const receipt = {
    hash: transaction.hash,
    status: 1,
    blockNumber: 800,
    blockHash: HASH("9"),
    contractAddress: step.predictedContract,
  };
  const canonicalTransactions = {
    [step.name]: {
      hash: transaction.hash,
      from: step.from,
      to: step.to,
      nonce: step.nonce,
      dataHash: step.dataHash,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      contractAddress: receipt.contractAddress,
    },
  };
  const finalQualification = await qualifyV3ExtensionDeployment({
    provider: deploymentProvider({ config, plan, artifacts, deployed: true }),
    config,
    plan,
    artifacts,
    contractFactory: contractFactory(config, plan),
    deploymentComplete: true,
    deploymentProgress: plan.steps.map((value) => ({
      ...value,
      status: "confirmed",
    })),
  });
  const manifest = {
    schemaVersion: 1,
    status: "deployed-qualified",
    generation: config.generation,
    chainId: config.chainId,
    configCommitment: plan.configCommitment,
    planCommitment: plan.planCommitment,
    prerequisites: plan.prerequisites,
    artifactHashes: plan.artifactHashes,
    constructors: plan.constructors,
    contracts: plan.predictedContracts,
    transactionPlan: plan.steps,
    executionPlan,
    executionPlanCommitment: executionPlan.commitment,
    transactions: Object.fromEntries(
      Object.entries(canonicalTransactions).map(([name, record]) => [
        name,
        {
          hash: record.hash,
          blockNumber: record.blockNumber,
          blockHash: record.blockHash,
          contractAddress: record.contractAddress,
        },
      ]),
    ),
    canonicalTransactions,
    finalQualification,
    journalPath: "v3-extension-deployment.json.v3-extension-journal.json",
  };
  assert.equal(
    validateV3ExtensionManifest({
      manifest,
      config,
      plan,
      finalQualification,
      canonicalTransactions,
    }),
    manifest,
  );

  const wrongGeneration = structuredClone(manifest);
  wrongGeneration.generation = "v3-operator-market-v1";
  assert.throws(
    () =>
      validateV3ExtensionManifest({
        manifest: wrongGeneration,
        config,
        plan,
        finalQualification,
        canonicalTransactions,
      }),
    /generation|manifest/,
  );
  const sharedManifest = structuredClone(manifest);
  sharedManifest.contracts.OperatorMarketV1 = ADDRESS("feed");
  assert.throws(
    () =>
      validateV3ExtensionManifest({
        manifest: sharedManifest,
        config,
        plan,
        finalQualification,
        canonicalTransactions,
      }),
    /contract set|contracts|manifest/,
  );

  const provider = {
    getTransaction: async () => transaction,
    getTransactionReceipt: async () => receipt,
    getBlock: async () => ({
      number: receipt.blockNumber,
      hash: receipt.blockHash,
    }),
    getBlockNumber: async () =>
      receipt.blockNumber + config.transactionPolicy.targetConfirmations - 1,
  };
  const verified = await verifyV3ExtensionTransactions({
    manifest,
    config,
    plan,
    provider,
  });
  assert.deepEqual(Object.keys(verified), [step.name]);
  await assert.rejects(
    () =>
      verifyV3ExtensionTransactions({
        manifest,
        config,
        plan,
        provider: {
          ...provider,
          getBlock: async () => ({
            number: receipt.blockNumber,
            hash: HASH("8"),
          }),
        },
      }),
    /canonical/,
  );
});

test("V3 extension deployment is offline by default and broadcast requires an approved live plan", () => {
  assert.throws(() => parseV3ExtensionArguments([]), /--config is required/);
  assert.deepEqual(
    parseV3ExtensionArguments([
      "--config",
      "config/v3-closed-loop.example.json",
    ]),
    {
      help: false,
      broadcast: false,
      liveCheck: false,
      qualifyDeployed: false,
      configPath: "config/v3-closed-loop.example.json",
      manifestPath: "v3-extension-deployment.json",
      writePlanPath: undefined,
      approvedPlanPath: undefined,
    },
  );
  assert.throws(
    () =>
      parseV3ExtensionArguments([
        "--config",
        "config/v3-closed-loop.example.json",
        "--broadcast",
      ]),
    /requires --live-check and --approved-plan/,
  );
  assert.throws(
    () =>
      parseV3ExtensionArguments([
        "--config",
        "config/v3-closed-loop.example.json",
        "--broadcast",
        "--live-check",
        "--approved-plan",
        "approval.json",
        "--write-plan",
        "plan.json",
      ]),
    /cannot be combined|mutually exclusive/,
  );
});

test("the extension deployment CLI exposes help without reading config or environment", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/deploy-v3-extension.mjs", "--help"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {},
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /offline validation and planning/);
  assert.match(result.stdout, /--broadcast/);
});
