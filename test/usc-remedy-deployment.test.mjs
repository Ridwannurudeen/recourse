import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AbiCoder,
  Interface,
  Transaction,
  Wallet,
  ZeroAddress,
  getAddress,
  getCreateAddress,
  keccak256,
  toBeHex,
  zeroPadValue,
} from "ethers";
import {
  USC_REMEDY_ARTIFACTS,
  USC_ACKNOWLEDGEMENT_VALIDATOR_ABI,
  USC_ATTESTOR_REGISTRY_ABI,
  buildUscRemedyLiveExecutionPlan,
  buildUscRemedyDeploymentPlan,
  createUscRemedyApproval,
  finalizeUscRemedyDeployment,
  initializeUscRemedyJournal,
  decodeOutbox020Constructor,
  decodeInbox020Constructor,
  parseUscRemedyDeploymentArguments,
  qualifyUscRemedyDependencies,
  readUscRemedyJournal,
  readUscRemedyArtifacts,
  reconcileUscRemedyStep,
  prepareUscRemedyStep,
  validateSignedUscStep,
  validateUscRemedyApproval,
  validateUscRemedyDeploymentConfig,
  validateUscRemedyDeploymentManifest,
  uscRemedyApprovalCommitment,
  verifyDeployedUscRemedyRoute,
  verifyInstalledUscContracts020,
  verifyUscRemedyDeploymentTransactions,
} from "../scripts/lib/usc-remedy-deployment.mjs";

const ADDRESS = (suffix) =>
  getAddress(`0x${"0".repeat(40 - suffix.length)}${suffix}`);
const HASH = (byte) =>
  `0x${byte.length === 1 ? byte.repeat(64) : byte.repeat(32)}`;
const CODE = "0x60006000f3";
const CODE_HASH = keccak256(CODE);
const DESTINATION_USC_CHAIN_KEY = zeroPadValue(toBeHex(3), 32);
const SOURCE_DEPLOYER = ADDRESS("d01");
const DESTINATION_DEPLOYER = ADDRESS("d02");
const OUTBOX = ADDRESS("100");
const INBOX = ADDRESS("200");
const ACK_DEPLOYER = ADDRESS("a05");
const ACK_DEPLOYMENT_NONCE = 2;
const VALIDATOR = getCreateAddress({
  from: ACK_DEPLOYER,
  nonce: ACK_DEPLOYMENT_NONCE,
});
const INBOX_VALIDATOR = ADDRESS("301");
const VAULT = ADDRESS("400");
const REGISTRY = ADDRESS("500");
const TOKEN = ADDRESS("600");
const CONTEXT = ADDRESS("700");
const CURRENT_DISPATCHER = ADDRESS("800");
const GUARDIAN = ADDRESS("900");
const PROOF_VERIFIER = ADDRESS("a00");
const ACK_VALIDATOR_OWNER = ADDRESS("a01");
const ATTESTOR_REGISTRY_DEPLOYER = ADDRESS("a06");
const ATTESTOR_REGISTRY_DEPLOYMENT_NONCE = 3;
const ATTESTOR_REGISTRY = getCreateAddress({
  from: ATTESTOR_REGISTRY_DEPLOYER,
  nonce: ATTESTOR_REGISTRY_DEPLOYMENT_NONCE,
});
const VOTE_VALIDATOR_OWNER = ADDRESS("a03");
const ATTESTOR_REGISTRY_OWNER = ADDRESS("a04");
const ATTESTORS = [ADDRESS("a11"), ADDRESS("a12"), ADDRESS("a13")];
const ACK_DEPLOYMENT_HASH = HASH("f");
const ATTESTOR_REGISTRY_DEPLOYMENT_HASH = HASH("e");
const ACK_CREATION_CODE = "0x6001";
const ATTESTOR_REGISTRY_CREATION_CODE = "0x6002";
const PREDICTED_DISPATCHER = getCreateAddress({
  from: DESTINATION_DEPLOYER,
  nonce: 12,
});
const PREDICTED_INBOX = getCreateAddress({
  from: DESTINATION_DEPLOYER,
  nonce: 13,
});

const constructorTypes = {
  UscRemedyTransportV1: [
    "address",
    "address",
    "address",
    "uint64",
    "address",
    "uint256",
  ],
  RemedyCoordinatorV1: ["address", "address"],
  BoundedRemedyReceiverV1: ["address", "address"],
  UscRemedyDispatcherV1: ["address", "uint64", "address", "address", "address"],
  Inbox020: ["bytes32", "uint256", "address", "address", "address"],
};

function artifact(name) {
  return {
    abi: [
      {
        type: "constructor",
        stateMutability: "nonpayable",
        inputs: constructorTypes[name].map((type, index) => ({
          name: `value${index}`,
          type,
        })),
      },
    ],
    bytecode: { object: CODE },
  };
}

function input(overrides = {}) {
  const artifacts = Object.fromEntries(
    USC_REMEDY_ARTIFACTS.map((name, index) => [
      name,
      { path: `${name}.json`, keccak256: HASH(String(index + 1)) },
    ]),
  );
  return {
    schemaVersion: 1,
    generation: "usc-remedy-v1",
    uscContractsVersion: "0.2.0",
    exclusiveSigners: true,
    source: {
      chainId: 102031,
      rpcUrlEnvironment: "CREDITCOIN_RPC_URL",
      privateKeyEnvironment: "SOURCE_DEPLOYER_PRIVATE_KEY",
      deployer: SOURCE_DEPLOYER,
      expectedStartingNonce: 7,
      context: { address: CONTEXT, runtimeCodeKeccak256: CODE_HASH },
      outbox: {
        address: OUTBOX,
        runtimeCodeKeccak256: CODE_HASH,
        deploymentTransactionHash: HASH("a"),
        chainKey: 3,
        owner: ADDRESS("111"),
        validator: {
          address: VALIDATOR,
          runtimeCodeKeccak256: CODE_HASH,
          dedicatedToRecourse: true,
          deploymentTransactionHash: ACK_DEPLOYMENT_HASH,
          creationCodeKeccak256: keccak256(ACK_CREATION_CODE),
          owner: ACK_VALIDATOR_OWNER,
          destinationChainKey: 3,
          outbox: OUTBOX,
          proofVerifier: {
            address: PROOF_VERIFIER,
            runtimeCodeKeccak256: CODE_HASH,
          },
          attestToken: TOKEN,
          trustedInboxes: [PREDICTED_INBOX],
        },
        defaultRateLimit: "25",
        attestorVault: { address: VAULT, runtimeCodeKeccak256: CODE_HASH },
        feeRegistry: { address: REGISTRY, runtimeCodeKeccak256: CODE_HASH },
        attestToken: { address: TOKEN, runtimeCodeKeccak256: CODE_HASH },
        maximumCoreFee: "10",
        paused: false,
      },
    },
    destination: {
      chainId: 1,
      uscChainKey: 3,
      rpcUrlEnvironment: "DESTINATION_RPC_URL",
      privateKeyEnvironment: "DESTINATION_DEPLOYER_PRIVATE_KEY",
      deployer: DESTINATION_DEPLOYER,
      expectedStartingNonce: 11,
      guardian: GUARDIAN,
      inbox: {
        dedicatedToRecourse: true,
        expectedAddress: PREDICTED_INBOX,
        localChainKey: DESTINATION_USC_CHAIN_KEY,
        creditcoinChainId: "102031",
        owner: DESTINATION_DEPLOYER,
        defaultVoteValidator: {
          address: INBOX_VALIDATOR,
          runtimeCodeKeccak256: CODE_HASH,
          validatorType: "eoa",
          owner: VOTE_VALIDATOR_OWNER,
          attestorRegistry: {
            address: ATTESTOR_REGISTRY,
            runtimeCodeKeccak256: CODE_HASH,
            dedicatedToRecourse: true,
            deploymentTransactionHash: ATTESTOR_REGISTRY_DEPLOYMENT_HASH,
            creationCodeKeccak256: keccak256(ATTESTOR_REGISTRY_CREATION_CODE),
            owner: ATTESTOR_REGISTRY_OWNER,
            authorizedUpdaters: [INBOX_VALIDATOR],
          },
          minAttestorCount: 3,
          thresholdNumerator: 20,
          thresholdAddition: 1,
          attestorSetUpdateNonce: 0,
          attestors: ATTESTORS,
        },
        paused: false,
      },
    },
    artifacts,
    transactionPolicy: {
      sourceConfirmations: 6,
      destinationConfirmations: 12,
      maximumReceiptPolls: 24,
      sourceFeePolicy: {
        transactionType: "eip1559",
        maximumGasLimit: "6000000",
        maximumFeePerGas: "100",
        maximumPriorityFeePerGas: "5",
      },
      destinationFeePolicy: {
        transactionType: "eip1559",
        maximumGasLimit: "6000000",
        maximumFeePerGas: "100",
        maximumPriorityFeePerGas: "5",
      },
    },
    ...overrides,
  };
}

