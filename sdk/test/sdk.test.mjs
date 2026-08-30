import assert from "node:assert/strict";
import test from "node:test";
import {
  AbiCoder,
  Interface,
  getAddress,
  id,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import {
  EvidenceKind,
  FacilityStatus,
  ObservationKind,
  PolicyOutcome,
  buildHorizon1Calldata,
  canonicalizePolicyPackage,
  computeEvidenceDigest,
  computeJobCommitment,
  encodeActivateFacility,
  encodeCommitEvidence,
  encodeCreateFacility,
  encodeCreateProofJob,
  encodeEventHistoryManifest,
  encodeJobCommitment,
  encodeKernelProof,
  encodeRevealEvidence,
  eventHistoryPolicyV1Abi,
  hashEventHistoryManifest,
  hashPolicyPackage,
  policyKernelV1Abi,
  proofJobsV1Abi,
  recourseFacilityFactoryV2Abi,
  recourseFacilityV2Abi,
  simulateFacilityPolicyState,
  validateEventHistoryManifest,
  validatePolicyPackage,
  verifiedCreditStateV1Abi,
} from "../src/index.mjs";

const HASH = (byte) => `0x${byte.repeat(32)}`;
const ADDRESS = (suffix) => getAddress(`0x${suffix.padStart(40, "0")}`);

function effect(overrides = {}) {
  return {
    outcome: PolicyOutcome.Watch,
    creditLimitBps: 9_000,
    futureDrawFeeBps: 250,
    freezePendingDraw: false,
    requireFreshEvidence: false,
    terminate: false,
    ...overrides,
  };
}

function eventHistoryManifest() {
  return {
    sourceChain: 3,
    emitter: ADDRESS("a0"),
    eventSignature: id("Transfer(address,address,uint256)"),
    subject: ADDRESS("b0"),
    startSourceBlock: 100,
    endSourceBlock: 200,
    topicCount: 3,
    subjectTopicIndex: 1,
    dataLength: 32,
    observedValueOffset: 0,
    observationKind: ObservationKind.Behaviour,
    evidenceKind: EvidenceKind.EventDelta,
    freshnessPeriod: 86_400,
    effect: effect({
      outcome: PolicyOutcome.MarginCalled,
      creditLimitBps: 5_000,
      futureDrawFeeBps: 400,
      freezePendingDraw: true,
      requireFreshEvidence: true,
    }),
  };
}

test("exports parseable Horizon 1 ABIs for the core read surfaces", () => {
  for (const abi of [
    policyKernelV1Abi,
    verifiedCreditStateV1Abi,
    proofJobsV1Abi,
    recourseFacilityV2Abi,
    recourseFacilityFactoryV2Abi,
    eventHistoryPolicyV1Abi,
  ]) {
    assert.doesNotThrow(() => new Interface(abi));
  }
  assert.equal(
    new Interface(recourseFacilityFactoryV2Abi)
      .getEvent("CreationPauseSet")
      .format(),
    "CreationPauseSet(bool)",
  );
});

test("EventHistory manifest encoding and hash exactly match abi.encode(Configuration)", () => {
  const manifest = eventHistoryManifest();
  const expected = AbiCoder.defaultAbiCoder().encode(
    [
      "tuple(uint64 sourceChain,address emitter,bytes32 eventSignature,address subject,uint64 startSourceBlock,uint64 endSourceBlock,uint8 topicCount,uint8 subjectTopicIndex,uint16 dataLength,uint16 observedValueOffset,uint8 observationKind,uint8 evidenceKind,uint64 freshnessPeriod,tuple(uint8 outcome,uint16 creditLimitBps,uint16 futureDrawFeeBps,bool freezePendingDraw,bool requireFreshEvidence,bool terminate) effect)",
    ],
    [manifest],
  );

  assert.deepEqual(validateEventHistoryManifest(manifest), manifest);
  assert.equal(encodeEventHistoryManifest(manifest), expected);
  assert.equal(hashEventHistoryManifest(manifest), keccak256(expected));
  assert.throws(
    () =>
      validateEventHistoryManifest({
        ...manifest,
        observedValueOffset: 32,
      }),
    /observedValueOffset/,
  );
  assert.throws(
    () =>
      validateEventHistoryManifest({
        ...manifest,
        evidenceKind: EvidenceKind.TransactionControl,
      }),
    /evidenceKind/,
  );
  assert.throws(
    () =>
      validateEventHistoryManifest({
        ...manifest,
        eventSignature: HASH("00"),
      }),
    /eventSignature/,
  );
  assert.throws(
    () => validateEventHistoryManifest({ ...manifest, sourceChain: true }),
    /sourceChain/,
  );
  assert.throws(
    () => validateEventHistoryManifest({ ...manifest, startSourceBlock: null }),
    /startSourceBlock/,
  );
});

test("proof and proof-job commitment encodings match the Solidity tuples", () => {
  const proofInput = {
    chainKey: 3,
    height: 25_839_959,
    encodedTransaction: "0x1234",
    merkleProof: {
      root: HASH("11"),
      siblings: [{ hash: HASH("22"), isLeft: true }],
    },
    continuityProof: {
      lowerEndpointDigest: HASH("33"),
      roots: [HASH("44")],
    },
  };
  const proof = encodeKernelProof(proofInput);
  const evidenceDigest = computeEvidenceDigest(proof);
  const hunter = ADDRESS("b0b");
  const salt = HASH("55");
  const expectedEncoding = AbiCoder.defaultAbiCoder().encode(
    ["uint256", "address", "bytes32", "bytes32"],
    [1n, hunter, evidenceDigest, salt],
  );

  assert.equal(
    encodeJobCommitment(1n, hunter, evidenceDigest, salt),
    expectedEncoding,
  );
  assert.equal(
    computeJobCommitment(1n, hunter, evidenceDigest, salt),
    keccak256(expectedEncoding),
  );

  const roundedUnsafeJobId = 9_007_199_254_740_993;
  assert.equal(roundedUnsafeJobId, 9_007_199_254_740_992);
  assert.throws(
    () => encodeJobCommitment(roundedUnsafeJobId, hunter, evidenceDigest, salt),
    /jobId/,
  );
  assert.doesNotThrow(() =>
    encodeJobCommitment("9007199254740993", hunter, evidenceDigest, salt),
  );
  assert.doesNotThrow(() =>
    encodeJobCommitment(9_007_199_254_740_993n, hunter, evidenceDigest, salt),
  );
});

test("facility simulation mirrors conservative policy aggregation and draw availability", () => {
  const state = simulateFacilityPolicyState({
    initialDrawFeeBps: 200,
    facilityLimit: 100_000n,
    drawnPrincipal: 40_000n,
    status: FacilityStatus.Active,
    lenderDrawPaused: false,
    borrowerDrawPaused: false,
    timestamp: 1_000,
    policies: [
      { effect: effect(), evidenceExpiry: 2_000 },
      {
        effect: effect({
          outcome: PolicyOutcome.Restricted,
          creditLimitBps: 6_000,
          futureDrawFeeBps: 400,
          requireFreshEvidence: true,
        }),
        evidenceExpiry: 1_500,
      },
      {
        effect: effect({
          outcome: PolicyOutcome.Cured,
          creditLimitBps: 10_000,
          futureDrawFeeBps: 0,
        }),
        evidenceExpiry: 0,
      },
    ],
  });

  assert.deepEqual(state, {
    policyOutcome: PolicyOutcome.Restricted,
    creditLimitBps: 6_000,
    futureDrawFeeBps: 400,
    freshEvidenceRequired: true,
    evidenceValidUntil: 1_500n,
    incidentPaused: false,
    effectiveLimit: 60_000n,
    availableCredit: 0n,
  });

  assert.equal(
    simulateFacilityPolicyState({
      initialDrawFeeBps: 200,
      facilityLimit: 100_000n,
      drawnPrincipal: 40_000n,
      status: FacilityStatus.Active,
      lenderDrawPaused: false,
      borrowerDrawPaused: false,
      timestamp: 1_500,
      policies: [{ effect: effect(), evidenceExpiry: 1_500 }],
    }).availableCredit,
    0n,
  );
  assert.equal(
    simulateFacilityPolicyState({
      initialDrawFeeBps: 200,
      facilityLimit: 100_000n,
      drawnPrincipal: 40_000n,
      status: FacilityStatus.Active,
      lenderDrawPaused: false,
      borrowerDrawPaused: false,
      timestamp: 1_000,
      policies: [
        { effect: effect({ terminate: true }), evidenceExpiry: 2_000 },
      ],
    }).availableCredit,
    0n,
  );
});

test("versioned policy packages canonicalize and bind exact audit deployments", () => {
  const policyPackage = {
    format: "recourse-policy-package",
    version: 1,
    id: "event-history-usdc-outflow",
    name: "USDC outflow history",
    release: "1.0.0",
    policyKind: "event-history-v1",
    supportedEvidenceKinds: ["event-delta"],
    actionAdapters: [],
    implementation: {
      chainId: 102031,
      address: ADDRESS("101"),
      codeHash: HASH("aa"),
    },
    audits: [
      {
        auditor: ADDRESS("a0d17"),
        release: "1.0.0",
        chainId: 102031,
        deployment: ADDRESS("101"),
        codeHash: HASH("aa"),
        reportUri: "ipfs://audit-report",
        reportHash: HASH("bb"),
      },
    ],
    deployments: [
      {
        chainId: 102031,
        address: ADDRESS("101"),
        blockNumber: 5_000_000,
        transactionHash: HASH("cc"),
        codeHash: HASH("aa"),
      },
    ],
  };

  assert.deepEqual(validatePolicyPackage(policyPackage), policyPackage);
  const canonical = canonicalizePolicyPackage(policyPackage);
  assert.equal(
    hashPolicyPackage(policyPackage),
    keccak256(toUtf8Bytes(canonical)),
  );
  assert.equal(canonical, canonicalizePolicyPackage(JSON.parse(canonical)));
  assert.throws(
    () =>
      validatePolicyPackage({
        ...policyPackage,
        audits: [{ ...policyPackage.audits[0], deployment: ADDRESS("202") }],
      }),
    /audit deployment/,
  );
  assert.throws(
    () =>
      validatePolicyPackage({
        ...policyPackage,
        audits: [{ ...policyPackage.audits[0], chainId: 1 }],
      }),
    /audit deployment/,
  );
  assert.throws(
    () =>
      validatePolicyPackage({
        ...policyPackage,
        audits: [{ ...policyPackage.audits[0], codeHash: HASH("dd") }],
      }),
    /audit deployment/,
  );
  assert.throws(
    () =>
      validatePolicyPackage({
        ...policyPackage,
        implementation: {
          ...policyPackage.implementation,
          codeHash: HASH("00"),
        },
        deployments: [
          { ...policyPackage.deployments[0], codeHash: HASH("00") },
        ],
        audits: [{ ...policyPackage.audits[0], codeHash: HASH("00") }],
      }),
    /implementation.codeHash/,
  );
  assert.throws(
    () =>
      validatePolicyPackage({
        ...policyPackage,
        deployments: [
          { ...policyPackage.deployments[0], transactionHash: HASH("00") },
        ],
      }),
    /deployments\[0\].transactionHash/,
  );
  assert.throws(
    () =>
      validatePolicyPackage({
        ...policyPackage,
        audits: [{ ...policyPackage.audits[0], reportHash: HASH("00") }],
      }),
    /audits\[0\].reportHash/,
  );
  assert.throws(
    () =>
      validatePolicyPackage({
        ...policyPackage,
        actionAdapters: [
          {
            kind: "freeze",
            chainId: 102031,
            address: ADDRESS("303"),
            codeHash: HASH("00"),
          },
        ],
      }),
    /actionAdapters\[0\].codeHash/,
  );
});

test("dry-run calldata builders emit exact selectors and round-trip arguments", () => {
  const manifest = eventHistoryManifest();
  const calls = buildHorizon1Calldata({
    createFacility: {
      asset: ADDRESS("1"),
      kernel: ADDRESS("2"),
      lender: ADDRESS("3"),
      borrower: ADDRESS("4"),
      facilityLimit: 100_000n,
      bondRequired: 20_000n,
      drawFeeBps: 200,
      maturityBlock: 6_000_000,
      drawDelayBlocks: 1,
    },
    configurePolicy: {
      facility: ADDRESS("5"),
      policyId: 1n,
      configuration: manifest,
    },
    registerPolicy: {
      facility: ADDRESS("5"),
      policyId: 1n,
      evaluator: ADDRESS("6"),
    },
  });
  const factory = new Interface(recourseFacilityFactoryV2Abi);
  const policy = new Interface(eventHistoryPolicyV1Abi);
  const kernel = new Interface(policyKernelV1Abi);

  assert.equal(
    factory.parseTransaction({ data: calls.createFacility }).name,
    "createFacility",
  );
  assert.equal(
    policy.parseTransaction({ data: calls.configurePolicy }).args.policyId,
    1n,
  );
  assert.equal(
    kernel.parseTransaction({ data: calls.registerPolicy }).args.evaluator,
    ADDRESS("6"),
  );
  assert(
    Object.values(calls).every(
      (data) => data.startsWith("0x") && data.length >= 10,
    ),
  );
});

test("calldata builders reject configurations guaranteed to revert on-chain", () => {
  const createFacility = {
    asset: ADDRESS("1"),
    kernel: ADDRESS("2"),
    lender: ADDRESS("3"),
    borrower: ADDRESS("4"),
    facilityLimit: 100_000n,
    bondRequired: 20_000n,
    drawFeeBps: 200,
    maturityBlock: 6_000_000,
    drawDelayBlocks: 1,
  };
  assert.throws(
    () =>
      encodeCreateFacility({
        ...createFacility,
        borrower: createFacility.lender,
      }),
    /borrower/,
  );
  for (const field of ["asset", "kernel", "lender", "borrower"]) {
    assert.throws(
      () => encodeCreateFacility({ ...createFacility, [field]: ADDRESS("0") }),
      new RegExp(field),
    );
  }
  for (const field of ["facilityLimit", "bondRequired"]) {
    assert.throws(
      () => encodeCreateFacility({ ...createFacility, [field]: 0 }),
      new RegExp(field),
    );
  }
  assert.throws(
    () => encodeCreateFacility({ ...createFacility, drawFeeBps: 10_001 }),
    /drawFeeBps/,
  );

  const proofJob = {
    token: ADDRESS("1"),
    facility: ADDRESS("5"),
    policyId: 1,
    requirementsDigest: HASH("11"),
    expiry: 4_000_000_000,
    revealWindowBlocks: 10,
    maxSuccessfulProofs: 2,
    proofReimbursement: 100,
    outcomeReward: 1_000,
    commitBond: 50,
    rewardOutcomeThreshold: 3,
  };
  for (const field of [
    "expiry",
    "revealWindowBlocks",
    "maxSuccessfulProofs",
    "proofReimbursement",
    "outcomeReward",
    "commitBond",
  ]) {
    assert.throws(
      () => encodeCreateProofJob({ ...proofJob, [field]: 0 }),
      new RegExp(field),
    );
  }
  assert.throws(
    () => encodeCreateProofJob({ ...proofJob, requirementsDigest: HASH("00") }),
    /requirementsDigest/,
  );
  for (const field of ["token", "facility"]) {
    assert.throws(
      () => encodeCreateProofJob({ ...proofJob, [field]: ADDRESS("0") }),
      new RegExp(field),
    );
  }
  assert.throws(
    () => encodeCreateProofJob({ ...proofJob, rewardOutcomeThreshold: 5 }),
    /rewardOutcomeThreshold/,
  );

  assert.throws(() => encodeActivateFacility(HASH("00")), /expectedPolicySet/);
  assert.throws(
    () => encodeCommitEvidence(1, HASH("00"), HASH("22")),
    /evidenceDigest/,
  );
  assert.throws(
    () => encodeCommitEvidence(1, HASH("11"), HASH("00")),
    /commitment/,
  );
  assert.throws(
    () => encodeRevealEvidence(1, HASH("00"), HASH("33"), "0x12"),
    /evidenceDigest/,
  );
  assert.throws(
    () => encodeRevealEvidence(1, HASH("11"), HASH("33"), "0x12"),
    /evidenceDigest/,
  );
});
