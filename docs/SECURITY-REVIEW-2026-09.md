# INTERNAL security review — September 2026

> **INTERNAL — NOT AN INDEPENDENT AUDIT.** This review does not satisfy the
> independent-audit readiness gate. It must never be entered as audit evidence
> in `npm run pilot:readiness -- --require-evidence-package`.

Six parallel adversarial review lanes and Slither 0.11.5 covered the V3 contracts
and their transitive V2 components, release and activation tooling, the operator
runtime, and the SDK and web surfaces. Slither reported 126 findings, which were
manually triaged. The review began from commit
`b95444875aedb5abcacbf9b6299fc1ecbfb867b1` on 2026-09-04.

The review found 4 HIGH, 15 MEDIUM, approximately 22 LOW, and approximately 22
informational findings. All four HIGH findings and all 15 MEDIUM findings were
remediated.

## HIGH findings

| ID | Finding | Disposition |
| --- | --- | --- |
| H1 | V3 activation compared reviewed runtime bytecode for only three of six core contracts, allowing a stale core manifest to stand in for the reviewed build. | Fixed. Activation now requires schema-v2 qualified manifests, binds runtime hashes for all six core contracts, and compares every live runtime before activation. |
| H2 | `RemedyCoordinatorV1` could leave an intent permanently in `Acknowledged` when cure evidence could never be produced. | Fixed. An acknowledged intent records its acknowledgement time and becomes permissionlessly expirable after a bounded seven-day cure window. |
| H3 | Operator confirmation polling treated a block-count recovery budget as seconds, making the shipped policy unable to observe the required confirmations before timing out. | Fixed. Execution policy now carries an explicit block-time duration and receipt polling uses it consistently. |
| H4 | The Horizon 1 execution path ignored the documented systemd credential loader and required a private key in its environment. | Fixed. Horizon 1 now uses the same credential loader as the V3 runner and verifies the derived signer against `HUNTER_ADDRESS`. |

## MEDIUM findings

| ID | Lane | Finding | Disposition |
| --- | --- | --- | --- |
| M1 | Contracts | A hunter's commit bond could be captured by the sponsor when the facility left `Active`. | Fixed. Non-active facilities are a graceful non-acceptance in the proof-job path, and expired jobs permit bond release. |
| M2 | Contracts | `PolicyKernelV2.registerPolicy` did not verify that the facility was bound to that kernel, permitting an evidence market whose effects could never settle. | Fixed. Registration enforces the facility's kernel, and `canPublishJob` repeats the binding check. |
| M3 | Contracts | `ClosedLoopPolicyV1` accepted finite or misordered cure windows and cure effects that could make cure or later credit availability permanently impossible. | Fixed. Configuration validation now rejects finite cure windows, non-forward shared-chain ordering, positive freshness periods, and cure effects that require fresh evidence. |
| M4 | Proof Jobs | A borrower could unilaterally pause draws and thereby veto the pool's only evidence-admission path. | Fixed. Draw-pause state no longer gates `ProofJobsV1.createJob`; it still controls draws. |
| M5 | Operator market | Any address could accept a public quote and force capture of the operator's bond at gas-only cost. | Fixed. Quotes require a nonzero intended sponsor, and only that sponsor may accept. |
| M6 | Operator market | The service verifier was an unconstrained trust dependency with no reference implementation. | Fixed. `OperatorServiceVerifierV1` binds the complete service context in an EIP-712 receipt and supports both ECDSA and ERC-1271 attestors. |
| M7 | Portfolio | Configuration permitted `maximumServiceBudget == maximumPoolAssets`, placing all investor capital within the manager's service-spending authority. | Fixed. `PortfolioPoolV1` rejects deployments whose immutable service budget exceeds 500 basis points (5%) of maximum pool assets; deployments may choose a lower or zero budget. A regression test covers the boundary. |
| M8 | Release tooling | Approval files used only an unkeyed hash over editable JSON, so an editor could alter the envelope and recompute its commitment. | Fixed. Broadcast validation requires an approval commitment supplied outside the approval file and independently derives the complete envelope digest. |
| M9 | Release tooling | Activation approval lacked effective integrity, bounded time anchoring, and canonical live-chain qualification checks. | Fixed. Activation uses the external approval commitment, validates the live qualification rather than the approval's self-reported copy, and enforces live timestamp and canonical-anchor consistency. Extension and USC validators enforce the same issued-at invariant. |
| M10 | Release tooling | Config and prerequisite-manifest paths were unconfined, allowing out-of-repository substitutions to be labeled with a clean audited commit. | Fixed. Live tools require repository-confined, tracked, clean inputs, record tracked Git blob commitments, and bind source commit and deployable-scope state. |
| M11 | Operator runtime | A withholding RPC could omit logs while the cursor advanced permanently, and the same endpoint also supplied attestation state. | Fixed. Log ranges are compared against an independent RPC before advancement, and attestation reads require a separately configured provider. |
| M12 | Operator runtime | Only reverted `reveal` transactions became terminal incidents; other reverted lifecycle transactions remained pending forever without their revert reason. | Fixed. Every mined lifecycle revert is persisted as a terminal incident with decoded revert data, and evidence-reservation races are checked before broadcast. |
| M13 | Operator runtime | `daemon/index.mjs` exposed an unhardened signing and broadcast path that bypassed fee, journal, confirmation, lock, and reorg controls. | Fixed. The path and its package script were removed. |
| M14 | Operator runtime | A deep reorg permanently wedged discovery until its entire cursor and accumulated metrics were deleted. | Fixed. Discovery rewinds to the deepest retained canonical boundary and replays forward while preserving earlier checkpoint history. |
| M15 | Operator runtime | Unbounded cursor collections met a hard 500-entry publisher limit, so the next job or operator could freeze the public report permanently. | Fixed. Cursors are pruned to replay-safe bounds, report collections are truncated deterministically, and explicit limitation strings disclose truncation. |