function storageWord(addressValue) {
  return `0x${"0".repeat(24)}${addressValue.slice(2).toLowerCase()}`;
}

function encodedAcknowledgementValidatorDeployment(config) {
  const argumentsData = AbiCoder.defaultAbiCoder().encode(
    ["uint64", "address", "address", "address"],
    [
      config.source.outbox.validator.destinationChainKey,
      config.source.outbox.validator.owner,
      config.source.outbox.validator.proofVerifier.address,
      config.source.outbox.validator.attestToken,
    ],
  );
  return `${ACK_CREATION_CODE}${argumentsData.slice(2)}`;
}

function encodedAttestorRegistryDeployment(config) {
  const argumentsData = AbiCoder.defaultAbiCoder().encode(
    ["address", "address[]"],
    [
      config.destination.inbox.defaultVoteValidator.attestorRegistry.owner,
      config.destination.inbox.defaultVoteValidator.attestors,
    ],
  );
  return `${ATTESTOR_REGISTRY_CREATION_CODE}${argumentsData.slice(2)}`;
}

function eventLog({
  abi,
  eventName,
  values,
  address: contractAddress,
  blockNumber,
  index = 0,
}) {
  const contractInterface = new Interface(abi);
  const encoded = contractInterface.encodeEventLog(
    contractInterface.getEvent(eventName),
    values,
  );
  return {
    address: contractAddress,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber,
    transactionIndex: 0,
    index,
    removed: false,
  };
}

function acknowledgementTrustedInboxLog(
  inbox = PREDICTED_INBOX,
  trusted = true,
) {
  return eventLog({
    abi: USC_ACKNOWLEDGEMENT_VALIDATOR_ABI,
    eventName: "TrustedInboxUpdated",
    values: [inbox, trusted],
    address: VALIDATOR,
    blockNumber: 92,
  });
}

function registryUpdaterLog(updater = INBOX_VALIDATOR, authorized = true) {
  return eventLog({
    abi: USC_ATTESTOR_REGISTRY_ABI,
    eventName: "UpdaterSet",
    values: [updater, authorized],
    address: ATTESTOR_REGISTRY,
    blockNumber: 191,
  });
}

function restartQualificationInputs(
  config,
  plan,
  { transportDeployed, transaction },
) {
  const outboxArguments = AbiCoder.defaultAbiCoder().encode(
    [
      "uint32",
      "address",
      "address",
      "uint128",
      "address",
      "address",
      "address",
    ],
    [3, ADDRESS("111"), VALIDATOR, 25, VAULT, REGISTRY, TOKEN],
  );
  const deploymentReceipt = {
    hash: HASH("a"),
    status: 1,
    contractAddress: OUTBOX,
    blockNumber: 90,
    blockHash: HASH("ee"),
  };
  const acknowledgementDeploymentReceipt = {
    hash: ACK_DEPLOYMENT_HASH,
    status: 1,
    contractAddress: VALIDATOR,
    blockNumber: 91,
    blockHash: HASH("ed"),
  };
  const registryDeploymentReceipt = {
    hash: ATTESTOR_REGISTRY_DEPLOYMENT_HASH,
    status: 1,
    contractAddress: ATTESTOR_REGISTRY,
    blockNumber: 190,
    blockHash: HASH("dc"),
  };
  const recoveredReceipt = transaction
    ? {
        hash: transaction.hash,
        status: 1,
        contractAddress: plan.predictedContracts.transport,
        blockNumber: 44,
        blockHash: HASH("dd"),
      }
    : undefined;
  const sourceProvider = {
    getNetwork: async () => ({ chainId: 102031n }),
    getTransactionCount: async () => (transportDeployed ? 8 : 7),
    getCode: async (contractAddress) => {
      const normalized = getAddress(contractAddress);
      if (normalized === plan.predictedContracts.transport) {
        return transportDeployed ? CODE : "0x";
      }
      if (normalized === plan.predictedContracts.coordinator) return "0x";
      return CODE;
    },
    getTransaction: async (hash) =>
      hash.toLowerCase() === HASH("a")
        ? {
            hash: HASH("a"),
            to: null,
            data: `0x6000${outboxArguments.slice(2)}`,
          }
        : hash.toLowerCase() === ACK_DEPLOYMENT_HASH
          ? {
              hash: ACK_DEPLOYMENT_HASH,
              from: ACK_DEPLOYER,
              nonce: ACK_DEPLOYMENT_NONCE,
              to: null,
              data: encodedAcknowledgementValidatorDeployment(config),
            }
          : hash.toLowerCase() === transaction?.hash.toLowerCase()
            ? transaction
            : null,
    getTransactionReceipt: async (hash) =>
      hash.toLowerCase() === HASH("a")
        ? deploymentReceipt
        : hash.toLowerCase() === ACK_DEPLOYMENT_HASH
          ? acknowledgementDeploymentReceipt
          : hash.toLowerCase() === transaction?.hash.toLowerCase()
            ? recoveredReceipt
            : null,
    getStorage: async (_contractAddress, slot) => {
      const numeric = BigInt(slot);
      const base =
        0xab96e70160de0dc083b7f7505d7192c8db5b16070df1d645513a7957430b9700n;
      if (numeric === base + 6n) return storageWord(VAULT);
      if (numeric === base + 7n) return storageWord(TOKEN);
      if (numeric === base + 8n) return storageWord(REGISTRY);
      throw new Error("Unexpected Outbox storage slot");
    },
    getLogs: async () => [acknowledgementTrustedInboxLog()],
    getBlock: async (block) =>
      block === "latest"
        ? { number: 100, hash: HASH("c"), timestamp: 1_000 }
        : block === 90
          ? { number: 90, hash: HASH("ee"), timestamp: 900 }
          : block === 91
            ? { number: 91, hash: HASH("ed"), timestamp: 910 }
            : block === 100
              ? { number: 100, hash: HASH("c"), timestamp: 1_000 }
              : { number: 44, hash: HASH("dd"), timestamp: 440 },
  };
  const destinationProvider = {
    getNetwork: async () => ({ chainId: 1n }),
    getTransactionCount: async () => 11,
    getCode: async (contractAddress) =>
      [INBOX_VALIDATOR, ATTESTOR_REGISTRY].includes(getAddress(contractAddress))
        ? CODE
        : "0x",
    getTransaction: async (hash) =>
      hash.toLowerCase() === ATTESTOR_REGISTRY_DEPLOYMENT_HASH
        ? {
            hash: ATTESTOR_REGISTRY_DEPLOYMENT_HASH,
            from: ATTESTOR_REGISTRY_DEPLOYER,
            nonce: ATTESTOR_REGISTRY_DEPLOYMENT_NONCE,
            to: null,
            data: encodedAttestorRegistryDeployment(config),
          }
        : null,
    getTransactionReceipt: async (hash) =>
      hash.toLowerCase() === ATTESTOR_REGISTRY_DEPLOYMENT_HASH
        ? registryDeploymentReceipt
        : null,
    getLogs: async () => [registryUpdaterLog()],
    getBlock: async (block) =>
      block === 190
        ? { number: 190, hash: HASH("dc"), timestamp: 950 }
        : { number: 200, hash: HASH("d"), timestamp: 1_000 },
  };
  const contractFactory = (contractAddress) =>
    contractAddress === OUTBOX
      ? {
          chainKey: async () => 3n,
          coreFee: async () => 9n,
          feeRegistry: async () => REGISTRY,
          defaultRateLimit: async () => 25n,
          validator: async () => VALIDATOR,
          owner: async () => ADDRESS("111"),
          pendingOwner: async () => ZeroAddress,
          paused: async () => false,
        }
      : contractAddress === VALIDATOR
        ? {
            destinationChainKey: async () => 3n,
            outbox: async () => OUTBOX,
            proofVerifier: async () => PROOF_VERIFIER,
            attestToken: async () => TOKEN,
            trustedInboxes: async () => true,
            owner: async () => ACK_VALIDATOR_OWNER,
            pendingOwner: async () => ZeroAddress,
          }
        : contractAddress === INBOX_VALIDATOR
          ? {
              validatorType: async () => "eoa",
              owner: async () => VOTE_VALIDATOR_OWNER,
              pendingOwner: async () => ZeroAddress,
              attestorRegistry: async () => ATTESTOR_REGISTRY,
              minAttestorCount: async () => 3n,
              thresholdNumerator: async () => 20n,
              thresholdAddition: async () => 1n,
              attestorSetUpdateNonce: async () => 0n,
              attestors: async () => ATTESTORS,
              threshold: async () => 3n,
            }
          : {
              owner: async () => ATTESTOR_REGISTRY_OWNER,
              pendingOwner: async () => ZeroAddress,
              isUpdater: async () => true,
              attestors: async () => ATTESTORS,
            };
  return { sourceProvider, destinationProvider, contractFactory };
}

