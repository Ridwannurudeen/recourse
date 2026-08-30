import assert from "node:assert/strict";
import test from "node:test";
import { Interface, ZeroAddress, getAddress } from "ethers";
import {
  AuditScope,
  EvidenceKind,
  encodeApprovePolicyRegistryRuntimeVariant,
  encodePublishPolicyRegistryAuditArtifact,
  encodePublishPolicyRegistryRelease,
  encodeRecordPolicyRegistryDeployment,
  policyRegistryV1Abi,
  readPolicyRegistryAuditArtifact,
  readPolicyRegistryAuditScope,
  readPolicyRegistryDeployment,
  readPolicyRegistryCatalog,
  readPolicyRegistryRelease,
  readPolicyRegistryRuntimeVariant,
} from "../src/index.mjs";

const HASH = (byte) => `0x${byte.repeat(32)}`;
const ADDRESS = (suffix) => getAddress(`0x${suffix.padStart(40, "0")}`);

const RELEASE_ID = HASH("11");
const VARIANT_ID = HASH("12");
const DEPLOYMENT_ID = HASH("13");
const ARTIFACT_ID = HASH("14");

function releaseRequest(overrides = {}) {
  return {
    packageName: "event-history",
    version: "1.0.0",
    referenceImplementation: ADDRESS("101"),
    buildArtifactHash: HASH("21"),
    referenceConstructorArgumentsHash: HASH("22"),
    metadataHash: HASH("23"),
    evidenceKinds: [EvidenceKind.EventDelta, EvidenceKind.EventTransition],
    actionAdapters: [
      {
        adapterKind: HASH("31"),
        specificationHash: HASH("32"),
        metadataURI: "ipfs://freeze-vault-v1-metadata-only",
      },
    ],
    ...overrides,
  };
}

test("PolicyRegistryV1 ABI matches compiled selectors, topics, and fragment counts", () => {
  const registry = new Interface(policyRegistryV1Abi);
  const selectors = {
    MAX_ACTION_ADAPTERS: "0xb16f88e8",
    MAX_AUDIT_URI_BYTES: "0xdc4d958d",
    MAX_EVIDENCE_KINDS: "0xc1104c35",
    MAX_METADATA_URI_BYTES: "0x4e6b0bbe",
    MAX_PACKAGE_NAME_BYTES: "0xcbfd7c5b",
    MAX_VERSION_BYTES: "0xcd7fc464",
    actionAdapterAt: "0x7531fa05",
    actionAdapterCount: "0x1d143dc9",
    approveRuntimeVariant: "0x95eb83e0",
    auditArtifact: "0xb4beba7c",
    auditArtifactAt: "0xb99819e2",
    auditArtifactCount: "0x6fccb990",
    auditScopeHash: "0xdc50826e",
    declaresEvidenceKind: "0x2ae4772b",
    deploymentAt: "0x5b1d8482",
    deploymentCount: "0xdc781fd2",
    deploymentRecord: "0x3db457a3",
    evidenceKindAt: "0xe863b35a",
    evidenceKindCount: "0xf682bda0",
    packageRelease: "0x09dd3e42",
    publishAuditArtifact: "0x29b66317",
    publishRelease: "0xc9de395a",
    recordDeployment: "0x1020df75",
    releaseIdOf: "0x1bed5d61",
    releaseAt: "0xe5de44d2",
    releaseCount: "0xb8d08db2",
    runtimeVariant: "0x53a14beb",
    runtimeVariantAt: "0xa6e7c564",
    runtimeVariantCount: "0xab172a8c",
    runtimeVariantIdOf: "0x44f1f0c6",
  };
  for (const [name, selector] of Object.entries(selectors)) {
    assert.equal(registry.getFunction(name).selector, selector, name);
  }
  assert.deepEqual(
    {
      AuditArtifactPublished: registry.getEvent("AuditArtifactPublished")
        .topicHash,
      PackageReleasePublished: registry.getEvent("PackageReleasePublished")
        .topicHash,
      PolicyDeploymentRecorded: registry.getEvent("PolicyDeploymentRecorded")
        .topicHash,
      RuntimeVariantApproved: registry.getEvent("RuntimeVariantApproved")
        .topicHash,
    },
    {
      AuditArtifactPublished:
        "0xedd2e62dd59239eb70994580cc07737e4bd572b6da2a89bb7015d9e5d69f99dc",
      PackageReleasePublished:
        "0x346279c190cfc8ed89beb107575550e3ecd7b0aebd34daf24b11a715fafa06bc",
      PolicyDeploymentRecorded:
        "0xf9476efd8fc383ea7abd9c7c44da5e6f1fa2250a874872e1b25dad0bc74a48a5",
      RuntimeVariantApproved:
        "0xa74ad4ac5e5d1f0845bd802ab0430f07a30fccae49fb84d51cf4f87e96f0c637",
    },
  );
  assert.equal(
    registry.fragments.filter(({ type }) => type === "function").length,
    30,
  );
  assert.equal(
    registry.fragments.filter(({ type }) => type === "event").length,
    4,
  );
  assert.equal(
    registry.fragments.filter(({ type }) => type === "error").length,
    32,
  );
});

