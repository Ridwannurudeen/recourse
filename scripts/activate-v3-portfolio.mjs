import { existsSync, readFileSync } from "node:fs";
import { JsonRpcProvider, Wallet, getAddress } from "ethers";
import {
  activationJournalPath,
  atomicWriteV3ActivationJson,
  completeV3ActivationJournal,
  initializeV3ActivationPersistence,
  parseV3ActivationArguments,
  prepareV3ActivationStep,
  readV3ActivationJournal,
  reconcileV3ActivationStep,
  validateV3ActivationJournal,
} from "./lib/v3-activation.mjs";
import {
  buildPortfolioPlan,
  createPortfolioApproval,
  createPortfolioContracts,
  readPortfolioInputs,
  runPortfolioPreflight,
  validatePortfolioApproval,
  verifyPortfolioFinal,
} from "./lib/v3-portfolio-activation.mjs";
import {
  inspectDeployableRepository,
  requireCleanDeployableRepository,
} from "./lib/pilot-readiness.mjs";

const USAGE = `Usage: node scripts/activate-v3-portfolio.mjs [options]

Default: deterministic offline plan; no RPC, signer, or file writes.

  --config <path>            Default: config/v3-portfolio-activation-cc3.json
  --manifest <path>          Default: allocation-v3-portfolio-current.json
  --live-check               Signerless qualification on CC3
  --write-plan <path>        Write a 30-minute approval envelope (requires --live-check)
  --broadcast                Execute only the approved plan (requires --live-check)
  --approved-plan <path>     Exact approved envelope, including renewal if recovering
  --approval-commitment <h>  Externally recorded approval commitment
  --help, -h                 Show this help

Prerequisite manifests are pinned in the tracked config. Private keys are read
from the configured process environment only when broadcasting. No .env is read.`;

