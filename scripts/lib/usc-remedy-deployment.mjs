import {
  AbiCoder,
  Contract,
  ContractFactory,
  Interface,
  Transaction,
  ZeroAddress,
  getAddress,
  getCreateAddress,
  isHexString,
  keccak256,
  toBeHex,
  toUtf8Bytes,
  zeroPadValue,
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
import { resolve } from "node:path";
import { requireCleanDeployableRepository } from "./pilot-readiness.mjs";

export const USC_CONTRACTS_VERSION = "0.2.0";
export const USC_REMEDY_GENERATION = "usc-remedy-v1";
export const USC_REMEDY_ARTIFACTS = Object.freeze([
  "UscRemedyTransportV1",
  "RemedyCoordinatorV1",
  "BoundedRemedyReceiverV1",
  "UscRemedyDispatcherV1",
  "Inbox020",
]);
export const USC_PLAN_VALIDITY_SECONDS = 1_800;
export const USC_REMEDY_USAGE = `Usage: node scripts/deploy-usc-remedy.mjs [options]

Default: deterministic offline dry-run; no RPC, signer, file write, or broadcast.

Options:
  --help, -h                 Show this help and exit
  --config <path>            Deployment evidence/config (default: config/usc-remedy.example.json)
  --manifest <path>          Deployment manifest output/input
  --live-check               Qualify chains/dependencies and populate capped fees
  --write-plan <path>        Write an expiring, exact live execution plan for review
  --broadcast                Broadcast only the exact approved execution plan
  --approved-plan <path>     Reviewed plan required with --broadcast
  --approval-commitment <h>  Externally recorded approval digest required by --broadcast
  --qualify-deployed         Read-only final route and transaction qualification

Safety boundary: this tool deploys a dedicated Inbox last, after the receiver
and dispatcher, with its constructor bound to the predicted Recourse dispatcher.
It never calls setMessageDispatcher and never replaces a shared dispatcher.`;

export const USC_OUTBOX_ABI = Object.freeze([
  "function chainKey() view returns (uint32)",
  "function coreFee() view returns (uint256)",
  "function feeRegistry() view returns (address)",
  "function defaultRateLimit() view returns (uint128)",
  "function validator() view returns (address)",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function paused() view returns (bool)",
  "function publishMessage(bool canAck,bytes payload) returns (bytes32)",
  "function isAcknowledged(bytes32 messageId) view returns (bool)",
]);
export const USC_INBOX_ABI = Object.freeze([
  "function localChainKey() view returns (bytes32)",
  "function creditcoinChainId() view returns (uint256)",
  "function defaultVoteValidator() view returns (address)",
  "function messageDispatcher() view returns (address)",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function paused() view returns (bool)",
  "function setMessageDispatcher(address receiver)",
  "function deliverMessage(bytes32 messageId,address emitterAddress,bytes payload,bytes votes) returns (bool)",
]);
export const USC_ACKNOWLEDGEMENT_VALIDATOR_ABI = Object.freeze([
  "function destinationChainKey() view returns (uint64)",
  "function outbox() view returns (address)",
  "function proofVerifier() view returns (address)",
  "function attestToken() view returns (address)",
  "function trustedInboxes(address inbox) view returns (bool)",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "event TrustedInboxUpdated(address indexed inbox,bool trusted)",
]);
export const USC_EOA_VOTE_VALIDATOR_ABI = Object.freeze([
  "function validatorType() view returns (string)",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function attestorRegistry() view returns (address)",
  "function minAttestorCount() view returns (uint256)",
  "function thresholdNumerator() view returns (uint256)",
  "function thresholdAddition() view returns (uint256)",
  "function attestorSetUpdateNonce() view returns (uint256)",
  "function attestors() view returns (address[])",
  "function threshold() view returns (uint256)",
]);
export const USC_ATTESTOR_REGISTRY_ABI = Object.freeze([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function isUpdater(address updater) view returns (bool)",
  "function attestors() view returns (address[])",
  "event UpdaterSet(address indexed updater,bool authorized)",
]);

const ABI = AbiCoder.defaultAbiCoder();
const OUTBOX_CONSTRUCTOR_TYPES = [
  "uint32",
  "address",
  "address",
  "uint128",
  "address",
  "address",
  "address",
];
const INBOX_CONSTRUCTOR_TYPES = [
  "bytes32",
  "uint256",
  "address",
  "address",
  "address",
];
const ACKNOWLEDGEMENT_VALIDATOR_CONSTRUCTOR_TYPES = [
  "uint64",
  "address",
  "address",
  "address",
];
const ATTESTOR_REGISTRY_CONSTRUCTOR_TYPES = ["address", "address[]"];
const OUTBOX_STORAGE_LOCATION =
  0xab96e70160de0dc083b7f7505d7192c8db5b16070df1d645513a7957430b9700n;
const OUTBOX_ATTESTOR_VAULT_SLOT = OUTBOX_STORAGE_LOCATION + 6n;
const OUTBOX_ATTEST_TOKEN_SLOT = OUTBOX_STORAGE_LOCATION + 7n;
const OUTBOX_FEE_REGISTRY_SLOT = OUTBOX_STORAGE_LOCATION + 8n;
const EVENT_HISTORY_BLOCK_RANGE = 10_000;
const EXPECTED_CONSTRUCTORS = Object.freeze({
  UscRemedyTransportV1: [
    "address",
    "address",
    "address",
    "uint64",
    "address",
    "uint256",
  ],
  RemedyCoordinatorV1: ["address", "address"],
  BoundedRemedyReceiverV1: ["address", "address"],
  UscRemedyDispatcherV1: ["address", "uint64", "address", "address", "address"],
  Inbox020: ["bytes32", "uint256", "address", "address", "address"],
});

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function addressList(value, label) {
  if (!Array.isArray(value) || value.length < 3) {
    throw new Error(`${label} must contain at least three addresses`);
  }
  const normalized = value.map((item, index) =>
    address(item, `${label}[${index}]`),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} must contain unique addresses`);
  }
  return normalized;
}

function nonemptyAddressList(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must contain at least one address`);
  }
  const normalized = value.map((item, index) =>
    address(item, `${label}[${index}]`),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} must contain unique addresses`);
  }
  return normalized;
}

function address(value, label) {
  let normalized;
  try {
    normalized = getAddress(value);
  } catch {
    throw new Error(`${label} must be a valid address`);
  }
  if (normalized === ZeroAddress) throw new Error(`${label} must not be zero`);
  return normalized;
}

function bytes32(value, label) {
  if (!isHexString(value, 32) || /^0x0{64}$/i.test(value)) {
    throw new Error(`${label} must be nonzero bytes32`);
  }
  return value.toLowerCase();
}

function digest(value, label) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value ?? "") || /^0x0{64}$/i.test(value)) {
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

function integer(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(
      `${label} must be a nonnegative integer no greater than ${maximum}`,
    );
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
    throw new Error(`${label} must be a nonnegative base-10 integer string`);
  }
  const normalized = BigInt(value);
  if (positive && normalized === 0n)
    throw new Error(`${label} must be positive`);
  return normalized;
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
    maximumGasLimit: decimal(
      input.maximumGasLimit,
      `${label}.maximumGasLimit`,
      {
        positive: true,
      },
    ),
  };
  if (input.transactionType === "eip1559") {
    if (input.maximumGasPrice !== undefined) {
      throw new Error(`${label} mixes legacy and EIP-1559 fee fields`);
    }
    normalized.maximumFeePerGas = decimal(
      input.maximumFeePerGas,
      `${label}.maximumFeePerGas`,
      { positive: true },
    );
    normalized.maximumPriorityFeePerGas = decimal(
      input.maximumPriorityFeePerGas,
      `${label}.maximumPriorityFeePerGas`,
      { positive: true },
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
      { positive: true },
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

function environmentName(value, label) {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(value)) {
    throw new Error(`${label} must be an uppercase environment variable name`);
  }
  return value;
}

function dependency(value, label) {
  const input = object(value, label);
  return {
    address: address(input.address, `${label}.address`),
    runtimeCodeKeccak256: digest(
      input.runtimeCodeKeccak256,
      `${label}.runtimeCodeKeccak256`,
    ),
  };
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

function commitment(value) {
  return keccak256(toUtf8Bytes(JSON.stringify(canonicalJson(value))));
}

function sameAddress(actual, expected, label) {
  if (getAddress(actual) !== getAddress(expected)) {
    throw new Error(`${label} mismatch`);
  }
}

function sameAddressList(actual, expected, label) {
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    actual.some((value, index) => getAddress(value) !== expected[index])
  ) {
    throw new Error(`${label} mismatch`);
  }
}

function sameAddressSet(actual, expected, label) {
  if (!Array.isArray(actual)) throw new Error(`${label} mismatch`);
  const normalized = actual.map((value) => getAddress(value)).sort();
  const expectedSorted = [...expected].sort();
  if (
    normalized.length !== expectedSorted.length ||
    normalized.some((value, index) => value !== expectedSorted[index])
  ) {
    throw new Error(`${label} mismatch`);
  }
}

function exactValue(actual, expected, label) {
  if (BigInt(actual) !== BigInt(expected)) throw new Error(`${label} mismatch`);
}

export function parseUscRemedyDeploymentArguments(args) {
  const parsed = {
    help: false,
    broadcast: false,
    liveCheck: false,
    qualifyDeployed: false,
    configPath: "config/usc-remedy.example.json",
    manifestPath: "usc-remedy-deployment.json",
    writePlanPath: undefined,
    approvedPlanPath: undefined,
    approvalCommitment: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") parsed.help = true;
    else if (argument === "--broadcast") parsed.broadcast = true;
    else if (argument === "--live-check") parsed.liveCheck = true;
    else if (argument === "--approval-commitment") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--approval-commitment requires a digest");
      }
      parsed.approvalCommitment = digest(value, "approval commitment");
      index += 1;
    } else if (argument === "--qualify-deployed") {
      parsed.qualifyDeployed = true;
      parsed.liveCheck = true;
    } else if (
      argument === "--config" ||
      argument === "--manifest" ||
      argument === "--write-plan" ||
      argument === "--approved-plan"
    ) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a path`);
      }
      if (argument === "--config") parsed.configPath = value;
      else if (argument === "--manifest") parsed.manifestPath = value;
      else if (argument === "--write-plan") parsed.writePlanPath = value;
      else parsed.approvedPlanPath = value;
      index += 1;
    } else throw new Error(`Unknown argument: ${argument}`);
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
  if (parsed.writePlanPath && !parsed.liveCheck) {
    throw new Error("--write-plan requires --live-check");
  }
  if (parsed.broadcast && parsed.writePlanPath) {
    throw new Error("--write-plan cannot be combined with --broadcast");
  }
  if (
    parsed.qualifyDeployed &&
    (parsed.broadcast ||
      parsed.writePlanPath ||
      parsed.approvedPlanPath ||
      parsed.approvalCommitment)
  ) {
    throw new Error(
      "--qualify-deployed cannot broadcast or create/use an approval plan",
    );
  }
  if (!parsed.broadcast && parsed.approvalCommitment) {
    throw new Error("--approval-commitment requires --broadcast");
  }
  return parsed;
}

