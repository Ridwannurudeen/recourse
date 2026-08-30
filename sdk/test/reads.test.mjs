import assert from "node:assert/strict";
import test from "node:test";
import { Interface, ZeroAddress, getAddress } from "ethers";
import {
  AuditScope,
  ObservationKind,
  policyKernelV1Abi,
  policyRegistryV1Abi,
  proofJobsV1Abi,
  readCreditState,
  readFacility,
  readFacilityFactory,
  readPolicyRegistration,
  readPolicyRegistryAuditArtifact,
  readPolicyRegistryAuditScope,
  readPolicyRegistryDeployment,
  readPolicyRegistryRelease,
  readPolicyRegistryRuntimeVariant,
  readProofJob,
  recourseFacilityFactoryV2Abi,
  recourseFacilityV2Abi,
  verifiedCreditStateV1Abi,
} from "../src/index.mjs";

const HASH = (byte) => `0x${byte.repeat(32)}`;
const ADDRESS = (suffix) => getAddress(`0x${suffix.padStart(40, "0")}`);

const targets = {
  facility: ADDRESS("101"),
  factory: ADDRESS("102"),
  creditState: ADDRESS("103"),
  proofJobs: ADDRESS("104"),
  kernel: ADDRESS("105"),
  registry: ADDRESS("106"),
};

function zeroValue(parameter) {
  if (parameter.baseType === "array") return [];
  if (parameter.baseType === "tuple")
    return parameter.components.map(zeroValue);
  if (parameter.type === "address") return ZeroAddress;
  if (parameter.type === "bool") return false;
  if (parameter.type === "string") return "";
  if (parameter.type === "bytes") return "0x";
  if (/^bytes\d+$/.test(parameter.type))
    return `0x${"00".repeat(Number(parameter.type.slice(5)))}`;
  if (/^(u?int)\d*$/.test(parameter.type)) return 0n;
  throw new Error(`Unsupported ABI output ${parameter.type}`);
}

function createRunner(outputOverrides = {}, options = {}) {
  const interfaces = new Map([
    [targets.facility, new Interface(recourseFacilityV2Abi)],
    [targets.factory, new Interface(recourseFacilityFactoryV2Abi)],
    [targets.creditState, new Interface(verifiedCreditStateV1Abi)],
    [targets.proofJobs, new Interface(proofJobsV1Abi)],
    [targets.kernel, new Interface(policyKernelV1Abi)],
    [targets.registry, new Interface(policyRegistryV1Abi)],
  ]);
  const calls = [];
  let blockNumberReads = 0;
  const blockLookups = [];
  const blockResponses = options.blockResponses
    ? [...options.blockResponses]
    : null;
  const provider = {
    async getBlockNumber() {
      blockNumberReads += 1;
      return 777;
    },
    async getBlock(blockTag) {
      blockLookups.push(blockTag);
      if (blockResponses) return blockResponses.shift() ?? null;
      return {
        number: typeof blockTag === "number" ? blockTag : 700,
        hash: HASH("aa"),
      };
    },
  };
  const runner = {
    provider,
    async call(transaction) {
      calls.push(transaction);
      const contractInterface = interfaces.get(getAddress(transaction.to));
      assert.ok(contractInterface, `Unexpected target ${transaction.to}`);
      const parsed = contractInterface.parseTransaction({
        data: transaction.data,
      });
      assert.ok(parsed);
      const outputs = Object.hasOwn(outputOverrides, parsed.name)
        ? outputOverrides[parsed.name]
        : parsed.fragment.outputs.map(zeroValue);
      return contractInterface.encodeFunctionResult(parsed.fragment, outputs);
    },
  };
  return {
    blockLookups,
    calls,
    runner,
    get blockNumberReads() {
      return blockNumberReads;
    },
  };
}

