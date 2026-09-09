import assert from "node:assert/strict";
import test from "node:test";
import { Interface, getAddress, id } from "ethers";
import {
  AuditScope,
  EvidenceKind,
  ObservationKind,
  PortfolioEligibilityCode,
  PolicyOutcome,
  buildPolicyRegistryCalldata,
  decodeEventHistoryManifest,
  encodeEventHistoryManifest,
  hashEventHistoryManifest,
  policyRegistryV1Abi,
  portfolioMandateV1Abi,
  simulatePortfolioMandateEligibility,
  validateEventHistoryManifestBinding,
} from "../src/index.mjs";

const HASH = (byte) => `0x${byte.repeat(32)}`;
const ADDRESS = (suffix) => getAddress(`0x${suffix.padStart(40, "0")}`);

function manifest() {
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
    effect: {
      outcome: PolicyOutcome.Restricted,
      creditLimitBps: 6_000,
      futureDrawFeeBps: 300,
      freezePendingDraw: true,
      requireFreshEvidence: true,
      terminate: false,
    },
  };
}

test("EventHistory manifest decoding returns validated plain data and binds its config hash", () => {
  const expected = manifest();
  const encoded = encodeEventHistoryManifest(expected);
  const expectedHash = hashEventHistoryManifest(expected);
  const decoded = decodeEventHistoryManifest(encoded);

  assert.equal(decoded.sourceChain, 3n);
  assert.equal(decoded.emitter, expected.emitter);
  assert.equal(decoded.topicCount, 3);
  assert.equal(decoded.effect.creditLimitBps, 6_000);
  assert.deepEqual(validateEventHistoryManifestBinding(encoded, expectedHash), {
    manifest: decoded,
    manifestHash: expectedHash,
  });
  assert.throws(
    () => validateEventHistoryManifestBinding(encoded, HASH("ff")),
    /config hash mismatch/,
  );
  assert.throws(() => decodeEventHistoryManifest("0x1234"), /manifestBytes/);
  assert.throws(
    () => decodeEventHistoryManifest(`${encoded}00`),
    /not canonical ABI encoding/,
  );
});

test("registry calldata aggregation preserves ordered calls without a signer or broadcast path", () => {
  const iface = new Interface(policyRegistryV1Abi);
  const releaseId = HASH("11");
  const calls = buildPolicyRegistryCalldata({
    approveRuntimeVariants: [
      {
        releaseId,
        implementation: ADDRESS("101"),
        constructorArgumentsHash: HASH("21"),
      },
      {
        releaseId,
        implementation: ADDRESS("102"),
        constructorArgumentsHash: HASH("22"),
      },
    ],
    recordDeployments: [
      {
        releaseId,
        kernel: ADDRESS("103"),
        facility: ADDRESS("104"),
        policyId: 7,
        runtimeVariantId: HASH("23"),
      },
    ],
    publishAuditArtifacts: [
      {
        scope: AuditScope.Deployment,
        scopeId: HASH("24"),
        artifactHash: HASH("25"),
        artifactURI: "ipfs://deployment-audit",
      },
    ],
  });

  assert.deepEqual(
    calls.approveRuntimeVariants.map(
      (data) => iface.parseTransaction({ data }).args.implementation,
    ),
    [ADDRESS("101"), ADDRESS("102")],
  );
  assert.equal(
    iface.parseTransaction({ data: calls.recordDeployments[0] }).args.policyId,
    7n,
  );
  assert.equal(
    iface.parseTransaction({ data: calls.publishAuditArtifacts[0] }).args.scope,
    1n,
  );
  assert.throws(() => buildPolicyRegistryCalldata({}), /No registry calldata/);
  assert.throws(
    () => buildPolicyRegistryCalldata({ recordDeployments: {} }),
    /recordDeployments/,
  );
});

function mandateSimulation(overrides = {}) {
  const facility = {
    address: ADDRESS("201"),
    asset: ADDRESS("202"),
    kernel: ADDRESS("203"),
    status: 1,
    facilityLimit: 100_000n,
    bondRequired: 20_000n,
    initialDrawFeeBps: 200,
    maturityBlock: 1_500,
    policySetCommitment: HASH("31"),
  };
  return {
    mandate: {
      asset: facility.asset,
      kernel: facility.kernel,
      requiredReleaseId: HASH("32"),
      requiredPolicySetCommitment: facility.policySetCommitment,
      requiredEvidenceKind: EvidenceKind.EventDelta,
      requiredActionAdapterKind: HASH("33"),
      maximumFacilityLimit: 200_000n,
      minimumBondBps: 2_000,
      maximumDrawFeeBps: 300,
      maximumRemainingMaturityBlocks: 1_000,
    },
    facility,
    deployment: {
      exists: true,
      releaseId: HASH("32"),
      chainId: 102_031,
      kernel: facility.kernel,
      facility: facility.address,
      evaluator: ADDRESS("204"),
      configHash: HASH("34"),
      manifestHash: HASH("34"),
    },
    releaseExists: true,
    factoryRecognized: true,
    evidenceKindDeclared: true,
    actionAdapters: [{ adapterKind: HASH("33") }],
    chainId: 102_031,
    blockNumber: 1_000,
    ...overrides,
  };
}

