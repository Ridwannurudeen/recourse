import { summarizeV3Extensions } from "./v3-core.mjs";

export const HISTORICAL_FACTORY = Object.freeze({
  address: "0x04719DA84B91AC2Cb2bf9ad770F412989DF61fbd",
  manifest: "deployments-horizon1.json",
  commit: "14d1e62e1b1adc671123cad80e9cff43ffd71b38",
  label: "Historical Horizon 1 factory; excluded from current pool inventory",
});

export function summarizePortfolioPool(extensions) {
  const summary = summarizeV3Extensions(extensions);
  if (summary.truth !== "deployed") {
    return {
      ...summary,
      lifecycle: summary.poolStatement,
      capital: "Capital state unavailable",
      execution: "Allocation state unavailable",
    };
  }
  const { pool } = summary;
  return {
    ...summary,
    lifecycle:
      Number(pool.status) === 0
        ? "Configuring — not activated"
        : ["Configuring", "Funding", "Active", "Finalized", "Cancelled"][
            Number(pool.status)
          ],
    capital:
      BigInt(pool.totalDeposited) === 0n &&
      BigInt(pool.totalAllocatedPrincipal) === 0n &&
      BigInt(pool.assetBalance) === 0n
        ? "None (0 deposits, 0 allocations)"
        : `${pool.totalDeposited} raw units deposited · ${pool.totalAllocatedPrincipal} raw units allocated · ${pool.assetBalance} raw units in pool`,
    execution:
      BigInt(pool.allocatedFacilityCount) === 0n &&
      BigInt(pool.totalAllocatedPrincipal) === 0n
        ? "Allocation path not exercised"
        : `${pool.allocatedFacilityCount} facilities allocated`,
  };
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

function amount(value, label) {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error();
    return parsed;
  } catch {
    throw new TypeError(`Invalid ${label}`);
  }
}

function safeCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