test("every aggregate read pins all calls to one derived snapshot block", async () => {
  const observed = createRunner();
  const facility = ADDRESS("201");
  const borrower = ADDRESS("202");
  const hunter = ADDRESS("203");
  const releaseId = HASH("11");
  const runtimeVariantId = HASH("12");
  const deploymentId = HASH("13");
  const artifactId = HASH("14");

  const results = await Promise.all([
    readFacility(targets.facility, observed.runner),
    readFacilityFactory(targets.factory, observed.runner),
    readCreditState(
      targets.creditState,
      observed.runner,
      facility,
      borrower,
      ObservationKind.Ownership,
    ),
    readProofJob(targets.proofJobs, observed.runner, 1n, {
      hunter,
      evidenceDigest: HASH("21"),
      claimableAccount: hunter,
    }),
    readPolicyRegistration(targets.kernel, observed.runner, facility, 1n),
    readPolicyRegistryRelease(targets.registry, observed.runner, releaseId),
    readPolicyRegistryRuntimeVariant(
      targets.registry,
      observed.runner,
      runtimeVariantId,
    ),
    readPolicyRegistryDeployment(
      targets.registry,
      observed.runner,
      deploymentId,
    ),
    readPolicyRegistryAuditArtifact(
      targets.registry,
      observed.runner,
      artifactId,
    ),
    readPolicyRegistryAuditScope(
      targets.registry,
      observed.runner,
      AuditScope.Deployment,
      deploymentId,
    ),
  ]);

  assert.equal(observed.blockNumberReads, results.length);
  assert.equal(observed.blockLookups.length, results.length * 2);
  for (const blockLookup of observed.blockLookups)
    assert.equal(blockLookup, 777);
  for (const result of results) assert.equal(result.blockTag, 777);
  assert.ok(observed.calls.length > results.length);
  for (const call of observed.calls) assert.equal(call.blockTag, 777);

  const creditState = results[2];
  const proofJob = results[3];
  assert.equal(typeof creditState.latest.observation.kind, "bigint");
  assert.equal(typeof proofJob.job.state, "bigint");
  assert.equal(typeof proofJob.commitment.committedBlock, "bigint");
});

test("an explicit snapshot block bypasses provider block discovery", async () => {
  const observed = createRunner();
  const result = await readFacility(targets.facility, observed.runner, {
    blockTag: 456,
  });

  assert.equal(observed.blockNumberReads, 0);
  assert.deepEqual(observed.blockLookups, [456, 456]);
  assert.equal(result.blockTag, 456);
  assert.ok(observed.calls.length > 0);
  for (const call of observed.calls) assert.equal(call.blockTag, 456);
});

test("dynamic block tags resolve once and pending snapshots are rejected", async () => {
  const latest = createRunner();
  const latestResult = await readFacility(targets.facility, latest.runner, {
    blockTag: "latest",
  });
  assert.equal(latest.blockNumberReads, 1);
  assert.deepEqual(latest.blockLookups, [777, 777]);
  assert.equal(latestResult.blockTag, 777);
  for (const call of latest.calls) assert.equal(call.blockTag, 777);

  const safe = createRunner();
  const safeResult = await readFacility(targets.facility, safe.runner, {
    blockTag: "safe",
  });
  assert.deepEqual(safe.blockLookups, ["safe", 700, 700]);
  assert.equal(safeResult.blockTag, 700);
  for (const call of safe.calls) assert.equal(call.blockTag, 700);

  const relative = createRunner();
  const relativeResult = await readFacility(targets.facility, relative.runner, {
    blockTag: -1,
  });
  assert.equal(relative.blockNumberReads, 1);
  assert.deepEqual(relative.blockLookups, [776, 776]);
  assert.equal(relativeResult.blockTag, 776);
  for (const call of relative.calls) assert.equal(call.blockTag, 776);

  const pending = createRunner();
  await assert.rejects(
    readFacility(targets.facility, pending.runner, { blockTag: "pending" }),
    /pending blockTag/,
  );
  assert.equal(pending.calls.length, 0);
});

test("aggregate reads reject a snapshot when its block hash changes", async () => {
  const observed = createRunner(
    {},
    {
      blockResponses: [
        { number: 456, hash: HASH("aa") },
        { number: 456, hash: HASH("bb") },
      ],
    },
  );

  await assert.rejects(
    readFacility(targets.facility, observed.runner, { blockTag: 456 }),
    /Block 456 changed while the SDK snapshot was being read/,
  );
  assert.deepEqual(observed.blockLookups, [456, 456]);
});

test("aggregate reads reject a snapshot when its final anchor is missing", async () => {
  const observed = createRunner(
    {},
    {
      blockResponses: [{ number: 456, hash: HASH("aa") }, null],
    },
  );

  await assert.rejects(
    readFacility(targets.facility, observed.runner, { blockTag: 456 }),
    /Block 456 changed while the SDK snapshot was being read/,
  );
  assert.deepEqual(observed.blockLookups, [456, 456]);
});

test("aggregate collection counts reject values that cannot be indexed safely", async () => {
  const oversized = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  const facility = ADDRESS("201");
  const borrower = ADDRESS("202");
  const cases = [
    {
      observed: createRunner({ policyCount: [oversized] }),
      read: (runner) => readFacility(targets.facility, runner),
      error: /policy count/,
    },
    {
      observed: createRunner({ facilityCount: [oversized] }),
      read: (runner) => readFacilityFactory(targets.factory, runner),
      error: /facility count/,
    },
    {
      observed: createRunner({ observationCount: [oversized] }),
      read: (runner) =>
        readCreditState(
          targets.creditState,
          runner,
          facility,
          borrower,
          ObservationKind.Ownership,
        ),
      error: /observation count/,
    },
  ];

  for (const { observed, read, error } of cases) {
    await assert.rejects(read(observed.runner), error);
  }
});