test("PortfolioMandate ABI parses and simulator mirrors ordered eligibility gates", () => {
  const mandateAbi = new Interface(portfolioMandateV1Abi);
  assert.equal(mandateAbi.getFunction("evaluate").name, "evaluate");
  const eligible = mandateSimulation();
  assert.equal(
    simulatePortfolioMandateEligibility(eligible),
    PortfolioEligibilityCode.Eligible,
  );
  assert.equal(
    simulatePortfolioMandateEligibility({
      ...eligible,
      factoryRecognized: false,
      facility: { ...eligible.facility, asset: ADDRESS("999") },
    }),
    PortfolioEligibilityCode.UnknownFacility,
  );
  assert.equal(
    simulatePortfolioMandateEligibility({
      ...eligible,
      facility: { ...eligible.facility, bondRequired: 19_999n },
    }),
    PortfolioEligibilityCode.BondBelowMinimum,
  );
  assert.equal(
    simulatePortfolioMandateEligibility({
      ...eligible,
      actionAdapters: [],
    }),
    PortfolioEligibilityCode.MissingActionAdapter,
  );

  const rounded = mandateSimulation();
  rounded.facility = {
    ...rounded.facility,
    facilityLimit: 3n,
    bondRequired: 1n,
  };
  rounded.mandate = {
    ...rounded.mandate,
    minimumBondBps: 3_334,
  };
  assert.equal(
    simulatePortfolioMandateEligibility(rounded),
    PortfolioEligibilityCode.BondBelowMinimum,
  );
});

for (const requiredActionAdapterKind of [HASH("00"), HASH("33")]) {
  test(`PortfolioMandate preserves every earlier gate with adapter kind ${requiredActionAdapterKind}`, () => {
    const eligible = mandateSimulation();
    eligible.mandate.requiredActionAdapterKind = requiredActionAdapterKind;
    eligible.actionAdapters = [];
    const cases = [
      [{ factoryRecognized: false }, PortfolioEligibilityCode.UnknownFacility],
      [
        { facility: { asset: ADDRESS("999") } },
        PortfolioEligibilityCode.WrongAsset,
      ],
      [
        { facility: { kernel: ADDRESS("999") } },
        PortfolioEligibilityCode.WrongKernel,
      ],
      [{ facility: { status: 2 } }, PortfolioEligibilityCode.InvalidStatus],
      [
        { facility: { facilityLimit: 0n } },
        PortfolioEligibilityCode.FacilityLimitExceeded,
      ],
      [
        { facility: { facilityLimit: 200_001n } },
        PortfolioEligibilityCode.FacilityLimitExceeded,
      ],
      [
        { facility: { bondRequired: 19_999n } },
        PortfolioEligibilityCode.BondBelowMinimum,
      ],
      [
        { facility: { initialDrawFeeBps: 301 } },
        PortfolioEligibilityCode.DrawFeeExceeded,
      ],
      [
        { facility: { maturityBlock: 1_000 } },
        PortfolioEligibilityCode.InvalidMaturity,
      ],
      [
        { facility: { maturityBlock: 2_001 } },
        PortfolioEligibilityCode.InvalidMaturity,
      ],
      [
        { facility: { policySetCommitment: HASH("ff") } },
        PortfolioEligibilityCode.PolicySetMismatch,
      ],
      [{ releaseExists: false }, PortfolioEligibilityCode.UnknownRelease],
      ...[
        { exists: false },
        { releaseId: HASH("ff") },
        { chainId: 1 },
        { kernel: ADDRESS("999") },
        { facility: ADDRESS("999") },
        { evaluator: ADDRESS("0") },
        { configHash: HASH("00") },
        { manifestHash: HASH("00") },
      ].map((deployment) => [
        { deployment },
        PortfolioEligibilityCode.InvalidDeployment,
      ]),
      [
        { evidenceKindDeclared: false },
        PortfolioEligibilityCode.MissingEvidenceKind,
      ],
    ];
    for (const [overrides, expected] of cases) {
      assert.equal(
        simulatePortfolioMandateEligibility({
          ...eligible,
          ...overrides,
          facility: { ...eligible.facility, ...overrides.facility },
          deployment: { ...eligible.deployment, ...overrides.deployment },
        }),
        expected,
      );
    }
  });
}

test("PortfolioMandate zero kind permits no adapters while nonzero kinds require an exact match", () => {
  for (const requiredActionAdapterKind of [HASH("00"), HASH("33")]) {
    for (const actionAdapters of [
      [],
      [{ adapterKind: HASH("ff") }],
      [{ adapterKind: HASH("33") }],
    ]) {
      const simulation = mandateSimulation({ actionAdapters });
      simulation.mandate.requiredActionAdapterKind = requiredActionAdapterKind;
      assert.equal(
        simulatePortfolioMandateEligibility(simulation),
        requiredActionAdapterKind === HASH("00") ||
          actionAdapters.some(({ adapterKind }) => adapterKind === HASH("33"))
          ? PortfolioEligibilityCode.Eligible
          : PortfolioEligibilityCode.MissingActionAdapter,
      );
    }
  }
});

test("PortfolioMandate adapter kind remains explicitly required and well formed", () => {
  for (const requiredActionAdapterKind of [undefined, null, "0x00", "invalid"]) {
    const simulation = mandateSimulation();
    simulation.mandate.requiredActionAdapterKind = requiredActionAdapterKind;
    assert.throws(
      () => simulatePortfolioMandateEligibility(simulation),
      /mandate.requiredActionAdapterKind/,
    );
  }
});
