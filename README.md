# Recourse

Recourse is an undercollateralized credit facility on Creditcoin where cryptographic proofs enforce covenants over a borrower's Ethereum conduct. A proven violation freezes undrawn credit, applies the borrower's penalty bond against debt, and pays the permissionless hunter who submitted the evidence.

The proof does not release an escrow. It changes credit risk.

## The problem

Traditional credit is governed by covenants: enforceable promises not to strip a treasury, take on new debt, or unwind a pledged position. DeFi replaced those controls with overcollateralization because one chain cannot see what a borrower does on another.

Attestcoin makes Ethereum conduct provable on Creditcoin. Recourse turns those proven facts into consequences held and executed by the credit facility itself.

## How it works

1. A lender funds a facility. The borrower posts a penalty bond, accepts named covenants, and draws credit.
2. Any hunter submits one or more Attestcoin proofs of relevant Ethereum transactions.
3. `AttestcoinAdjudicator` verifies inclusion and continuity through the BlockProver precompile, decodes the proven receipts on-chain, requires successful transaction status, and derives replay keys from transaction indices.
4. A covenant evaluates the proven logs. The hero `OutflowCapCovenant` aggregates qualifying USDC transfers; no single transfer crosses the cap, but their verified sum does.
5. On breach, the facility freezes undrawn capacity, applies up to 80% of the bond against outstanding debt, capped by that debt; the unused share returns to the borrower, and 20% rewards the hunter.

The live hero adjudication used five real Ethereum mainnet transfers in five distinct blocks across a 35-block span. The largest was 190.30 USDC, below the 232.545 USDC cap; together they totalled 274.79 USDC. See [the Attestcoin integration note](docs/attestcoin-integration.md) for the proof mechanics and evidence.

## Live deployment

CC3 Testnet, chain ID `102031`:

| Component              | Address                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Facility               | [`0x144048E22e822269814D592aeaC34734c603dCA7`](https://creditcoin-testnet.blockscout.com/address/0x144048E22e822269814D592aeaC34734c603dCA7) |
| Attestcoin adjudicator | [`0x6abB74F57c99986Ff205d4EF396Dd6d61d2659eB`](https://creditcoin-testnet.blockscout.com/address/0x6abB74F57c99986Ff205d4EF396Dd6d61d2659eB) |
| Outflow-cap covenant   | [`0x873C1344B850bB80c758E191D1DCA31CE86030Ef`](https://creditcoin-testnet.blockscout.com/address/0x873C1344B850bB80c758E191D1DCA31CE86030Ef) |
| New-borrow covenant    | [`0x5f1DCF18622663a046a55Ad86c61dd339E1e5dE4`](https://creditcoin-testnet.blockscout.com/address/0x5f1DCF18622663a046a55Ad86c61dd339E1e5dE4) |
| LP-lock covenant       | [`0x2826913E2917d905F7658AAa81288f3C4b98A53d`](https://creditcoin-testnet.blockscout.com/address/0x2826913E2917d905F7658AAa81288f3C4b98A53d) |
| Facility ID            | `1`                                                                                                                                          |
| Breach adjudication    | [`0x7c180209…7e5d5b6`](https://creditcoin-testnet.blockscout.com/tx/0x7c180209bedaa64b4e1acff02d2822e8c76b0db98f105b7b75e3b95ac7e5d5b6)      |
| Breach block           | `5,371,462`                                                                                                                                  |

The breach transaction succeeded, emitted seven events, and used 699,409 gas.

## Horizon 1 generation

The additive Horizon 1 generation is live on CC3 without changing the proven facilities above. It adds a committed graded Policy Kernel, event-derived Verified Credit State, permissionless commit/reveal Proof Jobs, an ERC-20 facility factory, fully recoverable public policy manifests, and bounded draw/creation circuit breakers.

The new demonstration facility is [`0xF1E51D2d648E7FeA60fE4B2C739f7591426d14FA`](https://creditcoin-testnet.blockscout.com/address/0xF1E51D2d648E7FeA60fE4B2C739f7591426d14FA). It is Active with 40,000 of 100,000 six-decimal demo rUSD drawn and proof job 1 funded. The demo token is fixed-supply testnet scaffolding, not a production stablecoin. See [the Horizon 1 technical note](docs/HORIZON1.md) and [`deployments-horizon1.json`](deployments-horizon1.json) for exact addresses, mechanics, limitations, and reproduction.

The additive [public Horizon 1 console](https://ridwan.gudman.xyz/recourse/horizon1.html), served from [`web/horizon1.html`](web/horizon1.html), reads the live factory, facility, kernel, credit state, and proof jobs at one pinned CC3 block. It shows registered policies separately from accepted policy effects and never requests a wallet or submits a transaction.

Roadmap work now also includes a typed [SDK](sdk/README.md), policy simulation and calldata builders, an issuer-attested `PolicyRegistryV1`, and a resumable operator discovery and metrics tool. The committed static console is publicly hosted; the SDK remains unpublished, the recorded V3 registry deployment is empty, and the Horizon 1 operator is installed only as a healthy read-only service. V3 execution is not installed or enabled. These foundations are tested but are not independently audited, frozen, or externally integrated. See [the external security audit handoff](docs/SECURITY-AUDIT-BRIEF.md) for the exact review scope and evidence requirements.

The repository now covers the buildable contract and tooling scope for roadmap items 4–10: a capped pilot factory and loss-settling facility, offline-first deployment and activation tooling, bounded remedy coordination, a pinned USC 0.2 transport and dispatcher, closed-loop acknowledgement/cure lifecycle, block-hash-paged registry SDK, multi-chain event-risk policy, escrowed operator-service market, hardened reference operator, and a fixed-vintage portfolio pool with exact allocation and loss accounting. See [the exact build inventory and remaining gates](docs/ROADMAP-4-10-BUILD.md). The inactive V3 core recorded in `deployments-v3.json` has zero facilities, policies, registry claims, or asset transfers, but it predates the current source-ordering interface and policy-set commitment. The activation tooling rejects that bytecode; the complete V3 core must be freshly redeployed from the reviewed current commit before activation. The USC route and portfolio pool are undeployed. None of the roadmap build is independently audited, externally integrated, customer-validated, or capitalized.

Fresh V3 deployment is offline by default. A signerless `--live-check` precedes
`--write-plan`; an accountable human must separately approve that exact plan,
and `--broadcast` requires its `--approved-plan` path before a signer is loaded.
The chain-time plan expires after 30 minutes and binds a clean exact source
commit, capped fees, six pinned artifacts, and six transactions: five creations
plus `setProofJobs`. A durable manifest-specific deployment journal persists each
raw signed transaction before broadcast, permits only same-byte recovery, and
requires confirmation-depth and canonical-chain checks. Final qualification
verifies exact runtime around immutables for all six artifacts, including
`VerifiedCreditStateV1`, before writing an evidence-complete manifest. See [the
operator handoff](ops/README.md#fresh-v3-core-manifest-handoff) for the exact
commands and renewal procedure.

Closed-loop policy, operator-market, and portfolio-core deployments use the
separate `npm run deploy:v3-extension` workflow. Its three checked-in example
configurations pin the reviewed local artifacts but deliberately leave route,
verifier, role, economics, nonce, fee, and prerequisite-manifest evidence
unauthorized. Each generation is planned independently from exact prerequisite
manifest hashes; live planning is signerless, approval expires after 30 minutes,
and raw signed transactions are journaled before broadcast. No extension has
been deployed. See [the extension handoff](ops/README.md#separate-v3-extension-manifests).

## Quickstart

The checked-in `deployments.json` points to the already-breached live facility. To reproduce the full demo with a fresh facility, use fresh development wallets and CC3 testnet funds. The release baseline uses Node.js 24.15.0, npm 11.12.1, and Foundry 1.7.1; ensure `forge` is on `PATH` before running the unified test command. The deployment and activation configurations pin the raw artifacts emitted by the forced build, and the Node suite rejects stale pins.

```bash
git submodule update --init --recursive
npm ci
npm --prefix sdk ci
forge build --force
npm test
npm run wallets:new
```

Create a local `.env` file, which is gitignored, with the generated role addresses and private keys plus:

```dotenv
CREDITCOIN_RPC_URL=https://rpc.cc3-testnet.creditcoin.network
PROOF_BUILDER_URL=https://prover.cc3-testnet.creditcoin.network
BLOCK_PROVER_PRECOMPILE=0x0000000000000000000000000000000000000FD2
ETH_MAINNET_RPC_URL=<ethereum-mainnet-rpc>
DEPLOYER_ADDRESS=<address>
DEPLOYER_PRIVATE_KEY=<private-key>
LENDER_ADDRESS=<address>
LENDER_PRIVATE_KEY=<private-key>
BORROWER_ADDRESS=<address>
BORROWER_PRIVATE_KEY=<private-key>
HUNTER_ADDRESS=<address>
HUNTER_PRIVATE_KEY=<private-key>
```

Fund only the deployer with CC3 testnet tCTC through the `token-faucet` channel in the [Creditcoin Discord](https://discord.gg/creditcoin). The setup script funds the other roles. Then run:

```bash
node scripts/deploy.mjs
node scripts/demo-setup.mjs
node scripts/submit.mjs
```

The final command pre-warms and fetches the five locked proofs, submits one batch, and checks the resulting `Breached` state, 274.79 USDC accumulation, debt reduction, zero available credit, and 40 tCTC hunter payout. Deployment rewrites `deployments.json`, so preserve the checked-in live record before running a fresh deployment.

To run the static application:

```bash
python -m http.server 8000
```

Open `http://localhost:8000/web/`. There is no build step. The application discovers facilities from live `FacilityOpened` events and remains fully readable without a wallet. Connect an injected EVM wallet such as MetaMask to add or switch to CC3 Testnet and operate facilities through wallet-owned signatures; browser code never reads a private key. Open `http://localhost:8000/web/horizon1.html` for the separate read-only Horizon 1 console.

The application exposes the complete deployed surface:

- lenders can open, fund, configure and register ordered covenants, cancel before activation, and withdraw claims;
- borrowers can post the bond, activate the exact live covenant-set commitment, request and execute delayed draws, repay, cancel before activation, and claim refunds;
- permissionless hunters can build Attestcoin batches directly from Ethereum transaction hashes, inspect the exact calldata and gas policy, and submit through their wallet;
- every write is shown in a transaction-review dialog and preflighted with a read-only contract call before the wallet is asked to sign.

The configure â†’ register â†’ activate order is explicit in the interface because it is a contract-enforced security boundary. Configuration parameters are verified against the on-chain hash. Parameters created in this browser are retained locally after confirmation; because the deployed covenant contracts expose only their hashes and emit no parameter event, another browser can verify checked-in public metadata but cannot reconstruct arbitrary private configuration values.

## Architecture

```text
Ethereum mainnet receipts
        │
        │ Proof Builder: Merkle proofs + shared continuity proof
        ▼
AttestcoinAdjudicator on Creditcoin
        ├── BlockProver.verify(...) proves inclusion and continuity
        ├── EvmV1Decoder reads status and receipt logs
        └── replay keys bind chain + block + transaction index
                       │
                       ▼
              Covenant evaluators
        ├── cumulative treasury outflow cap
        ├── new Aave borrow
        └── Uniswap V3 liquidity decrease
                       │ breach
                       ▼
              RecourseFacility
        freeze capacity │ slash bond │ record debt │ pay hunter
```

- `RecourseFacility.sol` owns the credit state machine, lender vault, borrower bond, draws, repayment, and breach accounting.
- `AttestcoinAdjudicator.sol` is the only contract that calls the BlockProver precompile. It verifies first, decodes receipts, rejects reverted transactions, enforces facility-and-covenant-scoped replay protection, and dispatches proven transactions.
- Each contract in `contracts/covenants/` is a small, separately configured predicate. It validates the source chain, window, emitting contract, indexed subjects, and event data relevant to that covenant.
- `scripts/` handles deployment, facility setup, proof retrieval, and unattended submission. `web/` is the zero-build wallet application and walletless facility monitor.
- `sdk/` exposes typed reads, simulations, exact ABI encodings, and calldata-only builders. `PolicyRegistryV1` records bounded issuer declarations, approved runtime variants, exact deployment attestations, and release- or deployment-scoped audit artifacts.
- `daemon/job-discovery.mjs` scans confirmed Proof Jobs history without a signer, pins hydrated state to the report block, persists a reorg-checked cursor, and derives only metrics observable from contract events.
- `contracts/v3/` contains the additive capped-pilot, remedy lifecycle, pinned USC adapter, multi-chain event policy, operator market, portfolio mandate, and fixed-vintage pool contracts. The USC adapter is source-only until an authoritative live Outbox route, source acknowledgement-validator trust, and destination validator state can be verified for a dedicated Recourse Inbox.
- `daemon/operator.mjs` is the read-only-by-default reference operator. Optional execution is gated by exact allowlists, economics, source-chain identity, Kernel V2 stale-proof recovery, confirmation depth, and crash-safe signed transaction journals.
- `web/operator.html` and `web/portfolio.html` are walletless observatories. Operator reports require a same-origin, size-bounded, internally consistent, RPC-anchored artifact; portfolio reads are explicitly labeled single-endpoint assertions.

The borrower's activation commits to an ordered hash covering both the identity and configuration of every registered covenant. Registration is limited to the pre-activation `Created` state, and each covenant rejects reconfiguration after registration, so neither the covenant set nor anything the borrower agreed to can change afterwards.

## Testing

`npm test` passes 375 Forge tests, 214 root Node tests, and 39 SDK tests across both deployed generations and the local roadmap build, followed by a strict SDK declaration compile. One Windows-only symlink test is skipped when the process lacks symlink privilege, for 215 root Node tests in total. The original 134 Forge tests remain green. New coverage includes exact pilot loss settlement, remedy retry/timeout/acknowledgement recovery, multi-rule transaction accumulation, per-policy source ordering and the later-weak/earlier-severe front-running regression, sponsor-bound operator-market escrow, registry declarations and exact audit scopes, ABI parity, block-hash-bound pagination, reorg-anchored aggregate reads, target-first crash recovery, signed-call substitution rejection, native proof/receipt binding, bounded adaptive source scans, queue-saturation recovery, transaction finality, conservative cures, extension deployment approval and journal recovery, and end-to-end policy flows.

Eight stateful invariant properties each complete 256 runs and 128,000 calls with zero handler reverts. They cover native and ERC-20 asset conservation, claim solvency, Horizon 1 and capped-pilot facility bounds, default loss distribution, inactive credit availability, portfolio recovery and loss bounds, and fully collateralized operator-market obligations even when unsolicited token transfers create surplus. A separate regression test asserts that the original-generation bond can be claimed at most once.

## Honest limitations

- **No cross-chain write-back.** [Attestcoin writability](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-writability) is not live on testnet, so Recourse cannot reach back to Ethereum. The bond, draw freeze, permanent default state, and on-Creditcoin repayment obligation are the recourse. This project does not claim legal or cross-chain recovery.
- **Legacy hunter MEV.** The frozen generation's direct submissions remain copyable. Horizon 1 routes submissions through hunter-bound proof jobs with evidence-digest reservation and commit/reveal; this does not change the old contracts.
- **Historical simulation.** The hero demo uses real historical Ethereum mainnet evidence that necessarily predates the facility. It is a historical simulation over real data, and the demo must be described that way; it is not evidence of post-funding borrower conduct.
- **Fixed predicates.** The implementation contains three hardcoded covenant predicates, not a general covenant DSL.
- **Legacy hash-only configuration recovery.** The frozen covenants expose only a configuration hash. Horizon 1 evaluators expose their complete typed configuration and the kernel stores the ABI-encoded public manifest.
- **Browser proof source.** Browser-built hunter batches currently support Ethereum mainnet (`chainKey = 3`). The application cross-checks the Proof Builder response against an independent public Ethereum RPC and the CC3 verifier-derived transaction index before review.
- **Plaintext development wallets.** `npm run wallets:new` writes throwaway testnet keys to a plaintext, gitignored file. The file is not encrypted, although none of these keys appear in git history.
- **Native-transfer compatibility.** Each participant address must be able to receive native transfers. A contract address that rejects them can block its own withdrawal.
- **Local registry trust model.** `PolicyRegistryV1` records issuer-attested, facility/kernel-consistent, evaluator-runtime/config-bound deployments. It does not certify a canonical factory or kernel build, and its constructor binding currently models kernel-only policy constructors. Audit artifacts identify their publisher and exact release or deployment scope; they are not a registry-wide audit verdict.
- **Testnet and unaudited.** Recourse is deployed only on CC3 Testnet and has not received an independent security audit beyond the project's own adversarial review and test suite.

## Roadmap

Recourse's trajectory is not “more covenants.” It is a cross-chain credit policy layer that turns verified external reality into continuously serviced credit state and bounded consequences, then, when the underlying protocol support exists, closes that loop wherever the exposure lives.

- **Horizon 1 — Items 1–3 delivered; item 4 bounded stack delivered locally.** The original Horizon 1 contracts are live, and its reference operator is installed as a healthy read-only service. The inactive six-contract V3 deployment has zero activation state but is superseded by the hardened current bytecode and cannot be activated. A fresh full-core deployment and qualification are required, and V3 execution is not installed. No pilot has run: a design partner, independent audit, legal review, and production asset and custody decisions remain explicit gates.
- **Horizon 2 — Local closed-loop stack delivered; live routing blocked.** Items 5 and 6 include a transport-neutral lifecycle plus a pinned USC 0.2 single-route adapter, deterministic deployment qualification, and acknowledgement handling. They remain undeployed and unusable as a live cross-chain product until an official route and external Inbox configuration are available and independently verified. Item 7 includes the unpublished typed SDK and a historical empty registry deployment; the current ABI requires the fresh V3 core described above. Independent audit, interface freezing, and two external integrations remain gates.
- **Horizon 3 — Local coordination stack delivered; live market and capital remain gated.** Item 8 supports the two source keys currently documented for CC3, item 9 includes an escrow market and fail-closed executable operator while only the Horizon 1 read-only service is installed, and item 10 includes a source-only fixed-vintage capital pool. No operator market, portfolio allocation, or customer policy is live; each still depends on audit, demand, economics, supported routes, and real servicing history.

See the [full three-horizon roadmap](docs/ROADMAP.md) for the ten-item plan, investment milestones, dependencies, and deliberate cut list.

## Attribution

The Attestcoin integration follows the patterns in the current [Attestcoin readability documentation](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-readability) and the MIT-licensed [`gluwa/usc-testnet-bridge-examples`](https://github.com/gluwa/usc-testnet-bridge-examples). Receipt decoding and verifier interfaces come from [`@gluwa/usc-contracts`](https://www.npmjs.com/package/@gluwa/usc-contracts); proof construction uses [`@gluwa/usc-sdk`](https://www.npmjs.com/package/@gluwa/usc-sdk). Facility safeguards use OpenZeppelin Contracts. Runtime dependencies are permissively licensed, and their required notices are retained in the installed packages.

## Licence

MIT, as declared in `package.json` and the Solidity source headers.
