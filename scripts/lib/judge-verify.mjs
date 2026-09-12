import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  Interface,
  keccak256,
  parseUnits,
  solidityPackedKeccak256,
} from "ethers";

export const MANIFEST_FILES = [
  "deployments.json",
  "deployments-horizon1.json",
  "deployments-v3-current.json",
  "activation-v3-current.json",
  "allocation-v3-portfolio-current.json",
  "deployments-v3-operator-market-current.json",
  "deployments-v3-operator-service-verifier-current.json",
  "deployments-v3-portfolio-core-current.json",
  "evidence-v1-catches.json",
];

// AttestcoinAdjudicator.sol and INativeQueryVerifier.sol define these tuples.
export const V1_ABI = [
  "function submitBatch(uint256 facilityId,uint256 covenantId,uint64 chainKey,uint64[] heights,bytes[] encodedTransactions,(bytes32 root,(bytes32 hash,bool isLeft)[] siblings)[] merkleProofs,(bytes32 lowerEndpointDigest,bytes32[] roots) sharedContinuityProof)",
  "event EvidenceAccepted(uint256 indexed facilityId,uint256 indexed covenantId,bytes32 indexed queryId,address submitter)",
  "event BreachReported(uint256 indexed facilityId,uint256 indexed covenantId,address indexed submitter)",
  "event Breached(uint256 indexed facilityId,address indexed hunter,uint256 debtReduction,uint256 hunterReward)",
];
const v1 = new Interface(V1_ABI);
const transfer = new Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const PRECOMPILE = "0x0000000000000000000000000000000000000fd2";
const CC3 = "https://rpc.cc3-testnet.creditcoin.network";
const ETH = "https://ethereum-rpc.publicnode.com";
const EXPLORER = "https://creditcoin-testnet.blockscout.com/api/v2";
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
function assert(condition, detail) {
  if (!condition) throw new Error(detail);
}
class TransportError extends Error {
  name = "TransportError";
}