async function runRestartWorker() {
  const mode = process.env.USC_RESTART_WORKER;
  const directory = process.env.USC_RESTART_DIRECTORY;
  const scenarioPath = join(directory, "scenario.json");
  const approvalPath = join(directory, "approval.json");
  const manifestPath = join(directory, "deployment.json");
  if (mode === "create" || mode === "expired-create") {
    const wallet = Wallet.createRandom();
    const rawInput = input();
    rawInput.source.deployer = wallet.address;
    const config = validateUscRemedyDeploymentConfig(rawInput);
    const plan = await buildUscRemedyDeploymentPlan({
      config,
      artifacts: artifacts(),
    });
    const qualification = await qualifyUscRemedyDependencies({
      config,
      plan,
      ...restartQualificationInputs(config, plan, {
        transportDeployed: false,
      }),
    });
    const executionPlan = await liveExecutionPlan(config, plan);
    const approval = createUscRemedyApproval({
      config,
      plan,
      qualification,
      executionPlan,
      now: qualification.source.blockTimestamp,
    });
    let { path, journal } = initializeUscRemedyJournal({
      manifestPath,
      config,
      plan,
      qualification,
      approval,
    });
    journal = await prepareUscRemedyStep({
      journal,
      journalPath: path,
      stepIndex: 0,
      signer: {
        getAddress: async () => wallet.address,
        signTransaction: (request) => wallet.signTransaction(request),
      },
    });
    if (mode === "expired-create") {
      const transaction = Transaction.from(
        journal.steps[0].intent.rawTransaction,
      );
      const runtime = restartQualificationInputs(config, plan, {
        transportDeployed: true,
        transaction,
      });
      journal = (
        await reconcileUscRemedyStep({
          journal,
          journalPath: path,
          stepIndex: 0,
          provider: runtime.sourceProvider,
          targetConfirmations: 1,
          maximumReceiptPolls: 1,
        })
      ).journal;
      await Promise.all([
        writeFile(
          scenarioPath,
          `${JSON.stringify({ rawInput, privateKey: wallet.privateKey })}\n`,
          "utf8",
        ),
        writeFile(approvalPath, `${JSON.stringify(approval)}\n`, "utf8"),
      ]);
      process.stdout.write(
        `${JSON.stringify({ status: journal.steps[0].status })}\n`,
      );
      return;
    }
    await Promise.all([
      writeFile(scenarioPath, `${JSON.stringify(rawInput)}\n`, "utf8"),
      writeFile(approvalPath, `${JSON.stringify(approval)}\n`, "utf8"),
    ]);
    process.stdout.write(
      `${JSON.stringify({ status: journal.steps[0].status })}\n`,
    );
    return;
  }
  if (mode === "expired-resume") {
    const scenario = JSON.parse(await readFile(scenarioPath, "utf8"));
    const expiredApproval = JSON.parse(await readFile(approvalPath, "utf8"));
    const config = validateUscRemedyDeploymentConfig(scenario.rawInput);
    const plan = await buildUscRemedyDeploymentPlan({
      config,
      artifacts: artifacts(),
    });
    let { path, journal } = readUscRemedyJournal({
      manifestPath,
      config,
      plan,
    });
    const runtime = restartQualificationInputs(config, plan, {
      transportDeployed: true,
    });
    const qualification = await qualifyUscRemedyDependencies({
      config,
      plan,
      ...runtime,
      deploymentProgress: journal.steps,
    });
    let expiredRejected = false;
    try {
      validateUscRemedyApproval({
        approval: expiredApproval,
        expectedApprovalCommitment: expiredApproval.approvalCommitment,
        config,
        plan,
        qualification: journal.qualification,
        liveQualification: qualification,
        now: expiredApproval.validUntil + 1,
        journal,
      });
    } catch (error) {
      if (!/expired/.test(error.message)) throw error;
      expiredRejected = true;
    }
    qualification.source.blockTimestamp = expiredApproval.validUntil + 10;
    const renewedApproval = createUscRemedyApproval({
      config,
      plan,
      qualification,
      executionPlan: journal.executionPlan,
      now: qualification.source.blockTimestamp,
      journal,
    });
    validateUscRemedyApproval({
      approval: renewedApproval,
      expectedApprovalCommitment: renewedApproval.approvalCommitment,
      config,
      plan,
      qualification,
      now: renewedApproval.issuedAt + 1,
      journal,
    });
    const wallet = new Wallet(scenario.privateKey);
    journal = await prepareUscRemedyStep({
      journal,
      journalPath: path,
      stepIndex: 1,
      signer: {
        getAddress: async () => wallet.address,
        signTransaction: (request) => wallet.signTransaction(request),
      },
    });
    const transaction = Transaction.from(
      journal.steps[1].intent.rawTransaction,
    );
    const receipt = {
      hash: transaction.hash,
      status: 1,
      contractAddress: plan.predictedContracts.coordinator,
      blockNumber: 45,
      blockHash: HASH("cc"),
    };
    let broadcasts = 0;
    const provider = {
      ...runtime.sourceProvider,
      getTransactionCount: async () => 8,
      getTransactionReceipt: async (hash) =>
        hash.toLowerCase() === transaction.hash.toLowerCase() && broadcasts > 0
          ? receipt
          : null,
      getTransaction: async (hash) =>
        hash.toLowerCase() === transaction.hash.toLowerCase() && broadcasts > 0
          ? transaction
          : null,
      getBlockNumber: async () => 45,
      getBlock: async (block) =>
        block === 45
          ? { number: 45, hash: HASH("cc") }
          : runtime.sourceProvider.getBlock(block),
      broadcastTransaction: async () => {
        broadcasts += 1;
      },
    };
    journal = (
      await reconcileUscRemedyStep({
        journal,
        journalPath: path,
        stepIndex: 1,
        provider,
        targetConfirmations: 1,
        maximumReceiptPolls: 2,
        delay: async () => {},
        beforeBroadcast: async () =>
          validateUscRemedyApproval({
            approval: renewedApproval,
            expectedApprovalCommitment: renewedApproval.approvalCommitment,
            config,
            plan,
            qualification,
            now: renewedApproval.issuedAt + 1,
            journal,
          }),
      })
    ).journal;
    process.stdout.write(
      `${JSON.stringify({
        expiredRejected,
        renewalRemainingSteps: renewedApproval.renewal.remainingSteps.length,
        broadcasts,
        status: journal.steps[1].status,
      })}\n`,
    );
    return;
  }
  const rawInput = JSON.parse(await readFile(scenarioPath, "utf8"));
  const approval = JSON.parse(await readFile(approvalPath, "utf8"));
  const config = validateUscRemedyDeploymentConfig(rawInput);
  const plan = await buildUscRemedyDeploymentPlan({
    config,
    artifacts: artifacts(),
  });
  let { path, journal } = initializeUscRemedyJournal({
    manifestPath,
    config,
    plan,
    qualification: undefined,
    approval,
  });
  validateUscRemedyApproval({
    approval,
    expectedApprovalCommitment: approval.approvalCommitment,
    config,
    plan,
    qualification: journal.qualification,
    now: approval.issuedAt + 1,
  });
  const transaction = Transaction.from(journal.steps[0].intent.rawTransaction);
  const runtime = restartQualificationInputs(config, plan, {
    transportDeployed: true,
    transaction,
  });
  const qualification = await qualifyUscRemedyDependencies({
    config,
    plan,
    ...runtime,
    deploymentProgress: journal.steps,
  });
  const reconciled = await reconcileUscRemedyStep({
    journal,
    journalPath: path,
    stepIndex: 0,
    provider: runtime.sourceProvider,
    targetConfirmations: 1,
    maximumReceiptPolls: 1,
  });
  process.stdout.write(
    `${JSON.stringify({
      qualification: qualification.dedicatedInbox.status,
      step: reconciled.journal.steps[0].status,
    })}\n`,
  );
}

