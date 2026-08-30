import {
  parseOperatorReport,
  readBoundedResponseText,
  resolveOperatorReportUrl,
  shortHex,
  summarizeOperatorReport,
  verifyConfiguredOperatorAnchor,
} from "./operator-core.mjs";

const DEFAULT_REPORT = "./operator-report.json";
const REFRESH_MS = 30_000;
const DEPLOYMENT = Object.freeze({
  chainId: 102031,
  proofJobs: "0xdA28730f8BCd7dAd54Fe3c77D01aacC41E8DeB4b",
  rpcUrl: "https://rpc.cc3-testnet.creditcoin.network",
});
const provider = new window.ethers.JsonRpcProvider(
  DEPLOYMENT.rpcUrl,
  DEPLOYMENT.chainId,
  { staticNetwork: true },
);
let timer;

function byId(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  byId(id).textContent = String(value);
}

function cell(label, value, className) {
  const td = document.createElement("td");
  td.dataset.label = label;
  td.textContent = String(value);
  if (className) td.className = className;
  return td;
}

function badge(label, tone) {
  const element = document.createElement("span");
  element.className = "obs-badge";
  element.dataset.tone = tone;
  element.textContent = label;
  return element;
}

function metric(label, value) {
  const item = document.createElement("div");
  item.className = "obs-metric";
  const caption = document.createElement("span");
  caption.className = "obs-label";
  caption.textContent = label;
  const number = document.createElement("strong");
  number.textContent = String(value);
  item.append(caption, number);
  return item;
}

function render(validated) {
  const { report } = validated;
  const summary = summarizeOperatorReport(validated);
  setText("operator-block", report.scan.stateBlock.toLocaleString("en-US"));
  setText(
    "operator-generated",
    `Generated ${new Date(validated.generatedAt).toLocaleString()} · state ${validated.stateAgeSeconds}s old`,
  );
  const badges = byId("operator-badges");
  badges.replaceChildren(
    badge("RPC-matched deployment anchor", "good"),
    badge(`block ${shortHex(report.scan.stateBlockHash, 10, 6)}`, "good"),
    badge(`${report.scan.confirmations} confirmations`, "good"),
    badge(
      validated.stale ? "stale state" : "fresh state",
      validated.stale ? "alert" : "good",
    ),
    ...(validated.reportStale ? [badge("old report file", "warn")] : []),
    ...(validated.reportFuture || validated.stateFuture
      ? [badge("future timestamp", "alert")]
      : []),
    badge(
      validated.partial
        ? "partial operator-reported history"
        : "operator-reported history",
      validated.partial ? "warn" : "good",
    ),
    ...(validated.truncated ? [badge("events truncated", "alert")] : []),
  );
  byId("operator-metrics").replaceChildren(
    metric("Accepting jobs", summary.acceptingJobs),
    metric("Observed operators", summary.operators),
    metric("Commitments", summary.commitments),
    metric("Accepted proofs", summary.acceptedProofs),
    metric("Completed jobs", summary.completedJobs),
  );

  const jobs = byId("operator-jobs");
  jobs.replaceChildren();
  for (const job of report.jobs) {
    const row = document.createElement("tr");
    row.append(
      cell("Job", `#${job.jobId}`),
      cell("Facility", shortHex(job.facility), "obs-address"),
      cell("State", job.state),
      cell(
        "Proofs",
        `${job.successfulProofs} / ${job.maxSuccessfulProofs}`,
        "obs-num",
      ),
      cell("Escrow remaining", job.escrowRemaining, "obs-num"),
    );
    jobs.append(row);
  }
  byId("operator-jobs-empty").hidden = report.jobs.length !== 0;

  const operators = byId("operator-addresses");
  operators.replaceChildren();
  for (const operator of report.metrics.operators) {
    const row = document.createElement("tr");
    row.append(
      cell("Operator", shortHex(operator.operator), "obs-address"),
      cell("Jobs covered", operator.jobsCovered, "obs-num"),
      cell("Commitments", operator.commitments, "obs-num"),
      cell("Accepted", operator.acceptedProofs, "obs-num"),
      cell("Slashes", operator.slashes, "obs-num"),
    );
    operators.append(row);
  }
  byId("operator-addresses-empty").hidden =
    report.metrics.operators.length !== 0;

  const limitations = byId("operator-limitations");
  limitations.replaceChildren();
  for (const limitation of report.limitations) {
    const item = document.createElement("li");
    item.textContent = limitation;
    limitations.append(item);
  }
  byId("operator-state").hidden = true;
  byId("operator-dashboard").hidden = false;
}

async function refresh() {
  window.clearTimeout(timer);
  byId("operator-retry").hidden = true;
  const source = resolveOperatorReportUrl(window.location.href, DEFAULT_REPORT);
  setText(
    "operator-source",
    "Configured same-origin operator report · anchor not yet checked",
  );
  try {
    const response = await fetch(source, { cache: "no-store" });
    if (!response.ok)
      throw new Error(`Report request returned HTTP ${response.status}`);
    const validated = parseOperatorReport(
      await readBoundedResponseText(response),
    );
    await verifyConfiguredOperatorAnchor(validated, {
      provider,
      chainId: DEPLOYMENT.chainId,
      proofJobs: DEPLOYMENT.proofJobs,
    });
    setText(
      "operator-source",
      "Operator-reported file · RPC anchor independently checked",
    );
    render(validated);
  } catch (error) {
    byId("operator-dashboard").hidden = true;
    byId("operator-state").hidden = false;
    setText("operator-state-title", "Operator report unavailable");
    setText(
      "operator-state-copy",
      error instanceof Error ? error.message : String(error),
    );
    byId("operator-retry").hidden = false;
  } finally {
    timer = window.setTimeout(refresh, REFRESH_MS);
  }
}

byId("operator-retry").addEventListener("click", refresh);
refresh();
