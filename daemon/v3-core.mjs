import { getAddress, isHexString } from "ethers";
import { readFileSync } from "node:fs";
import { posix } from "node:path";

export const V3_ACTIVATION_GENERATION = "v3-pilot-activation";
export const V3_CHAIN_ID = 102031;
export const HUNTER_KEY_CREDENTIAL = "recourse-hunter-private-key";
const SOURCE_NETWORKS = Object.freeze({
  1: Object.freeze({
    evmChainId: 11155111,
    rpcUrlEnvironment: "SEPOLIA_RPC_URL",
  }),
  3: Object.freeze({
    evmChainId: 1,
    rpcUrlEnvironment: "ETH_MAINNET_RPC_URL",
  }),
});

function address(value, label) {
  try {
    return getAddress(value);
  } catch {
    throw new Error(`Invalid V3 activation ${label}`);
  }
}

function decimal(value, label, { positive = false } = {}) {
  const text = String(value);
  let parsed;
  try {
    parsed = BigInt(text);
  } catch {
    throw new Error(`Invalid V3 activation ${label}`);
  }
  if (
    parsed < 0n ||
    (positive && parsed === 0n) ||
    parsed.toString() !== text
  ) {
    throw new Error(`Invalid V3 activation ${label}`);
  }
  return text;
}

