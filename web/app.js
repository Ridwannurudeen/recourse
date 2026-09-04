import { queryLegacyEvents, readFacilityCatalog } from "./app-core.mjs";

const { ethers } = window;

const CONFIG = Object.freeze({
  rpcUrl: "https://rpc.cc3-testnet.creditcoin.network",
  ethereumRpcUrl: "https://ethereum-rpc.publicnode.com",
  proofBuilderUrl: "https://prover.cc3-testnet.creditcoin.network",
  chainId: 102031,
  ethereumExplorer: "https://etherscan.io",
  deployments: Object.freeze({
    facility: "0x144048E22e822269814D592aeaC34734c603dCA7",
    adjudicator: "0x6abB74F57c99986Ff205d4EF396Dd6d61d2659eB",
    outflowCovenant: "0x873C1344B850bB80c758E191D1DCA31CE86030Ef",
    newBorrowCovenant: "0x5f1DCF18622663a046a55Ad86c61dd339E1e5dE4",
    lpLockCovenant: "0x2826913E2917d905F7658AAa81288f3C4b98A53d",
    verifier: "0x0000000000000000000000000000000000000FD2",
    facilityId: 1,
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
  "function openFacility(address lender,address borrower,uint256 facilityLimit,uint256 bondRequired,uint16 drawFeeBps,uint64 maturityBlock,uint32 drawDelayBlocks) returns (uint256)",
  "function fundAsLender(uint256) payable",
  "function postBond(uint256) payable",
  "function activate(uint256,bytes32)",
  "function requestDraw(uint256,uint256)",
  "function executeDraw(uint256)",
  "function repay(uint256) payable",
  "function markDefaulted(uint256)",
  "function cancel(uint256)",
  "function lenderWithdraw(uint256)",
  "function claimBorrowerRefund(uint256)",
  "function lenderClaimable(uint256) view returns (uint256)",
  "function borrowerClaimable(uint256) view returns (uint256)",
  "function facilityOf(uint256) view returns (tuple(address lender,address borrower,uint256 facilityLimit,uint256 bondRequired,uint16 drawFeeBps,uint64 maturityBlock,uint32 drawDelayBlocks,uint8 state,uint256 lenderFunded,uint256 bondPosted,uint256 drawnPrincipal,uint256 outstandingDebt,uint256 pendingDrawAmount,uint256 drawReadyAtBlock))",
  "function availableCredit(uint256) view returns (uint256)",
  "event FacilityOpened(uint256 indexed facilityId,address indexed lender,address indexed borrower)",
  "event Breached(uint256 indexed facilityId,address indexed hunter,uint256 debtReduction,uint256 hunterReward)",
  "error NotBorrower()",
  "error NotLender()",
  "error WrongState(uint8 expected,uint8 actual)",
  "error DrawNotReady(uint256 readyAtBlock)",
  "error MaturityPassed(uint256 maturityBlock)",
  "error CovenantSetMismatch(bytes32 expected,bytes32 actual)",
  "error ExceedsFacility(uint256 requested,uint256 available)",
  "error ZeroAmount()",
  "error TransferFailed()",
];
const COVENANT_ABI = [
  "function configHash(uint256) view returns (bytes32)",
];
const OUTFLOW_COVENANT_ABI = [
  ...COVENANT_ABI,
  "function accumulated(uint256) view returns (uint256)",
  "function configure(uint256,uint64,address,address,uint64,uint64,uint256)",
  "error CovenantAlreadyConfigured()",
  "error CovenantAlreadyRegistered()",
  "error CovenantNotConfigured()",
  "error NotLender()",
  "error WrongState(uint8 expected,uint8 actual)",
];
const NEW_BORROW_COVENANT_ABI = [
  ...COVENANT_ABI,
  "function configure(uint256,uint64,address,address,uint64,uint64)",
  "error CovenantAlreadyConfigured()",
  "error CovenantAlreadyRegistered()",
  "error CovenantNotConfigured()",
  "error NotLender()",
  "error WrongState(uint8 expected,uint8 actual)",
];
const LP_LOCK_COVENANT_ABI = [
  ...COVENANT_ABI,
  "function configure(uint256,uint64,address,uint256,uint64,uint64)",
  "error CovenantAlreadyConfigured()",
  "error CovenantAlreadyRegistered()",
  "error CovenantNotConfigured()",
  "error NotLender()",
  "error WrongState(uint8 expected,uint8 actual)",
];
const ADJUDICATOR_ABI = [
  "function covenantSetCommitment(uint256) view returns (bytes32)",
  "function registerCovenant(uint256,uint256,address)",
  "function submitBatch(uint256,uint256,uint64,uint64[],bytes[],tuple(bytes32 root,tuple(bytes32 hash,bool isLeft)[] siblings)[],tuple(bytes32 lowerEndpointDigest,bytes32[] roots))",
  "event CovenantRegistered(uint256 indexed facilityId,uint256 indexed covenantId,address indexed covenant)",
  "event EvidenceAccepted(uint256 indexed facilityId,uint256 indexed covenantId,bytes32 indexed queryId,address submitter)",
  "event BreachReported(uint256 indexed facilityId,uint256 indexed covenantId,address indexed submitter)",
  "error CovenantAlreadyRegistered()",
  "error NotLender()",
  "error WrongState(uint8 expected,uint8 actual)",
  "error CovenantNotRegistered()",
  "error ProofAlreadyUsed(bytes32 queryId)",
  "error VerificationFailed()",
  "error TransactionReverted()",
  "error IrrelevantEvidence()",
  "error ReentrancyGuardReentrantCall()",
];
const VERIFIER_ABI = [
  "function calculateTxIndex(tuple(bytes32 root,tuple(bytes32 hash,bool isLeft)[] siblings)) view returns (uint64)",
];
const COVENANT_DEFINITIONS = Object.freeze([
  Object.freeze({
    key: "outflow",
    label: "Cumulative outflow cap",
    address: CONFIG.deployments.outflowCovenant,
    abi: OUTFLOW_COVENANT_ABI,
    hashTypes: Object.freeze([
      "uint64",
      "address",
      "address",
      "uint64",
      "uint64",
      "uint256",
    ]),
  }),
  Object.freeze({
    key: "newBorrow",
    label: "New Aave borrowing",
    address: CONFIG.deployments.newBorrowCovenant,
    abi: NEW_BORROW_COVENANT_ABI,
    hashTypes: Object.freeze([
      "uint64",
      "address",
      "address",
      "uint64",
      "uint64",
    ]),
  }),
  Object.freeze({
    key: "lpLock",
    label: "LP liquidity lock",
    address: CONFIG.deployments.lpLockCovenant,
    abi: LP_LOCK_COVENANT_ABI,
    hashTypes: Object.freeze([
      "uint64",
      "address",
      "uint256",
      "uint64",
      "uint64",
    ]),
  }),
]);
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

let walletState = { account: null, chainId: null };
let currentSnapshot = null;
let pendingTransaction = null;
let transactionBusy = false;

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
    walletState = { account, chainId };
    setWalletButton(account, chainId);
    renderActions();
  } catch (error) {
    console.error(error);
    const state = await currentWalletState().catch(() => ({
      account: null,
      chainId: null,
    }));
    walletState = state;
    setWalletButton(state.account, state.chainId);
    renderActions();
    if (error.code === 4001) {
      button.title = "Wallet request rejected. No transaction was sent.";
    }
  }
}

async function refreshWalletButton() {
  walletState = await currentWalletState();
  setWalletButton(walletState.account, walletState.chainId);
  renderActions();
}

async function handleWalletChange() {
  await refreshWalletButton();
  if (!pendingTransaction || transactionBusy) return;
  pendingTransaction = null;
  const status = byId("transaction-dialog-status");
  status.hidden = false;
  status.className = "dialog-status error";
  status.textContent =
    "The connected account or network changed. Close this dialog and review the action again.";
  byId("transaction-confirm").disabled = true;
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

function selectedFacilityId(availableIds = null) {
  const raw = new URLSearchParams(window.location.search).get("facility");
  if (raw !== null && (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))) {
    throw new Error("The facility query parameter must be a positive integer.");
  }
  const facilityId = raw === null ? CONFIG.deployments.facilityId : Number(raw);
  if (availableIds && !availableIds.includes(facilityId)) {
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
  const facilityId = selectedFacilityId();
  const [catalog, registrations, breachEvents] = await Promise.all([
    readFacilityCatalog({
      facility,
      filter: facility.filters.FacilityOpened(),
      deploymentBlock: CONFIG.deployments.deploymentBlock,
      blockNumber,
      stateNames: STATE_NAMES,
      zeroAddress: ethers.ZeroAddress,
    }),
    queryLegacyEvents(
      adjudicator,
      adjudicator.filters.CovenantRegistered(facilityId),
      CONFIG.deployments.deploymentBlock,
      blockNumber,
    ),
    queryLegacyEvents(
      facility,
      facility.filters.Breached(facilityId),
      CONFIG.deployments.deploymentBlock,
      blockNumber,
    ),
  ]);
  selectedFacilityId(catalog.map((entry) => entry.facilityId));
  const facilityData = catalog.find(
    (entry) => entry.facilityId === facilityId,
  ).data;
  const stateName = STATE_NAMES[Number(facilityData.state)];
  if (!stateName)
    throw new Error(`Facility returned unknown state ${facilityData.state}.`);

  const registrationDetails = await Promise.all(
    registrations.map(async (event) => ({
      covenantId: event.args.covenantId,
      address: event.args.covenant,
      configHash: await new ethers.Contract(
        event.args.covenant,
        COVENANT_ABI,
        provider,
      ).configHash(facilityId, readOverrides),
    })),
  );
  const covenantConfigs = await Promise.all(
    COVENANT_DEFINITIONS.map(async (definition) => {
      const definitionConfigHash = await new ethers.Contract(
        definition.address,
        COVENANT_ABI,
        provider,
      ).configHash(facilityId, readOverrides);
      const browserMetadata = readCovenantMetadata(
        facilityId,
        definition,
        definitionConfigHash,
      );
      const checkedInMetadata = checkedInCovenantMetadata(
        facilityId,
        definition,
        definitionConfigHash,
      );
      return {
        ...definition,
        configHash: definitionConfigHash,
        metadata: browserMetadata ?? checkedInMetadata,
        metadataSource: browserMetadata
          ? "this browser"
          : checkedInMetadata
            ? CONFIG.facilityMetadata[facilityId].provenance.toLowerCase()
            : null,
        registered: registrationDetails.some(
          (registration) =>
            registration.address.toLowerCase() ===
            definition.address.toLowerCase(),
        ),
      };
    }),
  );
  let registration =
    registrations.find(
      (event) =>
        event.args.covenant.toLowerCase() ===
        CONFIG.deployments.outflowCovenant.toLowerCase(),
    ) ??
    registrations[0] ??
    null;
  let covenantId = registration?.args.covenantId ?? null;
  let covenantAddress = registration?.args.covenant ?? null;
  let isOutflow =
    covenantAddress?.toLowerCase() ===
    CONFIG.deployments.outflowCovenant.toLowerCase();
  let covenant = covenantAddress
    ? new ethers.Contract(
        covenantAddress,
        isOutflow ? OUTFLOW_COVENANT_ABI : COVENANT_ABI,
        provider,
      )
    : null;
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

  let breach = null;
  if (stateName === "Breached") {
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
      covenantId = registration.args.covenantId;
      covenantAddress = registration.args.covenant;
      isOutflow =
        covenantAddress.toLowerCase() ===
        CONFIG.deployments.outflowCovenant.toLowerCase();
      covenant = new ethers.Contract(
        covenantAddress,
        isOutflow ? OUTFLOW_COVENANT_ABI : COVENANT_ABI,
        provider,
      );
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
    registrationDetails,
    covenantConfigs,
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

function actionField(field) {
  const wrapper = document.createElement("label");
  wrapper.className = "action-field";
  wrapper.htmlFor = field.id;
  const label = document.createElement("span");
  label.textContent = field.label;
  const input = document.createElement(field.multiline ? "textarea" : "input");
  input.id = field.id;
  input.name = field.name;
  if (!field.multiline) input.type = field.type ?? "text";
  input.required = true;
  if (field.multiline) wrapper.classList.add("wide");
  if (field.value !== undefined) input.value = field.value;
  if (field.placeholder) input.placeholder = field.placeholder;
  if (field.min !== undefined) input.min = field.min;
  if (field.max !== undefined) input.max = field.max;
  if (field.step !== undefined) input.step = field.step;
  wrapper.append(label, input);
  return wrapper;
}

function actionCard({
  title,
  role,
  copy,
  fields = [],
  submitLabel,
  loadingLabel = "Preparing review",
  build,
}) {
  const form = document.createElement("form");
  form.className = "action-card";
  const heading = document.createElement("div");
  heading.className = "action-card-heading";
  const titleElement = document.createElement("h3");
  titleElement.textContent = title;
  const roleElement = document.createElement("span");
  roleElement.textContent = role;
  heading.append(titleElement, roleElement);
  const description = document.createElement("p");
  description.textContent = copy;
  const fieldGrid = document.createElement("div");
  fieldGrid.className = "action-fields";
  fieldGrid.append(...fields.map(actionField));
  fieldGrid.hidden = fields.length === 0;
  const error = document.createElement("p");
  error.className = "action-form-error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  const submit = document.createElement("button");
  submit.className = "primary-button";
  submit.type = "submit";
  submit.textContent = submitLabel;
  form.append(heading, description, fieldGrid, error, submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    submit.disabled = true;
    submit.textContent = loadingLabel;
    try {
      reviewTransaction(await build(new FormData(form)));
    } catch (caught) {
      error.textContent = caught.message;
      error.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = submitLabel;
    }
  });
  return form;
}

function parseTctc(value, label) {
  if (!/^\d+(\.\d{1,18})?$/.test(value)) {
    throw new Error(`${label} must be a positive tCTC amount.`);
  }
  const parsed = ethers.parseEther(value);
  if (parsed === 0n) throw new Error(`${label} must be greater than zero.`);
  return parsed;
}

function parseUnsigned(value, label, maximum) {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be a whole number.`);
  }
  const parsed = BigInt(value);
  if (parsed > maximum)
    throw new Error(`${label} is above the contract limit.`);
  return parsed;
}

function parseAddress(value, label) {
  try {
    const address = ethers.getAddress(value);
    if (address === ethers.ZeroAddress) throw new Error();
    return address;
  } catch {
    throw new Error(`${label} must be a nonzero EVM address.`);
  }
}

function covenantMetadataKey(facilityId, covenantAddress) {
  return `recourse:covenant:${CONFIG.chainId}:${facilityId}:${covenantAddress.toLowerCase()}`;
}

function saveCovenantMetadata(facilityId, definition, values) {
  try {
    window.localStorage.setItem(
      covenantMetadataKey(facilityId, definition.address),
      JSON.stringify({ key: definition.key, values: values.map(String) }),
    );
    return true;
  } catch {
    return false;
  }
}

function configuredHash(definition, values) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(definition.hashTypes, values),
  );
}

function readCovenantMetadata(facilityId, definition, liveConfigHash) {
  if (liveConfigHash === ethers.ZeroHash) return null;
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(
        covenantMetadataKey(facilityId, definition.address),
      ),
    );
    if (
      stored?.key !== definition.key ||
      !Array.isArray(stored.values) ||
      stored.values.length !== definition.hashTypes.length ||
      configuredHash(definition, stored.values) !== liveConfigHash
    ) {
      return null;
    }
    return stored.values;
  } catch {
    return null;
  }
}

function checkedInCovenantMetadata(facilityId, definition, liveConfigHash) {
  const metadata = CONFIG.facilityMetadata[facilityId];
  if (!metadata || definition.key !== "outflow") return null;
  const values = [
    metadata.chainKey,
    metadata.token,
    metadata.treasury,
    metadata.startSourceBlock,
    metadata.endSourceBlock,
    metadata.capBaseUnits,
  ];
  return configuredHash(definition, values) === liveConfigHash
    ? values.map(String)
    : null;
}

function transactionDescriptor({
  label,
  summary,
  method,
  args,
  details,
  value,
  gasLimit,
  maturityBlock,
  address = CONFIG.deployments.facility,
  abi = FACILITY_ABI,
  onConfirmed,
}) {
  return {
    label,
    summary,
    method,
    args,
    details,
    value,
    gasLimit,
    maturityBlock,
    onConfirmed,
    reviewedAccount: walletState.account,
    reviewedChainId: walletState.chainId,
    address,
    abi,
  };
}

function openFacilityAction(snapshot) {
  return actionCard({
    title: "Open a facility",
    role: "Lender",
    copy: "Create terms with this connected account as lender. Opening does not transfer principal or configure a covenant.",
    fields: [
      {
        id: "open-borrower",
        name: "borrower",
        label: "Borrower address",
        placeholder: "0x…",
      },
      {
        id: "open-limit",
        name: "limit",
        label: "Facility limit · tCTC",
        type: "number",
        min: "0",
        step: "any",
        value: "1000",
      },
      {
        id: "open-bond",
        name: "bond",
        label: "Required bond · tCTC",
        type: "number",
        min: "0",
        step: "any",
        value: "200",
      },
      {
        id: "open-fee",
        name: "fee",
        label: "Draw fee · basis points",
        type: "number",
        min: "0",
        max: "10000",
        step: "1",
        value: "200",
      },
      {
        id: "open-maturity",
        name: "maturity",
        label: "Maturity · CC3 block",
        type: "number",
        min: String(snapshot.blockNumber),
        step: "1",
        value: String(snapshot.blockNumber + 7200),
      },
      {
        id: "open-delay",
        name: "delay",
        label: "Draw delay · blocks",
        type: "number",
        min: "0",
        step: "1",
        value: "10",
      },
    ],
    submitLabel: "Review facility",
    build: (data) => {
      let borrower;
      try {
        borrower = ethers.getAddress(data.get("borrower"));
      } catch {
        throw new Error("Borrower address must be a valid EVM address.");
      }
      const limit = parseTctc(data.get("limit"), "Facility limit");
      const bond = parseTctc(data.get("bond"), "Required bond");
      const fee = parseUnsigned(data.get("fee"), "Draw fee", 10000n);
      const maturity = parseUnsigned(
        data.get("maturity"),
        "Maturity block",
        (1n << 64n) - 1n,
      );
      const delay = parseUnsigned(
        data.get("delay"),
        "Draw delay",
        (1n << 32n) - 1n,
      );
      if (maturity < BigInt(snapshot.blockNumber)) {
        throw new Error(
          "Maturity cannot be earlier than the current CC3 block.",
        );
      }
      if (maturity <= BigInt(snapshot.blockNumber + 1)) {
        throw new Error(
          "Maturity must leave at least two CC3 blocks for review and confirmation.",
        );
      }
      return transactionDescriptor({
        label: "Open facility",
        summary: `Create a ${formatUnits(limit, 18, 0, 4)} tCTC facility for ${truncateHex(borrower)}. No tCTC is transferred by this transaction.`,
        method: "openFacility",
        args: [
          walletState.account,
          borrower,
          limit,
          bond,
          fee,
          maturity,
          delay,
        ],
        details: [
          ["Lender", walletState.account],
          ["Borrower", borrower],
          ["Limit", `${formatUnits(limit, 18, 0, 4)} tCTC`],
          ["Bond", `${formatUnits(bond, 18, 0, 4)} tCTC`],
          ["Draw fee", `${fee} bps`],
          ["Maturity", `CC3 block ${formatInteger(maturity)}`],
          ["Draw delay", `${formatInteger(delay)} blocks`],
        ],
        maturityBlock: maturity,
      });
    },
  });
}

function valueAction({ title, role, copy, amount, label, method, snapshot }) {
  return actionCard({
    title,
    role,
    copy,
    fields: [
      {
        id: `${method}-amount`,
        name: "amount",
        label: `${label} · tCTC`,
        type: "number",
        min: "0",
        step: "any",
        value: ethers.formatEther(amount),
      },
    ],
    submitLabel: `Review ${title.toLowerCase()}`,
    build: (data) => {
      const value = parseTctc(data.get("amount"), label);
      return transactionDescriptor({
        label: title,
        summary: `${title} with ${formatUnits(value, 18, 0, 6)} tCTC for facility #${snapshot.facilityId}.`,
        method,
        args: [snapshot.facilityId],
        value,
        details: [
          ["Facility", `#${snapshot.facilityId}`],
          [label, `${formatUnits(value, 18, 0, 6)} tCTC`],
        ],
      });
    },
  });
}

