import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MAX_OPERATOR_REPORT_BYTES,
  parseOperatorReport,
  readBoundedResponseText,
  resolveOperatorReportUrl,
  summarizeOperatorReport,
  validateOperatorReport,
  verifyConfiguredOperatorAnchor,
} from "../web/operator-core.mjs";
import {
  formatAssetAmount,
  normalizeTokenSymbol,
  summarizePortfolio,
  validateNetworkAnchor,
} from "../web/portfolio-core.mjs";

const HASH = (byte) => `0x${byte.repeat(32)}`;
const ADDRESS = (suffix) => `0x${suffix.padStart(40, "0")}`;

function report(overrides = {}) {
  return {
    schemaVersion: 3,
    generatedAt: "2026-08-30T12:00:00.000Z",
    chainId: 102031,
    proofJobs: ADDRESS("101"),
    scan: {
      fromBlock: 100,
      toBlock: 120,
      historyFromBlock: 50,
      stateBlock: 120,
      stateBlockHash: HASH("aa"),
      stateBlockTimestamp: 1_788_091_200,
      historyComplete: true,
      eventsTruncated: false,
      eventsFromBlock: null,
      confirmations: 3,
    },
    events: [],
    jobs: [
      {
        jobId: "1",
        token: ADDRESS("102"),
        facility: ADDRESS("103"),
        successfulProofs: "0",
        maxSuccessfulProofs: "2",
        escrowRemaining: "1000000",
        state: "Open",
      },
    ],
    policies: [
      {
        facility: ADDRESS("103"),
        evaluator: ADDRESS("104"),
        policyId: "7",
      },
    ],
    metrics: {
      jobsCreated: 1,
      jobsCovered: 0,
      commitments: 0,
      acceptedProofs: 0,
      processedProofReleases: 0,
      validReveals: 0,
      completedJobs: 0,
      slashes: 0,
      releases: 0,
      coverage: { numerator: 0, denominator: 1, value: 0 },
      acceptedValidRevealRate: {
        numerator: 0,
        denominator: 0,
        value: null,
      },
      completionRate: { numerator: 0, denominator: 1, value: 0 },
      commitLatencyBlocks: {
        count: 0,
        minimum: null,
        maximum: null,
        average: null,
      },
      commitLatencySeconds: {
        count: 0,
        minimum: null,
        maximum: null,
        average: null,
      },
      operators: [],
    },
    limitations: ["Observed events only."],
    ...overrides,
  };
}

test("operator report requires schema v3 anchor and computes explicit freshness/coverage flags", () => {
  const validated = validateOperatorReport(report(), {
    now: Date.parse("2026-08-30T12:04:00.000Z"),
    staleAfterSeconds: 300,
  });
  assert.equal(validated.stale, false);
  assert.equal(validated.partial, false);
  assert.equal(validated.truncated, false);
  assert.equal(validated.reportAgeSeconds, 240);
  assert.equal(validated.stateAgeSeconds, 240);
  assert.deepEqual(summarizeOperatorReport(validated), {
    jobs: 1,
    openJobs: 1,
    acceptingJobs: 1,
    policies: 1,
    events: 0,
    operators: 0,
    commitments: 0,
    acceptedProofs: 0,
    completedJobs: 0,
  });

  const incomplete = validateOperatorReport(
    report({
      scan: {
        ...report().scan,
        historyComplete: false,
        eventsTruncated: true,
      },
    }),
    { now: Date.parse("2026-08-30T12:10:01.000Z") },
  );
  assert.equal(incomplete.stale, true);
  assert.equal(incomplete.partial, true);
  assert.equal(incomplete.truncated, true);
});

test("operator freshness follows the anchored state timestamp, not report regeneration time", () => {
  const now = Date.parse("2026-08-30T12:10:00.000Z");
  const regenerated = validateOperatorReport(
    report({
      generatedAt: "2026-08-30T12:10:00.000Z",
      scan: {
        ...report().scan,
        stateBlockTimestamp: Date.parse("2026-08-30T11:00:00.000Z") / 1_000,
      },
    }),
    { now, staleAfterSeconds: 300 },
  );
  assert.equal(regenerated.reportAgeSeconds, 0);
  assert.equal(regenerated.reportStale, false);
  assert.equal(regenerated.stateAgeSeconds, 4_200);
  assert.equal(regenerated.stale, true);

  const future = validateOperatorReport(
    report({
      generatedAt: "2026-08-30T12:20:00.000Z",
      scan: {
        ...report().scan,
        stateBlockTimestamp: Date.parse("2026-08-30T12:20:00.000Z") / 1_000,
      },
    }),
    { now, futureToleranceSeconds: 120 },
  );
  assert.equal(future.reportFuture, true);
  assert.equal(future.stateFuture, true);
  assert.equal(future.stale, true);
});