function block(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Invalid V3 activation ${label}`);
  }
  return number;
}

function digest(value, label) {
  if (!isHexString(value, 32)) {
    throw new Error(`Invalid V3 activation ${label}`);
  }
  return value.toLowerCase();
}

function exactSet(actual, expected, label, normalize) {
  const values = [...actual].map(normalize);
  if (
    values.length !== expected.size ||
    values.some((value) => !expected.has(value))
  ) {
    throw new Error(
      `V3 operator ${label} allowlist does not exactly match the activation manifest`,
    );
  }
}

export function activationDiscoveryDeployments(manifest) {
  if (!manifest || manifest.generation !== V3_ACTIVATION_GENERATION) {
    throw new Error("Invalid V3 activation generation");
  }
  if (Number(manifest.chainId) !== V3_CHAIN_ID) {
    throw new Error(
      `Invalid V3 activation chain ${manifest.chainId}; expected ${V3_CHAIN_ID}`,
    );
  }
  if (manifest.facility?.status !== "Active") {
    throw new Error("V3 activation facility is not Active");
  }
  const policyKernel = address(manifest.core?.policyKernel, "policy kernel");
  const multiChainEventPolicy = address(
    manifest.core?.multiChainEventPolicy,
    "multi-chain policy",
  );
  const proofJobs = address(manifest.core?.proofJobs, "ProofJobs");
  const facility = address(manifest.facility?.address, "facility");
  const asset = address(manifest.asset?.address, "asset");
  const policyId = decimal(manifest.policy?.policyId, "policy ID");
  const proofJobId = decimal(manifest.proofJob?.jobId, "proof job ID", {
    positive: true,
  });
  const configurationHash = digest(
    manifest.policy?.configurationHash,
    "policy configuration hash",
  );
  if (
    address(manifest.policy?.evaluator, "policy evaluator") !==
    multiChainEventPolicy
  ) {
    throw new Error("V3 activation policy evaluator does not match core");
  }
  if (address(manifest.proofJob?.address, "proof job address") !== proofJobs) {
    throw new Error("V3 activation proof job address does not match core");
  }
  if (
    digest(manifest.proofJob?.requirementsDigest, "requirements digest") !==
    configurationHash
  ) {
    throw new Error(
      "V3 activation proof job requirements do not match the policy configuration",
    );
  }
  const deploymentBlock = block(
    manifest.facility?.createdAtBlock,
    "facility creation block",
  );
  const activationBlock = block(manifest.activationBlock, "activation block");
  if (activationBlock < deploymentBlock) {
    throw new Error("V3 activation block precedes facility creation");
  }
  if (
    !Array.isArray(manifest.policy?.configuration?.rules) ||
    manifest.policy.configuration.rules.length === 0 ||
    manifest.policy.configuration.rules.length > 16
  ) {
    throw new Error("Invalid V3 activation policy rules");
  }
  const sourceNetworks = activationSourceNetworks(manifest);
  return {
    generation: V3_ACTIVATION_GENERATION,
    chainId: V3_CHAIN_ID,
    deploymentBlock,
    activationBlock,
    policyKernel,
    policyRegistry: address(manifest.core?.policyRegistry, "policy registry"),
    cappedPilotFactory: address(
      manifest.core?.cappedPilotFactory,
      "capped pilot factory",
    ),
    multiChainEventPolicy,
    proofJobs,
    verifiedCreditState: address(
      manifest.core?.verifiedCreditState,
      "verified credit state",
    ),
    demonstrationFacility: facility,
    demoAsset: asset,
    policyId,
    policyConfigHash: configurationHash,
    proofJobId,
    sourceNetworks,
    activation: manifest,
  };
}

export function multiRuleExecutionConfigurations(configuration) {
  const rules = configuration?.rules;
  if (!Array.isArray(rules)) {
    throw new Error("Invalid MultiChainEventPolicyV1 configuration");
  }
  if (rules.length === 0 || rules.length > 16) {
    throw new Error(
      `V3 operator requires between 1 and 16 MultiChainEventPolicyV1 source rules; found ${rules.length}`,
    );
  }
  const subject = address(configuration.subject, "subject");
  return rules.map((rule, ruleIndex) => ({
    ...rule,
    sourceChain: decimal(rule.sourceChain, `rule ${ruleIndex} source chain`, {
      positive: true,
    }),
    subject,
    ruleIndex,
  }));
}

export function singleRuleExecutionConfiguration(configuration) {
  const rules = multiRuleExecutionConfigurations(configuration);
  if (rules.length !== 1) {
    throw new Error(
      `V3 operator expected one MultiChainEventPolicyV1 source rule; found ${rules.length}`,
    );
  }
  const { ruleIndex: _ruleIndex, ...rule } = rules[0];
  return rule;
}

export function activationSourceNetworks(manifest) {
  const rules = manifest?.policy?.configuration?.rules;
  const sourceNetworks = manifest?.policy?.sourceNetworks;
  if (
    !Array.isArray(rules) ||
    !sourceNetworks ||
    typeof sourceNetworks !== "object" ||
    Array.isArray(sourceNetworks)
  ) {
    throw new Error("Invalid V3 activation source-network binding");
  }
  const required = [
    ...new Set(
      rules.map((rule) =>
        decimal(rule.sourceChain, "source chain", { positive: true }),
      ),
    ),
  ].sort((left, right) => Number(left) - Number(right));
  const supplied = Object.keys(sourceNetworks).sort(
    (left, right) => Number(left) - Number(right),
  );
  if (
    supplied.length !== required.length ||
    supplied.some((chain, index) => chain !== required[index])
  ) {
    throw new Error(
      "V3 activation source networks do not exactly cover policy rules",
    );
  }
  return Object.fromEntries(
    required.map((chainKey) => {
      const expectedNetwork = SOURCE_NETWORKS[chainKey];
      if (!expectedNetwork) {
        throw new Error(`Unsupported CC3 source chain key ${chainKey}`);
      }
      const network = sourceNetworks[chainKey];
      const evmChainId = Number(network?.evmChainId);
      if (!Number.isSafeInteger(evmChainId) || evmChainId <= 0) {
        throw new Error(
          `Invalid V3 activation EVM chain ID for source ${chainKey}`,
        );
      }
      if (
        typeof network.rpcUrlEnvironment !== "string" ||
        !/^[A-Z][A-Z0-9_]*$/.test(network.rpcUrlEnvironment)
      ) {
        throw new Error(
          `Invalid V3 activation RPC environment for source ${chainKey}`,
        );
      }
      if (
        evmChainId !== expectedNetwork.evmChainId ||
        network.rpcUrlEnvironment !== expectedNetwork.rpcUrlEnvironment
      ) {
        throw new Error(
          `V3 activation source ${chainKey} does not match its documented EVM network`,
        );
      }
      return [
        chainKey,
        { evmChainId, rpcUrlEnvironment: network.rpcUrlEnvironment },
      ];
    }),
  );
}

export function assertV3OperatorBinding(manifest, config) {
  const deployments = activationDiscoveryDeployments(manifest);
  exactSet(
    config.facilities,
    new Set([deployments.demonstrationFacility]),
    "facility",
    (value) => address(value, "operator facility"),
  );
  exactSet(
    config.policyIds,
    new Set([deployments.policyId]),
    "policy",
    (value) => BigInt(value).toString(),
  );
  exactSet(config.tokens, new Set([deployments.demoAsset]), "token", (value) =>
    address(value, "operator token"),
  );
  const sourceChains = new Set(
    manifest.policy.configuration.rules.map((rule) =>
      decimal(rule.sourceChain, "source chain", { positive: true }),
    ),
  );
  exactSet(config.sourceChains, sourceChains, "source chain", (value) =>
    BigInt(value).toString(),
  );
  return true;
}

export function assertActivatedV3Job(job, deployments) {
  const activation = deployments.activation;
  const expected = activation.proofJob;
  if (BigInt(job.jobId ?? deployments.proofJobId) !== BigInt(expected.jobId)) {
    throw new Error("V3 proof job ID does not match the activation manifest");
  }
  for (const [field, label] of [
    ["expiry", "expiry"],
    ["revealWindowBlocks", "reveal window"],
    ["maxSuccessfulProofs", "maximum successful proofs"],
    ["proofReimbursement", "proof reimbursement"],
    ["outcomeReward", "outcome reward"],
    ["commitBond", "commit bond"],
  ]) {
    if (BigInt(job[field]) !== BigInt(expected[field])) {
      throw new Error(`V3 proof job ${label} does not match activation`);
    }
  }
  if (
    Number(job.rewardOutcomeThreshold) !==
    Number(expected.rewardOutcomeThreshold)
  ) {
    throw new Error("V3 proof job reward threshold does not match activation");
  }
  if (
    address(job.sponsor, "job sponsor") !==
      address(activation.roles.lender, "lender") ||
    address(job.facility, "job facility") !==
      deployments.demonstrationFacility ||
    address(job.token, "job token") !== deployments.demoAsset ||
    BigInt(job.policyId) !== BigInt(deployments.policyId) ||
    digest(job.requirementsDigest, "job requirements") !==
      deployments.policyConfigHash
  ) {
    throw new Error("V3 proof job identity does not match activation");
  }
  return true;
}

export function loadHunterPrivateKey(
  environment = process.env,
  readCredential = readFileSync,
) {
  let raw;
  if (environment.CREDENTIALS_DIRECTORY) {
    raw = readCredential(
      posix.join(environment.CREDENTIALS_DIRECTORY, HUNTER_KEY_CREDENTIAL),
      "utf8",
    );
  } else {
    raw = environment.HUNTER_PRIVATE_KEY;
  }
  const value = typeof raw === "string" ? raw.trim() : "";
  const normalized = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("Invalid hunter signing credential");
  }
  return normalized;
}