The LOW and informational findings were triaged individually during the review.
They consisted primarily of documentation precision, observability limits,
defence-in-depth opportunities, and static-analysis false positives. They are
not represented here as an independent assurance statement.

## Verified-sound results

The adversarial review also established the following negative results:

- Every evaluating path requires `receiptStatus == 1`. This is essential because
  the BlockProver precompile proves inclusion but does not validate transaction
  success.
- Every log match requires the emitting contract address to equal the committed
  token address, so the same event shape emitted by an unrelated contract cannot
  satisfy a policy.
- Asset conservation holds across all four terminal paths. The V3 bond split is
  exact and strands no assets.
- All 15 SDK ABI arrays and 22 web inline ABIs had zero drift from the compiled
  artifacts. Twenty-seven calldata builders round-tripped against those
  artifacts.
- `web/ethers.umd.min.js` is an unmodified ethers 6.17.0 distribution. The npm
  registry integrity value matches both lockfiles and the vendored bytes.
- The live public `operator-report.json` is a strict allowlist projection. It
  exposes no key material, filesystem paths, RPC URLs, or hostnames.

## Reviewer tooling trap

The repository sources use CRLF. Slither derives incorrect line numbers from
byte offsets on these files: reported lines drift low, and the error grows later
in a file. Locate findings by symbol, not by a Slither-reported line number.

Forge records normalized LF source content in artifact metadata. Fifteen of 38
artifacts therefore appear falsely stale if a reviewer hashes the CRLF checkout
bytes directly. Normalize CRLF to LF before comparing source bytes with
`metadata.sources` keccak values.

## Status and exclusions

No deployment, activation, transaction broadcast, signer installation, package
publication, or capital movement was performed as part of this review or its
remediation. At the close of that review, the reviewed V3 roadmap build remained
undeployed, with no independent audit, design partner, live pilot facility,
published SDK, opened operator market, or capitalized portfolio pool. The public
console and Horizon 1 operator were read-only; neither established those gates.
Subsequent deployment and activation are recorded separately in
[`deployments-v3-current.json`](../deployments-v3-current.json) and
[`activation-v3-current.json`](../activation-v3-current.json). The activated capped
facility is a fixed-supply demo-token testnet demonstration, not a live pilot
with a counterparty or independent-audit evidence.

An independent reviewer must assess an exact clean remediation commit and
produce the evidence specified in
[`SECURITY-AUDIT-BRIEF.md`](SECURITY-AUDIT-BRIEF.md). This internal document is
context for that review only.

## Post-review defects found during the first live broadcast (2026-09-09)

- `90d8b05` fixed approval validation that compared the approved qualification
  with a fresh block for equality, which no later block could satisfy. The fix
  permits later blocks while retaining the approved anchor and invariant checks.
