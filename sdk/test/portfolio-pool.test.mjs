import assert from "node:assert/strict";
import test from "node:test";
import { Interface, ZeroAddress, getAddress } from "ethers";

import {
  PortfolioEligibilityCode,
  PortfolioPoolAllocationCode,
  PortfolioPoolStatus,
  buildPortfolioPoolCalldata,
  portfolioPoolV1Abi,
  readPortfolioPool,
  recourseDemoUsdAbi,
  simulatePortfolioPoolAllocation,
  simulatePortfolioPoolDistribution,
} from "../src/index.mjs";

const HASH = (byte) => `0x${byte.repeat(32)}`;
const ADDRESS = (suffix) => getAddress(`0x${suffix.padStart(40, "0")}`);

test("PortfolioPoolV1 ABI and calldata cover the complete local capital lifecycle", () => {
  const pool = new Interface(portfolioPoolV1Abi);
  assert.equal(pool.fragments.length, 121);
  assert.equal(pool.getFunction("setMandate").selector, "0x52ea357a");
  assert.equal(pool.getFunction("allocate").name, "allocate");
  assert.equal(pool.getFunction("settleAllocation").name, "settleAllocation");
  assert.equal(
    pool.getFunction("distributeAvailable").name,
    "distributeAvailable",
  );
  assert.equal(pool.getFunction("claim").name, "claim");
  assert.equal(
    pool.getFunction("remedyPolicyEvaluator").name,
    "remedyPolicyEvaluator",
  );
  assert.equal(pool.getFunction("remedyCoordinator").name, "remedyCoordinator");
  assert.equal(pool.getEvent("AllocationSettled").name, "AllocationSettled");
  assert.equal(
    pool.getEvent("RemedyIntentPublished").name,
    "RemedyIntentPublished",
  );
  assert.equal(
    pool.getEvent("RemedyIntentReplaced").name,
    "RemedyIntentReplaced",
  );
  assert.equal(pool.getError("SharesLocked").name, "SharesLocked");

  const calls = buildPortfolioPoolCalldata({
    setMandate: { mandate: ADDRESS("701") },
    createFacility: {
      facilityLimit: 1_000,
      bondRequired: 200,
      drawFeeBps: 100,
      maturityBlock: 10_000,
      drawDelayBlocks: 5,
    },
    configureAndRegisterPolicy: {
      facility: ADDRESS("702"),
      policyId: 7,
      evaluator: ADDRESS("703"),
      configurationCall: "0x12345678",
    },
    authorizeRemedyPolicy: {
      facility: ADDRESS("702"),
      policyId: 7,
      coordinator: ADDRESS("704"),
    },
    publishRemedyIntent: {
      facility: ADDRESS("702"),
      policyId: 7,
      actionData: "0x1234",
    },
    replaceRemedyIntent: {
      facility: ADDRESS("702"),
      policyId: 7,
    },
    registerCandidate: {
      facility: ADDRESS("702"),
      deploymentId: HASH("70"),
    },
    registerInvestor: { investor: ADDRESS("705") },
    setProofJobsVenue: { proofJobs: ADDRESS("706") },
    openFunding: true,
    deposit: { amount: 1_000 },
    withdrawFunding: { amount: 100 },
    cancelFunding: true,
    activate: true,
    allocate: { facility: ADDRESS("702"), amount: 1_000 },
    setFacilityDrawPaused: { facility: ADDRESS("702"), paused: true },
    createProofJob: {
      token: ADDRESS("707"),
      facility: ADDRESS("702"),
      policyId: 7,
      requirementsDigest: HASH("71"),
      expiry: 20_000,
      revealWindowBlocks: 10,
      maxSuccessfulProofs: 2,
      proofReimbursement: 10,
      outcomeReward: 20,
      commitBond: 5,
      rewardOutcomeThreshold: 4,
    },
    recoverProofJobFunds: true,
    harvest: { facility: ADDRESS("702") },
    settleAllocation: { facility: ADDRESS("702") },
    finalize: true,
    distributeAvailable: true,
    claim: true,
  });
  assert.equal(
    pool.parseTransaction({ data: calls.setMandate }).args.mandate_,
    ADDRESS("701"),
  );
  assert.equal(
    pool.parseTransaction({ data: calls.createFacility }).args.facilityLimit,
    1_000n,
  );
  assert.equal(
    pool.parseTransaction({ data: calls.configureAndRegisterPolicy }).args
      .configurationCall,
    "0x12345678",
  );
  assert.equal(
    pool.parseTransaction({ data: calls.allocate }).args.amount,
    1_000n,
  );
  assert.equal(
    pool.parseTransaction({ data: calls.publishRemedyIntent }).args.actionData,
    "0x1234",
  );
  assert.equal(
    pool.parseTransaction({ data: calls.replaceRemedyIntent }).args.policyId,
    7n,
  );
  assert.equal(
    pool.parseTransaction({ data: calls.createProofJob }).args.params
      .maxSuccessfulProofs,
    2n,
  );
  assert.equal(pool.parseTransaction({ data: calls.claim }).name, "claim");
  assert.throws(
    () => buildPortfolioPoolCalldata({}),
    /No portfolio-pool calldata/,
  );
});

