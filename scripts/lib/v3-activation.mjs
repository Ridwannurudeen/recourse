import {
  AbiCoder,
  Transaction,
  ZeroAddress,
  ZeroHash,
  formatUnits,
  getAddress,
  getCreateAddress,
  isHexString,
  keccak256,
  toUtf8Bytes,
  zeroPadValue,
} from "ethers";
import { createHash } from "node:crypto";
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

export const EXPECTED_V3_ACTIVATION_CHAIN_ID = 102031;
export const ACTIVATION_TRANSACTION_COUNT = 13;
export const MINIMUM_SOURCE_WINDOW_BUFFER_BLOCKS = 128;
export const MAXIMUM_POLICY_RULES = 16;
export const LIVE_PLAN_VALIDITY_SECONDS = 1_800;
export const MULTI_CHAIN_SOURCE_ORDERING = 1;
export const V3_ACTIVATION_USAGE = `Usage: node scripts/activate-v3-pilot.mjs [options]

Default: deterministic offline dry-run; no RPC, signer, file write, or broadcast.

Fresh core-manifest handoff:
  1. Deploy the reviewed current core to a new manifest, for example deployments-v3-current.json.
  2. Set config.coreManifest.path to that exact filename.
  3. Set config.coreManifest.sha256 to the lowercase SHA-256 of those exact manifest bytes.
  4. Pass the same file with --core-manifest. The checked-in deployments-v3.json remains historical.

Options:
  --config <path>             Activation config (default: config/v3-pilot-cc3.json)
  --core-manifest <path>      Exact core manifest pinned by config path and SHA-256
  --manifest <path>           Activation result/journal base (default: activation-v3.json)
  --live-check                Read and qualify current chain/source state
  --write-plan <path>         Write an expiring live plan for human approval
  --broadcast                 Broadcast only an exact approved live plan
  --approved-plan <path>      Human-approved live plan required by --broadcast
  --help, -h                  Show this help and exit`;
const SOURCE_NETWORKS = Object.freeze({
  1: Object.freeze({
    evmChainId: 11155111,
    rpcUrlEnvironment: "SEPOLIA_RPC_URL",
  }),
  3: Object.freeze({
    evmChainId: 1,
    rpcUrlEnvironment: "ETH_MAINNET_RPC_URL",
  }),
});

const ZERO_BYTES32 = ZeroHash;
const ABI = AbiCoder.defaultAbiCoder();
const POLICY_EFFECT_TUPLE =
  "tuple(uint8 outcome,uint16 creditLimitBps,uint16 futureDrawFeeBps,bool freezePendingDraw,bool requireFreshEvidence,bool terminate)";
const POLICY_RULE_TUPLE =
  "tuple(uint64 sourceChain,address emitter,bytes32 eventSignature,uint64 startSourceBlock,uint64 endSourceBlock,uint8 topicCount,uint8 subjectTopicIndex,uint16 dataLength,uint16 observedValueOffset,uint8 observationKind,uint32 riskWeight)";
const POLICY_CONFIGURATION_TUPLE = `tuple(address subject,uint64 freshnessPeriod,uint32 watchThreshold,uint32 restrictedThreshold,uint32 marginThreshold,uint32 breachThreshold,${POLICY_EFFECT_TUPLE} watchEffect,${POLICY_EFFECT_TUPLE} restrictedEffect,${POLICY_EFFECT_TUPLE} marginEffect,${POLICY_EFFECT_TUPLE} breachEffect,${POLICY_RULE_TUPLE}[] rules)`;
const ACTION_ADAPTER_TUPLE =
  "tuple(bytes32 adapterKind,bytes32 specificationHash,string metadataURI)";
const REQUIRED_ARTIFACTS = [
  "CappedPilotFactoryV1",
  "MultiChainEventPolicyV1",
  "RecourseFacilityV3",
];
const SIGNER_ROLES = ["deployer", "lender", "borrower", "hunter"];
const CORE_ROLES = ["deployer", "lender", "borrower", "guardian"];
const CORE_CONTRACTS = [
  "policyKernel",
  "verifiedCreditState",
  "policyRegistry",
  "cappedPilotFactory",
  "multiChainEventPolicy",
  "proofJobs",
];
const CORE_RUNTIME_ARTIFACTS = {
  policyKernel: "PolicyKernelV2",
  verifiedCreditState: "VerifiedCreditStateV1",
  policyRegistry: "PolicyRegistryV1",
  cappedPilotFactory: "CappedPilotFactoryV1",
  multiChainEventPolicy: "MultiChainEventPolicyV1",
  proofJobs: "ProofJobsV1",
};

export async function assertV3ActivationStepSafety({
  label,
  requireSourceSafety,
  requireExpirySafety,
  assertApprovalCurrent,
  assertSourceSafety,
  assertExpiryCurrent,
}) {
  await assertApprovalCurrent(label);
  if (requireSourceSafety) await assertSourceSafety(label);
  if (requireExpirySafety) await assertExpiryCurrent(label);
  return true;
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function address(value, label) {
  const normalized = getAddress(value);
  if (normalized === ZeroAddress)
    throw new Error(`${label} must not be the zero address`);
  return normalized;
}

function bytes32(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must be bytes32`);
  }
  const normalized = value.toLowerCase();
  if (normalized === ZERO_BYTES32) throw new Error(`${label} must not be zero`);
  return normalized;
}

function sha256Digest(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function decimal(value, label, { positive = true } = {}) {
  const expression = positive ? /^[1-9][0-9]*$/ : /^(0|[1-9][0-9]*)$/;
  if (typeof value !== "string" || !expression.test(value)) {
    throw new Error(
      `${label} must be a ${positive ? "positive" : "nonnegative"} base-10 integer string`,
    );
  }
  return BigInt(value);
}

function integer(value, label, maximum, { positive = false } = {}) {
  if (
    !Number.isSafeInteger(value) ||
    value < (positive ? 1 : 0) ||
    value > maximum
  ) {
    throw new Error(
      `${label} must be ${positive ? "a positive" : "a nonnegative"} integer no greater than ${maximum}`,
    );
  }
  return value;
}

function transactionFeePolicy(value, label) {
  const input = object(value, label);
  if (
    input.transactionType !== "eip1559" &&
    input.transactionType !== "legacy"
  ) {
    throw new Error(`${label}.transactionType must be eip1559 or legacy`);
  }
  const normalized = {
    transactionType: input.transactionType,
    maximumGasLimit: decimal(input.maximumGasLimit, `${label}.maximumGasLimit`),
  };
  if (input.transactionType === "eip1559") {
    if (input.maximumGasPrice !== undefined) {
      throw new Error(`${label} mixes legacy and EIP-1559 fee fields`);
    }
    normalized.maximumFeePerGas = decimal(
      input.maximumFeePerGas,
      `${label}.maximumFeePerGas`,
    );
    normalized.maximumPriorityFeePerGas = decimal(
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
    normalized.maximumGasPrice = decimal(
      input.maximumGasPrice,
      `${label}.maximumGasPrice`,
    );
  }
  return normalized;
}

function transactionFeePolicyRecord(policy) {
  return {
    transactionType: policy.transactionType,
    maximumGasLimit: policy.maximumGasLimit.toString(),
    maximumGasPrice:
      policy.transactionType === "legacy"
        ? policy.maximumGasPrice.toString()
        : undefined,
    maximumFeePerGas:
      policy.transactionType === "eip1559"
        ? policy.maximumFeePerGas.toString()
        : undefined,
    maximumPriorityFeePerGas:
      policy.transactionType === "eip1559"
        ? policy.maximumPriorityFeePerGas.toString()
        : undefined,
  };
}

function transactionFeeFields(transaction, policy, label) {
  const gasLimit = BigInt(transaction.gasLimit ?? 0);
  if (gasLimit === 0n) throw new Error(`${label} gasLimit must be positive`);
  if (gasLimit > policy.maximumGasLimit) {
    throw new Error(`${label} gasLimit exceeds the configured maximum`);
  }
  if (policy.transactionType === "eip1559") {
    if (Number(transaction.type) !== 2) {
      throw new Error(`${label} requires an EIP-1559 transaction`);
    }
    if (transaction.gasPrice != null) {
      throw new Error(`${label} mixes legacy and EIP-1559 fee fields`);
    }
    if (
      transaction.maxFeePerGas == null ||
      transaction.maxPriorityFeePerGas == null
    ) {
      throw new Error(`${label} is missing EIP-1559 fee fields`);
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
  if (Number(transaction.type) !== 0) {
    throw new Error(`${label} requires a legacy transaction`);
  }
  if (
    transaction.gasPrice == null ||
    transaction.maxFeePerGas != null ||
    transaction.maxPriorityFeePerGas != null
  ) {
    throw new Error(`${label} mixes legacy and EIP-1559 fee fields`);
  }
  const gasPrice = BigInt(transaction.gasPrice);
  if (gasPrice === 0n) throw new Error(`${label} gasPrice must be positive`);
  if (gasPrice > policy.maximumGasPrice) {
    throw new Error(`${label} gasPrice exceeds the configured maximum`);
  }
  return {
    type: 0,
    gasLimit: gasLimit.toString(),
    gasPrice: gasPrice.toString(),
    maxFeePerGas: null,
    maxPriorityFeePerGas: null,
  };
}

function boolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function string(value, label, maximumBytes) {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${label} must be a nonempty string`);
  if (Buffer.byteLength(value) > maximumBytes)
    throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  return value;
}

function sameAddress(actual, expected, label) {
  if (getAddress(actual) !== getAddress(expected))
    throw new Error(`${label} mismatch`);
}

function normalizeEffect(value, label, expectedOutcome) {
  const effect = object(value, label);
  const outcome = integer(effect.outcome, `${label}.outcome`, 5);
  if (outcome !== expectedOutcome)
    throw new Error(`${label}.outcome must be ${expectedOutcome}`);
  return {
    outcome,
    creditLimitBps: integer(
      effect.creditLimitBps,
      `${label}.creditLimitBps`,
      10_000,
    ),
    futureDrawFeeBps: integer(
      effect.futureDrawFeeBps,
      `${label}.futureDrawFeeBps`,
      10_000,
    ),
    freezePendingDraw: boolean(
      effect.freezePendingDraw,
      `${label}.freezePendingDraw`,
    ),
    requireFreshEvidence: boolean(
      effect.requireFreshEvidence,
      `${label}.requireFreshEvidence`,
    ),
    terminate: boolean(effect.terminate, `${label}.terminate`),
  };
}

function normalizeRule(value, index) {
  const label = `policy.configuration.rules[${index}]`;
  const rule = object(value, label);
  const normalized = {
    sourceChain: integer(
      rule.sourceChain,
      `${label}.sourceChain`,
      Number.MAX_SAFE_INTEGER,
      { positive: true },
    ),
    emitter: address(rule.emitter, `${label}.emitter`),
    eventSignature: bytes32(rule.eventSignature, `${label}.eventSignature`),
    startSourceBlock: integer(
      rule.startSourceBlock,
      `${label}.startSourceBlock`,
      Number.MAX_SAFE_INTEGER,
    ),
    endSourceBlock: integer(
      rule.endSourceBlock,
      `${label}.endSourceBlock`,
      Number.MAX_SAFE_INTEGER,
    ),
    topicCount: integer(rule.topicCount, `${label}.topicCount`, 4, {
      positive: true,
    }),
    subjectTopicIndex: integer(
      rule.subjectTopicIndex,
      `${label}.subjectTopicIndex`,
      3,
      { positive: true },
    ),
    dataLength: integer(rule.dataLength, `${label}.dataLength`, 0xffff, {
      positive: true,
    }),
    observedValueOffset: integer(
      rule.observedValueOffset,
      `${label}.observedValueOffset`,
      0xffff,
    ),
    observationKind: integer(
      rule.observationKind,
      `${label}.observationKind`,
      4,
    ),
    riskWeight: integer(rule.riskWeight, `${label}.riskWeight`, 0xffffffff, {
      positive: true,
    }),
  };
  if (normalized.startSourceBlock > normalized.endSourceBlock)
    throw new Error(`${label} source window is invalid`);
  if (
    normalized.topicCount < 2 ||
    normalized.subjectTopicIndex >= normalized.topicCount
  ) {
    throw new Error(`${label} topic layout is invalid`);
  }
  if (
    normalized.dataLength % 32 !== 0 ||
    normalized.observedValueOffset % 32 !== 0 ||
    normalized.observedValueOffset + 32 > normalized.dataLength
  ) {
    throw new Error(`${label} data layout is invalid`);
  }
  return normalized;
}