function requestDrawAction(snapshot) {
  return actionCard({
    title: "Request draw",
    role: "Borrower",
    copy: `Schedule principal for execution after ${formatInteger(snapshot.facility.drawDelayBlocks)} CC3 blocks. A new request replaces any pending request.`,
    fields: [
      {
        id: "request-draw-amount",
        name: "amount",
        label: "Draw principal · tCTC",
        type: "number",
        min: "0",
        step: "any",
        value: ethers.formatEther(snapshot.availableCredit),
      },
    ],
    submitLabel: "Review draw request",
    build: (data) => {
      const amount = parseTctc(data.get("amount"), "Draw principal");
      return transactionDescriptor({
        label: "Request draw",
        summary: `Request ${formatUnits(amount, 18, 0, 6)} tCTC. It cannot execute until the contract-set delay has elapsed.`,
        method: "requestDraw",
        args: [snapshot.facilityId, amount],
        details: [
          ["Facility", `#${snapshot.facilityId}`],
          ["Principal", `${formatUnits(amount, 18, 0, 6)} tCTC`],
          [
            "Delay",
            `${formatInteger(snapshot.facility.drawDelayBlocks)} blocks`,
          ],
        ],
      });
    },
  });
}

function simpleAction({ title, role, copy, method, snapshot, details = [] }) {
  return actionCard({
    title,
    role,
    copy,
    submitLabel: `Review ${title.toLowerCase()}`,
    build: () =>
      transactionDescriptor({
        label: title,
        summary: `${copy} This transaction targets facility #${snapshot.facilityId}.`,
        method,
        args: [snapshot.facilityId],
        details: [["Facility", `#${snapshot.facilityId}`], ...details],
      }),
  });
}

