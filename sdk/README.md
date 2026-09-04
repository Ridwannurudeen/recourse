# Recourse SDK

Typed, read-only-first tooling for Recourse Horizon 1 and V3. The package
exports the read, call, and event ABI fragments used by the SDK for the Horizon
1 core plus the current V3 kernel, capped factory, multi-chain policy,
registry, and proof-job source surfaces. It also exposes the repository-local
`RecourseFacilityV3`, operator-market, portfolio-mandate, and
`PortfolioPoolV1` interfaces without treating their presence in source as
deployment evidence. Provider-backed aggregate reads, exact
Solidity-compatible encoders, conservative simulations, versioned policy
package validation, and dry-run calldata construction share one signer-free
entry point.

Registry catalog, detailed release, and audit-scope reads are explicitly
page-bounded (maximum 100 entries per collection per call). Continuation cursors
carry the pinned block number and hash; a page fails if that anchor changed.
Facility policy discovery requires a known deployment `fromBlock`, scans at
most `maxPages`, and returns a cursor containing the original range start and
next block. `historyComplete` applies only to that explicit original range, so a
tail scan cannot claim genesis coverage. None of these APIs silently walks an
unbounded collection or chain history.

V3 factory and operator-market catalogs are capped at 100 entries per read and
continue only against their original block hash. Policy-registration reads
accept at most 32 explicit chain keys; they do not infer or scan chain history.
Portfolio-pool reads page created facilities, registered candidates, and
investors together, with independent cursor positions tied to the same block
hash. Candidate pages include recorded principal, recoveries, and realized
loss; investor pages include shares, claimable assets, and claimed assets.
Multi-chain helpers validate the exact Solidity tuple, reject overlapping rules
and non-canonical bytes, and simulate saturating risk accumulation across every
matched rule. Registration reads expose the policy's frozen source-ordering
mode; the current cumulative multi-chain policy is replay-protected
`UniqueOnly`, while legacy and closed-loop policies remain strictly increasing.
Pilot creation, default-loss, full-pool allocation, and
largest-remainder distribution helpers mirror deterministic contract gates and
accounting without claiming that a transaction will be mined.

EventHistory helpers decode the exact Solidity tuple, re-run manifest
validation, reject non-canonical encodings by exact decode/re-encode byte
comparison, and can require the encoded bytes to match an expected on-chain
configuration hash. Registry calldata aggregation remains dry-run only and
preserves ordered call arrays without accepting a signer.

`recourse-protocol-sdk` is not published to npm. Do not run `npm install recourse-protocol-sdk`;
that name is unclaimed, so it would resolve to a package this project does not
control. Install it from a clone of this repository instead, pointing at the
`sdk` directory:

```sh
git clone https://github.com/Ridwannurudeen/recourse.git
npm install ./recourse/sdk
```

```js
import {
  buildPortfolioPoolCalldata,
  buildV3Calldata,
  encodeEventHistoryManifest,
  hashEventHistoryManifest,
  readCappedPilotFactory,
  readFacility,
  readOperatorMarket,
  readPortfolioPool,
  simulateFacilityPolicyState,
  simulateMultiChainRisk,
  simulatePortfolioPoolDistribution,
} from "recourse-protocol-sdk";
```

All transaction helpers return calldata only. The SDK has no signer, private-key,
broadcast, deployment, or submission path.

Each aggregate read anchors one block hash before its calls, pins every call to
that numbered block, rechecks the hash before returning, and returns the number
as `blockTag`. Dynamic `latest`, `safe`, and `finalized` tags are resolved once;
`pending` is rejected because it cannot identify a pinned block snapshot.

The `recourse-policy-package` schema is an off-chain artifact format. It uses
schema version `1` and a separate exact release string. Packages
bind implementation code hashes, supported evidence kinds, action adapters,
audit reports, and deployment history. An audit entry is accepted only when its
declared auditor address, release, chain, deployment, and runtime code hash
identify an exact deployment in the same package. Package validation does not
authenticate the publisher. Presence of an artifact is metadata, not an
authoritative audit verdict.

`PolicyRegistryV1` types, reads, and calldata builders represent on-chain issuer
declarations, including an issuer-declared build-artifact hash. They are
deliberately named separately from the off-chain package schema, and the SDK
does not infer, translate, or claim equivalence between the two formats.

Deployment labels remain an application concern backed by a deployment
manifest plus runtime-code and anchored-state checks. The checked-in
`deployments-v3.json` is a historical inactive deployment: its capped factory
is empty, but its kernel and multi-chain policy predate the hardened
source-ordering ABI and policy-set commitment. Current V3 readers and activation
tooling must use a fresh, fully qualified deployment manifest and must not treat
the historical addresses as compatible with the exported V3 interfaces. There
is no live pilot facility. `OperatorMarketV1`, `PortfolioMandateV1`, and
`PortfolioPoolV1` exports describe source-level capabilities only unless a
separate verified deployment establishes live state. The pool API covers its
configuring, funding, active, finalized, and cancelled lifecycle, but the
repository contains no verified pool address or live pool capital. Market
activity, operator reputation, portfolio capital, TVL, yield, or allocation is
never inferred from an ABI.

Run `npm test` for runtime parity tests and strict declaration checks. Run
`npm run pack:check` to inspect the deterministic publish file set without
publishing anything.
