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
