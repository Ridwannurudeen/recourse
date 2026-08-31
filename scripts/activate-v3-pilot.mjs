import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import {
  Contract,
  JsonRpcProvider,
  VoidSigner,
  Wallet,
  ZeroAddress,
  ZeroHash,
  formatUnits,
  getAddress,
  keccak256,
} from "ethers";
import {
  activationJournalPath,
  V3_ACTIVATION_USAGE,
  assertV3ActivationStepSafety,
  atomicWriteV3ActivationJson,
  assessV3ActivationFreshness,
  buildV3ActivationPlan,
  buildV3OfflineActivationPlan,
  buildV3LiveExecutionPlan,
  completeV3ActivationJournal,
  createV3ActivationRenewalBinding,
  createV3LivePlanReceipt,
  deriveV3ActivationCommitments,
  initializeV3ActivationPersistence,
  parseV3ActivationArguments,
  prepareV3ActivationStep,
  readV3ActivationArtifacts,
  readV3ActivationJournal,
  readV3ActivationInputs,
  reconcileV3ActivationStep,
  runV3ActivationPreflight,
  validateApprovedV3ActivationPlan,
  validateV3ActivationJournal,
  verifyPinnedFactoryRuntime,
  verifyPinnedFacilityRuntime,
  verifyPinnedPolicyRuntime,
} from "./lib/v3-activation.mjs";
import { readCoreInterfaceArtifacts } from "./lib/v3-deployment.mjs";
import { getAttestedHeight } from "./lib/proofs.mjs";

const ASSET_ABI = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

function environment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function json(value) {
  return JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

function sameAddress(actual, expected, label) {
  if (getAddress(actual) !== getAddress(expected))
    throw new Error(`${label} mismatch`);
}

function event(receipt, contract, name) {
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(contract.target)) continue;
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed?.name === name) return parsed;
    } catch {
      continue;
    }
  }
  throw new Error(`${name} event missing`);
}

function amount(value, decimals) {
  return { baseUnits: value.toString(), uiUnits: formatUnits(value, decimals) };
}

const options = parseV3ActivationArguments(process.argv.slice(2));
if (options.help) {
  process.stdout.write(`${V3_ACTIVATION_USAGE}\n`);
  process.exit(0);
}
const { config } = readV3ActivationInputs(
  options.configPath,
  options.coreManifestPath,
);
const core = config.core;
const activationArtifacts = readV3ActivationArtifacts(config);
const offlinePlan = buildV3OfflineActivationPlan({
  config,
  activationArtifacts,
});

if (!options.liveCheck) {
  console.log(
    json({
      ...offlinePlan,
      totals: {
        assetTransferred: amount(
          config.totals.assetTransferred,
          core.asset.decimals,
        ),
        assetApproved: amount(config.totals.assetApproved, core.asset.decimals),
      },
      manifestWritten: false,
      liveStateVerified: false,
      humanApprovalRequired: true,
    }),
  );
  process.exit(0);
}

const coreArtifacts = readCoreInterfaceArtifacts();
const provider = new JsonRpcProvider(environment("CREDITCOIN_RPC_URL"));
const sourceProviders = new Map(
  Object.entries(config.sourceNetworks).map(([chainKey, network]) => [
    Number(chainKey),
    new JsonRpcProvider(environment(network.rpcUrlEnvironment)),
  ]),
);
const signerEnvironment = {
  deployer: "DEPLOYER_PRIVATE_KEY",
  lender: "LENDER_PRIVATE_KEY",
  borrower: "BORROWER_PRIVATE_KEY",
  hunter: "HUNTER_PRIVATE_KEY",
};
const signers = Object.fromEntries(
  Object.entries(signerEnvironment).map(([role, variable]) => [
    role,
    options.broadcast
      ? new Wallet(environment(variable), provider)
      : new VoidSigner(config.roles[role], provider),
  ]),
);
const asset = new Contract(core.asset.address, ASSET_ABI, provider);
const contracts = {
  kernel: new Contract(
    core.contracts.policyKernel,
    coreArtifacts.PolicyKernelV2.abi,
    provider,
  ),
  registry: new Contract(
    core.contracts.policyRegistry,
    coreArtifacts.PolicyRegistryV1.abi,
    provider,
  ),
  factory: new Contract(
    core.contracts.cappedPilotFactory,
    coreArtifacts.CappedPilotFactoryV1.abi,
    provider,
  ),
  policy: new Contract(
    core.contracts.multiChainEventPolicy,
    activationArtifacts.MultiChainEventPolicyV1.artifact.abi,
    provider,
  ),
  jobs: new Contract(
    core.contracts.proofJobs,
    coreArtifacts.ProofJobsV1.abi,
    provider,
  ),
};
const journalPath = activationJournalPath(options.activationManifestPath);
const existingJournal = existsSync(journalPath)
  ? readV3ActivationJournal(journalPath)
  : undefined;
