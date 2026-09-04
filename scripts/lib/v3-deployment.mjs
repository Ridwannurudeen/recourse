import {
  Contract,
  ContractFactory,
  Interface,
  Transaction,
  getAddress,
  getCreateAddress,
  isHexString,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  inspectDeployableRepository,
  inspectTrackedRepositoryFile,
} from "./pilot-readiness.mjs";
import { verifyPinnedArtifactRuntime } from "./v3-activation.mjs";

export const EXPECTED_V3_CHAIN_ID = 102031;
export const EXPECTED_V3_VERIFIER =
  "0x0000000000000000000000000000000000000FD2";
export const CORE_CONTRACT_NAMES = [
  "PolicyKernelV2",
  "PolicyRegistryV1",
  "CappedPilotFactoryV1",
  "MultiChainEventPolicyV1",
  "ProofJobsV1",
];
export const CORE_ARTIFACT_NAMES = [
  ...CORE_CONTRACT_NAMES,
  "VerifiedCreditStateV1",
];
export const V3_DEPLOYMENT_PLAN_VALIDITY_SECONDS = 1_800;
export const V3_DEPLOYMENT_USAGE = `Usage: node scripts/deploy-v3.mjs [options]

Default: read-only dry run; no signer, file write, or broadcast.

Options:
  --help, -h                 Show this help and exit
  --config <path>            Deployment config (default: config/v3-cc3.json)
  --manifest <path>          Deployment manifest output (default: deployments-v3.json)
  --live-check               Qualify live chain state and populate capped fees
  --write-plan <path>        Write an expiring exact plan for human approval
  --broadcast                Broadcast only an exact approved live plan
  --approved-plan <path>     Human-approved plan required by --broadcast
  --approval-commitment <h>  Externally recorded approval digest required by --broadcast`;

const ROLE_NAMES = ["deployer", "lender", "borrower", "guardian"];
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const IMMUTABLE_COUNTS = Object.freeze({
  PolicyKernelV2: 3,
  PolicyRegistryV1: 0,
  CappedPilotFactoryV1: 12,
  MultiChainEventPolicyV1: 1,
  ProofJobsV1: 1,
  VerifiedCreditStateV1: 1,
});

function nonzeroAddress(value, label) {
  const address = getAddress(value);
  if (address === ZERO_ADDRESS)
    throw new Error(`${label} must not be the zero address`);
  return address;
}

function requiredObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
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
    throw new Error(
      `${label} must be a positive integer no greater than ${maximum}`,
    );
  }
  return value;
}

function nonnegativeInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(
      `${label} must be a nonnegative integer no greater than ${maximum}`,
    );
  }
  return value;
}

