import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getAddress, id } from "ethers";
import { serializeMultiChainConfiguration } from "../daemon/job-discovery.mjs";
import {
  activationDiscoveryDeployments,
  assertV3OperatorBinding,
  loadHunterPrivateKey,
  multiRuleExecutionConfigurations,
  singleRuleExecutionConfiguration,
} from "../daemon/v3-core.mjs";
import { runV3Job } from "../daemon/v3-runner.mjs";
import { proofJobsV1Abi } from "../sdk/src/abis.mjs";
import {
  runOperatorCycle,
  runtimeInputs,
  validateOperatorSourceNetworks,
} from "../daemon/operator.mjs";

const ADDRESS = (suffix) =>
  getAddress(`0x${"0".repeat(40 - suffix.length)}${suffix}`);
const HASH = (byte) => `0x${byte.repeat(32)}`;
const FEE_POLICY = {
  transactionType: "legacy",
  maximumGasLimit: "200000",
  maximumGasPrice: "2",
  maximumNativeFee: "400000",
};
const FACILITY = ADDRESS("fac1");
const ASSET = ADDRESS("a55e7");
const KERNEL = ADDRESS("c0de");
const REGISTRY = ADDRESS("1001");
const FACTORY = ADDRESS("1002");
const POLICY = ADDRESS("1003");
const JOBS = ADDRESS("1004");
const CREDIT_STATE = ADDRESS("1005");
const LENDER = ADDRESS("1eade7");
const BORROWER = ADDRESS("b0770");
const GUARDIAN = ADDRESS("9a7d");
const HUNTER = ADDRESS("b0b");

function rule(overrides = {}) {
  return {
    sourceChain: "3",
    emitter: ASSET,
    eventSignature: id("Transfer(address,address,uint256)"),
    startSourceBlock: "100",
    endSourceBlock: "200",
    topicCount: 3,
    subjectTopicIndex: 1,
    dataLength: 32,
    observedValueOffset: 0,
    observationKind: 0,
    riskWeight: 1,
    ...overrides,
  };
}

function activation(overrides = {}) {
  return {
    generation: "v3-pilot-activation",
    chainId: 102031,
    core: {
      policyKernel: KERNEL,
      policyRegistry: REGISTRY,
      cappedPilotFactory: FACTORY,
      multiChainEventPolicy: POLICY,
      proofJobs: JOBS,
      verifiedCreditState: CREDIT_STATE,
    },
    asset: { address: ASSET, decimals: 6, symbol: "rUSD" },
    roles: {
      deployer: ADDRESS("de1"),
      lender: LENDER,
      borrower: BORROWER,
      guardian: GUARDIAN,
      hunter: HUNTER,
    },
    facility: {
      address: FACILITY,
      status: "Active",
      createdAtBlock: 500,
      activatedAtBlock: 510,
      policySetCommitment: HASH("11"),
    },
    policy: {
      policyId: "7",
      evaluator: POLICY,
      configurationHash: HASH("22"),
      configuration: {
        subject: BORROWER,
        freshnessPeriod: "3600",
        watchThreshold: 1,
        restrictedThreshold: 2,
        marginThreshold: 3,
        breachThreshold: 4,
        rules: [rule()],
      },
      sourceNetworks: {
        3: {
          evmChainId: 1,
          rpcUrlEnvironment: "ETH_MAINNET_RPC_URL",
        },
      },
    },
    proofJob: {
      address: JOBS,
      jobId: "9",
      requirementsDigest: HASH("22"),
      expiry: "2000000000",
      revealWindowBlocks: "20",
      maxSuccessfulProofs: "3",
      proofReimbursement: "25",
      outcomeReward: "50",
      commitBond: "10",
      rewardOutcomeThreshold: 3,
      escrow: "125",
    },
    activationBlock: 520,
    ...overrides,
  };
}

