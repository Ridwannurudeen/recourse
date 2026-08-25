import { Contract } from 'ethers';
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