function activationAction(snapshot) {
  return actionCard({
    title: "Activate facility",
    role: "Borrower",
    copy: "Accept the exact live covenant-set commitment. Activation permanently closes covenant configuration and registration.",
    submitLabel: "Review activation",
    build: () =>
      transactionDescriptor({
        label: "Activate facility",
        summary: `Activate facility #${snapshot.facilityId} with the exact covenant-set commitment shown below.`,
        method: "activate",
        args: [snapshot.facilityId, snapshot.commitment],
        details: [
          ["Facility", `#${snapshot.facilityId}`],
          ["Covenant commitment", snapshot.commitment],
          ["Registered covenants", String(snapshot.registrations.length)],
        ],
      }),
  });
}

function covenantFields(definition) {
  const common = [
    {
      id: `${definition.key}-chain-key`,
      name: "chainKey",
      label: "Source chain key",
      type: "number",
      min: "0",
      step: "1",
      value: "3",
    },
  ];
  if (definition.key === "outflow") {
    return [
      ...common,
      {
        id: "outflow-token",
        name: "token",
        label: "Token address",
        placeholder: "0xâ€¦",
      },
      {
        id: "outflow-treasury",
        name: "treasury",
        label: "Treasury address",
        placeholder: "0xâ€¦",
      },
      {
        id: "outflow-start",
        name: "start",
        label: "Start source block Â· inclusive",
        type: "number",
        min: "0",
        step: "1",
      },
      {
        id: "outflow-end",
        name: "end",
        label: "End source block Â· inclusive",
        type: "number",
        min: "0",
        step: "1",
      },
      {
        id: "outflow-cap",
        name: "cap",
        label: "Cap Â· token base units",
        type: "number",
        min: "1",
        step: "1",
      },
    ];
  }
  if (definition.key === "newBorrow") {
    return [
      ...common,
      {
        id: "borrow-pool",
        name: "pool",
        label: "Aave pool address",
        placeholder: "0xâ€¦",
      },
      {
        id: "borrow-account",
        name: "borrower",
        label: "On-behalf-of borrower",
        placeholder: "0xâ€¦",
      },
      {
        id: "borrow-start",
        name: "start",
        label: "Start source block Â· inclusive",
        type: "number",
        min: "0",
        step: "1",
      },
      {
        id: "borrow-end",
        name: "end",
        label: "End source block Â· inclusive",
        type: "number",
        min: "0",
        step: "1",
      },
    ];
  }
  return [
    ...common,
    {
      id: "lp-manager",
      name: "manager",
      label: "Position manager address",
      placeholder: "0xâ€¦",
    },
    {
      id: "lp-token-id",
      name: "tokenId",
      label: "Position token ID",
      type: "number",
      min: "0",
      step: "1",
    },
    {
      id: "lp-start",
      name: "start",
      label: "Start source block Â· inclusive",
      type: "number",
      min: "0",
      step: "1",
    },
    {
      id: "lp-end",
      name: "end",
      label: "End source block Â· exclusive",
      type: "number",
      min: "1",
      step: "1",
    },
  ];
}