let preflight;
if (existingJournal) {
  const [network, liveFactoryCode, livePolicyCode] = await Promise.all([
    provider.getNetwork(),
    provider.getCode(core.contracts.cappedPilotFactory),
    provider.getCode(core.contracts.multiChainEventPolicy),
  ]);
  if (network.chainId !== BigInt(config.chainId))
    throw new Error("Activation journal network mismatch");
  for (const [role, signer] of Object.entries(signers)) {
    sameAddress(
      await signer.getAddress(),
      config.roles[role],
      `${role} signer`,
    );
  }
  const policyRuntime = verifyPinnedPolicyRuntime({
    artifact: activationArtifacts.MultiChainEventPolicyV1.artifact,
    kernel: core.contracts.policyKernel,
    liveCode: livePolicyCode,
  });
  const factoryRuntime = verifyPinnedFactoryRuntime({
    artifact: activationArtifacts.CappedPilotFactoryV1.artifact,
    liveCode: liveFactoryCode,
  });
  preflight = {
    ...existingJournal.preflight,
    predictedFacility: existingJournal.predictedFacility,
    factoryRuntimeCode: factoryRuntime.expectedRuntimeCode,
    policyRuntimeCode: policyRuntime.expectedRuntimeCode,
  };
} else {
  const attestedHeights = new Map(
    await Promise.all(
      [...sourceProviders.keys()].map(async (chainKey) => [
        chainKey,
        await getAttestedHeight(chainKey),
      ]),
    ),
  );
  preflight = await runV3ActivationPreflight({
    provider,
    sourceProviders,
    attestedHeights,
    signers,
    asset,
    contracts,
    config,
    coreManifest: core,
    activationArtifacts,
  });
}
const commitments = deriveV3ActivationCommitments({
  config,
  coreManifest: core,
  predictedFacility: preflight.predictedFacility,
  policyRuntimeCode: preflight.policyRuntimeCode,
});
const transactionPlan = buildV3ActivationPlan({
  config,
  coreManifest: core,
  predictedFacility: preflight.predictedFacility,
  policyConfigHash: commitments.policyConfigHash,
  releaseId: commitments.releaseId,
  runtimeVariantId: commitments.runtimeVariantId,
  deploymentId: commitments.deploymentId,
  assetSymbol: preflight.assetSymbol,
});
const planCommitment = offlinePlan.planCommitment;
if (
  preflight.predictedFacility !== offlinePlan.predictedFacility ||
  commitments.configCommitment !== offlinePlan.commitments.configCommitment ||
  JSON.stringify(transactionPlan) !==
    JSON.stringify(offlinePlan.transactionPlan)
) {
  throw new Error(
    "Live activation plan differs from the deterministic offline plan",
  );
}

