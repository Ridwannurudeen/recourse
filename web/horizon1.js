import {
  capacitySegments,
  createCompletionPollingLoop,
  createLatestAsyncRunner,
  formatBaseUnits,
  formatUnixTimestamp,
  loadFacilityJobs,
  normalizeTokenSymbol,
  outcomeLabel,
  partitionFacilityCatalog,
  queryFilterInBlockPages,
  registeredPolicyIds,
  statusLabel,
} from "./horizon1-core.mjs";

const CONFIG = Object.freeze({
  rpcUrl: "https://rpc.cc3-testnet.creditcoin.network",
  explorer: "https://creditcoin-testnet.blockscout.com",
  factory: "0x04719DA84B91AC2Cb2bf9ad770F412989DF61fbd",
  kernel: "0x5cE48b776CBFa04Bf3f375809d16B33B3d413Dbb",
  creditState: "0x574916dc2D41b2Ac57FF77c4bc47e91D26550AE4",
  proofJobs: "0xdA28730f8BCd7dAd54Fe3c77D01aacC41E8DeB4b",
  policyKernelDeploymentBlock: 5_377_722,
  proofJobsDeploymentBlock: 5_377_746,
  refreshMs: 30_000,
});

const FACTORY_ABI = [
  "function facilityCount() view returns (uint256)",
  "function facilityAt(uint256) view returns (address)",
];
const FACILITY_ABI = [
  "function asset() view returns (address)",
  "function kernel() view returns (address)",
  "function lender() view returns (address)",
  "function borrower() view returns (address)",
  "function facilityLimit() view returns (uint256)",
  "function bondRequired() view returns (uint256)",
  "function initialDrawFeeBps() view returns (uint16)",
  "function maturityBlock() view returns (uint64)",
  "function status() view returns (uint8)",
  "function policyOutcome() view returns (uint8)",
  "function creditLimitBps() view returns (uint16)",
  "function futureDrawFeeBps() view returns (uint16)",
  "function evidenceValidUntil() view returns (uint64)",
  "function freshEvidenceRequired() view returns (bool)",
  "function lenderDrawPaused() view returns (bool)",
  "function borrowerDrawPaused() view returns (bool)",
  "function lenderFunded() view returns (uint256)",
  "function bondPosted() view returns (uint256)",
  "function drawnPrincipal() view returns (uint256)",
  "function outstandingDebt() view returns (uint256)",
  "function availableCredit() view returns (uint256)",
  "function policyEffectOf(uint256) view returns (tuple(uint8 outcome,uint16 creditLimitBps,uint16 futureDrawFeeBps,bool freezePendingDraw,bool requireFreshEvidence,bool terminate) effect,uint64 evidenceExpiry,bool exists)",
];
const KERNEL_ABI = [
  "event PolicyRegistered(address indexed facility,uint256 indexed policyId,address indexed evaluator,bytes32 configHash,bytes manifest)",
  "function creditState() view returns (address)",
  "function policySetCommitment(address) view returns (bytes32)",
  "function policyOf(address,uint256) view returns (address evaluator,bytes32 configHash,bytes manifestBytes)",
  "function latestSourcePosition(address,uint256) view returns (bool recorded,uint64 blockHeight,uint64 transactionIndex)",
];
const CREDIT_STATE_ABI = [
  "function observationCount(address,address) view returns (uint256)",
  "function observationAt(address,address,uint256) view returns (uint256 policyId,tuple(uint8 kind,uint8 evidenceKind,uint64 sourceChain,uint64 sourceBlock,uint64 transactionIndex,address subject,address emitter,uint256 observedValue,uint64 proofTime,uint64 expiry,bytes32 evidenceDigest,bytes32 policyEffectHash) observation)",
];
const PROOF_JOBS_ABI = [
  "event JobCreated(uint256 indexed jobId,address indexed sponsor,address indexed facility,uint256 policyId,bytes32 requirementsDigest,uint256 escrow)",
  "function getJob(uint256) view returns (tuple(address sponsor,address token,address facility,uint256 policyId,bytes32 requirementsDigest,uint64 expiry,uint64 revealWindowBlocks,uint32 maxSuccessfulProofs,uint32 successfulProofs,uint256 proofReimbursement,uint256 outcomeReward,uint256 commitBond,uint256 escrowRemaining,uint8 rewardOutcomeThreshold,uint8 state))",
];
const TOKEN_ABI = [
  "function symbol() view returns (string)",
  "function decimals() pure returns (uint8)",
];

