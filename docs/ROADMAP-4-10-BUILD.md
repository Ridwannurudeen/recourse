# Roadmap items 4–10: implemented scope and remaining gates

This document records what the repository implements for roadmap items 4–10.
It is an engineering inventory, not a production-readiness, audit, customer,
deployment, or investment claim. Every component below is source-only unless an
existing deployment record says otherwise.

## 4. Capped pilot

`CappedPilotFactoryV1` fixes the asset, kernel, lender, borrower, guardian, and
all aggregate limits at deployment. Only the lender can consume a facility slot;
the guardian can stop new creation. Each facility is bounded by per-facility and
aggregate notional, minimum bond, maximum draw fee, maturity, draw delay, and
facility count.

The factory deploys `RecourseFacilityV3`. After a maturity default, its one-time
lender-controlled loss settlement applies the posted bond to remaining debt,
credits only excess to the borrower, and cannot distribute the bond twice. This
keeps a pooled lender's recovery delay authoritative. The facility retains the
V2 draw, repayment, policy, and withdrawal behavior.

The pilot package also contains:

- a fail-closed readiness evaluator and deliberately incomplete example;
- a read-only-by-default operator with exact facility, policy, asset, and source
  chain allowlists;
- crash-safe, intended-call-bound execution journals reconciled before source
  discovery, process locking, canonical source cursors, confirmation-depth
  checks, recovery incidents, and operator health output;
- canonical transaction/receipt, ChainInfo attestation, native transaction-index,
  native proof, and full-kernel preflight checks before a new commitment;
- adaptive source-range splitting with hard log, candidate, and retained-history
  caps and durable progress only through processed subranges;
- an offline-by-default activation planner that commits the exact core manifest,
  artifacts, roles, facility, policy, registry release, proof job, funding, and
  transaction policy before any signer is admitted;
- a systemd service template and an operational runbook. A Horizon 1 read-only
  instance is installed and healthy; the V3 configuration and executable path
  are not installed or enabled.

No pilot has run. A design partner, independent audit of the exact commit, legal
review, pilot budget, production asset/custody decision, testnet rehearsal,
production watcher, and accountable human approvals remain external gates.

The six-contract CC3 V3 core recorded in `deployments-v3.json` is a historical,
inactive deployment with exactly zero facilities, zero configured policies, zero
registry claims, and zero asset transfers. Its kernel and multi-chain policy
predate the current frozen source-ordering mode and policy-set commitment. The
current activation tooling rejects that bytecode, so the full six-contract core
must be redeployed from the reviewed current commit before any activation.

The V3 core deployment command is `npm run deploy:v3`. Its default mode is
offline: `npm run deploy:v3 -- --manifest deployments-v3-current.json` reads no
RPC or signer, writes no file, and broadcasts nothing. `--live-check` adds
signerless qualification of chain 102031, the exact native verifier, separated
roles, asset bytecode and decimals, declared balances and allowances, pilot
bounds, the deployer identity and nonce, clean deployable source at the exact
commit, and all six pinned artifacts. `--live-check --write-plan <new-path>`
writes the exact fee-capped plan for separate human review and approval.

The plan contains exactly six transactions: creations of `PolicyKernelV2`,
`PolicyRegistryV1`, `CappedPilotFactoryV1`, `MultiChainEventPolicyV1`, and
`ProofJobsV1`, followed by the one-time `PolicyKernelV2.setProofJobs` call. Its
sixth pinned artifact is the constructor-created `VerifiedCreditStateV1`. The
plan binds every predicted address, nonce, calldata, value, fee field, live
anchor, source commit, and artifact hash and expires 30 minutes after its chain
timestamp.

Broadcast requires the same manifest plus
`--live-check --broadcast --approved-plan <exact-path>`; there is no unapproved
broadcast path. The signer is admitted only after the exact plan is validated,
and live state is requalified before each first signing or broadcast. Every raw
signed transaction is durably persisted first in the manifest-specific
`.v3-deployment-journal.json`. Recovery checks the recorded transaction before
any send, may rebroadcast only the same raw bytes, treats nonce replacement as
an incident, and advances only after confirmation depth and canonical
transaction, receipt, and block checks. If approval expires during partial
progress, a new human-approved plan must be bound to the journal's exact
checkpoint and remaining steps.

After all six transactions qualify, the tool compares deployed runtime around
compiler immutables for all six pinned artifacts, including
`VerifiedCreditStateV1`, and atomically writes an evidence-complete manifest
binding the reviewed source, configuration, artifacts, constructors, approved
execution plan, canonical transactions, runtime hashes, and verification block.
The deployment does not create or activate a facility, configure a policy,
publish a registry claim, transfer an asset, or enable a transport or operator
market. The historical manifest is never overwritten, and the deployment
journal must not be deleted to force a new nonce.

