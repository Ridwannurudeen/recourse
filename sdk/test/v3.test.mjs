import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AbiCoder, Interface, getAddress, id, keccak256 } from "ethers";

import {
  FacilityStatus,
  OperatorQuoteStatus,
  OperatorServiceKind,
  PilotCreationCode,
  PolicyOutcome,
  SourceOrdering,
  buildV3Calldata,
  cappedPilotFactoryV1Abi,
  computeOperatorAgreementId,
  decodeMultiChainConfiguration,
  encodeMultiChainConfiguration,
  hashMultiChainConfiguration,
  multiChainConfigurationTuple,
  multiChainEventPolicyV1Abi,
  operatorMarketV1Abi,
  policyKernelV2Abi,
  proofJobsV1Abi,
  recourseFacilityV3Abi,
  simulateCappedPilotFacilityCreation,
  simulateDefaultLossSettlement,
  simulateMultiChainRisk,
  validateMultiChainConfiguration,
} from "../src/index.mjs";

const HASH = (byte) => `0x${byte.repeat(32)}`;
const ADDRESS = (suffix) => getAddress(`0x${suffix.padStart(40, "0")}`);

function effect(outcome, creditLimitBps, futureDrawFeeBps, overrides = {}) {
  return {
    outcome,
    creditLimitBps,
    futureDrawFeeBps,
    freezePendingDraw: outcome >= PolicyOutcome.Restricted,
    requireFreshEvidence: outcome >= PolicyOutcome.Restricted,
    terminate: outcome === PolicyOutcome.Breached,
    ...overrides,
  };
}

function multiChainConfiguration(overrides = {}) {
  return {
    subject: ADDRESS("101"),
    freshnessPeriod: 86_400,
    watchThreshold: 10,
    restrictedThreshold: 20,
    marginThreshold: 30,
    breachThreshold: 40,
    watchEffect: effect(PolicyOutcome.Watch, 9_000, 200, {
      freezePendingDraw: false,
      requireFreshEvidence: false,
      terminate: false,
    }),
    restrictedEffect: effect(PolicyOutcome.Restricted, 7_500, 300, {
      terminate: false,
    }),
    marginEffect: effect(PolicyOutcome.MarginCalled, 5_000, 400, {
      terminate: false,
    }),
    breachEffect: effect(PolicyOutcome.Breached, 0, 500),
    rules: [
      {
        sourceChain: 2,
        emitter: ADDRESS("201"),
        eventSignature: id("Transfer(address,address,uint256)"),
        startSourceBlock: 100,
        endSourceBlock: 200,
        topicCount: 3,
        subjectTopicIndex: 1,
        dataLength: 32,
        observedValueOffset: 0,
        observationKind: 4,
        riskWeight: 10,
      },
      {
        sourceChain: 3,
        emitter: ADDRESS("202"),
        eventSignature: id("Borrow(address,uint256)"),
        startSourceBlock: 300,
        endSourceBlock: 400,
        topicCount: 2,
        subjectTopicIndex: 1,
        dataLength: 32,
        observedValueOffset: 0,
        observationKind: 3,
        riskWeight: 15,
      },
    ],
    ...overrides,
  };
}

test("V3 ABI fragments expose the compiled public surfaces", () => {
  const factory = new Interface(cappedPilotFactoryV1Abi);
  const facility = new Interface(recourseFacilityV3Abi);
  const kernel = new Interface(policyKernelV2Abi);
  const policy = new Interface(multiChainEventPolicyV1Abi);
  const market = new Interface(operatorMarketV1Abi);

  assert.equal(factory.getFunction("createFacility").selector, "0xde463fae");
  assert.equal(
    facility.getFunction("settleDefaultLoss").selector,
    "0x7a21cfb3",
  );
  assert.equal(
    kernel.getFunction("latestSourcePosition").format("sighash"),
    "latestSourcePosition(address,uint256,uint64)",
  );
  assert.equal(policy.getFunction("configurationOf").name, "configurationOf");
  assert.equal(policy.getFunction("sourceOrdering").name, "sourceOrdering");
  assert.equal(kernel.getFunction("sourceOrderingOf").name, "sourceOrderingOf");
  assert.equal(market.getFunction("quoteAt").name, "quoteAt");
  assert.equal(SourceOrdering.StrictlyIncreasing, 0);
  assert.equal(SourceOrdering.UniqueOnly, 1);
});