function configureCovenantAction(snapshot, definition) {
  return actionCard({
    title: `Configure ${definition.label}`,
    role: "Lender Â· step 1",
    copy:
      definition.key === "lpLock"
        ? "Fix this predicate's source-chain parameters. The end block is exclusive. Configuration is permanent and must precede registration."
        : "Fix this predicate's source-chain parameters. The block window is inclusive. Configuration is permanent and must precede registration.",
    fields: covenantFields(definition),
    submitLabel: "Review configuration",
    build: (data) => {
      const chainKey = parseUnsigned(
        data.get("chainKey"),
        "Source chain key",
        (1n << 64n) - 1n,
      );
      const start = parseUnsigned(
        data.get("start"),
        "Start source block",
        (1n << 64n) - 1n,
      );
      const end = parseUnsigned(
        data.get("end"),
        "End source block",
        (1n << 64n) - 1n,
      );
      if (definition.key === "lpLock" ? end <= start : end < start) {
        throw new Error(
          definition.key === "lpLock"
            ? "The exclusive end block must be later than the start block."
            : "The end block cannot be earlier than the start block.",
        );
      }
      let values;
      if (definition.key === "outflow") {
        const token = parseAddress(data.get("token"), "Token address");
        const treasury = parseAddress(data.get("treasury"), "Treasury address");
        const cap = parseUnsigned(
          data.get("cap"),
          "Outflow cap",
          (1n << 256n) - 1n,
        );
        if (cap === 0n)
          throw new Error("Outflow cap must be greater than zero.");
        values = [chainKey, token, treasury, start, end, cap];
      } else if (definition.key === "newBorrow") {
        values = [
          chainKey,
          parseAddress(data.get("pool"), "Aave pool address"),
          parseAddress(data.get("borrower"), "Borrower address"),
          start,
          end,
        ];
      } else {
        values = [
          chainKey,
          parseAddress(data.get("manager"), "Position manager address"),
          parseUnsigned(
            data.get("tokenId"),
            "Position token ID",
            (1n << 256n) - 1n,
          ),
          start,
          end,
        ];
      }
      const hash = configuredHash(definition, values);
      return transactionDescriptor({
        label: `Configure ${definition.label}`,
        summary: `Permanently configure ${definition.label} for facility #${snapshot.facilityId}. Registration must happen in a later transaction.`,
        method: "configure",
        args: [snapshot.facilityId, ...values],
        details: [
          ["Facility", `#${snapshot.facilityId}`],
          ["Template", definition.label],
          ["Configuration hash", hash],
          ["Ordering", "Configure before register"],
        ],
        address: definition.address,
        abi: definition.abi,
        onConfirmed: () =>
          saveCovenantMetadata(snapshot.facilityId, definition, values),
      });
    },
  });
}

function registerCovenantAction(snapshot, definition) {
  const usedIds = new Set(
    snapshot.registrationDetails.map((registration) =>
      String(registration.covenantId),
    ),
  );
  let suggestedId = 1n;
  while (usedIds.has(String(suggestedId))) suggestedId += 1n;
  return actionCard({
    title: `Register ${definition.label}`,
    role: "Lender Â· step 2",
    copy: "Append this configured predicate to the ordered covenant set. Its ID, address, configuration hash, and position are bound into the commitment.",
    fields: [
      {
        id: `${definition.key}-covenant-id`,
        name: "covenantId",
        label: "Covenant ID Â· order matters",
        type: "number",
        min: "0",
        step: "1",
        value: String(suggestedId),
      },
    ],
    submitLabel: "Review registration",
    build: (data) => {
      const covenantId = parseUnsigned(
        data.get("covenantId"),
        "Covenant ID",
        (1n << 256n) - 1n,
      );
      if (usedIds.has(String(covenantId))) {
        throw new Error(`Covenant ID ${covenantId} is already registered.`);
      }
      return transactionDescriptor({
        label: `Register ${definition.label}`,
        summary: `Append covenant ID ${covenantId} to facility #${snapshot.facilityId}. This permanently changes the commitment the borrower must accept.`,
        method: "registerCovenant",
        args: [snapshot.facilityId, covenantId, definition.address],
        details: [
          ["Facility", `#${snapshot.facilityId}`],
          ["Covenant ID", String(covenantId)],
          ["Template", definition.label],
          ["Configuration hash", definition.configHash],
          ["Ordering", `Registration ${snapshot.registrations.length + 1}`],
        ],
        address: CONFIG.deployments.adjudicator,
        abi: ADJUDICATOR_ABI,
      });
    },
  });
}

function transactionHashes(value) {
  const hashes = value
    .split(/[\s,]+/)
    .map((hash) => hash.trim())
    .filter(Boolean);
  if (hashes.length === 0 || hashes.length > 10) {
    throw new Error(
      "Provide between 1 and 10 source-chain transaction hashes.",
    );
  }
  if (hashes.some((hash) => !ethers.isHexString(hash, 32))) {
    throw new Error("Every transaction hash must be exactly 32 bytes of hex.");
  }
  const normalized = hashes.map((hash) => hash.toLowerCase());
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("Each transaction hash may appear only once in a batch.");
  }
  return hashes;
}

function assertBytes32(value, label) {
  if (!ethers.isHexString(value, 32)) {
    throw new Error(`The Proof Builder returned an invalid ${label}.`);
  }
}

async function limitedJson(response, maximumBytes) {
  if (!response.body) {
    throw new Error("The Proof Builder returned an empty response.");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error(
        "The Proof Builder response exceeds the 2 MB safety limit.",
      );
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new Error("The Proof Builder returned an unreadable response.");
  }
}

