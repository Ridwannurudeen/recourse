# External security audit brief

This document is the handoff specification for an independent review of the
current Recourse roadmap build. It is not an audit report, does not claim that
the code is secure, and does not satisfy the repository's independent-audit
readiness gate. The auditor's final report, exact reviewed commit, explicit
scope, findings, and remediation disposition remain external evidence.

## Exact revision handshake

Audit a commit, never a branch name or working directory description. At
kickoff and again after remediation, record:

```text
git rev-parse HEAD
git status --short
git submodule status --recursive
```

`git status --short` must be empty. The `lib/forge-std` gitlink must be clean at
revision `bf647bd6046f2f7da30d0c2bf435e5c76a780c1b` (`v1.16.2`). Any source,
configuration, lockfile, submodule, artifact-pin, or test change creates a new
review revision. The final report must state the full 40-hex commit it covers.

## Primary smart-contract scope

The primary scope is every Solidity file under `contracts/v3/`, including its
interfaces, plus these transitive local V2 components:

- `contracts/v2/PolicyRegistryV1.sol`
- `contracts/v2/ProofJobsV1.sol`
- `contracts/v2/RecourseFacilityV2.sol`
- `contracts/v2/VerifiedCreditStateV1.sol`
- `contracts/v2/policies/EventHistoryPolicyV1.sol`
- `contracts/v2/interfaces/*.sol`
- `contracts/v2/types/RecourseTypesV2.sol`

The functional review areas are:

| Area | Principal contracts |
| --- | --- |
| Capped pilot and evidence kernel | `CappedPilotFactoryV1`, `RecourseFacilityV3`, `PolicyKernelV2`, `MultiChainEventPolicyV1`, `PolicyRegistryV1`, `ProofJobsV1`, `VerifiedCreditStateV1` |
| Remedy lifecycle and USC route | `RemedyCoordinatorV1`, `BoundedRemedyReceiverV1`, `ClosedLoopPolicyV1`, `UscRemedyTransportV1`, `UscRemedyDispatcherV1` |
| Operator services | `OperatorMarketV1`, `IOperatorServiceVerifierV1` |
| Credit portfolio | `PortfolioMandateV1`, `PortfolioPoolV1` |

Review inherited V2 behavior where V3 extends or calls it; inherited accounting,
authorization, and state transitions are not excluded merely because their
source lives under `contracts/v2/`.

## Release-tooling scope

The contract review should include the code that turns reviewed source into a
deployment or executable operator configuration:

- `config/v3-cc3.json`, `config/v3-pilot-cc3.json`,
  `config/usc-remedy.example.json`, and the three `config/v3-*.example.json`
  extension configurations;
- `scripts/deploy-v3.mjs`, `scripts/activate-v3-pilot.mjs`,
  `scripts/deploy-usc-remedy.mjs`, `scripts/deploy-v3-extension.mjs`, and their
  modules under `scripts/lib/`;
- `scripts/pilot-readiness.mjs` and `scripts/lib/pilot-readiness.mjs`;
- `daemon/operator.mjs`, `daemon/v3.mjs`, their runners and core modules, and
  both operator configuration examples;
- `ops/recourse-operator.service` and the operational instructions in
  `ops/README.md` and `docs/PILOT-RUNBOOK.md`;
- SDK ABI, cursor, simulation, and calldata surfaces under `sdk/src/` that
  describe or construct calls for the scoped contracts;
- first-party observatory and console files under `web/`, including the V3,
  operator, portfolio, and Horizon 1 read-only views.

The runtime review must preserve the offline/read-only defaults and check plan
approval binding, signer admission, nonce and fee policy, durable raw-transaction
journals, same-byte recovery, canonical confirmation, reorg handling, process
locks, path confinement, configuration commitments, and systemd credential and
filesystem boundaries.

## Toolchain and pinned dependencies

The reviewed local baseline uses:

