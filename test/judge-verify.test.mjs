import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
  Interface,
  ZeroAddress,
  ZeroHash,
  keccak256,
  parseUnits,
  solidityPackedKeccak256,
  toQuantity,
} from "ethers";
import {
  runJudgeVerification,
  MANIFEST_FILES,
  V1_ABI,
  CURRENT_ABI,
} from "../scripts/lib/judge-verify.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const v1 = new Interface(V1_ABI);
const current = new Interface(CURRENT_ABI);
const transfer = new Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const code = "0x60006000";
const hash = `0x${"1".repeat(64)}`;

function fixture(t) {
  const repoRoot = mkdtempSync(join(tmpdir(), ".judge-test-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const manifests = {};
  for (const name of Object.values(MANIFEST_FILES)) {
    const manifest = JSON.parse(readFileSync(join(root, name), "utf8"));
    if (name === "deployments-v3-current.json")
      for (const key of Object.keys(manifest.runtimeCodeHashes))
        manifest.runtimeCodeHashes[key] = keccak256(code);
    manifests[name] = manifest;
    writeFileSync(join(repoRoot, name), `${JSON.stringify(manifest)}\n`);
  }
  const deployment = manifests["deployments.json"];
  const evidence = manifests["evidence-v1-catches.json"];
  const core = manifests["deployments-v3-current.json"];
  const activation = manifests["activation-v3-current.json"];
  const allocation = manifests["allocation-v3-portfolio-current.json"];
  const verifier =
    manifests["deployments-v3-operator-service-verifier-current.json"];
  const portfolioManifest =
    manifests["deployments-v3-portfolio-core-current.json"];
  const market = manifests["deployments-v3-operator-market-current.json"];
  const state = {
    chainId: 102031,
    reorg: false,
    proofCount: 1,
    poolBalance: 0,
    timeout: false,
    explorerFailure: false,
    portfolioFacilityLimit: allocation.facility.lenderFunded,
    portfolioBondRequired: allocation.facility.bondPosted,
    totalAllocatedPrincipal: allocation.pool.totalAllocatedPrincipal,
  };
  const receipts = {};
  function event(iface, address, name, values) {
    return { address, ...iface.encodeEventLog(iface.getEvent(name), values) };
  }
  for (const item of [evidence.cumulativeBatch, evidence.autonomousCatch]) {
    const consequences = item.consequences;
    receipts[item.cc3Tx] = {
      transactionHash: item.cc3Tx,
      status: "0x1",
      to: deployment.adjudicator,
      blockNumber: toQuantity(item.cc3Block),
      gasUsed: toQuantity(item.gasUsed),
      logs: [
        event(v1, deployment.facility, "Breached", [
          item.facilityId,
          consequences.hunter,
          consequences.debtReductionWei,
          consequences.hunterRewardWei,
        ]),
        event(v1, deployment.adjudicator, "BreachReported", [
          item.facilityId,
          consequences.covenantId,
          consequences.hunter,
        ]),
        ...(item.sources ?? [item.source]).map((source, index) =>
          event(v1, deployment.adjudicator, "EvidenceAccepted", [
            item.facilityId,
            consequences.covenantId,
            solidityPackedKeccak256(
              ["uint64", "uint64", "uint64"],
              [3, source.ethBlock, source.txIndex ?? index],
            ),
            consequences.hunter,
          ]),
        ),
      ],
    };
    for (const [index, source] of (item.sources ?? [item.source]).entries()) {
      const from = source.from ?? item.treasury;
      const amount = parseUnits(source.amountUsdc, 6);
      receipts[source.ethTx] = {
        transactionHash: source.ethTx,
        gasUsed: "0x5208",
        to: evidence.cumulativeBatch.usdc,
        status: "0x1",
        blockNumber: toQuantity(source.ethBlock),
        transactionIndex: toQuantity(source.txIndex ?? index),
        logs: [
          event(transfer, evidence.cumulativeBatch.usdc, "Transfer", [
            from,
            consequences.hunter,
            amount,
          ]),
          event(transfer, evidence.cumulativeBatch.usdc, "Transfer", [
            consequences.hunter,
            ZeroAddress,
            amount,
          ]),
        ],
      };
    }
  }
  function historical(manifest, step, to, logs) {
    const record = manifest.transactions[step];
    receipts[record.hash] = {
      transactionHash: record.hash,
      gasUsed: "0x5208",
      blockNumber: toQuantity(record.blockNumber),
      blockHash: record.blockHash,
      to,
      status: "0x1",
      logs,
    };
  }
  const p = activation.facility;
  const a = allocation.facility;
  historical(activation, "createFacility", core.contracts.cappedPilotFactory, [
    event(current, core.contracts.cappedPilotFactory, "PilotFacilityCreated", [
      p.address,
      p.facilityLimit,
      p.bondRequired,
    ]),
  ]);
  historical(activation, "fundFacility", p.address, [
    event(current, p.address, "LenderFunded", [p.lenderFunded]),
  ]);
  historical(activation, "postBorrowerBond", p.address, [
    event(current, p.address, "BondPosted", [p.bondPosted]),
  ]);
  historical(activation, "activateFacility", p.address, [
    event(current, p.address, "Activated", [p.policySetCommitment]),
  ]);
  historical(activation, "createProofJob", core.contracts.proofJobs, [
    event(current, core.contracts.proofJobs, "JobCreated", [
      activation.proofJob.jobId,
      p.lender,
      p.address,
      activation.policy.policyId,
      activation.proofJob.requirementsDigest,
      activation.proofJob.escrow,
    ]),
    event(current, p.asset, "Transfer", [
      p.lender,
      core.contracts.proofJobs,
      activation.proofJob.escrow,
    ]),
  ]);
  historical(allocation, "createFacility", allocation.pool.address, [
    event(
      current,
      portfolioManifest.contracts.CappedPilotFactoryV1,
      "PilotFacilityCreated",
      [a.address, a.lenderFunded, a.bondPosted],
    ),
  ]);
  historical(allocation, "postBorrowerBond", a.address, [
    event(current, a.address, "BondPosted", [a.bondPosted]),
  ]);
  historical(allocation, "activatePool", allocation.pool.address, [
    event(current, allocation.pool.address, "PoolActivated", [
      allocation.pool.totalDeposited,
    ]),
  ]);
  historical(allocation, "allocate", allocation.pool.address, [
    event(current, allocation.pool.address, "AllocationFunded", [
      a.address,
      allocation.registry.deploymentId,
      a.lenderFunded,
    ]),
    event(current, a.address, "LenderFunded", [a.lenderFunded]),
  ]);
  historical(allocation, "activateFacility", a.address, [
    event(current, a.address, "Activated", [a.policySetCommitment]),
  ]);
  for (const movement of allocation.assetMovement.transfers) {
    if (!receipts[movement.transactionHash])
      historical(allocation, movement.step, allocation.pool.address, []);
    receipts[movement.transactionHash].logs.push(
      event(current, p.asset, "Transfer", [
        movement.from,
        movement.to,
        movement.amount,
      ]),
    );
  }
  function zeroValue(param) {
    if (param.baseType === "tuple") return param.components.map(zeroValue);
    if (param.type === "address") return ZeroAddress;
    if (param.type === "bool") return false;
    if (param.type === "bytes32") return ZeroHash;
    if (param.type === "bytes") return "0x";
    return 0;
  }
  const calls = [];
  const cc3Provider = {
    url: "fixture:cc3",
    async send(method, params) {
      calls.push([method, params]);
      if (state.timeout) return new Promise(() => {});
      if (method === "eth_chainId") return toQuantity(state.chainId);
      if (method === "eth_getBlockByNumber")
        return {
          number: "0x600000",
          hash:
            state.reorg && params[0] !== "finalized"
              ? `0x${"2".repeat(64)}`
              : hash,
        };
      if (method === "eth_getCode") return code;
      if (method === "eth_getTransactionReceipt")
        return receipts[params[0]] ?? null;
      if (method === "eth_getLogs") return [];
      if (method === "eth_getTransactionByHash") {
        const item = evidence.cumulativeBatch;
        return {
          to: deployment.adjudicator,
          input: v1.encodeFunctionData("submitBatch", [
            1,
            1,
            3,
            item.sources.map((source) => source.ethBlock),
            item.sources.map(() => "0x01"),
            item.sources.map(() => [ZeroHash, []]),
            [ZeroHash, [ZeroHash]],
          ]),
        };
      }
      if (method === "eth_call") {
        const transaction = current.parseTransaction({ data: params[0].data });
        const name = transaction.name;
        const address = params[0].to.toLowerCase();
        const portfolio = address === allocation.facility.address.toLowerCase();
        const f = portfolio
          ? { ...activation.facility, ...allocation.facility }
          : activation.facility;
        const values = {
          asset: activation.facility.asset,
          kernel: core.contracts.policyKernel,
          verifier:
            address === market.contracts.OperatorMarketV1.toLowerCase()
              ? verifier.contracts.OperatorServiceVerifierV1
              : core.verifier,
          creditState: core.contracts.verifiedCreditState,
          proofJobs: core.contracts.proofJobs,
          context: core.contracts.policyKernel,
          lender: f.lender,
          borrower: f.borrower,
          facilityLimit: portfolio
            ? state.portfolioFacilityLimit
            : f.facilityLimit,
          bondRequired: portfolio
            ? state.portfolioBondRequired
            : f.bondRequired,
          lenderFunded: allocation.facility.lenderFunded,
          bondPosted: allocation.facility.bondPosted,
          isFacility: true,
          policySetCommitment: activation.facility.policySetCommitment,
          configHash: activation.policy.configurationHash,
          policyCount: 1,
          status: 1,
          totalAllocatedPrincipal: state.totalAllocatedPrincipal,
          decimals: 6,
          mandate: portfolioManifest.contracts.PortfolioMandateV1,
          factory: portfolioManifest.contracts.CappedPilotFactoryV1,
          balanceOf: state.poolBalance,
          serviceVerifier: verifier.contracts.OperatorServiceVerifierV1,
          attestor: verifier.constructors.OperatorServiceVerifierV1.values[0],
          quoteCount: 0,
        };
        if (name === "policyOf")
          return current.encodeFunctionResult(name, [
            activation.policy.evaluator,
            activation.policy.configurationHash,
            "0x",
          ]);
        if (name === "getJob") {
          const outputs = current.getFunction(name).outputs;
          const jobValues = {
            ...activation.proofJob,
            sponsor: p.lender,
            token: p.asset,
            facility: p.address,
            policyId: activation.policy.policyId,
            successfulProofs: state.proofCount,
            state: activation.proofJob.stateCode,
          };
          const job = outputs[0].components.map(
            (param) => jobValues[param.name] ?? zeroValue(param),
          );
          return current.encodeFunctionResult(name, [job]);
        }
        assert.ok(name in values, `Unmocked getter ${name}`);
        return current.encodeFunctionResult(name, [values[name]]);
      }
      throw new Error(`Unmocked RPC ${method}`);
    },
  };
  const ethProvider = {
    url: "fixture:ethereum",
    async send(method, params) {
      if (state.timeout) return new Promise(() => {});
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_getTransactionReceipt")
        return receipts[params[0]] ?? null;
      throw new Error(`Unmocked Ethereum RPC ${method}`);
    },
  };
  const fetchImpl = async (url) => {
    if (state.explorerFailure && String(url).includes("blockscout"))
      return { ok: false, status: 503 };
    let body = {};
    if (String(url).includes("internal-transactions")) {
      const count = String(url).includes(evidence.cumulativeBatch.cc3Tx)
        ? 6
        : 2;
      body = {
        items: Array.from({ length: count }, () => ({
          to: { hash: core.verifier },
        })),
        next_page_params: null,
      };
    } else if (String(url).includes("/addresses/"))
      body = { is_verified: true };
    else if (String(url).includes("registry.npmjs"))
      body = {
        name: "recourse-protocol-sdk",
        version: "0.1.1",
        dist: { integrity: "sha512-fixture" },
      };
    return { ok: true, status: 200, json: async () => body };
  };
  return {
    repoRoot,
    cc3Provider,
    ethProvider,
    fetchImpl,
    state,
    receipts,
    evidence,
    calls,
    now: () => new Date("2026-09-12T00:00:00Z"),
    timeout: 50,
  };
}

test("consistent public evidence passes RPC checks and leaves non-RPC claims unverified", async (t) => {
  const f = fixture(t);
  const result = await runJudgeVerification(f);
  assert.equal(
    result.summary.FAIL,
    0,
    JSON.stringify(result.checks.filter((check) => check.status !== "PASS")),
  );
  assert.equal(
    result.summary.UNVERIFIED,
    3,
    JSON.stringify(
      result.checks.filter((check) => check.status === "UNVERIFIED"),
    ),
  );
  assert.ok(result.summary.PASS > 10);
  for (const [method, params] of f.calls)
    if (["eth_call", "eth_getCode"].includes(method))
      assert.equal(params[1], result.anchor.number);
});

test("wrong CC3 chain and changed finalized hash fail", async (t) => {
  for (const mutation of ["chainId", "reorg"]) {
    const f = fixture(t);
    f.state[mutation] = mutation === "chainId" ? 1 : true;
    const result = await runJudgeVerification(f);
    assert.ok(
      result.checks.some(
        (check) =>
          check.status === "FAIL" &&
          /chain|anchor|finalized/i.test(`${check.title} ${check.detail}`),
      ),
      JSON.stringify(result),
    );
  }
});

test("one-unit gas or decoded consequence drift fails; absent receipts are unverified", async (t) => {
  for (const mutation of ["gas", "amount", "missing"]) {
    const f = fixture(t);
    const receipt = f.receipts[f.evidence.autonomousCatch.cc3Tx];
    if (mutation === "gas")
      receipt.gasUsed = toQuantity(BigInt(receipt.gasUsed) + 1n);
    if (mutation === "amount") {
      const decoded = v1.parseLog(receipt.logs[0]);
      receipt.logs[0] = {
        address: receipt.logs[0].address,
        ...v1.encodeEventLog(v1.getEvent("Breached"), [
          decoded.args[0],
          decoded.args[1],
          decoded.args[2] + 1n,
          decoded.args[3],
        ]),
      };
    }
    if (mutation === "missing")
      delete f.receipts[f.evidence.autonomousCatch.cc3Tx];
    const result = await runJudgeVerification(f);
    assert.ok(
      result.checks.some(
        (check) =>
          check.status === (mutation === "missing" ? "UNVERIFIED" : "FAIL") &&
          check.id === "v1-autonomousCatch",
      ),
      mutation,
    );
  }
});

test("transport timeout and explorer 503 are UNVERIFIED", async (t) => {
  for (const mutation of ["timeout", "explorerFailure"]) {
    const f = fixture(t);
    f.state[mutation] = true;
    const result = await runJudgeVerification(f);
    assert.equal(result.summary.FAIL, 0);
    assert.ok(result.summary.UNVERIFIED > 3);
  }
});

test("current proof-count and balance changes are described without failing", async (t) => {
  const f = fixture(t);
  f.state.proofCount = 17;
  f.state.poolBalance = 123456;
  const result = await runJudgeVerification(f);
  assert.equal(result.summary.FAIL, 0);
  assert.match(
    result.checks.find((check) => check.id === "6.pilot").detail,
    /successful proofs=17,/,
  );
  assert.match(
    result.checks.find((check) => check.id === "7.portfolio").detail,
    /pool cash=123456 /,
  );
});

test("CLI help and usage exit codes", () => {
  const help = spawnSync(
    process.execPath,
    ["scripts/judge-verify.mjs", "--help"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--json/);
  for (const args of [
    ["--unknown"],
    ["--timeout", "0"],
    ["--cc3-rpc"],
    ["--eth-rpc", "file:///x"],
  ]) {
    const result = spawnSync(
      process.execPath,
      ["scripts/judge-verify.mjs", ...args],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 2, result.stderr);
  }
});

test("CLI unreachable endpoints exit zero with JSON transport results and no network", (t) => {
  const directory = mkdtempSync(join(tmpdir(), ".judge-cli-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const preload = join(directory, "offline.mjs");
  writeFileSync(
    preload,
    'globalThis.fetch = async () => { throw new TypeError("offline fixture: connection refused"); };\n',
  );
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(preload).href,
      "scripts/judge-verify.mjs",
      "--json",
      "--cc3-rpc",
      "http://127.0.0.1:1",
      "--eth-rpc",
      "http://127.0.0.1:1",
      "--explorer",
      "http://127.0.0.1:1",
      "--timeout",
      "5",
    ],
    { cwd: root, encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.checks.length > 0);
  assert.ok(
    report.checks.every((check) => check.status === "UNVERIFIED"),
    JSON.stringify(report),
  );
});

test("malformed evidence manifest is a reported failure, not a crash", async (t) => {
  const f = fixture(t);
  delete f.evidence.cumulativeBatch;
  writeFileSync(
    join(f.repoRoot, "evidence-v1-catches.json"),
    JSON.stringify(f.evidence),
  );
  const report = await runJudgeVerification(f);
  assert.ok(
    report.checks.some(
      (check) => check.status === "FAIL" && check.id === "manifests",
    ),
  );
});

test("HTTP 404 falsifies page availability while HTTP 503 remains unverified", async (t) => {
  for (const status of [400, 401, 403, 404, 408, 429, 503]) {
    const f = fixture(t);
    const originalFetch = f.fetchImpl;
    f.fetchImpl = async (url, options) =>
      String(url).includes("recourse.gudman.xyz/v3.html")
        ? { ok: false, status }
        : originalFetch(url, options);
    const report = await runJudgeVerification(f);
    assert.equal(
      report.checks.find((check) => check.id === "site-v3.html").status,
      status === 404 ? "FAIL" : "UNVERIFIED",
    );
  }
});

test("false V1 source badge fails the advertised verification claim", async (t) => {
  const f = fixture(t);
  const originalFetch = f.fetchImpl;
  f.fetchImpl = async (url, options) =>
    String(url).includes(
      "/addresses/0x144048E22e822269814D592aeaC34734c603dCA7",
    )
      ? { ok: true, status: 200, json: async () => ({ is_verified: false }) }
      : originalFetch(url, options);
  const report = await runJudgeVerification(f);
  assert.equal(
    report.checks.find((check) => check.id === "badge-deployments/facility")
      .status,
    "FAIL",
  );
});

test("a receipt for another transaction fails even when events match", async (t) => {
  const f = fixture(t);
  f.receipts[f.evidence.autonomousCatch.cc3Tx].transactionHash = hash;
  const report = await runJudgeVerification(f);
  assert.equal(
    report.checks.find((check) => check.id === "v1-autonomousCatch").status,
    "FAIL",
  );
});

test("documented Horizon 1 unverified badges remain honest current observations", async (t) => {
  const f = fixture(t);
  const horizon = JSON.parse(
    readFileSync(join(root, "deployments-horizon1.json"), "utf8"),
  );
  const names = [
    "policyKernel",
    "demonstrationFacility",
    "verifiedCreditState",
  ];
  const originalFetch = f.fetchImpl;
  f.fetchImpl = async (url, options) =>
    names.some((name) => String(url).includes(`/addresses/${horizon[name]}`))
      ? { ok: true, status: 200, json: async () => ({ is_verified: false }) }
      : originalFetch(url, options);
  const report = await runJudgeVerification(f);
  for (const name of names) {
    const check = report.checks.find(
      (item) => item.id === `badge-deployments-horizon1/${name}`,
    );
    assert.equal(check.status, "PASS");
    assert.match(check.detail, /is_verified=false/);
  }
});

test("Ethereum amount, source identity and catch index drift fail", async (t) => {
  for (const mutation of ["amount", "sender", "emitter", "index", "missing"]) {
    const f = fixture(t);
    const source = f.evidence.autonomousCatch.source;
    const receipt = f.receipts[source.ethTx];
    if (mutation === "amount" || mutation === "sender")
      receipt.logs[0] = {
        address: receipt.logs[0].address,
        ...transfer.encodeEventLog(transfer.getEvent("Transfer"), [
          mutation === "sender" ? ZeroAddress : source.from,
          f.evidence.autonomousCatch.consequences.hunter,
          parseUnits(source.amountUsdc, 6) + (mutation === "amount" ? 1n : 0n),
        ]),
      };
    if (mutation === "emitter") receipt.logs[0].address = ZeroAddress;
    if (mutation === "index")
      receipt.transactionIndex = toQuantity(source.txIndex + 1);
    if (mutation === "missing") delete f.receipts[source.ethTx];
    const report = await runJudgeVerification(f);
    assert.equal(
      report.checks.find((check) => check.id === "ethereum-autonomousCatch")
        .status,
      mutation === "missing" ? "UNVERIFIED" : "FAIL",
      mutation,
    );
  }
});

for (const field of [
  "breachGasUsed",
  "breachTx",
  "breachBlock",
  "facilityId",
]) {
  test(`V1 deployment ${field} must agree with committed catch evidence`, async (t) => {
    const f = fixture(t);
    const path = join(f.repoRoot, "deployments.json");
    const deployment = JSON.parse(readFileSync(path, "utf8"));
    deployment[field] = field === "breachTx" ? hash : deployment[field] + 1;
    writeFileSync(path, JSON.stringify(deployment));
    const report = await runJudgeVerification(f);
    assert.equal(
      report.checks.find((check) => check.id === "manifests").status,
      "FAIL",
    );
  });
}

for (const field of ["portfolioFacilityLimit", "portfolioBondRequired"]) {
  test(`current ${field} must match the allocated facility identity`, async (t) => {
    const f = fixture(t);
    f.state[field] = BigInt(f.state[field]) + 1n;
    const report = await runJudgeVerification(f);
    assert.equal(
      report.checks.find((check) => check.id === "7.portfolio").status,
      "FAIL",
    );
  });
}

test("cumulative portfolio allocation cannot fall below its historical allocation", async (t) => {
  const f = fixture(t);
  f.state.totalAllocatedPrincipal = 99999999999n;
  const report = await runJudgeVerification(f);
  assert.equal(
    report.checks.find((check) => check.id === "7.portfolio").status,
    "FAIL",
  );
});

test("a higher cumulative portfolio allocation is reported as current state", async (t) => {
  const f = fixture(t);
  f.state.totalAllocatedPrincipal = 100000000001n;
  const report = await runJudgeVerification(f);
  const check = report.checks.find((item) => item.id === "7.portfolio");
  assert.equal(check.status, "PASS");
  assert.match(check.detail, /100000000001/);
});

test("missing activation creation record is a reported manifest failure", async (t) => {
  const f = fixture(t);
  const path = join(f.repoRoot, "activation-v3-current.json");
  const activation = JSON.parse(readFileSync(path, "utf8"));
  delete activation.transactions.createFacility;
  writeFileSync(path, JSON.stringify(activation));
  const report = await runJudgeVerification(f);
  assert.equal(
    report.checks.find((check) => check.id === "manifests").status,
    "FAIL",
  );
});

for (const mode of ["fallback-null", "fallback-receipt", "primary-null"]) {
  test(`Ethereum HTTP ${mode} preserves transport uncertainty and receipt absence`, async (t) => {
    const f = fixture(t);
    const originalFetch = f.fetchImpl;
    const fallbackCalls = [];
    f.ethProvider = undefined;
    f.fetchImpl = async (url, options) => {
      if (
        url !== "https://ethereum-rpc.publicnode.com" &&
        url !== "https://eth.drpc.org" &&
        url !== "https://1rpc.io/eth"
      )
        return originalFetch(url, options);
      const { method, params } = JSON.parse(options.body);
      const fallback = url !== "https://ethereum-rpc.publicnode.com";
      if (fallback) fallbackCalls.push(method);
      if (method === "eth_chainId")
        return { ok: true, status: 200, json: async () => ({ result: "0x1" }) };
      if (method === "eth_getBlockByNumber")
        throw new Error("block unavailable");
      assert.equal(method, "eth_getTransactionReceipt");
      if (!fallback && mode !== "primary-null")
        throw new TypeError("Primary Ethereum receipt transport failed");
      const result = mode === "fallback-receipt" ? f.receipts[params[0]] : null;
      return { ok: true, status: 200, json: async () => ({ result }) };
    };
    const report = await runJudgeVerification(f);
    for (const id of ["ethereum-cumulativeBatch", "ethereum-autonomousCatch"])
      assert.equal(
        report.checks.find((check) => check.id === id).status,
        mode === "fallback-receipt" ? "PASS" : "UNVERIFIED",
      );
    assert.ok(fallbackCalls.length > 0);
  });
}

for (const [name, id, mutate] of [
  [
    "missing gasUsed",
    "v1-autonomousCatch",
    (f) => delete f.receipts[f.evidence.autonomousCatch.cc3Tx].gasUsed,
  ],
  [
    "missing receipt status",
    "v1-autonomousCatch",
    (f) => delete f.receipts[f.evidence.autonomousCatch.cc3Tx].status,
  ],
  [
    "missing receipt logs",
    "v1-autonomousCatch",
    (f) => delete f.receipts[f.evidence.autonomousCatch.cc3Tx].logs,
  ],
  [
    "missing receipt topics",
    "6.history",
    (f) => {
      for (const r of Object.values(f.receipts))
        for (const log of r.logs) delete log.topics;
    },
  ],
  [
    "malformed finalized",
    "finalized-anchor",
    (f) => {
      const send = f.cc3Provider.send;
      f.cc3Provider.send = (m, p) =>
        m === "eth_getBlockByNumber" ? {} : send(m, p);
    },
  ],
  [
    "missing second hash",
    "anchor-recheck",
    (f) => {
      const send = f.cc3Provider.send;
      f.cc3Provider.send = (m, p) =>
        m === "eth_getBlockByNumber" && p[0] !== "finalized" ? {} : send(m, p);
    },
  ],
  [
    "nonhex runtime",
    "5.core",
    (f) => {
      const send = f.cc3Provider.send;
      f.cc3Provider.send = (m, p) =>
        m === "eth_getCode" ? "not-hex" : send(m, p);
    },
  ],
  [
    "malformed call result",
    "5.core",
    (f) => {
      const send = f.cc3Provider.send;
      f.cc3Provider.send = (m, p) => (m === "eth_call" ? "0x" : send(m, p));
    },
  ],
  [
    "malformed market log",
    "8.activity",
    (f) => {
      const send = f.cc3Provider.send;
      f.cc3Provider.send = (m, p) =>
        m === "eth_getLogs" ? [{ topics: [] }] : send(m, p);
    },
  ],
  [
    "null market logs",
    "8.activity",
    (f) => {
      const send = f.cc3Provider.send;
      f.cc3Provider.send = (m, p) => (m === "eth_getLogs" ? null : send(m, p));
    },
  ],
  [
    "missing npm metadata",
    "npm-sdk",
    (f) => {
      const fetch = f.fetchImpl;
      f.fetchImpl = (url, o) =>
        String(url).includes("registry.npmjs")
          ? { ok: true, status: 200, json: async () => ({}) }
          : fetch(url, o);
    },
  ],
]) {
  test(`malformed response: ${name} is UNVERIFIED`, async (t) => {
    const f = fixture(t);
    mutate(f);
    const report = await runJudgeVerification(f);
    const check = report.checks.find((row) => row.id === id);
    assert.equal(check.status, "UNVERIFIED", JSON.stringify(check));
  });
}

for (const mode of [
  "missing cursor",
  "nonobject",
  "missing items",
  "empty",
  "loop",
  "cap",
  "wrong count",
]) {
  test(`explorer pagination: ${mode}`, async (t) => {
    const f = fixture(t);
    const fetch = f.fetchImpl;
    const pages = new Map();
    f.fetchImpl = async (url, o) => {
      const response = await fetch(url, o);
      if (!String(url).includes("internal-transactions")) return response;
      let body = await response.json();
      if (mode === "missing cursor") delete body.next_page_params;
      if (mode === "nonobject") body = null;
      if (mode === "missing items") delete body.items;
      if (mode === "empty") body.items = [];
      if (mode === "loop") body.next_page_params = { index: 1 };
      if (mode === "cap") {
        const key = String(url).split("?")[0];
        const page = (pages.get(key) ?? 0) + 1;
        pages.set(key, page);
        body.next_page_params = page === 21 ? null : { index: page };
      }
      if (mode === "wrong count") body.items.pop();
      return { ...response, json: async () => body };
    };
    const report = await runJudgeVerification(f);
    for (const id of ["traces-cumulativeBatch", "traces-autonomousCatch"]) {
      const check = report.checks.find((row) => row.id === id);
      assert.equal(
        check.status,
        mode === "wrong count" ? "FAIL" : "UNVERIFIED",
        JSON.stringify(check),
      );
      if (mode === "empty")
        assert.match(
          check.detail,
          /explorer reports no internal transactions/i,
        );
    }
  });
}

for (const mode of [
  "runtime",
  "blockHash",
  "to",
  "reverted",
  "breach emitter",
  "queryId",
  "heights",
]) {
  test(`valid contradiction remains FAIL: ${mode}`, async (t) => {
    const f = fixture(t);
    const send = f.cc3Provider.send;
    let id = "v1-autonomousCatch";
    const catchReceipt = f.receipts[f.evidence.autonomousCatch.cc3Tx];
    if (mode === "runtime") {
      id = "5.core";
      f.cc3Provider.send = (m, p) =>
        m === "eth_getCode" ? "0x6001" : send(m, p);
    }
    if (mode === "blockHash" || mode === "to") {
      id = "6.history";
      const activation = JSON.parse(
        readFileSync(join(f.repoRoot, "activation-v3-current.json"), "utf8"),
      );
      f.receipts[activation.transactions.createFacility.hash][mode] =
        mode === "to" ? ZeroAddress : ZeroHash;
    }
    if (mode === "reverted") catchReceipt.status = "0x0";
    if (mode === "breach emitter") catchReceipt.logs[0].address = ZeroAddress;
    if (mode === "queryId") {
      id = "ethereum-cumulativeBatch";
      f.receipts[f.evidence.cumulativeBatch.sources[0].ethTx].transactionIndex =
        "0xffff";
    }
    if (mode === "heights") {
      id = "batch-shape";
      f.cc3Provider.send = async (m, p) => {
        const value = await send(m, p);
        if (m !== "eth_getTransactionByHash") return value;
        const args = v1
          .decodeFunctionData("submitBatch", value.input)
          .toArray(true);
        args[3][0] += 1n;
        return { ...value, input: v1.encodeFunctionData("submitBatch", args) };
      };
    }
    const report = await runJudgeVerification(f);
    const check = report.checks.find((row) => row.id === id);
    assert.equal(check.status, "FAIL", JSON.stringify(check));
  });
}

for (const field of [
  "address",
  "topics",
  "data",
  "blockNumber",
  "transactionHash",
  "logIndex",
]) {
  test(`market activity rejects malformed ${field}`, async (t) => {
    const f = fixture(t);
    const manifest = JSON.parse(
      readFileSync(
        join(f.repoRoot, "deployments-v3-operator-market-current.json"),
        "utf8",
      ),
    );
    const log = {
      address: manifest.contracts.OperatorMarketV1,
      topics: [current.getEvent("QuotePosted").topicHash],
      data: "0x",
      blockNumber: toQuantity(
        manifest.transactions.OperatorMarketV1.blockNumber,
      ),
      transactionHash: hash,
      logIndex: "0x0",
    };
    delete log[field];
    const send = f.cc3Provider.send;
    f.cc3Provider.send = (m, p) => (m === "eth_getLogs" ? [log] : send(m, p));
    const report = await runJudgeVerification(f);
    const check = report.checks.find((row) => row.id === "8.activity");
    assert.equal(check.status, "UNVERIFIED", JSON.stringify(check));
    assert.match(
      check.detail,
      new RegExp(`^Missing or malformed log\\.${field}`),
    );
  });
}

test("market activity reads contiguous ranges of at most 2000 blocks", async (t) => {
  const f = fixture(t);
  const report = await runJudgeVerification(f);
  const ranges = f.calls
    .filter(([method]) => method === "eth_getLogs")
    .map(([, [range]]) => range);
  assert.ok(ranges.length > 1);
  for (let i = 0; i < ranges.length; i++) {
    assert.ok(BigInt(ranges[i].toBlock) - BigInt(ranges[i].fromBlock) < 2000n);
    if (i)
      assert.equal(
        BigInt(ranges[i].fromBlock),
        BigInt(ranges[i - 1].toBlock) + 1n,
      );
  }
  assert.equal(BigInt(ranges.at(-1).toBlock), BigInt(report.anchor.number));
});

test("a concurrent contradiction takes priority over unavailable core reads", async (t) => {
  const f = fixture(t);
  const send = f.cc3Provider.send;
  let calls = 0;
  f.cc3Provider.send = async (m, p) => {
    if (m === "eth_getCode") {
      calls++;
      if (calls === 1) throw new Error("unavailable");
      return "0x6001";
    }
    return send(m, p);
  };
  const report = await runJudgeVerification(f);
  assert.equal(report.checks.find((row) => row.id === "5.core").status, "FAIL");
});

test("Ethereum fallback identity is checked before receipts and attributed", async (t) => {
  for (const chainId of ["0x1", "0x2"]) {
    const f = fixture(t);
    f.ethProvider = undefined;
    const fetch = f.fetchImpl;
    const calls = [];
    f.fetchImpl = async (url, options) => {
      if (
        ![
          "https://ethereum-rpc.publicnode.com",
          "https://eth.drpc.org",
        ].includes(url)
      )
        return fetch(url, options);
      const { method, params } = JSON.parse(options.body);
      const fallback = url === "https://eth.drpc.org";
      if (fallback) calls.push(method);
      if (!fallback && method !== "eth_chainId") throw new Error("unavailable");
      const result =
        method === "eth_chainId"
          ? fallback
            ? chainId
            : "0x1"
          : f.receipts[params[0]];
      return { ok: true, status: 200, json: async () => ({ result }) };
    };
    const report = await runJudgeVerification(f);
    assert.equal(calls[0], "eth_chainId");
    for (const id of ["ethereum-cumulativeBatch", "ethereum-autonomousCatch"]) {
      const check = report.checks.find((row) => row.id === id);
      assert.equal(
        check.status,
        chainId === "0x1" ? "PASS" : "UNVERIFIED",
        JSON.stringify(check),
      );
      if (chainId === "0x1")
        assert.match(check.detail, /https:\/\/eth.drpc.org/);
    }
    if (chainId === "0x2")
      assert.ok(!calls.includes("eth_getTransactionReceipt"));
  }
});

for (const malformed of [false, true]) {
  test(`AM unrelated zero-topic logs with malformed Transfer=${malformed}`, async (t) => {
    const f = fixture(t);
    for (const receipt of Object.values(f.receipts))
      receipt.logs.unshift({ address: ZeroAddress, topics: [], data: "0x" });
    if (malformed)
      f.receipts[f.evidence.autonomousCatch.source.ethTx].logs[1].topics.pop();
    const report = await runJudgeVerification(f);
    const row = report.checks.find(
      (row) => row.id === "ethereum-autonomousCatch",
    );
    assert.equal(
      row.status,
      malformed ? "UNVERIFIED" : "PASS",
      JSON.stringify(row),
    );
    if (malformed) assert.match(row.detail, /topics\[2\]/);
    for (const id of [
      "v1-cumulativeBatch",
      "v1-autonomousCatch",
      "6.history",
      "7.history",
    ])
      assert.equal(
        report.checks.find((row) => row.id === id).status,
        "PASS",
        id,
      );
  });
}

for (const mode of [
  "fallback ok",
  "second fallback ok",
  "all null",
  "null and transport",
  "blockHash contradiction",
]) {
  test(`AM primary null: ${mode}`, async (t) => {
    const f = fixture(t);
    f.ethProvider = undefined;
    const fetch = f.fetchImpl;
    const calls = [];
    f.fetchImpl = async (url, options) => {
      if (
        ![
          "https://ethereum-rpc.publicnode.com",
          "https://eth.drpc.org",
          "https://1rpc.io/eth",
        ].includes(url)
      )
        return fetch(url, options);
      const { method, params } = JSON.parse(options.body);
      calls.push([url, method]);
      if (method === "eth_chainId")
        return { ok: true, json: async () => ({ result: "0x1" }) };
      if (method === "eth_getBlockByNumber")
        throw new Error("block unavailable");
      assert.equal(method, "eth_getTransactionReceipt");
      if (
        mode === "null and transport" &&
        url !== "https://ethereum-rpc.publicnode.com"
      )
        throw new Error("unavailable");
      const answering =
        mode === "second fallback ok"
          ? "https://1rpc.io/eth"
          : "https://eth.drpc.org";
      const result =
        !["all null", "null and transport"].includes(mode) && url === answering
          ? f.receipts[params[0]]
          : null;
      return { ok: true, json: async () => ({ result }) };
    };
    if (mode === "blockHash contradiction") {
      const activation = JSON.parse(
        readFileSync(join(f.repoRoot, "activation-v3-current.json"), "utf8"),
      );
      f.receipts[activation.transactions.createFacility.hash].blockHash =
        ZeroHash;
    }
    const report = await runJudgeVerification(f);
    const row = report.checks.find(
      (row) => row.id === "ethereum-autonomousCatch",
    );
    assert.equal(
      row.status,
      ["all null", "null and transport"].includes(mode) ? "UNVERIFIED" : "PASS",
      JSON.stringify(row),
    );
    if (["all null", "null and transport"].includes(mode))
      assert.match(row.detail, /no receipt and no block returned/);
    else
      assert.ok(
        row.detail.includes(
          mode === "second fallback ok"
            ? "https://1rpc.io/eth"
            : "https://eth.drpc.org",
        ),
      );
    if (mode === "blockHash contradiction")
      assert.equal(
        report.checks.find((row) => row.id === "6.history").status,
        "FAIL",
      );
    for (const url of ["https://eth.drpc.org", "https://1rpc.io/eth"])
      if (calls.some(([node]) => node === url))
        assert.equal(calls.find(([node]) => node === url)[1], "eth_chainId");
  });
}

test("AM null CC3 historical receipts are unverified", async (t) => {
  const f = fixture(t);
  const send = f.cc3Provider.send;
  f.cc3Provider.send = (m, p) =>
    m === "eth_getTransactionReceipt" ? null : send(m, p);
  const report = await runJudgeVerification(f);
  for (const id of [
    "v1-cumulativeBatch",
    "v1-autonomousCatch",
    "6.history",
    "7.history",
  ]) {
    const row = report.checks.find((row) => row.id === id);
    assert.equal(row.status, "UNVERIFIED", JSON.stringify(row));
    assert.match(row.detail, /no receipt and no block returned/);
  }
});

test("AM activity skips unrelated emitters and zero-topic logs", async (t) => {
  const f = fixture(t);
  const market = JSON.parse(
    readFileSync(
      join(f.repoRoot, "deployments-v3-operator-market-current.json"),
      "utf8",
    ),
  );
  const send = f.cc3Provider.send;
  f.cc3Provider.send = (m, p) =>
    m === "eth_getLogs"
      ? [
          { address: ZeroAddress, topics: [], data: "0x" },
          {
            address: market.contracts.OperatorMarketV1,
            topics: [],
            data: "0x",
          },
          {
            address: ZeroAddress,
            topics: [current.getEvent("QuotePosted").topicHash],
            data: "0x",
          },
        ]
      : send(m, p);
  const report = await runJudgeVerification(f);
  const row = report.checks.find((row) => row.id === "8.activity");
  assert.equal(row.status, "PASS", JSON.stringify(row));
  assert.match(row.detail, /agreements accepted=0/);
});

for (const chain of ["Ethereum", "CC3"]) {
  for (const name of ["cumulativeBatch", "autonomousCatch"]) {
    for (const mode of [
      "absent",
      "present",
      "unavailable",
      "malformed",
      "wrong block",
      "malformed hash",
    ]) {
      test(`AN ${chain} ${name} null receipt membership: ${mode}`, async (t) => {
        const f = fixture(t);
        const record = f.evidence[name];
        const source = record.sources?.[0] ?? record.source;
        const tx = chain === "Ethereum" ? source.ethTx : record.cc3Tx;
        const block = chain === "Ethereum" ? source.ethBlock : record.cc3Block;
        const calls = [];
        const provider = chain === "Ethereum" ? f.ethProvider : f.cc3Provider;
        const send = provider.send;
        provider.send = (method, params) => {
          if (method === "eth_getTransactionReceipt" && params[0] === tx)
            return null;
          if (
            method === "eth_getBlockByNumber" &&
            params[0] === toQuantity(block)
          ) {
            calls.push(params);
            if (mode === "unavailable") throw new Error("block unavailable");
            if (mode === "malformed") return {};
            return {
              number: toQuantity(block + (mode === "wrong block" ? 1 : 0)),
              hash,
              transactions:
                mode === "present"
                  ? [tx.toUpperCase().replace("0X", "0x")]
                  : mode === "malformed hash"
                    ? ["invalid"]
                    : [],
            };
          }
          return send(method, params);
        };
        const report = await runJudgeVerification(f);
        const row = report.checks.find(
          (row) =>
            row.id === `${chain === "Ethereum" ? "ethereum" : "v1"}-${name}`,
        );
        assert.equal(
          row.status,
          mode === "absent" ? "FAIL" : "UNVERIFIED",
          JSON.stringify(row),
        );
        assert.equal(
          row.detail,
          mode === "absent"
            ? `block ${block} exists and does not contain the transaction`
            : mode === "present"
              ? `transaction is in block ${block} but no node returned its receipt`
              : "no receipt and no block returned",
        );
        assert.deepEqual(calls, [[toQuantity(block), false]]);
      });
    }
  }
}

for (const mode of ["absent", "present", "unavailable", "wrong identity"]) {
  test(`AN Ethereum fallback membership: ${mode}`, async (t) => {
    const f = fixture(t);
    f.ethProvider = undefined;
    const fetch = f.fetchImpl;
    const urls = [
      "https://ethereum-rpc.publicnode.com",
      "https://eth.drpc.org",
      "https://1rpc.io/eth",
    ];
    const calls = [];
    f.fetchImpl = async (url, options) => {
      if (!urls.includes(url)) return fetch(url, options);
      const { method, params } = JSON.parse(options.body);
      calls.push([url, method, params]);
      let result;
      if (method === "eth_chainId")
        result = mode === "wrong identity" && url === urls[1] ? "0x2" : "0x1";
      else if (method === "eth_getTransactionReceipt")
        result =
          mode === "wrong identity" && url === urls[2]
            ? f.receipts[params[0]]
            : null;
      else {
        assert.equal(method, "eth_getBlockByNumber");
        if (url === urls[0]) throw new Error("block unavailable");
        if (url === urls[1] || mode === "unavailable") result = {};
        else
          result = {
            number: params[0],
            hash,
            transactions: mode === "present" ? Object.keys(f.receipts) : [],
          };
      }
      return { ok: true, json: async () => ({ result }) };
    };
    const report = await runJudgeVerification(f);
    for (const name of ["cumulativeBatch", "autonomousCatch"]) {
      const row = report.checks.find((row) => row.id === `ethereum-${name}`);
      assert.equal(
        row.status,
        mode === "absent"
          ? "FAIL"
          : mode === "wrong identity"
            ? "PASS"
            : "UNVERIFIED",
        JSON.stringify(row),
      );
      assert.match(
        row.detail,
        mode === "absent"
          ? /exists and does not contain/
          : mode === "present"
            ? /but no node returned its receipt/
            : mode === "wrong identity"
              ? /skipped Ethereum nodes:.*chain ID differs from 1/
              : /no receipt and no block returned/,
      );
    }
    if (mode === "wrong identity") {
      assert.ok(
        !calls.some(
          ([url, method]) => url === urls[1] && method !== "eth_chainId",
        ),
      );
    } else {
      for (const url of urls)
        assert.ok(
          calls.some(
            ([node, method, params]) =>
              node === url &&
              method === "eth_getBlockByNumber" &&
              params[0] ===
                toQuantity(f.evidence.autonomousCatch.source.ethBlock) &&
              params[1] === false,
          ),
        );
    }
  });
}

test("transport refuses to follow redirects away from the requested host", async (t) => {
  const f = fixture(t);
  const originalFetch = f.fetchImpl;
  let sawRedirectPolicy = null;
  f.fetchImpl = async (url, options) => {
    if (String(url).includes("recourse.gudman.xyz/v3.html")) {
      sawRedirectPolicy = options?.redirect ?? null;
      const error = new Error("unexpected redirect");
      error.name = "TypeError";
      throw error;
    }
    return originalFetch(url, options);
  };
  const report = await runJudgeVerification(f);
  assert.equal(
    sawRedirectPolicy,
    "error",
    "every outbound request must forbid redirects so a hostile endpoint cannot steer the judge's machine",
  );
  assert.equal(
    report.checks.find((check) => check.id === "site-v3.html").status,
    "UNVERIFIED",
  );
});

test("an oversized streamed body is cut off instead of being buffered whole", async (t) => {
  const f = fixture(t);
  const originalFetch = f.fetchImpl;
  let bytesPulled = 0;
  let jsonCalled = false;
  let cancelled = false;
  f.fetchImpl = async (url, options) => {
    if (String(url).includes("registry.npmjs.org")) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: {
          getReader() {
            return {
              async read() {
                bytesPulled += 512;
                return { done: false, value: new Uint8Array(512) };
              },
              async cancel() {
                cancelled = true;
              },
            };
          },
        },
        json: async () => {
          jsonCalled = true;
          return {};
        },
      };
    }
    return originalFetch(url, options);
  };
  const report = await runJudgeVerification({ ...f, maxResponseBytes: 1024 });
  assert.equal(jsonCalled, false, "a streamed body must not be handed to response.json()");
  assert.ok(
    bytesPulled <= 1024 + 512,
    `reading must stop at the limit; pulled ${bytesPulled} bytes`,
  );
  assert.equal(cancelled, true, "the stream must be cancelled once the limit is passed");
  assert.equal(report.checks.find((check) => check.id === "npm-sdk").status, "UNVERIFIED");
});

test("an oversized content-length is rejected before the body is touched", async (t) => {
  const f = fixture(t);
  const originalFetch = f.fetchImpl;
  let readerRequested = false;
  let jsonCalled = false;
  f.fetchImpl = async (url, options) => {
    if (String(url).includes("registry.npmjs.org")) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "999999999" }),
        body: {
          getReader() {
            readerRequested = true;
            return { async read() { return { done: true }; }, async cancel() {} };
          },
        },
        json: async () => {
          jsonCalled = true;
          return {};
        },
      };
    }
    return originalFetch(url, options);
  };
  const report = await runJudgeVerification({ ...f, maxResponseBytes: 1024 });
  assert.equal(readerRequested, false, "a declared oversize must short-circuit before reading");
  assert.equal(jsonCalled, false, "a declared oversize must not be parsed");
  assert.equal(report.checks.find((check) => check.id === "npm-sdk").status, "UNVERIFIED");
});