export function verifyInstalledUscContracts020(rootDirectory = process.cwd()) {
  const packageRoot = resolve(
    rootDirectory,
    "node_modules/@gluwa/usc-contracts",
  );
  const packageJson = JSON.parse(
    readFileSync(resolve(packageRoot, "package.json"), "utf8"),
  );
  if (
    packageJson.name !== "@gluwa/usc-contracts" ||
    packageJson.version !== USC_CONTRACTS_VERSION
  ) {
    throw new Error(
      `@gluwa/usc-contracts ${USC_CONTRACTS_VERSION} is required`,
    );
  }
  const outboxSource = readFileSync(
    resolve(packageRoot, "contracts/write-ability/abstract/IOutbox.sol"),
    "utf8",
  ).replace(/\s+/g, " ");
  const inboxSource = readFileSync(
    resolve(packageRoot, "contracts/write-ability/abstract/IInbox.sol"),
    "utf8",
  ).replace(/\s+/g, " ");
  for (const signature of [
    "function chainKey()",
    "function coreFee()",
    "function feeRegistry()",
    "function defaultRateLimit()",
    "function validator()",
    "function publishMessage(",
    "function isAcknowledged(",
  ]) {
    if (!outboxSource.includes(signature)) {
      throw new Error(`Installed Outbox 0.2.0 API is missing ${signature}`);
    }
  }
  const outboxImplementation = readFileSync(
    resolve(packageRoot, "contracts/write-ability/Outbox.sol"),
    "utf8",
  ).replace(/\s+/g, "");
  const inboxImplementation = readFileSync(
    resolve(packageRoot, "contracts/write-ability/Inbox.sol"),
    "utf8",
  ).replace(/\s+/g, "");
  const acknowledgementValidator = readFileSync(
    resolve(
      packageRoot,
      "contracts/write-ability/AcknowledgementValidator.sol",
    ),
    "utf8",
  ).replace(/\s+/g, "");
  const eoaValidator = readFileSync(
    resolve(packageRoot, "contracts/write-ability/EOAValidator.sol"),
    "utf8",
  ).replace(/\s+/g, "");
  const attestorRegistry = readFileSync(
    resolve(packageRoot, "contracts/write-ability/AttestorRegistry.sol"),
    "utf8",
  ).replace(/\s+/g, "");
  const attestorRegistryInterface = readFileSync(
    resolve(
      packageRoot,
      "contracts/write-ability/abstract/IAttestorRegistry.sol",
    ),
    "utf8",
  ).replace(/\s+/g, "");
  const outboxStorage = readFileSync(
    resolve(packageRoot, "contracts/write-ability/common/Storage.sol"),
    "utf8",
  ).replace(/\s+/g, "");
  if (
    !outboxImplementation.includes(
      "constructor(uint32initialChainKey,addressinitialOwner,addressinitialValidator,uint128initialRateLimit,addressinitialAttestorVault,addressinitialFeeRegistry,addressinitialAttestToken)",
    )
  ) {
    throw new Error("Installed Outbox 0.2.0 constructor API mismatch");
  }
  if (
    !inboxImplementation.includes(
      "constructor(bytes32chainKey,uint256creditcoinChainId_,IVoteValidatorinitialValidator,addressmessageDispatcher_,addressinitialOwner)",
    )
  ) {
    throw new Error("Installed Inbox 0.2.0 constructor API mismatch");
  }
  if (
    !inboxImplementation.includes(
      "_requireMessageDispatcher(messageDispatcher_)",
    ) ||
    !inboxImplementation.includes("if(dispatcher.code.length==0)")
  ) {
    throw new Error(
      "Installed Inbox 0.2.0 does not require dispatcher code at construction",
    );
  }
  for (const signature of [
    "function deliverMessage(",
    "function localChainKey",
    "function creditcoinChainId",
    "function defaultVoteValidator",
    "function messageDispatcher",
    "function setMessageDispatcher(",
  ]) {
    if (!inboxSource.includes(signature)) {
      throw new Error(`Installed Inbox 0.2.0 API is missing ${signature}`);
    }
  }
  for (const signature of [
    "constructor(uint64_destinationChainKey,address_owner,address_proofVerifier,address_attestToken)",
    "uint64publicimmutabledestinationChainKey",
    "IAckOutboxpublicoutbox",
    "IUSCProofVerifierpublicproofVerifier",
    "mapping(address=>bool)publictrustedInboxes",
    "IERC20publicimmutableattestToken",
    "eventTrustedInboxUpdated(addressindexedinbox,booltrusted)",
  ]) {
    if (!acknowledgementValidator.includes(signature)) {
      throw new Error(
        `Installed AcknowledgementValidator 0.2.0 API is missing ${signature}`,
      );
    }
  }
  for (const signature of [
    "IAttestorRegistrypublicimmutableattestorRegistry",
    "uint256publicminAttestorCount",
    "uint256publicthresholdNumerator",
    "uint256publicthresholdAddition",
    "uint256publicattestorSetUpdateNonce",
    "functionvalidatorType()",
    "functionattestors()",
    "functionthreshold()",
  ]) {
    if (!eoaValidator.includes(signature)) {
      throw new Error(
        `Installed EOAValidator 0.2.0 API is missing ${signature}`,
      );
    }
  }
  for (const signature of [
    "constructor(addressinitialOwner,address[]memoryinitialAttestors)",
    "mapping(address=>bool)publicoverrideisUpdater",
    "functionattestors()",
  ]) {
    if (!attestorRegistry.includes(signature)) {
      throw new Error(
        `Installed AttestorRegistry 0.2.0 API is missing ${signature}`,
      );
    }
  }
  if (
    !attestorRegistryInterface.includes(
      "eventUpdaterSet(addressindexedupdater,boolauthorized)",
    )
  ) {
    throw new Error(
      "Installed AttestorRegistry 0.2.0 API is missing UpdaterSet",
    );
  }
  for (const signature of [
    "addressattestorVault;",
    "addressattestToken;",
    "addressfeeRegistry;",
    "0xab96e70160de0dc083b7f7505d7192c8db5b16070df1d645513a7957430b9700",
  ]) {
    if (!outboxStorage.includes(signature)) {
      throw new Error(
        `Installed Outbox 0.2.0 storage layout is missing ${signature}`,
      );
    }
  }
  new Interface(USC_OUTBOX_ABI);
  new Interface(USC_INBOX_ABI);
  new Interface(USC_ACKNOWLEDGEMENT_VALIDATOR_ABI);
  new Interface(USC_EOA_VOTE_VALIDATOR_ABI);
  new Interface(USC_ATTESTOR_REGISTRY_ABI);
  return { packageName: packageJson.name, version: packageJson.version };
}

