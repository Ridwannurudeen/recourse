import assert from "node:assert/strict";
import test from "node:test";
import { Interface, getAddress, id } from "ethers";
import {
  EvidenceKind,
  ObservationKind,
  PolicyOutcome,
  encodeEventHistoryManifest,
  hashEventHistoryManifest,
  policyKernelV1Abi,
  readFacilityPolicyCatalog,
} from "../src/index.mjs";

const HASH = (byte) => `0x${byte.repeat(32)}`;
const ADDRESS = (suffix) => getAddress(`0x${suffix.padStart(40, "0")}`);

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

test("facility policy catalog pages logs and binds each event to pinned policy state", async () => {
  const iface = new Interface(policyKernelV1Abi);
  const kernel = ADDRESS("101");
  const facility = ADDRESS("102");
  const evaluator = ADDRESS("103");
  const manifest = encodeEventHistoryManifest(eventHistoryManifest());
  const configHash = hashEventHistoryManifest(eventHistoryManifest());
  const encoded = iface.encodeEventLog(iface.getEvent("PolicyRegistered"), [
    facility,
    7n,
    evaluator,
    configHash,
    manifest,
  ]);
  const queries = [];
  const runner = {
    provider: {
      getBlockNumber: async () => 20,
      getBlock: async (blockTag) => ({
        number: Number(blockTag),
        hash: HASH("aa"),
      }),
      getLogs: async (filter) => {
        queries.push(filter);
        if (filter.fromBlock !== 15) return [];
        return [
          {
            address: kernel,
            topics: encoded.topics,
            data: encoded.data,
            blockNumber: 17,
            transactionIndex: 2,
            index: 1,
            transactionHash: HASH("bb"),
          },
        ];
      },
    },
    call: async (transaction) => {
      const parsed = iface.parseTransaction({ data: transaction.data });
      assert.equal(parsed.name, "policyOf");
      assert.equal(transaction.blockTag, 20);
      return iface.encodeFunctionResult(parsed.fragment, [
        evaluator,
        configHash,
        manifest,
      ]);
    },
  };

  const catalog = await readFacilityPolicyCatalog(kernel, runner, facility, {
    fromBlock: 10,
    pageSize: 5,
  });

  assert.deepEqual(
    queries.map(({ fromBlock, toBlock }) => [fromBlock, toBlock]),
    [
      [10, 14],
      [15, 19],
      [20, 20],
    ],
  );
  assert.equal(catalog.blockTag, 20);
  assert.equal(catalog.blockHash, HASH("aa"));
  assert.equal(catalog.facility, facility);
  assert.equal(catalog.originalFromBlock, 10);
  assert.equal(catalog.scannedToBlock, 20);
  assert.equal(catalog.nextBlock, null);
  assert.equal(catalog.historyComplete, true);
  assert.equal(catalog.nextCursor, null);
  assert.equal(catalog.registrations.length, 1);
  assert.deepEqual(catalog.registrations[0], {
    policyId: 7n,
    evaluator,
    configHash,
    manifest,
    blockNumber: 17,
    transactionIndex: 2,
    logIndex: 1,
    transactionHash: HASH("bb"),
  });
});

test("facility policy catalog rejects event/state disagreement at the snapshot", async () => {
  const iface = new Interface(policyKernelV1Abi);
  const kernel = ADDRESS("201");
  const facility = ADDRESS("202");
  const evaluator = ADDRESS("203");
  const manifest = encodeEventHistoryManifest(eventHistoryManifest());
  const configHash = hashEventHistoryManifest(eventHistoryManifest());
  const encoded = iface.encodeEventLog(iface.getEvent("PolicyRegistered"), [
    facility,
    1n,
    evaluator,
    configHash,
    manifest,
  ]);
  const runner = {
    provider: {
      getBlockNumber: async () => 5,
      getBlock: async () => ({ number: 5, hash: HASH("aa") }),
      getLogs: async () => [
        {
          address: kernel,
          topics: encoded.topics,
          data: encoded.data,
          blockNumber: 4,
          transactionIndex: 0,
          index: 0,
          transactionHash: HASH("cc"),
        },
      ],
    },
    call: async (transaction) => {
      const parsed = iface.parseTransaction({ data: transaction.data });
      return iface.encodeFunctionResult(parsed.fragment, [
        evaluator,
        HASH("dd"),
        manifest,
      ]);
    },
  };

  await assert.rejects(
    readFacilityPolicyCatalog(kernel, runner, facility, { fromBlock: 0 }),
    /registration does not match pinned state/,
  );
});