const facilityAddress = getAddress(preflight.predictedFacility);
const facility = new Contract(
  facilityAddress,
  activationArtifacts.RecourseFacilityV3.artifact.abi,
  provider,
);
const requestFactories = {
  createFacility: () =>
    contracts.factory
      .connect(signers.lender)
      .createFacility.populateTransaction(
        config.facility.facilityLimit,
        config.facility.bondRequired,
        config.facility.drawFeeBps,
        config.facility.maturityBlock,
        config.facility.drawDelayBlocks,
      ),
  configurePolicy: () =>
    contracts.policy
      .connect(signers.lender)
      .configure.populateTransaction(
        facilityAddress,
        config.policy.policyId,
        config.policy.configuration,
      ),
  registerPolicy: () =>
    contracts.kernel
      .connect(signers.lender)
      .registerPolicy.populateTransaction(
        facilityAddress,
        config.policy.policyId,
        core.contracts.multiChainEventPolicy,
      ),
  publishRegistryRelease: () =>
    contracts.registry
      .connect(signers.deployer)
      .publishRelease.populateTransaction(
        config.registry.packageName,
        config.registry.version,
        core.contracts.multiChainEventPolicy,
        config.artifacts.MultiChainEventPolicyV1.keccak256,
        commitments.constructorArgumentsHash,
        config.registry.metadataHash,
        config.registry.evidenceKinds,
        config.registry.actionAdapters,
      ),
  recordRegistryDeployment: () =>
    contracts.registry
      .connect(signers.deployer)
      .recordDeployment.populateTransaction(
        commitments.releaseId,
        core.contracts.policyKernel,
        facilityAddress,
        config.policy.policyId,
        commitments.runtimeVariantId,
      ),
  approveFacilityFunding: () =>
    asset
      .connect(signers.lender)
      .approve.populateTransaction(
        facilityAddress,
        config.facility.facilityLimit,
      ),
  fundFacility: () =>
    facility
      .connect(signers.lender)
      .fundAsLender.populateTransaction(config.facility.facilityLimit),
  approveBorrowerBond: () =>
    asset
      .connect(signers.borrower)
      .approve.populateTransaction(
        facilityAddress,
        config.facility.bondRequired,
      ),
  postBorrowerBond: () =>
    facility
      .connect(signers.borrower)
      .postBond.populateTransaction(config.facility.bondRequired),
  activateFacility: () =>
    facility
      .connect(signers.borrower)
      .activate.populateTransaction(commitments.policySetCommitment),
  approveProofJobEscrow: () =>
    asset
      .connect(signers.lender)
      .approve.populateTransaction(
        core.contracts.proofJobs,
        config.proofJob.escrow,
      ),
  createProofJob: () =>
    contracts.jobs.connect(signers.lender).createJob.populateTransaction({
      token: core.asset.address,
      facility: facilityAddress,
      policyId: config.policy.policyId,
      requirementsDigest: commitments.policyConfigHash,
      expiry: config.proofJob.expiry,
      revealWindowBlocks: config.proofJob.revealWindowBlocks,
      maxSuccessfulProofs: config.proofJob.maxSuccessfulProofs,
      proofReimbursement: config.proofJob.proofReimbursement,
      outcomeReward: config.proofJob.outcomeReward,
      commitBond: config.proofJob.commitBond,
      rewardOutcomeThreshold: config.proofJob.rewardOutcomeThreshold,
    }),
  approveHunterCommitBond: () =>
    asset
      .connect(signers.hunter)
      .approve.populateTransaction(
        core.contracts.proofJobs,
        config.proofJob.commitBond,
      ),
};
const transactionRequests = await Promise.all(
  transactionPlan.map(({ name }) => {
    if (!requestFactories[name]) {
      throw new Error(`Activation request factory is unavailable: ${name}`);
    }
    return requestFactories[name]();
  }),
);
let approvedPlan;
let liveExecutionPlan;
if (options.broadcast) {
  approvedPlan = JSON.parse(readFileSync(options.approvedPlanPath, "utf8"));
  const approvalBlock = await provider.getBlock("latest");
  if (!approvalBlock)
    throw new Error("Approval validation block is unavailable");
  validateApprovedV3ActivationPlan(approvedPlan, {
    configCommitment: commitments.configCommitment,
    planCommitment,
    predictedFacility: preflight.predictedFacility,
    transactionPlan,
    requests: transactionRequests,
    roles: config.roles,
    chainId: config.chainId,
    feePolicy: config.transactionPolicy.feePolicy,
    journal: existingJournal,
    now: approvalBlock.timestamp,
  });
  liveExecutionPlan = approvedPlan.executionPlan;
} else if (existingJournal) {
  liveExecutionPlan = existingJournal.executionPlan;
} else {
  const signerRoles = [...new Set(transactionPlan.map(({ signer }) => signer))];
  const startingNonces = Object.fromEntries(
    await Promise.all(
      signerRoles.map(async (role) => [
        role,
        await provider.getTransactionCount(config.roles[role], "pending"),
      ]),
    ),
  );
  liveExecutionPlan = await buildV3LiveExecutionPlan({
    transactionPlan,
    requests: transactionRequests,
    signers,
    roles: config.roles,
    chainId: config.chainId,
    startingNonces,
    feePolicy: config.transactionPolicy.feePolicy,
  });
}

if (existingJournal) {
  validateV3ActivationJournal(existingJournal, {
    chainId: config.chainId,
    configCommitment: commitments.configCommitment,
    predictedFacility: preflight.predictedFacility,
    commitments,
    transactionPlan,
    executionPlan: liveExecutionPlan,
  });
} else {
  const [release, variant, deployment, firstJob] = await Promise.all([
    contracts.registry.packageRelease(commitments.releaseId),
    contracts.registry.runtimeVariant(commitments.runtimeVariantId),
    contracts.registry.deploymentRecord(commitments.deploymentId),
    contracts.jobs.getJob(1),
  ]);
  if (release.exists || variant.exists || deployment.exists) {
    throw new Error("An activation-owned registry identifier already exists");
  }
  if (getAddress(firstJob.sponsor) !== ZeroAddress) {
    throw new Error("Activation-owned proof job identifier already exists");
  }
}

