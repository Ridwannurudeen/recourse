import {
  DeploymentTruth,
  anchorV3Snapshot,
  summarizeV3Snapshot,
} from "./v3-core.mjs";

const DEPLOYMENT = Object.freeze({
  chainId: 102031,
  rpcUrl: "https://rpc.cc3-testnet.creditcoin.network",
  contracts: Object.freeze({
    PolicyKernelV2: "0xC96EEf1D5105f2D1f44ecBf998a5989bd27912C7",
    VerifiedCreditStateV1: "0x09E8e25ad1cDE0937A58B3a2629bF0323aDe11Eb",
    PolicyRegistryV1: "0x07459CC8065e46BC3E5F519c715e71DDb10f6c30",
    CappedPilotFactoryV1: "0x3c69a7AB4D4b76C0A8139063E44E08FBdA2c474D",
    MultiChainEventPolicyV1: "0x82C6B7f5a4E1cc41d6e10De3506F73B888a4Ebab",
    ProofJobsV1: "0x1e2B21006dbce769fA8608aD86A7B8B94Bd28485",
  }),
});

const LOCAL_CAPABILITIES = Object.freeze([
  { name: "OperatorMarketV1", deploymentAddress: null },
  { name: "PortfolioMandateV1", deploymentAddress: null },
  { name: "PortfolioPoolV1", deploymentAddress: null },
]);

const FACTORY_ABI = [
  "function facilityCount() view returns (uint256)",
  "function facilityAt(uint256 index) view returns (address)",
  "function maximumFacilityCount() view returns (uint16)",
  "function maximumTotalLimit() view returns (uint256)",
  "function totalFacilityLimit() view returns (uint256)",
  "function creationPaused() view returns (bool)",
];
const KERNEL_ABI = [
  "function proofJobs() view returns (address)",
  "function safeStaleProofRelease() pure returns (bool)",
  "function policySetCommitment(address facility) view returns (bytes32)",
  "function policyOf(address facility,uint256 policyId) view returns (address evaluator,bytes32 configHash,bytes manifestBytes)",
];
const FACILITY_ABI = [
  "function status() view returns (uint8)",
  "function policyCount() view returns (uint256)",
  "function policyIdAt(uint256 index) view returns (uint256)",
];
const MULTI_CHAIN_POLICY_ABI = [
  "function isConfigured(address facility,uint256 policyId) view returns (bool)",
];
const REGISTRY_ABI = ["function releaseCount() view returns (uint256)"];
const PROOF_JOBS_ABI = ["function nextJobId() view returns (uint256)"];
const STATUS_LABELS = Object.freeze([
  "Created",
  "Active",
  "Repaid",
  "Defaulted",
  "Cancelled",
  "Terminated",
]);
const { Contract, JsonRpcProvider } = window.ethers;
const provider = new JsonRpcProvider(DEPLOYMENT.rpcUrl, DEPLOYMENT.chainId, {
  staticNetwork: true,
});

function byId(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  byId(id).textContent = String(value);
}

