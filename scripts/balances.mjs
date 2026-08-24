import 'dotenv/config';
import { JsonRpcProvider, formatEther } from 'ethers';
import { installDohFallback } from './lib/net.mjs';

installDohFallback();

const ROLES = ['DEPLOYER', 'LENDER', 'BORROWER', 'HUNTER'];

const provider = new JsonRpcProvider(process.env.CREDITCOIN_RPC_URL);
const network = await provider.getNetwork();
const block = await provider.getBlockNumber();
console.log(`CC3 Testnet  chainId=${network.chainId}  block=${block}\n`);

let funded = 0;
for (const role of ROLES) {
  const address = process.env[`${role}_ADDRESS`];
  if (!address) {
    console.log(`${role.padEnd(9)} (not configured)`);
    continue;
  }
  const balance = await provider.getBalance(address);
  if (balance > 0n) funded += 1;
  console.log(`${role.padEnd(9)} ${address}  ${formatEther(balance)} tCTC`);
}

if (funded === 0) {
  console.log(
    `\nNo funds yet. Request tCTC in the Creditcoin Discord #token-faucet channel:\n` +
      `  /faucet address:${process.env.DEPLOYER_ADDRESS}`
  );
}
