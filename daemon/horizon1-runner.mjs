import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function runHorizon1Job({
  transactionHash,
  jobId,
  statePath,
  deploymentPath,
  signal,
  executionPolicy,
  recoveryOnly = false,
  environment = process.env,
  spawnProcess = spawn,
}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawnProcess(
      process.execPath,
      [
        resolve("daemon/horizon1.mjs"),
        transactionHash,
        BigInt(jobId).toString(),
      ],
      {
        env: {
          ...environment,
          HORIZON1_STATE_FILE: resolve(statePath),
          HORIZON1_DEPLOYMENTS_FILE: resolve(deploymentPath),
          RECOURSE_EXECUTION_POLICY_JSON: JSON.stringify(executionPolicy),
          RECOURSE_RECOVERY_ONLY: recoveryOnly ? "1" : "0",
        },
        stdio: "inherit",
        windowsHide: true,
      },
    );
    const stop = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", stop, { once: true });
    child.once("error", (error) => {
      signal?.removeEventListener("abort", stop);
      reject(error);
    });
    child.once("exit", (code, childSignal) => {
      signal?.removeEventListener("abort", stop);
      if (code === 0) {
        resolvePromise();
        return;
      }
      if (code === 3 && existsSync(statePath)) {
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        resolvePromise({
          status: "incident",
          reason: state.incident?.reason || "operator incident",
        });
        return;
      }
      if (code === 4) {
        resolvePromise({ status: "aborted" });
        return;
      }
      reject(
        new Error(
          `Horizon 1 job ${jobId} exited with ${childSignal ? `signal ${childSignal}` : `code ${code}`}`,
        ),
      );
    });
  });
}
