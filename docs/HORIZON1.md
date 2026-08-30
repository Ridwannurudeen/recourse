# Horizon 1 technical generation

Horizon 1 is a new contract generation deployed alongside the frozen Recourse demonstration. It does not modify the five contracts used by facilities 1 and 2, `deployments.json`, or either generation's execution path. Its console and discovery report are additive, read-only surfaces; the original wallet application and hunter daemon remain intact.

This is technical testnet scaffolding. It is not a pilot, production stablecoin facility, independent audit, legal review, or design-partner deployment.

## Live CC3 deployment

| Component | Address |
| --- | --- |
| Policy Kernel v1 | [`0x5cE48b776CBFa04Bf3f375809d16B33B3d413Dbb`](https://creditcoin-testnet.blockscout.com/address/0x5cE48b776CBFa04Bf3f375809d16B33B3d413Dbb) |
| Verified Credit State | [`0x574916dc2D41b2Ac57FF77c4bc47e91D26550AE4`](https://creditcoin-testnet.blockscout.com/address/0x574916dc2D41b2Ac57FF77c4bc47e91D26550AE4) |
| Facility factory | [`0x04719DA84B91AC2Cb2bf9ad770F412989DF61fbd`](https://creditcoin-testnet.blockscout.com/address/0x04719DA84B91AC2Cb2bf9ad770F412989DF61fbd) |
| Event-history policy | [`0xcB6cc391E524966438a6B1f9ac411e7d2e500cA5`](https://creditcoin-testnet.blockscout.com/address/0xcB6cc391E524966438a6B1f9ac411e7d2e500cA5) |
| Permissionless proof jobs | [`0xdA28730f8BCd7dAd54Fe3c77D01aacC41E8DeB4b`](https://creditcoin-testnet.blockscout.com/address/0xdA28730f8BCd7dAd54Fe3c77D01aacC41E8DeB4b) |
| Demonstration facility | [`0xF1E51D2d648E7FeA60fE4B2C739f7591426d14FA`](https://creditcoin-testnet.blockscout.com/address/0xF1E51D2d648E7FeA60fE4B2C739f7591426d14FA) |
| Fixed-supply demo rUSD | [`0x3c6eF93E1d2C539c5EFefbBc51cc6a1E120fBf77`](https://creditcoin-testnet.blockscout.com/address/0x3c6eF93E1d2C539c5EFefbBc51cc6a1E120fBf77) |

The demonstration facility is Active with a 100,000 rUSD limit, 20,000 rUSD bond, 40,000 rUSD drawn principal, 40,800 rUSD debt, and 60,000 rUSD available credit. Proof job 1 is funded. rUSD is a six-decimal fixed-supply testnet token, not a stablecoin with reserves, redemption, or production value.

The machine-readable record is [`deployments-horizon1.json`](../deployments-horizon1.json). Its recorded SHA-256 digest of the legacy `deployments.json` remained unchanged throughout deployment.

## Policy Kernel v1

Each policy is configured once and registered before activation. Registration appends the policy ID, evaluator identity, and configuration hash to an ordered commitment. The borrower activates only against the exact final commitment. The kernel stores the full ABI-encoded manifest, and the evaluator exposes the typed configuration, so configuration is recoverable rather than hash-only.

Outcomes are `Eligible`, `Watch`, `Restricted`, `MarginCalled`, `Breached`, and `Cured`. Effects can reduce credit, freeze a pending draw, require fresh evidence, increase fees for future draws, or terminate. Effects are stored per policy and combined conservatively: the lowest credit limit, highest future fee, strictest outcome, any freshness requirement, and earliest nonzero expiry win. A cure updates only its own policy and cannot relax another policy's restriction.

The kernel verifies inclusion before receipt interpretation, separately requires successful receipt status, scopes replay keys by facility and policy, consumes them only after successful evaluation, and requires source positions to advance monotonically. Evaluation paths are reentrancy-guarded. Once Proof Jobs is installed, evidence must enter through that market, preventing a direct submission from front-running a committed reveal.

## Verified Credit State

Each accepted observation records its evidence and observation kind, source chain, source block, proof-derived transaction index, borrower subject, canonical emitter, raw event-reported value, CC3 proof-acceptance time, expiry, evidence digest, and policy-effect hash. History is ordered per facility and borrower, with latest-by-kind and freshness queries.

The installed Attestcoin surface proves included transactions and their encoded receipts. It exposes transaction fields, receipt status, and logs. It does **not** expose account proofs, storage proofs, balance snapshots, `eth_call` results, or a proven source-block timestamp. Therefore:

- Horizon 1 records proven event deltas and transitions, not a verified current balance;
- the event-history evaluator cannot produce `Eligible` or `Cured`, because an old favorable event cannot safely reopen credit;
- `proofTime` means CC3 acceptance time, not source-chain event time;
- raw amounts are not asset valuations; valuation remains an external input.

Reconstructing current state would require a protocol-specific adapter proving complete history from a known baseline and accounting for every state-changing path, upgrade, rebase, and accrual rule. Horizon 1 does not claim that capability.

## Permissionless Proof Jobs

A lender can publish a job only for its Active facility, exact denomination token, registered policy ID, and committed configuration digest. Escrow covers a fixed maximum reimbursement for each accepted proof plus an outcome reward. This is a declared budget, not an on-chain measurement of actual cost.

Hunters commit `keccak256(job ID, hunter, evidence digest, salt)` and post a bond. The digest is reserved to the first hunter for that job, while the proof remains unrevealed until a later block. Successful proofs return the bond and add reimbursement to a pull claim; the outcome reward is added only when the kernel's severity threshold is met.

Non-reveal bonds become slashable after the deadline. Invalid or irrelevant proofs revert without consuming the commitment. A valid proof already processed elsewhere returns the hunter bond without reimbursement, reward, attempt consumption, or sponsor capture. Unused escrow returns to the sponsor through a pull claim.

## ERC-20 facility and incident authority

`RecourseFacilityV2` uses exact-balance `SafeERC20` pulls and rejects fee-on-transfer or rebasing behavior. Transfers follow checks-effects-interactions, and payouts use repeatable pull claims.

The lender and borrower have independent draw-pause flags. Neither can clear the other's pause. Pauses cancel pending draws but never block repayment or claims. The factory guardian can pause only new creation; it cannot alter policy, seize assets, stop repayment, or stop withdrawals.

## Local SDK, registry, dashboard, and discovery foundations

The local [`sdk/`](../sdk/README.md) package exposes typed reads for both Horizon 1 and `PolicyRegistryV1`, exact ABI encodings, calldata-only builders, event-policy manifest hashing, proof-job commitments, and conservative facility simulation. Its off-chain `recourse-policy-package` artifact is intentionally separate from the registry's on-chain issuer declarations.

`PolicyRegistryV1` is implemented and tested locally but is not deployed. A release binds an issuer namespace, issuer-declared build-artifact hash, reference runtime, declared evidence kinds, and metadata-only action-adapter specifications. The issuer can approve exact constructor-bound runtime variants and attest deployments whose facility, kernel, evaluator runtime, manifest, and configuration agree. Audit publishers attach their own identity to either an exact release snapshot or exact deployment snapshot; the registry never exposes a global "audited" flag.

Deployment history is issuer-attested, not factory-certified. The registry does not prove that a facility came from `RecourseFacilityFactoryV2` or that its kernel is a canonical Recourse build. Its v1 constructor check models the current kernel-only `EventHistoryPolicyV1` constructor. The correct description is issuer-attested, facility/kernel-consistent, evaluator-runtime/config-bound deployment records.

The additive [`web/horizon1.html`](../web/horizon1.html) console reads the live factory at one pinned block, filters facilities to the configured kernel and credit state, discovers registered policies from `PolicyRegistered` logs, and keeps an unapplied registration distinct from an accepted policy effect. It never requests a wallet or exposes a transaction path.

`daemon/job-discovery.mjs` is a signerless Proof Jobs catalog and metrics report. It scans only confirmed blocks, checks canonical block hashes, checkpoints cumulative metrics plus cached state and a bounded recent-event window in an atomic cursor, refreshes changed jobs in bounded batches, pins every hydrated job and policy read to the report block, and reports only observable coverage, completion, reveal, slash, release, and latency data. Partial history is marked incomplete and does not invent lifecycle denominators, invalid-proof rates, uptime, reputation, or economics.

## Reproduction and remaining gates

The additive deployment path is:

```bash
forge build
npm test
node scripts/deploy-horizon1.mjs
```

The script checks CC3, the verifier, role key/address pairs, bytecode, wiring, manifest recovery, commitment, ERC-20 accounting, the demonstration draw, job escrow, and the legacy deployment checksum. It writes only `deployments-horizon1.json`.

The first reference operator runs separately from the frozen facility-2 daemon:

```bash
npm run daemon:horizon1 -- <ethereum-transaction-hash> [job-id]
```

It accepts only a successful Ethereum transaction inside the job's committed source window, obtains the exact Attestcoin proof, commits a hunter-bound evidence digest and random salt, persists resumable state atomically, waits at least one CC3 block, and reveals. The operator validates the deployment, job, policy, configuration digest, source receipt, proof cardinality, proof transaction hash, attested height, live commitment, and reveal deadline. Its gitignored state file is `daemon/horizon1-state.json`. Evidence still has to satisfy the on-chain event policy; operators should submit genuine observed activity, not create activity to trigger a reward.

The read-only catalog requires only a CC3 RPC and writes its gitignored cursor locally:

```bash
CREDITCOIN_RPC_URL=https://rpc.cc3-testnet.creditcoin.network npm run operator:discover
```

Serve the zero-build consoles from the repository root and open `/web/horizon1.html`:

```bash
python -m http.server 8000
```

A real facility still requires a design partner, an independently audited exact contract version, legal review, production asset and custody decisions, operating budgets, incident runbooks, and agreed source-data semantics.