async function fetchProofBatch(chainKey, requestedHashes) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 60000);
  let response;
  try {
    response = await fetch(
      `${CONFIG.proofBuilderUrl}/api/v1/proof-batch-by-tx/${chainKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestedHashes),
        signal: controller.signal,
      },
    );
  } catch (error) {
    window.clearTimeout(timeout);
    throw new Error(
      error.name === "AbortError"
        ? "Proof construction timed out after 60 seconds. The evidence may not be attested yet."
        : "The Proof Builder could not be reached from this browser.",
    );
  }

  let data;
  try {
    data = await limitedJson(response, 2_000_000);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        "Proof construction timed out after 60 seconds. The evidence may not be attested yet.",
      );
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(
      typeof data?.message === "string"
        ? `Proof construction failed: ${data.message}`
        : "Proof construction failed. Confirm the chain key, hashes, and attestation status.",
    );
  }
  const returnedChainKey = parseUnsigned(
    String(data.chainKey),
    "Proof Builder chain key",
    (1n << 64n) - 1n,
  );
  if (
    returnedChainKey !== chainKey ||
    !data.merkleProofs ||
    typeof data.merkleProofs !== "object" ||
    !data.continuityProof ||
    !Array.isArray(data.continuityProof.roots)
  ) {
    throw new Error(
      "The Proof Builder response does not match the expected batch format.",
    );
  }
  assertBytes32(
    data.continuityProof.lowerEndpointDigest,
    "continuity lower endpoint",
  );
  if (data.continuityProof.roots.length === 0) {
    throw new Error("The Proof Builder returned an empty continuity proof.");
  }
  if (data.continuityProof.roots.length > 512) {
    throw new Error("The continuity proof exceeds the 512-root safety limit.");
  }
  data.continuityProof.roots.forEach((root) =>
    assertBytes32(root, "continuity root"),
  );

  const entries = [];
  const blocks = Object.entries(data.merkleProofs)
    .map(([height, proofs]) => ({
      height: parseUnsigned(height, "Proof block height", (1n << 64n) - 1n),
      proofs,
    }))
    .sort((left, right) =>
      left.height < right.height ? -1 : left.height > right.height ? 1 : 0,
    );
  if (blocks.length > requestedHashes.length) {
    throw new Error(
      "The Proof Builder returned more proof blocks than requested.",
    );
  }
  for (const { height, proofs } of blocks) {
    if (!proofs || typeof proofs !== "object") {
      throw new Error("The Proof Builder returned an invalid proof map.");
    }
    const indexedProofs = Object.entries(proofs)
      .map(([index, entry]) => ({
        index: parseUnsigned(
          index,
          "Proof transaction index",
          (1n << 64n) - 1n,
        ),
        entry,
      }))
      .sort((left, right) =>
        left.index < right.index ? -1 : left.index > right.index ? 1 : 0,
      );
    for (const { index, entry } of indexedProofs) {
      if (
        !ethers.isHexString(entry?.txHash, 32) ||
        !ethers.isHexString(entry?.txBytes) ||
        entry.txBytes.length <= 2 ||
        !entry.merkleProof ||
        !Array.isArray(entry.merkleProof.siblings)
      ) {
        throw new Error(
          "The Proof Builder returned malformed transaction proof data.",
        );
      }
      if (entries.length >= requestedHashes.length) {
        throw new Error(
          "The Proof Builder returned more proofs than requested.",
        );
      }
      if (entry.txBytes.length > 524290) {
        throw new Error(
          "A proven transaction exceeds the 256 KB safety limit.",
        );
      }
      if (entry.merkleProof.siblings.length > 64) {
        throw new Error("A Merkle proof exceeds the 64-sibling safety limit.");
      }
      assertBytes32(entry.merkleProof.root, "Merkle root");
      for (const sibling of entry.merkleProof.siblings) {
        assertBytes32(sibling?.hash, "Merkle sibling");
        if (typeof sibling?.isLeft !== "boolean") {
          throw new Error(
            "The Proof Builder returned an invalid Merkle direction.",
          );
        }
      }
      entries.push({ height, index, ...entry });
    }
  }

  const expected = requestedHashes.map((hash) => hash.toLowerCase()).sort();
  const returned = entries.map((entry) => entry.txHash.toLowerCase()).sort();
  if (
    expected.length !== returned.length ||
    returned.some((hash, index) => hash !== expected[index])
  ) {
    throw new Error(
      "The Proof Builder response does not contain exactly the requested transactions.",
    );
  }
  await bindProofEntries(chainKey, entries);
  return {
    heights: entries.map((entry) => entry.height),
    txHashes: entries.map((entry) => entry.txHash),
    txBytes: entries.map((entry) => entry.txBytes),
    merkleProofs: entries.map((entry) => entry.merkleProof),
    continuityProof: data.continuityProof,
  };
}

async function bindProofEntries(chainKey, entries) {
  if (chainKey !== 3n) {
    throw new Error(
      "Browser proof submission currently supports Ethereum mainnet chain key 3 only.",
    );
  }
  const verifier = new ethers.Contract(
    CONFIG.deployments.verifier,
    VERIFIER_ABI,
    readProvider(),
  );
  const sourceProvider = new ethers.JsonRpcProvider(CONFIG.ethereumRpcUrl, 1);
  const [sourceNetwork, derivedIndices] = await Promise.all([
    sourceProvider.getNetwork(),
    Promise.all(
      entries.map((entry) => verifier.calculateTxIndex(entry.merkleProof)),
    ),
  ]);
  if (sourceNetwork.chainId !== 1n) {
    throw new Error("The independent source RPC is not Ethereum mainnet.");
  }
  derivedIndices.forEach((index, position) => {
    if (index !== entries[position].index) {
      throw new Error(
        "A Proof Builder transaction index does not match the CC3 verifier-derived index.",
      );
    }
  });

  const blockHeights = [
    ...new Set(entries.map((entry) => String(entry.height))),
  ];
  const blocks = await Promise.all(
    blockHeights.map(async (height) => [
      height,
      await sourceProvider.send("eth_getBlockByNumber", [
        ethers.toQuantity(height),
        false,
      ]),
    ]),
  );
  const blockByHeight = new Map(blocks);
  for (const entry of entries) {
    if (entry.index > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        "A source transaction index is too large for the browser.",
      );
    }
    const block = blockByHeight.get(String(entry.height));
    const canonicalHash = block?.transactions?.[Number(entry.index)];
    if (
      !ethers.isHexString(block?.hash, 32) ||
      BigInt(block.number) !== entry.height ||
      !ethers.isHexString(canonicalHash, 32) ||
      canonicalHash.toLowerCase() !== entry.txHash.toLowerCase()
    ) {
      throw new Error(
        `Proof evidence at Ethereum block ${entry.height}, index ${entry.index} does not match the canonical source transaction.`,
      );
    }
  }
}

async function proofGasReview(args) {
  const contract = new ethers.Contract(
    CONFIG.deployments.adjudicator,
    ADJUDICATOR_ABI,
    readProvider(),
  );
  try {
    const estimate = await contract.submitBatch.estimateGas(...args, {
      from: walletState.account,
    });
    const gasLimit = estimate + (estimate * 35n) / 100n;
    if (gasLimit > 5_000_000n) {
      throw new Error(
        "This proof exceeds the 5,000,000 gas browser safety limit. Split the evidence into a smaller batch.",
      );
    }
    return { gasLimit, label: `${formatInteger(gasLimit)} Â· estimate + 35%` };
  } catch (error) {
    if (error.message.includes("5,000,000 gas browser safety limit")) {
      throw error;
    }
    return {
      gasLimit: 3_000_000n,
      label: "3,000,000 Â· bounded fallback; CC3 estimation unavailable",
    };
  }
}

function proofBatchAction(snapshot) {
  const firstRegistration = snapshot.registrationDetails[0];
  const firstDefinition = snapshot.covenantConfigs.find(
    (definition) =>
      definition.address.toLowerCase() ===
      firstRegistration.address.toLowerCase(),
  );
  return actionCard({
    title: "Submit evidence batch",
    role: "Hunter Â· permissionless",
    copy: "Build one shared Attestcoin continuity proof for up to 10 source-chain transactions, then review the exact on-chain batch before signing.",
    fields: [
      {
        id: "proof-covenant-id",
        name: "covenantId",
        label: "Registered covenant ID",
        type: "number",
        min: "0",
        step: "1",
        value: String(firstRegistration.covenantId),
      },
      {
        id: "proof-chain-key",
        name: "chainKey",
        label: "Source chain key",
        type: "number",
        min: "0",
        step: "1",
        value: String(firstDefinition?.metadata?.[0] ?? 3),
      },
      {
        id: "proof-transaction-hashes",
        name: "hashes",
        label: "Transaction hashes Â· one per line",
        multiline: true,
        placeholder: "0xâ€¦",
      },
    ],
    submitLabel: "Build proof & review",
    loadingLabel: "Building Attestcoin proof",
    build: async (formData) => {
      const covenantId = parseUnsigned(
        formData.get("covenantId"),
        "Covenant ID",
        (1n << 256n) - 1n,
      );
      if (
        !snapshot.registrationDetails.some(
          (registration) => registration.covenantId === covenantId,
        )
      ) {
        throw new Error("Select a covenant ID registered on this facility.");
      }
      const chainKey = parseUnsigned(
        formData.get("chainKey"),
        "Source chain key",
        (1n << 64n) - 1n,
      );
      const hashes = transactionHashes(formData.get("hashes"));
      const proof = await fetchProofBatch(chainKey, hashes);
      const args = [
        snapshot.facilityId,
        covenantId,
        chainKey,
        proof.heights,
        proof.txBytes,
        proof.merkleProofs,
        proof.continuityProof,
      ];
      const calldata = new ethers.Interface(ADJUDICATOR_ABI).encodeFunctionData(
        "submitBatch",
        args,
      );
      const gas = await proofGasReview(args);
      return transactionDescriptor({
        label: "Submit evidence batch",
        summary: `Submit ${proof.txHashes.length} proven source-chain transaction${proof.txHashes.length === 1 ? "" : "s"} against covenant ${covenantId}. Relevant evidence can immediately breach facility #${snapshot.facilityId}.`,
        method: "submitBatch",
        args,
        details: [
          ["Facility", `#${snapshot.facilityId}`],
          ["Covenant ID", String(covenantId)],
          ["Source chain key", String(chainKey)],
          ["Receipts", String(proof.txHashes.length)],
          ["Continuity roots", String(proof.continuityProof.roots.length)],
          [
            "Exact calldata",
            `${((calldata.length - 2) / 2 / 1024).toFixed(1)} KB`,
          ],
          ...proof.txHashes.map((hash, index) => [
            `Evidence ${index + 1}`,
            `${hash} Â· block ${proof.heights[index]}`,
          ]),
          ["Gas limit", gas.label],
        ],
        gasLimit: gas.gasLimit,
        address: CONFIG.deployments.adjudicator,
        abi: ADJUDICATOR_ABI,
      });
    },
  });
}