if (process.env.USC_RESTART_WORKER) {
  await runRestartWorker();
  process.exit(0);
}

test("USC live execution planning rejects over-cap and mismatched RPC fee modes", async () => {
  const sourceWallet = Wallet.createRandom();
  const destinationWallet = Wallet.createRandom();
  const rawInput = input();
  rawInput.source.deployer = sourceWallet.address;
  rawInput.destination.deployer = destinationWallet.address;
  rawInput.destination.inbox.expectedAddress = getCreateAddress({
    from: destinationWallet.address,
    nonce: rawInput.destination.expectedStartingNonce + 2,
  });
  rawInput.source.outbox.validator.trustedInboxes = [
    rawInput.destination.inbox.expectedAddress,
  ];
  const config = validateUscRemedyDeploymentConfig(rawInput);
  const plan = await buildUscRemedyDeploymentPlan({
    config,
    artifacts: artifacts(),
  });
  const signers = {
    source: {
      getAddress: async () => sourceWallet.address,
      populateTransaction: async (request) => ({
        ...request,
        type: 2,
        maxFeePerGas: 101n,
        maxPriorityFeePerGas: 2n,
      }),
    },
    destination: {
      getAddress: async () => destinationWallet.address,
      populateTransaction: async (request) => ({
        ...request,
        type: 2,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n,
      }),
    },
  };
  await assert.rejects(
    () => buildUscRemedyLiveExecutionPlan({ config, plan, signers }),
    /maximumFeePerGas exceeds the configured maximum/,
  );
  signers.source.populateTransaction = async (request) => ({
    ...request,
    type: 0,
    gasPrice: 2n,
  });
  await assert.rejects(
    () => buildUscRemedyLiveExecutionPlan({ config, plan, signers }),
    /requires an EIP-1559 transaction/,
  );
});

function artifacts() {
  return Object.fromEntries(
    USC_REMEDY_ARTIFACTS.map((name, index) => [
      name,
      { artifact: artifact(name), hash: HASH(String(index + 1)) },
    ]),
  );
}

async function liveExecutionPlan(config, plan) {
  return buildUscRemedyLiveExecutionPlan({
    config,
    plan,
    signers: Object.fromEntries(
      ["source", "destination"].map((network) => [
        network,
        {
          getAddress: async () => config[network].deployer,
          populateTransaction: async (request) => ({
            ...request,
            type: 2,
            maxFeePerGas: 2n,
            maxPriorityFeePerGas: 1n,
          }),
        },
      ]),
    ),
  });
}

test("USC remedy deployment is offline by default and broadcast requires an approved live plan", () => {
  assert.deepEqual(parseUscRemedyDeploymentArguments([]), {
    help: false,
    broadcast: false,
    liveCheck: false,
    qualifyDeployed: false,
    configPath: "config/usc-remedy.example.json",
    manifestPath: "usc-remedy-deployment.json",
    writePlanPath: undefined,
    approvedPlanPath: undefined,
    approvalCommitment: undefined,
  });
  assert.throws(
    () => parseUscRemedyDeploymentArguments(["--broadcast"]),
    /requires --live-check, --approved-plan, and --approval-commitment/,
  );
  const help = spawnSync(
    process.execPath,
    ["scripts/deploy-usc-remedy.mjs", "--help"],
    { cwd: process.cwd(), encoding: "utf8", env: {} },
  );
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Default: deterministic offline dry-run/);
  assert.match(help.stdout, /deploys a dedicated Inbox last/);
  assert.match(help.stdout, /never calls setMessageDispatcher/);
});

test("the USC example contains no guessed official addresses and cannot authorize a broadcast", async () => {
  const example = JSON.parse(
    await readFile("config/usc-remedy.example.json", "utf8"),
  );
  assert.match(example.source.outbox.address, /^REPLACE_WITH_/);
  assert.match(example.destination.inbox.expectedAddress, /^REPLACE_WITH_/);
  assert.throws(
    () => validateUscRemedyDeploymentConfig(example),
    /must be a nonnegative integer|must be a valid address/,
  );
});

test("installed USC contracts and dependency declarations pin the exact 0.2.0 APIs", async () => {
  const [packageJson, packageLock] = await Promise.all(
    ["package.json", "package-lock.json"].map(async (path) =>
      JSON.parse(await readFile(path, "utf8")),
    ),
  );
  assert.equal(packageJson.dependencies["@gluwa/usc-contracts"], "0.2.0");
  assert.equal(
    packageLock.packages[""].dependencies["@gluwa/usc-contracts"],
    "0.2.0",
  );
  assert.equal(
    packageLock.packages["node_modules/@gluwa/usc-contracts"].version,
    "0.2.0",
  );
  assert.deepEqual(verifyInstalledUscContracts020(), {
    packageName: "@gluwa/usc-contracts",
    version: "0.2.0",
  });
});

test("USC config rejects guessed chains and unsafe fee, chain, or pause evidence", () => {
  const valid = validateUscRemedyDeploymentConfig(input());
  assert.equal(valid.source.outbox.maximumCoreFee, 10n);
  assert.throws(
    () =>
      validateUscRemedyDeploymentConfig(
        input({ source: { ...input().source, chainId: 1 } }),
      ),
    /source.chainId must be the Recourse CC3 chain 102031/,
  );
  assert.throws(
    () =>
      validateUscRemedyDeploymentConfig(
        input({
          destination: {
            ...input().destination,
            inbox: {
              ...input().destination.inbox,
              creditcoinChainId: "1",
            },
          },
        }),
      ),
    /creditcoinChainId must match source.chainId/,
  );
  assert.throws(
    () =>
      validateUscRemedyDeploymentConfig(
        input({
          destination: {
            ...input().destination,
            inbox: {
              ...input().destination.inbox,
              localChainKey: HASH("b"),
            },
          },
        }),
      ),
    /localChainKey must equal the zero-padded destination.uscChainKey/,
  );
  assert.throws(
    () =>
      validateUscRemedyDeploymentConfig(
        input({
          destination: {
            ...input().destination,
            localChainKey: DESTINATION_USC_CHAIN_KEY,
          },
        }),
      ),
    /destination.localChainKey is unsupported/,
  );
  assert.throws(
    () =>
      validateUscRemedyDeploymentConfig({
        ...input(),
        source: {
          ...input().source,
          outbox: { ...input().source.outbox, paused: true },
        },
      }),
    /paused must explicitly be false/,
  );
  const wrongTrustedInbox = input();
  wrongTrustedInbox.source.outbox.validator.trustedInboxes = [ADDRESS("bad")];
  assert.throws(
    () => validateUscRemedyDeploymentConfig(wrongTrustedInbox),
    /trustedInboxes must be exactly the dedicated Inbox/,
  );
  const unsafeQuorum = input();
  unsafeQuorum.destination.inbox.defaultVoteValidator.minAttestorCount = 2;
  assert.throws(
    () => validateUscRemedyDeploymentConfig(unsafeQuorum),
    /minAttestorCount must be at least 3/,
  );
  const zeroQuorum = input();
  zeroQuorum.destination.inbox.defaultVoteValidator.thresholdNumerator = 0;
  zeroQuorum.destination.inbox.defaultVoteValidator.thresholdAddition = 0;
  assert.throws(
    () => validateUscRemedyDeploymentConfig(zeroQuorum),
    /threshold must be nonzero/,
  );
});