export async function runJudgeVerification({
  repoRoot = process.cwd(),
  cc3Provider,
  ethProvider,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  cc3Rpc = CC3,
  ethRpc = ETH,
  explorer = EXPLORER,
  timeout = 20_000,
} = {}) {
  const checks = [];
  let anchor = null;
  async function bounded(operation) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new TransportError(`Timeout after ${timeout} ms`)),
            timeout,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function http(url, options = {}, json = true) {
    let response;
    try {
      response = await bounded(() =>
        fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeout) }),
      );
    } catch (error) {
      throw new TransportError(error.message);
    }
    if (!response.ok) {
      if (response.status >= 500 || [408, 429].includes(response.status))
        throw new TransportError(`HTTP ${response.status}: ${url}`);
      throw new Error(`HTTP ${response.status}: ${url}`);
    }
    if (!json) return response.status;
    try {
      return await bounded(() => response.json());
    } catch (error) {
      throw new TransportError(`Response body: ${error.message}`);
    }
  }
  function provider(url) {
    return {
      async send(method, params) {
        const body = await http(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        if (body.error)
          throw new TransportError(`RPC ${method}: ${body.error.message}`);
        if (!("result" in body))
          throw new TransportError(`RPC ${method}: missing result`);
        return body.result;
      },
    };
  }
  const cc3 = cc3Provider ?? provider(cc3Rpc);
  const eth = ethProvider ?? provider(ethRpc);
  async function rpcCall(target, method, params) {
    try {
      return await bounded(() => target.send(method, params));
    } catch (error) {
      throw new TransportError(`${method}: ${error.message}`);
    }
  }
  const rpc = (method, params) => rpcCall(cc3, method, params);
  async function ethCall(method, params) {
    try {
      return await rpcCall(eth, method, params);
    } catch (error) {
      if (ethProvider || ethRpc !== ETH) throw error;
      const fallback = await rpcCall(
        provider("https://cloudflare-eth.com/"),
        method,
        params,
      );
      if (fallback === null)
        throw new TransportError(
          `Primary ${ethRpc} failed (${error.message}); fallback https://cloudflare-eth.com/ returned no result for ${method}`,
        );
      return fallback;
    }
  }
  async function check(id, title, source, operation) {
    try {
      const detail = await operation();
      checks.push({ id, title, status: "PASS", detail, source });
      return true;
    } catch (error) {
      checks.push({
        id,
        title,
        status: error.name === "TransportError" ? "UNVERIFIED" : "FAIL",
        detail: error.message,
        source,
      });
      return false;
    }
  }
  let manifests;
  await check(
    "manifests",
    "Committed manifests and CC3 identity",
    `${cc3Rpc}; ${MANIFEST_FILES.join(", ")}`,
    async () => {
      const loaded = Object.fromEntries(
        await Promise.all(
          MANIFEST_FILES.map(async (file) => [
            file.replace(/\.json$/, ""),
            JSON.parse(await readFile(resolve(repoRoot, file), "utf8")),
          ]),
        ),
      );
      for (const [file, manifest] of Object.entries(loaded)) {
        assert(manifest.chainId === 102031, `${file}: expected chainId 102031`);
      }
      const detail = validateManifests(loaded);
      const evidence = loaded["evidence-v1-catches"];
      for (const name of ["cumulativeBatch", "autonomousCatch"]) {
        const record = evidence[name];
        assert(
          record &&
            /^0x[0-9a-f]{64}$/i.test(record.cc3Tx) &&
            record.consequences,
          `Invalid evidence record ${name}`,
        );
        const rows =
          name === "cumulativeBatch" ? record.sources : [record.source];
        assert(
          Array.isArray(rows) &&
            rows.length === (name === "cumulativeBatch" ? 5 : 1) &&
            rows.every((row) => row && /^0x[0-9a-f]{64}$/i.test(row.ethTx)),
          `Invalid Ethereum evidence ${name}`,
        );
      }
      manifests = loaded;
      assert(
        BigInt(await rpc("eth_chainId", [])) === 102031n,
        "CC3 chain ID differs from 102031",
      );
      return detail;
    },
  );
  const cc3Ready = checks.at(-1).status === "PASS";
  const ethReady = await check(
    "ethereum-chain",
    "Ethereum mainnet identity",
    ethRpc,
    async () => {
      assert(
        BigInt(await ethCall("eth_chainId", [])) === 1n,
        "Ethereum chain ID differs from 1",
      );
      return "Ethereum chainId 1";
    },
  );
  await check("finalized-anchor", "Finalized CC3 anchor", cc3Rpc, async () => {
    if (!cc3Ready) throw new TransportError("CC3 identity not established");
    const block = await rpc("eth_getBlockByNumber", ["finalized", false]);
    if (!block) throw new TransportError("Finalized block unavailable");
    assert(
      /^0x[0-9a-f]+$/i.test(block.number) &&
        /^0x[0-9a-f]{64}$/i.test(block.hash),
      "Malformed finalized block",
    );
    anchor = { number: block.number, hash: block.hash };
    return `Finalized block ${Number(BigInt(block.number))}, ${block.hash}`;
  });
  const historicalRpc = (method, params) => {
    if (!cc3Ready) throw new TransportError("CC3 identity not established");
    return rpc(method, params);
  };
  if (manifests) {
    const legacy = manifests.deployments;
    const evidence = manifests["evidence-v1-catches"];
    const receipts = new Map();
    for (const [name, record] of Object.entries({
      cumulativeBatch: evidence.cumulativeBatch,
      autonomousCatch: evidence.autonomousCatch,
    })) {
      const source = `${cc3Rpc}; ${explorer}/transactions/${record.cc3Tx}; historical block ${record.cc3Block}`;
      await check(
        `v1-${name}`,
        `V1 ${name} receipt and credit consequence`,
        source,
        async () => {
          const receipt = await historicalRpc("eth_getTransactionReceipt", [
            record.cc3Tx,
          ]);
          assert(receipt, `Missing receipt ${record.cc3Tx}`);
          assert(
            same(receipt.transactionHash, record.cc3Tx),
            "Receipt transaction hash differs",
          );
          assert(BigInt(receipt.status) === 1n, "Receipt reverted");
          assert(
            same(receipt.to, legacy.adjudicator),
            "Receipt destination differs from adjudicator",
          );
          assert(
            BigInt(receipt.blockNumber) === BigInt(record.cc3Block),
            "Historical block differs",
          );
          assert(
            BigInt(receipt.gasUsed) === BigInt(record.gasUsed),
            `gasUsed differs from ${record.gasUsed}`,
          );
          const events = receipt.logs
            .filter((log) => same(log.address, legacy.facility))
            .map((log) => v1.parseLog(log))
            .filter((log) => log?.name === "Breached");
          assert(
            events.length === 1,
            "Expected exactly one facility Breached event",
          );
          const event = events[0].args;
          assert(
            event.facilityId === BigInt(record.facilityId),
            "Breach facility ID differs",
          );
          assert(
            event.debtReduction ===
              BigInt(record.consequences.debtReductionWei),
            "Breach debt reduction differs",
          );
          assert(
            event.hunterReward === BigInt(record.consequences.hunterRewardWei),
            "Breach hunter reward differs",
          );
          assert(
            same(event.hunter, record.consequences.hunter),
            "Breach hunter differs",
          );
          const adjudications = receipt.logs
            .filter((log) => same(log.address, legacy.adjudicator))
            .map((log) => v1.parseLog(log));
          const reported = adjudications.filter(
            (log) => log?.name === "BreachReported",
          );
          assert(
            reported.length === 1 &&
              reported[0].args.facilityId === BigInt(record.facilityId) &&
              reported[0].args.covenantId ===
                BigInt(record.consequences.covenantId) &&
              same(reported[0].args.submitter, event.hunter),
            "BreachReported binding differs",
          );
          const accepted = adjudications.filter(
            (log) => log?.name === "EvidenceAccepted",
          );
          assert(
            accepted.length === (record.sources?.length ?? 1),
            "EvidenceAccepted count differs",
          );
          assert(
            accepted.every(
              (log) =>
                log.args.facilityId === BigInt(record.facilityId) &&
                log.args.covenantId ===
                  BigInt(record.consequences.covenantId) &&
                same(log.args.submitter, event.hunter),
            ),
            "EvidenceAccepted binding differs",
          );
          receipts.set(name, accepted);
          return `facility ${event.facilityId}; debt reduction ${event.debtReduction} wei; hunter reward ${event.hunterReward} wei`;
        },
      );
      await check(
        `traces-${name}`,
        `V1 ${name} precompile calls`,
        `${explorer}/transactions/${record.cc3Tx}/internal-transactions`,
        async () => {
          let url = `${explorer}/transactions/${record.cc3Tx}/internal-transactions`;
          let count = 0;
          const pages = new Set();
          while (url) {
            assert(!pages.has(url), "Explorer pagination repeated");
            pages.add(url);
            const page = await http(url);
            if (!Array.isArray(page.items))
              throw new TransportError(
                "Explorer internal transactions unavailable",
              );
            count += page.items.filter((item) =>
              same(item.to?.hash ?? item.to, PRECOMPILE),
            ).length;
            url = page.next_page_params
              ? `${explorer}/transactions/${record.cc3Tx}/internal-transactions?${new URLSearchParams(page.next_page_params)}`
              : null;
          }
          assert(
            count === record.precompileCalls,
            `Expected ${record.precompileCalls} precompile calls, observed ${count}`,
          );
          return `${count} calls: one verification and ${count - 1} transaction-index derivations`;
        },
      );
      await check(
        `ethereum-${name}`,
        `V1 ${name} Ethereum source receipts`,
        `${ethRpc}; ${[...(record.sources ?? [record.source])].map((row) => `https://etherscan.io/tx/${row.ethTx} block ${row.ethBlock}`).join("; ")}`,
        async () => {
          if (!ethReady)
            throw new TransportError("Ethereum identity not established");
          const rows = record.sources ?? [record.source];
          const positions = new Set();
          const queryIds = [];
          let total = 0n;
          let max = 0n;
          for (const row of rows) {
            const receipt = await ethCall("eth_getTransactionReceipt", [
              row.ethTx,
            ]);
            assert(receipt, `Missing Ethereum receipt ${row.ethTx}`);
            assert(
              same(receipt.transactionHash, row.ethTx),
              "Ethereum receipt transaction hash differs",
            );
            assert(
              BigInt(receipt.status) === 1n,
              `Ethereum receipt reverted ${row.ethTx}`,
            );
            assert(
              BigInt(receipt.blockNumber) === BigInt(row.ethBlock),
              `Ethereum block differs ${row.ethTx}`,
            );
            if (row.txIndex !== undefined)
              assert(
                BigInt(receipt.transactionIndex) === BigInt(row.txIndex),
                "Catch transaction index differs from 146",
              );
            const position = `${BigInt(receipt.blockNumber)}:${BigInt(receipt.transactionIndex)}`;
            assert(!positions.has(position), "Duplicate batch source position");
            positions.add(position);
            queryIds.push(
              solidityPackedKeccak256(
                ["uint64", "uint64", "uint64"],
                [3, row.ethBlock, receipt.transactionIndex],
              ),
            );
            let amount = 0n;
            for (const log of receipt.logs) {
              if (
                !same(log.address, evidence.cumulativeBatch.usdc) ||
                log.topics.length !== 3 ||
                !/^0x[0-9a-f]{64}$/i.test(log.data)
              )
                continue;
              const event = transfer.parseLog(log);
              const treasury = row.from ?? record.treasury;
              if (
                event &&
                same(event.args.from, treasury) &&
                !same(event.args.to, treasury)
              )
                amount += event.args.value;
            }
            assert(
              amount === parseUnits(String(row.amountUsdc), 6),
              `USDC treasury outflow differs for ${row.ethTx}: ${amount} base units`,
            );
            total += amount;
            if (amount > max) max = amount;
          }
          if (record.sources) {
            const cap = parseUnits(String(record.capUsdc), 6);
            assert(
              rows.length === 5 &&
                total === 274790000n &&
                cap === 232545000n &&
                max === 190300000n &&
                total > cap &&
                cap > max,
              "Batch sum/cap/maximum inequality differs",
            );
          }
          const accepted = receipts.get(name);
          if (!accepted)
            throw new TransportError(
              "CC3 accepted-evidence receipt was not established",
            );
          assert(
            queryIds.every((qid) =>
              accepted.some((log) => same(log.args.queryId, qid)),
            ),
            "Ethereum source position is not accepted in CC3 receipt",
          );
          return `${rows.length} distinct source positions; treasury outflow ${total} USDC base units; forwarded hops excluded${record.sources ? "; 274.79 > 232.545 > 190.30 USDC" : ""}`;
        },
      );
    }
    await check(
      "batch-shape",
      "Five receipts under one shared continuity proof",
      `${cc3Rpc}; ${evidence.cumulativeBatch.cc3Tx}; contracts/AttestcoinAdjudicator.sol:72`,
      async () => {
        const tx = await historicalRpc("eth_getTransactionByHash", [
          evidence.cumulativeBatch.cc3Tx,
        ]);
        assert(
          tx && same(tx.to, legacy.adjudicator),
          "Missing batch transaction or wrong destination",
        );
        const decoded = v1.parseTransaction({ data: tx.input ?? tx.data });
        assert(
          decoded?.name === "submitBatch",
          "Expected submitBatch calldata",
        );
        const args = decoded.args;
        assert(
          args.facilityId === BigInt(evidence.cumulativeBatch.facilityId) &&
            args.covenantId ===
              BigInt(evidence.cumulativeBatch.consequences.covenantId) &&
            args.chainKey === 3n,
          "Batch facility/covenant/source chain differs",
        );
        assert(
          args.heights.length === 5 &&
            args.encodedTransactions.length === 5 &&
            args.merkleProofs.length === 5,
          "Batch does not contain five receipts/proofs",
        );
        assert(
          args.heights.every(
            (height, i) =>
              height === BigInt(evidence.cumulativeBatch.sources[i].ethBlock),
          ),
          "Batch source heights differ",
        );
        assert(
          args.sharedContinuityProof.roots.length > 0,
          "Shared continuity proof is empty",
        );
        return `Five receipts, five Merkle proofs, one shared continuity proof (${args.sharedContinuityProof.roots.length} roots)`;
      },
    );
    await verifyCurrent({
      manifests,
      anchor: anchor ?? { number: "finalized", hash: null },
      check,
      rpc: (method, params) => {
        if (!anchor)
          throw new TransportError("Finalized CC3 anchor unavailable");
        return historicalRpc(method, params);
      },
    });
    for (const item of inventory(manifests)) {
      await check(
        `badge-${item.name}`,
        `Explorer source badge: ${item.name}`,
        `${explorer}/addresses/${item.address}`,
        async () => {
          const data = await http(`${explorer}/addresses/${item.address}`);
          if (typeof data.is_verified !== "boolean")
            throw new TransportError("Explorer verification flag unavailable");
          const historicallyUnverified = [
            "deployments-horizon1/policyKernel",
            "deployments-horizon1/demonstrationFacility",
            "deployments-horizon1/verifiedCreditState",
          ].includes(item.name);
          assert(
            data.is_verified || historicallyUnverified,
            "README source-verification claim differs: is_verified=false",
          );
          return `is_verified=${data.is_verified}; ${historicallyUnverified ? "historically unverified Horizon 1 contract; current badge observed" : "documented source-verification badge matches"}; explorer metadata, not an audit`;
        },
      );
    }
  }
  await check(
    "npm-sdk",
    "Published SDK metadata",
    "https://registry.npmjs.org/recourse-protocol-sdk/0.1.1",
    async () => {
      const data = await http(
        "https://registry.npmjs.org/recourse-protocol-sdk/0.1.1",
      );
      assert(
        data.name === "recourse-protocol-sdk" &&
          data.version === "0.1.1" &&
          typeof data.dist?.integrity === "string",
        "SDK package/version/integrity metadata differs",
      );
      return `${data.name}@${data.version}; ${data.dist.integrity}`;
    },
  );
  for (const page of ["v3.html", "portfolio.html"]) {
    const url = `https://recourse.gudman.xyz/${page}`;
    await check(
      `site-${page}`,
      `Public observatory: ${page}`,
      url,
      async () => {
        const status = await http(url, {}, false);
        assert(status === 200, `Expected HTTP 200, observed ${status}`);
        return "HTTP 200; availability does not certify page content";
      },
    );
  }
  await check(
    "anchor-recheck",
    "Finalized CC3 anchor hash recheck",
    `${cc3Rpc}; block ${anchor?.number ?? "unavailable"}`,
    async () => {
      if (!anchor) throw new TransportError("Finalized CC3 anchor unavailable");
      const block = await rpc("eth_getBlockByNumber", [anchor.number, false]);
      if (!block)
        throw new TransportError("Anchor block unavailable on recheck");
      assert(
        same(block.hash, anchor.hash),
        "Finalized anchor hash changed during verification",
      );
      return `Unchanged ${anchor.hash}`;
    },
  );
  for (const [id, title, source] of [
    [
      "test-counts",
      "Local test counts",
      "JUDGE.md section 3; README.md Testing",
    ],
    [
      "authorship",
      "Original authorship",
      "Repository history; public chain data cannot establish authorship",
    ],
    [
      "unattended",
      "Unattended operation and absence of human intervention",
      "JUDGE.md section 1; operator records outside public RPC",
    ],
  ])
    checks.push({
      id,
      title,
      status: "UNVERIFIED",
      detail: "A public RPC cannot establish this claim",
      source,
    });
  const summary = { PASS: 0, FAIL: 0, UNVERIFIED: 0 };
  for (const item of checks) summary[item.status]++;
  return {
    checks,
    anchor,
    summary,
    checkedAt: new Date(typeof now === "function" ? now() : now).toISOString(),
  };
}