const { Contract, JsonRpcProvider } = window.ethers;
const provider = new JsonRpcProvider(CONFIG.rpcUrl, 102031, {
  staticNetwork: true,
});
const factory = new Contract(CONFIG.factory, FACTORY_ABI, provider);
const kernel = new Contract(CONFIG.kernel, KERNEL_ABI, provider);
const creditState = new Contract(
  CONFIG.creditState,
  CREDIT_STATE_ABI,
  provider,
);
const proofJobs = new Contract(CONFIG.proofJobs, PROOF_JOBS_ABI, provider);
const state = {
  facilities: [],
  unsupportedFacilities: 0,
  selected: null,
  timer: null,
};
const runLatestRefresh = createLatestAsyncRunner();

export async function readAtStableBlock(
  provider,
  blockNumber,
  readPinnedState,
) {
  const block = await provider.getBlock(blockNumber);
  if (!block || typeof block.hash !== "string") {
    throw new Error(`Block ${blockNumber} is unavailable.`);
  }
  const expectedHash = block.hash.toLowerCase();
  const value = await readPinnedState(blockNumber);
  const anchoredBlock = await provider.getBlock(blockNumber);
  if (
    !anchoredBlock ||
    typeof anchoredBlock.hash !== "string" ||
    anchoredBlock.hash.toLowerCase() !== expectedHash
  ) {
    throw new Error(
      `Block ${blockNumber} changed while the dashboard snapshot was being read.`,
    );
  }
  return { block, value };
}

function element(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  element(id).textContent = value;
}

function shortAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function explorerAddress(address) {
  return `${CONFIG.explorer}/address/${address}`;
}

function formatBps(value) {
  return `${(Number(value) / 100).toFixed(2)}%`;
}

function observationKind(value) {
  return (
    ["Ownership", "Collateral", "Position", "Liability", "Behaviour"][
      Number(value)
    ] ?? "Unknown"
  );
}

function evidenceKind(value) {
  return (
    ["Transaction control", "Event delta", "Event transition"][Number(value)] ??
    "Unknown"
  );
}

function jobState(value) {
  return (
    ["Open", "Outcome reached", "Attempts exhausted", "Expired"][
      Number(value)
    ] ?? "Unknown"
  );
}

async function discoverFacilities(blockTag) {
  const [countValue, configuredCreditState] = await Promise.all([
    factory.facilityCount({ blockTag }),
    kernel.creditState({ blockTag }),
  ]);
  const count = Number(countValue);
  const addresses = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      factory.facilityAt(index, { blockTag }),
    ),
  );
  const facilities = await Promise.all(
    addresses.map(async (address) => {
      const facility = new Contract(address, FACILITY_ABI, provider);
      const facilityKernel = await facility.kernel({ blockTag });
      return {
        address,
        kernel: facilityKernel,
        creditState:
          facilityKernel.toLowerCase() === CONFIG.kernel.toLowerCase()
            ? configuredCreditState
            : null,
      };
    }),
  );
  return partitionFacilityCatalog(
    facilities,
    CONFIG.kernel,
    CONFIG.creditState,
  );
}