function safeNumber(value, label) {
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} is not safely indexable`);
  }
  return Number(parsed);
}

function shortHex(value, lead = 8, tail = 6) {
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

function badge(text, tone) {
  const element = document.createElement("span");
  element.className = "obs-badge";
  element.dataset.tone = tone;
  element.textContent = text;
  return element;
}

function metric(label, value) {
  const item = document.createElement("div");
  item.className = "obs-metric";
  const caption = document.createElement("span");
  caption.className = "obs-label";
  caption.textContent = label;
  const number = document.createElement("strong");
  number.textContent = String(value);
  item.append(caption, number);
  return item;
}

function cell(label, value, className) {
  const td = document.createElement("td");
  td.dataset.label = label;
  td.textContent = String(value);
  if (className) td.className = className;
  return td;
}

function truthTone(truth) {
  if (
    truth === DeploymentTruth.Deployed ||
    truth === DeploymentTruth.Activated
  ) {
    return "good";
  }
  if (truth === DeploymentTruth.Unavailable) return "alert";
  return "warn";
}

function truthItem(label, truth, detail) {
  const item = document.createElement("div");
  item.className = "obs-truth-item";
  item.dataset.truth = truth;
  const caption = document.createElement("span");
  caption.textContent = label;
  const state = document.createElement("strong");
  state.textContent = truth;
  const copy = document.createElement("small");
  copy.textContent = detail;
  item.append(caption, state, copy);
  return item;
}

async function readFacility(address, blockTag, kernel, multiChainPolicy) {
  const facility = new Contract(address, FACILITY_ABI, provider);
  const [statusValue, countValue, policySetCommitment] = await Promise.all([
    facility.status({ blockTag }),
    facility.policyCount({ blockTag }),
    kernel.policySetCommitment(address, { blockTag }),
  ]);
  const policyCount = safeNumber(countValue, `${address} policy count`);
  if (policyCount > 32) {
    throw new Error(`${address} policy count exceeds the V3 read bound`);
  }
  const policyIds = await Promise.all(
    Array.from({ length: policyCount }, (_, index) =>
      facility.policyIdAt(index, { blockTag }),
    ),
  );
  const configured = await Promise.all(
    policyIds.map(async (policyId) => {
      const [registration, isConfigured] = await Promise.all([
        kernel.policyOf(address, policyId, { blockTag }),
        multiChainPolicy.isConfigured(address, policyId, { blockTag }),
      ]);
      return (
        registration.evaluator.toLowerCase() ===
          DEPLOYMENT.contracts.MultiChainEventPolicyV1.toLowerCase() &&
        isConfigured
      );
    }),
  );
  return {
    address,
    status: safeNumber(statusValue, `${address} status`),
    policyCount,
    policySetCommitment,
    multiChainPoliciesConfigured: configured.filter(Boolean).length,
  };
}

async function readPinned(blockTag, anchor) {
  const addresses = Object.entries(DEPLOYMENT.contracts);
  const factory = new Contract(
    DEPLOYMENT.contracts.CappedPilotFactoryV1,
    FACTORY_ABI,
    provider,
  );
  const kernel = new Contract(
    DEPLOYMENT.contracts.PolicyKernelV2,
    KERNEL_ABI,
    provider,
  );
  const multiChainPolicy = new Contract(
    DEPLOYMENT.contracts.MultiChainEventPolicyV1,
    MULTI_CHAIN_POLICY_ABI,
    provider,
  );
  const registry = new Contract(
    DEPLOYMENT.contracts.PolicyRegistryV1,
    REGISTRY_ABI,
    provider,
  );
  const proofJobs = new Contract(
    DEPLOYMENT.contracts.ProofJobsV1,
    PROOF_JOBS_ABI,
    provider,
  );
  const [
    codes,
    configuredProofJobs,
    safeStaleProofRelease,
    facilityCountValue,
    maximumFacilityCountValue,
    totalFacilityLimit,
    maximumTotalLimit,
    creationPaused,
    registryReleaseCountValue,
    nextProofJobId,
  ] = await Promise.all([
    Promise.all(
      addresses.map(async ([name, address]) => ({
        name,
        address,
        code: await provider.getCode(address, blockTag),
      })),
    ),
    kernel.proofJobs({ blockTag }),
    kernel.safeStaleProofRelease({ blockTag }),
    factory.facilityCount({ blockTag }),
    factory.maximumFacilityCount({ blockTag }),
    factory.totalFacilityLimit({ blockTag }),
    factory.maximumTotalLimit({ blockTag }),
    factory.creationPaused({ blockTag }),
    registry.releaseCount({ blockTag }),
    proofJobs.nextJobId({ blockTag }),
  ]);
  const facilityCount = safeNumber(facilityCountValue, "facility count");
  const maximumFacilityCount = safeNumber(
    maximumFacilityCountValue,
    "maximum facility count",
  );
  if (facilityCount > maximumFacilityCount || maximumFacilityCount > 32) {
    throw new Error("Factory inventory exceeds the configured V3 read bound");
  }
  const facilityAddresses = await Promise.all(
    Array.from({ length: facilityCount }, (_, index) =>
      factory.facilityAt(index, { blockTag }),
    ),
  );
  const facilities = await Promise.all(
    facilityAddresses.map((address) =>
      readFacility(address, blockTag, kernel, multiChainPolicy),
    ),
  );
  return {
    anchor,
    contracts: codes.map(({ code, ...contract }) => ({
      ...contract,
      hasCode: code !== "0x",
    })),
    kernel: {
      proofJobs: configuredProofJobs,
      expectedProofJobs: DEPLOYMENT.contracts.ProofJobsV1,
      safeStaleProofRelease,
    },
    factory: {
      facilityCount,
      maximumFacilityCount,
      totalFacilityLimit,
      maximumTotalLimit,
      creationPaused,
    },
    facilities,
    registryReleaseCount: safeNumber(
      registryReleaseCountValue,
      "registry release count",
    ),
    nextProofJobId,
    localCapabilities: LOCAL_CAPABILITIES,
  };
}

function render(summary) {
  const noPilot = summary.facilityCount === 0;
  setText(
    "v3-title",
    summary.coreDeployment === DeploymentTruth.Deployed
      ? noPilot
        ? "Historical core found. The hardened pilot is not live."
        : "Historical core found. Its pilot state is enumerable."
      : "V3 core verification is incomplete.",
  );
  setText("v3-block", summary.anchor.blockNumber.toLocaleString("en-US"));
  setText(
    "v3-block-time",
    `${new Date(summary.anchor.blockTimestamp * 1_000).toLocaleString()} · ${shortHex(summary.anchor.blockHash, 10, 6)}`,
  );
  byId("v3-badges").replaceChildren(
    badge(
      `historical core ${summary.coreDeployment}`,
      truthTone(summary.coreDeployment),
    ),
    badge("one-block hash anchor", "good"),
    badge("single RPC endpoint", "warn"),
    badge(
      summary.creationPaused ? "creation paused" : "creation open",
      summary.creationPaused ? "warn" : "good",
    ),
    badge(
      noPilot ? "no live pilot" : `${summary.facilityCount} factory entries`,
      noPilot ? "warn" : "good",
    ),
  );
  byId("v3-truth-rail").replaceChildren(
    truthItem(
      "Historical core",
      summary.coreDeployment,
      "Runtime code + wiring; current compatibility unclaimed",
    ),
    truthItem(
      "Factory",
      summary.factoryState,
      `${summary.facilityCount} entries`,
    ),
    truthItem(
      "Configured",
      summary.configuredFacilities > 0
        ? DeploymentTruth.Configured
        : DeploymentTruth.Empty,
      `${summary.configuredFacilities} facilities`,
    ),
    truthItem(
      "Activated",
      summary.activatedFacilities > 0
        ? DeploymentTruth.Activated
        : DeploymentTruth.Empty,
      `${summary.activatedFacilities} facilities`,
    ),
    truthItem(
      "External",
      DeploymentTruth.ExternalGated,
      `${summary.externalGates.length} named gates`,
    ),
  );
  byId("v3-metrics").replaceChildren(
    metric("Factory entries", summary.facilityCount),
    metric("Configured", summary.configuredFacilities),
    metric("Activated", summary.activatedFacilities),
    metric("Registry releases", summary.registryReleaseCount),
    metric("Proof jobs", summary.proofJobCount.toString()),
  );

  const contracts = byId("v3-contracts");
  contracts.replaceChildren();
  for (const contract of summary.contracts) {
    const row = document.createElement("tr");
    row.append(
      cell("Contract", contract.name),
      cell("Address", shortHex(contract.address), "obs-address"),
      cell("Evidence", contract.truth),
    );
    contracts.append(row);
  }

  setText(
    "v3-capacity-note",
    `${summary.totalFacilityLimit.toLocaleString("en-US")} / ${summary.maximumTotalLimit.toLocaleString("en-US")} raw asset units allocated · ${summary.facilityCount} / ${summary.maximumFacilityCount} slots`,
  );
  const facilities = byId("v3-facilities");
  facilities.replaceChildren();
  for (const facility of summary.facilities) {
    const row = document.createElement("tr");
    row.append(
      cell("Facility", shortHex(facility.address), "obs-address"),
      cell("Status", STATUS_LABELS[facility.status]),
      cell("Policies", facility.policyCount, "obs-num"),
      cell("V3 configs", facility.configuredPolicies, "obs-num"),
      cell("Truth", facility.truth),
    );
    facilities.append(row);
  }
  byId("v3-facilities-empty").hidden = summary.facilityCount !== 0;

  const capabilities = byId("v3-capabilities");
  capabilities.replaceChildren();
  for (const capability of summary.localCapabilities) {
    const card = document.createElement("article");
    card.className = "obs-capability-card";
    const state = badge(capability.truth, truthTone(capability.truth));
    const heading = document.createElement("h3");
    heading.textContent = capability.name;
    const copy = document.createElement("p");
    copy.textContent =
      capability.deploymentAddress === null
        ? "Implemented in the repository; no V3 deployment address or live state is claimed."
        : `Manifest address ${shortHex(capability.deploymentAddress)}.`;
    card.append(state, heading, copy);
    capabilities.append(card);
  }

  const gates = byId("v3-external-gates");
  gates.replaceChildren();
  for (const gate of summary.externalGates) {
    const item = document.createElement("li");
    const state = document.createElement("span");
    state.textContent = gate.truth;
    const name = document.createElement("strong");
    name.textContent = gate.name;
    item.append(state, name);
    gates.append(item);
  }
  byId("v3-state").hidden = true;
  byId("v3-dashboard").hidden = false;
}

async function refresh() {
  byId("v3-retry").hidden = true;
  byId("v3-dashboard").hidden = true;
  byId("v3-state").hidden = false;
  setText("v3-state-title", "Checking V3 deployment truth");
  setText(
    "v3-state-copy",
    "Pinning core code, wiring, factory inventory, registry releases, and proof-job counts to one CC3 block.",
  );
  try {
    const blockNumber = await provider.getBlockNumber();
    const anchored = await anchorV3Snapshot(
      provider,
      DEPLOYMENT.chainId,
      blockNumber,
      readPinned,
    );
    render(summarizeV3Snapshot(anchored.value));
  } catch (error) {
    setText("v3-state-title", "V3 state unavailable");
    setText(
      "v3-state-copy",
      error instanceof Error ? error.message : String(error),
    );
    byId("v3-retry").hidden = false;
  }
}

byId("v3-retry").addEventListener("click", refresh);
refresh();
