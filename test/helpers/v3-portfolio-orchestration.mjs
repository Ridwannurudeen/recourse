import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AbiCoder,
  Interface,
  Transaction,
  Wallet,
  ZeroHash,
  getCreateAddress,
  keccak256,
} from "ethers";
import { runPortfolioActivation } from "../../scripts/activate-v3-portfolio.mjs";
import {
  createPortfolioApproval,
  validatePortfolioConfig,
} from "../../scripts/lib/v3-portfolio-activation.mjs";
import {
  activationJournalPath,
  readV3ActivationJournal,
} from "../../scripts/lib/v3-activation.mjs";
import {
  chainFixture,
  fixture,
  repositoryState,
} from "./v3-portfolio-fixture.mjs";

const abi = AbiCoder.defaultAbiCoder();

function signingFixture(wallets) {
  const original = fixture();
  let text = JSON.stringify({
    input: original.input,
    manifests: original.manifests,
  });
  for (const role of ["manager", "investor", "borrower"])
    text = text.replaceAll(original.config.roles[role], wallets[role].address);
  const { input, manifests } = JSON.parse(text);
  const configurationType = manifests.artifacts.policy.abi.find(
    (item) => item.type === "function" && item.name === "configure",
  ).inputs[2];
  const configHash = keccak256(
    abi.encode(
      [configurationType],
      [manifests.activation.policy.configuration],
    ),
  );
  manifests.activation.policy.configurationHash = configHash;
  const commitment = keccak256(
    abi.encode(
      ["bytes32", "uint256", "address", "bytes32", "uint8"],
      [ZeroHash, 1, manifests.activation.policy.evaluator, configHash, 1],
    ),
  );
  manifests.activation.facility.policySetCommitment = commitment;
  manifests.portfolio.constructors.PortfolioMandateV1.values[5] = commitment;
  const registry = manifests.activation.registry;
  registry.runtimeCodeHash = keccak256("0x60006000");
  registry.runtimeVariantId = keccak256(
    abi.encode(
      ["bytes32", "bytes32", "bytes32"],
      [
        registry.releaseId,
        registry.runtimeCodeHash,
        registry.constructorArgumentsHash,
      ],
    ),
  );
  return {
    input,
    manifests,
    config: validatePortfolioConfig(input, manifests),
  };
}

function expectedCalls(config, manifests) {
  const pool = manifests.portfolio.contracts.PortfolioPoolV1;
  const facility = getCreateAddress({
    from: manifests.portfolio.contracts.CappedPilotFactoryV1,
    nonce: 1,
  });
  const registry = manifests.activation.core.policyRegistry;
  const kernel = manifests.activation.core.policyKernel;
  const policy = manifests.activation.policy.evaluator;
  const asset = manifests.activation.asset.address;
  const r = manifests.activation.registry;
  const configuration = manifests.activation.policy.configuration;
  const policyInterface = new Interface(manifests.artifacts.policy.abi);
  const configurationType = policyInterface.getFunction("configure").inputs[2];
  const manifestHash = keccak256(
    abi.encode([configurationType], [configuration]),
  );
  const deploymentId = keccak256(
    abi.encode(
      [
        "uint256",
        "address",
        "bytes32",
        "address",
        "address",
        "uint256",
        "address",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
        "bytes32",
      ],
      [
        102031,
        registry,
        r.releaseId,
        kernel,
        facility,
        1,
        policy,
        r.runtimeVariantId,
        r.runtimeCodeHash,
        keccak256(abi.encode(["address"], [kernel])),
        manifestHash,
        manifestHash,
      ],
    ),
  );
  const commitment = keccak256(
    abi.encode(
      ["bytes32", "uint256", "address", "bytes32", "uint8"],
      [ZeroHash, 1, policy, manifestHash, 1],
    ),
  );
  const rows = [
    [
      pool,
      "pool",
      "createFacility",
      [
        100000000000n,
        20000000000n,
        200,
        config.qualificationBlock.number + 80000,
        10,
      ],
      "0xde463fae",
      "manager",
      46,
    ],
    [
      pool,
      "pool",
      "configureAndRegisterPolicy",
      [
        facility,
        1,
        policy,
        policyInterface.encodeFunctionData("configure", [
          facility,
          1,
          configuration,
        ]),
      ],
      "0x921776da",
      "manager",
      47,
    ],
    [
      registry,
      "registry",
      "recordDeployment",
      [r.releaseId, kernel, facility, 1, r.runtimeVariantId],
      "0x1020df75",
      "manager",
      48,
    ],
    [
      pool,
      "pool",
      "registerCandidate",
      [facility, deploymentId],
      "0x90fa99e5",
      "manager",
      49,
    ],
    [
      pool,
      "pool",
      "registerInvestor",
      [config.roles.investor],
      "0x691c9484",
      "manager",
      50,
    ],
    [pool, "pool", "openFunding", [], "0xad331767", "manager", 51],
    [
      asset,
      "asset",
      "approve",
      [pool, 100000000000n],
      "0x095ea7b3",
      "investor",
      22,
    ],
    [pool, "pool", "deposit", [100000000000n], "0xb6b55f25", "investor", 23],
    [
      asset,
      "asset",
      "approve",
      [facility, 20000000000n],
      "0x095ea7b3",
      "borrower",
      20,
    ],
    [
      facility,
      "facility",
      "postBond",
      [20000000000n],
      "0xd89b73d0",
      "borrower",
      21,
    ],
    [pool, "pool", "activate", [], "0x0f15f4c0", "manager", 52],
    [
      pool,
      "pool",
      "allocate",
      [facility, 100000000000n],
      "0xb78b52df",
      "manager",
      53,
    ],
    [
      facility,
      "facility",
      "activate",
      [commitment],
      "0x59db6e85",
      "borrower",
      22,
    ],
  ];
  return {
    deploymentId,
    rows: rows.map(([to, artifact, method, args, selector, signer, nonce]) => {
      const iface = new Interface(
        artifact === "asset"
          ? ["function approve(address,uint256)"]
          : manifests.artifacts[artifact].abi,
      );
      const data = iface.encodeFunctionData(method, args);
      assert.equal(data.slice(0, 10), selector);
      return { to, data, signer, nonce };
    }),
  };
}