test("PolicyRegistryV1 calldata builders round-trip exact contract arguments", () => {
  const registry = new Interface(policyRegistryV1Abi);
  const request = releaseRequest();
  const published = registry.parseTransaction({
    data: encodePublishPolicyRegistryRelease(request),
  });
  assert.equal(published.name, "publishRelease");
  assert.equal(published.args.packageName, request.packageName);
  assert.equal(
    published.args.referenceImplementation,
    request.referenceImplementation,
  );
  assert.deepEqual([...published.args.evidenceKinds], [1n, 2n]);
  assert.equal(
    published.args.actionAdapters[0].metadataURI,
    request.actionAdapters[0].metadataURI,
  );

  const approved = registry.parseTransaction({
    data: encodeApprovePolicyRegistryRuntimeVariant({
      releaseId: RELEASE_ID,
      implementation: ADDRESS("102"),
      constructorArgumentsHash: HASH("24"),
    }),
  });
  assert.equal(approved.name, "approveRuntimeVariant");
  assert.equal(approved.args.releaseId, RELEASE_ID);

  const recorded = registry.parseTransaction({
    data: encodeRecordPolicyRegistryDeployment({
      releaseId: RELEASE_ID,
      kernel: ADDRESS("103"),
      facility: ADDRESS("104"),
      policyId: 7,
      runtimeVariantId: VARIANT_ID,
    }),
  });
  assert.equal(recorded.name, "recordDeployment");
  assert.equal(recorded.args.policyId, 7n);

  const audited = registry.parseTransaction({
    data: encodePublishPolicyRegistryAuditArtifact({
      scope: AuditScope.Deployment,
      scopeId: DEPLOYMENT_ID,
      artifactHash: HASH("25"),
      artifactURI: "ipfs://deployment-audit",
    }),
  });
  assert.equal(audited.name, "publishAuditArtifact");
  assert.equal(audited.args.scope, 1n);
});