if (!options.broadcast) {
  initializeV3ActivationPersistence({
    broadcast: false,
    manifestPath: options.activationManifestPath,
    lockMetadata: { configCommitment: commitments.configCommitment },
    initialJournal: {},
  });
  let writtenPlan;
  if (options.writePlanPath) {
    if (existsSync(options.writePlanPath)) {
      throw new Error(
        `Live activation plan already exists: ${options.writePlanPath}`,
      );
    }
    const targetBlock = await provider.getBlock(
      existingJournal ? "latest" : preflight.activationBlock,
    );
    if (!targetBlock?.hash)
      throw new Error("Live activation plan block is unavailable");
    let sourceStates = preflight.sourceStates;
    let renewal;
    if (existingJournal) {
      sourceStates = Object.fromEntries(
        await Promise.all(
          [...sourceProviders.entries()].map(
            async ([chainKey, sourceProvider]) => {
              const [network, head, attestedHeight] = await Promise.all([
                sourceProvider.getNetwork(),
                sourceProvider.getBlockNumber(),
                getAttestedHeight(chainKey),
              ]);
              const expected = config.sourceNetworks[chainKey];
              if (Number(network.chainId) !== expected.evmChainId) {
                throw new Error(
                  `Renewal source chain ${chainKey} identity mismatch`,
                );
              }
              return [
                chainKey.toString(),
                { evmChainId: Number(network.chainId), head, attestedHeight },
              ];
            },
          ),
        ),
      );
      const freshness = assessV3ActivationFreshness({
        config,
        targetState: {
          blockNumber: targetBlock.number,
          timestamp: targetBlock.timestamp,
        },
        sourceStates,
      });
      if (!freshness.readyForBroadcast) {
        throw new Error(
          "V3 activation renewal is no longer fresh enough to broadcast",
        );
      }
      renewal = createV3ActivationRenewalBinding(existingJournal);
    }
    writtenPlan = createV3LivePlanReceipt({
      configCommitment: commitments.configCommitment,
      planCommitment,
      predictedFacility: preflight.predictedFacility,
      targetBlock,
      sourceStates,
      executionPlan: liveExecutionPlan,
      validUntil: Math.min(
        targetBlock.timestamp + 1_800,
        config.proofJob.expiry - 3_600,
      ),
      renewal,
    });
    atomicWriteV3ActivationJson(options.writePlanPath, writtenPlan);
  }
  console.log(
    json({
      mode: "live-check",
      preflight: {
        chainId: preflight.chainId,
        activationBlock: preflight.activationBlock,
        activationTimestamp: preflight.activationTimestamp,
        sourceHead: preflight.sourceHead,
        attestedHeight: preflight.attestedHeight,
        predictedFacility: preflight.predictedFacility,
        assetSymbol: preflight.assetSymbol,
        nativeBalances: preflight.nativeBalances,
        assetBalances: preflight.assetBalances,
        initialAllowances: preflight.initialAllowances,
        sourceStates: preflight.sourceStates,
        freshness: preflight.freshness,
      },
      commitments,
      planCommitment,
      transactionPlan,
      executionPlan: liveExecutionPlan,
      totals: {
        assetTransferred: amount(
          config.totals.assetTransferred,
          core.asset.decimals,
        ),
        assetApproved: amount(config.totals.assetApproved, core.asset.decimals),
      },
      transactionsBroadcast: 0,
      manifestWritten: false,
      livePlanWritten: options.writePlanPath ?? null,
      livePlan: writtenPlan,
      humanApprovalRequired: true,
    }),
  );
  process.exit(0);
}

const persistence = initializeV3ActivationPersistence({
  broadcast: true,
  manifestPath: options.activationManifestPath,
  lockMetadata: { configCommitment: commitments.configCommitment },
  initialJournal: {
    chainId: config.chainId,
    configCommitment: commitments.configCommitment,
    predictedFacility: preflight.predictedFacility,
    commitments,
    transactionPlan,
    executionPlan: liveExecutionPlan,
    preflight,
  },
});
const releaseManifestReservation = persistence.releaseManifestReservation;
let journal = persistence.journal;
validateV3ActivationJournal(journal, {
  chainId: config.chainId,
  configCommitment: commitments.configCommitment,
  predictedFacility: preflight.predictedFacility,
  commitments,
  transactionPlan,
  executionPlan: liveExecutionPlan,
});
const transactions = {};

async function assertSourceSafety(label) {
  const [latestBlock, entries] = await Promise.all([
    provider.getBlock("latest"),
    Promise.all(
      [...sourceProviders.entries()].map(async ([chainKey, sourceProvider]) => {
        const [network, head, attestedHeight] = await Promise.all([
          sourceProvider.getNetwork(),
          sourceProvider.getBlockNumber(),
          getAttestedHeight(chainKey),
        ]);
        return [
          chainKey.toString(),
          {
            evmChainId: Number(network.chainId),
            head,
            attestedHeight,
          },
        ];
      }),
    ),
  ]);
  if (!latestBlock)
    throw new Error(`${label}: latest CC3 block is unavailable`);
  const freshness = assessV3ActivationFreshness({
    config,
    targetState: {
      blockNumber: latestBlock.number,
      timestamp: latestBlock.timestamp,
    },
    sourceStates: Object.fromEntries(entries),
  });
  if (!freshness.readyForBroadcast) {
    const sourceFailure = freshness.sources.find(
      ({ status }) => status !== "ready",
    );
    throw new Error(
      `${label}: ${sourceFailure?.reason ?? "target maturity or proof-job expiry is stale"}`,
    );
  }
}

async function assertApprovalCurrent(label) {
  const latestBlock = await provider.getBlock("latest");
  if (!latestBlock)
    throw new Error(`${label}: latest CC3 block is unavailable`);
  try {
    validateApprovedV3ActivationPlan(approvedPlan, {
      configCommitment: commitments.configCommitment,
      planCommitment,
      predictedFacility: preflight.predictedFacility,
      transactionPlan,
      requests: transactionRequests,
      roles: config.roles,
      chainId: config.chainId,
      feePolicy: config.transactionPolicy.feePolicy,
      journal,
      now: latestBlock.timestamp,
    });
  } catch (error) {
    throw new Error(`${label}: ${error.message}`);
  }
}

async function assertExpiryCurrent(label) {
  const latestBlock = await provider.getBlock("latest");
  if (!latestBlock || config.proofJob.expiry <= latestBlock.timestamp + 3_600) {
    throw new Error(
      `${label}: proof job expiry must remain at least one hour in the future`,
    );
  }
}

