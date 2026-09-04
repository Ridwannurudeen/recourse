import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  Transaction,
  Wallet,
  ZeroAddress,
  ZeroHash,
  getAddress,
  id,
  keccak256,
  toUtf8Bytes,
  zeroPadValue,
} from "ethers";
import {
  applyArtifactImmutables,
  activationJournalPath,
  assessV3ActivationFreshness,
  assertFutureSourceWindow,
  assertV3ActivationStepSafety,
  buildV3ActivationPlan,
  buildV3LiveExecutionPlan,
  buildV3OfflineActivationPlan,
  createV3ActivationRenewalBinding,
  createV3ActivationJournal,
  createV3LivePlanReceipt,
  deriveFirstPilotFacilityAddress,
  initializeV3ActivationPersistence,
  parseV3ActivationArguments,
  prepareV3ActivationStep,
  readV3ActivationInputs,
  readV3ActivationJournal,
  reconcileV3ActivationStep,
  reserveV3ActivationManifest,
  runV3ActivationPreflight,
  validateV3ActivationJournal,
  validateApprovedV3ActivationPlan,
  validateV3ActivationRenewalBinding,
  validateV3ActivationConfig,
  verifyPinnedFacilityRuntime,
  verifyPinnedFactoryRuntime,
  verifyPinnedPolicyRuntime,
} from "../scripts/lib/v3-activation.mjs";

const ADDRESS = (digit) => getAddress(`0x${digit.repeat(40)}`);
const HASH = (byte) => `0x${byte.repeat(64)}`;

function approvedTransaction(name, signer, from, populated) {
  return {
    name,
    signer,
    chainId: Number(populated.chainId),
    nonce: populated.nonce,
    from: getAddress(from),
    to: getAddress(populated.to),
    data: populated.data,
    dataHash: keccak256(populated.data),
    value: BigInt(populated.value ?? 0).toString(),
    type: populated.type,
    gasLimit: BigInt(populated.gasLimit).toString(),
    gasPrice:
      populated.type === 0 ? BigInt(populated.gasPrice).toString() : null,
    maxFeePerGas:
      populated.type === 2 ? BigInt(populated.maxFeePerGas).toString() : null,
    maxPriorityFeePerGas:
      populated.type === 2
        ? BigInt(populated.maxPriorityFeePerGas).toString()
        : null,
  };
}

function runtimeArtifactWithImmutables(count) {
  let object = "60";
  const immutableReferences = {};
  for (let index = 0; index < count; index += 1) {
    immutableReferences[index + 1] = [{ start: object.length / 2, length: 32 }];
    object += "00".repeat(32);
  }
  object += "00";
  return {
    bytecode: { object: "0x6000" },
    deployedBytecode: {
      object: `0x${object}`,
      immutableReferences,
      linkReferences: {},
    },
  };
}

async function singleStepExecutionPlan({ plan, request, wallet, populated }) {
  const role = plan[0].signer;
  return buildV3LiveExecutionPlan({
    transactionPlan: plan,
    requests: [request],
    signers: {
      [role]: {
        getAddress: async () => wallet.address,
        populateTransaction: async (base) => ({
          ...base,
          type: populated.type,
          gasLimit: populated.gasLimit,
          ...(populated.type === 2
            ? {
                maxFeePerGas: populated.maxFeePerGas,
                maxPriorityFeePerGas: populated.maxPriorityFeePerGas,
              }
            : { gasPrice: populated.gasPrice }),
        }),
      },
    },
    roles: { [role]: wallet.address },
    chainId: Number(populated.chainId),
    startingNonces: { [role]: populated.nonce },
    feePolicy:
      populated.type === 2
        ? {
            transactionType: "eip1559",
            maximumGasLimit: BigInt(populated.gasLimit),
            maximumFeePerGas: BigInt(populated.maxFeePerGas),
            maximumPriorityFeePerGas: BigInt(populated.maxPriorityFeePerGas),
          }
        : {
            transactionType: "legacy",
            maximumGasLimit: BigInt(populated.gasLimit),
            maximumGasPrice: BigInt(populated.gasPrice),
          },
  });
}

function fixture() {
  const deployer = Wallet.createRandom();
  const lender = Wallet.createRandom();
  const borrower = Wallet.createRandom();
  const hunter = Wallet.createRandom();
  const roles = {
    deployer: deployer.address,
    lender: lender.address,
    borrower: borrower.address,
    guardian: hunter.address,
    hunter: hunter.address,
  };
  const core = {
    schemaVersion: 2,
    status: "deployed-qualified",
    generation: "v3-core",
    chainId: 102031,
    verifier: "0x0000000000000000000000000000000000000FD2",
    asset: { address: ADDRESS("1"), decimals: 6 },
    roles: Object.fromEntries(
      Object.entries(roles).filter(([name]) => name !== "hunter"),
    ),
    contracts: {
      policyKernel: ADDRESS("2"),
      verifiedCreditState: ADDRESS("3"),
      policyRegistry: ADDRESS("4"),
      cappedPilotFactory: ADDRESS("5"),
      multiChainEventPolicy: ADDRESS("6"),
      proofJobs: ADDRESS("7"),
    },
    runtimeCodeHashes: {
      PolicyKernelV2: HASH("a"),
      VerifiedCreditStateV1: HASH("b"),
      PolicyRegistryV1: HASH("c"),
      CappedPilotFactoryV1: HASH("d"),
      MultiChainEventPolicyV1: HASH("e"),
      ProofJobsV1: HASH("f"),
    },
    pilotBounds: {
      maximumFacilityLimit: "100000000000",
      maximumTotalLimit: "300000000000",
      minimumBondBps: 2000,
      maximumDrawFeeBps: 400,
      maximumMaturityBlocks: 100000,
      maximumDrawDelayBlocks: 50,
      maximumFacilityCount: 3,
    },
  };
  const input = {
    generation: "v3-pilot-activation",
    chainId: 102031,
    assetSymbol: "rUSD",
    coreManifest: { path: "deployments-v3.json", sha256: "ab".repeat(32) },
    roles,
    artifacts: {
      CappedPilotFactoryV1: {
        path: "out/factory.json",
        keccak256: HASH("7"),
      },
      MultiChainEventPolicyV1: {
        path: "out/policy.json",
        keccak256: HASH("8"),
      },
      RecourseFacilityV3: { path: "out/facility.json", keccak256: HASH("9") },
    },
    facility: {
      facilityLimit: "100000000000",
      bondRequired: "20000000000",
      drawFeeBps: 200,
      maturityBlock: 5_490_000,
      drawDelayBlocks: 10,
    },
    policy: {
      policyId: "1",
      configuration: {
        subject: roles.borrower,
        freshnessPeriod: 86_400,
        watchThreshold: 1,
        restrictedThreshold: 2,
        marginThreshold: 3,
        breachThreshold: 4,
        watchEffect: {
          outcome: 1,
          creditLimitBps: 10_000,
          futureDrawFeeBps: 200,
          freezePendingDraw: false,
          requireFreshEvidence: false,
          terminate: false,
        },
        restrictedEffect: {
          outcome: 2,
          creditLimitBps: 7_500,
          futureDrawFeeBps: 300,
          freezePendingDraw: true,
          requireFreshEvidence: true,
          terminate: false,
        },
        marginEffect: {
          outcome: 3,
          creditLimitBps: 5_000,
          futureDrawFeeBps: 400,
          freezePendingDraw: true,
          requireFreshEvidence: true,
          terminate: false,
        },
        breachEffect: {
          outcome: 4,
          creditLimitBps: 0,
          futureDrawFeeBps: 400,
          freezePendingDraw: true,
          requireFreshEvidence: true,
          terminate: true,
        },
        rules: [
          {
            sourceChain: 3,
            emitter: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            eventSignature: id("Transfer(address,address,uint256)"),
            startSourceBlock: 25_868_968,
            endSourceBlock: 25_918_968,
            topicCount: 3,
            subjectTopicIndex: 1,
            dataLength: 32,
            observedValueOffset: 0,
            observationKind: 4,
            riskWeight: 1,
          },
        ],
      },
    },
    registry: {
      packageName: "recourse-multi-chain-event-policy",
      version: "1.0.0-cc3-pilot",
      metadata: "Recourse MultiChainEventPolicyV1 CC3 pilot release 1.0.0",
      metadataHash: keccak256(
        toUtf8Bytes("Recourse MultiChainEventPolicyV1 CC3 pilot release 1.0.0"),
      ),
      evidenceKinds: [1],
      actionAdapters: [],
    },
    proofJob: {
      expiry: 1_788_696_000,
      revealWindowBlocks: 30,
      maxSuccessfulProofs: 3,
      proofReimbursement: "25000000",
      outcomeReward: "100000000",
      commitBond: "10000000",
      rewardOutcomeThreshold: 3,
    },
    sourceNetworks: {
      3: {
        evmChainId: 1,
        rpcUrlEnvironment: "ETH_MAINNET_RPC_URL",
      },
    },
    transactionPolicy: {
      targetConfirmations: 6,
      maximumReceiptPolls: 24,
      feePolicy: {
        transactionType: "eip1559",
        maximumGasLimit: "3000000",
        maximumFeePerGas: "100000000000",
        maximumPriorityFeePerGas: "5000000000",
      },
    },
    requirements: {
      minimumNativeWei: {
        deployer: "1000000000000000000",
        lender: "1000000000000000000",
        borrower: "1000000000000000000",
        hunter: "1000000000000000000",
      },
    },
  };
  return { core, input, signers: { deployer, lender, borrower, hunter } };
}