test("offline USC plan precomputes both dependency cycles and deploys the dedicated Inbox last", async () => {
  const config = validateUscRemedyDeploymentConfig(input());
  const first = await buildUscRemedyDeploymentPlan({
    config,
    artifacts: artifacts(),
  });
  const second = await buildUscRemedyDeploymentPlan({
    config,
    artifacts: artifacts(),
  });
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.steps.map(({ network, nonce }) => [network, nonce]),
    [
      ["source", 7],
      ["source", 8],
      ["destination", 11],
      ["destination", 12],
      ["destination", 13],
    ],
  );
  assert.equal(
    first.predictedContracts.transport,
    first.steps[0].predictedContract,
  );
  assert.equal(first.steps[3].name, "deployDispatcher");
  assert.equal(first.steps[4].name, "deployInbox");
  assert.equal(
    first.steps[4].predictedContract,
    first.predictedContracts.inbox,
  );
  assert.equal(
    first.predictedContracts.coordinator,
    first.steps[1].predictedContract,
  );
  const dispatcherArguments = AbiCoder.defaultAbiCoder().decode(
    constructorTypes.UscRemedyDispatcherV1,
    `0x${first.steps[3].data.slice(-constructorTypes.UscRemedyDispatcherV1.length * 64)}`,
  );
  const inboxArguments = AbiCoder.defaultAbiCoder().decode(
    constructorTypes.Inbox020,
    `0x${first.steps[4].data.slice(-constructorTypes.Inbox020.length * 64)}`,
  );
  assert.equal(
    getAddress(dispatcherArguments[0]),
    first.predictedContracts.inbox,
  );
  assert.equal(
    getAddress(inboxArguments[3]),
    first.predictedContracts.dispatcher,
  );
  assert.match(first.planCommitment, /^0x[0-9a-f]{64}$/);
});

test("USC deployment documentation preserves the nonce-bound source deployment order", async () => {
  const [roadmap, transportGuide] = await Promise.all([
    readFile("docs/ROADMAP-4-10-BUILD.md", "utf8"),
    readFile("docs/USC-REMEDY-TRANSPORT.md", "utf8"),
  ]);
  assert.match(
    roadmap,
    /source transport and coordinator, then the destination receiver/,
  );
  assert.match(
    transportGuide,
    /source transport,\s+source coordinator, destination receiver/,
  );
});

test("artifact loading pins hashes and exact route constructors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-usc-artifacts-"));
  const rawConfig = input();
  try {
    for (const name of USC_REMEDY_ARTIFACTS) {
      const raw = `${JSON.stringify(artifact(name))}\n`;
      const path = join(directory, `${name}.json`);
      await writeFile(path, raw, "utf8");
      rawConfig.artifacts[name] = {
        path,
        keccak256: keccak256(Buffer.from(raw)),
      };
    }
    const config = validateUscRemedyDeploymentConfig(rawConfig);
    assert.equal(
      Object.keys(readUscRemedyArtifacts(config)).length,
      USC_REMEDY_ARTIFACTS.length,
    );
    rawConfig.artifacts.UscRemedyTransportV1.keccak256 = HASH("f");
    assert.throws(
      () =>
        readUscRemedyArtifacts(validateUscRemedyDeploymentConfig(rawConfig)),
      /artifact hash mismatch/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("USC CLI rejects an untracked external config before RPC or signing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-usc-cli-"));
  const rawConfig = input();
  const configPath = join(directory, "config.json");
  const manifestPath = join(directory, "deployment.json");
  try {
    for (const name of USC_REMEDY_ARTIFACTS) {
      const raw = `${JSON.stringify(artifact(name))}\n`;
      const path = join(directory, `${name}.json`);
      await writeFile(path, raw, "utf8");
      rawConfig.artifacts[name] = {
        path,
        keccak256: keccak256(Buffer.from(raw)),
      };
    }
    await writeFile(configPath, `${JSON.stringify(rawConfig, null, 2)}\n`);
    const result = spawnSync(
      process.execPath,
      [
        "scripts/deploy-usc-remedy.mjs",
        "--config",
        configPath,
        "--manifest",
        manifestPath,
      ],
      { cwd: process.cwd(), encoding: "utf8", env: {} },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /inside the repository/);
    await assert.rejects(access(manifestPath), /ENOENT/);
    await assert.rejects(
      access(`${manifestPath}.usc-deployment-journal.json`),
      /ENOENT/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Outbox deployment evidence decodes the exact 0.2.0 constructor including ATTEST", () => {
  const encoded = AbiCoder.defaultAbiCoder().encode(
    [
      "uint32",
      "address",
      "address",
      "uint128",
      "address",
      "address",
      "address",
    ],
    [3, ADDRESS("111"), VALIDATOR, 25, VAULT, REGISTRY, TOKEN],
  );
  assert.deepEqual(decodeOutbox020Constructor(`0x6000${encoded.slice(2)}`), {
    chainKey: 3,
    owner: ADDRESS("111"),
    validator: VALIDATOR,
    defaultRateLimit: 25n,
    attestorVault: VAULT,
    feeRegistry: REGISTRY,
    attestToken: TOKEN,
  });
});

test("Inbox deployment evidence binds a dedicated Inbox to the predicted Recourse dispatcher", () => {
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint256", "address", "address", "address"],
    [
      DESTINATION_USC_CHAIN_KEY,
      102031,
      INBOX_VALIDATOR,
      PREDICTED_DISPATCHER,
      DESTINATION_DEPLOYER,
    ],
  );
  assert.deepEqual(decodeInbox020Constructor(`0x6000${encoded.slice(2)}`), {
    localChainKey: DESTINATION_USC_CHAIN_KEY,
    creditcoinChainId: 102031n,
    defaultVoteValidator: INBOX_VALIDATOR,
    messageDispatcher: PREDICTED_DISPATCHER,
    owner: DESTINATION_DEPLOYER,
  });
});

