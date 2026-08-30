import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluatePilotReadiness } from "../scripts/lib/pilot-readiness.mjs";

const ROLES = ["lender", "borrower", "security", "legal", "operations"];
const GIT_COMMIT = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const GATES = [
  "designPartner",
  "independentAudit",
  "legalReview",
  "pilotBudget",
  "testnetRehearsal",
  "productionAssetAndCustody",
  "productionWatcher",
];
const CLEAN_REPOSITORY = {
  head: GIT_COMMIT.toLowerCase(),
  deployableScopeClean: true,
};

function readyConfig(reference, digest) {
  return {
    schemaVersion: 1,
    pilotId: "pilot-1",
    deploymentEnvironment: "production",
    gates: Object.fromEntries(
      GATES.map((key) => [
        key,
        {
          status: "complete",
          evidence: [{ reference, digest }],
          ...(key === "independentAudit" ? { exactCommit: GIT_COMMIT } : {}),
        },
      ]),
    ),
    approvals: ROLES.map((role) => ({
      role,
      name: `${role} owner`,
      signedAt: "2026-08-30T00:00:00.000Z",
      reference,
      digest,
    })),
  };
}

test("the repository example reports every real-world pilot dependency as blocked", async () => {
  const config = JSON.parse(await readFile("pilot/example.json", "utf8"));
  const report = evaluatePilotReadiness(config, "2026-08-30T00:00:00.000Z");

  assert.equal(report.productionReady, false);
  assert.equal(
    report.gates.every(({ status }) => status === "blocked"),
    true,
  );
  assert.equal(
    report.approvals.every(({ status }) => status === "blocked"),
    true,
  );
  assert.ok(
    report.blocked.includes("deployment:environment-is-not-production"),
  );
  assert.match(report.limitations.join(" "), /does not verify the truth/i);
});

test("a fully hashed evidence package remains human-authorized, never machine-declared production ready", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-pilot-evidence-"));
  const reference = "evidence.txt";
  const contents = "reviewed evidence\n";
  const digest = `0x${createHash("sha256").update(contents).digest("hex")}`;
  try {
    await writeFile(join(directory, reference), contents, "utf8");
    const config = readyConfig(reference, digest);
    const ready = evaluatePilotReadiness(config, undefined, {
      baseDirectory: directory,
      repositoryState: CLEAN_REPOSITORY,
    });
    assert.equal(ready.evidencePackageComplete, true);
    assert.equal(ready.humanAuthorizationRequired, true);
    assert.equal(ready.productionReady, false);
    assert.deepEqual(ready.blocked, []);

    const missingAuditScope = readyConfig(reference, digest);
    delete missingAuditScope.gates.independentAudit.exactCommit;
    assert.equal(
      evaluatePilotReadiness(missingAuditScope, undefined, {
        baseDirectory: directory,
        repositoryState: CLEAN_REPOSITORY,
      }).evidencePackageComplete,
      false,
    );

    const unknownAuditCommit = readyConfig(reference, digest);
    unknownAuditCommit.gates.independentAudit.exactCommit = "f".repeat(40);
    assert.equal(
      evaluatePilotReadiness(unknownAuditCommit, undefined, {
        baseDirectory: directory,
        repositoryState: CLEAN_REPOSITORY,
      }).evidencePackageComplete,
      false,
    );

    const missingApproval = readyConfig(reference, digest);
    missingApproval.approvals = missingApproval.approvals.filter(
      ({ role }) => role !== "legal",
    );
    assert.ok(
      evaluatePilotReadiness(missingApproval, undefined, {
        baseDirectory: directory,
        repositoryState: CLEAN_REPOSITORY,
      }).blocked.includes("approval:legal"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tampered, missing, and duplicate approval evidence fails closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-pilot-tamper-"));
  const reference = "evidence.txt";
  const original = "original\n";
  const digest = `0x${createHash("sha256").update(original).digest("hex")}`;
  try {
    await writeFile(join(directory, reference), "tampered\n", "utf8");
    const tampered = evaluatePilotReadiness(
      readyConfig(reference, digest),
      undefined,
      { baseDirectory: directory },
    );
    assert.equal(tampered.evidencePackageComplete, false);

    const missing = evaluatePilotReadiness(
      readyConfig("missing.txt", digest),
      undefined,
      { baseDirectory: directory },
    );
    assert.equal(missing.evidencePackageComplete, false);

    const duplicate = readyConfig(reference, digest);
    duplicate.approvals.push({ ...duplicate.approvals[0] });
    assert.throws(
      () =>
        evaluatePilotReadiness(duplicate, undefined, {
          baseDirectory: directory,
          repositoryState: CLEAN_REPOSITORY,
        }),
      /Duplicate pilot approval role/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("audit readiness binds the exact HEAD and a clean deployable scope", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-pilot-scope-"));
  const reference = "evidence.txt";
  const contents = "scope evidence\n";
  const digest = `0x${createHash("sha256").update(contents).digest("hex")}`;
  try {
    await writeFile(join(directory, reference), contents, "utf8");
    const dirty = evaluatePilotReadiness(
      readyConfig(reference, digest),
      undefined,
      {
        baseDirectory: directory,
        repositoryState: {
          ...CLEAN_REPOSITORY,
          deployableScopeClean: false,
        },
      },
    );
    assert.equal(dirty.evidencePackageComplete, false);
    assert.match(
      dirty.gates
        .find(({ key }) => key === "independentAudit")
        .reasons.join(" "),
      /deployable scope must be clean/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("evidence must be a regular in-boundary file and symlinks are refused", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "recourse-pilot-boundary-"));
  const outsideDirectory = await mkdtemp(
    join(tmpdir(), "recourse-pilot-outside-"),
  );
  const contents = "boundary evidence\n";
  const digest = `0x${createHash("sha256").update(contents).digest("hex")}`;
  try {
    await writeFile(join(outsideDirectory, "outside.txt"), contents, "utf8");
    await mkdir(join(directory, "directory-evidence"));
    const outside = evaluatePilotReadiness(
      readyConfig(
        join("..", outsideDirectory.split(/[\\/]/).at(-1), "outside.txt"),
        digest,
      ),
      undefined,
      { baseDirectory: directory, repositoryState: CLEAN_REPOSITORY },
    );
    assert.equal(outside.evidencePackageComplete, false);
    const notRegular = evaluatePilotReadiness(
      readyConfig("directory-evidence", digest),
      undefined,
      { baseDirectory: directory, repositoryState: CLEAN_REPOSITORY },
    );
    assert.equal(notRegular.evidencePackageComplete, false);

    const linkPath = join(directory, "linked-evidence.txt");
    try {
      await symlink(join(outsideDirectory, "outside.txt"), linkPath, "file");
    } catch (error) {
      if (error?.code === "EPERM") {
        context.skip("Windows symlink creation is not available");
        return;
      }
      throw error;
    }
    const linked = evaluatePilotReadiness(
      readyConfig("linked-evidence.txt", digest),
      undefined,
      { baseDirectory: directory, repositoryState: CLEAN_REPOSITORY },
    );
    assert.equal(linked.evidencePackageComplete, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outsideDirectory, { recursive: true, force: true });
  }
});

test("--require-ready fails closed for the checked-in testnet example", () => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/pilot-readiness.mjs",
      "--config",
      "pilot/example.json",
      "--require-ready",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).productionReady, false);
  assert.equal(result.stderr, "");
});
