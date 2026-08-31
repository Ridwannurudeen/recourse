import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { relative, resolve } from "node:path";

const REQUIRED_GATES = [
  ["designPartner", "Signed design partner"],
  ["independentAudit", "Independent audit of the exact contract scope"],
  ["legalReview", "Legal review of the facility terms"],
  ["pilotBudget", "Complete pilot budget"],
  ["testnetRehearsal", "Rehearsed testnet facility"],
  ["productionAssetAndCustody", "Production asset and custody decision"],
  ["productionWatcher", "Production watcher and incident owner"],
];

const REQUIRED_APPROVALS = [
  "lender",
  "borrower",
  "security",
  "legal",
  "operations",
];

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function artifactDigest(reference, baseDirectory) {
  if (!nonEmpty(reference)) return undefined;
  let descriptor;
  const root = realpathSync(resolve(baseDirectory));
  const path = resolve(root, reference);
  let canonicalPath;
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) return undefined;
    canonicalPath = realpathSync(path);
  } catch {
    return undefined;
  }
  const pathFromRoot = relative(root, canonicalPath);
  if (pathFromRoot.startsWith("..") || canonicalPath === root) return undefined;
  try {
    descriptor = openSync(
      canonicalPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    if (
      !fstatSync(descriptor).isFile() ||
      realpathSync(path) !== canonicalPath
    ) {
      return undefined;
    }
    return `0x${createHash("sha256").update(readFileSync(descriptor)).digest("hex")}`;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function validEvidence(evidence, baseDirectory) {
  return (
    Array.isArray(evidence) &&
    evidence.length > 0 &&
    evidence.every(
      (item) =>
        item &&
        nonEmpty(item.reference) &&
        nonEmpty(item.digest) &&
        /^0x[0-9a-fA-F]{64}$/.test(item.digest) &&
        artifactDigest(item.reference, baseDirectory) ===
          item.digest.toLowerCase(),
    )
  );
}

export function inspectDeployableRepository(repositoryDirectory) {
  const options = {
    cwd: repositoryDirectory,
    encoding: "utf8",
    windowsHide: true,
  };
  const head = spawnSync("git", ["rev-parse", "HEAD"], options);
  const status = spawnSync(
    "git",
    [
      "status",
      "--porcelain",
      "--",
      ".gitmodules",
      "contracts",
      "config",
      "daemon",
      "lib",
      "ops",
      "scripts",
      "sdk",
      "web",
      "package.json",
      "package-lock.json",
      "foundry.lock",
      "foundry.toml",
    ],
    options,
  );
  if (head.status !== 0 || status.status !== 0) {
    throw new Error("Unable to inspect the deployable Git scope");
  }
  return {
    head: head.stdout.trim().toLowerCase(),
    deployableScopeClean: status.stdout.trim() === "",
  };
}

function evaluateGate(key, label, input, baseDirectory, repositoryState) {
  const complete = input?.status === "complete";
  const hasEvidence = validEvidence(input?.evidence, baseDirectory);
  const exactScope =
    key !== "independentAudit" ||
    (/^[0-9a-fA-F]{40}$/.test(input?.exactCommit ?? "") &&
      input.exactCommit.toLowerCase() === repositoryState.head &&
      repositoryState.deployableScopeClean);
  return {
    key,
    label,
    status: complete && hasEvidence && exactScope ? "passed" : "blocked",
    reasons: [
      ...(!complete ? ["status is not complete"] : []),
      ...(!hasEvidence
        ? ["evidence references and bytes32 digests are required"]
        : []),
      ...(!exactScope
        ? [
            "audit exactCommit must equal HEAD and deployable scope must be clean",
          ]
        : []),
    ],
  };
}

function evaluateApproval(role, approval, baseDirectory) {
  const valid =
    approval?.role === role &&
    nonEmpty(approval.name) &&
    nonEmpty(approval.signedAt) &&
    Number.isFinite(Date.parse(approval.signedAt)) &&
    nonEmpty(approval.reference) &&
    /^0x[0-9a-fA-F]{64}$/.test(approval.digest ?? "") &&
    artifactDigest(approval.reference, baseDirectory) ===
      approval.digest.toLowerCase();
  return {
    role,
    status: valid ? "passed" : "blocked",
    reason: valid
      ? null
      : "named, dated approval with an evidence reference and bytes32 digest is required",
  };
}

export function evaluatePilotReadiness(
  config,
  generatedAt = new Date().toISOString(),
  {
    baseDirectory = process.cwd(),
    repositoryDirectory = process.cwd(),
    repositoryState: suppliedRepositoryState,
  } = {},
) {
  if (!config || config.schemaVersion !== 1) {
    throw new Error("Invalid pilot readiness configuration version");
  }
  if (!nonEmpty(config.pilotId)) throw new Error("pilotId is required");
  if (
    config.deploymentEnvironment !== "testnet" &&
    config.deploymentEnvironment !== "production"
  ) {
    throw new Error("deploymentEnvironment must be testnet or production");
  }
  const approvalRoles = (config.approvals ?? []).map(({ role }) => role);
  if (new Set(approvalRoles).size !== approvalRoles.length) {
    throw new Error("Duplicate pilot approval role");
  }
  const repositoryState =
    suppliedRepositoryState ?? inspectDeployableRepository(repositoryDirectory);
  const gates = REQUIRED_GATES.map(([key, label]) =>
    evaluateGate(
      key,
      label,
      config.gates?.[key],
      baseDirectory,
      repositoryState,
    ),
  );
  const approvals = REQUIRED_APPROVALS.map((role) =>
    evaluateApproval(
      role,
      config.approvals?.find((approval) => approval?.role === role),
      baseDirectory,
    ),
  );
  const blocked = [
    ...gates
      .filter(({ status }) => status === "blocked")
      .map(({ key }) => `gate:${key}`),
    ...approvals
      .filter(({ status }) => status === "blocked")
      .map(({ role }) => `approval:${role}`),
    ...(config.deploymentEnvironment !== "production"
      ? ["deployment:environment-is-not-production"]
      : []),
  ];
  return {
    schemaVersion: 1,
    pilotId: config.pilotId,
    generatedAt,
    deploymentEnvironment: config.deploymentEnvironment,
    evidencePackageComplete: blocked.length === 0,
    humanAuthorizationRequired: true,
    productionReady: false,
    blocked,
    gates,
    approvals,
    limitations: [
      "This report verifies that supplied local evidence artifacts exist and match their declared SHA-256 digests; it does not verify the truth, sufficiency, authority, or legal effect of their contents.",
      "Testnet deployment history is not production performance or evidence of customer demand.",
      "A complete evidence package is a release gate, not authorization to deploy, fund, broadcast, or execute a pilot.",
    ],
  };
}