function predicatesOverlap(first, second) {
  return Boolean(
    first.sourceChain === second.sourceChain &&
    first.emitter === second.emitter &&
    first.eventSignature === second.eventSignature &&
    first.topicCount === second.topicCount &&
    first.subjectTopicIndex === second.subjectTopicIndex &&
    first.dataLength === second.dataLength &&
    first.startSourceBlock <= second.endSourceBlock &&
    second.startSourceBlock <= first.endSourceBlock,
  );
}

function normalizeSourceNetworks(value, rules) {
  const input = object(value, "sourceNetworks");
  const requiredChains = [
    ...new Set(rules.map(({ sourceChain }) => sourceChain.toString())),
  ].sort((left, right) => Number(left) - Number(right));
  const suppliedChains = Object.keys(input).sort(
    (left, right) => Number(left) - Number(right),
  );
  if (
    suppliedChains.length !== requiredChains.length ||
    suppliedChains.some((chain, index) => chain !== requiredChains[index])
  ) {
    throw new Error("sourceNetworks must exactly cover policy source chains");
  }
  return Object.fromEntries(
    requiredChains.map((chain) => {
      const label = `sourceNetworks.${chain}`;
      const expectedNetwork = SOURCE_NETWORKS[chain];
      if (!expectedNetwork) {
        throw new Error(`Unsupported CC3 source chain key ${chain}`);
      }
      const network = object(input[chain], label);
      const rpcUrlEnvironment = string(
        network.rpcUrlEnvironment,
        `${label}.rpcUrlEnvironment`,
        128,
      );
      if (!/^[A-Z][A-Z0-9_]*$/.test(rpcUrlEnvironment)) {
        throw new Error(`${label}.rpcUrlEnvironment is invalid`);
      }
      const evmChainId = integer(
        network.evmChainId,
        `${label}.evmChainId`,
        Number.MAX_SAFE_INTEGER,
        { positive: true },
      );
      if (
        evmChainId !== expectedNetwork.evmChainId ||
        rpcUrlEnvironment !== expectedNetwork.rpcUrlEnvironment
      ) {
        throw new Error(
          `${label} must bind CC3 key ${chain} to EVM chain ${expectedNetwork.evmChainId} via ${expectedNetwork.rpcUrlEnvironment}`,
        );
      }
      return [chain, { evmChainId, rpcUrlEnvironment }];
    }),
  );
}

function normalizeCoreManifest(input) {
  const core = object(input, "core manifest");
  if (core.schemaVersion !== 2)
    throw new Error("core manifest schemaVersion must be 2");
  if (core.generation !== "v3-core")
    throw new Error("core manifest generation must be v3-core");
  if (core.status !== "deployed-qualified")
    throw new Error("core manifest status must be deployed-qualified");
  if (core.chainId !== EXPECTED_V3_ACTIVATION_CHAIN_ID) {
    throw new Error(
      `core manifest chainId must be ${EXPECTED_V3_ACTIVATION_CHAIN_ID}`,
    );
  }
  const assetInput = object(core.asset, "core manifest asset");
  const rolesInput = object(core.roles, "core manifest roles");
  const contractsInput = object(core.contracts, "core manifest contracts");
  const hashesInput = object(
    core.runtimeCodeHashes,
    "core manifest runtimeCodeHashes",
  );
  const boundsInput = object(core.pilotBounds, "core manifest pilotBounds");
  return {
    generation: core.generation,
    chainId: core.chainId,
    verifier: address(core.verifier, "core manifest verifier"),
    asset: {
      address: address(assetInput.address, "core manifest asset.address"),
      decimals: integer(
        assetInput.decimals,
        "core manifest asset.decimals",
        255,
      ),
    },
    roles: Object.fromEntries(
      CORE_ROLES.map((role) => [
        role,
        address(rolesInput[role], `core manifest roles.${role}`),
      ]),
    ),
    contracts: Object.fromEntries(
      CORE_CONTRACTS.map((name) => [
        name,
        address(contractsInput[name], `core manifest contracts.${name}`),
      ]),
    ),
    runtimeCodeHashes: Object.fromEntries(
      CORE_CONTRACTS.map((name) => [
        name,
        bytes32(
          hashesInput[CORE_RUNTIME_ARTIFACTS[name]],
          `core manifest runtimeCodeHashes.${CORE_RUNTIME_ARTIFACTS[name]}`,
        ),
      ]),
    ),
    pilotBounds: {
      maximumFacilityLimit: decimal(
        boundsInput.maximumFacilityLimit,
        "core manifest maximumFacilityLimit",
      ),
      maximumTotalLimit: decimal(
        boundsInput.maximumTotalLimit,
        "core manifest maximumTotalLimit",
      ),
      minimumBondBps: integer(
        boundsInput.minimumBondBps,
        "core manifest minimumBondBps",
        10_000,
        { positive: true },
      ),
      maximumDrawFeeBps: integer(
        boundsInput.maximumDrawFeeBps,
        "core manifest maximumDrawFeeBps",
        10_000,
      ),
      maximumMaturityBlocks: integer(
        boundsInput.maximumMaturityBlocks,
        "core manifest maximumMaturityBlocks",
        Number.MAX_SAFE_INTEGER,
        { positive: true },
      ),
      maximumDrawDelayBlocks: integer(
        boundsInput.maximumDrawDelayBlocks,
        "core manifest maximumDrawDelayBlocks",
        0xffffffff,
      ),
      maximumFacilityCount: integer(
        boundsInput.maximumFacilityCount,
        "core manifest maximumFacilityCount",
        0xffff,
        {
          positive: true,
        },
      ),
    },
  };
}