async function readFacility(address, blockTag) {
  const facility = new Contract(address, FACILITY_ABI, provider);
  const [
    asset,
    lender,
    borrower,
    facilityLimit,
    bondRequired,
    initialDrawFeeBps,
    maturityBlock,
    status,
    policyOutcome,
    creditLimitBps,
    futureDrawFeeBps,
    evidenceValidUntil,
    freshEvidenceRequired,
    lenderDrawPaused,
    borrowerDrawPaused,
    lenderFunded,
    bondPosted,
    drawnPrincipal,
    outstandingDebt,
    availableCredit,
    policySetCommitment,
  ] = await Promise.all([
    facility.asset({ blockTag }),
    facility.lender({ blockTag }),
    facility.borrower({ blockTag }),
    facility.facilityLimit({ blockTag }),
    facility.bondRequired({ blockTag }),
    facility.initialDrawFeeBps({ blockTag }),
    facility.maturityBlock({ blockTag }),
    facility.status({ blockTag }),
    facility.policyOutcome({ blockTag }),
    facility.creditLimitBps({ blockTag }),
    facility.futureDrawFeeBps({ blockTag }),
    facility.evidenceValidUntil({ blockTag }),
    facility.freshEvidenceRequired({ blockTag }),
    facility.lenderDrawPaused({ blockTag }),
    facility.borrowerDrawPaused({ blockTag }),
    facility.lenderFunded({ blockTag }),
    facility.bondPosted({ blockTag }),
    facility.drawnPrincipal({ blockTag }),
    facility.outstandingDebt({ blockTag }),
    facility.availableCredit({ blockTag }),
    kernel.policySetCommitment(address, { blockTag }),
  ]);

  const token = new Contract(asset, TOKEN_ABI, provider);
  const [symbol, decimals] = await Promise.all([
    token.symbol({ blockTag }),
    token.decimals({ blockTag }),
  ]);
  const [policyEvents, jobs] = await Promise.all([
    queryFilterInBlockPages(
      kernel,
      kernel.filters.PolicyRegistered(address),
      CONFIG.policyKernelDeploymentBlock,
      blockTag,
    ),
    loadFacilityJobs(
      proofJobs,
      address,
      CONFIG.proofJobsDeploymentBlock,
      blockTag,
    ),
  ]);
  const policyIds = registeredPolicyIds(policyEvents);
  const policies = await Promise.all(
    policyIds.map(async (policyId) => {
      const [registration, effectRecord, sourcePosition] = await Promise.all([
        kernel.policyOf(address, policyId, { blockTag }),
        facility.policyEffectOf(policyId, { blockTag }),
        kernel.latestSourcePosition(address, policyId, { blockTag }),
      ]);
      return { policyId, registration, effectRecord, sourcePosition };
    }),
  );

  const observationCount = Number(
    await creditState.observationCount(address, borrower, { blockTag }),
  );
  const observations = await Promise.all(
    Array.from({ length: observationCount }, (_, index) =>
      creditState.observationAt(address, borrower, index, { blockTag }),
    ),
  );

  return {
    address,
    asset,
    symbol: normalizeTokenSymbol(symbol),
    decimals: Number(decimals),
    lender,
    borrower,
    facilityLimit,
    bondRequired,
    initialDrawFeeBps,
    maturityBlock,
    status,
    policyOutcome,
    creditLimitBps,
    futureDrawFeeBps,
    evidenceValidUntil,
    freshEvidenceRequired,
    lenderDrawPaused,
    borrowerDrawPaused,
    lenderFunded,
    bondPosted,
    drawnPrincipal,
    outstandingDebt,
    availableCredit,
    policySetCommitment,
    policies,
    observations,
    jobs,
  };
}

function renderFacilityPills() {
  const container = element("facility-pills");
  container.replaceChildren();
  state.facilities.forEach((address, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "facility-pill";
    button.dataset.selected = String(address === state.selected);
    button.setAttribute("aria-pressed", String(address === state.selected));
    button.textContent = `Facility ${index + 1} · ${shortAddress(address)}`;
    button.addEventListener("click", () => selectFacility(address));
    container.append(button);
  });
  const supported = state.facilities.length;
  const filtered = state.unsupportedFacilities;
  setText(
    "facility-catalog-note",
    filtered === 0
      ? `${supported} compatible with the configured Horizon 1 kernel`
      : `${supported} compatible · ${filtered} incompatible ${filtered === 1 ? "facility" : "facilities"} filtered`,
  );
}

function renderPolicies(snapshot) {
  const list = element("policy-list");
  list.replaceChildren();
  snapshot.policies.forEach(
    ({ policyId, registration, effectRecord, sourcePosition }) => {
      const card = document.createElement("article");
      card.className = "policy-card";
      const effect = effectRecord.effect;
      const applied = effectRecord.exists;
      const source = sourcePosition.recorded
        ? `Source ${sourcePosition.blockHeight.toLocaleString()} · tx ${sourcePosition.transactionIndex}`
        : "No accepted source position";
      card.innerHTML = `
      <div class="policy-card-heading">
        <div><span>Policy ${policyId}</span><strong>${applied ? outcomeLabel(effect.outcome) : "Awaiting evidence"}</strong></div>
        <a href="${explorerAddress(registration.evaluator)}" target="_blank" rel="noopener noreferrer">${shortAddress(registration.evaluator)} ↗</a>
      </div>
      <dl>
        <div><dt>Config hash</dt><dd title="${registration.configHash}">${shortAddress(registration.configHash)}</dd></div>
        <div><dt>Credit ceiling</dt><dd>${applied ? formatBps(effect.creditLimitBps) : "Not applied"}</dd></div>
        <div><dt>Draw fee</dt><dd>${applied ? formatBps(effect.futureDrawFeeBps) : "Not applied"}</dd></div>
        <div><dt>Evidence expiry</dt><dd>${applied ? formatUnixTimestamp(effectRecord.evidenceExpiry) : "No accepted effect"}</dd></div>
      </dl>
      <p>${applied ? source : "Registered and committed; no accepted observation has applied an effect."}</p>
    `;
      list.append(card);
    },
  );
}