test("portfolio allocation simulation preserves manager, deadline, bond, and mandate gate ordering", () => {
  const input = {
    pool: {
      address: ADDRESS("710"),
      manager: ADDRESS("711"),
      status: PortfolioPoolStatus.Active,
      fundingDeadline: 2_000,
      assetBalance: 1_000,
      totalAllocatedPrincipal: 0,
      allocatedFacilityCount: 0,
    },
    allocation: {
      registered: true,
      settled: false,
      principal: 0,
    },
    facility: {
      lender: ADDRESS("710"),
      facilityLimit: 1_000,
      lenderFunded: 0,
      bondRequired: 200,
      bondPosted: 200,
    },
    sender: ADDRESS("711"),
    timestamp: 1_500,
    amount: 1_000,
    mandateEligibilityCode: PortfolioEligibilityCode.Eligible,
  };
  assert.deepEqual(simulatePortfolioPoolAllocation(input), {
    code: PortfolioPoolAllocationCode.Eligible,
    allocationPrincipalAfter: 1_000n,
    totalAllocatedPrincipalAfter: 1_000n,
    allocatedFacilityCountAfter: 1n,
  });
  assert.equal(
    simulatePortfolioPoolAllocation({ ...input, sender: ADDRESS("799") }).code,
    PortfolioPoolAllocationCode.NotManager,
  );
  assert.equal(
    simulatePortfolioPoolAllocation({ ...input, timestamp: 2_000 }).code,
    PortfolioPoolAllocationCode.FundingExpired,
  );
  assert.equal(
    simulatePortfolioPoolAllocation({
      ...input,
      facility: { ...input.facility, bondPosted: 199 },
    }).code,
    PortfolioPoolAllocationCode.InvalidFacility,
  );
  assert.equal(
    simulatePortfolioPoolAllocation({
      ...input,
      mandateEligibilityCode: PortfolioEligibilityCode.MissingEvidenceKind,
    }).code,
    PortfolioPoolAllocationCode.IneligibleFacility,
  );
});

test("portfolio distribution simulation assigns every available unit by exact share remainder", () => {
  assert.deepEqual(
    simulatePortfolioPoolDistribution({
      assetBalance: 10,
      totalDistributed: 0,
      totalClaimed: 0,
      totalSupply: 3,
      investors: [
        { account: ADDRESS("721"), shares: 1, claimable: 0 },
        { account: ADDRESS("722"), shares: 2, claimable: 0 },
      ],
    }),
    {
      amount: 10n,
      reserved: 0n,
      totalDistributedAfter: 10n,
      investors: [
        { account: ADDRESS("721"), amount: 3n, claimableAfter: 3n },
        { account: ADDRESS("722"), amount: 7n, claimableAfter: 7n },
      ],
    },
  );
});

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

test("portfolio pool reads page complete source-level state against one block hash", async () => {
  const poolAddress = ADDRESS("730");
  const assetAddress = ADDRESS("731");
  const facilities = [ADDRESS("732"), ADDRESS("733")];
  const investors = [ADDRESS("734"), ADDRESS("735")];
  const interfaces = new Map([
    [poolAddress, new Interface(portfolioPoolV1Abi)],
    [assetAddress, new Interface(recourseDemoUsdAbi)],
  ]);
  const calls = [];
  const runner = {
    provider: {
      getBlockNumber: async () => 888,
      getBlock: async (blockTag) => ({
        number: Number(blockTag),
        hash: HASH("aa"),
      }),
    },
    call: async (transaction) => {
      calls.push(transaction);
      const target = getAddress(transaction.to);
      const iface = interfaces.get(target);
      const parsed = iface.parseTransaction({ data: transaction.data });
      let value = parsed.fragment.outputs.map(zeroValue);
      if (target === poolAddress) {
        if (parsed.name === "asset") value = [assetAddress];
        if (parsed.name === "createdFacilityCount") value = [2];
        if (parsed.name === "candidateCount") value = [1];
        if (parsed.name === "investorCount") value = [2];
        if (parsed.name === "createdFacilityAt")
          value = [facilities[Number(parsed.args.index)]];
        if (parsed.name === "candidateAt") value = [facilities[0]];
        if (parsed.name === "investorAt")
          value = [investors[Number(parsed.args.index)]];
        if (parsed.name === "allocationOf")
          value = [[HASH("73"), 1_000, 400, 600, true, true]];
        if (parsed.name === "balanceOf")
          value = [parsed.args.account === investors[0] ? 600 : 400];
        if (parsed.name === "claimable")
          value = [parsed.args.account === investors[0] ? 240 : 160];
        if (parsed.name === "claimedAssets") value = [0];
      } else if (parsed.name === "balanceOf") {
        value = [500];
      }
      return iface.encodeFunctionResult(parsed.fragment, value);
    },
  };
  const first = await readPortfolioPool(poolAddress, runner, {
    detailLimit: 1,
  });
  assert.equal(first.blockTag, 888);
  assert.equal(first.assetBalance, 500n);
  assert.deepEqual(first.createdFacilities, facilities.slice(0, 1));
  assert.equal(first.candidates[0].allocation.realizedLoss, 600n);
  assert.equal(first.investors[0].claimable, 240n);
  assert.ok(first.nextCursor);
  await assert.rejects(
    readPortfolioPool(poolAddress, runner, {
      cursor: { ...first.nextCursor, blockHash: HASH("bb") },
      detailLimit: 1,
    }),
    /continuation hash/,
  );
  const final = await readPortfolioPool(poolAddress, runner, {
    cursor: first.nextCursor,
    detailLimit: 1,
  });
  assert.deepEqual(final.createdFacilities, facilities.slice(1));
  assert.equal(final.candidates.length, 0);
  assert.equal(final.investors[0].account, investors[1]);
  assert.equal(final.nextCursor, null);
  for (const call of calls) assert.equal(call.blockTag, 888);
});
