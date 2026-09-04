import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ContractFactory,
  Interface,
  Transaction,
  Wallet,
  getAddress,
  getCreateAddress,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import { applyArtifactImmutables } from "../scripts/lib/v3-activation.mjs";
import {
  CORE_ARTIFACT_NAMES,
  CORE_CONTRACT_NAMES,
  buildV3DeploymentManifest,
  buildV3DeploymentLiveExecutionPlan,
  buildV3DeploymentPlan,
  createV3DeploymentApproval,
  createV3DeploymentRenewalBinding,
  initializeV3DeploymentJournal,
  parseV3DeploymentArguments,
  prepareV3DeploymentStep,
  qualifyV3DeploymentState,
  readCoreArtifacts,
  readV3DeploymentConfig,
  reconcileV3DeploymentStep,
  reserveV3Manifest,
  runV3DeploymentFundingPreflight,
  runV3Preflight,
  validateV3DeploymentApproval,
  validateV3DeploymentConfig,
  validateV3DeploymentLiveExecutionPlan,
  validateV3DeploymentManifest,
  validateV3DeploymentRenewalBinding,
  v3DeploymentApprovalCommitment,
  verifyV3RuntimeArtifacts,
  verifyV3Deployment,
  verifyV3DeploymentTransactions,
  verifyV3DeploymentApprovalAnchor,
} from "../scripts/lib/v3-deployment.mjs";

const ADDRESS = (suffix) =>
  getAddress(`0x${"0".repeat(40 - suffix.length)}${suffix}`);
const HASH = (byte) => `0x${byte.repeat(64)}`;
const SOURCE_COMMIT = "a".repeat(40);
const STARTING_NONCE = 7;

const CONSTRUCTOR_TYPES = {
  PolicyKernelV2: ["address"],
  PolicyRegistryV1: [],
  CappedPilotFactoryV1: [
    "address",
    "address",
    "address",
    "address",
    "address",
    "uint256",
    "uint256",
    "uint16",
    "uint16",
    "uint64",
    "uint32",
    "uint16",
  ],
  MultiChainEventPolicyV1: ["address"],
  ProofJobsV1: ["address"],
  VerifiedCreditStateV1: ["address"],
};

function artifact(name, index) {
  return {
    abi: [
      {
        type: "constructor",
        stateMutability: "nonpayable",
        inputs: CONSTRUCTOR_TYPES[name].map((type, inputIndex) => ({
          name: `value${inputIndex}`,
          type,
        })),
      },
      ...(name === "PolicyKernelV2"
        ? [
            {
              type: "function",
              name: "setProofJobs",
              stateMutability: "nonpayable",
              inputs: [{ name: "proofJobs_", type: "address" }],
              outputs: [],
            },
          ]
        : []),
    ],
    bytecode: {
      object: `0x60${(index + 1).toString(16).padStart(2, "0")}6000f3`,
    },
    deployedBytecode: { object: "0x60006000f3", immutableReferences: {} },
  };
}

function fixtureConfig(deployer) {
  return {
    generation: "v3-core",
    chainId: 102031,
    verifier: "0x0000000000000000000000000000000000000FD2",
    asset: {
      address: "0x1000000000000000000000000000000000000001",
      decimals: 6,
    },
    roles: {
      deployer,
      lender: "0x2000000000000000000000000000000000000002",
      borrower: "0x3000000000000000000000000000000000000003",
      guardian: "0x4000000000000000000000000000000000000004",
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
    requirements: {
      nativeBalances: [{ role: "deployer", minimumWei: "1000" }],
      assetBalances: [{ role: "lender", minimumBaseUnits: "2000" }],
      assetAllowances: [
        {
          ownerRole: "lender",
          spender: "0x5000000000000000000000000000000000000005",
          minimumBaseUnits: "3000",
        },
      ],
    },
    artifacts: Object.fromEntries(
      CORE_ARTIFACT_NAMES.map((name, index) => [
        name,
        {
          path: `out/${name}.sol/${name}.json`,
          keccak256: HASH(String(index + 1)),
        },
      ]),
    ),
    transactionPolicy: {
      targetConfirmations: 6,
      maximumReceiptPolls: 24,
      feePolicy: {
        transactionType: "eip1559",
        maximumGasLimit: "6000000",
        maximumFeePerGas: "100000000000",
        maximumPriorityFeePerGas: "5000000000",
      },
    },
  };
}

function artifacts(config = fixtureConfig(ADDRESS("d01"))) {
  return Object.fromEntries(
    CORE_ARTIFACT_NAMES.map((name, index) => [
      name,
      {
        artifact: artifact(name, index),
        hash: config.artifacts[name].keccak256,
      },
    ]),
  );
}

async function deploymentFixture(wallet = Wallet.createRandom()) {
  const input = fixtureConfig(wallet.address);
  const config = validateV3DeploymentConfig(input);
  const loadedArtifacts = artifacts(input);
  const plan = await buildV3DeploymentPlan({
    config,
    artifacts: loadedArtifacts,
    startingNonce: STARTING_NONCE,
    sourceCommit: SOURCE_COMMIT,
  });
  const signer = {
    getAddress: async () => wallet.address,
    populateTransaction: async (request) => ({
      ...request,
      type: 2,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 1n,
    }),
    signTransaction: (request) => wallet.signTransaction(request),
  };
  const executionPlan = await buildV3DeploymentLiveExecutionPlan({
    config,
    plan,
    signer,
  });
  const qualification = {
    chainId: config.chainId,
    blockNumber: 500,
    blockHash: HASH("a"),
    blockTimestamp: 1_000,
    pendingNonce: STARTING_NONCE,
    deployer: wallet.address,
    sourceCommit: plan.sourceCommit,
    artifactHashes: plan.artifactHashes,
    deployableScopeClean: true,
  };
  const approval = createV3DeploymentApproval({
    config,
    plan,
    qualification,
    executionPlan,
    now: 1_000,
  });
  return {
    wallet,
    config,
    loadedArtifacts,
    plan,
    signer,
    executionPlan,
    qualification,
    approval,
  };
}

test("V3 deployment arguments are dry-run by default and require an explicit broadcast flag", () => {
  assert.deepEqual(parseV3DeploymentArguments([]), {
    help: false,
    broadcast: false,
    liveCheck: false,
    configPath: "config/v3-cc3.json",
    manifestPath: "deployments-v3.json",
    writePlanPath: undefined,
    approvedPlanPath: undefined,
    approvalCommitment: undefined,
  });
  assert.deepEqual(
    parseV3DeploymentArguments([
      "--live-check",
      "--broadcast",
      "--approved-plan",
      "approved.json",
      "--approval-commitment",
      HASH("9"),
      "--config",
      "pilot.json",
      "--manifest",
      "record.json",
    ]),
    {
      help: false,
      broadcast: true,
      liveCheck: true,
      configPath: "pilot.json",
      manifestPath: "record.json",
      writePlanPath: undefined,
      approvedPlanPath: "approved.json",
      approvalCommitment: HASH("9"),
    },
  );
  assert.throws(
    () => parseV3DeploymentArguments(["--broadcast"]),
    /requires --live-check, --approved-plan, and --approval-commitment/,
  );
  assert.throws(
    () => parseV3DeploymentArguments(["--write-plan", "plan.json"]),
    /requires --live-check/,
  );
  assert.throws(
    () =>
      parseV3DeploymentArguments([
        "--live-check",
        "--write-plan",
        "plan.json",
        "--broadcast",
        "--approved-plan",
        "approved.json",
        "--approval-commitment",
        HASH("9"),
      ]),
    /cannot be combined with --broadcast/,
  );
  assert.throws(
    () => parseV3DeploymentArguments(["--send"]),
    /Unknown argument: --send/,
  );
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(packageJson.scripts["deploy:v3"], "node scripts/deploy-v3.mjs");
});

test("V3 deployment help exits without RPC or signing material", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/deploy-v3.mjs", "--help"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {},
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--write-plan <path>/);
  assert.match(result.stdout, /--approved-plan <path>/);
  assert.match(result.stdout, /no signer, file write, or broadcast/i);
});

