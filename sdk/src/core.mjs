import {
  AbiCoder,
  Interface,
  ZeroAddress,
  getAddress,
  isHexString,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import {
  eventHistoryConfigurationTuple,
  eventHistoryPolicyV1Abi,
  policyKernelV1Abi,
  policyRegistryActionAdapterTuple,
  policyRegistryV1Abi,
  proofJobParamsTuple,
  proofJobsV1Abi,
  recourseFacilityFactoryV2Abi,
  recourseFacilityV2Abi,
} from "./abis.mjs";

export const PolicyOutcome = Object.freeze({
  Eligible: 0,
  Watch: 1,
  Restricted: 2,
  MarginCalled: 3,
  Breached: 4,
  Cured: 5,
});
export const ObservationKind = Object.freeze({
  Ownership: 0,
  Collateral: 1,
  Position: 2,
  Liability: 3,
  Behaviour: 4,
});
export const EvidenceKind = Object.freeze({
  TransactionControl: 0,
  EventDelta: 1,
  EventTransition: 2,
});
export const FacilityStatus = Object.freeze({
  Created: 0,
  Active: 1,
  Repaid: 2,
  Defaulted: 3,
  Cancelled: 4,
  Terminated: 5,
});
export const ProofJobState = Object.freeze({
  Open: 0,
  OutcomeReached: 1,
  AttemptsExhausted: 2,
  Expired: 3,
});
export const AuditScope = Object.freeze({
  Release: 0,
  Deployment: 1,
});
export const PortfolioEligibilityCode = Object.freeze({
  Eligible: 0,
  UnknownFacility: 1,
  WrongAsset: 2,
  WrongKernel: 3,
  InvalidStatus: 4,
  FacilityLimitExceeded: 5,
  BondBelowMinimum: 6,
  DrawFeeExceeded: 7,
  InvalidMaturity: 8,
  PolicySetMismatch: 9,
  UnknownRelease: 10,
  InvalidDeployment: 11,
  MissingEvidenceKind: 12,
  MissingActionAdapter: 13,
});

const coder = AbiCoder.defaultAbiCoder();
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT64 = (1n << 64n) - 1n;
const MAX_UINT32 = (1n << 32n) - 1n;
const MAX_UINT16 = (1n << 16n) - 1n;
const MAX_UINT8 = (1n << 8n) - 1n;
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;
const evidenceKinds = new Set([
  "transaction-control",
  "event-delta",
  "event-transition",
]);

function integer(value, label, maximum) {
  const valueType = typeof value;
  if (
    (valueType !== "bigint" &&
      valueType !== "number" &&
      valueType !== "string") ||
    (valueType === "string" && value.trim() === "") ||
    (valueType === "number" && !Number.isSafeInteger(value))
  ) {
    throw new TypeError(`Invalid ${label}`);
  }
  let result;
  try {
    result = BigInt(value);
  } catch {
    throw new TypeError(`Invalid ${label}`);
  }
  if (result < 0n || result > maximum) throw new RangeError(`Invalid ${label}`);
  return result;
}

function positiveInteger(value, label, maximum) {
  const result = integer(value, label, maximum);
  if (result === 0n) throw new RangeError(`Invalid ${label}`);
  return result;
}

function safeInteger(value, label, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

function address(value, label, { nonzero = true } = {}) {
  let result;
  try {
    result = getAddress(value);
  } catch {
    throw new TypeError(`Invalid ${label}`);
  }
  if (nonzero && result === ZeroAddress)
    throw new TypeError(`Invalid ${label}`);
  return result;
}

function bytes32(value, label) {
  if (!isHexString(value, 32)) throw new TypeError(`Invalid ${label}`);
  return value.toLowerCase();
}

function nonzeroBytes32(value, label) {
  const result = bytes32(value, label);
  if (result === ZERO_BYTES32) throw new RangeError(`Invalid ${label}`);
  return result;
}

function bytes(value, label) {
  if (!isHexString(value)) throw new TypeError(`Invalid ${label}`);
  return value.toLowerCase();
}

function policyEffect(value) {
  if (!value || typeof value !== "object")
    throw new TypeError("Invalid effect");
  const outcome = Number(integer(value.outcome, "effect.outcome", 5n));
  const creditLimitBps = Number(
    integer(value.creditLimitBps, "effect.creditLimitBps", MAX_UINT16),
  );
  const futureDrawFeeBps = Number(
    integer(value.futureDrawFeeBps, "effect.futureDrawFeeBps", MAX_UINT16),
  );
  if (creditLimitBps > 10_000)
    throw new RangeError("Invalid effect.creditLimitBps");
  if (futureDrawFeeBps > 10_000)
    throw new RangeError("Invalid effect.futureDrawFeeBps");
  for (const key of [
    "freezePendingDraw",
    "requireFreshEvidence",
    "terminate",
  ]) {
    if (typeof value[key] !== "boolean")
      throw new TypeError(`Invalid effect.${key}`);
  }
  return {
    outcome,
    creditLimitBps,
    futureDrawFeeBps,
    freezePendingDraw: value.freezePendingDraw,
    requireFreshEvidence: value.requireFreshEvidence,
    terminate: value.terminate,
  };
}

export const KERNEL_PROOF_TYPES = Object.freeze([
  "uint64",
  "uint64",
  "bytes",
  "tuple(bytes32 root, tuple(bytes32 hash, bool isLeft)[] siblings)",
  "tuple(bytes32 lowerEndpointDigest, bytes32[] roots)",
]);

export function encodeKernelProof({
  chainKey,
  height,
  encodedTransaction,
  merkleProof,
  continuityProof,
}) {
  integer(chainKey, "chainKey", MAX_UINT64);
  integer(height, "height", MAX_UINT64);
  bytes(encodedTransaction, "encodedTransaction");
  bytes32(merkleProof?.root, "merkleProof.root");
  if (!Array.isArray(merkleProof?.siblings))
    throw new TypeError("Invalid merkleProof.siblings");
  for (const [index, sibling] of merkleProof.siblings.entries()) {
    bytes32(sibling?.hash, `merkleProof.siblings[${index}].hash`);
    if (typeof sibling?.isLeft !== "boolean") {
      throw new TypeError(`Invalid merkleProof.siblings[${index}].isLeft`);
    }
  }
  bytes32(
    continuityProof?.lowerEndpointDigest,
    "continuityProof.lowerEndpointDigest",
  );
  if (!Array.isArray(continuityProof?.roots))
    throw new TypeError("Invalid continuityProof.roots");
  continuityProof.roots.forEach((root, index) =>
    bytes32(root, `continuityProof.roots[${index}]`),
  );
  return coder.encode(KERNEL_PROOF_TYPES, [
    chainKey,
    height,
    encodedTransaction,
    merkleProof,
    continuityProof,
  ]);
}

export function computeEvidenceDigest(proof) {
  return keccak256(bytes(proof, "proof"));
}

export function encodeJobCommitment(jobId, hunter, evidenceDigest, salt) {
  integer(jobId, "jobId", (1n << 256n) - 1n);
  return coder.encode(
    ["uint256", "address", "bytes32", "bytes32"],
    [
      jobId,
      address(hunter, "hunter"),
      bytes32(evidenceDigest, "evidenceDigest"),
      bytes32(salt, "salt"),
    ],
  );
}

export function computeJobCommitment(jobId, hunter, evidenceDigest, salt) {
  return keccak256(encodeJobCommitment(jobId, hunter, evidenceDigest, salt));
}

export function validateEventHistoryManifest(value) {
  if (!value || typeof value !== "object")
    throw new TypeError("Invalid EventHistory manifest");
  const sourceChain = integer(value.sourceChain, "sourceChain", MAX_UINT64);
  if (sourceChain === 0n) throw new RangeError("Invalid sourceChain");
  const startSourceBlock = integer(
    value.startSourceBlock,
    "startSourceBlock",
    MAX_UINT64,
  );
  const endSourceBlock = integer(
    value.endSourceBlock,
    "endSourceBlock",
    MAX_UINT64,
  );
  if (startSourceBlock > endSourceBlock)
    throw new RangeError("Invalid source block range");
  const topicCount = Number(integer(value.topicCount, "topicCount", MAX_UINT8));
  if (topicCount <= 1 || topicCount > 4)
    throw new RangeError("Invalid topicCount");
  const subjectTopicIndex = Number(
    integer(value.subjectTopicIndex, "subjectTopicIndex", MAX_UINT8),
  );
  if (subjectTopicIndex === 0 || subjectTopicIndex >= topicCount) {
    throw new RangeError("Invalid subjectTopicIndex");
  }
  const dataLength = Number(
    integer(value.dataLength, "dataLength", MAX_UINT16),
  );
  if (dataLength === 0 || dataLength % 32 !== 0)
    throw new RangeError("Invalid dataLength");
  const observedValueOffset = Number(
    integer(value.observedValueOffset, "observedValueOffset", MAX_UINT16),
  );
  if (observedValueOffset % 32 !== 0 || observedValueOffset + 32 > dataLength) {
    throw new RangeError("Invalid observedValueOffset");
  }
  const observationKind = Number(
    integer(value.observationKind, "observationKind", 4n),
  );
  const evidenceKind = Number(integer(value.evidenceKind, "evidenceKind", 2n));
  if (evidenceKind === EvidenceKind.TransactionControl)
    throw new RangeError("Invalid evidenceKind");
  const freshnessPeriod = integer(
    value.freshnessPeriod,
    "freshnessPeriod",
    MAX_UINT64,
  );
  if (freshnessPeriod === 0n) throw new RangeError("Invalid freshnessPeriod");
  const eventSignature = bytes32(value.eventSignature, "eventSignature");
  if (eventSignature === ZERO_BYTES32)
    throw new RangeError("Invalid eventSignature");
  const effect = policyEffect(value.effect);
  if (
    effect.outcome === PolicyOutcome.Eligible ||
    effect.outcome === PolicyOutcome.Cured
  ) {
    throw new RangeError("Invalid effect.outcome");
  }
  return {
    sourceChain: value.sourceChain,
    emitter: address(value.emitter, "emitter"),
    eventSignature,
    subject: address(value.subject, "subject"),
    startSourceBlock: value.startSourceBlock,
    endSourceBlock: value.endSourceBlock,
    topicCount,
    subjectTopicIndex,
    dataLength,
    observedValueOffset,
    observationKind,
    evidenceKind,
    freshnessPeriod: value.freshnessPeriod,
    effect,
  };
}

export function encodeEventHistoryManifest(value) {
  return coder.encode(
    [eventHistoryConfigurationTuple],
    [validateEventHistoryManifest(value)],
  );
}

export function hashEventHistoryManifest(value) {
  return keccak256(encodeEventHistoryManifest(value));
}

export function decodeEventHistoryManifest(manifestBytes) {
  const encoded = bytes(manifestBytes, "manifestBytes");
  let decoded;
  try {
    [decoded] = coder.decode([eventHistoryConfigurationTuple], encoded);
  } catch {
    throw new TypeError("Invalid manifestBytes");
  }
  const manifest = validateEventHistoryManifest({
    sourceChain: decoded.sourceChain,
    emitter: decoded.emitter,
    eventSignature: decoded.eventSignature,
    subject: decoded.subject,
    startSourceBlock: decoded.startSourceBlock,
    endSourceBlock: decoded.endSourceBlock,
    topicCount: Number(decoded.topicCount),
    subjectTopicIndex: Number(decoded.subjectTopicIndex),
    dataLength: Number(decoded.dataLength),
    observedValueOffset: Number(decoded.observedValueOffset),
    observationKind: Number(decoded.observationKind),
    evidenceKind: Number(decoded.evidenceKind),
    freshnessPeriod: decoded.freshnessPeriod,
    effect: decoded.effect,
  });
  if (encodeEventHistoryManifest(manifest).toLowerCase() !== encoded) {
    throw new TypeError(
      "EventHistory manifestBytes are not canonical ABI encoding",
    );
  }
  return manifest;
}

export function validateEventHistoryManifestBinding(
  manifestBytes,
  expectedConfigHash,
) {
  const encoded = bytes(manifestBytes, "manifestBytes");
  const expected = nonzeroBytes32(expectedConfigHash, "expectedConfigHash");
  const manifestHash = keccak256(encoded);
  if (manifestHash !== expected) {
    throw new RangeError("EventHistory manifest config hash mismatch");
  }
  return {
    manifest: decodeEventHistoryManifest(encoded),
    manifestHash,
  };
}

function severity(outcome) {
  return outcome >= PolicyOutcome.Watch && outcome <= PolicyOutcome.Breached
    ? outcome
    : 0;
}

export function simulateFacilityPolicyState({
  initialDrawFeeBps,
  facilityLimit,
  drawnPrincipal,
  status,
  lenderDrawPaused,
  borrowerDrawPaused,
  timestamp,
  policies,
}) {
  const initialFee = Number(
    integer(initialDrawFeeBps, "initialDrawFeeBps", 10_000n),
  );
  const limit = integer(facilityLimit, "facilityLimit", (1n << 256n) - 1n);
  const drawn = integer(drawnPrincipal, "drawnPrincipal", (1n << 256n) - 1n);
  const facilityStatus = Number(integer(status, "status", 5n));
  const now = integer(timestamp, "timestamp", MAX_UINT64);
  if (
    typeof lenderDrawPaused !== "boolean" ||
    typeof borrowerDrawPaused !== "boolean"
  ) {
    throw new TypeError("Invalid pause state");
  }
  if (!Array.isArray(policies)) throw new TypeError("Invalid policies");

  let aggregateSeverity = 0;
  let creditLimitBps = 10_000;
  let futureDrawFeeBps = initialFee;
  let evidenceValidUntil = 0n;
  let freshEvidenceRequired = false;
  let anyCured = false;
  let terminationRequired = false;
  for (const [index, stored] of policies.entries()) {
    if (!stored || typeof stored !== "object")
      throw new TypeError(`Invalid policies[${index}]`);
    const current = policyEffect(stored.effect);
    const expiry = integer(
      stored.evidenceExpiry,
      `policies[${index}].evidenceExpiry`,
      MAX_UINT64,
    );
    aggregateSeverity = Math.max(aggregateSeverity, severity(current.outcome));
    anyCured ||= current.outcome === PolicyOutcome.Cured;
    creditLimitBps = Math.min(creditLimitBps, current.creditLimitBps);
    futureDrawFeeBps = Math.max(futureDrawFeeBps, current.futureDrawFeeBps);
    freshEvidenceRequired ||= current.requireFreshEvidence;
    terminationRequired ||= current.terminate;
    if (
      expiry !== 0n &&
      (evidenceValidUntil === 0n || expiry < evidenceValidUntil)
    ) {
      evidenceValidUntil = expiry;
    }
  }
  const policyOutcome =
    aggregateSeverity === 0
      ? anyCured
        ? PolicyOutcome.Cured
        : PolicyOutcome.Eligible
      : aggregateSeverity;
  const incidentPaused = lenderDrawPaused || borrowerDrawPaused;
  const effectiveLimit = (limit * BigInt(creditLimitBps)) / 10_000n;
  let availableCredit = drawn >= effectiveLimit ? 0n : effectiveLimit - drawn;
  if (
    facilityStatus !== FacilityStatus.Active ||
    terminationRequired ||
    incidentPaused ||
    freshEvidenceRequired ||
    (evidenceValidUntil !== 0n && now >= evidenceValidUntil)
  ) {
    availableCredit = 0n;
  }
  return {
    policyOutcome,
    creditLimitBps,
    futureDrawFeeBps,
    freshEvidenceRequired,
    evidenceValidUntil,
    incidentPaused,
    effectiveLimit,
    availableCredit,
  };
}

export function simulatePortfolioMandateEligibility({
  mandate,
  facility,
  deployment,
  releaseExists,
  factoryRecognized,
  evidenceKindDeclared,
  actionAdapters,
  chainId,
  blockNumber,
}) {
  if (!mandate || typeof mandate !== "object")
    throw new TypeError("Invalid mandate");
  if (!facility || typeof facility !== "object")
    throw new TypeError("Invalid facility");
  if (!deployment || typeof deployment !== "object")
    throw new TypeError("Invalid deployment");
  if (
    typeof releaseExists !== "boolean" ||
    typeof factoryRecognized !== "boolean" ||
    typeof evidenceKindDeclared !== "boolean"
  ) {
    throw new TypeError("Invalid mandate evidence state");
  }
  if (!Array.isArray(actionAdapters))
    throw new TypeError("Invalid actionAdapters");
  const currentChainId = positiveInteger(chainId, "chainId", MAX_UINT256);
  const currentBlock = integer(blockNumber, "blockNumber", MAX_UINT256);
  const requiredAsset = address(mandate.asset, "mandate.asset");
  const requiredKernel = address(mandate.kernel, "mandate.kernel");
  const requiredReleaseId = nonzeroBytes32(
    mandate.requiredReleaseId,
    "mandate.requiredReleaseId",
  );
  const requiredPolicySetCommitment = nonzeroBytes32(
    mandate.requiredPolicySetCommitment,
    "mandate.requiredPolicySetCommitment",
  );
  const requiredActionAdapterKind = nonzeroBytes32(
    mandate.requiredActionAdapterKind,
    "mandate.requiredActionAdapterKind",
  );
  integer(mandate.requiredEvidenceKind, "mandate.requiredEvidenceKind", 2n);
  const maximumFacilityLimit = positiveInteger(
    mandate.maximumFacilityLimit,
    "mandate.maximumFacilityLimit",
    MAX_UINT256,
  );
  const minimumBondBps = positiveInteger(
    mandate.minimumBondBps,
    "mandate.minimumBondBps",
    10_000n,
  );
  const maximumDrawFeeBps = integer(
    mandate.maximumDrawFeeBps,
    "mandate.maximumDrawFeeBps",
    10_000n,
  );
  const maximumRemainingMaturityBlocks = positiveInteger(
    mandate.maximumRemainingMaturityBlocks,
    "mandate.maximumRemainingMaturityBlocks",
    MAX_UINT64,
  );
  const facilityAddress = address(facility.address, "facility.address");
  if (!factoryRecognized) return PortfolioEligibilityCode.UnknownFacility;
  if (address(facility.asset, "facility.asset") !== requiredAsset) {
    return PortfolioEligibilityCode.WrongAsset;
  }
  if (address(facility.kernel, "facility.kernel") !== requiredKernel) {
    return PortfolioEligibilityCode.WrongKernel;
  }
  const status = Number(integer(facility.status, "facility.status", 5n));
  if (status !== FacilityStatus.Created && status !== FacilityStatus.Active) {
    return PortfolioEligibilityCode.InvalidStatus;
  }
  const facilityLimit = integer(
    facility.facilityLimit,
    "facility.facilityLimit",
    MAX_UINT256,
  );
  if (facilityLimit === 0n || facilityLimit > maximumFacilityLimit) {
    return PortfolioEligibilityCode.FacilityLimitExceeded;
  }
  const minimumBond = (facilityLimit * minimumBondBps + 9_999n) / 10_000n;
  if (
    integer(facility.bondRequired, "facility.bondRequired", MAX_UINT256) <
    minimumBond
  ) {
    return PortfolioEligibilityCode.BondBelowMinimum;
  }
  if (
    integer(
      facility.initialDrawFeeBps,
      "facility.initialDrawFeeBps",
      MAX_UINT16,
    ) > maximumDrawFeeBps
  ) {
    return PortfolioEligibilityCode.DrawFeeExceeded;
  }
  const maturityBlock = integer(
    facility.maturityBlock,
    "facility.maturityBlock",
    MAX_UINT64,
  );
  if (
    maturityBlock <= currentBlock ||
    maturityBlock > currentBlock + maximumRemainingMaturityBlocks
  ) {
    return PortfolioEligibilityCode.InvalidMaturity;
  }
  if (
    bytes32(facility.policySetCommitment, "facility.policySetCommitment") !==
    requiredPolicySetCommitment
  ) {
    return PortfolioEligibilityCode.PolicySetMismatch;
  }
  if (!releaseExists) return PortfolioEligibilityCode.UnknownRelease;
  const deploymentValid =
    deployment.exists === true &&
    bytes32(deployment.releaseId, "deployment.releaseId") ===
      requiredReleaseId &&
    integer(deployment.chainId, "deployment.chainId", MAX_UINT256) ===
      currentChainId &&
    address(deployment.kernel, "deployment.kernel") === requiredKernel &&
    address(deployment.facility, "deployment.facility") === facilityAddress &&
    address(deployment.evaluator, "deployment.evaluator", {
      nonzero: false,
    }) !== ZeroAddress &&
    bytes32(deployment.configHash, "deployment.configHash") !== ZERO_BYTES32 &&
    bytes32(deployment.manifestHash, "deployment.manifestHash") !==
      ZERO_BYTES32;
  if (!deploymentValid) return PortfolioEligibilityCode.InvalidDeployment;
  if (!evidenceKindDeclared)
    return PortfolioEligibilityCode.MissingEvidenceKind;
  const adapterKinds = actionAdapters.map((adapter, index) =>
    bytes32(adapter?.adapterKind, `actionAdapters[${index}].adapterKind`),
  );
  return adapterKinds.includes(requiredActionAdapterKind)
    ? PortfolioEligibilityCode.Eligible
    : PortfolioEligibilityCode.MissingActionAdapter;
}

function nonemptyString(value, label) {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0
  ) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

function boundedUtf8String(value, label, maximumBytes) {
  if (typeof value !== "string") throw new TypeError(`Invalid ${label}`);
  let length;
  try {
    length = toUtf8Bytes(value).length;
  } catch {
    throw new TypeError(`Invalid ${label}`);
  }
  if (length === 0 || length > maximumBytes)
    throw new RangeError(`Invalid ${label}`);
  return value;
}

function deployment(value, label) {
  if (!value || typeof value !== "object")
    throw new TypeError(`Invalid ${label}`);
  return {
    chainId: safeInteger(value.chainId, `${label}.chainId`, { positive: true }),
    address: address(value.address, `${label}.address`),
    blockNumber: safeInteger(value.blockNumber, `${label}.blockNumber`),
    transactionHash: nonzeroBytes32(
      value.transactionHash,
      `${label}.transactionHash`,
    ),
    codeHash: nonzeroBytes32(value.codeHash, `${label}.codeHash`),
  };
}

export function validatePolicyPackage(value) {
  if (!value || typeof value !== "object")
    throw new TypeError("Invalid policy package");
  if (value.format !== "recourse-policy-package")
    throw new TypeError("Invalid policy package format");
  if (value.version !== 1)
    throw new TypeError("Unsupported policy package version");
  const supportedEvidenceKinds = value.supportedEvidenceKinds;
  if (
    !Array.isArray(supportedEvidenceKinds) ||
    supportedEvidenceKinds.length === 0
  ) {
    throw new TypeError("Invalid supportedEvidenceKinds");
  }
  if (new Set(supportedEvidenceKinds).size !== supportedEvidenceKinds.length) {
    throw new TypeError("Duplicate supportedEvidenceKinds");
  }
  supportedEvidenceKinds.forEach((kind) => {
    if (!evidenceKinds.has(kind))
      throw new TypeError("Invalid supportedEvidenceKinds");
  });
  if (!value.implementation || typeof value.implementation !== "object") {
    throw new TypeError("Invalid implementation");
  }
  const implementation = {
    chainId: safeInteger(
      value.implementation.chainId,
      "implementation.chainId",
      { positive: true },
    ),
    address: address(value.implementation.address, "implementation.address"),
    codeHash: nonzeroBytes32(
      value.implementation.codeHash,
      "implementation.codeHash",
    ),
  };
  if (!Array.isArray(value.actionAdapters))
    throw new TypeError("Invalid actionAdapters");
  const actionAdapters = value.actionAdapters.map((adapter, index) => {
    if (!adapter || typeof adapter !== "object")
      throw new TypeError(`Invalid actionAdapters[${index}]`);
    return {
      kind: nonemptyString(adapter.kind, `actionAdapters[${index}].kind`),
      chainId: safeInteger(
        adapter.chainId,
        `actionAdapters[${index}].chainId`,
        { positive: true },
      ),
      address: address(adapter.address, `actionAdapters[${index}].address`),
      codeHash: nonzeroBytes32(
        adapter.codeHash,
        `actionAdapters[${index}].codeHash`,
      ),
    };
  });
  if (!Array.isArray(value.deployments) || value.deployments.length === 0) {
    throw new TypeError("Invalid deployments");
  }
  const deployments = value.deployments.map((item, index) =>
    deployment(item, `deployments[${index}]`),
  );
  const deploymentKeys = new Set(
    deployments.map((item) => `${item.chainId}:${item.address}`),
  );
  if (deploymentKeys.size !== deployments.length)
    throw new TypeError("Duplicate deployment");
  const implementationDeployment = deployments.find(
    (item) =>
      item.chainId === implementation.chainId &&
      item.address === implementation.address,
  );
  if (
    !implementationDeployment ||
    implementationDeployment.codeHash !== implementation.codeHash
  ) {
    throw new TypeError("Implementation deployment mismatch");
  }
  if (!Array.isArray(value.audits)) throw new TypeError("Invalid audits");
  const audits = value.audits.map((audit, index) => {
    if (!audit || typeof audit !== "object")
      throw new TypeError(`Invalid audits[${index}]`);
    const auditChainId = safeInteger(
      audit.chainId,
      `audits[${index}].chainId`,
      { positive: true },
    );
    const exactDeployment = address(
      audit.deployment,
      `audits[${index}].deployment`,
    );
    const auditCodeHash = nonzeroBytes32(
      audit.codeHash,
      `audits[${index}].codeHash`,
    );
    if (
      !deployments.some(
        (item) =>
          item.chainId === auditChainId &&
          item.address === exactDeployment &&
          item.codeHash === auditCodeHash,
      )
    ) {
      throw new TypeError(`Invalid audit deployment at audits[${index}]`);
    }
    const release = nonemptyString(audit.release, `audits[${index}].release`);
    if (release !== value.release)
      throw new TypeError(`Invalid audit release at audits[${index}]`);
    return {
      auditor: address(audit.auditor, `audits[${index}].auditor`),
      release,
      chainId: auditChainId,
      deployment: exactDeployment,
      codeHash: auditCodeHash,
      reportUri: nonemptyString(audit.reportUri, `audits[${index}].reportUri`),
      reportHash: nonzeroBytes32(
        audit.reportHash,
        `audits[${index}].reportHash`,
      ),
    };
  });
  return {
    format: value.format,
    version: value.version,
    id: nonemptyString(value.id, "id"),
    name: nonemptyString(value.name, "name"),
    release: nonemptyString(value.release, "release"),
    policyKind: nonemptyString(value.policyKind, "policyKind"),
    supportedEvidenceKinds: [...supportedEvidenceKinds],
    actionAdapters,
    implementation,
    audits,
    deployments,
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

export function canonicalizePolicyPackage(value) {
  return JSON.stringify(canonical(validatePolicyPackage(value)));
}

export function hashPolicyPackage(value) {
  return keccak256(toUtf8Bytes(canonicalizePolicyPackage(value)));
}

const factoryInterface = new Interface(recourseFacilityFactoryV2Abi);
const policyInterface = new Interface(eventHistoryPolicyV1Abi);
const kernelInterface = new Interface(policyKernelV1Abi);
const facilityInterface = new Interface(recourseFacilityV2Abi);
const jobsInterface = new Interface(proofJobsV1Abi);
const policyRegistryInterface = new Interface(policyRegistryV1Abi);

export function encodeCreateFacility(value) {
  if (!value || typeof value !== "object")
    throw new TypeError("Invalid facility request");
  const asset = address(value.asset, "asset");
  const kernel = address(value.kernel, "kernel");
  const lender = address(value.lender, "lender");
  const borrower = address(value.borrower, "borrower");
  if (lender === borrower) throw new TypeError("Invalid borrower");
  const facilityLimit = positiveInteger(
    value.facilityLimit,
    "facilityLimit",
    MAX_UINT256,
  );
  const bondRequired = positiveInteger(
    value.bondRequired,
    "bondRequired",
    MAX_UINT256,
  );
  const drawFeeBps = integer(value.drawFeeBps, "drawFeeBps", 10_000n);
  const maturityBlock = integer(
    value.maturityBlock,
    "maturityBlock",
    MAX_UINT64,
  );
  const drawDelayBlocks = integer(
    value.drawDelayBlocks,
    "drawDelayBlocks",
    MAX_UINT32,
  );
  return factoryInterface.encodeFunctionData("createFacility", [
    asset,
    kernel,
    lender,
    borrower,
    facilityLimit,
    bondRequired,
    drawFeeBps,
    maturityBlock,
    drawDelayBlocks,
  ]);
}

export function encodeConfigureEventHistoryPolicy({
  facility,
  policyId,
  configuration,
}) {
  return policyInterface.encodeFunctionData("configure", [
    address(facility, "facility"),
    integer(policyId, "policyId", MAX_UINT256),
    validateEventHistoryManifest(configuration),
  ]);
}

export function encodeRegisterPolicy({ facility, policyId, evaluator }) {
  return kernelInterface.encodeFunctionData("registerPolicy", [
    address(facility, "facility"),
    integer(policyId, "policyId", MAX_UINT256),
    address(evaluator, "evaluator"),
  ]);
}

export function encodeActivateFacility(expectedPolicySet) {
  return facilityInterface.encodeFunctionData("activate", [
    nonzeroBytes32(expectedPolicySet, "expectedPolicySet"),
  ]);
}

export function encodeCreateProofJob(params) {
  if (!params || typeof params !== "object")
    throw new TypeError("Invalid proof job");
  const normalized = {
    token: address(params.token, "token"),
    facility: address(params.facility, "facility"),
    policyId: integer(params.policyId, "policyId", MAX_UINT256),
    requirementsDigest: nonzeroBytes32(
      params.requirementsDigest,
      "requirementsDigest",
    ),
    expiry: positiveInteger(params.expiry, "expiry", MAX_UINT64),
    revealWindowBlocks: positiveInteger(
      params.revealWindowBlocks,
      "revealWindowBlocks",
      MAX_UINT64,
    ),
    maxSuccessfulProofs: positiveInteger(
      params.maxSuccessfulProofs,
      "maxSuccessfulProofs",
      MAX_UINT32,
    ),
    proofReimbursement: positiveInteger(
      params.proofReimbursement,
      "proofReimbursement",
      MAX_UINT256,
    ),
    outcomeReward: positiveInteger(
      params.outcomeReward,
      "outcomeReward",
      MAX_UINT256,
    ),
    commitBond: positiveInteger(params.commitBond, "commitBond", MAX_UINT256),
    rewardOutcomeThreshold: integer(
      params.rewardOutcomeThreshold,
      "rewardOutcomeThreshold",
      4n,
    ),
  };
  const escrow =
    normalized.proofReimbursement * normalized.maxSuccessfulProofs +
    normalized.outcomeReward;
  if (escrow > MAX_UINT256) throw new RangeError("Invalid proof job escrow");
  coder.encode([proofJobParamsTuple], [normalized]);
  return jobsInterface.encodeFunctionData("createJob", [normalized]);
}

export function encodeCommitEvidence(jobId, evidenceDigest, commitment) {
  return jobsInterface.encodeFunctionData("commitEvidence", [
    positiveInteger(jobId, "jobId", MAX_UINT256),
    nonzeroBytes32(evidenceDigest, "evidenceDigest"),
    nonzeroBytes32(commitment, "commitment"),
  ]);
}

export function encodeRevealEvidence(jobId, evidenceDigest, salt, proof) {
  const normalizedEvidenceDigest = nonzeroBytes32(
    evidenceDigest,
    "evidenceDigest",
  );
  const normalizedProof = bytes(proof, "proof");
  if (keccak256(normalizedProof) !== normalizedEvidenceDigest) {
    throw new RangeError("Invalid evidenceDigest");
  }
  return jobsInterface.encodeFunctionData("revealEvidence", [
    positiveInteger(jobId, "jobId", MAX_UINT256),
    normalizedEvidenceDigest,
    bytes32(salt, "salt"),
    normalizedProof,
  ]);
}

export function encodePublishPolicyRegistryRelease(value) {
  if (!value || typeof value !== "object")
    throw new TypeError("Invalid registry release");
  const packageName = boundedUtf8String(value.packageName, "packageName", 64);
  const version = boundedUtf8String(value.version, "version", 32);
  const referenceImplementation = address(
    value.referenceImplementation,
    "referenceImplementation",
  );
  const buildArtifactHash = nonzeroBytes32(
    value.buildArtifactHash,
    "buildArtifactHash",
  );
  const referenceConstructorArgumentsHash = nonzeroBytes32(
    value.referenceConstructorArgumentsHash,
    "referenceConstructorArgumentsHash",
  );
  const metadataHash = nonzeroBytes32(value.metadataHash, "metadataHash");
  if (!Array.isArray(value.evidenceKinds) || value.evidenceKinds.length === 0) {
    throw new TypeError("Invalid evidenceKinds");
  }
  if (value.evidenceKinds.length > 3)
    throw new RangeError("Invalid evidenceKinds");
  const evidenceKinds = Array.from(value.evidenceKinds, (kind) =>
    Number(integer(kind, "evidenceKinds", 2n)),
  );
  if (new Set(evidenceKinds).size !== evidenceKinds.length) {
    throw new TypeError("Invalid evidenceKinds");
  }
  if (!Array.isArray(value.actionAdapters))
    throw new TypeError("Invalid actionAdapters");
  if (value.actionAdapters.length > 32)
    throw new RangeError("Invalid actionAdapters");
  const declarationIds = new Set();
  const actionAdapters = Array.from(value.actionAdapters, (adapter, index) => {
    if (!adapter || typeof adapter !== "object") {
      throw new TypeError(`Invalid actionAdapters[${index}]`);
    }
    const normalized = {
      adapterKind: nonzeroBytes32(
        adapter.adapterKind,
        `actionAdapters[${index}].adapterKind`,
      ),
      specificationHash: nonzeroBytes32(
        adapter.specificationHash,
        `actionAdapters[${index}].specificationHash`,
      ),
      metadataURI: boundedUtf8String(
        adapter.metadataURI,
        `actionAdapters[${index}].metadataURI`,
        256,
      ),
    };
    const declarationId = keccak256(
      coder.encode([policyRegistryActionAdapterTuple], [normalized]),
    );
    if (declarationIds.has(declarationId))
      throw new TypeError("Invalid actionAdapters");
    declarationIds.add(declarationId);
    return normalized;
  });
  return policyRegistryInterface.encodeFunctionData("publishRelease", [
    packageName,
    version,
    referenceImplementation,
    buildArtifactHash,
    referenceConstructorArgumentsHash,
    metadataHash,
    evidenceKinds,
    actionAdapters,
  ]);
}

export function encodeApprovePolicyRegistryRuntimeVariant({
  releaseId,
  implementation,
  constructorArgumentsHash,
}) {
  return policyRegistryInterface.encodeFunctionData("approveRuntimeVariant", [
    bytes32(releaseId, "releaseId"),
    address(implementation, "implementation"),
    nonzeroBytes32(constructorArgumentsHash, "constructorArgumentsHash"),
  ]);
}

export function encodeRecordPolicyRegistryDeployment({
  releaseId,
  kernel,
  facility,
  policyId,
  runtimeVariantId,
}) {
  return policyRegistryInterface.encodeFunctionData("recordDeployment", [
    bytes32(releaseId, "releaseId"),
    address(kernel, "kernel"),
    address(facility, "facility"),
    integer(policyId, "policyId", MAX_UINT256),
    bytes32(runtimeVariantId, "runtimeVariantId"),
  ]);
}

export function encodePublishPolicyRegistryAuditArtifact({
  scope,
  scopeId,
  artifactHash,
  artifactURI,
}) {
  return policyRegistryInterface.encodeFunctionData("publishAuditArtifact", [
    integer(scope, "scope", 1n),
    bytes32(scopeId, "scopeId"),
    nonzeroBytes32(artifactHash, "artifactHash"),
    boundedUtf8String(artifactURI, "artifactURI", 256),
  ]);
}

export function buildPolicyRegistryCalldata(requests) {
  if (!requests || typeof requests !== "object") {
    throw new TypeError("Invalid registry calldata requests");
  }
  const result = {};
  if (requests.publishRelease) {
    result.publishRelease = encodePublishPolicyRegistryRelease(
      requests.publishRelease,
    );
  }
  if (requests.approveRuntimeVariants !== undefined) {
    if (!Array.isArray(requests.approveRuntimeVariants)) {
      throw new TypeError("Invalid approveRuntimeVariants");
    }
    result.approveRuntimeVariants = requests.approveRuntimeVariants.map(
      encodeApprovePolicyRegistryRuntimeVariant,
    );
  }
  if (requests.recordDeployments !== undefined) {
    if (!Array.isArray(requests.recordDeployments)) {
      throw new TypeError("Invalid recordDeployments");
    }
    result.recordDeployments = requests.recordDeployments.map(
      encodeRecordPolicyRegistryDeployment,
    );
  }
  if (requests.publishAuditArtifacts !== undefined) {
    if (!Array.isArray(requests.publishAuditArtifacts)) {
      throw new TypeError("Invalid publishAuditArtifacts");
    }
    result.publishAuditArtifacts = requests.publishAuditArtifacts.map(
      encodePublishPolicyRegistryAuditArtifact,
    );
  }
  if (Object.keys(result).length === 0) {
    throw new TypeError("No registry calldata requests supplied");
  }
  return result;
}

export function buildHorizon1Calldata(requests) {
  if (!requests || typeof requests !== "object")
    throw new TypeError("Invalid calldata requests");
  const result = {};
  if (requests.createFacility)
    result.createFacility = encodeCreateFacility(requests.createFacility);
  if (requests.configurePolicy) {
    result.configurePolicy = encodeConfigureEventHistoryPolicy(
      requests.configurePolicy,
    );
  }
  if (requests.registerPolicy)
    result.registerPolicy = encodeRegisterPolicy(requests.registerPolicy);
  if (requests.activateFacility) {
    result.activateFacility = encodeActivateFacility(
      requests.activateFacility.expectedPolicySet,
    );
  }
  if (requests.createProofJob)
    result.createProofJob = encodeCreateProofJob(requests.createProofJob);
  if (requests.commitEvidence) {
    result.commitEvidence = encodeCommitEvidence(
      requests.commitEvidence.jobId,
      requests.commitEvidence.evidenceDigest,
      requests.commitEvidence.commitment,
    );
  }
  if (requests.revealEvidence) {
    result.revealEvidence = encodeRevealEvidence(
      requests.revealEvidence.jobId,
      requests.revealEvidence.evidenceDigest,
      requests.revealEvidence.salt,
      requests.revealEvidence.proof,
    );
  }
  if (Object.keys(result).length === 0)
    throw new TypeError("No calldata requests supplied");
  return result;
}
