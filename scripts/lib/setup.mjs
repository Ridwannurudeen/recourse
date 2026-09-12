import { Contract, Wallet } from 'ethers';
import { readFileSync } from 'node:fs';

export function contractFromArtifact(address, name, runner) {
  const artifact = JSON.parse(readFileSync(`out/${name}.sol/${name}.json`, 'utf8'));
  return new Contract(address, artifact.abi, runner);
}

export async function send(label, transactionPromise) {
  const transaction = await transactionPromise;
  const receipt = await transaction.wait();
  if (receipt.status !== 1) throw new Error(`${label} failed`);
  console.log(`${label}: ${receipt.hash}`);
  return receipt;
}

export function signerFromEnvironment(variable, provider, environment = process.env) {
  const raw = environment[variable];
  const value = typeof raw === 'string' ? raw.trim() : '';
  const normalized = value.startsWith('0x') ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(`${variable} must contain a 32-byte hex private key`);
  }
  try {
    return new Wallet(normalized, provider);
  } catch {
    throw new Error(`${variable} is not a valid signing key`);
  }
}
