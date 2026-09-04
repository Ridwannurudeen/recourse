import { JsonRpcProvider, VoidSigner, Wallet, getAddress } from "ethers";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  V3_EXTENSION_USAGE,
  buildV3ExtensionDeploymentPlan,
  buildV3ExtensionLiveExecutionPlan,
  buildV3ExtensionManifest,
  completeV3ExtensionJournal,
  createV3ExtensionApproval,
  initializeV3ExtensionJournal,
  parseV3ExtensionArguments,
  prepareV3ExtensionStep,
  qualifyV3ExtensionDeployment,
  readV3ExtensionArtifacts,
  readV3ExtensionInputs,
  readV3ExtensionJournal,
  reconcileV3ExtensionStep,
  reserveV3ExtensionManifest,
  validateV3ExtensionApproval,
  validateV3ExtensionLiveExecutionPlan,
  validateV3ExtensionManifest,
  verifyV3ExtensionApprovalAnchor,
  verifyV3ExtensionTransactions,
} from "./lib/v3-extension-deployment.mjs";
import { atomicWriteJson } from "./lib/v3-deployment.mjs";
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

function providerFromEnvironment(config) {
  const value = requiredEnvironment(config.rpcUrlEnvironment);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${config.rpcUrlEnvironment} must contain a valid RPC URL`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(
      `${config.rpcUrlEnvironment} must contain an HTTP(S) RPC URL`,
    );
  }
  return new JsonRpcProvider(value);
}

function print(value) {
  process.stdout.write(
    `${JSON.stringify(
      value,
      (_key, item) => (typeof item === "bigint" ? item.toString() : item),
      2,
    )}\n`,
  );
}

function transactionEvidence(journal) {
  return Object.fromEntries(
    journal.steps.map((step) => [
      step.name,
      {
        hash: step.receipt.hash,
        blockNumber: step.receipt.blockNumber,
        blockHash: step.receipt.blockHash,
        contractAddress: step.receipt.contractAddress,
      },
    ]),
  );
}

async function qualifyExistingManifest({
  manifest,
  config,
  plan,
  artifacts,
  provider,
  repositoryState,
}) {
  const finalQualification = await qualifyV3ExtensionDeployment({
    provider,
    config,
    plan,
    artifacts,
    deploymentComplete: true,
    blockTag: manifest?.finalQualification?.blockNumber,
    repositoryState,
  });
  const canonicalTransactions = await verifyV3ExtensionTransactions({
    manifest,
    config,
    plan,
    provider,
  });
  validateV3ExtensionManifest({
    manifest,
    config,
    plan,
    finalQualification,
    canonicalTransactions,
  });
  return { finalQualification, canonicalTransactions };
}

async function main() {
  const options = parseV3ExtensionArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${V3_EXTENSION_USAGE}\n`);
    return;
  }

  const repositoryState = inspectDeployableRepository(process.cwd());
  inspectTrackedRepositoryFile(process.cwd(), options.configPath);
  const { config } = readV3ExtensionInputs(options.configPath);
  for (const prerequisite of Object.values(config.prerequisites)) {
    inspectTrackedRepositoryFile(process.cwd(), prerequisite.path);
  }
  const artifacts = readV3ExtensionArtifacts(config);
  const plan = await buildV3ExtensionDeploymentPlan({
    config,
    artifacts,
    repositoryState,
  });

  if (!options.liveCheck) {
    print({
      mode: "offline-dry-run",
      generation: config.generation,
      chainId: config.chainId,
      plan,
      liveCheckRequiredForStateAndFees: true,
      transactionsBroadcast: 0,
      filesWritten: 0,
    });
    return;
  }

  await import("dotenv/config");
  const provider = providerFromEnvironment(config);
  let { path: journalPath, journal } = readV3ExtensionJournal({
    manifestPath: options.manifestPath,
    config,
    plan,
  });
  const manifestTarget = resolve(options.manifestPath);

  if (options.qualifyDeployed) {
    if (!existsSync(manifestTarget)) {
      throw new Error(`Missing V3 extension manifest: ${manifestTarget}`);
    }
    const manifest = JSON.parse(readFileSync(manifestTarget, "utf8"));
    const qualification = await qualifyExistingManifest({
      manifest,
      config,
      plan,
      artifacts,
      provider,
      repositoryState,
    });
    print({
      mode: "deployed-qualified-read-only",
      manifest,
      ...qualification,
      transactionsBroadcast: 0,
      filesWritten: 0,
    });
    return;
  }

  const release = options.broadcast
    ? reserveV3ExtensionManifest(options.manifestPath, {
        allowExistingManifest: true,
      })
    : undefined;
  try {
    if (options.broadcast && existsSync(manifestTarget)) {
      if (journal?.steps.some(({ status }) => status !== "confirmed")) {
        throw new Error(
          "Existing V3 extension manifest conflicts with an unfinished journal",
        );
      }
      const manifest = JSON.parse(readFileSync(manifestTarget, "utf8"));
      const qualification = await qualifyExistingManifest({
        manifest,
        config,
        plan,
        artifacts,
        provider,
        repositoryState,
      });
      const recoveredJournal = journal?.phase === "deploying";
      if (recoveredJournal) {
        journal = completeV3ExtensionJournal(
          journal,
          journalPath,
          options.manifestPath,
        );
      }
      print({
        mode: "already-deployed-qualified",
        manifest,
        ...qualification,
        transactionsBroadcast: 0,
        filesWritten: recoveredJournal ? 1 : 0,
      });
      return;
    }

    const approval = options.broadcast
      ? JSON.parse(readFileSync(resolve(options.approvedPlanPath), "utf8"))
      : undefined;
    let qualification = await qualifyV3ExtensionDeployment({
      provider,
      config,
      plan,
      artifacts,
      deploymentProgress: journal?.steps,
      repositoryState,
    });
    let executionPlan;
    if (journal) {
      executionPlan = journal.executionPlan;
      validateV3ExtensionLiveExecutionPlan({ config, plan, executionPlan });
    } else if (approval) {
      executionPlan = approval.executionPlan;
      validateV3ExtensionLiveExecutionPlan({ config, plan, executionPlan });
    } else {
      executionPlan = await buildV3ExtensionLiveExecutionPlan({
        config,
        plan,
        signer: new VoidSigner(config.deployer, provider),
      });
    }

    if (options.writePlanPath) {
      if (journal?.steps.every(({ status }) => status === "confirmed")) {
        throw new Error(
          "V3 extension transactions are complete; use broadcast mode for final qualification",
        );
      }
      const writtenApproval = createV3ExtensionApproval({
        config,
        plan,
        qualification,
        executionPlan,
        now: qualification.blockTimestamp,
        journal,
      });
      atomicWriteJson(options.writePlanPath, writtenApproval);
      print({
        mode: journal ? "renewal-plan-written" : "live-plan-written",
        plan,
        qualification,
        executionPlan,
        approvalPath: resolve(options.writePlanPath),
        transactionsBroadcast: 0,
        filesWritten: 1,
      });
      return;
    }

    if (!options.broadcast) {
      print({
        mode: "live-dry-run",
        plan,
        qualification,
        executionPlan,
        transactionsBroadcast: 0,
        filesWritten: 0,
      });
      return;
    }

    const hasRemainingTransactions =
      !journal || journal.steps.some(({ status }) => status !== "confirmed");
    validateV3ExtensionApproval({
      approval,
      expectedApprovalCommitment: options.approvalCommitment,
      config,
      plan,
      qualification: approval.qualification,
      liveQualification: qualification,
      now: hasRemainingTransactions
        ? qualification.blockTimestamp
        : approval.issuedAt,
      journal,
    });
    await verifyV3ExtensionApprovalAnchor({ approval, provider });

    async function assertApprovalCurrent(currentJournal) {
      qualification = await qualifyV3ExtensionDeployment({
        provider,
        config,
        plan,
        artifacts,
        deploymentProgress: currentJournal.steps,
        repositoryState,
      });
      await verifyV3ExtensionApprovalAnchor({ approval, provider });
      validateV3ExtensionApproval({
        approval,
        expectedApprovalCommitment: options.approvalCommitment,
        config,
        plan,
        qualification: approval.qualification,
        liveQualification: qualification,
        now: qualification.blockTimestamp,
        journal: currentJournal,
      });
    }

    async function assertRemainingFunding(currentJournal) {
      const remaining = currentJournal.steps.filter(
        ({ status }) => status !== "confirmed",
      );
      const maximumRemainingFee = remaining.reduce(
        (sum, step) =>
          sum +
          BigInt(step.gasLimit) *
            BigInt(step.type === 2 ? step.maxFeePerGas : step.gasPrice),
        0n,
      );
      const balance = await provider.getBalance(config.deployer, "latest");
      if (BigInt(balance) < maximumRemainingFee) {
        throw new Error(
          "Extension deployer balance cannot cover the approved remaining maximum fees",
        );
      }
    }

    let signer;
    if (hasRemainingTransactions) {
      signer = new Wallet(
        requiredEnvironment(config.privateKeyEnvironment),
        provider,
      );
      if (getAddress(signer.address) !== config.deployer) {
        throw new Error(
          `Credential from ${config.privateKeyEnvironment} does not match extension deployer`,
        );
      }
    }
    ({ path: journalPath, journal } = initializeV3ExtensionJournal({
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
        journal = await prepareV3ExtensionStep({
          journal,
          journalPath,
          stepIndex,
          signer,
        });
      }
      const reconciled = await reconcileV3ExtensionStep({
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

    const finalQualification = await qualifyV3ExtensionDeployment({
      provider,
      config,
      plan,
      artifacts,
      deploymentComplete: true,
      deploymentProgress: journal.steps,
      repositoryState,
    });
    const transactions = transactionEvidence(journal);
    const canonicalTransactions = await verifyV3ExtensionTransactions({
      manifest: {
        executionPlan: journal.executionPlan,
        executionPlanCommitment: journal.executionPlanCommitment,
        transactions,
      },
      config,
      plan,
      provider,
    });
    const manifest = buildV3ExtensionManifest({
      config,
      plan,
      journal,
      finalQualification,
      canonicalTransactions,
      journalPath,
    });
    validateV3ExtensionManifest({
      manifest,
      config,
      plan,
      finalQualification,
      canonicalTransactions,
    });
    atomicWriteJson(options.manifestPath, manifest);
    journal = completeV3ExtensionJournal(
      journal,
      journalPath,
      options.manifestPath,
    );
    print({
      mode: "deployed-qualified",
      manifest,
      transactionsBroadcast,
      filesWritten: 2,
    });
  } finally {
    release?.();
  }
}

await main();
