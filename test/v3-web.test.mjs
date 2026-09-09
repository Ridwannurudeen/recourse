import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DeploymentTruth,
  EXTENSION_DEPLOYMENT,
  readV3Extensions,
  summarizeV3Extensions,
  anchorV3Snapshot,
  summarizeV3Snapshot,
} from "../web/v3-core.mjs";

const HASH = (byte) => `0x${byte.repeat(32)}`;
const ADDRESS = (suffix) => `0x${suffix.padStart(40, "0")}`;

function extensions() {
  const pinned = EXTENSION_DEPLOYMENT;
  return {
    contracts: Object.entries(pinned.contracts).map(([name, address]) => ({
      name,
      address,
      hasCode: true,
    })),
    verifier: { attestor: pinned.attestor },
    market: {
      verifier: pinned.contracts.OperatorServiceVerifierV1,
      token: pinned.token,
      minimumOperatorBond: 100000000n,
      quoteCount: 0n,
    },
    pool: {
      status: 0n,
      mandate: pinned.contracts.PortfolioMandateV1,
      asset: pinned.token,
      facilityCount: 0n,
      maximumPoolAssets: 300000000000n,
      fundingDeadline: 1789591485n,
      investorCount: 0n,
      allocatedFacilityCount: 0n,
      totalDeposited: 0n,
      totalAllocatedPrincipal: 0n,
      assetBalance: 0n,
    },
    mandate: {
      factory: pinned.contracts.CappedPilotFactoryV1,
      requiredReleaseId: pinned.activatedReleaseId,
      requiredActionAdapterKind: HASH("00"),
      requiredPolicySetCommitment: HASH("11"),
      requiredEvidenceKind: 1n,
    },
    factory: { lender: pinned.contracts.PortfolioPoolV1, facilityCount: 0n },
    errors: [],
  };
}

