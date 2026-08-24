import 'dotenv/config';
import { JsonRpcProvider } from 'ethers';
import pkg from '@gluwa/usc-sdk';
import { installDohFallback } from './net.mjs';

const { chainInfo, proofProvider } = pkg;
installDohFallback();

export function getProvider() {
  return new JsonRpcProvider(process.env.CREDITCOIN_RPC_URL);
}

export function getSourceProvider(chainKey) {
  const url = Number(chainKey) === 3 ? process.env.ETH_MAINNET_RPC_URL : process.env.SEPOLIA_RPC_URL;
  return new JsonRpcProvider(url);
}

export async function getAttestedHeight(chainKey) {
  const info = new chainInfo.PrecompileChainInfoProvider(getProvider());
  const latest = await info.getLatestAttestedHeightAndHash(Number(chainKey));
  return Number(latest.height);
}

function builder(chainKey) {
  return new proofProvider.service.ProofBuilder(Number(chainKey), process.env.PROOF_BUILDER_URL);
}

// getBatchProof returns merkleProofs as a nested map: blockHeight -> txIndex -> entry.
// It supports non-contiguous blocks. Do NOT use mergeProofs, which requires contiguity.
export async function fetchBatchProof(chainKey, hashes) {
  const result = await builder(chainKey).getBatchProof(hashes);
  if (!result.success) throw new Error(`getBatchProof failed: ${result.error}`);
  const data = result.data;
  const heights = [], txBytes = [], merkleProofs = [];
  const outer = data.merkleProofs instanceof Map
    ? data.merkleProofs.entries() : Object.entries(data.merkleProofs);
  for (const [height, inner] of outer) {
    const entries = inner instanceof Map ? inner.entries() : Object.entries(inner);
    for (const [, entry] of entries) {
      heights.push(Number(height));
      txBytes.push(entry.txBytes);
      merkleProofs.push(entry.merkleProof);
    }
  }
  return { heights, txBytes, merkleProofs, continuityProof: data.continuityProof };
}

export async function prewarm(chainKey, hashes) {
  const b = builder(chainKey);
  for (const hash of hashes) {
    const r = await b.getProof(hash);
    if (!r.success) throw new Error(`prewarm failed for ${hash}: ${r.error}`);
  }
}
