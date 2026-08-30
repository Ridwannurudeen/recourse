# Recourse SDK

Typed, read-only-first tooling for Recourse Horizon 1. The package exports the
read, call, and event ABI fragments used by the SDK for seven Horizon 1
contracts plus the complete `PolicyRegistryV1` ABI, provider-backed
facility/factory/credit-state/proof-job and policy-registry reads, exact
Solidity-compatible encoders, conservative facility simulation, versioned
policy-package validation, and dry-run calldata construction.

Registry catalog, detailed release, and audit-scope reads are explicitly
page-bounded (maximum 100 entries per collection per call). Continuation cursors
carry the pinned block number and hash; a page fails if that anchor changed.
Facility policy discovery requires a known deployment `fromBlock`, scans at
most `maxPages`, and returns a cursor containing the original range start and
next block. `historyComplete` applies only to that explicit original range, so a
tail scan cannot claim genesis coverage. None of these APIs silently walks an
unbounded collection or chain history.

EventHistory helpers decode the exact Solidity tuple, re-run manifest
validation, reject non-canonical encodings by exact decode/re-encode byte
comparison, and can require the encoded bytes to match an expected on-chain
configuration hash. Registry calldata aggregation remains dry-run only and
preserves ordered call arrays without accepting a signer.

```js
import {
  encodeEventHistoryManifest,
  hashEventHistoryManifest,
  readFacility,
  simulateFacilityPolicyState,
} from "@recourse/sdk";
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

Run `npm test` for runtime parity tests and strict declaration checks. Run
`npm run pack:check` to inspect the deterministic publish file set without
publishing anything.