test("operator report rejects legacy, missing-anchor, malformed, and unsafe job data", () => {
  assert.throws(
    () => validateOperatorReport({ ...report(), schemaVersion: 2 }),
    /schema/,
  );
  assert.throws(
    () =>
      validateOperatorReport({
        ...report(),
        scan: { ...report().scan, stateBlockHash: null },
      }),
    /stateBlockHash/,
  );
  assert.throws(
    () =>
      validateOperatorReport({
        ...report(),
        jobs: [{ ...report().jobs[0], jobId: "01" }],
      }),
    /jobId/,
  );
  assert.throws(() => parseOperatorReport("not json"), /valid JSON/);
  assert.equal(
    parseOperatorReport(JSON.stringify(report())).report.chainId,
    102031,
  );
});

test("operator report bounds external collections and enforces metric consistency", () => {
  assert.throws(
    () =>
      validateOperatorReport({
        ...report(),
        limitations: ["x".repeat(513)],
      }),
    /limitations/,
  );
  assert.throws(
    () =>
      validateOperatorReport({
        ...report(),
        jobs: [{ ...report().jobs[0], jobId: "1".repeat(79) }],
      }),
    /jobId/,
  );
  assert.throws(
    () =>
      validateOperatorReport({
        ...report(),
        metrics: { ...report().metrics, jobsCreated: 2 },
      }),
    /Inconsistent operator metrics/,
  );
  const invalidOperator = {
    operator: ADDRESS("105"),
    jobsCovered: 0,
    coverage: { numerator: 0, denominator: 1, value: 0 },
    commitments: 0,
    acceptedProofs: 1,
    processedProofReleases: 0,
    validReveals: 0,
    acceptedValidRevealRate: { numerator: 1, denominator: 0, value: null },
    slashes: 0,
    releases: 0,
    responseLatencyBlocks: {
      count: 0,
      minimum: null,
      maximum: null,
      average: null,
    },
    responseLatencySeconds: {
      count: 0,
      minimum: null,
      maximum: null,
      average: null,
    },
  };
  assert.throws(
    () =>
      validateOperatorReport({
        ...report(),
        metrics: { ...report().metrics, operators: [invalidOperator] },
      }),
    /metrics\.operators\[0\]/,
  );
});

test("operator report loading is same-origin, size-capped, and RPC anchor checked", async () => {
  assert.equal(
    resolveOperatorReportUrl(
      "https://recourse.example/operator.html",
      "./operator-report.json",
    ),
    "https://recourse.example/operator-report.json",
  );
  assert.throws(
    () =>
      resolveOperatorReportUrl(
        "https://recourse.example/operator.html",
        "https://attacker.example/report.json",
      ),
    /same-origin/,
  );
  await assert.rejects(
    readBoundedResponseText(
      new Response(new Uint8Array(MAX_OPERATOR_REPORT_BYTES + 1)),
    ),
    /response-size cap/,
  );
  assert.equal(
    await readBoundedResponseText(new Response(new TextEncoder().encode("{}"))),
    "{}",
  );

  const validated = validateOperatorReport(report());
  const provider = {
    send: async () => "0x18e8f",
    getBlock: async () => ({ hash: HASH("aa"), timestamp: 1_788_091_200 }),
  };
  assert.deepEqual(
    await verifyConfiguredOperatorAnchor(validated, {
      provider,
      chainId: 102031,
      proofJobs: ADDRESS("101"),
    }),
    { chainId: 102031, blockHash: HASH("aa") },
  );
  await assert.rejects(
    verifyConfiguredOperatorAnchor(validated, {
      provider: { ...provider, send: async () => "0x1" },
      chainId: 102031,
      proofJobs: ADDRESS("101"),
    }),
    /chain ID mismatch/,
  );
  await assert.rejects(
    verifyConfiguredOperatorAnchor(validated, {
      provider: {
        ...provider,
        getBlock: async () => ({ hash: HASH("ff"), timestamp: 1_788_091_200 }),
      },
      chainId: 102031,
      proofJobs: ADDRESS("101"),
    }),
    /anchor hash/,
  );
});

