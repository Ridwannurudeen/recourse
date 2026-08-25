const CONFIG = Object.freeze({
  rpcUrl: "https://rpc.cc3-testnet.creditcoin.network",
  chainId: 102031,
  ethereumExplorer: "https://etherscan.io",
  deployments: Object.freeze({
    facility: "0x144048E22e822269814D592aeaC34734c603dCA7",
    adjudicator: "0x6abB74F57c99986Ff205d4EF396Dd6d61d2659eB",
    outflowCovenant: "0x873C1344B850bB80c758E191D1DCA31CE86030Ef",
    newBorrowCovenant: "0x5f1DCF18622663a046a55Ad86c61dd339E1e5dE4",
    lpLockCovenant: "0x2826913E2917d905F7658AAa81288f3C4b98A53d",
    deploymentBlock: 5371433,
    explorer: "https://creditcoin-testnet.blockscout.com",
  }),
  facilityMetadata: Object.freeze({
    1: Object.freeze({
      covenantId: 1,
      kind: "Cumulative outflow cap",
      chainKey: 3,
      token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      tokenSymbol: "USDC",
      tokenDecimals: 6,
      treasury: "0xbaa67174531f0c031f91a373f6788c7e821af2c5",
      startSourceBlock: 25826525,
      endSourceBlock: 25826559,
      capBaseUnits: 232545000n,
      provenance: "Checked-in public evidence snapshot",
      txs: Object.freeze([
        Object.freeze({
          hash: "0xa44c5e3f40201583bfa3329b8b4da1851c34f4dbabcc723743c4ca82e2f5dcaa",
          block: 25826525,
          valueBaseUnits: 8580000n,
          to: "0xEE00968C140c6Fd48C7748b87A60Ba48e976A68C",
        }),
        Object.freeze({
          hash: "0x2456f121b5402fb3cd42ea45714f4072965b6ef1b85a05f0e3a67e78c13b0d8b",
          block: 25826526,
          valueBaseUnits: 31240000n,
          to: "0xc9581C8106465D283e4B32E434Dd8EeF71C9770e",
        }),
        Object.freeze({
          hash: "0x1c9a4bf94a28bd8b7da9e676e2259b05a0cce7815c757b1fa77ef8588218addc",
          block: 25826544,
          valueBaseUnits: 190300000n,
          to: "0x9FBB4956cd9e741a841A79EbdeA46DE615c6c933",
        }),
        Object.freeze({
          hash: "0xbddccb82e91cf16def50c3bad6003b4b6e7e68f8d2c35541d0890bdcc117fdc9",
          block: 25826548,
          valueBaseUnits: 14580000n,
          to: "0xa7c34B3F8b904BA1eFDa1C036a7B9be3d7237FC5",
        }),
        Object.freeze({
          hash: "0xb22894683c336ffd74ad115b705babd9e60bb1df40444f160eb6248067855465",
          block: 25826559,
          valueBaseUnits: 30090000n,
          to: "0xc4F4e32062D88375c027b8E252B597edA46dCb3F",
        }),
      ]),
    }),
    2: Object.freeze({
      covenantId: 1,
      kind: "Cumulative outflow cap",
      chainKey: 3,
      token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      tokenSymbol: "USDC",
      tokenDecimals: 6,
      treasury: "0x000000000004444c5dc75cb358380d2e3de08a90",
      startSourceBlock: 25832534,
      endSourceBlock: 25833134,
      capBaseUnits: 100000000n,
      provenance: "Checked-in autonomous watcher configuration",
      txs: Object.freeze([]),
    }),
  }),
});

const CC3_NETWORK = Object.freeze({
  chainId: `0x${CONFIG.chainId.toString(16)}`,
  chainName: "Creditcoin Testnet",
  nativeCurrency: Object.freeze({
    name: "Test Creditcoin",
    symbol: "tCTC",
    decimals: 18,
  }),
  rpcUrls: Object.freeze([CONFIG.rpcUrl]),
  blockExplorerUrls: Object.freeze([CONFIG.deployments.explorer]),
});

const FACILITY_ABI = [
  "function lenderClaimable(uint256) view returns (uint256)",
  "function borrowerClaimable(uint256) view returns (uint256)",
  "function facilityOf(uint256) view returns (tuple(address lender,address borrower,uint256 facilityLimit,uint256 bondRequired,uint16 drawFeeBps,uint64 maturityBlock,uint32 drawDelayBlocks,uint8 state,uint256 lenderFunded,uint256 bondPosted,uint256 drawnPrincipal,uint256 outstandingDebt,uint256 pendingDrawAmount,uint256 drawReadyAtBlock))",
  "function availableCredit(uint256) view returns (uint256)",
  "event FacilityOpened(uint256 indexed facilityId,address indexed lender,address indexed borrower)",
  "event Breached(uint256 indexed facilityId,address indexed hunter,uint256 debtReduction,uint256 hunterReward)",
];
const COVENANT_ABI = [
  "function accumulated(uint256) view returns (uint256)",
  "function configHash(uint256) view returns (bytes32)",
];
const ADJUDICATOR_ABI = [
  "function covenantSetCommitment(uint256) view returns (bytes32)",
  "event CovenantRegistered(uint256 indexed facilityId,uint256 indexed covenantId,address indexed covenant)",
  "event EvidenceAccepted(uint256 indexed facilityId,uint256 indexed covenantId,bytes32 indexed queryId,address submitter)",
  "event BreachReported(uint256 indexed facilityId,uint256 indexed covenantId,address indexed submitter)",
];
const STATE_NAMES = [
  "Created",
  "Active",
  "Repaid",
  "Breached",
  "Defaulted",
  "Cancelled",
];
const STATE_SUMMARIES = Object.freeze({
  Created:
    "The facility is awaiting lender funding, the borrower bond, or activation.",
  Active:
    "Credit remains drawable until a valid proof establishes a registered covenant breach.",
  Repaid: "The borrower repaid the facility and the credit position is closed.",
  Breached:
    "Credit froze when verified source-chain evidence satisfied a registered covenant.",
  Defaulted: "The facility matured with outstanding debt and entered default.",
  Cancelled: "The facility was cancelled before activation.",
});