export function parseV3ActivationArguments(args) {
  const parsed = {
    help: false,
    broadcast: false,
    liveCheck: false,
    configPath: "config/v3-pilot-cc3.json",
    coreManifestPath: "deployments-v3.json",
    activationManifestPath: "activation-v3.json",
    writePlanPath: undefined,
    approvedPlanPath: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      continue;
    }
    if (argument === "--broadcast") {
      parsed.broadcast = true;
      continue;
    }
    if (argument === "--live-check") {
      parsed.liveCheck = true;
      continue;
    }
    const keys = {
      "--config": "configPath",
      "--core-manifest": "coreManifestPath",
      "--manifest": "activationManifestPath",
      "--write-plan": "writePlanPath",
      "--approved-plan": "approvedPlanPath",
    };
    const key = keys[argument];
    if (!key) throw new Error(`Unknown argument: ${argument}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`${argument} requires a path`);
    parsed[key] = value;
    index += 1;
  }
  if (parsed.help) return parsed;
  if (parsed.broadcast && (!parsed.liveCheck || !parsed.approvedPlanPath)) {
    throw new Error("--broadcast requires --live-check and --approved-plan");
  }
  if (parsed.broadcast && parsed.writePlanPath) {
    throw new Error("--write-plan cannot be combined with --broadcast");
  }
  if (!parsed.liveCheck && parsed.writePlanPath) {
    throw new Error("--write-plan requires --live-check");
  }
  return parsed;
}

export function validateV3ActivationConfig(input, coreInput) {
  const config = object(input, "config");
  const core = normalizeCoreManifest(coreInput);
  if (config.generation !== "v3-pilot-activation")
    throw new Error("generation must be v3-pilot-activation");
  if (config.chainId !== EXPECTED_V3_ACTIVATION_CHAIN_ID) {
    throw new Error(`chainId must be ${EXPECTED_V3_ACTIVATION_CHAIN_ID}`);
  }
  const assetSymbol = string(config.assetSymbol, "assetSymbol", 32);

  const coreManifestInput = object(config.coreManifest, "coreManifest");
  const coreManifest = {
    path: string(coreManifestInput.path, "coreManifest.path", 260),
    sha256: sha256Digest(coreManifestInput.sha256, "coreManifest.sha256"),
  };
  const rolesInput = object(config.roles, "roles");
  const roles = Object.fromEntries(
    [...CORE_ROLES, "hunter"].map((role) => [
      role,
      address(rolesInput[role], `roles.${role}`),
    ]),
  );
  for (const role of CORE_ROLES)
    sameAddress(roles[role], core.roles[role], `roles.${role}`);
  if (new Set([roles.deployer, roles.lender, roles.borrower]).size !== 3) {
    throw new Error("deployer, lender, and borrower roles must be distinct");
  }
  if ([roles.deployer, roles.lender, roles.borrower].includes(roles.hunter)) {
    throw new Error(
      "hunter must be distinct from deployer, lender, and borrower",
    );
  }

  const artifactsInput = object(config.artifacts, "artifacts");
  const artifacts = Object.fromEntries(
    REQUIRED_ARTIFACTS.map((name) => {
      const item = object(artifactsInput[name], `artifacts.${name}`);
      return [
        name,
        {
          path: string(item.path, `artifacts.${name}.path`, 260),
          keccak256: bytes32(item.keccak256, `artifacts.${name}.keccak256`),
        },
      ];
    }),
  );

  const facilityInput = object(config.facility, "facility");
  const facility = {
    facilityLimit: decimal(
      facilityInput.facilityLimit,
      "facility.facilityLimit",
    ),
    bondRequired: decimal(facilityInput.bondRequired, "facility.bondRequired"),
    drawFeeBps: integer(
      facilityInput.drawFeeBps,
      "facility.drawFeeBps",
      10_000,
    ),
    maturityBlock: integer(
      facilityInput.maturityBlock,
      "facility.maturityBlock",
      Number.MAX_SAFE_INTEGER,
      {
        positive: true,
      },
    ),
    drawDelayBlocks: integer(
      facilityInput.drawDelayBlocks,
      "facility.drawDelayBlocks",
      0xffffffff,
    ),
  };
  if (facility.facilityLimit > core.pilotBounds.maximumFacilityLimit) {
    throw new Error("facilityLimit exceeds the core pilot bound");
  }
  const minimumBond =
    (facility.facilityLimit * BigInt(core.pilotBounds.minimumBondBps) +
      9_999n) /
    10_000n;
  if (facility.bondRequired < minimumBond) {
    throw new Error(
      `bondRequired must be at least ${core.pilotBounds.minimumBondBps / 100}% of facilityLimit`,
    );
  }
  if (facility.drawFeeBps > core.pilotBounds.maximumDrawFeeBps) {
    throw new Error("drawFeeBps exceeds the core pilot bound");
  }
  if (facility.drawDelayBlocks > core.pilotBounds.maximumDrawDelayBlocks) {
    throw new Error("drawDelayBlocks exceeds the core pilot bound");
  }

  const policyInput = object(config.policy, "policy");
  const configurationInput = object(
    policyInput.configuration,
    "policy.configuration",
  );
  const configuration = {
    subject: address(
      configurationInput.subject,
      "policy.configuration.subject",
    ),
    freshnessPeriod: integer(
      configurationInput.freshnessPeriod,
      "policy.configuration.freshnessPeriod",
      Number.MAX_SAFE_INTEGER,
      { positive: true },
    ),
    watchThreshold: integer(
      configurationInput.watchThreshold,
      "policy.configuration.watchThreshold",
      0xffffffff,
      {
        positive: true,
      },
    ),
    restrictedThreshold: integer(
      configurationInput.restrictedThreshold,
      "policy.configuration.restrictedThreshold",
      0xffffffff,
      { positive: true },
    ),
    marginThreshold: integer(
      configurationInput.marginThreshold,
      "policy.configuration.marginThreshold",
      0xffffffff,
      {
        positive: true,
      },
    ),
    breachThreshold: integer(
      configurationInput.breachThreshold,
      "policy.configuration.breachThreshold",
      0xffffffff,
      {
        positive: true,
      },
    ),
    watchEffect: normalizeEffect(
      configurationInput.watchEffect,
      "policy.configuration.watchEffect",
      1,
    ),
    restrictedEffect: normalizeEffect(
      configurationInput.restrictedEffect,
      "policy.configuration.restrictedEffect",
      2,
    ),
    marginEffect: normalizeEffect(
      configurationInput.marginEffect,
      "policy.configuration.marginEffect",
      3,
    ),
    breachEffect: normalizeEffect(
      configurationInput.breachEffect,
      "policy.configuration.breachEffect",
      4,
    ),
    rules: array(configurationInput.rules, "policy.configuration.rules").map(
      normalizeRule,
    ),
  };
  if (configuration.subject !== roles.borrower)
    throw new Error("policy subject must equal borrower");
  if (
    configuration.rules.length === 0 ||
    configuration.rules.length > MAXIMUM_POLICY_RULES
  ) {
    throw new Error(
      `policy must define between 1 and ${MAXIMUM_POLICY_RULES} immutable rules`,
    );
  }
  if (
    !(
      configuration.watchThreshold < configuration.restrictedThreshold &&
      configuration.restrictedThreshold < configuration.marginThreshold &&
      configuration.marginThreshold < configuration.breachThreshold
    )
  ) {
    throw new Error("policy thresholds must be strictly increasing");
  }
  for (let index = 0; index < configuration.rules.length; index += 1) {
    const rule = configuration.rules[index];
    if (rule.riskWeight < configuration.watchThreshold) {
      throw new Error(
        `policy rule ${index} riskWeight must reach the watch threshold`,
      );
    }
    for (let prior = 0; prior < index; prior += 1) {
      if (predicatesOverlap(configuration.rules[prior], rule)) {
        throw new Error(`policy rules ${prior} and ${index} overlap`);
      }
    }
  }
  const effects = [
    configuration.watchEffect,
    configuration.restrictedEffect,
    configuration.marginEffect,
    configuration.breachEffect,
  ];
  for (let index = 1; index < effects.length; index += 1) {
    const previous = effects[index - 1];
    const current = effects[index];
    if (
      current.creditLimitBps > previous.creditLimitBps ||
      current.futureDrawFeeBps < previous.futureDrawFeeBps ||
      (previous.freezePendingDraw && !current.freezePendingDraw) ||
      (previous.requireFreshEvidence && !current.requireFreshEvidence)
    ) {
      throw new Error("policy effects must become monotonically stricter");
    }
  }
  if (
    configuration.watchEffect.terminate ||
    configuration.restrictedEffect.terminate
  ) {
    throw new Error(
      "watch and restricted policy effects must not terminate the facility",
    );
  }
  if (
    configuration.marginEffect.terminate &&
    !configuration.breachEffect.terminate
  ) {
    throw new Error("breach termination must include margin termination");
  }
  const policy = {
    policyId: decimal(policyInput.policyId, "policy.policyId", {
      positive: false,
    }),
    configuration,
  };

  const registryInput = object(config.registry, "registry");
  const registry = {
    packageName: string(registryInput.packageName, "registry.packageName", 64),
    version: string(registryInput.version, "registry.version", 32),
    metadata: string(registryInput.metadata, "registry.metadata", 512),
    metadataHash: bytes32(registryInput.metadataHash, "registry.metadataHash"),
    evidenceKinds: array(
      registryInput.evidenceKinds,
      "registry.evidenceKinds",
    ).map((value, index) =>
      integer(value, `registry.evidenceKinds[${index}]`, 2),
    ),
    actionAdapters: array(
      registryInput.actionAdapters,
      "registry.actionAdapters",
    ).map((value, index) => {
      const adapter = object(value, `registry.actionAdapters[${index}]`);
      return {
        adapterKind: bytes32(
          adapter.adapterKind,
          `registry.actionAdapters[${index}].adapterKind`,
        ),
        specificationHash: bytes32(
          adapter.specificationHash,
          `registry.actionAdapters[${index}].specificationHash`,
        ),
        metadataURI: string(
          adapter.metadataURI,
          `registry.actionAdapters[${index}].metadataURI`,
          256,
        ),
      };
    }),
  };
  if (registry.metadataHash !== keccak256(toUtf8Bytes(registry.metadata))) {
    throw new Error("registry.metadataHash does not match registry.metadata");
  }
  if (
    registry.evidenceKinds.length === 0 ||
    new Set(registry.evidenceKinds).size !== registry.evidenceKinds.length
  ) {
    throw new Error("registry.evidenceKinds must be nonempty and unique");
  }
  if (!registry.evidenceKinds.includes(1))
    throw new Error("registry must declare EventDelta evidence");

  const jobInput = object(config.proofJob, "proofJob");
  const proofJob = {
    expiry: integer(
      jobInput.expiry,
      "proofJob.expiry",
      Number.MAX_SAFE_INTEGER,
      { positive: true },
    ),
    revealWindowBlocks: integer(
      jobInput.revealWindowBlocks,
      "proofJob.revealWindowBlocks",
      Number.MAX_SAFE_INTEGER,
      {
        positive: true,
      },
    ),
    maxSuccessfulProofs: integer(
      jobInput.maxSuccessfulProofs,
      "proofJob.maxSuccessfulProofs",
      0xffffffff,
      {
        positive: true,
      },
    ),
    proofReimbursement: decimal(
      jobInput.proofReimbursement,
      "proofJob.proofReimbursement",
    ),
    outcomeReward: decimal(jobInput.outcomeReward, "proofJob.outcomeReward"),
    commitBond: decimal(jobInput.commitBond, "proofJob.commitBond"),
    rewardOutcomeThreshold: integer(
      jobInput.rewardOutcomeThreshold,
      "proofJob.rewardOutcomeThreshold",
      4,
    ),
  };
  proofJob.escrow =
    proofJob.proofReimbursement * BigInt(proofJob.maxSuccessfulProofs) +
    proofJob.outcomeReward;

  const sourceNetworks = normalizeSourceNetworks(
    config.sourceNetworks,
    configuration.rules,
  );
  const transactionPolicyInput = object(
    config.transactionPolicy,
    "transactionPolicy",
  );
  const transactionPolicy = {
    targetConfirmations: integer(
      transactionPolicyInput.targetConfirmations,
      "transactionPolicy.targetConfirmations",
      256,
      { positive: true },
    ),
    maximumReceiptPolls: integer(
      transactionPolicyInput.maximumReceiptPolls,
      "transactionPolicy.maximumReceiptPolls",
      10_000,
      { positive: true },
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
    throw new Error(
      "transactionPolicy.maximumReceiptPolls must cover targetConfirmations",
    );
  }

  const requirementsInput = object(config.requirements, "requirements");
  const nativeInput = object(
    requirementsInput.minimumNativeWei,
    "requirements.minimumNativeWei",
  );
  const requirements = {
    minimumNativeWei: Object.fromEntries(
      SIGNER_ROLES.map((role) => [
        role,
        decimal(nativeInput[role], `requirements.minimumNativeWei.${role}`),
      ]),
    ),
  };
  const totals = {
    assetTransferred:
      facility.facilityLimit + facility.bondRequired + proofJob.escrow,
    assetApproved:
      facility.facilityLimit +
      facility.bondRequired +
      proofJob.escrow +
      proofJob.commitBond,
  };
  return {
    generation: config.generation,
    chainId: config.chainId,
    assetSymbol,
    coreManifest,
    core,
    roles,
    artifacts,
    facility,
    policy,
    registry,
    proofJob,
    sourceNetworks,
    transactionPolicy,
    requirements,
    totals,
  };
}

export function readV3ActivationInputs(
  configPath,
  coreManifestPath,
  rootDirectory = process.cwd(),
) {
  const resolvedConfig = resolve(rootDirectory, configPath);
  const resolvedCore = resolve(rootDirectory, coreManifestPath);
  const configInput = JSON.parse(readFileSync(resolvedConfig, "utf8"));
  const coreBytes = readFileSync(resolvedCore);
  const digest = createHash("sha256").update(coreBytes).digest("hex");
  if (digest !== configInput.coreManifest?.sha256)
    throw new Error("core manifest SHA-256 mismatch");
  if (
    resolve(rootDirectory, configInput.coreManifest?.path ?? "") !==
    resolvedCore
  ) {
    throw new Error("core manifest path does not match --core-manifest");
  }
  return {
    config: validateV3ActivationConfig(
      configInput,
      JSON.parse(coreBytes.toString("utf8")),
    ),
    coreManifestBytes: coreBytes,
  };
}

export function readV3ActivationArtifacts(
  config,
  rootDirectory = process.cwd(),
) {
  return Object.fromEntries(
    REQUIRED_ARTIFACTS.map((name) => {
      const path = resolve(rootDirectory, config.artifacts[name].path);
      if (!existsSync(path))
        throw new Error(`Missing activation artifact: ${path}`);
      const raw = readFileSync(path);
      const hash = keccak256(raw);
      if (hash !== config.artifacts[name].keccak256)
        throw new Error(`${name} artifact hash mismatch`);
      const artifact = JSON.parse(raw.toString("utf8"));
      if (!Array.isArray(artifact.abi))
        throw new Error(`${name} artifact ABI is missing`);
      if (
        !/^0x[0-9a-fA-F]+$/.test(artifact.bytecode?.object ?? "") ||
        artifact.bytecode.object === "0x"
      ) {
        throw new Error(`${name} artifact bytecode is missing`);
      }
      if (
        !/^0x[0-9a-fA-F]+$/.test(artifact.deployedBytecode?.object ?? "") ||
        artifact.deployedBytecode.object === "0x"
      ) {
        throw new Error(`${name} artifact deployed bytecode is missing`);
      }
      return [name, { artifact, hash, path }];
    }),
  );
}

export function applyArtifactImmutables(artifact, immutableValues) {
  const deployed = object(
    artifact?.deployedBytecode,
    "artifact deployedBytecode",
  );
  if (!isHexString(deployed.object) || deployed.object === "0x") {
    throw new Error("Artifact deployed bytecode is invalid");
  }
  const linkReferences = object(
    deployed.linkReferences ?? {},
    "artifact linkReferences",
  );
  if (
    Object.values(linkReferences).some((file) => Object.keys(file).length > 0)
  ) {
    throw new Error(
      "Artifact deployed bytecode contains unresolved library links",
    );
  }
  const references = object(
    deployed.immutableReferences ?? {},
    "artifact immutableReferences",
  );
  const bytes = deployed.object.slice(2).split("");
  for (const [referenceId, slots] of Object.entries(references)) {
    const value = immutableValues[referenceId];
    if (value === undefined)
      throw new Error(`Missing immutable value for reference ${referenceId}`);
    for (const [index, slot] of array(
      slots,
      `immutable reference ${referenceId}`,
    ).entries()) {
      const start = integer(
        slot.start,
        `immutable reference ${referenceId}[${index}].start`,
        Number.MAX_SAFE_INTEGER,
      );
      const length = integer(
        slot.length,
        `immutable reference ${referenceId}[${index}].length`,
        Number.MAX_SAFE_INTEGER,
        {
          positive: true,
        },
      );
      const replacement = zeroPadValue(value, length).slice(2);
      if (start * 2 + length * 2 > bytes.length)
        throw new Error(`Immutable reference ${referenceId} is out of bounds`);
      bytes.splice(start * 2, length * 2, ...replacement);
    }
  }
  return `0x${bytes.join("")}`;
}

export function verifyPinnedPolicyRuntime({ artifact, kernel, liveCode }) {
  if (!isHexString(liveCode) || liveCode === "0x")
    throw new Error("Live policy runtime bytecode is missing");
  const referenceIds = Object.keys(
    artifact?.deployedBytecode?.immutableReferences ?? {},
  );
  if (referenceIds.length !== 1)
    throw new Error(
      "MultiChain policy artifact must contain exactly one immutable",
    );
  const expectedRuntimeCode = applyArtifactImmutables(artifact, {
    [referenceIds[0]]: getAddress(kernel),
  });
  if (expectedRuntimeCode.toLowerCase() !== liveCode.toLowerCase()) {
    throw new Error(
      "Live MultiChain policy runtime bytecode does not match the pinned artifact",
    );
  }
  return {
    expectedRuntimeCode,
    runtimeCodeHash: keccak256(expectedRuntimeCode),
  };
}

export function verifyPinnedArtifactRuntime({
  artifact,
  liveCode,
  label,
  immutableCount,
}) {
  if (!isHexString(liveCode) || liveCode === "0x") {
    throw new Error(`Live ${label} runtime bytecode is missing`);
  }
  const deployed = object(
    artifact?.deployedBytecode,
    `${label} artifact deployedBytecode`,
  );
  if (!isHexString(deployed.object) || deployed.object === "0x") {
    throw new Error(`${label} artifact deployed bytecode is invalid`);
  }
  const referenceEntries = Object.entries(
    object(
      deployed.immutableReferences ?? {},
      `${label} artifact immutableReferences`,
    ),
  );
  if (referenceEntries.length !== immutableCount) {
    throw new Error(
      `${label} artifact must contain exactly ${immutableCount} immutables`,
    );
  }
  if (liveCode.length !== deployed.object.length) {
    throw new Error(
      `${label} runtime bytecode does not match the pinned artifact`,
    );
  }
  const immutableValues = Object.fromEntries(
    referenceEntries.map(([referenceId, rawSlots]) => {
      const slots = array(
        rawSlots,
        `${label} immutable reference ${referenceId}`,
      );
      if (slots.length === 0) {
        throw new Error(`${label} immutable reference ${referenceId} is empty`);
      }
      const first = object(
        slots[0],
        `${label} immutable reference ${referenceId}[0]`,
      );
      const start = integer(
        first.start,
        `${label} immutable reference ${referenceId}[0].start`,
        Number.MAX_SAFE_INTEGER,
      );
      const length = integer(
        first.length,
        `${label} immutable reference ${referenceId}[0].length`,
        Number.MAX_SAFE_INTEGER,
        { positive: true },
      );
      if (start * 2 + length * 2 > liveCode.length - 2) {
        throw new Error(
          `${label} immutable reference ${referenceId} is out of bounds`,
        );
      }
      return [
        referenceId,
        `0x${liveCode.slice(2 + start * 2, 2 + start * 2 + length * 2)}`,
      ];
    }),
  );
  const expectedRuntimeCode = applyArtifactImmutables(
    artifact,
    immutableValues,
  );
  if (expectedRuntimeCode.toLowerCase() !== liveCode.toLowerCase()) {
    throw new Error(
      `${label} runtime bytecode does not match the pinned artifact`,
    );
  }
  return {
    expectedRuntimeCode,
    runtimeCodeHash: keccak256(expectedRuntimeCode),
  };
}

export function verifyPinnedFactoryRuntime({ artifact, liveCode }) {
  return verifyPinnedArtifactRuntime({
    artifact,
    liveCode,
    label: "CappedPilotFactoryV1",
    immutableCount: 12,
  });
}

export function verifyPinnedFacilityRuntime({ artifact, liveCode }) {
  return verifyPinnedArtifactRuntime({
    artifact,
    liveCode,
    label: "RecourseFacilityV3",
    immutableCount: 9,
  });
}

export function deriveFirstPilotFacilityAddress(factory) {
  return getCreateAddress({
    from: address(factory, "pilot factory"),
    nonce: 1,
  });
}

function expectedPinnedPolicyRuntime(artifact, kernel) {
  const referenceIds = Object.keys(
    artifact?.deployedBytecode?.immutableReferences ?? {},
  );
  if (referenceIds.length !== 1) {
    throw new Error(
      "MultiChain policy artifact must contain exactly one immutable",
    );
  }
  return applyArtifactImmutables(artifact, {
    [referenceIds[0]]: getAddress(kernel),
  });
}

function stateInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`${label} must be a nonnegative safe integer`);
  }
  return normalized;
}

export function assessV3ActivationFreshness({
  config,
  targetState,
  sourceStates,
}) {
  const target = targetState
    ? {
        blockNumber: stateInteger(
          targetState.blockNumber,
          "targetState.blockNumber",
        ),
        timestamp: stateInteger(targetState.timestamp, "targetState.timestamp"),
      }
    : undefined;
  const targetChecks = target
    ? {
        activationBlocksRemaining:
          config.facility.maturityBlock -
          target.blockNumber -
          ACTIVATION_TRANSACTION_COUNT,
        maturityWithinFactoryWindow:
          config.facility.maturityBlock <=
          target.blockNumber + config.core.pilotBounds.maximumMaturityBlocks,
        proofJobSecondsRemaining: config.proofJob.expiry - target.timestamp,
      }
    : undefined;
  const targetReady = Boolean(
    targetChecks &&
    targetChecks.activationBlocksRemaining > 0 &&
    targetChecks.maturityWithinFactoryWindow &&
    targetChecks.proofJobSecondsRemaining > 3_600,
  );
  const sources = config.policy.configuration.rules.map((rule, ruleIndex) => {
    const chainKey = rule.sourceChain.toString();
    const raw = sourceStates?.[chainKey];
    if (!raw) {
      return {
        ruleIndex,
        chainKey,
        status: "unchecked",
        reason: "source state was not supplied",
      };
    }
    const state = {
      evmChainId: stateInteger(raw.evmChainId, `${chainKey}.evmChainId`),
      head: stateInteger(raw.head, `${chainKey}.head`),
      attestedHeight: stateInteger(
        raw.attestedHeight,
        `${chainKey}.attestedHeight`,
      ),
    };
    let reason;
    if (state.evmChainId !== config.sourceNetworks[chainKey].evmChainId) {
      reason = `source EVM chain mismatch: expected ${config.sourceNetworks[chainKey].evmChainId}, got ${state.evmChainId}`;
    } else if (state.attestedHeight > state.head) {
      reason = "attested source height exceeds the live source head";
    } else if (
      rule.startSourceBlock - state.head <
      MINIMUM_SOURCE_WINDOW_BUFFER_BLOCKS
    ) {
      reason = `policy source window lacks the ${MINIMUM_SOURCE_WINDOW_BUFFER_BLOCKS}-block live buffer`;
    } else if (
      rule.startSourceBlock - state.attestedHeight <
      MINIMUM_SOURCE_WINDOW_BUFFER_BLOCKS
    ) {
      reason = `policy source window lacks the ${MINIMUM_SOURCE_WINDOW_BUFFER_BLOCKS}-block attested buffer`;
    } else if (
      rule.endSourceBlock <= state.head ||
      rule.endSourceBlock <= state.attestedHeight
    ) {
      reason = "policy source window has expired";
    }
    return {
      ruleIndex,
      chainKey,
      ...state,
      liveStartBuffer: rule.startSourceBlock - state.head,
      attestedStartBuffer: rule.startSourceBlock - state.attestedHeight,
      liveEndRemaining: rule.endSourceBlock - state.head,
      attestedEndRemaining: rule.endSourceBlock - state.attestedHeight,
      status: reason ? "stale" : "ready",
      reason: reason ?? null,
    };
  });
  const allSourcesChecked = sources.every(
    ({ status }) => status !== "unchecked",
  );
  const sourcesReady = sources.every(({ status }) => status === "ready");
  const allChecked = Boolean(target && allSourcesChecked);
  const readyForBroadcast = Boolean(allChecked && targetReady && sourcesReady);
  return {
    status: !allChecked ? "unchecked" : readyForBroadcast ? "ready" : "stale",
    readyForBroadcast,
    target: target
      ? { ...target, ...targetChecks, status: targetReady ? "ready" : "stale" }
      : { status: "unchecked", reason: "target state was not supplied" },
    sources,
  };
}

export function v3ActivationPlanCommitment({
  configCommitment,
  predictedFacility,
  transactionPlan,
}) {
  return keccak256(
    toUtf8Bytes(
      canonicalText({
        configCommitment,
        predictedFacility: getAddress(predictedFacility),
        transactionPlan,
      }),
    ),
  );
}

export function buildV3OfflineActivationPlan({ config, activationArtifacts }) {
  for (const name of REQUIRED_ARTIFACTS) {
    if (activationArtifacts[name]?.hash !== config.artifacts[name].keccak256) {
      throw new Error(`${name} artifact hash mismatch`);
    }
  }
  const predictedFacility = deriveFirstPilotFacilityAddress(
    config.core.contracts.cappedPilotFactory,
  );
  const policyRuntimeCode = expectedPinnedPolicyRuntime(
    activationArtifacts.MultiChainEventPolicyV1.artifact,
    config.core.contracts.policyKernel,
  );
  const commitments = deriveV3ActivationCommitments({
    config,
    coreManifest: config.core,
    predictedFacility,
    policyRuntimeCode,
  });
  const transactionPlan = buildV3ActivationPlan({
    config,
    coreManifest: config.core,
    predictedFacility,
    policyConfigHash: commitments.policyConfigHash,
    releaseId: commitments.releaseId,
    runtimeVariantId: commitments.runtimeVariantId,
    deploymentId: commitments.deploymentId,
    assetSymbol: config.assetSymbol,
  });
  return {
    mode: "offline-plan",
    chainId: config.chainId,
    predictedFacility,
    commitments,
    planCommitment: v3ActivationPlanCommitment({
      configCommitment: commitments.configCommitment,
      predictedFacility,
      transactionPlan,
    }),
    transactionPlan,
    freshness: assessV3ActivationFreshness({ config }),
    transactionsBroadcast: 0,
    filesWritten: 0,
  };
}

export async function buildV3LiveExecutionPlan({
  transactionPlan,
  requests,
  signers,
  roles,
  chainId,
  startingNonces,
  feePolicy,
}) {
  if (
    !Array.isArray(transactionPlan) ||
    !Array.isArray(requests) ||
    transactionPlan.length !== requests.length
  ) {
    throw new Error("V3 execution requests must match the transaction plan");
  }
  const nonceOffsets = {};
  const steps = [];
  for (let index = 0; index < transactionPlan.length; index += 1) {
    const planned = transactionPlan[index];
    const signer = signers[planned.signer];
    if (!signer) throw new Error(`${planned.name} signer is unavailable`);
    const expectedFrom = address(roles[planned.signer], `${planned.name} role`);
    sameAddress(
      await signer.getAddress(),
      expectedFrom,
      `${planned.name} signer`,
    );
    const startingNonce = integer(
      startingNonces[planned.signer],
      `${planned.signer} starting nonce`,
      Number.MAX_SAFE_INTEGER,
    );
    const nonce = startingNonce + (nonceOffsets[planned.signer] ?? 0);
    nonceOffsets[planned.signer] = (nonceOffsets[planned.signer] ?? 0) + 1;
    const request = object(requests[index], `${planned.name} request`);
    sameAddress(request.to, planned.to, `${planned.name} request target`);
    if (!isHexString(request.data ?? "")) {
      throw new Error(`${planned.name} request data is invalid`);
    }
    const value = BigInt(request.value ?? 0);
    const populated = await signer.populateTransaction({
      ...request,
      chainId,
      nonce,
      gasLimit: feePolicy.maximumGasLimit,
    });
    sameAddress(populated.to, planned.to, `${planned.name} populated target`);
    if (
      BigInt(populated.chainId) !== BigInt(chainId) ||
      populated.nonce !== nonce ||
      keccak256(populated.data) !== keccak256(request.data) ||
      BigInt(populated.value ?? 0) !== value
    ) {
      throw new Error(`${planned.name} populated transaction changed its plan`);
    }
    steps.push({
      name: planned.name,
      signer: planned.signer,
      chainId,
      nonce,
      from: expectedFrom,
      to: address(populated.to, `${planned.name} populated target`),
      data: populated.data,
      dataHash: keccak256(populated.data),
      value: BigInt(populated.value ?? 0).toString(),
      ...transactionFeeFields(populated, feePolicy, planned.name),
    });
  }
  const executionPlan = {
    schemaVersion: 1,
    chainId,
    feePolicy: transactionFeePolicyRecord(feePolicy),
    startingNonces: Object.fromEntries(
      Object.keys(nonceOffsets)
        .sort()
        .map((role) => [role, startingNonces[role]]),
    ),
    steps,
  };
  executionPlan.commitment = keccak256(
    toUtf8Bytes(canonicalText(executionPlan)),
  );
  return executionPlan;
}

export function validateV3LiveExecutionPlan({
  executionPlan,
  transactionPlan,
  requests,
  roles,
  chainId,
  feePolicy,
}) {
  if (
    executionPlan?.schemaVersion !== 1 ||
    executionPlan.chainId !== chainId ||
    !Array.isArray(executionPlan.steps) ||
    executionPlan.steps.length !== transactionPlan.length ||
    !Array.isArray(requests) ||
    requests.length !== transactionPlan.length
  ) {
    throw new Error("Invalid V3 live execution plan");
  }
  if (
    canonicalText(executionPlan.feePolicy) !==
    canonicalText(transactionFeePolicyRecord(feePolicy))
  ) {
    throw new Error("V3 live execution fee policy mismatch");
  }
  const expectedCommitment = keccak256(
    toUtf8Bytes(
      canonicalText(
        Object.fromEntries(
          Object.entries(executionPlan).filter(([key]) => key !== "commitment"),
        ),
      ),
    ),
  );
  if (executionPlan.commitment !== expectedCommitment) {
    throw new Error("V3 live execution plan commitment mismatch");
  }
  const nonceOffsets = {};
  for (let index = 0; index < transactionPlan.length; index += 1) {
    const planned = transactionPlan[index];
    const approved = executionPlan.steps[index];
    const request = object(requests[index], `${planned.name} request`);
    const startingNonce = integer(
      executionPlan.startingNonces?.[planned.signer],
      `${planned.signer} approved starting nonce`,
      Number.MAX_SAFE_INTEGER,
    );
    const expectedNonce = startingNonce + (nonceOffsets[planned.signer] ?? 0);
    nonceOffsets[planned.signer] = (nonceOffsets[planned.signer] ?? 0) + 1;
    if (
      approved?.name !== planned.name ||
      approved.signer !== planned.signer ||
      approved.chainId !== chainId ||
      approved.nonce !== expectedNonce ||
      approved.from !==
        address(roles[planned.signer], `${planned.name} role`) ||
      approved.to !== address(planned.to, `${planned.name} target`) ||
      !isHexString(approved.data) ||
      approved.dataHash !== keccak256(approved.data) ||
      approved.dataHash !== keccak256(request.data) ||
      BigInt(approved.value) !== BigInt(request.value ?? 0)
    ) {
      throw new Error(`${planned.name} approved transaction changed its plan`);
    }
    const normalizedFees = transactionFeeFields(
      approved,
      feePolicy,
      planned.name,
    );
    for (const field of [
      "type",
      "gasLimit",
      "gasPrice",
      "maxFeePerGas",
      "maxPriorityFeePerGas",
    ]) {
      if (approved[field] !== normalizedFees[field]) {
        throw new Error(`${planned.name} approved ${field} is not canonical`);
      }
    }
  }
  return executionPlan;
}

export function createV3LivePlanReceipt({
  configCommitment,
  planCommitment,
  predictedFacility,
  targetBlock,
  sourceStates,
  validUntil,
  executionPlan,
  renewal,
}) {
  const target = object(targetBlock, "targetBlock");
  const receipt = {
    schemaVersion: 2,
    kind: "recourse-v3-live-activation-plan",
    configCommitment: bytes32(configCommitment, "configCommitment"),
    planCommitment: bytes32(planCommitment, "planCommitment"),
    predictedFacility: address(predictedFacility, "predictedFacility"),
    targetBlock: {
      number: stateInteger(target.number, "targetBlock.number"),
      hash: bytes32(target.hash, "targetBlock.hash"),
      timestamp: stateInteger(target.timestamp, "targetBlock.timestamp"),
    },
    sourceStates: canonicalJson(object(sourceStates, "sourceStates")),
    validUntil: stateInteger(validUntil, "validUntil"),
    executionPlan: canonicalJson(object(executionPlan, "executionPlan")),
    ...(renewal === undefined
      ? {}
      : { renewal: canonicalJson(object(renewal, "renewal")) }),
  };
  if (receipt.validUntil <= receipt.targetBlock.timestamp) {
    throw new Error(
      "Live activation plan validity must extend past its target block",
    );
  }
  return receipt;
}

export function validateApprovedV3ActivationPlan(
  receipt,
  {
    configCommitment,
    planCommitment,
    predictedFacility,
    transactionPlan,
    requests,
    roles,
    chainId,
    feePolicy,
    journal,
    now = Math.floor(Date.now() / 1_000),
  },
) {
  if (
    receipt?.schemaVersion !== 2 ||
    receipt.kind !== "recourse-v3-live-activation-plan"
  ) {
    throw new Error("Invalid approved V3 activation plan");
  }
  if (receipt.configCommitment !== configCommitment) {
    throw new Error("Approved activation config commitment mismatch");
  }
  if (receipt.planCommitment !== planCommitment) {
    throw new Error("Approved activation plan commitment mismatch");
  }
  sameAddress(
    receipt.predictedFacility,
    predictedFacility,
    "Approved activation facility",
  );
  const validUntil = stateInteger(receipt.validUntil, "approved validUntil");
  if (stateInteger(now, "approval time") >= validUntil) {
    throw new Error("Approved V3 activation plan has expired");
  }
  validateV3LiveExecutionPlan({
    executionPlan: receipt.executionPlan,
    transactionPlan,
    requests,
    roles,
    chainId,
    feePolicy,
  });
  if (receipt.renewal !== undefined) {
    if (!journal) {
      throw new Error("Renewed V3 activation approval requires its journal");
    }
    validateV3ActivationRenewalBinding(receipt.renewal, journal);
  }
  return true;
}

export async function assertFutureSourceWindow(sourceProvider, rule, label) {
  const sourceHead = await sourceProvider.getBlockNumber();
  if (
    rule.startSourceBlock - sourceHead <
    MINIMUM_SOURCE_WINDOW_BUFFER_BLOCKS
  ) {
    throw new Error(
      `${label}: policy source window requires a minimum ${MINIMUM_SOURCE_WINDOW_BUFFER_BLOCKS}-block buffer`,
    );
  }
  if (rule.endSourceBlock <= rule.startSourceBlock)
    throw new Error(`${label}: policy source window is invalid`);
  return sourceHead;
}

export function policyConfigurationHash(configuration) {
  return keccak256(ABI.encode([POLICY_CONFIGURATION_TUPLE], [configuration]));
}

function canonicalJson(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

export function deriveV3ActivationCommitments({
  config,
  coreManifest,
  predictedFacility,
  policyRuntimeCode,
}) {
  const policyConfigHash = policyConfigurationHash(config.policy.configuration);
  const constructorArgumentsHash = keccak256(
    ABI.encode(["address"], [coreManifest.contracts.policyKernel]),
  );
  const policyRuntimeCodeHash = keccak256(policyRuntimeCode);
  const releaseId = keccak256(
    ABI.encode(
      ["address", "string", "string"],
      [
        config.roles.deployer,
        config.registry.packageName,
        config.registry.version,
      ],
    ),
  );
  const runtimeVariantId = keccak256(
    ABI.encode(
      ["bytes32", "bytes32", "bytes32"],
      [releaseId, policyRuntimeCodeHash, constructorArgumentsHash],
    ),
  );
  const declarationsHash = keccak256(
    ABI.encode(
      ["uint8[]", `${ACTION_ADAPTER_TUPLE}[]`],
      [config.registry.evidenceKinds, config.registry.actionAdapters],
    ),
  );
  const releaseContentHash = keccak256(
    ABI.encode(
      ["bytes32", "address", "bytes32", "bytes32", "bytes32", "bytes32"],
      [
        releaseId,
        coreManifest.contracts.multiChainEventPolicy,
        config.artifacts.MultiChainEventPolicyV1.keccak256,
        runtimeVariantId,
        config.registry.metadataHash,
        declarationsHash,
      ],
    ),
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
        coreManifest.contracts.policyRegistry,
        releaseId,
        coreManifest.contracts.policyKernel,
        predictedFacility,
        config.policy.policyId,
        coreManifest.contracts.multiChainEventPolicy,
        runtimeVariantId,
        policyRuntimeCodeHash,
        constructorArgumentsHash,
        policyConfigHash,
        policyConfigHash,
      ],
    ),
  );
  const policySetCommitment = keccak256(
    ABI.encode(
      ["bytes32", "uint256", "address", "bytes32", "uint8"],
      [
        ZeroHash,
        config.policy.policyId,
        coreManifest.contracts.multiChainEventPolicy,
        policyConfigHash,
        MULTI_CHAIN_SOURCE_ORDERING,
      ],
    ),
  );
  const configCommitment = keccak256(
    toUtf8Bytes(JSON.stringify(canonicalJson(config))),
  );
  return {
    policyConfigHash,
    manifestHash: policyConfigHash,
    constructorArgumentsHash,
    policyRuntimeCodeHash,
    releaseId,
    runtimeVariantId,
    releaseContentHash,
    deploymentId,
    policySetCommitment,
    configCommitment,
  };
}

export async function runV3ActivationPreflight({
  provider,
  sourceProvider,
  sourceProviders,
  attestedHeight,
  attestedHeights,
  signers,
  asset,
  contracts,
  config,
  coreManifest,
  activationArtifacts,
}) {
  const core =
    typeof coreManifest.pilotBounds?.maximumFacilityLimit === "bigint"
      ? coreManifest
      : normalizeCoreManifest(coreManifest);
  const [network, latestBlock] = await Promise.all([
    provider.getNetwork(),
    provider.getBlock("latest"),
  ]);
  if (network.chainId !== BigInt(config.chainId)) {
    throw new Error(
      `Wrong activation network: expected ${config.chainId}, got ${network.chainId}`,
    );
  }
  if (!latestBlock) throw new Error("Latest activation block is unavailable");
  const sourceStates = {};
  for (const [chainKey, expected] of Object.entries(config.sourceNetworks)) {
    const source =
      sourceProviders instanceof Map
        ? (sourceProviders.get(Number(chainKey)) ??
          sourceProviders.get(chainKey))
        : (sourceProviders?.[chainKey] ?? sourceProvider);
    if (!source)
      throw new Error(`Missing source provider for chain key ${chainKey}`);
    const [sourceNetwork, sourceHead] = await Promise.all([
      source.getNetwork(),
      source.getBlockNumber(),
    ]);
    if (sourceNetwork.chainId !== BigInt(expected.evmChainId)) {
      throw new Error(
        `Wrong source network for chain key ${chainKey}: expected ${expected.evmChainId}, got ${sourceNetwork.chainId}`,
      );
    }
    const height =
      attestedHeights instanceof Map
        ? (attestedHeights.get(Number(chainKey)) ??
          attestedHeights.get(chainKey))
        : (attestedHeights?.[chainKey] ?? attestedHeight);
    if (!Number.isSafeInteger(height) || height < 0) {
      throw new Error(`Missing attested height for chain key ${chainKey}`);
    }
    sourceStates[chainKey] = {
      evmChainId: Number(sourceNetwork.chainId),
      head: sourceHead,
      attestedHeight: height,
    };
  }
  const freshness = assessV3ActivationFreshness({
    config,
    targetState: {
      blockNumber: latestBlock.number,
      timestamp: latestBlock.timestamp,
    },
    sourceStates,
  });
  if (!freshness.readyForBroadcast) {
    const sourceFailure = freshness.sources.find(
      ({ status }) => status !== "ready",
    );
    if (sourceFailure) {
      throw new Error(
        `Policy source window is not activation-safe for rule ${sourceFailure.ruleIndex}: ${sourceFailure.reason}`,
      );
    }
    if (freshness.target.activationBlocksRemaining <= 0) {
      throw new Error(
        "Facility maturity does not leave enough blocks for activation",
      );
    }
    if (!freshness.target.maturityWithinFactoryWindow) {
      throw new Error("Facility maturity exceeds the live factory window");
    }
    throw new Error(
      "Proof job expiry must remain at least one hour in the future",
    );
  }

  for (const role of SIGNER_ROLES) {
    sameAddress(
      await signers[role].getAddress(),
      config.roles[role],
      `${role} signer`,
    );
  }
  for (const name of REQUIRED_ARTIFACTS) {
    if (activationArtifacts[name]?.hash !== config.artifacts[name].keccak256) {
      throw new Error(`${name} artifact hash mismatch`);
    }
  }

  const codeAddresses = [
    core.asset.address,
    ...CORE_CONTRACTS.map((name) => core.contracts[name]),
  ];
  const code = await Promise.all(
    codeAddresses.map((value) => provider.getCode(value)),
  );
  if (code.some((value) => value === "0x"))
    throw new Error("A V3 activation dependency has no bytecode");
  const policyRuntime = verifyPinnedPolicyRuntime({
    artifact: activationArtifacts.MultiChainEventPolicyV1.artifact,
    kernel: core.contracts.policyKernel,
    liveCode: code[CORE_CONTRACTS.indexOf("multiChainEventPolicy") + 1],
  });
  const factoryRuntime = verifyPinnedFactoryRuntime({
    artifact: activationArtifacts.CappedPilotFactoryV1.artifact,
    liveCode: code[CORE_CONTRACTS.indexOf("cappedPilotFactory") + 1],
  });
  for (const [index, name] of CORE_CONTRACTS.entries()) {
    if (keccak256(code[index + 1]) !== core.runtimeCodeHashes[name]) {
      throw new Error(
        `${CORE_RUNTIME_ARTIFACTS[name]} live runtime bytecode does not match the core manifest`,
      );
    }
  }

  sameAddress(
    await contracts.kernel.verifier(),
    core.verifier,
    "Kernel verifier",
  );
  sameAddress(
    await contracts.kernel.owner(),
    config.roles.deployer,
    "Kernel owner",
  );
  sameAddress(
    await contracts.kernel.creditState(),
    core.contracts.verifiedCreditState,
    "Kernel credit state",
  );
  sameAddress(
    await contracts.kernel.proofJobs(),
    core.contracts.proofJobs,
    "Kernel ProofJobs",
  );
  if ((await contracts.kernel.safeStaleProofRelease()) !== true)
    throw new Error("Kernel stale-proof safety is disabled");
  sameAddress(
    await contracts.factory.asset(),
    core.asset.address,
    "Factory asset",
  );
  sameAddress(
    await contracts.factory.kernel(),
    core.contracts.policyKernel,
    "Factory kernel",
  );
  sameAddress(
    await contracts.factory.lender(),
    config.roles.lender,
    "Factory lender",
  );
  sameAddress(
    await contracts.factory.borrower(),
    config.roles.borrower,
    "Factory borrower",
  );
  sameAddress(
    await contracts.factory.guardian(),
    config.roles.guardian,
    "Factory guardian",
  );
  sameAddress(
    await contracts.policy.context(),
    core.contracts.policyKernel,
    "Policy context",
  );
  sameAddress(
    await contracts.jobs.kernel(),
    core.contracts.policyKernel,
    "ProofJobs kernel",
  );

  const boundChecks = [
    ["maximumFacilityLimit", core.pilotBounds.maximumFacilityLimit],
    ["maximumTotalLimit", core.pilotBounds.maximumTotalLimit],
    ["minimumBondBps", BigInt(core.pilotBounds.minimumBondBps)],
    ["maximumDrawFeeBps", BigInt(core.pilotBounds.maximumDrawFeeBps)],
    ["maximumMaturityBlocks", BigInt(core.pilotBounds.maximumMaturityBlocks)],
    ["maximumDrawDelayBlocks", BigInt(core.pilotBounds.maximumDrawDelayBlocks)],
    ["maximumFacilityCount", BigInt(core.pilotBounds.maximumFacilityCount)],
  ];
  for (const [method, expected] of boundChecks) {
    if ((await contracts.factory[method]()) !== expected)
      throw new Error(`Factory ${method} mismatch`);
  }
  if ((await contracts.factory.facilityCount()) !== 0n)
    throw new Error("Factory is not empty");
  if ((await contracts.factory.totalFacilityLimit()) !== 0n)
    throw new Error("Factory total limit is not empty");
  if ((await contracts.factory.creationPaused()) !== false)
    throw new Error("Factory creation is paused");
  if ((await contracts.jobs.nextJobId()) !== 1n)
    throw new Error("ProofJobs is not empty");

  const predictedFacility = getAddress(
    await contracts.factory
      .connect(signers.lender)
      .createFacility.staticCall(
        config.facility.facilityLimit,
        config.facility.bondRequired,
        config.facility.drawFeeBps,
        config.facility.maturityBlock,
        config.facility.drawDelayBlocks,
      ),
  );
  const offlinePredictedFacility = deriveFirstPilotFacilityAddress(
    core.contracts.cappedPilotFactory,
  );
  if (predictedFacility !== offlinePredictedFacility) {
    throw new Error(
      "Live first-facility prediction differs from the deterministic offline plan",
    );
  }
  if ((await provider.getCode(predictedFacility)) !== "0x")
    throw new Error("Predicted facility already has bytecode");

  const [decimals, assetSymbol] = await Promise.all([
    asset.decimals(),
    asset.symbol(),
  ]);
  if (Number(decimals) !== core.asset.decimals)
    throw new Error("Asset decimals mismatch");
  if (typeof assetSymbol !== "string" || assetSymbol.length === 0)
    throw new Error("Asset symbol is unavailable");
  if (assetSymbol !== config.assetSymbol)
    throw new Error("Asset symbol mismatch");

  const nativeBalances = {};
  for (const role of SIGNER_ROLES) {
    nativeBalances[role] = await provider.getBalance(config.roles[role]);
    if (nativeBalances[role] < config.requirements.minimumNativeWei[role]) {
      throw new Error(`Insufficient native balance for ${role}`);
    }
  }
  const assetBalances = {
    lender: await asset.balanceOf(config.roles.lender),
    borrower: await asset.balanceOf(config.roles.borrower),
    hunter: await asset.balanceOf(config.roles.hunter),
  };
  if (
    assetBalances.lender <
    config.facility.facilityLimit + config.proofJob.escrow
  ) {
    throw new Error("Insufficient asset balance for lender");
  }
  if (assetBalances.borrower < config.facility.bondRequired)
    throw new Error("Insufficient asset balance for borrower");
  if (assetBalances.hunter < config.proofJob.commitBond)
    throw new Error("Insufficient asset balance for hunter");

  const initialAllowances = {
    lenderFacility: await asset.allowance(
      config.roles.lender,
      predictedFacility,
    ),
    borrowerFacility: await asset.allowance(
      config.roles.borrower,
      predictedFacility,
    ),
    lenderProofJobs: await asset.allowance(
      config.roles.lender,
      core.contracts.proofJobs,
    ),
    hunterProofJobs: await asset.allowance(
      config.roles.hunter,
      core.contracts.proofJobs,
    ),
  };
  for (const [name, value] of Object.entries(initialAllowances)) {
    if (value !== 0n) throw new Error(`${name} allowance must be exactly zero`);
  }
  return {
    chainId: config.chainId,
    activationBlock: latestBlock.number,
    activationTimestamp: latestBlock.timestamp,
    sourceHead: sourceStates[Object.keys(sourceStates)[0]].head,
    attestedHeight: sourceStates[Object.keys(sourceStates)[0]].attestedHeight,
    sourceStates,
    freshness,
    predictedFacility,
    factoryRuntimeCode: factoryRuntime.expectedRuntimeCode,
    policyRuntimeCode: policyRuntime.expectedRuntimeCode,
    assetSymbol,
    nativeBalances,
    assetBalances,
    initialAllowances,
  };
}

function assetEffect(type, amount, decimals, symbol) {
  return {
    type,
    baseUnits: amount.toString(),
    uiUnits: formatUnits(amount, decimals),
    symbol,
  };
}

export function buildV3ActivationPlan({
  config,
  coreManifest,
  predictedFacility,
  policyConfigHash,
  releaseId,
  runtimeVariantId,
  deploymentId,
  assetSymbol,
}) {
  const none = () =>
    assetEffect("none", 0n, coreManifest.asset.decimals, assetSymbol);
  const approval = (amount) =>
    assetEffect("approval", amount, coreManifest.asset.decimals, assetSymbol);
  const transfer = (amount) =>
    assetEffect("transfer", amount, coreManifest.asset.decimals, assetSymbol);
  const policySetCommitment = keccak256(
    ABI.encode(
      ["bytes32", "uint256", "address", "bytes32", "uint8"],
      [
        ZeroHash,
        config.policy.policyId,
        coreManifest.contracts.multiChainEventPolicy,
        policyConfigHash,
        MULTI_CHAIN_SOURCE_ORDERING,
      ],
    ),
  );
  const steps = [
    [
      "createFacility",
      "lender",
      coreManifest.contracts.cappedPilotFactory,
      "createFacility",
      [
        config.facility.facilityLimit.toString(),
        config.facility.bondRequired.toString(),
        config.facility.drawFeeBps,
        config.facility.maturityBlock,
        config.facility.drawDelayBlocks,
      ],
      none(),
    ],
    [
      "configurePolicy",
      "lender",
      coreManifest.contracts.multiChainEventPolicy,
      "configure",
      [
        predictedFacility,
        config.policy.policyId.toString(),
        config.policy.configuration,
      ],
      none(),
    ],
    [
      "registerPolicy",
      "lender",
      coreManifest.contracts.policyKernel,
      "registerPolicy",
      [
        predictedFacility,
        config.policy.policyId.toString(),
        coreManifest.contracts.multiChainEventPolicy,
      ],
      none(),
    ],
    [
      "publishRegistryRelease",
      "deployer",
      coreManifest.contracts.policyRegistry,
      "publishRelease",
      [
        config.registry.packageName,
        config.registry.version,
        coreManifest.contracts.multiChainEventPolicy,
        config.artifacts.MultiChainEventPolicyV1.keccak256,
        keccak256(
          ABI.encode(["address"], [coreManifest.contracts.policyKernel]),
        ),
        config.registry.metadataHash,
        config.registry.evidenceKinds,
        config.registry.actionAdapters,
      ],
      none(),
    ],
    [
      "recordRegistryDeployment",
      "deployer",
      coreManifest.contracts.policyRegistry,
      "recordDeployment",
      [
        releaseId,
        coreManifest.contracts.policyKernel,
        predictedFacility,
        config.policy.policyId.toString(),
        runtimeVariantId,
      ],
      none(),
    ],
    [
      "approveFacilityFunding",
      "lender",
      coreManifest.asset.address,
      "approve",
      [predictedFacility, config.facility.facilityLimit.toString()],
      approval(config.facility.facilityLimit),
    ],
    [
      "fundFacility",
      "lender",
      predictedFacility,
      "fundAsLender",
      [config.facility.facilityLimit.toString()],
      transfer(config.facility.facilityLimit),
    ],
    [
      "approveBorrowerBond",
      "borrower",
      coreManifest.asset.address,
      "approve",
      [predictedFacility, config.facility.bondRequired.toString()],
      approval(config.facility.bondRequired),
    ],
    [
      "postBorrowerBond",
      "borrower",
      predictedFacility,
      "postBond",
      [config.facility.bondRequired.toString()],
      transfer(config.facility.bondRequired),
    ],
    [
      "activateFacility",
      "borrower",
      predictedFacility,
      "activate",
      [policySetCommitment],
      none(),
    ],
    [
      "approveProofJobEscrow",
      "lender",
      coreManifest.asset.address,
      "approve",
      [coreManifest.contracts.proofJobs, config.proofJob.escrow.toString()],
      approval(config.proofJob.escrow),
    ],
    [
      "createProofJob",
      "lender",
      coreManifest.contracts.proofJobs,
      "createJob",
      [
        {
          token: coreManifest.asset.address,
          facility: predictedFacility,
          policyId: config.policy.policyId.toString(),
          requirementsDigest: policyConfigHash,
          expiry: config.proofJob.expiry,
          revealWindowBlocks: config.proofJob.revealWindowBlocks,
          maxSuccessfulProofs: config.proofJob.maxSuccessfulProofs,
          proofReimbursement: config.proofJob.proofReimbursement.toString(),
          outcomeReward: config.proofJob.outcomeReward.toString(),
          commitBond: config.proofJob.commitBond.toString(),
          rewardOutcomeThreshold: config.proofJob.rewardOutcomeThreshold,
        },
      ],
      transfer(config.proofJob.escrow),
    ],
    [
      "approveHunterCommitBond",
      "hunter",
      coreManifest.asset.address,
      "approve",
      [coreManifest.contracts.proofJobs, config.proofJob.commitBond.toString()],
      approval(config.proofJob.commitBond),
    ],
  ];
  return steps.map(([name, signer, to, method, arguments_, effect], index) => ({
    order: index + 1,
    name,
    signer,
    to,
    method,
    arguments: arguments_,
    assetEffect: effect,
    commitments:
      name === "recordRegistryDeployment"
        ? { releaseId, runtimeVariantId, deploymentId }
        : undefined,
  }));
}

export function atomicWriteV3ActivationJson(path, value) {
  const target = resolve(path);
  const temporaryPath = `${target}.activation-tmp`;
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
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
}

export function activationJournalPath(manifestPath) {
  return `${resolve(manifestPath)}.activation-journal.json`;
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

export function reserveV3ActivationManifest(
  path,
  { allowExistingManifest = false, metadata = {} } = {},
) {
  const target = resolve(path);
  const lockPath = `${target}.activation-lock`;
  const temporaryPath = `${target}.activation-tmp`;
  const token = createHash("sha256")
    .update(`${process.pid}:${Date.now()}:${Math.random()}`)
    .digest("hex");
  const record = {
    schemaVersion: 1,
    pid: process.pid,
    token,
    startedAt: new Date().toISOString(),
    ...metadata,
  };
  let descriptor;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      fsyncSync(descriptor);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        if (descriptor !== undefined) closeSync(descriptor);
        throw error;
      }
      let existing;
      try {
        existing = JSON.parse(readFileSync(lockPath, "utf8"));
      } catch {
        throw new Error(`V3 activation lock is unreadable: ${lockPath}`);
      }
      if (
        existing?.schemaVersion !== 1 ||
        !Number.isSafeInteger(existing.pid) ||
        existing.pid <= 0 ||
        typeof existing.token !== "string"
      ) {
        throw new Error(`V3 activation lock is invalid: ${lockPath}`);
      }
      if (processIsAlive(existing.pid))
        throw new Error(`V3 activation lock already exists: ${lockPath}`);
      const stalePath = `${target}.stale.${existing.pid}.${existing.token}.activation-lock`;
      renameSync(lockPath, stalePath);
      unlinkSync(stalePath);
    }
  }
  if (descriptor === undefined)
    throw new Error(`Unable to acquire V3 activation lock: ${lockPath}`);
  try {
    if (!allowExistingManifest && existsSync(target)) {
      throw new Error(`V3 activation manifest already exists: ${target}`);
    }
    if (existsSync(temporaryPath))
      throw new Error(
        `V3 temporary activation manifest already exists: ${temporaryPath}`,
      );
  } catch (error) {
    closeSync(descriptor);
    unlinkSync(lockPath);
    throw error;
  }
  let released = false;
  const release = () => {
    if (released) return;
    const current = JSON.parse(readFileSync(lockPath, "utf8"));
    if (current.token !== token)
      throw new Error(`V3 activation lock ownership changed: ${lockPath}`);
    closeSync(descriptor);
    unlinkSync(lockPath);
    released = true;
  };
  release.path = lockPath;
  return release;
}

function canonicalText(value) {
  return JSON.stringify(canonicalJson(value));
}

function v3ExecutionPlanCommitment(executionPlan) {
  return keccak256(
    toUtf8Bytes(
      canonicalText(
        Object.fromEntries(
          Object.entries(executionPlan).filter(([key]) => key !== "commitment"),
        ),
      ),
    ),
  );
}

function validateStoredV3ExecutionPlan(executionPlan, transactionPlan) {
  if (
    executionPlan?.schemaVersion !== 1 ||
    !isHexString(executionPlan.commitment, 32) ||
    executionPlan.commitment !== v3ExecutionPlanCommitment(executionPlan) ||
    !Array.isArray(executionPlan.steps) ||
    executionPlan.steps.length !== transactionPlan.length
  ) {
    throw new Error("Activation journal has an invalid live execution plan");
  }
  for (let index = 0; index < transactionPlan.length; index += 1) {
    if (
      executionPlan.steps[index]?.name !== transactionPlan[index].name ||
      executionPlan.steps[index].signer !== transactionPlan[index].signer
    ) {
      throw new Error(
        `Activation journal execution step ${index + 1} does not match its transaction plan`,
      );
    }
  }
  return executionPlan;
}

function renewalJournalIdentity(journal) {
  return keccak256(
    toUtf8Bytes(
      canonicalText({
        chainId: journal.chainId,
        configCommitment: journal.configCommitment,
        predictedFacility: journal.predictedFacility,
        commitments: journal.commitments,
        transactionPlan: journal.transactionPlan,
        executionPlan: journal.executionPlan,
      }),
    ),
  );
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
            status: step.receipt.status,
          }
        : null,
  };
}

export function createV3ActivationRenewalBinding(journal) {
  validateStoredV3ExecutionPlan(journal.executionPlan, journal.transactionPlan);
  const binding = {
    schemaVersion: 1,
    journalIdentity: renewalJournalIdentity(journal),
    executionPlanCommitment: journal.executionPlan.commitment,
    checkpoint: journal.steps.map(renewalCheckpointStep),
    remainingSteps: journal.steps
      .filter(({ status }) => status !== "confirmed")
      .map(({ name }) => name),
  };
  if (binding.remainingSteps.length === 0) {
    throw new Error("Completed V3 activation journal does not need renewal");
  }
  binding.commitment = keccak256(toUtf8Bytes(canonicalText(binding)));
  return binding;
}

export function validateV3ActivationRenewalBinding(binding, journal) {
  if (
    binding?.schemaVersion !== 1 ||
    binding.journalIdentity !== renewalJournalIdentity(journal) ||
    binding.executionPlanCommitment !== journal.executionPlan?.commitment ||
    !Array.isArray(binding.checkpoint) ||
    !Array.isArray(binding.remainingSteps)
  ) {
    throw new Error("V3 activation renewal does not match its journal");
  }
  const expectedCommitment = keccak256(
    toUtf8Bytes(
      canonicalText(
        Object.fromEntries(
          Object.entries(binding).filter(([key]) => key !== "commitment"),
        ),
      ),
    ),
  );
  if (binding.commitment !== expectedCommitment) {
    throw new Error("V3 activation renewal commitment mismatch");
  }
  if (binding.checkpoint.length !== journal.steps.length) {
    throw new Error("V3 activation renewal checkpoint length mismatch");
  }
  const statusRank = { planned: 0, prepared: 1, confirmed: 2 };
  for (let index = 0; index < journal.steps.length; index += 1) {
    const checkpoint = binding.checkpoint[index];
    const current = journal.steps[index];
    if (
      checkpoint?.name !== current.name ||
      statusRank[checkpoint.status] === undefined ||
      statusRank[current.status] < statusRank[checkpoint.status]
    ) {
      throw new Error("V3 activation journal regressed after renewal");
    }
    if (
      checkpoint.transactionHash !== null &&
      checkpoint.transactionHash !== current.intent?.transactionHash
    ) {
      throw new Error("V3 activation transaction changed after renewal");
    }
    if (
      checkpoint.status === "confirmed" &&
      canonicalText(checkpoint.receipt) !== canonicalText(current.receipt)
    ) {
      throw new Error("V3 activation receipt changed after renewal");
    }
  }
  const remainingSteps = binding.checkpoint
    .filter(({ status }) => status !== "confirmed")
    .map(({ name }) => name);
  if (canonicalText(binding.remainingSteps) !== canonicalText(remainingSteps)) {
    throw new Error("V3 activation renewal remaining-step list mismatch");
  }
  return true;
}

export function createV3ActivationJournal(
  path,
  {
    chainId,
    configCommitment,
    predictedFacility,
    commitments,
    transactionPlan,
    executionPlan,
    preflight,
  },
) {
  const target = resolve(path);
  if (existsSync(target))
    throw new Error(`V3 activation journal already exists: ${target}`);
  validateStoredV3ExecutionPlan(executionPlan, transactionPlan);
  const now = new Date().toISOString();
  const journal = {
    schemaVersion: 1,
    phase: "running",
    chainId,
    configCommitment,
    predictedFacility: getAddress(predictedFacility),
    commitments,
    transactionPlan,
    executionPlan,
    preflight,
    steps: transactionPlan.map((step) => ({ ...step, status: "planned" })),
    createdAt: now,
    updatedAt: now,
  };
  atomicWriteV3ActivationJson(target, journal);
  return journal;
}

export function readV3ActivationJournal(path) {
  const journal = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (
    journal?.schemaVersion !== 1 ||
    (journal.phase !== "running" && journal.phase !== "complete")
  ) {
    throw new Error("Invalid V3 activation journal");
  }
  if (
    !Array.isArray(journal.steps) ||
    !Array.isArray(journal.transactionPlan)
  ) {
    throw new Error("Invalid V3 activation journal steps");
  }
  validateStoredV3ExecutionPlan(journal.executionPlan, journal.transactionPlan);
  return journal;
}

export function validateV3ActivationJournal(
  journal,
  {
    chainId,
    configCommitment,
    predictedFacility,
    commitments,
    transactionPlan,
    executionPlan,
  },
) {
  validateStoredV3ExecutionPlan(journal.executionPlan, transactionPlan);
  if (journal.chainId !== chainId)
    throw new Error("Activation journal chainId mismatch");
  if (journal.configCommitment !== configCommitment)
    throw new Error("Activation journal config commitment mismatch");
  sameAddress(
    journal.predictedFacility,
    predictedFacility,
    "Activation journal facility",
  );
  if (canonicalText(journal.commitments) !== canonicalText(commitments)) {
    throw new Error("Activation journal commitments mismatch");
  }
  if (
    canonicalText(journal.transactionPlan) !== canonicalText(transactionPlan)
  ) {
    throw new Error("Activation journal transaction plan mismatch");
  }
  if (canonicalText(journal.executionPlan) !== canonicalText(executionPlan)) {
    throw new Error("Activation journal live execution plan mismatch");
  }
  if (journal.steps.length !== transactionPlan.length)
    throw new Error("Activation journal step count mismatch");
  for (let index = 0; index < journal.steps.length; index += 1) {
    const { status, intent, receipt, ...storedPlan } = journal.steps[index];
    if (canonicalText(storedPlan) !== canonicalText(transactionPlan[index])) {
      throw new Error(`Activation journal step ${index + 1} mismatch`);
    }
    if (!["planned", "prepared", "confirmed"].includes(status)) {
      throw new Error(
        `Activation journal step ${index + 1} has invalid status`,
      );
    }
    if (status === "prepared" && !intent?.rawTransaction) {
      throw new Error(
        `Activation journal step ${index + 1} is missing its signed transaction`,
      );
    }
    if (
      status === "confirmed" &&
      (!intent || intent.rawTransaction !== undefined || !receipt)
    ) {
      throw new Error(
        `Activation journal step ${index + 1} has invalid confirmation state`,
      );
    }
    if (status !== "planned") {
      const approved = journal.executionPlan.steps[index];
      if (!journalIntentMatchesApproved(intent, approved)) {
        throw new Error(
          `Activation journal step ${index + 1} intent differs from its approved execution plan`,
        );
      }
      if (status === "prepared") {
        const transaction = Transaction.from(intent.rawTransaction);
        if (
          !transactionMatchesIntent(transaction, intent) ||
          !transactionMatchesFeeFields(transaction, approved)
        ) {
          throw new Error(
            `Activation journal step ${index + 1} signed transaction differs from its approved execution plan`,
          );
        }
      }
    }
  }
  return journal;
}

function transactionMatchesFeeFields(transaction, intent) {
  if (
    Number(transaction.type) !== intent.type ||
    BigInt(transaction.gasLimit) !== BigInt(intent.gasLimit)
  ) {
    return false;
  }
  if (intent.type === 2) {
    return Boolean(
      intent.gasPrice === null &&
      transaction.maxFeePerGas != null &&
      transaction.maxPriorityFeePerGas != null &&
      BigInt(transaction.maxFeePerGas) === BigInt(intent.maxFeePerGas) &&
      BigInt(transaction.maxPriorityFeePerGas) ===
        BigInt(intent.maxPriorityFeePerGas),
    );
  }
  return Boolean(
    intent.type === 0 &&
    transaction.gasPrice != null &&
    transaction.maxFeePerGas == null &&
    transaction.maxPriorityFeePerGas == null &&
    BigInt(transaction.gasPrice) === BigInt(intent.gasPrice) &&
    intent.maxFeePerGas === null &&
    intent.maxPriorityFeePerGas === null,
  );
}

function journalIntentMatchesApproved(intent, approved) {
  return Boolean(
    intent &&
    isHexString(intent.transactionHash, 32) &&
    BigInt(intent.chainId) === BigInt(approved.chainId) &&
    intent.from === approved.from &&
    intent.to === approved.to &&
    intent.nonce === approved.nonce &&
    intent.dataHash === approved.dataHash &&
    BigInt(intent.value) === BigInt(approved.value) &&
    intent.type === approved.type &&
    BigInt(intent.gasLimit) === BigInt(approved.gasLimit) &&
    intent.gasPrice === approved.gasPrice &&
    intent.maxFeePerGas === approved.maxFeePerGas &&
    intent.maxPriorityFeePerGas === approved.maxPriorityFeePerGas,
  );
}

function transactionMatchesIntent(transaction, intent) {
  return Boolean(
    transaction?.hash &&
    transaction.hash.toLowerCase() === intent.transactionHash &&
    transaction.from &&
    getAddress(transaction.from) === intent.from &&
    transaction.to &&
    getAddress(transaction.to) === intent.to &&
    BigInt(transaction.chainId) === BigInt(intent.chainId) &&
    transaction.nonce === intent.nonce &&
    keccak256(transaction.data) === intent.dataHash &&
    BigInt(transaction.value) === BigInt(intent.value) &&
    transactionMatchesFeeFields(transaction, intent),
  );
}

export async function prepareV3ActivationStep({
  journal,
  journalPath,
  stepIndex,
  signer,
  request,
  approvedTransaction,
}) {
  const step = journal.steps[stepIndex];
  if (!step || step.status !== "planned")
    throw new Error(`Activation step ${stepIndex + 1} is not planned`);
  const signerAddress = getAddress(await signer.getAddress());
  if (
    approvedTransaction?.name !== step.name ||
    approvedTransaction.signer !== step.signer ||
    approvedTransaction.from !== signerAddress ||
    approvedTransaction.to !== address(step.to, `${step.name} target`) ||
    BigInt(approvedTransaction.chainId) !== BigInt(journal.chainId) ||
    approvedTransaction.dataHash !== keccak256(request.data) ||
    BigInt(approvedTransaction.value) !== BigInt(request.value ?? 0)
  ) {
    throw new Error(
      `${step.name} approved transaction does not match its plan`,
    );
  }
  const unsignedTransaction = {
    type: approvedTransaction.type,
    chainId: approvedTransaction.chainId,
    nonce: approvedTransaction.nonce,
    to: approvedTransaction.to,
    value: approvedTransaction.value,
    data: approvedTransaction.data,
    gasLimit: approvedTransaction.gasLimit,
    ...(approvedTransaction.type === 2
      ? {
          maxFeePerGas: approvedTransaction.maxFeePerGas,
          maxPriorityFeePerGas: approvedTransaction.maxPriorityFeePerGas,
        }
      : { gasPrice: approvedTransaction.gasPrice }),
  };
  const rawTransaction = await signer.signTransaction(unsignedTransaction);
  const transaction = Transaction.from(rawTransaction);
  const transactionHash = transaction.hash?.toLowerCase();
  if (!transactionHash || !transaction.from || !transaction.to)
    throw new Error(`${step.name} signed transaction is invalid`);
  const intent = {
    transactionHash,
    rawTransaction,
    chainId: transaction.chainId.toString(),
    from: getAddress(transaction.from),
    to: getAddress(transaction.to),
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
  if (
    intent.from !== signerAddress ||
    !transactionMatchesFeeFields(transaction, approvedTransaction) ||
    !transactionMatchesIntent(transaction, intent)
  ) {
    throw new Error(
      `${step.name} signed transaction does not match its intent`,
    );
  }
  const updated = {
    ...journal,
    steps: journal.steps.map((value, index) =>
      index === stepIndex ? { ...value, status: "prepared", intent } : value,
    ),
    updatedAt: new Date().toISOString(),
  };
  atomicWriteV3ActivationJson(journalPath, updated);
  return updated;
}

function validateReceipt(receipt, intent, recordedReceipt) {
  if (
    !receipt ||
    !receipt.hash ||
    receipt.hash.toLowerCase() !== intent.transactionHash ||
    receipt.status !== 1 ||
    !Number.isSafeInteger(receipt.blockNumber) ||
    typeof receipt.blockHash !== "string"
  ) {
    throw new Error("Activation transaction receipt is invalid");
  }
  if (
    recordedReceipt &&
    (recordedReceipt.hash !== receipt.hash.toLowerCase() ||
      recordedReceipt.blockNumber !== receipt.blockNumber ||
      recordedReceipt.blockHash !== receipt.blockHash.toLowerCase() ||
      recordedReceipt.status !== receipt.status)
  ) {
    throw new Error(
      "Activation transaction receipt changed after confirmation",
    );
  }
}

export async function reconcileV3ActivationStep({
  journal,
  journalPath,
  stepIndex,
  provider,
  targetConfirmations = 1,
  maximumReceiptPolls = 20,
  receiptPollIntervalMs = 1_000,
  beforeBroadcast = async () => {},
  delay = (milliseconds) =>
    new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
}) {
  const step = journal.steps[stepIndex];
  if (!step || step.status === "planned")
    throw new Error(`Activation step ${stepIndex + 1} is not prepared`);
  const intent = step.intent;
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(intent.chainId))
    throw new Error(`${step.name} journal chain mismatch`);
  targetConfirmations = integer(
    targetConfirmations,
    "target confirmations",
    256,
    { positive: true },
  );
  maximumReceiptPolls = integer(
    maximumReceiptPolls,
    "maximum receipt polls",
    10_000,
    { positive: true },
  );
  if (maximumReceiptPolls < targetConfirmations) {
    throw new Error("Maximum receipt polls must cover target confirmations");
  }
  let receipt;
  let transaction;
  let broadcast = false;
  let canonicallyConfirmed = false;
  for (let attempt = 0; attempt < maximumReceiptPolls; attempt += 1) {
    receipt = await provider.getTransactionReceipt(intent.transactionHash);
    if (receipt) {
      validateReceipt(
        receipt,
        intent,
        step.status === "confirmed" ? step.receipt : undefined,
      );
      const confirmedThrough =
        targetConfirmations === 1
          ? receipt.blockNumber
          : await provider.getBlockNumber();
      const requiredBlock = receipt.blockNumber + targetConfirmations - 1;
      if (confirmedThrough >= requiredBlock) {
        const [canonicalBlock, confirmedReceipt, canonicalTransaction] =
          await Promise.all([
            provider.getBlock(receipt.blockNumber),
            provider.getTransactionReceipt(intent.transactionHash),
            provider.getTransaction(intent.transactionHash),
          ]);
        validateReceipt(
          confirmedReceipt,
          intent,
          step.status === "confirmed" ? step.receipt : undefined,
        );
        if (
          !canonicalBlock?.hash ||
          canonicalBlock.hash.toLowerCase() !==
            confirmedReceipt.blockHash.toLowerCase()
        ) {
          throw new Error(`${step.name} receipt block is not canonical`);
        }
        if (
          !canonicalTransaction ||
          !transactionMatchesIntent(canonicalTransaction, intent)
        ) {
          throw new Error(
            `${step.name} canonical transaction does not match its journal`,
          );
        }
        receipt = confirmedReceipt;
        transaction = canonicalTransaction;
        canonicallyConfirmed = true;
        break;
      }
    } else {
      transaction = await provider.getTransaction(intent.transactionHash);
      if (!transaction) {
        if (!intent.rawTransaction) {
          throw new Error(`${step.name} signed transaction is unavailable`);
        }
        const [confirmedNonce, pendingNonce] = await Promise.all([
          provider.getTransactionCount(intent.from, "latest"),
          provider.getTransactionCount(intent.from, "pending"),
        ]);
        if (confirmedNonce > intent.nonce || pendingNonce > intent.nonce) {
          throw new Error(
            `${step.name} transaction nonce ${intent.nonce} was advanced or replaced`,
          );
        }
        if (!broadcast) {
          await beforeBroadcast();
          await provider.broadcastTransaction(intent.rawTransaction);
          broadcast = true;
          continue;
        }
      } else if (!transactionMatchesIntent(transaction, intent)) {
        throw new Error(
          `${step.name} pending transaction does not match its journal`,
        );
      }
    }
    if (attempt + 1 < maximumReceiptPolls) {
      await delay(receiptPollIntervalMs);
    }
  }
  if (!canonicallyConfirmed) {
    throw new Error(
      `${step.name} transaction remains pending after ${maximumReceiptPolls} bounded receipt polls`,
    );
  }
  if (step.status === "confirmed")
    return { journal, receipt, broadcast: false };
  const { rawTransaction: _rawTransaction, ...confirmedIntent } = intent;
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
              status: receipt.status,
            },
          }
        : value,
    ),
    updatedAt: new Date().toISOString(),
  };
  atomicWriteV3ActivationJson(journalPath, updated);
  return { journal: updated, receipt, broadcast };
}

export function completeV3ActivationJournal(
  journal,
  journalPath,
  manifestPath,
) {
  if (journal.steps.some((step) => step.status !== "confirmed")) {
    throw new Error(
      "Cannot complete an activation journal with unfinished steps",
    );
  }
  const completed = {
    ...journal,
    phase: "complete",
    manifestPath: resolve(manifestPath),
    completedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  atomicWriteV3ActivationJson(journalPath, completed);
  return completed;
}

export function initializeV3ActivationPersistence({
  broadcast,
  manifestPath,
  lockMetadata,
  initialJournal,
}) {
  const journalPath = activationJournalPath(manifestPath);
  if (!broadcast) return { journalPath };
  const existingJournal = existsSync(journalPath)
    ? readV3ActivationJournal(journalPath)
    : undefined;
  const releaseManifestReservation = reserveV3ActivationManifest(manifestPath, {
    allowExistingManifest: Boolean(existingJournal),
    metadata: lockMetadata,
  });
  try {
    const journal =
      existingJournal ?? createV3ActivationJournal(journalPath, initialJournal);
    return { journalPath, journal, releaseManifestReservation };
  } catch (error) {
    releaseManifestReservation();
    throw error;
  }
}