test("activation arguments are dry-run by default and reject implicit broadcasts", () => {
  assert.deepEqual(parseV3ActivationArguments([]), {
    help: false,
    broadcast: false,
    liveCheck: false,
    configPath: "config/v3-pilot-cc3.json",
    coreManifestPath: "deployments-v3.json",
    activationManifestPath: "activation-v3.json",
    writePlanPath: undefined,
    approvedPlanPath: undefined,
  });
  assert.deepEqual(
    parseV3ActivationArguments([
      "--live-check",
      "--broadcast",
      "--approved-plan",
      "approved-plan.json",
      "--config",
      "pilot.json",
      "--core-manifest",
      "core.json",
      "--manifest",
      "activation.json",
    ]),
    {
      help: false,
      broadcast: true,
      liveCheck: true,
      configPath: "pilot.json",
      coreManifestPath: "core.json",
      activationManifestPath: "activation.json",
      writePlanPath: undefined,
      approvedPlanPath: "approved-plan.json",
    },
  );
  assert.throws(
    () => parseV3ActivationArguments(["--broadcast"]),
    /requires --live-check and --approved-plan/,
  );
  assert.throws(
    () => parseV3ActivationArguments(["--send"]),
    /Unknown argument: --send/,
  );
  assert.equal(
    JSON.parse(readFileSync("package.json", "utf8")).scripts["activate:v3"],
    "node scripts/activate-v3-pilot.mjs",
  );
});