const byId = (id) => document.getElementById(id);
const formatInteger = (value) => new Intl.NumberFormat("en-US").format(value);

function formatUnits(
  value,
  decimals,
  minimumFractionDigits = 0,
  maximumFractionDigits = 3,
) {
  const decimal = ethers.formatUnits(value, decimals);
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits,
    maximumFractionDigits,
  }).format(Number(decimal));
}

function setAmount(
  element,
  value,
  decimals,
  symbol,
  minimumFractionDigits = 0,
  maximumFractionDigits = 3,
) {
  const unit = document.createElement("span");
  unit.className = "unit";
  unit.textContent = ` ${symbol}`;
  element.replaceChildren(
    document.createTextNode(
      formatUnits(
        value,
        decimals,
        minimumFractionDigits,
        maximumFractionDigits,
      ),
    ),
    unit,
  );
}

function truncateHex(value, leading = 8, trailing = 6) {
  return `${value.slice(0, leading)}…${value.slice(-trailing)}`;
}

function walletLabel(account) {
  return account ? truncateHex(account, 7, 5) : "Connect wallet";
}

function setWalletButton(account, chainId) {
  const button = byId("wallet-button");
  button.className = "wallet-button";
  if (!window.ethereum) {
    button.textContent = "Wallet unavailable";
    button.disabled = true;
    button.title = "Install an injected EVM wallet to sign transactions.";
    return;
  }
  button.disabled = false;
  if (!account) {
    button.textContent = "Connect wallet";
    button.title = "Connect an injected wallet";
    return;
  }
  if (chainId?.toLowerCase() !== CC3_NETWORK.chainId) {
    button.classList.add("wrong-network");
    button.textContent = "Switch to CC3";
    button.title = `${walletLabel(account)} connected on the wrong network`;
    return;
  }
  button.classList.add("connected");
  button.textContent = walletLabel(account);
  button.title = `Connected account ${account}`;
}

async function currentWalletState() {
  if (!window.ethereum) return { account: null, chainId: null };
  const [accounts, chainId] = await Promise.all([
    window.ethereum.request({ method: "eth_accounts" }),
    window.ethereum.request({ method: "eth_chainId" }),
  ]);
  return { account: accounts[0] ?? null, chainId };
}

async function switchToCc3() {
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CC3_NETWORK.chainId }],
    });
  } catch (error) {
    if (error.code !== 4902) throw error;
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [CC3_NETWORK],
    });
  }
}

async function connectWallet() {
  if (!window.ethereum) return;
  const button = byId("wallet-button");
  button.disabled = true;
  button.textContent = "Check wallet";
  try {
    let { account, chainId } = await currentWalletState();
    if (!account) {
      const accounts = await window.ethereum.request({
        method: "eth_requestAccounts",
      });
      account = accounts[0] ?? null;
      chainId = await window.ethereum.request({ method: "eth_chainId" });
    }
    if (account && chainId.toLowerCase() !== CC3_NETWORK.chainId) {
      await switchToCc3();
      chainId = await window.ethereum.request({ method: "eth_chainId" });
    }
    setWalletButton(account, chainId);
  } catch (error) {
    console.error(error);
    const state = await currentWalletState().catch(() => ({
      account: null,
      chainId: null,
    }));
    setWalletButton(state.account, state.chainId);
    if (error.code === 4001) {
      button.title = "Wallet request rejected. No transaction was sent.";
    }
  }
}

async function refreshWalletButton() {
  const { account, chainId } = await currentWalletState();
  setWalletButton(account, chainId);
}

function setExplorerLink(element, value, href, label) {
  element.textContent = truncateHex(value);
  element.href = href;
  element.title = value;
  element.setAttribute("aria-label", `${label}: ${value} (opens explorer)`);
}

function selectedBlockOverride() {
  const raw = new URLSearchParams(window.location.search).get("block");
  if (raw === null) return null;
  if (
    !/^\d+$/.test(raw) ||
    Number(raw) <= 0 ||
    !Number.isSafeInteger(Number(raw))
  ) {
    throw new Error("The block query parameter must be a positive integer.");
  }
  return Number(raw);
}

function selectedFacilityId(availableIds) {
  const raw = new URLSearchParams(window.location.search).get("facility");
  if (raw === null) return availableIds[0];
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error("The facility query parameter must be a positive integer.");
  }
  const facilityId = Number(raw);
  if (!availableIds.includes(facilityId)) {
    throw new Error(`Facility #${facilityId} was not found in the registry.`);
  }
  return facilityId;
}

