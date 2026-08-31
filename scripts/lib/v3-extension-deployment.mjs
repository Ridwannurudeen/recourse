import {
  Contract,
  ContractFactory,
  Interface,
  ZeroAddress,
  getAddress,
  getCreateAddress,
  isHexString,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  atomicWriteJson,
  completeV3DeploymentJournal,
  prepareV3DeploymentStep,
  reconcileV3DeploymentStep,
  reserveV3Manifest,
  validateSignedV3DeploymentStep,
} from "./v3-deployment.mjs";
import { verifyPinnedArtifactRuntime } from "./v3-activation.mjs";

export const V3_EXTENSION_PLAN_VALIDITY_SECONDS = 1_800;
export const V3_EXTENSION_GENERATIONS = Object.freeze([
  "v3-closed-loop-v1",
  "v3-operator-market-v1",
  "v3-portfolio-core-v1",
]);
export const V3_EXTENSION_USAGE = `Usage: node scripts/deploy-v3-extension.mjs [options]

Default: deterministic offline validation and planning; no RPC, signer, file write, or broadcast.

Options:
  --config <path>             Exact extension config (required)
  --manifest <path>           Deployment manifest/journal base (default: v3-extension-deployment.json)
  --live-check                Read and qualify current chain state
  --write-plan <path>         Write an expiring live plan for human approval
  --broadcast                 Broadcast only an exact approved live plan
  --approved-plan <path>      Human-approved live plan required by --broadcast
  --qualify-deployed          Re-qualify an existing deployment manifest without signing
  --help, -h                  Show this help and exit`;

const GENERATION_SPECS = Object.freeze({
  "v3-closed-loop-v1": Object.freeze({
    artifacts: Object.freeze(["ClosedLoopPolicyV1"]),
    prerequisites: Object.freeze(["core", "remedy"]),
    constructorTypes: Object.freeze({
      ClosedLoopPolicyV1: Object.freeze(["address", "address"]),
    }),
  }),
  "v3-operator-market-v1": Object.freeze({
    artifacts: Object.freeze(["OperatorMarketV1"]),
    prerequisites: Object.freeze(["verifier"]),
    constructorTypes: Object.freeze({
      OperatorMarketV1: Object.freeze([
        "address",
        "address",
        "uint256",
        "uint64",
        "uint64",
      ]),
    }),
  }),
  "v3-portfolio-core-v1": Object.freeze({
    artifacts: Object.freeze([
      "PortfolioPoolV1",
      "CappedPilotFactoryV1",
      "PortfolioMandateV1",
    ]),
    prerequisites: Object.freeze(["core"]),
    constructorTypes: Object.freeze({
      PortfolioPoolV1: Object.freeze([
        "address",
        "address",
        "uint256",
        "uint256",
        "uint64",
        "uint16",
        "uint64",
        "uint64",
      ]),
      CappedPilotFactoryV1: Object.freeze([
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
      ]),
      PortfolioMandateV1: Object.freeze([
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
      ]),
    }),
  }),
});

const ERC20_ABI = Object.freeze([
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
]);
const POLICY_REGISTRY_ABI = Object.freeze([
  "function packageRelease(bytes32 releaseId) view returns ((address issuer,string packageName,string version,address referenceImplementation,bytes32 buildArtifactHash,bytes32 referenceRuntimeCodeHash,bytes32 referenceVariantId,bytes32 metadataHash,bytes32 releaseContentHash,uint64 releasedAt,bool exists))",
  "function declaresEvidenceKind(bytes32 releaseId,uint8 evidenceKind) view returns (bool)",
  "function actionAdapterCount(bytes32 releaseId) view returns (uint256)",
  "function actionAdapterAt(bytes32 releaseId,uint256 index) view returns ((bytes32 adapterKind,bytes32 specificationHash,string metadataURI))",
]);
const IMMUTABLE_COUNTS = Object.freeze({
  ClosedLoopPolicyV1: 2,
  OperatorMarketV1: 5,
  PortfolioPoolV1: 9,
  CappedPilotFactoryV1: 12,
  PortfolioMandateV1: 12,
});

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJson(item)]),
    );
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

function canonicalText(value) {
  return JSON.stringify(canonicalJson(value));
}

function commitment(value) {
  return keccak256(toUtf8Bytes(canonicalText(value)));
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(object(value, label)).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} must contain exactly ${wanted.join(", ")}`);
  }
}

function integer(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${label} must be a nonnegative safe integer`);
  }
  return value;
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  const normalized = integer(value, label, maximum);
  if (normalized === 0) throw new Error(`${label} must be positive`);
  return normalized;
}