test("Extension constants pin all addresses, deployment blocks, token, attestor and activated release to manifests", async () => {
  for (const name of [
    "operator-service-verifier",
    "operator-market",
    "portfolio-core",
  ]) {
    const manifest = JSON.parse(
      await readFile(
        new URL(`../deployments-v3-${name}-current.json`, import.meta.url),
        "utf8",
      ),
    );
    for (const [contract, address] of Object.entries(manifest.contracts)) {
      assert.equal(EXTENSION_DEPLOYMENT.contracts[contract], address);
      assert.equal(
        EXTENSION_DEPLOYMENT.deploymentBlocks[contract],
        manifest.transactions[contract].blockNumber,
      );
    }
    if (name === "operator-service-verifier")
      assert.equal(
        EXTENSION_DEPLOYMENT.attestor,
        manifest.constructors.OperatorServiceVerifierV1.values[0],
      );
    if (name === "operator-market")
      assert.equal(
        EXTENSION_DEPLOYMENT.token,
        manifest.constructors.OperatorMarketV1.values[0],
      );
  }
  const activation = JSON.parse(
    await readFile(
      new URL("../activation-v3-current.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(
    EXTENSION_DEPLOYMENT.activatedReleaseId,
    activation.registry.releaseId,
  );
});

test("Extension truth reflects empty deployed state without inventing capital or action requirements", () => {
  const input = extensions();
  const result = summarizeV3Extensions(input);
  assert.equal(result.truth, DeploymentTruth.Deployed);
  assert.equal(
    result.poolStatement,
    "Deployed · Configuring · no facilities, no capital, no allocation",
  );
  assert.equal(
    result.marketStatement,
    "Deployed · empty · single project-operated attestor",
  );
  assert.equal(
    result.mandateStatement,
    "No action adapter required by this mandate",
  );
  for (const field of [
    "totalDeposited",
    "totalAllocatedPrincipal",
    "assetBalance",
    "allocatedFacilityCount",
  ]) {
    const changed = extensions();
    changed.pool[field] = 1n;
    assert.doesNotMatch(
      summarizeV3Extensions(changed).poolStatement,
      /no capital/,
    );
  }
  input.market.quoteCount = 1n;
  input.mandate.requiredActionAdapterKind = HASH("ab");
  assert.match(summarizeV3Extensions(input).marketStatement, /1 quotes/);
  assert.doesNotMatch(
    summarizeV3Extensions(input).mandateStatement,
    /No action adapter/,
  );
});

test("Extension wiring mismatches stay inconsistent and isolated from the current core", () => {
  for (const [section, field] of [
    ["market", "verifier"],
    ["pool", "mandate"],
    ["mandate", "factory"],
    ["factory", "lender"],
    ["verifier", "attestor"],
    ["market", "token"],
    ["pool", "asset"],
    ["mandate", "requiredReleaseId"],
  ]) {
    const input = extensions();
    input[section][field] =
      field === "requiredReleaseId" ? HASH("ff") : ADDRESS("ff");
    const result = summarizeV3Snapshot(snapshot({ extensions: input }));
    assert.equal(result.coreDeployment, DeploymentTruth.Deployed);
    assert.equal(result.extensions.truth, DeploymentTruth.Inconsistent);
    assert.match(
      result.extensions.issues.join(" "),
      new RegExp(`${section}.${field}`),
    );
  }
  const missing = extensions();
  missing.contracts[0].hasCode = false;
  assert.equal(
    summarizeV3Snapshot(snapshot({ extensions: missing })).extensions.truth,
    DeploymentTruth.Unavailable,
  );
});

test("Real extension reader pins every getter and code check and isolates missing code and RPC failure", async () => {
  for (const failure of [null, "code", "read"]) {
    const fixture = extensions();
    const calls = [];
    const byAddress = Object.fromEntries(
      ["verifier", "market", "pool", "factory", "mandate"].map((key, index) => [
        Object.values(EXTENSION_DEPLOYMENT.contracts)[index],
        fixture[key],
      ]),
    );
    const provider = {
      getCode: async (address, blockTag) => {
        assert.equal(blockTag, 123);
        calls.push(`code:${address}`);
        return failure === "code" &&
          address === EXTENSION_DEPLOYMENT.contracts.OperatorMarketV1
          ? "0x"
          : "0x01";
      },
    };
    class Contract {
      constructor(address, abi) {
        for (const fragment of abi) {
          const method = fragment.match(/function (\w+)\(/)[1];
          this[method] = async (...args) => {
            assert.deepEqual(args.at(-1), { blockTag: 123 });
            calls.push(`${address}:${method}`);
            if (failure === "read" && method === "attestor")
              throw new Error("read failed");
            if (method === "balanceOf") {
              assert.equal(
                args[0],
                EXTENSION_DEPLOYMENT.contracts.PortfolioPoolV1,
              );
              return fixture.pool.assetBalance;
            }
            const value =
              byAddress[address][
                method === "createdFacilityCount" ? "facilityCount" : method
              ];
            assert.notEqual(value, undefined, method);
            return value;
          };
        }
      }
    }
    const read = await readV3Extensions(provider, Contract, 123);
    assert.equal(calls.filter((call) => call.startsWith("code:")).length, 5);
    if (!failure) {
      assert.deepEqual(
        {
          ...read,
          contracts: [...read.contracts].sort((a, b) =>
            a.name.localeCompare(b.name),
          ),
        },
        {
          ...fixture,
          contracts: [...fixture.contracts].sort((a, b) =>
            a.name.localeCompare(b.name),
          ),
        },
      );
      assert.equal(calls.length, 28);
      assert.equal(summarizeV3Extensions(read).truth, DeploymentTruth.Deployed);
    } else {
      assert.equal(
        summarizeV3Extensions(read).truth,
        DeploymentTruth.Unavailable,
      );
      assert.equal(read.pool.assetBalance, 0n);
      if (failure === "code")
        assert.equal(
          calls.some((call) =>
            call.startsWith(
              `${EXTENSION_DEPLOYMENT.contracts.OperatorMarketV1}:`,
            ),
          ),
          false,
        );
      else assert.match(read.errors[0], /read failed/);
    }
  }
});

function snapshot(overrides = {}) {
  return {
    anchor: {
      chainId: 102031,
      blockNumber: 5_400_130,
      blockHash: HASH("aa"),
      blockTimestamp: 1_788_091_200,
    },
    contracts: [
      { name: "PolicyKernelV2", address: ADDRESS("1"), hasCode: true },
      { name: "PolicyRegistryV1", address: ADDRESS("2"), hasCode: true },
      { name: "CappedPilotFactoryV1", address: ADDRESS("3"), hasCode: true },
      { name: "MultiChainEventPolicyV1", address: ADDRESS("4"), hasCode: true },
      { name: "ProofJobsV1", address: ADDRESS("5"), hasCode: true },
    ],
    kernel: {
      proofJobs: ADDRESS("5"),
      expectedProofJobs: ADDRESS("5"),
      safeStaleProofRelease: true,
    },
    factory: {
      facilityCount: 0,
      maximumFacilityCount: 3,
      totalFacilityLimit: 0n,
      maximumTotalLimit: 300_000_000_000n,
      creationPaused: false,
    },
    facilities: [],
    registryReleaseCount: 0,
    nextProofJobId: 1n,
    localCapabilities: [
      { name: "OperatorMarketV1", deploymentAddress: null },
      { name: "PortfolioMandateV1", deploymentAddress: null },
      { name: "PortfolioPoolV1", deploymentAddress: null },
    ],
    ...overrides,
  };
}

test("V3 summary separates deployed, empty, configured, activated, and external-gated truth", () => {
  const summary = summarizeV3Snapshot(snapshot());
  assert.equal(summary.coreDeployment, DeploymentTruth.Deployed);
  assert.equal(summary.factoryState, DeploymentTruth.Empty);
  assert.equal(summary.configuredFacilities, 0);
  assert.equal(summary.activatedFacilities, 0);
  assert.equal(summary.registryState, DeploymentTruth.Empty);
  assert.equal(summary.proofJobState, DeploymentTruth.Empty);
  assert.equal(summary.localCapabilities[0].truth, DeploymentTruth.SourceOnly);
  assert.equal(summary.externalGates.length > 0, true);

  const active = summarizeV3Snapshot(
    snapshot({
      factory: {
        ...snapshot().factory,
        facilityCount: 1,
        totalFacilityLimit: 100_000_000_000n,
      },
      facilities: [
        {
          address: ADDRESS("9"),
          status: 1,
          registeredPolicies: 1,
          appliedEffects: 1,
          policySetCommitment: HASH("99"),
          multiChainPoliciesConfigured: 1,
        },
      ],
    }),
  );
  assert.equal(active.factoryState, DeploymentTruth.Activated);
  assert.equal(active.configuredFacilities, 1);
  assert.equal(active.activatedFacilities, 1);
});

test("V3 summary never upgrades cancelled or incomplete inventory into activation", () => {
  const cancelled = summarizeV3Snapshot(
    snapshot({
      factory: {
        ...snapshot().factory,
        facilityCount: 1,
        totalFacilityLimit: 100_000_000_000n,
      },
      facilities: [
        {
          address: ADDRESS("9"),
          status: 4,
          registeredPolicies: 1,
          appliedEffects: 1,
          policySetCommitment: HASH("99"),
          multiChainPoliciesConfigured: 1,
        },
      ],
    }),
  );
  assert.equal(cancelled.factoryState, DeploymentTruth.Configured);
  assert.equal(cancelled.configuredFacilities, 1);
  assert.equal(cancelled.activatedFacilities, 0);
  assert.throws(
    () =>
      summarizeV3Snapshot(
        snapshot({
          factory: { ...snapshot().factory, facilityCount: 1 },
          facilities: [],
        }),
      ),
    /Incomplete facility inventory/,
  );
});

test("V3 activates registered and configured policies before any effects are applied", () => {
  const input = snapshot({
    factory: { ...snapshot().factory, facilityCount: 1 },
    facilities: [
      {
        address: "0x00B50626C4AA42d22ca01AAEa8649f253aEc5B1e",
        status: 1,
        registeredPolicies: 1,
        multiChainPoliciesConfigured: 1,
        appliedEffects: 0,
        policySetCommitment: HASH("99"),
      },
    ],
  });
  const summary = summarizeV3Snapshot(input);
  assert.equal(summary.facilities[0].truth, DeploymentTruth.Activated);
  assert.equal(summary.facilities[0].registeredPolicies, 1);
  assert.equal(summary.facilities[0].configuredPolicies, 1);
  assert.equal(summary.facilities[0].appliedEffects, 0);
  assert.equal(summary.configuredFacilities, 1);
  assert.equal(summary.activatedFacilities, 1);
  assert.equal(summary.factoryState, DeploymentTruth.Activated);

  input.facilities[0].multiChainPoliciesConfigured = 2;
  assert.throws(
    () => summarizeV3Snapshot(input),
    /Inconsistent .* policy counts/,
  );
  input.facilities[0].multiChainPoliciesConfigured = 0;
  assert.equal(
    summarizeV3Snapshot(input).facilities[0].truth,
    DeploymentTruth.Deployed,
  );
  input.facilities[0].multiChainPoliciesConfigured = 1;
  input.facilities[0].policySetCommitment = HASH("00");
  assert.equal(
    summarizeV3Snapshot(input).facilities[0].truth,
    DeploymentTruth.Deployed,
  );
});

test("V3 anchored reads reject a block hash change", async () => {
  const blocks = [
    { number: 12, hash: HASH("aa"), timestamp: 1_000 },
    { number: 12, hash: HASH("bb"), timestamp: 1_000 },
  ];
  await assert.rejects(
    anchorV3Snapshot(
      {
        send: async () => "0x18e8f",
        getBlock: async () => blocks.shift(),
      },
      102031,
      12,
      async () => "state",
    ),
    /changed during the V3 read/,
  );
});

test("V3 anchored reads expose the exact pinned block and reject the wrong chain", async () => {
  const block = { number: 12, hash: HASH("aa"), timestamp: 1_000 };
  const provider = {
    send: async () => "0x18e8f",
    getBlock: async () => block,
  };
  const anchored = await anchorV3Snapshot(
    provider,
    102031,
    12,
    async (blockTag, anchor) => ({ blockTag, anchor }),
  );
  assert.equal(anchored.value.blockTag, 12);
  assert.deepEqual(anchored.value.anchor, anchored.anchor);
  await assert.rejects(
    anchorV3Snapshot(provider, 1, 12, async () => "unreachable"),
    /RPC chain ID/,
  );
});

test("V3 observatory is walletless, safe-DOM, and names every truth boundary", async () => {
  const [html, script, index, horizon, operator, portfolio] = await Promise.all(
    [
      readFile(new URL("../web/v3.html", import.meta.url), "utf8"),
      readFile(new URL("../web/v3.js", import.meta.url), "utf8"),
      readFile(new URL("../web/index.html", import.meta.url), "utf8"),
      readFile(new URL("../web/horizon1.html", import.meta.url), "utf8"),
      readFile(new URL("../web/operator.html", import.meta.url), "utf8"),
      readFile(new URL("../web/portfolio.html", import.meta.url), "utf8"),
    ],
  );
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(
    script,
    /BrowserProvider|eth_requestAccounts|sendTransaction/,
  );
  assert.match(script, /\.textContent =/);
  assert.match(html, /id="v3-state"[^>]*aria-live="polite"/);
  assert.match(html, /id="v3-extensions"/);
  assert.match(html, /id="v3-extension-details"/);
  assert.match(script, /readV3Extensions\(provider, Contract, blockTag\)/);
  assert.match(script, /dataset.truth = extensions.truth/);
  assert.match(script, /extensions\.contracts\.some/);
  assert.doesNotMatch(html, /items 9.10\s+are not deployed/i);
  assert.match(html, /deployed/i);
  assert.match(html, /configured/i);
  assert.match(html, /activated/i);
  assert.match(html, /external.gated/i);
  assert.match(html, /not a live pilot with a counterparty/i);
  assert.match(html, /current core/i);
  assert.match(html, /superseded/i);
  assert.match(html, /historical/i);
  assert.match(html, /href="\.\.\/deployments-v3-current\.json"/);
  assert.match(html, /href="\.\.\/activation-v3-current\.json"/);
  assert.match(script, /current core/i);
  const deployment = JSON.parse(
    await readFile(
      new URL("../deployments-v3-current.json", import.meta.url),
      "utf8",
    ),
  );
  for (const address of Object.values(deployment.contracts)) {
    assert.ok(script.includes(address));
  }
  assert.ok(script.includes(deployment.sourceCommit));
  assert.match(
    script,
    new RegExp(
      `deploymentBlock: ${deployment.deploymentBlocks.PolicyKernelV2}`,
    ),
  );
  assert.match(script, /provider\.getBlock\("finalized"\)/);
  assert.doesNotMatch(script, /provider\.getBlockNumber\(/);
  assert.match(script, /one-block hash anchor · finalized/i);
  assert.match(script, /kernel\.filters\.PolicyRegistered\(address\)/);
  assert.match(script, /DEPLOYMENT\.deploymentBlock,\s*blockTag/);
  assert.doesNotMatch(script, /policyIdAt/);
  assert.match(html, /Registered/);
  assert.match(html, /Configured/);
  assert.match(html, /Applied effects/);
  assert.match(html, /href="#main"/);
  for (const page of [index, horizon, operator, portfolio]) {
    assert.match(page, /href="\.\/v3\.html"/);
  }
});