function normalizedAddress(value, label) {
  if (typeof value !== "string" || !ADDRESS.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

export function normalizeTokenSymbol(value) {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,16}$/.test(value)
    ? value
    : "TOKEN";
}

export function validateNetworkAnchor(
  value,
  {
    now = Date.now(),
    staleAfterSeconds = 300,
    futureToleranceSeconds = 120,
  } = {},
) {
  if (!value || typeof value !== "object")
    throw new TypeError("Invalid network anchor");
  const expectedChainId = safeCount(value.expectedChainId, "expectedChainId");
  const actualChainId = safeCount(value.actualChainId, "actualChainId");
  if (actualChainId !== expectedChainId) {
    throw new RangeError(
      `RPC chain ID ${actualChainId} does not match ${expectedChainId}`,
    );
  }
  const blockNumber = safeCount(value.blockNumber, "blockNumber");
  const blockTimestamp = safeCount(value.blockTimestamp, "blockTimestamp");
  if (typeof value.blockHash !== "string" || !BYTES32.test(value.blockHash)) {
    throw new TypeError("Invalid blockHash");
  }
  if (!Number.isFinite(now) || now < 0) throw new TypeError("Invalid now");
  safeCount(staleAfterSeconds, "staleAfterSeconds");
  safeCount(futureToleranceSeconds, "futureToleranceSeconds");
  const stateAgeSeconds = Math.max(
    0,
    Math.floor((now - blockTimestamp * 1_000) / 1_000),
  );
  const future = blockTimestamp * 1_000 > now + futureToleranceSeconds * 1_000;
  return {
    chainId: actualChainId,
    blockNumber,
    blockHash: value.blockHash.toLowerCase(),
    blockTimestamp,
    stateAgeSeconds,
    stale: stateAgeSeconds > staleAfterSeconds,
    future,
  };
}

export function summarizePortfolio(snapshots, options = {}) {
  if (!Array.isArray(snapshots)) throw new TypeError("Invalid snapshots");
  const groups = new Map();
  const networks = snapshots.map((snapshot, networkIndex) => {
    if (!snapshot || typeof snapshot !== "object") {
      throw new TypeError(`Invalid snapshots[${networkIndex}]`);
    }
    const anchor = validateNetworkAnchor(
      {
        expectedChainId: snapshot.chainId,
        actualChainId: snapshot.chainId,
        blockNumber: snapshot.blockNumber,
        blockHash: snapshot.blockHash,
        blockTimestamp: snapshot.blockTimestamp,
      },
      options,
    );
    const { chainId } = anchor;
    const totalFacilities = safeCount(
      snapshot.totalFacilities,
      `snapshots[${networkIndex}].totalFacilities`,
    );
    if (
      !Array.isArray(snapshot.facilities) ||
      !Array.isArray(snapshot.failures)
    ) {
      throw new TypeError(`Invalid snapshots[${networkIndex}] collections`);
    }
    for (const [index, facility] of snapshot.facilities.entries()) {
      const label = `snapshots[${networkIndex}].facilities[${index}]`;
      const asset = normalizedAddress(facility.asset, `${label}.asset`);
      const decimals = safeCount(facility.decimals, `${label}.decimals`);
      if (decimals > 255) throw new TypeError(`Invalid ${label}.decimals`);
      normalizedAddress(facility.address, `${label}.address`);
      const key = `${chainId}:${asset.toLowerCase()}:${decimals}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          chainId,
          asset,
          decimals,
          symbol: normalizeTokenSymbol(facility.symbol),
          facilities: 0,
          facilityLimit: 0n,
          lenderFunded: 0n,
          bondPosted: 0n,
          drawnPrincipal: 0n,
          outstandingDebt: 0n,
          availableCredit: 0n,
        };
        groups.set(key, group);
      }
      group.facilities += 1;
      for (const field of [
        "facilityLimit",
        "lenderFunded",
        "bondPosted",
        "drawnPrincipal",
        "outstandingDebt",
        "availableCredit",
      ]) {
        group[field] += amount(facility[field], `${label}.${field}`);
      }
    }
    return {
      chainId,
      name: String(snapshot.name),
      blockNumber: anchor.blockNumber,
      blockHash: anchor.blockHash,
      blockTimestamp: anchor.blockTimestamp,
      stateAgeSeconds: anchor.stateAgeSeconds,
      stale: anchor.stale,
      future: anchor.future,
      factory: snapshot.factory,
      pool: snapshot.extensions
        ? summarizePortfolioPool(snapshot.extensions)
        : null,
      totalFacilities,
      observedFacilities: snapshot.facilities.length,
      failedFacilities: snapshot.failures.length,
      truncated: Boolean(snapshot.truncated),
      partial: snapshot.failures.length > 0 || Boolean(snapshot.truncated),
    };
  });
  return {
    networks,
    groups: [...groups.values()].sort((left, right) => {
      if (left.chainId !== right.chainId) return left.chainId - right.chainId;
      return left.asset.localeCompare(right.asset);
    }),
    totalFacilities: networks.reduce(
      (total, network) => total + network.totalFacilities,
      0,
    ),
    observedFacilities: networks.reduce(
      (total, network) => total + network.observedFacilities,
      0,
    ),
    partial: networks.some(({ partial }) => partial),
    stale: networks.some(({ stale, future }) => stale || future),
  };
}

export function formatAssetAmount(value, decimals, displayDecimals = 2) {
  const parsed = amount(value, "value");
  safeCount(decimals, "decimals");
  safeCount(displayDecimals, "displayDecimals");
  const scale = 10n ** BigInt(decimals);
  const whole = parsed / scale;
  if (displayDecimals === 0 || decimals === 0) {
    return whole.toLocaleString("en-US");
  }
  const shown = Math.min(decimals, displayDecimals);
  const fraction = (parsed % scale)
    .toString()
    .padStart(decimals, "0")
    .slice(0, shown);
  return `${whole.toLocaleString("en-US")}.${fraction}`;
}