function renderCovenantWorkflow(snapshot) {
  const workflow = byId("covenant-workflow");
  if (!workflow) return;
  const configured = snapshot.covenantConfigs.filter(
    (definition) => definition.configHash !== ethers.ZeroHash,
  ).length;
  const configuredAwaitingRegistration = snapshot.covenantConfigs.filter(
    (definition) =>
      definition.configHash !== ethers.ZeroHash && !definition.registered,
  ).length;
  const configuredSetIsRegistered =
    configured > 0 && configuredAwaitingRegistration === 0;
  const stages = [
    {
      number: "01",
      title: "Configure",
      copy: `${configured} of ${snapshot.covenantConfigs.length} deployed templates configured; ${configuredAwaitingRegistration} still awaiting registration. Parameters become immutable.`,
      complete: configuredSetIsRegistered,
    },
    {
      number: "02",
      title: "Register in order",
      copy: `${snapshot.registrations.length} covenant${snapshot.registrations.length === 1 ? "" : "s"} bound into the rolling commitment. Later registrations change it.`,
      complete: snapshot.registrations.length > 0 && configuredSetIsRegistered,
    },
    {
      number: "03",
      title: "Borrower activates",
      copy:
        snapshot.stateName === "Created"
          ? "The borrower must accept the final exact commitment. No configuration or registration is possible afterward."
          : `Facility is ${snapshot.stateName}. The covenant set is closed.`,
      complete: snapshot.stateName !== "Created",
    },
  ];
  const heading = document.createElement("div");
  heading.className = "workflow-heading";
  const title = document.createElement("h3");
  title.textContent = "Covenant-set ceremony";
  const note = document.createElement("p");
  note.textContent = "Contract-enforced order Â· each step is permanent";
  heading.append(title, note);
  const list = document.createElement("ol");
  list.className = "workflow-stages";
  for (const stage of stages) {
    const item = document.createElement("li");
    if (stage.complete) item.classList.add("complete");
    const marker = document.createElement("span");
    marker.textContent = stage.complete ? "Done" : stage.number;
    const content = document.createElement("div");
    const stageTitle = document.createElement("strong");
    stageTitle.textContent = stage.title;
    const copy = document.createElement("p");
    copy.textContent = stage.copy;
    content.append(stageTitle, copy);
    item.append(marker, content);
    list.append(item);
  }
  const templateList = document.createElement("div");
  templateList.className = "workflow-templates";
  for (const definition of snapshot.covenantConfigs) {
    const row = document.createElement("p");
    const name = document.createElement("strong");
    name.textContent = definition.label;
    const state = document.createElement("span");
    if (definition.configHash === ethers.ZeroHash) {
      state.textContent = definition.registered
        ? "Registered without configuration Â· locked and unsafe to activate"
        : "Not configured";
    } else if (definition.metadata) {
      const values = definition.metadata;
      if (definition.key === "outflow") {
        state.textContent = `Chain ${values[0]} Â· token ${truncateHex(values[1])} Â· treasury ${truncateHex(values[2])} Â· blocks ${formatInteger(values[3])}â€“${formatInteger(values[4])} inclusive Â· cap ${formatInteger(values[5])} base units`;
      } else if (definition.key === "newBorrow") {
        state.textContent = `Chain ${values[0]} Â· pool ${truncateHex(values[1])} Â· borrower ${truncateHex(values[2])} Â· blocks ${formatInteger(values[3])}â€“${formatInteger(values[4])} inclusive`;
      } else {
        state.textContent = `Chain ${values[0]} Â· manager ${truncateHex(values[1])} Â· token ID ${formatInteger(values[2])} Â· blocks ${formatInteger(values[3])}â€“${formatInteger(values[4])}, end exclusive`;
      }
      state.textContent += ` Â· parameters verified from ${definition.metadataSource}`;
    } else {
      state.textContent = `Configured${definition.registered ? " and registered" : ""} Â· parameters unavailable; only the on-chain hash is readable`;
    }
    row.append(name, state);
    templateList.append(row);
  }
  workflow.replaceChildren(heading, list, templateList);
}

function connectedRole(snapshot, role) {
  return (
    walletState.account?.toLowerCase() === snapshot.facility[role].toLowerCase()
  );
}