// Getter and event signatures from contracts/v2 and contracts/v3; no build artifacts.
export const CURRENT_ABI = [
  ...[
    "asset",
    "kernel",
    "lender",
    "borrower",
    "verifier",
    "proofJobs",
    "creditState",
    "context",
    "attestor",
    "mandate",
    "factory",
  ].map((name) => `function ${name}() view returns (address)`),
  ...[
    "facilityLimit",
    "bondRequired",
    "lenderFunded",
    "bondPosted",
    "status",
    "policyCount",
    "totalAllocatedPrincipal",
    "quoteCount",
    "decimals",
  ].map((name) => `function ${name}() view returns (uint256)`),
  "function balanceOf(address) view returns (uint256)",
  "function isFacility(address) view returns (bool)",
  "function policySetCommitment(address) view returns (bytes32)",
  "function configHash(address,uint256) view returns (bytes32)",
  "function policyOf(address,uint256) view returns (address evaluator,bytes32 configHash,bytes manifestBytes)",
  "function getJob(uint256) view returns ((address sponsor,address token,address facility,uint256 policyId,bytes32 requirementsDigest,uint64 expiry,uint64 revealWindowBlocks,uint32 maxSuccessfulProofs,uint32 successfulProofs,uint256 proofReimbursement,uint256 outcomeReward,uint256 commitBond,uint256 escrowRemaining,uint8 rewardOutcomeThreshold,uint8 state))",
  "event PilotFacilityCreated(address indexed facility,uint256 facilityLimit,uint256 bondRequired)",
  "event Activated(bytes32 indexed policySetCommitment)",
  "event LenderFunded(uint256 amount)",
  "event BondPosted(uint256 amount)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event JobCreated(uint256 indexed jobId,address indexed sponsor,address indexed facility,uint256 policyId,bytes32 requirementsDigest,uint256 escrow)",
  "event AllocationFunded(address indexed facility,bytes32 indexed deploymentId,uint256 amount)",
  "event PoolActivated(uint256 assets)",
  "event QuotePosted(uint256 indexed quoteId,address indexed operator,uint8 indexed serviceKind,address intendedSponsor,bytes32 requirementsDigest,uint256 price,uint256 operatorBond,uint64 quoteExpiry,uint64 serviceDuration)",
  "event QuoteAccepted(uint256 indexed quoteId,address indexed sponsor)",
  "event ServiceSettled(uint256 indexed quoteId,bytes32 indexed agreementId,bytes32 indexed deliveryDigest)",
];
const abi = new Interface(CURRENT_ABI);
const coreNames = {
  policyKernel: "PolicyKernelV2",
  policyRegistry: "PolicyRegistryV1",
  cappedPilotFactory: "CappedPilotFactoryV1",
  multiChainEventPolicy: "MultiChainEventPolicyV1",
  proofJobs: "ProofJobsV1",
  verifiedCreditState: "VerifiedCreditStateV1",
};
function equal(actual, expected, label) {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
}