test("PolicyRegistryV1 builders enforce only deterministic on-chain preconditions", () => {
  assert.throws(
    () =>
      encodePublishPolicyRegistryRelease(releaseRequest({ packageName: "" })),
    /packageName/,
  );
  assert.throws(
    () =>
      encodePublishPolicyRegistryRelease(
        releaseRequest({ packageName: "é".repeat(33) }),
      ),
    /packageName/,
  );
  assert.throws(
    () => encodePublishPolicyRegistryRelease(releaseRequest({ version: "" })),
    /version/,
  );
  assert.throws(
    () =>
      encodePublishPolicyRegistryRelease(
        releaseRequest({ referenceImplementation: ZeroAddress }),
      ),
    /referenceImplementation/,
  );
  for (const field of [
    "buildArtifactHash",
    "referenceConstructorArgumentsHash",
    "metadataHash",
  ]) {
    assert.throws(
      () =>
        encodePublishPolicyRegistryRelease(
          releaseRequest({ [field]: HASH("00") }),
        ),
      new RegExp(field),
    );
  }
  assert.throws(
    () =>
      encodePublishPolicyRegistryRelease(releaseRequest({ evidenceKinds: [] })),
    /evidenceKinds/,
  );
  assert.throws(
    () =>
      encodePublishPolicyRegistryRelease(
        releaseRequest({
          evidenceKinds: [EvidenceKind.EventDelta, EvidenceKind.EventDelta],
        }),
      ),
    /evidenceKinds/,
  );
  assert.throws(
    () =>
      encodePublishPolicyRegistryRelease(
        releaseRequest({ evidenceKinds: [3] }),
      ),
    /evidenceKinds/,
  );
  assert.throws(
    () =>
      encodePublishPolicyRegistryRelease(
        releaseRequest({
          actionAdapters: [
            {
              ...releaseRequest().actionAdapters[0],
              specificationHash: HASH("00"),
            },
          ],
        }),
      ),
    /specificationHash/,
  );
  assert.throws(
    () =>
      encodePublishPolicyRegistryRelease(
        releaseRequest({
          actionAdapters: [
            releaseRequest().actionAdapters[0],
            releaseRequest().actionAdapters[0],
          ],
        }),
      ),
    /actionAdapters/,
  );
  assert.throws(
    () =>
      encodePublishPolicyRegistryRelease(
        releaseRequest({
          actionAdapters: [
            {
              ...releaseRequest().actionAdapters[0],
              metadataURI: "a".repeat(257),
            },
          ],
        }),
      ),
    /metadataURI/,
  );

  assert.throws(
    () =>
      encodeApprovePolicyRegistryRuntimeVariant({
        releaseId: RELEASE_ID,
        implementation: ZeroAddress,
        constructorArgumentsHash: HASH("24"),
      }),
    /implementation/,
  );
  assert.throws(
    () =>
      encodeApprovePolicyRegistryRuntimeVariant({
        releaseId: RELEASE_ID,
        implementation: ADDRESS("102"),
        constructorArgumentsHash: HASH("00"),
      }),
    /constructorArgumentsHash/,
  );
  for (const field of ["kernel", "facility"]) {
    assert.throws(
      () =>
        encodeRecordPolicyRegistryDeployment({
          releaseId: RELEASE_ID,
          kernel: ADDRESS("103"),
          facility: ADDRESS("104"),
          policyId: 7,
          runtimeVariantId: VARIANT_ID,
          [field]: ZeroAddress,
        }),
      new RegExp(field),
    );
  }
  assert.throws(
    () =>
      encodePublishPolicyRegistryAuditArtifact({
        scope: 2,
        scopeId: DEPLOYMENT_ID,
        artifactHash: HASH("25"),
        artifactURI: "ipfs://audit",
      }),
    /scope/,
  );
  assert.throws(
    () =>
      encodePublishPolicyRegistryAuditArtifact({
        scope: AuditScope.Release,
        scopeId: RELEASE_ID,
        artifactHash: HASH("00"),
        artifactURI: "ipfs://audit",
      }),
    /artifactHash/,
  );
  assert.throws(
    () =>
      encodePublishPolicyRegistryAuditArtifact({
        scope: AuditScope.Release,
        scopeId: RELEASE_ID,
        artifactHash: HASH("25"),
        artifactURI: "",
      }),
    /artifactURI/,
  );

  assert.doesNotThrow(() =>
    encodePublishPolicyRegistryRelease(
      releaseRequest({ packageName: " ", version: " " }),
    ),
  );
  assert.doesNotThrow(() =>
    encodeApprovePolicyRegistryRuntimeVariant({
      releaseId: HASH("00"),
      implementation: ADDRESS("102"),
      constructorArgumentsHash: HASH("24"),
    }),
  );
});

function mockRegistryRunner(registry, handlers) {
  return {
    provider: {
      async getBlockNumber() {
        return 777;
      },
      async getBlock(blockTag) {
        return { number: Number(blockTag), hash: HASH("aa") };
      },
    },
    async call(transaction) {
      const parsed = registry.parseTransaction({ data: transaction.data });
      return registry.encodeFunctionResult(
        parsed.fragment,
        handlers[parsed.name](parsed.args),
      );
    },
  };
}

