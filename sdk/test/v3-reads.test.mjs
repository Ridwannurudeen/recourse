import assert from "node:assert/strict";
import test from "node:test";
import { Interface, ZeroAddress, getAddress } from "ethers";

import {
  cappedPilotFactoryV1Abi,
  multiChainEventPolicyV1Abi,
  operatorMarketV1Abi,
  policyKernelV2Abi,
  portfolioMandateV1Abi,
  readCappedPilotFactory,
  readMultiChainPolicy,
  readOperatorMarket,
  readPolicyKernelV2,
  readPolicyRegistrationV2,
  readPortfolioMandate,
} from "../src/index.mjs";

const HASH = (byte) => `0x${byte.repeat(32)}`;
const ADDRESS = (suffix) => getAddress(`0x${suffix.padStart(40, "0")}`);

const targets = {
  factory: ADDRESS("501"),
  kernel: ADDRESS("502"),
  policy: ADDRESS("503"),
  market: ADDRESS("504"),
  mandate: ADDRESS("505"),
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

function runner(overrides = {}) {
  const interfaces = new Map([
    [targets.factory, new Interface(cappedPilotFactoryV1Abi)],
    [targets.kernel, new Interface(policyKernelV2Abi)],
    [targets.policy, new Interface(multiChainEventPolicyV1Abi)],
    [targets.market, new Interface(operatorMarketV1Abi)],
    [targets.mandate, new Interface(portfolioMandateV1Abi)],
  ]);
  const calls = [];
  const provider = {
    getBlockNumber: async () => 777,
    getBlock: async (blockTag) => ({
      number: Number(blockTag),
      hash: HASH("aa"),
    }),
  };
  return {
    calls,
    value: {
      provider,
      call: async (transaction) => {
        calls.push(transaction);
        const iface = interfaces.get(getAddress(transaction.to));
        assert.ok(iface);
        const parsed = iface.parseTransaction({ data: transaction.data });
        const value = Object.hasOwn(overrides, parsed.name)
          ? overrides[parsed.name](parsed.args)
          : parsed.fragment.outputs.map(zeroValue);
        return iface.encodeFunctionResult(parsed.fragment, value);
      },
    },
  };
}

test("V3 aggregate reads pin factory, kernel, policy, market, and mandate state to one block", async () => {
  const observed = runner({
    facilityCount: () => [0],
    quoteCount: () => [0],
    isConfigured: () => [false],
    safeStaleProofRelease: () => [true],
    evaluate: () => [0],
  });
  const reads = await Promise.all([
    readCappedPilotFactory(targets.factory, observed.value),
    readPolicyKernelV2(targets.kernel, observed.value),
    readPolicyRegistrationV2(
      targets.kernel,
      observed.value,
      ADDRESS("511"),
      7,
      [2, 3],
    ),
    readMultiChainPolicy(targets.policy, observed.value, ADDRESS("511"), 7),
    readOperatorMarket(targets.market, observed.value),
    readPortfolioMandate(targets.mandate, observed.value, {
      facility: ADDRESS("511"),
      deploymentId: HASH("51"),
    }),
  ]);

  for (const read of reads) assert.equal(read.blockTag, 777);
  for (const call of observed.calls) assert.equal(call.blockTag, 777);
  assert.equal(reads[0].totalCount, 0);
  assert.equal(reads[1].safeStaleProofRelease, true);
  assert.deepEqual(
    reads[2].sourcePositions.map(({ chainKey }) => chainKey),
    [2n, 3n],
  );
  assert.equal(reads[2].sourceOrdering, 0n);
  assert.equal(reads[3].configured, false);
  assert.equal(reads[3].sourceOrdering, 0n);
  assert.equal(reads[4].quoteTotalCount, 0);
  assert.equal(reads[5].eligibilityCode, 0n);
});

test("V3 enumerable reads are bounded and continue only on the anchored block hash", async () => {
  const facilities = [ADDRESS("521"), ADDRESS("522"), ADDRESS("523")];
  const quotes = facilities.map((operator, index) => ({
    operator,
    sponsor: ZeroAddress,
    serviceKind: index,
    status: 0,
    quoteExpiry: 2_000,
    serviceDuration: 100,
    deliveryDeadline: 0,
    price: 1_000,
    operatorBond: 500,
    requirementsDigest: HASH("52"),
    deliveryDigest: HASH("00"),
  }));
  const observed = runner({
    facilityCount: () => [facilities.length],
    facilityAt: ([index]) => [facilities[Number(index)]],
    quoteCount: () => [quotes.length],
    quoteAt: ([index]) => [quotes[Number(index)]],
  });

  const firstFactory = await readCappedPilotFactory(
    targets.factory,
    observed.value,
    {
      limit: 2,
    },
  );
  const finalFactory = await readCappedPilotFactory(
    targets.factory,
    observed.value,
    {
      limit: 2,
      cursor: firstFactory.nextCursor,
    },
  );
  assert.deepEqual(firstFactory.facilities, facilities.slice(0, 2));
  assert.deepEqual(finalFactory.facilities, facilities.slice(2));
  assert.equal(finalFactory.nextCursor, null);

  const firstMarket = await readOperatorMarket(targets.market, observed.value, {
    limit: 2,
    claimableAccounts: [facilities[0]],
  });
  assert.equal(firstMarket.quotes.length, 2);
  assert.deepEqual(firstMarket.nextCursor, {
    blockNumber: 777,
    blockHash: HASH("aa"),
    nextIndex: 2,
  });
  assert.equal(firstMarket.claimable[0].account, facilities[0]);
  assert.equal(firstMarket.claimable[0].amount, 0n);
});