export function inventory(manifests) {
  const entries = [];
  for (const [file, keys] of [
    [
      "deployments",
      [
        "facility",
        "adjudicator",
        "outflowCovenant",
        "newBorrowCovenant",
        "lpLockCovenant",
      ],
    ],
    [
      "deployments-horizon1",
      [
        "demoAsset",
        "policyKernel",
        "facilityFactory",
        "eventHistoryPolicy",
        "proofJobs",
        "demonstrationFacility",
        "verifiedCreditState",
      ],
    ],
  ])
    for (const name of keys)
      entries.push({ name: `${file}/${name}`, address: manifests[file][name] });
  for (const file of [
    "deployments-v3-current",
    "deployments-v3-operator-market-current",
    "deployments-v3-operator-service-verifier-current",
    "deployments-v3-portfolio-core-current",
  ]) {
    for (const [name, address] of Object.entries(manifests[file].contracts))
      entries.push({ name: `${file}/${name}`, address });
  }
  for (const file of [
    "activation-v3-current",
    "allocation-v3-portfolio-current",
  ])
    entries.push({
      name: `${file}/facility`,
      address: manifests[file].facility.address,
    });
  return entries.filter(
    ({ address }, i) =>
      /^0x[\da-f]{40}$/i.test(address) &&
      BigInt(address) !== 0n &&
      address.toLowerCase() !== PRECOMPILE &&
      entries.findIndex(
        (item) => item.address.toLowerCase() === address.toLowerCase(),
      ) === i,
  );
}

