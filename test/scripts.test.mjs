import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Interface, keccak256 } from "ethers";
import { summarizeQualifyingTransfers } from "../scripts/lib/evidence.mjs";
import {
  assertExactHashMultiset,
  getSourceNetwork,
  getSourceProvider,
} from "../scripts/lib/proofs.mjs";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const TREASURY = "0xbaa67174531f0c031f91a373f6788c7e821af2c5";
const OTHER = "0x1111111111111111111111111111111111111111";
const iface = new Interface([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

function transfer(address, from, to, value) {
  const encoded = iface.encodeEventLog(iface.getEvent("Transfer"), [
    from,
    to,
    value,
  ]);
  return { address, topics: encoded.topics, data: encoded.data };
}

test("assertExactHashMultiset accepts reordered hashes and preserves duplicates", () => {
  const first = `0x${"ab".repeat(32)}`;
  const second = `0x${"cd".repeat(32)}`;

  assert.doesNotThrow(() =>
    assertExactHashMultiset(
      [first, second, first],
      [first.toUpperCase(), first, second.toUpperCase()],
    ),
  );
  assert.throws(
    () =>
      assertExactHashMultiset([first, second, second], [first, first, second]),
    /Batch proof transaction hashes do not match the requested set/,
  );
});

test("CC3 source keys bind exactly to Sepolia and Ethereum mainnet", () => {
  assert.deepEqual(getSourceNetwork(1), {
    chainKey: 1,
    evmChainId: 11155111,
    rpcUrlEnvironment: "SEPOLIA_RPC_URL",
  });
  assert.deepEqual(getSourceNetwork("3"), {
    chainKey: 3,
    evmChainId: 1,
    rpcUrlEnvironment: "ETH_MAINNET_RPC_URL",
  });
  assert.throws(
    () => getSourceNetwork(2),
    /Unsupported CC3 source chain key 2/,
  );
  assert.throws(
    () => getSourceProvider(1, {}),
    /SEPOLIA_RPC_URL is required for source chain key 1/,
  );
});

test("summarizeQualifyingTransfers sums every log matching the covenant predicate", () => {
  const qualifying = transfer(USDC, TREASURY, OTHER, 10n);
  const wrongTopic = transfer(USDC, TREASURY, OTHER, 100n);
  wrongTopic.topics[0] = `0x${"00".repeat(32)}`;
  const wrongData = transfer(USDC, TREASURY, OTHER, 100n);
  wrongData.data = "0x01";
  const logs = [
    qualifying,
    transfer(USDC, TREASURY, "0x2222222222222222222222222222222222222222", 15n),
    transfer(USDC, TREASURY, TREASURY, 100n),
    transfer(USDC, OTHER, TREASURY, 100n),
    transfer(
      "0x3333333333333333333333333333333333333333",
      TREASURY,
      OTHER,
      100n,
    ),
    wrongTopic,
    wrongData,
    { ...qualifying, topics: qualifying.topics.slice(0, 2) },
  ];

  assert.deepEqual(summarizeQualifyingTransfers(logs, USDC, TREASURY), {
    valueBaseUnits: "25",
    to: OTHER,
    qualifyingTransferCount: 2,
  });
});

test("checked-in deployment configurations pin every compiled local artifact", () => {
  const configurations = [
    "config/v3-pilot-cc3.json",
    "config/usc-remedy.example.json",
  ];

  for (const configPath of configurations) {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    for (const [name, artifact] of Object.entries(config.artifacts)) {
      if (artifact.path.startsWith("REPLACE_WITH_")) continue;
      assert.equal(
        keccak256(readFileSync(artifact.path)),
        artifact.keccak256,
        `${configPath} has a stale ${name} artifact hash`,
      );
    }
  }
});