export function validateUscRemedyDeploymentConfig(input) {
  const config = object(input, "config");
  if (config.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  if (config.generation !== USC_REMEDY_GENERATION) {
    throw new Error(`generation must be ${USC_REMEDY_GENERATION}`);
  }
  if (config.uscContractsVersion !== USC_CONTRACTS_VERSION) {
    throw new Error(`uscContractsVersion must be ${USC_CONTRACTS_VERSION}`);
  }
  if (config.exclusiveSigners !== true) {
    throw new Error("USC deployment requires exclusiveSigners to be true");
  }
  const sourceInput = object(config.source, "source");
  const destinationInput = object(config.destination, "destination");
  const sourceChainId = positiveInteger(sourceInput.chainId, "source.chainId");
  if (sourceChainId !== 102031) {
    throw new Error("source.chainId must be the Recourse CC3 chain 102031");
  }
  const destinationChainId = positiveInteger(
    destinationInput.chainId,
    "destination.chainId",
  );
  if (destinationChainId === sourceChainId) {
    throw new Error("Source and destination EVM chains must be distinct");
  }
  const destinationChainKey = positiveInteger(
    destinationInput.uscChainKey,
    "destination.uscChainKey",
    0xffffffff,
  );
  if (destinationInput.localChainKey !== undefined) {
    throw new Error(
      "destination.localChainKey is unsupported; configure destination.inbox.localChainKey only",
    );
  }
  const sourceDeployer = address(sourceInput.deployer, "source.deployer");
  const destinationDeployer = address(
    destinationInput.deployer,
    "destination.deployer",
  );
  const sourceStartingNonce = integer(
    sourceInput.expectedStartingNonce,
    "source.expectedStartingNonce",
  );
  const destinationStartingNonce = integer(
    destinationInput.expectedStartingNonce,
    "destination.expectedStartingNonce",
  );
  const predictedInbox = getCreateAddress({
    from: destinationDeployer,
    nonce: destinationStartingNonce + 2,
  });
  const outboxInput = object(sourceInput.outbox, "source.outbox");
  const inboxInput = object(destinationInput.inbox, "destination.inbox");
  const validatorInput = object(
    outboxInput.validator,
    "source.outbox.validator",
  );
  const voteValidatorInput = object(
    inboxInput.defaultVoteValidator,
    "destination.inbox.defaultVoteValidator",
  );
  const attestorRegistryInput = object(
    voteValidatorInput.attestorRegistry,
    "destination.inbox.defaultVoteValidator.attestorRegistry",
  );
  const outbox = {
    ...dependency(outboxInput, "source.outbox"),
    deploymentTransactionHash: bytes32(
      outboxInput.deploymentTransactionHash,
      "source.outbox.deploymentTransactionHash",
    ),
    chainKey: positiveInteger(
      outboxInput.chainKey,
      "source.outbox.chainKey",
      0xffffffff,
    ),
    owner: address(outboxInput.owner, "source.outbox.owner"),
    validator: {
      ...dependency(validatorInput, "source.outbox.validator"),
      dedicatedToRecourse: validatorInput.dedicatedToRecourse,
      deploymentTransactionHash: bytes32(
        validatorInput.deploymentTransactionHash,
        "source.outbox.validator.deploymentTransactionHash",
      ),
      creationCodeKeccak256: digest(
        validatorInput.creationCodeKeccak256,
        "source.outbox.validator.creationCodeKeccak256",
      ),
      owner: address(validatorInput.owner, "source.outbox.validator.owner"),
      destinationChainKey: positiveInteger(
        validatorInput.destinationChainKey,
        "source.outbox.validator.destinationChainKey",
        Number.MAX_SAFE_INTEGER,
      ),
      outbox: address(validatorInput.outbox, "source.outbox.validator.outbox"),
      proofVerifier: dependency(
        validatorInput.proofVerifier,
        "source.outbox.validator.proofVerifier",
      ),
      attestToken: address(
        validatorInput.attestToken,
        "source.outbox.validator.attestToken",
      ),
      trustedInboxes: nonemptyAddressList(
        validatorInput.trustedInboxes,
        "source.outbox.validator.trustedInboxes",
      ),
    },
    defaultRateLimit: decimal(
      outboxInput.defaultRateLimit,
      "source.outbox.defaultRateLimit",
    ),
    attestorVault: dependency(
      outboxInput.attestorVault,
      "source.outbox.attestorVault",
    ),
    feeRegistry: dependency(
      outboxInput.feeRegistry,
      "source.outbox.feeRegistry",
    ),
    attestToken: dependency(
      outboxInput.attestToken,
      "source.outbox.attestToken",
    ),
    maximumCoreFee: decimal(
      outboxInput.maximumCoreFee,
      "source.outbox.maximumCoreFee",
      { positive: true },
    ),
    paused: outboxInput.paused,
  };
  if (outbox.paused !== false) {
    throw new Error("source.outbox.paused must explicitly be false");
  }
  const inbox = {
    expectedAddress: address(
      inboxInput.expectedAddress,
      "destination.inbox.expectedAddress",
    ),
    dedicatedToRecourse: inboxInput.dedicatedToRecourse,
    localChainKey: bytes32(
      inboxInput.localChainKey,
      "destination.inbox.localChainKey",
    ),
    creditcoinChainId: decimal(
      inboxInput.creditcoinChainId,
      "destination.inbox.creditcoinChainId",
      { positive: true },
    ),
    owner: address(inboxInput.owner, "destination.inbox.owner"),
    defaultVoteValidator: {
      ...dependency(
        voteValidatorInput,
        "destination.inbox.defaultVoteValidator",
      ),
      validatorType: voteValidatorInput.validatorType,
      owner: address(
        voteValidatorInput.owner,
        "destination.inbox.defaultVoteValidator.owner",
      ),
      attestorRegistry: {
        ...dependency(
          attestorRegistryInput,
          "destination.inbox.defaultVoteValidator.attestorRegistry",
        ),
        dedicatedToRecourse: attestorRegistryInput.dedicatedToRecourse,
        deploymentTransactionHash: bytes32(
          attestorRegistryInput.deploymentTransactionHash,
          "destination.inbox.defaultVoteValidator.attestorRegistry.deploymentTransactionHash",
        ),
        creationCodeKeccak256: digest(
          attestorRegistryInput.creationCodeKeccak256,
          "destination.inbox.defaultVoteValidator.attestorRegistry.creationCodeKeccak256",
        ),
        owner: address(
          attestorRegistryInput.owner,
          "destination.inbox.defaultVoteValidator.attestorRegistry.owner",
        ),
        authorizedUpdaters: nonemptyAddressList(
          attestorRegistryInput.authorizedUpdaters,
          "destination.inbox.defaultVoteValidator.attestorRegistry.authorizedUpdaters",
        ),
      },
      minAttestorCount: positiveInteger(
        voteValidatorInput.minAttestorCount,
        "destination.inbox.defaultVoteValidator.minAttestorCount",
      ),
      thresholdNumerator: integer(
        voteValidatorInput.thresholdNumerator,
        "destination.inbox.defaultVoteValidator.thresholdNumerator",
        30,
      ),
      thresholdAddition: integer(
        voteValidatorInput.thresholdAddition,
        "destination.inbox.defaultVoteValidator.thresholdAddition",
      ),
      attestorSetUpdateNonce: integer(
        voteValidatorInput.attestorSetUpdateNonce,
        "destination.inbox.defaultVoteValidator.attestorSetUpdateNonce",
      ),
      attestors: addressList(
        voteValidatorInput.attestors,
        "destination.inbox.defaultVoteValidator.attestors",
      ),
    },
    paused: inboxInput.paused,
  };
  const expectedInboxLocalChainKey = zeroPadValue(
    toBeHex(destinationChainKey),
    32,
  ).toLowerCase();
  if (inbox.localChainKey !== expectedInboxLocalChainKey) {
    throw new Error(
      "destination.inbox.localChainKey must equal the zero-padded destination.uscChainKey",
    );
  }
  sameAddress(
    inbox.expectedAddress,
    predictedInbox,
    "Dedicated Inbox expected address",
  );
  if (inbox.paused !== false) {
    throw new Error("destination.inbox.paused must explicitly be false");
  }
  if (inbox.defaultVoteValidator.validatorType !== "eoa") {
    throw new Error(
      "destination.inbox.defaultVoteValidator.validatorType must be eoa",
    );
  }
  if (inbox.defaultVoteValidator.minAttestorCount < 3) {
    throw new Error(
      "destination.inbox.defaultVoteValidator.minAttestorCount must be at least 3",
    );
  }
  const configuredFractionalThreshold =
    Math.floor(
      (inbox.defaultVoteValidator.attestors.length *
        inbox.defaultVoteValidator.thresholdNumerator) /
        30,
    ) + inbox.defaultVoteValidator.thresholdAddition;
  if (configuredFractionalThreshold === 0) {
    throw new Error("Inbox vote-validator threshold must be nonzero");
  }
  const voteThreshold = Math.max(
    configuredFractionalThreshold,
    inbox.defaultVoteValidator.minAttestorCount,
  );
  if (voteThreshold > inbox.defaultVoteValidator.attestors.length) {
    throw new Error("Inbox vote-validator threshold is unreachable");
  }
  if (inbox.dedicatedToRecourse !== true) {
    throw new Error(
      "destination.inbox.dedicatedToRecourse must explicitly be true",
    );
  }
  if (outbox.validator.dedicatedToRecourse !== true) {
    throw new Error(
      "source.outbox.validator.dedicatedToRecourse must explicitly be true",
    );
  }
  if (
    outbox.validator.trustedInboxes.length !== 1 ||
    outbox.validator.trustedInboxes[0] !== inbox.expectedAddress
  ) {
    throw new Error(
      "AcknowledgementValidator trustedInboxes must be exactly the dedicated Inbox",
    );
  }
  if (
    inbox.defaultVoteValidator.attestorRegistry.dedicatedToRecourse !== true
  ) {
    throw new Error(
      "Inbox attestor registry dedicatedToRecourse must explicitly be true",
    );
  }
  if (
    inbox.defaultVoteValidator.attestorRegistry.authorizedUpdaters.length !==
      1 ||
    inbox.defaultVoteValidator.attestorRegistry.authorizedUpdaters[0] !==
      inbox.defaultVoteValidator.address
  ) {
    throw new Error(
      "Inbox attestor registry authorizedUpdaters must contain exactly the vote validator",
    );
  }
  if (inbox.creditcoinChainId !== BigInt(sourceChainId)) {
    throw new Error(
      "destination.inbox.creditcoinChainId must match source.chainId",
    );
  }
  if (destinationChainKey !== outbox.chainKey) {
    throw new Error(
      "destination.uscChainKey must match source.outbox.chainKey",
    );
  }
  if (
    outbox.validator.destinationChainKey !== destinationChainKey ||
    outbox.validator.outbox !== outbox.address ||
    outbox.validator.attestToken !== outbox.attestToken.address ||
    outbox.validator.trustedInboxes[0] !== inbox.expectedAddress
  ) {
    throw new Error(
      "AcknowledgementValidator evidence must bind the exact Outbox, destination chain, ATTEST token, and dedicated Inbox",
    );
  }
  const artifactInput = object(config.artifacts, "artifacts");
  const artifacts = Object.fromEntries(
    USC_REMEDY_ARTIFACTS.map((name) => {
      const value = object(artifactInput[name], `artifacts.${name}`);
      if (typeof value.path !== "string" || value.path.length === 0) {
        throw new Error(`artifacts.${name}.path must be nonempty`);
      }
      return [
        name,
        {
          path: value.path,
          keccak256: digest(value.keccak256, `artifacts.${name}.keccak256`),
        },
      ];
    }),
  );
  const transactionPolicy = object(
    config.transactionPolicy,
    "transactionPolicy",
  );
  const normalized = {
    schemaVersion: 1,
    generation: USC_REMEDY_GENERATION,
    uscContractsVersion: USC_CONTRACTS_VERSION,
    exclusiveSigners: true,
    source: {
      chainId: sourceChainId,
      rpcUrlEnvironment: environmentName(
        sourceInput.rpcUrlEnvironment,
        "source.rpcUrlEnvironment",
      ),
      privateKeyEnvironment: environmentName(
        sourceInput.privateKeyEnvironment,
        "source.privateKeyEnvironment",
      ),
      deployer: sourceDeployer,
      expectedStartingNonce: sourceStartingNonce,
      context: dependency(sourceInput.context, "source.context"),
      outbox,
    },
    destination: {
      chainId: destinationChainId,
      uscChainKey: destinationChainKey,
      localChainKey: inbox.localChainKey,
      rpcUrlEnvironment: environmentName(
        destinationInput.rpcUrlEnvironment,
        "destination.rpcUrlEnvironment",
      ),
      privateKeyEnvironment: environmentName(
        destinationInput.privateKeyEnvironment,
        "destination.privateKeyEnvironment",
      ),
      deployer: destinationDeployer,
      expectedStartingNonce: destinationStartingNonce,
      guardian: address(destinationInput.guardian, "destination.guardian"),
      inbox,
    },
    artifacts,
    transactionPolicy: {
      sourceConfirmations: positiveInteger(
        transactionPolicy.sourceConfirmations,
        "transactionPolicy.sourceConfirmations",
        256,
      ),
      destinationConfirmations: positiveInteger(
        transactionPolicy.destinationConfirmations,
        "transactionPolicy.destinationConfirmations",
        256,
      ),
      maximumReceiptPolls: positiveInteger(
        transactionPolicy.maximumReceiptPolls,
        "transactionPolicy.maximumReceiptPolls",
        10_000,
      ),
      sourceFeePolicy: transactionFeePolicy(
        transactionPolicy.sourceFeePolicy,
        "transactionPolicy.sourceFeePolicy",
      ),
      destinationFeePolicy: transactionFeePolicy(
        transactionPolicy.destinationFeePolicy,
        "transactionPolicy.destinationFeePolicy",
      ),
    },
  };
  if (
    normalized.transactionPolicy.maximumReceiptPolls <
    Math.max(
      normalized.transactionPolicy.sourceConfirmations,
      normalized.transactionPolicy.destinationConfirmations,
    )
  ) {
    throw new Error("Maximum receipt polls must cover confirmation depth");
  }
  normalized.configCommitment = commitment(normalized);
  return normalized;
}

export function readUscRemedyArtifacts(config, rootDirectory = process.cwd()) {
  return Object.fromEntries(
    USC_REMEDY_ARTIFACTS.map((name) => {
      const path = resolve(rootDirectory, config.artifacts[name].path);
      const raw = readFileSync(path);
      const hash = keccak256(raw);
      if (hash !== config.artifacts[name].keccak256) {
        throw new Error(`${name} artifact hash mismatch`);
      }
      const artifact = JSON.parse(raw.toString("utf8"));
      if (
        !Array.isArray(artifact.abi) ||
        !isHexString(artifact.bytecode?.object) ||
        artifact.bytecode.object === "0x"
      ) {
        throw new Error(`${name} artifact is missing ABI or creation bytecode`);
      }
      const constructor = artifact.abi.find(
        ({ type }) => type === "constructor",
      );
      const actualTypes = (constructor?.inputs ?? []).map(({ type }) => type);
      if (
        actualTypes.length !== EXPECTED_CONSTRUCTORS[name].length ||
        actualTypes.some(
          (type, index) => type !== EXPECTED_CONSTRUCTORS[name][index],
        )
      ) {
        throw new Error(`${name} constructor ABI mismatch`);
      }
      return [name, { artifact, hash, path }];
    }),
  );
}

export async function buildUscRemedyDeploymentPlan({
  config,
  artifacts,
  repositoryState,
}) {
  const sourceTransport = getCreateAddress({
    from: config.source.deployer,
    nonce: config.source.expectedStartingNonce,
  });
  const sourceCoordinator = getCreateAddress({
    from: config.source.deployer,
    nonce: config.source.expectedStartingNonce + 1,
  });
  const destinationReceiver = getCreateAddress({
    from: config.destination.deployer,
    nonce: config.destination.expectedStartingNonce,
  });
  const destinationDispatcher = getCreateAddress({
    from: config.destination.deployer,
    nonce: config.destination.expectedStartingNonce + 1,
  });
  const destinationInbox = getCreateAddress({
    from: config.destination.deployer,
    nonce: config.destination.expectedStartingNonce + 2,
  });
  sameAddress(
    config.destination.inbox.expectedAddress,
    destinationInbox,
    "Dedicated Inbox expected address",
  );
  const constructors = {
    UscRemedyTransportV1: [
      sourceCoordinator,
      config.source.outbox.address,
      config.source.outbox.attestToken.address,
      config.destination.uscChainKey,
      destinationReceiver,
      config.source.outbox.maximumCoreFee,
    ],
    RemedyCoordinatorV1: [config.source.context.address, sourceTransport],
    BoundedRemedyReceiverV1: [
      destinationDispatcher,
      config.destination.guardian,
    ],
    UscRemedyDispatcherV1: [
      destinationInbox,
      config.source.chainId,
      sourceTransport,
      sourceCoordinator,
      destinationReceiver,
    ],
    Inbox020: [
      config.destination.localChainKey,
      config.source.chainId,
      config.destination.inbox.defaultVoteValidator.address,
      destinationDispatcher,
      config.destination.inbox.owner,
    ],
  };
  const deployments = {};
  for (const name of USC_REMEDY_ARTIFACTS) {
    const factory = new ContractFactory(
      artifacts[name].artifact.abi,
      artifacts[name].artifact.bytecode.object,
    );
    const request = await factory.getDeployTransaction(...constructors[name]);
    if (!request.data || request.data === "0x") {
      throw new Error(`${name} deployment transaction is empty`);
    }
    deployments[name] = request.data;
  }
  const steps = [
    {
      name: "deployTransport",
      network: "source",
      chainId: config.source.chainId,
      nonce: config.source.expectedStartingNonce,
      from: config.source.deployer,
      to: null,
      predictedContract: sourceTransport,
      data: deployments.UscRemedyTransportV1,
      value: "0",
    },
    {
      name: "deployCoordinator",
      network: "source",
      chainId: config.source.chainId,
      nonce: config.source.expectedStartingNonce + 1,
      from: config.source.deployer,
      to: null,
      predictedContract: sourceCoordinator,
      data: deployments.RemedyCoordinatorV1,
      value: "0",
    },
    {
      name: "deployReceiver",
      network: "destination",
      chainId: config.destination.chainId,
      nonce: config.destination.expectedStartingNonce,
      from: config.destination.deployer,
      to: null,
      predictedContract: destinationReceiver,
      data: deployments.BoundedRemedyReceiverV1,
      value: "0",
    },
    {
      name: "deployDispatcher",
      network: "destination",
      chainId: config.destination.chainId,
      nonce: config.destination.expectedStartingNonce + 1,
      from: config.destination.deployer,
      to: null,
      predictedContract: destinationDispatcher,
      data: deployments.UscRemedyDispatcherV1,
      value: "0",
    },
    {
      name: "deployInbox",
      network: "destination",
      chainId: config.destination.chainId,
      nonce: config.destination.expectedStartingNonce + 2,
      from: config.destination.deployer,
      to: null,
      predictedContract: destinationInbox,
      data: deployments.Inbox020,
      value: "0",
    },
  ].map((step) => ({ ...step, dataHash: keccak256(step.data) }));
  const plan = {
    schemaVersion: 1,
    generation: USC_REMEDY_GENERATION,
    ...(repositoryState
      ? {
          sourceCommit: sourceCommit(repositoryState.head),
          deployableScopeClean: repositoryState.deployableScopeClean === true,
        }
      : {}),
    configCommitment: config.configCommitment,
    uscContractsVersion: USC_CONTRACTS_VERSION,
    predictedContracts: {
      transport: sourceTransport,
      coordinator: sourceCoordinator,
      receiver: destinationReceiver,
      dispatcher: destinationDispatcher,
      inbox: destinationInbox,
    },
    artifactHashes: Object.fromEntries(
      USC_REMEDY_ARTIFACTS.map((name) => [name, artifacts[name].hash]),
    ),
    steps,
  };
  plan.planCommitment = commitment(plan);
  return plan;
}

function uscStepFeePolicy(config, step) {
  return step.network === "source"
    ? config.transactionPolicy.sourceFeePolicy
    : config.transactionPolicy.destinationFeePolicy;
}

export async function buildUscRemedyLiveExecutionPlan({
  config,
  plan,
  signers,
}) {
  const steps = [];
  for (const step of plan.steps) {
    const signer = signers[step.network];
    if (!signer) throw new Error(`${step.name} signer is unavailable`);
    sameAddress(await signer.getAddress(), step.from, `${step.name} signer`);
    const feePolicy = uscStepFeePolicy(config, step);
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
      BigInt(populated.value ?? 0) !== BigInt(step.value)
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
    sourceFeePolicy: transactionFeePolicyRecord(
      config.transactionPolicy.sourceFeePolicy,
    ),
    destinationFeePolicy: transactionFeePolicyRecord(
      config.transactionPolicy.destinationFeePolicy,
    ),
    steps,
  };
  executionPlan.commitment = commitment(executionPlan);
  return executionPlan;
}

export function validateUscRemedyLiveExecutionPlan({
  config,
  plan,
  executionPlan,
}) {
  if (
    executionPlan?.schemaVersion !== 1 ||
    !Array.isArray(executionPlan.steps) ||
    executionPlan.steps.length !== plan.steps.length
  ) {
    throw new Error("Invalid USC remedy live execution plan");
  }
  if (
    JSON.stringify(executionPlan.sourceFeePolicy) !==
      JSON.stringify(
        transactionFeePolicyRecord(config.transactionPolicy.sourceFeePolicy),
      ) ||
    JSON.stringify(executionPlan.destinationFeePolicy) !==
      JSON.stringify(
        transactionFeePolicyRecord(
          config.transactionPolicy.destinationFeePolicy,
        ),
      )
  ) {
    throw new Error("USC remedy live execution fee policy mismatch");
  }
  const expectedCommitment = commitment(
    Object.fromEntries(
      Object.entries(executionPlan).filter(([key]) => key !== "commitment"),
    ),
  );
  if (executionPlan.commitment !== expectedCommitment) {
    throw new Error("USC remedy live execution plan commitment mismatch");
  }
  for (let index = 0; index < plan.steps.length; index += 1) {
    const planned = plan.steps[index];
    const approved = executionPlan.steps[index];
    const baseFields = [
      "name",
      "network",
      "chainId",
      "nonce",
      "from",
      "to",
      "predictedContract",
      "data",
      "dataHash",
      "value",
    ];
    if (baseFields.some((field) => approved?.[field] !== planned[field])) {
      throw new Error(`${planned.name} approved transaction changed its plan`);
    }
    const normalizedFees = transactionFeeFields(
      approved,
      uscStepFeePolicy(config, planned),
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

async function assertCode(provider, expected, label, blockTag) {
  const code = await provider.getCode(expected.address, blockTag);
  if (!isHexString(code) || code === "0x")
    throw new Error(`${label} has no bytecode`);
  const hash = keccak256(code);
  if (hash !== expected.runtimeCodeKeccak256) {
    throw new Error(`${label} runtime bytecode hash mismatch`);
  }
  return hash;
}

async function assertNoCode(provider, addressValue, label, blockTag) {
  const code = await provider.getCode(addressValue, blockTag);
  if (!isHexString(code))
    throw new Error(`${label} bytecode response is invalid`);
  if (code !== "0x") throw new Error(`${label} already has bytecode`);
  return "precomputed-no-code";
}

async function readCodeHash(provider, addressValue, label, blockTag) {
  const code = await provider.getCode(addressValue, blockTag);
  if (!isHexString(code) || code === "0x") {
    throw new Error(`${label} has no bytecode`);
  }
  return keccak256(code);
}

function deploymentProgressByName(deploymentProgress, plan) {
  if (deploymentProgress === undefined) return undefined;
  if (
    !Array.isArray(deploymentProgress) ||
    deploymentProgress.length !== plan.steps.length
  ) {
    throw new Error("USC deployment progress does not match the plan");
  }
  return new Map(
    deploymentProgress.map((step, index) => {
      const planned = plan.steps[index];
      if (
        step?.name !== planned.name ||
        step.network !== planned.network ||
        step.chainId !== planned.chainId ||
        step.nonce !== planned.nonce ||
        step.from !== planned.from ||
        step.to !== planned.to ||
        step.predictedContract !== planned.predictedContract ||
        step.dataHash !== planned.dataHash ||
        !["planned", "prepared", "confirmed"].includes(step.status)
      ) {
        throw new Error("USC deployment progress does not match the plan");
      }
      return [step.name, step.status];
    }),
  );
}

function assertProgressNonce({
  network,
  actualNonce,
  startingNonce,
  progress,
  plan,
}) {
  const steps = plan.steps.filter((step) => step.network === network);
  const confirmedCount = steps.filter(
    ({ name }) => progress.get(name) === "confirmed",
  ).length;
  const preparedCount = steps.filter(
    ({ name }) => progress.get(name) === "prepared",
  ).length;
  const minimum = startingNonce + confirmedCount;
  const maximum = minimum + preparedCount;
  if (actualNonce < minimum || actualNonce > maximum) {
    throw new Error(
      `${network} deployer pending nonce is inconsistent with the deployment journal`,
    );
  }
}

export function decodeOutbox020Constructor(transactionData) {
  if (!isHexString(transactionData)) {
    throw new Error("Outbox deployment transaction data is invalid");
  }
  const argumentBytes = OUTBOX_CONSTRUCTOR_TYPES.length * 32;
  if ((transactionData.length - 2) / 2 <= argumentBytes) {
    throw new Error(
      "Outbox deployment transaction is missing creation bytecode",
    );
  }
  const encodedArguments = `0x${transactionData.slice(-argumentBytes * 2)}`;
  const decoded = ABI.decode(OUTBOX_CONSTRUCTOR_TYPES, encodedArguments);
  return {
    chainKey: Number(decoded[0]),
    owner: getAddress(decoded[1]),
    validator: getAddress(decoded[2]),
    defaultRateLimit: BigInt(decoded[3]),
    attestorVault: getAddress(decoded[4]),
    feeRegistry: getAddress(decoded[5]),
    attestToken: getAddress(decoded[6]),
  };
}

export function decodeInbox020Constructor(transactionData) {
  if (!isHexString(transactionData)) {
    throw new Error("Inbox deployment transaction data is invalid");
  }
  const argumentBytes = INBOX_CONSTRUCTOR_TYPES.length * 32;
  if ((transactionData.length - 2) / 2 <= argumentBytes) {
    throw new Error(
      "Inbox deployment transaction is missing creation bytecode",
    );
  }
  const encodedArguments = `0x${transactionData.slice(-argumentBytes * 2)}`;
  const decoded = ABI.decode(INBOX_CONSTRUCTOR_TYPES, encodedArguments);
  return {
    localChainKey: decoded[0].toLowerCase(),
    creditcoinChainId: BigInt(decoded[1]),
    defaultVoteValidator: getAddress(decoded[2]),
    messageDispatcher: getAddress(decoded[3]),
    owner: getAddress(decoded[4]),
  };
}

function encodedConstructorSuffix(
  transactionData,
  constructorTypes,
  values,
  label,
) {
  if (!isHexString(transactionData)) {
    throw new Error(`${label} deployment transaction data is invalid`);
  }
  const encodedArguments = ABI.encode(constructorTypes, values).toLowerCase();
  if (
    transactionData.length <= encodedArguments.length ||
    !transactionData.toLowerCase().endsWith(encodedArguments.slice(2))
  ) {
    throw new Error(`${label} constructor arguments mismatch`);
  }
  return {
    encodedArguments,
    creationCode: `0x${transactionData.slice(
      2,
      transactionData.length - (encodedArguments.length - 2),
    )}`,
  };
}

async function verifyCanonicalContractDeployment({
  provider,
  transactionHash,
  expectedAddress,
  constructorTypes,
  constructorValues,
  creationCodeKeccak256,
  label,
}) {
  const [transaction, receipt] = await Promise.all([
    provider.getTransaction(transactionHash),
    provider.getTransactionReceipt(transactionHash),
  ]);
  if (
    !transaction ||
    transaction.hash?.toLowerCase() !== transactionHash ||
    transaction.to !== null ||
    !Number.isSafeInteger(transaction.nonce) ||
    !transaction.from ||
    !receipt ||
    receipt.hash?.toLowerCase() !== transactionHash ||
    receipt.status !== 1 ||
    !receipt.contractAddress ||
    getAddress(receipt.contractAddress) !== expectedAddress ||
    getCreateAddress({
      from: getAddress(transaction.from),
      nonce: transaction.nonce,
    }) !== expectedAddress
  ) {
    throw new Error(`${label} deployment evidence is inconsistent`);
  }
  if (
    !Number.isSafeInteger(receipt.blockNumber) ||
    !isHexString(receipt.blockHash, 32)
  ) {
    throw new Error(
      `${label} deployment receipt lacks a canonical block identity`,
    );
  }
  const deploymentBlock = await provider.getBlock(receipt.blockNumber);
  if (
    !deploymentBlock?.hash ||
    deploymentBlock.hash.toLowerCase() !== receipt.blockHash.toLowerCase()
  ) {
    throw new Error(`${label} deployment receipt is no longer canonical`);
  }
  const { creationCode } = encodedConstructorSuffix(
    transaction.data,
    constructorTypes,
    constructorValues,
    label,
  );
  if (keccak256(creationCode) !== creationCodeKeccak256) {
    throw new Error(`${label} creation bytecode hash mismatch`);
  }
  return {
    transactionHash,
    deployer: getAddress(transaction.from),
    nonce: transaction.nonce,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash.toLowerCase(),
    creationCodeKeccak256,
  };
}

async function reconstructBooleanEventSet({
  provider,
  contractAddress,
  abi,
  eventName,
  keyArgument,
  valueArgument,
  fromBlock,
  toBlock,
  label,
}) {
  if (
    !Number.isSafeInteger(fromBlock) ||
    !Number.isSafeInteger(toBlock) ||
    fromBlock < 0 ||
    toBlock < fromBlock
  ) {
    throw new Error(`${label} event-history range is invalid`);
  }
  const contractInterface = new Interface(abi);
  const event = contractInterface.getEvent(eventName);
  const logs = [];
  for (
    let start = fromBlock;
    start <= toBlock;
    start += EVENT_HISTORY_BLOCK_RANGE
  ) {
    const end = Math.min(toBlock, start + EVENT_HISTORY_BLOCK_RANGE - 1);
    logs.push(
      ...(await provider.getLogs({
        address: contractAddress,
        topics: [event.topicHash],
        fromBlock: start,
        toBlock: end,
      })),
    );
  }
  logs.sort(
    (left, right) =>
      left.blockNumber - right.blockNumber ||
      left.transactionIndex - right.transactionIndex ||
      left.index - right.index,
  );
  const active = new Set();
  for (const log of logs) {
    if (
      log.removed === true ||
      getAddress(log.address) !== contractAddress ||
      !Number.isSafeInteger(log.blockNumber) ||
      !Number.isSafeInteger(log.transactionIndex) ||
      !Number.isSafeInteger(log.index)
    ) {
      throw new Error(`${label} event history is invalid`);
    }
    const parsed = contractInterface.parseLog(log);
    if (!parsed || parsed.name !== eventName) {
      throw new Error(`${label} event history is invalid`);
    }
    const key = getAddress(parsed.args[keyArgument]);
    if (parsed.args[valueArgument] === true) active.add(key);
    else active.delete(key);
  }
  return [...active].sort();
}

function storageAddress(value, label) {
  if (!isHexString(value, 32)) {
    throw new Error(`${label} storage value is invalid`);
  }
  return getAddress(`0x${value.slice(-40)}`);
}

export async function qualifyUscRemedyDependencies({
  config,
  plan,
  sourceProvider,
  destinationProvider,
  deploymentComplete = false,
  deploymentProgress,
  contractFactory = (addressValue, abi, provider) =>
    new Contract(addressValue, abi, provider),
  repositoryState,
}) {
  if (plan.sourceCommit !== undefined) {
    const sourceState = requireCleanDeployableRepository(repositoryState);
    if (sourceState.head !== plan.sourceCommit) {
      throw new Error("USC remedy deployment source commit changed");
    }
  }
  if (deploymentComplete && deploymentProgress !== undefined) {
    throw new Error(
      "Completed deployment qualification cannot use partial progress",
    );
  }
  const progress = deploymentProgressByName(deploymentProgress, plan);
  const [sourceNetwork, destinationNetwork] = await Promise.all([
    sourceProvider.getNetwork(),
    destinationProvider.getNetwork(),
  ]);
  if (sourceNetwork.chainId !== BigInt(config.source.chainId)) {
    throw new Error("Source RPC chain identity mismatch");
  }
  if (destinationNetwork.chainId !== BigInt(config.destination.chainId)) {
    throw new Error("Destination RPC chain identity mismatch");
  }
  const [sourceNonce, destinationNonce, sourceBlock, destinationBlock] =
    await Promise.all([
      sourceProvider.getTransactionCount(config.source.deployer, "pending"),
      destinationProvider.getTransactionCount(
        config.destination.deployer,
        "pending",
      ),
      sourceProvider.getBlock("latest"),
      destinationProvider.getBlock("latest"),
    ]);
  if (
    !Number.isSafeInteger(sourceBlock?.number) ||
    !isHexString(sourceBlock?.hash, 32) ||
    !Number.isSafeInteger(sourceBlock?.timestamp) ||
    !Number.isSafeInteger(destinationBlock?.number) ||
    !isHexString(destinationBlock?.hash, 32) ||
    !Number.isSafeInteger(destinationBlock?.timestamp)
  ) {
    throw new Error("Live qualification block anchors are unavailable");
  }
  if (!deploymentComplete) {
    if (progress) {
      assertProgressNonce({
        network: "source",
        actualNonce: sourceNonce,
        startingNonce: config.source.expectedStartingNonce,
        progress,
        plan,
      });
      assertProgressNonce({
        network: "destination",
        actualNonce: destinationNonce,
        startingNonce: config.destination.expectedStartingNonce,
        progress,
        plan,
      });
    } else {
      if (sourceNonce !== config.source.expectedStartingNonce) {
        throw new Error("Source deployer pending nonce differs from the plan");
      }
      if (destinationNonce !== config.destination.expectedStartingNonce) {
        throw new Error(
          "Destination deployer pending nonce differs from the plan",
        );
      }
    }
  }
  sameAddress(
    plan.predictedContracts.inbox,
    config.destination.inbox.expectedAddress,
    "Dedicated Inbox planned address",
  );
  const [
    sourceContextCodeHash,
    outboxCodeHash,
    outboxValidatorCodeHash,
    acknowledgementProofVerifierCodeHash,
    attestorVaultCodeHash,
    feeRegistryCodeHash,
    attestTokenCodeHash,
    inboxValidatorCodeHash,
    attestorRegistryCodeHash,
  ] = await Promise.all([
    assertCode(
      sourceProvider,
      config.source.context,
      "Source context",
      sourceBlock.number,
    ),
    assertCode(
      sourceProvider,
      config.source.outbox,
      "USC Outbox",
      sourceBlock.number,
    ),
    assertCode(
      sourceProvider,
      config.source.outbox.validator,
      "Outbox validator",
      sourceBlock.number,
    ),
    assertCode(
      sourceProvider,
      config.source.outbox.validator.proofVerifier,
      "AcknowledgementValidator proof verifier",
      sourceBlock.number,
    ),
    assertCode(
      sourceProvider,
      config.source.outbox.attestorVault,
      "Outbox attestor vault",
      sourceBlock.number,
    ),
    assertCode(
      sourceProvider,
      config.source.outbox.feeRegistry,
      "Outbox fee registry",
      sourceBlock.number,
    ),
    assertCode(
      sourceProvider,
      config.source.outbox.attestToken,
      "Outbox ATTEST token",
      sourceBlock.number,
    ),
    assertCode(
      destinationProvider,
      config.destination.inbox.defaultVoteValidator,
      "Inbox vote validator",
      destinationBlock.number,
    ),
    assertCode(
      destinationProvider,
      config.destination.inbox.defaultVoteValidator.attestorRegistry,
      "Inbox attestor registry",
      destinationBlock.number,
    ),
  ]);
  const routeCodeEntries = [
    [
      "transport",
      "deployTransport",
      sourceProvider,
      plan.predictedContracts.transport,
      "Predicted transport",
    ],
    [
      "coordinator",
      "deployCoordinator",
      sourceProvider,
      plan.predictedContracts.coordinator,
      "Predicted coordinator",
    ],
    [
      "receiver",
      "deployReceiver",
      destinationProvider,
      plan.predictedContracts.receiver,
      "Predicted receiver",
    ],
    [
      "dispatcher",
      "deployDispatcher",
      destinationProvider,
      plan.predictedContracts.dispatcher,
      "Predicted dispatcher",
    ],
    [
      "inbox",
      "deployInbox",
      destinationProvider,
      plan.predictedContracts.inbox,
      "Predicted dedicated Inbox",
    ],
  ];
  const routeCodeHashes = Object.fromEntries(
    await Promise.all(
      routeCodeEntries.map(
        async ([name, stepName, provider, addressValue, label]) => {
          const status = progress?.get(stepName) ?? "planned";
          if (deploymentComplete || status === "confirmed") {
            const blockTag =
              provider === sourceProvider
                ? sourceBlock.number
                : destinationBlock.number;
            return [
              name,
              await readCodeHash(provider, addressValue, label, blockTag),
            ];
          }
          if (status === "planned") {
            const blockTag =
              provider === sourceProvider
                ? sourceBlock.number
                : destinationBlock.number;
            return [
              name,
              await assertNoCode(provider, addressValue, label, blockTag),
            ];
          }
          const blockTag =
            provider === sourceProvider
              ? sourceBlock.number
              : destinationBlock.number;
          const code = await provider.getCode(addressValue, blockTag);
          if (!isHexString(code)) {
            throw new Error(`${label} bytecode response is invalid`);
          }
          return [name, code === "0x" ? "prepared-no-code" : keccak256(code)];
        },
      ),
    ),
  );
  const dependencies = {
    sourceContext: sourceContextCodeHash,
    outbox: outboxCodeHash,
    outboxValidator: outboxValidatorCodeHash,
    acknowledgementProofVerifier: acknowledgementProofVerifierCodeHash,
    attestorVault: attestorVaultCodeHash,
    feeRegistry: feeRegistryCodeHash,
    attestToken: attestTokenCodeHash,
    inboxValidator: inboxValidatorCodeHash,
    attestorRegistry: attestorRegistryCodeHash,
    plannedRoute: routeCodeHashes,
  };
  const outbox = contractFactory(
    config.source.outbox.address,
    USC_OUTBOX_ABI,
    sourceProvider,
  );
  const acknowledgementValidator = contractFactory(
    config.source.outbox.validator.address,
    USC_ACKNOWLEDGEMENT_VALIDATOR_ABI,
    sourceProvider,
  );
  const voteValidator = contractFactory(
    config.destination.inbox.defaultVoteValidator.address,
    USC_EOA_VOTE_VALIDATOR_ABI,
    destinationProvider,
  );
  const attestorRegistry = contractFactory(
    config.destination.inbox.defaultVoteValidator.attestorRegistry.address,
    USC_ATTESTOR_REGISTRY_ABI,
    destinationProvider,
  );
  const [
    outboxChainKey,
    coreFee,
    feeRegistry,
    defaultRateLimit,
    outboxValidator,
    outboxOwner,
    outboxPendingOwner,
    outboxPaused,
    outboxAttestorVaultStorage,
    outboxAttestTokenStorage,
    outboxFeeRegistryStorage,
    acknowledgementDestinationChainKey,
    acknowledgementOutbox,
    acknowledgementProofVerifier,
    acknowledgementAttestToken,
    acknowledgementTrustedInbox,
    acknowledgementOwner,
    acknowledgementPendingOwner,
    voteValidatorType,
    voteValidatorOwner,
    voteValidatorPendingOwner,
    voteAttestorRegistry,
    voteMinAttestorCount,
    voteThresholdNumerator,
    voteThresholdAddition,
    voteAttestorSetUpdateNonce,
    voteAttestors,
    voteThreshold,
    registryOwner,
    registryPendingOwner,
    registryUpdaterAuthorizations,
    registryAttestors,
  ] = await Promise.all([
    outbox.chainKey({ blockTag: sourceBlock.number }),
    outbox.coreFee({ blockTag: sourceBlock.number }),
    outbox.feeRegistry({ blockTag: sourceBlock.number }),
    outbox.defaultRateLimit({ blockTag: sourceBlock.number }),
    outbox.validator({ blockTag: sourceBlock.number }),
    outbox.owner({ blockTag: sourceBlock.number }),
    outbox.pendingOwner({ blockTag: sourceBlock.number }),
    outbox.paused({ blockTag: sourceBlock.number }),
    sourceProvider.getStorage(
      config.source.outbox.address,
      OUTBOX_ATTESTOR_VAULT_SLOT,
      sourceBlock.number,
    ),
    sourceProvider.getStorage(
      config.source.outbox.address,
      OUTBOX_ATTEST_TOKEN_SLOT,
      sourceBlock.number,
    ),
    sourceProvider.getStorage(
      config.source.outbox.address,
      OUTBOX_FEE_REGISTRY_SLOT,
      sourceBlock.number,
    ),
    acknowledgementValidator.destinationChainKey({
      blockTag: sourceBlock.number,
    }),
    acknowledgementValidator.outbox({ blockTag: sourceBlock.number }),
    acknowledgementValidator.proofVerifier({ blockTag: sourceBlock.number }),
    acknowledgementValidator.attestToken({ blockTag: sourceBlock.number }),
    acknowledgementValidator.trustedInboxes(plan.predictedContracts.inbox, {
      blockTag: sourceBlock.number,
    }),
    acknowledgementValidator.owner({ blockTag: sourceBlock.number }),
    acknowledgementValidator.pendingOwner({ blockTag: sourceBlock.number }),
    voteValidator.validatorType({ blockTag: destinationBlock.number }),
    voteValidator.owner({ blockTag: destinationBlock.number }),
    voteValidator.pendingOwner({ blockTag: destinationBlock.number }),
    voteValidator.attestorRegistry({ blockTag: destinationBlock.number }),
    voteValidator.minAttestorCount({ blockTag: destinationBlock.number }),
    voteValidator.thresholdNumerator({ blockTag: destinationBlock.number }),
    voteValidator.thresholdAddition({ blockTag: destinationBlock.number }),
    voteValidator.attestorSetUpdateNonce({ blockTag: destinationBlock.number }),
    voteValidator.attestors({ blockTag: destinationBlock.number }),
    voteValidator.threshold({ blockTag: destinationBlock.number }),
    attestorRegistry.owner({ blockTag: destinationBlock.number }),
    attestorRegistry.pendingOwner({ blockTag: destinationBlock.number }),
    Promise.all(
      config.destination.inbox.defaultVoteValidator.attestorRegistry.authorizedUpdaters.map(
        (updater) =>
          attestorRegistry.isUpdater(updater, {
            blockTag: destinationBlock.number,
          }),
      ),
    ),
    attestorRegistry.attestors({ blockTag: destinationBlock.number }),
  ]);
  exactValue(outboxChainKey, config.source.outbox.chainKey, "Outbox chain key");
  if (BigInt(coreFee) > config.source.outbox.maximumCoreFee) {
    throw new Error("Outbox core fee exceeds the configured maximum");
  }
  sameAddress(
    feeRegistry,
    config.source.outbox.feeRegistry.address,
    "Outbox fee registry",
  );
  exactValue(
    defaultRateLimit,
    config.source.outbox.defaultRateLimit,
    "Outbox rate limit",
  );
  sameAddress(
    outboxValidator,
    config.source.outbox.validator.address,
    "Outbox validator",
  );
  sameAddress(outboxOwner, config.source.outbox.owner, "Outbox owner");
  sameAddress(outboxPendingOwner, ZeroAddress, "Outbox pending owner");
  if (outboxPaused !== false) throw new Error("Outbox is paused");
  sameAddress(
    storageAddress(outboxAttestorVaultStorage, "Outbox attestor vault"),
    config.source.outbox.attestorVault.address,
    "Outbox current attestor vault",
  );
  sameAddress(
    storageAddress(outboxAttestTokenStorage, "Outbox ATTEST token"),
    config.source.outbox.attestToken.address,
    "Outbox current ATTEST token",
  );
  sameAddress(
    storageAddress(outboxFeeRegistryStorage, "Outbox fee registry"),
    config.source.outbox.feeRegistry.address,
    "Outbox current fee registry",
  );
  exactValue(
    acknowledgementDestinationChainKey,
    config.source.outbox.validator.destinationChainKey,
    "AcknowledgementValidator destination chain key",
  );
  sameAddress(
    acknowledgementOutbox,
    config.source.outbox.validator.outbox,
    "AcknowledgementValidator Outbox",
  );
  sameAddress(
    acknowledgementProofVerifier,
    config.source.outbox.validator.proofVerifier.address,
    "AcknowledgementValidator proof verifier",
  );
  sameAddress(
    acknowledgementAttestToken,
    config.source.outbox.validator.attestToken,
    "AcknowledgementValidator ATTEST token",
  );
  if (acknowledgementTrustedInbox !== true) {
    throw new Error(
      "AcknowledgementValidator does not trust the dedicated Inbox",
    );
  }
  sameAddress(
    acknowledgementOwner,
    config.source.outbox.validator.owner,
    "AcknowledgementValidator owner",
  );
  sameAddress(
    acknowledgementPendingOwner,
    ZeroAddress,
    "AcknowledgementValidator pending owner",
  );
  if (
    voteValidatorType !==
    config.destination.inbox.defaultVoteValidator.validatorType
  ) {
    throw new Error("Inbox vote-validator type mismatch");
  }
  sameAddress(
    voteValidatorOwner,
    config.destination.inbox.defaultVoteValidator.owner,
    "Inbox vote-validator owner",
  );
  sameAddress(
    voteValidatorPendingOwner,
    ZeroAddress,
    "Inbox vote-validator pending owner",
  );
  sameAddress(
    voteAttestorRegistry,
    config.destination.inbox.defaultVoteValidator.attestorRegistry.address,
    "Inbox vote-validator attestor registry",
  );
  exactValue(
    voteMinAttestorCount,
    config.destination.inbox.defaultVoteValidator.minAttestorCount,
    "Inbox vote-validator minimum attestor count",
  );
  exactValue(
    voteThresholdNumerator,
    config.destination.inbox.defaultVoteValidator.thresholdNumerator,
    "Inbox vote-validator threshold numerator",
  );
  exactValue(
    voteThresholdAddition,
    config.destination.inbox.defaultVoteValidator.thresholdAddition,
    "Inbox vote-validator threshold addition",
  );
  exactValue(
    voteAttestorSetUpdateNonce,
    config.destination.inbox.defaultVoteValidator.attestorSetUpdateNonce,
    "Inbox vote-validator attestor-set update nonce",
  );
  sameAddressList(
    voteAttestors,
    config.destination.inbox.defaultVoteValidator.attestors,
    "Inbox vote-validator attestors",
  );
  const expectedVoteThreshold = Math.max(
    Math.floor(
      (config.destination.inbox.defaultVoteValidator.attestors.length *
        config.destination.inbox.defaultVoteValidator.thresholdNumerator) /
        30,
    ) + config.destination.inbox.defaultVoteValidator.thresholdAddition,
    config.destination.inbox.defaultVoteValidator.minAttestorCount,
  );
  exactValue(
    voteThreshold,
    expectedVoteThreshold,
    "Inbox vote-validator threshold",
  );
  sameAddress(
    registryOwner,
    config.destination.inbox.defaultVoteValidator.attestorRegistry.owner,
    "Inbox attestor-registry owner",
  );
  sameAddress(
    registryPendingOwner,
    ZeroAddress,
    "Inbox attestor-registry pending owner",
  );
  if (registryUpdaterAuthorizations.some((authorized) => authorized !== true)) {
    throw new Error(
      "Inbox vote validator is not an authorized registry updater",
    );
  }
  sameAddressList(
    registryAttestors,
    config.destination.inbox.defaultVoteValidator.attestors,
    "Inbox attestor-registry attestors",
  );

  const [acknowledgementDeployment, registryDeployment] = await Promise.all([
    verifyCanonicalContractDeployment({
      provider: sourceProvider,
      transactionHash: config.source.outbox.validator.deploymentTransactionHash,
      expectedAddress: config.source.outbox.validator.address,
      constructorTypes: ACKNOWLEDGEMENT_VALIDATOR_CONSTRUCTOR_TYPES,
      constructorValues: [
        config.source.outbox.validator.destinationChainKey,
        config.source.outbox.validator.owner,
        config.source.outbox.validator.proofVerifier.address,
        config.source.outbox.validator.attestToken,
      ],
      creationCodeKeccak256:
        config.source.outbox.validator.creationCodeKeccak256,
      label: "AcknowledgementValidator",
    }),
    verifyCanonicalContractDeployment({
      provider: destinationProvider,
      transactionHash:
        config.destination.inbox.defaultVoteValidator.attestorRegistry
          .deploymentTransactionHash,
      expectedAddress:
        config.destination.inbox.defaultVoteValidator.attestorRegistry.address,
      constructorTypes: ATTESTOR_REGISTRY_CONSTRUCTOR_TYPES,
      constructorValues: [
        config.destination.inbox.defaultVoteValidator.attestorRegistry.owner,
        config.destination.inbox.defaultVoteValidator.attestors,
      ],
      creationCodeKeccak256:
        config.destination.inbox.defaultVoteValidator.attestorRegistry
          .creationCodeKeccak256,
      label: "Inbox AttestorRegistry",
    }),
  ]);
  const [trustedInboxHistory, registryUpdaterHistory] = await Promise.all([
    reconstructBooleanEventSet({
      provider: sourceProvider,
      contractAddress: config.source.outbox.validator.address,
      abi: USC_ACKNOWLEDGEMENT_VALIDATOR_ABI,
      eventName: "TrustedInboxUpdated",
      keyArgument: "inbox",
      valueArgument: "trusted",
      fromBlock: acknowledgementDeployment.blockNumber,
      toBlock: sourceBlock.number,
      label: "AcknowledgementValidator trusted-Inbox",
    }),
    reconstructBooleanEventSet({
      provider: destinationProvider,
      contractAddress:
        config.destination.inbox.defaultVoteValidator.attestorRegistry.address,
      abi: USC_ATTESTOR_REGISTRY_ABI,
      eventName: "UpdaterSet",
      keyArgument: "updater",
      valueArgument: "authorized",
      fromBlock: registryDeployment.blockNumber,
      toBlock: destinationBlock.number,
      label: "Inbox AttestorRegistry updater",
    }),
  ]);
  sameAddressSet(
    trustedInboxHistory,
    config.source.outbox.validator.trustedInboxes,
    "AcknowledgementValidator exact trusted-Inbox set",
  );
  sameAddressSet(
    registryUpdaterHistory,
    config.destination.inbox.defaultVoteValidator.attestorRegistry
      .authorizedUpdaters,
    "Inbox AttestorRegistry exact updater set",
  );

  const deploymentHash = config.source.outbox.deploymentTransactionHash;
  const [deploymentTransaction, deploymentReceipt] = await Promise.all([
    sourceProvider.getTransaction(deploymentHash),
    sourceProvider.getTransactionReceipt(deploymentHash),
  ]);
  if (
    !deploymentTransaction ||
    deploymentTransaction.hash?.toLowerCase() !== deploymentHash ||
    deploymentTransaction.to !== null ||
    !deploymentReceipt ||
    deploymentReceipt.hash?.toLowerCase() !== deploymentHash ||
    deploymentReceipt.status !== 1 ||
    getAddress(deploymentReceipt.contractAddress) !==
      config.source.outbox.address
  ) {
    throw new Error("Outbox deployment evidence is inconsistent");
  }
  if (
    !Number.isSafeInteger(deploymentReceipt.blockNumber) ||
    !isHexString(deploymentReceipt.blockHash, 32)
  ) {
    throw new Error(
      "Outbox deployment receipt lacks a canonical block identity",
    );
  }
  const deploymentBlock = await sourceProvider.getBlock(
    deploymentReceipt.blockNumber,
  );
  if (
    !deploymentBlock?.hash ||
    deploymentBlock.hash.toLowerCase() !==
      deploymentReceipt.blockHash.toLowerCase()
  ) {
    throw new Error("Outbox deployment receipt is no longer canonical");
  }
  const constructor = decodeOutbox020Constructor(deploymentTransaction.data);
  exactValue(
    constructor.chainKey,
    config.source.outbox.chainKey,
    "Outbox constructor chain key",
  );
  sameAddress(
    constructor.owner,
    config.source.outbox.owner,
    "Outbox constructor owner",
  );
  sameAddress(
    constructor.validator,
    config.source.outbox.validator.address,
    "Outbox constructor validator",
  );
  exactValue(
    constructor.defaultRateLimit,
    config.source.outbox.defaultRateLimit,
    "Outbox constructor rate limit",
  );
  sameAddress(
    constructor.attestorVault,
    config.source.outbox.attestorVault.address,
    "Outbox constructor attestor vault",
  );
  sameAddress(
    constructor.feeRegistry,
    config.source.outbox.feeRegistry.address,
    "Outbox constructor fee registry",
  );
  sameAddress(
    constructor.attestToken,
    config.source.outbox.attestToken.address,
    "Outbox constructor ATTEST token",
  );
  const inboxStep = plan.steps.find(({ name }) => name === "deployInbox");
  if (
    !inboxStep ||
    inboxStep.predictedContract !== plan.predictedContracts.inbox
  ) {
    throw new Error("Dedicated Inbox deployment step is missing");
  }
  const inboxConstructor = decodeInbox020Constructor(inboxStep.data);
  if (inboxConstructor.localChainKey !== config.destination.localChainKey) {
    throw new Error("Dedicated Inbox constructor local chain key mismatch");
  }
  exactValue(
    inboxConstructor.creditcoinChainId,
    config.source.chainId,
    "Dedicated Inbox constructor Creditcoin chain ID",
  );
  sameAddress(
    inboxConstructor.defaultVoteValidator,
    config.destination.inbox.defaultVoteValidator.address,
    "Dedicated Inbox constructor validator",
  );
  sameAddress(
    inboxConstructor.messageDispatcher,
    plan.predictedContracts.dispatcher,
    "Dedicated Inbox constructor dispatcher",
  );
  sameAddress(
    inboxConstructor.owner,
    config.destination.inbox.owner,
    "Dedicated Inbox constructor owner",
  );
  const inboxDeploymentQualified =
    deploymentComplete || progress?.get("deployInbox") === "confirmed";
  if (inboxDeploymentQualified) {
    const inbox = contractFactory(
      plan.predictedContracts.inbox,
      USC_INBOX_ABI,
      destinationProvider,
    );
    const [
      localChainKey,
      creditcoinChainId,
      inboxValidator,
      messageDispatcher,
      inboxOwner,
      inboxPendingOwner,
      inboxPaused,
    ] = await Promise.all([
      inbox.localChainKey({ blockTag: destinationBlock.number }),
      inbox.creditcoinChainId({ blockTag: destinationBlock.number }),
      inbox.defaultVoteValidator({ blockTag: destinationBlock.number }),
      inbox.messageDispatcher({ blockTag: destinationBlock.number }),
      inbox.owner({ blockTag: destinationBlock.number }),
      inbox.pendingOwner({ blockTag: destinationBlock.number }),
      inbox.paused({ blockTag: destinationBlock.number }),
    ]);
    if (localChainKey.toLowerCase() !== config.destination.localChainKey) {
      throw new Error("Inbox local chain key mismatch");
    }
    exactValue(
      creditcoinChainId,
      config.source.chainId,
      "Inbox Creditcoin chain ID",
    );
    sameAddress(
      inboxValidator,
      config.destination.inbox.defaultVoteValidator.address,
      "Inbox validator",
    );
    sameAddress(
      messageDispatcher,
      plan.predictedContracts.dispatcher,
      "Inbox dispatcher",
    );
    sameAddress(inboxOwner, config.destination.inbox.owner, "Inbox owner");
    sameAddress(inboxPendingOwner, ZeroAddress, "Inbox pending owner");
    if (inboxPaused !== false) throw new Error("Inbox is paused");
  }
  const [canonicalSourceAnchor, canonicalDestinationAnchor] = await Promise.all(
    [
      sourceProvider.getBlock(sourceBlock.number),
      destinationProvider.getBlock(destinationBlock.number),
    ],
  );
  if (
    canonicalSourceAnchor?.hash?.toLowerCase() !==
      sourceBlock.hash.toLowerCase() ||
    canonicalDestinationAnchor?.hash?.toLowerCase() !==
      destinationBlock.hash.toLowerCase()
  ) {
    throw new Error("Live qualification block anchor is no longer canonical");
  }
  return {
    schemaVersion: 1,
    planCommitment: plan.planCommitment,
    source: {
      chainId: config.source.chainId,
      pendingNonce: sourceNonce,
      blockNumber: sourceBlock.number,
      blockHash: sourceBlock.hash.toLowerCase(),
      blockTimestamp: sourceBlock.timestamp,
      coreFee: BigInt(coreFee).toString(),
    },
    destination: {
      chainId: config.destination.chainId,
      pendingNonce: destinationNonce,
      blockNumber: destinationBlock.number,
      blockHash: destinationBlock.hash.toLowerCase(),
      blockTimestamp: destinationBlock.timestamp,
    },
    dependencies,
    ...(plan.sourceCommit
      ? {
          sourceCommit: plan.sourceCommit,
          deployableScopeClean: true,
        }
      : {}),
    outboxConstructor: {
      ...constructor,
      defaultRateLimit: constructor.defaultRateLimit.toString(),
    },
    mutableAuthorityEvidence: {
      pendingOwners: {
        outbox: ZeroAddress,
        acknowledgementValidator: ZeroAddress,
        voteValidator: ZeroAddress,
        attestorRegistry: ZeroAddress,
        inbox: inboxDeploymentQualified ? ZeroAddress : "not-deployed",
      },
      acknowledgementValidator: {
        deployment: acknowledgementDeployment,
        trustedInboxes: trustedInboxHistory,
      },
      attestorRegistry: {
        deployment: registryDeployment,
        owner:
          config.destination.inbox.defaultVoteValidator.attestorRegistry.owner,
        authorizedUpdaters: registryUpdaterHistory,
      },
      outboxStorage: {
        attestorVault: storageAddress(
          outboxAttestorVaultStorage,
          "Outbox attestor vault",
        ),
        attestToken: storageAddress(
          outboxAttestTokenStorage,
          "Outbox ATTEST token",
        ),
        feeRegistry: storageAddress(
          outboxFeeRegistryStorage,
          "Outbox fee registry",
        ),
      },
    },
    dedicatedInbox: {
      address: plan.predictedContracts.inbox,
      status: inboxDeploymentQualified
        ? "deployed-and-qualified"
        : progress
          ? "partially-deployed"
          : "planned-empty",
      sharedDispatcherReplacementAllowed: false,
    },
    inboxConstructor: {
      ...inboxConstructor,
      creditcoinChainId: inboxConstructor.creditcoinChainId.toString(),
    },
  };
}

function uscQualificationSecurityState(qualification) {
  const dependencies = object(
    qualification?.dependencies,
    "qualification.dependencies",
  );
  return canonicalJson({
    planCommitment: qualification.planCommitment,
    ...(qualification.sourceCommit
      ? {
          sourceCommit: qualification.sourceCommit,
          deployableScopeClean: qualification.deployableScopeClean,
        }
      : {}),
    source: {
      chainId: qualification.source?.chainId,
      coreFee: qualification.source?.coreFee,
    },
    destination: {
      chainId: qualification.destination?.chainId,
    },
    dependencies: Object.fromEntries(
      Object.entries(dependencies).filter(([key]) => key !== "plannedRoute"),
    ),
    outboxConstructor: qualification.outboxConstructor,
    inboxConstructor: qualification.inboxConstructor,
    mutableAuthorityEvidence: qualification.mutableAuthorityEvidence,
  });
}

function uscRenewalJournalIdentity(journal) {
  return commitment({
    configCommitment: journal.configCommitment,
    planCommitment: journal.planCommitment,
    predictedContracts: journal.predictedContracts,
    transactionPlan: journal.transactionPlan,
    executionPlan: journal.executionPlan,
  });
}

function uscRenewalCheckpointStep(step) {
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

export function createUscRemedyRenewalBinding(journal) {
  const binding = {
    schemaVersion: 1,
    journalIdentity: uscRenewalJournalIdentity(journal),
    executionPlanCommitment: journal.executionPlan?.commitment,
    checkpoint: journal.steps.map(uscRenewalCheckpointStep),
    remainingSteps: journal.steps
      .filter(({ status }) => status !== "confirmed")
      .map(({ name }) => name),
  };
  if (binding.remainingSteps.length === 0) {
    throw new Error("Completed USC deployment journal does not need renewal");
  }
  binding.commitment = commitment(binding);
  return binding;
}

export function validateUscRemedyRenewalBinding(binding, journal) {
  if (
    binding?.schemaVersion !== 1 ||
    binding.journalIdentity !== uscRenewalJournalIdentity(journal) ||
    binding.executionPlanCommitment !== journal.executionPlan?.commitment ||
    !Array.isArray(binding.checkpoint) ||
    !Array.isArray(binding.remainingSteps)
  ) {
    throw new Error("USC deployment renewal does not match its journal");
  }
  const expectedCommitment = commitment(
    Object.fromEntries(
      Object.entries(binding).filter(([key]) => key !== "commitment"),
    ),
  );
  if (binding.commitment !== expectedCommitment) {
    throw new Error("USC deployment renewal commitment mismatch");
  }
  if (binding.checkpoint.length !== journal.steps.length) {
    throw new Error("USC deployment renewal checkpoint length mismatch");
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
      throw new Error("USC deployment journal regressed after renewal");
    }
    if (
      checkpoint.transactionHash !== null &&
      checkpoint.transactionHash !== current.intent?.transactionHash
    ) {
      throw new Error("USC deployment transaction changed after renewal");
    }
    if (
      checkpoint.status === "confirmed" &&
      JSON.stringify(canonicalJson(checkpoint.receipt)) !==
        JSON.stringify(canonicalJson(current.receipt))
    ) {
      throw new Error("USC deployment receipt changed after renewal");
    }
  }
  const remainingSteps = binding.checkpoint
    .filter(({ status }) => status !== "confirmed")
    .map(({ name }) => name);
  if (
    JSON.stringify(binding.remainingSteps) !== JSON.stringify(remainingSteps)
  ) {
    throw new Error("USC deployment renewal remaining-step list mismatch");
  }
  return true;
}

export function createUscRemedyApproval({
  config,
  plan,
  qualification,
  executionPlan,
  now,
  journal,
}) {
  validateUscRemedyLiveExecutionPlan({ config, plan, executionPlan });
  const issuedAt = integer(now, "approval issue time");
  if (
    issuedAt !==
    integer(
      qualification.source?.blockTimestamp,
      "qualification source block timestamp",
    )
  ) {
    throw new Error(
      "USC remedy approval issue time must equal its qualification timestamp",
    );
  }
  const securityQualification = uscQualificationSecurityState(qualification);
  const approval = {
    schemaVersion: 2,
    generation: USC_REMEDY_GENERATION,
    configCommitment: plan.configCommitment,
    planCommitment: plan.planCommitment,
    issuedAt,
    validUntil: issuedAt + USC_PLAN_VALIDITY_SECONDS,
    sourceAnchor: qualification.source,
    destinationAnchor: qualification.destination,
    dependencies: qualification.dependencies,
    securityQualification,
    securityQualificationCommitment: commitment(securityQualification),
    executionPlan,
    executionPlanCommitment: executionPlan.commitment,
    ...(journal === undefined
      ? {}
      : { renewal: createUscRemedyRenewalBinding(journal) }),
  };
  approval.approvalCommitment = uscRemedyApprovalCommitment(approval);
  return approval;
}

export function uscRemedyApprovalCommitment(approval) {
  return commitment(
    Object.fromEntries(
      Object.entries(approval ?? {}).filter(
        ([key]) => key !== "approvalCommitment",
      ),
    ),
  );
}

export function validateUscRemedyApproval({
  approval,
  expectedApprovalCommitment,
  config,
  plan,
  qualification,
  liveQualification = qualification,
  now,
  journal,
}) {
  const expectedCommitment = digest(
    expectedApprovalCommitment,
    "expected approval commitment",
  );
  if (
    approval?.approvalCommitment !== expectedCommitment ||
    approval.approvalCommitment !== uscRemedyApprovalCommitment(approval)
  ) {
    throw new Error("Approved USC remedy approval commitment mismatch");
  }
  if (
    approval?.schemaVersion !== 2 ||
    approval.generation !== USC_REMEDY_GENERATION ||
    approval.configCommitment !== plan.configCommitment ||
    approval.planCommitment !== plan.planCommitment
  ) {
    throw new Error("Approved USC remedy plan does not match this deployment");
  }
  validateUscRemedyLiveExecutionPlan({
    config,
    plan,
    executionPlan: approval.executionPlan,
  });
  if (approval.executionPlanCommitment !== approval.executionPlan.commitment) {
    throw new Error("Approved USC remedy execution commitment mismatch");
  }
  const approvedSecurityQualification = object(
    approval.securityQualification,
    "approved security qualification",
  );
  if (
    approval.securityQualificationCommitment !==
      commitment(approvedSecurityQualification) ||
    JSON.stringify(approvedSecurityQualification) !==
      JSON.stringify(uscQualificationSecurityState(liveQualification))
  ) {
    throw new Error("Approved USC remedy security qualification changed");
  }
  const issuedAt = integer(approval.issuedAt, "approval issue time");
  const validUntil = integer(approval.validUntil, "approval expiry");
  const currentTime = integer(now, "approval validation time");
  if (
    issuedAt !==
    integer(
      liveQualification?.source?.blockTimestamp,
      "live qualification source block timestamp",
    )
  ) {
    throw new Error("Approved USC remedy qualification timestamp changed");
  }
  if (
    validUntil !== issuedAt + USC_PLAN_VALIDITY_SECONDS ||
    currentTime < issuedAt ||
    currentTime > validUntil
  ) {
    throw new Error("Approved USC remedy plan has expired");
  }
  if (approval.renewal === undefined) {
    if (
      approval.sourceAnchor?.pendingNonce !==
        qualification.source.pendingNonce ||
      approval.destinationAnchor?.pendingNonce !==
        qualification.destination.pendingNonce ||
      JSON.stringify(approval.dependencies) !==
        JSON.stringify(qualification.dependencies)
    ) {
      throw new Error("Approved USC remedy live dependencies changed");
    }
  } else {
    if (!journal) {
      throw new Error("USC deployment renewal requires its journal");
    }
    validateUscRemedyRenewalBinding(approval.renewal, journal);
  }
  return approval;
}

export function atomicWriteUscJson(path, value, { overwrite = false } = {}) {
  const target = resolve(path);
  if (!overwrite && existsSync(target)) {
    throw new Error(`Refusing to overwrite ${target}`);
  }
  const temporary = `${target}.usc-deployment-tmp`;
  if (existsSync(temporary)) {
    throw new Error(`Temporary file already exists: ${temporary}`);
  }
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, target);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export async function verifyUscApprovalAnchors({
  approval,
  sourceProvider,
  destinationProvider,
}) {
  const [sourceBlock, destinationBlock] = await Promise.all([
    sourceProvider.getBlock(approval.sourceAnchor.blockNumber),
    destinationProvider.getBlock(approval.destinationAnchor.blockNumber),
  ]);
  if (
    !sourceBlock?.hash ||
    sourceBlock.hash.toLowerCase() !== approval.sourceAnchor.blockHash ||
    sourceBlock.timestamp !== approval.sourceAnchor.blockTimestamp ||
    !destinationBlock?.hash ||
    destinationBlock.hash.toLowerCase() !==
      approval.destinationAnchor.blockHash ||
    destinationBlock.timestamp !== approval.destinationAnchor.blockTimestamp
  ) {
    throw new Error("Approved USC remedy chain anchor is no longer canonical");
  }
  return true;
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

export function reserveUscRemedyDeployment(manifestPath) {
  const target = resolve(manifestPath);
  const lockPath = `${target}.usc-deployment-lock`;
  const token = commitment({ pid: process.pid, now: Date.now(), target });
  let descriptor;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
      writeFileSync(
        descriptor,
        `${JSON.stringify({ schemaVersion: 1, pid: process.pid, token }, null, 2)}\n`,
        "utf8",
      );
      fsyncSync(descriptor);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let existing;
      try {
        existing = JSON.parse(readFileSync(lockPath, "utf8"));
      } catch {
        throw new Error(`USC deployment lock is unreadable: ${lockPath}`);
      }
      if (
        existing.schemaVersion !== 1 ||
        !Number.isSafeInteger(existing.pid) ||
        typeof existing.token !== "string"
      ) {
        throw new Error(`USC deployment lock is invalid: ${lockPath}`);
      }
      if (processIsAlive(existing.pid)) {
        throw new Error(`USC deployment lock already exists: ${lockPath}`);
      }
      const stalePath = `${target}.stale.${existing.pid}.${existing.token}.usc-deployment-lock`;
      renameSync(lockPath, stalePath);
      unlinkSync(stalePath);
    }
  }
  if (descriptor === undefined) {
    throw new Error(`Unable to acquire USC deployment lock: ${lockPath}`);
  }
  let released = false;
  return () => {
    if (released) return;
    const current = JSON.parse(readFileSync(lockPath, "utf8"));
    if (current.token !== token) {
      throw new Error("USC deployment lock ownership changed");
    }
    closeSync(descriptor);
    unlinkSync(lockPath);
    released = true;
  };
}

export function uscRemedyJournalPath(manifestPath) {
  return `${resolve(manifestPath)}.usc-deployment-journal.json`;
}

function validateUscRemedyJournal({ journal, config, plan }) {
  if (
    journal?.schemaVersion !== 1 ||
    journal.generation !== USC_REMEDY_GENERATION ||
    !["deploying", "deployed-dedicated-inbox-route"].includes(journal.phase) ||
    journal.planCommitment !== plan.planCommitment ||
    journal.configCommitment !== plan.configCommitment ||
    JSON.stringify(journal.predictedContracts) !==
      JSON.stringify(plan.predictedContracts) ||
    JSON.stringify(journal.transactionPlan) !== JSON.stringify(plan.steps) ||
    journal.executionPlanCommitment !== journal.executionPlan?.commitment ||
    !Array.isArray(journal.steps) ||
    journal.steps.length !== plan.steps.length
  ) {
    throw new Error("USC deployment journal does not match its plan");
  }
  validateUscRemedyLiveExecutionPlan({
    config,
    plan,
    executionPlan: journal.executionPlan,
  });
  const statusRank = { planned: 0, prepared: 1, confirmed: 2 };
  let previousRank = 2;
  for (let index = 0; index < journal.steps.length; index += 1) {
    const current = journal.steps[index];
    const approved = journal.executionPlan.steps[index];
    const rank = statusRank[current?.status];
    if (rank === undefined || rank > previousRank) {
      throw new Error("USC deployment journal step order is invalid");
    }
    previousRank = rank;
    for (const field of [
      "name",
      "network",
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
      if (current[field] !== approved[field]) {
        throw new Error(`${approved.name} journal transaction changed`);
      }
    }
    if (current.status === "planned") {
      if (current.intent !== undefined || current.receipt !== undefined) {
        throw new Error(
          `${current.name} planned journal step has execution state`,
        );
      }
      continue;
    }
    const intent = object(current.intent, `${current.name} intent`);
    if (
      !isHexString(intent.transactionHash, 32) ||
      intent.chainId !== String(current.chainId) ||
      getAddress(intent.from) !== current.from ||
      intent.to !== null ||
      intent.dataHash !== current.dataHash ||
      intent.value !== current.value ||
      intent.type !== current.type ||
      intent.gasLimit !== current.gasLimit ||
      intent.gasPrice !== current.gasPrice ||
      intent.maxFeePerGas !== current.maxFeePerGas ||
      intent.maxPriorityFeePerGas !== current.maxPriorityFeePerGas
    ) {
      throw new Error(`${current.name} journal intent changed`);
    }
    if (current.status === "prepared") {
      if (
        !isHexString(intent.rawTransaction) ||
        current.receipt !== undefined
      ) {
        throw new Error(`${current.name} prepared journal step is invalid`);
      }
      const transaction = validateSignedUscStep(intent.rawTransaction, current);
      if (transaction.hash.toLowerCase() !== intent.transactionHash) {
        throw new Error(`${current.name} prepared transaction hash changed`);
      }
    } else {
      if (intent.rawTransaction !== undefined) {
        throw new Error(
          `${current.name} confirmed journal retained signer material`,
        );
      }
      validateUscReceipt(current.receipt, intent, current);
    }
  }
  if (
    journal.phase === "deployed-dedicated-inbox-route" &&
    journal.steps.some(({ status }) => status !== "confirmed")
  ) {
    throw new Error("Completed USC deployment journal has unfinished steps");
  }
  return journal;
}

export function readUscRemedyJournal({ manifestPath, config, plan }) {
  const path = uscRemedyJournalPath(manifestPath);
  if (!existsSync(path)) return { path, journal: undefined };
  const journal = JSON.parse(readFileSync(path, "utf8"));
  validateUscRemedyJournal({ journal, config, plan });
  return { path, journal };
}

export function initializeUscRemedyJournal({
  manifestPath,
  config,
  plan,
  qualification,
  approval,
}) {
  if (
    approval?.executionPlanCommitment !== approval?.executionPlan?.commitment
  ) {
    throw new Error("USC deployment approval has no valid execution plan");
  }
  const path = uscRemedyJournalPath(manifestPath);
  if (existsSync(path)) {
    const { journal } = readUscRemedyJournal({ manifestPath, config, plan });
    if (
      journal.executionPlanCommitment !== approval.executionPlanCommitment ||
      JSON.stringify(journal.executionPlan) !==
        JSON.stringify(approval.executionPlan)
    ) {
      throw new Error(
        "USC deployment journal does not match the approved plan",
      );
    }
    return { path, journal };
  }
  const now = new Date().toISOString();
  const journal = {
    schemaVersion: 1,
    generation: USC_REMEDY_GENERATION,
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
  atomicWriteUscJson(path, journal);
  return { path, journal };
}

export async function prepareUscRemedyStep({
  journal,
  journalPath,
  stepIndex,
  signer,
}) {
  const step = journal.steps[stepIndex];
  if (!step || step.status !== "planned") {
    throw new Error(`USC deployment step ${stepIndex + 1} is not planned`);
  }
  sameAddress(await signer.getAddress(), step.from, `${step.name} signer`);
  const unsignedTransaction = {
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
  };
  const rawTransaction = await signer.signTransaction(unsignedTransaction);
  const transaction = validateSignedUscStep(rawTransaction, step);
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
  atomicWriteUscJson(journalPath, updated, { overwrite: true });
  return updated;
}

function validateUscReceipt(receipt, intent, step) {
  if (
    !receipt?.hash ||
    receipt.hash.toLowerCase() !== intent.transactionHash ||
    receipt.status !== 1 ||
    !Number.isSafeInteger(receipt.blockNumber) ||
    !isHexString(receipt.blockHash, 32)
  ) {
    throw new Error(`${step.name} receipt is invalid`);
  }
  if (
    step.predictedContract &&
    (!receipt.contractAddress ||
      getAddress(receipt.contractAddress) !== step.predictedContract)
  ) {
    throw new Error(`${step.name} created an unexpected contract address`);
  }
  if (
    step.status === "confirmed" &&
    (step.receipt?.hash !== receipt.hash.toLowerCase() ||
      step.receipt.blockNumber !== receipt.blockNumber ||
      step.receipt.blockHash !== receipt.blockHash.toLowerCase() ||
      step.receipt.contractAddress !==
        (receipt.contractAddress ? getAddress(receipt.contractAddress) : null))
  ) {
    throw new Error(`${step.name} receipt changed after confirmation`);
  }
}

export async function reconcileUscRemedyStep({
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
    throw new Error(`USC deployment step ${stepIndex + 1} is not prepared`);
  }
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(step.chainId)) {
    throw new Error(`${step.name} journal chain mismatch`);
  }
  positiveInteger(targetConfirmations, "target confirmations", 256);
  positiveInteger(maximumReceiptPolls, "maximum receipt polls", 10_000);
  if (maximumReceiptPolls < targetConfirmations) {
    throw new Error("Maximum receipt polls must cover confirmation depth");
  }
  let receipt;
  let broadcastAttempted = false;
  let canonicallyConfirmed = false;
  for (let attempt = 0; attempt < maximumReceiptPolls; attempt += 1) {
    receipt = await provider.getTransactionReceipt(step.intent.transactionHash);
    if (receipt) {
      validateUscReceipt(receipt, step.intent, step);
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
        validateUscReceipt(confirmedReceipt, step.intent, step);
        if (
          canonicalBlock?.hash?.toLowerCase() !==
          confirmedReceipt.blockHash.toLowerCase()
        ) {
          throw new Error(`${step.name} receipt block is not canonical`);
        }
        const parsed = validateSignedUscStep(transaction, step);
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
        const parsed = validateSignedUscStep(transaction, step);
        if (parsed.hash.toLowerCase() !== step.intent.transactionHash) {
          throw new Error(`${step.name} pending transaction hash mismatch`);
        }
      } else {
        if (!step.intent.rawTransaction) {
          throw new Error(`${step.name} signed transaction is unavailable`);
        }
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
    if (attempt + 1 < maximumReceiptPolls) {
      await delay(receiptPollIntervalMs);
    }
  }
  if (!canonicallyConfirmed) {
    throw new Error(
      `${step.name} remains pending after ${maximumReceiptPolls} bounded receipt polls`,
    );
  }
  if (step.status === "confirmed") return { journal, receipt };
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
  atomicWriteUscJson(journalPath, updated, { overwrite: true });
  return { journal: updated, receipt };
}

export function completeUscRemedyJournal(journal, journalPath) {
  if (journal.steps.some(({ status }) => status !== "confirmed")) {
    throw new Error("Cannot complete a USC deployment with unfinished steps");
  }
  const completed = {
    ...journal,
    phase: "deployed-dedicated-inbox-route",
    safetyBoundary: {
      dedicatedInboxRequired: true,
      requiredMessageDispatcher: journal.predictedContracts.dispatcher,
      setMessageDispatcherCalledByThisTool: false,
    },
    completedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  atomicWriteUscJson(journalPath, completed, { overwrite: true });
  return completed;
}

export function validateUscRemedyDeploymentManifest({
  manifest,
  config,
  plan,
}) {
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.generation !== USC_REMEDY_GENERATION ||
    manifest.status !== "deployed-dedicated-inbox-route" ||
    manifest.uscContractsVersion !== USC_CONTRACTS_VERSION ||
    manifest.configCommitment !== plan.configCommitment ||
    manifest.planCommitment !== plan.planCommitment ||
    manifest.sourceCommit !== plan.sourceCommit ||
    manifest.deployableScopeClean !== plan.deployableScopeClean ||
    manifest.sourceChainId !== config.source.chainId ||
    manifest.destinationChainId !== config.destination.chainId ||
    JSON.stringify(manifest.contracts) !==
      JSON.stringify(plan.predictedContracts) ||
    manifest.executionPlanCommitment !== manifest.executionPlan?.commitment ||
    manifest.finalQualification?.dedicatedInbox?.status !==
      "deployed-and-qualified" ||
    manifest.routeQualification?.status !== "qualified" ||
    manifest.routeQualification?.messageDispatcher !==
      plan.predictedContracts.dispatcher ||
    !manifest.canonicalTransactions ||
    manifest.safetyBoundary?.dedicatedInboxRequired !== true ||
    manifest.safetyBoundary?.requiredMessageDispatcher !==
      plan.predictedContracts.dispatcher ||
    manifest.safetyBoundary?.setMessageDispatcherCalledByThisTool !== false
  ) {
    throw new Error(
      "USC remedy deployment manifest does not match the configured plan",
    );
  }
  validateUscRemedyLiveExecutionPlan({
    config,
    plan,
    executionPlan: manifest.executionPlan,
  });
  const expectedNames = plan.steps.map(({ name }) => name).sort();
  for (const [label, records] of [
    ["transaction", manifest.transactions],
    ["canonical transaction", manifest.canonicalTransactions],
  ]) {
    if (
      !records ||
      JSON.stringify(Object.keys(records).sort()) !==
        JSON.stringify(expectedNames)
    ) {
      throw new Error(`USC manifest ${label} set mismatch`);
    }
  }
  return manifest;
}

export async function finalizeUscRemedyDeployment({
  manifestPath,
  journal,
  journalPath,
  installedPackage,
  config,
  plan,
  sourceProvider,
  destinationProvider,
  safetyBoundary,
  qualifyDependencies = qualifyUscRemedyDependencies,
  verifyRoute = verifyDeployedUscRemedyRoute,
  verifyTransactions = verifyUscRemedyDeploymentTransactions,
  repositoryState,
}) {
  if (journal.steps.some(({ status }) => status !== "confirmed")) {
    throw new Error("Cannot finalize a USC deployment with unfinished steps");
  }
  const transactionRecords = Object.fromEntries(
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
  const provisionalManifest = {
    schemaVersion: 1,
    generation: USC_REMEDY_GENERATION,
    status: "deployed-dedicated-inbox-route",
    uscContractsVersion: installedPackage.version,
    configCommitment: plan.configCommitment,
    planCommitment: plan.planCommitment,
    ...(plan.sourceCommit
      ? {
          sourceCommit: plan.sourceCommit,
          deployableScopeClean: plan.deployableScopeClean,
        }
      : {}),
    executionPlan: journal.executionPlan,
    executionPlanCommitment: journal.executionPlan.commitment,
    sourceChainId: config.source.chainId,
    destinationChainId: config.destination.chainId,
    contracts: plan.predictedContracts,
    transactions: transactionRecords,
    safetyBoundary,
    journalPath,
  };
  const finalQualification = await qualifyDependencies({
    config,
    plan,
    sourceProvider,
    destinationProvider,
    deploymentComplete: true,
    repositoryState,
  });
  const routeQualification = await verifyRoute({
    config,
    plan,
    sourceProvider,
    destinationProvider,
  });
  const canonicalTransactions = await verifyTransactions({
    manifest: provisionalManifest,
    config,
    plan,
    sourceProvider,
    destinationProvider,
  });
  const manifest = {
    ...provisionalManifest,
    dependencies: finalQualification.dependencies,
    finalQualification,
    routeQualification,
    canonicalTransactions,
  };
  validateUscRemedyDeploymentManifest({ manifest, config, plan });
  completeUscRemedyJournal(journal, journalPath);
  atomicWriteUscJson(manifestPath, manifest);
  return manifest;
}

export async function verifyDeployedUscRemedyRoute({
  config,
  plan,
  sourceProvider,
  destinationProvider,
  contractFactory = (addressValue, abi, provider) =>
    new Contract(addressValue, abi, provider),
}) {
  const transport = contractFactory(
    plan.predictedContracts.transport,
    [
      "function coordinator() view returns (address)",
      "function outbox() view returns (address)",
      "function attestToken() view returns (address)",
      "function destinationChain() view returns (uint64)",
      "function destinationReceiver() view returns (address)",
      "function maximumCoreFee() view returns (uint256)",
    ],
    sourceProvider,
  );
  const coordinator = contractFactory(
    plan.predictedContracts.coordinator,
    [
      "function context() view returns (address)",
      "function transport() view returns (address)",
    ],
    sourceProvider,
  );
  const receiver = contractFactory(
    plan.predictedContracts.receiver,
    [
      "function transport() view returns (address)",
      "function guardian() view returns (address)",
    ],
    destinationProvider,
  );
  const dispatcher = contractFactory(
    plan.predictedContracts.dispatcher,
    [
      "function trustedInbox() view returns (address)",
      "function trustedSourceChain() view returns (uint64)",
      "function trustedSourceAdapter() view returns (address)",
      "function trustedSourceCoordinator() view returns (address)",
      "function destinationReceiver() view returns (address)",
    ],
    destinationProvider,
  );
  const inbox = contractFactory(
    plan.predictedContracts.inbox,
    USC_INBOX_ABI,
    destinationProvider,
  );
  const [
    transportCode,
    coordinatorCode,
    receiverCode,
    dispatcherCode,
    inboxCode,
    transportCoordinator,
    transportOutbox,
    transportToken,
    transportDestinationChain,
    transportReceiver,
    transportMaximumFee,
    coordinatorContext,
    coordinatorTransport,
    receiverTransport,
    receiverGuardian,
    dispatcherInbox,
    dispatcherSourceChain,
    dispatcherSourceAdapter,
    dispatcherSourceCoordinator,
    dispatcherReceiver,
    installedDispatcher,
    inboxLocalChainKey,
    inboxCreditcoinChainId,
    inboxValidator,
    inboxOwner,
    inboxPendingOwner,
    inboxPaused,
  ] = await Promise.all([
    sourceProvider.getCode(plan.predictedContracts.transport),
    sourceProvider.getCode(plan.predictedContracts.coordinator),
    destinationProvider.getCode(plan.predictedContracts.receiver),
    destinationProvider.getCode(plan.predictedContracts.dispatcher),
    destinationProvider.getCode(plan.predictedContracts.inbox),
    transport.coordinator(),
    transport.outbox(),
    transport.attestToken(),
    transport.destinationChain(),
    transport.destinationReceiver(),
    transport.maximumCoreFee(),
    coordinator.context(),
    coordinator.transport(),
    receiver.transport(),
    receiver.guardian(),
    dispatcher.trustedInbox(),
    dispatcher.trustedSourceChain(),
    dispatcher.trustedSourceAdapter(),
    dispatcher.trustedSourceCoordinator(),
    dispatcher.destinationReceiver(),
    inbox.messageDispatcher(),
    inbox.localChainKey(),
    inbox.creditcoinChainId(),
    inbox.defaultVoteValidator(),
    inbox.owner(),
    inbox.pendingOwner(),
    inbox.paused(),
  ]);
  for (const [label, code] of [
    ["Transport", transportCode],
    ["Coordinator", coordinatorCode],
    ["Receiver", receiverCode],
    ["Dispatcher", dispatcherCode],
    ["Inbox", inboxCode],
  ]) {
    if (!isHexString(code) || code === "0x") {
      throw new Error(`${label} route contract has no bytecode`);
    }
  }
  sameAddress(
    transportCoordinator,
    plan.predictedContracts.coordinator,
    "Transport coordinator",
  );
  sameAddress(
    transportOutbox,
    config.source.outbox.address,
    "Transport Outbox",
  );
  sameAddress(
    transportToken,
    config.source.outbox.attestToken.address,
    "Transport ATTEST token",
  );
  exactValue(
    transportDestinationChain,
    config.destination.uscChainKey,
    "Transport destination chain",
  );
  sameAddress(
    transportReceiver,
    plan.predictedContracts.receiver,
    "Transport receiver",
  );
  exactValue(
    transportMaximumFee,
    config.source.outbox.maximumCoreFee,
    "Transport maximum core fee",
  );
  sameAddress(
    coordinatorContext,
    config.source.context.address,
    "Coordinator context",
  );
  sameAddress(
    coordinatorTransport,
    plan.predictedContracts.transport,
    "Coordinator transport",
  );
  sameAddress(
    receiverTransport,
    plan.predictedContracts.dispatcher,
    "Receiver dispatcher",
  );
  sameAddress(
    receiverGuardian,
    config.destination.guardian,
    "Receiver guardian",
  );
  sameAddress(
    dispatcherInbox,
    plan.predictedContracts.inbox,
    "Dispatcher Inbox",
  );
  exactValue(
    dispatcherSourceChain,
    config.source.chainId,
    "Dispatcher source chain",
  );
  sameAddress(
    dispatcherSourceAdapter,
    plan.predictedContracts.transport,
    "Dispatcher source adapter",
  );
  sameAddress(
    dispatcherSourceCoordinator,
    plan.predictedContracts.coordinator,
    "Dispatcher source coordinator",
  );
  sameAddress(
    dispatcherReceiver,
    plan.predictedContracts.receiver,
    "Dispatcher receiver",
  );
  if (inboxLocalChainKey.toLowerCase() !== config.destination.localChainKey) {
    throw new Error("Inbox local chain key mismatch");
  }
  exactValue(
    inboxCreditcoinChainId,
    config.source.chainId,
    "Inbox Creditcoin chain ID",
  );
  sameAddress(
    inboxValidator,
    config.destination.inbox.defaultVoteValidator.address,
    "Inbox vote validator",
  );
  sameAddress(inboxOwner, config.destination.inbox.owner, "Inbox owner");
  sameAddress(inboxPendingOwner, ZeroAddress, "Inbox pending owner");
  if (inboxPaused !== false) throw new Error("Inbox is paused");
  sameAddress(
    installedDispatcher,
    plan.predictedContracts.dispatcher,
    "Inbox installed message dispatcher",
  );
  return {
    status: "qualified",
    messageDispatcher: plan.predictedContracts.dispatcher,
    runtimeCodeHashes: {
      transport: keccak256(transportCode),
      coordinator: keccak256(coordinatorCode),
      receiver: keccak256(receiverCode),
      dispatcher: keccak256(dispatcherCode),
      inbox: keccak256(inboxCode),
    },
  };
}

export async function verifyUscRemedyDeploymentTransactions({
  manifest,
  config,
  plan,
  sourceProvider,
  destinationProvider,
}) {
  validateUscRemedyLiveExecutionPlan({
    config,
    plan,
    executionPlan: manifest.executionPlan,
  });
  if (manifest.executionPlanCommitment !== manifest.executionPlan.commitment) {
    throw new Error("USC manifest execution plan commitment mismatch");
  }
  const verified = {};
  for (const step of manifest.executionPlan.steps) {
    const record = manifest.transactions?.[step.name];
    if (!isHexString(record?.hash, 32)) {
      throw new Error(`Missing ${step.name} deployment transaction evidence`);
    }
    const provider =
      step.network === "source" ? sourceProvider : destinationProvider;
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
    validateSignedUscStep(transaction, step);
    const intent = { transactionHash: record.hash.toLowerCase() };
    validateUscReceipt(receipt, intent, { ...step, status: "prepared" });
    const canonicalBlock = await provider.getBlock(receipt.blockNumber);
    if (
      !canonicalBlock?.hash ||
      canonicalBlock.hash.toLowerCase() !== receipt.blockHash.toLowerCase()
    ) {
      throw new Error(`${step.name} receipt is no longer canonical`);
    }
    if (
      record.blockNumber !== receipt.blockNumber ||
      record.blockHash?.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      getAddress(record.contractAddress) !== step.predictedContract
    ) {
      throw new Error(`${step.name} manifest transaction evidence mismatch`);
    }
    verified[step.name] = {
      hash: record.hash.toLowerCase(),
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash.toLowerCase(),
      contractAddress: getAddress(receipt.contractAddress),
      creationDataHash: step.dataHash,
    };
  }
  return verified;
}

export function validateSignedUscStep(transaction, step) {
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