function json(value) {
  return JSON.stringify(
    value,
    (_key, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--core-manifest")) {
    throw new Error("Use the three prerequisite paths pinned in the config");
  }
  const options = parseV3ActivationArguments([
    "--config",
    "config/v3-portfolio-activation-cc3.json",
    "--manifest",
    "allocation-v3-portfolio-current.json",
    ...args,
  ]);
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const repositoryState = inspectDeployableRepository(process.cwd());
  const { config, manifests } = readPortfolioInputs(options.configPath);
  if (!options.liveCheck) {
    console.log(
      json({
        ...(await buildPortfolioPlan({ config, manifests, repositoryState })),
        mode: "offline-plan",
        transactionsBroadcast: 0,
        filesWritten: 0,
        liveStateVerified: false,
        humanApprovalRequired: true,
      }),
    );
    return;
  }
  requireCleanDeployableRepository(repositoryState);
  const provider = new JsonRpcProvider(
    process.env.CREDITCOIN_RPC_URL ??
      "https://rpc.cc3-testnet.creditcoin.network",
    undefined,
    { batchMaxCount: 1 },
  );
  let releaseManifestReservation;
  try {
    const journalPath = activationJournalPath(options.activationManifestPath);
    let journal = existsSync(journalPath)
      ? readV3ActivationJournal(journalPath)
      : undefined;
    const approvedPlan = options.broadcast
      ? JSON.parse(readFileSync(options.approvedPlanPath, "utf8"))
      : undefined;
    const latestBlock = await provider.getBlock("latest");
    if (!latestBlock?.hash) throw new Error("Qualification block unavailable");
    const qualificationBlock =
      journal?.preflight.qualificationBlock ??
      approvedPlan?.qualificationBlock ??
      latestBlock;
    const plan = await buildPortfolioPlan({
      config,
      manifests,
      repositoryState,
      qualificationBlock,
    });
    const contracts = createPortfolioContracts(provider, manifests, plan);
    const journalIdentity = {
      chainId: config.chainId,
      configCommitment: plan.configCommitment,
      predictedFacility: plan.predictedFacility,
      commitments: plan.commitments,
      transactionPlan: plan.transactionPlan,
      executionPlan: plan.executionPlan,
    };
    if (journal) validateV3ActivationJournal(journal, journalIdentity);
    const approvalContext = (now) => ({
      plan,
      config,
      expectedApprovalCommitment: options.approvalCommitment,
      journal,
      now,
      repositoryState,
    });
    async function assertApprovalCurrent() {
      const [head, anchor] = await Promise.all([
        provider.getBlock("latest"),
        provider.getBlock(approvedPlan.targetBlock.number),
      ]);
      if (
        !head?.hash ||
        anchor?.hash !== approvedPlan.targetBlock.hash ||
        anchor.timestamp !== approvedPlan.targetBlock.timestamp ||
        anchor.number > head.number
      ) {
        throw new Error("Approval target block is not canonical");
      }
      validatePortfolioApproval(
        approvedPlan,
        approvalContext(
          Math.max(head.timestamp, Math.floor(Date.now() / 1000)),
        ),
      );
    }
    if (approvedPlan) {
      validatePortfolioApproval(
        approvedPlan,
        approvalContext(
          Math.max(latestBlock.timestamp, Math.floor(Date.now() / 1000)),
        ),
      );
      await assertApprovalCurrent();
    }
    const preflight = await runPortfolioPreflight({
      provider,
      config,
      manifests,
      plan,
      contracts,
      repositoryState,
      journal,
    });
    if (!options.broadcast) {
      let livePlan;
      if (options.writePlanPath) {
        if (existsSync(options.writePlanPath)) {
          throw new Error("Approval output already exists");
        }
        livePlan = createPortfolioApproval({
          plan,
          config,
          targetBlock: latestBlock,
          journal,
          repositoryState,
        });
        atomicWriteV3ActivationJson(options.writePlanPath, livePlan);
      }
      console.log(
        json({
          mode: "live-check",
          plan,
          preflight,
          livePlan,
          transactionsBroadcast: 0,
          livePlanWritten: options.writePlanPath ?? null,
          humanApprovalRequired: true,
        }),
      );
      return;
    }
    const persistence = initializeV3ActivationPersistence({
      broadcast: true,
      manifestPath: options.activationManifestPath,
      lockMetadata: { configCommitment: plan.configCommitment },
      initialJournal: {
        ...journalIdentity,
        preflight: {
          ...preflight,
          qualificationBlock: plan.qualificationBlock,
        },
      },
    });
    releaseManifestReservation = persistence.releaseManifestReservation;
    journal = persistence.journal;
    validateV3ActivationJournal(journal, journalIdentity);

    async function assertCurrent() {
      const currentRepository = inspectDeployableRepository(process.cwd());
      requireCleanDeployableRepository(currentRepository);
      if (currentRepository.head !== repositoryState.head) {
        throw new Error("Source commit changed during activation");
      }
      readPortfolioInputs(options.configPath);
      const block = await provider.getBlock("latest");
      if (!block?.hash) throw new Error("Approval block unavailable");
      validatePortfolioApproval(
        approvedPlan,
        approvalContext(
          Math.max(block.timestamp, Math.floor(Date.now() / 1000)),
        ),
      );
      await runPortfolioPreflight({
        provider,
        config,
        manifests,
        plan,
        contracts,
        repositoryState: currentRepository,
        journal,
      });
      await assertApprovalCurrent();
    }

    const signers = {};
    for (
      let stepIndex = 0;
      stepIndex < plan.transactionPlan.length;
      stepIndex += 1
    ) {
      const step = plan.transactionPlan[stepIndex];
      if (journal.steps[stepIndex].status === "planned") {
        await assertCurrent();
        if (!signers[step.signer]) {
          const variable = config.signerEnvironment[step.signer];
          const key = process.env[variable];
          if (!key || !/^(0x)?[0-9a-fA-F]{64}$/.test(key)) {
            throw new Error(`${variable} must contain a valid private key`);
          }
          let signer;
          try {
            signer = new Wallet(key, provider);
          } catch {
            throw new Error(`${variable} is not a valid signing key`);
          }
          if (
            getAddress(await signer.getAddress()) !==
            getAddress(config.roles[step.signer])
          ) {
            throw new Error(`${step.signer} signer address mismatch`);
          }
          signers[step.signer] = signer;
        }
        journal = await prepareV3ActivationStep({
          journal,
          journalPath,
          stepIndex,
          signer: signers[step.signer],
          request: plan.executionPlan.steps[stepIndex],
          approvedTransaction: plan.executionPlan.steps[stepIndex],
          targetConfirmations: config.transactionPolicy.targetConfirmations,
          maximumReceiptPolls: config.transactionPolicy.maximumReceiptPolls,
        });
      }
      const result = await reconcileV3ActivationStep({
        journal,
        journalPath,
        stepIndex,
        provider,
        targetConfirmations: config.transactionPolicy.targetConfirmations,
        maximumReceiptPolls: config.transactionPolicy.maximumReceiptPolls,
        beforeBroadcast: assertCurrent,
      });
      journal = result.journal;
      if (stepIndex === 0) {
        const topic =
          contracts.pool.interface.getEvent("FacilityCreated").topicHash;
        const logs = result.receipt.logs.filter(
          (log) =>
            getAddress(log.address) === getAddress(contracts.pool.target) &&
            log.topics[0] === topic,
        );
        if (
          logs.length !== 1 ||
          getAddress(
            contracts.pool.interface.parseLog(logs[0]).args.facility,
          ) !== plan.predictedFacility
        ) {
          throw new Error(
            "FacilityCreated event differs from the approved prediction",
          );
        }
      }
      if (
        stepIndex === 1 &&
        (await contracts.kernel.policySetCommitment(plan.predictedFacility)) !==
          plan.commitments.policySetCommitment
      ) {
        throw new Error(
          "Registered policy-set commitment differs from the mandate",
        );
      }
      console.log(`${step.name}: ${result.receipt.hash}`);
    }
    const verified = await verifyPortfolioFinal({
      provider,
      config,
      manifests,
      plan,
      contracts,
      journal,
    });
    const manifest = {
      schemaVersion: 1,
      generation: config.generation,
      status: "allocated-activated",
      chainId: config.chainId,
      prerequisites: config.prerequisites,
      roles: config.roles,
      sourceCommit: repositoryState.head,
      deployableScopeClean: true,
      configCommitment: plan.configCommitment,
      planCommitment: plan.planCommitment,
      qualificationBlock: plan.qualificationBlock,
      commitments: plan.commitments,
      transactionPlan: plan.transactionPlan,
      executionPlan: plan.executionPlan,
      approvedPlan: {
        approvalCommitment: approvedPlan.approvalCommitment,
        validUntil: approvedPlan.validUntil,
        targetBlock: approvedPlan.targetBlock,
      },
      ...verified,
    };
    if (existsSync(options.activationManifestPath)) {
      const previous = JSON.parse(
        readFileSync(options.activationManifestPath, "utf8"),
      );
      for (const key of new Set([
        ...Object.keys(previous),
        ...Object.keys(manifest),
      ])) {
        if (
          key === "verifiedAtBlock" ||
          key === "verifiedAtBlockHash" ||
          key === "approvedPlan"
        )
          continue;
        if (json(previous[key]) !== json(manifest[key])) {
          throw new Error(
            `Existing allocation manifest ${key} differs from verified state`,
          );
        }
      }
    } else {
      atomicWriteV3ActivationJson(options.activationManifestPath, manifest);
    }
    completeV3ActivationJournal(
      journal,
      journalPath,
      options.activationManifestPath,
    );
    console.log(`${options.activationManifestPath} verified`);
  } finally {
    if (releaseManifestReservation) releaseManifestReservation();
    provider.destroy();
  }
}

await main();
