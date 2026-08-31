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
  cappedPilotFactoryV1Abi,
  eventHistoryConfigurationTuple,
  eventHistoryPolicyV1Abi,
  multiChainConfigurationTuple,
  multiChainEventPolicyV1Abi,
  operatorMarketV1Abi,
  portfolioPoolV1Abi,
  policyKernelV1Abi,
  policyKernelV2Abi,
  policyRegistryActionAdapterTuple,
  policyRegistryV1Abi,
  proofJobParamsTuple,
  proofJobsV1Abi,
  recourseFacilityFactoryV2Abi,
  recourseFacilityV2Abi,
  recourseFacilityV3Abi,
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
export const PortfolioPoolStatus = Object.freeze({
  Configuring: 0,
  Funding: 1,
  Active: 2,
  Finalized: 3,
  Cancelled: 4,
});
export const SourceOrdering = Object.freeze({
  StrictlyIncreasing: 0,
  UniqueOnly: 1,
});
export const PortfolioPoolAllocationCode = Object.freeze({
  Eligible: 0,
  NotManager: 1,
  WrongStatus: 2,
  FundingExpired: 3,
  CandidateNotRegistered: 4,
  AllocationAlreadySettled: 5,
  InvalidFacility: 6,
  InvalidAmount: 7,
  IneligibleFacility: 8,
});
export const PilotCreationCode = Object.freeze({
  Eligible: 0,
  NotLender: 1,
  CreationPaused: 2,
  FacilityCountExceeded: 3,
  FacilityLimitExceeded: 4,
  TotalLimitExceeded: 5,
  InvalidBond: 6,
  InvalidDrawFee: 7,
  InvalidMaturity: 8,
});
export const OperatorServiceKind = Object.freeze({
  Monitoring: 0,
  ProofConstruction: 1,
  Submission: 2,
  Delivery: 3,
});
export const OperatorQuoteStatus = Object.freeze({
  Open: 0,
  Accepted: 1,
  Settled: 2,
  Cancelled: 3,
  Expired: 4,
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

function multiChainRule(value, index, watchThreshold) {
  if (!value || typeof value !== "object") {
    throw new TypeError(`Invalid rules[${index}]`);
  }
  const sourceChain = positiveInteger(
    value.sourceChain,
    `rules[${index}].sourceChain`,
    MAX_UINT64,
  );
  const startSourceBlock = integer(
    value.startSourceBlock,
    `rules[${index}].startSourceBlock`,
    MAX_UINT64,
  );
  const endSourceBlock = integer(
    value.endSourceBlock,
    `rules[${index}].endSourceBlock`,
    MAX_UINT64,
  );
  if (startSourceBlock > endSourceBlock) {
    throw new RangeError(`Invalid rules[${index}] source block range`);
  }
  const topicCount = Number(
    integer(value.topicCount, `rules[${index}].topicCount`, MAX_UINT8),
  );
  if (topicCount <= 1 || topicCount > 4) {
    throw new RangeError(`Invalid rules[${index}].topicCount`);
  }
  const subjectTopicIndex = Number(
    integer(
      value.subjectTopicIndex,
      `rules[${index}].subjectTopicIndex`,
      MAX_UINT8,
    ),
  );
  if (subjectTopicIndex === 0 || subjectTopicIndex >= topicCount) {
    throw new RangeError(`Invalid rules[${index}].subjectTopicIndex`);
  }
  const dataLength = Number(
    integer(value.dataLength, `rules[${index}].dataLength`, MAX_UINT16),
  );
  if (dataLength === 0 || dataLength % 32 !== 0) {
    throw new RangeError(`Invalid rules[${index}].dataLength`);
  }
  const observedValueOffset = Number(
    integer(
      value.observedValueOffset,
      `rules[${index}].observedValueOffset`,
      MAX_UINT16,
    ),
  );
  if (observedValueOffset % 32 !== 0 || observedValueOffset + 32 > dataLength) {
    throw new RangeError(`Invalid rules[${index}].observedValueOffset`);
  }
  const observationKind = Number(
    integer(value.observationKind, `rules[${index}].observationKind`, 4n),
  );
  const riskWeight = positiveInteger(
    value.riskWeight,
    `rules[${index}].riskWeight`,
    MAX_UINT32,
  );
  if (riskWeight < watchThreshold) {
    throw new RangeError(`Invalid rules[${index}].riskWeight`);
  }
  return {
    sourceChain,
    emitter: address(value.emitter, `rules[${index}].emitter`),
    eventSignature: nonzeroBytes32(
      value.eventSignature,
      `rules[${index}].eventSignature`,
    ),
    startSourceBlock,
    endSourceBlock,
    topicCount,
    subjectTopicIndex,
    dataLength,
    observedValueOffset,
    observationKind,
    riskWeight,
  };
}

function multiChainRulesOverlap(first, second) {
  return (
    first.sourceChain === second.sourceChain &&
    first.emitter === second.emitter &&
    first.eventSignature === second.eventSignature &&
    first.topicCount === second.topicCount &&
    first.subjectTopicIndex === second.subjectTopicIndex &&
    first.dataLength === second.dataLength &&
    first.startSourceBlock <= second.endSourceBlock &&
    second.startSourceBlock <= first.endSourceBlock
  );
}

function validateMultiChainEffects({
  watchEffect,
  restrictedEffect,
  marginEffect,
  breachEffect,
}) {
  const valid =
    watchEffect.outcome === PolicyOutcome.Watch &&
    restrictedEffect.outcome === PolicyOutcome.Restricted &&
    marginEffect.outcome === PolicyOutcome.MarginCalled &&
    breachEffect.outcome === PolicyOutcome.Breached &&
    restrictedEffect.creditLimitBps <= watchEffect.creditLimitBps &&
    marginEffect.creditLimitBps <= restrictedEffect.creditLimitBps &&
    breachEffect.creditLimitBps <= marginEffect.creditLimitBps &&
    watchEffect.futureDrawFeeBps <= restrictedEffect.futureDrawFeeBps &&
    restrictedEffect.futureDrawFeeBps <= marginEffect.futureDrawFeeBps &&
    marginEffect.futureDrawFeeBps <= breachEffect.futureDrawFeeBps &&
    !watchEffect.terminate &&
    !restrictedEffect.terminate &&
    (!watchEffect.freezePendingDraw || restrictedEffect.freezePendingDraw) &&
    (!restrictedEffect.freezePendingDraw || marginEffect.freezePendingDraw) &&
    (!marginEffect.freezePendingDraw || breachEffect.freezePendingDraw) &&
    (!watchEffect.requireFreshEvidence ||
      restrictedEffect.requireFreshEvidence) &&
    (!restrictedEffect.requireFreshEvidence ||
      marginEffect.requireFreshEvidence) &&
    (!marginEffect.requireFreshEvidence || breachEffect.requireFreshEvidence) &&
    (!marginEffect.terminate || breachEffect.terminate);
  if (!valid) throw new RangeError("Invalid multi-chain effects");
}

export function validateMultiChainConfiguration(value) {
  if (!value || typeof value !== "object") {
    throw new TypeError("Invalid multi-chain configuration");
  }
  const freshnessPeriod = positiveInteger(
    value.freshnessPeriod,
    "freshnessPeriod",
    MAX_UINT64,
  );
  const watchThreshold = positiveInteger(
    value.watchThreshold,
    "watchThreshold",
    MAX_UINT32,
  );
  const restrictedThreshold = positiveInteger(
    value.restrictedThreshold,
    "restrictedThreshold",
    MAX_UINT32,
  );
  const marginThreshold = positiveInteger(
    value.marginThreshold,
    "marginThreshold",
    MAX_UINT32,
  );
  const breachThreshold = positiveInteger(
    value.breachThreshold,
    "breachThreshold",
    MAX_UINT32,
  );
  if (
    watchThreshold >= restrictedThreshold ||
    restrictedThreshold >= marginThreshold ||
    marginThreshold >= breachThreshold
  ) {
    throw new RangeError("Invalid multi-chain thresholds");
  }
  const effects = {
    watchEffect: policyEffect(value.watchEffect),
    restrictedEffect: policyEffect(value.restrictedEffect),
    marginEffect: policyEffect(value.marginEffect),
    breachEffect: policyEffect(value.breachEffect),
  };
  validateMultiChainEffects(effects);
  if (
    !Array.isArray(value.rules) ||
    value.rules.length === 0 ||
    value.rules.length > 16
  ) {
    throw new RangeError("Invalid multi-chain rules");
  }
  const rules = value.rules.map((rule, index) =>
    multiChainRule(rule, index, watchThreshold),
  );
  for (let index = 0; index < rules.length; index += 1) {
    for (let prior = 0; prior < index; prior += 1) {
      if (multiChainRulesOverlap(rules[prior], rules[index])) {
        throw new RangeError(`Multi-chain rules ${prior} and ${index} overlap`);
      }
    }
  }
  return {
    subject: address(value.subject, "subject"),
    freshnessPeriod,
    watchThreshold,
    restrictedThreshold,
    marginThreshold,
    breachThreshold,
    ...effects,
    rules,
  };
}

export function encodeMultiChainConfiguration(value) {
  return coder.encode(
    [multiChainConfigurationTuple],
    [validateMultiChainConfiguration(value)],
  );
}

export function hashMultiChainConfiguration(value) {
  return keccak256(encodeMultiChainConfiguration(value));
}

export function decodeMultiChainConfiguration(configurationBytes) {
  const encoded = bytes(configurationBytes, "configurationBytes");
  let decoded;
  try {
    [decoded] = coder.decode([multiChainConfigurationTuple], encoded);
  } catch {
    throw new TypeError("Invalid configurationBytes");
  }
  const configuration = validateMultiChainConfiguration({
    subject: decoded.subject,
    freshnessPeriod: decoded.freshnessPeriod,
    watchThreshold: decoded.watchThreshold,
    restrictedThreshold: decoded.restrictedThreshold,
    marginThreshold: decoded.marginThreshold,
    breachThreshold: decoded.breachThreshold,
    watchEffect: decoded.watchEffect,
    restrictedEffect: decoded.restrictedEffect,
    marginEffect: decoded.marginEffect,
    breachEffect: decoded.breachEffect,
    rules: decoded.rules,
  });
  if (encodeMultiChainConfiguration(configuration).toLowerCase() !== encoded) {
    throw new TypeError(
      "Multi-chain configurationBytes are not canonical ABI encoding",
    );
  }
  return configuration;
}

export function simulateMultiChainRisk({
  configuration,
  currentScore,
  ruleMatchCounts,
}) {
  const normalized = validateMultiChainConfiguration(configuration);
  const priorScore = integer(currentScore, "currentScore", MAX_UINT32);
  if (
    !Array.isArray(ruleMatchCounts) ||
    ruleMatchCounts.length !== normalized.rules.length
  ) {
    throw new TypeError("Invalid ruleMatchCounts");
  }
  let newScore = priorScore;
  const matchedRuleIndexes = [];
  for (const [index, value] of ruleMatchCounts.entries()) {
    const count = integer(value, `ruleMatchCounts[${index}]`, MAX_UINT256);
    if (count === 0n) continue;
    matchedRuleIndexes.push(index);
    const weight = normalized.rules[index].riskWeight;
    const remaining = MAX_UINT32 - newScore;
    newScore =
      count > remaining / weight ? MAX_UINT32 : newScore + weight * count;
  }
  if (matchedRuleIndexes.length === 0) {
    throw new RangeError("Irrelevant evidence");
  }
  const effect =
    newScore >= normalized.breachThreshold
      ? normalized.breachEffect
      : newScore >= normalized.marginThreshold
        ? normalized.marginEffect
        : newScore >= normalized.restrictedThreshold
          ? normalized.restrictedEffect
          : normalized.watchEffect;
  return { priorScore, newScore, matchedRuleIndexes, effect };
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

export function simulateCappedPilotFacilityCreation({
  factory,
  request,
  sender,
  blockNumber,
}) {
  if (!factory || typeof factory !== "object")
    throw new TypeError("Invalid factory");
  if (!request || typeof request !== "object")
    throw new TypeError("Invalid facility request");
  const lender = address(factory.lender, "factory.lender");
  const caller = address(sender, "sender");
  if (typeof factory.creationPaused !== "boolean") {
    throw new TypeError("Invalid factory.creationPaused");
  }
  const facilityCount = integer(
    factory.facilityCount,
    "factory.facilityCount",
    MAX_UINT256,
  );
  const totalFacilityLimit = integer(
    factory.totalFacilityLimit,
    "factory.totalFacilityLimit",
    MAX_UINT256,
  );
  const maximumFacilityLimit = positiveInteger(
    factory.maximumFacilityLimit,
    "factory.maximumFacilityLimit",
    MAX_UINT256,
  );
  const maximumTotalLimit = positiveInteger(
    factory.maximumTotalLimit,
    "factory.maximumTotalLimit",
    MAX_UINT256,
  );
  const minimumBondBps = positiveInteger(
    factory.minimumBondBps,
    "factory.minimumBondBps",
    10_000n,
  );
  const maximumDrawFeeBps = integer(
    factory.maximumDrawFeeBps,
    "factory.maximumDrawFeeBps",
    10_000n,
  );
  const maximumMaturityBlocks = positiveInteger(
    factory.maximumMaturityBlocks,
    "factory.maximumMaturityBlocks",
    MAX_UINT64,
  );
  const maximumDrawDelayBlocks = integer(
    factory.maximumDrawDelayBlocks,
    "factory.maximumDrawDelayBlocks",
    MAX_UINT32,
  );
  const maximumFacilityCount = positiveInteger(
    factory.maximumFacilityCount,
    "factory.maximumFacilityCount",
    MAX_UINT16,
  );
  const facilityLimit = integer(
    request.facilityLimit,
    "request.facilityLimit",
    MAX_UINT256,
  );
  const bondRequired = integer(
    request.bondRequired,
    "request.bondRequired",
    MAX_UINT256,
  );
  const drawFeeBps = integer(
    request.drawFeeBps,
    "request.drawFeeBps",
    MAX_UINT16,
  );
  const maturityBlock = integer(
    request.maturityBlock,
    "request.maturityBlock",
    MAX_UINT64,
  );
  const drawDelayBlocks = integer(
    request.drawDelayBlocks,
    "request.drawDelayBlocks",
    MAX_UINT32,
  );
  const currentBlock = integer(blockNumber, "blockNumber", MAX_UINT256);
  const minimumBond = (facilityLimit * minimumBondBps + 9_999n) / 10_000n;
  const totalFacilityLimitAfter = totalFacilityLimit + facilityLimit;
  let code = PilotCreationCode.Eligible;
  if (caller !== lender) code = PilotCreationCode.NotLender;
  else if (factory.creationPaused) code = PilotCreationCode.CreationPaused;
  else if (facilityCount >= maximumFacilityCount) {
    code = PilotCreationCode.FacilityCountExceeded;
  } else if (facilityLimit === 0n || facilityLimit > maximumFacilityLimit) {
    code = PilotCreationCode.FacilityLimitExceeded;
  } else if (
    totalFacilityLimitAfter > MAX_UINT256 ||
    totalFacilityLimitAfter > maximumTotalLimit
  ) {
    code = PilotCreationCode.TotalLimitExceeded;
  } else if (bondRequired < minimumBond) code = PilotCreationCode.InvalidBond;
  else if (drawFeeBps > maximumDrawFeeBps) {
    code = PilotCreationCode.InvalidDrawFee;
  } else if (
    maturityBlock <= currentBlock ||
    maturityBlock > currentBlock + maximumMaturityBlocks ||
    drawDelayBlocks > maximumDrawDelayBlocks
  ) {
    code = PilotCreationCode.InvalidMaturity;
  }
  return { code, minimumBond, totalFacilityLimitAfter };
}

export function simulateDefaultLossSettlement({
  lender,
  sender,
  status,
  maturityBlock,
  blockNumber,
  bondPosted,
  outstandingDebt,
  lenderClaimable,
  borrowerClaimable,
}) {
  const expectedLender = address(lender, "lender");
  const caller = address(sender, "sender");
  if (caller !== expectedLender) throw new RangeError("Sender is not lender");
  const facilityStatus = Number(integer(status, "status", 5n));
  if (
    facilityStatus !== FacilityStatus.Defaulted &&
    facilityStatus !== FacilityStatus.Terminated
  ) {
    throw new RangeError("Facility is not defaulted or terminated");
  }
  if (facilityStatus === FacilityStatus.Terminated) {
    const maturity = integer(maturityBlock, "maturityBlock", MAX_UINT64);
    const currentBlock = integer(blockNumber, "blockNumber", MAX_UINT256);
    if (currentBlock <= maturity) {
      throw new RangeError("Terminated facility settlement is not ready");
    }
  }
  const bond = positiveInteger(bondPosted, "bondPosted", MAX_UINT256);
  const debt = integer(outstandingDebt, "outstandingDebt", MAX_UINT256);
  const currentLenderClaimable = integer(
    lenderClaimable,
    "lenderClaimable",
    MAX_UINT256,
  );
  const currentBorrowerClaimable = integer(
    borrowerClaimable,
    "borrowerClaimable",
    MAX_UINT256,
  );
  const lenderRecovery = bond > debt ? debt : bond;
  const borrowerExcess = bond - lenderRecovery;
  if (
    currentLenderClaimable + lenderRecovery > MAX_UINT256 ||
    currentBorrowerClaimable + borrowerExcess > MAX_UINT256
  ) {
    throw new RangeError("Default-loss claimable overflow");
  }
  return {
    lenderRecovery,
    borrowerExcess,
    bondPosted: 0n,
    outstandingDebt: debt - lenderRecovery,
    lenderClaimable: currentLenderClaimable + lenderRecovery,
    borrowerClaimable: currentBorrowerClaimable + borrowerExcess,
  };
}

export function simulatePortfolioPoolAllocation({
  pool,
  allocation,
  facility,
  sender,
  timestamp,
  amount,
  mandateEligibilityCode,
}) {
  if (!pool || typeof pool !== "object") throw new TypeError("Invalid pool");
  if (!allocation || typeof allocation !== "object") {
    throw new TypeError("Invalid allocation");
  }
  if (!facility || typeof facility !== "object") {
    throw new TypeError("Invalid facility");
  }
  const poolAddress = address(pool.address, "pool.address");
  const manager = address(pool.manager, "pool.manager");
  const caller = address(sender, "sender");
  const status = Number(integer(pool.status, "pool.status", 4n));
  const fundingDeadline = integer(
    pool.fundingDeadline,
    "pool.fundingDeadline",
    MAX_UINT64,
  );
  const assetBalance = integer(
    pool.assetBalance,
    "pool.assetBalance",
    MAX_UINT256,
  );
  const totalAllocatedPrincipal = integer(
    pool.totalAllocatedPrincipal,
    "pool.totalAllocatedPrincipal",
    MAX_UINT256,
  );
  const allocatedFacilityCount = integer(
    pool.allocatedFacilityCount,
    "pool.allocatedFacilityCount",
    MAX_UINT256,
  );
  if (
    typeof allocation.registered !== "boolean" ||
    typeof allocation.settled !== "boolean"
  ) {
    throw new TypeError("Invalid allocation state");
  }
  const allocationPrincipal = integer(
    allocation.principal,
    "allocation.principal",
    MAX_UINT256,
  );
  const facilityLender = address(facility.lender, "facility.lender");
  const facilityLimit = integer(
    facility.facilityLimit,
    "facility.facilityLimit",
    MAX_UINT256,
  );
  const lenderFunded = integer(
    facility.lenderFunded,
    "facility.lenderFunded",
    MAX_UINT256,
  );
  const bondRequired = integer(
    facility.bondRequired,
    "facility.bondRequired",
    MAX_UINT256,
  );
  const bondPosted = integer(
    facility.bondPosted,
    "facility.bondPosted",
    MAX_UINT256,
  );
  const currentTimestamp = integer(timestamp, "timestamp", MAX_UINT256);
  const requestedAmount = integer(amount, "amount", MAX_UINT256);
  const eligibilityCode = Number(
    integer(mandateEligibilityCode, "mandateEligibilityCode", 13n),
  );

  let code = PortfolioPoolAllocationCode.Eligible;
  if (caller !== manager) code = PortfolioPoolAllocationCode.NotManager;
  else if (status !== PortfolioPoolStatus.Active) {
    code = PortfolioPoolAllocationCode.WrongStatus;
  } else if (currentTimestamp >= fundingDeadline) {
    code = PortfolioPoolAllocationCode.FundingExpired;
  } else if (!allocation.registered) {
    code = PortfolioPoolAllocationCode.CandidateNotRegistered;
  } else if (allocation.settled) {
    code = PortfolioPoolAllocationCode.AllocationAlreadySettled;
  } else if (facilityLender !== poolAddress) {
    code = PortfolioPoolAllocationCode.InvalidFacility;
  } else if (
    requestedAmount !== facilityLimit ||
    lenderFunded !== 0n ||
    requestedAmount > assetBalance
  ) {
    code = PortfolioPoolAllocationCode.InvalidAmount;
  } else if (bondPosted !== bondRequired) {
    code = PortfolioPoolAllocationCode.InvalidFacility;
  } else if (eligibilityCode !== PortfolioEligibilityCode.Eligible) {
    code = PortfolioPoolAllocationCode.IneligibleFacility;
  }

  if (code !== PortfolioPoolAllocationCode.Eligible) {
    return {
      code,
      allocationPrincipalAfter: allocationPrincipal,
      totalAllocatedPrincipalAfter: totalAllocatedPrincipal,
      allocatedFacilityCountAfter: allocatedFacilityCount,
    };
  }
  if (
    allocationPrincipal + requestedAmount > MAX_UINT256 ||
    totalAllocatedPrincipal + requestedAmount > MAX_UINT256 ||
    (allocationPrincipal === 0n && allocatedFacilityCount === MAX_UINT256)
  ) {
    throw new RangeError("Portfolio allocation overflow");
  }
  return {
    code,
    allocationPrincipalAfter: allocationPrincipal + requestedAmount,
    totalAllocatedPrincipalAfter: totalAllocatedPrincipal + requestedAmount,
    allocatedFacilityCountAfter:
      allocatedFacilityCount + (allocationPrincipal === 0n ? 1n : 0n),
  };
}

export function simulatePortfolioPoolDistribution({
  assetBalance,
  totalDistributed,
  totalClaimed,
  totalSupply,
  investors,
}) {
  const balance = integer(assetBalance, "assetBalance", MAX_UINT256);
  const distributed = integer(
    totalDistributed,
    "totalDistributed",
    MAX_UINT256,
  );
  const claimed = integer(totalClaimed, "totalClaimed", MAX_UINT256);
  const supply = integer(totalSupply, "totalSupply", MAX_UINT256);
  if (!Array.isArray(investors) || investors.length > 64) {
    throw new TypeError("Invalid investors");
  }
  if (claimed > distributed) {
    throw new RangeError("Invalid portfolio distribution accounting");
  }
  const reserved = distributed - claimed;
  if (balance < reserved) {
    throw new RangeError("Invalid portfolio distribution accounting");
  }
  const normalizedInvestors = investors.map((investor, index) => {
    if (!investor || typeof investor !== "object") {
      throw new TypeError(`Invalid investors[${index}]`);
    }
    return {
      account: address(investor.account, `investors[${index}].account`),
      shares: integer(
        investor.shares,
        `investors[${index}].shares`,
        MAX_UINT256,
      ),
      claimable: integer(
        investor.claimable,
        `investors[${index}].claimable`,
        MAX_UINT256,
      ),
    };
  });
  if (
    new Set(normalizedInvestors.map((investor) => investor.account)).size !==
    normalizedInvestors.length
  ) {
    throw new TypeError("Invalid investors");
  }
  const amount = balance - reserved;
  if (amount === 0n) {
    return {
      amount,
      reserved,
      totalDistributedAfter: distributed,
      investors: normalizedInvestors.map(({ account, claimable }) => ({
        account,
        amount: 0n,
        claimableAfter: claimable,
      })),
    };
  }
  if (supply === 0n) {
    throw new RangeError("Invalid portfolio distribution supply");
  }
  const shareTotal = normalizedInvestors.reduce(
    (total, investor) => total + investor.shares,
    0n,
  );
  const claimableTotal = normalizedInvestors.reduce(
    (total, investor) => total + investor.claimable,
    0n,
  );
  if (shareTotal !== supply || claimableTotal !== reserved) {
    throw new RangeError("Incomplete portfolio investor state");
  }
  const allocations = normalizedInvestors.map((investor) => ({
    account: investor.account,
    amount: (amount * investor.shares) / supply,
    remainder: (amount * investor.shares) % supply,
    claimable: investor.claimable,
  }));
  const assigned = allocations.reduce(
    (total, allocation) => total + allocation.amount,
    0n,
  );
  let remaining = amount - assigned;
  while (remaining > 0n) {
    let selected = -1;
    let largestRemainder = 0n;
    for (let index = 0; index < allocations.length; index += 1) {
      if (allocations[index].remainder > largestRemainder) {
        selected = index;
        largestRemainder = allocations[index].remainder;
      }
    }
    if (selected === -1) {
      throw new RangeError("Invalid portfolio distribution accounting");
    }
    allocations[selected].amount += 1n;
    allocations[selected].remainder = 0n;
    remaining -= 1n;
  }
  if (distributed + amount > MAX_UINT256) {
    throw new RangeError("Portfolio distribution overflow");
  }
  return {
    amount,
    reserved,
    totalDistributedAfter: distributed + amount,
    investors: allocations.map(
      ({ account, amount: investorAmount, claimable }) => ({
        account,
        amount: investorAmount,
        claimableAfter: claimable + investorAmount,
      }),
    ),
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
const cappedPilotFactoryInterface = new Interface(cappedPilotFactoryV1Abi);
const facilityV3Interface = new Interface(recourseFacilityV3Abi);
const kernelV2Interface = new Interface(policyKernelV2Abi);
const multiChainPolicyInterface = new Interface(multiChainEventPolicyV1Abi);
const operatorMarketInterface = new Interface(operatorMarketV1Abi);
const portfolioPoolInterface = new Interface(portfolioPoolV1Abi);

function cappedPilotFacilityRequest(value) {
  if (!value || typeof value !== "object") {
    throw new TypeError("Invalid capped pilot facility request");
  }
  return {
    facilityLimit: positiveInteger(
      value.facilityLimit,
      "facilityLimit",
      MAX_UINT256,
    ),
    bondRequired: positiveInteger(
      value.bondRequired,
      "bondRequired",
      MAX_UINT256,
    ),
    drawFeeBps: integer(value.drawFeeBps, "drawFeeBps", 10_000n),
    maturityBlock: positiveInteger(
      value.maturityBlock,
      "maturityBlock",
      MAX_UINT64,
    ),
    drawDelayBlocks: integer(
      value.drawDelayBlocks,
      "drawDelayBlocks",
      MAX_UINT32,
    ),
  };
}

function operatorQuoteRequest(value) {
  if (!value || typeof value !== "object") {
    throw new TypeError("Invalid operator quote");
  }
  return {
    serviceKind: Number(integer(value.serviceKind, "serviceKind", 3n)),
    requirementsDigest: nonzeroBytes32(
      value.requirementsDigest,
      "requirementsDigest",
    ),
    price: positiveInteger(value.price, "price", MAX_UINT256),
    operatorBond: positiveInteger(
      value.operatorBond,
      "operatorBond",
      MAX_UINT256,
    ),
    quoteExpiry: positiveInteger(value.quoteExpiry, "quoteExpiry", MAX_UINT64),
    serviceDuration: positiveInteger(
      value.serviceDuration,
      "serviceDuration",
      MAX_UINT64,
    ),
  };
}

export function computeOperatorAgreementId({
  market,
  chainId,
  quoteId,
  sponsor,
  quote,
}) {
  const normalized = operatorQuoteRequest(quote);
  return keccak256(
    coder.encode(
      [
        "address",
        "uint256",
        "uint256",
        "address",
        "address",
        "uint8",
        "bytes32",
        "uint256",
        "uint256",
        "uint64",
        "uint64",
      ],
      [
        address(market, "market"),
        positiveInteger(chainId, "chainId", MAX_UINT256),
        integer(quoteId, "quoteId", MAX_UINT256),
        address(quote.operator, "quote.operator"),
        address(sponsor, "sponsor"),
        normalized.serviceKind,
        normalized.requirementsDigest,
        normalized.price,
        normalized.operatorBond,
        normalized.quoteExpiry,
        normalized.serviceDuration,
      ],
    ),
  );
}

export function encodeCreateCappedPilotFacility(value) {
  const request = cappedPilotFacilityRequest(value);
  return cappedPilotFactoryInterface.encodeFunctionData("createFacility", [
    request.facilityLimit,
    request.bondRequired,
    request.drawFeeBps,
    request.maturityBlock,
    request.drawDelayBlocks,
  ]);
}

export function encodeSetCappedPilotCreationPaused(paused) {
  if (typeof paused !== "boolean") throw new TypeError("Invalid paused");
  return cappedPilotFactoryInterface.encodeFunctionData("setCreationPaused", [
    paused,
  ]);
}

export function encodeConfigureMultiChainPolicy({
  facility,
  policyId,
  configuration,
}) {
  return multiChainPolicyInterface.encodeFunctionData("configure", [
    address(facility, "facility"),
    integer(policyId, "policyId", MAX_UINT256),
    validateMultiChainConfiguration(configuration),
  ]);
}

export function encodeSetPolicyKernelV2ProofJobs(proofJobs) {
  return kernelV2Interface.encodeFunctionData("setProofJobs", [
    address(proofJobs, "proofJobs"),
  ]);
}

export function encodeFundFacility(amount) {
  return facilityV3Interface.encodeFunctionData("fundAsLender", [
    positiveInteger(amount, "amount", MAX_UINT256),
  ]);
}

export function encodePostFacilityBond(amount) {
  return facilityV3Interface.encodeFunctionData("postBond", [
    positiveInteger(amount, "amount", MAX_UINT256),
  ]);
}

export function encodeRequestFacilityDraw(amount) {
  return facilityV3Interface.encodeFunctionData("requestDraw", [
    positiveInteger(amount, "amount", MAX_UINT256),
  ]);
}

export function encodeExecuteFacilityDraw() {
  return facilityV3Interface.encodeFunctionData("executeDraw");
}

export function encodeRepayFacility(amount) {
  return facilityV3Interface.encodeFunctionData("repay", [
    positiveInteger(amount, "amount", MAX_UINT256),
  ]);
}

export function encodeMarkFacilityDefaulted() {
  return facilityV3Interface.encodeFunctionData("markDefaulted");
}

export function encodeCancelFacility() {
  return facilityV3Interface.encodeFunctionData("cancel");
}

export function encodeLenderWithdraw() {
  return facilityV3Interface.encodeFunctionData("lenderWithdraw");
}

export function encodeClaimBorrowerRefund() {
  return facilityV3Interface.encodeFunctionData("claimBorrowerRefund");
}

export function encodeSetFacilityDrawPaused(paused) {
  if (typeof paused !== "boolean") throw new TypeError("Invalid paused");
  return facilityV3Interface.encodeFunctionData("setDrawPaused", [paused]);
}

export function encodeSettleDefaultLoss() {
  return facilityV3Interface.encodeFunctionData("settleDefaultLoss");
}

export function encodePostOperatorQuote(value) {
  const quote = operatorQuoteRequest(value);
  return operatorMarketInterface.encodeFunctionData("postQuote", [
    quote.serviceKind,
    quote.requirementsDigest,
    quote.price,
    quote.operatorBond,
    quote.quoteExpiry,
    quote.serviceDuration,
  ]);
}

export function encodeAcceptOperatorQuote(quoteId) {
  return operatorMarketInterface.encodeFunctionData("acceptQuote", [
    integer(quoteId, "quoteId", MAX_UINT256),
  ]);
}

export function encodeSettleOperatorQuote(quoteId, deliveryDigest, evidence) {
  return operatorMarketInterface.encodeFunctionData("settle", [
    integer(quoteId, "quoteId", MAX_UINT256),
    nonzeroBytes32(deliveryDigest, "deliveryDigest"),
    bytes(evidence, "evidence"),
  ]);
}

export function encodeCancelOperatorQuote(quoteId) {
  return operatorMarketInterface.encodeFunctionData("cancelQuote", [
    integer(quoteId, "quoteId", MAX_UINT256),
  ]);
}

export function encodeExpireOperatorQuote(quoteId) {
  return operatorMarketInterface.encodeFunctionData("expireQuote", [
    integer(quoteId, "quoteId", MAX_UINT256),
  ]);
}

export function encodeOperatorWithdrawal() {
  return operatorMarketInterface.encodeFunctionData("withdraw");
}

export function encodeSetPortfolioPoolMandate(mandate) {
  return portfolioPoolInterface.encodeFunctionData("setMandate", [
    address(mandate, "mandate"),
  ]);
}

export function encodeCreatePortfolioPoolFacility(value) {
  const request = cappedPilotFacilityRequest(value);
  return portfolioPoolInterface.encodeFunctionData("createFacility", [
    request.facilityLimit,
    request.bondRequired,
    request.drawFeeBps,
    request.maturityBlock,
    request.drawDelayBlocks,
  ]);
}

export function encodeConfigureAndRegisterPortfolioPoolPolicy({
  facility,
  policyId,
  evaluator,
  configurationCall,
}) {
  const call = bytes(configurationCall, "configurationCall");
  if ((call.length - 2) / 2 < 4) {
    throw new RangeError("Invalid configurationCall");
  }
  return portfolioPoolInterface.encodeFunctionData(
    "configureAndRegisterPolicy",
    [
      address(facility, "facility"),
      integer(policyId, "policyId", MAX_UINT256),
      address(evaluator, "evaluator"),
      call,
    ],
  );
}

export function encodeAuthorizePortfolioPoolRemedyPolicy({
  facility,
  policyId,
  coordinator,
}) {
  return portfolioPoolInterface.encodeFunctionData("authorizeRemedyPolicy", [
    address(facility, "facility"),
    integer(policyId, "policyId", MAX_UINT256),
    address(coordinator, "coordinator"),
  ]);
}

export function encodePublishPortfolioPoolRemedyIntent({
  facility,
  policyId,
  actionData,
}) {
  return portfolioPoolInterface.encodeFunctionData("publishRemedyIntent", [
    address(facility, "facility"),
    integer(policyId, "policyId", MAX_UINT256),
    bytes(actionData, "actionData"),
  ]);
}

export function encodeReplacePortfolioPoolRemedyIntent({ facility, policyId }) {
  return portfolioPoolInterface.encodeFunctionData("replaceRemedyIntent", [
    address(facility, "facility"),
    integer(policyId, "policyId", MAX_UINT256),
  ]);
}

export function encodeRegisterPortfolioPoolCandidate({
  facility,
  deploymentId,
}) {
  return portfolioPoolInterface.encodeFunctionData("registerCandidate", [
    address(facility, "facility"),
    nonzeroBytes32(deploymentId, "deploymentId"),
  ]);
}

export function encodeRegisterPortfolioPoolInvestor(investor) {
  return portfolioPoolInterface.encodeFunctionData("registerInvestor", [
    address(investor, "investor"),
  ]);
}

export function encodeSetPortfolioPoolProofJobsVenue(proofJobs) {
  return portfolioPoolInterface.encodeFunctionData("setProofJobsVenue", [
    address(proofJobs, "proofJobs"),
  ]);
}

export function encodeOpenPortfolioPoolFunding() {
  return portfolioPoolInterface.encodeFunctionData("openFunding");
}

export function encodePortfolioPoolDeposit(amount) {
  return portfolioPoolInterface.encodeFunctionData("deposit", [
    positiveInteger(amount, "amount", MAX_UINT256),
  ]);
}

export function encodePortfolioPoolFundingWithdrawal(amount) {
  return portfolioPoolInterface.encodeFunctionData("withdrawFunding", [
    positiveInteger(amount, "amount", MAX_UINT256),
  ]);
}

export function encodeCancelPortfolioPoolFunding() {
  return portfolioPoolInterface.encodeFunctionData("cancelFunding");
}

export function encodeActivatePortfolioPool() {
  return portfolioPoolInterface.encodeFunctionData("activate");
}

export function encodePortfolioPoolAllocation(facility, amount) {
  return portfolioPoolInterface.encodeFunctionData("allocate", [
    address(facility, "facility"),
    positiveInteger(amount, "amount", MAX_UINT256),
  ]);
}

export function encodeSetPortfolioPoolFacilityDrawPaused(facility, paused) {
  if (typeof paused !== "boolean") throw new TypeError("Invalid paused");
  return portfolioPoolInterface.encodeFunctionData("setFacilityDrawPaused", [
    address(facility, "facility"),
    paused,
  ]);
}

export function encodeCreatePortfolioPoolProofJob(params) {
  return portfolioPoolInterface.encodeFunctionData("createProofJob", [
    normalizeProofJobParams(params),
  ]);
}

export function encodeRecoverPortfolioPoolProofJobFunds() {
  return portfolioPoolInterface.encodeFunctionData("recoverProofJobFunds");
}

export function encodeHarvestPortfolioPoolFacility(facility) {
  return portfolioPoolInterface.encodeFunctionData("harvest", [
    address(facility, "facility"),
  ]);
}

export function encodeSettlePortfolioPoolAllocation(facility) {
  return portfolioPoolInterface.encodeFunctionData("settleAllocation", [
    address(facility, "facility"),
  ]);
}

export function encodeFinalizePortfolioPool() {
  return portfolioPoolInterface.encodeFunctionData("finalize");
}

export function encodeDistributePortfolioPoolAvailable() {
  return portfolioPoolInterface.encodeFunctionData("distributeAvailable");
}

export function encodeClaimPortfolioPoolAssets() {
  return portfolioPoolInterface.encodeFunctionData("claim");
}

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

function normalizeProofJobParams(params) {
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
  return normalized;
}

export function encodeCreateProofJob(params) {
  const normalized = normalizeProofJobParams(params);
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

export function encodeSlashExpiredProofCommit(jobId, hunter) {
  return jobsInterface.encodeFunctionData("slashExpiredCommit", [
    positiveInteger(jobId, "jobId", MAX_UINT256),
    address(hunter, "hunter"),
  ]);
}

export function encodeReleaseProofCommit(jobId) {
  return jobsInterface.encodeFunctionData("releaseCommit", [
    positiveInteger(jobId, "jobId", MAX_UINT256),
  ]);
}

export function encodeFinalizeExpiredProofJob(jobId) {
  return jobsInterface.encodeFunctionData("finalizeExpired", [
    positiveInteger(jobId, "jobId", MAX_UINT256),
  ]);
}

export function encodeClaimProofJobs(token) {
  return jobsInterface.encodeFunctionData("claim", [address(token, "token")]);
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

export function buildV3Calldata(requests) {
  if (!requests || typeof requests !== "object") {
    throw new TypeError("Invalid V3 calldata requests");
  }
  const result = {};
  if (requests.createPilotFacility) {
    result.createPilotFacility = encodeCreateCappedPilotFacility(
      requests.createPilotFacility,
    );
  }
  if (requests.setCreationPaused !== undefined) {
    result.setCreationPaused = encodeSetCappedPilotCreationPaused(
      requests.setCreationPaused,
    );
  }
  if (requests.configureMultiChainPolicy) {
    result.configureMultiChainPolicy = encodeConfigureMultiChainPolicy(
      requests.configureMultiChainPolicy,
    );
  }
  if (requests.registerPolicy) {
    result.registerPolicy = encodeRegisterPolicy(requests.registerPolicy);
  }
  if (requests.setProofJobs) {
    result.setProofJobs = encodeSetPolicyKernelV2ProofJobs(
      requests.setProofJobs.proofJobs,
    );
  }
  if (requests.fundFacility) {
    result.fundFacility = encodeFundFacility(requests.fundFacility.amount);
  }
  if (requests.postFacilityBond) {
    result.postFacilityBond = encodePostFacilityBond(
      requests.postFacilityBond.amount,
    );
  }
  if (requests.activateFacility) {
    result.activateFacility = encodeActivateFacility(
      requests.activateFacility.expectedPolicySet,
    );
  }
  if (requests.requestFacilityDraw) {
    result.requestFacilityDraw = encodeRequestFacilityDraw(
      requests.requestFacilityDraw.amount,
    );
  }
  for (const [key, encode] of [
    ["executeFacilityDraw", encodeExecuteFacilityDraw],
    ["markFacilityDefaulted", encodeMarkFacilityDefaulted],
    ["cancelFacility", encodeCancelFacility],
    ["lenderWithdraw", encodeLenderWithdraw],
    ["claimBorrowerRefund", encodeClaimBorrowerRefund],
    ["settleDefaultLoss", encodeSettleDefaultLoss],
    ["withdrawOperatorClaim", encodeOperatorWithdrawal],
  ]) {
    if (requests[key] === true) result[key] = encode();
    else if (requests[key] !== undefined && requests[key] !== false) {
      throw new TypeError(`Invalid ${key}`);
    }
  }
  if (requests.repayFacility) {
    result.repayFacility = encodeRepayFacility(requests.repayFacility.amount);
  }
  if (requests.setFacilityDrawPaused !== undefined) {
    result.setFacilityDrawPaused = encodeSetFacilityDrawPaused(
      requests.setFacilityDrawPaused,
    );
  }
  if (requests.createProofJob) {
    result.createProofJob = encodeCreateProofJob(requests.createProofJob);
  }
  if (requests.slashExpiredProofCommit) {
    result.slashExpiredProofCommit = encodeSlashExpiredProofCommit(
      requests.slashExpiredProofCommit.jobId,
      requests.slashExpiredProofCommit.hunter,
    );
  }
  if (requests.releaseProofCommit) {
    result.releaseProofCommit = encodeReleaseProofCommit(
      requests.releaseProofCommit.jobId,
    );
  }
  if (requests.finalizeExpiredProofJob) {
    result.finalizeExpiredProofJob = encodeFinalizeExpiredProofJob(
      requests.finalizeExpiredProofJob.jobId,
    );
  }
  if (requests.claimProofJobs) {
    result.claimProofJobs = encodeClaimProofJobs(requests.claimProofJobs.token);
  }
  if (requests.postOperatorQuote) {
    result.postOperatorQuote = encodePostOperatorQuote(
      requests.postOperatorQuote,
    );
  }
  if (requests.acceptOperatorQuote) {
    result.acceptOperatorQuote = encodeAcceptOperatorQuote(
      requests.acceptOperatorQuote.quoteId,
    );
  }
  if (requests.settleOperatorQuote) {
    result.settleOperatorQuote = encodeSettleOperatorQuote(
      requests.settleOperatorQuote.quoteId,
      requests.settleOperatorQuote.deliveryDigest,
      requests.settleOperatorQuote.evidence,
    );
  }
  if (requests.cancelOperatorQuote) {
    result.cancelOperatorQuote = encodeCancelOperatorQuote(
      requests.cancelOperatorQuote.quoteId,
    );
  }
  if (requests.expireOperatorQuote) {
    result.expireOperatorQuote = encodeExpireOperatorQuote(
      requests.expireOperatorQuote.quoteId,
    );
  }
  if (Object.keys(result).length === 0) {
    throw new TypeError("No V3 calldata requests supplied");
  }
  return result;
}

export function buildPortfolioPoolCalldata(requests) {
  if (!requests || typeof requests !== "object") {
    throw new TypeError("Invalid portfolio-pool calldata requests");
  }
  const result = {};
  if (requests.setMandate) {
    result.setMandate = encodeSetPortfolioPoolMandate(
      requests.setMandate.mandate,
    );
  }
  if (requests.createFacility) {
    result.createFacility = encodeCreatePortfolioPoolFacility(
      requests.createFacility,
    );
  }
  if (requests.configureAndRegisterPolicy) {
    result.configureAndRegisterPolicy =
      encodeConfigureAndRegisterPortfolioPoolPolicy(
        requests.configureAndRegisterPolicy,
      );
  }
  if (requests.authorizeRemedyPolicy) {
    result.authorizeRemedyPolicy = encodeAuthorizePortfolioPoolRemedyPolicy(
      requests.authorizeRemedyPolicy,
    );
  }
  if (requests.publishRemedyIntent) {
    result.publishRemedyIntent = encodePublishPortfolioPoolRemedyIntent(
      requests.publishRemedyIntent,
    );
  }
  if (requests.replaceRemedyIntent) {
    result.replaceRemedyIntent = encodeReplacePortfolioPoolRemedyIntent(
      requests.replaceRemedyIntent,
    );
  }
  if (requests.registerCandidate) {
    result.registerCandidate = encodeRegisterPortfolioPoolCandidate(
      requests.registerCandidate,
    );
  }
  if (requests.registerInvestor) {
    result.registerInvestor = encodeRegisterPortfolioPoolInvestor(
      requests.registerInvestor.investor,
    );
  }
  if (requests.setProofJobsVenue) {
    result.setProofJobsVenue = encodeSetPortfolioPoolProofJobsVenue(
      requests.setProofJobsVenue.proofJobs,
    );
  }
  if (requests.deposit) {
    result.deposit = encodePortfolioPoolDeposit(requests.deposit.amount);
  }
  if (requests.withdrawFunding) {
    result.withdrawFunding = encodePortfolioPoolFundingWithdrawal(
      requests.withdrawFunding.amount,
    );
  }
  if (requests.allocate) {
    result.allocate = encodePortfolioPoolAllocation(
      requests.allocate.facility,
      requests.allocate.amount,
    );
  }
  if (requests.setFacilityDrawPaused) {
    result.setFacilityDrawPaused = encodeSetPortfolioPoolFacilityDrawPaused(
      requests.setFacilityDrawPaused.facility,
      requests.setFacilityDrawPaused.paused,
    );
  }
  if (requests.createProofJob) {
    result.createProofJob = encodeCreatePortfolioPoolProofJob(
      requests.createProofJob,
    );
  }
  if (requests.harvest) {
    result.harvest = encodeHarvestPortfolioPoolFacility(
      requests.harvest.facility,
    );
  }
  if (requests.settleAllocation) {
    result.settleAllocation = encodeSettlePortfolioPoolAllocation(
      requests.settleAllocation.facility,
    );
  }
  for (const [key, encode] of [
    ["openFunding", encodeOpenPortfolioPoolFunding],
    ["cancelFunding", encodeCancelPortfolioPoolFunding],
    ["activate", encodeActivatePortfolioPool],
    ["recoverProofJobFunds", encodeRecoverPortfolioPoolProofJobFunds],
    ["finalize", encodeFinalizePortfolioPool],
    ["distributeAvailable", encodeDistributePortfolioPoolAvailable],
    ["claim", encodeClaimPortfolioPoolAssets],
  ]) {
    if (requests[key] === true) result[key] = encode();
    else if (requests[key] !== undefined && requests[key] !== false) {
      throw new TypeError(`Invalid ${key}`);
    }
  }
  if (Object.keys(result).length === 0) {
    throw new TypeError("No portfolio-pool calldata requests supplied");
  }
  return result;
}