test("facility policy catalog returns an explicit continuation before its RPC page bound", async () => {
  const calls = [];
  const runner = {
    provider: {
      getBlockNumber: async () => 100,
      getBlock: async () => ({ number: 100, hash: HASH("aa") }),
      getLogs: async ({ fromBlock, toBlock }) => {
        calls.push([fromBlock, toBlock]);
        return [];
      },
    },
  };

  const partial = await readFacilityPolicyCatalog(
    ADDRESS("301"),
    runner,
    ADDRESS("302"),
    { fromBlock: 0, pageSize: 10, maxPages: 2 },
  );
  assert.deepEqual(calls, [
    [0, 9],
    [10, 19],
  ]);
  assert.equal(partial.scannedToBlock, 19);
  assert.equal(partial.nextBlock, 20);
  assert.equal(partial.historyComplete, false);
  assert.equal(partial.originalFromBlock, 0);
  assert.deepEqual(partial.nextCursor, {
    blockNumber: 100,
    blockHash: HASH("aa"),
    originalFromBlock: 0,
    nextBlock: 20,
  });

  calls.length = 0;
  const final = await readFacilityPolicyCatalog(
    ADDRESS("301"),
    runner,
    ADDRESS("302"),
    { cursor: partial.nextCursor, pageSize: 10, maxPages: 10 },
  );
  assert.equal(final.scannedToBlock, 100);
  assert.equal(final.nextBlock, null);
  assert.equal(final.historyComplete, true);
  assert.equal(final.originalFromBlock, 0);
  assert.equal(final.nextCursor, null);
  assert.equal(calls.length, 9);

  await assert.rejects(
    readFacilityPolicyCatalog(ADDRESS("301"), runner, ADDRESS("302")),
    /fromBlock is required/,
  );
});

test("facility policy catalog binds continuations to the original range and block hash", async () => {
  let blockHash = HASH("aa");
  const runner = {
    provider: {
      getBlockNumber: async () => 100,
      getBlock: async () => ({ number: 100, hash: blockHash }),
      getLogs: async () => [],
    },
  };

  const kernel = ADDRESS("401");
  const facility = ADDRESS("402");
  const partial = await readFacilityPolicyCatalog(kernel, runner, facility, {
    fromBlock: 0,
    pageSize: 10,
    maxPages: 1,
  });
  blockHash = HASH("ff");
  await assert.rejects(
    readFacilityPolicyCatalog(kernel, runner, facility, {
      cursor: partial.nextCursor,
      pageSize: 10,
      maxPages: 1,
    }),
    /continuation hash/,
  );

  blockHash = HASH("aa");
  const tail = await readFacilityPolicyCatalog(kernel, runner, facility, {
    fromBlock: 90,
    pageSize: 20,
    maxPages: 1,
  });
  assert.equal(tail.historyComplete, true);
  assert.equal(tail.originalFromBlock, 90);
  assert.equal(tail.fromBlock, 90);
  assert.equal(tail.scannedToBlock, 100);

  await assert.rejects(
    readFacilityPolicyCatalog(kernel, runner, facility, {
      fromBlock: 101,
      pageSize: 20,
      maxPages: 1,
    }),
    /range starts after/,
  );
});