test("V3 activation normalization exposes the exact discovery contract graph", () => {
  const deployments = activationDiscoveryDeployments(activation());

  assert.equal(deployments.generation, "v3-pilot-activation");
  assert.equal(deployments.chainId, 102031);
  assert.equal(deployments.deploymentBlock, 500);
  assert.equal(deployments.policyKernel, KERNEL);
  assert.equal(deployments.multiChainEventPolicy, POLICY);
  assert.equal(deployments.proofJobs, JOBS);
  assert.equal(deployments.demonstrationFacility, FACILITY);
  assert.equal(deployments.demoAsset, ASSET);
  assert.equal(deployments.policyId, "7");
  assert.equal(deployments.proofJobId, "9");
  assert.throws(
    () =>
      activationDiscoveryDeployments(
        activation({
          policy: {
            ...activation().policy,
            configuration: {
              ...activation().policy.configuration,
              rules: [rule({ sourceChain: "4" })],
            },
            sourceNetworks: {
              4: {
                evmChainId: 1,
                rpcUrlEnvironment: "ETH_MAINNET_RPC_URL",
              },
            },
          },
        }),
      ),
    /Unsupported CC3 source chain key 4/,
  );
});

test("V3 execution expands every activated rule while preserving the single-rule compatibility view", () => {
  const configuration = activation().policy.configuration;
  assert.deepEqual(singleRuleExecutionConfiguration(configuration), {
    ...configuration.rules[0],
    subject: BORROWER,
  });
  const expanded = multiRuleExecutionConfigurations({
    ...configuration,
    rules: [
      rule(),
      rule({
        sourceChain: "1",
        emitter: ADDRESS("bee"),
        startSourceBlock: "300",
        endSourceBlock: "400",
      }),
    ],
  });
  assert.deepEqual(
    expanded.map(({ sourceChain, ruleIndex }) => ({ sourceChain, ruleIndex })),
    [
      { sourceChain: "3", ruleIndex: 0 },
      { sourceChain: "1", ruleIndex: 1 },
    ],
  );
  assert.equal(expanded[1].subject, BORROWER);
});

test("V3 source network configuration enforces the documented CC3 chain bindings", () => {
  const networks = validateOperatorSourceNetworks(
    {
      1: {
        evmChainId: 11155111,
        rpcUrlEnvironment: "SEPOLIA_RPC_URL",
      },
      3: {
        evmChainId: 1,
        rpcUrlEnvironment: "ETH_MAINNET_RPC_URL",
      },
    },
    new Set(["1", "3"]),
    {
      SEPOLIA_RPC_URL: "https://sepolia.example",
      SEPOLIA_RPC_URL_SECONDARY: "https://sepolia-secondary.example",
      ETH_MAINNET_RPC_URL: "https://mainnet.example",
      ETH_MAINNET_RPC_URL_SECONDARY: "https://mainnet-secondary.example",
    },
  );
  assert.equal(networks.get("1").evmChainId, 11155111);
  assert.equal(networks.get("3").evmChainId, 1);
  assert.equal(
    networks.get("3").secondaryRpcUrl,
    "https://mainnet-secondary.example",
  );
  assert.throws(
    () =>
      validateOperatorSourceNetworks(
        {
          1: {
            evmChainId: 1,
            rpcUrlEnvironment: "SEPOLIA_RPC_URL",
          },
        },
        new Set(["1"]),
        { SEPOLIA_RPC_URL: "https://sepolia.example" },
      ),
    /source key 1 must bind to EVM chain 11155111/,
  );
  assert.throws(
    () =>
      validateOperatorSourceNetworks(
        {
          4: {
            evmChainId: 1,
            rpcUrlEnvironment: "ETH_MAINNET_RPC_URL",
          },
        },
        new Set(["4"]),
        { ETH_MAINNET_RPC_URL: "https://mainnet.example" },
      ),
    /Unsupported CC3 source chain key 4/,
  );
  assert.throws(
    () =>
      validateOperatorSourceNetworks(
        {
          3: {
            evmChainId: 1,
            rpcUrlEnvironment: "ETH_MAINNET_RPC_URL",
          },
        },
        new Set(["3"]),
        {
          ETH_MAINNET_RPC_URL: "https://mainnet.example",
          ETH_MAINNET_RPC_URL_SECONDARY: "https://mainnet.example/",
        },
      ),
    /must be an independent HTTP endpoint/,
  );
});

