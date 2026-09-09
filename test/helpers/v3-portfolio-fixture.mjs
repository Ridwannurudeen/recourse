import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { AbiCoder, ZeroHash, keccak256 } from "ethers";
import {
  buildPortfolioPlan,
  validatePortfolioConfig,
} from "../../scripts/lib/v3-portfolio-activation.mjs";

export const HASH = (digit) => `0x${digit.repeat(64)}`;
export const repositoryState = {
  head: "1".repeat(40),
  deployableScopeClean: true,
};

export function fixture(investorAddress) {
  const input = JSON.parse(
    readFileSync("config/v3-portfolio-activation.example.json", "utf8"),
  );
  input.prerequisites = Object.fromEntries(
    Object.entries({
      portfolio: "deployments-v3-portfolio-core-current.json",
      core: "deployments-v3-current.json",
      activation: "activation-v3-current.json",
    }).map(([key, path]) => [
      key,
      {
        path,
        sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      },
    ]),
  );
  const manifests = Object.fromEntries(
    Object.entries(input.prerequisites).map(([key, pin]) => [
      key,
      JSON.parse(readFileSync(pin.path, "utf8")),
    ]),
  );
  const roles = manifests.activation.roles;
  if (investorAddress) roles.lender = investorAddress;
  input.roles = {
    manager: roles.deployer,
    issuer: roles.deployer,
    investor: roles.lender,
    borrower: roles.borrower,
  };
  input.qualificationBlock = {
    ...manifests.activation.approvedPlan.targetBlock,
  };
  input.expectedStartingNonces = {
    manager: 46,
    issuer: 46,
    investor: 22,
    borrower: 20,
  };
  manifests.artifacts = Object.fromEntries(
    Object.entries({
      pool: "PortfolioPoolV1",
      factory: "CappedPilotFactoryV1",
      mandate: "PortfolioMandateV1",
      kernel: "PolicyKernelV2",
      registry: "PolicyRegistryV1",
      policy: "MultiChainEventPolicyV1",
      facility: "RecourseFacilityV3",
    }).map(([key, name]) => [
      key,
      JSON.parse(readFileSync(`out/${name}.sol/${name}.json`, "utf8")),
    ]),
  );
  return {
    input,
    config: validatePortfolioConfig(input, manifests),
    manifests,
  };
}