async function executeStep(
  name,
  { sourceGuard = false, expiryGuard = false } = {},
) {
  const stepIndex = transactionPlan.findIndex((step) => step.name === name);
  if (stepIndex < 0) throw new Error(`Unknown activation step: ${name}`);
  if (journal.steps[stepIndex].status === "planned") {
    await assertV3ActivationStepSafety({
      label: `Before ${name}`,
      requireSourceSafety: sourceGuard,
      requireExpirySafety: expiryGuard,
      assertApprovalCurrent,
      assertSourceSafety,
      assertExpiryCurrent,
    });
    journal = await prepareV3ActivationStep({
      journal,
      journalPath: persistence.journalPath,
      stepIndex,
      signer: signers[transactionPlan[stepIndex].signer],
      request: transactionRequests[stepIndex],
      approvedTransaction: liveExecutionPlan.steps[stepIndex],
    });
  }
  const result = await reconcileV3ActivationStep({
    journal,
    journalPath: persistence.journalPath,
    stepIndex,
    provider,
    targetConfirmations: config.transactionPolicy.targetConfirmations,
    maximumReceiptPolls: config.transactionPolicy.maximumReceiptPolls,
    beforeBroadcast: () =>
      assertV3ActivationStepSafety({
        label: `Before broadcasting ${name}`,
        requireSourceSafety: sourceGuard,
        requireExpirySafety: expiryGuard,
        assertApprovalCurrent,
        assertSourceSafety,
        assertExpiryCurrent,
      }),
  });
  journal = result.journal;
  transactions[name] = {
    hash: result.receipt.hash.toLowerCase(),
    blockNumber: result.receipt.blockNumber,
    blockHash: result.receipt.blockHash.toLowerCase(),
  };
  console.log(`${name}: ${result.receipt.hash}`);
  return result.receipt;
}

const createdReceipt = await executeStep("createFacility");
const created = event(
  createdReceipt,
  contracts.factory,
  "PilotFacilityCreated",
);
const emittedFacilityAddress = getAddress(created.args.facility);
if (
  emittedFacilityAddress !== facilityAddress ||
  created.args.facilityLimit !== config.facility.facilityLimit ||
  created.args.bondRequired !== config.facility.bondRequired
) {
  throw new Error("Created facility event differs from the activation plan");
}

const configuredReceipt = await executeStep("configurePolicy");
const configured = event(
  configuredReceipt,
  contracts.policy,
  "PolicyConfigured",
);
if (
  getAddress(configured.args.facility) !== facilityAddress ||
  configured.args.policyId !== config.policy.policyId ||
  configured.args.configurationHash !== commitments.policyConfigHash
) {
  throw new Error("Configured policy event differs from the local commitment");
}

const registeredReceipt = await executeStep("registerPolicy");
const registered = event(
  registeredReceipt,
  contracts.kernel,
  "PolicyRegistered",
);
if (
  getAddress(registered.args.facility) !== facilityAddress ||
  registered.args.policyId !== config.policy.policyId ||
  getAddress(registered.args.evaluator) !==
    core.contracts.multiChainEventPolicy ||
  registered.args.configHash !== commitments.policyConfigHash
) {
  throw new Error("Registered policy event differs from the activation plan");
}
if (keccak256(registered.args.manifest) !== commitments.manifestHash) {
  throw new Error("Registered policy manifest mismatch");
}

const publishedReceipt = await executeStep("publishRegistryRelease");
const published = event(
  publishedReceipt,
  contracts.registry,
  "PackageReleasePublished",
);
if (
  published.args.releaseId !== commitments.releaseId ||
  getAddress(published.args.issuer) !== config.roles.deployer ||
  getAddress(published.args.referenceImplementation) !==
    core.contracts.multiChainEventPolicy ||
  published.args.buildArtifactHash !==
    config.artifacts.MultiChainEventPolicyV1.keccak256 ||
  published.args.referenceVariantId !== commitments.runtimeVariantId ||
  published.args.releaseContentHash !== commitments.releaseContentHash
) {
  throw new Error("Published registry release commitment mismatch");
}

const recordedReceipt = await executeStep("recordRegistryDeployment");
const recorded = event(
  recordedReceipt,
  contracts.registry,
  "PolicyDeploymentRecorded",
);
if (
  recorded.args.deploymentId !== commitments.deploymentId ||
  recorded.args.releaseId !== commitments.releaseId ||
  getAddress(recorded.args.kernel) !== core.contracts.policyKernel ||
  getAddress(recorded.args.facility) !== facilityAddress ||
  recorded.args.policyId !== config.policy.policyId ||
  getAddress(recorded.args.evaluator) !==
    core.contracts.multiChainEventPolicy ||
  recorded.args.runtimeVariantId !== commitments.runtimeVariantId ||
  recorded.args.configHash !== commitments.policyConfigHash
) {
  throw new Error("Recorded registry deployment commitment mismatch");
}

await executeStep("approveFacilityFunding", { sourceGuard: true });
await executeStep("fundFacility", { sourceGuard: true });
await executeStep("approveBorrowerBond", { sourceGuard: true });
await executeStep("postBorrowerBond", { sourceGuard: true });

