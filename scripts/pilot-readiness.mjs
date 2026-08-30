import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { evaluatePilotReadiness } from "./lib/pilot-readiness.mjs";

function parseArgs(args) {
  let configPath;
  let requireReady = false;
  let requireEvidencePackage = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--require-ready") {
      requireReady = true;
      continue;
    }
    if (argument === "--require-evidence-package") {
      requireEvidencePackage = true;
      continue;
    }
    if (argument !== "--config" || index + 1 >= args.length) {
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    }
    configPath = args[index + 1];
    index += 1;
  }
  if (!configPath) throw new Error("--config PATH is required");
  return {
    configPath: resolve(configPath),
    requireReady,
    requireEvidencePackage,
  };
}

try {
  const { configPath, requireReady, requireEvidencePackage } = parseArgs(
    process.argv.slice(2),
  );
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const report = evaluatePilotReadiness(config, new Date().toISOString(), {
    baseDirectory: dirname(configPath),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (
    (requireReady && !report.productionReady) ||
    (requireEvidencePackage && !report.evidencePackageComplete)
  ) {
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exitCode = 1;
}