function selectFacility(facilityId) {
  const url = new URL(window.location.href);
  url.searchParams.set("facility", String(facilityId));
  window.history.replaceState({}, "", url);
  restoreFacilityFocus = true;
  loadDashboard();
}

function readProvider() {
  const connection = new ethers.FetchRequest(CONFIG.rpcUrl);
  connection.timeout = 15000;
  return new ethers.JsonRpcProvider(connection, CONFIG.chainId, {
    staticNetwork: true,
  });
}

async function readFacilityCatalog(provider, facility, blockNumber) {
  const opened = await facility.queryFilter(
    facility.filters.FacilityOpened(),
    CONFIG.deployments.deploymentBlock,
    blockNumber,
  );
  const ids = opened.map((event) => Number(event.args.facilityId));
  const uniqueIds = [...new Set(ids)].sort((left, right) => left - right);
  return Promise.all(
    uniqueIds.map(async (facilityId) => {
      const data = await facility.facilityOf(facilityId, {
        blockTag: blockNumber,
      });
      if (data.lender === ethers.ZeroAddress || data.facilityLimit === 0n) {
        throw new Error(`Facility #${facilityId} returned an invalid record.`);
      }
      return {
        facilityId,
        data,
        stateName: STATE_NAMES[Number(data.state)],
      };
    }),
  );
}

function parseReceiptEvents(receipt, facilityInterface, adjudicatorInterface) {
  let breached;
  let breachReported;
  const accepted = [];

  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() === CONFIG.deployments.facility.toLowerCase()
    ) {
      const parsed = facilityInterface.parseLog(log);
      if (parsed?.name === "Breached") breached = parsed;
    }
    if (
      log.address.toLowerCase() === CONFIG.deployments.adjudicator.toLowerCase()
    ) {
      const parsed = adjudicatorInterface.parseLog(log);
      if (parsed?.name === "EvidenceAccepted") accepted.push(parsed);
      if (parsed?.name === "BreachReported") breachReported = parsed;
    }
  }

  return { breached, breachReported, accepted };
}

