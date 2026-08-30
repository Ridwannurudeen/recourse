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

The factory deploys `RecourseFacilityV3`. After a maturity default, its
permissionless loss settlement applies the posted bond to remaining debt,
credits only excess to the borrower, and cannot distribute the bond twice. The
facility retains the V2 draw, repayment, policy, and withdrawal behavior.

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
- an uninstalled systemd service template and an operational runbook.

No pilot has run. A design partner, independent audit of the exact commit, legal
review, pilot budget, production asset/custody decision, testnet rehearsal,
production watcher, and accountable human approvals remain external gates.

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
call fails. A transport cannot authorize a new target or action.

This is not a live USC integration. The installed USC packages do not expose an
authoritative dispatcher implementation, deployed dispatcher address, or final
wire format for the required route. No dispatcher or Inbox address is guessed.

## 6. Closed-loop servicing

`ClosedLoopPolicyV1` links a verified adverse event to a remedy intent, and only
accepts a cure after acknowledgement of an exact action-data commitment.
`RemedyCoordinatorV1` tracks recorded, published, acknowledged, cured, expired,
and failed states. Publication attempts are bounded, message IDs cannot be
reused, prior attempts remain acknowledgement-recoverable, and permissionless
timeouts prevent a dropped delivery from blocking the policy forever. A new
adverse intent is allowed only after the previous intent reaches a terminal
state.

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
- a local `PortfolioMandateV1` eligibility simulator matching the Solidity gate.

The SDK remains unpublished and its interfaces are not frozen. External
integration and an independent audit remain open milestones.

## 8. Multi-chain portfolio policy

`MultiChainEventPolicyV1` evaluates a bounded set of strict EVM log rules keyed
by configured source-chain identifiers. It maintains a saturating cumulative
risk score and applies the most conservative configured effect tier. A source
transaction matching several rules accumulates every match deterministically;
bundling monitored actions cannot make the evidence unprocessable.

This is a multi-chain-capable policy engine, not proof that new source chains are
available. A configured chain is usable only when the native verifier actually
supports it. The implementation proves event history, not balances, storage,
prices, ownership, or complete portfolio value.

## 9. Open operator market

`OperatorMarketV1` supports four independently priced services: monitoring,
proof construction, submission, and delivery. An operator escrows a bond when
posting a quote; a sponsor escrows the price on acceptance. Settlement is
permissionless but succeeds only when the configured verifier validates the
agreement-bound delivery evidence. Cancellation, expiry, refunds, and pull-based
withdrawals preserve exact escrow solvency.

The operator daemon is a reference service implementation, not evidence of an
open market. There are no live quotes, operators, customers, reputation system,
or profitability claims.

## 10. Programmable credit portfolios

`PortfolioMandateV1` is a read-only eligibility gate. It checks exact factory
provenance, asset, kernel, facility status, maximum notional, minimum bond,
maximum draw fee, remaining maturity, policy-set commitment, release,
deployment binding, evidence kind, and action-adapter declaration. It does not
custody or allocate capital.

The portfolio observatory groups facilities only when chain, asset address, and
decimals agree. Its anchors are explicit single-endpoint assertions and are not
sufficient on their own for a value-moving decision. A capital pool remains
blocked on live servicing history, lender demand, audited loss accounting,
valuation inputs, custody, and legal structure.

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