| Component | Version or revision |
| --- | --- |
| Node.js | `24.15.0` |
| npm | `11.12.1` |
| Foundry Forge | `1.7.1` (`4072e48705af9d93e3c0f6e29e93b5e9a40caed8`) |
| Solidity | `0.8.30`, optimizer 200 runs, IR pipeline, Shanghai EVM |
| forge-std | `v1.16.2` at `bf647bd6046f2f7da30d0c2bf435e5c76a780c1b` |
| `@gluwa/usc-contracts` | `0.2.0` |
| `@gluwa/usc-sdk` | `0.18.0` resolved by the root lockfile |
| `@openzeppelin/contracts` | `5.4.0` resolved by the root lockfile |
| `ethers` | `6.17.0` in the root and SDK lockfiles |
| `dotenv` | `17.4.2` resolved by the root lockfile |
| TypeScript | `7.0.2` |

`package-lock.json`, `sdk/package-lock.json`, `foundry.lock`, `.gitmodules`, and
the `lib/forge-std` gitlink are part of the reproducibility boundary. Do not
substitute later dependency versions without creating a new reviewed commit.

Third-party implementations under `node_modules/`, including OpenZeppelin and
USC contracts, are not first-party source, but their exact imported code,
constructor and ABI assumptions, and Recourse integration remain in review
scope. The vendored `web/ethers.umd.min.js` distribution is treated the same
way. The dedicated USC `Inbox020` artifact is reproducibly compiled from the
pinned `@gluwa/usc-contracts` 0.2.0 source with that package's exact nested
OpenZeppelin dependency by `npm run build:usc-contracts-020`. The checked-in
route fields remain explicit placeholders, so no live USC route is part of this
release candidate. Supplying route evidence creates a new review scope and
commit.

## Privileged roles and trust boundaries

| Role or dependency | Authority or assumption requiring review |
| --- | --- |
| Kernel owner | One-time Proof Jobs binding; compromise before binding changes the authorized submission venue. |
| Facility lender | Policy registration/configuration, facility creation and funding, retry authorization, and default-loss settlement. |
| Borrower | Bonding, activation consent, draw requests, and repayment within facility rules. |
| Factory or receiver guardian | Pauses new facility creation or pre-authorizes one exact destination remedy. |
| Portfolio manager | Freezes mandate, investor, facility, service-venue, and remedy bindings before activation; allocates and services the fixed vintage. |
| Policy evaluator | Records adverse intents and, once lender-authorized, may replace its latest failed or expired intent. |
| Operator and sponsor | Escrow quote, job, proof, submission, and delivery economics; neither may override the configured verifier. |
| Native query verifier and proof builder | Must bind the claimed source transaction, receipt, transaction index, and continuity evidence. |
| USC Outbox, Inbox, validators, attestors, and route owners | Supply message authenticity and acknowledgement guarantees outside Recourse. |
| Destination target | Must implement only the intended bounded action and preserve its own authorization and idempotency rules. |
| ERC-20 assets | Assumed to be standard, non-rebasing, non-fee-on-transfer tokens unless an integration proves otherwise. |
| RPC providers | Untrusted observations constrained by chain-identity, canonical-block, confirmation, and reorg checks. |
| Registry issuers and artifact publishers | Make attributed declarations; registry presence is not an audit verdict. |

Legal enforceability, custody, production asset selection, counterparty identity,
route governance, source-chain support, and economic viability are external
pilot gates, not properties established by the contracts.

## Required adversarial review

At minimum, test and reason about:

- every role transition and immutable binding, including separated-role and
  wrong-runtime deployments;
- replay domains, source ordering, duplicate evidence, batch behavior, and
  later-weak versus earlier-severe evidence ordering;
- asset conservation, pull-claim solvency, rounding, default loss, late
  recovery, service escrow, and malicious or unusual token behavior;
- reentrancy at token, verifier, transport, receiver, target, and claim
  boundaries;
- remedy retry, acknowledgement, expiry, replacement, delayed delivery, and
  stable-execution idempotency, including adapter outages;