async function readSnapshot() {
  const provider = readProvider();
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(CONFIG.chainId)) {
    throw new Error(
      `Expected CC3 chain ${CONFIG.chainId}, received ${network.chainId}.`,
    );
  }

  const requestedBlock = selectedBlockOverride();
  const blockNumber = requestedBlock ?? (await provider.getBlockNumber());
  const readOverrides = { blockTag: blockNumber };
  const facility = new ethers.Contract(
    CONFIG.deployments.facility,
    FACILITY_ABI,
    provider,
  );
  const adjudicator = new ethers.Contract(
    CONFIG.deployments.adjudicator,
    ADJUDICATOR_ABI,
    provider,
  );
  const catalog = await readFacilityCatalog(provider, facility, blockNumber);
  const facilityId = selectedFacilityId(
    catalog.map((entry) => entry.facilityId),
  );
  const facilityData = catalog.find(
    (entry) => entry.facilityId === facilityId,
  ).data;
  const registrations = await adjudicator.queryFilter(
    adjudicator.filters.CovenantRegistered(facilityId),
    CONFIG.deployments.deploymentBlock,
    blockNumber,
  );
  let registration =
    registrations.find(
      (event) =>
        event.args.covenant.toLowerCase() ===
        CONFIG.deployments.outflowCovenant.toLowerCase(),
    ) ??
    registrations[0] ??
    null;
  let covenantId = registration ? Number(registration.args.covenantId) : null;
  let covenantAddress = registration?.args.covenant ?? null;
  let covenant = covenantAddress
    ? new ethers.Contract(covenantAddress, COVENANT_ABI, provider)
    : null;
  let isOutflow =
    covenantAddress?.toLowerCase() ===
    CONFIG.deployments.outflowCovenant.toLowerCase();
  const [availableCredit, lenderClaimable, borrowerClaimable, commitment] =
    await Promise.all([
      facility.availableCredit(facilityId, readOverrides),
      facility.lenderClaimable(facilityId, readOverrides),
      facility.borrowerClaimable(facilityId, readOverrides),
      adjudicator.covenantSetCommitment(facilityId, readOverrides),
    ]);
  let [accumulated, configHash] = await Promise.all([
    isOutflow ? covenant.accumulated(facilityId, readOverrides) : 0n,
    covenant ? covenant.configHash(facilityId, readOverrides) : ethers.ZeroHash,
  ]);

  const stateName = STATE_NAMES[Number(facilityData.state)];
  if (!stateName)
    throw new Error(`Facility returned unknown state ${facilityData.state}.`);

  let breach = null;
  if (stateName === "Breached") {
    const breachEvents = await facility.queryFilter(
      facility.filters.Breached(facilityId),
      CONFIG.deployments.deploymentBlock,
      blockNumber,
    );
    const breachEvent = breachEvents.at(-1);
    if (!breachEvent) {
      throw new Error(
        `Facility #${facilityId} is breached without a breach event.`,
      );
    }
    const breachBlock = breachEvent.blockNumber;
    const breachTx = breachEvent.transactionHash;
    const [receipt, facilityBeforeBreach, facilityAtBreach] = await Promise.all(
      [
        provider.getTransactionReceipt(breachTx),
        facility.facilityOf(facilityId, {
          blockTag: breachBlock - 1,
        }),
        facility.facilityOf(facilityId, {
          blockTag: breachBlock,
        }),
      ],
    );
    if (
      !receipt ||
      receipt.status !== 1 ||
      receipt.blockNumber !== breachBlock ||
      receipt.blockNumber > blockNumber
    ) {
      throw new Error(
        "The recorded breach receipt is not valid at the selected block.",
      );
    }
    const parsed = parseReceiptEvents(
      receipt,
      new ethers.Interface(FACILITY_ABI),
      new ethers.Interface(ADJUDICATOR_ABI),
    );
    const acceptedCovenantIds = new Set(
      parsed.accepted.map((event) => event.args.covenantId.toString()),
    );
    const triggerRegistration = registrations.find(
      (registered) =>
        registered.args.covenantId === parsed.breachReported?.args.covenantId,
    );
    if (
      !parsed.breached ||
      !parsed.breachReported ||
      parsed.breached.args.facilityId !== BigInt(facilityId) ||
      parsed.breachReported.args.facilityId !== BigInt(facilityId) ||
      parsed.accepted.length === 0 ||
      acceptedCovenantIds.size !== 1 ||
      !triggerRegistration ||
      !acceptedCovenantIds.has(
        parsed.breachReported.args.covenantId.toString(),
      ) ||
      parsed.breachReported.args.submitter.toLowerCase() !==
        parsed.breached.args.hunter.toLowerCase() ||
      parsed.accepted.some(
        (event) =>
          event.args.facilityId !== BigInt(facilityId) ||
          event.args.submitter.toLowerCase() !==
            parsed.breached.args.hunter.toLowerCase(),
      ) ||
      STATE_NAMES[Number(facilityBeforeBreach.state)] !== "Active" ||
      STATE_NAMES[Number(facilityAtBreach.state)] !== "Breached" ||
      facilityBeforeBreach.outstandingDebt -
        parsed.breached.args.debtReduction !==
        facilityAtBreach.outstandingDebt
    ) {
      throw new Error(
        "The breach receipt does not match the facility state transition.",
      );
    }
    if (triggerRegistration !== registration) {
      registration = triggerRegistration;
      covenantId = Number(registration.args.covenantId);
      covenantAddress = registration.args.covenant;
      covenant = new ethers.Contract(covenantAddress, COVENANT_ABI, provider);
      isOutflow =
        covenantAddress.toLowerCase() ===
        CONFIG.deployments.outflowCovenant.toLowerCase();
      [accumulated, configHash] = await Promise.all([
        isOutflow ? covenant.accumulated(facilityId, readOverrides) : 0n,
        covenant.configHash(facilityId, readOverrides),
      ]);
    }
    breach = {
      blockNumber: breachBlock,
      transactionHash: breachTx,
      hunter: parsed.breached.args.hunter,
      debtReduction: parsed.breached.args.debtReduction,
      hunterReward: parsed.breached.args.hunterReward,
      debtBefore: facilityBeforeBreach.outstandingDebt,
      debtAfter: facilityAtBreach.outstandingDebt,
      gasUsed: receipt.gasUsed,
      acceptedCount: parsed.accepted.length,
      covenantId,
      accepted: parsed.accepted.map((event) => ({
        queryId: event.args.queryId,
        submitter: event.args.submitter,
      })),
    };
  }

  const metadata = CONFIG.facilityMetadata[facilityId] ?? null;
  let metadataVerified = false;
  if (metadata && isOutflow) {
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint64", "address", "address", "uint64", "uint64", "uint256"],
      [
        metadata.chainKey,
        metadata.token,
        metadata.treasury,
        metadata.startSourceBlock,
        metadata.endSourceBlock,
        metadata.capBaseUnits,
      ],
    );
    metadataVerified = ethers.keccak256(encoded) === configHash;
  }
  if (breach && metadataVerified && metadata.txs.length > 0) {
    const evidenceTotal = metadata.txs.reduce(
      (sum, transaction) => sum + transaction.valueBaseUnits,
      0n,
    );
    if (
      breach.acceptedCount !== metadata.txs.length ||
      evidenceTotal !== accumulated
    ) {
      throw new Error(
        "The checked-in evidence snapshot does not match the live accepted evidence.",
      );
    }
  }

  return {
    catalog,
    facilityId,
    blockNumber,
    historical: requestedBlock !== null,
    facility: facilityData,
    availableCredit,
    accumulated,
    configHash,
    commitment,
    covenantId,
    covenantAddress,
    registrations,
    isOutflow,
    metadata,
    metadataVerified,
    lenderClaimable,
    borrowerClaimable,
    stateName,
    breach,
  };
}

function renderRoles(snapshot) {
  const addressBase = `${CONFIG.deployments.explorer}/address/`;
  setExplorerLink(
    byId("lender-link"),
    snapshot.facility.lender,
    `${addressBase}${snapshot.facility.lender}`,
    "Lender address",
  );
  setExplorerLink(
    byId("borrower-link"),
    snapshot.facility.borrower,
    `${addressBase}${snapshot.facility.borrower}`,
    "Borrower address",
  );

  const hunterRole = byId("hunter-role");
  const hunterLink = byId("hunter-link");
  const hunterOpen = byId("hunter-open");
  if (snapshot.breach) {
    hunterRole.classList.add("breached");
    hunterOpen.hidden = true;
    hunterLink.hidden = false;
    byId("hunter-note").textContent =
      "Claimed by the permissionless proof submitter.";
    setExplorerLink(
      hunterLink,
      snapshot.breach.hunter,
      `${addressBase}${snapshot.breach.hunter}`,
      "Hunter address",
    );
    return;
  }

  hunterRole.classList.remove("breached");
  hunterLink.hidden = true;
  hunterOpen.hidden = false;
  if (snapshot.stateName === "Active") {
    byId("hunter-note").textContent = "Anyone can submit a valid proof.";
    hunterOpen.textContent = "Open role · permissionless";
  } else {
    byId("hunter-note").textContent = "No proof submitter recorded.";
    hunterOpen.textContent = "Not claimed";
  }
}

