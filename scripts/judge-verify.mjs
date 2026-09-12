import { fileURLToPath } from "node:url";
import { runJudgeVerification } from "./lib/judge-verify.mjs";

const help = `Usage: npm run judge:verify -- [options]

Walletless, read-only checks against public endpoints.
  --json             Print the complete JSON report
  --cc3-rpc <url>     Creditcoin RPC endpoint
  --eth-rpc <url>     Ethereum RPC endpoint
  --explorer <url>    Creditcoin Blockscout API v2 endpoint
  --timeout <ms>      Timeout per network call (default: 20000)
  --help             Print this help
`;

function parseArgs(args) {
  const options = {};
  const names = {
    "--cc3-rpc": "cc3Rpc",
    "--eth-rpc": "ethRpc",
    "--explorer": "explorer",
    "--timeout": "timeout",
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "--json") {
      options[argument.slice(2)] = true;
      continue;
    }
    const name = names[argument];
    const value = args[index + 1];
    if (!name || !value || value.startsWith("--"))
      throw new Error(`Unknown or incomplete argument: ${argument}`);
    index += 1;
    if (name === "timeout") {
      if (
        !/^\d+$/.test(value) ||
        !Number.isSafeInteger(Number(value)) ||
        Number(value) < 1 ||
        Number(value) > 2147483647
      )
        throw new Error("--timeout must be an integer from 1 to 2147483647");
      options[name] = Number(value);
    } else {
      const url = new URL(value);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error(
          `${argument} requires an HTTP(S) URL without credentials`,
        );
      options[name] = value;
    }
  }
  return options;
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n${help}`);
  process.exitCode = 2;
}
if (options?.help) {
  process.stdout.write(help);
} else if (options) {
  const report = await runJudgeVerification({
    ...options,
    repoRoot: fileURLToPath(new URL("../", import.meta.url)),
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write("ID\tSTATUS\tTITLE\tSOURCE\n");
    for (const check of report.checks)
      process.stdout.write(
        `${check.id}\t${check.status}\t${check.title}\t${check.source}\n  ${check.detail}\n`,
      );
    const counts = { PASS: 0, FAIL: 0, UNVERIFIED: 0 };
    for (const check of report.checks) counts[check.status] += 1;
    process.stdout.write(
      `PASS ${counts.PASS} | FAIL ${counts.FAIL} | UNVERIFIED ${counts.UNVERIFIED}\n`,
    );
  }
  process.exitCode = report.checks.some((check) => check.status === "FAIL")
    ? 1
    : 0;
}
