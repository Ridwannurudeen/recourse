# Recourse Roadmap

## Where the project is today

Recourse has proved its first hard primitive: verified conduct on another chain can autonomously change financial rights on Creditcoin. Five protocol contracts are deployed on CC3 Testnet. The system has three fixed covenant predicates, an ordered covenant-set commitment, a permissionless adjudicator, a credit-facility state machine, an autonomous hunter daemon, and a zero-build wallet application covering the full lender, borrower, and hunter workflow.

The evidence is concrete. A live autonomous daemon run detected a qualifying Ethereum mainnet USDC outflow, built the Attestcoin proof, submitted it, and moved Facility 2 to `Breached` without manual intervention. The contract suite passes 134 Forge tests and the daemon passes four focused Node tests. This is still testnet software. It has received internal adversarial review only, not an independent security audit, and the demonstrated testnet history is not production credit performance.

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

### 1. Recourse Policy Kernel v1

**What it is:** Replace the binary healthy-or-breached model with a committed policy state machine supporting graded outcomes: eligible, watch, restricted, margin-called, breached, and cured. Policies can freeze a pending draw, reduce locally available credit, require fresh evidence, step up terms for future draws, or terminate the facility.

**Why it is the natural next step for Recourse:** The three current covenants and ordered covenant-set commitment are already a narrow policy kernel. Generalizing the consequence model extends the part that works instead of widening the authorization surface with a premature universal covenant language.

**Sponsor alignment:** Verified collateral lending and settlement/RWA attestation.

**What it unlocks:** Continuous servicing rather than one terminal enforcement event, with multiple lending products able to consume the same adjudicated risk state.

**Honest dependencies:** No writability is required for local actions. The kernel requires new economic invariants, adversarial tests, and an independent audit before real value is entrusted to it.

### 2. Verified Credit State

**What it is:** A per-borrower, per-facility state composed from ownership proofs, collateral or position evidence, proven liabilities, behavioural observations, and explicit freshness deadlines. Each observation records its source chain, subject, proof time, expiry, and policy effect.

**Why it is the natural next step for Recourse:** The current product already turns behaviour into consequences. Adding eligibility and capacity evidence completes the credit lifecycle: qualify, monitor, restrict, and enforce.

**Sponsor alignment:** Lending against verified balances and derivatives backed by proven collateral.

**What it unlocks:** Risk-based facility limits, collateral-maintenance rules, proof-of-compliance challenges, and portfolio monitoring across chains.

**Honest dependencies:** Direct balance or storage-state proof support must be verified before it is promised. The first version should use proven event histories and collateral contracts with reconstructable state. Asset valuation remains an external input; pricing, liquidity, ownership binding, rehypothecation, and hidden liabilities are not cryptographically solved by proving a quantity.

### 3. Permissionless Proof Jobs

**What it is:** Facilities publish typed monitoring jobs with evidence requirements, expiry, maximum proof reimbursement, and outcome rewards. Hunters commit an evidence digest before revealing the proof, protecting their right to the application reward without hiding the eventual evidence. The existing daemon becomes the first reference operator.

**Why it is the natural next step for Recourse:** Recourse already has a live autonomous hunter and an application-funded breach reward. This turns a working operator into repeatable infrastructure.

**Sponsor alignment:** Permissionless readability proof submission and the operator model surrounding Attestcoin.

**What it unlocks:** Lenders no longer need to run their own watchers; multiple independent operators can cover facilities; monitoring becomes a measurable service with latency and uptime.

**Honest dependencies:** Commit/reveal must be designed against griefing and non-reveal attacks. Rewards must cover expected proof and gas costs without incentivizing manufactured breaches. This should reuse Attestcoin proof infrastructure, not duplicate it.

### 4. A capped real-asset pilot

**What it is:** A stablecoin-denominated facility factory, public policy manifests, full configuration recoverability, a production watcher, incident controls, and one design-partner pilot with deliberately capped exposure.

