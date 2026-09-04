import "dotenv/config";
import { JsonRpcProvider, VoidSigner, Wallet, getAddress } from "ethers";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  USC_REMEDY_USAGE,
  atomicWriteUscJson,
  buildUscRemedyDeploymentPlan,
  buildUscRemedyLiveExecutionPlan,
  createUscRemedyApproval,
  finalizeUscRemedyDeployment,
  initializeUscRemedyJournal,
  parseUscRemedyDeploymentArguments,
  prepareUscRemedyStep,
  qualifyUscRemedyDependencies,
  readUscRemedyJournal,
  readUscRemedyArtifacts,
  reconcileUscRemedyStep,
  reserveUscRemedyDeployment,
  validateUscRemedyApproval,
  validateUscRemedyDeploymentConfig,
  validateUscRemedyDeploymentManifest,
  verifyDeployedUscRemedyRoute,
  verifyInstalledUscContracts020,
  verifyUscRemedyDeploymentTransactions,
  verifyUscApprovalAnchors,
} from "./lib/usc-remedy-deployment.mjs";
import {
  inspectDeployableRepository,
  inspectTrackedRepositoryFile,
} from "./lib/pilot-readiness.mjs";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function providerFor(environmentName) {
  const url = requiredEnvironment(environmentName);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${environmentName} must contain a valid RPC URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${environmentName} must contain an HTTP(S) RPC URL`);
  }
  return new JsonRpcProvider(url);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const options = parseUscRemedyDeploymentArguments(process.argv.slice(2));
if (options.help) {
  process.stdout.write(`${USC_REMEDY_USAGE}\n`);
  process.exit(0);
}
const installedPackage = verifyInstalledUscContracts020();
const repositoryState = inspectDeployableRepository(process.cwd());
inspectTrackedRepositoryFile(process.cwd(), options.configPath);
const config = validateUscRemedyDeploymentConfig(
  JSON.parse(readFileSync(resolve(options.configPath), "utf8")),
);
const artifacts = readUscRemedyArtifacts(config);
const plan = await buildUscRemedyDeploymentPlan({
  config,
  artifacts,
  repositoryState,
});

const safetyBoundary = {
  dedicatedInboxRequired: true,
  requiredMessageDispatcher: plan.predictedContracts.dispatcher,
  setMessageDispatcherCalledByThisTool: false,
  warning:
    "Never use this route with a shared Inbox; this plan deploys the dedicated Inbox last, constructor-bound to the already-deployed predicted Recourse dispatcher",
};

if (!options.liveCheck) {
  print({
    mode: "offline-dry-run",
    installedPackage,
    plan,
    transactionsBroadcast: 0,
    filesWritten: 0,
    safetyBoundary,
  });
  process.exit(0);
}

const sourceProvider = providerFor(config.source.rpcUrlEnvironment);
const destinationProvider = providerFor(config.destination.rpcUrlEnvironment);

async function qualifyDeploymentManifest(manifest) {
  validateUscRemedyDeploymentManifest({ manifest, config, plan });
  const dependencies = await qualifyUscRemedyDependencies({
    config,
    plan,
    sourceProvider,
    destinationProvider,
    deploymentComplete: true,
    repositoryState,
  });
  const route = await verifyDeployedUscRemedyRoute({
    config,
    plan,
    sourceProvider,
    destinationProvider,
  });
  const transactions = await verifyUscRemedyDeploymentTransactions({
    manifest,
    config,
    plan,
    sourceProvider,
    destinationProvider,
  });
  if (
    JSON.stringify(manifest.dependencies) !==
      JSON.stringify(dependencies.dependencies) ||
    JSON.stringify(manifest.routeQualification) !== JSON.stringify(route) ||
    JSON.stringify(manifest.canonicalTransactions) !==
      JSON.stringify(transactions)
  ) {
    throw new Error("USC remedy deployment manifest qualification changed");
  }
  return { dependencies, route, transactions };
}

if (options.qualifyDeployed) {
  if (!existsSync(resolve(options.manifestPath))) {
    throw new Error(
      `USC remedy deployment manifest does not exist: ${resolve(options.manifestPath)}`,
    );
  }
  const manifest = JSON.parse(
    readFileSync(resolve(options.manifestPath), "utf8"),
  );
  const { dependencies, route, transactions } =
    await qualifyDeploymentManifest(manifest);
  print({
    mode: "deployed-route-qualification",
    manifest: resolve(options.manifestPath),
    dependencies,
    route,
    transactions,
    transactionsBroadcast: 0,
    filesWritten: 0,
  });
  process.exit(0);
}

let approval;
let executionPlan;
const existingJournal = readUscRemedyJournal({
  manifestPath: options.manifestPath,
  config,
  plan,
});
const resumedJournal = existingJournal.journal;
if (options.broadcast) {
  approval = JSON.parse(
    readFileSync(resolve(options.approvedPlanPath), "utf8"),
  );
}

const qualification = await qualifyUscRemedyDependencies({
  config,
  plan,
  sourceProvider,
  destinationProvider,
  deploymentProgress: resumedJournal?.steps,
  repositoryState,
});
const approvalQualification =
  approval?.renewal === undefined && resumedJournal
    ? resumedJournal.qualification
    : qualification;
const hasRemainingTransactions =
  !resumedJournal ||
  resumedJournal.steps.some(({ status }) => status !== "confirmed");

if (options.broadcast && hasRemainingTransactions) {
  validateUscRemedyApproval({
    approval,
    expectedApprovalCommitment: options.approvalCommitment,
    config,
    plan,
    qualification: approvalQualification,
    liveQualification: qualification,
    now: qualification.source.blockTimestamp,
    journal: resumedJournal,
  });
  executionPlan = approval.executionPlan;
} else if (options.broadcast) {
  executionPlan = resumedJournal.executionPlan;
  if (
    approval.executionPlanCommitment !== executionPlan.commitment ||
    JSON.stringify(approval.executionPlan) !== JSON.stringify(executionPlan)
  ) {
    throw new Error(
      "Approved USC remedy plan does not match the completed journal",
    );
  }
} else if (resumedJournal) {
  if (resumedJournal.steps.every(({ status }) => status === "confirmed")) {
    throw new Error(
      "USC deployment transactions are complete; resume broadcast for final qualification",
    );
  }
  executionPlan = resumedJournal.executionPlan;
} else {
  executionPlan = await buildUscRemedyLiveExecutionPlan({
    config,
    plan,
    signers: {
      source: new VoidSigner(config.source.deployer, sourceProvider),
      destination: new VoidSigner(
        config.destination.deployer,
        destinationProvider,
      ),
    },
  });
}

if (options.writePlanPath) {
  approval = createUscRemedyApproval({
    config,
    plan,
    qualification,
    executionPlan,
    now: qualification.source.blockTimestamp,
    journal: resumedJournal,
  });
  atomicWriteUscJson(options.writePlanPath, approval);
  print({
    mode: "live-plan-written",
    plan,
    qualification,
    approvalPath: resolve(options.writePlanPath),
    transactionsBroadcast: 0,
    safetyBoundary,
  });
  process.exit(0);
}

if (!options.broadcast) {
  print({
    mode: "live-dry-run",
    plan,
    qualification,
    executionPlan,
    transactionsBroadcast: 0,
    filesWritten: 0,
    safetyBoundary,
  });
  process.exit(0);
}

if (hasRemainingTransactions) {
  await verifyUscApprovalAnchors({
    approval,
    sourceProvider,
    destinationProvider,
  });
}

async function assertApprovalCurrent(step, journal) {
  const stepProvider =
    step.network === "source" ? sourceProvider : destinationProvider;
  const [latestBlock] = await Promise.all([
    stepProvider.getBlock("latest"),
    verifyUscApprovalAnchors({
      approval,
      sourceProvider,
      destinationProvider,
    }),
  ]);
  if (!latestBlock || !Number.isSafeInteger(latestBlock.timestamp)) {
    throw new Error(`${step.name} latest block timestamp is unavailable`);
  }
  validateUscRemedyApproval({
    approval,
    expectedApprovalCommitment: options.approvalCommitment,
    config,
    plan,
    qualification: approvalQualification,
    liveQualification: qualification,
    now: latestBlock.timestamp,
    journal,
  });
}

const release = reserveUscRemedyDeployment(options.manifestPath);
try {
  if (existsSync(resolve(options.manifestPath))) {
    const existing = JSON.parse(
      readFileSync(resolve(options.manifestPath), "utf8"),
    );
    await qualifyDeploymentManifest(existing);
    print({ mode: "already-deployed", manifest: existing });
    process.exitCode = 0;
  } else {
    let sourceSigner;
    let destinationSigner;
    if (hasRemainingTransactions) {
      sourceSigner = new Wallet(
        requiredEnvironment(config.source.privateKeyEnvironment),
        sourceProvider,
      );
      destinationSigner = new Wallet(
        requiredEnvironment(config.destination.privateKeyEnvironment),
        destinationProvider,
      );
      if (getAddress(sourceSigner.address) !== config.source.deployer) {
        throw new Error(
          "Source deployment credential does not match source.deployer",
        );
      }
      if (
        getAddress(destinationSigner.address) !== config.destination.deployer
      ) {
        throw new Error(
          "Destination deployment credential does not match destination.deployer",
        );
      }
    }
    let { path: journalPath, journal } = initializeUscRemedyJournal({
      manifestPath: options.manifestPath,
      config,
      plan,
      qualification: approvalQualification,
      approval,
    });
    for (let stepIndex = 0; stepIndex < journal.steps.length; stepIndex += 1) {
      const step = journal.steps[stepIndex];
      const signer =
        step.network === "source" ? sourceSigner : destinationSigner;
      const provider =
        step.network === "source" ? sourceProvider : destinationProvider;
      if (step.status === "planned") {
        await assertApprovalCurrent(step, journal);
        journal = await prepareUscRemedyStep({
          journal,
          journalPath,
          stepIndex,
          signer,
        });
      }
      const reconciled = await reconcileUscRemedyStep({
        journal,
        journalPath,
        stepIndex,
        provider,
        targetConfirmations:
          step.network === "source"
            ? config.transactionPolicy.sourceConfirmations
            : config.transactionPolicy.destinationConfirmations,
        maximumReceiptPolls: config.transactionPolicy.maximumReceiptPolls,
        beforeBroadcast: () => assertApprovalCurrent(step, journal),
      });
      journal = reconciled.journal;
    }
    const manifest = await finalizeUscRemedyDeployment({
      manifestPath: options.manifestPath,
      journal,
      journalPath,
      installedPackage,
      config,
      plan,
      sourceProvider,
      destinationProvider,
      safetyBoundary,
      repositoryState,
    });
    print({
      mode: "deployed-dedicated-inbox-route",
      manifest,
      transactionsBroadcast: journal.steps.length,
    });
  }
} finally {
  release();
}
