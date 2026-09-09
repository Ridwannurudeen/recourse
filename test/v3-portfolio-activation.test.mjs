import "./helpers/v3-portfolio-orchestration.mjs";
import "./helpers/v3-portfolio-inputs.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AbiCoder,
  Interface,
  Transaction,
  Wallet,
  ZeroHash,
  getAddress,
  getCreateAddress,
  keccak256,
} from "ethers";
import { encodeConfigureMultiChainPolicy } from "../sdk/src/core.mjs";
import {
  buildPortfolioPlan,
  createPortfolioApproval,
  readPortfolioInputs,
  runPortfolioPreflight,
  validatePortfolioApproval,
  validatePortfolioConfig,
  verifyPortfolioFinal,
} from "../scripts/lib/v3-portfolio-activation.mjs";
import {
  buildV3LiveExecutionPlan,
  createV3ActivationJournal,
  createV3ActivationRenewalBinding,
  prepareV3ActivationStep,
  readV3ActivationJournal,
  reconcileV3ActivationStep,
  validateV3ActivationRenewalBinding,
} from "../scripts/lib/v3-activation.mjs";

import {
  HASH,
  repositoryState,
  fixture,
  chainFixture,
} from "./helpers/v3-portfolio-fixture.mjs";

test("portfolio preflight accepts a signerless clean chain and rejects every bound getter and starting-state mismatch", async () => {
  const f = await chainFixture();
  const result = await runPortfolioPreflight(f);
  assert.equal(result.confirmedSteps, 0);
  assert.deepEqual(result.pendingNonces, {
    manager: 46,
    investor: 22,
    borrower: 20,
  });
  for (const [contract, members] of Object.entries(f.state)) {
    if (contract === "facility") continue;
    for (const [method, value] of Object.entries(members)) {
      if (
        [
          "evaluate",
          "facilityAt",
          "isFacility",
          "createdFacilityAt",
          "allocationOf",
        ].includes(method)
      )
        continue;
      f.state[contract][method] =
        typeof value === "boolean"
          ? !value
          : typeof value === "object"
            ? { ...value, exists: !value.exists }
            : "INVALID";
      await assert.rejects(
        runPortfolioPreflight(f),
        undefined,
        `${contract}.${method}`,
      );
      f.state[contract][method] = value;
    }
  }
  for (const role of ["manager", "investor", "borrower"]) {
    const address = f.config.roles[role];
    const balance = f.nativeBalances[address];
    f.nativeBalances[address] = 0n;
    await assert.rejects(runPortfolioPreflight(f), /Insufficient native/);
    f.nativeBalances[address] = balance;
    f.nonces[address] += 1;
    await assert.rejects(runPortfolioPreflight(f), /nonce/);
    f.nonces[address] -= 1;
  }
  for (const role of ["investor", "borrower"]) {
    const address = f.config.roles[role],
      balance = f.balances[address];
    f.balances[address] = 0n;
    await assert.rejects(runPortfolioPreflight(f), /Insufficient asset/);
    f.balances[address] = balance;
  }
  for (const [owner, spender] of [
    [f.config.roles.investor, f.plan.addresses.pool],
    [f.config.roles.borrower, f.plan.predictedFacility],
    [f.plan.addresses.pool, f.plan.predictedFacility],
  ]) {
    const key = `${owner}:${spender}`;
    f.allowances[key] = 1n;
    await assert.rejects(runPortfolioPreflight(f), /allowance/);
    delete f.allowances[key];
  }
  await assert.rejects(
    runPortfolioPreflight({
      ...f,
      repositoryState: { ...repositoryState, deployableScopeClean: false },
    }),
    /scope must be clean/,
  );
  for (const override of [
    { getNetwork: async () => ({ chainId: 1n }) },
    { getBlock: async () => ({ ...f.block, hash: HASH("5") }) },
    { getCode: async () => "0x" },
    { getCode: async () => "0x6001" },
    { getTransactionCount: async () => 2 },
  ])
    await assert.rejects(
      runPortfolioPreflight({ ...f, provider: { ...f.provider, ...override } }),
    );
  const timestamp = f.block.timestamp;
  f.block.timestamp =
    Number(f.manifests.portfolio.constructors.PortfolioPoolV1.values[6]) - 3600;
  await assert.rejects(runPortfolioPreflight(f), /one-hour/);
  f.block.timestamp = timestamp;
});

