# Capped pilot readiness and operator runbook

This runbook covers the local readiness gate and proof-job operator. The activated
capped V3 facility is a testnet demonstration, not a live pilot with a counterparty
or a claim that Recourse is production-ready.

## Readiness evidence

Copy `pilot/example.json` to a private working location and fill it only with
facts supported by local evidence artifacts. Each evidence `reference` is a path
relative to the readiness file, and each `digest` is the artifact's SHA-256 hash
with a `0x` prefix. The independent audit must identify the exact 40-hex Git
commit it covers. That commit must equal `HEAD`, and the deployable contracts,
daemon, scripts, SDK, web, operations templates, package manifests, and Foundry
configuration, lockfile, `.gitmodules`, and `lib/forge-std` submodule must be
clean. Lender, borrower, security, legal, and operations approvals are all
distinct mandatory roles. Evidence paths are realpath-confined regular files;
symlinks, directories, missing files, and digest mismatches fail closed. The
independent report contents and acceptance requirements are defined in
`docs/SECURITY-AUDIT-BRIEF.md`.

Run the gate with:

```text
npm run pilot:readiness -- --config /path/to/pilot.json --require-evidence-package
```

The tool can report `evidencePackageComplete`, but it always leaves
`productionReady` false and `humanAuthorizationRequired` true. Matching files and
hashes cannot prove the truth or legal effect of their contents, and this command
does not authorize deployment, funding, or transaction execution.

## Current V3 deployment boundary

`deployments-v3.json` is a historical inactive record. Its kernel, multi-chain
policy, and policy-set commitment predate the hardened current build, so the
activation preflight rejects it. Preserve that file. The hardened core is now
deployed on CC3 Testnet in [`deployments-v3-current.json`](../deployments-v3-current.json)
(schema version 2, `deployed-qualified`), from reviewed source commit
`90d8b05af38940ffeb55d974401641a327176b9e`, with runtime code hashes verified for
all six contracts at block 5459080.

[`activation-v3-current.json`](../activation-v3-current.json) records the capped
facility `0x00B50626C4AA42d22ca01AAEa8649f253aEc5B1e` as Active, with policy 1,
registry release `0xad31a01779b7c8c8651e1fecbb15b6d177c25dbd637c99d7496c2c2a0b7d221a`,
and open proof job 1. Its Ethereum source window is blocks 25944522–26024522
(source chain key 3), its CC3 maturity block is 5554121, and proof-job expiry is
Unix timestamp 1792497600. The recorded facility has a 100,000 rUSD limit,
20,000 rUSD borrower bond, no drawn principal, and 175 rUSD proof-job escrow.
rUSD is the fixed-supply demo token. There is still no design partner, live pilot
with a counterparty, independent audit, or production asset or custody decision.

For subsequent separately approved deployments, use a new manifest. The deployment
command is offline by default and does not read an RPC, load a signer, write a
file, or broadcast. Use `--live-check` for signerless qualification, then
`--live-check --write-plan <new-path>` to write the exact candidate plan for
separate human review and approval. That plan binds the clean deployable source
scope at its exact commit, six pinned artifacts, live anchor, capped fees, and
exactly six transactions: five creations followed by `setProofJobs`.

An approved plan expires 30 minutes after its chain timestamp. Broadcast
requires `--live-check --broadcast --approved-plan <exact-path> --approval-commitment <digest>` with the same
explicit manifest and can sign only the approved transaction sequence. Before
each send, the manifest-specific `.v3-deployment-journal.json` durably records
the raw signed transaction. Recovery checks the recorded hash first and may
rebroadcast only those same bytes; it requires the configured confirmation depth
and canonical block rechecks. Preserve that journal. If approval expires during
partial progress, create and separately approve a new plan bound to the journal
checkpoint and remaining steps.

Final qualification compares the exact deployed runtimes around compiler
immutables for all six pinned artifacts, including the constructor-created
`VerifiedCreditStateV1`, before writing the source-, plan-, transaction-, and
runtime-evidence-complete manifest. Bind a copied activation config to that exact
manifest path and lowercase SHA-256. The complete commands and recovery rules
are documented in `ops/README.md`; deployment and activation broadcasts remain
separately authorized operations.

## Read-only operator qualification