test("PolicyRegistryV1 reads hydrate releases and every indexed collection", async () => {
  const registry = new Interface(policyRegistryV1Abi);
  const release = {
    issuer: ADDRESS("201"),
    packageName: "event-history",
    version: "1.0.0",
    referenceImplementation: ADDRESS("202"),
    buildArtifactHash: HASH("41"),
    referenceRuntimeCodeHash: HASH("42"),
    referenceVariantId: VARIANT_ID,
    metadataHash: HASH("43"),
    releaseContentHash: HASH("44"),
    releasedAt: 1_000,
    exists: true,
  };
  const variant = {
    releaseId: RELEASE_ID,
    implementation: ADDRESS("202"),
    runtimeCodeHash: HASH("42"),
    constructorArgumentsHash: HASH("45"),
    approvedAt: 1_000,
    exists: true,
  };
  const adapter = {
    adapterKind: HASH("31"),
    specificationHash: HASH("32"),
    metadataURI: "ipfs://adapter",
  };
  const deployment = {
    releaseId: RELEASE_ID,
    chainId: 102_031,
    kernel: ADDRESS("203"),
    facility: ADDRESS("204"),
    policyId: 7,
    evaluator: ADDRESS("202"),
    runtimeVariantId: VARIANT_ID,
    runtimeCodeHash: HASH("42"),
    constructorArgumentsHash: HASH("45"),
    configHash: HASH("46"),
    manifestHash: HASH("46"),
    attester: ADDRESS("201"),
    recordedAt: 1_100,
    exists: true,
  };
  const artifact = {
    scope: AuditScope.Deployment,
    releaseId: RELEASE_ID,
    deploymentId: DEPLOYMENT_ID,
    scopeHash: HASH("47"),
    auditor: ADDRESS("205"),
    artifactHash: HASH("48"),
    artifactURI: "ipfs://deployment-audit",
    publishedAt: 1_200,
    exists: true,
  };
  const runner = mockRegistryRunner(registry, {
    releaseCount: () => [1],
    releaseAt: () => [RELEASE_ID],
    packageRelease: () => [release],
    runtimeVariantCount: () => [1],
    runtimeVariantAt: () => [VARIANT_ID],
    runtimeVariant: () => [variant],
    evidenceKindCount: () => [2],
    evidenceKindAt: ([, index]) => [
      index === 0n ? EvidenceKind.EventDelta : EvidenceKind.EventTransition,
    ],
    actionAdapterCount: () => [1],
    actionAdapterAt: () => [adapter],
    deploymentCount: () => [1],
    deploymentAt: () => [DEPLOYMENT_ID],
    deploymentRecord: () => [deployment],
    auditArtifact: () => [artifact],
    auditScopeHash: () => [artifact.scopeHash],
    auditArtifactCount: () => [1],
    auditArtifactAt: () => [ARTIFACT_ID],
  });
  const registryAddress = ADDRESS("206");

  const hydrated = await readPolicyRegistryRelease(
    registryAddress,
    runner,
    RELEASE_ID,
  );
  assert.equal(hydrated.address, registryAddress);
  assert.equal(hydrated.blockTag, 777);
  assert.equal(hydrated.blockHash, HASH("aa"));
  assert.equal(hydrated.release.releaseContentHash, release.releaseContentHash);
  assert.deepEqual(hydrated.evidenceKinds, [1n, 2n]);
  assert.equal(hydrated.actionAdapters[0].metadataURI, adapter.metadataURI);
  assert.equal(hydrated.runtimeVariants[0].runtimeVariantId, VARIANT_ID);
  assert.equal(hydrated.runtimeVariants[0].variant.approvedAt, 1_000n);
  assert.equal(hydrated.deployments[0].deploymentId, DEPLOYMENT_ID);
  assert.equal(hydrated.deployments[0].deployment.chainId, 102_031n);
  assert.equal(hydrated.runtimeVariantTotalCount, 1);
  assert.equal(hydrated.deploymentTotalCount, 1);
  assert.equal(hydrated.nextCursor, null);

  const catalog = await readPolicyRegistryCatalog(registryAddress, runner);
  assert.equal(catalog.blockTag, 777);
  assert.equal(catalog.blockHash, HASH("aa"));
  assert.equal(catalog.totalCount, 1);
  assert.equal(catalog.start, 0);
  assert.equal(catalog.nextIndex, null);
  assert.equal(catalog.nextCursor, null);
  assert.equal(catalog.truncated, false);
  assert.equal(catalog.releases.length, 1);
  assert.equal(catalog.releases[0].releaseId, RELEASE_ID);
  assert.equal(catalog.releases[0].release.packageName, "event-history");

  assert.equal(
    (
      await readPolicyRegistryRuntimeVariant(
        registryAddress,
        runner,
        VARIANT_ID,
      )
    ).variant.releaseId,
    RELEASE_ID,
  );
  assert.equal(
    (await readPolicyRegistryDeployment(registryAddress, runner, DEPLOYMENT_ID))
      .deployment.policyId,
    7n,
  );
  assert.equal(
    (
      await readPolicyRegistryAuditArtifact(
        registryAddress,
        runner,
        ARTIFACT_ID,
      )
    ).artifact.auditor,
    artifact.auditor,
  );
  const auditScope = await readPolicyRegistryAuditScope(
    registryAddress,
    runner,
    AuditScope.Deployment,
    DEPLOYMENT_ID,
  );
  assert.equal(auditScope.scopeHash, artifact.scopeHash);
  assert.equal(auditScope.blockHash, HASH("aa"));
  assert.equal(auditScope.totalCount, 1);
  assert.equal(auditScope.nextCursor, null);
  assert.equal(auditScope.artifacts[0].artifactId, ARTIFACT_ID);
  assert.equal(
    auditScope.artifacts[0].artifact.artifactURI,
    artifact.artifactURI,
  );
});