function renderCredit(snapshot) {
  const facility = snapshot.facility;
  const undrawn = facility.facilityLimit - facility.drawnPrincipal;
  const frozen = snapshot.stateName === "Breached" ? undrawn : 0n;
  const drawnPercent =
    Number((facility.drawnPrincipal * 10000n) / facility.facilityLimit) / 100;
  const availablePercent =
    Number((snapshot.availableCredit * 10000n) / facility.facilityLimit) / 100;
  const frozenPercent =
    Number((frozen * 10000n) / facility.facilityLimit) / 100;

  setAmount(
    byId("available-credit"),
    snapshot.availableCredit,
    18,
    "tCTC",
    0,
    2,
  );
  setAmount(byId("facility-limit"), facility.facilityLimit, 18, "tCTC", 0, 2);
  setAmount(byId("drawn-principal"), facility.drawnPrincipal, 18, "tCTC", 0, 2);
  setAmount(
    byId("outstanding-debt"),
    facility.outstandingDebt,
    18,
    "tCTC",
    0,
    2,
  );
  setAmount(byId("facility-bond"), facility.bondRequired, 18, "tCTC", 0, 2);

  byId("rail-drawn").style.width = `${drawnPercent}%`;
  byId("rail-available").style.width = `${availablePercent}%`;
  byId("rail-frozen").style.width = `${frozenPercent}%`;
  byId("frozen-legend").hidden = frozen === 0n;

  if (snapshot.stateName === "Active") {
    byId("available-context").textContent =
      `${formatUnits(undrawn, 18, 0, 2)} tCTC remains drawable.`;
    byId("credit-note").textContent =
      "Capacity stays open until repayment, maturity, or a proven covenant breach.";
    byId("debt-context").textContent = "principal + draw fee";
    byId("bond-context").textContent =
      `Current bond posted: ${formatUnits(facility.bondPosted, 18, 0, 2)} tCTC`;
    return;
  }

  if (snapshot.breach) {
    byId("available-context").textContent =
      `${formatUnits(undrawn, 18, 0, 2)} tCTC undrawn capacity frozen on breach.`;
    byId("credit-note").textContent =
      "The breach zeroed available credit immediately; drawn principal remains visible.";
    byId("debt-context").textContent =
      `${formatUnits(snapshot.breach.debtBefore, 18, 0, 2)} → ${formatUnits(snapshot.breach.debtAfter, 18, 0, 2)} tCTC at breach`;
    byId("bond-context").textContent =
      `Current bond posted: ${formatUnits(facility.bondPosted, 18, 0, 2)} tCTC`;
    return;
  }

  byId("available-context").textContent =
    `Credit is unavailable while the facility is ${snapshot.stateName.toLowerCase()}.`;
  byId("credit-note").textContent =
    "Available credit is read directly from the facility state machine.";
  byId("debt-context").textContent = "current balance";
  byId("bond-context").textContent =
    `Current bond posted: ${formatUnits(facility.bondPosted, 18, 0, 2)} tCTC`;
}

