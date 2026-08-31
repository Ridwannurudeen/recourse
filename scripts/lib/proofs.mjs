import "dotenv/config";
import { JsonRpcProvider } from "ethers";
import pkg from "@gluwa/usc-sdk";
import { installDohFallback } from "./net.mjs";

const { chainInfo, proofProvider } = pkg;
installDohFallback();

const SOURCE_NETWORKS = Object.freeze({
  1: Object.freeze({
    chainKey: 1,
    evmChainId: 11155111,
    rpcUrlEnvironment: "SEPOLIA_RPC_URL",
  }),
  3: Object.freeze({
    chainKey: 3,
    evmChainId: 1,
    rpcUrlEnvironment: "ETH_MAINNET_RPC_URL",
  }),
});

export function getSourceNetwork(chainKey) {
  const numeric = Number(chainKey);
  if (!Number.isSafeInteger(numeric) || !SOURCE_NETWORKS[numeric]) {
    throw new Error(`Unsupported CC3 source chain key ${String(chainKey)}`);
  }
  return { ...SOURCE_NETWORKS[numeric] };
}

export function getProvider() {
  return new JsonRpcProvider(process.env.CREDITCOIN_RPC_URL);
}

export function getSourceProvider(chainKey, environment = process.env) {
  const network = getSourceNetwork(chainKey);
  const url = environment[network.rpcUrlEnvironment];
  if (typeof url !== "string" || url.length === 0) {
    throw new Error(
      `${network.rpcUrlEnvironment} is required for source chain key ${network.chainKey}`,
    );
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid RPC URL for source chain key ${network.chainKey}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `Invalid RPC URL protocol for source chain key ${network.chainKey}`,
    );
  }
  return new JsonRpcProvider(url);
}

export async function getAttestedHeight(chainKey) {
  return Number((await getLatestAttestation(chainKey)).height);
}

export async function getLatestAttestation(chainKey) {
  const network = getSourceNetwork(chainKey);
  const info = new chainInfo.PrecompileChainInfoProvider(getProvider());
  return info.getLatestAttestedHeightAndHash(network.chainKey);
}

function builder(chainKey) {
  const network = getSourceNetwork(chainKey);
  return new proofProvider.service.ProofBuilder(
    network.chainKey,
    process.env.PROOF_BUILDER_URL,
  );
}

// getBatchProof returns merkleProofs as a nested map: blockHeight -> txIndex -> entry.
// mergeProofs also spans gaps when each proof's covered range reaches the next proof's
// start block; the batch endpoint handles that shared-checkpoint merge for us.
export async function fetchBatchProof(chainKey, hashes) {
  const result = await builder(chainKey).getBatchProof(hashes);
  if (!result.success) throw new Error(`getBatchProof failed: ${result.error}`);
  const data = result.data;
  const heights = [],
    txHashes = [],
    txBytes = [],
    merkleProofs = [];
  const outer =
    data.merkleProofs instanceof Map
      ? data.merkleProofs.entries()
      : Object.entries(data.merkleProofs);
  for (const [height, inner] of outer) {
    const entries =
      inner instanceof Map ? inner.entries() : Object.entries(inner);
    for (const [, entry] of entries) {
      heights.push(Number(height));
      txHashes.push(entry.txHash);
      txBytes.push(entry.txBytes);
      merkleProofs.push(entry.merkleProof);
    }
  }
  return {
    heights,
    txHashes,
    txBytes,
    merkleProofs,
    continuityProof: data.continuityProof,
  };
}

export function assertExactHashMultiset(requested, returned) {
  const expected = requested.map((hash) => hash.toLowerCase()).sort();
  const actual = returned.map((hash) => hash.toLowerCase()).sort();
  if (
    expected.length !== actual.length ||
    actual.some((hash, index) => hash !== expected[index])
  ) {
    throw new Error(
      `Batch proof transaction hashes do not match the requested set: requested=${JSON.stringify(expected)} returned=${JSON.stringify(actual)}`,
    );
  }
}

export async function prewarm(chainKey, hashes) {
  const b = builder(chainKey);
  for (const hash of hashes) {
    const r = await b.getProof(hash);
    if (!r.success) throw new Error(`prewarm failed for ${hash}: ${r.error}`);
  }
}