test("PolicyRegistryV1 catalog reads are bounded, paged, and safe past the final release", async () => {
  const registry = new Interface(policyRegistryV1Abi);
  const releaseIds = [HASH("51"), HASH("52"), HASH("53")];
  const requestedIndexes = [];
  const runner = mockRegistryRunner(registry, {
    releaseCount: () => [releaseIds.length],
    releaseAt: ([index]) => {
      requestedIndexes.push(Number(index));
      return [releaseIds[Number(index)]];
    },
    packageRelease: ([releaseId]) => [
      {
        issuer: ADDRESS("301"),
        packageName: `package-${releaseIds.indexOf(releaseId)}`,
        version: "1.0.0",
        referenceImplementation: ADDRESS("302"),
        buildArtifactHash: HASH("61"),
        referenceRuntimeCodeHash: HASH("62"),
        referenceVariantId: HASH("63"),
        metadataHash: HASH("64"),
        releaseContentHash: HASH("65"),
        releasedAt: 1_000,
        exists: true,
      },
    ],
    runtimeVariantCount: () => [0],
    evidenceKindCount: () => [0],
    actionAdapterCount: () => [0],
    deploymentCount: () => [0],
  });

  const first = await readPolicyRegistryCatalog(ADDRESS("303"), runner, {
    start: 0,
    limit: 2,
  });
  assert.equal(first.totalCount, 3);
  assert.equal(first.nextIndex, 2);
  assert.deepEqual(first.nextCursor, {
    blockNumber: 777,
    blockHash: HASH("aa"),
    nextIndex: 2,
  });
  assert.equal(first.truncated, true);
  assert.deepEqual(
    first.releases.map(({ releaseId }) => releaseId),
    releaseIds.slice(0, 2),
  );

  const final = await readPolicyRegistryCatalog(ADDRESS("303"), runner, {
    cursor: first.nextCursor,
    limit: 2,
  });
  assert.equal(final.nextIndex, null);
  assert.equal(final.truncated, false);
  assert.equal(final.nextCursor, null);
  assert.deepEqual(
    final.releases.map(({ releaseId }) => releaseId),
    releaseIds.slice(2),
  );

  const pastFinal = await readPolicyRegistryCatalog(ADDRESS("303"), runner, {
    cursor: {
      blockNumber: 777,
      blockHash: HASH("aa"),
      nextIndex: 99,
    },
    limit: 2,
  });
  assert.deepEqual(pastFinal.releases, []);
  assert.equal(pastFinal.nextIndex, null);
  assert.equal(pastFinal.truncated, false);
  assert.deepEqual(requestedIndexes, [0, 1, 2]);

  await assert.rejects(
    readPolicyRegistryCatalog(ADDRESS("303"), runner, { limit: 101 }),
    /catalog limit/,
  );
  await assert.rejects(
    readPolicyRegistryCatalog(ADDRESS("303"), runner, { start: 1 }),
    /requires a continuation cursor/,
  );
});