function positiveDecimal(value, label) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${label} must be a positive base-10 integer string`);
  }
  return BigInt(value);
}

function digest(value, label) {
  if (!isHexString(value, 32) || /^0x0{64}$/i.test(value)) {
    throw new Error(`${label} must be a nonzero keccak256 digest`);
  }
  return value.toLowerCase();
}

function sourceCommit(value) {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error("sourceCommit must be a 40-hex Git commit");
  }
  return value.toLowerCase();
}

function canonicalJson(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function canonicalText(value) {
  return JSON.stringify(canonicalJson(value));
}

function commitment(value) {
  return keccak256(toUtf8Bytes(canonicalText(value)));
}

function transactionFeePolicy(value, label) {
  const input = requiredObject(value, label);
  if (
    input.transactionType !== "eip1559" &&
    input.transactionType !== "legacy"
  ) {
    throw new Error(`${label}.transactionType must be eip1559 or legacy`);
  }
  const normalized = {
    transactionType: input.transactionType,
    maximumGasLimit: positiveDecimal(
      input.maximumGasLimit,
      `${label}.maximumGasLimit`,
    ),
  };
  if (input.transactionType === "eip1559") {
    if (input.maximumGasPrice !== undefined)
      throw new Error(`${label} mixes legacy and EIP-1559 fee fields`);
    normalized.maximumFeePerGas = positiveDecimal(
      input.maximumFeePerGas,
      `${label}.maximumFeePerGas`,
    );
    normalized.maximumPriorityFeePerGas = positiveDecimal(
      input.maximumPriorityFeePerGas,
      `${label}.maximumPriorityFeePerGas`,
    );
    if (normalized.maximumPriorityFeePerGas > normalized.maximumFeePerGas) {
      throw new Error(
        `${label}.maximumPriorityFeePerGas must not exceed maximumFeePerGas`,
      );
    }
  } else {
    if (
      input.maximumFeePerGas !== undefined ||
      input.maximumPriorityFeePerGas !== undefined
    ) {
      throw new Error(`${label} mixes legacy and EIP-1559 fee fields`);
    }
    normalized.maximumGasPrice = positiveDecimal(
      input.maximumGasPrice,
      `${label}.maximumGasPrice`,
    );
  }
  return normalized;
}

function transactionFeePolicyRecord(policy) {
  return policy.transactionType === "eip1559"
    ? {
        transactionType: "eip1559",
        maximumGasLimit: policy.maximumGasLimit.toString(),
        maximumFeePerGas: policy.maximumFeePerGas.toString(),
        maximumPriorityFeePerGas: policy.maximumPriorityFeePerGas.toString(),
      }
    : {
        transactionType: "legacy",
        maximumGasLimit: policy.maximumGasLimit.toString(),
        maximumGasPrice: policy.maximumGasPrice.toString(),
      };
}

function transactionFeeFields(transaction, policy, label) {
  const gasLimit = BigInt(transaction.gasLimit ?? 0);
  if (gasLimit === 0n) throw new Error(`${label} gasLimit must be positive`);
  if (gasLimit > policy.maximumGasLimit)
    throw new Error(`${label} gasLimit exceeds the configured maximum`);
  if (policy.transactionType === "eip1559") {
    if (Number(transaction.type) !== 2)
      throw new Error(`${label} requires an EIP-1559 transaction`);
    if (
      transaction.gasPrice != null ||
      transaction.maxFeePerGas == null ||
      transaction.maxPriorityFeePerGas == null
    ) {
      throw new Error(`${label} mixes legacy and EIP-1559 fee fields`);
    }
    const maxFeePerGas = BigInt(transaction.maxFeePerGas);
    const maxPriorityFeePerGas = BigInt(transaction.maxPriorityFeePerGas);
    if (maxFeePerGas === 0n || maxPriorityFeePerGas === 0n) {
      throw new Error(`${label} EIP-1559 fee fields must be positive`);
    }
    if (maxFeePerGas > policy.maximumFeePerGas) {
      throw new Error(
        `${label} maximumFeePerGas exceeds the configured maximum`,
      );
    }
    if (maxPriorityFeePerGas > policy.maximumPriorityFeePerGas) {
      throw new Error(
        `${label} maximumPriorityFeePerGas exceeds the configured maximum`,
      );
    }
    if (maxPriorityFeePerGas > maxFeePerGas) {
      throw new Error(
        `${label} maximumPriorityFeePerGas exceeds maximumFeePerGas`,
      );
    }
    return {
      type: 2,
      gasLimit: gasLimit.toString(),
      gasPrice: null,
      maxFeePerGas: maxFeePerGas.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
    };
  }
  if (
    Number(transaction.type) !== 0 ||
    transaction.gasPrice == null ||
    transaction.maxFeePerGas != null ||
    transaction.maxPriorityFeePerGas != null
  ) {
    throw new Error(`${label} mixes legacy and EIP-1559 fee fields`);
  }
  const gasPrice = BigInt(transaction.gasPrice);
  if (gasPrice === 0n) throw new Error(`${label} gasPrice must be positive`);
  if (gasPrice > policy.maximumGasPrice)
    throw new Error(`${label} gasPrice exceeds the configured maximum`);
  return {
    type: 0,
    gasLimit: gasLimit.toString(),
    gasPrice: gasPrice.toString(),
    maxFeePerGas: null,
    maxPriorityFeePerGas: null,
  };
}

function roleAddress(roles, role, label) {
  if (!ROLE_NAMES.includes(role))
    throw new Error(`${label} has unknown role ${role}`);
  return roles[role];
}

function normalizeBalanceRequirements(requirements, roles) {
  const nativeBalances = requiredArray(
    requirements.nativeBalances,
    "requirements.nativeBalances",
  ).map((requirement, index) => {
    const value = requiredObject(
      requirement,
      `requirements.nativeBalances[${index}]`,
    );
    return {
      role: value.role,
      address: roleAddress(
        roles,
        value.role,
        `requirements.nativeBalances[${index}]`,
      ),
      minimumWei: positiveDecimal(
        value.minimumWei,
        `requirements.nativeBalances[${index}].minimumWei`,
      ),
    };
  });
  const assetBalances = requiredArray(
    requirements.assetBalances,
    "requirements.assetBalances",
  ).map((requirement, index) => {
    const value = requiredObject(
      requirement,
      `requirements.assetBalances[${index}]`,
    );
    return {
      role: value.role,
      address: roleAddress(
        roles,
        value.role,
        `requirements.assetBalances[${index}]`,
      ),
      minimumBaseUnits: positiveDecimal(
        value.minimumBaseUnits,
        `requirements.assetBalances[${index}].minimumBaseUnits`,
      ),
    };
  });
  const assetAllowances = requiredArray(
    requirements.assetAllowances,
    "requirements.assetAllowances",
  ).map((requirement, index) => {
    const value = requiredObject(
      requirement,
      `requirements.assetAllowances[${index}]`,
    );
    return {
      ownerRole: value.ownerRole,
      owner: roleAddress(
        roles,
        value.ownerRole,
        `requirements.assetAllowances[${index}]`,
      ),
      spender: getAddress(value.spender),
      minimumBaseUnits: positiveDecimal(
        value.minimumBaseUnits,
        `requirements.assetAllowances[${index}].minimumBaseUnits`,
      ),
    };
  });
  return { nativeBalances, assetBalances, assetAllowances };
}

export function parseV3DeploymentArguments(args) {
  const parsed = {
    help: false,
    broadcast: false,
    liveCheck: false,
    configPath: "config/v3-cc3.json",
    manifestPath: "deployments-v3.json",
    writePlanPath: undefined,
    approvedPlanPath: undefined,
    approvalCommitment: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
    } else if (argument === "--live-check") {
      parsed.liveCheck = true;
    } else if (argument === "--broadcast") {
      parsed.broadcast = true;
    } else if (argument === "--approval-commitment") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--approval-commitment requires a digest");
      }
      parsed.approvalCommitment = digest(value, "approval commitment");
      index += 1;
    } else if (
      argument === "--config" ||
      argument === "--manifest" ||
      argument === "--write-plan" ||
      argument === "--approved-plan"
    ) {
      const value = args[index + 1];
      if (!value || value.startsWith("--"))
        throw new Error(`${argument} requires a path`);
      if (argument === "--config") parsed.configPath = value;
      else if (argument === "--manifest") parsed.manifestPath = value;
      else if (argument === "--write-plan") parsed.writePlanPath = value;
      else parsed.approvedPlanPath = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (
    parsed.broadcast &&
    (!parsed.liveCheck ||
      !parsed.approvedPlanPath ||
      !parsed.approvalCommitment)
  ) {
    throw new Error(
      "--broadcast requires --live-check, --approved-plan, and --approval-commitment",
    );
  }
  if (parsed.writePlanPath && !parsed.liveCheck)
    throw new Error("--write-plan requires --live-check");
  if (parsed.writePlanPath && parsed.broadcast)
    throw new Error("--write-plan cannot be combined with --broadcast");
  if (parsed.approvedPlanPath && !parsed.broadcast)
    throw new Error("--approved-plan requires --broadcast");
  if (parsed.approvalCommitment && !parsed.broadcast)
    throw new Error("--approval-commitment requires --broadcast");
  return parsed;
}

export function validateV3DeploymentConfig(input) {
  const config = requiredObject(input, "config");
  if (config.generation !== "v3-core")
    throw new Error("generation must be v3-core");
  if (config.chainId !== EXPECTED_V3_CHAIN_ID) {
    throw new Error(`chainId must be ${EXPECTED_V3_CHAIN_ID}`);
  }
  const verifier = getAddress(config.verifier);
  if (verifier !== EXPECTED_V3_VERIFIER)
    throw new Error(`verifier must be ${EXPECTED_V3_VERIFIER}`);

  const assetInput = requiredObject(config.asset, "asset");
  const asset = {
    address: nonzeroAddress(assetInput.address, "asset.address"),
    decimals: nonnegativeInteger(assetInput.decimals, "asset.decimals", 255),
  };
  const roleInput = requiredObject(config.roles, "roles");
  const roles = Object.fromEntries(
    ROLE_NAMES.map((role) => [
      role,
      nonzeroAddress(roleInput[role], `roles.${role}`),
    ]),
  );
  if (new Set(Object.values(roles)).size !== ROLE_NAMES.length) {
    throw new Error("V3 deployment roles must be distinct");
  }

  const boundsInput = requiredObject(config.pilotBounds, "pilotBounds");
  const pilotBounds = {
    maximumFacilityLimit: positiveDecimal(
      boundsInput.maximumFacilityLimit,
      "pilotBounds.maximumFacilityLimit",
    ),
    maximumTotalLimit: positiveDecimal(
      boundsInput.maximumTotalLimit,
      "pilotBounds.maximumTotalLimit",
    ),
    minimumBondBps: positiveInteger(
      boundsInput.minimumBondBps,
      "pilotBounds.minimumBondBps",
      10_000,
    ),
    maximumDrawFeeBps: nonnegativeInteger(
      boundsInput.maximumDrawFeeBps,
      "pilotBounds.maximumDrawFeeBps",
      10_000,
    ),
    maximumMaturityBlocks: positiveInteger(
      boundsInput.maximumMaturityBlocks,
      "pilotBounds.maximumMaturityBlocks",
      Number.MAX_SAFE_INTEGER,
    ),
    maximumDrawDelayBlocks: nonnegativeInteger(
      boundsInput.maximumDrawDelayBlocks,
      "pilotBounds.maximumDrawDelayBlocks",
      0xffffffff,
    ),
    maximumFacilityCount: positiveInteger(
      boundsInput.maximumFacilityCount,
      "pilotBounds.maximumFacilityCount",
      0xffff,
    ),
  };
  if (pilotBounds.maximumTotalLimit < pilotBounds.maximumFacilityLimit) {
    throw new Error(
      "pilotBounds.maximumTotalLimit must be at least maximumFacilityLimit",
    );
  }

  const requirements = normalizeBalanceRequirements(
    requiredObject(config.requirements, "requirements"),
    roles,
  );
  const artifactInput = requiredObject(config.artifacts, "artifacts");
  const artifacts = Object.fromEntries(
    CORE_ARTIFACT_NAMES.map((name) => {
      const value = requiredObject(artifactInput[name], `${name} artifact`);
      if (typeof value.path !== "string" || value.path.length === 0) {
        throw new Error(`${name} artifact path is required`);
      }
      const normalizedPath = value.path.replaceAll("\\", "/");
      if (
        normalizedPath.startsWith("/") ||
        /^[A-Za-z]:\//.test(normalizedPath) ||
        normalizedPath.split("/").includes("..")
      ) {
        throw new Error(
          `${name} artifact path must stay inside the repository`,
        );
      }
      return [
        name,
        {
          path: normalizedPath,
          keccak256: digest(value.keccak256, `${name} artifact keccak256`),
        },
      ];
    }),
  );
  const transactionPolicyInput = requiredObject(
    config.transactionPolicy,
    "transactionPolicy",
  );
  const transactionPolicy = {
    targetConfirmations: positiveInteger(
      transactionPolicyInput.targetConfirmations,
      "transactionPolicy.targetConfirmations",
      256,
    ),
    maximumReceiptPolls: positiveInteger(
      transactionPolicyInput.maximumReceiptPolls,
      "transactionPolicy.maximumReceiptPolls",
      10_000,
    ),
    feePolicy: transactionFeePolicy(
      transactionPolicyInput.feePolicy,
      "transactionPolicy.feePolicy",
    ),
  };
  if (
    transactionPolicy.maximumReceiptPolls <
    transactionPolicy.targetConfirmations
  ) {
    throw new Error("Maximum receipt polls must cover confirmation depth");
  }
  return {
    generation: config.generation,
    chainId: config.chainId,
    verifier,
    asset,
    roles,
    pilotBounds,
    requirements,
    artifacts,
    transactionPolicy,
  };
}

export function readV3DeploymentConfig(
  path,
  repositoryDirectory = process.cwd(),
) {
  const configSource = inspectTrackedRepositoryFile(repositoryDirectory, path);
  return {
    ...validateV3DeploymentConfig(
      JSON.parse(
        readFileSync(resolve(repositoryDirectory, configSource.path), "utf8"),
      ),
    ),
    configSource,
  };
}

function v3DeploymentConfigCommitment(config) {
  return config.configSource
    ? commitment({ gitBlob: config.configSource.blobHash })
    : commitment(config);
}

export function readCoreArtifacts(config, rootDirectory = process.cwd()) {
  return Object.fromEntries(
    CORE_ARTIFACT_NAMES.map((name) => {
      const path = resolve(rootDirectory, config.artifacts[name].path);
      if (!existsSync(path))
        throw new Error(`Missing contract artifact: ${path}`);
      const raw = readFileSync(path);
      const hash = keccak256(raw);
      if (hash !== config.artifacts[name].keccak256)
        throw new Error(`${name} artifact hash mismatch`);
      const artifact = JSON.parse(raw.toString("utf8"));
      validateArtifact(name, artifact);
      return [name, { artifact, hash, path }];
    }),
  );
}

export function readCoreInterfaceArtifacts(rootDirectory = process.cwd()) {
  return Object.fromEntries(
    CORE_CONTRACT_NAMES.map((name) => {
      const path = resolve(rootDirectory, "out", `${name}.sol`, `${name}.json`);
      if (!existsSync(path))
        throw new Error(`Missing contract interface artifact: ${path}`);
      const artifact = JSON.parse(readFileSync(path, "utf8"));
      if (!Array.isArray(artifact.abi))
        throw new Error(`${name} artifact ABI is missing`);
      return [name, artifact];
    }),
  );
}

function validateArtifact(name, artifact) {
  if (!artifact || !Array.isArray(artifact.abi))
    throw new Error(`${name} artifact ABI is missing`);
  const bytecode = artifact.bytecode?.object;
  if (
    typeof bytecode !== "string" ||
    !/^0x[0-9a-fA-F]+$/.test(bytecode) ||
    bytecode === "0x"
  ) {
    throw new Error(`${name} artifact bytecode is missing`);
  }
  const deployedBytecode = artifact.deployedBytecode?.object;
  if (
    typeof deployedBytecode !== "string" ||
    !/^0x[0-9a-fA-F]+$/.test(deployedBytecode) ||
    deployedBytecode === "0x"
  ) {
    throw new Error(`${name} artifact deployed bytecode is missing`);
  }
}

function validateArtifacts(artifacts) {
  for (const name of CORE_ARTIFACT_NAMES) {
    const entry = artifacts[name];
    if (!entry || entry.hash !== digest(entry.hash, `${name} artifact hash`)) {
      throw new Error(`${name} artifact hash is missing`);
    }
    validateArtifact(name, entry.artifact);
  }
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

export async function buildV3DeploymentPlan({
  config,
  artifacts,
  startingNonce,
  sourceCommit: commit,
}) {
  validateArtifacts(artifacts);
  const nonce = nonnegativeInteger(startingNonce, "startingNonce");
  const normalizedCommit = sourceCommit(commit);
  const predictedContracts = Object.fromEntries(
    CORE_CONTRACT_NAMES.map((name, index) => [
      name,
      getCreateAddress({ from: config.roles.deployer, nonce: nonce + index }),
    ]),
  );
  const constructors = constructorArguments(
    config,
    predictedContracts.PolicyKernelV2,
  );
  const steps = [];
  for (const [index, name] of CORE_CONTRACT_NAMES.entries()) {
    const factory = new ContractFactory(
      artifacts[name].artifact.abi,
      artifacts[name].artifact.bytecode.object,
    );
    const transaction = await factory.getDeployTransaction(
      ...constructors[name],
    );
    if (!isHexString(transaction.data) || transaction.data === "0x") {
      throw new Error(`${name} deployment transaction is empty`);
    }
    steps.push({
      order: index + 1,
      name,
      chainId: config.chainId,
      nonce: nonce + index,
      from: config.roles.deployer,
      to: null,
      predictedContract: predictedContracts[name],
      data: transaction.data,
      dataHash: keccak256(transaction.data),
      value: "0",
    });
  }
  const wiringData = new Interface(
    artifacts.PolicyKernelV2.artifact.abi,
  ).encodeFunctionData("setProofJobs", [predictedContracts.ProofJobsV1]);
  steps.push({
    order: CORE_CONTRACT_NAMES.length + 1,
    name: "setProofJobs",
    chainId: config.chainId,
    nonce: nonce + CORE_CONTRACT_NAMES.length,
    from: config.roles.deployer,
    to: predictedContracts.PolicyKernelV2,
    predictedContract: null,
    data: wiringData,
    dataHash: keccak256(wiringData),
    value: "0",
  });
  const plan = {
    schemaVersion: 1,
    generation: config.generation,
    chainId: config.chainId,
    sourceCommit: normalizedCommit,
    ...(config.configSource ? { configSource: config.configSource } : {}),
    configCommitment: v3DeploymentConfigCommitment(config),
    startingNonce: nonce,
    predictedContracts,
    artifactHashes: Object.fromEntries(
      CORE_ARTIFACT_NAMES.map((name) => [name, artifacts[name].hash]),
    ),
    constructorArguments: canonicalJson(constructors),
    steps,
  };
  plan.planCommitment = commitment(plan);
  return plan;
}

function validateV3DeploymentPlan(config, plan) {
  if (
    plan?.schemaVersion !== 1 ||
    plan.generation !== config.generation ||
    plan.chainId !== config.chainId ||
    plan.configCommitment !== v3DeploymentConfigCommitment(config) ||
    sourceCommit(plan.sourceCommit) !== plan.sourceCommit ||
    !Array.isArray(plan.steps) ||
    plan.steps.length !== CORE_CONTRACT_NAMES.length + 1
  ) {
    throw new Error("Invalid V3 deployment plan");
  }
  if (
    plan.planCommitment !==
    commitment(
      Object.fromEntries(
        Object.entries(plan).filter(([key]) => key !== "planCommitment"),
      ),
    )
  ) {
    throw new Error("V3 deployment plan changed its plan commitment");
  }
  for (const name of CORE_ARTIFACT_NAMES) {
    if (plan.artifactHashes?.[name] !== config.artifacts[name].keccak256) {
      throw new Error(`${name} deployment plan artifact hash mismatch`);
    }
  }
  for (const [index, step] of plan.steps.entries()) {
    if (
      step?.order !== index + 1 ||
      step.chainId !== config.chainId ||
      step.nonce !== plan.startingNonce + index ||
      step.from !== config.roles.deployer ||
      !isHexString(step.data) ||
      step.dataHash !== keccak256(step.data) ||
      step.value !== "0"
    ) {
      throw new Error(`V3 deployment plan step ${index + 1} is invalid`);
    }
    if (index < CORE_CONTRACT_NAMES.length) {
      const name = CORE_CONTRACT_NAMES[index];
      if (
        step.name !== name ||
        step.to !== null ||
        step.predictedContract !== plan.predictedContracts?.[name] ||
        step.predictedContract !==
          getCreateAddress({ from: step.from, nonce: step.nonce })
      ) {
        throw new Error(`${name} deployment plan step is invalid`);
      }
    } else if (
      step.name !== "setProofJobs" ||
      step.to !== plan.predictedContracts?.PolicyKernelV2 ||
      step.predictedContract !== null
    ) {
      throw new Error("setProofJobs deployment plan step is invalid");
    }
  }
  return plan;
}

export async function buildV3DeploymentLiveExecutionPlan({
  config,
  plan,
  signer,
}) {
  validateV3DeploymentPlan(config, plan);
  sameAddress(
    await signer.getAddress(),
    config.roles.deployer,
    "V3 deployment signer",
  );
  const feePolicy = config.transactionPolicy.feePolicy;
  const steps = [];
  for (const step of plan.steps) {
    const populated = await signer.populateTransaction({
      type: feePolicy.transactionType === "eip1559" ? 2 : 0,
      chainId: step.chainId,
      nonce: step.nonce,
      ...(step.to === null ? {} : { to: step.to }),
      data: step.data,
      value: step.value,
      gasLimit: feePolicy.maximumGasLimit,
    });
    if (
      BigInt(populated.chainId) !== BigInt(step.chainId) ||
      populated.nonce !== step.nonce ||
      (step.to === null
        ? populated.to !== null && populated.to !== undefined
        : getAddress(populated.to) !== step.to) ||
      keccak256(populated.data) !== step.dataHash ||
      BigInt(populated.value ?? 0) !== 0n
    ) {
      throw new Error(`${step.name} populated transaction changed its plan`);
    }
    steps.push({
      ...step,
      ...transactionFeeFields(populated, feePolicy, step.name),
    });
  }
  const executionPlan = {
    schemaVersion: 1,
    feePolicy: transactionFeePolicyRecord(feePolicy),
    steps,
  };
  executionPlan.commitment = commitment(executionPlan);
  return executionPlan;
}

export function validateV3DeploymentLiveExecutionPlan({
  config,
  plan,
  executionPlan,
}) {
  validateV3DeploymentPlan(config, plan);
  if (
    executionPlan?.schemaVersion !== 1 ||
    !Array.isArray(executionPlan.steps) ||
    executionPlan.steps.length !== plan.steps.length ||
    canonicalText(executionPlan.feePolicy) !==
      canonicalText(
        transactionFeePolicyRecord(config.transactionPolicy.feePolicy),
      ) ||
    executionPlan.commitment !==
      commitment(
        Object.fromEntries(
          Object.entries(executionPlan).filter(([key]) => key !== "commitment"),
        ),
      )
  ) {
    throw new Error("Invalid V3 deployment live execution plan");
  }
  for (const [index, planned] of plan.steps.entries()) {
    const approved = executionPlan.steps[index];
    for (const field of [
      "order",
      "name",
      "chainId",
      "nonce",
      "from",
      "to",
      "predictedContract",
      "data",
      "dataHash",
      "value",
    ]) {
      if (approved?.[field] !== planned[field]) {
        throw new Error(
          `${planned.name} approved transaction changed its plan`,
        );
      }
    }
    const fees = transactionFeeFields(
      approved,
      config.transactionPolicy.feePolicy,
      planned.name,
    );
    for (const field of [
      "type",
      "gasLimit",
      "gasPrice",
      "maxFeePerGas",
      "maxPriorityFeePerGas",
    ]) {
      if (approved[field] !== fees[field])
        throw new Error(`${planned.name} approved ${field} is not canonical`);
    }
  }
  return executionPlan;
}

function normalizeQualification(value) {
  const qualification = requiredObject(value, "qualification");
  const normalized = {
    chainId: positiveInteger(qualification.chainId, "qualification.chainId"),
    blockNumber: nonnegativeInteger(
      qualification.blockNumber,
      "qualification.blockNumber",
    ),
    blockHash: digest(qualification.blockHash, "qualification.blockHash"),
    blockTimestamp: nonnegativeInteger(
      qualification.blockTimestamp,
      "qualification.blockTimestamp",
    ),
    pendingNonce: nonnegativeInteger(
      qualification.pendingNonce,
      "qualification.pendingNonce",
    ),
    deployer: nonzeroAddress(qualification.deployer, "qualification.deployer"),
    sourceCommit: sourceCommit(qualification.sourceCommit),
    artifactHashes: Object.fromEntries(
      CORE_ARTIFACT_NAMES.map((name) => [
        name,
        digest(
          qualification.artifactHashes?.[name],
          `qualification.artifactHashes.${name}`,
        ),
      ]),
    ),
    deployableScopeClean: qualification.deployableScopeClean === true,
  };
  if (!normalized.deployableScopeClean)
    throw new Error("V3 deployable source scope must be clean");
  return normalized;
}

function journalIdentity(journal) {
  return commitment({
    chainId: journal.chainId,
    configCommitment: journal.configCommitment,
    planCommitment: journal.planCommitment,
    sourceCommit: journal.sourceCommit,
    artifactHashes: journal.artifactHashes,
    predictedContracts: journal.predictedContracts,
    executionPlan: journal.executionPlan,
    qualification: journal.qualification,
  });
}

function renewalCheckpointStep(step) {
  return {
    name: step.name,
    status: step.status,
    transactionHash: step.intent?.transactionHash ?? null,
    receipt:
      step.status === "confirmed"
        ? {
            hash: step.receipt.hash,
            blockNumber: step.receipt.blockNumber,
            blockHash: step.receipt.blockHash,
            contractAddress: step.receipt.contractAddress,
            status: step.receipt.status,
          }
        : null,
  };
}

export function createV3DeploymentRenewalBinding(journal) {
  const binding = {
    schemaVersion: 1,
    journalIdentity: journalIdentity(journal),
    executionPlanCommitment: journal.executionPlan?.commitment,
    checkpoint: journal.steps.map(renewalCheckpointStep),
    remainingSteps: journal.steps
      .filter(({ status }) => status !== "confirmed")
      .map(({ name }) => name),
  };
  if (binding.remainingSteps.length === 0)
    throw new Error("Completed V3 deployment journal does not need renewal");
  binding.commitment = commitment(binding);
  return binding;
}

export function validateV3DeploymentRenewalBinding(binding, journal) {
  if (
    binding?.schemaVersion !== 1 ||
    binding.journalIdentity !== journalIdentity(journal) ||
    binding.executionPlanCommitment !== journal.executionPlan?.commitment ||
    !Array.isArray(binding.checkpoint) ||
    !Array.isArray(binding.remainingSteps) ||
    binding.commitment !==
      commitment(
        Object.fromEntries(
          Object.entries(binding).filter(([key]) => key !== "commitment"),
        ),
      )
  ) {
    throw new Error("V3 deployment renewal does not match its journal");
  }
  if (binding.checkpoint.length !== journal.steps.length) {
    throw new Error("V3 deployment renewal checkpoint length mismatch");
  }
  const statusRank = { planned: 0, prepared: 1, confirmed: 2 };
  for (const [index, current] of journal.steps.entries()) {
    const checkpoint = binding.checkpoint[index];
    if (
      checkpoint?.name !== current.name ||
      statusRank[checkpoint.status] === undefined ||
      statusRank[current.status] < statusRank[checkpoint.status]
    ) {
      throw new Error("V3 deployment journal regressed after renewal");
    }
    if (
      checkpoint.transactionHash !== null &&
      checkpoint.transactionHash !== current.intent?.transactionHash
    ) {
      throw new Error("V3 deployment transaction changed after renewal");
    }
    if (
      checkpoint.status === "confirmed" &&
      canonicalText(checkpoint.receipt) !== canonicalText(current.receipt)
    ) {
      throw new Error("V3 deployment receipt changed after renewal");
    }
  }
  const remainingSteps = binding.checkpoint
    .filter(({ status }) => status !== "confirmed")
    .map(({ name }) => name);
  if (canonicalText(binding.remainingSteps) !== canonicalText(remainingSteps)) {
    throw new Error("V3 deployment renewal remaining-step list mismatch");
  }
  return true;
}

export function createV3DeploymentApproval({
  config,
  plan,
  qualification,
  executionPlan,
  now,
  journal,
}) {
  validateV3DeploymentLiveExecutionPlan({ config, plan, executionPlan });
  const issuedAt = nonnegativeInteger(now, "approval issue time");
  const normalizedQualification = normalizeQualification(qualification);
  if (issuedAt !== normalizedQualification.blockTimestamp) {
    throw new Error(
      "V3 deployment approval issue time must equal its qualification timestamp",
    );
  }
  if (
    normalizedQualification.chainId !== config.chainId ||
    normalizedQualification.deployer !== config.roles.deployer ||
    normalizedQualification.sourceCommit !== plan.sourceCommit ||
    canonicalText(normalizedQualification.artifactHashes) !==
      canonicalText(plan.artifactHashes)
  ) {
    throw new Error("V3 deployment qualification does not match its plan");
  }
  const approval = {
    schemaVersion: 2,
    generation: config.generation,
    configCommitment: plan.configCommitment,
    planCommitment: plan.planCommitment,
    sourceCommit: plan.sourceCommit,
    artifactHashes: plan.artifactHashes,
    issuedAt,
    validUntil: issuedAt + V3_DEPLOYMENT_PLAN_VALIDITY_SECONDS,
    qualification: normalizedQualification,
    executionPlan,
    executionPlanCommitment: executionPlan.commitment,
    ...(journal === undefined
      ? {}
      : { renewal: createV3DeploymentRenewalBinding(journal) }),
  };
  approval.approvalCommitment = v3DeploymentApprovalCommitment(approval);
  return approval;
}

export function v3DeploymentApprovalCommitment(approval) {
  return commitment(
    Object.fromEntries(
      Object.entries(approval ?? {}).filter(
        ([key]) => key !== "approvalCommitment",
      ),
    ),
  );
}

export function validateV3DeploymentApproval({
  approval,
  expectedApprovalCommitment,
  config,
  plan,
  qualification,
  now,
  journal,
}) {
  const normalizedExpectedApprovalCommitment = digest(
    expectedApprovalCommitment,
    "expected approval commitment",
  );
  if (
    approval?.approvalCommitment !== normalizedExpectedApprovalCommitment ||
    approval.approvalCommitment !== v3DeploymentApprovalCommitment(approval)
  ) {
    throw new Error("Approved V3 deployment approval commitment mismatch");
  }
  if (
    approval?.schemaVersion !== 2 ||
    approval.generation !== config.generation ||
    approval.configCommitment !== plan.configCommitment ||
    approval.planCommitment !== plan.planCommitment ||
    approval.sourceCommit !== plan.sourceCommit ||
    canonicalText(approval.artifactHashes) !==
      canonicalText(plan.artifactHashes) ||
    approval.executionPlanCommitment !== approval.executionPlan?.commitment
  ) {
    throw new Error(
      "Approved V3 deployment plan does not match this deployment",
    );
  }
  validateV3DeploymentLiveExecutionPlan({
    config,
    plan,
    executionPlan: approval.executionPlan,
  });
  const issuedAt = nonnegativeInteger(approval.issuedAt, "approval issue time");
  const validUntil = nonnegativeInteger(approval.validUntil, "approval expiry");
  const currentTime = nonnegativeInteger(now, "approval validation time");
  if (
    validUntil !== issuedAt + V3_DEPLOYMENT_PLAN_VALIDITY_SECONDS ||
    currentTime < issuedAt ||
    currentTime > validUntil
  ) {
    throw new Error("Approved V3 deployment plan has expired");
  }
  const currentQualification = normalizeQualification(qualification);
  if (issuedAt !== currentQualification.blockTimestamp) {
    throw new Error("Approved V3 deployment qualification timestamp changed");
  }
  if (
    canonicalText(approval.qualification) !==
    canonicalText(currentQualification)
  ) {
    throw new Error("Approved V3 deployment qualification changed");
  }
  if (approval.renewal === undefined) {
    if (
      journal &&
      canonicalText(approval.qualification) !==
        canonicalText(journal.qualification)
    ) {
      throw new Error(
        "Partial V3 deployment approval does not match its original qualification",
      );
    }
  } else {
    if (!journal) throw new Error("V3 deployment renewal requires its journal");
    validateV3DeploymentRenewalBinding(approval.renewal, journal);
  }
  return approval;
}

export async function qualifyV3DeploymentState({
  provider,
  config,
  plan,
  journal,
  repositoryDirectory = process.cwd(),
  repositoryState,
}) {
  validateV3DeploymentPlan(config, plan);
  if (journal) validateV3DeploymentJournal({ journal, config, plan });
  const sourceState =
    repositoryState ?? inspectDeployableRepository(repositoryDirectory);
  if (sourceCommit(sourceState.head) !== plan.sourceCommit) {
    throw new Error("V3 deployment source commit changed");
  }
  if (sourceState.deployableScopeClean !== true) {
    throw new Error("V3 deployable source scope must be clean");
  }
  const [network, latestBlock, pendingNonce] = await Promise.all([
    provider.getNetwork(),
    provider.getBlock("latest"),
    provider.getTransactionCount(config.roles.deployer, "pending"),
  ]);
  if (network.chainId !== BigInt(config.chainId)) {
    throw new Error(
      `Wrong network: expected ${config.chainId}, got ${network.chainId}`,
    );
  }
  if (
    !latestBlock ||
    !Number.isSafeInteger(latestBlock.number) ||
    !isHexString(latestBlock.hash, 32) ||
    !Number.isSafeInteger(latestBlock.timestamp)
  ) {
    throw new Error("V3 deployment latest block is invalid");
  }
  const steps =
    journal?.steps ??
    plan.steps.map((step) => ({ ...step, status: "planned" }));
  const confirmedCount = steps.filter(
    ({ status }) => status === "confirmed",
  ).length;
  const preparedCount = steps.filter(
    ({ status }) => status === "prepared",
  ).length;
  const minimumNonce = plan.startingNonce + confirmedCount;
  const maximumNonce = minimumNonce + preparedCount;
  if (pendingNonce < minimumNonce || pendingNonce > maximumNonce) {
    throw new Error(
      `V3 deployer pending nonce does not match deployment progress: expected ${minimumNonce}-${maximumNonce}, got ${pendingNonce}`,
    );
  }
  await Promise.all(
    CORE_CONTRACT_NAMES.map(async (name, index) => {
      const code = await provider.getCode(plan.predictedContracts[name]);
      if (!isHexString(code))
        throw new Error(`${name} bytecode response is invalid`);
      const status = steps[index].status;
      if (status === "confirmed" && code === "0x")
        throw new Error(`${name} confirmed deployment has no bytecode`);
      if (status === "planned" && code !== "0x")
        throw new Error(`${name} predicted address already has bytecode`);
    }),
  );
  return {
    chainId: config.chainId,
    blockNumber: latestBlock.number,
    blockHash: latestBlock.hash.toLowerCase(),
    blockTimestamp: latestBlock.timestamp,
    pendingNonce,
    deployer: config.roles.deployer,
    sourceCommit: plan.sourceCommit,
    artifactHashes: plan.artifactHashes,
    deployableScopeClean: true,
  };
}

export async function verifyV3DeploymentApprovalAnchor({ approval, provider }) {
  const qualification = normalizeQualification(approval?.qualification);
  const [network, block] = await Promise.all([
    provider.getNetwork(),
    provider.getBlock(qualification.blockNumber),
  ]);
  if (
    network.chainId !== BigInt(qualification.chainId) ||
    block?.number !== qualification.blockNumber ||
    !block.hash ||
    block.hash.toLowerCase() !== qualification.blockHash ||
    block.timestamp !== qualification.blockTimestamp
  ) {
    throw new Error(
      "Approved V3 deployment chain anchor is no longer canonical: number, hash, timestamp, or network changed",
    );
  }
  return true;
}

export async function verifyV3DeploymentBlockAnchor({
  provider,
  verification,
}) {
  const blockNumber = nonnegativeInteger(
    verification?.verifiedAtBlock,
    "verification.verifiedAtBlock",
  );
  const blockHash = digest(
    verification?.verifiedAtBlockHash,
    "verification.verifiedAtBlockHash",
  );
  const block = await provider.getBlock(blockNumber);
  if (
    block?.number !== blockNumber ||
    block.hash?.toLowerCase() !== blockHash
  ) {
    throw new Error("V3 verification block is no longer canonical");
  }
  return true;
}

export function v3DeploymentJournalPath(manifestPath) {
  return `${resolve(manifestPath)}.v3-deployment-journal.json`;
}

function validateV3DeploymentJournal({ journal, config, plan }) {
  const qualification = normalizeQualification(journal?.qualification);
  if (
    journal?.schemaVersion !== 1 ||
    journal.generation !== config.generation ||
    (journal.phase !== "deploying" && journal.phase !== "complete") ||
    journal.chainId !== config.chainId ||
    journal.configCommitment !== plan.configCommitment ||
    journal.planCommitment !== plan.planCommitment ||
    journal.sourceCommit !== plan.sourceCommit ||
    canonicalText(journal.artifactHashes) !==
      canonicalText(plan.artifactHashes) ||
    canonicalText(journal.predictedContracts) !==
      canonicalText(plan.predictedContracts) ||
    canonicalText(journal.transactionPlan) !== canonicalText(plan.steps) ||
    journal.executionPlanCommitment !== journal.executionPlan?.commitment ||
    qualification.chainId !== config.chainId ||
    qualification.pendingNonce !== plan.startingNonce ||
    qualification.deployer !== config.roles.deployer ||
    qualification.sourceCommit !== plan.sourceCommit ||
    canonicalText(qualification.artifactHashes) !==
      canonicalText(plan.artifactHashes) ||
    !Array.isArray(journal.steps) ||
    journal.steps.length !== plan.steps.length
  ) {
    throw new Error("V3 deployment journal does not match its plan");
  }
  validateV3DeploymentLiveExecutionPlan({
    config,
    plan,
    executionPlan: journal.executionPlan,
  });
  const statusRank = { planned: 0, prepared: 1, confirmed: 2 };
  let previousRank = 2;
  for (const [index, step] of journal.steps.entries()) {
    const approved = journal.executionPlan.steps[index];
    const rank = statusRank[step?.status];
    if (rank === undefined || rank > previousRank)
      throw new Error("V3 deployment journal step order is invalid");
    previousRank = rank;
    for (const field of [
      "order",
      "name",
      "chainId",
      "nonce",
      "from",
      "to",
      "predictedContract",
      "data",
      "dataHash",
      "value",
      "type",
      "gasLimit",
      "gasPrice",
      "maxFeePerGas",
      "maxPriorityFeePerGas",
    ]) {
      if (step[field] !== approved[field])
        throw new Error(`${approved.name} journal transaction changed`);
    }
    if (step.status === "planned") {
      if (step.intent !== undefined || step.receipt !== undefined) {
        throw new Error(
          `${step.name} planned journal step has execution state`,
        );
      }
      continue;
    }
    if (!step.intent || !isHexString(step.intent.transactionHash, 32)) {
      throw new Error(`${step.name} journal intent is invalid`);
    }
    if (step.status === "prepared") {
      if (
        !isHexString(step.intent.rawTransaction) ||
        step.receipt !== undefined
      ) {
        throw new Error(`${step.name} prepared journal step is invalid`);
      }
      const transaction = validateSignedV3DeploymentStep(
        step.intent.rawTransaction,
        step,
      );
      if (transaction.hash.toLowerCase() !== step.intent.transactionHash) {
        throw new Error(`${step.name} prepared transaction hash changed`);
      }
    } else {
      if (step.intent.rawTransaction !== undefined || !step.receipt) {
        throw new Error(`${step.name} confirmed journal step is invalid`);
      }
      validateV3DeploymentReceipt(step.receipt, step.intent, step);
    }
  }
  if (
    journal.phase === "complete" &&
    journal.steps.some(({ status }) => status !== "confirmed")
  ) {
    throw new Error("Completed V3 deployment journal has unfinished steps");
  }
  return journal;
}

export function readV3DeploymentJournal({ manifestPath, config, plan }) {
  const path = v3DeploymentJournalPath(manifestPath);
  if (!existsSync(path)) return { path, journal: undefined };
  const journal = JSON.parse(readFileSync(path, "utf8"));
  validateV3DeploymentJournal({ journal, config, plan });
  return { path, journal };
}

export function initializeV3DeploymentJournal({
  manifestPath,
  config,
  plan,
  qualification,
  approval,
}) {
  validateV3DeploymentLiveExecutionPlan({
    config,
    plan,
    executionPlan: approval?.executionPlan,
  });
  if (approval.executionPlanCommitment !== approval.executionPlan.commitment) {
    throw new Error("V3 deployment approval has no valid execution plan");
  }
  const path = v3DeploymentJournalPath(manifestPath);
  if (existsSync(path)) {
    const { journal } = readV3DeploymentJournal({ manifestPath, config, plan });
    if (
      journal.executionPlanCommitment !== approval.executionPlanCommitment ||
      canonicalText(journal.executionPlan) !==
        canonicalText(approval.executionPlan)
    ) {
      throw new Error("V3 deployment journal does not match the approved plan");
    }
    return { path, journal };
  }
  const now = new Date().toISOString();
  const journal = {
    schemaVersion: 1,
    generation: config.generation,
    phase: "deploying",
    chainId: config.chainId,
    configCommitment: plan.configCommitment,
    planCommitment: plan.planCommitment,
    sourceCommit: plan.sourceCommit,
    artifactHashes: plan.artifactHashes,
    predictedContracts: plan.predictedContracts,
    transactionPlan: plan.steps,
    executionPlan: approval.executionPlan,
    executionPlanCommitment: approval.executionPlanCommitment,
    qualification: normalizeQualification(qualification),
    steps: approval.executionPlan.steps.map((step) => ({
      ...step,
      status: "planned",
    })),
    createdAt: now,
    updatedAt: now,
  };
  atomicWriteJson(path, journal);
  return { path, journal };
}

export function validateSignedV3DeploymentStep(transaction, step) {
  const parsed =
    typeof transaction === "string"
      ? Transaction.from(transaction)
      : transaction;
  if (
    !parsed.hash ||
    !parsed.from ||
    getAddress(parsed.from) !== step.from ||
    BigInt(parsed.chainId) !== BigInt(step.chainId) ||
    parsed.nonce !== step.nonce ||
    BigInt(parsed.value) !== BigInt(step.value) ||
    keccak256(parsed.data) !== step.dataHash ||
    (step.to === null
      ? parsed.to !== null
      : getAddress(parsed.to) !== step.to) ||
    Number(parsed.type) !== step.type ||
    BigInt(parsed.gasLimit) !== BigInt(step.gasLimit) ||
    (step.type === 2
      ? parsed.maxFeePerGas == null ||
        parsed.maxPriorityFeePerGas == null ||
        BigInt(parsed.maxFeePerGas) !== BigInt(step.maxFeePerGas) ||
        BigInt(parsed.maxPriorityFeePerGas) !==
          BigInt(step.maxPriorityFeePerGas) ||
        step.gasPrice !== null
      : step.type !== 0 ||
        parsed.gasPrice == null ||
        parsed.maxFeePerGas != null ||
        parsed.maxPriorityFeePerGas != null ||
        BigInt(parsed.gasPrice) !== BigInt(step.gasPrice) ||
        step.maxFeePerGas !== null ||
        step.maxPriorityFeePerGas !== null)
  ) {
    throw new Error(`${step.name} signed transaction does not match its plan`);
  }
  return parsed;
}

export async function prepareV3DeploymentStep({
  journal,
  journalPath,
  stepIndex,
  signer,
}) {
  const step = journal.steps[stepIndex];
  if (!step || step.status !== "planned")
    throw new Error(`V3 deployment step ${stepIndex + 1} is not planned`);
  sameAddress(await signer.getAddress(), step.from, `${step.name} signer`);
  const rawTransaction = await signer.signTransaction({
    type: step.type,
    chainId: step.chainId,
    nonce: step.nonce,
    ...(step.to === null ? {} : { to: step.to }),
    data: step.data,
    value: step.value,
    gasLimit: step.gasLimit,
    ...(step.type === 2
      ? {
          maxFeePerGas: step.maxFeePerGas,
          maxPriorityFeePerGas: step.maxPriorityFeePerGas,
        }
      : { gasPrice: step.gasPrice }),
  });
  const transaction = validateSignedV3DeploymentStep(rawTransaction, step);
  const intent = {
    transactionHash: transaction.hash.toLowerCase(),
    rawTransaction,
    chainId: transaction.chainId.toString(),
    from: getAddress(transaction.from),
    to: transaction.to === null ? null : getAddress(transaction.to),
    nonce: transaction.nonce,
    dataHash: keccak256(transaction.data),
    value: transaction.value.toString(),
    type: transaction.type,
    gasLimit: transaction.gasLimit.toString(),
    gasPrice: transaction.type === 0 ? transaction.gasPrice.toString() : null,
    maxFeePerGas:
      transaction.type === 2 ? transaction.maxFeePerGas.toString() : null,
    maxPriorityFeePerGas:
      transaction.type === 2
        ? transaction.maxPriorityFeePerGas.toString()
        : null,
  };
  const updated = {
    ...journal,
    steps: journal.steps.map((value, index) =>
      index === stepIndex ? { ...value, status: "prepared", intent } : value,
    ),
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJson(journalPath, updated, { overwrite: true });
  return updated;
}

function validateV3DeploymentReceipt(receipt, intent, step) {
  if (
    !receipt?.hash ||
    receipt.hash.toLowerCase() !== intent.transactionHash ||
    receipt.status !== 1 ||
    !Number.isSafeInteger(receipt.blockNumber) ||
    !isHexString(receipt.blockHash, 32)
  ) {
    throw new Error(`${step.name} receipt is invalid`);
  }
  const contractAddress = receipt.contractAddress
    ? getAddress(receipt.contractAddress)
    : null;
  if (contractAddress !== step.predictedContract) {
    throw new Error(`${step.name} created an unexpected contract address`);
  }
  if (
    step.status === "confirmed" &&
    (step.receipt?.hash !== receipt.hash.toLowerCase() ||
      step.receipt.blockNumber !== receipt.blockNumber ||
      step.receipt.blockHash !== receipt.blockHash.toLowerCase() ||
      step.receipt.contractAddress !== contractAddress)
  ) {
    throw new Error(`${step.name} receipt changed after confirmation`);
  }
}

export async function reconcileV3DeploymentStep({
  journal,
  journalPath,
  stepIndex,
  provider,
  targetConfirmations,
  maximumReceiptPolls,
  receiptPollIntervalMs = 1_000,
  beforeBroadcast = async () => {},
  delay = (milliseconds) =>
    new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
}) {
  const step = journal.steps[stepIndex];
  if (!step || step.status === "planned" || !step.intent) {
    throw new Error(`V3 deployment step ${stepIndex + 1} is not prepared`);
  }
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(step.chainId))
    throw new Error(`${step.name} journal chain mismatch`);
  targetConfirmations = positiveInteger(
    targetConfirmations,
    "target confirmations",
    256,
  );
  maximumReceiptPolls = positiveInteger(
    maximumReceiptPolls,
    "maximum receipt polls",
    10_000,
  );
  if (maximumReceiptPolls < targetConfirmations) {
    throw new Error("Maximum receipt polls must cover confirmation depth");
  }
  let receipt;
  let broadcastAttempted = false;
  let canonicallyConfirmed = false;
  for (let attempt = 0; attempt < maximumReceiptPolls; attempt += 1) {
    receipt = await provider.getTransactionReceipt(step.intent.transactionHash);
    if (receipt) {
      validateV3DeploymentReceipt(receipt, step.intent, step);
      const confirmedThrough =
        targetConfirmations === 1
          ? receipt.blockNumber
          : await provider.getBlockNumber();
      if (confirmedThrough >= receipt.blockNumber + targetConfirmations - 1) {
        const [canonicalBlock, confirmedReceipt, transaction] =
          await Promise.all([
            provider.getBlock(receipt.blockNumber),
            provider.getTransactionReceipt(step.intent.transactionHash),
            provider.getTransaction(step.intent.transactionHash),
          ]);
        validateV3DeploymentReceipt(confirmedReceipt, step.intent, step);
        if (
          canonicalBlock?.hash?.toLowerCase() !==
          confirmedReceipt.blockHash.toLowerCase()
        ) {
          throw new Error(`${step.name} receipt block is not canonical`);
        }
        const parsed = validateSignedV3DeploymentStep(transaction, step);
        if (parsed.hash.toLowerCase() !== step.intent.transactionHash) {
          throw new Error(`${step.name} canonical transaction hash mismatch`);
        }
        receipt = confirmedReceipt;
        canonicallyConfirmed = true;
        break;
      }
    } else {
      const transaction = await provider.getTransaction(
        step.intent.transactionHash,
      );
      if (transaction) {
        const parsed = validateSignedV3DeploymentStep(transaction, step);
        if (parsed.hash.toLowerCase() !== step.intent.transactionHash) {
          throw new Error(`${step.name} pending transaction hash mismatch`);
        }
      } else {
        if (!step.intent.rawTransaction)
          throw new Error(`${step.name} signed transaction is unavailable`);
        const [confirmedNonce, pendingNonce] = await Promise.all([
          provider.getTransactionCount(step.from, "latest"),
          provider.getTransactionCount(step.from, "pending"),
        ]);
        if (confirmedNonce > step.nonce || pendingNonce > step.nonce) {
          throw new Error(
            `${step.name} nonce ${step.nonce} was advanced or replaced`,
          );
        }
        if (!broadcastAttempted) {
          await beforeBroadcast();
          await provider.broadcastTransaction(step.intent.rawTransaction);
          broadcastAttempted = true;
        }
      }
    }
    if (attempt + 1 < maximumReceiptPolls) await delay(receiptPollIntervalMs);
  }
  if (!canonicallyConfirmed) {
    throw new Error(
      `${step.name} remains pending after ${maximumReceiptPolls} bounded receipt polls`,
    );
  }
  if (step.status === "confirmed")
    return { journal, receipt, broadcast: false };
  const { rawTransaction: _rawTransaction, ...confirmedIntent } = step.intent;
  const updated = {
    ...journal,
    steps: journal.steps.map((value, index) =>
      index === stepIndex
        ? {
            ...value,
            status: "confirmed",
            intent: confirmedIntent,
            receipt: {
              hash: receipt.hash.toLowerCase(),
              blockNumber: receipt.blockNumber,
              blockHash: receipt.blockHash.toLowerCase(),
              contractAddress: receipt.contractAddress
                ? getAddress(receipt.contractAddress)
                : null,
              status: receipt.status,
            },
          }
        : value,
    ),
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJson(journalPath, updated, { overwrite: true });
  return { journal: updated, receipt, broadcast: broadcastAttempted };
}

export function completeV3DeploymentJournal(
  journal,
  journalPath,
  manifestPath,
) {
  if (journal.steps.some(({ status }) => status !== "confirmed")) {
    throw new Error("Cannot complete a V3 deployment with unfinished steps");
  }
  const completed = {
    ...journal,
    phase: "complete",
    manifestPath: resolve(manifestPath),
    completedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJson(journalPath, completed, { overwrite: true });
  return completed;
}

export async function verifyV3DeploymentTransactions({
  manifest,
  config,
  plan,
  provider,
}) {
  validateV3DeploymentLiveExecutionPlan({
    config,
    plan,
    executionPlan: manifest.executionPlan,
  });
  if (manifest.executionPlanCommitment !== manifest.executionPlan.commitment) {
    throw new Error("V3 manifest execution plan commitment mismatch");
  }
  const verified = {};
  for (const step of manifest.executionPlan.steps) {
    const record = manifest.canonicalTransactions?.[step.name];
    if (!isHexString(record?.hash, 32))
      throw new Error(`Missing ${step.name} transaction evidence`);
    const [transaction, receipt] = await Promise.all([
      provider.getTransaction(record.hash),
      provider.getTransactionReceipt(record.hash),
    ]);
    if (
      !transaction ||
      transaction.hash?.toLowerCase() !== record.hash.toLowerCase()
    ) {
      throw new Error(`${step.name} canonical transaction is unavailable`);
    }
    validateSignedV3DeploymentStep(transaction, step);
    validateV3DeploymentReceipt(
      receipt,
      { transactionHash: record.hash.toLowerCase() },
      { ...step, status: "prepared" },
    );
    const canonicalBlock = await provider.getBlock(receipt.blockNumber);
    if (
      !canonicalBlock?.hash ||
      canonicalBlock.hash.toLowerCase() !== receipt.blockHash.toLowerCase()
    ) {
      throw new Error(`${step.name} receipt is no longer canonical`);
    }
    const expectedContractAddress = receipt.contractAddress
      ? getAddress(receipt.contractAddress)
      : null;
    if (
      getAddress(record.from) !== step.from ||
      (step.to === null
        ? record.to !== null
        : getAddress(record.to) !== step.to) ||
      record.nonce !== step.nonce ||
      record.dataHash !== step.dataHash ||
      record.blockNumber !== receipt.blockNumber ||
      record.blockHash?.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      record.contractAddress !== expectedContractAddress
    ) {
      throw new Error(`${step.name} manifest transaction evidence mismatch`);
    }
    verified[step.name] = {
      hash: record.hash.toLowerCase(),
      from: step.from,
      to: step.to,
      nonce: step.nonce,
      dataHash: step.dataHash,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash.toLowerCase(),
      contractAddress: expectedContractAddress,
    };
  }
  return verified;
}

export function buildV3DeploymentManifest({
  config,
  plan,
  journal,
  approval,
  verification,
  canonicalTransactions,
}) {
  validateV3DeploymentPlan(config, plan);
  validateV3DeploymentLiveExecutionPlan({
    config,
    plan,
    executionPlan: journal?.executionPlan,
  });
  if (
    journal.executionPlanCommitment !== journal.executionPlan.commitment ||
    !Array.isArray(journal.steps) ||
    journal.steps.length !== plan.steps.length ||
    journal.steps.some(({ status }) => status !== "confirmed")
  ) {
    throw new Error("V3 deployment journal is not complete");
  }
  validateV3DeploymentApproval({
    approval,
    expectedApprovalCommitment: approval?.approvalCommitment,
    config,
    plan,
    qualification: approval?.qualification,
    now: approval?.issuedAt,
    journal,
  });
  if (
    approval?.executionPlanCommitment !== journal.executionPlan.commitment ||
    canonicalText(approval.executionPlan) !==
      canonicalText(journal.executionPlan)
  ) {
    throw new Error(
      "V3 deployment approval does not match the completed journal",
    );
  }
  const transactionNames = plan.steps.map(({ name }) => name);
  if (
    !canonicalTransactions ||
    canonicalText(Object.keys(canonicalTransactions)) !==
      canonicalText(transactionNames)
  ) {
    throw new Error("V3 canonical transaction set mismatch");
  }
  for (const [index, name] of transactionNames.entries()) {
    const canonical = canonicalTransactions[name];
    const receipt = journal.steps[index].receipt;
    if (
      !canonical ||
      !receipt ||
      canonical.hash?.toLowerCase() !== receipt.hash?.toLowerCase() ||
      canonical.blockNumber !== receipt.blockNumber ||
      canonical.blockHash?.toLowerCase() !== receipt.blockHash?.toLowerCase() ||
      canonical.contractAddress !== receipt.contractAddress
    ) {
      throw new Error(
        `${name} canonical transaction differs from the completed journal`,
      );
    }
  }
  const expectedCreditState = getCreateAddress({
    from: plan.predictedContracts.PolicyKernelV2,
    nonce: 1,
  });
  sameAddress(
    verification.creditState,
    expectedCreditState,
    "Verified Credit State address",
  );
  const runtimeCodeHashes = Object.fromEntries(
    CORE_ARTIFACT_NAMES.map((name) => [
      name,
      digest(
        verification.runtimeCodeHashes?.[name],
        `${name} runtime code hash`,
      ),
    ]),
  );
  const block = nonnegativeInteger(
    verification.verifiedAtBlock,
    "verifiedAtBlock",
  );
  const blockHash = digest(
    verification.verifiedAtBlockHash,
    "verifiedAtBlockHash",
  );
  for (const name of transactionNames) {
    if (
      block <
      canonicalTransactions[name].blockNumber +
        config.transactionPolicy.targetConfirmations -
        1
    ) {
      throw new Error(
        "V3 verification block does not prove configured confirmation depth",
      );
    }
  }
  const legacyNames = {
    PolicyKernelV2: "policyKernel",
    PolicyRegistryV1: "policyRegistry",
    CappedPilotFactoryV1: "cappedPilotFactory",
    MultiChainEventPolicyV1: "multiChainEventPolicy",
    ProofJobsV1: "proofJobs",
  };
  return {
    schemaVersion: 2,
    status: "deployed-qualified",
    generation: config.generation,
    chainId: config.chainId,
    sourceCommit: plan.sourceCommit,
    ...(plan.configSource ? { configSource: plan.configSource } : {}),
    configCommitment: plan.configCommitment,
    planCommitment: plan.planCommitment,
    verifier: config.verifier,
    asset: config.asset,
    roles: config.roles,
    pilotBounds: {
      ...config.pilotBounds,
      maximumFacilityLimit: config.pilotBounds.maximumFacilityLimit.toString(),
      maximumTotalLimit: config.pilotBounds.maximumTotalLimit.toString(),
    },
    artifactHashes: plan.artifactHashes,
    runtimeCodeHashes,
    constructorArguments: plan.constructorArguments,
    contracts: {
      policyKernel: plan.predictedContracts.PolicyKernelV2,
      verifiedCreditState: getAddress(verification.creditState),
      policyRegistry: plan.predictedContracts.PolicyRegistryV1,
      cappedPilotFactory: plan.predictedContracts.CappedPilotFactoryV1,
      multiChainEventPolicy: plan.predictedContracts.MultiChainEventPolicyV1,
      proofJobs: plan.predictedContracts.ProofJobsV1,
    },
    transactions: {
      ...Object.fromEntries(
        CORE_CONTRACT_NAMES.map((name) => [
          legacyNames[name],
          canonicalTransactions[name].hash.toLowerCase(),
        ]),
      ),
      setProofJobs: canonicalTransactions.setProofJobs.hash.toLowerCase(),
    },
    canonicalTransactions,
    deploymentBlocks: Object.fromEntries(
      CORE_CONTRACT_NAMES.map((name) => [
        name,
        canonicalTransactions[name].blockNumber,
      ]),
    ),
    wiringVerifiedAtBlock: block,
    verifiedAtBlock: block,
    verifiedAtBlockHash: blockHash,
    transactionPolicy: {
      targetConfirmations: config.transactionPolicy.targetConfirmations,
      maximumReceiptPolls: config.transactionPolicy.maximumReceiptPolls,
      feePolicy: transactionFeePolicyRecord(config.transactionPolicy.feePolicy),
    },
    transactionPlan: plan.steps,
    executionPlan: journal.executionPlan,
    executionPlanCommitment: journal.executionPlan.commitment,
    approvedPlan: {
      qualification: approval.qualification,
      issuedAt: approval.issuedAt,
      validUntil: approval.validUntil,
      executionPlanCommitment: approval.executionPlanCommitment,
      renewalCommitment: approval.renewal?.commitment ?? null,
    },
    activation: {
      facilitiesCreated: 0,
      policiesConfigured: 0,
      registryClaimsPublished: 0,
      assetsTransferred: "0",
    },
  };
}

export function validateV3DeploymentManifest({
  manifest,
  config,
  plan,
  verification,
  canonicalTransactions,
}) {
  validateV3DeploymentPlan(config, plan);
  validateV3DeploymentLiveExecutionPlan({
    config,
    plan,
    executionPlan: manifest?.executionPlan,
  });
  const expectedCreditState = getCreateAddress({
    from: plan.predictedContracts.PolicyKernelV2,
    nonce: 1,
  });
  sameAddress(
    verification.creditState,
    expectedCreditState,
    "Verified Credit State address",
  );
  const expectedContracts = {
    policyKernel: plan.predictedContracts.PolicyKernelV2,
    verifiedCreditState: expectedCreditState,
    policyRegistry: plan.predictedContracts.PolicyRegistryV1,
    cappedPilotFactory: plan.predictedContracts.CappedPilotFactoryV1,
    multiChainEventPolicy: plan.predictedContracts.MultiChainEventPolicyV1,
    proofJobs: plan.predictedContracts.ProofJobsV1,
  };
  const legacyNames = {
    PolicyKernelV2: "policyKernel",
    PolicyRegistryV1: "policyRegistry",
    CappedPilotFactoryV1: "cappedPilotFactory",
    MultiChainEventPolicyV1: "multiChainEventPolicy",
    ProofJobsV1: "proofJobs",
  };
  const expectedTransactions = {
    ...Object.fromEntries(
      CORE_CONTRACT_NAMES.map((name) => [
        legacyNames[name],
        canonicalTransactions[name].hash.toLowerCase(),
      ]),
    ),
    setProofJobs: canonicalTransactions.setProofJobs.hash.toLowerCase(),
  };
  const expectedDeploymentBlocks = Object.fromEntries(
    CORE_CONTRACT_NAMES.map((name) => [
      name,
      canonicalTransactions[name].blockNumber,
    ]),
  );
  const expectedRuntimeHashes = Object.fromEntries(
    CORE_ARTIFACT_NAMES.map((name) => [
      name,
      digest(
        verification.runtimeCodeHashes?.[name],
        `${name} runtime code hash`,
      ),
    ]),
  );
  const expectedPilotBounds = {
    ...config.pilotBounds,
    maximumFacilityLimit: config.pilotBounds.maximumFacilityLimit.toString(),
    maximumTotalLimit: config.pilotBounds.maximumTotalLimit.toString(),
  };
  const expectedTransactionPolicy = {
    targetConfirmations: config.transactionPolicy.targetConfirmations,
    maximumReceiptPolls: config.transactionPolicy.maximumReceiptPolls,
    feePolicy: transactionFeePolicyRecord(config.transactionPolicy.feePolicy),
  };
  const approvedQualification = normalizeQualification(
    manifest?.approvedPlan?.qualification,
  );
  const approvedIssuedAt = nonnegativeInteger(
    manifest.approvedPlan.issuedAt,
    "manifest approvedPlan.issuedAt",
  );
  const approvedValidUntil = nonnegativeInteger(
    manifest.approvedPlan.validUntil,
    "manifest approvedPlan.validUntil",
  );
  const expectedVerifiedAtBlock = nonnegativeInteger(
    verification.verifiedAtBlock,
    "verification.verifiedAtBlock",
  );
  const expectedVerifiedAtBlockHash = digest(
    verification.verifiedAtBlockHash,
    "verification.verifiedAtBlockHash",
  );
  for (const name of plan.steps.map(({ name }) => name)) {
    if (
      expectedVerifiedAtBlock <
      canonicalTransactions[name].blockNumber +
        config.transactionPolicy.targetConfirmations -
        1
    ) {
      throw new Error(
        "V3 verification block does not prove configured confirmation depth",
      );
    }
  }
  if (
    manifest.schemaVersion !== 2 ||
    manifest.status !== "deployed-qualified" ||
    manifest.generation !== config.generation ||
    manifest.chainId !== config.chainId ||
    manifest.sourceCommit !== plan.sourceCommit ||
    canonicalText(manifest.configSource) !== canonicalText(plan.configSource) ||
    manifest.configCommitment !== plan.configCommitment ||
    manifest.planCommitment !== plan.planCommitment ||
    manifest.verifier !== config.verifier ||
    canonicalText(manifest.asset) !== canonicalText(config.asset) ||
    canonicalText(manifest.roles) !== canonicalText(config.roles) ||
    canonicalText(manifest.pilotBounds) !==
      canonicalText(expectedPilotBounds) ||
    canonicalText(manifest.artifactHashes) !==
      canonicalText(plan.artifactHashes) ||
    canonicalText(manifest.runtimeCodeHashes) !==
      canonicalText(expectedRuntimeHashes) ||
    canonicalText(manifest.constructorArguments) !==
      canonicalText(plan.constructorArguments) ||
    canonicalText(manifest.contracts) !== canonicalText(expectedContracts) ||
    canonicalText(manifest.transactions) !==
      canonicalText(expectedTransactions) ||
    canonicalText(manifest.canonicalTransactions) !==
      canonicalText(canonicalTransactions) ||
    canonicalText(manifest.deploymentBlocks) !==
      canonicalText(expectedDeploymentBlocks) ||
    canonicalText(manifest.transactionPolicy) !==
      canonicalText(expectedTransactionPolicy) ||
    canonicalText(manifest.transactionPlan) !== canonicalText(plan.steps) ||
    manifest.executionPlanCommitment !== manifest.executionPlan.commitment ||
    manifest.approvedPlan.executionPlanCommitment !==
      manifest.executionPlan.commitment ||
    approvedValidUntil !==
      approvedIssuedAt + V3_DEPLOYMENT_PLAN_VALIDITY_SECONDS ||
    approvedQualification.chainId !== config.chainId ||
    approvedQualification.deployer !== config.roles.deployer ||
    approvedQualification.sourceCommit !== plan.sourceCommit ||
    canonicalText(approvedQualification.artifactHashes) !==
      canonicalText(plan.artifactHashes) ||
    manifest.wiringVerifiedAtBlock !== manifest.verifiedAtBlock ||
    manifest.verifiedAtBlock !== expectedVerifiedAtBlock ||
    manifest.verifiedAtBlockHash !== expectedVerifiedAtBlockHash ||
    canonicalText(manifest.activation) !==
      canonicalText({
        facilitiesCreated: 0,
        policiesConfigured: 0,
        registryClaimsPublished: 0,
        assetsTransferred: "0",
      })
  ) {
    throw new Error("V3 deployment manifest does not match its qualified plan");
  }
  return manifest;
}

export async function runV3DeploymentFundingPreflight({
  provider,
  deployer,
  steps,
}) {
  const address = nonzeroAddress(deployer, "V3 deployment funder");
  let requiredWei = 0n;
  for (const [index, input] of requiredArray(
    steps,
    "V3 deployment funding steps",
  ).entries()) {
    const step = requiredObject(
      input,
      `V3 deployment funding step ${index + 1}`,
    );
    const gasLimit = positiveDecimal(
      step.gasLimit,
      `V3 deployment funding step ${index + 1} gasLimit`,
    );
    const gasPrice =
      step.type === 2
        ? positiveDecimal(
            step.maxFeePerGas,
            `V3 deployment funding step ${index + 1} maxFeePerGas`,
          )
        : step.type === 0
          ? positiveDecimal(
              step.gasPrice,
              `V3 deployment funding step ${index + 1} gasPrice`,
            )
          : undefined;
    if (gasPrice === undefined) {
      throw new Error(
        `V3 deployment funding step ${index + 1} transaction type is invalid`,
      );
    }
    if (typeof step.value !== "string" || !/^[0-9]+$/.test(step.value)) {
      throw new Error(
        `V3 deployment funding step ${index + 1} value must be a base-10 integer string`,
      );
    }
    requiredWei += gasLimit * gasPrice + BigInt(step.value);
  }
  const availableWei = BigInt(await provider.getBalance(address));
  if (availableWei < requiredWei) {
    throw new Error(
      "Insufficient native balance for remaining V3 deployment transactions",
    );
  }
  return {
    deployer: address,
    remainingTransactions: steps.length,
    requiredWei: requiredWei.toString(),
    availableWei: availableWei.toString(),
  };
}

export async function runV3Preflight({
  provider,
  signer,
  verifier,
  asset,
  config,
  artifacts,
  checkConfiguredFunding = true,
}) {
  validateArtifacts(artifacts);
  if (typeof checkConfiguredFunding !== "boolean") {
    throw new Error("checkConfiguredFunding must be boolean");
  }
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(config.chainId)) {
    throw new Error(
      `Wrong network: expected ${config.chainId}, got ${network.chainId}`,
    );
  }
  const deployer = getAddress(await signer.getAddress());
  if (deployer !== config.roles.deployer)
    throw new Error("Deployer key does not match configured deployer address");

  const [emptyProofIndex, assetCode, decimals] = await Promise.all([
    verifier.calculateTxIndex([`0x${"00".repeat(32)}`, []]),
    provider.getCode(config.asset.address),
    asset.decimals(),
  ]);
  if (emptyProofIndex !== 0n)
    throw new Error("Native verifier returned an invalid empty-proof index");
  if (assetCode === "0x")
    throw new Error(`Asset has no bytecode at ${config.asset.address}`);
  if (Number(decimals) !== config.asset.decimals) {
    throw new Error(
      `Asset decimals mismatch: expected ${config.asset.decimals}, got ${decimals}`,
    );
  }

  if (checkConfiguredFunding) {
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
      const allowance = await asset.allowance(
        requirement.owner,
        requirement.spender,
      );
      if (allowance < requirement.minimumBaseUnits) {
        throw new Error(
          `Insufficient asset allowance for ${requirement.ownerRole}`,
        );
      }
    }
  }

  return {
    chainId: config.chainId,
    deployer,
    verifierPrecompileResponsive: true,
    assetCodePresent: true,
    checkedNativeBalances: checkConfiguredFunding
      ? config.requirements.nativeBalances.length
      : 0,
    checkedAssetBalances: checkConfiguredFunding
      ? config.requirements.assetBalances.length
      : 0,
    checkedAssetAllowances: checkConfiguredFunding
      ? config.requirements.assetAllowances.length
      : 0,
    checkedArtifacts: CORE_ARTIFACT_NAMES.length,
  };
}

function sameAddress(actual, expected, label) {
  if (getAddress(actual) !== getAddress(expected))
    throw new Error(`${label} mismatch`);
}

export function verifyV3RuntimeArtifacts({ artifacts, runtimeCodes }) {
  validateArtifacts(artifacts);
  return Object.fromEntries(
    CORE_ARTIFACT_NAMES.map((name) => [
      name,
      verifyPinnedArtifactRuntime({
        artifact: artifacts[name].artifact,
        liveCode: runtimeCodes[name],
        label: name,
        immutableCount: IMMUTABLE_COUNTS[name],
      }).runtimeCodeHash,
    ]),
  );
}

export async function verifyV3Deployment({
  provider,
  signerAddress,
  config,
  artifacts,
  addresses,
  blockTag = "latest",
}) {
  const [network, initialBlock] = await Promise.all([
    provider.getNetwork(),
    provider.getBlock(blockTag),
  ]);
  if (network.chainId !== BigInt(config.chainId)) {
    throw new Error("V3 verification network mismatch");
  }
  if (
    !initialBlock ||
    !Number.isSafeInteger(initialBlock.number) ||
    !isHexString(initialBlock.hash, 32)
  ) {
    throw new Error("V3 verification block is invalid");
  }
  const verifiedAtBlock = initialBlock.number;
  const verifiedAtBlockHash = initialBlock.hash.toLowerCase();
  const callOverrides = { blockTag: verifiedAtBlock };
  const contracts = Object.fromEntries(
    CORE_CONTRACT_NAMES.map((name) => [
      name,
      new Contract(addresses[name], artifacts[name].artifact.abi, provider),
    ]),
  );
  const creditState = await contracts.PolicyKernelV2.creditState(callOverrides);
  const expectedCreditState = getCreateAddress({
    from: addresses.PolicyKernelV2,
    nonce: 1,
  });
  sameAddress(
    creditState,
    expectedCreditState,
    "Verified Credit State address",
  );
  const runtimeAddresses = {
    ...addresses,
    VerifiedCreditStateV1: creditState,
  };
  const runtimeEntries = await Promise.all(
    CORE_ARTIFACT_NAMES.map(async (name) => [
      name,
      await provider.getCode(runtimeAddresses[name], verifiedAtBlock),
    ]),
  );
  const runtimeCodeHashes = verifyV3RuntimeArtifacts({
    artifacts,
    runtimeCodes: Object.fromEntries(runtimeEntries),
  });

  sameAddress(
    await contracts.PolicyKernelV2.verifier(callOverrides),
    config.verifier,
    "Kernel verifier",
  );
  sameAddress(
    await contracts.PolicyKernelV2.owner(callOverrides),
    signerAddress,
    "Kernel owner",
  );
  sameAddress(
    await contracts.PolicyKernelV2.proofJobs(callOverrides),
    addresses.ProofJobsV1,
    "Kernel ProofJobs",
  );
  if (
    (await contracts.PolicyKernelV2.safeStaleProofRelease(callOverrides)) !==
    true
  ) {
    throw new Error("Kernel stale-proof release safety is disabled");
  }
  sameAddress(
    await contracts.CappedPilotFactoryV1.asset(callOverrides),
    config.asset.address,
    "Factory asset",
  );
  sameAddress(
    await contracts.CappedPilotFactoryV1.kernel(callOverrides),
    addresses.PolicyKernelV2,
    "Factory kernel",
  );
  sameAddress(
    await contracts.CappedPilotFactoryV1.lender(callOverrides),
    config.roles.lender,
    "Factory lender",
  );
  sameAddress(
    await contracts.CappedPilotFactoryV1.borrower(callOverrides),
    config.roles.borrower,
    "Factory borrower",
  );
  sameAddress(
    await contracts.CappedPilotFactoryV1.guardian(callOverrides),
    config.roles.guardian,
    "Factory guardian",
  );
  if (
    (await contracts.CappedPilotFactoryV1.maximumFacilityLimit(
      callOverrides,
    )) !== config.pilotBounds.maximumFacilityLimit
  ) {
    throw new Error("Factory maximumFacilityLimit mismatch");
  }
  if (
    (await contracts.CappedPilotFactoryV1.maximumTotalLimit(callOverrides)) !==
    config.pilotBounds.maximumTotalLimit
  ) {
    throw new Error("Factory maximumTotalLimit mismatch");
  }
  if (
    Number(
      await contracts.CappedPilotFactoryV1.minimumBondBps(callOverrides),
    ) !== config.pilotBounds.minimumBondBps
  ) {
    throw new Error("Factory minimumBondBps mismatch");
  }
  if (
    Number(
      await contracts.CappedPilotFactoryV1.maximumDrawFeeBps(callOverrides),
    ) !== config.pilotBounds.maximumDrawFeeBps
  ) {
    throw new Error("Factory maximumDrawFeeBps mismatch");
  }
  if (
    Number(
      await contracts.CappedPilotFactoryV1.maximumMaturityBlocks(callOverrides),
    ) !== config.pilotBounds.maximumMaturityBlocks
  ) {
    throw new Error("Factory maximumMaturityBlocks mismatch");
  }
  if (
    Number(
      await contracts.CappedPilotFactoryV1.maximumDrawDelayBlocks(
        callOverrides,
      ),
    ) !== config.pilotBounds.maximumDrawDelayBlocks
  ) {
    throw new Error("Factory maximumDrawDelayBlocks mismatch");
  }
  if (
    Number(
      await contracts.CappedPilotFactoryV1.maximumFacilityCount(callOverrides),
    ) !== config.pilotBounds.maximumFacilityCount
  ) {
    throw new Error("Factory maximumFacilityCount mismatch");
  }
  if (
    (await contracts.CappedPilotFactoryV1.facilityCount(callOverrides)) !== 0n
  )
    throw new Error("Factory is not empty");
  if (
    (await contracts.CappedPilotFactoryV1.totalFacilityLimit(callOverrides)) !==
    0n
  )
    throw new Error("Factory limit is not empty");
  if (
    (await contracts.CappedPilotFactoryV1.creationPaused(callOverrides)) !==
    false
  )
    throw new Error("Factory creation is paused");
  sameAddress(
    await contracts.MultiChainEventPolicyV1.context(callOverrides),
    addresses.PolicyKernelV2,
    "Policy context",
  );
  sameAddress(
    await contracts.ProofJobsV1.kernel(callOverrides),
    addresses.PolicyKernelV2,
    "ProofJobs kernel",
  );
  const verifiedCreditState = new Contract(
    creditState,
    artifacts.VerifiedCreditStateV1.artifact.abi,
    provider,
  );
  sameAddress(
    await verifiedCreditState.kernel(callOverrides),
    addresses.PolicyKernelV2,
    "Verified Credit State kernel",
  );
  const verification = {
    creditState: getAddress(creditState),
    runtimeCodeHashes,
    verifiedAtBlock,
    verifiedAtBlockHash,
  };
  try {
    await verifyV3DeploymentBlockAnchor({ provider, verification });
  } catch {
    throw new Error("V3 verification block changed during qualification");
  }
  return verification;
}

function processIsAlive(pid) {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

export function reserveV3Manifest(
  path,
  { allowExistingManifest = false } = {},
) {
  const target = resolve(path);
  const lockPath = `${target}.lock`;
  const temporaryPath = `${target}.tmp`;
  const token = commitment({ pid: process.pid, now: Date.now(), target });
  let descriptor;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
      writeFileSync(
        descriptor,
        `${JSON.stringify({ schemaVersion: 1, pid: process.pid, token }, null, 2)}\n`,
      );
      fsyncSync(descriptor);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let existing;
      try {
        existing = JSON.parse(readFileSync(lockPath, "utf8"));
      } catch {
        throw new Error(`V3 deployment lock is unreadable: ${lockPath}`);
      }
      if (
        existing.schemaVersion !== 1 ||
        !Number.isSafeInteger(existing.pid) ||
        !isHexString(existing.token, 32)
      ) {
        throw new Error(`V3 deployment lock is invalid: ${lockPath}`);
      }
      if (processIsAlive(existing.pid))
        throw new Error(`V3 deployment lock already exists: ${lockPath}`);
      const stalePath = `${target}.stale.${existing.pid}.${existing.token.slice(2)}.lock`;
      renameSync(lockPath, stalePath);
      unlinkSync(stalePath);
    }
  }
  if (descriptor === undefined)
    throw new Error(`Unable to acquire V3 deployment lock: ${lockPath}`);

  try {
    if (existsSync(target) && !allowExistingManifest) {
      throw new Error(`V3 deployment manifest already exists: ${target}`);
    }
    if (existsSync(temporaryPath)) {
      throw new Error(`V3 temporary manifest already exists: ${temporaryPath}`);
    }
  } catch (error) {
    closeSync(descriptor);
    unlinkSync(lockPath);
    throw error;
  }

  let released = false;
  return () => {
    if (released) return;
    const current = JSON.parse(readFileSync(lockPath, "utf8"));
    if (current.token !== token)
      throw new Error(`V3 deployment lock ownership changed: ${lockPath}`);
    closeSync(descriptor);
    unlinkSync(lockPath);
    released = true;
  };
}

export function atomicWriteJson(path, value, { overwrite = false } = {}) {
  const target = resolve(path);
  if (!overwrite && existsSync(target))
    throw new Error(`Refusing to overwrite ${target}`);
  const temporaryPath = `${target}.tmp`;
  if (existsSync(temporaryPath))
    throw new Error(`Temporary file already exists: ${temporaryPath}`);
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(
      descriptor,
      `${JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item), 2)}\n`,
      "utf8",
    );
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, target);
    if (process.platform === "linux") {
      const directory = openSync(dirname(target), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}