export async function chainFixture(
  final = false,
  prefix = final ? 13 : 0,
  investorAddress,
  fixtureValues,
) {
  const values = fixtureValues ?? fixture(investorAddress);
  const { config, manifests } = values;
  const plan = await buildPortfolioPlan({ config, manifests, repositoryState });
  const a = plan.addresses;
  const fields = {
    pool: [
      "asset",
      "manager",
      "maximumPoolAssets",
      "maximumServiceBudget",
      "maximumServiceJobDuration",
      "maximumFacilityCount",
      "fundingDeadline",
      "recoveryDelayBlocks",
    ],
    factory: [
      "asset",
      "kernel",
      "lender",
      "borrower",
      "guardian",
      "maximumFacilityLimit",
      "maximumTotalLimit",
      "minimumBondBps",
      "maximumDrawFeeBps",
      "maximumMaturityBlocks",
      "maximumDrawDelayBlocks",
      "maximumFacilityCount",
    ],
    mandate: [
      "factory",
      "registry",
      "asset",
      "kernel",
      "requiredReleaseId",
      "requiredPolicySetCommitment",
      "requiredEvidenceKind",
      "requiredActionAdapterKind",
      "maximumFacilityLimit",
      "minimumBondBps",
      "maximumDrawFeeBps",
      "maximumRemainingMaturityBlocks",
    ],
  };
  const state = Object.fromEntries(
    Object.entries({
      pool: "PortfolioPoolV1",
      factory: "CappedPilotFactoryV1",
      mandate: "PortfolioMandateV1",
    }).map(([key, name]) => [
      key,
      Object.fromEntries(
        fields[key].map((field, index) => [
          field,
          manifests.portfolio.constructors[name].values[index],
        ]),
      ),
    ]),
  );
  Object.assign(state.pool, {
    mandate: a.mandate,
    status: final ? 2 : 0,
    createdFacilityCount: final ? 1 : 0,
    candidateCount: final ? 1 : 0,
    investorCount: final ? 1 : 0,
    totalSupply: final ? config.facility.facilityLimit : 0n,
    totalDeposited: final ? config.facility.facilityLimit : 0n,
    totalAllocatedPrincipal: final ? config.facility.facilityLimit : 0n,
    allocatedFacilityCount: final ? 1 : 0,
    isInvestor: final,
    createdFacilityAt: plan.predictedFacility,
    allocationOf: {
      deploymentId: plan.commitments.deploymentId,
      registered: true,
      settled: false,
      principal: config.facility.facilityLimit,
    },
  });
  Object.assign(state.factory, {
    facilityCount: final ? 1 : 0,
    totalFacilityLimit: final ? config.facility.facilityLimit : 0n,
    creationPaused: false,
    isFacility: prefix >= 1,
    facilityAt: plan.predictedFacility,
  });
  state.mandate.evaluate = 0;
  const configurationType = manifests.artifacts.policy.abi.find(
    (item) => item.type === "function" && item.name === "configure",
  ).inputs[2];
  const manifest = AbiCoder.defaultAbiCoder().encode(
    [configurationType],
    [manifests.activation.policy.configuration],
  );
  state.policy = {
    context: a.kernel,
    sourceOrdering: 1,
    isConfigured: final,
    ...(final
      ? { configHash: plan.commitments.policyConfigHash, manifest }
      : {}),
  };
  state.kernel = {
    owner: config.roles.manager,
    verifier: manifests.core.verifier,
    creditState: manifests.core.contracts.verifiedCreditState,
    proofJobs: manifests.core.contracts.proofJobs,
    safeStaleProofRelease: true,
    policySetCommitment: final
      ? plan.commitments.policySetCommitment
      : ZeroHash,
  };
  if (final)
    state.kernel.policyOf = [
      a.policy,
      plan.commitments.policyConfigHash,
      manifest,
    ];
  state.asset = { decimals: 6, symbol: "rUSD" };
  state.registry = {
    packageRelease: { exists: true, issuer: config.roles.issuer },
    declaresEvidenceKind: true,
    runtimeVariant: {
      exists: true,
      releaseId: plan.commitments.releaseId,
      runtimeCodeHash: plan.commitments.policyRuntimeCodeHash,
      constructorArgumentsHash: plan.commitments.constructorArgumentsHash,
    },
    deploymentRecord: {
      exists: final,
      facility: plan.predictedFacility,
      kernel: a.kernel,
      chainId: config.chainId,
      policyId: 1,
      evaluator: a.policy,
      releaseId: plan.commitments.releaseId,
      runtimeVariantId: plan.commitments.runtimeVariantId,
      configHash: plan.commitments.policyConfigHash,
      manifestHash: plan.commitments.policyConfigHash,
    },
  };
  Object.assign(state.registry.deploymentRecord, {
    runtimeCodeHash: plan.commitments.policyRuntimeCodeHash,
    constructorArgumentsHash: plan.commitments.constructorArgumentsHash,
    attester: config.roles.issuer,
  });
  state.facility = {
    asset: a.asset,
    kernel: a.kernel,
    lender: a.pool,
    borrower: config.roles.borrower,
    facilityLimit: config.facility.facilityLimit,
    bondRequired: config.facility.bondRequired,
    initialDrawFeeBps: 200,
    maturityBlock: plan.maturityBlock,
    drawDelayBlocks: 10,
    status: 1,
    lenderFunded: config.facility.facilityLimit,
    bondPosted: config.facility.bondRequired,
    outstandingDebt: 0,
    drawnPrincipal: 0,
  };
  Object.assign(state.pool, {
    status: prefix >= 11 ? 2 : prefix >= 6 ? 1 : 0,
    createdFacilityCount: prefix >= 1 ? 1 : 0,
    candidateCount: prefix >= 4 ? 1 : 0,
    investorCount: prefix >= 5 ? 1 : 0,
    totalSupply: prefix >= 8 ? config.facility.facilityLimit : 0n,
    totalDeposited: prefix >= 8 ? config.facility.facilityLimit : 0n,
    totalAllocatedPrincipal: prefix >= 12 ? config.facility.facilityLimit : 0n,
    allocatedFacilityCount: prefix >= 12 ? 1 : 0,
    isInvestor: prefix >= 5,
  });
  state.pool.allocationOf.principal =
    prefix >= 12 ? config.facility.facilityLimit : 0n;
  Object.assign(state.factory, {
    facilityCount: prefix >= 1 ? 1 : 0,
    totalFacilityLimit: prefix >= 1 ? config.facility.facilityLimit : 0n,
  });
  Object.assign(state.facility, {
    status: prefix >= 13 ? 1 : 0,
    lenderFunded: prefix >= 12 ? config.facility.facilityLimit : 0n,
    bondPosted: prefix >= 10 ? config.facility.bondRequired : 0n,
  });
  state.policy.isConfigured = prefix >= 2;
  state.kernel.policySetCommitment =
    prefix >= 2 ? plan.commitments.policySetCommitment : ZeroHash;
  state.registry.deploymentRecord.exists = prefix >= 3;
  const contracts = Object.fromEntries(
    Object.entries(state).map(([key, members]) => [
      key,
      Object.fromEntries(
        Object.keys(members).map((method) => [
          method,
          async () => state[key][method],
        ]),
      ),
    ]),
  );
  const balances = {
    [a.pool]: 0n,
    [plan.predictedFacility]: final ? 120000000000n : 0n,
    [config.roles.investor]: 100000000000n,
    [config.roles.borrower]: 20000000000n,
  };
  const allowances = {};
  balances[a.pool] =
    prefix >= 8 && prefix < 12 ? config.facility.facilityLimit : 0n;
  balances[plan.predictedFacility] =
    (prefix >= 10 ? config.facility.bondRequired : 0n) +
    (prefix >= 12 ? config.facility.facilityLimit : 0n);
  if (prefix === 7)
    allowances[`${config.roles.investor}:${a.pool}`] =
      config.facility.facilityLimit;
  if (prefix === 9)
    allowances[`${config.roles.borrower}:${plan.predictedFacility}`] =
      config.facility.bondRequired;
  contracts.asset.balanceOf = async (address) => balances[address];
  contracts.asset.allowance = async (owner, spender) =>
    allowances[`${owner}:${spender}`] ?? 0n;
  const code = "0x60006000";
  const hash = keccak256(code);
  for (const name of [
    "PortfolioPoolV1",
    "CappedPilotFactoryV1",
    "PortfolioMandateV1",
  ])
    manifests.portfolio.finalQualification.runtimeQualification[name] = hash;
  manifests.core.runtimeCodeHashes.PolicyKernelV2 = hash;
  manifests.core.runtimeCodeHashes.PolicyRegistryV1 = hash;
  manifests.activation.registry.runtimeCodeHash = hash;
  manifests.portfolio.finalQualification.prerequisiteCodeHashes.asset = hash;
  const nativeBalances = Object.fromEntries(
    Object.values(config.roles).map((address) => [
      address,
      1000000000000000000n,
    ]),
  );
  const nonces = Object.fromEntries(
    Object.entries(config.roles).map(([role, address]) => [
      address,
      config.expectedStartingNonces[role],
    ]),
  );
  for (const step of plan.transactionPlan.slice(0, prefix))
    nonces[config.roles[step.signer]] += 1;
  const block = {
    ...config.qualificationBlock,
    number: config.qualificationBlock.number + 100,
  };
  const provider = {
    getNetwork: async () => ({ chainId: 102031n }),
    getBlock: async (number) =>
      number === "latest" || number === "finalized"
        ? block
        : config.qualificationBlock,
    getCode: async (address) =>
      address === plan.predictedFacility
        ? prefix >= 1
          ? manifests.artifacts.facility.deployedBytecode.object
          : "0x"
        : code,
    getTransactionCount: async (address) =>
      address === a.factory ? (prefix >= 1 ? 2 : 1) : nonces[address],
    getBalance: async (address) => nativeBalances[address],
  };
  return {
    ...values,
    plan,
    state,
    contracts,
    balances,
    allowances,
    nativeBalances,
    nonces,
    block,
    provider,
    repositoryState,
  };
}