test("live qualification binds bytecode, APIs, constructor evidence, fees, nonces, and chain identities", async () => {
  const config = validateUscRemedyDeploymentConfig(input());
  const plan = await buildUscRemedyDeploymentPlan({
    config,
    artifacts: artifacts(),
  });
  const encoded = AbiCoder.defaultAbiCoder().encode(
    [
      "uint32",
      "address",
      "address",
      "uint128",
      "address",
      "address",
      "address",
    ],
    [3, ADDRESS("111"), VALIDATOR, 25, VAULT, REGISTRY, TOKEN],
  );
  let currentVault = VAULT;
  let acknowledgementPendingOwner = ZeroAddress;
  let acknowledgementLogs = [acknowledgementTrustedInboxLog()];
  let registryLogs = [registryUpdaterLog()];
  const sourceProvider = {
    getNetwork: async () => ({ chainId: 102031n }),
    getTransactionCount: async () => 7,
    getCode: async (contractAddress) =>
      [
        plan.predictedContracts.transport,
        plan.predictedContracts.coordinator,
      ].includes(getAddress(contractAddress))
        ? "0x"
        : CODE,
    getTransaction: async (hash) =>
      hash.toLowerCase() === HASH("a")
        ? {
            hash: HASH("a"),
            to: null,
            data: `0x6000${encoded.slice(2)}`,
          }
        : {
            hash: ACK_DEPLOYMENT_HASH,
            from: ACK_DEPLOYER,
            nonce: ACK_DEPLOYMENT_NONCE,
            to: null,
            data: encodedAcknowledgementValidatorDeployment(config),
          },
    getTransactionReceipt: async (hash) =>
      hash.toLowerCase() === HASH("a")
        ? {
            hash: HASH("a"),
            status: 1,
            contractAddress: OUTBOX,
            blockNumber: 90,
            blockHash: HASH("ee"),
          }
        : {
            hash: ACK_DEPLOYMENT_HASH,
            status: 1,
            contractAddress: VALIDATOR,
            blockNumber: 91,
            blockHash: HASH("ed"),
          },
    getStorage: async (_contractAddress, slot) => {
      const base =
        0xab96e70160de0dc083b7f7505d7192c8db5b16070df1d645513a7957430b9700n;
      if (BigInt(slot) === base + 6n) return storageWord(currentVault);
      if (BigInt(slot) === base + 7n) return storageWord(TOKEN);
      if (BigInt(slot) === base + 8n) return storageWord(REGISTRY);
      throw new Error("Unexpected Outbox storage slot");
    },
    getLogs: async () => acknowledgementLogs,
    getBlock: async (block) =>
      block === "latest"
        ? { number: 100, hash: HASH("c"), timestamp: 1_000 }
        : block === 90
          ? { number: 90, hash: HASH("ee"), timestamp: 900 }
          : block === 91
            ? { number: 91, hash: HASH("ed"), timestamp: 910 }
            : { number: 100, hash: HASH("c"), timestamp: 1_000 },
  };
  const destinationProvider = {
    getNetwork: async () => ({ chainId: 1n }),
    getTransactionCount: async () => 11,
    getCode: async (contractAddress) =>
      [INBOX_VALIDATOR, ATTESTOR_REGISTRY].includes(getAddress(contractAddress))
        ? CODE
        : "0x",
    getTransaction: async () => ({
      hash: ATTESTOR_REGISTRY_DEPLOYMENT_HASH,
      from: ATTESTOR_REGISTRY_DEPLOYER,
      nonce: ATTESTOR_REGISTRY_DEPLOYMENT_NONCE,
      to: null,
      data: encodedAttestorRegistryDeployment(config),
    }),
    getTransactionReceipt: async () => ({
      hash: ATTESTOR_REGISTRY_DEPLOYMENT_HASH,
      status: 1,
      contractAddress: ATTESTOR_REGISTRY,
      blockNumber: 190,
      blockHash: HASH("dc"),
    }),
    getLogs: async () => registryLogs,
    getBlock: async (block) =>
      block === 190
        ? { number: 190, hash: HASH("dc"), timestamp: 950 }
        : { number: 200, hash: HASH("d"), timestamp: 1_000 },
  };
  let trustedInbox = true;
  let voteThreshold = 3n;
  let registryUpdaterAuthorized = true;
  const contracts = (contractAddress) =>
    contractAddress === OUTBOX
      ? {
          chainKey: async () => 3n,
          coreFee: async () => 9n,
          feeRegistry: async () => REGISTRY,
          defaultRateLimit: async () => 25n,
          validator: async () => VALIDATOR,
          owner: async () => ADDRESS("111"),
          pendingOwner: async () => ZeroAddress,
          paused: async () => false,
        }
      : contractAddress === VALIDATOR
        ? {
            destinationChainKey: async () => 3n,
            outbox: async () => OUTBOX,
            proofVerifier: async () => PROOF_VERIFIER,
            attestToken: async () => TOKEN,
            trustedInboxes: async () => trustedInbox,
            owner: async () => ACK_VALIDATOR_OWNER,
            pendingOwner: async () => acknowledgementPendingOwner,
          }
        : contractAddress === INBOX_VALIDATOR
          ? {
              validatorType: async () => "eoa",
              owner: async () => VOTE_VALIDATOR_OWNER,
              pendingOwner: async () => ZeroAddress,
              attestorRegistry: async () => ATTESTOR_REGISTRY,
              minAttestorCount: async () => 3n,
              thresholdNumerator: async () => 20n,
              thresholdAddition: async () => 1n,
              attestorSetUpdateNonce: async () => 0n,
              attestors: async () => ATTESTORS,
              threshold: async () => voteThreshold,
            }
          : contractAddress === ATTESTOR_REGISTRY
            ? {
                owner: async () => ATTESTOR_REGISTRY_OWNER,
                pendingOwner: async () => ZeroAddress,
                isUpdater: async () => registryUpdaterAuthorized,
                attestors: async () => ATTESTORS,
              }
            : (() => {
                throw new Error("Preflight must not call the undeployed Inbox");
              })();
  const qualificationInputs = {
    config,
    plan,
    sourceProvider,
    destinationProvider,
    contractFactory: (contractAddress) => contracts(contractAddress),
  };
  const qualification = await qualifyUscRemedyDependencies(qualificationInputs);
  assert.equal(qualification.source.coreFee, "9");
  assert.equal(qualification.outboxConstructor.attestToken, TOKEN);
  assert.equal(qualification.destination.pendingNonce, 11);
  assert.equal(qualification.dedicatedInbox.status, "planned-empty");
  assert.deepEqual(qualification.dependencies.plannedRoute, {
    transport: "precomputed-no-code",
    coordinator: "precomputed-no-code",
    receiver: "precomputed-no-code",
    dispatcher: "precomputed-no-code",
    inbox: "precomputed-no-code",
  });
  await assert.rejects(
    () =>
      qualifyUscRemedyDependencies({
        ...qualificationInputs,
        destinationProvider: {
          ...destinationProvider,
          getCode: async (contractAddress) =>
            getAddress(contractAddress) === plan.predictedContracts.inbox
              ? CODE
              : destinationProvider.getCode(contractAddress),
        },
      }),
    /Predicted dedicated Inbox already has bytecode/,
  );
  trustedInbox = false;
  await assert.rejects(
    () => qualifyUscRemedyDependencies(qualificationInputs),
    /does not trust the dedicated Inbox/,
  );
  trustedInbox = true;
  voteThreshold = 2n;
  await assert.rejects(
    () => qualifyUscRemedyDependencies(qualificationInputs),
    /vote-validator threshold mismatch/,
  );
  voteThreshold = 3n;
  registryUpdaterAuthorized = false;
  await assert.rejects(
    () => qualifyUscRemedyDependencies(qualificationInputs),
    /not an authorized registry updater/,
  );
  registryUpdaterAuthorized = true;

  currentVault = ADDRESS("bad1");
  await assert.rejects(
    () => qualifyUscRemedyDependencies(qualificationInputs),
    /Outbox current attestor vault mismatch/,
  );
  currentVault = VAULT;

  acknowledgementPendingOwner = ADDRESS("bad2");
  await assert.rejects(
    () => qualifyUscRemedyDependencies(qualificationInputs),
    /AcknowledgementValidator pending owner mismatch/,
  );
  acknowledgementPendingOwner = ZeroAddress;

  acknowledgementLogs = [
    acknowledgementTrustedInboxLog(),
    acknowledgementTrustedInboxLog(ADDRESS("bad3")),
  ];
  await assert.rejects(
    () => qualifyUscRemedyDependencies(qualificationInputs),
    /exact trusted-Inbox set mismatch/,
  );
  acknowledgementLogs = [acknowledgementTrustedInboxLog()];

  registryLogs = [registryUpdaterLog(), registryUpdaterLog(ADDRESS("bad4"))];
  await assert.rejects(
    () => qualifyUscRemedyDependencies(qualificationInputs),
    /exact updater set mismatch/,
  );
  registryLogs = [registryUpdaterLog()];

  const approval = createUscRemedyApproval({
    config,
    plan,
    qualification,
    executionPlan: await liveExecutionPlan(config, plan),
    now: 1_000,
  });
  assert.equal(
    validateUscRemedyApproval({
      approval,
      expectedApprovalCommitment: approval.approvalCommitment,
      config,
      plan,
      qualification,
      now: 1_001,
    }),
    approval,
  );
  const forgedApproval = structuredClone(approval);
  forgedApproval.issuedAt += 86_400;
  forgedApproval.validUntil += 86_400;
  forgedApproval.sourceAnchor.blockTimestamp = forgedApproval.issuedAt;
  forgedApproval.approvalCommitment =
    uscRemedyApprovalCommitment(forgedApproval);
  assert.throws(
    () =>
      validateUscRemedyApproval({
        approval: forgedApproval,
        expectedApprovalCommitment: approval.approvalCommitment,
        config,
        plan,
        qualification: forgedApproval,
        liveQualification: qualification,
        now: forgedApproval.issuedAt,
      }),
    /approval commitment/i,
  );
  assert.throws(
    () =>
      validateUscRemedyApproval({
        approval: forgedApproval,
        expectedApprovalCommitment: forgedApproval.approvalCommitment,
        config,
        plan,
        qualification,
        liveQualification: qualification,
        now: forgedApproval.issuedAt,
      }),
    /qualification timestamp/i,
  );
  assert.throws(
    () =>
      validateUscRemedyApproval({
        approval,
        expectedApprovalCommitment: approval.approvalCommitment,
        config,
        plan,
        qualification,
        now: approval.validUntil + 1,
      }),
    /expired/,
  );
  const finalQualification = await qualifyUscRemedyDependencies({
    ...qualificationInputs,
    deploymentComplete: true,
    sourceProvider: {
      ...sourceProvider,
      getTransactionCount: async () => 9,
      getCode: async () => CODE,
    },
    destinationProvider: {
      ...destinationProvider,
      getTransactionCount: async () => 14,
      getCode: async () => CODE,
    },
    contractFactory: (contractAddress) =>
      getAddress(contractAddress) === plan.predictedContracts.inbox
        ? {
            localChainKey: async () => DESTINATION_USC_CHAIN_KEY,
            creditcoinChainId: async () => 102031n,
            defaultVoteValidator: async () => INBOX_VALIDATOR,
            messageDispatcher: async () => plan.predictedContracts.dispatcher,
            owner: async () => DESTINATION_DEPLOYER,
            pendingOwner: async () => ZeroAddress,
            paused: async () => false,
          }
        : contracts(contractAddress),
  });
  assert.equal(
    finalQualification.dedicatedInbox.status,
    "deployed-and-qualified",
  );
});