test("V3 discovery serializes every MultiChainEventPolicyV1 rule without losing thresholds", () => {
  const effect = {
    outcome: 1n,
    creditLimitBps: 9000n,
    futureDrawFeeBps: 25n,
    freezePendingDraw: true,
    requireFreshEvidence: true,
    terminate: false,
  };
  const serialized = serializeMultiChainConfiguration({
    subject: BORROWER,
    freshnessPeriod: 3600n,
    watchThreshold: 1n,
    restrictedThreshold: 2n,
    marginThreshold: 3n,
    breachThreshold: 4n,
    watchEffect: effect,
    restrictedEffect: effect,
    marginEffect: effect,
    breachEffect: effect,
    rules: [
      {
        ...rule(),
        sourceChain: 3n,
        startSourceBlock: 100n,
        endSourceBlock: 200n,
        topicCount: 3n,
        subjectTopicIndex: 1n,
        dataLength: 32n,
        observedValueOffset: 0n,
        observationKind: 0n,
        riskWeight: 1n,
      },
    ],
  });
  assert.equal(serialized.kind, "multi-chain-event-v1");
  assert.equal(serialized.subject, BORROWER);
  assert.equal(serialized.restrictedThreshold, 2);
  assert.equal(serialized.rules.length, 1);
  assert.equal(serialized.rules[0].sourceChain, "3");
  assert.equal(serialized.rules[0].riskWeight, 1);
});

test("V3 operator allowlists must exactly bind the activated facility, policy, asset, and sources", () => {
  const manifest = activation();
  const config = {
    facilities: new Set([FACILITY]),
    policyIds: new Set(["7"]),
    tokens: new Set([ASSET]),
    sourceChains: new Set(["3"]),
  };
  assert.equal(assertV3OperatorBinding(manifest, config), true);
  assert.throws(
    () =>
      assertV3OperatorBinding(manifest, {
        ...config,
        facilities: new Set([ADDRESS("bad")]),
      }),
    /facility allowlist does not exactly match/i,
  );
});