- stale, forged, malformed, reverted, or reorged source evidence and saturation
  at numeric bounds;
- portfolio mandate substitution, post-check state changes, deadline edges,
  incomplete allocations, and post-finalization servicing;
- public versus intended-sponsor market quotes, self-sponsorship, exact
  acceptance and service-deadline boundaries, verifier-context substitution,
  and unsolicited token surplus;
- transaction substitution, signer or nonce drift, fee escalation, partial
  execution, approval expiry, journal corruption, concurrent processes, and
  crash recovery;
- mismatches among reviewed source, compiler output, pinned artifacts, planned
  creations, deployed runtime around immutables, activation manifests, and
  operator configuration;
- rooted-path prerequisite escapes, wrong portfolio asset runtime, and assets
  pre-sent to predicted portfolio-pool addresses.

An internal review found and remediated an expiry-boundary race in
`RemedyCoordinatorV1`: an observable acknowledgement now wins atomically when a
published intent is timed out at expiry, while an unavailable acknowledgement
adapter does not block permissionless expiry. Re-test both branches through
`test_availableAcknowledgementWinsAtPublishedExpiry` and
`test_publishedExpiryDoesNotDependOnAcknowledgementAdapterAvailability`. This
internal remediation is not an independent audit result.

The extension deployment review also found and remediated approval-window
mutability: approval now commits the complete issued-at and expiry envelope in
addition to the plan, qualification, prerequisites, and fees. Re-test shifted
approval windows and canonical-anchor changes through the focused extension
deployment suite. This remains internal review evidence, not an independent
audit result.

## Reproduction

Use a fresh checkout of the exact review revision:

```text
git submodule update --init --recursive
npm ci
npm --prefix sdk ci
npm run build:usc-contracts-020
forge build --force
npm test
forge lint contracts/v3 contracts/v2 --severity high med
forge build --sizes
npm audit --audit-level=low
npm --prefix sdk audit --audit-level=low
npm --prefix sdk run pack:check
git diff --check
```

The release baseline is 375 Forge tests, 215 root Node tests (214 passes and one
Windows symlink-permission skip), and 39 SDK tests followed by strict declaration
type-checking. Each of eight invariant properties completes 256 runs totaling
128,000 calls, with zero handler reverts. A different count, unexpected skip,
stale artifact pin, dirty submodule, or warning promoted to the selected
high/medium lint threshold must be investigated.

The dependency audits currently report zero known vulnerabilities. The
[September 2026 internal security review](SECURITY-REVIEW-2026-09.md) used
Slither 0.11.5, but that internal work is not an independent Slither-pass claim.
An independent reviewer should use additional static, symbolic, and manual
techniques appropriate to the scope rather than treating the repository test
suite or internal review as an audit substitute.

## Deployment and product exclusions

The historical `deployments-v3.json` core is inactive, empty, and incompatible
with the current hardened activation checks. It is not an activation target.
The scoped current V3 core, USC route, operator market, and portfolio pool have
not been deployed, activated, funded, or opened. No audit activity authorizes a
broadcast, signer installation, production deployment, capital movement, or
pilot launch.

## Required audit evidence

To satisfy the independent-audit readiness gate, the evidence package must
contain a final report that records:

1. the named independent auditor or firm and report date;
2. the exact full Git commit and explicit included/excluded file scope;
3. methodology, tool versions, trust assumptions, and deployment model;
4. every finding with severity and disposition;
5. the remediation commit and retest result for each resolved finding;
6. every accepted risk or unresolved finding and its accountable owner;
7. the final report artifact reference and SHA-256 digest.

The report and remediation evidence must be entered into a private pilot
readiness file. Run:

```text
npm run pilot:readiness -- --config <path> --require-evidence-package
```

The command verifies file/digest presence, exact `HEAD`, and a clean deployable
and dependency scope. It cannot verify the auditor's identity, the truth of the
report, or legal authorization; accountable security, legal, operations,
lender, and borrower approvals remain mandatory.