export function validateManifests(manifests) {
  for (const [name, manifest] of Object.entries(manifests)) {
    if (name !== "evidence-v1-catches" || manifest.chainId !== undefined)
      equal(manifest.chainId, 102031, `${name} chainId`);
  }
  const core = manifests["deployments-v3-current"];
  const pilot = manifests["activation-v3-current"];
  const allocation = manifests["allocation-v3-portfolio-current"];
  const portfolio = manifests["deployments-v3-portfolio-core-current"];
  for (const [field, deploymentField] of [
    ["cc3Tx", "breachTx"],
    ["cc3Block", "breachBlock"],
    ["gasUsed", "breachGasUsed"],
    ["facilityId", "facilityId"],
  ])
    equal(
      manifests["evidence-v1-catches"].cumulativeBatch?.[field],
      manifests.deployments[deploymentField],
      `V1 evidence ${field}`,
    );
  for (const [manifest, steps] of [
    [
      pilot,
      [
        "createFacility",
        "fundFacility",
        "postBorrowerBond",
        "activateFacility",
        "createProofJob",
      ],
    ],
    [
      allocation,
      [
        "createFacility",
        "deposit",
        "postBorrowerBond",
        "activatePool",
        "allocate",
        "activateFacility",
      ],
    ],
  ]) {
    for (const step of steps) {
      const record = manifest.transactions[step];
      if (
        !record ||
        !/^0x[0-9a-f]{64}$/i.test(record.hash) ||
        !/^0x[0-9a-f]{64}$/i.test(record.blockHash) ||
        !Number.isSafeInteger(record.blockNumber)
      )
        throw new Error(`Invalid historical transaction record: ${step}`);
    }
  }
  for (const [name, address] of Object.entries(core.contracts))
    equal(pilot.core[name], address, `activation core ${name}`);
  equal(pilot.facility.kernel, core.contracts.policyKernel, "pilot kernel");
  equal(pilot.facility.asset, core.asset.address, "pilot asset");
  equal(pilot.proofJob.address, core.contracts.proofJobs, "pilot proof jobs");
  equal(
    allocation.pool.address,
    portfolio.contracts.PortfolioPoolV1,
    "allocation pool",
  );
  equal(
    allocation.facility.lender,
    allocation.pool.address,
    "allocation lender",
  );
  equal(
    portfolio.constructors.CappedPilotFactoryV1.values[2],
    allocation.pool.address,
    "portfolio factory lender",
  );
  equal(
    portfolio.constructors.PortfolioMandateV1.values[0],
    portfolio.contracts.CappedPilotFactoryV1,
    "portfolio mandate factory",
  );
  equal(
    portfolio.constructors.CappedPilotFactoryV1.values[1],
    core.contracts.policyKernel,
    "portfolio kernel",
  );
  equal(
    manifests["deployments-v3-operator-market-current"].constructors
      .OperatorMarketV1.values[1],
    manifests["deployments-v3-operator-service-verifier-current"].contracts
      .OperatorServiceVerifierV1,
    "market verifier",
  );
  equal(inventory(manifests).length, 25, "contract inventory size");
  return "Committed chain IDs and core, activation, portfolio factory/pool, market/verifier references agree; 25 distinct project contracts.";
}