function renderObservations(snapshot) {
  setText("observation-count", `${snapshot.observations.length} accepted`);
  const list = element("observation-list");
  list.replaceChildren();
  if (snapshot.observations.length === 0) {
    const empty = document.createElement("p");
    empty.className = "stream-empty";
    empty.textContent =
      "No policy observation has been accepted for this borrower.";
    list.append(empty);
    return;
  }

  snapshot.observations
    .slice()
    .reverse()
    .forEach(([policyId, observation], reverseIndex) => {
      const row = document.createElement("article");
      row.className = "observation-row";
      row.innerHTML = `
        <span class="stream-index">${String(snapshot.observations.length - reverseIndex).padStart(2, "0")}</span>
        <div>
          <strong>${observationKind(observation.kind)} · ${evidenceKind(observation.evidenceKind)}</strong>
          <p>Policy ${policyId} · chain ${observation.sourceChain} · block ${observation.sourceBlock.toLocaleString()} · tx ${observation.transactionIndex}</p>
        </div>
        <div class="observation-value">
          <strong>${observation.observedValue.toLocaleString()}</strong>
          <span>raw event value</span>
        </div>
        <time>${formatUnixTimestamp(observation.proofTime)}</time>
      `;
      list.append(row);
    });
}

function renderJobs(snapshot) {
  setText("job-count", `${snapshot.jobs.length} published`);
  const list = element("job-list");
  list.replaceChildren();
  if (snapshot.jobs.length === 0) {
    const empty = document.createElement("p");
    empty.className = "stream-empty";
    empty.textContent = "No proof job targets this facility.";
    list.append(empty);
    return;
  }

  snapshot.jobs.forEach(({ id, job }) => {
    const card = document.createElement("article");
    card.className = "job-card";
    card.innerHTML = `
      <div class="job-card-heading">
        <span>Job ${id}</span>
        <strong data-state="${jobState(job.state)}">${jobState(job.state)}</strong>
      </div>
      <p>Policy ${job.policyId} · ${job.successfulProofs}/${job.maxSuccessfulProofs} accepted proofs</p>
      <div class="job-progress"><span style="width:${Number(job.maxSuccessfulProofs) === 0 ? 0 : (Number(job.successfulProofs) / Number(job.maxSuccessfulProofs)) * 100}%"></span></div>
      <dl>
        <div><dt>Proof reimbursement</dt><dd>${formatBaseUnits(job.proofReimbursement, snapshot.decimals, 2)} ${snapshot.symbol}</dd></div>
        <div><dt>Outcome reward</dt><dd>${formatBaseUnits(job.outcomeReward, snapshot.decimals, 2)} ${snapshot.symbol}</dd></div>
        <div><dt>Commit bond</dt><dd>${formatBaseUnits(job.commitBond, snapshot.decimals, 2)} ${snapshot.symbol}</dd></div>
        <div><dt>Expires</dt><dd>${formatUnixTimestamp(job.expiry)}</dd></div>
      </dl>
    `;
    list.append(card);
  });
}