function renderActions() {
  if (!byId("action-list") || !currentSnapshot) return;
  const snapshot = currentSnapshot;
  const list = byId("action-list");
  const notice = byId("action-notice");
  const account = byId("action-account");
  list.replaceChildren();
  notice.className = "action-notice";
  renderCovenantWorkflow(snapshot);

  if (!window.ethereum) {
    account.textContent = "Read-only · no injected wallet detected";
    notice.textContent =
      "Facility state remains available. Install an injected EVM wallet to prepare signed actions.";
    return;
  }
  if (!walletState.account) {
    account.textContent = "Wallet not connected";
    notice.textContent =
      "Connect a wallet to see actions permitted for its lender or borrower role.";
    return;
  }
  if (walletState.chainId?.toLowerCase() !== CC3_NETWORK.chainId) {
    account.textContent = walletLabel(walletState.account);
    notice.classList.add("warning");
    notice.textContent = "Switch the connected wallet to CC3 before signing.";
    return;
  }
  account.textContent = `Connected · ${walletLabel(walletState.account)}`;
  if (snapshot.historical) {
    notice.classList.add("warning");
    notice.textContent =
      "This is a historical snapshot. Return to the latest block before preparing a transaction.";
    return;
  }

  const actions = [openFacilityAction(snapshot)];
  const isLender = connectedRole(snapshot, "lender");
  const isBorrower = connectedRole(snapshot, "borrower");
  const facility = snapshot.facility;

  if (snapshot.stateName === "Created") {
    if (isLender) {
      for (const definition of snapshot.covenantConfigs) {
        if (
          definition.configHash === ethers.ZeroHash &&
          !definition.registered
        ) {
          actions.push(configureCovenantAction(snapshot, definition));
        } else if (!definition.registered) {
          actions.push(registerCovenantAction(snapshot, definition));
        }
      }
    }
    if (isLender && facility.lenderFunded < facility.facilityLimit) {
      actions.push(
        valueAction({
          title: "Fund facility",
          role: "Lender",
          copy: "Deposit lender principal into the facility. Funding can be completed in multiple transactions.",
          amount: facility.facilityLimit - facility.lenderFunded,
          label: "Funding",
          method: "fundAsLender",
          snapshot,
        }),
      );
    }
    if (isBorrower && facility.bondPosted < facility.bondRequired) {
      actions.push(
        valueAction({
          title: "Post bond",
          role: "Borrower",
          copy: "Post the borrower bond. The contract caps deposits at the required bond.",
          amount: facility.bondRequired - facility.bondPosted,
          label: "Bond",
          method: "postBond",
          snapshot,
        }),
      );
    }
    if (
      isBorrower &&
      facility.lenderFunded === facility.facilityLimit &&
      facility.bondPosted === facility.bondRequired &&
      snapshot.registrationDetails.length > 0 &&
      snapshot.registrationDetails.every(
        (registered) => registered.configHash !== ethers.ZeroHash,
      ) &&
      snapshot.covenantConfigs.every(
        (definition) =>
          definition.configHash === ethers.ZeroHash || definition.registered,
      )
    ) {
      actions.push(activationAction(snapshot));
    }
    if (isLender || isBorrower) {
      actions.push(
        simpleAction({
          title: "Cancel facility",
          role: isLender ? "Lender" : "Borrower",
          copy: "Cancel before activation and move posted funding and bond into pull-payment refunds.",
          method: "cancel",
          snapshot,
        }),
      );
    }
  }

  if (snapshot.stateName === "Active") {
    const beforeOrAtMaturity =
      BigInt(snapshot.blockNumber) <= facility.maturityBlock;
    if (snapshot.registrationDetails.length > 0) {
      actions.push(proofBatchAction(snapshot));
    }
    if (isBorrower && snapshot.availableCredit > 0n && beforeOrAtMaturity) {
      actions.push(requestDrawAction(snapshot));
    }
    if (
      isBorrower &&
      facility.pendingDrawAmount > 0n &&
      beforeOrAtMaturity &&
      BigInt(snapshot.blockNumber) >= facility.drawReadyAtBlock
    ) {
      actions.push(
        simpleAction({
          title: "Execute draw",
          role: "Borrower",
          copy: `Transfer the pending ${formatUnits(facility.pendingDrawAmount, 18, 0, 6)} tCTC principal after CC3 block ${formatInteger(facility.drawReadyAtBlock)} and add the draw fee to debt.`,
          method: "executeDraw",
          snapshot,
          details: [
            [
              "Pending principal",
              `${formatUnits(facility.pendingDrawAmount, 18, 0, 6)} tCTC`,
            ],
            [
              "Ready at",
              `CC3 block ${formatInteger(facility.drawReadyAtBlock)}`,
            ],
          ],
        }),
      );
    }
    if (BigInt(snapshot.blockNumber) > facility.maturityBlock) {
      actions.push(
        simpleAction({
          title: "Finalize maturity",
          role: "Permissionless",
          copy: "Move this matured facility to Repaid when debt is zero, or Defaulted while debt remains.",
          method: "markDefaulted",
          snapshot,
        }),
      );
    }
  }

  if (
    isBorrower &&
    facility.outstandingDebt > 0n &&
    ["Active", "Breached", "Defaulted"].includes(snapshot.stateName)
  ) {
    actions.push(
      valueAction({
        title: "Repay debt",
        role: "Borrower",
        copy: "Pay down outstanding debt. Any amount above the live debt is returned by the contract.",
        amount: facility.outstandingDebt,
        label: "Repayment",
        method: "repay",
        snapshot,
      }),
    );
  }

  const terminal = ["Repaid", "Breached", "Defaulted", "Cancelled"].includes(
    snapshot.stateName,
  );
  if (isLender && terminal && snapshot.lenderClaimable > 0n) {
    actions.push(
      simpleAction({
        title: "Withdraw lender claim",
        role: "Lender",
        copy: `Withdraw ${formatUnits(snapshot.lenderClaimable, 18, 0, 6)} tCTC currently claimable by the lender.`,
        method: "lenderWithdraw",
        snapshot,
        details: [
          [
            "Claimable",
            `${formatUnits(snapshot.lenderClaimable, 18, 0, 6)} tCTC`,
          ],
        ],
      }),
    );
  }
  if (isBorrower && snapshot.borrowerClaimable > 0n) {
    actions.push(
      simpleAction({
        title: "Claim borrower refund",
        role: "Borrower",
        copy: `Withdraw ${formatUnits(snapshot.borrowerClaimable, 18, 0, 6)} tCTC currently refundable to the borrower.`,
        method: "claimBorrowerRefund",
        snapshot,
        details: [
          [
            "Refund",
            `${formatUnits(snapshot.borrowerClaimable, 18, 0, 6)} tCTC`,
          ],
        ],
      }),
    );
  }

  list.replaceChildren(...actions);
  const actionSummary =
    actions.length === 1
      ? "This account has no role-specific action on the selected facility. It can still open a new one."
      : `${actions.length - 1} role or state-specific actions available, plus opening a new facility.`;
  const pendingDrawSummary =
    isBorrower &&
    snapshot.stateName === "Active" &&
    facility.pendingDrawAmount > 0n &&
    BigInt(snapshot.blockNumber) <= facility.maturityBlock &&
    BigInt(snapshot.blockNumber) < facility.drawReadyAtBlock
      ? ` Pending draw: ${formatUnits(facility.pendingDrawAmount, 18, 0, 6)} tCTC unlocks at CC3 block ${formatInteger(facility.drawReadyAtBlock)}.`
      : "";
  notice.textContent = `${actionSummary}${pendingDrawSummary}`;
}

function reviewTransaction(descriptor) {
  if (transactionBusy) return;
  pendingTransaction = descriptor;
  byId("transaction-title").textContent = descriptor.label;
  byId("transaction-summary").textContent = descriptor.summary;
  const details = descriptor.details.flatMap(([label, value]) => {
    const wrapper = document.createElement("div");
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value;
    wrapper.append(term, description);
    return wrapper;
  });
  const contract = document.createElement("div");
  const contractLabel = document.createElement("dt");
  contractLabel.textContent = "Contract";
  const contractAddress = document.createElement("dd");
  contractAddress.textContent = truncateHex(descriptor.address, 12, 10);
  contractAddress.title = descriptor.address;
  contract.append(contractLabel, contractAddress);
  byId("transaction-details").replaceChildren(...details, contract);
  byId("transaction-dialog-status").hidden = true;
  byId("transaction-dialog-status").className = "dialog-status";
  byId("transaction-confirm").disabled = false;
  byId("transaction-confirm").textContent = "Confirm in wallet";
  byId("transaction-cancel").hidden = false;
  byId("transaction-cancel").textContent = "Cancel";
  byId("transaction-close").disabled = false;
  byId("transaction-dialog").showModal();
}

async function assertReviewedWallet(descriptor) {
  const state = await currentWalletState();
  if (
    !state.account ||
    state.account.toLowerCase() !== descriptor.reviewedAccount?.toLowerCase() ||
    state.chainId?.toLowerCase() !==
      descriptor.reviewedChainId?.toLowerCase() ||
    state.chainId?.toLowerCase() !== CC3_NETWORK.chainId
  ) {
    const error = new Error("Wallet changed after transaction review.");
    error.code = "REVIEW_INVALIDATED";
    throw error;
  }
  return state;
}

function nestedErrorCode(error) {
  return error?.code ?? error?.info?.error?.code ?? error?.error?.code;
}

function nestedErrorData(error) {
  const candidates = [
    error?.data,
    error?.info?.error?.data,
    error?.error?.data,
    error?.revert?.data,
  ];
  return candidates.find(
    (candidate) => typeof candidate === "string" && candidate.startsWith("0x"),
  );
}