function decimal(value, label, { positive = false } = {}) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} must be an unsigned decimal string`);
  }
  const normalized = BigInt(value);
  if (positive && normalized === 0n)
    throw new Error(`${label} must be positive`);
  return normalized.toString();
}

function digest(value, label) {
  if (!isHexString(value, 32)) throw new Error(`${label} must be bytes32`);
  return value.toLowerCase();
}

function nonzeroDigest(value, label) {
  const normalized = digest(value, label);
  if (normalized === `0x${"0".repeat(64)}`) {
    throw new Error(`${label} must be nonzero`);
  }
  return normalized;
}

function sha256Digest(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function safeString(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /REPLACE|PLACEHOLDER|TBD|TODO/i.test(value)
  ) {
    throw new Error(`${label} must be an exact non-placeholder string`);
  }
  return value;
}

function relativePath(value, label) {
  const normalized = safeString(value, label);
  if (
    /^[\\/]/.test(normalized) ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split(/[\\/]+/).includes("..")
  ) {
    throw new Error(`${label} must be a workspace-relative path`);
  }
  return normalized;
}

function environmentName(value, label) {
  const normalized = safeString(value, label);
  if (!/^[A-Z][A-Z0-9_]*$/.test(normalized)) {
    throw new Error(`${label} must be an environment-variable name`);
  }
  return normalized;
}

function address(value, label) {
  if (
    typeof value === "string" &&
    /REPLACE|PLACEHOLDER|TBD|TODO/i.test(value)
  ) {
    throw new Error(`${label} must not be a placeholder`);
  }
  let normalized;
  try {
    normalized = getAddress(value);
  } catch {
    throw new Error(`${label} must be an address`);
  }
  if (normalized === ZeroAddress) throw new Error(`${label} must be nonzero`);
  return normalized;
}

function sameAddress(actual, expected, label) {
  if (getAddress(actual) !== getAddress(expected)) {
    throw new Error(`${label} mismatch`);
  }
}

function sameValue(actual, expected, label) {
  if (BigInt(actual) !== BigInt(expected)) throw new Error(`${label} mismatch`);
}

function normalizePrerequisiteRecord(value, label) {
  const input = object(value, `prerequisites.${label}`);
  return {
    path: relativePath(input.path, `prerequisites.${label}.path`),
    sha256: sha256Digest(input.sha256, `prerequisites.${label}.sha256`),
  };
}

function normalizeArtifactRecords(input, spec) {
  exactKeys(input, spec.artifacts, "artifacts");
  return Object.fromEntries(
    spec.artifacts.map((name) => {
      const record = object(input[name], `artifacts.${name}`);
      return [
        name,
        {
          path: relativePath(record.path, `artifacts.${name}.path`),
          keccak256: digest(record.keccak256, `artifacts.${name}.keccak256`),
        },
      ];
    }),
  );
}

function normalizeFeePolicy(input) {
  const value = object(input, "transactionPolicy.feePolicy");
  if (!["eip1559", "legacy"].includes(value.transactionType)) {
    throw new Error("feePolicy.transactionType must be eip1559 or legacy");
  }
  const normalized = {
    transactionType: value.transactionType,
    maximumGasLimit: decimal(
      value.maximumGasLimit,
      "feePolicy.maximumGasLimit",
      {
        positive: true,
      },
    ),
    maximumTotalFeeWei: decimal(
      value.maximumTotalFeeWei,
      "feePolicy.maximumTotalFeeWei",
      { positive: true },
    ),
  };
  if (value.transactionType === "eip1559") {
    normalized.maximumFeePerGas = decimal(
      value.maximumFeePerGas,
      "feePolicy.maximumFeePerGas",
      { positive: true },
    );
    normalized.maximumPriorityFeePerGas = decimal(
      value.maximumPriorityFeePerGas,
      "feePolicy.maximumPriorityFeePerGas",
      { positive: true },
    );
    if (
      BigInt(normalized.maximumPriorityFeePerGas) >
      BigInt(normalized.maximumFeePerGas)
    ) {
      throw new Error("maximum priority fee exceeds maximum total fee per gas");
    }
    if (value.maximumGasPrice !== undefined) {
      throw new Error("EIP-1559 fee policy cannot contain maximumGasPrice");
    }
  } else {
    normalized.maximumGasPrice = decimal(
      value.maximumGasPrice,
      "feePolicy.maximumGasPrice",
      { positive: true },
    );
    if (
      value.maximumFeePerGas !== undefined ||
      value.maximumPriorityFeePerGas !== undefined
    ) {
      throw new Error("Legacy fee policy cannot contain EIP-1559 fee fields");
    }
  }
  return normalized;
}

function normalizeTransactionPolicy(input) {
  const value = object(input, "transactionPolicy");
  const targetConfirmations = positiveInteger(
    value.targetConfirmations,
    "transactionPolicy.targetConfirmations",
    256,
  );
  const maximumReceiptPolls = positiveInteger(
    value.maximumReceiptPolls,
    "transactionPolicy.maximumReceiptPolls",
    10_000,
  );
  if (maximumReceiptPolls < targetConfirmations) {
    throw new Error("maximumReceiptPolls must cover targetConfirmations");
  }
  return {
    targetConfirmations,
    maximumReceiptPolls,
    feePolicy: normalizeFeePolicy(value.feePolicy),
  };
}

function normalizeAsset(
  input,
  label = "asset",
  { requireRuntimeCodeHash = false } = {},
) {
  const value = object(input, label);
  return {
    address: address(value.address, `${label}.address`),
    decimals: integer(value.decimals, `${label}.decimals`, 255),
    ...(requireRuntimeCodeHash
      ? {
          runtimeCodeKeccak256: nonzeroDigest(
            value.runtimeCodeKeccak256,
            `${label}.runtimeCodeKeccak256`,
          ),
        }
      : {}),
  };
}

function normalizeCoreManifest(manifest, chainId) {
  const value = object(manifest, "core prerequisite manifest");
  if (
    value.schemaVersion !== 2 ||
    value.generation !== "v3-core" ||
    value.status !== "deployed-qualified" ||
    value.chainId !== chainId
  ) {
    throw new Error("core prerequisite manifest identity mismatch");
  }
  const contracts = object(value.contracts, "core prerequisite contracts");
  const runtimeCodeHashes = object(
    value.runtimeCodeHashes,
    "core prerequisite runtimeCodeHashes",
  );
  return {
    policyKernel: address(
      contracts.policyKernel,
      "core prerequisite policyKernel",
    ),
    policyRegistry: address(
      contracts.policyRegistry,
      "core prerequisite policyRegistry",
    ),
    asset: normalizeAsset(value.asset, "core prerequisite asset"),
    policyKernelRuntimeCodeKeccak256: digest(
      runtimeCodeHashes.PolicyKernelV2,
      "core prerequisite PolicyKernelV2 runtime hash",
    ),
    policyRegistryRuntimeCodeKeccak256: digest(
      runtimeCodeHashes.PolicyRegistryV1,
      "core prerequisite PolicyRegistryV1 runtime hash",
    ),
  };
}

function normalizeRemedyManifest(manifest, chainId) {
  const value = object(manifest, "remedy prerequisite manifest");
  if (
    value.schemaVersion !== 1 ||
    value.generation !== "usc-remedy-v1" ||
    value.status !== "deployed-dedicated-inbox-route" ||
    value.sourceChainId !== chainId
  ) {
    throw new Error("remedy prerequisite manifest identity mismatch");
  }
  const contracts = object(value.contracts, "remedy prerequisite contracts");
  const runtimeCodeHashes = object(
    value.routeQualification?.runtimeCodeHashes,
    "remedy route runtime hashes",
  );
  return {
    coordinator: address(
      contracts.coordinator,
      "remedy prerequisite coordinator",
    ),
    transport: address(contracts.transport, "remedy prerequisite transport"),
    coordinatorRuntimeCodeKeccak256: digest(
      runtimeCodeHashes.coordinator,
      "remedy coordinator runtime hash",
    ),
    transportRuntimeCodeKeccak256: digest(
      runtimeCodeHashes.transport,
      "remedy transport runtime hash",
    ),
  };
}

function normalizeVerifierManifest(manifest, chainId) {
  const value = object(manifest, "verifier prerequisite manifest");
  if (
    value.schemaVersion !== 1 ||
    value.generation !== "operator-service-verifier-v1" ||
    value.status !== "deployed-qualified" ||
    value.chainId !== chainId
  ) {
    throw new Error("verifier prerequisite manifest identity mismatch");
  }
  const contract = object(value.contract, "verifier prerequisite contract");
  return {
    verifier: address(contract.address, "verifier prerequisite address"),
    runtimeCodeKeccak256: nonzeroDigest(
      contract.runtimeCodeKeccak256,
      "verifier prerequisite runtime hash",
    ),
  };
}

function normalizeClosedLoop(input, bindings) {
  const value = object(input, "closedLoop");
  const context = address(value.context, "closedLoop.context");
  const coordinator = address(value.coordinator, "closedLoop.coordinator");
  sameAddress(context, bindings.policyKernel, "closedLoop.context");
  sameAddress(
    coordinator,
    bindings.remedyCoordinator,
    "closedLoop.coordinator",
  );
  return { context, coordinator };
}

function normalizeOperatorMarket(input, asset, bindings) {
  const value = object(input, "operatorMarket");
  const token = address(value.token, "operatorMarket.token");
  const verifier = address(value.verifier, "operatorMarket.verifier");
  sameAddress(token, asset.address, "operatorMarket.token");
  sameAddress(verifier, bindings.operatorVerifier, "operatorMarket.verifier");
  return {
    token,
    verifier,
    minimumOperatorBond: decimal(
      value.minimumOperatorBond,
      "operatorMarket.minimumOperatorBond",
      { positive: true },
    ),
    maximumQuoteDuration: positiveInteger(
      value.maximumQuoteDuration,
      "operatorMarket.maximumQuoteDuration",
      Number.MAX_SAFE_INTEGER,
    ),
    maximumServiceDuration: positiveInteger(
      value.maximumServiceDuration,
      "operatorMarket.maximumServiceDuration",
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

function normalizePortfolio(input, asset, bindings) {
  const value = object(input, "portfolio");
  const poolInput = object(value.pool, "portfolio.pool");
  const factoryInput = object(value.factory, "portfolio.factory");
  const mandateInput = object(value.mandate, "portfolio.mandate");
  const safetyInput = object(value.safety, "portfolio.safety");
  const pool = {
    maximumPoolAssets: decimal(
      poolInput.maximumPoolAssets,
      "portfolio.pool.maximumPoolAssets",
      { positive: true },
    ),
    maximumServiceBudget: decimal(
      poolInput.maximumServiceBudget,
      "portfolio.pool.maximumServiceBudget",
    ),
    maximumServiceJobDuration: integer(
      poolInput.maximumServiceJobDuration,
      "portfolio.pool.maximumServiceJobDuration",
      Number.MAX_SAFE_INTEGER,
    ),
    maximumFacilityCount: positiveInteger(
      poolInput.maximumFacilityCount,
      "portfolio.pool.maximumFacilityCount",
      65_535,
    ),
    fundingDeadline: positiveInteger(
      poolInput.fundingDeadline,
      "portfolio.pool.fundingDeadline",
      Number.MAX_SAFE_INTEGER,
    ),
    recoveryDelayBlocks: positiveInteger(
      poolInput.recoveryDelayBlocks,
      "portfolio.pool.recoveryDelayBlocks",
      Number.MAX_SAFE_INTEGER,
    ),
  };
  if (BigInt(pool.maximumServiceBudget) > BigInt(pool.maximumPoolAssets)) {
    throw new Error("portfolio service budget exceeds maximum pool assets");
  }
  if (
    BigInt(pool.maximumServiceBudget) !== 0n &&
    pool.maximumServiceJobDuration === 0
  ) {
    throw new Error("nonzero service budget requires a service duration");
  }
  const factory = {
    maximumFacilityLimit: decimal(
      factoryInput.maximumFacilityLimit,
      "portfolio.factory.maximumFacilityLimit",
      { positive: true },
    ),
    maximumTotalLimit: decimal(
      factoryInput.maximumTotalLimit,
      "portfolio.factory.maximumTotalLimit",
      { positive: true },
    ),
    minimumBondBps: positiveInteger(
      factoryInput.minimumBondBps,
      "portfolio.factory.minimumBondBps",
      10_000,
    ),
    maximumDrawFeeBps: integer(
      factoryInput.maximumDrawFeeBps,
      "portfolio.factory.maximumDrawFeeBps",
      10_000,
    ),
    maximumMaturityBlocks: positiveInteger(
      factoryInput.maximumMaturityBlocks,
      "portfolio.factory.maximumMaturityBlocks",
      Number.MAX_SAFE_INTEGER,
    ),
    maximumDrawDelayBlocks: integer(
      factoryInput.maximumDrawDelayBlocks,
      "portfolio.factory.maximumDrawDelayBlocks",
      4_294_967_295,
    ),
    maximumFacilityCount: positiveInteger(
      factoryInput.maximumFacilityCount,
      "portfolio.factory.maximumFacilityCount",
      65_535,
    ),
  };
  if (
    BigInt(factory.maximumTotalLimit) < BigInt(factory.maximumFacilityLimit)
  ) {
    throw new Error("factory total limit is below its per-facility limit");
  }
  if (factory.maximumFacilityCount !== pool.maximumFacilityCount) {
    throw new Error("pool and factory facility-count bounds differ");
  }
  const mandate = {
    requiredReleaseId: nonzeroDigest(
      mandateInput.requiredReleaseId,
      "portfolio.mandate.requiredReleaseId",
    ),
    requiredPolicySetCommitment: nonzeroDigest(
      mandateInput.requiredPolicySetCommitment,
      "portfolio.mandate.requiredPolicySetCommitment",
    ),
    requiredEvidenceKind: integer(
      mandateInput.requiredEvidenceKind,
      "portfolio.mandate.requiredEvidenceKind",
      2,
    ),
    requiredActionAdapterKind: nonzeroDigest(
      mandateInput.requiredActionAdapterKind,
      "portfolio.mandate.requiredActionAdapterKind",
    ),
    maximumFacilityLimit: decimal(
      mandateInput.maximumFacilityLimit,
      "portfolio.mandate.maximumFacilityLimit",
      { positive: true },
    ),
    minimumBondBps: positiveInteger(
      mandateInput.minimumBondBps,
      "portfolio.mandate.minimumBondBps",
      10_000,
    ),
    maximumDrawFeeBps: integer(
      mandateInput.maximumDrawFeeBps,
      "portfolio.mandate.maximumDrawFeeBps",
      10_000,
    ),
    maximumRemainingMaturityBlocks: positiveInteger(
      mandateInput.maximumRemainingMaturityBlocks,
      "portfolio.mandate.maximumRemainingMaturityBlocks",
      Number.MAX_SAFE_INTEGER,
    ),
  };
  if (
    BigInt(mandate.maximumFacilityLimit) >
      BigInt(factory.maximumFacilityLimit) ||
    mandate.minimumBondBps < factory.minimumBondBps ||
    mandate.maximumDrawFeeBps > factory.maximumDrawFeeBps ||
    mandate.maximumRemainingMaturityBlocks > factory.maximumMaturityBlocks
  ) {
    throw new Error("portfolio mandate is looser than its dedicated factory");
  }
  const safety = {
    minimumFundingWindowSeconds: positiveInteger(
      safetyInput.minimumFundingWindowSeconds,
      "portfolio.safety.minimumFundingWindowSeconds",
      Number.MAX_SAFE_INTEGER,
    ),
  };
  return {
    asset,
    kernel: bindings.policyKernel,
    registry: bindings.policyRegistry,
    pool,
    factory,
    mandate,
    safety,
  };
}

export function parseV3ExtensionArguments(args) {
  const options = {
    help: false,
    broadcast: false,
    liveCheck: false,
    qualifyDeployed: false,
    configPath: undefined,
    manifestPath: "v3-extension-deployment.json",
    writePlanPath: undefined,
    approvedPlanPath: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--live-check") options.liveCheck = true;
    else if (argument === "--broadcast") options.broadcast = true;
    else if (argument === "--qualify-deployed") options.qualifyDeployed = true;
    else if (
      ["--config", "--manifest", "--write-plan", "--approved-plan"].includes(
        argument,
      )
    ) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a path`);
      }
      index += 1;
      if (argument === "--config") options.configPath = value;
      else if (argument === "--manifest") options.manifestPath = value;
      else if (argument === "--write-plan") options.writePlanPath = value;
      else options.approvedPlanPath = value;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.help) return options;
  if (!options.configPath) throw new Error("--config is required");
  if (
    Number(Boolean(options.writePlanPath)) +
      Number(options.broadcast) +
      Number(options.qualifyDeployed) >
    1
  ) {
    throw new Error(
      "write-plan, broadcast, and qualify-deployed are mutually exclusive",
    );
  }
  if (
    (options.writePlanPath || options.qualifyDeployed) &&
    !options.liveCheck
  ) {
    throw new Error("live operation requires --live-check");
  }
  if (options.broadcast && (!options.liveCheck || !options.approvedPlanPath)) {
    throw new Error("--broadcast requires --live-check and --approved-plan");
  }
  if (!options.broadcast && options.approvedPlanPath) {
    throw new Error("--approved-plan is only valid with --broadcast");
  }
  return options;
}