test("portfolio inputs require a Git-tracked config and help rejects implicit broadcast without reading signer material", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "recourse-portfolio-input-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const initialized = spawnSync("git", ["init", "--quiet", directory], {
    encoding: "utf8",
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  writeFileSync(join(directory, "input.json"), JSON.stringify(fixture().input));
  assert.throws(
    () => readPortfolioInputs("input.json", directory),
    /tracked by Git/,
  );
  const help = spawnSync(
    process.execPath,
    ["scripts/activate-v3-portfolio.mjs", "--help"],
    {
      encoding: "utf8",
      env: { ...process.env, CREDITCOIN_RPC_URL: "invalid-url" },
    },
  );
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /no RPC, signer, or file writes/);
  const invalid = spawnSync(
    process.execPath,
    ["scripts/activate-v3-portfolio.mjs", "--broadcast"],
    { encoding: "utf8" },
  );
  assert.notEqual(invalid.status, 0);
  assert.match(
    invalid.stderr,
    /requires --live-check, --approved-plan, and --approval-commitment/,
  );
});

test("portfolio recovery qualifies every transaction prefix and permits completed finalization after the funding deadline", async () => {
  for (let prefix = 0; prefix <= 13; prefix += 1) {
    const f = await chainFixture(true, prefix);
    const journal = {
      ...f.plan,
      steps: f.plan.transactionPlan.map((step, index) =>
        index < prefix
          ? {
              ...step,
              status: "confirmed",
              intent: {
                ...f.plan.executionPlan.steps[index],
                transactionHash: keccak256(new Uint8Array([index])),
              },
              receipt: {
                hash: keccak256(new Uint8Array([index])),
                blockNumber: f.config.qualificationBlock.number,
                blockHash: f.config.qualificationBlock.hash,
                status: 1,
              },
            }
          : { ...step, status: "planned" },
      ),
    };
    const result = await runPortfolioPreflight({ ...f, journal });
    assert.equal(result.confirmedSteps, prefix);
    if (prefix === 13) {
      f.block.timestamp = Number(f.state.pool.fundingDeadline) + 1;
      assert.equal(
        (await runPortfolioPreflight({ ...f, journal })).confirmedSteps,
        13,
      );
    }
  }
});