test("V3 runtime binds the exact activation file and config commitment before loading RPCs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-v3-runtime-"));
  const manifestPath = join(directory, "activation.json");
  const configPath = join(directory, "operator.json");
  const dataDirectory = join(directory, "data");
  const manifest = { ...activation(), configCommitment: HASH("aa") };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestSha256 = createHash("sha256")
    .update(manifestBytes)
    .digest("hex");
  const operatorConfig = {
    schemaVersion: 1,
    execution: "read-only",
    deploymentManifest: manifestPath,
    deploymentManifestSha256: manifestSha256,
    activationConfigCommitment: manifest.configCommitment,
    stateNamespace: "generation-activation-commitment-v1",
    bindAllowlistsToActivation: true,
    pollIntervalMs: 15000,
    maxBackoffMs: 120000,
    maxSourceBlocksPerPoll: 2000,
    confirmations: 12,
    discoveryChunkSize: 2000,
    targetConfirmations: 6,
    recoveryBlocks: 12,
    exclusiveSigner: false,
    economics: {
      maxCommitBond: "10000000",
      minProofReimbursement: "25",
      minRewardToBondBps: 10000,
      minRevealWindowBlocks: 18,
      minSecondsToExpiry: 60,
    },
    transactionPolicy: { feePolicy: FEE_POLICY },
  };
  try {
    await mkdir(dataDirectory);
    const horizon1Cursor = join(dataDirectory, "discovery-cursor.json");
    await writeFile(horizon1Cursor, '{"generation":"horizon1"}\n', "utf8");
    await writeFile(manifestPath, manifestBytes, "utf8");
    await writeFile(
      configPath,
      `${JSON.stringify(operatorConfig, null, 2)}\n`,
      "utf8",
    );
    const inputs = runtimeInputs({
      RECOURSE_OPERATOR_CONFIG: configPath,
      RECOURSE_OPERATOR_DATA_DIRECTORY: dataDirectory,
      ETH_MAINNET_RPC_URL: "https://mainnet.example",
    });
    assert.equal(inputs.deployments.policyConfigHash, HASH("22"));
    assert.equal(inputs.config.sourceNetworks.get("3").evmChainId, 1);
    const expectedNamespace = join(
      dataDirectory,
      "v3-pilot-activation",
      manifest.configCommitment.slice(2),
    );
    assert.equal(inputs.paths.jobsDirectory, expectedNamespace);
    assert.equal(
      inputs.paths.discoveryCursor,
      join(expectedNamespace, "discovery-cursor.json"),
    );
    assert.equal(
      await readFile(horizon1Cursor, "utf8"),
      '{"generation":"horizon1"}\n',
    );

    const { stateNamespace: _stateNamespace, ...unnamespacedConfig } =
      operatorConfig;
    await writeFile(
      configPath,
      `${JSON.stringify(unnamespacedConfig, null, 2)}\n`,
      "utf8",
    );
    assert.throws(
      () =>
        runtimeInputs({
          RECOURSE_OPERATOR_CONFIG: configPath,
          RECOURSE_OPERATOR_DATA_DIRECTORY: dataDirectory,
          ETH_MAINNET_RPC_URL: "https://mainnet.example",
        }),
      /stateNamespace must be generation-activation-commitment-v1/,
    );

    await writeFile(
      configPath,
      `${JSON.stringify(
        { ...operatorConfig, deploymentManifestSha256: "0".repeat(64) },
        null,
        2,
      )}\n`,
      "utf8",
    );
    assert.throws(
      () =>
        runtimeInputs({
          RECOURSE_OPERATOR_CONFIG: configPath,
          RECOURSE_OPERATOR_DATA_DIRECTORY: dataDirectory,
          ETH_MAINNET_RPC_URL: "https://mainnet.example",
        }),
      /activation manifest SHA-256 mismatch/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("systemd credential signer material takes precedence and malformed files fail closed", () => {
  const credentialPath =
    "/run/credentials/recourse/recourse-hunter-private-key";
  assert.equal(
    loadHunterPrivateKey(
      {
        CREDENTIALS_DIRECTORY: "/run/credentials/recourse",
        HUNTER_PRIVATE_KEY: `0x${"22".repeat(32)}`,
      },
      (path) => {
        assert.equal(path, credentialPath);
        return `${"11".repeat(32)}\n`;
      },
    ),
    `0x${"11".repeat(32)}`,
  );
  assert.throws(
    () =>
      loadHunterPrivateKey(
        { CREDENTIALS_DIRECTORY: "/run/credentials/recourse" },
        () => "not-a-key\n",
      ),
    /invalid hunter signing credential/i,
  );
  assert.equal(
    loadHunterPrivateKey({ HUNTER_PRIVATE_KEY: `0x${"33".repeat(32)}` }),
    `0x${"33".repeat(32)}`,
  );
});

test("V3 runtime uses the checked-in ProofJobs ABI and has no build-output dependency", async () => {
  const source = await readFile("daemon/v3.mjs", "utf8");
  assert.match(
    source,
    /import \{ proofJobsV1Abi \} from "\.\.\/sdk\/src\/abis\.mjs"/,
  );
  assert.doesNotMatch(source, /out[\\/]ProofJobsV1\.sol|ProofJobsV1\.json/);
  for (const signature of [
    "function getJob(uint256 jobId)",
    "function claim(address token)",
    "function claimable(address token,address account)",
  ]) {
    assert.equal(
      proofJobsV1Abi.some((entry) => entry.startsWith(signature)),
      true,
      `${signature} is absent from the packaged ABI`,
    );
  }
});

test("V3 runner uses the V3 executable and forwards durable-boundary aborts", async () => {
  const controller = new AbortController();
  const child = new EventEmitter();
  let executable;
  let argumentsSeen;
  let environment;
  child.kill = (signal) => {
    assert.equal(signal, "SIGTERM");
    queueMicrotask(() => child.emit("exit", 4, null));
  };
  const result = runV3Job({
    transactionHash: HASH("44"),
    jobId: 9,
    sourceChain: 3,
    statePath: "daemon/operator-data/v3.json",
    deploymentPath: "activation-v3.json",
    signal: controller.signal,
    executionPolicy: { targetConfirmations: 2 },
    spawnProcess: (command, args, options) => {
      executable = command;
      argumentsSeen = args;
      environment = options.env;
      return child;
    },
  });
  controller.abort();
  assert.deepEqual(await result, { status: "aborted" });
  assert.equal(executable, process.execPath);
  assert.match(argumentsSeen[0], /daemon[\\/]v3\.mjs$/);
  assert.equal(argumentsSeen[3], "3");
  assert.equal(environment.RECOURSE_SOURCE_CHAIN, "3");
  assert.equal(
    environment.RECOURSE_ACTIVATION_FILE.endsWith("activation-v3.json"),
    true,
  );
});

test("V3 runner refuses an already-aborted job without spawning", async () => {
  const controller = new AbortController();
  controller.abort();
  let spawns = 0;
  assert.deepEqual(
    await runV3Job({
      transactionHash: HASH("44"),
      jobId: 9,
      sourceChain: 3,
      statePath: "daemon/operator-data/v3.json",
      deploymentPath: "activation-v3.json",
      signal: controller.signal,
      executionPolicy: { targetConfirmations: 2 },
      spawnProcess: () => {
        spawns += 1;
      },
    }),
    { status: "aborted" },
  );
  assert.equal(spawns, 0);
});

test("V3 runner closes an abort race immediately after listener registration", async () => {
  const child = new EventEmitter();
  let killed = false;
  child.kill = () => {
    killed = true;
    queueMicrotask(() => child.emit("exit", 4, null));
  };
  const signal = {
    aborted: false,
    addEventListener() {
      this.aborted = true;
    },
    removeEventListener() {},
  };
  assert.deepEqual(
    await runV3Job({
      transactionHash: HASH("44"),
      jobId: 9,
      sourceChain: 3,
      statePath: "daemon/operator-data/v3.json",
      deploymentPath: "activation-v3.json",
      signal,
      executionPolicy: { targetConfirmations: 2 },
      spawnProcess: () => child,
    }),
    { status: "aborted" },
  );
  assert.equal(killed, true);
});

test("V3 operator passes validated economics to queued execution, not hydrated policy data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-v3-policy-route-"));
  const economicPolicy = {
    targetConfirmations: 6,
    recoveryBlocks: 12,
    blockTimeMs: 15000,
    minRevealWindowBlocks: 18,
    minSecondsToExpiry: 3600,
    maxCommitBond: "10000000",
    minProofReimbursement: "25000000",
    minRewardToBondBps: 25000,
    feePolicy: FEE_POLICY,
    exclusiveSigner: true,
  };
  const hydratedPolicy = {
    facility: FACILITY,
    policyId: "7",
    evaluator: POLICY,
    configHash: HASH("22"),
    configuration: {
      ...activation().policy.configuration,
      rules: [rule()],
    },
  };
  let routedPolicy;
  try {
    await runOperatorCycle({
      provider: {},
      deployments: {
        generation: "v3-pilot-activation",
        chainId: 102031,
        policyKernel: KERNEL,
        proofJobs: JOBS,
        proofJobId: "9",
      },
      paths: {
        jobsDirectory: directory,
        deployments: "activation-v3.json",
        discoveryCursor: join(directory, "cursor.json"),
        discoveryReport: join(directory, "report.json"),
      },
      config: {
        execution: "enabled",
        sourceChains: new Set(["3"]),
        facilities: new Set([FACILITY]),
        policyIds: new Set(["7"]),
        tokens: new Set([ASSET]),
        maxSourceBlocksPerPoll: 1,
        confirmations: 12,
        discoveryChunkSize: 100,
        ...economicPolicy,
        maxCommitBond: 10000000n,
        minProofReimbursement: 25000000n,
      },
      signal: { aborted: false },
      executionKernelForProvider: async () => ({
        sourceOrderingOf: async () => 1n,
        latestSourcePosition: async () => ({
          recorded: false,
          blockHeight: 0n,
          transactionIndex: 0n,
        }),
        isProcessed: async () => false,
      }),
      sourceProviderForChain: () => ({
        getNetwork: async () => ({ chainId: 1n }),
      }),
      attestedHeightForChain: async () => 100,
      discoverJobs: async () => ({
        chainId: 102031,
        scan: { stateBlockTimestamp: 1000 },
        jobs: [
          {
            jobId: "9",
            sponsor: LENDER,
            facility: FACILITY,
            token: ASSET,
            policyId: "7",
            requirementsDigest: HASH("22"),
            state: "Open",
            commitBond: "10000000",
            proofReimbursement: "25000000",
            revealWindowBlocks: "18",
            expiry: "5000",
          },
        ],
        policies: [hydratedPolicy],
      }),
      writeReport: () => {},
      scanEvidence: async () => ({
        state: {
          candidates: [],
          completedTransactionHashes: [],
          skippedCandidates: [],
          incidents: [],
          lastScannedBlock: 100,
        },
        added: [],
      }),
      executeCandidates: async ({ executionPolicy }) => {
        routedPolicy = executionPolicy;
      },
    });
    assert.deepEqual(routedPolicy, economicPolicy);
    assert.notEqual(routedPolicy, hydratedPolicy);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("V3 operator groups rules by source chain and keeps a separate cursor per job and chain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-v3-chains-"));
  const configurations = [
    rule({ ruleIndex: 0 }),
    rule({ ruleIndex: 1, eventSignature: id("Flagged(address,uint256)") }),
    rule({
      ruleIndex: 2,
      sourceChain: "1",
      emitter: ADDRESS("bee"),
    }),
  ];
  const scans = [];
  try {
    const result = await runOperatorCycle({
      provider: {},
      deployments: {
        generation: "v3-pilot-activation",
        chainId: 102031,
        policyKernel: KERNEL,
        proofJobs: JOBS,
        proofJobId: "9",
      },
      paths: {
        jobsDirectory: directory,
        deployments: "activation-v3.json",
        discoveryCursor: join(directory, "cursor.json"),
        discoveryReport: join(directory, "report.json"),
      },
      config: {
        execution: "read-only",
        sourceChains: new Set(["1", "3"]),
        sourceNetworks: new Map([
          [
            "1",
            {
              evmChainId: 11155111,
              rpcUrlEnvironment: "SEPOLIA_RPC_URL",
              rpcUrl: "https://sepolia.example",
            },
          ],
          [
            "3",
            {
              evmChainId: 1,
              rpcUrlEnvironment: "ETH_MAINNET_RPC_URL",
              rpcUrl: "https://mainnet.example",
            },
          ],
        ]),
        facilities: new Set([FACILITY]),
        policyIds: new Set(["7"]),
        tokens: new Set([ASSET]),
        maxSourceBlocksPerPoll: 1,
        confirmations: 12,
        discoveryChunkSize: 100,
        targetConfirmations: 6,
        recoveryBlocks: 12,
        minRevealWindowBlocks: 18,
        minSecondsToExpiry: 3600,
        maxCommitBond: 10000000n,
        minProofReimbursement: 25000000n,
        minRewardToBondBps: 25000,
        feePolicy: FEE_POLICY,
        exclusiveSigner: false,
      },
      signal: { aborted: false },
      sourceProviderForChain: (chainKey, environment) => {
        const rpcUrlEnvironment =
          chainKey === 1 ? "SEPOLIA_RPC_URL" : "ETH_MAINNET_RPC_URL";
        assert.deepEqual(Object.keys(environment), [rpcUrlEnvironment]);
        assert.equal(
          environment[rpcUrlEnvironment],
          chainKey === 1
            ? "https://sepolia.example"
            : "https://mainnet.example",
        );
        return {
          getNetwork: async () => ({
            chainId: chainKey === 1 ? 11155111n : 1n,
          }),
        };
      },
      attestedHeightForChain: async () => 100,
      discoverJobs: async () => ({
        chainId: 102031,
        scan: { stateBlockTimestamp: 1000 },
        jobs: [
          {
            jobId: "9",
            sponsor: LENDER,
            facility: FACILITY,
            token: ASSET,
            policyId: "7",
            requirementsDigest: HASH("22"),
            state: "Open",
            commitBond: "10000000",
            proofReimbursement: "25000000",
            revealWindowBlocks: "18",
            expiry: "5000",
          },
        ],
        policies: [
          {
            facility: FACILITY,
            policyId: "7",
            evaluator: POLICY,
            configHash: HASH("22"),
            configuration: {
              ...activation().policy.configuration,
              rules: configurations,
            },
          },
        ],
      }),
      writeReport: () => {},
      scanEvidence: async (input) => {
        scans.push(input);
        return {
          state: {
            candidates: [],
            completedTransactionHashes: [],
            skippedCandidates: [],
            incidents: [],
            lastScannedBlock: 100,
          },
          added: [],
        };
      },
    });
    assert.equal(scans.length, 2);
    assert.deepEqual(
      scans.map(({ policy }) =>
        policy.configurations.map(({ ruleIndex }) => ruleIndex),
      ),
      [[2], [0, 1]],
    );
    assert.deepEqual(
      scans.map(({ statePath }) => statePath.split(/[\\/]/).at(-1)),
      ["102031-9-source-1.json", "102031-9-source-3.json"],
    );
    assert.deepEqual(
      result.jobs.map(({ sourceChain }) => sourceChain),
      ["1", "3"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("systemd template keeps read-only mode and applies the verified isolation boundary", async () => {
  const unit = await readFile("ops/recourse-operator.service", "utf8");
  for (const directive of [
    "CapabilityBoundingSet=",
    "PrivateDevices=true",
    "ProtectKernelTunables=true",
    "ProtectKernelModules=true",
    "ProtectKernelLogs=true",
    "ProtectProc=invisible",
    "ProcSubset=pid",
    "RestrictNamespaces=true",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
  ]) {
    assert.match(unit, new RegExp(`^${directive}$`, "m"));
  }
  const config = JSON.parse(
    await readFile("daemon/operator-config-v3.example.json", "utf8"),
  );
  assert.equal(config.execution, "read-only");
  assert.equal(config.deploymentManifest, "activation-v3.json");
  assert.equal(config.stateNamespace, "generation-activation-commitment-v1");
  assert.match(unit, /generation\/activation-commitment namespace/);
});

test("public reporter is independently sandboxed from protected operator state", async () => {
  const [unit, timer, nginx] = await Promise.all([
    readFile("ops/recourse-operator-report.service", "utf8"),
    readFile("ops/recourse-operator-report.timer", "utf8"),
    readFile("ops/recourse-operator-report.nginx", "utf8"),
  ]);
  for (const directive of [
    "User=recourse-report",
    "Group=recourse-report",
    "UMask=0027",
    "InaccessiblePaths=/var/lib/recourse-operator",
    "ReadWritePaths=/var/lib/recourse-report /var/lib/recourse-report-public",
    "CapabilityBoundingSet=",
    "NoNewPrivileges=true",
    "ProtectSystem=strict",
    "ProtectHome=true",
    "PrivateDevices=true",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
  ]) {
    assert.match(unit, new RegExp(`^${directive}$`, "m"));
  }
  assert.match(
    unit,
    /^EnvironmentFile=\/etc\/recourse\/operator-report-runtime\.conf$/m,
  );
  assert.match(
    unit,
    /daemon\/job-discovery\.mjs --output \/var\/lib\/recourse-report\/discovery-report\.json/,
  );
  assert.match(
    unit,
    /daemon\/publish-operator-report\.mjs --input \/var\/lib\/recourse-report\/discovery-report\.json --output \/var\/lib\/recourse-report-public\/operator-report\.json/,
  );
  assert.doesNotMatch(unit, /operator\.json|LoadCredential|HUNTER_PRIVATE_KEY/);
  assert.match(timer, /^OnBootSec=15s$/m);
  assert.match(timer, /^OnUnitInactiveSec=30s$/m);
  assert.doesNotMatch(timer, /^Persistent=/m);
  assert.match(nginx, /^location = \/recourse\/operator-report\.json \{$/m);
  assert.match(
    nginx,
    /^\s+alias \/var\/lib\/recourse-report-public\/operator-report\.json;$/m,
  );
  assert.match(nginx, /^\s+limit_except GET \{$/m);
  assert.match(nginx, /Cache-Control "no-store, max-age=0" always/);
  assert.match(nginx, /X-Content-Type-Options "nosniff" always/);
  assert.match(
    nginx,
    /Strict-Transport-Security "max-age=31536000; includeSubDomains" always/,
  );
  assert.match(
    nginx,
    /Referrer-Policy "strict-origin-when-cross-origin" always/,
  );
  assert.match(
    nginx,
    /Permissions-Policy "geolocation=\(\), microphone=\(\), camera=\(\)" always/,
  );
  assert.doesNotMatch(
    nginx,
    /recourse-operator|cors|Access-Control-Allow-Origin/i,
  );
});