test("activation help exits without configuration or signing material and documents the fresh-manifest handoff", () => {
  assert.deepEqual(parseV3ActivationArguments(["--help"]), {
    help: true,
    broadcast: false,
    liveCheck: false,
    configPath: "config/v3-pilot-cc3.json",
    coreManifestPath: "deployments-v3.json",
    activationManifestPath: "activation-v3.json",
    writePlanPath: undefined,
    approvedPlanPath: undefined,
  });
  assert.equal(parseV3ActivationArguments(["-h"]).help, true);

  const result = spawnSync(
    process.execPath,
    ["scripts/activate-v3-pilot.mjs", "--help"],
    { cwd: resolve("."), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Default: deterministic offline dry-run/);
  assert.match(result.stdout, /deployments-v3-current\.json/);
  assert.match(result.stdout, /coreManifest\.sha256/);
  assert.equal(result.stderr, "");
});

test("activation binds an explicitly named fresh core manifest by path and SHA-256", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "recourse-v3-core-handoff-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { core, input } = fixture();
  const coreManifestPath = join(directory, "deployments-v3-current.json");
  const configPath = join(directory, "activation-current.json");
  const coreBytes = `${JSON.stringify(core, null, 2)}\n`;
  const sha256 = createHash("sha256").update(coreBytes).digest("hex");
  writeFileSync(coreManifestPath, coreBytes);
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        ...input,
        coreManifest: { path: "deployments-v3-current.json", sha256 },
      },
      null,
      2,
    )}\n`,
  );

  const loaded = readV3ActivationInputs(
    "activation-current.json",
    "deployments-v3-current.json",
    directory,
  );
  assert.equal(loaded.config.coreManifest.path, "deployments-v3-current.json");
  assert.equal(loaded.config.coreManifest.sha256, sha256);

  writeFileSync(join(directory, "deployments-v3.json"), coreBytes);
  assert.throws(
    () =>
      readV3ActivationInputs(
        "activation-current.json",
        "deployments-v3.json",
        directory,
      ),
    /core manifest path does not match --core-manifest/,
  );
});

test("offline activation planning is deterministic, signerless, and labels freshness as unchecked", () => {
  const { core, input } = fixture();
  const config = validateV3ActivationConfig(input, core);
  const artifact = {
    deployedBytecode: {
      object: `0x60${"00".repeat(32)}00`,
      immutableReferences: { 1: [{ start: 1, length: 32 }] },
      linkReferences: {},
    },
  };
  const activationArtifacts = {
    CappedPilotFactoryV1: { artifact: {}, hash: HASH("7") },
    MultiChainEventPolicyV1: { artifact, hash: HASH("8") },
    RecourseFacilityV3: { artifact: {}, hash: HASH("9") },
  };
  const first = buildV3OfflineActivationPlan({ config, activationArtifacts });
  const second = buildV3OfflineActivationPlan({ config, activationArtifacts });

  assert.deepEqual(first, second);
  assert.equal(
    first.predictedFacility,
    deriveFirstPilotFacilityAddress(core.contracts.cappedPilotFactory),
  );
  assert.equal(first.freshness.status, "unchecked");
  assert.equal(first.freshness.readyForBroadcast, false);
  assert.equal(first.transactionPlan.length, 13);
  assert.match(first.planCommitment, /^0x[0-9a-f]{64}$/);
});

test("multi-rule activation config requires exact source-network coverage and preserves every rule", () => {
  const { core, input } = fixture();
  const secondRule = {
    ...input.policy.configuration.rules[0],
    sourceChain: 1,
    emitter: ADDRESS("a"),
    startSourceBlock: 9_000,
    endSourceBlock: 10_000,
  };
  const multi = {
    ...input,
    sourceNetworks: {
      ...input.sourceNetworks,
      1: { evmChainId: 11155111, rpcUrlEnvironment: "SEPOLIA_RPC_URL" },
    },
    policy: {
      ...input.policy,
      configuration: {
        ...input.policy.configuration,
        rules: [...input.policy.configuration.rules, secondRule],
      },
    },
  };
  const normalized = validateV3ActivationConfig(multi, core);
  assert.equal(normalized.policy.configuration.rules.length, 2);
  assert.deepEqual(Object.keys(normalized.sourceNetworks), ["1", "3"]);
  assert.throws(
    () =>
      validateV3ActivationConfig(
        { ...multi, sourceNetworks: { 3: multi.sourceNetworks[3] } },
        core,
      ),
    /sourceNetworks must exactly cover policy source chains/,
  );
  assert.throws(
    () =>
      validateV3ActivationConfig(
        {
          ...multi,
          sourceNetworks: {
            ...multi.sourceNetworks,
            1: { evmChainId: 1, rpcUrlEnvironment: "SEPOLIA_RPC_URL" },
          },
        },
        core,
      ),
    /must bind CC3 key 1 to EVM chain 11155111/,
  );
});

test("freshness assessment distinguishes unchecked, stale, and broadcast-ready source windows", () => {
  const { core, input } = fixture();
  const config = validateV3ActivationConfig(input, core);
  assert.equal(assessV3ActivationFreshness({ config }).status, "unchecked");

  const stale = assessV3ActivationFreshness({
    config,
    targetState: { blockNumber: 5_400_000, timestamp: 1_788_091_545 },
    sourceStates: {
      3: {
        evmChainId: 1,
        head: input.policy.configuration.rules[0].startSourceBlock - 127,
        attestedHeight:
          input.policy.configuration.rules[0].startSourceBlock - 200,
      },
    },
  });
  assert.equal(stale.status, "stale");
  assert.equal(stale.readyForBroadcast, false);
  assert.match(stale.sources[0].reason, /128-block live buffer/);

  const ready = assessV3ActivationFreshness({
    config,
    targetState: { blockNumber: 5_400_000, timestamp: 1_788_091_545 },
    sourceStates: {
      3: {
        evmChainId: 1,
        head: input.policy.configuration.rules[0].startSourceBlock - 200,
        attestedHeight:
          input.policy.configuration.rules[0].startSourceBlock - 220,
      },
    },
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.readyForBroadcast, true);
});

test("broadcast approval binds the exact live plan and expires without weakening freshness checks", async () => {
  const wallet = Wallet.createRandom();
  const transactionPlan = [
    {
      order: 1,
      name: "step",
      signer: "lender",
      to: ADDRESS("d"),
      method: "ping",
      arguments: [],
    },
  ];
  const requests = [{ to: ADDRESS("d"), data: "0x1234" }];
  const roles = { lender: wallet.address };
  const feePolicy = {
    transactionType: "eip1559",
    maximumGasLimit: 100_000n,
    maximumFeePerGas: 100n,
    maximumPriorityFeePerGas: 5n,
  };
  const executionPlan = await buildV3LiveExecutionPlan({
    transactionPlan,
    requests,
    signers: {
      lender: {
        getAddress: async () => wallet.address,
        populateTransaction: async (request) => ({
          ...request,
          type: 2,
          maxFeePerGas: 10n,
          maxPriorityFeePerGas: 2n,
        }),
      },
    },
    roles,
    chainId: 102031,
    startingNonces: { lender: 4 },
    feePolicy,
  });
  const receipt = createV3LivePlanReceipt({
    configCommitment: HASH("1"),
    planCommitment: HASH("2"),
    predictedFacility: ADDRESS("b"),
    targetBlock: { number: 44, hash: HASH("3"), timestamp: 1_000 },
    sourceStates: {
      3: { head: 100, attestedHeight: 90, evmChainId: 1 },
    },
    validUntil: 1_300,
    executionPlan,
  });
  assert.equal(
    validateApprovedV3ActivationPlan(receipt, {
      configCommitment: HASH("1"),
      planCommitment: HASH("2"),
      predictedFacility: ADDRESS("b"),
      transactionPlan,
      requests,
      roles,
      chainId: 102031,
      feePolicy,
      now: 1_299,
    }),
    true,
  );
  assert.throws(
    () =>
      validateApprovedV3ActivationPlan(receipt, {
        configCommitment: HASH("1"),
        planCommitment: HASH("2"),
        predictedFacility: ADDRESS("b"),
        transactionPlan,
        requests,
        roles,
        chainId: 102031,
        feePolicy,
        now: 1_300,
      }),
    /expired/,
  );
  assert.throws(
    () =>
      validateApprovedV3ActivationPlan(receipt, {
        configCommitment: HASH("1"),
        planCommitment: HASH("4"),
        predictedFacility: ADDRESS("b"),
        transactionPlan,
        requests,
        roles,
        chainId: 102031,
        feePolicy,
        now: 1_100,
      }),
    /plan commitment mismatch/,
  );
});

test("activation config binds the core, exact policy, and all asset economics", () => {
  const { core, input } = fixture();
  const config = validateV3ActivationConfig(input, core);
  assert.equal(config.facility.facilityLimit, 100_000_000_000n);
  assert.equal(config.facility.bondRequired, 20_000_000_000n);
  assert.equal(config.proofJob.escrow, 175_000_000n);
  assert.equal(config.totals.assetTransferred, 120_175_000_000n);
  assert.equal(config.totals.assetApproved, 120_185_000_000n);
  assert.equal(config.roles.hunter, config.roles.guardian);
  assert.equal(config.transactionPolicy.feePolicy.transactionType, "eip1559");
  assert.equal(config.transactionPolicy.feePolicy.maximumGasLimit, 3_000_000n);
  assert.equal(
    config.policy.configuration.rules[0].eventSignature,
    id("Transfer(address,address,uint256)"),
  );

  assert.throws(
    () => validateV3ActivationConfig({ ...input, chainId: 1 }, core),
    /chainId must be 102031/,
  );
  assert.throws(
    () =>
      validateV3ActivationConfig(
        {
          ...input,
          facility: { ...input.facility, bondRequired: "19999999999" },
        },
        core,
      ),
    /bondRequired must be at least 20%/,
  );
  assert.throws(
    () =>
      validateV3ActivationConfig(
        {
          ...input,
          policy: {
            ...input.policy,
            configuration: {
              ...input.policy.configuration,
              subject: input.roles.lender,
            },
          },
        },
        core,
      ),
    /policy subject must equal borrower/,
  );
  assert.throws(
    () =>
      validateV3ActivationConfig(
        {
          ...input,
          policy: {
            ...input.policy,
            configuration: {
              ...input.policy.configuration,
              rules: [
                { ...input.policy.configuration.rules[0], endSourceBlock: 1 },
              ],
            },
          },
        },
        core,
      ),
    /source window/,
  );
  assert.throws(
    () =>
      validateV3ActivationConfig(
        {
          ...input,
          policy: {
            ...input.policy,
            configuration: {
              ...input.policy.configuration,
              watchEffect: {
                ...input.policy.configuration.watchEffect,
                freezePendingDraw: "false",
              },
            },
          },
        },
        core,
      ),
    /must be a boolean/,
  );
});

test("activation live execution planning rejects compromised RPC fee envelopes", async () => {
  const wallet = Wallet.createRandom();
  const target = ADDRESS("d");
  const transactionPlan = [
    {
      order: 1,
      name: "step",
      signer: "lender",
      to: target,
      method: "ping",
      arguments: [],
    },
  ];
  const common = {
    transactionPlan,
    requests: [{ to: target, data: "0x1234", value: 0n }],
    signers: {
      lender: {
        getAddress: async () => wallet.address,
        populateTransaction: async (request) => ({
          ...request,
          type: 2,
          maxFeePerGas: 101n,
          maxPriorityFeePerGas: 2n,
        }),
      },
    },
    roles: { lender: wallet.address },
    chainId: 102031,
    startingNonces: { lender: 4 },
    feePolicy: {
      transactionType: "eip1559",
      maximumGasLimit: 100_000n,
      maximumFeePerGas: 100n,
      maximumPriorityFeePerGas: 5n,
    },
  };
  await assert.rejects(
    () => buildV3LiveExecutionPlan(common),
    /maximumFeePerGas exceeds the configured maximum/,
  );
  await assert.rejects(
    () =>
      buildV3LiveExecutionPlan({
        ...common,
        signers: {
          lender: {
            getAddress: async () => wallet.address,
            populateTransaction: async (request) => ({
              ...request,
              type: 0,
              gasPrice: 2n,
            }),
          },
        },
      }),
    /requires an EIP-1559 transaction/,
  );
});

test("activation reservation fails closed and retains an interrupted lock", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "recourse-v3-activation-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifestPath = join(directory, "activation-v3.json");
  const release = reserveV3ActivationManifest(manifestPath);
  assert.equal(existsSync(`${manifestPath}.activation-lock`), true);
  if (process.platform !== "win32") {
    assert.equal(
      statSync(`${manifestPath}.activation-lock`).mode & 0o777,
      0o600,
    );
  }
  assert.throws(
    () => reserveV3ActivationManifest(manifestPath),
    /activation lock already exists/,
  );
  release();
  assert.equal(existsSync(`${manifestPath}.activation-lock`), false);

  writeFileSync(`${manifestPath}.activation-tmp`, "partial");
  assert.throws(
    () => reserveV3ActivationManifest(manifestPath),
    /temporary activation manifest already exists/,
  );
  assert.equal(existsSync(`${manifestPath}.activation-lock`), false);
});

test("dry-run persistence initialization writes no journal, lock, or temporary file", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "recourse-v3-dry-run-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifestPath = join(directory, "activation-v3.json");
  assert.equal(
    activationJournalPath(join(directory, "custom-manifest")),
    `${resolve(directory, "custom-manifest")}.activation-journal.json`,
  );
  const result = initializeV3ActivationPersistence({
    broadcast: false,
    manifestPath,
    lockMetadata: { configCommitment: HASH("1") },
    initialJournal: {},
  });
  assert.equal(existsSync(result.journalPath), false);
  assert.equal(existsSync(`${result.journalPath}.activation-tmp`), false);
  assert.equal(existsSync(`${manifestPath}.activation-lock`), false);
  assert.equal(existsSync(`${manifestPath}.activation-tmp`), false);
});

test("preflight verifies live empty state, four signers, exact allowances, and predicted first facility", async () => {
  const { core, input, signers } = fixture();
  const config = validateV3ActivationConfig(input, core);
  const predictedFacility = deriveFirstPilotFacilityAddress(
    core.contracts.cappedPilotFactory,
  );
  const policyArtifact = {
    deployedBytecode: {
      object: `0x60${"00".repeat(32)}00`,
      immutableReferences: { 1: [{ start: 1, length: 32 }] },
      linkReferences: {},
    },
  };
  const policyRuntime = applyArtifactImmutables(policyArtifact, {
    1: core.contracts.policyKernel,
  });
  const factoryArtifact = runtimeArtifactWithImmutables(12);
  const factoryRuntime = applyArtifactImmutables(
    factoryArtifact,
    Object.fromEntries(
      Object.keys(factoryArtifact.deployedBytecode.immutableReferences).map(
        (referenceId) => [referenceId, HASH("1")],
      ),
    ),
  );
  const codeAddresses = new Set(
    [
      core.asset.address,
      core.contracts.policyKernel,
      core.contracts.verifiedCreditState,
      core.contracts.policyRegistry,
      core.contracts.cappedPilotFactory,
      core.contracts.multiChainEventPolicy,
      core.contracts.proofJobs,
    ].map((address) => address.toLowerCase()),
  );
  const boundCore = {
    ...core,
    runtimeCodeHashes: {
      PolicyKernelV2: keccak256("0x6000"),
      VerifiedCreditStateV1: keccak256("0x6000"),
      PolicyRegistryV1: keccak256("0x6000"),
      CappedPilotFactoryV1: keccak256(factoryRuntime),
      MultiChainEventPolicyV1: keccak256(policyRuntime),
      ProofJobsV1: keccak256("0x6000"),
    },
  };
  const provider = {
    getNetwork: async () => ({ chainId: 102031n }),
    getBlock: async () => ({ number: 5_400_000, timestamp: 1_788_091_545 }),
    getCode: async (address) => {
      if (address === core.contracts.multiChainEventPolicy)
        return policyRuntime;
      if (address === core.contracts.cappedPilotFactory) return factoryRuntime;
      return codeAddresses.has(address.toLowerCase()) ? "0x6000" : "0x";
    },
    getBalance: async () => 2_000_000_000_000_000_000n,
  };
  const sourceProvider = {
    getNetwork: async () => ({ chainId: 1n }),
    getBlockNumber: async () => 25_867_968,
  };
  const asset = {
    decimals: async () => 6n,
    symbol: async () => "rUSD",
    balanceOf: async (address) => {
      if (address === config.roles.lender) return 200_000_000_000n;
      if (address === config.roles.borrower) return 20_000_000_000n;
      if (address === config.roles.hunter) return 10_000_000n;
      if (address === core.contracts.proofJobs) return 0n;
      return 0n;
    },
    allowance: async () => 0n,
  };
  const factory = {
    asset: async () => core.asset.address,
    kernel: async () => core.contracts.policyKernel,
    lender: async () => core.roles.lender,
    borrower: async () => core.roles.borrower,
    guardian: async () => core.roles.guardian,
    facilityCount: async () => 0n,
    totalFacilityLimit: async () => 0n,
    creationPaused: async () => false,
    maximumFacilityLimit: async () => 100_000_000_000n,
    maximumTotalLimit: async () => 300_000_000_000n,
    minimumBondBps: async () => 2_000n,
    maximumDrawFeeBps: async () => 400n,
    maximumMaturityBlocks: async () => 100_000n,
    maximumDrawDelayBlocks: async () => 50n,
    maximumFacilityCount: async () => 3n,
    connect() {
      return this;
    },
    createFacility: {
      staticCall: async () => predictedFacility,
    },
  };
  const contracts = {
    kernel: {
      verifier: async () => core.verifier,
      owner: async () => core.roles.deployer,
      creditState: async () => core.contracts.verifiedCreditState,
      proofJobs: async () => core.contracts.proofJobs,
      safeStaleProofRelease: async () => true,
    },
    registry: { releaseCount: async () => 0n },
    factory,
    policy: { context: async () => core.contracts.policyKernel },
    jobs: {
      kernel: async () => core.contracts.policyKernel,
      nextJobId: async () => 1n,
    },
  };
  const result = await runV3ActivationPreflight({
    provider,
    sourceProvider,
    attestedHeight: 25_867_930,
    signers,
    asset,
    contracts,
    config,
    coreManifest: boundCore,
    activationArtifacts: {
      CappedPilotFactoryV1: {
        hash: HASH("7"),
        artifact: factoryArtifact,
      },
      MultiChainEventPolicyV1: { hash: HASH("8"), artifact: policyArtifact },
      RecourseFacilityV3: { hash: HASH("9"), artifact: {} },
    },
  });
  assert.equal(result.predictedFacility, predictedFacility);
  assert.equal(result.initialAllowances.lenderFacility, 0n);
  assert.equal(result.initialAllowances.hunterProofJobs, 0n);
  assert.equal(result.sourceHead, 25_867_968);

  await assert.rejects(
    () =>
      runV3ActivationPreflight({
        provider: {
          ...provider,
          getCode: async (address) => {
            const code = await provider.getCode(address);
            return address === core.contracts.cappedPilotFactory
              ? `${code.slice(0, -2)}01`
              : code;
          },
        },
        sourceProvider,
        attestedHeight: 25_867_930,
        signers,
        asset,
        contracts,
        config,
        coreManifest: boundCore,
        activationArtifacts: {
          CappedPilotFactoryV1: {
            hash: HASH("7"),
            artifact: factoryArtifact,
          },
          MultiChainEventPolicyV1: {
            hash: HASH("8"),
            artifact: policyArtifact,
          },
          RecourseFacilityV3: { hash: HASH("9"), artifact: {} },
        },
      }),
    /CappedPilotFactoryV1 runtime bytecode does not match the pinned artifact/,
  );

  await assert.rejects(
    () =>
      runV3ActivationPreflight({
        provider,
        sourceProvider,
        attestedHeight: 25_867_930,
        signers,
        asset: { ...asset, allowance: async () => 1n },
        contracts,
        config,
        coreManifest: boundCore,
        activationArtifacts: {
          CappedPilotFactoryV1: {
            hash: HASH("7"),
            artifact: factoryArtifact,
          },
          MultiChainEventPolicyV1: {
            hash: HASH("8"),
            artifact: policyArtifact,
          },
          RecourseFacilityV3: { hash: HASH("9"), artifact: {} },
        },
      }),
    /allowance must be exactly zero/,
  );

  await assert.rejects(
    () =>
      runV3ActivationPreflight({
        provider: {
          ...provider,
          getCode: async (address) =>
            address === core.contracts.policyKernel
              ? "0x6001"
              : provider.getCode(address),
        },
        sourceProvider,
        attestedHeight: 25_867_930,
        signers,
        asset,
        contracts,
        config,
        coreManifest: boundCore,
        activationArtifacts: {
          CappedPilotFactoryV1: {
            hash: HASH("7"),
            artifact: factoryArtifact,
          },
          MultiChainEventPolicyV1: {
            hash: HASH("8"),
            artifact: policyArtifact,
          },
          RecourseFacilityV3: { hash: HASH("9"), artifact: {} },
        },
      }),
    /PolicyKernelV2 live runtime bytecode does not match the core manifest/,
  );
});

test("core manifest binding requires a qualified schema and every core runtime hash", () => {
  const { core, input } = fixture();
  assert.throws(
    () => validateV3ActivationConfig(input, { ...core, schemaVersion: 1 }),
    /core manifest schemaVersion must be 2/,
  );
  assert.throws(
    () => validateV3ActivationConfig(input, { ...core, status: "deployed" }),
    /core manifest status must be deployed-qualified/,
  );
  assert.throws(
    () =>
      validateV3ActivationConfig(input, {
        ...core,
        runtimeCodeHashes: undefined,
      }),
    /core manifest runtimeCodeHashes must be an object/,
  );
  assert.throws(
    () =>
      validateV3ActivationConfig(input, {
        ...core,
        runtimeCodeHashes: {
          ...core.runtimeCodeHashes,
          VerifiedCreditStateV1: undefined,
        },
      }),
    /core manifest runtimeCodeHashes\.VerifiedCreditStateV1 must be bytes32/,
  );
  assert.deepEqual(
    validateV3ActivationConfig(input, core).core.runtimeCodeHashes,
    {
      policyKernel: HASH("a"),
      verifiedCreditState: HASH("b"),
      policyRegistry: HASH("c"),
      cappedPilotFactory: HASH("d"),
      multiChainEventPolicy: HASH("e"),
      proofJobs: HASH("f"),
    },
  );
});

test("transaction plan is exact, ordered, and reports base and UI units", () => {
  const { core, input } = fixture();
  const config = validateV3ActivationConfig(input, core);
  const plan = buildV3ActivationPlan({
    config,
    coreManifest: core,
    predictedFacility: ADDRESS("b"),
    policyConfigHash: HASH("c"),
    releaseId: HASH("d"),
    runtimeVariantId: HASH("e"),
    deploymentId: HASH("f"),
    assetSymbol: "rUSD",
  });
  assert.deepEqual(
    plan.map(({ name }) => name),
    [
      "createFacility",
      "configurePolicy",
      "registerPolicy",
      "publishRegistryRelease",
      "recordRegistryDeployment",
      "approveFacilityFunding",
      "fundFacility",
      "approveBorrowerBond",
      "postBorrowerBond",
      "activateFacility",
      "approveProofJobEscrow",
      "createProofJob",
      "approveHunterCommitBond",
    ],
  );
  assert.deepEqual(plan[6].assetEffect, {
    type: "transfer",
    baseUnits: "100000000000",
    uiUnits: "100000.0",
    symbol: "rUSD",
  });
  assert.equal(plan.at(-1).assetEffect.type, "approval");
  assert.equal(plan.at(-1).assetEffect.baseUnits, "10000000");
  assert.equal(
    plan.some(({ name }) => name.toLowerCase().includes("draw")),
    false,
  );
  assert.equal(
    plan.some(({ method }) => method === "publishAuditArtifact"),
    false,
  );
  assert.notEqual(plan[0].to, ZeroAddress);
  assert.notEqual(plan[2].arguments.at(-1), ZeroAddress);
  assert.notEqual(plan[9].arguments[0], ZeroHash);
});

test("policy runtime verification patches every immutable kernel slot before comparing live code", () => {
  const kernel = ADDRESS("2");
  const artifact = {
    deployedBytecode: {
      object: `0x60${"00".repeat(32)}61${"00".repeat(32)}00`,
      immutableReferences: {
        17: [
          { start: 1, length: 32 },
          { start: 34, length: 32 },
        ],
      },
      linkReferences: {},
    },
  };
  const word = zeroPadValue(kernel, 32).slice(2);
  const expected = `0x60${word}61${word}00`;
  assert.equal(applyArtifactImmutables(artifact, { 17: kernel }), expected);
  assert.deepEqual(
    verifyPinnedPolicyRuntime({ artifact, kernel, liveCode: expected }),
    {
      expectedRuntimeCode: expected,
      runtimeCodeHash: keccak256(expected),
    },
  );
  assert.throws(
    () =>
      verifyPinnedPolicyRuntime({
        artifact,
        kernel,
        liveCode: `${expected.slice(0, -2)}01`,
      }),
    /runtime bytecode does not match/,
  );
});

test("factory and created-facility runtime verification pins all executable bytes around immutables", () => {
  const factoryArtifact = runtimeArtifactWithImmutables(12);
  const factoryValues = Object.fromEntries(
    Object.keys(factoryArtifact.deployedBytecode.immutableReferences).map(
      (referenceId) => [referenceId, HASH("a")],
    ),
  );
  const factoryRuntime = applyArtifactImmutables(
    factoryArtifact,
    factoryValues,
  );
  assert.equal(
    verifyPinnedFactoryRuntime({
      artifact: factoryArtifact,
      liveCode: factoryRuntime,
    }).runtimeCodeHash,
    keccak256(factoryRuntime),
  );
  assert.throws(
    () =>
      verifyPinnedFactoryRuntime({
        artifact: factoryArtifact,
        liveCode: `${factoryRuntime.slice(0, -2)}01`,
      }),
    /CappedPilotFactoryV1 runtime bytecode does not match the pinned artifact/,
  );

  const facilityArtifact = runtimeArtifactWithImmutables(9);
  const facilityRuntime = applyArtifactImmutables(
    facilityArtifact,
    Object.fromEntries(
      Object.keys(facilityArtifact.deployedBytecode.immutableReferences).map(
        (referenceId) => [referenceId, HASH("b")],
      ),
    ),
  );
  assert.equal(
    verifyPinnedFacilityRuntime({
      artifact: facilityArtifact,
      liveCode: facilityRuntime,
    }).runtimeCodeHash,
    keccak256(facilityRuntime),
  );
});

test("source-window guard requires a conservative strictly-future buffer at every guarded boundary", async () => {
  const rule = { startSourceBlock: 1_000, endSourceBlock: 2_000 };
  assert.equal(
    await assertFutureSourceWindow(
      { getBlockNumber: async () => 800 },
      rule,
      "before funding",
    ),
    800,
  );
  await assert.rejects(
    () =>
      assertFutureSourceWindow(
        { getBlockNumber: async () => 873 },
        rule,
        "before activation",
      ),
    /minimum 128-block buffer/,
  );
});

test("activation journal survives a crash and never rebroadcasts an already-mined successful step", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "recourse-v3-journal-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const journalPath = join(directory, "activation-v3.journal.json");
  const wallet = Wallet.createRandom();
  const target = ADDRESS("d");
  const plan = [
    {
      order: 1,
      name: "firstStep",
      signer: "deployer",
      to: target,
      method: "ping",
      arguments: ["7"],
      assetEffect: {
        type: "none",
        baseUnits: "0",
        uiUnits: "0.0",
        symbol: "rUSD",
      },
    },
  ];
  const populated = {
    type: 2,
    chainId: 102031,
    nonce: 4,
    to: target,
    value: 0,
    data: "0x1234",
    gasLimit: 50_000,
    maxFeePerGas: 2,
    maxPriorityFeePerGas: 1,
  };
  const executionPlan = await singleStepExecutionPlan({
    plan,
    request: { to: target, data: "0x1234" },
    wallet,
    populated,
  });
  const initial = createV3ActivationJournal(journalPath, {
    chainId: 102031,
    configCommitment: HASH("1"),
    predictedFacility: ADDRESS("b"),
    commitments: { releaseId: HASH("2") },
    transactionPlan: plan,
    executionPlan,
    preflight: { assetSymbol: "rUSD" },
  });
  assert.equal(initial.steps[0].status, "planned");
  assert.equal(existsSync(journalPath), true);
  if (process.platform !== "win32")
    assert.equal(statSync(journalPath).mode & 0o777, 0o600);
  const signer = {
    getAddress: async () => wallet.address,
    signTransaction: (request) => wallet.signTransaction(request),
  };
  const prepared = await prepareV3ActivationStep({
    journal: initial,
    journalPath,
    stepIndex: 0,
    signer,
    request: { to: target, data: "0x1234" },
    approvedTransaction: executionPlan.steps[0],
  });
  assert.equal(prepared.steps[0].status, "prepared");
  const signed = Transaction.from(prepared.steps[0].intent.rawTransaction);
  let receipt;
  let broadcasts = 0;
  const provider = {
    getNetwork: async () => ({ chainId: 102031n }),
    getTransactionReceipt: async () => receipt,
    getTransaction: async () => (receipt ? signed : null),
    getTransactionCount: async () => 4,
    broadcastTransaction: async (raw) => {
      broadcasts += 1;
      assert.equal(raw, prepared.steps[0].intent.rawTransaction);
      receipt = {
        hash: signed.hash,
        blockNumber: 44,
        blockHash: HASH("a"),
        status: 1,
        logs: [],
      };
      return { hash: signed.hash };
    },
    waitForTransaction: async () => receipt,
    getBlock: async () => ({ hash: HASH("a") }),
  };

  const resumed = readV3ActivationJournal(journalPath);
  validateV3ActivationJournal(resumed, {
    chainId: 102031,
    configCommitment: HASH("1"),
    predictedFacility: ADDRESS("b"),
    commitments: { releaseId: HASH("2") },
    transactionPlan: plan,
    executionPlan,
  });
  let approvalChecks = 0;
  let sourceChecks = 0;
  let expiryChecks = 0;
  await assert.rejects(
    reconcileV3ActivationStep({
      journal: resumed,
      journalPath,
      stepIndex: 0,
      provider,
      beforeBroadcast: () =>
        assertV3ActivationStepSafety({
          label: "Before broadcasting createFacility",
          requireSourceSafety: true,
          requireExpirySafety: true,
          assertApprovalCurrent: async () => {
            approvalChecks += 1;
          },
          assertSourceSafety: async () => {
            sourceChecks += 1;
            throw new Error("source proof window crossed");
          },
          assertExpiryCurrent: async () => {
            expiryChecks += 1;
          },
        }),
    }),
    /source proof window crossed/,
  );
  assert.equal(approvalChecks, 1);
  assert.equal(sourceChecks, 1);
  assert.equal(expiryChecks, 0);
  assert.equal(broadcasts, 0);
  assert.equal(
    readV3ActivationJournal(journalPath).steps[0].status,
    "prepared",
  );
  const confirmed = await reconcileV3ActivationStep({
    journal: resumed,
    journalPath,
    stepIndex: 0,
    provider,
  });
  assert.equal(confirmed.journal.steps[0].status, "confirmed");
  assert.equal(confirmed.journal.steps[0].intent.rawTransaction, undefined);
  assert.equal(broadcasts, 1);

  const afterReceiptCrash = readV3ActivationJournal(journalPath);
  const reconciledAgain = await reconcileV3ActivationStep({
    journal: afterReceiptCrash,
    journalPath,
    stepIndex: 0,
    provider,
  });
  assert.equal(reconciledAgain.journal.steps[0].receipt.hash, signed.hash);
  assert.equal(broadcasts, 1);
});

test("activation journal rejects a changed plan and reconciles a mined receipt without broadcasting", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "recourse-v3-mined-journal-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const journalPath = join(directory, "activation-v3.journal.json");
  const wallet = Wallet.createRandom();
  const target = ADDRESS("e");
  const plan = [
    {
      order: 1,
      name: "step",
      signer: "lender",
      to: target,
      method: "call",
      arguments: [],
    },
  ];
  const populated = {
    type: 2,
    chainId: 102031,
    nonce: 0,
    to: target,
    value: 0,
    data: "0xabcd",
    gasLimit: 50_000,
    maxFeePerGas: 2,
    maxPriorityFeePerGas: 1,
  };
  const executionPlan = await singleStepExecutionPlan({
    plan,
    request: { to: target, data: "0xabcd" },
    wallet,
    populated,
  });
  const journal = createV3ActivationJournal(journalPath, {
    chainId: 102031,
    configCommitment: HASH("3"),
    predictedFacility: ADDRESS("b"),
    commitments: { releaseId: HASH("4") },
    transactionPlan: plan,
    executionPlan,
    preflight: {},
  });
  const prepared = await prepareV3ActivationStep({
    journal,
    journalPath,
    stepIndex: 0,
    signer: {
      getAddress: async () => wallet.address,
      signTransaction: (request) => wallet.signTransaction(request),
    },
    request: { to: target, data: "0xabcd" },
    approvedTransaction: executionPlan.steps[0],
  });
  const signed = Transaction.from(prepared.steps[0].intent.rawTransaction);
  const receipt = {
    hash: signed.hash,
    blockNumber: 45,
    blockHash: HASH("b"),
    status: 1,
    logs: [],
  };
  let broadcasts = 0;
  const result = await reconcileV3ActivationStep({
    journal: readV3ActivationJournal(journalPath),
    journalPath,
    stepIndex: 0,
    provider: {
      getNetwork: async () => ({ chainId: 102031n }),
      getTransactionReceipt: async () => receipt,
      getTransaction: async () => signed,
      broadcastTransaction: async () => {
        broadcasts += 1;
      },
      waitForTransaction: async () => receipt,
      getBlock: async () => ({ hash: HASH("b") }),
    },
  });
  assert.equal(result.journal.steps[0].status, "confirmed");
  assert.equal(broadcasts, 0);
  assert.throws(
    () =>
      validateV3ActivationJournal(result.journal, {
        chainId: 102031,
        configCommitment: HASH("3"),
        predictedFacility: ADDRESS("b"),
        commitments: { releaseId: HASH("4") },
        transactionPlan: [{ ...plan[0], method: "changed" }],
        executionPlan,
      }),
    /transaction plan mismatch/,
  );
});

test("activation recovery refuses a missing transaction after nonce advancement and waits for canonical depth", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "recourse-v3-depth-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const journalPath = join(directory, "activation-v3.journal.json");
  const wallet = Wallet.createRandom();
  const target = ADDRESS("e");
  const plan = [
    {
      order: 1,
      name: "step",
      signer: "lender",
      to: target,
      method: "call",
      arguments: [],
    },
  ];
  const populated = {
    type: 2,
    chainId: 102031,
    nonce: 6,
    to: target,
    value: 0,
    data: "0xabcd",
    gasLimit: 50_000,
    maxFeePerGas: 2,
    maxPriorityFeePerGas: 1,
  };
  const executionPlan = await singleStepExecutionPlan({
    plan,
    request: { to: target, data: "0xabcd" },
    wallet,
    populated,
  });
  const initial = createV3ActivationJournal(journalPath, {
    chainId: 102031,
    configCommitment: HASH("5"),
    predictedFacility: ADDRESS("b"),
    commitments: { releaseId: HASH("6") },
    transactionPlan: plan,
    executionPlan,
    preflight: {},
  });
  const prepared = await prepareV3ActivationStep({
    journal: initial,
    journalPath,
    stepIndex: 0,
    signer: {
      getAddress: async () => wallet.address,
      signTransaction: (request) => wallet.signTransaction(request),
    },
    request: { to: target, data: "0xabcd" },
    approvedTransaction: executionPlan.steps[0],
  });
  let broadcasts = 0;
  await assert.rejects(
    () =>
      reconcileV3ActivationStep({
        journal: prepared,
        journalPath,
        stepIndex: 0,
        provider: {
          getNetwork: async () => ({ chainId: 102031n }),
          getTransactionReceipt: async () => null,
          getTransaction: async () => null,
          getTransactionCount: async () => 7,
          broadcastTransaction: async () => {
            broadcasts += 1;
          },
        },
      }),
    /nonce 6 was advanced or replaced/,
  );
  assert.equal(broadcasts, 0);

  const transaction = Transaction.from(prepared.steps[0].intent.rawTransaction);
  const receipt = {
    hash: transaction.hash,
    blockNumber: 50,
    blockHash: HASH("a"),
    status: 1,
    logs: [],
  };
  let head = 49;
  let delays = 0;
  const result = await reconcileV3ActivationStep({
    journal: prepared,
    journalPath,
    stepIndex: 0,
    targetConfirmations: 3,
    maximumReceiptPolls: 4,
    delay: async () => {
      delays += 1;
    },
    provider: {
      getNetwork: async () => ({ chainId: 102031n }),
      getTransactionReceipt: async () => receipt,
      getTransaction: async () => transaction,
      getBlockNumber: async () => {
        head += 1;
        return head;
      },
      getBlock: async () => ({ hash: HASH("a") }),
    },
  });
  assert.equal(result.journal.steps[0].status, "confirmed");
  assert.equal(delays, 2);
});

test("an expired partial activation restarts only with journal-bound human reapproval", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "recourse-v3-renewal-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const journalPath = join(directory, "activation-v3.journal.json");
  const wallet = Wallet.createRandom();
  const targets = [ADDRESS("d"), ADDRESS("e")];
  const transactionPlan = targets.map((to, index) => ({
    order: index + 1,
    name: `step${index + 1}`,
    signer: "lender",
    to,
    method: "call",
    arguments: [],
  }));
  const requests = targets.map((to, index) => ({
    to,
    data: index === 0 ? "0x1234" : "0x5678",
  }));
  const feePolicy = {
    transactionType: "eip1559",
    maximumGasLimit: 100_000n,
    maximumFeePerGas: 100n,
    maximumPriorityFeePerGas: 5n,
  };
  const executionPlan = await buildV3LiveExecutionPlan({
    transactionPlan,
    requests,
    signers: {
      lender: {
        getAddress: async () => wallet.address,
        populateTransaction: async (request) => ({
          ...request,
          type: 2,
          maxFeePerGas: 10n,
          maxPriorityFeePerGas: 2n,
        }),
      },
    },
    roles: { lender: wallet.address },
    chainId: 102031,
    startingNonces: { lender: 4 },
    feePolicy,
  });
  let journal = createV3ActivationJournal(journalPath, {
    chainId: 102031,
    configCommitment: HASH("1"),
    predictedFacility: ADDRESS("b"),
    commitments: { releaseId: HASH("2") },
    transactionPlan,
    executionPlan,
    preflight: {},
  });
  const signer = {
    getAddress: async () => wallet.address,
    signTransaction: (request) => wallet.signTransaction(request),
  };
  journal = await prepareV3ActivationStep({
    journal,
    journalPath,
    stepIndex: 0,
    signer,
    request: requests[0],
    approvedTransaction: executionPlan.steps[0],
  });
  const firstTransaction = Transaction.from(
    journal.steps[0].intent.rawTransaction,
  );
  const firstReceipt = {
    hash: firstTransaction.hash,
    blockNumber: 10,
    blockHash: HASH("a"),
    status: 1,
    logs: [],
  };
  journal = (
    await reconcileV3ActivationStep({
      journal,
      journalPath,
      stepIndex: 0,
      provider: {
        getNetwork: async () => ({ chainId: 102031n }),
        getTransactionReceipt: async () => firstReceipt,
        getTransaction: async () => firstTransaction,
        getBlock: async () => ({ hash: firstReceipt.blockHash }),
      },
    })
  ).journal;
  const initialApproval = createV3LivePlanReceipt({
    configCommitment: HASH("1"),
    planCommitment: HASH("3"),
    predictedFacility: ADDRESS("b"),
    targetBlock: { number: 1, hash: HASH("4"), timestamp: 1_000 },
    sourceStates: { 3: { head: 100, attestedHeight: 90, evmChainId: 1 } },
    validUntil: 1_100,
    executionPlan,
  });
  assert.throws(
    () =>
      validateApprovedV3ActivationPlan(initialApproval, {
        configCommitment: HASH("1"),
        planCommitment: HASH("3"),
        predictedFacility: ADDRESS("b"),
        transactionPlan,
        requests,
        roles: { lender: wallet.address },
        chainId: 102031,
        feePolicy,
        journal,
        now: 1_101,
      }),
    /expired/,
  );

  journal = readV3ActivationJournal(journalPath);
  const renewal = createV3ActivationRenewalBinding(journal);
  const renewedApproval = createV3LivePlanReceipt({
    configCommitment: HASH("1"),
    planCommitment: HASH("3"),
    predictedFacility: ADDRESS("b"),
    targetBlock: { number: 20, hash: HASH("5"), timestamp: 2_000 },
    sourceStates: { 3: { head: 110, attestedHeight: 100, evmChainId: 1 } },
    validUntil: 2_300,
    executionPlan,
    renewal,
  });
  assert.equal(
    validateApprovedV3ActivationPlan(renewedApproval, {
      configCommitment: HASH("1"),
      planCommitment: HASH("3"),
      predictedFacility: ADDRESS("b"),
      transactionPlan,
      requests,
      roles: { lender: wallet.address },
      chainId: 102031,
      feePolicy,
      journal,
      now: 2_100,
    }),
    true,
  );
  assert.equal(validateV3ActivationRenewalBinding(renewal, journal), true);

  journal = await prepareV3ActivationStep({
    journal,
    journalPath,
    stepIndex: 1,
    signer,
    request: requests[1],
    approvedTransaction: executionPlan.steps[1],
  });
  const secondTransaction = Transaction.from(
    journal.steps[1].intent.rawTransaction,
  );
  let secondReceipt;
  let approvalChecks = 0;
  journal = (
    await reconcileV3ActivationStep({
      journal,
      journalPath,
      stepIndex: 1,
      maximumReceiptPolls: 2,
      delay: async () => {},
      beforeBroadcast: async () => {
        approvalChecks += 1;
        validateApprovedV3ActivationPlan(renewedApproval, {
          configCommitment: HASH("1"),
          planCommitment: HASH("3"),
          predictedFacility: ADDRESS("b"),
          transactionPlan,
          requests,
          roles: { lender: wallet.address },
          chainId: 102031,
          feePolicy,
          journal,
          now: 2_101,
        });
      },
      provider: {
        getNetwork: async () => ({ chainId: 102031n }),
        getTransactionReceipt: async () => secondReceipt,
        getTransaction: async () => (secondReceipt ? secondTransaction : null),
        getTransactionCount: async () => 5,
        broadcastTransaction: async () => {
          secondReceipt = {
            hash: secondTransaction.hash,
            blockNumber: 21,
            blockHash: HASH("b"),
            status: 1,
            logs: [],
          };
        },
        getBlock: async () => ({ hash: HASH("b") }),
      },
    })
  ).journal;
  assert.equal(approvalChecks, 1);
  assert.equal(journal.steps[1].status, "confirmed");

  const tampered = structuredClone(journal);
  tampered.executionPlan.steps[1].maxFeePerGas = "11";
  assert.throws(
    () => validateV3ActivationRenewalBinding(renewal, tampered),
    /does not match its journal/,
  );
});
