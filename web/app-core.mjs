import { queryFilterInBlockPages } from "./horizon1-core.mjs";

const LEGACY_EVENT_QUERY_CONCURRENCY = 4;

export function queryLegacyEvents(
  contract,
  filter,
  deploymentBlock,
  blockNumber,
) {
  return queryFilterInBlockPages(
    contract,
    filter,
    deploymentBlock,
    blockNumber,
    LEGACY_EVENT_QUERY_CONCURRENCY,
  );
}

export async function readFacilityCatalog({
  facility,
  filter,
  deploymentBlock,
  blockNumber,
  stateNames,
  zeroAddress,
}) {
  const opened = await queryLegacyEvents(
    facility,
    filter,
    deploymentBlock,
    blockNumber,
  );
  const ids = opened.map((event) => Number(event.args.facilityId));
  const uniqueIds = [...new Set(ids)].sort((left, right) => left - right);
  return Promise.all(
    uniqueIds.map(async (facilityId) => {
      const data = await facility.facilityOf(facilityId, {
        blockTag: blockNumber,
      });
      if (data.lender === zeroAddress || data.facilityLimit === 0n) {
        throw new Error(`Facility #${facilityId} returned an invalid record.`);
      }
      return {
        facilityId,
        data,
        stateName: stateNames[Number(data.state)],
      };
    }),
  );
}