export async function verifyCurrent({ manifests, rpc, anchor, check }) {
  const core = manifests["deployments-v3-current"];
  const pilot = manifests["activation-v3-current"];
  const allocation = manifests["allocation-v3-portfolio-current"];
  const portfolio = manifests["deployments-v3-portfolio-core-current"];
  const market = manifests["deployments-v3-operator-market-current"];
  const verifier =
    manifests["deployments-v3-operator-service-verifier-current"];
  const source = `CC3 finalized block ${anchor.number} (${anchor.hash})`;
  async function read(to, name, args = []) {
    const result = await rpc("eth_call", [
      { to, data: abi.encodeFunctionData(name, args) },
      anchor.number,
    ]);
    return abi.decodeFunctionResult(name, result);
  }
  async function getter(to, name, expected, args = []) {
    const [value] = await read(to, name, args);
    equal(value, expected, `${to} ${name}`);
  }
  async function receipt(record, to) {
    const result = await rpc("eth_getTransactionReceipt", [record.hash]);
    if (!result) throw new Error(`Historical receipt absent: ${record.hash}`);
    equal(
      result.transactionHash,
      record.hash,
      "Historical receipt transaction hash",
    );
    equal(BigInt(result.status), 1n, `${record.hash} status`);
    equal(
      BigInt(result.blockNumber),
      record.blockNumber,
      `${record.hash} block`,
    );
    equal(result.blockHash, record.blockHash, `${record.hash} block hash`);
    equal(result.to, to, `${record.hash} destination`);
    return result;
  }
  function event(result, emitter, name, expected) {
    const matches = result.logs.filter(
      (log) =>
        log.address.toLowerCase() === emitter.toLowerCase() &&
        log.topics[0].toLowerCase() ===
          abi.getEvent(name).topicHash.toLowerCase(),
    );
    equal(matches.length, 1, `${result.transactionHash} ${name} event count`);
    const decoded = abi.decodeEventLog(
      name,
      matches[0].data,
      matches[0].topics,
    );
    for (const [key, value] of Object.entries(expected))
      equal(decoded[key], value, `${name}.${key}`);
  }
  await check(
    "5.core",
    "V3 core runtime hashes and wiring",
    source,
    async () => {
      await Promise.all(
        Object.entries(coreNames).map(async ([key, name]) => {
          const code = await rpc("eth_getCode", [
            core.contracts[key],
            anchor.number,
          ]);
          equal(
            keccak256(code),
            core.runtimeCodeHashes[name],
            `${name} runtime hash`,
          );
        }),
      );
      await Promise.all([
        getter(core.contracts.policyKernel, "verifier", PRECOMPILE),
        getter(
          core.contracts.policyKernel,
          "proofJobs",
          core.contracts.proofJobs,
        ),
        getter(
          core.contracts.policyKernel,
          "creditState",
          core.contracts.verifiedCreditState,
        ),
        getter(core.contracts.proofJobs, "kernel", core.contracts.policyKernel),
        getter(
          core.contracts.multiChainEventPolicy,
          "context",
          core.contracts.policyKernel,
        ),
        getter(
          core.contracts.verifiedCreditState,
          "kernel",
          core.contracts.policyKernel,
        ),
      ]);
      return "All six committed runtime hashes and kernel wiring match. A hash match is not an audit.";
    },
  );
  await check(
    "6.pilot",
    "Pilot identity, policy and proof job 1",
    source,
    async () => {
      const f = pilot.facility;
      await Promise.all([
        ...[
          "asset",
          "kernel",
          "lender",
          "borrower",
          "facilityLimit",
          "bondRequired",
        ].map((key) => getter(f.address, key, f[key])),
        getter(core.contracts.cappedPilotFactory, "isFacility", true, [
          f.address,
        ]),
        getter(
          core.contracts.policyKernel,
          "policySetCommitment",
          f.policySetCommitment,
          [f.address],
        ),
        getter(
          pilot.policy.evaluator,
          "configHash",
          pilot.policy.configurationHash,
          [f.address, pilot.policy.policyId],
        ),
      ]);
      const policy = await read(core.contracts.policyKernel, "policyOf", [
        f.address,
        pilot.policy.policyId,
      ]);
      equal(policy.evaluator, pilot.policy.evaluator, "pilot policy evaluator");
      equal(
        policy.configHash,
        pilot.policy.configurationHash,
        "pilot policy configuration",
      );
      const [job] = await read(core.contracts.proofJobs, "getJob", [
        pilot.proofJob.jobId,
      ]);
      for (const [key, expected] of Object.entries({
        sponsor: f.lender,
        token: f.asset,
        facility: f.address,
        policyId: pilot.policy.policyId,
        ...Object.fromEntries(
          [
            "requirementsDigest",
            "expiry",
            "revealWindowBlocks",
            "maxSuccessfulProofs",
            "proofReimbursement",
            "outcomeReward",
            "commitBond",
            "rewardOutcomeThreshold",
          ].map((key) => [key, pilot.proofJob[key]]),
        ),
      }))
        equal(job[key], expected, `proof job ${key}`);
      const [[status], [policies]] = await Promise.all([
        read(f.address, "status"),
        read(f.address, "policyCount"),
      ]);
      return `Identity/configuration match. Current status=${status} (activation ${f.statusCode}), policy count=${policies}, job 1 status=${job.state} (activation ${pilot.proofJob.stateCode}), successful proofs=${job.successfulProofs}, escrow remaining=${job.escrowRemaining} base units. Mutable state is a current observation.`;
    },
  );
  await check(
    "6.history",
    "Pilot creation, activation and original funding",
    `activation-v3-current.json; historical CC3 blocks ${["createFacility", "fundFacility", "postBorrowerBond", "activateFacility", "createProofJob"].map((step) => pilot.transactions[step].blockNumber).join(", ")}`,
    async () => {
      const f = pilot.facility;
      event(
        await receipt(
          pilot.transactions.createFacility,
          core.contracts.cappedPilotFactory,
        ),
        core.contracts.cappedPilotFactory,
        "PilotFacilityCreated",
        {
          facility: f.address,
          facilityLimit: f.facilityLimit,
          bondRequired: f.bondRequired,
        },
      );
      for (const [step, name, amount] of [
        ["fundFacility", "LenderFunded", f.lenderFunded],
        ["postBorrowerBond", "BondPosted", f.bondPosted],
      ])
        event(
          await receipt(pilot.transactions[step], f.address),
          f.address,
          name,
          { amount },
        );
      event(
        await receipt(pilot.transactions.activateFacility, f.address),
        f.address,
        "Activated",
        { policySetCommitment: f.policySetCommitment },
      );
      const funded = await receipt(
        pilot.transactions.createProofJob,
        core.contracts.proofJobs,
      );
      event(funded, core.contracts.proofJobs, "JobCreated", {
        jobId: pilot.proofJob.jobId,
        sponsor: f.lender,
        facility: f.address,
        policyId: pilot.policy.policyId,
        requirementsDigest: pilot.proofJob.requirementsDigest,
        escrow: pilot.proofJob.escrow,
      });
      event(funded, f.asset, "Transfer", {
        from: f.lender,
        to: core.contracts.proofJobs,
        value: pilot.proofJob.escrow,
      });
      return "Historical creation/activation events, 100000 rUSD funding, 20000 rUSD bond and job 1 original 175 rUSD escrow agree with the activation manifest.";
    },
  );
  await check(
    "7.portfolio",
    "Portfolio identity and current accounting",
    source,
    async () => {
      const f = allocation.facility;
      await Promise.all([
        getter(f.address, "asset", core.asset.address),
        getter(f.address, "kernel", core.contracts.policyKernel),
        getter(f.address, "lender", allocation.pool.address),
        getter(f.address, "borrower", f.borrower),
        getter(f.address, "facilityLimit", "100000000000"),
        getter(f.address, "bondRequired", "20000000000"),
        getter(core.asset.address, "decimals", 6),
        getter(portfolio.contracts.CappedPilotFactoryV1, "isFacility", true, [
          f.address,
        ]),
        getter(
          portfolio.contracts.PortfolioMandateV1,
          "factory",
          portfolio.contracts.CappedPilotFactoryV1,
        ),
        getter(
          allocation.pool.address,
          "mandate",
          portfolio.contracts.PortfolioMandateV1,
        ),
      ]);
      const [[funded], [bond], [allocated], [poolBalance], [facilityBalance]] =
        await Promise.all([
          read(f.address, "lenderFunded"),
          read(f.address, "bondPosted"),
          read(allocation.pool.address, "totalAllocatedPrincipal"),
          read(core.asset.address, "balanceOf", [allocation.pool.address]),
          read(core.asset.address, "balanceOf", [f.address]),
        ]);
      if (allocated < BigInt(allocation.pool.totalAllocatedPrincipal))
        throw new Error(
          "Pool totalAllocatedPrincipal is below the historical allocation",
        );
      return `Identity matches. Current base units (6 decimals): lenderFunded=${funded} (historical ${f.lenderFunded}), bondPosted=${bond} (historical ${f.bondPosted}), pool totalAllocatedPrincipal=${allocated} (historical ${allocation.pool.totalAllocatedPrincipal}); pool cash=${poolBalance} (historical ${allocation.pool.assetBalance}), facility cash=${facilityBalance}. Later accounting/balance changes do not falsify historical allocation.`;
    },
  );
  await check(
    "7.history",
    "Portfolio creation, allocation and activation",
    `allocation-v3-portfolio-current.json; historical CC3 blocks ${["createFacility", "deposit", "postBorrowerBond", "activatePool", "allocate", "activateFacility"].map((step) => allocation.transactions[step].blockNumber).join(", ")}`,
    async () => {
      const f = allocation.facility;
      equal(f.lenderFunded, "100000000000", "historical allocation amount");
      equal(f.bondPosted, "20000000000", "historical bond amount");
      event(
        await receipt(
          allocation.transactions.createFacility,
          allocation.pool.address,
        ),
        portfolio.contracts.CappedPilotFactoryV1,
        "PilotFacilityCreated",
        {
          facility: f.address,
          facilityLimit: f.lenderFunded,
          bondRequired: f.bondPosted,
        },
      );
      event(
        await receipt(allocation.transactions.postBorrowerBond, f.address),
        f.address,
        "BondPosted",
        { amount: f.bondPosted },
      );
      event(
        await receipt(
          allocation.transactions.activatePool,
          allocation.pool.address,
        ),
        allocation.pool.address,
        "PoolActivated",
        { assets: allocation.pool.totalDeposited },
      );
      const allocated = await receipt(
        allocation.transactions.allocate,
        allocation.pool.address,
      );
      event(allocated, allocation.pool.address, "AllocationFunded", {
        facility: f.address,
        deploymentId: allocation.registry.deploymentId,
        amount: f.lenderFunded,
      });
      event(allocated, f.address, "LenderFunded", { amount: f.lenderFunded });
      event(
        await receipt(allocation.transactions.activateFacility, f.address),
        f.address,
        "Activated",
        { policySetCommitment: f.policySetCommitment },
      );
      for (const movement of allocation.assetMovement.transfers) {
        const destination =
          movement.step === "postBorrowerBond"
            ? f.address
            : allocation.pool.address;
        event(
          await receipt(allocation.transactions[movement.step], destination),
          core.asset.address,
          "Transfer",
          { from: movement.from, to: movement.to, value: movement.amount },
        );
      }
      return "Historical 100000 rUSD pool deposit/allocation and 20000 rUSD borrower bond, creation and both activations match. Allocated funds left pool cash.";
    },
  );
  await check(
    "8.bindings",
    "Operator market and service verifier bindings",
    source,
    async () => {
      await getter(
        market.contracts.OperatorMarketV1,
        "verifier",
        verifier.contracts.OperatorServiceVerifierV1,
      );
      await getter(
        verifier.contracts.OperatorServiceVerifierV1,
        "attestor",
        verifier.constructors.OperatorServiceVerifierV1.values[0],
      );
      const [quotes] = await read(
        market.contracts.OperatorMarketV1,
        "quoteCount",
      );
      return `Bindings match; current quote count=${quotes}. Quote count alone does not establish absence of agreements.`;
    },
  );
  await check(
    "8.activity",
    "Operator market registration and agreement activity",
    source,
    async () => {
      const logs = await rpc("eth_getLogs", [
        {
          address: market.contracts.OperatorMarketV1,
          fromBlock: `0x${market.transactions.OperatorMarketV1.blockNumber.toString(16)}`,
          toBlock: anchor.number,
        },
      ]);
      const counts = Object.fromEntries(
        ["QuotePosted", "QuoteAccepted", "ServiceSettled"].map((name) => [
          name,
          logs.filter(
            (log) =>
              log.topics[0]?.toLowerCase() ===
              abi.getEvent(name).topicHash.toLowerCase(),
          ).length,
        ]),
      );
      return `Observed since deployment: quote registrations=${counts.QuotePosted}, agreements accepted=${counts.QuoteAccepted}, services settled=${counts.ServiceSettled}; total market logs=${logs.length}. These contracts define no separate operator-registration event.`;
    },
  );
}