export function validateV3ExtensionConfig(input, prerequisiteManifests = {}) {
  const value = object(input, "config");
  if (value.schemaVersion !== 1)
    throw new Error("unsupported config schemaVersion");
  if (!V3_EXTENSION_GENERATIONS.includes(value.generation)) {
    throw new Error("unsupported V3 extension generation");
  }
  const spec = GENERATION_SPECS[value.generation];
  const chainId = positiveInteger(value.chainId, "chainId");
  const deployer = address(value.deployer, "deployer");
  const prerequisiteInput = object(value.prerequisites, "prerequisites");
  exactKeys(prerequisiteInput, spec.prerequisites, "prerequisites");
  exactKeys(
    prerequisiteManifests,
    spec.prerequisites,
    "prerequisite manifests",
  );
  const prerequisites = Object.fromEntries(
    spec.prerequisites.map((name) => [
      name,
      normalizePrerequisiteRecord(prerequisiteInput[name], name),
    ]),
  );
  const bindings = {};
  if (spec.prerequisites.includes("core")) {
    const core = normalizeCoreManifest(prerequisiteManifests.core, chainId);
    bindings.coreManifestSha256 = prerequisites.core.sha256;
    bindings.policyKernel = core.policyKernel;
    bindings.policyRegistry = core.policyRegistry;
    bindings.coreAsset = core.asset;
    bindings.policyKernelRuntimeCodeKeccak256 =
      core.policyKernelRuntimeCodeKeccak256;
    bindings.policyRegistryRuntimeCodeKeccak256 =
      core.policyRegistryRuntimeCodeKeccak256;
  }
  if (spec.prerequisites.includes("remedy")) {
    const remedy = normalizeRemedyManifest(
      prerequisiteManifests.remedy,
      chainId,
    );
    bindings.remedyManifestSha256 = prerequisites.remedy.sha256;
    bindings.remedyCoordinator = remedy.coordinator;
    bindings.remedyTransport = remedy.transport;
    bindings.remedyCoordinatorRuntimeCodeKeccak256 =
      remedy.coordinatorRuntimeCodeKeccak256;
    bindings.remedyTransportRuntimeCodeKeccak256 =
      remedy.transportRuntimeCodeKeccak256;
  }
  if (spec.prerequisites.includes("verifier")) {
    const verifier = normalizeVerifierManifest(
      prerequisiteManifests.verifier,
      chainId,
    );
    bindings.verifierManifestSha256 = prerequisites.verifier.sha256;
    bindings.operatorVerifier = verifier.verifier;
    bindings.operatorVerifierRuntimeCodeKeccak256 =
      verifier.runtimeCodeKeccak256;
  }
  const artifacts = normalizeArtifactRecords(
    object(value.artifacts, "artifacts"),
    spec,
  );
  const normalized = {
    schemaVersion: 1,
    generation: value.generation,
    chainId,
    deployer,
    rpcUrlEnvironment: environmentName(
      value.rpcUrlEnvironment,
      "rpcUrlEnvironment",
    ),
    privateKeyEnvironment: environmentName(
      value.privateKeyEnvironment,
      "privateKeyEnvironment",
    ),
    expectedStartingNonce: integer(
      value.expectedStartingNonce,
      "expectedStartingNonce",
    ),
    prerequisites,
    bindings,
    artifacts,
    transactionPolicy: normalizeTransactionPolicy(value.transactionPolicy),
    requirements: {
      minimumNativeWei: decimal(
        object(value.requirements, "requirements").minimumNativeWei,
        "requirements.minimumNativeWei",
        { positive: true },
      ),
    },
  };
  if (value.generation === "v3-closed-loop-v1") {
    normalized.closedLoop = normalizeClosedLoop(value.closedLoop, bindings);
  } else if (value.generation === "v3-operator-market-v1") {
    normalized.asset = normalizeAsset(value.asset, "asset", {
      requireRuntimeCodeHash: true,
    });
    normalized.operatorMarket = normalizeOperatorMarket(
      value.operatorMarket,
      normalized.asset,
      bindings,
    );
  } else {
    const asset = normalizeAsset(value.asset, "asset", {
      requireRuntimeCodeHash: true,
    });
    sameAddress(asset.address, bindings.coreAsset.address, "portfolio asset");
    if (asset.decimals !== bindings.coreAsset.decimals) {
      throw new Error("portfolio asset decimals mismatch core manifest");
    }
    const rolesInput = object(value.roles, "roles");
    exactKeys(rolesInput, ["manager", "borrower", "guardian"], "roles");
    normalized.roles = {
      manager: address(rolesInput.manager, "roles.manager"),
      borrower: address(rolesInput.borrower, "roles.borrower"),
      guardian: address(rolesInput.guardian, "roles.guardian"),
    };
    sameAddress(
      normalized.roles.manager,
      deployer,
      "portfolio manager/deployer",
    );
    if (
      new Set([deployer, normalized.roles.borrower, normalized.roles.guardian])
        .size !== 3
    ) {
      throw new Error("portfolio borrower and guardian roles must be distinct");
    }
    normalized.asset = asset;
    normalized.portfolio = normalizePortfolio(value.portfolio, asset, bindings);
  }
  return normalized;
}

export function readV3ExtensionInputs(
  configPath,
  rootDirectory = process.cwd(),
) {
  const resolvedConfig = resolve(rootDirectory, configPath);
  const rawConfig = JSON.parse(readFileSync(resolvedConfig, "utf8"));
  if (!V3_EXTENSION_GENERATIONS.includes(rawConfig.generation)) {
    throw new Error("unsupported V3 extension generation");
  }
  const spec = GENERATION_SPECS[rawConfig.generation];
  const prerequisiteManifests = {};
  for (const name of spec.prerequisites) {
    const record = normalizePrerequisiteRecord(
      rawConfig.prerequisites?.[name],
      name,
    );
    const path = resolve(rootDirectory, record.path);
    if (!existsSync(path)) throw new Error(`Missing ${name} manifest: ${path}`);
    const bytes = readFileSync(path);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== record.sha256) {
      throw new Error(`${name} manifest SHA-256 mismatch`);
    }
    prerequisiteManifests[name] = JSON.parse(bytes.toString("utf8"));
  }
  return {
    config: validateV3ExtensionConfig(rawConfig, prerequisiteManifests),
    prerequisiteManifests,
  };
}

export function readV3ExtensionArtifacts(
  config,
  rootDirectory = process.cwd(),
) {
  const spec = GENERATION_SPECS[config.generation];
  if (!spec) throw new Error("unsupported V3 extension generation");
  const artifacts = Object.fromEntries(
    spec.artifacts.map((name) => {
      const path = resolve(rootDirectory, config.artifacts[name].path);
      if (!existsSync(path))
        throw new Error(`Missing extension artifact: ${path}`);
      const raw = readFileSync(path);
      const hash = keccak256(raw);
      if (hash !== config.artifacts[name].keccak256) {
        throw new Error(`${name} artifact hash mismatch`);
      }
      const artifact = JSON.parse(raw.toString("utf8"));
      if (!Array.isArray(artifact.abi))
        throw new Error(`${name} artifact ABI is missing`);
      for (const field of ["bytecode", "deployedBytecode"]) {
        if (
          !isHexString(artifact[field]?.object) ||
          artifact[field].object === "0x"
        ) {
          throw new Error(`${name} artifact ${field} is missing`);
        }
        const links = artifact[field].linkReferences ?? {};
        if (Object.values(links).some((file) => Object.keys(file).length > 0)) {
          throw new Error(`${name} artifact contains unresolved library links`);
        }
      }
      const constructor = artifact.abi.find(
        (entry) => entry.type === "constructor",
      );
      const actualTypes = (constructor?.inputs ?? []).map(({ type }) => type);
      const expectedTypes = spec.constructorTypes[name];
      if (
        expectedTypes &&
        JSON.stringify(actualTypes) !== JSON.stringify(expectedTypes)
      ) {
        throw new Error(`${name} constructor ABI mismatch`);
      }
      if (
        Object.keys(artifact.deployedBytecode.immutableReferences ?? {})
          .length !== IMMUTABLE_COUNTS[name]
      ) {
        throw new Error(`${name} artifact immutable-reference count mismatch`);
      }
      return [name, { artifact, hash, path }];
    }),
  );
  return artifacts;
}

function planStep({
  order,
  name,
  config,
  nonce,
  to = null,
  data,
  predictedContract = null,
}) {
  return {
    order,
    name,
    chainId: config.chainId,
    nonce,
    from: config.deployer,
    to,
    predictedContract,
    data,
    dataHash: keccak256(data),
    value: "0",
  };
}

async function deploymentData(artifactRecord, values) {
  const factory = new ContractFactory(
    artifactRecord.artifact.abi,
    artifactRecord.artifact.bytecode.object,
  );
  const transaction = await factory.getDeployTransaction(...values);
  if (!isHexString(transaction.data) || transaction.data === "0x") {
    throw new Error("deployment transaction data is missing");
  }
  return transaction.data;
}