- `783768d` fixed receipt polling at 1 second × 24 polls, which could not cover
  six 15-second confirmations. Polling now defaults to the CC3 block interval
  and validates that the time budget covers the required confirmation depth.
- `897ad0d` fixed core approval re-validation rejecting pending nonce progress
  after a confirmed deployment step. The follow-up review of the first two
  fixes found this release-tooling defect, not a contract defect. Higher live
  nonces are accepted only when confirmed/prepared journal steps explain them;
  lower nonces and nonce changes without a journal remain refused. The deployed
  core and pilot are unaffected: they were completed by renewal cycles that
  each advanced one step.

The first two defects were found by running the release tools live, not by this
review. They are release-tooling defects, not contract defects.

## Post-review mandate and verifier addendum (2026-09-09)

`PortfolioMandateV1` now accepts `requiredActionAdapterKind == bytes32(0)`
and returns Eligible after the evidence-kind check in that mode. A nonzero
kind still requires an exact matching action-adapter declaration. This permits
the existing activated release and evidence policy to serve a mandate that
requires no action adapter. It removes only the metadata-only declaration
check in zero mode; that check never proved adapter deployment, execution,
custody, or recovery. It does not deploy a same-chain remedy adapter.

Factory membership, asset, kernel, facility status, limit, bond, draw fee,
maturity, policy-set commitment, release existence, issuer-recorded deployment
bindings, and evidence-kind checks remain in their original order. Registry
publication and SDK publication encoding still reject zero-kind adapter
declarations; an empty declaration list remains allowed. The SDK simulator
mirrors both mandate modes for valid complete snapshots.

The fourth extension generation, `operator-service-verifier-v1`, produces the
qualified prerequisite manifest consumed by the operator-market generation.
It checks the pinned runtime and immutable groups, configured attestor,
EIP-712 domain, and a locally computed service-receipt digest before publishing
a deployed-qualified manifest. Shared approval, nonce, fee, journal, and
canonical-confirmation controls remain required.

Task W reviewed commits `6de854d` and `de416dc` and found one MEDIUM finding,
Task W M1: three extension artifact pins matched existing output but failed a
clean whole-project rebuild. Compiler-generated raw JSON IDs differed while
creation/runtime bytecode and metadata were unchanged. The correction,
`08915d422c3ecdb8717f6a8dd9265825c77fe2c9`, re-pinned the verifier, pool,
mandate, and affected remedy artifacts from clean-build output. Raw-file
keccak256 checks remain mandatory; executable-bytecode equality is insufficient.
Task W's recorded checks passed: `forge test` (392 passed, zero failed or
skipped), `node --test test/*.test.mjs` (280 tests, 279 passed, one Windows
symlink-permission skip), and `npm --prefix sdk test` (44 passed plus strict
declaration type-checking). Those Node checks used existing output and did not
negate M1; Task X subsequently verified the corrected pins and passing root
Node suite. These are internal checks, not independent audit evidence.

Task Y reran those three commands after the deployment records: 392 Forge
tests passed with zero failures or skips; 280 root Node tests yielded 279
passes, zero failures, and one Windows symlink-permission skip; all 44 SDK
tests and strict declaration type-checking passed. Twelve invariant checks
(eight distinct properties) each completed 256 runs and 128,000 calls with
zero handler reverts. No RPC, signing, or broadcast was part of these checks.

The committed verifier, market, and portfolio-core manifests record six
qualified CC3 transactions. The operator verifier and empty market are
deployed with one dedicated project-operated EOA attestor. The fixed-vintage
pool, dedicated pool-owned capped factory, and zero-mode mandate are deployed
and qualified in Configuring state against the activated release, with no
adapter required by the mandate. Allocation has not been exercised. No
investors, capital, service quotes, or completed work are demonstrated by
deployment. See `deployments-v3-operator-service-verifier-current.json`,
`deployments-v3-operator-market-current.json`, and
`deployments-v3-portfolio-core-current.json` at the repository root.

These contracts were not part of the September internal review's deployed
scope; this addendum does not extend that review into a production security or
audit conclusion. Independent attestation, competitive operators, customer
usage, real servicing performance, profitability, production readiness,
evergreen NAV, cross-chain remedy execution, Attestcoin writability, completed
cures, and audited portfolio loss accounting remain unsupported. Legal and
custody review, external demand, a production audit, and real servicing
history remain open.
