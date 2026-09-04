import {
  Contract,
  JsonRpcProvider,
  VoidSigner,
  Wallet,
  getAddress,
} from "ethers";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  V3_DEPLOYMENT_USAGE,
  atomicWriteJson,
  buildV3DeploymentLiveExecutionPlan,
  buildV3DeploymentManifest,
  buildV3DeploymentPlan,
  completeV3DeploymentJournal,
  createV3DeploymentApproval,
  initializeV3DeploymentJournal,
  parseV3DeploymentArguments,
  prepareV3DeploymentStep,
  qualifyV3DeploymentState,
  readCoreArtifacts,
  readV3DeploymentConfig,
  readV3DeploymentJournal,
  reconcileV3DeploymentStep,
  reserveV3Manifest,
  runV3DeploymentFundingPreflight,
  runV3Preflight,
  validateV3DeploymentApproval,
  validateV3DeploymentLiveExecutionPlan,
  validateV3DeploymentManifest,
  verifyV3Deployment,
  verifyV3DeploymentApprovalAnchor,
  verifyV3DeploymentBlockAnchor,
  verifyV3DeploymentTransactions,
  v3DeploymentJournalPath,
} from "./lib/v3-deployment.mjs";
import { inspectDeployableRepository } from "./lib/pilot-readiness.mjs";

