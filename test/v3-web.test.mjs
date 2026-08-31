import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DeploymentTruth,
  anchorV3Snapshot,
  summarizeV3Snapshot,
} from "../web/v3-core.mjs";

const HASH = (byte) => `0x${byte.repeat(32)}`;
const ADDRESS = (suffix) => `0x${suffix.padStart(40, "0")}`;

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
          policyCount: 1,
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
          policyCount: 1,
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
  assert.match(html, /deployed/i);
  assert.match(html, /configured/i);
  assert.match(html, /activated/i);
  assert.match(html, /external.gated/i);
  assert.match(html, /no live pilot/i);
  assert.match(html, /historical/i);
  assert.match(html, /fresh deployment/i);
  assert.match(script, /historical core/i);
  assert.match(html, /href="#main"/);
  for (const page of [index, horizon, operator, portfolio]) {
    assert.match(page, /href="\.\/v3\.html"/);
  }
});