test("signed USC deployment transactions cannot substitute calldata, nonce, signer, chain, gas, or fees", async () => {
  const wallet = Wallet.createRandom();
  const step = {
    name: "installDispatcher",
    chainId: 1,
    nonce: 4,
    from: wallet.address,
    to: INBOX,
    data: "0x1234",
    dataHash: keccak256("0x1234"),
    value: "0",
    type: 2,
    gasLimit: "100000",
    gasPrice: null,
    maxFeePerGas: "2",
    maxPriorityFeePerGas: "1",
  };
  const raw = await wallet.signTransaction({
    chainId: 1,
    nonce: 4,
    to: INBOX,
    data: "0x1234",
    gasLimit: 100000,
    maxFeePerGas: 2,
    maxPriorityFeePerGas: 1,
    type: 2,
  });
  assert.equal(
    validateSignedUscStep(raw, step).hash,
    Transaction.from(raw).hash,
  );
  assert.throws(
    () => validateSignedUscStep(raw, { ...step, nonce: 5 }),
    /does not match its plan/,
  );
  const alteredFees = await wallet.signTransaction({
    chainId: 1,
    nonce: 4,
    to: INBOX,
    data: "0x1234",
    gasLimit: 100000,
    maxFeePerGas: 3,
    maxPriorityFeePerGas: 1,
    type: 2,
  });
  assert.throws(
    () => validateSignedUscStep(alteredFees, step),
    /does not match its plan/,
  );
  const alteredGas = await wallet.signTransaction({
    chainId: 1,
    nonce: 4,
    to: INBOX,
    data: "0x1234",
    gasLimit: 100001,
    maxFeePerGas: 2,
    maxPriorityFeePerGas: 1,
    type: 2,
  });
  assert.throws(
    () => validateSignedUscStep(alteredGas, step),
    /does not match its plan/,
  );
});