test("actual portfolio CLI orchestration preserves approval, guards, checkpoints and final manifest across all thirteen transactions", async (t) => {
  for (const scenario of [
    "single approval",
    "resume same approval",
    "renew expired approval",
    "foreign manager nonce",
    "foreign investor nonce",
    "foreign borrower nonce",
    "pre-sign state drift",
    "pre-broadcast state drift",
  ]) {
    await t.test(scenario, async (t) => {
      const directory = mkdtempSync(
        join(tmpdir(), "recourse-portfolio-orchestration-"),
      );
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const wallets = Object.fromEntries(
        ["manager", "investor", "borrower"].map((role) => [
          role,
          Wallet.createRandom(),
        ]),
      );
      const snapshots = await Promise.all(
        Array.from({ length: 14 }, (_, prefix) =>
          chainFixture(true, prefix, undefined, signingFixture(wallets)),
        ),
      );
      let prefix = 0;
      const { config, manifests, plan } = snapshots[0];
      const oracle = expectedCalls(config, manifests);
      assert.equal(plan.commitments.deploymentId, oracle.deploymentId);
      const manifestPath = join(directory, "allocation.json");
      const journalPath = activationJournalPath(manifestPath);
      const approvalPath = join(directory, "approval.json");
      let clock = config.qualificationBlock.timestamp;
      let approval = createPortfolioApproval({
        plan,
        config,
        targetBlock: config.qualificationBlock,
        repositoryState,
      });
      const saveApproval = () =>
        writeFileSync(approvalPath, JSON.stringify(approval));
      saveApproval();
      const transactions = new Map();
      const receipts = new Map();
      const signed = [];
      const broadcast = [];
      let reads = 0;
      let lastSignReads = 0;
      let lastBroadcastReads = 1;
      let stopped = false;
      let foreignRole;
      const provider = {
        getNetwork: async () => ({ chainId: 102031n }),
        getBlock: async (number) =>
          number === "latest"
            ? { ...snapshots[prefix].block, timestamp: clock }
            : number === approval.targetBlock.number
              ? approval.targetBlock
              : config.qualificationBlock,
        getCode: (...args) => snapshots[prefix].provider.getCode(...args),
        getBalance: (...args) => snapshots[prefix].provider.getBalance(...args),
        getTransactionCount: async (address) =>
          (await snapshots[prefix].provider.getTransactionCount(address)) +
          (foreignRole && address === config.roles[foreignRole] ? 1 : 0),
        getBlockNumber: async () => snapshots[prefix].block.number,
        getTransactionReceipt: async (hash) => {
          if (
            readV3ActivationJournal(journalPath).steps.some(
              (step) => step.status !== "confirmed",
            )
          )
            assert.equal(
              existsSync(manifestPath),
              false,
              "manifest must wait for all thirteen confirmations",
            );
          return receipts.get(hash) ?? null;
        },
        getTransaction: async (hash) => transactions.get(hash) ?? null,
        broadcastTransaction: async (raw) => {
          assert.ok(
            reads > lastSignReads,
            `step ${prefix + 1}: missing pre-broadcast assertCurrent`,
          );
          lastBroadcastReads = reads;
          assert.equal(
            existsSync(manifestPath),
            false,
            "manifest must not precede thirteen confirmed transactions",
          );
          const tx = Transaction.from(raw);
          assert.equal(
            readV3ActivationJournal(journalPath).steps[prefix].intent
              .rawTransaction,
            raw,
          );
          const expected = oracle.rows[prefix];
          assert.equal(tx.to, expected.to);
          assert.equal(tx.data, expected.data);
          assert.equal(tx.from, config.roles[expected.signer]);
          assert.equal(tx.nonce, expected.nonce);
          const logs = [];
          if (prefix === 0) {
            const iface = new Interface(manifests.artifacts.pool.abi);
            logs.push({
              address: expected.to,
              ...iface.encodeEventLog(iface.getEvent("FacilityCreated"), [
                plan.predictedFacility,
              ]),
            });
          }
          const movement =
            prefix === 7
              ? [config.roles.investor, plan.addresses.pool, 100000000000n]
              : prefix === 9
                ? [config.roles.borrower, plan.predictedFacility, 20000000000n]
                : prefix === 11
                  ? [plan.addresses.pool, plan.predictedFacility, 100000000000n]
                  : undefined;
          if (movement) {
            const iface = new Interface([
              "event Transfer(address indexed from,address indexed to,uint256 value)",
            ]);
            logs.push({
              address: plan.addresses.asset,
              ...iface.encodeEventLog(iface.getEvent("Transfer"), movement),
            });
          }
          transactions.set(tx.hash, tx);
          receipts.set(tx.hash, {
            hash: tx.hash,
            status: 1,
            blockNumber: config.qualificationBlock.number + prefix,
            blockHash: config.qualificationBlock.hash,
            logs,
          });
          broadcast.push(raw);
          prefix += 1;
        },
        destroy: () => {},
      };
      const contracts = Object.fromEntries(
        Object.entries(snapshots[13].contracts).map(([name, methods]) => [
          name,
          Object.fromEntries(
            Object.keys(methods).map((method) => [
              method,
              (...args) => snapshots[prefix].contracts[name][method](...args),
            ]),
          ),
        ]),
      );
      contracts.pool.interface = new Interface(manifests.artifacts.pool.abi);
      contracts.pool.target = plan.addresses.pool;
      const dependencies = {
        inspectRepository: () => repositoryState,
        readInputs: () => {
          reads += 1;
          return { config, manifests };
        },
        createProvider: () => provider,
        createContracts: () => contracts,
        now: () => clock,
        createSigner: (role) => ({
          getAddress: async () => wallets[role].address,
          signTransaction: async (request) => {
            assert.ok(
              reads > lastBroadcastReads,
              `step ${prefix + 1}: missing pre-sign assertCurrent`,
            );
            lastSignReads = reads;
            signed.push(role);
            const raw = await wallets[role].signTransaction(request);
            if (scenario === "pre-broadcast state drift" && prefix === 4)
              snapshots[4].state.pool.status = 1;
            return raw;
          },
        }),
        log: () => {
          if (scenario === "pre-sign state drift" && prefix === 4)
            snapshots[4].state.pool.status = 1;
          if (
            prefix === 4 &&
            !stopped &&
            scenario !== "single approval" &&
            !scenario.endsWith("state drift")
          ) {
            stopped = true;
            throw new Error("simulated interruption after confirmed step");
          }
        },
      };
      const run = () =>
        runPortfolioActivation(
          [
            "--config",
            "fixture.json",
            "--manifest",
            manifestPath,
            "--live-check",
            "--broadcast",
            "--approved-plan",
            approvalPath,
            "--approval-commitment",
            approval.approvalCommitment,
          ],
          dependencies,
        );
      if (scenario.endsWith("state drift")) {
        await assert.rejects(run(), /pool\.status mismatch/);
        assert.equal(
          signed.length,
          scenario === "pre-sign state drift" ? 4 : 5,
        );
        assert.equal(broadcast.length, 4);
        assert.equal(existsSync(manifestPath), false);
        return;
      }
      if (scenario !== "single approval") {
        await assert.rejects(
          run(),
          /simulated interruption after confirmed step/,
        );
        const checkpoint = readV3ActivationJournal(journalPath);
        assert.equal(
          checkpoint.steps.filter((step) => step.status === "confirmed").length,
          4,
        );
        assert.equal(existsSync(manifestPath), false);
        assert.equal(signed.length, 4);
        if (scenario.startsWith("foreign")) {
          foreignRole = scenario.split(" ")[1];
          await assert.rejects(run(), /nonce/i);
          assert.equal(
            signed.length,
            4,
            "foreign signer nonce must be refused before signing",
          );
          assert.equal(broadcast.length, 4);
          return;
        }
        if (scenario === "renew expired approval") {
          clock = approval.validUntil;
          await assert.rejects(run(), /expired/);
          assert.equal(signed.length, 4);
          approval = createPortfolioApproval({
            plan,
            config,
            targetBlock: { ...snapshots[4].block, timestamp: clock },
            journal: checkpoint,
            repositoryState,
          });
          saveApproval();
          const changed = structuredClone(checkpoint);
          changed.steps[0].receipt.blockHash = ZeroHash;
          writeFileSync(journalPath, JSON.stringify(changed));
          await assert.rejects(run(), /renewal|checkpoint|receipt/i);
          assert.equal(signed.length, 4);
          writeFileSync(journalPath, JSON.stringify(checkpoint));
        }
      }
      await run();
      assert.equal(signed.length, 13);
      assert.equal(broadcast.length, 13);
      assert.equal(new Set(broadcast).size, 13);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      assert.equal(manifest.status, "allocated-activated");
      assert.equal(
        manifest.approvedPlan.approvalCommitment,
        approval.approvalCommitment,
      );
      assert.equal(Object.keys(manifest.transactions).length, 13);
      assert.equal(
        readV3ActivationJournal(journalPath).steps.every(
          (step) => step.status === "confirmed",
        ),
        true,
      );
    });
  }
});
