import {
  AbiCoder,
  Contract,
  Interface,
  ZeroAddress,
  ZeroHash,
  getAddress,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { encodeConfigureMultiChainPolicy } from "../../sdk/src/core.mjs";
import {
  inspectTrackedRepositoryFile,
  requireCleanDeployableRepository,
} from "./pilot-readiness.mjs";
import {
  buildV3LiveExecutionPlan,
  createV3LivePlanReceipt,
  createV3ActivationRenewalBinding,
  deriveFirstPilotFacilityAddress,
  policyConfigurationHash,
  validateApprovedV3ActivationPlan,
  validateV3ActivationJournal,
  verifyPinnedFacilityRuntime,
  v3ActivationApprovalCommitment,
  v3ActivationPlanCommitment,
} from "./v3-activation.mjs";

const ABI = AbiCoder.defaultAbiCoder();
const ROLES = ["manager", "investor", "borrower"];
const ARTIFACTS = {
  pool: "PortfolioPoolV1",
  factory: "CappedPilotFactoryV1",
  mandate: "PortfolioMandateV1",
  kernel: "PolicyKernelV2",
  registry: "PolicyRegistryV1",
  policy: "MultiChainEventPolicyV1",
  facility: "RecourseFacilityV3",
};
const TOKEN_ABI = [
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
];
function assert(condition, label) {
  if (!condition) throw new Error(label);
}
function canonical(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
function digest(value) {
  return keccak256(toUtf8Bytes(JSON.stringify(canonical(value))));
}
function equal(actual, expected, label) {
  assert(
    String(actual).toLowerCase() === String(expected).toLowerCase(),
    `${label} mismatch`,
  );
}
function positive(value, label) {
  assert(
    typeof value === "string" && /^[1-9][0-9]*$/.test(value),
    `${label} must be a positive decimal string`,
  );
  return BigInt(value);
}
function blockRecord(block) {
  assert(
    Number.isSafeInteger(block?.number) &&
      block.number > 0 &&
      Number.isSafeInteger(block.timestamp) &&
      block.timestamp > 0 &&
      /^0x[0-9a-f]{64}$/.test(block.hash ?? "") &&
      block.hash !== ZeroHash,
    "Invalid qualification block",
  );
  return { number: block.number, hash: block.hash, timestamp: block.timestamp };
}

export function validatePortfolioConfig(input, manifests) {
  assert(
    input?.generation === "v3-portfolio-activation" && input.chainId === 102031,
    "Invalid portfolio activation generation or chainId",
  );
  for (const name of ["portfolio", "core", "activation"]) {
    const pin = input.prerequisites?.[name];
    assert(
      typeof pin?.path === "string" &&
        pin.path.length > 0 &&
        !/placeholder|replace|<|>/i.test(pin.path) &&
        /^[0-9a-f]{64}$/.test(pin.sha256 ?? "") &&
        !/^0+$/.test(pin.sha256),
      `Invalid ${name} prerequisite pin`,
    );
    assert(
      manifests[name]?.chainId === input.chainId,
      `${name} chainId mismatch`,
    );
  }
  equal(
    manifests.portfolio.generation,
    "v3-portfolio-core-v1",
    "portfolio generation",
  );
  equal(manifests.portfolio.status, "deployed-qualified", "portfolio status");
  equal(manifests.core.generation, "v3-core", "core generation");
  equal(manifests.core.status, "deployed-qualified", "core status");
  equal(
    manifests.activation.generation,
    "v3-pilot-activation",
    "activation generation",
  );
  equal(manifests.activation.facility.status, "Active", "activation status");
  const roles = Object.fromEntries(
    [...ROLES, "issuer"].map((role) => {
      const value = getAddress(input.roles?.[role]);
      assert(value !== ZeroAddress, `Invalid ${role} address`);
      return [role, value];
    }),
  );
  for (const [role, original] of Object.entries({
    manager: "deployer",
    issuer: "deployer",
    investor: "lender",
    borrower: "borrower",
  }))
    equal(roles[role], manifests.activation.roles[original], `${role} role`);
  assert(
    new Set(ROLES.map((role) => roles[role])).size === 3,
    "Signer accounts must be distinct except manager/issuer",
  );
  for (const [role, environment] of Object.entries({
    manager: "DEPLOYER_PRIVATE_KEY",
    issuer: "DEPLOYER_PRIVATE_KEY",
    investor: "LENDER_PRIVATE_KEY",
    borrower: "BORROWER_PRIVATE_KEY",
  }))
    equal(
      input.signerEnvironment?.[role],
      environment,
      `${role} signer environment`,
    );
  for (const [key, value] of Object.entries({
    facilityLimit: "100000000000",
    bondRequired: "20000000000",
    drawFeeBps: 200,
    maturityBlockOffset: 80000,
    drawDelayBlocks: 10,
  }))
    assert(
      input.facility?.[key] === value,
      `facility.${key} must remain exactly ${value}`,
    );
  for (const role of [...ROLES, "issuer"])
    assert(
      Number.isSafeInteger(input.expectedStartingNonces?.[role]) &&
        input.expectedStartingNonces[role] >= 0,
      `Invalid ${role} starting nonce`,
    );
  equal(
    input.expectedStartingNonces.manager,
    input.expectedStartingNonces.issuer,
    "Shared manager/issuer nonce",
  );
  const policy = input.transactionPolicy;
  assert(
    policy?.targetConfirmations === 6 && policy.maximumReceiptPolls === 24,
    "Receipt policy must use 6 confirmations and 24 polls",
  );
  const fees = policy.feePolicy;
  for (const [key, value] of Object.entries({
    transactionType: "eip1559",
    maximumGasLimit: "6000000",
    maximumFeePerGas: "10000000000",
    maximumPriorityFeePerGas: "1000000000",
  }))
    equal(fees?.[key], value, `feePolicy.${key}`);
  equal(policy.maximumTotalFeeWei, "780000000000000000", "Total fee cap");
  equal(input.assetSymbol, "rUSD", "Asset symbol");
  const a = addressesFor(manifests),
    constructors = manifests.portfolio.constructors;
  for (const [name, values] of Object.entries({
    PortfolioPoolV1: [a.asset, roles.manager],
    CappedPilotFactoryV1: [a.asset, a.kernel, a.pool, roles.borrower],
    PortfolioMandateV1: [a.factory, a.registry, a.asset, a.kernel],
  }))
    values.forEach((value, index) =>
      equal(
        constructors[name].values[index],
        value,
        `${name} constructor binding ${index}`,
      ),
    );
  equal(
    a.policy,
    manifests.core.contracts.multiChainEventPolicy,
    "Core policy binding",
  );
  equal(
    a.asset,
    manifests.activation.asset.address,
    "Activation asset binding",
  );
  equal(
    a.kernel,
    manifests.activation.core.policyKernel,
    "Activation kernel binding",
  );
  equal(
    a.registry,
    manifests.activation.core.policyRegistry,
    "Activation registry binding",
  );
  return {
    ...input,
    roles,
    qualificationBlock: blockRecord(input.qualificationBlock),
    facility: {
      ...input.facility,
      facilityLimit: positive(input.facility.facilityLimit, "facilityLimit"),
      bondRequired: positive(input.facility.bondRequired, "bondRequired"),
    },
    transactionPolicy: {
      ...policy,
      maximumTotalFeeWei: positive(
        policy.maximumTotalFeeWei,
        "maximumTotalFeeWei",
      ),
      feePolicy: {
        ...fees,
        maximumGasLimit: positive(fees.maximumGasLimit, "maximumGasLimit"),
        maximumFeePerGas: positive(fees.maximumFeePerGas, "maximumFeePerGas"),
        maximumPriorityFeePerGas: positive(
          fees.maximumPriorityFeePerGas,
          "maximumPriorityFeePerGas",
        ),
      },
    },
  };
}

export function readPortfolioInputs(configPath, rootDirectory = process.cwd()) {
  inspectTrackedRepositoryFile(rootDirectory, configPath);
  const input = JSON.parse(
    readFileSync(resolve(rootDirectory, configPath), "utf8"),
  );
  const manifests = {};
  for (const name of ["portfolio", "core", "activation"]) {
    const pin = input.prerequisites?.[name];
    assert(typeof pin?.path === "string", `Missing ${name} prerequisite`);
    inspectTrackedRepositoryFile(rootDirectory, pin.path);
    const bytes = readFileSync(resolve(rootDirectory, pin.path));
    equal(
      createHash("sha256").update(bytes).digest("hex"),
      pin.sha256,
      `${name} prerequisite SHA-256`,
    );
    manifests[name] = JSON.parse(bytes.toString("utf8"));
  }
  const config = validatePortfolioConfig(input, manifests);
  equal(
    manifests.portfolio.prerequisites.core.sha256,
    config.prerequisites.core.sha256,
    "Portfolio core prerequisite",
  );
  equal(
    manifests.activation.coreManifest.sha256,
    config.prerequisites.core.sha256,
    "Activation core prerequisite",
  );
  manifests.artifacts = Object.fromEntries(
    Object.entries(ARTIFACTS).map(([key, name]) => {
      const path =
        manifests.activation.artifacts[name]?.path ??
        `out/${name}.sol/${name}.json`;
      const bytes = readFileSync(resolve(rootDirectory, path));
      const expected =
        manifests.portfolio.artifactHashes[name] ??
        manifests.core.artifactHashes[name] ??
        manifests.activation.artifacts[name]?.keccak256;
      equal(keccak256(bytes), expected, `${name} artifact hash`);
      return [key, JSON.parse(bytes.toString("utf8"))];
    }),
  );
  return { config, manifests };
}

function addressesFor(manifests) {
  const { portfolio, core, activation } = manifests;
  return {
    pool: getAddress(portfolio.contracts.PortfolioPoolV1),
    factory: getAddress(portfolio.contracts.CappedPilotFactoryV1),
    mandate: getAddress(portfolio.contracts.PortfolioMandateV1),
    kernel: getAddress(core.contracts.policyKernel),
    registry: getAddress(core.contracts.policyRegistry),
    policy: getAddress(activation.policy.evaluator),
    asset: getAddress(core.asset.address),
  };
}
export function createPortfolioContracts(provider, manifests, plan) {
  return Object.fromEntries(
    Object.entries({ ...plan.addresses, facility: plan.predictedFacility }).map(
      ([key, address]) => [
        key,
        new Contract(
          address,
          key === "asset" ? TOKEN_ABI : manifests.artifacts[key].abi,
          provider,
        ),
      ],
    ),
  );
}

function assertTerms(
  config,
  manifests,
  block,
  maturityBlock,
  fundingPending = true,
) {
  const pool = manifests.portfolio.constructors.PortfolioPoolV1.values;
  const factory = manifests.portfolio.constructors.CappedPilotFactoryV1.values;
  const mandate = manifests.portfolio.constructors.PortfolioMandateV1.values;
  const f = config.facility;
  assert(f.facilityLimit <= BigInt(pool[2]), "Pool maximumPoolAssets exceeded");
  assert(
    Number(pool[5]) >= 1 && Number(factory[11]) >= 1,
    "Facility count bound",
  );
  if (fundingPending)
    assert(
      Number(pool[6]) - block.timestamp > 3600,
      "Funding deadline must retain one-hour safety window",
    );
  for (const [label, limit, bond, fee, maturity] of [
    ["factory", factory[5], factory[7], factory[8], factory[9]],
    ["mandate", mandate[8], mandate[9], mandate[10], mandate[11]],
  ]) {
    assert(
      f.facilityLimit <= BigInt(limit),
      `${label} facility limit exceeded`,
    );
    assert(
      f.bondRequired >= (f.facilityLimit * BigInt(bond) + 9999n) / 10000n,
      `${label} minimum bond not satisfied`,
    );
    assert(f.drawFeeBps <= Number(fee), `${label} draw fee exceeded`);
    assert(
      maturityBlock >
        block.number + 13 * config.transactionPolicy.targetConfirmations &&
        maturityBlock <= block.number + Number(maturity),
      `${label} maturity bound or safety window`,
    );
  }
  assert(f.facilityLimit <= BigInt(factory[6]), "Factory total limit exceeded");
  assert(
    f.drawDelayBlocks <= Number(factory[10]),
    "Factory draw delay exceeded",
  );
  equal(mandate[4], manifests.activation.registry.releaseId, "Mandate release");
  equal(
    mandate[5],
    manifests.activation.facility.policySetCommitment,
    "Mandate commitment",
  );
  equal(mandate[6], 1, "Mandate evidence kind");
  equal(mandate[7], ZeroHash, "Mandate action adapter");
}

export async function buildPortfolioPlan({
  config,
  manifests,
  repositoryState,
  qualificationBlock = config.qualificationBlock,
}) {
  const block = blockRecord(qualificationBlock);
  const maturityBlock = block.number + config.facility.maturityBlockOffset;
  assertTerms(config, manifests, block, maturityBlock);
  const addresses = addressesFor(manifests);
  const predictedFacility = deriveFirstPilotFacilityAddress(addresses.factory);
  const activation = manifests.activation;
  equal(
    activation.policy.configuration.subject,
    config.roles.borrower,
    "Policy subject",
  );
  const policyConfigHash = policyConfigurationHash(
    activation.policy.configuration,
  );
  equal(
    policyConfigHash,
    activation.policy.configurationHash,
    "Policy configuration hash",
  );
  const policySetCommitment = keccak256(
    ABI.encode(
      ["bytes32", "uint256", "address", "bytes32", "uint8"],
      [ZeroHash, 1, addresses.policy, policyConfigHash, 1],
    ),
  );
  equal(
    policySetCommitment,
    activation.facility.policySetCommitment,
    "Policy set commitment",
  );
  const r = activation.registry;
  const constructorArgumentsHash = keccak256(
    ABI.encode(["address"], [addresses.kernel]),
  );
  equal(
    constructorArgumentsHash,
    r.constructorArgumentsHash,
    "Constructor arguments hash",
  );
  equal(
    keccak256(
      ABI.encode(
        ["bytes32", "bytes32", "bytes32"],
        [r.releaseId, r.runtimeCodeHash, constructorArgumentsHash],
      ),
    ),
    r.runtimeVariantId,
    "Runtime variant derivation",
  );
  const deploymentId = keccak256(
    ABI.encode(
      [
        "uint256",
        "address",
        "bytes32",
        "address",
        "address",
        "uint256",
        "address",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
      ],
      [
        config.chainId,
        addresses.registry,
        r.releaseId,
        addresses.kernel,
        predictedFacility,
        1,
        addresses.policy,
        r.runtimeVariantId,
        r.runtimeCodeHash,
        constructorArgumentsHash,
        policyConfigHash,
        policyConfigHash,
      ],
    ),
  );
  const configCommitment = digest(config);
  const commitments = {
    configCommitment,
    policyConfigHash,
    policySetCommitment,
    deploymentId,
    releaseId: r.releaseId,
    runtimeVariantId: r.runtimeVariantId,
    policyRuntimeCodeHash: r.runtimeCodeHash,
    constructorArgumentsHash,
    manifestHash: policyConfigHash,
  };
  const configureCall = encodeConfigureMultiChainPolicy({
    facility: predictedFacility,
    policyId: 1,
    configuration: activation.policy.configuration,
  });
  const f = config.facility;
  const rows = [
    [
      "createFacility",
      "manager",
      "pool",
      "createFacility",
      [
        f.facilityLimit,
        f.bondRequired,
        f.drawFeeBps,
        maturityBlock,
        f.drawDelayBlocks,
      ],
    ],
    [
      "configureAndRegisterPolicy",
      "manager",
      "pool",
      "configureAndRegisterPolicy",
      [predictedFacility, 1, addresses.policy, configureCall],
    ],
    [
      "recordRegistryDeployment",
      "issuer",
      "registry",
      "recordDeployment",
      [r.releaseId, addresses.kernel, predictedFacility, 1, r.runtimeVariantId],
    ],
    [
      "registerCandidate",
      "manager",
      "pool",
      "registerCandidate",
      [predictedFacility, deploymentId],
    ],
    [
      "registerInvestor",
      "manager",
      "pool",
      "registerInvestor",
      [config.roles.investor],
    ],
    ["openFunding", "manager", "pool", "openFunding", []],
    [
      "approvePoolDeposit",
      "investor",
      "asset",
      "approve",
      [addresses.pool, f.facilityLimit],
    ],
    ["deposit", "investor", "pool", "deposit", [f.facilityLimit]],
    [
      "approveBorrowerBond",
      "borrower",
      "asset",
      "approve",
      [predictedFacility, f.bondRequired],
    ],
    ["postBorrowerBond", "borrower", "facility", "postBond", [f.bondRequired]],
    ["activatePool", "manager", "pool", "activate", []],
    [
      "allocate",
      "manager",
      "pool",
      "allocate",
      [predictedFacility, f.facilityLimit],
    ],
    [
      "activateFacility",
      "borrower",
      "facility",
      "activate",
      [policySetCommitment],
    ],
  ];
  const interfaces = Object.fromEntries(
    Object.entries(manifests.artifacts).map(([key, artifact]) => [
      key,
      new Interface(artifact.abi),
    ]),
  );
  interfaces.asset = new Interface(TOKEN_ABI);
  const transactionPlan = rows.map(
    ([name, role, contract, method, args], index) => ({
      order: index + 1,
      name,
      role,
      signer: role === "issuer" ? "manager" : role,
      to: contract === "facility" ? predictedFacility : addresses[contract],
      method,
      arguments: canonical(args),
      data: interfaces[contract].encodeFunctionData(method, args),
      preconditions: {
        poolStatus: index >= 11 ? 2 : index >= 6 ? 1 : 0,
        facilityStatus: index >= 1 ? 0 : null,
        fundingDeadlineApplies: [5, 7, 10, 11].includes(index),
      },
    }),
  );
  const requests = transactionPlan.map((step) => ({
    to: step.to,
    data: step.data,
    value: 0n,
  }));
  const feePolicy = config.transactionPolicy.feePolicy;
  const signers = Object.fromEntries(
    ROLES.map((role) => [
      role,
      {
        getAddress: async () => config.roles[role],
        populateTransaction: async (request) => ({
          ...request,
          type: 2,
          maxFeePerGas: feePolicy.maximumFeePerGas,
          maxPriorityFeePerGas: feePolicy.maximumPriorityFeePerGas,
        }),
      },
    ]),
  );
  const executionPlan = await buildV3LiveExecutionPlan({
    transactionPlan,
    requests,
    signers,
    roles: config.roles,
    chainId: config.chainId,
    startingNonces: config.expectedStartingNonces,
    feePolicy,
  });
  assert(
    executionPlan.steps.reduce(
      (total, step) =>
        total + BigInt(step.gasLimit) * BigInt(step.maxFeePerGas),
      0n,
    ) <= config.transactionPolicy.maximumTotalFeeWei,
    "Total fee cap exceeded",
  );
  const source = repositoryState
    ? {
        sourceCommit: repositoryState.head,
        deployableScopeClean: repositoryState.deployableScopeClean === true,
      }
    : {};
  return {
    mode: "offline-plan",
    chainId: config.chainId,
    ...source,
    addresses,
    predictedFacility,
    qualificationBlock: block,
    maturityBlock,
    configCommitment,
    commitments,
    transactionPlan,
    requests,
    executionPlan,
    planCommitment: v3ActivationPlanCommitment({
      configCommitment,
      predictedFacility,
      transactionPlan,
      ...source,
    }),
    assertions: {
      fundingDeadline: Number(
        manifests.portfolio.constructors.PortfolioPoolV1.values[6],
      ),
      fundingSafetySeconds: 3600,
      poolStatusSequence: [0, 1, 2],
      facilityStatusSequence: [0, 1],
      allocationAmount: f.facilityLimit.toString(),
      bondRequired: f.bondRequired.toString(),
    },
    transactionsBroadcast: 0,
    filesWritten: 0,
  };
}

export function createPortfolioApproval({
  plan,
  config,
  targetBlock,
  journal,
  repositoryState,
}) {
  const complete = journal && confirmedPrefix(journal, plan) === 13;
  const receipt = createV3LivePlanReceipt({
    configCommitment: plan.configCommitment,
    planCommitment: plan.planCommitment,
    predictedFacility: plan.predictedFacility,
    targetBlock,
    sourceStates: {},
    validUntil: targetBlock.timestamp + 1800,
    executionPlan: plan.executionPlan,
    ...(journal && !complete
      ? { renewal: createV3ActivationRenewalBinding(journal) }
      : {}),
    sourceCommit: repositoryState?.head ?? plan.sourceCommit,
    deployableScopeClean:
      repositoryState?.deployableScopeClean ?? plan.deployableScopeClean,
  });
  if (complete)
    receipt.finalization = { checkpointCommitment: digest(journal.steps) };
  receipt.generation = config.generation;
  receipt.qualificationBlock = plan.qualificationBlock;
  receipt.approvalCommitment = v3ActivationApprovalCommitment(receipt);
  return receipt;
}
export function validatePortfolioApproval(
  receipt,
  { plan, config, expectedApprovalCommitment, journal, now, repositoryState },
) {
  equal(receipt?.generation, config.generation, "Approval generation");
  equal(
    digest(receipt.qualificationBlock),
    digest(plan.qualificationBlock),
    "Approval qualification block",
  );
  assert(
    receipt.validUntil === receipt.targetBlock.timestamp + 1800,
    "Approval validity must be exactly 30 minutes",
  );
  equal(
    receipt.executionPlan.commitment,
    plan.executionPlan.commitment,
    "Approval execution plan",
  );
  if (receipt.finalization !== undefined) {
    assert(
      journal && confirmedPrefix(journal, plan) === 13,
      "Finalization approval requires thirteen confirmed steps",
    );
    equal(
      receipt.finalization.checkpointCommitment,
      digest(journal.steps),
      "Finalization checkpoint",
    );
    assert(
      receipt.renewal === undefined,
      "Finalization approval cannot also renew unfinished steps",
    );
  }
  return validateApprovedV3ActivationPlan(receipt, {
    expectedApprovalCommitment,
    configCommitment: plan.configCommitment,
    planCommitment: plan.planCommitment,
    predictedFacility: plan.predictedFacility,
    transactionPlan: plan.transactionPlan,
    requests: plan.requests,
    roles: config.roles,
    chainId: config.chainId,
    feePolicy: config.transactionPolicy.feePolicy,
    journal,
    now,
    repositoryState,
  });
}

function confirmedPrefix(journal, plan) {
  if (!journal) return 0;
  validateV3ActivationJournal(journal, {
    chainId: plan.chainId,
    configCommitment: plan.configCommitment,
    predictedFacility: plan.predictedFacility,
    commitments: plan.commitments,
    transactionPlan: plan.transactionPlan,
    executionPlan: plan.executionPlan,
  });
  let count = 0;
  while (journal.steps[count]?.status === "confirmed") count += 1;
  assert(
    journal.steps.slice(count + 1).every((step) => step.status === "planned"),
    "Journal must be a confirmed prefix followed by at most one prepared step",
  );
  return count;
}

async function verifyBindings(contracts, config, manifests, plan, blockTag) {
  const a = plan.addresses;
  const bindings = {
    pool: { asset: a.asset, manager: config.roles.manager, mandate: a.mandate },
    factory: {
      asset: a.asset,
      kernel: a.kernel,
      lender: a.pool,
      borrower: config.roles.borrower,
    },
    mandate: {
      factory: a.factory,
      registry: a.registry,
      asset: a.asset,
      kernel: a.kernel,
      requiredReleaseId: plan.commitments.releaseId,
      requiredPolicySetCommitment: plan.commitments.policySetCommitment,
      requiredEvidenceKind: 1,
      requiredActionAdapterKind: ZeroHash,
    },
    policy: { context: a.kernel, sourceOrdering: 1 },
    kernel: {
      owner: config.roles.manager,
      verifier: manifests.core.verifier,
      creditState: manifests.core.contracts.verifiedCreditState,
      proofJobs: manifests.core.contracts.proofJobs,
      safeStaleProofRelease: true,
    },
    asset: { decimals: 6, symbol: config.assetSymbol },
  };
  const constructorFields = {
    pool: [
      "asset",
      "manager",
      "maximumPoolAssets",
      "maximumServiceBudget",
      "maximumServiceJobDuration",
      "maximumFacilityCount",
      "fundingDeadline",
      "recoveryDelayBlocks",
    ],
    factory: [
      "asset",
      "kernel",
      "lender",
      "borrower",
      "guardian",
      "maximumFacilityLimit",
      "maximumTotalLimit",
      "minimumBondBps",
      "maximumDrawFeeBps",
      "maximumMaturityBlocks",
      "maximumDrawDelayBlocks",
      "maximumFacilityCount",
    ],
    mandate: [
      "factory",
      "registry",
      "asset",
      "kernel",
      "requiredReleaseId",
      "requiredPolicySetCommitment",
      "requiredEvidenceKind",
      "requiredActionAdapterKind",
      "maximumFacilityLimit",
      "minimumBondBps",
      "maximumDrawFeeBps",
      "maximumRemainingMaturityBlocks",
    ],
  };
  for (const [key, fields] of Object.entries(constructorFields))
    fields.forEach((field, index) => {
      bindings[key][field] =
        manifests.portfolio.constructors[ARTIFACTS[key]].values[index];
    });
  for (const [key, fields] of Object.entries(bindings)) {
    const results = await Promise.all(
      Object.keys(fields).map((method) => contracts[key][method]({ blockTag })),
    );
    Object.entries(fields).forEach(([method, expected], index) =>
      equal(results[index], expected, `${key}.${method}`),
    );
  }
  const release = await contracts.registry.packageRelease(
    plan.commitments.releaseId,
    { blockTag },
  );
  assert(release.exists === true, "Required release does not exist");
  equal(release.issuer, config.roles.issuer, "Release issuer");
  assert(
    await contracts.registry.declaresEvidenceKind(
      plan.commitments.releaseId,
      1,
      { blockTag },
    ),
    "Required evidence kind is not declared",
  );
  const variant = await contracts.registry.runtimeVariant(
    plan.commitments.runtimeVariantId,
    { blockTag },
  );
  assert(variant.exists === true, "Runtime variant does not exist");
  equal(variant.releaseId, plan.commitments.releaseId, "Runtime release");
  equal(
    variant.runtimeCodeHash,
    plan.commitments.policyRuntimeCodeHash,
    "Runtime code hash",
  );
  equal(
    variant.constructorArgumentsHash,
    plan.commitments.constructorArgumentsHash,
    "Runtime constructor arguments",
  );
}

async function verifyPrefixState({
  contracts,
  config,
  plan,
  prefix,
  blockTag,
}) {
  const a = plan.addresses;
  const f = config.facility;
  const expected = {
    pool: {
      status: prefix >= 11 ? 2 : prefix >= 6 ? 1 : 0,
      createdFacilityCount: prefix >= 1 ? 1 : 0,
      candidateCount: prefix >= 4 ? 1 : 0,
      investorCount: prefix >= 5 ? 1 : 0,
      totalSupply: prefix >= 8 ? f.facilityLimit : 0,
      totalDeposited: prefix >= 8 ? f.facilityLimit : 0,
      totalAllocatedPrincipal: prefix >= 12 ? f.facilityLimit : 0,
      allocatedFacilityCount: prefix >= 12 ? 1 : 0,
    },
    factory: {
      facilityCount: prefix >= 1 ? 1 : 0,
      totalFacilityLimit: prefix >= 1 ? f.facilityLimit : 0,
      creationPaused: false,
    },
  };
  if (prefix >= 1)
    expected.facility = {
      asset: a.asset,
      kernel: a.kernel,
      lender: a.pool,
      borrower: config.roles.borrower,
      facilityLimit: f.facilityLimit,
      bondRequired: f.bondRequired,
      initialDrawFeeBps: f.drawFeeBps,
      maturityBlock: plan.maturityBlock,
      drawDelayBlocks: f.drawDelayBlocks,
      status: prefix >= 13 ? 1 : 0,
      lenderFunded: prefix >= 12 ? f.facilityLimit : 0,
      bondPosted: prefix >= 10 ? f.bondRequired : 0,
      outstandingDebt: 0,
      drawnPrincipal: 0,
    };
  for (const [key, fields] of Object.entries(expected)) {
    const results = await Promise.all(
      Object.keys(fields).map((method) => contracts[key][method]({ blockTag })),
    );
    Object.entries(fields).forEach(([method, value], index) =>
      equal(results[index], value, `${key}.${method}`),
    );
  }
  equal(
    await contracts.asset.balanceOf(a.pool, { blockTag }),
    prefix >= 8 && prefix < 12 ? f.facilityLimit : 0,
    "Pool asset balance",
  );
  equal(
    await contracts.asset.balanceOf(plan.predictedFacility, { blockTag }),
    (prefix >= 10 ? f.bondRequired : 0n) +
      (prefix >= 12 ? f.facilityLimit : 0n),
    "Facility asset balance",
  );
  equal(
    await contracts.asset.allowance(config.roles.investor, a.pool, {
      blockTag,
    }),
    prefix === 7 ? f.facilityLimit : 0,
    "Investor pool allowance",
  );
  equal(
    await contracts.asset.allowance(
      config.roles.borrower,
      plan.predictedFacility,
      { blockTag },
    ),
    prefix === 9 ? f.bondRequired : 0,
    "Borrower facility allowance",
  );
  equal(
    await contracts.asset.allowance(a.pool, plan.predictedFacility, {
      blockTag,
    }),
    0,
    "Pool facility allowance",
  );
  equal(
    await contracts.pool.isInvestor(config.roles.investor, { blockTag }),
    prefix >= 5,
    "Investor registration",
  );
  equal(
    await contracts.kernel.policySetCommitment(plan.predictedFacility, {
      blockTag,
    }),
    prefix >= 2 ? plan.commitments.policySetCommitment : ZeroHash,
    "Kernel policy commitment",
  );
  equal(
    await contracts.policy.isConfigured(plan.predictedFacility, 1, {
      blockTag,
    }),
    prefix >= 2,
    "Policy configured",
  );
  if (prefix >= 2) {
    equal(
      await contracts.policy.configHash(plan.predictedFacility, 1, {
        blockTag,
      }),
      plan.commitments.policyConfigHash,
      "Policy configuration hash",
    );
    equal(
      keccak256(
        await contracts.policy.manifest(plan.predictedFacility, 1, {
          blockTag,
        }),
      ),
      plan.commitments.manifestHash,
      "Policy manifest hash",
    );
    const policy = await contracts.kernel.policyOf(plan.predictedFacility, 1, {
      blockTag,
    });
    equal(policy[0], a.policy, "Kernel policy evaluator");
    equal(
      policy[1],
      plan.commitments.policyConfigHash,
      "Kernel policy configuration",
    );
    equal(
      keccak256(policy[2]),
      plan.commitments.manifestHash,
      "Kernel policy manifest",
    );
  }
  if (prefix >= 1) {
    equal(
      await contracts.factory.isFacility(plan.predictedFacility, { blockTag }),
      true,
      "Factory facility registration",
    );
    equal(
      await contracts.factory.facilityAt(0, { blockTag }),
      plan.predictedFacility,
      "Factory created facility",
    );
    equal(
      await contracts.pool.createdFacilityAt(0, { blockTag }),
      plan.predictedFacility,
      "Pool created facility",
    );
  }
  const record = await contracts.registry.deploymentRecord(
    plan.commitments.deploymentId,
    { blockTag },
  );
  equal(record.exists, prefix >= 3, "Deployment existence");
  if (prefix >= 3) {
    for (const [field, value] of Object.entries({
      facility: plan.predictedFacility,
      kernel: a.kernel,
      chainId: config.chainId,
      policyId: 1,
      evaluator: a.policy,
      releaseId: plan.commitments.releaseId,
      runtimeVariantId: plan.commitments.runtimeVariantId,
      configHash: plan.commitments.policyConfigHash,
      manifestHash: plan.commitments.policyConfigHash,
      runtimeCodeHash: plan.commitments.policyRuntimeCodeHash,
      constructorArgumentsHash: plan.commitments.constructorArgumentsHash,
      attester: config.roles.issuer,
    }))
      equal(record[field], value, `Deployment ${field}`);
    equal(
      await contracts.mandate.evaluate(
        plan.predictedFacility,
        plan.commitments.deploymentId,
        { blockTag },
      ),
      0,
      "Mandate eligibility",
    );
  }
  if (prefix >= 4) {
    const allocation = await contracts.pool.allocationOf(
      plan.predictedFacility,
      { blockTag },
    );
    equal(
      allocation.deploymentId,
      plan.commitments.deploymentId,
      "Allocation deployment",
    );
    equal(allocation.registered, true, "Allocation registered");
    equal(allocation.settled, false, "Allocation settled");
    equal(
      allocation.principal,
      prefix >= 12 ? f.facilityLimit : 0,
      "Allocation principal",
    );
  }
}

async function finalizedSnapshot(provider, config, minimumBlock, delay) {
  for (
    let attempt = 0;
    attempt < config.transactionPolicy.maximumReceiptPolls;
    attempt += 1
  ) {
    const block = blockRecord(await provider.getBlock("finalized"));
    if (block.number >= minimumBlock) return block;
    if (attempt + 1 < config.transactionPolicy.maximumReceiptPolls)
      await delay(15_000);
  }
  throw new Error(
    `Finalized block did not reach receipt block ${minimumBlock} within the receipt poll budget`,
  );
}

export async function runPortfolioPreflight({
  provider,
  config,
  manifests,
  plan,
  contracts,
  repositoryState,
  journal,
  delay = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  requireCleanDeployableRepository(repositoryState);
  const network = await provider.getNetwork();
  equal(network.chainId, config.chainId, "Network chainId");
  let prefix = confirmedPrefix(journal, plan);
  let minimumBlock = Math.max(
    0,
    ...(journal?.steps.slice(0, prefix).map((step) => step.receipt.blockNumber) ?? []),
  );
  const prepared = journal?.steps[prefix];
  if (prepared?.status === "prepared") {
    const receipt = await provider.getTransactionReceipt(
      prepared.intent.transactionHash,
    );
    if (receipt) {
      assert(receipt.status === 1, "Prepared transaction receipt failed");
      equal(
        receipt.hash,
        prepared.intent.transactionHash,
        "Prepared receipt hash",
      );
      equal(
        (await provider.getBlock(receipt.blockNumber))?.hash,
        receipt.blockHash,
        "Prepared receipt canonical block",
      );
      minimumBlock = Math.max(minimumBlock, receipt.blockNumber);
      const transaction = await provider.getTransaction(
        prepared.intent.transactionHash,
      );
      assert(transaction, "Prepared canonical transaction missing");
      const approved = plan.executionPlan.steps[prefix];
      for (const field of [
        "from",
        "to",
        "nonce",
        "chainId",
        "value",
        "type",
        "gasLimit",
        "maxFeePerGas",
        "maxPriorityFeePerGas",
      ])
        equal(
          transaction[field],
          approved[field],
          `Prepared transaction ${field}`,
        );
      equal(
        keccak256(transaction.data),
        approved.dataHash,
        "Prepared transaction data",
      );
      prefix += 1;
    }
  }
  const targetBlock = await finalizedSnapshot(
    provider,
    config,
    minimumBlock,
    delay,
  );
  if (prefix < 13)
    assertTerms(
      config,
      manifests,
      targetBlock,
      plan.maturityBlock,
      prefix < 12,
    );
  const anchor = await provider.getBlock(plan.qualificationBlock.number);
  equal(
    anchor?.hash,
    plan.qualificationBlock.hash,
    "Qualification block canonical hash",
  );
  const expectedCodes = {
    pool: manifests.portfolio.finalQualification.runtimeQualification
      .PortfolioPoolV1,
    factory:
      manifests.portfolio.finalQualification.runtimeQualification
        .CappedPilotFactoryV1,
    mandate:
      manifests.portfolio.finalQualification.runtimeQualification
        .PortfolioMandateV1,
    kernel: manifests.core.runtimeCodeHashes.PolicyKernelV2,
    registry: manifests.core.runtimeCodeHashes.PolicyRegistryV1,
    policy: manifests.activation.registry.runtimeCodeHash,
    asset: manifests.portfolio.finalQualification.prerequisiteCodeHashes.asset,
  };
  for (const [key, hash] of Object.entries(expectedCodes)) {
    const code = await provider.getCode(
      plan.addresses[key],
      targetBlock.number,
    );
    assert(code !== "0x", `${key} bytecode missing`);
    equal(keccak256(code), hash, `${key} runtime hash`);
  }
  equal(
    await provider.getTransactionCount(
      plan.addresses.factory,
      targetBlock.number,
    ),
    prefix >= 1 ? 2 : 1,
    "Factory CREATE nonce",
  );
  const facilityCode = await provider.getCode(
    plan.predictedFacility,
    targetBlock.number,
  );
  assert(
    prefix >= 1 ? facilityCode !== "0x" : facilityCode === "0x",
    "Predicted facility code state mismatch",
  );
  if (prefix >= 1)
    verifyPinnedFacilityRuntime({
      artifact: manifests.artifacts.facility,
      liveCode: facilityCode,
    });
  await verifyBindings(contracts, config, manifests, plan, targetBlock.number);
  await verifyPrefixState({
    contracts,
    config,
    plan,
    prefix,
    blockTag: targetBlock.number,
  });
  const pendingNonces = {},
    nativeBalances = {},
    assetBalances = {};
  for (const role of ROLES) {
    const confirmedCount = plan.transactionPlan
      .slice(0, prefix)
      .filter((step) => step.signer === role).length;
    const expectedNonce = config.expectedStartingNonces[role] + confirmedCount;
    const [confirmed, pending, balance] = await Promise.all([
      provider.getTransactionCount(config.roles[role], "latest"),
      provider.getTransactionCount(config.roles[role], "pending"),
      provider.getBalance(config.roles[role], targetBlock.number),
    ]);
    equal(confirmed, expectedNonce, `${role} confirmed nonce`);
    const prepared = journal?.steps[prefix];
    const pendingOwn =
      prepared?.status === "prepared" &&
      prepared.signer === role &&
      pending === expectedNonce + 1;
    if (pendingOwn) {
      const transaction = await provider.getTransaction(
        prepared.intent.transactionHash,
      );
      assert(
        transaction &&
          transaction.hash.toLowerCase() === prepared.intent.transactionHash &&
          transaction.nonce === expectedNonce &&
          keccak256(transaction.data) === prepared.intent.dataHash,
        "Prepared pending transaction mismatch",
      );
    } else equal(pending, expectedNonce, `${role} pending nonce`);
    const feeRequired = plan.executionPlan.steps
      .slice(prefix)
      .filter((step) => step.signer === role)
      .reduce(
        (sum, step) => sum + BigInt(step.gasLimit) * BigInt(step.maxFeePerGas),
        0n,
      );
    assert(balance >= feeRequired, `Insufficient native balance for ${role}`);
    pendingNonces[role] = pending;
    nativeBalances[role] = balance.toString();
  }
  for (const [role, required] of [
    ["investor", prefix >= 8 ? 0n : config.facility.facilityLimit],
    ["borrower", prefix >= 10 ? 0n : config.facility.bondRequired],
  ]) {
    const balance = await contracts.asset.balanceOf(config.roles[role], {
      blockTag: targetBlock.number,
    });
    assert(balance >= required, `Insufficient asset balance for ${role}`);
    assetBalances[role] = balance.toString();
  }
  equal(
    (await provider.getBlock(targetBlock.number))?.hash,
    targetBlock.hash,
    "Preflight snapshot canonical hash",
  );
  return {
    chainId: config.chainId,
    targetBlock,
    qualificationBlock: plan.qualificationBlock,
    pendingNonces,
    nativeBalances,
    assetBalances,
    confirmedSteps: prefix,
    deployableScopeClean: true,
    sourceCommit: repositoryState.head,
  };
}

export async function verifyPortfolioFinal({
  provider,
  config,
  manifests,
  plan,
  contracts,
  journal,
  delay = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  equal(
    confirmedPrefix(journal, plan),
    13,
    "Final confirmed transaction count",
  );
  equal((await provider.getNetwork()).chainId, config.chainId, "Final chainId");
  const head = await finalizedSnapshot(
    provider,
    config,
    Math.max(...journal.steps.map((step) => step.receipt.blockNumber)),
    delay,
  );
  const confirmationHead = blockRecord(await provider.getBlock("latest"));
  verifyPinnedFacilityRuntime({
    artifact: manifests.artifacts.facility,
    liveCode: await provider.getCode(plan.predictedFacility, head.number),
  });
  await verifyBindings(contracts, config, manifests, plan, head.number);
  await verifyPrefixState({
    contracts,
    config,
    plan,
    prefix: 13,
    blockTag: head.number,
  });
  const transactions = {},
    movements = [];
  const assetInterface = new Interface(TOKEN_ABI);
  const poolInterface = new Interface(manifests.artifacts.pool.abi);
  for (let index = 0; index < 13; index += 1) {
    const step = journal.steps[index],
      approved = plan.executionPlan.steps[index];
    const [receipt, transaction] = await Promise.all([
      provider.getTransactionReceipt(step.intent.transactionHash),
      provider.getTransaction(step.intent.transactionHash),
    ]);
    assert(
      receipt &&
        receipt.status === 1 &&
        receipt.hash.toLowerCase() === step.intent.transactionHash,
      "Canonical receipt missing or failed",
    );
    equal(receipt.blockHash, step.receipt.blockHash, "Receipt block hash");
    equal(
      receipt.blockNumber,
      step.receipt.blockNumber,
      "Receipt block number",
    );
    equal(
      (await provider.getBlock(receipt.blockNumber))?.hash,
      receipt.blockHash,
      "Canonical receipt block",
    );
    assert(
      confirmationHead.number >=
        receipt.blockNumber + config.transactionPolicy.targetConfirmations - 1,
      "Receipt lacks target confirmations",
    );
    assert(transaction, "Canonical transaction missing");
    equal(
      transaction.hash,
      step.intent.transactionHash,
      "Canonical transaction hash",
    );
    for (const field of [
      "from",
      "to",
      "nonce",
      "chainId",
      "value",
      "type",
      "gasLimit",
      "maxFeePerGas",
      "maxPriorityFeePerGas",
    ])
      equal(
        transaction[field],
        approved[field],
        `Canonical transaction ${field}`,
      );
    equal(
      keccak256(transaction.data),
      approved.dataHash,
      "Canonical transaction data",
    );
    if (index === 0) {
      const created = receipt.logs
        .filter((log) => getAddress(log.address) === plan.addresses.pool)
        .map((log) => poolInterface.parseLog(log))
        .filter((log) => log?.name === "FacilityCreated");
      assert(
        created.length === 1,
        "FacilityCreated event missing or duplicated",
      );
      equal(
        created[0].args.facility,
        plan.predictedFacility,
        "FacilityCreated address",
      );
    }
    for (const log of receipt.logs.filter(
      (log) => getAddress(log.address) === plan.addresses.asset,
    )) {
      const parsed = assetInterface.parseLog(log);
      if (parsed?.name === "Transfer")
        movements.push({
          step: step.name,
          from: getAddress(parsed.args.from),
          to: getAddress(parsed.args.to),
          amount: parsed.args.value.toString(),
          transactionHash: receipt.hash,
        });
    }
    transactions[step.name] = {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
    };
  }
  const expected = [
    {
      step: "deposit",
      from: config.roles.investor,
      to: plan.addresses.pool,
      amount: config.facility.facilityLimit.toString(),
    },
    {
      step: "postBorrowerBond",
      from: config.roles.borrower,
      to: plan.predictedFacility,
      amount: config.facility.bondRequired.toString(),
    },
    {
      step: "allocate",
      from: plan.addresses.pool,
      to: plan.predictedFacility,
      amount: config.facility.facilityLimit.toString(),
    },
  ];
  equal(
    digest(movements.map(({ transactionHash, ...movement }) => movement)),
    digest(expected),
    "Asset movement reconciliation",
  );
  equal(
    (await provider.getBlock(head.number))?.hash,
    head.hash,
    "Final snapshot canonical hash",
  );
  return {
    verifiedAtBlock: head.number,
    verifiedAtBlockHash: head.hash,
    transactions,
    pool: {
      address: plan.addresses.pool,
      status: "Active",
      statusCode: 2,
      totalDeposited: config.facility.facilityLimit.toString(),
      totalAllocatedPrincipal: config.facility.facilityLimit.toString(),
      assetBalance: "0",
    },
    facility: {
      address: plan.predictedFacility,
      lender: plan.addresses.pool,
      borrower: config.roles.borrower,
      status: "Active",
      statusCode: 1,
      lenderFunded: config.facility.facilityLimit.toString(),
      bondPosted: config.facility.bondRequired.toString(),
      maturityBlock: plan.maturityBlock,
      policySetCommitment: plan.commitments.policySetCommitment,
    },
    registry: {
      deploymentId: plan.commitments.deploymentId,
      releaseId: plan.commitments.releaseId,
      runtimeVariantId: plan.commitments.runtimeVariantId,
    },
    assetMovement: {
      reconciled: true,
      transfers: movements,
      poolBalance: "0",
      facilityBalance: (
        config.facility.facilityLimit + config.facility.bondRequired
      ).toString(),
    },
  };
}