test("V3 manifest reservation fails closed across concurrent and interrupted broadcasts", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "recourse-v3-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manifestPath = join(directory, "deployments-v3.json");
  const temporaryPath = `${manifestPath}.tmp`;

  writeFileSync(temporaryPath, "interrupted write");
  assert.throws(
    () => reserveV3Manifest(manifestPath),
    /temporary manifest already exists/,
  );
  rmSync(temporaryPath);

  const release = reserveV3Manifest(manifestPath);
  assert.equal(existsSync(`${manifestPath}.lock`), true);
  assert.throws(
    () => reserveV3Manifest(manifestPath),
    /deployment lock already exists/,
  );
  release();
  assert.equal(existsSync(`${manifestPath}.lock`), false);

  writeFileSync(manifestPath, "{}");
  assert.throws(
    () => reserveV3Manifest(manifestPath),
    /manifest already exists/,
  );
});

test("V3 deployment config requires separated roles and coherent pilot bounds", () => {
  const signer = Wallet.createRandom();
  const valid = fixtureConfig(signer.address);
  assert.equal(
    validateV3DeploymentConfig(valid).roles.deployer,
    signer.address,
  );

  assert.throws(
    () =>
      validateV3DeploymentConfig({
        ...valid,
        roles: {
          ...valid.roles,
          guardian: "0x0000000000000000000000000000000000000000",
        },
      }),
    /guardian must not be the zero address/,
  );
  assert.throws(
    () =>
      validateV3DeploymentConfig({
        ...valid,
        roles: { ...valid.roles, guardian: valid.roles.lender },
      }),
    /roles must be distinct/,
  );
  assert.throws(
    () =>
      validateV3DeploymentConfig({
        ...valid,
        pilotBounds: { ...valid.pilotBounds, maximumTotalLimit: "99999999999" },
      }),
    /maximumTotalLimit must be at least maximumFacilityLimit/,
  );
  const missingArtifact = structuredClone(valid);
  delete missingArtifact.artifacts.VerifiedCreditStateV1;
  assert.throws(
    () => validateV3DeploymentConfig(missingArtifact),
    /VerifiedCreditStateV1 artifact/,
  );
  assert.throws(
    () =>
      validateV3DeploymentConfig({
        ...valid,
        transactionPolicy: {
          ...valid.transactionPolicy,
          maximumReceiptPolls: 5,
        },
      }),
    /must cover confirmation depth/,
  );
});