function renderCovenant(snapshot) {
  const evidence = snapshot.metadataVerified ? snapshot.metadata : null;
  byId("covenant-kind").textContent = snapshot.isOutflow
    ? `Cumulative outflow cap · ${snapshot.registrations.length} registered`
    : snapshot.covenantAddress
      ? `Registered covenant · ${snapshot.registrations.length} in set`
      : "No covenant registered";
  byId("config-hash").textContent = truncateHex(snapshot.configHash, 12, 10);
  byId("config-hash").title = snapshot.configHash;
  byId("covenant-commitment").textContent = truncateHex(
    snapshot.commitment,
    12,
    10,
  );
  byId("covenant-commitment").title = snapshot.commitment;

  if (!evidence) {
    byId("covenant-cap").textContent = "Unavailable";
    byId("accumulated-outflow").textContent = snapshot.isOutflow
      ? formatInteger(snapshot.accumulated)
      : "Not applicable";
    byId("progress-fill").style.width = "0";
    byId("covenant-progress").classList.remove("over-cap");
    byId("covenant-progress").setAttribute("aria-valuenow", "0");
    byId("progress-status").textContent = snapshot.covenantAddress
      ? "The on-chain commitment is readable; the original parameters are not."
      : "No covenant has been registered for this facility.";
    byId("progress-percent").textContent = "Hash-only state";
    byId("covenant-explanation").textContent =
      "Covenant configuration is stored privately and emits no parameter event. Recourse will not infer terms that cannot be verified against the on-chain configuration hash.";
    byId("treasury-link").removeAttribute("href");
    byId("treasury-link").textContent = "Unavailable";
    byId("token-link").removeAttribute("href");
    byId("token-link").textContent = "Unavailable";
    byId("block-window").textContent = "Unavailable";
    byId("covenant-provenance").textContent =
      "Parameters unavailable in this browser. The configuration hash and covenant-set commitment are live CC3 reads.";
    return;
  }

  const cap = evidence.capBaseUnits;
  const percentTimesHundred = (snapshot.accumulated * 10000n) / cap;
  const percent = Number(percentTimesHundred) / 100;
  const clampedPercent = Math.min(percent, 100);
  const overCap = snapshot.accumulated > cap;
  const remaining = overCap
    ? snapshot.accumulated - cap
    : cap - snapshot.accumulated;

  setAmount(
    byId("accumulated-outflow"),
    snapshot.accumulated,
    evidence.tokenDecimals,
    evidence.tokenSymbol,
    2,
    5,
  );
  setAmount(
    byId("covenant-cap"),
    cap,
    evidence.tokenDecimals,
    evidence.tokenSymbol,
    2,
    3,
  );
  byId("progress-fill").style.width = `${clampedPercent}%`;
  byId("covenant-progress").classList.toggle("over-cap", overCap);
  byId("covenant-progress").setAttribute(
    "aria-valuenow",
    String(clampedPercent),
  );
  byId("covenant-progress").setAttribute(
    "aria-valuetext",
    `${percent.toFixed(2)}% of covenant cap`,
  );
  byId("progress-percent").textContent = `${percent.toFixed(2)}% of cap`;

  if (overCap) {
    byId("progress-status").textContent =
      `Threshold crossed by ${formatUnits(remaining, evidence.tokenDecimals, 2, 3)} ${evidence.tokenSymbol}`;
  } else if (snapshot.accumulated === 0n) {
    byId("progress-status").textContent =
      "No proven outflow accumulated on CC3 at this block";
  } else {
    byId("progress-status").textContent =
      `${formatUnits(remaining, evidence.tokenDecimals, 2, 3)} ${evidence.tokenSymbol} remains before the breach line`;
  }

  const largest = evidence.txs.reduce(
    (current, transaction) =>
      transaction.valueBaseUnits > current
        ? transaction.valueBaseUnits
        : current,
    0n,
  );
  byId("covenant-explanation").textContent = snapshot.breach
    ? `The largest individual transfer was ${formatUnits(largest, evidence.tokenDecimals, 2, 3)} ${evidence.tokenSymbol}—below the ${formatUnits(cap, evidence.tokenDecimals, 2, 3)} ${evidence.tokenSymbol} cap. Only the five-transfer total crossed the line.`
    : "Each valid treasury transfer is accumulated independently. No single transaction needs to breach the cap; the covenant evaluates the running total.";

  setExplorerLink(
    byId("treasury-link"),
    evidence.treasury,
    `${CONFIG.ethereumExplorer}/address/${evidence.treasury}`,
    "Committed treasury on Etherscan",
  );
  setExplorerLink(
    byId("token-link"),
    evidence.token,
    `${CONFIG.ethereumExplorer}/token/${evidence.token}`,
    `${evidence.tokenSymbol} token on Etherscan`,
  );
  byId("token-link").textContent =
    `${evidence.tokenSymbol} · ${truncateHex(evidence.token)}`;
  byId("block-window").textContent =
    `${formatInteger(evidence.startSourceBlock)}–${formatInteger(evidence.endSourceBlock)}`;
  byId("covenant-provenance").textContent =
    `${evidence.provenance}; its encoded parameters match the live on-chain configuration hash. Accumulation is read live from CC3.`;
}

function evidenceRow(transaction, index, evidence) {
  const row = document.createElement("article");
  row.className = "evidence-row";

  const number = document.createElement("span");
  number.className = "evidence-index";
  number.textContent = String(index + 1).padStart(2, "0");

  const amount = document.createElement("p");
  amount.className = "evidence-amount";
  const symbol = document.createElement("span");
  symbol.textContent = ` ${evidence.tokenSymbol}`;
  amount.append(
    document.createTextNode(
      formatUnits(transaction.valueBaseUnits, evidence.tokenDecimals, 2, 3),
    ),
    symbol,
  );

  const detail = document.createElement("div");
  detail.className = "evidence-detail";
  const transactionLink = document.createElement("a");
  transactionLink.href = `${CONFIG.ethereumExplorer}/tx/${transaction.hash}`;
  transactionLink.target = "_blank";
  transactionLink.rel = "noopener noreferrer";
  transactionLink.title = transaction.hash;
  transactionLink.textContent = `${truncateHex(transaction.hash, 12, 8)} ↗`;
  transactionLink.setAttribute(
    "aria-label",
    `Ethereum transaction ${transaction.hash}, ${formatUnits(transaction.valueBaseUnits, evidence.tokenDecimals, 2, 3)} ${evidence.tokenSymbol} (opens Etherscan)`,
  );
  const meta = document.createElement("p");
  meta.textContent = `block ${formatInteger(transaction.block)} · to ${truncateHex(transaction.to)}`;
  meta.title = `Recipient ${transaction.to}`;
  detail.append(transactionLink, meta);
  row.append(number, amount, detail);
  return row;
}

