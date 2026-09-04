import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  MAX_OPERATOR_REPORT_BYTES,
  validateOperatorReport,
} from "../web/operator-core.mjs";
import { atomicWriteJson, isMainModule } from "./operator-core.mjs";

const PUBLIC_EVENT_LIMITATION =
  "Raw event records are omitted from this public artifact; metrics remain derived from the independent discovery checkpoint.";
const PUBLIC_COLLECTION_LIMIT = 500;
const PUBLIC_COLLECTION_LIMITATION =
  "Job, policy, and operator collections retain only the newest 500 relevant entries; bounded checkpoint metrics may include retained-operator activity for omitted jobs and exclude evicted operators.";

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

function computedRatio(numerator, denominator) {
  return {
    numerator,
    denominator,
    value: denominator === 0 ? null : numerator / denominator,
  };
}

function sum(operators, field) {
  return operators.reduce(
    (total, operator) => total + Number(operator?.[field] ?? 0),
    0,
  );
}

export function projectPublicOperatorReport(source) {
  const metrics = source?.metrics;
  const sourceJobs = source?.jobs ?? [];
  const sourcePolicies = source?.policies ?? [];
  const sourceOperators = metrics?.operators ?? [];
  const jobs = [...sourceJobs]
    .sort((left, right) =>
      BigInt(left.jobId) === BigInt(right.jobId)
        ? 0
        : BigInt(left.jobId) < BigInt(right.jobId)
          ? -1
          : 1,
    )
    .slice(-PUBLIC_COLLECTION_LIMIT);
  const policyKeys = new Set(
    jobs
      .filter((job) => job.policyId !== undefined)
      .map(
        (job) =>
          `${job.facility.toLowerCase()}:${BigInt(job.policyId).toString()}`,
      ),
  );
  const policies = sourcePolicies
    .filter(
      (policy) =>
        policyKeys.size === 0 ||
        policyKeys.has(
          `${policy.facility.toLowerCase()}:${BigInt(policy.policyId).toString()}`,
        ),
    )
    .slice(-PUBLIC_COLLECTION_LIMIT);
  const operators = [...sourceOperators]
    .sort(
      (left, right) =>
        Number(left?.lastActivityBlock ?? 0) -
          Number(right?.lastActivityBlock ?? 0) ||
        left.operator.localeCompare(right.operator),
    )
    .slice(-PUBLIC_COLLECTION_LIMIT);
  const collectionsTruncated =
    source?.scan?.stateTruncated === true ||
    jobs.length < sourceJobs.length ||
    policies.length < sourcePolicies.length ||
    operators.length < sourceOperators.length;
  const jobsCreated = collectionsTruncated ? jobs.length : metrics?.jobsCreated;
  const jobsCovered = collectionsTruncated
    ? Math.min(Number(metrics?.jobsCovered ?? 0), jobsCreated)
    : metrics?.jobsCovered;
  const completedJobs = collectionsTruncated
    ? Math.min(Number(metrics?.completedJobs ?? 0), jobsCreated)
    : metrics?.completedJobs;
  const commitments =
    operators.length < sourceOperators.length
      ? sum(operators, "commitments")
      : metrics?.commitments;
  const acceptedProofs =
    operators.length < sourceOperators.length
      ? sum(operators, "acceptedProofs")
      : metrics?.acceptedProofs;
  const processedProofReleases =
    operators.length < sourceOperators.length
      ? sum(operators, "processedProofReleases")
      : metrics?.processedProofReleases;
  const validReveals = acceptedProofs + processedProofReleases;
  const slashes =
    operators.length < sourceOperators.length
      ? sum(operators, "slashes")
      : metrics?.slashes;
  const releases =
    operators.length < sourceOperators.length
      ? sum(operators, "releases")
      : metrics?.releases;
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
    jobs: jobs.map((job) => ({
      jobId: job?.jobId,
      facility: job?.facility,
      token: job?.token,
      successfulProofs: job?.successfulProofs,
      maxSuccessfulProofs: job?.maxSuccessfulProofs,
      escrowRemaining: job?.escrowRemaining,
      state: job?.state,
    })),
    policies: policies.map((policy) => ({
      facility: policy?.facility,
      evaluator: policy?.evaluator,
      policyId: policy?.policyId,
    })),
    metrics: {
      jobsCreated,
      jobsCovered,
      commitments,
      acceptedProofs,
      processedProofReleases,
      validReveals,
      completedJobs,
      slashes,
      releases,
      coverage: collectionsTruncated
        ? computedRatio(jobsCovered, jobsCreated)
        : ratio(metrics?.coverage),
      acceptedValidRevealRate:
        operators.length < sourceOperators.length
          ? computedRatio(acceptedProofs, validReveals)
          : ratio(metrics?.acceptedValidRevealRate),
      completionRate: collectionsTruncated
        ? computedRatio(completedJobs, jobsCreated)
        : ratio(metrics?.completionRate),
      commitLatencyBlocks: distribution(metrics?.commitLatencyBlocks),
      commitLatencySeconds: distribution(metrics?.commitLatencySeconds),
      operators: operators.map((operator) => ({
        operator: operator?.operator,
        jobsCovered: collectionsTruncated
          ? Math.min(Number(operator?.jobsCovered ?? 0), jobsCreated)
          : operator?.jobsCovered,
        commitments: operator?.commitments,
        acceptedProofs: operator?.acceptedProofs,
        processedProofReleases: operator?.processedProofReleases,
        validReveals: operator?.validReveals,
        slashes: operator?.slashes,
        releases: operator?.releases,
        coverage: collectionsTruncated
          ? computedRatio(
              Math.min(Number(operator?.jobsCovered ?? 0), jobsCreated),
              jobsCreated,
            )
          : ratio(operator?.coverage),
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
      ...(collectionsTruncated ? [PUBLIC_COLLECTION_LIMITATION] : []),
      ...(source?.scan?.rpcLogCrossCheck !== true
        ? [
            "A single RPC endpoint cannot reveal log withholding; this artifact was produced without an independent log cross-check.",
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