function plainTransactionError(error, descriptor) {
  const code = nestedErrorCode(error);
  if (code === 4001 || code === "ACTION_REJECTED") {
    return "You rejected the wallet request. No transaction was sent.";
  }
  if (code === "REVIEW_INVALIDATED") {
    return "The connected account or network changed after review. Close this dialog and review the action again.";
  }
  if (code === "MATURITY_TOO_CLOSE") {
    return "The proposed maturity is now too close to the current CC3 block. Close this dialog and choose a later block.";
  }
  const data = nestedErrorData(error);
  let parsed = null;
  if (data) {
    try {
      parsed = new ethers.Interface(descriptor.abi).parseError(data);
    } catch {
      parsed = null;
    }
  }
  if (!parsed) {
    return "The contract rejected this action. Its state may have changed; refresh the facility and review the action again.";
  }
  const messages = {
    NotBorrower: "Only this facility's borrower can perform that action.",
    NotLender: "Only this facility's lender can perform that action.",
    ZeroAmount: "The amount must be greater than zero.",
    TransferFailed:
      "The contract could not transfer tCTC to the receiving account.",
    CovenantSetMismatch:
      "The covenant set changed after this review. Refresh and verify the new commitment before activating.",
    CovenantAlreadyConfigured:
      "This covenant template is already configured for the facility. Configuration cannot be replaced.",
    CovenantAlreadyRegistered:
      "That covenant template or covenant ID is already registered for the facility.",
    CovenantNotConfigured:
      "Configure this covenant template before registering it.",
    CovenantNotRegistered:
      "The selected covenant ID is not registered on this facility.",
    VerificationFailed:
      "Attestcoin could not verify this batch against the source-chain attestation.",
    TransactionReverted:
      "At least one proven source-chain transaction reverted, so it cannot be used as evidence.",
    IrrelevantEvidence:
      "None of the proven transactions satisfies the selected covenant predicate.",
    ReentrancyGuardReentrantCall:
      "Another proof submission is already executing in this transaction.",
  };
  if (messages[parsed.name]) return messages[parsed.name];
  if (parsed.name === "WrongState") {
    const expected =
      STATE_NAMES[Number(parsed.args.expected)] ?? "another state";
    const actual =
      STATE_NAMES[Number(parsed.args.actual)] ?? "an unknown state";
    return `This action requires ${expected}, but the facility is ${actual}.`;
  }
  if (parsed.name === "DrawNotReady") {
    return `The draw is not ready. Try again at or after CC3 block ${formatInteger(parsed.args.readyAtBlock)}.`;
  }
  if (parsed.name === "MaturityPassed") {
    return `The facility maturity boundary is CC3 block ${formatInteger(parsed.args.maturityBlock)}.`;
  }
  if (parsed.name === "ExceedsFacility") {
    return `The requested amount exceeds the contract's current allowance of ${formatUnits(parsed.args.available, 18, 0, 6)} tCTC.`;
  }
  if (parsed.name === "ProofAlreadyUsed") {
    return `Evidence query ${truncateHex(parsed.args.queryId, 14, 10)} was already processed for this facility and covenant.`;
  }
  return "The contract rejected this action. Refresh the facility and review its current state.";
}

function openedFacilityId(receipt) {
  const facilityInterface = new ethers.Interface(FACILITY_ABI);
  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() !== CONFIG.deployments.facility.toLowerCase()
    ) {
      continue;
    }
    const parsed = facilityInterface.parseLog(log);
    if (parsed?.name === "FacilityOpened") {
      return Number(parsed.args.facilityId);
    }
  }
  return null;
}

async function confirmTransaction() {
  if (!pendingTransaction || !window.ethereum || transactionBusy) return;
  const descriptor = pendingTransaction;
  const confirm = byId("transaction-confirm");
  const cancel = byId("transaction-cancel");
  const close = byId("transaction-close");
  const status = byId("transaction-dialog-status");
  let transaction = null;
  let metadataSaved = true;
  transactionBusy = true;
  confirm.disabled = true;
  cancel.disabled = true;
  close.disabled = true;
  confirm.textContent = "Checking contract";
  status.hidden = false;
  status.className = "dialog-status pending";
  status.textContent =
    "Running a read-only contract preflight before requesting a signature.";

  try {
    await assertReviewedWallet(descriptor);
    if (descriptor.maturityBlock !== undefined) {
      const latestBlock = await readProvider().getBlockNumber();
      if (descriptor.maturityBlock <= BigInt(latestBlock + 1)) {
        const error = new Error("Maturity is too close to the current block.");
        error.code = "MATURITY_TOO_CLOSE";
        throw error;
      }
    }
    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer = await provider.getSigner(descriptor.reviewedAccount);
    const [signerAddress, network] = await Promise.all([
      signer.getAddress(),
      provider.getNetwork(),
    ]);
    if (
      signerAddress.toLowerCase() !==
        descriptor.reviewedAccount.toLowerCase() ||
      network.chainId !== BigInt(CONFIG.chainId)
    ) {
      const error = new Error("Signer changed after transaction review.");
      error.code = "REVIEW_INVALIDATED";
      throw error;
    }
    const contract = new ethers.Contract(
      descriptor.address,
      descriptor.abi,
      signer,
    );
    const invocation = [...descriptor.args];
    const overrides = {};
    if (descriptor.value !== undefined) overrides.value = descriptor.value;
    if (descriptor.gasLimit !== undefined) {
      overrides.gasLimit = descriptor.gasLimit;
    }
    if (Object.keys(overrides).length > 0) {
      invocation.push(overrides);
    }
    await contract[descriptor.method].staticCall(...invocation);
    await assertReviewedWallet(descriptor);
    confirm.textContent = "Check wallet";
    status.textContent =
      "Preflight passed. Confirm or reject the transaction in your wallet.";
    transaction = await contract[descriptor.method](...invocation);
    confirm.textContent = "Waiting for CC3";
    status.replaceChildren(
      document.createTextNode("Submitted "),
      Object.assign(document.createElement("a"), {
        href: `${CONFIG.deployments.explorer}/tx/${transaction.hash}`,
        target: "_blank",
        rel: "noopener noreferrer",
        textContent: truncateHex(transaction.hash, 14, 10),
      }),
      document.createTextNode(". Waiting for confirmation."),
    );
    const receipt = await transaction.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error("Transaction did not confirm successfully.");
    }
    if (descriptor.onConfirmed) {
      metadataSaved = descriptor.onConfirmed(receipt);
    }
    status.className = "dialog-status success";
    status.replaceChildren(
      document.createTextNode(
        metadataSaved
          ? "Confirmed on CC3. "
          : "Confirmed on CC3. This browser could not retain a local copy of the covenant parameters; the on-chain configuration hash remains authoritative. ",
      ),
      Object.assign(document.createElement("a"), {
        href: `${CONFIG.deployments.explorer}/tx/${transaction.hash}`,
        target: "_blank",
        rel: "noopener noreferrer",
        textContent: "View transaction ↗",
      }),
    );
    confirm.textContent = "Confirmed";
    transactionBusy = false;
    close.disabled = false;
    cancel.disabled = false;
    cancel.textContent = "Close";
    const newFacilityId =
      descriptor.method === "openFacility" ? openedFacilityId(receipt) : null;
    if (newFacilityId !== null) {
      const url = new URL(window.location.href);
      url.searchParams.set("facility", String(newFacilityId));
      url.searchParams.delete("block");
      window.history.replaceState({}, "", url);
    }
    await loadDashboard();
  } catch (error) {
    transactionBusy = false;
    status.className = "dialog-status error";
    if (transaction) {
      status.replaceChildren(
        document.createTextNode(
          "The transaction was submitted, but confirmation could not be verified here. Do not retry it from this dialog. ",
        ),
        Object.assign(document.createElement("a"), {
          href: `${CONFIG.deployments.explorer}/tx/${transaction.hash}`,
          target: "_blank",
          rel: "noopener noreferrer",
          textContent: "Check transaction status ↗",
        }),
      );
      pendingTransaction = null;
      confirm.disabled = true;
      confirm.textContent = "Fresh review required";
      cancel.disabled = false;
      cancel.textContent = "Close";
      close.disabled = false;
      await loadDashboard();
      return;
    }
    status.textContent = plainTransactionError(error, descriptor);
    confirm.disabled = false;
    confirm.textContent = "Try again";
    cancel.disabled = false;
    close.disabled = false;
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
  renderActions();
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
    currentSnapshot = snapshot;
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
byId("transaction-confirm").addEventListener("click", confirmTransaction);
byId("transaction-dialog").addEventListener("close", () => {
  pendingTransaction = null;
  byId("transaction-cancel").disabled = false;
  byId("transaction-close").disabled = false;
});
byId("transaction-dialog").addEventListener("cancel", (event) => {
  if (transactionBusy) event.preventDefault();
});

if (window.ethereum?.on) {
  window.ethereum.on("accountsChanged", () =>
    handleWalletChange().catch(console.error),
  );
  window.ethereum.on("chainChanged", () =>
    handleWalletChange().catch(console.error),
  );
}

refreshWalletButton().catch(console.error);
loadDashboard();
