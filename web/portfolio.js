import {
  formatAssetAmount,
  summarizePortfolio,
  validateNetworkAnchor,
} from "./portfolio-core.mjs";

const NETWORKS = Object.freeze([
  {
    name: "Creditcoin CC3 Testnet",
    chainId: 102031,
    rpcUrl: "https://rpc.cc3-testnet.creditcoin.network",
    factory: "0x04719DA84B91AC2Cb2bf9ad770F412989DF61fbd",
  },
]);
const MAX_FACILITIES_PER_NETWORK = 200;
const FACILITY_BATCH = 8;
const FACTORY_ABI = [
  "function facilityCount() view returns (uint256)",
  "function facilityAt(uint256 index) view returns (address)",
];
const FACILITY_ABI = [
  "function asset() view returns (address)",
  "function facilityLimit() view returns (uint256)",
  "function lenderFunded() view returns (uint256)",
  "function bondPosted() view returns (uint256)",
  "function drawnPrincipal() view returns (uint256)",
  "function outstandingDebt() view returns (uint256)",
  "function availableCredit() view returns (uint256)",
];
const TOKEN_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];
const { Contract, JsonRpcProvider } = window.ethers;

function byId(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  byId(id).textContent = String(value);
}

async function inBatches(values, size, read) {
  const results = [];
  for (let index = 0; index < values.length; index += size) {
    results.push(
      ...(await Promise.all(values.slice(index, index + size).map(read))),
    );
  }
  return results;
}