function acceptedProofRow(proof, index, snapshot) {
  const row = document.createElement("article");
  row.className = "evidence-row evidence-proof-row";
  const number = document.createElement("span");
  number.className = "evidence-index";
  number.textContent = String(index + 1).padStart(2, "0");
  const label = document.createElement("p");
  label.className = "evidence-amount";
  label.textContent = "Verified";
  const detail = document.createElement("div");
  detail.className = "evidence-detail";
  const transactionLink = document.createElement("a");
  transactionLink.href = `${CONFIG.deployments.explorer}/tx/${snapshot.breach.transactionHash}`;
  transactionLink.target = "_blank";
  transactionLink.rel = "noopener noreferrer";
  transactionLink.textContent = `${truncateHex(proof.queryId, 14, 10)} ↗`;
  transactionLink.title = proof.queryId;
  const meta = document.createElement("p");
  meta.textContent = `query ID · submitted by ${truncateHex(proof.submitter)}`;
  meta.title = `Submitter ${proof.submitter}`;
  detail.append(transactionLink, meta);
  row.append(number, label, detail);
  return row;
}

function renderEvidence(snapshot) {
  const empty = byId("evidence-empty");
  const layout = byId("evidence-layout");
  if (!snapshot.breach) {
    empty.hidden = false;
    layout.hidden = true;
    byId("evidence-count").textContent = "Awaiting a valid proof";
    return;
  }

  empty.hidden = true;
  layout.hidden = false;
  byId("evidence-count").textContent =
    `${snapshot.breach.acceptedCount} receipts accepted`;
  const evidence = snapshot.metadataVerified ? snapshot.metadata : null;
  const transactions = evidence?.txs ?? [];
  const total = transactions.reduce(
    (sum, transaction) => sum + transaction.valueBaseUnits,
    0n,
  );
  if (transactions.length > 0) {
    byId("evidence-column-label").textContent = "Ethereum mainnet receipts";
    byId("evidence-total").textContent =
      `${formatUnits(total, evidence.tokenDecimals, 2, 3)} ${evidence.tokenSymbol}`;
    byId("evidence-list").replaceChildren(
      ...transactions.map((transaction, index) =>
        evidenceRow(transaction, index, evidence),
      ),
    );
  } else {
    byId("evidence-column-label").textContent = "Accepted proof queries";
    byId("evidence-total").textContent =
      `${snapshot.breach.acceptedCount} accepted`;
    byId("evidence-list").replaceChildren(
      ...snapshot.breach.accepted.map((proof, index) =>
        acceptedProofRow(proof, index, snapshot),
      ),
    );
  }

  byId("breach-link").href =
    `${CONFIG.deployments.explorer}/tx/${snapshot.breach.transactionHash}`;
  byId("breach-link").title = snapshot.breach.transactionHash;
  setAmount(
    byId("hunter-payout"),
    snapshot.breach.hunterReward,
    18,
    "tCTC",
    0,
    2,
  );
  setAmount(
    byId("debt-reduction"),
    snapshot.breach.debtReduction,
    18,
    "tCTC",
    0,
    2,
  );
  setAmount(byId("debt-after"), snapshot.breach.debtAfter, 18, "tCTC", 0, 2);
  byId("breach-gas").textContent = formatInteger(snapshot.breach.gasUsed);
  const provenOutflow = evidence
    ? `${formatUnits(snapshot.accumulated, evidence.tokenDecimals, 2, 5)} ${evidence.tokenSymbol} cumulative outflow`
    : `${snapshot.breach.acceptedCount} accepted proof queries`;
  byId("outcome-copy").textContent =
    `${provenOutflow} triggered enforcement. Credit froze, ${formatUnits(snapshot.breach.debtReduction, 18, 0, 2)} tCTC of the bond reduced debt, and the permissionless hunter received ${formatUnits(snapshot.breach.hunterReward, 18, 0, 2)} tCTC.`;
}

function facilityCard(entry, selectedId) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "facility-card";
  button.dataset.selected = String(entry.facilityId === selectedId);
  button.setAttribute("aria-pressed", String(entry.facilityId === selectedId));
  button.addEventListener("click", () => selectFacility(entry.facilityId));

  const heading = document.createElement("span");
  heading.className = "facility-card-heading";
  const name = document.createElement("strong");
  name.textContent = `Facility #${entry.facilityId}`;
  const state = document.createElement("span");
  state.className = `status-badge state-${entry.stateName.toLowerCase()}`;
  state.textContent = entry.stateName;
  heading.append(name, state);

  const metrics = document.createElement("span");
  metrics.className = "facility-card-metrics";
  const limit = document.createElement("span");
  const limitLabel = document.createElement("small");
  limitLabel.textContent = "Limit";
  limit.append(
    limitLabel,
    document.createTextNode(
      `${formatUnits(entry.data.facilityLimit, 18, 0, 2)} tCTC`,
    ),
  );
  const debt = document.createElement("span");
  const debtLabel = document.createElement("small");
  debtLabel.textContent = "Debt";
  debt.append(
    debtLabel,
    document.createTextNode(
      `${formatUnits(entry.data.outstandingDebt, 18, 0, 2)} tCTC`,
    ),
  );
  metrics.append(limit, debt);

  const roles = document.createElement("span");
  roles.className = "facility-card-role";
  roles.textContent = `Borrower ${truncateHex(entry.data.borrower)}`;
  button.append(heading, metrics, roles);
  return button;
}