test("USC deployment journal survives a crash after signing and never rebroadcasts a mined step", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-usc-journal-"));
  const wallet = Wallet.createRandom();
  const rawInput = input();
  rawInput.source.deployer = wallet.address;
  const config = validateUscRemedyDeploymentConfig(rawInput);
  const plan = await buildUscRemedyDeploymentPlan({
    config,
    artifacts: artifacts(),
  });
  try {
    const executionPlan = await liveExecutionPlan(config, plan);
    const approval = createUscRemedyApproval({
      config,
      plan,
      qualification: {
        source: { blockTimestamp: 1_000 },
        destination: {},
        dependencies: {},
      },
      executionPlan,
      now: 1_000,
    });
    let { path, journal } = initializeUscRemedyJournal({
      manifestPath: join(directory, "deployment.json"),
      config,
      plan,
      qualification: { checked: true },
      approval,
    });
    const signer = {
      getAddress: async () => wallet.address,
      signTransaction: (request) => wallet.signTransaction(request),
    };
    journal = await prepareUscRemedyStep({
      journal,
      journalPath: path,
      stepIndex: 0,
      signer,
    });
    const transaction = Transaction.from(
      journal.steps[0].intent.rawTransaction,
    );
    const receipt = {
      hash: transaction.hash,
      status: 1,
      blockNumber: 10,
      blockHash: HASH("ee"),
      contractAddress: plan.predictedContracts.transport,
    };
    let broadcasts = 0;
    const result = await reconcileUscRemedyStep({
      journal,
      journalPath: path,
      stepIndex: 0,
      provider: {
        getNetwork: async () => ({ chainId: 102031n }),
        getTransactionReceipt: async () => receipt,
        getBlockNumber: async () => 11,
        getBlock: async () => ({ hash: receipt.blockHash }),
        getTransaction: async () => transaction,
        broadcastTransaction: async () => {
          broadcasts += 1;
        },
      },
      targetConfirmations: 2,
      maximumReceiptPolls: 3,
      delay: async () => {},
    });
    assert.equal(broadcasts, 0);
    assert.equal(result.journal.steps[0].status, "confirmed");
    assert.equal(result.journal.steps[0].intent.rawTransaction, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a resumed prepared USC step rechecks approval before first broadcast", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-usc-expiry-"));
  const wallet = Wallet.createRandom();
  const rawInput = input();
  rawInput.source.deployer = wallet.address;
  const config = validateUscRemedyDeploymentConfig(rawInput);
  const plan = await buildUscRemedyDeploymentPlan({
    config,
    artifacts: artifacts(),
  });
  try {
    const executionPlan = await liveExecutionPlan(config, plan);
    const approval = createUscRemedyApproval({
      config,
      plan,
      qualification: {
        source: { blockTimestamp: 1_000 },
        destination: {},
        dependencies: {},
      },
      executionPlan,
      now: 1_000,
    });
    let { path, journal } = initializeUscRemedyJournal({
      manifestPath: join(directory, "deployment.json"),
      config,
      plan,
      qualification: { checked: true },
      approval,
    });
    journal = await prepareUscRemedyStep({
      journal,
      journalPath: path,
      stepIndex: 0,
      signer: {
        getAddress: async () => wallet.address,
        signTransaction: (request) => wallet.signTransaction(request),
      },
    });
    let approvalChecks = 0;
    let broadcasts = 0;
    const provider = {
      getNetwork: async () => ({ chainId: 102031n }),
      getTransactionReceipt: async () => null,
      getTransaction: async () => null,
      getTransactionCount: async () => plan.steps[0].nonce,
      broadcastTransaction: async () => {
        broadcasts += 1;
      },
    };
    await assert.rejects(
      () =>
        reconcileUscRemedyStep({
          journal,
          journalPath: path,
          stepIndex: 0,
          provider,
          targetConfirmations: 1,
          maximumReceiptPolls: 1,
          beforeBroadcast: async () => {
            approvalChecks += 1;
            throw new Error("approval expired");
          },
        }),
      /approval expired/,
    );
    assert.equal(approvalChecks, 1);
    assert.equal(broadcasts, 0);

    approvalChecks = 0;
    const pendingTransaction = Transaction.from(
      journal.steps[0].intent.rawTransaction,
    );
    await assert.rejects(
      () =>
        reconcileUscRemedyStep({
          journal,
          journalPath: path,
          stepIndex: 0,
          provider: {
            ...provider,
            getTransaction: async () => pendingTransaction,
          },
          targetConfirmations: 1,
          maximumReceiptPolls: 1,
          beforeBroadcast: async () => {
            approvalChecks += 1;
            throw new Error("approval expired");
          },
        }),
      /remains pending/,
    );
    assert.equal(approvalChecks, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("USC deployment resumes and reconciles a prepared step after a real process restart", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "recourse-usc-process-restart-"),
  );
  const environment = {
    USC_RESTART_DIRECTORY: directory,
  };
  try {
    const first = spawnSync(
      process.execPath,
      ["test/usc-remedy-deployment.test.mjs"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...environment, USC_RESTART_WORKER: "create" },
      },
    );
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout), { status: "prepared" });

    const second = spawnSync(
      process.execPath,
      ["test/usc-remedy-deployment.test.mjs"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...environment, USC_RESTART_WORKER: "resume" },
      },
    );
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout), {
      qualification: "partially-deployed",
      step: "confirmed",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an expired partial USC deployment resumes only with journal-bound human reapproval", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "recourse-usc-renewal-restart-"),
  );
  const environment = { USC_RESTART_DIRECTORY: directory };
  try {
    const first = spawnSync(
      process.execPath,
      ["test/usc-remedy-deployment.test.mjs"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...environment, USC_RESTART_WORKER: "expired-create" },
      },
    );
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout), { status: "confirmed" });

    const second = spawnSync(
      process.execPath,
      ["test/usc-remedy-deployment.test.mjs"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...environment, USC_RESTART_WORKER: "expired-resume" },
      },
    );
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout), {
      expiredRejected: true,
      renewalRemainingSteps: 4,
      broadcasts: 1,
      status: "confirmed",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("final USC manifest writing is gated by postdeploy dependency, route, and canonical transaction qualification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-usc-final-gate-"));
  const manifestPath = join(directory, "deployment.json");
  const journalPath = `${manifestPath}.usc-deployment-journal.json`;
  const config = validateUscRemedyDeploymentConfig(input());
  const plan = await buildUscRemedyDeploymentPlan({
    config,
    artifacts: artifacts(),
  });
  const executionPlan = await liveExecutionPlan(config, plan);
  const journal = {
    schemaVersion: 1,
    generation: "usc-remedy-v1",
    phase: "deploying",
    configCommitment: plan.configCommitment,
    planCommitment: plan.planCommitment,
    predictedContracts: plan.predictedContracts,
    transactionPlan: plan.steps,
    executionPlan,
    executionPlanCommitment: executionPlan.commitment,
    steps: executionPlan.steps.map((step, index) => ({
      ...step,
      status: "confirmed",
      intent: {
        transactionHash: HASH((index + 1).toString(16)),
      },
      receipt: {
        hash: HASH((index + 1).toString(16)),
        blockNumber: 100 + index,
        blockHash: HASH((index + 10).toString(16)),
        contractAddress: step.predictedContract,
        status: 1,
      },
    })),
  };
  const safetyBoundary = {
    dedicatedInboxRequired: true,
    requiredMessageDispatcher: plan.predictedContracts.dispatcher,
    setMessageDispatcherCalledByThisTool: false,
  };
  try {
    await assert.rejects(
      () =>
        finalizeUscRemedyDeployment({
          manifestPath,
          journal,
          journalPath,
          installedPackage: { version: "0.2.0" },
          config,
          plan,
          sourceProvider: {},
          destinationProvider: {},
          safetyBoundary,
          qualifyDependencies: async () => {
            throw new Error(
              "AcknowledgementValidator exact trusted-Inbox set mismatch",
            );
          },
        }),
      /exact trusted-Inbox set mismatch/,
    );
    await assert.rejects(access(manifestPath), /ENOENT/);
    await assert.rejects(access(journalPath), /ENOENT/);

    const canonicalTransactions = Object.fromEntries(
      journal.steps.map((step) => [
        step.name,
        {
          hash: step.receipt.hash,
          blockNumber: step.receipt.blockNumber,
          blockHash: step.receipt.blockHash,
          contractAddress: step.receipt.contractAddress,
          creationDataHash: step.dataHash,
        },
      ]),
    );
    const manifest = await finalizeUscRemedyDeployment({
      manifestPath,
      journal,
      journalPath,
      installedPackage: { version: "0.2.0" },
      config,
      plan,
      sourceProvider: {},
      destinationProvider: {},
      safetyBoundary,
      qualifyDependencies: async () => ({
        dependencies: { exact: true },
        dedicatedInbox: { status: "deployed-and-qualified" },
      }),
      verifyRoute: async () => ({
        status: "qualified",
        messageDispatcher: plan.predictedContracts.dispatcher,
      }),
      verifyTransactions: async () => canonicalTransactions,
    });
    assert.deepEqual(manifest.dependencies, { exact: true });
    assert.deepEqual(manifest.canonicalTransactions, canonicalTransactions);
    assert.equal(
      JSON.parse(await readFile(manifestPath, "utf8")).status,
      "deployed-dedicated-inbox-route",
    );
    const truncatedTransactions = { ...manifest.canonicalTransactions };
    delete truncatedTransactions.deployInbox;
    assert.throws(
      () =>
        validateUscRemedyDeploymentManifest({
          manifest: {
            ...manifest,
            canonicalTransactions: truncatedTransactions,
          },
          config,
          plan,
        }),
      /canonical transaction set mismatch/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("final USC route qualification requires the constructor-bound predicted dispatcher", async () => {
  const config = validateUscRemedyDeploymentConfig(input());
  const plan = await buildUscRemedyDeploymentPlan({
    config,
    artifacts: artifacts(),
  });
  const sourceProvider = { getCode: async () => CODE };
  const destinationProvider = { getCode: async () => CODE };
  let installedDispatcher = CURRENT_DISPATCHER;
  const contracts = new Map([
    [
      plan.predictedContracts.transport,
      {
        coordinator: async () => plan.predictedContracts.coordinator,
        outbox: async () => OUTBOX,
        attestToken: async () => TOKEN,
        destinationChain: async () => 3n,
        destinationReceiver: async () => plan.predictedContracts.receiver,
        maximumCoreFee: async () => 10n,
      },
    ],
    [
      plan.predictedContracts.coordinator,
      {
        context: async () => CONTEXT,
        transport: async () => plan.predictedContracts.transport,
      },
    ],
    [
      plan.predictedContracts.receiver,
      {
        transport: async () => plan.predictedContracts.dispatcher,
        guardian: async () => GUARDIAN,
      },
    ],
    [
      plan.predictedContracts.dispatcher,
      {
        trustedInbox: async () => plan.predictedContracts.inbox,
        trustedSourceChain: async () => 102031n,
        trustedSourceAdapter: async () => plan.predictedContracts.transport,
        trustedSourceCoordinator: async () =>
          plan.predictedContracts.coordinator,
        destinationReceiver: async () => plan.predictedContracts.receiver,
      },
    ],
    [
      plan.predictedContracts.inbox,
      {
        messageDispatcher: async () => installedDispatcher,
        localChainKey: async () => DESTINATION_USC_CHAIN_KEY,
        creditcoinChainId: async () => 102031n,
        defaultVoteValidator: async () => INBOX_VALIDATOR,
        owner: async () => DESTINATION_DEPLOYER,
        pendingOwner: async () => ZeroAddress,
        paused: async () => false,
      },
    ],
  ]);
  const inputs = {
    config,
    plan,
    sourceProvider,
    destinationProvider,
    contractFactory: (contractAddress) => contracts.get(contractAddress),
  };
  await assert.rejects(
    verifyDeployedUscRemedyRoute(inputs),
    /Inbox installed message dispatcher mismatch/,
  );
  installedDispatcher = plan.predictedContracts.dispatcher;
  const qualified = await verifyDeployedUscRemedyRoute(inputs);
  assert.equal(qualified.status, "qualified");
  assert.equal(qualified.messageDispatcher, installedDispatcher);
});

test("deployed-route qualification proves every canonical creation transaction matches the pinned bytecode plan", async () => {
  const sourceWallet = Wallet.createRandom();
  const destinationWallet = Wallet.createRandom();
  const rawInput = input();
  rawInput.source.deployer = sourceWallet.address;
  rawInput.destination.deployer = destinationWallet.address;
  rawInput.destination.inbox.expectedAddress = getCreateAddress({
    from: destinationWallet.address,
    nonce: rawInput.destination.expectedStartingNonce + 2,
  });
  rawInput.source.outbox.validator.trustedInboxes = [
    rawInput.destination.inbox.expectedAddress,
  ];
  const config = validateUscRemedyDeploymentConfig(rawInput);
  const plan = await buildUscRemedyDeploymentPlan({
    config,
    artifacts: artifacts(),
  });
  const transactions = new Map();
  const receipts = new Map();
  const blocks = new Map();
  const executionPlan = await liveExecutionPlan(config, plan);
  const manifest = {
    transactions: {},
    executionPlan,
    executionPlanCommitment: executionPlan.commitment,
  };
  for (const [index, step] of executionPlan.steps.entries()) {
    const wallet = step.network === "source" ? sourceWallet : destinationWallet;
    const raw = await wallet.signTransaction({
      chainId: step.chainId,
      nonce: step.nonce,
      data: step.data,
      value: step.value,
      gasLimit: step.gasLimit,
      maxFeePerGas: step.maxFeePerGas,
      maxPriorityFeePerGas: step.maxPriorityFeePerGas,
      type: step.type,
    });
    const transaction = Transaction.from(raw);
    const blockHash = `0x${(index + 1).toString(16).padStart(64, "0")}`;
    const receipt = {
      hash: transaction.hash,
      status: 1,
      blockNumber: 100 + index,
      blockHash,
      contractAddress: step.predictedContract,
    };
    transactions.set(transaction.hash, transaction);
    receipts.set(transaction.hash, receipt);
    blocks.set(receipt.blockNumber, { hash: blockHash });
    manifest.transactions[step.name] = {
      hash: transaction.hash,
      blockNumber: receipt.blockNumber,
      blockHash,
      contractAddress: step.predictedContract,
    };
  }
  const provider = {
    getTransaction: async (hash) => transactions.get(hash),
    getTransactionReceipt: async (hash) => receipts.get(hash),
    getBlock: async (height) => blocks.get(height),
  };
  const verified = await verifyUscRemedyDeploymentTransactions({
    manifest,
    config,
    plan,
    sourceProvider: provider,
    destinationProvider: provider,
  });
  assert.equal(Object.keys(verified).length, 5);
  assert.deepEqual(
    Object.values(verified).map(({ creationDataHash }) => creationDataHash),
    plan.steps.map(({ dataHash }) => dataHash),
  );
});
