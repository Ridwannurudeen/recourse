const button = document.getElementById("copy-commands");
const note = document.getElementById("copy-note");
const status = document.getElementById("copy-status");
if (typeof navigator.clipboard?.writeText === "function") {
  button.disabled = false;
  button.setAttribute("aria-label", "Copy: npm ci --omit=dev, then npm run judge:verify");
  document.getElementById("copy-label").textContent = "Copy both commands";
  note.textContent = "Copies both lines. Run from the repo root.";
  let reset;
  button.addEventListener("click", async () => {
    clearTimeout(reset);
    status.textContent = "";
    try {
      await navigator.clipboard.writeText("npm ci --omit=dev\nnpm run judge:verify");
      button.classList.add("is-copied");
      status.textContent = "Both commands copied. Paste into your shell.";
      note.textContent = "Copies both lines. Run from the repo root.";
      reset = setTimeout(() => button.classList.remove("is-copied"), 2200);
    } catch {
      button.classList.remove("is-copied");
      note.textContent = "Copy manually from the commands above.";
      status.textContent = "Clipboard access denied. Select and copy the commands manually.";
    }
  });
}

const DEPLOYMENT = Object.freeze({
  rpcUrl: "https://rpc.cc3-testnet.creditcoin.network",
  chainId: 102031,
  factory: "0x73afEFF5A629B6708EAbf1AD0bce753E3fb7973B",
  proofJobs: "0x0C6C15da198EA9F828d0e3199508187b1a79e9Cf",
  policyRegistry: "0xFb5B0d26140A8577015388E206A06fc6e1622c28",
  // CappedPilotFactoryV1.asset() is rUSD, read on CC3 as 6 decimals.
  assetDecimals: 6,
  assetSymbol: "rUSD",
});

if (window.ethers) {
  const { Contract, JsonRpcProvider, formatUnits } = window.ethers;
  const amount = (value) => {
    const [whole, fraction] = formatUnits(value, DEPLOYMENT.assetDecimals).split(".");
    return BigInt(whole).toLocaleString("en-US") + (fraction === "0" ? "" : `.${fraction}`);
  };
  const provider = new JsonRpcProvider(DEPLOYMENT.rpcUrl, DEPLOYMENT.chainId, {
    staticNetwork: true,
  });
  const factory = new Contract(DEPLOYMENT.factory, [
    "function facilityCount() view returns (uint256)",
    "function maximumFacilityCount() view returns (uint16)",
    "function totalFacilityLimit() view returns (uint256)",
    "function maximumTotalLimit() view returns (uint256)",
  ], provider);
  const proofJobs = new Contract(DEPLOYMENT.proofJobs, [
    "function nextJobId() view returns (uint256)",
  ], provider);
  const policyRegistry = new Contract(DEPLOYMENT.policyRegistry, [
    "function releaseCount() view returns (uint256)",
  ], provider);
  const reads = [
    ["live-block", [() => provider.getBlock("finalized")], ([block]) => {
      if (!block) throw new Error("Finalized block unavailable");
      return block.number.toLocaleString("en-US");
    }],
    ["live-facilities", [() => factory.facilityCount(), () => factory.maximumFacilityCount()],
      ([count, cap]) => `${count.toLocaleString("en-US")} of ${cap.toLocaleString("en-US")}`],
    ["live-limit", [() => factory.totalFacilityLimit(), () => factory.maximumTotalLimit()],
      ([total, cap]) => `${amount(total)} of ${amount(cap)} ${DEPLOYMENT.assetSymbol}`],
    ["live-jobs", [() => proofJobs.nextJobId()], ([value]) => (value - 1n).toLocaleString("en-US")],
    ["live-releases", [() => policyRegistry.releaseCount()], ([value]) => value.toLocaleString("en-US")],
  ];

  const LIVE_IDS = ["status-block", "live-block", "live-facilities", "live-limit", "live-jobs", "live-releases"];
  for (const id of LIVE_IDS) document.getElementById(id).textContent = "connecting…";
  const pendingReads = new Set();

  async function refresh() {
    await Promise.allSettled(reads.map(async ([id, read, format]) => {
      if (pendingReads.has(id)) return;
      const element = document.getElementById(id);
      let timeout;
      let available = false;
      try {
        pendingReads.add(id);
        // Keep the row occupied until every request settles, even after a timeout.
        const request = Promise.allSettled(read.map((call) => Promise.resolve().then(call)))
          .finally(() => pendingReads.delete(id));
        const value = await Promise.race([
          request,
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error("RPC read timed out")), 10000);
          }),
        ]);
        const failed = value.find((result) => result.status === "rejected");
        if (failed) throw failed.reason;
        element.textContent = format(value.map((result) => result.value));
        available = true;
      } catch {
        element.textContent = "unavailable";
      } finally {
        clearTimeout(timeout);
      }
      if (id === "live-block") {
        element.classList.toggle("is-pending", !available);
        document.getElementById("status-block").textContent = element.textContent;
        document.getElementById("live-badge").hidden = !available;
        document.getElementById("live-dot").classList.toggle("is-live", available);
      }
    }));
    setTimeout(refresh, 30000);
  }

  refresh();
} else {
  for (const id of ["status-block", "live-block", "live-facilities", "live-limit", "live-jobs", "live-releases"]) {
    document.getElementById(id).textContent = "unavailable";
  }
}