The checked-in `daemon/operator-config.example.json` is read-only and allowlists
only the deployed Horizon 1 demonstration facility, policy, denomination token,
and source chain key 3. This operator version rejects all other source keys. Run:

```text
npm run operator
```

`CREDITCOIN_RPC_URL` and `ETH_MAINNET_RPC_URL` are required. The source provider
must report Ethereum chain ID 1 before discovery or source state is written. The
operator writes an atomic discovery report, canonical cursor, per-job source
cursor, and health report under `daemon/operator-data` unless another data
directory is configured. A failed discovery scan never replaces the last good
report. Source scans compare the anchor hash before and after receipt hydration;
a reorg fails the cycle without advancing the cursor or queuing evidence.

## Execution mode

Execution requires changing `execution` to `enabled`, setting `exclusiveSigner`
to true, and configuring the maximum bond, minimum reimbursement,
reward-to-bond ratio, reveal/recovery window, expiry margin, and target
confirmations. Those bounds are checked during selection and immediately before
commit. Enabled mode also requires PolicyKernelV2's
`safeStaleProofRelease() == true`; V1 and unknown kernels are refused. Do that
only after the readiness evidence has been reviewed by the accountable humans
and the exact contract scope is authorized.

For V3, the runtime also requires an activation manifest whose digest and
configuration commitment exactly match the allowlists. Its
`generation-activation-commitment-v1` namespace isolates every activation from
Horizon 1 and from later V3 generations, preserving old recovery journals. The
runtime reads each registered policy's frozen source-ordering mode: strict
policies reject stale positions, while the cumulative `UniqueOnly` policy keeps
every distinct unprocessed transaction and uses the latest position only as a
non-regressing telemetry cursor.

Execution preserves the proof, salt, commitment, and complete intended signed
transaction binding (chain ID, signer, destination, nonce, calldata hash, value,
transaction hash, and raw bytes) before broadcast. The signed bytes are checked
against that independently derived intent before persistence and again on every
resume. On restart, target-chain commit, reveal, and release journals are
reconciled before source discovery or Ethereum RPC access. It rebroadcasts only
the same signed transaction when necessary and never creates a replacement for
an uncertain outcome. A nonce advancement or replacement is an incident, not a
transient retry. Journaled transactions are cleared only after the configured
confirmation depth and a canonical receipt/block recheck.

The configured transaction policy caps gas limit, per-gas fees, priority fees,
and total native fee. Those exact fee fields are part of the signed intent and
journal. Immediately before a first or resumed broadcast, the operator rechecks
the live job state, expiry/reveal window, commitment ownership, nonce, and the
approved call binding. A terminal reveal or release is not considered settled
until the resulting Proof Jobs pull claim is recovered through its own durable
journal; process restart resumes that claim instead of abandoning earned funds.

Before a new commitment, the operator binds the proof-builder payload to the
canonical source transaction and receipt, checks the native verifier-derived
transaction index, requires the retained ChainInfo attestation digest, verifies
the native proof, and preflights the full kernel evaluation. Source log ranges
split adaptively when an RPC refuses a range; hard log, candidate, and retained
history caps fail closed without advancing an unprocessed cursor.

Each job and source transaction has a separate execution journal. This is
required because one Proof Job may accept several successful proofs. `SIGINT` and
`SIGTERM` stop new work at the next durable journal boundary, write a final
`stopped` health status with `stoppedAt`, and release the process lock. A live or indeterminate
lock is never stolen; a lock is recovered only when its recorded PID is
demonstrably dead.

## Incident rules

- Never delete a journal with a pending transaction. Reconcile its hash on-chain.
- Never copy the operator data directory into a public artifact or web root.
- Treat an expired reveal window or reverted journaled transaction as an incident;
  do not manually retry with a new nonce before reviewing the on-chain state.
- Finalized OutcomeReached or AttemptsExhausted jobs with a live commitment are
  recovered through a journaled `releaseCommit`, followed by a journaled pull
  claim when funds are claimable. Expired live commitments remain explicit
  incidents and are never retried forever.
- Keep the operator read-only if RPC chain identity, policy configuration,
  allowlists, source cursor canonicality, or discovery report freshness cannot be
  verified.
- Testnet history is not production credit performance or evidence of demand.
