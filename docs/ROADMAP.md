# Recourse Roadmap

## Where the project is today

Recourse has two live application generations on CC3 Testnet plus a historical inactive six-contract V3 core, with 18 deployed contracts in total. The proven v1 generation remains live and untouched: its five contracts provide three fixed covenant predicates, an ordered covenant-set commitment, a permissionless adjudicator, a native-token credit-facility state machine, the original autonomous hunter daemon, and a zero-build wallet application covering the lender, borrower, and hunter workflow. Facilities 1 and 2 both remain `Breached`.

The v1 evidence stands as before. A live autonomous daemon run detected a qualifying Ethereum mainnet USDC outflow, built the Attestcoin proof, submitted it, and moved Facility 2 to `Breached` without manual intervention. Horizon 1 is an additive seven-contract generation: a Policy Kernel, Verified Credit State, Permissionless Proof Jobs, facility factory, event-history policy, demonstration facility, and fixed-supply demo asset. Its demonstration facility is ERC-20 denominated with six decimals. Its resumable reference operator is installed and healthy in read-only mode; it is separate from the original daemon and has no transaction signer.

A separate roadmap build adds the typed SDK and simulation package, `PolicyRegistryV1`, an issuer-declaration and exact-audit model, Proof Jobs discovery and observable-metrics reports, and walletless observatories. The committed Horizon 1 console is [publicly hosted](https://ridwan.gudman.xyz/recourse/horizon1.html); the SDK remains unpublished, and the historical V3 registry deployment contains no releases, deployments, or audit claims. It is part of the superseded core, not a current-ABI integration target. None of these foundations has been independently audited, frozen, or validated by an external integration.

The repository-buildable implementation for items 4–10 is now complete and catalogued in [Roadmap items 4–10: implemented scope and remaining gates](ROADMAP-4-10-BUILD.md). The inactive V3 deployment recorded in `deployments-v3.json` predates the hardened source-ordering interface and cannot be activated by the current tooling; a fresh full-core deployment is required. The USC route, operator market, and portfolio pool are not deployed or opened. “Built” does not mean audited, integrated, funded, authorized, or validated by customers; the remaining external gates are preserved below.

Across both deployed generations and the local roadmap build, the suite passes 348 Forge tests, 176 root Node tests, and 36 SDK tests, followed by a strict SDK declaration compile; one Windows symlink test is skipped when the process lacks symlink privilege, for 177 root Node tests in total. Eight stateful invariant properties each complete 256 runs and 128,000 calls with zero handler reverts while checking native and ERC-20 asset conservation, claim solvency, facility and default-loss bounds, inactive credit availability, portfolio recovery and loss bounds, and exact operator-market escrow solvency. This remains testnet software. It has received internal adversarial review only, not an independent security audit; the demo asset is not a production stablecoin; and the demonstrated testnet history is not production credit performance.

The thesis is larger than an undercollateralized lending application:

> **Recourse is the cross-chain credit policy layer: it verifies what an entity controls, owes, and does across chains, converts that evidence into a continuously updated credit state on Creditcoin, and executes pre-authorized remedies wherever the exposure lives.**

Creditcoin supplies verified multichain facts. Recourse supplies the credit semantics, policy lifecycle, incentives, and consequences. That fits [Creditcoin's current positioning](https://docs.creditcoin.org/what-is-creditcoin) as infrastructure for smart contracts coordinating across blockchains, rather than relying on its earlier credit-bureau framing.

The ambitious version of Recourse is not more covenants. It is the layer that turns verified cross-chain reality into enforceable, continuously serviced credit policy, and eventually closes that loop across every place the exposure actually lives.

## Business and investment case

The initial customer profile is on-chain treasuries, market makers, credit vaults, and RWA vehicles with programmable accounts, not unsecured consumers. These entities have observable activity, professional counterparties, larger facilities, and the ability to pre-authorize bounded remedies. Recourse has no design partner today, so this is a target market thesis, not evidence of customer demand.

The intended business model is:

- an origination or deployment fee for a credit facility;
- a recurring monitoring and policy-servicing fee;
- usage fees for adjudication and action routing; and
- enterprise integration work initially, converging toward standardized policy packages.

No Recourse token is required. The roadmap is organized around the qualities [CEIP asks applicants to demonstrate](https://creditcoin.org/Fund): cross-chain compatibility, a clear development roadmap, transparent milestones, sustainability, and measurable real-world impact.

## Horizon 1 — Turn the proof into a pilotable credit system

### 1. Recourse Policy Kernel v1 — delivered and deployed

**What shipped:** A committed policy state machine with graded outcomes: eligible, watch, restricted, margin-called, breached, and cured. Deployed policies can freeze a pending draw, reduce locally available credit, require fresh evidence, step up terms for future draws, or terminate the facility. Policy registration builds an ordered commitment, full public manifests are recoverable, and multiple policy effects aggregate conservatively.

**Why it is the natural extension of Recourse:** The three original covenants and ordered covenant-set commitment were already a narrow policy kernel. Generalizing the consequence model extends the proven primitive without widening the authorization surface with a premature universal covenant language.

**Sponsor alignment:** Verified collateral lending and settlement/RWA attestation.

**What it unlocks:** Continuous servicing rather than one terminal enforcement event, with multiple lending products able to consume the same adjudicated risk state.

**Honest dependencies:** No writability is required for local actions. The economic invariants and adversarial tests are built; an independent audit of the exact deployed scope remains required before real value is entrusted to it.

### 2. Verified Credit State — delivered and deployed

**What shipped:** A per-borrower, per-facility history of proven event observations, deltas, and transitions with explicit freshness deadlines. Each accepted observation records its source chain, source position, subject, canonical emitter, event-reported value, proof time, expiry, evidence digest, and policy effect.

**Why it is the natural extension of Recourse:** The original product already turns proven behaviour into consequences. Horizon 1 makes those observations reusable as ordered, freshness-aware credit state while staying inside the evidence Attestcoin actually proves.

**Sponsor alignment:** Lending against verified balances and derivatives backed by proven collateral, subject to the confirmed limits below.

**What it unlocks:** Event-derived facility restrictions, proof-of-compliance challenges, and portfolio monitoring based on proven transitions. Current balances and asset values still require additional evidence sources.

**Confirmed Attestcoin boundary:** The installed surface proves transaction inclusion and the encoded transaction, receipt, and log data. It does not provide account, balance, storage, `eth_call`, or source-block-timestamp proofs. Verified Credit State therefore records proven event deltas and transitions, not cryptographically verified current balances. `proofTime` is CC3 acceptance time, not source-chain event time, and asset valuation remains an external input. Event-history policies reject favourable `Eligible` and `Cured` outcomes because a stale favourable event must not reopen credit.

This qualifies Attestcoin's own “lending against verified on-chain balances” framing: directly proving a current on-chain balance is not possible with the installed surface today. Recourse works within that boundary by recording what the proof actually establishes. Reconstructing current state would require a protocol-specific adapter with a known baseline and complete coverage of every state-changing path; pricing, liquidity, ownership binding, rehypothecation, and hidden liabilities would still remain outside the proof.

### 3. Permissionless Proof Jobs — delivered and deployed

**What shipped:** Facilities publish typed monitoring jobs with evidence requirements, expiry, maximum proof reimbursement, and outcome rewards. Hunters commit a hunter-bound evidence digest before revealing the proof, reserving their right to the application reward without hiding the eventual evidence. When run, the resumable Horizon 1 reference operator persists and validates commit/reveal state without modifying the unchanged original daemon.

**Why it is the natural extension of Recourse:** Recourse already had a live autonomous hunter and an application-funded breach reward. Proof Jobs turns that working operator model into repeatable infrastructure.

**Sponsor alignment:** Permissionless readability proof submission and the operator model surrounding Attestcoin.

**What it unlocks:** Lenders no longer need to run their own watchers; multiple independent operators can cover facilities; monitoring becomes a measurable service with latency and uptime.

**Honest dependencies:** The deployed design reserves each evidence digest to its first committer, delays reveal, makes missed-reveal bonds slashable, and recovers invalid, irrelevant, or duplicate attempts conservatively. Production reward levels still need to cover expected proof and gas costs without incentivizing manufactured breaches. The implementation reuses Attestcoin proof infrastructure rather than duplicating it.

### 4. A capped real-asset pilot — bounded stack delivered locally; pilot not run

**What shipped:** `CappedPilotFactoryV1` fixes every counterparty and applies per-facility, aggregate-notional, bond, fee, maturity, delay, and count bounds; only its lender can consume capacity and its guardian can pause creation. It deploys `RecourseFacilityV3`, whose one-time lender-controlled default settlement applies the bond to remaining debt and returns only excess to the borrower. Keeping settlement lender-only makes a pooled lender's recovery delay authoritative. A fail-closed readiness evaluator, offline-by-default activation planner, read-only-by-default operator, recovery journal, service template, and runbook cover qualification without declaring the pilot production-ready. The historical six-contract V3 deployment is wired and has zero activation state, but its kernel and policy bytecode predate the current source-ordering contract and commitment, so the current activation tooling correctly rejects it. The demonstration asset remains a fixed-supply testnet token, not a stablecoin or production asset.

**What did not ship:** No pilot has been run, and the hardened V3 build has not been deployed. Recourse still has no design partner, independent audit, legal review, production asset or custody decision, or production watcher. The historical scaffolding deployment must not be read as an activation target, evidence of customer demand, or production credit performance.

**Why it is the natural next step for Recourse:** The deployed native-token and ERC-20 testnet facilities prove mechanics, not product demand. A real lender-borrower workflow remains the shortest path to learning whether counterparties will pay for continuously serviced, automatically enforced credit policy.

**Sponsor alignment:** Collateralized lending, RWA financing, and real-world settlement.

**What it unlocks:** Real servicing data: proof latency, monitoring cost, false-positive rate, operator economics, capital utilization, and whether counterparties accept automated covenant consequences.

**Honest dependencies:** Recourse has no design partner today and no customer has requested this pilot. It requires an independent audit of the exact contract scope, legal review of facility terms, production asset and custody decisions, production deployment readiness, and a counterparty willing to use programmable custody. Testnet history must never be presented as production performance.

**Investment milestone:** One signed design partner, one independently audited scope, a complete pilot budget, and a rehearsed testnet facility whose monitored conduct begins only after funding.

## Horizon 2 — Close the loop across chains

The transport-neutral contracts and local lifecycle are now implemented, but live routing remains blocked. [Attestcoin writability is still undergoing tests and audits and is not live on testnet](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-writability), so neither item is a deployed cross-chain product until the required protocol surface exists and can be verified in the target environment.

### 5. Cross-chain Remedy Adapters — pinned USC adapter delivered locally; live route blocked

**What shipped locally:** `RemedyCoordinatorV1`, `BoundedRemedyReceiverV1`, narrow transport and target interfaces, and a single-route `UscRemedyTransportV1`/`UscRemedyDispatcherV1` pair against the pinned USC contracts package. An intent and receiver authorization bind the exact facility policy, evidence, source chain, coordinator, destination, receiver, target, action kind, action-data hash, execution ID, nonce, and expiry. Fresh adverse evidence always creates a fresh execution domain. Only a lender-authorized explicit replacement of the latest failed or expired intent preserves the same adverse episode and execution ID; the receiver reuses the first nonzero result instead of calling the target twice. Its canonical confirmation event binds the current intent, execution ID, target, result, and action hash. The adapter binds an exact Outbox, a dedicated constructor-bound Inbox callback domain, ATTEST token, fee ceiling, coordinator, receiver, and acknowledgement request. Offline-first deployment qualification verifies bytecode, constructors, chain identities, USC dependencies, route state, nonces, deterministic addresses, transaction fees, and crash journals without inventing a route or replacing a shared dispatcher.

**What it is:** Destination receivers for specific pre-authorized actions: freeze a vault, reduce a spending limit, initiate a margin call, suspend a treasury module, or release agreed escrow. Every instruction carries a policy ID, evidence commitment, nonce, deadline, and bounded action parameters.

**Why it is the natural next step for Recourse:** This is the outbound half of the decision Recourse already makes. It converts “verified conduct changes Creditcoin state” into “verified conduct changes the actual exposure.”

**Sponsor alignment:** Chain-to-chain routing and settlement/RWA attestation.

**What it unlocks:** Enforcement where assets and permissions live, rather than only on Creditcoin.

**Honest dependencies:** The installed USC 0.2 package exposes concrete Outbox/Inbox contracts and a wire format, but no authoritative live route or deployment authority is checked into this repository. The official writability documentation still describes the capability as undergoing testing and audits. The source acknowledgement validator must separately trust the exact predicted dedicated Inbox, and the destination vote-validator and attestor-registry state must match the approved evidence. Each route and destination target needs independent security review. Recourse can act only through explicitly authorized receivers; it cannot seize an arbitrary wallet, reverse a transfer, or force an unintegrated protocol to act.

### 6. Closed-loop servicing with acknowledgements and cure — local lifecycle delivered

**What shipped locally:** Recorded, published, acknowledged, cured, expired, and failed states with bounded publish attempts, permissionless timeouts, and prior-attempt acknowledgement recovery. Fresh adverse evidence after a terminal intent gets a fresh execution ID. The lender-authorized policy evaluator may instead explicitly replace the latest failed or expired intent from the same adverse episode, preserving its execution domain for delayed-message idempotency. `ClosedLoopPolicyV1` accepts only the canonical receiver confirmation for the current acknowledged intent, stable execution ID, target, and action commitment, and rejects overlapping adverse/cure configurations.

**What it is:** A durable workflow that records intent, delivery, execution or pending status, acknowledgement, and cure. A failed destination handler does not silently mark the remedy complete; Recourse waits for proven delivery and execution events before advancing its policy state.

**Why it is the natural next step for Recourse:** Credit enforcement is a stateful process, not a fire-and-forget message. The current facility state machine provides the natural coordination point.

**Sponsor alignment:** Writability retryability, delivery acknowledgements, and RWA settlement.

**What it unlocks:** Auditable margin calls, collateral top-ups, cures, and multi-step settlements across chains.

**Honest dependencies:** Writability and acknowledgement proofs must be live and verified. Recourse must distinguish message authenticity, delivery, handler execution, and economic completion, just as the current implementation distinguishes transaction inclusion from transaction success.

### 7. Recourse SDK and Policy Registry — local v1 foundation delivered; external validation pending

**What shipped:** A plain-ESM typed SDK with Horizon 1, V3 core, Policy Registry, Proof Jobs, and portfolio-pool reads; exact ABI encodings; calldata-only builders; manifest and commitment hashing; and conservative facility, policy, default-loss, and portfolio simulations. Block-hash-bound cursors and hard page limits make registry, audit, deployment, facility-policy, and aggregate reads resumable without silently changing snapshots; canonical manifest decoding rejects trailing bytes. `PolicyRegistryV1` records bounded issuer declarations, issuer-declared build-artifact hashes, exact constructor-bound runtime variants, metadata-only action-adapter specifications, issuer-attested deployment records, and auditor-attributed release or deployment artifacts. The historical V3 registry deployment remains empty and is incompatible with current aggregate V3 reads; a fresh full-core manifest is required. The capped factory remains a separate deployment surface.

The SDK's off-chain `recourse-policy-package` artifact and the registry's on-chain issuer declarations are deliberately separate schemas. Registry deployment history is issuer-attested, facility/kernel-consistent, and evaluator-runtime/config-bound; it is not factory-certified or proof that the kernel itself is a canonical build. The v1 constructor binding models the current kernel-only policy constructor, not a universal constructor language. Audit artifacts identify their publisher and exact scope and never create a registry-wide audit verdict.

**Why it is the natural next step for Recourse:** This extracts the reusable pieces already present in the adjudicator, covenant, facility, daemon, and wallet split without prematurely turning the system into a universal language.

**Sponsor alignment:** Infrastructure for lending, derivatives, routing, and settlement applications.

**What it unlocks:** Other teams can begin integrating verified credit controls into vaults or markets without adopting the Recourse user application or rebuilding proof handling. The current package is suitable for interface discovery and testnet integration, not a frozen production dependency.

**Honest dependencies:** Unlike items 5 and 6, this item is not blocked on Attestcoin writability. The SDK remains unpublished, the deployed registry is empty, no external protocol has integrated it, and no independent audit covers it. At least two external integrations should shape the interfaces before they are frozen. Recourse has no external integration partner today. “Audited” must attach to an exact release or deployment and a named auditor, never to the registry as a whole.

**Business milestone:** First external protocol integration and first recurring monitoring customer.

## Horizon 3 — Become the credit coordination network

### 8. Multi-chain portfolio policy — bounded event-policy core delivered locally

**What shipped:** `MultiChainEventPolicyV1` evaluates up to 16 strict EVM log rules keyed by configured source-chain identifiers, maintains a saturating cumulative risk score, and applies conservative effect tiers. A transaction matching several monitored rules accumulates every match deterministically instead of becoming an enforcement bypass. `PolicyKernelV2` freezes each evaluator's declared ordering mode into the policy-set commitment. Legacy and closed-loop policies remain strictly increasing. The cumulative multi-chain policy is `UniqueOnly`: every distinct proven transaction can contribute even if a later weak event arrived first, replay remains forbidden, and the latest-position cursor never regresses. The ordered batch entry point is disabled for `UniqueOnly`; its operator submits canonical single proofs and mirrors the on-chain mode. Activation and operator tooling map only the two CC3 source keys currently documented: key 1 to Ethereum Sepolia and key 3 to Ethereum mainnet, with exact RPC-reported EVM chain IDs.

**What it is:** A single facility whose policy evaluates verified positions, obligations, liquidity movements, and conduct across several supported chains, then routes bounded remedies to the chains holding the relevant exposure.

**Why it is the natural next step for Recourse:** Credit risk is portfolio-wide. A borrower can satisfy a rule on one chain while moving risk elsewhere; Recourse's cumulative behavioural model is designed to reason across a sequence rather than a single message.

**Sponsor alignment:** Creditcoin's standardized multichain event access and Attestcoin's stated expansion beyond EVM chains.

**What it unlocks:** Credit lines and RWA facilities based on the borrower's total provable operating state rather than one isolated wallet.

**Honest dependencies:** On CC3 Testnet, [the currently documented source environments are Ethereum Sepolia and Ethereum mainnet](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-protocol-chains-environments). Add only chains that Attestcoin actually provisions and a customer needs. Bitcoin, non-EVM state, and new destination chains are dependencies, not promised deliverables.

### 9. Open operator market — local escrow market and operator delivered; market not opened

**What is implemented:** `OperatorMarketV1` supports separately priced monitoring, proof-construction, submission, and delivery quotes with operator-bond and sponsor-price escrow, verifier-bound permissionless settlement, cancellation, expiry, and pull withdrawals. Its exact escrow solvency is statefully tested. The operator scanner checks confirmed canonical history, resumes through atomic reorg-checked cursors, pins hydration to one report block, and reports only event-observable metrics. Optional V3 execution is fail-closed on economics, exact allowlists, Kernel V2 stale-proof recovery, signer exclusivity, source-chain identity, canonical receipts, confirmation depth, fee ceilings, and durable transaction journals. The operator terminal refuses unanchored or inconsistent reports. A Horizon 1 instance is installed and healthy in read-only mode; no V3 executable service or market is installed or enabled.

**What it is:** Competing operators would quote separately for monitoring, proof construction, transaction submission, and, where applicable, message delivery. Recourse would measure coverage, response latency, valid-proof rate, and completed jobs, while verification remains entirely on-chain.

**Why it is the natural next step for Recourse:** The autonomous daemon is already the first operator. Turning it into an open service market removes Recourse itself as a liveness bottleneck.

**Sponsor alignment:** Permissionless proof submission and paid message relaying.

**What it unlocks:** Reliable facility coverage without one centralized watcher and a new source of Attestcoin transaction and write demand.

**Honest dependencies:** The quote and escrow contract is local and source-only; no live operator market, matching service, customers, reputation, or profitability evidence exists. Reverted invalid or irrelevant reveals emit no event, so the report does not claim a false-positive rate; partial history is explicitly incomplete. A real market still needs protection against censorship, job spam, collusion, and reward manipulation. Relaying should remain compatible with Attestcoin's own competitive fee market rather than becoming a separate Recourse network.

### 10. Programmable credit portfolios — fixed-vintage pool delivered locally; capital not deployed

**What shipped locally:** `PortfolioMandateV1` checks exact factory provenance, asset, kernel, facility status, notional, bond, fee, maturity, policy commitment, registry release/deployment binding, evidence kind, and action-adapter declaration. `PortfolioPoolV1` is a fixed-vintage, single-asset capital pool with a frozen bounded investor allowlist, exact mandate revalidation, pool-created facilities, full-bond-before-allocation, one atomic full-limit allocation, pull-based claims, permissionless cash-only finalization, lender-only default-loss settlement after the pool's recovery delay, explicit loss recognition, delayed recovery redistribution, and bounded Proof Jobs service spending. It freezes each remedy evaluator/coordinator binding before funding and lets only the manager publish retries or request a policy-authorized replacement; those bounded servicing calls remain available after economic finalization so an open remedy is not stranded. Its largest-remainder accounting distributes each finalized or recovered asset unit exactly once. The source-only observatory never presents the pool as deployed or funded.

**What it is:** Lenders allocate capital to pools constrained by standardized Recourse policies, such as facilities whose collateral freshness, maximum verified outflow, liability growth, and remedy adapters satisfy a declared mandate. Proven servicing history becomes an input to future allocation without becoming a simplistic universal credit score.

**Why it is the natural next step for Recourse:** Once policies and outcomes are standardized, the natural scale step is from one facility to portfolios managed by verifiable risk mandates.

**Sponsor alignment:** Collateralized lending, proven collateral for financial products, and RWA financing.

**What it unlocks:** Diversified capital formation, transparent servicing performance, and repeatable underwriting products built on Creditcoin.

**Honest dependencies:** The pool is undeployed, unaudited, uncapitalized, and not an evergreen NAV product; shares lock after activation and only exact fixed-vintage allocations are supported. Meaningful live history, lender demand, legal structuring, custody review, valuation inputs, and audited loss accounting remain gates. It should follow successful bilateral facilities, not precede them.

## What we are deliberately not building

- **Repayment sweeps as the headline write-back.** They are too narrow and potentially the most legally and technically fraught adapter. Bounded remedy adapters and closed-loop servicing describe the real product.
- **More source chains as a milestone.** Chain count is not product validation. A chain should be added only when Attestcoin actually provisions it and a customer needs it.
- **“Audited covenant templates” as vision.** Audits are release gates, not roadmap differentiation. Exact-version audit status belongs in the policy registry.
- **Standalone compliance deadlines.** Freshness and liveness requirements belong inside verified credit state.
- **Bridges, governance, or generic messaging.** They validate Attestcoin, not Recourse. Recourse should participate only where verified facts drive credit policy.
- **A universal covenant DSL in the near term.** It expands the authorization surface before recurring abstractions are known. Versioned Solidity policy packages, typed manifests, a deployment factory, and an SDK are the safer next move.
- **A Recourse token or separate relayer network.** Neither is necessary. Attestcoin already owns message delivery; Recourse should own the market for identifying and proving financially meaningful conditions.
- **Emerging-market consumer lending as the primary framing.** Recourse does not have the identity, regulatory, legal, underwriting-data, or collections systems required to make that claim credible. The nearer opportunity is infrastructure for programmable institutional and on-chain credit.