const policySetCommitment =
  await contracts.kernel.policySetCommitment(facilityAddress);
if (policySetCommitment !== commitments.policySetCommitment)
  throw new Error("Policy-set commitment mismatch");
await executeStep("activateFacility", { sourceGuard: true });
await executeStep("approveProofJobEscrow", {
  sourceGuard: true,
  expiryGuard: true,
});

const jobReceipt = await executeStep("createProofJob", {
  sourceGuard: true,
  expiryGuard: true,
});
const jobCreated = event(jobReceipt, contracts.jobs, "JobCreated");
const jobId = jobCreated.args.jobId;
if (
  jobId !== 1n ||
  getAddress(jobCreated.args.sponsor) !== config.roles.lender ||
  getAddress(jobCreated.args.facility) !== facilityAddress ||
  jobCreated.args.policyId !== config.policy.policyId ||
  jobCreated.args.requirementsDigest !== commitments.policyConfigHash ||
  jobCreated.args.escrow !== config.proofJob.escrow
) {
  throw new Error("Created proof job differs from the preflight plan");
}

await executeStep("approveHunterCommitBond", { sourceGuard: true });

const [
  facilityCode,
  factoryCode,
  factoryCount,
  factoryTotalLimit,
  indexedFacility,
  factoryMembership,
  facilityAsset,
  facilityKernel,
  facilityLender,
  facilityBorrower,
  facilityLimit,
  bondRequired,
  initialDrawFeeBps,
  maturityBlock,
  drawDelayBlocks,
  facilityStatus,
  lenderFunded,
  bondPosted,
  drawnPrincipal,
  outstandingDebt,
  pendingDrawAmount,
  availableCredit,
  configuredOnChain,
  policyConfigHash,
  policyManifest,
  registeredPolicy,
  finalPolicySetCommitment,
  release,
  variant,
  deployment,
  job,
  hunterCommitment,
  lenderFacilityAllowance,
  borrowerFacilityAllowance,
  lenderProofJobsAllowance,
  hunterProofJobsAllowance,
] = await Promise.all([
  provider.getCode(facilityAddress),
  provider.getCode(core.contracts.cappedPilotFactory),
  contracts.factory.facilityCount(),
  contracts.factory.totalFacilityLimit(),
  contracts.factory.facilityAt(0),
  contracts.factory.isFacility(facilityAddress),
  facility.asset(),
  facility.kernel(),
  facility.lender(),
  facility.borrower(),
  facility.facilityLimit(),
  facility.bondRequired(),
  facility.initialDrawFeeBps(),
  facility.maturityBlock(),
  facility.drawDelayBlocks(),
  facility.status(),
  facility.lenderFunded(),
  facility.bondPosted(),
  facility.drawnPrincipal(),
  facility.outstandingDebt(),
  facility.pendingDrawAmount(),
  facility.availableCredit(),
  contracts.policy.isConfigured(facilityAddress, config.policy.policyId),
  contracts.policy.configHash(facilityAddress, config.policy.policyId),
  contracts.policy.manifest(facilityAddress, config.policy.policyId),
  contracts.kernel.policyOf(facilityAddress, config.policy.policyId),
  contracts.kernel.policySetCommitment(facilityAddress),
  contracts.registry.packageRelease(commitments.releaseId),
  contracts.registry.runtimeVariant(commitments.runtimeVariantId),
  contracts.registry.deploymentRecord(commitments.deploymentId),
  contracts.jobs.getJob(jobId),
  contracts.jobs.getCommitment(jobId, config.roles.hunter),
  asset.allowance(config.roles.lender, facilityAddress),
  asset.allowance(config.roles.borrower, facilityAddress),
  asset.allowance(config.roles.lender, core.contracts.proofJobs),
  asset.allowance(config.roles.hunter, core.contracts.proofJobs),
]);

if (facilityCode === "0x")
  throw new Error("Activated facility has no bytecode");
verifyPinnedFactoryRuntime({
  artifact: activationArtifacts.CappedPilotFactoryV1.artifact,
  liveCode: factoryCode,
});
verifyPinnedFacilityRuntime({
  artifact: activationArtifacts.RecourseFacilityV3.artifact,
  liveCode: facilityCode,
});
if (factoryCount !== 1n || factoryTotalLimit !== config.facility.facilityLimit)
  throw new Error("Factory totals mismatch");
sameAddress(indexedFacility, facilityAddress, "Factory first facility");
if (factoryMembership !== true)
  throw new Error("Factory facility index mismatch");