test("OperatorMarketV1 SDK ABI matches the compiled artifact", () => {
  const artifact = JSON.parse(
    readFileSync(
      new URL(
        "../../out/OperatorMarketV1.sol/OperatorMarketV1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const compiled = new Interface(artifact.abi);
  const sdk = new Interface(operatorMarketV1Abi);

  assert.equal(
    sdk.getFunction("postQuote").selector,
    compiled.getFunction("postQuote").selector,
  );
  assert.equal(
    sdk.getEvent("QuotePosted").topicHash,
    compiled.getEvent("QuotePosted").topicHash,
  );
  assert.deepEqual(
    sdk
      .getFunction("quoteAt")
      .outputs[0].components.map(({ name, type }) => ({ name, type })),
    compiled
      .getFunction("quoteAt")
      .outputs[0].components.map(({ name, type }) => ({ name, type })),
  );
});

test("multi-chain configuration encoding is canonical and simulation accumulates every matched rule", () => {
  const configuration = multiChainConfiguration();
  const normalized = validateMultiChainConfiguration(configuration);
  const encoded = encodeMultiChainConfiguration(configuration);
  const expected = AbiCoder.defaultAbiCoder().encode(
    [multiChainConfigurationTuple],
    [normalized],
  );

  assert.equal(encoded, expected);
  assert.equal(hashMultiChainConfiguration(configuration), keccak256(expected));
  assert.deepEqual(decodeMultiChainConfiguration(encoded), normalized);
  assert.throws(
    () => decodeMultiChainConfiguration(`${encoded}00`),
    /not canonical/,
  );

  const simulated = simulateMultiChainRisk({
    configuration,
    currentScore: 5,
    ruleMatchCounts: [1, 2],
  });
  assert.equal(simulated.newScore, 45n);
  assert.deepEqual(simulated.matchedRuleIndexes, [0, 1]);
  assert.equal(simulated.effect.outcome, PolicyOutcome.Breached);

  assert.throws(
    () =>
      validateMultiChainConfiguration({
        ...configuration,
        rules: [configuration.rules[0], { ...configuration.rules[0] }],
      }),
    /overlap/,
  );
  assert.throws(
    () =>
      validateMultiChainConfiguration({
        ...configuration,
        restrictedEffect: {
          ...configuration.restrictedEffect,
          creditLimitBps: 9_500,
        },
      }),
    /effects/,
  );
});

test("capped-pilot and default-loss simulations preserve contract ordering and conservation", () => {
  const factory = {
    lender: ADDRESS("301"),
    creationPaused: false,
    facilityCount: 1,
    totalFacilityLimit: 100_000n,
    maximumFacilityLimit: 100_000n,
    maximumTotalLimit: 200_000n,
    minimumBondBps: 2_000,
    maximumDrawFeeBps: 400,
    maximumMaturityBlocks: 1_000,
    maximumDrawDelayBlocks: 50,
    maximumFacilityCount: 2,
  };
  const request = {
    facilityLimit: 50_000n,
    bondRequired: 10_000n,
    drawFeeBps: 200,
    maturityBlock: 1_500,
    drawDelayBlocks: 10,
  };
  assert.deepEqual(
    simulateCappedPilotFacilityCreation({
      factory,
      request,
      sender: factory.lender,
      blockNumber: 1_000,
    }),
    {
      code: PilotCreationCode.Eligible,
      minimumBond: 10_000n,
      totalFacilityLimitAfter: 150_000n,
    },
  );
  assert.equal(
    simulateCappedPilotFacilityCreation({
      factory: { ...factory, creationPaused: true },
      request,
      sender: ADDRESS("399"),
      blockNumber: 1_000,
    }).code,
    PilotCreationCode.NotLender,
  );
  assert.equal(
    simulateCappedPilotFacilityCreation({
      factory,
      request: { ...request, bondRequired: 9_999n },
      sender: factory.lender,
      blockNumber: 1_000,
    }).code,
    PilotCreationCode.InvalidBond,
  );

  assert.deepEqual(
    simulateDefaultLossSettlement({
      lender: ADDRESS("320"),
      sender: ADDRESS("320"),
      status: FacilityStatus.Defaulted,
      bondPosted: 20_000n,
      outstandingDebt: 15_000n,
      lenderClaimable: 2_000n,
      borrowerClaimable: 1_000n,
    }),
    {
      lenderRecovery: 15_000n,
      borrowerExcess: 5_000n,
      bondPosted: 0n,
      outstandingDebt: 0n,
      lenderClaimable: 17_000n,
      borrowerClaimable: 6_000n,
    },
  );
  assert.equal(
    simulateDefaultLossSettlement({
      lender: ADDRESS("320"),
      sender: ADDRESS("320"),
      status: FacilityStatus.Terminated,
      maturityBlock: 1_500,
      blockNumber: 1_501,
      bondPosted: 20_000n,
      outstandingDebt: 15_000n,
      lenderClaimable: 2_000n,
      borrowerClaimable: 1_000n,
    }).lenderRecovery,
    15_000n,
  );
  assert.throws(
    () =>
      simulateDefaultLossSettlement({
        lender: ADDRESS("320"),
        sender: ADDRESS("320"),
        status: FacilityStatus.Terminated,
        maturityBlock: 1_500,
        blockNumber: 1_500,
        bondPosted: 20_000n,
        outstandingDebt: 15_000n,
        lenderClaimable: 2_000n,
        borrowerClaimable: 1_000n,
      }),
    /not ready/,
  );
  assert.throws(
    () =>
      simulateDefaultLossSettlement({
        lender: ADDRESS("320"),
        sender: ADDRESS("321"),
        status: FacilityStatus.Defaulted,
        bondPosted: 20_000n,
        outstandingDebt: 15_000n,
        lenderClaimable: 2_000n,
        borrowerClaimable: 1_000n,
      }),
    /not lender/,
  );
});

test("operator agreement IDs and V3 builders round-trip exact calldata without a signer", () => {
  const marketAddress = ADDRESS("401");
  const quote = {
    operator: ADDRESS("402"),
    intendedSponsor: ADDRESS("403"),
    serviceKind: OperatorServiceKind.Submission,
    requirementsDigest: HASH("41"),
    price: 1_000n,
    operatorBond: 500n,
    quoteExpiry: 2_000,
    serviceDuration: 300,
    acceptedAt: 1_900,
    deliveryDeadline: 2_200,
  };
  const agreementId = computeOperatorAgreementId({
    market: marketAddress,
    chainId: 102031,
    quoteId: 7,
    sponsor: ADDRESS("403"),
    quote,
  });
  const expected = keccak256(
    AbiCoder.defaultAbiCoder().encode(
      [
        "address",
        "uint256",
        "uint256",
        "address",
        "address",
        "address",
        "uint8",
        "bytes32",
        "uint256",
        "uint256",
        "uint64",
        "uint64",
        "uint64",
        "uint64",
      ],
      [
        marketAddress,
        102031,
        7,
        quote.operator,
        quote.intendedSponsor,
        ADDRESS("403"),
        quote.serviceKind,
        quote.requirementsDigest,
        quote.price,
        quote.operatorBond,
        quote.quoteExpiry,
        quote.serviceDuration,
        quote.acceptedAt,
        quote.deliveryDeadline,
      ],
    ),
  );
  assert.equal(agreementId, expected);
  assert.throws(
    () =>
      computeOperatorAgreementId({
        market: marketAddress,
        chainId: 102031,
        quoteId: 7,
        sponsor: ADDRESS("403"),
        quote: { ...quote, deliveryDeadline: 2_201 },
      }),
    /deliveryDeadline/,
  );

  const calls = buildV3Calldata({
    createPilotFacility: {
      facilityLimit: 50_000n,
      bondRequired: 10_000n,
      drawFeeBps: 200,
      maturityBlock: 1_500,
      drawDelayBlocks: 10,
    },
    configureMultiChainPolicy: {
      facility: ADDRESS("404"),
      policyId: 7,
      configuration: multiChainConfiguration(),
    },
    postOperatorQuote: quote,
    acceptOperatorQuote: { quoteId: 7 },
    slashExpiredProofCommit: { jobId: 8, hunter: ADDRESS("405") },
    releaseProofCommit: { jobId: 8 },
    finalizeExpiredProofJob: { jobId: 8 },
    claimProofJobs: { token: ADDRESS("406") },
    settleDefaultLoss: true,
  });
  assert.equal(
    new Interface(cappedPilotFactoryV1Abi).parseTransaction({
      data: calls.createPilotFacility,
    }).args.facilityLimit,
    50_000n,
  );
  assert.equal(
    new Interface(multiChainEventPolicyV1Abi).parseTransaction({
      data: calls.configureMultiChainPolicy,
    }).args.policyId,
    7n,
  );
  assert.equal(
    new Interface(operatorMarketV1Abi).parseTransaction({
      data: calls.postOperatorQuote,
    }).args.serviceKind,
    2n,
  );
  assert.equal(
    new Interface(operatorMarketV1Abi).parseTransaction({
      data: calls.postOperatorQuote,
    }).args.intendedSponsor,
    ADDRESS("403"),
  );
  assert.equal(
    new Interface(operatorMarketV1Abi).parseTransaction({
      data: calls.acceptOperatorQuote,
    }).args.quoteId,
    7n,
  );
  assert.equal(
    new Interface(recourseFacilityV3Abi).parseTransaction({
      data: calls.settleDefaultLoss,
    }).name,
    "settleDefaultLoss",
  );
  const jobs = new Interface(proofJobsV1Abi);
  assert.equal(
    jobs.parseTransaction({ data: calls.slashExpiredProofCommit }).args.hunter,
    ADDRESS("405"),
  );
  assert.equal(
    jobs.parseTransaction({ data: calls.releaseProofCommit }).args.jobId,
    8n,
  );
  assert.equal(
    jobs.parseTransaction({ data: calls.finalizeExpiredProofJob }).args.jobId,
    8n,
  );
  assert.equal(
    jobs.parseTransaction({ data: calls.claimProofJobs }).args.token,
    ADDRESS("406"),
  );
  assert.equal(OperatorQuoteStatus.Open, 0);
  assert.throws(() => buildV3Calldata({}), /No V3 calldata/);
});