test("registry continuations reject a changed block hash and detailed collections stay bounded", async () => {
  const registry = new Interface(policyRegistryV1Abi);
  const releaseIds = [HASH("71"), HASH("72"), HASH("73")];
  const variantIds = [HASH("81"), HASH("82"), HASH("83")];
  const deploymentIds = [HASH("91"), HASH("92"), HASH("93")];
  const artifactIds = [HASH("a1"), HASH("a2"), HASH("a3")];
  const release = {
    issuer: ADDRESS("401"),
    packageName: "bounded-release",
    version: "1.0.0",
    referenceImplementation: ADDRESS("402"),
    buildArtifactHash: HASH("b1"),
    referenceRuntimeCodeHash: HASH("b2"),
    referenceVariantId: variantIds[0],
    metadataHash: HASH("b3"),
    releaseContentHash: HASH("b4"),
    releasedAt: 1_000,
    exists: true,
  };
  const runner = mockRegistryRunner(registry, {
    releaseCount: () => [releaseIds.length],
    releaseAt: ([index]) => [releaseIds[Number(index)]],
    packageRelease: () => [release],
    evidenceKindCount: () => [0],
    actionAdapterCount: () => [0],
    runtimeVariantCount: () => [variantIds.length],
    runtimeVariantAt: ([, index]) => [variantIds[Number(index)]],
    runtimeVariant: ([variantId]) => [
      {
        releaseId: RELEASE_ID,
        implementation: ADDRESS("402"),
        runtimeCodeHash: HASH("b2"),
        constructorArgumentsHash: HASH("b5"),
        approvedAt: 1_000,
        exists: variantIds.includes(variantId),
      },
    ],
    deploymentCount: () => [deploymentIds.length],
    deploymentAt: ([, index]) => [deploymentIds[Number(index)]],
    deploymentRecord: () => [
      {
        releaseId: RELEASE_ID,
        chainId: 102_031,
        kernel: ADDRESS("403"),
        facility: ADDRESS("404"),
        policyId: 7,
        evaluator: ADDRESS("402"),
        runtimeVariantId: variantIds[0],
        runtimeCodeHash: HASH("b2"),
        constructorArgumentsHash: HASH("b5"),
        configHash: HASH("b6"),
        manifestHash: HASH("b6"),
        attester: ADDRESS("401"),
        recordedAt: 1_100,
        exists: true,
      },
    ],
    auditScopeHash: () => [HASH("c1")],
    auditArtifactCount: () => [artifactIds.length],
    auditArtifactAt: ([, , index]) => [artifactIds[Number(index)]],
    auditArtifact: ([artifactId]) => [
      {
        scope: AuditScope.Release,
        releaseId: RELEASE_ID,
        deploymentId: HASH("00"),
        scopeHash: HASH("c1"),
        auditor: ADDRESS("405"),
        artifactHash: artifactId,
        artifactURI: "ipfs://audit",
        publishedAt: 1_200,
        exists: true,
      },
    ],
  });

  const firstRelease = await readPolicyRegistryRelease(
    ADDRESS("406"),
    runner,
    RELEASE_ID,
    { detailLimit: 2 },
  );
  assert.equal(firstRelease.runtimeVariants.length, 2);
  assert.equal(firstRelease.deployments.length, 2);
  assert.deepEqual(firstRelease.nextCursor, {
    blockNumber: 777,
    blockHash: HASH("aa"),
    runtimeNextIndex: 2,
    deploymentNextIndex: 2,
  });
  const finalRelease = await readPolicyRegistryRelease(
    ADDRESS("406"),
    runner,
    RELEASE_ID,
    { detailLimit: 2, cursor: firstRelease.nextCursor },
  );
  assert.equal(finalRelease.runtimeVariants.length, 1);
  assert.equal(finalRelease.deployments.length, 1);
  assert.equal(finalRelease.nextCursor, null);

  const firstAudit = await readPolicyRegistryAuditScope(
    ADDRESS("406"),
    runner,
    AuditScope.Release,
    RELEASE_ID,
    { limit: 2 },
  );
  assert.equal(firstAudit.artifacts.length, 2);
  const finalAudit = await readPolicyRegistryAuditScope(
    ADDRESS("406"),
    runner,
    AuditScope.Release,
    RELEASE_ID,
    { limit: 2, cursor: firstAudit.nextCursor },
  );
  assert.equal(finalAudit.artifacts.length, 1);
  assert.equal(finalAudit.nextCursor, null);

  const firstCatalog = await readPolicyRegistryCatalog(ADDRESS("406"), runner, {
    limit: 1,
  });
  runner.provider.getBlock = async (blockTag) => ({
    number: Number(blockTag),
    hash: HASH("ff"),
  });
  await assert.rejects(
    readPolicyRegistryCatalog(ADDRESS("406"), runner, {
      cursor: firstCatalog.nextCursor,
    }),
    /continuation hash/,
  );
});
