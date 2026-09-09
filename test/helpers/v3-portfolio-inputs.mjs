import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { readPortfolioInputs } from "../../scripts/lib/v3-portfolio-activation.mjs";

function trackedInputFixture(t) {
  const directory = mkdtempSync(
    resolve("..", "recourse-portfolio-input-hashes-"),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = JSON.parse(
    readFileSync("config/v3-portfolio-activation-cc3.json", "utf8"),
  );
  const artifactPaths = [
    "PortfolioPoolV1",
    "CappedPilotFactoryV1",
    "PortfolioMandateV1",
    "PolicyKernelV2",
    "PolicyRegistryV1",
    "MultiChainEventPolicyV1",
    "RecourseFacilityV3",
  ].map((name) => `out/${name}.sol/${name}.json`);
  for (const path of [
    ...Object.values(input.prerequisites).map((pin) => pin.path),
    ...artifactPaths,
  ]) {
    const bytes = readFileSync(path);
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), bytes);
  }
  writeFileSync(join(directory, "input.json"), JSON.stringify(input));
  execFileSync("git", ["init", "--quiet", directory]);
  commitFixture(directory);
  assert.equal(
    Object.keys(
      readPortfolioInputs("input.json", directory).manifests.artifacts,
    ).length,
    7,
  );
  return { directory, input, artifactPaths };
}

function commitFixture(directory) {
  const options = { cwd: directory, encoding: "utf8", windowsHide: true };
  execFileSync("git", ["-c", "core.autocrlf=false", "add", "."], options);
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Recourse Test",
      "-c",
      "user.email=recourse-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "tracked input fixture",
    ],
    options,
  );
}

test("tracked portfolio inputs reject each prerequisite SHA-256 mismatch", (t) => {
  const { directory, input } = trackedInputFixture(t);
  for (const name of ["portfolio", "core", "activation"]) {
    const changed = structuredClone(input);
    changed.prerequisites[name].sha256 = "1".repeat(64);
    writeFileSync(join(directory, "input.json"), JSON.stringify(changed));
    commitFixture(directory);
    assert.throws(() => readPortfolioInputs("input.json", directory), {
      message: `${name} prerequisite SHA-256 mismatch`,
    });
  }
});

test("tracked portfolio inputs reject each artifact hash mismatch", (t) => {
  const { directory, artifactPaths } = trackedInputFixture(t);
  for (const path of artifactPaths) {
    const absolutePath = join(directory, path);
    const bytes = readFileSync(absolutePath);
    writeFileSync(absolutePath, `${bytes.toString("utf8")}\n`);
    const name = path.split("/").at(-1).replace(".json", "");
    assert.throws(() => readPortfolioInputs("input.json", directory), {
      message: `${name} artifact hash mismatch`,
    });
    writeFileSync(absolutePath, bytes);
  }
  assert.equal(
    Object.keys(
      readPortfolioInputs("input.json", directory).manifests.artifacts,
    ).length,
    7,
  );
});
