import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  MAX_OPERATOR_REPORT_BYTES,
  validateOperatorReport,
} from "../web/operator-core.mjs";
import { atomicWriteJson, isMainModule } from "./operator-core.mjs";

const PUBLIC_EVENT_LIMITATION =
  "Raw event records are omitted from this public artifact; cumulative metrics remain derived from the independent discovery checkpoint.";

function ratio(value) {
  return {
    numerator: value?.numerator,
    denominator: value?.denominator,
    value: value?.value,
  };
}

function distribution(value) {
  return {
    count: value?.count,
    minimum: value?.minimum,
    maximum: value?.maximum,
    average: value?.average,
  };
}

export function projectPublicOperatorReport(source) {
  const metrics = source?.metrics;
  const eventsOmitted =
    source?.scan?.eventsTruncated === true || (source?.events?.length ?? 0) > 0;
  const projected = {
    schemaVersion: source?.schemaVersion,
    generatedAt: source?.generatedAt,
    chainId: source?.chainId,
    proofJobs: source?.proofJobs,
    scan: {
      fromBlock: source?.scan?.fromBlock,
      toBlock: source?.scan?.toBlock,
      historyFromBlock: source?.scan?.historyFromBlock,
      stateBlock: source?.scan?.stateBlock,
      stateBlockHash: source?.scan?.stateBlockHash,
      stateBlockTimestamp: source?.scan?.stateBlockTimestamp,
      historyComplete: source?.scan?.historyComplete,
      eventsTruncated: eventsOmitted,
      eventsFromBlock: null,
      confirmations: source?.scan?.confirmations,
    },
    events: [],
    jobs: (source?.jobs ?? []).map((job) => ({
      jobId: job?.jobId,
      facility: job?.facility,
      token: job?.token,
      successfulProofs: job?.successfulProofs,
      maxSuccessfulProofs: job?.maxSuccessfulProofs,
      escrowRemaining: job?.escrowRemaining,
      state: job?.state,
    })),
    policies: (source?.policies ?? []).map((policy) => ({
      facility: policy?.facility,
      evaluator: policy?.evaluator,
      policyId: policy?.policyId,
    })),
    metrics: {
      jobsCreated: metrics?.jobsCreated,
      jobsCovered: metrics?.jobsCovered,
      commitments: metrics?.commitments,
      acceptedProofs: metrics?.acceptedProofs,
      processedProofReleases: metrics?.processedProofReleases,
      validReveals: metrics?.validReveals,
      completedJobs: metrics?.completedJobs,
      slashes: metrics?.slashes,
      releases: metrics?.releases,
      coverage: ratio(metrics?.coverage),
      acceptedValidRevealRate: ratio(metrics?.acceptedValidRevealRate),
      completionRate: ratio(metrics?.completionRate),
      commitLatencyBlocks: distribution(metrics?.commitLatencyBlocks),
      commitLatencySeconds: distribution(metrics?.commitLatencySeconds),
      operators: (metrics?.operators ?? []).map((operator) => ({
        operator: operator?.operator,
        jobsCovered: operator?.jobsCovered,
        commitments: operator?.commitments,
        acceptedProofs: operator?.acceptedProofs,
        processedProofReleases: operator?.processedProofReleases,
        validReveals: operator?.validReveals,
        slashes: operator?.slashes,
        releases: operator?.releases,
        coverage: ratio(operator?.coverage),
        acceptedValidRevealRate: ratio(operator?.acceptedValidRevealRate),
        responseLatencyBlocks: distribution(operator?.responseLatencyBlocks),
        responseLatencySeconds: distribution(operator?.responseLatencySeconds),
      })),
    },
    limitations: [
      "Reverted invalid or irrelevant reveals emit no event, so this report does not claim an invalid-proof count or false-positive rate.",
      "ProcessedProofReleased proves only that a valid proof had already been processed; it is not counted as an accepted proof.",
      "Coverage means at least one observed commitment for a job whose creation is present in the retained history range; it is not an uptime or censorship claim.",
      ...(source?.scan?.historyComplete === false
        ? [
            "The retained history starts after contract deployment, so lifecycle rates exclude jobs whose creation is not present and do not describe complete contract history.",
          ]
        : []),
      ...(source?.scan?.eventsTruncated === true
        ? [
            "Cumulative metrics include earlier scanned events that are outside the bounded discovery checkpoint window.",
          ]
        : []),
      "No quotes, costs, reputation, profitability, or operator economics are inferred from these events.",
      PUBLIC_EVENT_LIMITATION,
    ],
  };
  return validateOperatorReport(projected).report;
}

export function writePublicOperatorReport(path, source) {
  const projected = projectPublicOperatorReport(source);
  const serialized = `${JSON.stringify(projected, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_OPERATOR_REPORT_BYTES) {
    throw new Error("Public operator report exceeds the response-size cap");
  }
  atomicWriteJson(path, projected, { mode: 0o640 });
  return projected;
}

function pathsFromArgs(args) {
  let input;
  let output;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if ((flag !== "--input" && flag !== "--output") || !value) {
      throw new Error(
        "Usage: publish-operator-report --input <path> --output <path>",
      );
    }
    if (flag === "--input") {
      if (input) throw new Error("--input may be supplied only once");
      input = resolve(value);
    } else {
      if (output) throw new Error("--output may be supplied only once");
      output = resolve(value);
    }
  }
  if (!input || !output) {
    throw new Error(
      "Usage: publish-operator-report --input <path> --output <path>",
    );
  }
  if (input === output) {
    throw new Error("Public report input and output paths must be different");
  }
  return { input, output };
}

function main() {
  const { input, output } = pathsFromArgs(process.argv.slice(2));
  const source = JSON.parse(readFileSync(input, "utf8"));
  writePublicOperatorReport(output, source);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exitCode = 1;
  }
}
