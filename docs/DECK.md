# Recourse — deck content

Content draft for 13 slides. Deployment and operating status below reflect the repository records; this document does not claim a fresh live-chain inspection. Sources are attached to each section for layout and fact-checking.

## 1. Covenant-enforced credit on Creditcoin

Recourse is an undercollateralized credit facility on Creditcoin where cryptographic proofs enforce covenants over a borrower's Ethereum conduct.

Source: [README](../README.md), [submission description](submission-form.md).

## 2. Credit needs enforceable promises

Traditional credit is governed by covenants: enforceable promises not to strip a treasury, take on new debt, or unwind a pledged position.

DeFi replaced those controls with overcollateralization because one chain cannot see what a borrower does on another. A lender needs more than an initial deposit: it needs a way to enforce the conduct the borrower agreed to after drawing credit.

Source: [README — The problem](../README.md#the-problem).

## 3. Provable conduct makes covenants executable

Attestcoin makes Ethereum conduct provable on Creditcoin. Recourse turns those proven facts into consequences held and executed by the credit facility itself.

The contract establishes what happened, checks it against the agreed covenant, and changes the borrower's available credit and debt accounting. The shipped remedy stays on Creditcoin; it cannot reach back into an arbitrary Ethereum wallet.

**The proof does not release an escrow. It changes credit risk.**

Source: [submission description](submission-form.md), [README — Honest limitations](../README.md#honest-limitations).

## 4. The facility lifecycle

1. **Fund.** A lender funds a facility with agreed credit terms.
2. **Commit and draw.** The borrower posts a penalty bond, commits named Ethereum positions to covenants, accepts the ordered covenant-set commitment, and draws credit.
3. **Prove.** Anyone may submit Attestcoin evidence of qualifying Ethereum conduct; the original adjudicator accepts individual or batched evidence.
4. **Verify and evaluate.** The adjudicator verifies inclusion and continuity against the BlockProver precompile, decodes the receipt on-chain, checks successful execution, derives replay-safe transaction identities, and evaluates the covenant.
5. **Execute the consequence.** A breach freezes undrawn capacity. In the original facility, up to 80% of the bond reduces outstanding debt, capped by that debt; the unused share returns to the borrower, and 20% rewards the hunter.

The borrower commits to covenant identities and configurations before activation; those agreed rules cannot subsequently be changed.

Source: [README — How it works and Architecture](../README.md), [submission description](submission-form.md).

## 5. The hero covenant: the breach is the sum

Five real Ethereum mainnet USDC transfers, in five distinct blocks across a 35-block inclusive span, were verified under one shared continuity proof in one adjudication.

**190.30 USDC largest transfer < 232.545 USDC cap < 274.79 USDC verified total.**

No single proven transfer breaches the cap. Only their verified sum does. Establishing that sum requires all of these checks:

- **Status:** each receipt reports successful execution; inclusion alone is insufficient.
- **Logs:** the emitter is the committed USDC contract, and the proven topics and amount match an outflow from the committed treasury.
- **Indices:** proof-derived transaction indices identify evidence and prevent replay, including repeated counting through aliased covenant registrations.
- **Continuity:** the separated source blocks verify under the shared continuity proof before their receipts affect credit accounting.

The historical batch settled at **CC3 block 5,371,462**, using **699,409 gas**. This is a historical simulation over real mainnet data that predates its facility, not proof of post-funding borrower conduct. The gas figure measures that adjudication, not a general production cost or throughput claim.

Sources: [integration evidence and mechanics](attestcoin-integration.md), [deployment record](../deployments.json), [historical adjudication transaction](https://creditcoin-testnet.blockscout.com/tx/0x7c180209bedaa64b4e1acff02d2822e8c76b0db98f105b7b75e3b95ac7e5d5b6).

## 6. The real autonomous catch

**A separate facility was configured before the qualifying Ethereum block was mined.**

The policy window was committed on CC3 first. The unattended operator then detected a **147.41949 USDC** Ethereum mainnet outflow, built its Attestcoin proof, and submitted the breach without manual intervention. Facility 2 moved to `Breached` at **CC3 block 5,371,828** (transaction [`0x96bf3081…f7528192`](https://creditcoin-testnet.blockscout.com/tx/0x96bf3081614a76c8df459eaeffe50975556883dd0e39d622758ca468f7528192), 459,396 gas).

This demonstrates a pre-configured policy reacting autonomously to subsequent mainnet activity. It is separate from the historical cumulative batch on the preceding slide. The historical batch's 699,409 gas must not be attributed to this catch.

Mainnet evidence was adjudicated on CC3 Testnet. Neither demonstration establishes customer demand or production credit performance.

Sources: [integration note — Two deployed generations](attestcoin-integration.md#two-deployed-generations), [roadmap — Current state](ROADMAP.md#where-the-project-is-today).

## 7. What is live today

The repository records the original covenant facility, the additive Horizon 1 generation, and the hardened V3 core on **CC3 Testnet**.

Horizon 1 comprises **seven contracts**: Policy Kernel, kernel-created Verified Credit State, ERC-20 facility factory, event-history policy, Proof Jobs market, demonstration facility, and demo token.

The demonstration facility is recorded as Active. Its denomination asset is a **fixed-supply testnet token, not a stablecoin or production asset**. The Horizon 1 reference operator is installed as a healthy **read-only service without a transaction signer**; this is separate from the historical autonomous daemon run.

The public Horizon 1 console reads factory, facility, policy, credit-state, and proof-job data at a pinned CC3 block. It requests no wallet and submits no transaction.

**The hardened V3 core is deployed and qualified.** `deployments-v3-current.json` records six contracts from reviewed source commit `90d8b05af38940ffeb55d974401641a327176b9e`, with all six runtime code hashes verified at CC3 block **5,459,080** and all six sources verified on Blockscout. The historical `deployments-v3.json` core remains inactive and superseded.

`activation-v3-current.json` records capped pilot facility `0x00B50626C4AA42d22ca01AAEa8649f253aEc5B1e` as **Active**, with policy **1**, registry release `0xad31a01779b7c8c8651e1fecbb15b6d177c25dbd637c99d7496c2c2a0b7d221a`, and proof job **1**. Its Ethereum source window is **25,944,522–26,024,522**, maturity is CC3 block **5,554,121**, and proof-job expiry is Unix timestamp **1792497600**. This is a fixed-supply demo-token testnet activation with no draw recorded, not a live pilot with a counterparty. There is no design partner, independent audit, or production asset or custody decision; V3 operator execution remains uninstalled and disabled.

Sources: [current V3 core manifest](../deployments-v3-current.json), [pilot activation manifest](../activation-v3-current.json), [Horizon 1 technical note](HORIZON1.md), [Horizon 1 manifest](../deployments-horizon1.json), [README](../README.md), [public console](https://recourse.gudman.xyz/horizon1.html), [live observatory](https://recourse.gudman.xyz).

## 8. Architecture: evidence becomes credit state

**Ethereum receipts → Attestcoin verification → Policy Kernel → Verified Credit State and facility consequences.**

| Component | Responsibility |
| --- | --- |
| Policy Kernel | Verify before interpretation; bind evidence to committed policies; apply graded effects such as Watch, Restricted, MarginCalled, and Breached. |
| Verified Credit State | Retain accepted event observations with source positions, evidence digests, expiry, and policy effects. |
| Proof Jobs | Let hunters reserve evidence through hunter-bound commit/reveal, then earn escrowed reimbursement and eligible outcome rewards after on-chain evaluation. |
| ERC-20 facility factory | Create and index token-denominated facilities with their own accounting and committed policies. |

Across policies, the most conservative effect wins: a favourable result cannot erase another policy's restriction.

**Evidence boundary:** the installed proof surface establishes included transactions, receipts, and logs. It does not provide current balance, account, storage, `eth_call`-result, or source-block-timestamp proofs. Credit state records event deltas and transitions; proof time is CC3 acceptance time, and valuation remains external. The event-history evaluator rejects favourable Eligible and Cured configurations.

Sources: [integration note — Horizon 1 and protocol limits](attestcoin-integration.md), [Horizon 1 technical note](HORIZON1.md).

## 9. Operator services and credit portfolios: deployed scope

| Implemented and deployed scope | What remains absent |
| --- | --- |
| Operator-service market with separately priced services, sponsor-bound acceptance, operator-bond and sponsor-payment escrow, settlement, expiry, and pull withdrawals. Reference operator with bounded scans, reorg recovery, execution gates, and durable transaction journals. | The verifier and empty market are deployed on CC3 with one dedicated project-operated EOA attestor. No operators, quotes, sponsors, settlements, or independent attestation are demonstrated. No V3 execution service is enabled; no independently qualified production service verifier, matching service, customers, reputation, or profitability evidence exists. |
| Fixed-vintage, single-asset portfolio pool with mandate checks, exact allocation, explicit loss accounting, recovery distribution, and bounded service spending. | The pool, dedicated capped factory, and zero-mode mandate are deployed; one project-funded testnet vintage allocated 100,000 rUSD to a pool-created facility that the borrower then activated. Investor and borrower are project wallets: the allocation path is demonstrated, not lender demand or external capital. No independent audit has been completed. It is not an evergreen NAV product. Lender demand, custody and legal review, valuation inputs, and real servicing history remain gates. |

The deployed Horizon 1 and current V3 Proof Jobs contracts are distinct from the operator-service market. The portfolio mandate reuses the activated release and evidence policy with no action adapter required; the allocation path has been exercised once with project-operated test tokens. There is **no design partner, no customer, no live pilot with a counterparty, no production capital deployed, and no external integration**. The capped V3 facility is an activated demo-token testnet demonstration. SDK **0.1.1 is published** for interface discovery and testnet integration; its interfaces are not frozen.

Sources: [verifier](../deployments-v3-operator-service-verifier-current.json), [market](../deployments-v3-operator-market-current.json), [portfolio](../deployments-v3-portfolio-core-current.json), [roadmap items 7, 9, and 10](ROADMAP.md), [internal review — Status and exclusions](SECURITY-REVIEW-2026-09.md#status-and-exclusions).

## 10. Security posture: internal review, not independent assurance

**No independent audit yet.** The September internal adversarial review covered V3 contracts and transitive V2 components, release and activation tooling, the operator runtime, SDK, and web surfaces.

The review records Slither **0.11.5**, **126 manually triaged findings**, and remediation of all **4 HIGH** and **15 MEDIUM** findings identified by the internal review. Static-analysis findings and review severity counts describe different sets; they are not additive assurance metrics.

For this draft, the test suites passed **392 Forge tests, 314 root Node tests, and 44 SDK tests**, followed by strict SDK declaration compilation. **One root Node test was skipped.** Coverage includes proof validation, replay resistance, policy ordering, asset conservation, loss settlement, operator recovery, deployment qualification, and SDK encoding. These results are not a substitute for independent review.

The internal review did not deploy or activate V3, install a signer, publish a package, or move capital. An independent reviewer must assess an exact clean release and produce evidence for that specific scope. The internal report cannot satisfy the independent-audit readiness gate.

Sources: [internal security review](SECURITY-REVIEW-2026-09.md), [README — Testing](../README.md#testing), [independent audit brief](SECURITY-AUDIT-BRIEF.md).

## 11. Roadmap: three horizons, explicit dependencies

| Horizon | Delivered scope | Gates to the next outcome |
| --- | --- | --- |
| **1 — Pilotable credit system; items 1–4** | Hardened V3 core deployed and qualified; capped demo-token pilot facility activated on CC3 Testnet. | No live pilot with a counterparty. Independent audit, design partner, legal review, production asset and custody decisions, and production watcher readiness remain gates. |
| **2 — Close the loop; items 5–7** | Remedy coordination, pinned USC transport, and acknowledgement/cure lifecycle built locally; registry deployed and SDK 0.1.1 published for interface discovery and testnet integration. | Items 5 and 6 remain blocked on Attestcoin writability. A verified live route, authorized receivers, acknowledgement proofs, and route-specific review are required. SDK interfaces are not frozen; no external integration exists. |
| **3 — Credit coordination; items 8–10** | Bounded multi-chain event policy deployed with V3; verifier and empty operator-service market deployed; fixed-vintage pool, dedicated factory, and zero-mode mandate deployed, with one project-funded testnet allocation and borrower activation recorded. | Item 9 uses a single project-operated attestor and demonstrates no service activity. The item 10 allocation used project wallets and test tokens; drawdown, repayment, default, and recovery evidence are not demonstrated. Audit, operator economics, lender demand, legal/custody decisions, real servicing history, and supported routes must precede market opening and capital allocation. |

Cross-chain remedies are **not delivered as a live product**. Local lifecycle code cannot establish transport availability or destination execution authority.

Source: [full roadmap and honest dependencies](ROADMAP.md).

## 12. What we are deliberately not building

- **Repayment sweeps as the headline write-back.** The intended product is bounded remedies and closed-loop servicing.
- **More chains as a milestone.** Provisioning and customer need determine expansion.
- **“Audited templates” as the vision.** Audit status belongs to an exact release or deployment; it is a gate.
- **Standalone compliance deadlines.** Freshness belongs inside verified credit state.
- **Bridges, governance, or generic messaging.** Recourse's scope is verified facts driving credit policy.
- **A universal covenant DSL in the near term.** Use versioned policy packages and typed manifests while recurring needs become clear.
- **A Recourse token or separate relayer network.** Neither is required.
- **Consumer lending as the primary framing.** The nearer thesis is programmable institutional and on-chain credit; required consumer identity, regulatory, underwriting, and collections systems do not exist here.

Source: [roadmap — Deliberate cut list](ROADMAP.md#what-we-are-deliberately-not-building), linked from the [README roadmap](../README.md#roadmap).

## 13. What would have to be true to go to production

- An **independent audit** covers the exact contracts and release intended for deployment, with remediation verified.
- A **design partner** accepts the lender-borrower workflow, bounded remedies, monitoring economics, and pilot budget.
- **Legal review** establishes the facility terms and permitted consequences.
- **Production asset and custody decisions** are complete, including who controls each programmable account and authorized receiver.
- The exact production release is deployed and qualified, and production monitoring, recovery, and incident procedures are rehearsed before value is entrusted to it. The current hardened V3 deployment and activation are on testnet.

Item 10's mandate now permits zero adapter kind (none required); nonzero kinds retain exact declaration matching. The pool, dedicated factory, and mandate are deployed, and one project-funded testnet allocation (100,000 rUSD to a pool-created facility, a 20,000 rUSD borrower bond, and borrower activation) is recorded in the allocation manifest. No remedy adapter, drawdown, repayment, default, recovery, or completed cure is demonstrated.

The target is a capped bilateral facility with meaningful servicing evidence before portfolio expansion. These are unmet gates, not implied commitments or traction. The demonstrated testnet history is not production performance.

**The proof does not release an escrow. It changes credit risk.**

Sources: [roadmap — Capped pilot and portfolio dependencies](ROADMAP.md), [security review exclusions](SECURITY-REVIEW-2026-09.md#status-and-exclusions).