The separate activation command is `npm run activate:v3`. Its default mode is
offline and produces a deterministic, human-reviewable plan without reading an
RPC or loading a signer. Live checks use signerless providers and revalidate the
core code, immutable wiring, activation counts, roles, balances, allowances,
source networks, fee ceilings, and artifact commitments. Broadcasting additionally
requires the exact approved plan and revalidates each guarded step before signing.
Copy the checked-in activation config, bind `coreManifest.path` to the fresh
manifest and `coreManifest.sha256` to its exact lowercase SHA-256, then pass the
same file with `--core-manifest deployments-v3-current.json`. The historical
manifest must never be overwritten or substituted after review. The exact
handoff and approval commands are in `ops/README.md`.

The checked-in guardian is the existing Horizon 1 hunter wallet only as a
testnet candidate. Its owner has not accepted the immutable guardian duty, so
the dry-run result is not authorization to use `--broadcast`. Confirm that role
with the accountable owner, or replace it with an approved guardian, before any
transaction is sent.

## 5. Cross-chain remedy adapters

The repository defines a transport-neutral remedy boundary:

- `RemedyCoordinatorV1` records policy-bound intents and publishes bounded
  payloads;
- `BoundedRemedyReceiverV1` requires an exact pre-authorization over source
  chain, coordinator, intent, target, action kind, action-data hash, and expiry;
- `IRemedyTransportV1` isolates delivery and acknowledgement semantics;
- `IRemedyTargetV1` limits execution to an integrated target contract.

Replay protection is scoped to the full intent domain. The receiver consumes an
authorization before the external target call and rolls the state back if the
call fails. Fresh adverse evidence always starts a fresh execution domain. Only
the lender-authorized policy evaluator can explicitly replace the latest failed
or expired intent from the same adverse episode; that replacement preserves the
predecessor, adverse evidence, route, action commitment, and stable execution ID.
The receiver stores
the first nonzero execution result and returns it for an exact replacement
without calling the target twice. On both first execution and reuse it emits one
canonical confirmation binding the target, current intent, stable execution ID,
result, and action-data hash. A transport cannot authorize a new target or
action.

`UscRemedyTransportV1` and `UscRemedyDispatcherV1` implement one immutable route
against the pinned USC contracts 0.2.0 surface. The source adapter binds the
coordinator, Outbox, ATTEST token, destination key, receiver, and maximum core
fee. The destination dispatcher binds the Inbox callback, Creditcoin source
chain, source adapter, coordinator, and receiver. Both ends apply replay checks,
and a destination failure rolls the dispatcher mark back so the Inbox can retry.

`npm run deploy:usc-remedy` is offline by default. It validates the pinned USC
artifacts and constructor shapes and precomputes five nonce-bound creations: the
source coordinator and transport, then the destination receiver, dispatcher,
and dedicated Inbox. The Inbox is created last and constructor-bound to the
already deployed Recourse dispatcher; the tool never replaces a shared Inbox
dispatcher. Its guarded live path requires exact chain, bytecode, owner,
validator, attestor-registry, fee, rate-limit, pause, nonce, transaction-fee,
and address evidence; signed transactions are bound to the approved intent and
persisted before broadcast for crash recovery. The source acknowledgement
validator must already trust the predicted dedicated Inbox, which remains an
external route-authority action.

This is not a live USC integration. No authoritative Outbox/Inbox route or
deployment authority is checked in, the example contains deliberate placeholders,
and no address is guessed. The official writability documentation still describes
the capability as undergoing testing and audits.

## 6. Closed-loop servicing

`ClosedLoopPolicyV1` links a verified adverse event to a remedy intent, and only
accepts a cure after acknowledgement and a verified canonical receiver event
that binds the current intent, its stable execution ID, target, and action-data
commitment. An older intent's event cannot cure a new adverse episode.
`RemedyCoordinatorV1` tracks recorded, published, acknowledged, cured, expired,
and failed states. Publication attempts are bounded, message IDs cannot be
reused, prior attempts remain acknowledgement-recoverable, and permissionless
timeouts prevent a dropped delivery from blocking the policy forever. A new
adverse intent is allowed only after the previous intent reaches a terminal
state and always receives a fresh execution domain; lender-authorized explicit
replacement is the only path that preserves an earlier domain.

These state transitions prove contract-level coordination only. Economic
completion still depends on the destination target and the transport's real
authentication and acknowledgement guarantees.

## 7. SDK and policy registry

`PolicyRegistryV1` exposes bounded enumeration for releases while retaining its
issuer-declaration trust model. Audit artifacts remain publisher-attributed and
exactly release- or deployment-scoped; registry presence is never an audit
verdict.

The plain-ESM SDK adds:

- block-number and block-hash-bound continuation cursors for registry,
  deployment, audit, and facility-policy history;
- bounded collection hydration with explicit continuation metadata;
- canonical manifest decoding that rejects trailing ABI bytes;
- exact calldata aggregation without a signer or broadcast path;
- V3 core, Proof Jobs, multi-chain policy, and portfolio-pool bindings and reads;
- capped-pilot, policy-risk, default-loss, and portfolio allocation simulations;
- a local `PortfolioMandateV1` eligibility simulator matching the Solidity gate.

The historical V3 registry deployment is empty and belongs to the superseded
core. Current aggregate V3 readers require a fresh compatible full-core
manifest. The SDK remains unpublished and its interfaces are not frozen.
External integration and an independent audit remain open milestones.

## 8. Multi-chain portfolio policy

`MultiChainEventPolicyV1` evaluates a bounded set of strict EVM log rules keyed
by configured source-chain identifiers. It maintains a saturating cumulative
risk score and applies the most conservative configured effect tier. A source
transaction matching several rules accumulates every match deterministically;
bundling monitored actions cannot make the evidence unprocessable.

`PolicyKernelV2` freezes an evaluator's source-ordering mode at registration and
binds it into the policy-set commitment. Legacy and closed-loop evaluators are
strictly increasing. The cumulative multi-chain evaluator is replay-protected
but accepts every unique transaction even when an operator first receives a
later source position; its telemetry cursor advances but never regresses. The
strictly ordered batch path rejects that `UniqueOnly` mode, and the operator
mirrors the frozen mode when filtering candidates.

This is a multi-chain-capable policy engine, not proof that new source chains are
available. A configured chain is usable only when the native verifier actually
supports it. The implementation proves event history, not balances, storage,
prices, ownership, or complete portfolio value. The activation and operator
tooling recognize only the currently documented CC3 mappings: source key 1 is
Ethereum Sepolia chain ID 11155111 and source key 3 is Ethereum mainnet chain ID
`1`. Unknown keys and mismatched RPC identities fail closed.

## 9. Open operator market

`OperatorMarketV1` supports four independently priced services: monitoring,
proof construction, submission, and delivery. An operator escrows a bond when
posting a quote; a sponsor escrows the price on acceptance. Settlement is
permissionless but succeeds only when the configured verifier validates the
agreement-bound delivery evidence. Cancellation, expiry, refunds, and pull-based
withdrawals preserve exact escrow solvency.

The operator daemon is a reference service implementation, not evidence of an
open market. A Horizon 1 instance is installed and healthy in read-only mode;
the V3 executable configuration and signer are not installed. There are no live
market quotes, paid operators, customers, reputation system, or profitability
claims.

## 10. Programmable credit portfolios

`PortfolioMandateV1` is an eligibility gate. It checks exact factory
provenance, asset, kernel, facility status, maximum notional, minimum bond,
maximum draw fee, remaining maturity, policy-set commitment, release,
deployment binding, evidence kind, and action-adapter declaration.

`PortfolioPoolV1` is a fixed-vintage, single-asset pool. It freezes a bounded
investor allowlist before activation, creates facilities through its exact
factory, rechecks the complete mandate, requires the full borrower bond, and
allocates one complete facility limit atomically before the funding deadline.
It uses pull withdrawals and claims, permissionless cash-only finalization after
the deadline, lender-only facility loss settlement after maturity plus the pool's
recovery delay, late-recovery redistribution, and largest-remainder distribution
so no finalized asset unit is stranded. Proof Jobs spending is limited to the exact
facility, asset, policy, kernel, venue, gross service cap, and job duration.
Remedy-capable allocations freeze the exact evaluator and coordinator before
funding; only the manager can forward a publish retry or policy-authorized
replacement, and that bounded servicing path remains available after pool
finalization so economic closeout cannot strand an outstanding remedy.

The pool and its observatory are source-only. It is not deployed, capitalized,
audited, evergreen, or evidence of lender demand. Shares lock after activation;
valuation inputs, custody, legal structure, and real servicing history remain
external gates before capital use.

## Deployment order and trust boundaries

The safe dependency order is:

1. deploy and independently review the exact facility, kernel, policies, and
   registry scope;
2. configure policies and verify their public manifests before borrower
   activation;
3. deploy remedy targets and receivers with narrow authorizations before any
   transport is enabled;
4. qualify the operator in read-only mode, then rehearse recovery and finality
   handling on testnet;
5. enable transaction execution only after the readiness evidence and human
   approvals are complete;
6. introduce real assets or capital only after the external pilot gates pass.

The native query verifier, remedy transport, destination target, service
verifier, RPC providers, token behavior, registry issuers, artifact publishers,
operators, and legal/custody arrangements are independent trust boundaries.
None is made trustworthy merely by being referenced on-chain.
