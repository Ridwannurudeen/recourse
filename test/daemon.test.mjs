import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface } from 'ethers';
import {
  computeConfigHash,
  evaluateReceipt,
  queryId,
  reconcileCandidates,
} from '../daemon/core.mjs';

const CONFIG = {
  chainKey: 3,
  token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  treasury: '0x000000000004444c5dc75cb358380d2e3de08a90',
  startSourceBlock: 100,
  endSourceBlock: 200,
  capBaseUnits: '25',
};
const OTHER = '0x1111111111111111111111111111111111111111';
const iface = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);

function transfer(address, from, to, value) {
  const encoded = iface.encodeEventLog(iface.getEvent('Transfer'), [from, to, value]);
  return { address, topics: encoded.topics, data: encoded.data };
}

function receipt(overrides = {}) {
  return {
    hash: `0x${'ab'.repeat(32)}`,
    status: 1,
    blockNumber: 100,
    index: 7,
    logs: [transfer(CONFIG.token, CONFIG.treasury, OTHER, 10n)],
    ...overrides,
  };
}

test('computeConfigHash matches the deployed covenant ABI encoding', () => {
  assert.equal(
    computeConfigHash(CONFIG),
    '0xd24d8bfe5aa4eb306fad151e4200914a8c8e0e6c9942dc49d08ac7cfc5b081b9',
  );
});

test('evaluateReceipt applies the inclusive window and sums every qualifying transfer', () => {
  const qualifying = receipt({
    blockNumber: CONFIG.endSourceBlock,
    logs: [
      transfer(CONFIG.token, CONFIG.treasury, OTHER, 10n),
      transfer(CONFIG.token, CONFIG.treasury, '0x2222222222222222222222222222222222222222', 15n),
      transfer(CONFIG.token, OTHER, CONFIG.treasury, 100n),
      transfer(CONFIG.token, CONFIG.treasury, CONFIG.treasury, 100n),
    ],
  });

  assert.deepEqual(evaluateReceipt(qualifying, CONFIG), {
    qualified: true,
    amount: 25n,
    qualifyingTransferCount: 2,
    recipient: OTHER,
  });
  assert.deepEqual(evaluateReceipt(receipt({ blockNumber: 99 }), CONFIG), {
    qualified: false,
    reason: 'outside covenant window',
  });
  assert.deepEqual(evaluateReceipt(receipt({ status: 0 }), CONFIG), {
    qualified: false,
    reason: 'transaction reverted',
  });
});

test('reconcileCandidates breaches only above the cap and excludes processed evidence after restart', async () => {
  const candidates = [
    { hash: `0x${'11'.repeat(32)}`, blockNumber: 101, transactionIndex: 1, amount: 5n },
    { hash: `0x${'22'.repeat(32)}`, blockNumber: 102, transactionIndex: 2, amount: 10n },
    { hash: `0x${'33'.repeat(32)}`, blockNumber: 103, transactionIndex: 3, amount: 1n },
  ];
  const alreadyProcessed = queryId(CONFIG.chainKey, 101, 1);
  const result = await reconcileCandidates({
    facilityState: 1n,
    onChainAccumulated: 15n,
    capBaseUnits: 25n,
    chainKey: CONFIG.chainKey,
    candidates,
    isProcessed: async (qid) => qid === alreadyProcessed,
  });

  assert.equal(result.runningTotal, 26n);
  assert.equal(result.breached, true);
  assert.deepEqual(result.processed.map((candidate) => candidate.hash), [candidates[0].hash]);
  assert.deepEqual(result.pending.map((candidate) => candidate.hash), [candidates[1].hash, candidates[2].hash]);
  assert.deepEqual(result.batch.map((candidate) => candidate.hash), [candidates[1].hash, candidates[2].hash]);
});

test('reconcileCandidates takes no action unless the facility is Active', async () => {
  const result = await reconcileCandidates({
    facilityState: 3n,
    onChainAccumulated: 0n,
    capBaseUnits: 1n,
    chainKey: CONFIG.chainKey,
    candidates: [{ hash: `0x${'44'.repeat(32)}`, blockNumber: 101, transactionIndex: 1, amount: 2n }],
    isProcessed: async () => false,
  });

  assert.equal(result.active, false);
  assert.deepEqual(result.batch, []);
});