sameAddress(facilityAsset, core.asset.address, "Facility asset");
sameAddress(facilityKernel, core.contracts.policyKernel, "Facility kernel");
sameAddress(facilityLender, config.roles.lender, "Facility lender");
sameAddress(facilityBorrower, config.roles.borrower, "Facility borrower");
if (
  facilityLimit !== config.facility.facilityLimit ||
  bondRequired !== config.facility.bondRequired ||
  Number(initialDrawFeeBps) !== config.facility.drawFeeBps ||
  Number(maturityBlock) !== config.facility.maturityBlock ||
  Number(drawDelayBlocks) !== config.facility.drawDelayBlocks
) {
  throw new Error("Facility immutable economics mismatch");
}
if (facilityStatus !== 1n) throw new Error("Facility is not Active");
if (
  lenderFunded !== config.facility.facilityLimit ||
  bondPosted !== config.facility.bondRequired ||
  drawnPrincipal !== 0n ||
  outstandingDebt !== 0n ||
  pendingDrawAmount !== 0n ||
  availableCredit !== config.facility.facilityLimit
) {
  throw new Error("Facility funded state mismatch");
}
if (
  !configuredOnChain ||
  policyConfigHash !== commitments.policyConfigHash ||
  keccak256(policyManifest) !== commitments.manifestHash
) {
  throw new Error("Policy configuration verification failed");
}
sameAddress(
  registeredPolicy.evaluator,
  core.contracts.multiChainEventPolicy,
  "Registered evaluator",
);
if (
  registeredPolicy.configHash !== commitments.policyConfigHash ||
  keccak256(registeredPolicy.manifestBytes) !== commitments.manifestHash ||
  finalPolicySetCommitment !== commitments.policySetCommitment
) {
  throw new Error("Kernel policy registration verification failed");
}
sameAddress(release.issuer, config.roles.deployer, "Release issuer");
if (
  release.packageName !== config.registry.packageName ||
  release.version !== config.registry.version ||
  release.buildArtifactHash !==
    config.artifacts.MultiChainEventPolicyV1.keccak256 ||
  release.metadataHash !== config.registry.metadataHash ||
  release.referenceVariantId !== commitments.runtimeVariantId ||
  release.releaseContentHash !== commitments.releaseContentHash ||
  release.exists !== true
) {
  throw new Error("Registry release verification failed");
}
if (
  variant.releaseId !== commitments.releaseId ||
  variant.runtimeCodeHash !== commitments.policyRuntimeCodeHash ||
  variant.constructorArgumentsHash !== commitments.constructorArgumentsHash ||
  variant.exists !== true
) {
  throw new Error("Registry runtime variant verification failed");
}
if (
  deployment.releaseId !== commitments.releaseId ||
  deployment.chainId !== BigInt(config.chainId) ||
  deployment.policyId !== config.policy.policyId ||
  deployment.runtimeVariantId !== commitments.runtimeVariantId ||
  deployment.configHash !== commitments.policyConfigHash ||
  deployment.manifestHash !== commitments.manifestHash ||
  deployment.exists !== true
) {
  throw new Error("Registry deployment verification failed");
}
sameAddress(
  deployment.facility,
  facilityAddress,
  "Registry deployment facility",
);
sameAddress(
  deployment.attester,
  config.roles.deployer,
  "Registry deployment attester",
);
if (
  job.sponsor !== config.roles.lender ||
  job.token !== core.asset.address ||
  job.facility !== facilityAddress ||
  job.policyId !== config.policy.policyId ||
  job.requirementsDigest !== commitments.policyConfigHash ||
  Number(job.expiry) !== config.proofJob.expiry ||
  Number(job.revealWindowBlocks) !== config.proofJob.revealWindowBlocks ||
  Number(job.maxSuccessfulProofs) !== config.proofJob.maxSuccessfulProofs ||
  job.successfulProofs !== 0n ||
  job.proofReimbursement !== config.proofJob.proofReimbursement ||
  job.outcomeReward !== config.proofJob.outcomeReward ||
  job.commitBond !== config.proofJob.commitBond ||
  job.escrowRemaining !== config.proofJob.escrow ||
  Number(job.rewardOutcomeThreshold) !==
    config.proofJob.rewardOutcomeThreshold ||
  job.state !== 0n
) {
  throw new Error("Proof job verification failed");
}
if (hunterCommitment.bond !== 0n)
  throw new Error("Activation unexpectedly committed hunter evidence");
if (
  lenderFacilityAllowance !== 0n ||
  borrowerFacilityAllowance !== 0n ||
  lenderProofJobsAllowance !== 0n ||
  hunterProofJobsAllowance !== config.proofJob.commitBond
) {
  throw new Error("Final allowance verification failed");
}

