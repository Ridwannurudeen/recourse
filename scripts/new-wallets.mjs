import { writeFileSync, existsSync } from 'node:fs';
import { Wallet, HDNodeWallet } from 'ethers';

const ROLES = ['DEPLOYER', 'LENDER', 'BORROWER', 'HUNTER'];
const OUT = '.env.wallets';

if (existsSync(OUT)) {
  console.error(`${OUT} already exists — refusing to overwrite existing keys.`);
  process.exit(1);
}

const phrase = Wallet.createRandom().mnemonic.phrase;

let out = `# Recourse dev wallets — TESTNET ONLY, never fund on mainnet\n`;
out += `# Generated ${new Date().toISOString()}\n`;
out += `MNEMONIC="${phrase}"\n\n`;

for (const [index, role] of ROLES.entries()) {
  const account = HDNodeWallet.fromPhrase(phrase, '', `m/44'/60'/0'/0/${index}`);
  out += `${role}_ADDRESS=${account.address}\n${role}_PRIVATE_KEY=${account.privateKey}\n\n`;
  console.log(`${role.padEnd(9)} ${account.address}`);
}

writeFileSync(OUT, out);
console.log(`\nWritten to ${OUT}. Merge into .env — both are gitignored.`);
