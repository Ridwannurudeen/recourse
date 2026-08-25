import { Interface, dataLength, id } from 'ethers';

const TRANSFER = id('Transfer(address,address,uint256)');
const iface = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);

export function summarizeQualifyingTransfers(logs, token, treasury) {
  const normalizedToken = token.toLowerCase();
  const normalizedTreasury = treasury.toLowerCase();
  let total = 0n;
  let firstRecipient;
  let qualifyingTransferCount = 0;

  for (const log of logs) {
    if (
      log.address.toLowerCase() !== normalizedToken ||
      log.topics.length !== 3 ||
      dataLength(log.data) !== 32 ||
      log.topics[0].toLowerCase() !== TRANSFER.toLowerCase()
    ) continue;

    const parsed = iface.parseLog({ topics: log.topics, data: log.data });
    const from = parsed.args.from.toLowerCase();
    const to = parsed.args.to.toLowerCase();
    if (from !== normalizedTreasury || to === normalizedTreasury) continue;

    firstRecipient ??= parsed.args.to;
    qualifyingTransferCount++;
    total += parsed.args.value;
  }

  if (qualifyingTransferCount === 0) return null;
  return { valueBaseUnits: total.toString(), to: firstRecipient, qualifyingTransferCount };
}