const verifiedAtBlock = await provider.getBlockNumber();
const decimals = core.asset.decimals;
const manifest = {
  generation: config.generation,
  chainId: config.chainId,
  coreManifest: config.coreManifest,
  core: core.contracts,
  asset: { ...core.asset, symbol: preflight.assetSymbol },
  roles: config.roles,
  artifacts: config.artifacts,
  facility: {
    address: facilityAddress,
    asset: core.asset.address,
    kernel: core.contracts.policyKernel,
    lender: config.roles.lender,
    borrower: config.roles.borrower,
    facilityLimit: config.facility.facilityLimit.toString(),
    facilityLimitUi: formatUnits(config.facility.facilityLimit, decimals),
    bondRequired: config.facility.bondRequired.toString(),
    bondRequiredUi: formatUnits(config.facility.bondRequired, decimals),
    drawFeeBps: config.facility.drawFeeBps,
    maturityBlock: config.facility.maturityBlock,
    drawDelayBlocks: config.facility.drawDelayBlocks,
    status: "Active",
    statusCode: 1,
    lenderFunded: lenderFunded.toString(),
    bondPosted: bondPosted.toString(),
    drawnPrincipal: "0",
    outstandingDebt: "0",
    policySetCommitment: commitments.policySetCommitment,
    createdAtBlock: transactions.createFacility.blockNumber,
    activatedAtBlock: transactions.activateFacility.blockNumber,
  },
  policy: {
    policyId: config.policy.policyId.toString(),
    evaluator: core.contracts.multiChainEventPolicy,
    configurationHash: commitments.policyConfigHash,
    manifestHash: commitments.manifestHash,
    configuration: config.policy.configuration,
    sourceNetworks: config.sourceNetworks,
  },
  registry: {
    packageName: config.registry.packageName,
    version: config.registry.version,
    buildArtifactHash: config.artifacts.MultiChainEventPolicyV1.keccak256,
    metadataHash: config.registry.metadataHash,
    constructorArgumentsHash: commitments.constructorArgumentsHash,
    runtimeCodeHash: commitments.policyRuntimeCodeHash,
    releaseId: commitments.releaseId,
    runtimeVariantId: commitments.runtimeVariantId,
    releaseContentHash: commitments.releaseContentHash,
    deploymentId: commitments.deploymentId,
  },
  proofJob: {
    address: core.contracts.proofJobs,
    jobId: jobId.toString(),
    requirementsDigest: commitments.policyConfigHash,
    expiry: config.proofJob.expiry,
    revealWindowBlocks: config.proofJob.revealWindowBlocks,
    maxSuccessfulProofs: config.proofJob.maxSuccessfulProofs,
    proofReimbursement: config.proofJob.proofReimbursement.toString(),
    proofReimbursementUi: formatUnits(
      config.proofJob.proofReimbursement,
      decimals,
    ),
    outcomeReward: config.proofJob.outcomeReward.toString(),
    outcomeRewardUi: formatUnits(config.proofJob.outcomeReward, decimals),
    commitBond: config.proofJob.commitBond.toString(),
    commitBondUi: formatUnits(config.proofJob.commitBond, decimals),
    rewardOutcomeThreshold: config.proofJob.rewardOutcomeThreshold,
    escrow: config.proofJob.escrow.toString(),
    escrowUi: formatUnits(config.proofJob.escrow, decimals),
    state: "Open",
    stateCode: 0,
  },
  transactions,
  transactionPlan,
  assetMovement: {
    lenderToFacility: amount(config.facility.facilityLimit, decimals),
    borrowerToFacility: amount(config.facility.bondRequired, decimals),
    lenderToProofJobs: amount(config.proofJob.escrow, decimals),
    hunterToProofJobs: amount(0n, decimals),
    totalTransferred: amount(config.totals.assetTransferred, decimals),
    noDraw: true,
  },
  allowances: {
    initial: Object.fromEntries(
      Object.entries(preflight.initialAllowances).map(([name, value]) => [
        name,
        amount(value, decimals),
      ]),
    ),
    final: {
      lenderFacility: amount(lenderFacilityAllowance, decimals),
      borrowerFacility: amount(borrowerFacilityAllowance, decimals),
      lenderProofJobs: amount(lenderProofJobsAllowance, decimals),
      hunterProofJobs: amount(hunterProofJobsAllowance, decimals),
    },
    totalApproved: amount(config.totals.assetApproved, decimals),
  },
  configCommitment: commitments.configCommitment,
  planCommitment,
  approvedPlan: {
    targetBlock: approvedPlan.targetBlock,
    sourceStates: approvedPlan.sourceStates,
    validUntil: approvedPlan.validUntil,
    executionPlanCommitment: approvedPlan.executionPlan.commitment,
  },
  activationBlock: transactions.approveHunterCommitBond.blockNumber,
  verifiedAtBlock,
};
journal = completeV3ActivationJournal(
  journal,
  persistence.journalPath,
  options.activationManifestPath,
);
if (existsSync(options.activationManifestPath)) {
  const existingManifest = JSON.parse(
    readFileSync(options.activationManifestPath, "utf8"),
  );
  if (
    existingManifest.configCommitment !== commitments.configCommitment ||
    getAddress(existingManifest.facility?.address) !== facilityAddress ||
    existingManifest.registry?.releaseId !== commitments.releaseId ||
    existingManifest.registry?.deploymentId !== commitments.deploymentId
  ) {
    throw new Error(
      "Existing V3 activation manifest differs from the completed journal",
    );
  }
  for (const [name, record] of Object.entries(transactions)) {
    if (
      existingManifest.transactions?.[name]?.hash?.toLowerCase() !== record.hash
    ) {
      throw new Error(
        `Existing V3 activation manifest transaction mismatch: ${name}`,
      );
    }
  }
} else {
  atomicWriteV3ActivationJson(options.activationManifestPath, manifest);
}
releaseManifestReservation();
console.log(
  `${options.activationManifestPath} written after complete activation verification`,
);
