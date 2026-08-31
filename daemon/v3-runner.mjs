import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function runV3Job({
  transactionHash,
  jobId,
  sourceChain,
  statePath,
  deploymentPath,
  signal,
  executionPolicy,
  recoveryOnly = false,
  environment = process.env,
  spawnProcess = spawn,
}) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      resolvePromise({ status: "aborted" });
      return;
    }
    const normalizedSourceChain = BigInt(sourceChain).toString();
    if (normalizedSourceChain !== "1" && normalizedSourceChain !== "3") {
      reject(
        new Error(
          `V3 execution supports only CC3 source chain keys 1 and 3; found ${normalizedSourceChain}`,
        ),
      );
      return;
    }
    const child = spawnProcess(
      process.execPath,
      [
        resolve("daemon/v3.mjs"),
        transactionHash,
        BigInt(jobId).toString(),
        normalizedSourceChain,
      ],
      {
        env: {
          ...environment,
          HORIZON1_STATE_FILE: resolve(statePath),
          RECOURSE_ACTIVATION_FILE: resolve(deploymentPath),
          RECOURSE_EXECUTION_POLICY_JSON: JSON.stringify(executionPolicy),
          RECOURSE_RECOVERY_ONLY: recoveryOnly ? "1" : "0",
          RECOURSE_SOURCE_CHAIN: normalizedSourceChain,
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
          `V3 job ${jobId} exited with ${childSignal ? `signal ${childSignal}` : `code ${code}`}`,
        ),
      );
    });
    if (signal?.aborted) stop();
  });
}