**Why it is the natural next step for Recourse:** The current native-token testnet facilities prove mechanics, not product demand. A real lender-borrower workflow is the shortest path to learning whether counterparties will pay for continuously serviced, automatically enforced credit policy.

**Sponsor alignment:** Collateralized lending, RWA financing, and real-world settlement.

**What it unlocks:** Real servicing data: proof latency, monitoring cost, false-positive rate, operator economics, capital utilization, and whether counterparties accept automated covenant consequences.

**Honest dependencies:** Recourse has no design partner today and no customer has requested this pilot. It requires an independent contract audit, legal review of facility terms, stablecoin support, production deployment readiness, and a counterparty willing to use programmable custody. Testnet history must never be presented as production performance.

**Investment milestone:** One signed design partner, one independently audited scope, a complete pilot budget, and a rehearsed testnet facility whose monitored conduct begins only after funding.

## Horizon 2 — Close the loop across chains

This horizon is directionally important but not scheduled work. [Attestcoin writability is not live on testnet](https://docs.creditcoin.org/attestcoin-protocol/attestcoin-writability), so both cross-chain items below remain blocked until the required protocol surface exists and can be verified in the target environment.

### 5. Cross-chain Remedy Adapters

**What it is:** Destination receivers for specific pre-authorized actions: freeze a vault, reduce a spending limit, initiate a margin call, suspend a treasury module, or release agreed escrow. Every instruction carries a policy ID, evidence commitment, nonce, deadline, and bounded action parameters.

**Why it is the natural next step for Recourse:** This is the outbound half of the decision Recourse already makes. It converts “verified conduct changes Creditcoin state” into “verified conduct changes the actual exposure.”

**Sponsor alignment:** Chain-to-chain routing and settlement/RWA attestation.

**What it unlocks:** Enforcement where assets and permissions live, rather than only on Creditcoin.

**Honest dependencies:** Fully blocked on deployed writability, destination Inbox availability, finalized authentication semantics, delivery fees, and acknowledgement support. Each destination integration needs its own security review. Recourse can act only through explicitly authorized receivers; it cannot seize an arbitrary wallet, reverse a transfer, or force an unintegrated protocol to act.

### 6. Closed-loop servicing with acknowledgements and cure

**What it is:** A durable workflow that records intent, delivery, execution or pending status, acknowledgement, and cure. A failed destination handler does not silently mark the remedy complete; Recourse waits for proven delivery and execution events before advancing its policy state.

**Why it is the natural next step for Recourse:** Credit enforcement is a stateful process, not a fire-and-forget message. The current facility state machine provides the natural coordination point.

**Sponsor alignment:** Writability retryability, delivery acknowledgements, and RWA settlement.

**What it unlocks:** Auditable margin calls, collateral top-ups, cures, and multi-step settlements across chains.

**Honest dependencies:** Writability and acknowledgement proofs must be live and verified. Recourse must distinguish message authenticity, delivery, handler execution, and economic completion, just as the current implementation distinguishes transaction inclusion from transaction success.

### 7. Recourse SDK and Policy Registry

**What it is:** A typed SDK, deployment factory, simulation tools, versioned policy packages, and a registry exposing policy code hashes, supported evidence types, action adapters, audits, and deployment history.

**Why it is the natural next step for Recourse:** This extracts the reusable pieces already present in the adjudicator, covenant, facility, daemon, and wallet split without prematurely turning the system into a universal language.

**Sponsor alignment:** Infrastructure for lending, derivatives, routing, and settlement applications.

**What it unlocks:** Other teams can add verified credit controls to their vaults or markets without adopting the Recourse user application or rebuilding proof handling.

**Honest dependencies:** At least two external integrations should shape the interfaces before they are frozen. Recourse has no external integration partner today. “Audited” must attach to an exact version and deployment, never to the registry as a whole.

**Business milestone:** First external protocol integration and first recurring monitoring customer.

## Horizon 3 — Become the credit coordination network

### 8. Multi-chain portfolio policy

**What it is:** A single facility whose policy evaluates verified positions, obligations, liquidity movements, and conduct across several supported chains, then routes bounded remedies to the chains holding the relevant exposure.

**Why it is the natural next step for Recourse:** Credit risk is portfolio-wide. A borrower can satisfy a rule on one chain while moving risk elsewhere; Recourse's cumulative behavioural model is designed to reason across a sequence rather than a single message.

**Sponsor alignment:** Creditcoin's standardized multichain event access and Attestcoin's stated expansion beyond EVM chains.

**What it unlocks:** Credit lines and RWA facilities based on the borrower's total provable operating state rather than one isolated wallet.

**Honest dependencies:** On CC3 Testnet, [only Ethereum Sepolia and Ethereum mainnet are currently provisioned](https://docs.creditcoin.org/attestcoin-protocol/attestcoin-design-diagrams) as source chains. Add only chains that Attestcoin actually provisions and a customer needs. Bitcoin, non-EVM state, and new destination chains are dependencies, not promised deliverables.

### 9. Open operator market

**What it is:** Competing operators quote separately for monitoring, proof construction, transaction submission, and, where applicable, message delivery. Recourse measures coverage, response latency, valid-proof rate, and completed jobs, while verification remains entirely on-chain.

**Why it is the natural next step for Recourse:** The autonomous daemon is already the first operator. Turning it into an open service market removes Recourse itself as a liveness bottleneck.

**Sponsor alignment:** Permissionless proof submission and paid message relaying.

**What it unlocks:** Reliable facility coverage without one centralized watcher and a new source of Attestcoin transaction and write demand.

**Honest dependencies:** No operator is trusted for correctness, but the system still needs protection against censorship, job spam, collusion, and reward manipulation. Relaying should remain compatible with Attestcoin's own competitive fee market rather than becoming a separate Recourse network.

### 10. Programmable credit portfolios

**What it is:** Lenders allocate capital to pools constrained by standardized Recourse policies, such as facilities whose collateral freshness, maximum verified outflow, liability growth, and remedy adapters satisfy a declared mandate. Proven servicing history becomes an input to future allocation without becoming a simplistic universal credit score.

**Why it is the natural next step for Recourse:** Once policies and outcomes are standardized, the natural scale step is from one facility to portfolios managed by verifiable risk mandates.

**Sponsor alignment:** Collateralized lending, proven collateral for financial products, and RWA financing.

**What it unlocks:** Diversified capital formation, transparent servicing performance, and repeatable underwriting products built on Creditcoin.

**Honest dependencies:** Meaningful live history, audited contracts, lender demand, legal structuring, and robust valuation inputs. It should follow successful bilateral facilities, not precede them.

## What we are deliberately not building

- **Repayment sweeps as the headline write-back.** They are too narrow and potentially the most legally and technically fraught adapter. Bounded remedy adapters and closed-loop servicing describe the real product.
- **More source chains as a milestone.** Chain count is not product validation. A chain should be added only when Attestcoin actually provisions it and a customer needs it.
- **“Audited covenant templates” as vision.** Audits are release gates, not roadmap differentiation. Exact-version audit status belongs in the policy registry.
- **Standalone compliance deadlines.** Freshness and liveness requirements belong inside verified credit state.
- **Bridges, governance, or generic messaging.** They validate Attestcoin, not Recourse. Recourse should participate only where verified facts drive credit policy.
- **A universal covenant DSL in the near term.** It expands the authorization surface before recurring abstractions are known. Versioned Solidity policy packages, typed manifests, a deployment factory, and an SDK are the safer next move.
- **A Recourse token or separate relayer network.** Neither is necessary. Attestcoin already owns message delivery; Recourse should own the market for identifying and proving financially meaningful conditions.
- **Emerging-market consumer lending as the primary framing.** Recourse does not have the identity, regulatory, legal, underwriting-data, or collections systems required to make that claim credible. The nearer opportunity is infrastructure for programmable institutional and on-chain credit.