test("portfolio aggregation groups only exact chain, asset, and decimal identities", () => {
  const baseFacility = {
    address: ADDRESS("201"),
    asset: ADDRESS("202"),
    decimals: 6,
    symbol: "rUSD",
    facilityLimit: 100_000_000n,
    lenderFunded: 80_000_000n,
    bondPosted: 20_000_000n,
    drawnPrincipal: 40_000_000n,
    outstandingDebt: 41_000_000n,
    availableCredit: 60_000_000n,
  };
  const summary = summarizePortfolio(
    [
      {
        name: "CC3",
        chainId: 102031,
        blockNumber: 5_400_000,
        blockHash: HASH("a1"),
        blockTimestamp: 1_788_091_200,
        totalFacilities: 3,
        truncated: false,
        failures: [{ address: ADDRESS("299") }],
        facilities: [
          baseFacility,
          {
            ...baseFacility,
            address: ADDRESS("203"),
            facilityLimit: 50_000_000n,
            availableCredit: 10_000_000n,
          },
        ],
      },
      {
        name: "Another network",
        chainId: 1,
        blockNumber: 21_000_000,
        blockHash: HASH("a2"),
        blockTimestamp: 1_788_091_200,
        totalFacilities: 1,
        truncated: false,
        failures: [],
        facilities: [{ ...baseFacility, address: ADDRESS("204") }],
      },
    ],
    { now: Date.parse("2026-08-30T12:04:00.000Z") },
  );

  assert.equal(summary.groups.length, 2);
  assert.equal(summary.groups[0].chainId, 1);
  assert.equal(summary.groups[1].chainId, 102031);
  assert.equal(summary.groups[1].facilities, 2);
  assert.equal(summary.groups[1].facilityLimit, 150_000_000n);
  assert.equal(summary.groups[1].availableCredit, 70_000_000n);
  assert.equal(summary.totalFacilities, 4);
  assert.equal(summary.observedFacilities, 3);
  assert.equal(summary.partial, true);
});

test("portfolio formatting and token labels preserve raw-unit truth boundaries", () => {
  assert.equal(formatAssetAmount(123_456_789n, 6), "123.45");
  assert.equal(normalizeTokenSymbol("USDC.e"), "USDC.e");
  assert.equal(normalizeTokenSymbol("<img onerror=alert(1)>"), "TOKEN");
  assert.deepEqual(summarizePortfolio([]), {
    networks: [],
    groups: [],
    totalFacilities: 0,
    observedFacilities: 0,
    partial: false,
    stale: false,
  });
});

test("portfolio network anchors reject wrong chains and expose stale or future block time", () => {
  assert.throws(
    () =>
      validateNetworkAnchor({
        expectedChainId: 102031,
        actualChainId: 1,
        blockNumber: 5,
        blockHash: HASH("aa"),
        blockTimestamp: 1_000,
      }),
    /chain ID/,
  );
  const stale = validateNetworkAnchor(
    {
      expectedChainId: 102031,
      actualChainId: 102031,
      blockNumber: 5,
      blockHash: HASH("AA"),
      blockTimestamp: 1_000,
    },
    { now: 1_400_000, staleAfterSeconds: 300 },
  );
  assert.equal(stale.stateAgeSeconds, 400);
  assert.equal(stale.stale, true);
  assert.equal(stale.blockHash, HASH("aa"));
  const future = validateNetworkAnchor(
    {
      expectedChainId: 102031,
      actualChainId: 102031,
      blockNumber: 6,
      blockHash: HASH("bb"),
      blockTimestamp: 2_000,
    },
    { now: 1_000_000, futureToleranceSeconds: 120 },
  );
  assert.equal(future.future, true);
});

test("observatory pages keep external data on safe text DOM paths and expose state landmarks", async () => {
  const [operatorHtml, operatorJs, portfolioHtml, portfolioJs] =
    await Promise.all([
      readFile(new URL("../web/operator.html", import.meta.url), "utf8"),
      readFile(new URL("../web/operator.js", import.meta.url), "utf8"),
      readFile(new URL("../web/portfolio.html", import.meta.url), "utf8"),
      readFile(new URL("../web/portfolio.js", import.meta.url), "utf8"),
    ]);
  assert.doesNotMatch(
    operatorJs,
    /innerHTML|insertAdjacentHTML|document\.write/,
  );
  assert.doesNotMatch(
    portfolioJs,
    /innerHTML|insertAdjacentHTML|document\.write/,
  );
  assert.match(operatorJs, /\.textContent =/);
  assert.match(portfolioJs, /\.textContent =/);
  assert.match(operatorHtml, /id="operator-state"[^>]*aria-live="polite"/);
  assert.match(portfolioHtml, /id="portfolio-state"[^>]*aria-live="polite"/);
  for (const html of [operatorHtml, portfolioHtml]) {
    assert.match(html, /href="\.\/operator\.html"/);
    assert.match(html, /href="\.\/portfolio\.html"/);
    assert.match(html, /href="#main"/);
  }
  assert.match(portfolioHtml, /single-endpoint/i);
  assert.match(portfolioHtml, /value-moving decisions/i);
  assert.match(operatorHtml, /operator-reported/i);
  assert.doesNotMatch(operatorJs, /URLSearchParams/);
});