function renderFacilityBrowser(snapshot) {
  byId("browser-count").textContent =
    `${snapshot.catalog.length} facilities discovered from FacilityOpened events`;
  byId("browser-title").previousElementSibling.textContent = snapshot.historical
    ? "Historical registry"
    : "Live registry";
  byId("facility-list").replaceChildren(
    ...snapshot.catalog.map((entry) =>
      facilityCard(entry, snapshot.facilityId),
    ),
  );
  if (restoreFacilityFocus) {
    byId("facility-list")
      .querySelector('.facility-card[aria-pressed="true"]')
      ?.focus();
    restoreFacilityFocus = false;
  }
}

function renderSnapshot(snapshot) {
  const stateClass = `state-${snapshot.stateName.toLowerCase()}`;
  byId("dashboard").dataset.facilityState = snapshot.stateName;
  const badge = byId("state-badge");
  badge.className = `status-badge ${stateClass}`;
  badge.textContent = snapshot.stateName;
  byId("facility-title").textContent = `Facility #${snapshot.facilityId}`;
  byId("facility-summary").textContent = STATE_SUMMARIES[snapshot.stateName];
  byId("covenant-title").textContent = snapshot.breach
    ? snapshot.isOutflow
      ? "The line a single transfer never crossed"
      : "The registered covenant enforced"
    : snapshot.isOutflow
      ? "Cumulative treasury outflow"
      : "Registered covenant";
  byId("evidence-title").textContent = snapshot.breach
    ? snapshot.isOutflow
      ? "Ethereum evidence. Creditcoin consequence."
      : "Verified evidence. Creditcoin consequence."
    : "Enforcement record";
  byId("snapshot-label").textContent = snapshot.historical
    ? `Creditcoin · historical block ${formatInteger(snapshot.blockNumber)}`
    : `Creditcoin · block ${formatInteger(snapshot.blockNumber)}`;
  byId("block-readout").textContent = snapshot.historical
    ? `Historical snapshot · block ${formatInteger(snapshot.blockNumber)}`
    : `Live snapshot · block ${formatInteger(snapshot.blockNumber)}`;

  const addressBase = `${CONFIG.deployments.explorer}/address/`;
  byId("facility-contract-link").href =
    `${addressBase}${CONFIG.deployments.facility}`;
  byId("facility-contract-link").title = CONFIG.deployments.facility;
  byId("covenant-contract-link").href =
    `${addressBase}${snapshot.covenantAddress ?? CONFIG.deployments.adjudicator}`;
  byId("covenant-contract-link").title =
    snapshot.covenantAddress ?? CONFIG.deployments.adjudicator;

  renderFacilityBrowser(snapshot);
  renderRoles(snapshot);
  renderCredit(snapshot);
  renderCovenant(snapshot);
  renderEvidence(snapshot);
}

function showFailure(error) {
  console.error(error);
  const invalidRequest =
    error.message.startsWith("The block query parameter") ||
    error.message.startsWith("The facility query parameter") ||
    error.message.includes("was not found in the registry");
  byId("dashboard").hidden = true;
  byId("dashboard").dataset.loadState = "error";
  byId("load-panel").hidden = false;
  byId("load-panel").classList.add("error");
  byId("load-title").textContent = "Facility state could not be loaded";
  byId("load-copy").textContent = invalidRequest
    ? error.message
    : "The CC3 RPC did not return a valid facility snapshot. Check the connection and retry.";
  byId("retry-button").hidden = invalidRequest;
  byId("network-status").className = "network-status failed";
  byId("network-label").textContent = invalidRequest
    ? "Invalid snapshot request"
    : "Snapshot unavailable";
}

async function loadDashboard() {
  const requestVersion = ++dashboardRequestVersion;
  byId("retry-button").hidden = true;
  byId("load-panel").classList.remove("error");
  byId("load-title").textContent = "Reading live facility state";
  byId("load-copy").textContent =
    "Verifying the network and loading a consistent CC3 block snapshot.";
  byId("network-status").className = "network-status";
  byId("network-label").textContent = "Connecting to CC3";

  try {
    const snapshot = await readSnapshot();
    if (requestVersion !== dashboardRequestVersion) return;
    renderSnapshot(snapshot);
    byId("load-panel").hidden = true;
    byId("dashboard").hidden = false;
    byId("dashboard").dataset.loadState = "ready";
    byId("network-status").className = "network-status connected";
    byId("network-label").textContent = snapshot.historical
      ? "CC3 historical snapshot"
      : "CC3 connected";
  } catch (error) {
    if (requestVersion !== dashboardRequestVersion) return;
    showFailure(error);
  }
}

const themes = ["auto", "light", "dark"];
let themeIndex = 0;
let dashboardRequestVersion = 0;
let restoreFacilityFocus = false;
byId("theme-toggle").addEventListener("click", () => {
  themeIndex = (themeIndex + 1) % themes.length;
  const theme = themes[themeIndex];
  if (theme === "auto") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.dataset.theme = theme;
  }
  byId("theme-toggle").textContent =
    `Theme · ${theme[0].toUpperCase()}${theme.slice(1)}`;
});
byId("retry-button").addEventListener("click", loadDashboard);
byId("wallet-button").addEventListener("click", connectWallet);

if (window.ethereum?.on) {
  window.ethereum.on("accountsChanged", refreshWalletButton);
  window.ethereum.on("chainChanged", refreshWalletButton);
}

refreshWalletButton().catch(console.error);
loadDashboard();