const ASSET_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
];
const VERIFIER_ABI = [
  "function calculateTxIndex((bytes32 root,(bytes32 hash,bool isLeft)[] siblings) proof) view returns (uint64)",
];

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${name} is required`);
  return value;
}

function providerFromEnvironment() {
  const value = requiredEnvironment("CREDITCOIN_RPC_URL");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("CREDITCOIN_RPC_URL must contain a valid RPC URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("CREDITCOIN_RPC_URL must contain an HTTP(S) RPC URL");
  }
  return new JsonRpcProvider(value);
}

function print(value) {
  process.stdout.write(
    `${JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item), 2)}\n`,
  );
}

const options = parseV3DeploymentArguments(process.argv.slice(2));
if (options.help) {
  process.stdout.write(`${V3_DEPLOYMENT_USAGE}\n`);
  process.exit(0);
}

const config = readV3DeploymentConfig(options.configPath);
const artifacts = readCoreArtifacts(config);
const repositoryState = inspectDeployableRepository(process.cwd());

if (!options.liveCheck) {
  print({
    mode: "offline-dry-run",
    generation: config.generation,
    chainId: config.chainId,
    sourceCommit: repositoryState.head,
    deployableScopeClean: repositoryState.deployableScopeClean,
    artifactHashes: Object.fromEntries(
      Object.entries(artifacts).map(([name, artifact]) => [
        name,
        artifact.hash,
      ]),
    ),
    transactionPlan: null,
    liveCheckRequiredForNonceAndFees: true,
    transactionsBroadcast: 0,
    filesWritten: 0,
  });
  process.exit(0);
}

await import("dotenv/config");
const provider = providerFromEnvironment();
let approval;
if (options.broadcast) {
  approval = JSON.parse(
    readFileSync(resolve(options.approvedPlanPath), "utf8"),
  );
}

const rawJournalPath = v3DeploymentJournalPath(options.manifestPath);
const rawJournal = existsSync(rawJournalPath)
  ? JSON.parse(readFileSync(rawJournalPath, "utf8"))
  : undefined;
const startingNonce =
  rawJournal?.transactionPlan?.[0]?.nonce ??
  approval?.executionPlan?.steps?.[0]?.nonce ??
  (await provider.getTransactionCount(config.roles.deployer, "pending"));
const plan = await buildV3DeploymentPlan({
  config,
  artifacts,
  startingNonce,
  sourceCommit:
    rawJournal?.sourceCommit ?? approval?.sourceCommit ?? repositoryState.head,
});
let { path: journalPath, journal } = readV3DeploymentJournal({
  manifestPath: options.manifestPath,
  config,
  plan,
});
const readOnlySigner = new VoidSigner(config.roles.deployer, provider);
const verifier = new Contract(config.verifier, VERIFIER_ABI, provider);
const asset = new Contract(config.asset.address, ASSET_ABI, provider);
const preflight = await runV3Preflight({
  provider,
  signer: readOnlySigner,
  verifier,
  asset,
  config,
  artifacts,
  checkConfiguredFunding: journal === undefined,
});
let qualification = await qualifyV3DeploymentState({
  provider,
  config,
  plan,
  journal,
  repositoryState,
});
let executionPlan;
if (journal) {
  executionPlan = journal.executionPlan;
  validateV3DeploymentLiveExecutionPlan({ config, plan, executionPlan });
} else if (options.broadcast) {
  executionPlan = approval.executionPlan;
  validateV3DeploymentLiveExecutionPlan({ config, plan, executionPlan });
} else {
  executionPlan = await buildV3DeploymentLiveExecutionPlan({
    config,
    plan,
    signer: readOnlySigner,
  });
}

if (options.writePlanPath) {
  if (journal?.steps.every(({ status }) => status === "confirmed")) {
    throw new Error(
      "V3 deployment transactions are complete; use broadcast mode for final qualification",
    );
  }
  approval = createV3DeploymentApproval({
    config,
    plan,
    qualification,
    executionPlan,
    now: qualification.blockTimestamp,
    journal,
  });
  atomicWriteJson(options.writePlanPath, approval);
  print({
    mode: journal ? "renewal-plan-written" : "live-plan-written",
    preflight,
    plan,
    qualification,
    approvalPath: resolve(options.writePlanPath),
    transactionsBroadcast: 0,
    filesWritten: 1,
  });
  process.exit(0);
}

if (!options.broadcast) {
  print({
    mode: "live-dry-run",
    preflight,
    plan,
    qualification,
    executionPlan,
    transactionsBroadcast: 0,
    filesWritten: 0,
  });
  process.exit(0);
}

const hasRemainingTransactions =
  !journal || journal.steps.some(({ status }) => status !== "confirmed");
if (hasRemainingTransactions) {
  validateV3DeploymentApproval({
    approval,
    expectedApprovalCommitment: options.approvalCommitment,
    config,
    plan,
    qualification,
    now: qualification.blockTimestamp,
    journal,
  });
} else {
  validateV3DeploymentApproval({
    approval,
    expectedApprovalCommitment: options.approvalCommitment,
    config,
    plan,
    qualification,
    now: qualification.blockTimestamp,
    journal,
  });
}
await verifyV3DeploymentApprovalAnchor({ approval, provider });

async function assertApprovalCurrent(currentJournal) {
  qualification = await qualifyV3DeploymentState({
    provider,
    config,
    plan,
    journal: currentJournal,
  });
  await verifyV3DeploymentApprovalAnchor({ approval, provider });
  validateV3DeploymentApproval({
    approval,
    expectedApprovalCommitment: options.approvalCommitment,
    config,
    plan,
    qualification,
    now: qualification.blockTimestamp,
    journal: currentJournal,
  });
}

async function assertRemainingFunding(currentJournal) {
  return runV3DeploymentFundingPreflight({
    provider,
    deployer: config.roles.deployer,
    steps: currentJournal.steps.filter(({ status }) => status !== "confirmed"),
  });
}

const release = reserveV3Manifest(options.manifestPath, {
  allowExistingManifest: true,
});
try {
  const manifestTarget = resolve(options.manifestPath);
  if (existsSync(manifestTarget)) {
    if (
      !journal ||
      journal.steps.some(({ status }) => status !== "confirmed")
    ) {
      throw new Error(
        "Existing V3 deployment manifest has no fully confirmed recovery journal",
      );
    }
    const manifest = JSON.parse(readFileSync(manifestTarget, "utf8"));
    const verification = await verifyV3Deployment({
      provider,
      signerAddress: config.roles.deployer,
      config,
      artifacts,
      addresses: plan.predictedContracts,
      blockTag: manifest.verifiedAtBlock,
    });
    const canonicalTransactions = await verifyV3DeploymentTransactions({
      manifest,
      config,
      plan,
      provider,
    });
    await verifyV3DeploymentBlockAnchor({ provider, verification });
    validateV3DeploymentManifest({
      manifest,
      config,
      plan,
      verification,
      canonicalTransactions,
    });
    const expectedManifest = buildV3DeploymentManifest({
      config,
      plan,
      journal,
      approval,
      verification,
      canonicalTransactions,
    });
    if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest)) {
      throw new Error("Existing V3 deployment manifest qualification changed");
    }
    const recoveredJournal = journal.phase === "deploying";
    if (recoveredJournal) {
      journal = completeV3DeploymentJournal(
        journal,
        journalPath,
        options.manifestPath,
      );
    }
    print({
      mode: "already-deployed-qualified",
      manifest,
      transactionsBroadcast: 0,
      filesWritten: recoveredJournal ? 1 : 0,
    });
  } else {
    let signer;
    if (hasRemainingTransactions) {
      signer = new Wallet(
        requiredEnvironment("DEPLOYER_PRIVATE_KEY"),
        provider,
      );
      if (getAddress(signer.address) !== config.roles.deployer) {
        throw new Error("Deployment credential does not match roles.deployer");
      }
    }
    ({ path: journalPath, journal } = initializeV3DeploymentJournal({
      manifestPath: options.manifestPath,
      config,
      plan,
      qualification: approval.qualification,
      approval,
    }));
    let transactionsBroadcast = 0;
    for (let stepIndex = 0; stepIndex < journal.steps.length; stepIndex += 1) {
      if (journal.steps[stepIndex].status === "planned") {
        await assertApprovalCurrent(journal);
        await assertRemainingFunding(journal);
        journal = await prepareV3DeploymentStep({
          journal,
          journalPath,
          stepIndex,
          signer,
        });
      }
      const reconciled = await reconcileV3DeploymentStep({
        journal,
        journalPath,
        stepIndex,
        provider,
        targetConfirmations: config.transactionPolicy.targetConfirmations,
        maximumReceiptPolls: config.transactionPolicy.maximumReceiptPolls,
        beforeBroadcast: async () => {
          await assertApprovalCurrent(journal);
          await assertRemainingFunding(journal);
        },
      });
      journal = reconciled.journal;
      if (reconciled.broadcast) transactionsBroadcast += 1;
    }

    const verification = await verifyV3Deployment({
      provider,
      signerAddress: config.roles.deployer,
      config,
      artifacts,
      addresses: plan.predictedContracts,
    });
    const journalTransactions = Object.fromEntries(
      journal.steps.map((step) => [
        step.name,
        {
          hash: step.receipt.hash,
          from: step.from,
          to: step.to,
          nonce: step.nonce,
          dataHash: step.dataHash,
          blockNumber: step.receipt.blockNumber,
          blockHash: step.receipt.blockHash,
          contractAddress: step.receipt.contractAddress,
        },
      ]),
    );
    const canonicalTransactions = await verifyV3DeploymentTransactions({
      manifest: {
        executionPlan: journal.executionPlan,
        executionPlanCommitment: journal.executionPlanCommitment,
        canonicalTransactions: journalTransactions,
      },
      config,
      plan,
      provider,
    });
    await verifyV3DeploymentBlockAnchor({ provider, verification });
    journal = completeV3DeploymentJournal(
      journal,
      journalPath,
      options.manifestPath,
    );
    const manifest = buildV3DeploymentManifest({
      config,
      plan,
      journal,
      approval,
      verification,
      canonicalTransactions,
    });
    validateV3DeploymentManifest({
      manifest,
      config,
      plan,
      verification,
      canonicalTransactions,
    });
    atomicWriteJson(options.manifestPath, manifest);
    print({
      mode: "deployed-qualified",
      manifest,
      transactionsBroadcast,
      filesWritten: 2,
    });
  }
} finally {
  release();
}