function renderSnapshot(snapshot, block) {
  const amount = (value) =>
    `${formatBaseUnits(value, snapshot.decimals, 2)} ${snapshot.symbol}`;
  const segments = capacitySegments(snapshot);
  const appliedPolicies = snapshot.policies.filter(
    ({ effectRecord }) => effectRecord.exists,
  ).length;
  setText("snapshot-block", block.number.toLocaleString());
  setText("snapshot-time", formatUnixTimestamp(block.timestamp));
  setText("available-credit", amount(snapshot.availableCredit));
  setText(
    "capacity-caption",
    `${amount(snapshot.drawnPrincipal)} drawn from a ${amount(snapshot.facilityLimit)} facility.`,
  );
  setText("facility-status", statusLabel(snapshot.status));
  element("facility-status").dataset.state = statusLabel(snapshot.status);
  setText("facility-limit", amount(snapshot.facilityLimit));
  setText("outstanding-debt", amount(snapshot.outstandingDebt));
  setText("policy-limit", formatBps(snapshot.creditLimitBps));
  setText("draw-fee", formatBps(snapshot.futureDrawFeeBps));
  setText(
    "bond-posted",
    `${amount(snapshot.bondPosted)} / ${amount(snapshot.bondRequired)}`,
  );
  setText(
    "evidence-valid-until",
    formatUnixTimestamp(snapshot.evidenceValidUntil),
  );
  element("capacity-drawn").style.width = `${segments.drawnBps / 100}%`;
  element("capacity-available").style.width = `${segments.availableBps / 100}%`;
  element("capacity-frozen").style.width = `${segments.frozenBps / 100}%`;
  setText(
    "policy-outcome",
    outcomeLabel(snapshot.policyOutcome, appliedPolicies > 0),
  );
  setText(
    "policy-explanation",
    snapshot.policies.length === 0
      ? "No registered policy was found at this block."
      : `${snapshot.policies.length} registered ${snapshot.policies.length === 1 ? "policy is" : "policies are"} committed; ${appliedPolicies} currently ${appliedPolicies === 1 ? "has" : "have"} an accepted effect.`,
  );
  setText("policy-count", snapshot.policies.length.toString());
  setText("policy-commitment", snapshot.policySetCommitment);
  setText(
    "fresh-evidence",
    snapshot.freshEvidenceRequired ? "Required" : "Not required",
  );
  setText(
    "incident-pause",
    snapshot.lenderDrawPaused || snapshot.borrowerDrawPaused
      ? "Paused"
      : "Clear",
  );
  element("facility-link").href = explorerAddress(snapshot.address);
  renderPolicies(snapshot);
  renderObservations(snapshot);
  renderJobs(snapshot);
  element("loading").hidden = true;
  element("horizon-dashboard").hidden = false;
  setText("network-label", "CC3 live");
  element("network-status").className = "network-status connected";
  setText(
    "refresh-readout",
    `Last one-block read · ${new Date().toLocaleTimeString()}`,
  );
}

async function selectFacility(address) {
  state.selected = address;
  renderFacilityPills();
  await refresh();
}

async function refresh() {
  setText("network-label", "Reading CC3");
  element("network-status").className = "network-status";
  const preferredFacility = state.selected;
  return runLatestRefresh(
    async () => {
      const blockNumber = await provider.getBlockNumber();
      const { block, value } = await readAtStableBlock(
        provider,
        blockNumber,
        async (blockTag) => {
          const catalog = await discoverFacilities(blockTag);
          const facilities = catalog.supported.map(({ address }) => address);
          const selected = facilities.includes(preferredFacility)
            ? preferredFacility
            : (facilities[0] ?? null);
          if (!selected) {
            throw new Error(
              "The deployed factory has no facility compatible with the configured Horizon 1 kernel and credit state.",
            );
          }
          const snapshot = await readFacility(selected, blockTag);
          return { catalog, facilities, selected, snapshot };
        },
      );
      return { block, ...value };
    },
    {
      success: ({ block, catalog, facilities, selected, snapshot }) => {
        state.facilities = facilities;
        state.unsupportedFacilities = catalog.unsupported.length;
        state.selected = selected;
        renderFacilityPills();
        renderSnapshot(snapshot, block);
        element("retry-button").hidden = true;
      },
      failure: (error) => {
        element("loading").hidden = false;
        element("horizon-dashboard").hidden = true;
        setText(
          "loading-detail",
          error instanceof Error ? error.message : String(error),
        );
        setText("network-label", "Read failed");
        element("network-status").className = "network-status failed";
        element("retry-button").hidden = false;
      },
    },
  );
}

if (typeof document !== "undefined") {
  element("retry-button").addEventListener("click", refresh);
  const runAutomaticRefresh = createCompletionPollingLoop(
    refresh,
    (next, delay) => {
      state.timer = window.setTimeout(next, delay);
    },
    CONFIG.refreshMs,
  );
  runAutomaticRefresh();
}