for (const [label, deadlineOffset] of [
  ["one-hour boundary", -3600],
  ["after deadline", 1],
]) {
  test(`portfolio final-step recovery and approval renewal at ${label}`, async (t) => {
    const directory = mkdtempSync(
      join(tmpdir(), "recourse-portfolio-deadline-"),
    );
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    for (let prefix = 0; prefix <= 13; prefix += 1) {
      const f = await chainFixture(true, prefix);
      const journal = createV3ActivationJournal(
        join(directory, `journal-${prefix}.json`),
        {
          ...f.plan,
          preflight: {},
        },
      );
      journal.steps = journal.steps.map((step, index) =>
        index < prefix
          ? {
              ...step,
              status: "confirmed",
              intent: {
                ...f.plan.executionPlan.steps[index],
                transactionHash: keccak256(new Uint8Array([index])),
              },
              receipt: {
                hash: keccak256(new Uint8Array([index])),
                blockNumber: f.config.qualificationBlock.number,
                blockHash: f.config.qualificationBlock.hash,
                status: 1,
              },
            }
          : step,
      );
      f.block.timestamp = Number(f.state.pool.fundingDeadline) + deadlineOffset;
      if (prefix < 12) {
        await assert.rejects(
          runPortfolioPreflight({ ...f, journal }),
          /one-hour/,
          `prefix ${prefix}`,
        );
        continue;
      }
      assert.equal(
        (await runPortfolioPreflight({ ...f, journal })).confirmedSteps,
        prefix,
      );
      const approval = createPortfolioApproval({
        ...f,
        targetBlock: f.config.qualificationBlock,
      });
      const context = {
        ...f,
        journal,
        expectedApprovalCommitment: approval.approvalCommitment,
        now: f.block.timestamp,
      };
      assert.throws(
        () => validatePortfolioApproval(approval, context),
        /expired/,
      );
      const renewed = createPortfolioApproval({
        ...f,
        targetBlock: f.block,
        journal,
      });
      assert.equal(
        validatePortfolioApproval(renewed, {
          ...context,
          expectedApprovalCommitment: renewed.approvalCommitment,
        }),
        true,
      );
      assert.equal(
        (await runPortfolioPreflight({ ...f, journal })).confirmedSteps,
        prefix,
      );
      if (prefix === 12) {
        const changed = structuredClone(journal);
        changed.steps[11].receipt.blockHash = HASH("9");
        assert.throws(
          () =>
            validatePortfolioApproval(renewed, {
              ...context,
              journal: changed,
              expectedApprovalCommitment: renewed.approvalCommitment,
            }),
          /receipt changed/,
        );
        for (const [contract, method, value] of [
          ["facility", "status", 1],
          ["facility", "lenderFunded", 0],
          ["facility", "bondPosted", 0],
          ["kernel", "policySetCommitment", ZeroHash],
        ]) {
          const original = f.state[contract][method];
          f.state[contract][method] = value;
          await assert.rejects(
            runPortfolioPreflight({ ...f, journal }),
            /mismatch/,
          );
          f.state[contract][method] = original;
        }
        f.block.number =
          f.plan.maturityBlock -
          13 * f.config.transactionPolicy.targetConfirmations;
        await assert.rejects(
          runPortfolioPreflight({ ...f, journal }),
          /maturity bound or safety window/,
        );
      }
    }
  });
}

test("portfolio post-creation qualification refuses a facility absent from the factory mapping", async () => {
  for (const prefix of [1, 12, 13]) {
    const f = await chainFixture(true, prefix);
    const journal = {
      ...f.plan,
      steps: f.plan.transactionPlan.map((step, index) =>
        index < prefix
          ? {
              ...step,
              status: "confirmed",
              intent: {
                ...f.plan.executionPlan.steps[index],
                transactionHash: keccak256(new Uint8Array([index])),
              },
              receipt: {
                hash: keccak256(new Uint8Array([index])),
                blockNumber: f.config.qualificationBlock.number,
                blockHash: f.config.qualificationBlock.hash,
                status: 1,
              },
            }
          : { ...step, status: "planned" },
      ),
    };
    f.contracts.factory.isFacility = async (address, options) => {
      assert.equal(address, f.plan.predictedFacility);
      assert.equal(options.blockTag, f.block.number);
      return true;
    };
    assert.equal(
      (await runPortfolioPreflight({ ...f, journal })).confirmedSteps,
      prefix,
    );
    f.contracts.factory.isFacility = async () => false;
    await assert.rejects(
      runPortfolioPreflight({ ...f, journal }),
      /Factory facility registration/,
    );
  }
});