function constructorRecord(types, values) {
  return {
    types: [...types],
    values: values.map((value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  };
}

function basePlan(config, artifacts, predictedContracts, constructors, steps) {
  const plan = {
    schemaVersion: 1,
    generation: config.generation,
    chainId: config.chainId,
    deployer: config.deployer,
    expectedStartingNonce: config.expectedStartingNonce,
    prerequisites: config.prerequisites,
    bindings: config.bindings,
    artifactHashes: Object.fromEntries(
      Object.entries(artifacts).map(([name, record]) => [name, record.hash]),
    ),
    configCommitment: commitment(config),
    predictedContracts,
    constructors,
    steps,
  };
  plan.planCommitment = commitment(plan);
  return plan;
}

function assertPlan(config, plan) {
  if (
    plan?.schemaVersion !== 1 ||
    plan.generation !== config.generation ||
    plan.chainId !== config.chainId ||
    plan.deployer !== config.deployer ||
    plan.expectedStartingNonce !== config.expectedStartingNonce ||
    plan.configCommitment !== commitment(config) ||
    plan.planCommitment !==
      commitment(
        Object.fromEntries(
          Object.entries(plan).filter(([key]) => key !== "planCommitment"),
        ),
      ) ||
    !Array.isArray(plan.steps) ||
    plan.steps.length === 0
  ) {
    throw new Error("V3 extension deployment plan is invalid");
  }
  for (const [index, step] of plan.steps.entries()) {
    if (
      step.order !== index + 1 ||
      step.chainId !== config.chainId ||
      step.nonce !== config.expectedStartingNonce + index ||
      step.from !== config.deployer ||
      !isHexString(step.data) ||
      step.dataHash !== keccak256(step.data) ||
      step.value !== "0"
    ) {
      throw new Error(`${step.name ?? `step ${index + 1}`} plan is invalid`);
    }
  }
  return plan;
}

export async function buildV3ExtensionDeploymentPlan({ config, artifacts }) {
  const nonce = config.expectedStartingNonce;
  if (config.generation === "v3-closed-loop-v1") {
    const predicted = getCreateAddress({ from: config.deployer, nonce });
    const values = [
      config.bindings.policyKernel,
      config.bindings.remedyCoordinator,
    ];
    const data = await deploymentData(artifacts.ClosedLoopPolicyV1, values);
    return assertPlan(
      config,
      basePlan(
        config,
        artifacts,
        { ClosedLoopPolicyV1: predicted },
        {
          ClosedLoopPolicyV1: constructorRecord(
            GENERATION_SPECS[config.generation].constructorTypes
              .ClosedLoopPolicyV1,
            values,
          ),
        },
        [
          planStep({
            order: 1,
            name: "ClosedLoopPolicyV1",
            config,
            nonce,
            data,
            predictedContract: predicted,
          }),
        ],
      ),
    );
  }
  if (config.generation === "v3-operator-market-v1") {
    const predicted = getCreateAddress({ from: config.deployer, nonce });
    const market = config.operatorMarket;
    const values = [
      market.token,
      market.verifier,
      BigInt(market.minimumOperatorBond),
      BigInt(market.maximumQuoteDuration),
      BigInt(market.maximumServiceDuration),
    ];
    const data = await deploymentData(artifacts.OperatorMarketV1, values);
    return assertPlan(
      config,
      basePlan(
        config,
        artifacts,
        { OperatorMarketV1: predicted },
        {
          OperatorMarketV1: constructorRecord(
            GENERATION_SPECS[config.generation].constructorTypes
              .OperatorMarketV1,
            values,
          ),
        },
        [
          planStep({
            order: 1,
            name: "OperatorMarketV1",
            config,
            nonce,
            data,
            predictedContract: predicted,
          }),
        ],
      ),
    );
  }
  const predictedContracts = {
    PortfolioPoolV1: getCreateAddress({ from: config.deployer, nonce }),
    CappedPilotFactoryV1: getCreateAddress({
      from: config.deployer,
      nonce: nonce + 1,
    }),
    PortfolioMandateV1: getCreateAddress({
      from: config.deployer,
      nonce: nonce + 2,
    }),
  };
  const { pool, factory, mandate } = config.portfolio;
  const poolValues = [
    config.asset.address,
    config.roles.manager,
    BigInt(pool.maximumPoolAssets),
    BigInt(pool.maximumServiceBudget),
    BigInt(pool.maximumServiceJobDuration),
    BigInt(pool.maximumFacilityCount),
    BigInt(pool.fundingDeadline),
    BigInt(pool.recoveryDelayBlocks),
  ];
  const factoryValues = [
    config.asset.address,
    config.bindings.policyKernel,
    predictedContracts.PortfolioPoolV1,
    config.roles.borrower,
    config.roles.guardian,
    BigInt(factory.maximumFacilityLimit),
    BigInt(factory.maximumTotalLimit),
    BigInt(factory.minimumBondBps),
    BigInt(factory.maximumDrawFeeBps),
    BigInt(factory.maximumMaturityBlocks),
    BigInt(factory.maximumDrawDelayBlocks),
    BigInt(factory.maximumFacilityCount),
  ];
  const mandateValues = [
    predictedContracts.CappedPilotFactoryV1,
    config.bindings.policyRegistry,
    config.asset.address,
    config.bindings.policyKernel,
    mandate.requiredReleaseId,
    mandate.requiredPolicySetCommitment,
    BigInt(mandate.requiredEvidenceKind),
    mandate.requiredActionAdapterKind,
    BigInt(mandate.maximumFacilityLimit),
    BigInt(mandate.minimumBondBps),
    BigInt(mandate.maximumDrawFeeBps),
    BigInt(mandate.maximumRemainingMaturityBlocks),
  ];
  const [poolData, factoryData, mandateData] = await Promise.all([
    deploymentData(artifacts.PortfolioPoolV1, poolValues),
    deploymentData(artifacts.CappedPilotFactoryV1, factoryValues),
    deploymentData(artifacts.PortfolioMandateV1, mandateValues),
  ]);
  const setMandateData = new Interface(
    artifacts.PortfolioPoolV1.artifact.abi,
  ).encodeFunctionData("setMandate", [predictedContracts.PortfolioMandateV1]);
  return assertPlan(
    config,
    basePlan(
      config,
      artifacts,
      predictedContracts,
      {
        PortfolioPoolV1: constructorRecord(
          GENERATION_SPECS[config.generation].constructorTypes.PortfolioPoolV1,
          poolValues,
        ),
        CappedPilotFactoryV1: constructorRecord(
          GENERATION_SPECS[config.generation].constructorTypes
            .CappedPilotFactoryV1,
          factoryValues,
        ),
        PortfolioMandateV1: constructorRecord(
          GENERATION_SPECS[config.generation].constructorTypes
            .PortfolioMandateV1,
          mandateValues,
        ),
      },
      [
        planStep({
          order: 1,
          name: "PortfolioPoolV1",
          config,
          nonce,
          data: poolData,
          predictedContract: predictedContracts.PortfolioPoolV1,
        }),
        planStep({
          order: 2,
          name: "CappedPilotFactoryV1",
          config,
          nonce: nonce + 1,
          data: factoryData,
          predictedContract: predictedContracts.CappedPilotFactoryV1,
        }),
        planStep({
          order: 3,
          name: "PortfolioMandateV1",
          config,
          nonce: nonce + 2,
          data: mandateData,
          predictedContract: predictedContracts.PortfolioMandateV1,
        }),
        planStep({
          order: 4,
          name: "setMandate",
          config,
          nonce: nonce + 3,
          to: predictedContracts.PortfolioPoolV1,
          data: setMandateData,
        }),
      ],
    ),
  );
}

function feePolicyRecord(policy) {
  return { ...policy };
}

function transactionFeeFields(transaction, policy, label) {
  const type = Number(transaction.type);
  const gasLimit = decimal(
    BigInt(transaction.gasLimit).toString(),
    `${label}.gasLimit`,
    { positive: true },
  );
  if (BigInt(gasLimit) > BigInt(policy.maximumGasLimit)) {
    throw new Error(`${label} gas limit exceeds policy`);
  }
  if (policy.transactionType === "eip1559") {
    if (
      type !== 2 ||
      transaction.gasPrice != null ||
      transaction.maxFeePerGas == null ||
      transaction.maxPriorityFeePerGas == null
    ) {
      throw new Error(`${label} fee mode does not match EIP-1559 policy`);
    }
    const maximumFee = BigInt(transaction.maxFeePerGas);
    const priorityFee = BigInt(transaction.maxPriorityFeePerGas);
    if (
      maximumFee > BigInt(policy.maximumFeePerGas) ||
      priorityFee > BigInt(policy.maximumPriorityFeePerGas) ||
      priorityFee > maximumFee
    ) {
      throw new Error(
        `${label} maximumFeePerGas or priority fee exceeds the configured fee cap`,
      );
    }
    return {
      type,
      gasLimit,
      gasPrice: null,
      maxFeePerGas: maximumFee.toString(),
      maxPriorityFeePerGas: priorityFee.toString(),
    };
  }
  if (
    type !== 0 ||
    transaction.gasPrice == null ||
    transaction.maxFeePerGas != null ||
    transaction.maxPriorityFeePerGas != null
  ) {
    throw new Error(`${label} fee mode does not match legacy policy`);
  }
  const gasPrice = BigInt(transaction.gasPrice);
  if (gasPrice > BigInt(policy.maximumGasPrice)) {
    throw new Error(`${label} gas price exceeds policy`);
  }
  return {
    type,
    gasLimit,
    gasPrice: gasPrice.toString(),
    maxFeePerGas: null,
    maxPriorityFeePerGas: null,
  };
}

export async function buildV3ExtensionLiveExecutionPlan({
  config,
  plan,
  signer,
}) {
  assertPlan(config, plan);
  sameAddress(await signer.getAddress(), config.deployer, "extension signer");
  const policy = config.transactionPolicy.feePolicy;
  const steps = [];
  let maximumTotalFee = 0n;
  for (const step of plan.steps) {
    const populated = await signer.populateTransaction({
      type: policy.transactionType === "eip1559" ? 2 : 0,
      chainId: step.chainId,
      nonce: step.nonce,
      ...(step.to === null ? {} : { to: step.to }),
      data: step.data,
      value: step.value,
      gasLimit: policy.maximumGasLimit,
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
    const fees = transactionFeeFields(populated, policy, step.name);
    maximumTotalFee +=
      BigInt(fees.gasLimit) *
      BigInt(fees.type === 2 ? fees.maxFeePerGas : fees.gasPrice);
    steps.push({ ...step, ...fees });
  }
  if (maximumTotalFee > BigInt(policy.maximumTotalFeeWei)) {
    throw new Error("extension execution plan exceeds maximum total fee");
  }
  const executionPlan = {
    schemaVersion: 1,
    feePolicy: feePolicyRecord(policy),
    maximumTotalFeeWei: maximumTotalFee.toString(),
    steps,
  };
  executionPlan.commitment = commitment(executionPlan);
  return executionPlan;
}

export function validateV3ExtensionLiveExecutionPlan({
  config,
  plan,
  executionPlan,
}) {
  assertPlan(config, plan);
  if (
    executionPlan?.schemaVersion !== 1 ||
    canonicalText(executionPlan.feePolicy) !==
      canonicalText(config.transactionPolicy.feePolicy) ||
    !Array.isArray(executionPlan.steps) ||
    executionPlan.steps.length !== plan.steps.length ||
    executionPlan.commitment !==
      commitment(
        Object.fromEntries(
          Object.entries(executionPlan).filter(([key]) => key !== "commitment"),
        ),
      )
  ) {
    throw new Error("invalid V3 extension live execution plan");
  }
  let maximumTotalFee = 0n;
  for (const [index, step] of plan.steps.entries()) {
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
      if (approved?.[field] !== step[field]) {
        throw new Error(`${step.name} approved transaction changed its plan`);
      }
    }
    const fees = transactionFeeFields(
      approved,
      config.transactionPolicy.feePolicy,
      step.name,
    );
    for (const field of [
      "type",
      "gasLimit",
      "gasPrice",
      "maxFeePerGas",
      "maxPriorityFeePerGas",
    ]) {
      if (approved[field] !== fees[field]) {
        throw new Error(`${step.name} approved ${field} is not canonical`);
      }
    }
    maximumTotalFee +=
      BigInt(fees.gasLimit) *
      BigInt(fees.type === 2 ? fees.maxFeePerGas : fees.gasPrice);
  }
  if (
    executionPlan.maximumTotalFeeWei !== maximumTotalFee.toString() ||
    maximumTotalFee >
      BigInt(config.transactionPolicy.feePolicy.maximumTotalFeeWei)
  ) {
    throw new Error("approved extension total fee is invalid");
  }
  return executionPlan;
}

function qualificationSecurityState(qualification) {
  return canonicalJson({
    generation: qualification.generation,
    chainId: qualification.chainId,
    deployer: qualification.deployer,
    artifactHashes: qualification.artifactHashes,
    prerequisiteCodeHashes: qualification.prerequisiteCodeHashes,
    ...(qualification.registryQualification
      ? { registryQualification: qualification.registryQualification }
      : {}),
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

function journalIdentity(journal) {
  return commitment({
    generation: journal.generation,
    configCommitment: journal.configCommitment,
    planCommitment: journal.planCommitment,
    predictedContracts: journal.predictedContracts,
    transactionPlan: journal.transactionPlan,
    executionPlan: journal.executionPlan,
  });
}

function createRenewalBinding(journal) {
  const binding = {
    schemaVersion: 1,
    journalIdentity: journalIdentity(journal),
    executionPlanCommitment: journal.executionPlanCommitment,
    checkpoint: journal.steps.map(renewalCheckpointStep),
    remainingSteps: journal.steps
      .filter(({ status }) => status !== "confirmed")
      .map(({ name }) => name),
  };
  if (binding.remainingSteps.length === 0) {
    throw new Error("completed extension journal does not need renewal");
  }
  binding.commitment = commitment(binding);
  return binding;
}

function validateRenewalBinding(binding, journal) {
  if (
    binding?.schemaVersion !== 1 ||
    binding.journalIdentity !== journalIdentity(journal) ||
    binding.executionPlanCommitment !== journal.executionPlanCommitment ||
    !Array.isArray(binding.checkpoint) ||
    !Array.isArray(binding.remainingSteps) ||
    binding.commitment !==
      commitment(
        Object.fromEntries(
          Object.entries(binding).filter(([key]) => key !== "commitment"),
        ),
      ) ||
    binding.checkpoint.length !== journal.steps.length
  ) {
    throw new Error("extension renewal does not match its journal");
  }
  const ranks = { planned: 0, prepared: 1, confirmed: 2 };
  for (const [index, checkpoint] of binding.checkpoint.entries()) {
    const current = journal.steps[index];
    if (
      checkpoint.name !== current.name ||
      ranks[checkpoint.status] === undefined ||
      ranks[current.status] < ranks[checkpoint.status] ||
      (checkpoint.transactionHash !== null &&
        checkpoint.transactionHash !== current.intent?.transactionHash)
    ) {
      throw new Error("extension journal regressed after renewal");
    }
    if (
      checkpoint.status === "confirmed" &&
      canonicalText(checkpoint.receipt) !== canonicalText(current.receipt)
    ) {
      throw new Error("extension receipt changed after renewal");
    }
  }
  const remaining = binding.checkpoint
    .filter(({ status }) => status !== "confirmed")
    .map(({ name }) => name);
  if (JSON.stringify(remaining) !== JSON.stringify(binding.remainingSteps)) {
    throw new Error("extension renewal remaining-step list mismatch");
  }
}

function approvalEnvelopeCommitment(approval) {
  return commitment(
    Object.fromEntries(
      Object.entries(approval ?? {}).filter(
        ([key]) => key !== "approvalCommitment",
      ),
    ),
  );
}

export function createV3ExtensionApproval({
  config,
  plan,
  qualification,
  executionPlan,
  now,
  journal,
}) {
  validateV3ExtensionLiveExecutionPlan({ config, plan, executionPlan });
  const issuedAt = integer(now, "approval issue time");
  const securityQualification = qualificationSecurityState(qualification);
  const approval = {
    schemaVersion: 1,
    generation: config.generation,
    configCommitment: plan.configCommitment,
    planCommitment: plan.planCommitment,
    issuedAt,
    validUntil: issuedAt + V3_EXTENSION_PLAN_VALIDITY_SECONDS,
    qualification,
    qualificationCommitment: commitment(qualification),
    securityQualification,
    securityQualificationCommitment: commitment(securityQualification),
    executionPlan,
    executionPlanCommitment: executionPlan.commitment,
    ...(journal ? { renewal: createRenewalBinding(journal) } : {}),
  };
  approval.approvalCommitment = approvalEnvelopeCommitment(approval);
  return approval;
}

export function validateV3ExtensionApproval({
  approval,
  config,
  plan,
  qualification,
  liveQualification = qualification,
  now,
  journal,
}) {
  if (
    approval?.schemaVersion !== 1 ||
    approval.generation !== config.generation ||
    approval.configCommitment !== plan.configCommitment ||
    approval.planCommitment !== plan.planCommitment ||
    approval.executionPlanCommitment !== approval.executionPlan?.commitment ||
    approval.approvalCommitment !== approvalEnvelopeCommitment(approval)
  ) {
    throw new Error("extension approval plan does not match this deployment");
  }
  validateV3ExtensionLiveExecutionPlan({
    config,
    plan,
    executionPlan: approval.executionPlan,
  });
  if (
    approval.qualificationCommitment !== commitment(approval.qualification) ||
    approval.securityQualificationCommitment !==
      commitment(approval.securityQualification) ||
    canonicalText(approval.securityQualification) !==
      canonicalText(qualificationSecurityState(liveQualification))
  ) {
    throw new Error("approved extension qualification changed");
  }
  const issuedAt = integer(approval.issuedAt, "approval issue time");
  const validUntil = integer(approval.validUntil, "approval expiry");
  const current = integer(now, "approval validation time");
  if (
    validUntil !== issuedAt + V3_EXTENSION_PLAN_VALIDITY_SECONDS ||
    current < issuedAt ||
    current > validUntil
  ) {
    throw new Error("approved extension plan has expired");
  }
  if (approval.renewal) {
    if (!journal) throw new Error("extension renewal requires its journal");
    validateRenewalBinding(approval.renewal, journal);
  } else if (
    canonicalText(approval.qualification) !== canonicalText(qualification)
  ) {
    throw new Error("approved extension live qualification changed");
  }
  return approval;
}

export async function verifyV3ExtensionApprovalAnchor({ approval, provider }) {
  const qualification = object(
    approval?.qualification,
    "extension approval qualification",
  );
  const chainId = positiveInteger(
    qualification.chainId,
    "extension approval chainId",
  );
  const blockNumber = integer(
    qualification.blockNumber,
    "extension approval block number",
  );
  const blockHash = digest(
    qualification.blockHash,
    "extension approval block hash",
  );
  const blockTimestamp = integer(
    qualification.blockTimestamp,
    "extension approval block timestamp",
  );
  const [network, block] = await Promise.all([
    provider.getNetwork(),
    provider.getBlock(blockNumber),
  ]);
  if (
    network.chainId !== BigInt(chainId) ||
    block?.number !== blockNumber ||
    block?.hash?.toLowerCase() !== blockHash ||
    block.timestamp !== blockTimestamp
  ) {
    throw new Error(
      "Approved V3 extension chain anchor is no longer canonical",
    );
  }
  return true;
}

export function v3ExtensionJournalPath(manifestPath) {
  return `${resolve(manifestPath)}.v3-extension-journal.json`;
}

function validateJournal({ journal, config, plan }) {
  if (
    journal?.schemaVersion !== 1 ||
    journal.generation !== config.generation ||
    !["deploying", "complete"].includes(journal.phase) ||
    journal.configCommitment !== plan.configCommitment ||
    journal.planCommitment !== plan.planCommitment ||
    canonicalText(journal.predictedContracts) !==
      canonicalText(plan.predictedContracts) ||
    canonicalText(journal.transactionPlan) !== canonicalText(plan.steps) ||
    journal.executionPlanCommitment !== journal.executionPlan?.commitment ||
    !Array.isArray(journal.steps) ||
    journal.steps.length !== plan.steps.length
  ) {
    throw new Error("extension deployment journal does not match its plan");
  }
  validateV3ExtensionLiveExecutionPlan({
    config,
    plan,
    executionPlan: journal.executionPlan,
  });
  const ranks = { planned: 0, prepared: 1, confirmed: 2 };
  let previous = 2;
  for (const [index, step] of journal.steps.entries()) {
    const approved = journal.executionPlan.steps[index];
    const rank = ranks[step?.status];
    if (rank === undefined || rank > previous) {
      throw new Error("extension journal step order is invalid");
    }
    previous = rank;
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
      if (step[field] !== approved[field]) {
        throw new Error(`${approved.name} journal transaction changed`);
      }
    }
    if (step.status === "planned") {
      if (step.intent !== undefined || step.receipt !== undefined) {
        throw new Error(`${step.name} planned step has execution state`);
      }
      continue;
    }
    const intent = object(step.intent, `${step.name} intent`);
    if (
      !isHexString(intent.transactionHash, 32) ||
      intent.chainId !== String(step.chainId) ||
      getAddress(intent.from) !== step.from ||
      intent.to !== step.to ||
      intent.nonce !== step.nonce ||
      intent.dataHash !== step.dataHash ||
      intent.value !== step.value ||
      intent.type !== step.type ||
      intent.gasLimit !== step.gasLimit ||
      intent.gasPrice !== step.gasPrice ||
      intent.maxFeePerGas !== step.maxFeePerGas ||
      intent.maxPriorityFeePerGas !== step.maxPriorityFeePerGas
    ) {
      throw new Error(`${step.name} journal intent changed`);
    }
    if (step.status === "prepared") {
      if (!isHexString(intent.rawTransaction) || step.receipt !== undefined) {
        throw new Error(`${step.name} prepared step is invalid`);
      }
      const parsed = validateSignedV3DeploymentStep(
        intent.rawTransaction,
        step,
      );
      if (parsed.hash.toLowerCase() !== intent.transactionHash) {
        throw new Error(`${step.name} prepared hash changed`);
      }
    } else {
      if (intent.rawTransaction !== undefined) {
        throw new Error(`${step.name} confirmed step retained signer material`);
      }
      const receipt = object(step.receipt, `${step.name} receipt`);
      if (
        receipt.hash !== intent.transactionHash ||
        receipt.status !== 1 ||
        !Number.isSafeInteger(receipt.blockNumber) ||
        !isHexString(receipt.blockHash, 32) ||
        receipt.contractAddress !== step.predictedContract
      ) {
        throw new Error(`${step.name} confirmed receipt is invalid`);
      }
    }
  }
  if (
    journal.phase === "complete" &&
    journal.steps.some(({ status }) => status !== "confirmed")
  ) {
    throw new Error("completed extension journal has unfinished steps");
  }
  return journal;
}

export function readV3ExtensionJournal({ manifestPath, config, plan }) {
  const path = v3ExtensionJournalPath(manifestPath);
  if (!existsSync(path)) return { path, journal: undefined };
  const journal = JSON.parse(readFileSync(path, "utf8"));
  validateJournal({ journal, config, plan });
  return { path, journal };
}

export function initializeV3ExtensionJournal({
  manifestPath,
  config,
  plan,
  qualification,
  approval,
}) {
  validateV3ExtensionLiveExecutionPlan({
    config,
    plan,
    executionPlan: approval?.executionPlan,
  });
  const existing = readV3ExtensionJournal({ manifestPath, config, plan });
  if (existing.journal) {
    if (
      existing.journal.executionPlanCommitment !==
        approval.executionPlanCommitment ||
      canonicalText(existing.journal.executionPlan) !==
        canonicalText(approval.executionPlan)
    ) {
      throw new Error(
        "extension journal does not match approved execution plan",
      );
    }
    return existing;
  }
  const now = new Date().toISOString();
  const journal = {
    schemaVersion: 1,
    generation: config.generation,
    phase: "deploying",
    configCommitment: plan.configCommitment,
    planCommitment: plan.planCommitment,
    predictedContracts: plan.predictedContracts,
    transactionPlan: plan.steps,
    executionPlan: approval.executionPlan,
    executionPlanCommitment: approval.executionPlanCommitment,
    qualification,
    steps: approval.executionPlan.steps.map((step) => ({
      ...step,
      status: "planned",
    })),
    createdAt: now,
    updatedAt: now,
  };
  const path = v3ExtensionJournalPath(manifestPath);
  atomicWriteJson(path, journal);
  return { path, journal };
}

export {
  completeV3DeploymentJournal as completeV3ExtensionJournal,
  prepareV3DeploymentStep as prepareV3ExtensionStep,
  reconcileV3DeploymentStep as reconcileV3ExtensionStep,
  reserveV3Manifest as reserveV3ExtensionManifest,
  validateSignedV3DeploymentStep as validateSignedV3ExtensionStep,
};

async function codeHash(provider, addressValue, label, blockTag) {
  const code = await provider.getCode(addressValue, blockTag);
  if (!isHexString(code) || code === "0x")
    throw new Error(`${label} has no bytecode`);
  return { code, hash: keccak256(code) };
}

function progressStatuses(deploymentProgress, plan) {
  if (deploymentProgress === undefined) return undefined;
  if (
    !Array.isArray(deploymentProgress) ||
    deploymentProgress.length !== plan.steps.length
  ) {
    throw new Error("extension deployment progress does not match plan");
  }
  return new Map(
    deploymentProgress.map((step, index) => {
      if (
        step.name !== plan.steps[index].name ||
        !["planned", "prepared", "confirmed"].includes(step.status)
      ) {
        throw new Error("extension deployment progress is invalid");
      }
      return [step.name, step.status];
    }),
  );
}

function callOptions(blockNumber) {
  return { blockTag: blockNumber };
}

async function qualifyClosedLoopState({
  config,
  plan,
  artifacts,
  provider,
  contractFactory,
  blockNumber,
  liveCode,
}) {
  const runtime = verifyPinnedArtifactRuntime({
    artifact: artifacts.ClosedLoopPolicyV1.artifact,
    liveCode,
    label: "ClosedLoopPolicyV1",
    immutableCount: 2,
  });
  const policy = contractFactory(
    plan.predictedContracts.ClosedLoopPolicyV1,
    artifacts.ClosedLoopPolicyV1.artifact.abi,
    provider,
  );
  const [context, coordinator, ordering] = await Promise.all([
    policy.context(callOptions(blockNumber)),
    policy.coordinator(callOptions(blockNumber)),
    policy.sourceOrdering(callOptions(blockNumber)),
  ]);
  sameAddress(context, config.bindings.policyKernel, "closed-loop context");
  sameAddress(
    coordinator,
    config.bindings.remedyCoordinator,
    "closed-loop coordinator",
  );
  sameValue(ordering, 0, "closed-loop source ordering");
  return {
    runtimeCodeHashes: { ClosedLoopPolicyV1: runtime.runtimeCodeHash },
    state: {
      context: getAddress(context),
      coordinator: getAddress(coordinator),
      sourceOrdering: Number(ordering),
    },
  };
}

async function qualifyMarketState({
  config,
  plan,
  artifacts,
  provider,
  contractFactory,
  blockNumber,
  liveCode,
}) {
  const runtime = verifyPinnedArtifactRuntime({
    artifact: artifacts.OperatorMarketV1.artifact,
    liveCode,
    label: "OperatorMarketV1",
    immutableCount: 5,
  });
  const marketAddress = plan.predictedContracts.OperatorMarketV1;
  const market = contractFactory(
    marketAddress,
    artifacts.OperatorMarketV1.artifact.abi,
    provider,
  );
  const token = contractFactory(config.asset.address, ERC20_ABI, provider);
  const [
    actualToken,
    verifier,
    bond,
    quoteDuration,
    serviceDuration,
    quotes,
    balance,
  ] = await Promise.all([
    market.token(callOptions(blockNumber)),
    market.verifier(callOptions(blockNumber)),
    market.minimumOperatorBond(callOptions(blockNumber)),
    market.maximumQuoteDuration(callOptions(blockNumber)),
    market.maximumServiceDuration(callOptions(blockNumber)),
    market.quoteCount(callOptions(blockNumber)),
    token.balanceOf(marketAddress, callOptions(blockNumber)),
  ]);
  sameAddress(actualToken, config.asset.address, "operator market token");
  sameAddress(
    verifier,
    config.bindings.operatorVerifier,
    "operator market verifier",
  );
  sameValue(
    bond,
    config.operatorMarket.minimumOperatorBond,
    "operator market bond",
  );
  sameValue(
    quoteDuration,
    config.operatorMarket.maximumQuoteDuration,
    "operator quote duration",
  );
  sameValue(
    serviceDuration,
    config.operatorMarket.maximumServiceDuration,
    "operator service duration",
  );
  sameValue(quotes, 0, "fresh operator quote count");
  return {
    runtimeCodeHashes: { OperatorMarketV1: runtime.runtimeCodeHash },
    state: {
      token: getAddress(actualToken),
      verifier: getAddress(verifier),
      minimumOperatorBond: BigInt(bond).toString(),
      maximumQuoteDuration: Number(quoteDuration),
      maximumServiceDuration: Number(serviceDuration),
      quoteCount: BigInt(quotes).toString(),
      tokenBalance: BigInt(balance).toString(),
    },
  };
}

async function qualifyPortfolioState({
  config,
  plan,
  artifacts,
  provider,
  contractFactory,
  blockNumber,
  liveCodes,
}) {
  const runtimeCodeHashes = {};
  for (const [name, count] of [
    ["PortfolioPoolV1", 9],
    ["CappedPilotFactoryV1", 12],
    ["PortfolioMandateV1", 12],
  ]) {
    runtimeCodeHashes[name] = verifyPinnedArtifactRuntime({
      artifact: artifacts[name].artifact,
      liveCode: liveCodes[name],
      label: name,
      immutableCount: count,
    }).runtimeCodeHash;
  }
  const poolAddress = plan.predictedContracts.PortfolioPoolV1;
  const factoryAddress = plan.predictedContracts.CappedPilotFactoryV1;
  const mandateAddress = plan.predictedContracts.PortfolioMandateV1;
  const pool = contractFactory(
    poolAddress,
    artifacts.PortfolioPoolV1.artifact.abi,
    provider,
  );
  const factory = contractFactory(
    factoryAddress,
    artifacts.CappedPilotFactoryV1.artifact.abi,
    provider,
  );
  const mandate = contractFactory(
    mandateAddress,
    artifacts.PortfolioMandateV1.artifact.abi,
    provider,
  );
  const token = contractFactory(config.asset.address, ERC20_ABI, provider);
  const option = callOptions(blockNumber);
  const [
    poolAsset,
    poolManager,
    maximumPoolAssets,
    maximumServiceBudget,
    maximumServiceJobDuration,
    poolFacilityCount,
    fundingDeadline,
    recoveryDelayBlocks,
    installedMandate,
    proofJobsVenue,
    poolStatus,
    totalSupply,
    totalDeposited,
    totalAllocatedPrincipal,
    totalRecovered,
    totalRealizedLoss,
    totalServiceEscrowed,
    totalServiceRecovered,
    createdFacilityCount,
    candidateCount,
    investorCount,
    tokenDecimals,
    poolTokenBalance,
    factoryAsset,
    factoryKernel,
    factoryLender,
    factoryBorrower,
    factoryGuardian,
    factoryMaximumFacilityLimit,
    factoryMaximumTotalLimit,
    factoryMinimumBondBps,
    factoryMaximumDrawFeeBps,
    factoryMaximumMaturityBlocks,
    factoryMaximumDrawDelayBlocks,
    factoryMaximumFacilityCount,
    creationPaused,
    totalFacilityLimit,
    factoryFacilityCount,
    mandateFactory,
    mandateRegistry,
    mandateAsset,
    mandateKernel,
    requiredReleaseId,
    requiredPolicySetCommitment,
    requiredEvidenceKind,
    requiredActionAdapterKind,
    mandateMaximumFacilityLimit,
    mandateMinimumBondBps,
    mandateMaximumDrawFeeBps,
    maximumRemainingMaturityBlocks,
  ] = await Promise.all([
    pool.asset(option),
    pool.manager(option),
    pool.maximumPoolAssets(option),
    pool.maximumServiceBudget(option),
    pool.maximumServiceJobDuration(option),
    pool.maximumFacilityCount(option),
    pool.fundingDeadline(option),
    pool.recoveryDelayBlocks(option),
    pool.mandate(option),
    pool.proofJobsVenue(option),
    pool.status(option),
    pool.totalSupply(option),
    pool.totalDeposited(option),
    pool.totalAllocatedPrincipal(option),
    pool.totalRecovered(option),
    pool.totalRealizedLoss(option),
    pool.totalServiceEscrowed(option),
    pool.totalServiceRecovered(option),
    pool.createdFacilityCount(option),
    pool.candidateCount(option),
    pool.investorCount(option),
    token.decimals(option),
    token.balanceOf(poolAddress, option),
    factory.asset(option),
    factory.kernel(option),
    factory.lender(option),
    factory.borrower(option),
    factory.guardian(option),
    factory.maximumFacilityLimit(option),
    factory.maximumTotalLimit(option),
    factory.minimumBondBps(option),
    factory.maximumDrawFeeBps(option),
    factory.maximumMaturityBlocks(option),
    factory.maximumDrawDelayBlocks(option),
    factory.maximumFacilityCount(option),
    factory.creationPaused(option),
    factory.totalFacilityLimit(option),
    factory.facilityCount(option),
    mandate.factory(option),
    mandate.registry(option),
    mandate.asset(option),
    mandate.kernel(option),
    mandate.requiredReleaseId(option),
    mandate.requiredPolicySetCommitment(option),
    mandate.requiredEvidenceKind(option),
    mandate.requiredActionAdapterKind(option),
    mandate.maximumFacilityLimit(option),
    mandate.minimumBondBps(option),
    mandate.maximumDrawFeeBps(option),
    mandate.maximumRemainingMaturityBlocks(option),
  ]);
  const expected = config.portfolio;
  for (const [actual, wanted, label] of [
    [poolAsset, config.asset.address, "pool asset"],
    [poolManager, config.roles.manager, "pool manager"],
    [installedMandate, mandateAddress, "pool mandate"],
    [proofJobsVenue, ZeroAddress, "pool ProofJobs venue"],
    [factoryAsset, config.asset.address, "factory asset"],
    [factoryKernel, config.bindings.policyKernel, "factory kernel"],
    [factoryLender, poolAddress, "factory lender"],
    [factoryBorrower, config.roles.borrower, "factory borrower"],
    [factoryGuardian, config.roles.guardian, "factory guardian"],
    [mandateFactory, factoryAddress, "mandate factory"],
    [mandateRegistry, config.bindings.policyRegistry, "mandate registry"],
    [mandateAsset, config.asset.address, "mandate asset"],
    [mandateKernel, config.bindings.policyKernel, "mandate kernel"],
  ])
    sameAddress(actual, wanted, label);
  for (const [actual, wanted, label] of [
    [maximumPoolAssets, expected.pool.maximumPoolAssets, "pool maximum assets"],
    [
      maximumServiceBudget,
      expected.pool.maximumServiceBudget,
      "pool service budget",
    ],
    [
      maximumServiceJobDuration,
      expected.pool.maximumServiceJobDuration,
      "pool service duration",
    ],
    [
      poolFacilityCount,
      expected.pool.maximumFacilityCount,
      "pool facility count bound",
    ],
    [fundingDeadline, expected.pool.fundingDeadline, "pool funding deadline"],
    [
      recoveryDelayBlocks,
      expected.pool.recoveryDelayBlocks,
      "pool recovery delay",
    ],
    [tokenDecimals, config.asset.decimals, "asset decimals"],
    [
      factoryMaximumFacilityLimit,
      expected.factory.maximumFacilityLimit,
      "factory facility limit",
    ],
    [
      factoryMaximumTotalLimit,
      expected.factory.maximumTotalLimit,
      "factory total limit",
    ],
    [
      factoryMinimumBondBps,
      expected.factory.minimumBondBps,
      "factory minimum bond",
    ],
    [
      factoryMaximumDrawFeeBps,
      expected.factory.maximumDrawFeeBps,
      "factory draw fee",
    ],
    [
      factoryMaximumMaturityBlocks,
      expected.factory.maximumMaturityBlocks,
      "factory maturity",
    ],
    [
      factoryMaximumDrawDelayBlocks,
      expected.factory.maximumDrawDelayBlocks,
      "factory draw delay",
    ],
    [
      factoryMaximumFacilityCount,
      expected.factory.maximumFacilityCount,
      "factory count bound",
    ],
    [
      requiredEvidenceKind,
      expected.mandate.requiredEvidenceKind,
      "mandate evidence kind",
    ],
    [
      mandateMaximumFacilityLimit,
      expected.mandate.maximumFacilityLimit,
      "mandate facility limit",
    ],
    [
      mandateMinimumBondBps,
      expected.mandate.minimumBondBps,
      "mandate minimum bond",
    ],
    [
      mandateMaximumDrawFeeBps,
      expected.mandate.maximumDrawFeeBps,
      "mandate draw fee",
    ],
    [
      maximumRemainingMaturityBlocks,
      expected.mandate.maximumRemainingMaturityBlocks,
      "mandate maturity",
    ],
  ])
    sameValue(actual, wanted, label);
  if (requiredReleaseId.toLowerCase() !== expected.mandate.requiredReleaseId)
    throw new Error("mandate release ID mismatch");
  if (
    requiredPolicySetCommitment.toLowerCase() !==
    expected.mandate.requiredPolicySetCommitment
  )
    throw new Error("mandate policy-set commitment mismatch");
  if (
    requiredActionAdapterKind.toLowerCase() !==
    expected.mandate.requiredActionAdapterKind
  )
    throw new Error("mandate action-adapter kind mismatch");
  for (const [actual, label] of [
    [poolStatus, "pool status"],
    [poolTokenBalance, "pool initial token balance"],
    [totalSupply, "pool total supply"],
    [totalDeposited, "pool deposited assets"],
    [totalAllocatedPrincipal, "pool allocated principal"],
    [totalRecovered, "pool recovered assets"],
    [totalRealizedLoss, "pool realized loss"],
    [totalServiceEscrowed, "pool service escrow"],
    [totalServiceRecovered, "pool service recovery"],
    [createdFacilityCount, "pool created facilities"],
    [candidateCount, "pool candidates"],
    [investorCount, "pool investors"],
    [totalFacilityLimit, "factory total facility limit"],
    [factoryFacilityCount, "factory facility count"],
  ])
    sameValue(actual, 0, label);
  if (creationPaused !== false) throw new Error("portfolio factory is paused");
  return {
    runtimeCodeHashes,
    state: {
      pool: {
        asset: getAddress(poolAsset),
        manager: getAddress(poolManager),
        mandate: getAddress(installedMandate),
        status: Number(poolStatus),
        proofJobsVenue: getAddress(proofJobsVenue),
        tokenBalance: BigInt(poolTokenBalance).toString(),
        totalSupply: BigInt(totalSupply).toString(),
      },
      factory: {
        asset: getAddress(factoryAsset),
        kernel: getAddress(factoryKernel),
        lender: getAddress(factoryLender),
        borrower: getAddress(factoryBorrower),
        guardian: getAddress(factoryGuardian),
        creationPaused,
        facilityCount: BigInt(factoryFacilityCount).toString(),
      },
      mandate: {
        factory: getAddress(mandateFactory),
        registry: getAddress(mandateRegistry),
        asset: getAddress(mandateAsset),
        kernel: getAddress(mandateKernel),
        requiredReleaseId: requiredReleaseId.toLowerCase(),
        requiredPolicySetCommitment: requiredPolicySetCommitment.toLowerCase(),
        requiredActionAdapterKind: requiredActionAdapterKind.toLowerCase(),
      },
    },
  };
}

export async function qualifyV3ExtensionDeployment({
  provider,
  config,
  plan,
  artifacts,
  contractFactory = (addressValue, abi, runner) =>
    new Contract(addressValue, abi, runner),
  deploymentComplete = false,
  deploymentProgress,
  blockTag = "latest",
}) {
  assertPlan(config, plan);
  const progress = progressStatuses(deploymentProgress, plan);
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(config.chainId))
    throw new Error("extension RPC chain identity mismatch");
  const block = await provider.getBlock(blockTag);
  if (
    !Number.isSafeInteger(block?.number) ||
    !isHexString(block?.hash, 32) ||
    !Number.isSafeInteger(block?.timestamp)
  ) {
    throw new Error("extension qualification block anchor is unavailable");
  }
  const pendingNonce = await provider.getTransactionCount(
    config.deployer,
    blockTag === "latest" ? "pending" : block.number,
  );
  if (!deploymentComplete) {
    if (!progress) {
      if (pendingNonce !== config.expectedStartingNonce)
        throw new Error("extension deployer pending nonce differs from plan");
    } else {
      const confirmed = deploymentProgress.filter(
        ({ status }) => status === "confirmed",
      ).length;
      const prepared = deploymentProgress.filter(
        ({ status }) => status === "prepared",
      ).length;
      const minimum = config.expectedStartingNonce + confirmed;
      const maximum = minimum + prepared;
      if (pendingNonce < minimum || pendingNonce > maximum)
        throw new Error(
          "extension deployer nonce differs from journal progress",
        );
    }
  } else if (pendingNonce < config.expectedStartingNonce + plan.steps.length) {
    throw new Error(
      "extension deployer nonce does not cover the completed plan",
    );
  }
  const nativeBalance = await provider.getBalance(
    config.deployer,
    block.number,
  );
  if (
    !deploymentComplete &&
    BigInt(nativeBalance) < BigInt(config.requirements.minimumNativeWei)
  ) {
    throw new Error("extension deployer native balance is below requirement");
  }
  if (
    config.generation === "v3-portfolio-core-v1" &&
    !deploymentComplete &&
    config.portfolio.pool.fundingDeadline <
      block.timestamp + config.portfolio.safety.minimumFundingWindowSeconds
  ) {
    throw new Error(
      "portfolio funding deadline lacks the configured safety window",
    );
  }
  const prerequisiteAddresses =
    config.generation === "v3-closed-loop-v1"
      ? {
          policyKernel: config.bindings.policyKernel,
          remedyCoordinator: config.bindings.remedyCoordinator,
          remedyTransport: config.bindings.remedyTransport,
        }
      : config.generation === "v3-operator-market-v1"
        ? {
            token: config.asset.address,
            operatorVerifier: config.bindings.operatorVerifier,
          }
        : {
            asset: config.asset.address,
            policyKernel: config.bindings.policyKernel,
            policyRegistry: config.bindings.policyRegistry,
          };
  const prerequisiteCodeHashes = {};
  for (const [name, addressValue] of Object.entries(prerequisiteAddresses)) {
    const result = await codeHash(provider, addressValue, name, block.number);
    prerequisiteCodeHashes[name] = result.hash;
  }
  if (
    config.generation === "v3-closed-loop-v1" &&
    (prerequisiteCodeHashes.remedyCoordinator !==
      config.bindings.remedyCoordinatorRuntimeCodeKeccak256 ||
      prerequisiteCodeHashes.remedyTransport !==
        config.bindings.remedyTransportRuntimeCodeKeccak256)
  ) {
    throw new Error("remedy prerequisite runtime mismatch");
  }
  if (
    config.bindings.policyKernelRuntimeCodeKeccak256 &&
    prerequisiteCodeHashes.policyKernel !==
      config.bindings.policyKernelRuntimeCodeKeccak256
  ) {
    throw new Error("core PolicyKernelV2 prerequisite runtime mismatch");
  }
  if (
    config.generation === "v3-portfolio-core-v1" &&
    prerequisiteCodeHashes.policyRegistry !==
      config.bindings.policyRegistryRuntimeCodeKeccak256
  ) {
    throw new Error("core PolicyRegistryV1 prerequisite runtime mismatch");
  }
  if (
    config.generation === "v3-portfolio-core-v1" &&
    prerequisiteCodeHashes.asset !== config.asset.runtimeCodeKeccak256
  ) {
    throw new Error("portfolio asset runtime mismatch");
  }
  if (
    config.generation === "v3-operator-market-v1" &&
    prerequisiteCodeHashes.operatorVerifier !==
      config.bindings.operatorVerifierRuntimeCodeKeccak256
  ) {
    throw new Error("operator verifier runtime mismatch");
  }
  if (
    config.generation === "v3-operator-market-v1" &&
    prerequisiteCodeHashes.token !== config.asset.runtimeCodeKeccak256
  ) {
    throw new Error("operator market token runtime mismatch");
  }
  if (config.asset) {
    const token = contractFactory(config.asset.address, ERC20_ABI, provider);
    sameValue(
      await token.decimals(callOptions(block.number)),
      config.asset.decimals,
      "extension asset decimals",
    );
  }
  let registryQualification;
  if (config.generation === "v3-portfolio-core-v1") {
    const registry = contractFactory(
      config.bindings.policyRegistry,
      POLICY_REGISTRY_ABI,
      provider,
    );
    const releaseId = config.portfolio.mandate.requiredReleaseId;
    const evidenceKind = config.portfolio.mandate.requiredEvidenceKind;
    const requiredAdapterKind =
      config.portfolio.mandate.requiredActionAdapterKind;
    const [release, evidenceKindDeclared, adapterCountValue] =
      await Promise.all([
        registry.packageRelease(releaseId, callOptions(block.number)),
        registry.declaresEvidenceKind(
          releaseId,
          evidenceKind,
          callOptions(block.number),
        ),
        registry.actionAdapterCount(releaseId, callOptions(block.number)),
      ]);
    if (release?.exists !== true) {
      throw new Error("portfolio mandate package release does not exist");
    }
    if (evidenceKindDeclared !== true) {
      throw new Error("portfolio mandate evidence kind is not declared");
    }
    const adapterCount = BigInt(adapterCountValue);
    if (adapterCount === 0n || adapterCount > 32n) {
      throw new Error("portfolio mandate action adapter set is invalid");
    }
    const adapters = await Promise.all(
      Array.from({ length: Number(adapterCount) }, (_value, index) =>
        registry.actionAdapterAt(releaseId, index, callOptions(block.number)),
      ),
    );
    const actionAdapterMatched = adapters.some(
      (adapter) =>
        digest(adapter?.adapterKind, "portfolio action adapter kind") ===
        requiredAdapterKind,
    );
    if (!actionAdapterMatched) {
      throw new Error(
        "portfolio mandate required action adapter kind is absent",
      );
    }
    registryQualification = {
      releaseId,
      releaseExists: true,
      evidenceKind,
      evidenceKindDeclared: true,
      requiredActionAdapterKind: requiredAdapterKind,
      actionAdapterCount: adapterCount.toString(),
      actionAdapterMatched: true,
    };
  }
  const predictedCodeHashes = {};
  const liveCodes = {};
  for (const [name, addressValue] of Object.entries(plan.predictedContracts)) {
    const code = await provider.getCode(addressValue, block.number);
    if (!isHexString(code))
      throw new Error(`${name} bytecode response is invalid`);
    const stepStatus = progress?.get(name) ?? "planned";
    if (deploymentComplete || stepStatus === "confirmed") {
      if (code === "0x") throw new Error(`${name} has no deployed bytecode`);
      predictedCodeHashes[name] = keccak256(code);
      liveCodes[name] = code;
    } else if (stepStatus === "planned") {
      if (code !== "0x")
        throw new Error(`${name} predicted address already has bytecode`);
      predictedCodeHashes[name] = null;
    } else {
      predictedCodeHashes[name] =
        code === "0x" ? "prepared-no-code" : keccak256(code);
      if (code !== "0x") liveCodes[name] = code;
    }
  }
  let runtimeQualification;
  let stateQualification;
  if (deploymentComplete) {
    let result;
    if (config.generation === "v3-closed-loop-v1") {
      result = await qualifyClosedLoopState({
        config,
        plan,
        artifacts,
        provider,
        contractFactory,
        blockNumber: block.number,
        liveCode: liveCodes.ClosedLoopPolicyV1,
      });
    } else if (config.generation === "v3-operator-market-v1") {
      result = await qualifyMarketState({
        config,
        plan,
        artifacts,
        provider,
        contractFactory,
        blockNumber: block.number,
        liveCode: liveCodes.OperatorMarketV1,
      });
    } else {
      result = await qualifyPortfolioState({
        config,
        plan,
        artifacts,
        provider,
        contractFactory,
        blockNumber: block.number,
        liveCodes,
      });
    }
    runtimeQualification = result.runtimeCodeHashes;
    stateQualification = result.state;
  }
  const canonicalBlock = await provider.getBlock(block.number);
  if (canonicalBlock?.hash?.toLowerCase() !== block.hash.toLowerCase()) {
    throw new Error("extension qualification block is no longer canonical");
  }
  return {
    schemaVersion: 1,
    generation: config.generation,
    planCommitment: plan.planCommitment,
    chainId: config.chainId,
    blockNumber: block.number,
    blockHash: block.hash.toLowerCase(),
    blockTimestamp: block.timestamp,
    pendingNonce,
    deployer: config.deployer,
    nativeBalance: BigInt(nativeBalance).toString(),
    artifactHashes: plan.artifactHashes,
    prerequisiteCodeHashes,
    ...(registryQualification ? { registryQualification } : {}),
    predictedCodeHashes,
    ...(runtimeQualification ? { runtimeQualification } : {}),
    ...(stateQualification ? { stateQualification } : {}),
  };
}

function validateCanonicalReceipt(receipt, transactionHash, step) {
  if (
    !receipt ||
    receipt.hash?.toLowerCase() !== transactionHash ||
    receipt.status !== 1 ||
    !Number.isSafeInteger(receipt.blockNumber) ||
    !isHexString(receipt.blockHash, 32) ||
    (receipt.contractAddress ? getAddress(receipt.contractAddress) : null) !==
      step.predictedContract
  ) {
    throw new Error(`${step.name} canonical receipt is invalid`);
  }
}

export async function verifyV3ExtensionTransactions({
  manifest,
  config,
  plan,
  provider,
}) {
  validateV3ExtensionLiveExecutionPlan({
    config,
    plan,
    executionPlan: manifest.executionPlan,
  });
  if (manifest.executionPlanCommitment !== manifest.executionPlan.commitment) {
    throw new Error("extension manifest execution commitment mismatch");
  }
  const expectedNames = plan.steps.map(({ name }) => name).sort();
  if (
    JSON.stringify(Object.keys(manifest.transactions ?? {}).sort()) !==
    JSON.stringify(expectedNames)
  ) {
    throw new Error("extension manifest transaction set mismatch");
  }
  const verified = {};
  for (const step of manifest.executionPlan.steps) {
    const record = manifest.transactions[step.name];
    if (!isHexString(record?.hash, 32))
      throw new Error(`missing ${step.name} transaction evidence`);
    const hash = record.hash.toLowerCase();
    const [transaction, receipt] = await Promise.all([
      provider.getTransaction(hash),
      provider.getTransactionReceipt(hash),
    ]);
    if (!transaction || transaction.hash?.toLowerCase() !== hash) {
      throw new Error(`${step.name} canonical transaction is unavailable`);
    }
    validateSignedV3DeploymentStep(transaction, step);
    validateCanonicalReceipt(receipt, hash, step);
    const canonicalBlock = await provider.getBlock(receipt.blockNumber);
    if (
      canonicalBlock?.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()
    ) {
      throw new Error(`${step.name} receipt is no longer canonical`);
    }
    const confirmedThrough = await provider.getBlockNumber();
    if (
      confirmedThrough <
      receipt.blockNumber + config.transactionPolicy.targetConfirmations - 1
    ) {
      throw new Error(`${step.name} lacks required canonical confirmations`);
    }
    if (
      record.blockNumber !== receipt.blockNumber ||
      record.blockHash?.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      (record.contractAddress ? getAddress(record.contractAddress) : null) !==
        step.predictedContract
    ) {
      throw new Error(`${step.name} manifest transaction evidence mismatch`);
    }
    verified[step.name] = {
      hash,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash.toLowerCase(),
      contractAddress: step.predictedContract,
      dataHash: step.dataHash,
      nonce: step.nonce,
    };
  }
  return verified;
}

export function buildV3ExtensionManifest({
  config,
  plan,
  journal,
  finalQualification,
  canonicalTransactions,
  journalPath,
}) {
  if (journal.steps.some(({ status }) => status !== "confirmed")) {
    throw new Error("cannot build extension manifest with unfinished steps");
  }
  const transactions = Object.fromEntries(
    journal.steps.map((step) => [
      step.name,
      {
        hash: step.receipt.hash,
        blockNumber: step.receipt.blockNumber,
        blockHash: step.receipt.blockHash,
        contractAddress: step.receipt.contractAddress,
      },
    ]),
  );
  return {
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
    executionPlan: journal.executionPlan,
    executionPlanCommitment: journal.executionPlanCommitment,
    transactions,
    canonicalTransactions,
    finalQualification,
    journalPath: resolve(journalPath),
  };
}

export function validateV3ExtensionManifest({
  manifest,
  config,
  plan,
  finalQualification = manifest?.finalQualification,
  canonicalTransactions = manifest?.canonicalTransactions,
}) {
  const expectedContracts = Object.keys(plan.predictedContracts).sort();
  const expectedTransactions = plan.steps.map(({ name }) => name).sort();
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.status !== "deployed-qualified" ||
    manifest.generation !== config.generation ||
    manifest.chainId !== config.chainId ||
    manifest.configCommitment !== plan.configCommitment ||
    manifest.planCommitment !== plan.planCommitment ||
    canonicalText(manifest.prerequisites) !==
      canonicalText(plan.prerequisites) ||
    canonicalText(manifest.artifactHashes) !==
      canonicalText(plan.artifactHashes) ||
    canonicalText(manifest.constructors) !== canonicalText(plan.constructors) ||
    canonicalText(manifest.contracts) !==
      canonicalText(plan.predictedContracts) ||
    canonicalText(manifest.transactionPlan) !== canonicalText(plan.steps) ||
    manifest.executionPlanCommitment !== manifest.executionPlan?.commitment ||
    canonicalText(manifest.finalQualification) !==
      canonicalText(finalQualification) ||
    canonicalText(manifest.canonicalTransactions) !==
      canonicalText(canonicalTransactions) ||
    JSON.stringify(Object.keys(manifest.contracts ?? {}).sort()) !==
      JSON.stringify(expectedContracts) ||
    JSON.stringify(Object.keys(manifest.transactions ?? {}).sort()) !==
      JSON.stringify(expectedTransactions) ||
    JSON.stringify(Object.keys(manifest.canonicalTransactions ?? {}).sort()) !==
      JSON.stringify(expectedTransactions) ||
    finalQualification?.planCommitment !== plan.planCommitment ||
    finalQualification?.generation !== config.generation ||
    !finalQualification?.runtimeQualification ||
    !finalQualification?.stateQualification
  ) {
    throw new Error(
      "extension deployment manifest does not match the qualified plan",
    );
  }
  validateV3ExtensionLiveExecutionPlan({
    config,
    plan,
    executionPlan: manifest.executionPlan,
  });
  return manifest;
}