async function readNetwork(config) {
  const provider = new JsonRpcProvider(config.rpcUrl, config.chainId, {
    staticNetwork: true,
  });
  const actualChainId = Number(BigInt(await provider.send("eth_chainId", [])));
  const blockNumber = await provider.getBlockNumber();
  const anchor = await provider.getBlock(blockNumber);
  if (!anchor || typeof anchor.hash !== "string")
    throw new Error(`${config.name} block ${blockNumber} is unavailable`);
  const validatedAnchor = validateNetworkAnchor({
    expectedChainId: config.chainId,
    actualChainId,
    blockNumber,
    blockHash: anchor.hash,
    blockTimestamp: anchor.timestamp,
  });
  const factory = new Contract(config.factory, FACTORY_ABI, provider);
  const count = await factory.facilityCount({ blockTag: blockNumber });
  if (count > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(`${config.name} facility count is not safely indexable`);
  const totalFacilities = Number(count);
  const observedCount = Math.min(totalFacilities, MAX_FACILITIES_PER_NETWORK);
  const addresses = await inBatches(
    Array.from({ length: observedCount }, (_, index) => index),
    FACILITY_BATCH,
    (index) => factory.facilityAt(index, { blockTag: blockNumber }),
  );
  const loaded = await inBatches(addresses, FACILITY_BATCH, async (address) => {
    try {
      const facility = new Contract(address, FACILITY_ABI, provider);
      const [
        asset,
        facilityLimit,
        lenderFunded,
        bondPosted,
        drawnPrincipal,
        outstandingDebt,
        availableCredit,
      ] = await Promise.all([
        facility.asset({ blockTag: blockNumber }),
        facility.facilityLimit({ blockTag: blockNumber }),
        facility.lenderFunded({ blockTag: blockNumber }),
        facility.bondPosted({ blockTag: blockNumber }),
        facility.drawnPrincipal({ blockTag: blockNumber }),
        facility.outstandingDebt({ blockTag: blockNumber }),
        facility.availableCredit({ blockTag: blockNumber }),
      ]);
      const token = new Contract(asset, TOKEN_ABI, provider);
      const [symbol, decimals] = await Promise.all([
        token.symbol({ blockTag: blockNumber }),
        token.decimals({ blockTag: blockNumber }),
      ]);
      return {
        ok: true,
        value: {
          address,
          asset,
          symbol,
          decimals: Number(decimals),
          facilityLimit,
          lenderFunded,
          bondPosted,
          drawnPrincipal,
          outstandingDebt,
          availableCredit,
        },
      };
    } catch (error) {
      return {
        ok: false,
        value: {
          address,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  });
  const finalAnchor = await provider.getBlock(blockNumber);
  if (
    !finalAnchor ||
    finalAnchor.hash.toLowerCase() !== anchor.hash.toLowerCase()
  ) {
    throw new Error(
      `${config.name} block ${blockNumber} changed during the portfolio read`,
    );
  }
  return {
    name: config.name,
    chainId: config.chainId,
    blockNumber,
    blockHash: validatedAnchor.blockHash,
    blockTimestamp: validatedAnchor.blockTimestamp,
    totalFacilities,
    truncated: totalFacilities > observedCount,
    facilities: loaded.filter(({ ok }) => ok).map(({ value }) => value),
    failures: loaded.filter(({ ok }) => !ok).map(({ value }) => value),
  };
}

function label(text) {
  const element = document.createElement("span");
  element.className = "obs-label";
  element.textContent = text;
  return element;
}

function badge(text, tone) {
  const element = document.createElement("span");
  element.className = "obs-badge";
  element.dataset.tone = tone;
  element.textContent = text;
  return element;
}

function ledger(items) {
  const list = document.createElement("dl");
  list.className = "obs-ledger";
  for (const [term, value] of items) {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = term;
    dd.textContent = value;
    row.append(dt, dd);
    list.append(row);
  }
  return list;
}

function render(summary) {
  setText(
    "portfolio-coverage",
    `${summary.observedFacilities} / ${summary.totalFacilities}`,
  );
  const newestBlockTime = summary.networks.reduce(
    (latest, network) => Math.max(latest, network.blockTimestamp),
    0,
  );
  setText(
    "portfolio-refresh",
    newestBlockTime === 0
      ? "No configured network state"
      : `Latest block time ${new Date(newestBlockTime * 1_000).toLocaleString()}`,
  );
  byId("portfolio-badges").replaceChildren(
    badge(
      `${summary.networks.length} single-endpoint assertion${summary.networks.length === 1 ? "" : "s"}`,
      "warn",
    ),
    badge(
      summary.partial ? "partial coverage" : "complete configured coverage",
      summary.partial ? "warn" : "good",
    ),
    badge(
      summary.stale ? "stale or future block time" : "fresh block time",
      summary.stale ? "alert" : "good",
    ),
    badge(
      `${summary.groups.length} exact asset group${summary.groups.length === 1 ? "" : "s"}`,
      "good",
    ),
  );
  const networks = byId("portfolio-networks");
  networks.replaceChildren();
  for (const network of summary.networks) {
    const card = document.createElement("article");
    card.className = "obs-network-card";
    const heading = document.createElement("h3");
    heading.textContent = network.name;
    card.append(
      label(`chain ${network.chainId}`),
      heading,
      ledger([
        ["Block", network.blockNumber.toLocaleString("en-US")],
        [
          "Block hash",
          `${network.blockHash.slice(0, 10)}…${network.blockHash.slice(-6)}`,
        ],
        [
          "Block time",
          new Date(network.blockTimestamp * 1_000).toLocaleString(),
        ],
        [
          "State age",
          `${network.stateAgeSeconds.toLocaleString("en-US")} seconds`,
        ],
        ["Factory entries", network.totalFacilities.toLocaleString("en-US")],
        [
          "Read successfully",
          network.observedFacilities.toLocaleString("en-US"),
        ],
        ["Read failures", network.failedFacilities.toLocaleString("en-US")],
        ["RPC evidence", "Single endpoint; chain and block hash checked"],
        ["Coverage", network.partial ? "Partial" : "Complete"],
      ]),
    );
    networks.append(card);
  }
  const groups = byId("portfolio-groups");
  groups.replaceChildren();
  for (const group of summary.groups) {
    const card = document.createElement("article");
    card.className = "obs-group-card";
    const heading = document.createElement("h3");
    heading.textContent = group.symbol;
    const amount = (value) =>
      `${formatAssetAmount(value, group.decimals)} ${group.symbol}`;
    card.append(
      label(`chain ${group.chainId} · ${group.asset}`),
      heading,
      ledger([
        ["Facilities", group.facilities.toLocaleString("en-US")],
        ["Facility limit", amount(group.facilityLimit)],
        ["Lender funded", amount(group.lenderFunded)],
        ["Bond posted", amount(group.bondPosted)],
        ["Principal drawn", amount(group.drawnPrincipal)],
        ["Outstanding debt", amount(group.outstandingDebt)],
        ["Available credit", amount(group.availableCredit)],
      ]),
    );
    groups.append(card);
  }
  byId("portfolio-empty").hidden = summary.groups.length !== 0;
  byId("portfolio-state").hidden = true;
  byId("portfolio-dashboard").hidden = false;
}

async function refresh() {
  byId("portfolio-retry").hidden = true;
  try {
    const settled = await Promise.allSettled(NETWORKS.map(readNetwork));
    const failures = settled.filter(({ status }) => status === "rejected");
    const snapshots = settled
      .filter(({ status }) => status === "fulfilled")
      .map(({ value }) => value);
    if (snapshots.length === 0) throw failures[0].reason;
    render(summarizePortfolio(snapshots));
    if (failures.length > 0) {
      byId("portfolio-badges").append(
        badge(`${failures.length} network read failed`, "alert"),
      );
    }
  } catch (error) {
    byId("portfolio-dashboard").hidden = true;
    byId("portfolio-state").hidden = false;
    setText("portfolio-state-title", "Portfolio state unavailable");
    setText(
      "portfolio-state-copy",
      error instanceof Error ? error.message : String(error),
    );
    byId("portfolio-retry").hidden = false;
  }
}

byId("portfolio-retry").addEventListener("click", refresh);
refresh();