test("V3 deployment config is confined to a clean tracked Git blob", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "recourse-v3-config-source-"));
  const repository = join(directory, "repository");
  const configDirectory = join(repository, "config");
  const configPath = join(configDirectory, "deployment.json");
  const outsidePath = join(directory, "outside.json");
  const rawConfig = fixtureConfig(ADDRESS("d01"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(rawConfig, null, 2)}\n`);
  writeFileSync(outsidePath, `${JSON.stringify(rawConfig, null, 2)}\n`);
  for (const args of [
    ["init"],
    ["config", "user.email", "release-test@example.invalid"],
    ["config", "user.name", "Release Test"],
    ["add", "config/deployment.json"],
    ["commit", "-m", "track deployment config"],
  ]) {
    const result = spawnSync("git", args, {
      cwd: repository,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
  }

  const config = readV3DeploymentConfig("config/deployment.json", repository);
  assert.deepEqual(config.configSource, {
    path: "config/deployment.json",
    blobHash: spawnSync("git", ["rev-parse", "HEAD:config/deployment.json"], {
      cwd: repository,
      encoding: "utf8",
      windowsHide: true,
    }).stdout.trim(),
  });
  const plan = await buildV3DeploymentPlan({
    config,
    artifacts: artifacts(rawConfig),
    startingNonce: STARTING_NONCE,
    sourceCommit: SOURCE_COMMIT,
  });
  assert.equal(
    plan.configCommitment,
    keccak256(
      toUtf8Bytes(JSON.stringify({ gitBlob: config.configSource.blobHash })),
    ),
  );
  assert.throws(
    () => readV3DeploymentConfig(outsidePath, repository),
    /inside the repository/,
  );
  writeFileSync(
    join(configDirectory, "untracked.json"),
    `${JSON.stringify(rawConfig)}\n`,
  );
  assert.throws(
    () => readV3DeploymentConfig("config/untracked.json", repository),
    /tracked by Git/,
  );
  writeFileSync(
    configPath,
    `${JSON.stringify({ ...rawConfig, roles: { ...rawConfig.roles, guardian: ADDRESS("bad") } })}\n`,
  );
  assert.throws(
    () => readV3DeploymentConfig("config/deployment.json", repository),
    /clean in Git/,
  );
});

test("V3 artifact loading verifies all six configured artifact byte hashes", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "recourse-v3-artifacts-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const rawConfig = fixtureConfig(ADDRESS("d01"));

  for (const [index, name] of CORE_ARTIFACT_NAMES.entries()) {
    const path = join(directory, ...rawConfig.artifacts[name].path.split("/"));
    const bytes = `${JSON.stringify(artifact(name, index))}\n`;
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, bytes);
    rawConfig.artifacts[name].keccak256 = keccak256(Buffer.from(bytes));
  }

  const config = validateV3DeploymentConfig(rawConfig);
  const loaded = readCoreArtifacts(config, directory);
  assert.deepEqual(Object.keys(loaded), CORE_ARTIFACT_NAMES);
  for (const name of CORE_ARTIFACT_NAMES) {
    assert.equal(loaded[name].hash, rawConfig.artifacts[name].keccak256);
    assert.deepEqual(
      loaded[name].artifact,
      JSON.parse(readFileSync(join(directory, rawConfig.artifacts[name].path))),
    );
  }

  writeFileSync(
    join(directory, rawConfig.artifacts.VerifiedCreditStateV1.path),
    "{}\n",
  );
  assert.throws(
    () => readCoreArtifacts(config, directory),
    /VerifiedCreditStateV1 artifact hash mismatch/,
  );
});

test("V3 runtime qualification compares all six executable runtimes around compiler-declared immutables", () => {
  const config = validateV3DeploymentConfig(
    JSON.parse(readFileSync("config/v3-cc3.json", "utf8")),
  );
  const loaded = readCoreArtifacts(config);
  const runtimeCodes = Object.fromEntries(
    CORE_ARTIFACT_NAMES.map((name) => {
      const artifact = loaded[name].artifact;
      const immutableValues = Object.fromEntries(
        Object.keys(artifact.deployedBytecode.immutableReferences ?? {}).map(
          (referenceId, index) => [
            referenceId,
            ADDRESS((index + 1).toString(16)),
          ],
        ),
      );
      return [name, applyArtifactImmutables(artifact, immutableValues)];
    }),
  );
  const verified = verifyV3RuntimeArtifacts({
    artifacts: loaded,
    runtimeCodes,
  });
  assert.deepEqual(Object.keys(verified), CORE_ARTIFACT_NAMES);
  for (const name of CORE_ARTIFACT_NAMES)
    assert.equal(verified[name], keccak256(runtimeCodes[name]));

  const mutated = { ...runtimeCodes };
  const code = mutated.VerifiedCreditStateV1;
  mutated.VerifiedCreditStateV1 = `${code.slice(0, 20)}${code.slice(20, 22) === "00" ? "01" : "00"}${code.slice(22)}`;
  assert.throws(
    () =>
      verifyV3RuntimeArtifacts({ artifacts: loaded, runtimeCodes: mutated }),
    /VerifiedCreditStateV1 runtime bytecode does not match the pinned artifact/,
  );
});

test("V3 postdeployment qualification pins every runtime and getter to one canonical block", async () => {
  const config = validateV3DeploymentConfig(
    JSON.parse(readFileSync("config/v3-cc3.json", "utf8")),
  );
  const loaded = readCoreArtifacts(config);
  const plan = await buildV3DeploymentPlan({
    config,
    artifacts: loaded,
    startingNonce: STARTING_NONCE,
    sourceCommit: SOURCE_COMMIT,
  });
  const addresses = plan.predictedContracts;
  const creditState = getCreateAddress({
    from: addresses.PolicyKernelV2,
    nonce: 1,
  });
  const runtimeByAddress = new Map(
    CORE_ARTIFACT_NAMES.map((name) => {
      const immutableValues = Object.fromEntries(
        Object.keys(
          loaded[name].artifact.deployedBytecode.immutableReferences ?? {},
        ).map((referenceId) => [referenceId, "0x01"]),
      );
      const address =
        name === "VerifiedCreditStateV1" ? creditState : addresses[name];
      return [
        address.toLowerCase(),
        applyArtifactImmutables(loaded[name].artifact, immutableValues),
      ];
    }),
  );
  const responses = new Map();
  const addResponse = (name, address, functionName, value) => {
    const contractInterface = new Interface(loaded[name].artifact.abi);
    const fragment = contractInterface.getFunction(functionName);
    responses.set(
      `${address.toLowerCase()}:${fragment.selector}`,
      contractInterface.encodeFunctionResult(fragment, [value]),
    );
  };
  addResponse(
    "PolicyKernelV2",
    addresses.PolicyKernelV2,
    "creditState",
    creditState,
  );
  addResponse(
    "PolicyKernelV2",
    addresses.PolicyKernelV2,
    "verifier",
    config.verifier,
  );
  addResponse(
    "PolicyKernelV2",
    addresses.PolicyKernelV2,
    "owner",
    config.roles.deployer,
  );
  addResponse(
    "PolicyKernelV2",
    addresses.PolicyKernelV2,
    "proofJobs",
    addresses.ProofJobsV1,
  );
  addResponse(
    "PolicyKernelV2",
    addresses.PolicyKernelV2,
    "safeStaleProofRelease",
    true,
  );
  for (const [functionName, value] of [
    ["asset", config.asset.address],
    ["kernel", addresses.PolicyKernelV2],
    ["lender", config.roles.lender],
    ["borrower", config.roles.borrower],
    ["guardian", config.roles.guardian],
    ["maximumFacilityLimit", config.pilotBounds.maximumFacilityLimit],
    ["maximumTotalLimit", config.pilotBounds.maximumTotalLimit],
    ["minimumBondBps", config.pilotBounds.minimumBondBps],
    ["maximumDrawFeeBps", config.pilotBounds.maximumDrawFeeBps],
    ["maximumMaturityBlocks", config.pilotBounds.maximumMaturityBlocks],
    ["maximumDrawDelayBlocks", config.pilotBounds.maximumDrawDelayBlocks],
    ["maximumFacilityCount", config.pilotBounds.maximumFacilityCount],
    ["facilityCount", 0],
    ["totalFacilityLimit", 0],
    ["creationPaused", false],
  ]) {
    addResponse(
      "CappedPilotFactoryV1",
      addresses.CappedPilotFactoryV1,
      functionName,
      value,
    );
  }
  addResponse(
    "MultiChainEventPolicyV1",
    addresses.MultiChainEventPolicyV1,
    "context",
    addresses.PolicyKernelV2,
  );
  addResponse(
    "ProofJobsV1",
    addresses.ProofJobsV1,
    "kernel",
    addresses.PolicyKernelV2,
  );
  addResponse(
    "VerifiedCreditStateV1",
    creditState,
    "kernel",
    addresses.PolicyKernelV2,
  );
  const blockHash = HASH("c");
  const provider = {
    getNetwork: async () => ({ chainId: BigInt(config.chainId) }),
    getBlock: async (tag) => {
      assert.ok(tag === "latest" || tag === 900);
      return { number: 900, hash: blockHash };
    },
    getCode: async (address, blockTag) => {
      assert.equal(blockTag, 900);
      return runtimeByAddress.get(address.toLowerCase());
    },
    call: async (transaction) => {
      assert.equal(transaction.blockTag, 900);
      const response = responses.get(
        `${transaction.to.toLowerCase()}:${transaction.data.slice(0, 10)}`,
      );
      assert.ok(
        response,
        `missing response for ${transaction.data.slice(0, 10)}`,
      );
      return response;
    },
  };
  const verification = await verifyV3Deployment({
    provider,
    signerAddress: config.roles.deployer,
    config,
    artifacts: loaded,
    addresses,
  });
  assert.equal(verification.creditState, creditState);
  assert.equal(verification.verifiedAtBlock, 900);
  assert.equal(verification.verifiedAtBlockHash, blockHash);
  assert.deepEqual(
    Object.keys(verification.runtimeCodeHashes),
    CORE_ARTIFACT_NAMES,
  );
  let blockReads = 0;
  await assert.rejects(
    () =>
      verifyV3Deployment({
        provider: {
          ...provider,
          getBlock: async (tag) => {
            assert.ok(tag === "latest" || tag === 900);
            blockReads += 1;
            return {
              number: 900,
              hash: blockReads === 1 ? blockHash : HASH("d"),
            };
          },
        },
        signerAddress: config.roles.deployer,
        config,
        artifacts: loaded,
        addresses,
      }),
    /verification block changed/,
  );
});

test("V3 deployment plan binds the source commit and six exact transactions", async () => {
  const deployer = Wallet.createRandom();
  const config = validateV3DeploymentConfig(fixtureConfig(deployer.address));
  const loadedArtifacts = artifacts(fixtureConfig(deployer.address));
  const plan = await buildV3DeploymentPlan({
    config,
    artifacts: loadedArtifacts,
    startingNonce: STARTING_NONCE,
    sourceCommit: SOURCE_COMMIT,
  });
  const predictedContracts = Object.fromEntries(
    CORE_CONTRACT_NAMES.map((name, index) => [
      name,
      getCreateAddress({
        from: deployer.address,
        nonce: STARTING_NONCE + index,
      }),
    ]),
  );
  const constructorArguments = {
    PolicyKernelV2: [config.verifier],
    PolicyRegistryV1: [],
    CappedPilotFactoryV1: [
      config.asset.address,
      predictedContracts.PolicyKernelV2,
      config.roles.lender,
      config.roles.borrower,
      config.roles.guardian,
      config.pilotBounds.maximumFacilityLimit,
      config.pilotBounds.maximumTotalLimit,
      config.pilotBounds.minimumBondBps,
      config.pilotBounds.maximumDrawFeeBps,
      config.pilotBounds.maximumMaturityBlocks,
      config.pilotBounds.maximumDrawDelayBlocks,
      config.pilotBounds.maximumFacilityCount,
    ],
    MultiChainEventPolicyV1: [predictedContracts.PolicyKernelV2],
    ProofJobsV1: [predictedContracts.PolicyKernelV2],
  };
  const expectedSteps = [];
  for (const [index, name] of CORE_CONTRACT_NAMES.entries()) {
    const factory = new ContractFactory(
      loadedArtifacts[name].artifact.abi,
      loadedArtifacts[name].artifact.bytecode.object,
    );
    const transaction = await factory.getDeployTransaction(
      ...constructorArguments[name],
    );
    expectedSteps.push({
      order: index + 1,
      name,
      chainId: config.chainId,
      nonce: STARTING_NONCE + index,
      from: deployer.address,
      to: null,
      predictedContract: predictedContracts[name],
      data: transaction.data,
      dataHash: keccak256(transaction.data),
      value: "0",
    });
  }
  const wiringData = new Interface(
    loadedArtifacts.PolicyKernelV2.artifact.abi,
  ).encodeFunctionData("setProofJobs", [predictedContracts.ProofJobsV1]);
  expectedSteps.push({
    order: 6,
    name: "setProofJobs",
    chainId: config.chainId,
    nonce: STARTING_NONCE + CORE_CONTRACT_NAMES.length,
    from: deployer.address,
    to: predictedContracts.PolicyKernelV2,
    predictedContract: null,
    data: wiringData,
    dataHash: keccak256(wiringData),
    value: "0",
  });

  assert.equal(plan.sourceCommit, SOURCE_COMMIT);
  assert.deepEqual(plan.predictedContracts, predictedContracts);
  assert.deepEqual(
    plan.artifactHashes,
    Object.fromEntries(
      CORE_ARTIFACT_NAMES.map((name) => [name, loadedArtifacts[name].hash]),
    ),
  );
  assert.deepEqual(plan.steps, expectedSteps);
  assert.match(plan.planCommitment, /^0x[0-9a-f]{64}$/);
});

test("V3 live execution planning rejects fee-cap breaches, mixed fee modes, and changed transaction intent", async () => {
  const wallet = Wallet.createRandom();
  const input = fixtureConfig(wallet.address);
  const config = validateV3DeploymentConfig(input);
  const plan = await buildV3DeploymentPlan({
    config,
    artifacts: artifacts(input),
    startingNonce: STARTING_NONCE,
    sourceCommit: SOURCE_COMMIT,
  });
  const signer = {
    getAddress: async () => wallet.address,
    populateTransaction: async (request) => ({
      ...request,
      type: 2,
      maxFeePerGas: config.transactionPolicy.feePolicy.maximumFeePerGas + 1n,
      maxPriorityFeePerGas: 1n,
    }),
  };

  await assert.rejects(
    () => buildV3DeploymentLiveExecutionPlan({ config, plan, signer }),
    /maximumFeePerGas exceeds the configured maximum/,
  );
  signer.populateTransaction = async (request) => ({
    ...request,
    type: 0,
    gasPrice: 2n,
  });
  await assert.rejects(
    () => buildV3DeploymentLiveExecutionPlan({ config, plan, signer }),
    /requires an EIP-1559 transaction/,
  );
  signer.populateTransaction = async (request) => ({
    ...request,
    nonce: request.nonce + 1,
    type: 2,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  });
  await assert.rejects(
    () => buildV3DeploymentLiveExecutionPlan({ config, plan, signer }),
    /populated transaction changed its plan/,
  );

  const valid = await deploymentFixture(wallet);
  const changedPlan = structuredClone(valid.plan);
  changedPlan.steps[0].data = `${changedPlan.steps[0].data}00`;
  assert.throws(
    () =>
      validateV3DeploymentLiveExecutionPlan({
        config: valid.config,
        plan: changedPlan,
        executionPlan: valid.executionPlan,
      }),
    /changed its plan/,
  );
});

test("V3 live execution planning accepts CC3's zero priority fee", async () => {
  const wallet = Wallet.createRandom();
  const input = fixtureConfig(wallet.address);
  const config = validateV3DeploymentConfig(input);
  const plan = await buildV3DeploymentPlan({
    config,
    artifacts: artifacts(input),
    startingNonce: STARTING_NONCE,
    sourceCommit: SOURCE_COMMIT,
  });
  const executionPlan = await buildV3DeploymentLiveExecutionPlan({
    config,
    plan,
    signer: {
      getAddress: async () => wallet.address,
      populateTransaction: async (request) => ({
        ...request,
        type: 2,
        maxFeePerGas: 1_000_000_000n,
        maxPriorityFeePerGas: 0n,
      }),
    },
  });

  assert.equal(executionPlan.steps[0].maxFeePerGas, "1000000000");
  assert.equal(executionPlan.steps[0].maxPriorityFeePerGas, "0");
});

test("V3 deployment approval expires and binds the chain anchor, source commit, artifacts, and clean scope", async () => {
  const fixture = await deploymentFixture();
  assert.equal(
    validateV3DeploymentApproval({
      approval: fixture.approval,
      expectedApprovalCommitment: fixture.approval.approvalCommitment,
      config: fixture.config,
      plan: fixture.plan,
      qualification: fixture.qualification,
      now: 1_001,
    }),
    fixture.approval,
  );
  assert.throws(
    () =>
      createV3DeploymentApproval({
        config: fixture.config,
        plan: fixture.plan,
        qualification: fixture.qualification,
        executionPlan: fixture.executionPlan,
        now: fixture.qualification.blockTimestamp + 1,
      }),
    /qualification timestamp/i,
  );
  const shiftedApproval = {
    ...fixture.approval,
    issuedAt: fixture.approval.issuedAt + 1,
    validUntil: fixture.approval.validUntil + 1,
  };
  shiftedApproval.approvalCommitment =
    v3DeploymentApprovalCommitment(shiftedApproval);
  assert.throws(
    () =>
      validateV3DeploymentApproval({
        approval: shiftedApproval,
        expectedApprovalCommitment: shiftedApproval.approvalCommitment,
        config: fixture.config,
        plan: fixture.plan,
        qualification: fixture.qualification,
        now: shiftedApproval.issuedAt,
      }),
    /qualification timestamp/i,
  );
  assert.throws(
    () =>
      validateV3DeploymentApproval({
        approval: fixture.approval,
        expectedApprovalCommitment: fixture.approval.approvalCommitment,
        config: fixture.config,
        plan: fixture.plan,
        qualification: fixture.qualification,
        now: fixture.approval.validUntil + 1,
      }),
    /expired/,
  );
  for (const qualification of [
    { ...fixture.qualification, blockHash: HASH("b") },
    { ...fixture.qualification, sourceCommit: "b".repeat(40) },
    {
      ...fixture.qualification,
      artifactHashes: {
        ...fixture.qualification.artifactHashes,
        PolicyKernelV2: HASH("c"),
      },
    },
    { ...fixture.qualification, deployableScopeClean: false },
  ]) {
    assert.throws(
      () =>
        validateV3DeploymentApproval({
          approval: fixture.approval,
          expectedApprovalCommitment: fixture.approval.approvalCommitment,
          config: fixture.config,
          plan: fixture.plan,
          qualification,
          now: 1_001,
        }),
      /approved V3 deployment|qualification|clean/i,
    );
  }
});

test("V3 live qualification requires the reviewed clean commit, exact nonce, empty predicted addresses, and a canonical anchor", async () => {
  const fixture = await deploymentFixture();
  const provider = {
    getNetwork: async () => ({ chainId: BigInt(fixture.config.chainId) }),
    getBlock: async (tag) =>
      tag === "latest"
        ? { number: 500, hash: HASH("a"), timestamp: 1_000 }
        : { number: tag, hash: HASH("a"), timestamp: 1_000 },
    getTransactionCount: async () => STARTING_NONCE,
    getCode: async () => "0x",
  };
  const qualification = await qualifyV3DeploymentState({
    provider,
    config: fixture.config,
    plan: fixture.plan,
    repositoryState: { head: SOURCE_COMMIT, deployableScopeClean: true },
  });
  assert.deepEqual(qualification, {
    chainId: fixture.config.chainId,
    blockNumber: 500,
    blockHash: HASH("a"),
    blockTimestamp: 1_000,
    pendingNonce: STARTING_NONCE,
    deployer: fixture.wallet.address,
    sourceCommit: SOURCE_COMMIT,
    artifactHashes: fixture.plan.artifactHashes,
    deployableScopeClean: true,
  });
  assert.equal(
    await verifyV3DeploymentApprovalAnchor({
      approval: fixture.approval,
      provider,
    }),
    true,
  );
  const forgedTimestampApproval = structuredClone(fixture.approval);
  forgedTimestampApproval.issuedAt = 1_000_000;
  forgedTimestampApproval.validUntil =
    forgedTimestampApproval.issuedAt +
    (fixture.approval.validUntil - fixture.approval.issuedAt);
  forgedTimestampApproval.qualification.blockTimestamp =
    forgedTimestampApproval.issuedAt;
  forgedTimestampApproval.approvalCommitment = v3DeploymentApprovalCommitment(
    forgedTimestampApproval,
  );
  assert.throws(
    () =>
      validateV3DeploymentApproval({
        approval: forgedTimestampApproval,
        expectedApprovalCommitment: fixture.approval.approvalCommitment,
        config: fixture.config,
        plan: fixture.plan,
        qualification: forgedTimestampApproval.qualification,
        now: forgedTimestampApproval.issuedAt,
      }),
    /approval commitment/i,
  );
  assert.throws(
    () =>
      validateV3DeploymentApproval({
        approval: forgedTimestampApproval,
        expectedApprovalCommitment: forgedTimestampApproval.approvalCommitment,
        config: fixture.config,
        plan: fixture.plan,
        qualification,
        now: forgedTimestampApproval.issuedAt,
      }),
    /qualification timestamp/i,
  );
  await assert.rejects(
    () =>
      verifyV3DeploymentApprovalAnchor({
        approval: forgedTimestampApproval,
        provider,
      }),
    /anchor.*timestamp|timestamp.*anchor/i,
  );

  await assert.rejects(
    () =>
      qualifyV3DeploymentState({
        provider: {
          ...provider,
          getTransactionCount: async () => STARTING_NONCE + 1,
        },
        config: fixture.config,
        plan: fixture.plan,
        repositoryState: { head: SOURCE_COMMIT, deployableScopeClean: true },
      }),
    /pending nonce does not match/,
  );
  await assert.rejects(
    () =>
      qualifyV3DeploymentState({
        provider: { ...provider, getCode: async () => "0x6000" },
        config: fixture.config,
        plan: fixture.plan,
        repositoryState: { head: SOURCE_COMMIT, deployableScopeClean: true },
      }),
    /already has bytecode/,
  );
  await assert.rejects(
    () =>
      verifyV3DeploymentApprovalAnchor({
        approval: fixture.approval,
        provider: { ...provider, getBlock: async () => ({ hash: HASH("b") }) },
      }),
    /no longer canonical/,
  );
});

test("V3 journal durably records the signed transaction before broadcast and never rebroadcasts pending or mined work", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "recourse-v3-journal-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = await deploymentFixture();
  let { path, journal } = initializeV3DeploymentJournal({
    manifestPath: join(directory, "deployment.json"),
    config: fixture.config,
    plan: fixture.plan,
    qualification: fixture.qualification,
    approval: fixture.approval,
  });
  journal = await prepareV3DeploymentStep({
    journal,
    journalPath: path,
    stepIndex: 0,
    signer: fixture.signer,
  });
  const persisted = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(persisted.steps[0].status, "prepared");
  assert.match(persisted.steps[0].intent.rawTransaction, /^0x[0-9a-f]+$/);
  assert.equal(
    persisted.steps[0].intent.rawTransaction,
    journal.steps[0].intent.rawTransaction,
  );

  const transaction = Transaction.from(journal.steps[0].intent.rawTransaction);
  let broadcasts = 0;
  await assert.rejects(
    () =>
      reconcileV3DeploymentStep({
        journal,
        journalPath: path,
        stepIndex: 0,
        provider: {
          getNetwork: async () => ({ chainId: BigInt(fixture.config.chainId) }),
          getTransactionReceipt: async () => null,
          getTransaction: async () => transaction,
          broadcastTransaction: async () => {
            broadcasts += 1;
          },
        },
        targetConfirmations: 1,
        maximumReceiptPolls: 1,
      }),
    /remains pending/,
  );
  assert.equal(broadcasts, 0);

  const receipt = {
    hash: transaction.hash,
    status: 1,
    blockNumber: 40,
    blockHash: HASH("d"),
    contractAddress: fixture.plan.steps[0].predictedContract,
  };
  const result = await reconcileV3DeploymentStep({
    journal,
    journalPath: path,
    stepIndex: 0,
    provider: {
      getNetwork: async () => ({ chainId: BigInt(fixture.config.chainId) }),
      getTransactionReceipt: async () => receipt,
      getTransaction: async () => transaction,
      getBlock: async () => ({ hash: receipt.blockHash }),
      broadcastTransaction: async () => {
        broadcasts += 1;
      },
    },
    targetConfirmations: 1,
    maximumReceiptPolls: 1,
  });
  assert.equal(broadcasts, 0);
  assert.equal(result.journal.steps[0].status, "confirmed");
  assert.equal(result.journal.steps[0].intent.rawTransaction, undefined);
});

test("V3 recovery refuses nonce advancement and requires canonical confirmation depth", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "recourse-v3-recovery-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = await deploymentFixture();
  let { path, journal } = initializeV3DeploymentJournal({
    manifestPath: join(directory, "deployment.json"),
    config: fixture.config,
    plan: fixture.plan,
    qualification: fixture.qualification,
    approval: fixture.approval,
  });
  journal = await prepareV3DeploymentStep({
    journal,
    journalPath: path,
    stepIndex: 0,
    signer: fixture.signer,
  });
  let broadcasts = 0;
  await assert.rejects(
    () =>
      reconcileV3DeploymentStep({
        journal,
        journalPath: path,
        stepIndex: 0,
        provider: {
          getNetwork: async () => ({ chainId: BigInt(fixture.config.chainId) }),
          getTransactionReceipt: async () => null,
          getTransaction: async () => null,
          getTransactionCount: async () => fixture.plan.steps[0].nonce + 1,
          broadcastTransaction: async () => {
            broadcasts += 1;
          },
        },
        targetConfirmations: 1,
        maximumReceiptPolls: 1,
      }),
    /nonce 7 was advanced or replaced/,
  );
  assert.equal(broadcasts, 0);

  const transaction = Transaction.from(journal.steps[0].intent.rawTransaction);
  const receipt = {
    hash: transaction.hash,
    status: 1,
    blockNumber: 50,
    blockHash: HASH("e"),
    contractAddress: fixture.plan.steps[0].predictedContract,
  };
  let head = 49;
  let delays = 0;
  const confirmed = await reconcileV3DeploymentStep({
    journal,
    journalPath: path,
    stepIndex: 0,
    provider: {
      getNetwork: async () => ({ chainId: BigInt(fixture.config.chainId) }),
      getTransactionReceipt: async () => receipt,
      getTransaction: async () => transaction,
      getBlockNumber: async () => {
        head += 1;
        return head;
      },
      getBlock: async () => ({ hash: receipt.blockHash }),
    },
    targetConfirmations: 3,
    maximumReceiptPolls: 4,
    delay: async () => {
      delays += 1;
    },
  });
  assert.equal(confirmed.journal.steps[0].status, "confirmed");
  assert.equal(delays, 2);

  const reorgDirectory = mkdtempSync(join(tmpdir(), "recourse-v3-reorg-"));
  t.after(() => rmSync(reorgDirectory, { recursive: true, force: true }));
  let reorgJournal = initializeV3DeploymentJournal({
    manifestPath: join(reorgDirectory, "deployment.json"),
    config: fixture.config,
    plan: fixture.plan,
    qualification: fixture.qualification,
    approval: fixture.approval,
  });
  reorgJournal.journal = await prepareV3DeploymentStep({
    journal: reorgJournal.journal,
    journalPath: reorgJournal.path,
    stepIndex: 0,
    signer: fixture.signer,
  });
  await assert.rejects(
    () =>
      reconcileV3DeploymentStep({
        journal: reorgJournal.journal,
        journalPath: reorgJournal.path,
        stepIndex: 0,
        provider: {
          getNetwork: async () => ({ chainId: BigInt(fixture.config.chainId) }),
          getTransactionReceipt: async () => receipt,
          getTransaction: async () => transaction,
          getBlock: async () => ({ hash: HASH("f") }),
        },
        targetConfirmations: 1,
        maximumReceiptPolls: 1,
      }),
    /not canonical/,
  );
});

test("an expired partial V3 deployment requires renewal bound to the exact journal checkpoint", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "recourse-v3-renewal-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = await deploymentFixture();
  let { path, journal } = initializeV3DeploymentJournal({
    manifestPath: join(directory, "deployment.json"),
    config: fixture.config,
    plan: fixture.plan,
    qualification: fixture.qualification,
    approval: fixture.approval,
  });
  journal = await prepareV3DeploymentStep({
    journal,
    journalPath: path,
    stepIndex: 0,
    signer: fixture.signer,
  });
  const transaction = Transaction.from(journal.steps[0].intent.rawTransaction);
  const receipt = {
    hash: transaction.hash,
    status: 1,
    blockNumber: 60,
    blockHash: HASH("1"),
    contractAddress: fixture.plan.steps[0].predictedContract,
  };
  journal = (
    await reconcileV3DeploymentStep({
      journal,
      journalPath: path,
      stepIndex: 0,
      provider: {
        getNetwork: async () => ({ chainId: BigInt(fixture.config.chainId) }),
        getTransactionReceipt: async () => receipt,
        getTransaction: async () => transaction,
        getBlock: async () => ({ hash: receipt.blockHash }),
      },
      targetConfirmations: 1,
      maximumReceiptPolls: 1,
    })
  ).journal;
  assert.equal(
    validateV3DeploymentApproval({
      approval: fixture.approval,
      expectedApprovalCommitment: fixture.approval.approvalCommitment,
      config: fixture.config,
      plan: fixture.plan,
      qualification: fixture.qualification,
      now: 1_001,
      journal,
    }),
    fixture.approval,
  );
  assert.throws(
    () =>
      validateV3DeploymentApproval({
        approval: fixture.approval,
        expectedApprovalCommitment: fixture.approval.approvalCommitment,
        config: fixture.config,
        plan: fixture.plan,
        qualification: fixture.qualification,
        now: fixture.approval.validUntil + 1,
        journal,
      }),
    /expired/,
  );

  const renewal = createV3DeploymentRenewalBinding(journal);
  assert.equal(validateV3DeploymentRenewalBinding(renewal, journal), true);
  const newQualification = {
    ...fixture.qualification,
    blockNumber: 700,
    blockHash: HASH("2"),
    blockTimestamp: fixture.approval.validUntil + 10,
    pendingNonce: fixture.plan.steps[1].nonce,
  };
  const renewedApproval = createV3DeploymentApproval({
    config: fixture.config,
    plan: fixture.plan,
    qualification: newQualification,
    executionPlan: fixture.executionPlan,
    now: fixture.approval.validUntil + 10,
    journal,
  });
  assert.equal(
    validateV3DeploymentApproval({
      approval: renewedApproval,
      expectedApprovalCommitment: renewedApproval.approvalCommitment,
      config: fixture.config,
      plan: fixture.plan,
      qualification: newQualification,
      now: renewedApproval.issuedAt + 1,
      journal,
    }),
    renewedApproval,
  );

  const tampered = structuredClone(journal);
  tampered.executionPlan.steps[1].maxFeePerGas = "3";
  assert.throws(
    () => validateV3DeploymentRenewalBinding(renewal, tampered),
    /does not match its journal/,
  );
  const changedProvenance = structuredClone(journal);
  changedProvenance.artifactHashes.PolicyKernelV2 = HASH("f");
  assert.throws(
    () => validateV3DeploymentRenewalBinding(renewal, changedProvenance),
    /does not match its journal/,
  );
  const changedQualification = structuredClone(journal);
  changedQualification.qualification.blockHash = HASH("e");
  assert.throws(
    () => validateV3DeploymentRenewalBinding(renewal, changedQualification),
    /does not match its journal/,
  );
});

test("V3 transaction qualification proves all six canonical transactions match the approved plan", async () => {
  const fixture = await deploymentFixture();
  const transactions = {};
  const canonicalTransactions = new Map();
  const receipts = new Map();
  for (const [index, step] of fixture.executionPlan.steps.entries()) {
    const rawTransaction = await fixture.wallet.signTransaction({
      type: step.type,
      chainId: step.chainId,
      nonce: step.nonce,
      ...(step.to === null ? {} : { to: step.to }),
      data: step.data,
      value: step.value,
      gasLimit: step.gasLimit,
      maxFeePerGas: step.maxFeePerGas,
      maxPriorityFeePerGas: step.maxPriorityFeePerGas,
    });
    const transaction = Transaction.from(rawTransaction);
    const receipt = {
      hash: transaction.hash,
      status: 1,
      blockNumber: 100 + index,
      blockHash: HASH(String(index + 1)),
      contractAddress: step.predictedContract,
    };
    canonicalTransactions.set(transaction.hash.toLowerCase(), transaction);
    receipts.set(transaction.hash.toLowerCase(), receipt);
    transactions[step.name] = {
      hash: transaction.hash,
      from: step.from,
      to: step.to,
      nonce: step.nonce,
      dataHash: step.dataHash,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      contractAddress: receipt.contractAddress,
    };
  }
  const manifest = {
    executionPlan: fixture.executionPlan,
    executionPlanCommitment: fixture.executionPlan.commitment,
    canonicalTransactions: transactions,
  };
  let reorgedBlock;
  const provider = {
    getTransaction: async (hash) =>
      canonicalTransactions.get(hash.toLowerCase()),
    getTransactionReceipt: async (hash) => receipts.get(hash.toLowerCase()),
    getBlock: async (blockNumber) => ({
      hash:
        blockNumber === reorgedBlock
          ? HASH("f")
          : [...receipts.values()].find(
              (receipt) => receipt.blockNumber === blockNumber,
            ).blockHash,
    }),
  };

  const verified = await verifyV3DeploymentTransactions({
    manifest,
    config: fixture.config,
    plan: fixture.plan,
    provider,
  });
  assert.deepEqual(Object.keys(verified), [
    ...CORE_CONTRACT_NAMES,
    "setProofJobs",
  ]);
  assert.equal(verified.setProofJobs.contractAddress, null);

  reorgedBlock = transactions.setProofJobs.blockNumber;
  await assert.rejects(
    () =>
      verifyV3DeploymentTransactions({
        manifest,
        config: fixture.config,
        plan: fixture.plan,
        provider,
      }),
    /receipt is no longer canonical/,
  );
});

test("V3 manifest construction preserves activation compatibility and records complete release evidence", async () => {
  const fixture = await deploymentFixture();
  const canonicalTransactions = Object.fromEntries(
    fixture.executionPlan.steps.map((step, index) => [
      step.name,
      {
        hash: HASH(String(index + 1)),
        from: step.from,
        to: step.to,
        nonce: step.nonce,
        dataHash: step.dataHash,
        blockNumber: 100 + index,
        blockHash: HASH(String(index + 1)),
        contractAddress: step.predictedContract,
      },
    ]),
  );
  const journal = {
    executionPlan: fixture.executionPlan,
    executionPlanCommitment: fixture.executionPlan.commitment,
    qualification: fixture.qualification,
    steps: fixture.executionPlan.steps.map((step) => ({
      ...step,
      status: "confirmed",
      receipt: canonicalTransactions[step.name],
    })),
  };
  const runtimeCodeHashes = Object.fromEntries(
    CORE_ARTIFACT_NAMES.map((name, index) => [name, HASH(String(index + 1))]),
  );
  const creditState = getCreateAddress({
    from: fixture.plan.predictedContracts.PolicyKernelV2,
    nonce: 1,
  });
  const verification = {
    creditState,
    runtimeCodeHashes,
    verifiedAtBlock: 200,
    verifiedAtBlockHash: HASH("b"),
  };
  const manifest = buildV3DeploymentManifest({
    config: fixture.config,
    plan: fixture.plan,
    journal,
    approval: fixture.approval,
    verification,
    canonicalTransactions,
  });
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.sourceCommit, SOURCE_COMMIT);
  assert.equal(manifest.contracts.verifiedCreditState, creditState);
  assert.equal(
    manifest.transactions.policyKernel,
    canonicalTransactions.PolicyKernelV2.hash,
  );
  assert.equal(
    manifest.transactions.setProofJobs,
    canonicalTransactions.setProofJobs.hash,
  );
  assert.deepEqual(manifest.canonicalTransactions, canonicalTransactions);
  assert.deepEqual(manifest.runtimeCodeHashes, runtimeCodeHashes);
  assert.equal(manifest.verifiedAtBlockHash, verification.verifiedAtBlockHash);
  assert.equal(
    manifest.approvedPlan.executionPlanCommitment,
    fixture.executionPlan.commitment,
  );
  assert.deepEqual(manifest.activation, {
    facilitiesCreated: 0,
    policiesConfigured: 0,
    registryClaimsPublished: 0,
    assetsTransferred: "0",
  });
  assert.equal(
    validateV3DeploymentManifest({
      manifest,
      config: fixture.config,
      plan: fixture.plan,
      verification,
      canonicalTransactions,
    }),
    manifest,
  );
  assert.throws(
    () =>
      validateV3DeploymentManifest({
        manifest: {
          ...manifest,
          verifiedAtBlock: 0,
          wiringVerifiedAtBlock: 0,
        },
        config: fixture.config,
        plan: fixture.plan,
        verification: { ...verification, verifiedAtBlock: 0 },
        canonicalTransactions,
      }),
    /confirmation depth|verification block/i,
  );
  assert.throws(
    () =>
      validateV3DeploymentManifest({
        manifest: { ...manifest, verifiedAtBlockHash: HASH("f") },
        config: fixture.config,
        plan: fixture.plan,
        verification,
        canonicalTransactions,
      }),
    /block hash|qualified plan/i,
  );
  const approvalWithoutQualification = {
    ...fixture.approval,
    qualification: undefined,
  };
  approvalWithoutQualification.approvalCommitment =
    v3DeploymentApprovalCommitment(approvalWithoutQualification);
  assert.throws(
    () =>
      buildV3DeploymentManifest({
        config: fixture.config,
        plan: fixture.plan,
        journal,
        approval: approvalWithoutQualification,
        verification,
        canonicalTransactions,
      }),
    /qualification/i,
  );
  assert.throws(
    () =>
      validateV3DeploymentManifest({
        manifest: {
          ...manifest,
          contracts: { ...manifest.contracts, policyRegistry: ADDRESS("bad") },
        },
        config: fixture.config,
        plan: fixture.plan,
        verification,
        canonicalTransactions,
      }),
    /manifest does not match/i,
  );

  const incomplete = { ...canonicalTransactions };
  delete incomplete.setProofJobs;
  assert.throws(
    () =>
      buildV3DeploymentManifest({
        config: fixture.config,
        plan: fixture.plan,
        journal,
        approval: fixture.approval,
        verification,
        canonicalTransactions: incomplete,
      }),
    /canonical transaction set mismatch/,
  );
});

test("V3 preflight validates chain, verifier, signer, asset, balances, allowances, and artifacts", async () => {
  const signer = Wallet.createRandom();
  const config = fixtureConfig(signer.address);
  const normalized = validateV3DeploymentConfig(config);
  const provider = {
    getNetwork: async () => ({ chainId: 102031n }),
    getCode: async () => "0x6000",
    getBalance: async () => 1000n,
  };
  const asset = {
    decimals: async () => 6n,
    balanceOf: async () => 2000n,
    allowance: async () => 3000n,
  };
  const verifier = { calculateTxIndex: async () => 0n };

  const result = await runV3Preflight({
    provider,
    signer,
    verifier,
    asset,
    config: normalized,
    artifacts: artifacts(config),
  });
  assert.deepEqual(result, {
    chainId: 102031,
    deployer: signer.address,
    verifierPrecompileResponsive: true,
    assetCodePresent: true,
    checkedNativeBalances: 1,
    checkedAssetBalances: 1,
    checkedAssetAllowances: 1,
    checkedArtifacts: CORE_ARTIFACT_NAMES.length,
  });

  await assert.rejects(
    () =>
      runV3Preflight({
        provider,
        signer,
        verifier,
        asset: { ...asset, allowance: async () => 2999n },
        config: normalized,
        artifacts: artifacts(config),
      }),
    /Insufficient asset allowance for lender/,
  );

  const recovery = await runV3Preflight({
    provider: {
      ...provider,
      getBalance: async () => {
        throw new Error("mutable balance must not block recovery");
      },
    },
    signer,
    verifier,
    asset: {
      decimals: asset.decimals,
      balanceOf: async () => {
        throw new Error("mutable asset balance must not block recovery");
      },
      allowance: async () => {
        throw new Error("mutable allowance must not block recovery");
      },
    },
    config: normalized,
    artifacts: artifacts(config),
    checkConfiguredFunding: false,
  });
  assert.equal(recovery.checkedNativeBalances, 0);
  assert.equal(recovery.checkedAssetBalances, 0);
  assert.equal(recovery.checkedAssetAllowances, 0);

  await assert.rejects(
    () =>
      runV3DeploymentFundingPreflight({
        provider: { getBalance: async () => 35n },
        deployer: signer.address,
        steps: [
          { type: 2, gasLimit: "3", maxFeePerGas: "10", value: "1" },
          { type: 0, gasLimit: "2", gasPrice: "3", value: "0" },
        ],
      }),
    /Insufficient native balance for remaining V3 deployment transactions/,
  );
  assert.deepEqual(
    await runV3DeploymentFundingPreflight({
      provider: { getBalance: async () => 37n },
      deployer: signer.address,
      steps: [
        { type: 2, gasLimit: "3", maxFeePerGas: "10", value: "1" },
        { type: 0, gasLimit: "2", gasPrice: "3", value: "0" },
      ],
    }),
    {
      deployer: signer.address,
      remainingTransactions: 2,
      requiredWei: "37",
      availableWei: "37",
    },
  );
});