test("portfolio recovery recognizes a mined prepared transaction without modifying its persisted raw bytes", async (t) => {
  const wallet = Wallet.createRandom();
  const f = await chainFixture(true, 7, wallet.address);
  const directory = mkdtempSync(join(tmpdir(), "recourse-portfolio-mined-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const journalPath = join(directory, "journal.json");
  let journal = createV3ActivationJournal(journalPath, {
    ...f.plan,
    preflight: {},
  });
  journal.steps = journal.steps.map((step, index) =>
    index < 6
      ? {
          ...f.plan.transactionPlan[index],
          status: "confirmed",
          intent: {
            ...f.plan.executionPlan.steps[index],
            transactionHash: keccak256(new Uint8Array([index])),
          },
          receipt: {
            hash: keccak256(new Uint8Array([index])),
            blockNumber: f.config.qualificationBlock.number,
            blockHash: f.config.qualificationBlock.hash,
            status: 1,
          },
        }
      : step,
  );
  journal = await prepareV3ActivationStep({
    journal,
    journalPath,
    stepIndex: 6,
    signer: wallet,
    request: f.plan.requests[6],
    approvedTransaction: f.plan.executionPlan.steps[6],
  });
  const persisted = readFileSync(journalPath, "utf8");
  const transaction = Transaction.from(journal.steps[6].intent.rawTransaction);
  const receipt = {
    hash: transaction.hash,
    status: 1,
    blockNumber: f.config.qualificationBlock.number + 1,
    blockHash: f.config.qualificationBlock.hash,
  };
  f.provider.getTransactionReceipt = async () => receipt;
  f.provider.getTransaction = async () => transaction;
  const result = await runPortfolioPreflight({ ...f, journal });
  assert.equal(result.confirmedSteps, 7);
  assert.equal(journal.steps[6].status, "prepared");
  assert.equal(readFileSync(journalPath, "utf8"), persisted);
  receipt.status = 0;
  await assert.rejects(
    runPortfolioPreflight({ ...f, journal }),
    /Prepared transaction receipt failed/,
  );
  receipt.status = 1;
  receipt.blockHash = HASH("a");
  await assert.rejects(
    runPortfolioPreflight({ ...f, journal }),
    /Prepared receipt canonical block/,
  );
});

test("portfolio final verification reconciles all thirteen canonical receipts and rejects state, event and movement drift", async () => {
  const f = await chainFixture(true);
  const { plan, config } = f;
  const asset = new Interface([
    "event Transfer(address indexed from,address indexed to,uint256 value)",
  ]);
  const pool = new Interface(f.manifests.artifacts.pool.abi);
  const receipts = {},
    transactions = {};
  const steps = plan.transactionPlan.map((step, index) => {
    const approved = plan.executionPlan.steps[index];
    const hash = keccak256(new Uint8Array([index + 1]));
    const receipt = {
      hash,
      blockNumber: config.qualificationBlock.number + index,
      blockHash: config.qualificationBlock.hash,
      status: 1,
      logs: [],
    };
    if (index === 0)
      receipt.logs.push({
        address: plan.addresses.pool,
        ...pool.encodeEventLog(pool.getEvent("FacilityCreated"), [
          plan.predictedFacility,
        ]),
      });
    const transfer =
      index === 7
        ? [
            config.roles.investor,
            plan.addresses.pool,
            config.facility.facilityLimit,
          ]
        : index === 9
          ? [
              config.roles.borrower,
              plan.predictedFacility,
              config.facility.bondRequired,
            ]
          : index === 11
            ? [
                plan.addresses.pool,
                plan.predictedFacility,
                config.facility.facilityLimit,
              ]
            : undefined;
    if (transfer)
      receipt.logs.push({
        address: plan.addresses.asset,
        ...asset.encodeEventLog(asset.getEvent("Transfer"), transfer),
      });
    receipts[hash] = receipt;
    transactions[hash] = { ...approved, hash };
    return {
      ...step,
      status: "confirmed",
      intent: { ...approved, transactionHash: hash },
      receipt: {
        hash,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        status: 1,
      },
    };
  });
  const journal = { ...plan, steps };
  f.journal = journal;
  f.provider.getTransactionReceipt = async (hash) => receipts[hash];
  f.provider.getTransaction = async (hash) => transactions[hash];
  const result = await verifyPortfolioFinal(f);
  assert.equal(Object.keys(result.transactions).length, 13);
  assert.equal(result.assetMovement.reconciled, true);
  assert.equal(result.assetMovement.transfers.length, 3);
  assert.equal(result.pool.statusCode, 2);
  assert.equal(result.facility.statusCode, 1);
  const finalization = createPortfolioApproval({
    plan,
    config,
    targetBlock: f.block,
    journal,
    repositoryState,
  });
  const approvalOptions = {
    plan,
    config,
    journal,
    expectedApprovalCommitment: finalization.approvalCommitment,
    repositoryState,
    now: f.block.timestamp + 1,
  };
  assert.equal(validatePortfolioApproval(finalization, approvalOptions), true);
  assert.equal(finalization.renewal, undefined);
  assert.throws(
    () =>
      validatePortfolioApproval(finalization, {
        ...approvalOptions,
        now: finalization.validUntil,
      }),
    /expired/,
  );
  const alteredJournal = structuredClone(journal);
  alteredJournal.steps[0].receipt.blockHash = HASH("9");
  assert.throws(
    () =>
      validatePortfolioApproval(finalization, {
        ...approvalOptions,
        journal: alteredJournal,
      }),
    /Finalization checkpoint/,
  );
  assert.throws(
    () =>
      validatePortfolioApproval(finalization, {
        ...approvalOptions,
        journal: undefined,
      }),
    /thirteen confirmed/,
  );
  for (const [contract, method, value] of [
    ["pool", "status", 1],
    ["facility", "status", 0],
    ["facility", "lenderFunded", 0],
    ["facility", "bondPosted", 0],
    ["facility", "lender", config.roles.investor],
    ["mandate", "evaluate", 9],
    ["kernel", "policySetCommitment", ZeroHash],
  ]) {
    const original = f.state[contract][method];
    f.state[contract][method] = value;
    await assert.rejects(verifyPortfolioFinal(f));
    f.state[contract][method] = original;
  }
  f.balances[plan.addresses.pool] = 1n;
  await assert.rejects(verifyPortfolioFinal(f), /Pool asset balance/);
  f.balances[plan.addresses.pool] = 0n;
  const firstHash = steps[0].intent.transactionHash;
  const first = receipts[firstHash];
  for (const changed of [
    undefined,
    { ...first, status: 0 },
    { ...first, blockHash: HASH("8") },
    { ...first, logs: [] },
  ]) {
    receipts[firstHash] = changed;
    await assert.rejects(verifyPortfolioFinal(f));
  }
  receipts[firstHash] = first;
  const transferReceipt = receipts[steps[7].intent.transactionHash];
  const logs = transferReceipt.logs;
  transferReceipt.logs = [];
  await assert.rejects(
    verifyPortfolioFinal(f),
    /Asset movement reconciliation/,
  );
  transferReceipt.logs = logs;
  const transaction = transactions[firstHash];
  transactions[firstHash] = { ...transaction, nonce: transaction.nonce + 1 };
  await assert.rejects(verifyPortfolioFinal(f), /Canonical transaction nonce/);
  transactions[firstHash] = transaction;
  const number = f.block.number;
  f.block.number = first.blockNumber;
  await assert.rejects(verifyPortfolioFinal(f), /target confirmations/);
  f.block.number = number;
});

test("portfolio config rejects placeholders, changed exact terms, shared-account nonce divergence and fee policy drift", () => {
  const { input, manifests } = fixture();
  const example = JSON.parse(
    readFileSync("config/v3-portfolio-activation.example.json", "utf8"),
  );
  assert.throws(() => validatePortfolioConfig(example, manifests));
  for (const mutate of [
    (value) => {
      value.prerequisites.core.sha256 = "0".repeat(64);
    },
    (value) => {
      value.prerequisites.core.sha256 = "AB".repeat(32);
    },
    (value) => {
      value.roles.manager = "REPLACE_ME";
    },
    (value) => {
      value.facility.facilityLimit = "100000000001";
    },
    (value) => {
      value.facility.bondRequired = "19999999999";
    },
    (value) => {
      value.facility.maturityBlockOffset = 80001;
    },
    (value) => {
      value.expectedStartingNonces.issuer += 1;
    },
    (value) => {
      value.transactionPolicy.maximumTotalFeeWei = "780000000000000001";
    },
    (value) => {
      value.transactionPolicy.targetConfirmations = 1;
    },
    (value) => {
      value.signerEnvironment.investor = "DEPLOYER_PRIVATE_KEY";
    },
  ]) {
    const changed = structuredClone(input);
    mutate(changed);
    assert.throws(() => validatePortfolioConfig(changed, manifests));
  }
});

test("portfolio offline plan reproduces thirteen ABI calls, canonical account nonces and manifest commitments", async () => {
  const { config, manifests } = fixture();
  const first = await buildPortfolioPlan({
    config,
    manifests,
    repositoryState,
  });
  assert.deepEqual(
    first,
    await buildPortfolioPlan({ config, manifests, repositoryState }),
  );
  assert.equal(first.transactionPlan.length, 13);
  assert.deepEqual(
    first.transactionPlan.map((step) => step.name),
    [
      "createFacility",
      "configureAndRegisterPolicy",
      "recordRegistryDeployment",
      "registerCandidate",
      "registerInvestor",
      "openFunding",
      "approvePoolDeposit",
      "deposit",
      "approveBorrowerBond",
      "postBorrowerBond",
      "activatePool",
      "allocate",
      "activateFacility",
    ],
  );
  assert.deepEqual(
    first.executionPlan.steps.map((step) => step.signer),
    [
      "manager",
      "manager",
      "manager",
      "manager",
      "manager",
      "manager",
      "investor",
      "investor",
      "borrower",
      "borrower",
      "manager",
      "manager",
      "borrower",
    ],
  );
  assert.deepEqual(
    first.executionPlan.steps.map((step) => step.nonce),
    [46, 47, 48, 49, 50, 51, 22, 23, 20, 21, 52, 53, 22],
  );
  assert.equal(first.transactionPlan[2].role, "issuer");
  assert.equal(
    first.predictedFacility,
    getCreateAddress({
      from: manifests.portfolio.contracts.CappedPilotFactoryV1,
      nonce: 1,
    }),
  );
  const abi = AbiCoder.defaultAbiCoder();
  const commitment = keccak256(
    abi.encode(
      ["bytes32", "uint256", "address", "bytes32", "uint8"],
      [
        ZeroHash,
        1,
        manifests.activation.policy.evaluator,
        manifests.activation.policy.configurationHash,
        1,
      ],
    ),
  );
  assert.equal(first.commitments.policySetCommitment, commitment);
  assert.equal(commitment, manifests.activation.facility.policySetCommitment);
  assert.equal(
    first.commitments.policyConfigHash,
    manifests.activation.policy.configurationHash,
  );
  const configure = new Interface(
    manifests.artifacts.pool.abi,
  ).decodeFunctionData("configureAndRegisterPolicy", first.requests[1].data);
  assert.equal(
    configure[3],
    encodeConfigureMultiChainPolicy({
      facility: first.predictedFacility,
      policyId: 1,
      configuration: manifests.activation.policy.configuration,
    }),
  );
  const artifactKeys = [
    "pool",
    "pool",
    "registry",
    "pool",
    "pool",
    "pool",
    "asset",
    "pool",
    "asset",
    "facility",
    "pool",
    "pool",
    "facility",
  ];
  for (const [index, step] of first.executionPlan.steps.entries()) {
    const iface = new Interface(
      artifactKeys[index] === "asset"
        ? ["function approve(address,uint256)"]
        : manifests.artifacts[artifactKeys[index]].abi,
    );
    assert.equal(
      step.dataHash,
      keccak256(
        iface.encodeFunctionData(
          first.transactionPlan[index].method,
          first.transactionPlan[index].arguments,
        ),
      ),
    );
    assert.equal(step.from, config.roles[step.signer]);
  }
  assert.equal(first.maturityBlock, config.qualificationBlock.number + 80000);
  const shifted = await buildPortfolioPlan({
    config,
    manifests,
    repositoryState,
    qualificationBlock: {
      ...config.qualificationBlock,
      number: config.qualificationBlock.number + 1,
    },
  });
  assert.equal(shifted.maturityBlock, first.maturityBlock + 1);
  assert.notEqual(shifted.planCommitment, first.planCommitment);
  assert.equal(
    first.executionPlan.steps.reduce(
      (sum, step) => sum + BigInt(step.gasLimit) * BigInt(step.maxFeePerGas),
      0n,
    ),
    780000000000000000n,
  );
});

test("portfolio plan refuses impossible mandate, factory and funding deadline constraints", async () => {
  const { config, manifests } = fixture();
  for (const [contract, index, value] of [
    ["PortfolioPoolV1", 2, "99999999999"],
    ["PortfolioPoolV1", 6, String(config.qualificationBlock.timestamp + 3600)],
    ["CappedPilotFactoryV1", 7, "2001"],
    ["CappedPilotFactoryV1", 10, "9"],
    ["PortfolioMandateV1", 11, "79999"],
    ["PortfolioMandateV1", 7, HASH("1")],
  ]) {
    const changed = structuredClone(manifests);
    changed.portfolio.constructors[contract].values[index] = value;
    await assert.rejects(
      buildPortfolioPlan({ config, manifests: changed, repositoryState }),
    );
  }
  const changed = structuredClone(manifests);
  changed.activation.policy.configuration.watchThreshold += 1;
  await assert.rejects(
    buildPortfolioPlan({ config, manifests: changed, repositoryState }),
    /configuration hash/,
  );
});

test("portfolio approval binds nonce, calldata, source, qualification and thirty-minute expiry with journal renewal", async (t) => {
  const { config, manifests } = fixture();
  const plan = await buildPortfolioPlan({ config, manifests, repositoryState });
  const targetBlock = config.qualificationBlock;
  const approval = createPortfolioApproval({
    plan,
    config,
    targetBlock,
    repositoryState,
  });
  const options = {
    plan,
    config,
    expectedApprovalCommitment: approval.approvalCommitment,
    now: targetBlock.timestamp + 1,
    repositoryState,
  };
  assert.equal(validatePortfolioApproval(approval, options), true);
  assert.equal(approval.validUntil - targetBlock.timestamp, 1800);
  assert.throws(
    () =>
      validatePortfolioApproval(approval, {
        ...options,
        now: approval.validUntil,
      }),
    /expired/,
  );
  for (const mutate of [
    (value) => {
      value.executionPlan.steps[0].nonce += 1;
    },
    (value) => {
      value.executionPlan.steps[0].data = "0x1234";
    },
    (value) => {
      value.qualificationBlock.number += 1;
    },
    (value) => {
      value.sourceCommit = "2".repeat(40);
    },
    (value) => {
      value.validUntil += 1;
    },
  ]) {
    const changed = structuredClone(approval);
    mutate(changed);
    assert.throws(() => validatePortfolioApproval(changed, options));
  }
  const directory = mkdtempSync(join(tmpdir(), "recourse-portfolio-renewal-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const journal = createV3ActivationJournal(join(directory, "journal.json"), {
    ...plan,
    preflight: {},
  });
  const renewed = createPortfolioApproval({
    plan,
    config,
    targetBlock: { ...targetBlock, timestamp: approval.validUntil + 1 },
    journal,
    repositoryState,
  });
  assert.equal(
    validatePortfolioApproval(renewed, {
      ...options,
      journal,
      now: approval.validUntil + 2,
      expectedApprovalCommitment: renewed.approvalCommitment,
    }),
    true,
  );
  assert.throws(
    () =>
      validatePortfolioApproval(renewed, {
        ...options,
        now: approval.validUntil + 2,
        expectedApprovalCommitment: renewed.approvalCommitment,
      }),
    /requires its journal/,
  );
});

test("portfolio journal recovery preserves raw bytes and rejects inadequate receipt budgets before signing", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "recourse-portfolio-journal-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const journalPath = join(directory, "journal.json");
  const wallet = Wallet.createRandom();
  const request = { to: getAddress(`0x${"a".repeat(40)}`), data: "0x1234" };
  const transactionPlan = [
    { order: 1, name: "deposit", signer: "investor", ...request },
  ];
  const executionPlan = await buildV3LiveExecutionPlan({
    transactionPlan,
    requests: [request],
    signers: {
      investor: {
        getAddress: async () => wallet.address,
        populateTransaction: async (value) => ({
          ...value,
          type: 2,
          maxFeePerGas: 10n,
          maxPriorityFeePerGas: 1n,
        }),
      },
    },
    roles: { investor: wallet.address },
    chainId: 102031,
    startingNonces: { investor: 22 },
    feePolicy: {
      transactionType: "eip1559",
      maximumGasLimit: 6000000n,
      maximumFeePerGas: 10n,
      maximumPriorityFeePerGas: 1n,
    },
  });
  let journal = createV3ActivationJournal(journalPath, {
    chainId: 102031,
    configCommitment: HASH("1"),
    predictedFacility: request.to,
    commitments: { deploymentId: HASH("2") },
    transactionPlan,
    executionPlan,
    preflight: {},
  });
  let signatures = 0;
  const signer = {
    getAddress: async () => wallet.address,
    signTransaction: (value) => {
      signatures += 1;
      return wallet.signTransaction(value);
    },
  };
  const prepare = {
    journal,
    journalPath,
    stepIndex: 0,
    signer,
    request,
    approvedTransaction: executionPlan.steps[0],
  };
  await assert.rejects(
    prepareV3ActivationStep({
      ...prepare,
      targetConfirmations: 6,
      maximumReceiptPolls: 6,
      receiptPollIntervalMs: 1000,
    }),
    /6000.*90000/,
  );
  assert.equal(signatures, 0);
  assert.equal(readV3ActivationJournal(journalPath).steps[0].status, "planned");
  journal = await prepareV3ActivationStep(prepare);
  const raw = journal.steps[0].intent.rawTransaction;
  assert.equal(
    readV3ActivationJournal(journalPath).steps[0].intent.rawTransaction,
    raw,
  );
  const renewal = createV3ActivationRenewalBinding(journal);
  assert.equal(validateV3ActivationRenewalBinding(renewal, journal), true);
  const changed = structuredClone(journal);
  changed.steps[0].intent.transactionHash = HASH("3");
  assert.throws(
    () => validateV3ActivationRenewalBinding(renewal, changed),
    /transaction changed/,
  );
  const transaction = Transaction.from(raw);
  let receipt;
  const broadcastBytes = [];
  const provider = {
    getNetwork: async () => ({ chainId: 102031n }),
    getTransactionReceipt: async () => receipt,
    getTransaction: async () => (receipt ? transaction : null),
    getTransactionCount: async () => 22,
    getBlockNumber: async () => 105,
    getBlock: async () => ({ hash: HASH("4") }),
    broadcastTransaction: async (value) => {
      broadcastBytes.push(value);
      receipt = {
        hash: transaction.hash,
        blockNumber: 100,
        blockHash: HASH("4"),
        status: 1,
        logs: [],
      };
    },
  };
  await assert.rejects(
    reconcileV3ActivationStep({
      journal,
      journalPath,
      stepIndex: 0,
      provider,
      targetConfirmations: 6,
      maximumReceiptPolls: 6,
      receiptPollIntervalMs: 1000,
    }),
    /6000.*90000/,
  );
  assert.equal(broadcastBytes.length, 0);
  await assert.rejects(
    reconcileV3ActivationStep({
      journal,
      journalPath,
      stepIndex: 0,
      provider: { ...provider, getTransactionCount: async () => 23 },
    }),
    /advanced or replaced/,
  );
  assert.equal(broadcastBytes.length, 0);
  const result = await reconcileV3ActivationStep({
    journal: readV3ActivationJournal(journalPath),
    journalPath,
    stepIndex: 0,
    provider,
    targetConfirmations: 6,
    maximumReceiptPolls: 24,
    delay: async () => {},
  });
  assert.equal(result.journal.steps[0].status, "confirmed");
  assert.deepEqual(broadcastBytes, [raw]);
  assert.equal(signatures, 1);
  assert.equal(
    validateV3ActivationRenewalBinding(renewal, result.journal),
    true,
  );
});
