# Recourse — Design Specification (v2, post-audit)

**Date:** 2026-08-24 (v2 same day, after Codex audit round: 18 findings incorporated)
**Event:** BUIDL CTC 2026 Fall (DoraHacks), deadline 2026-09-06 23:59 ET
**Track:** DeFi
**Tagline:** Credit with consequences.
**One-liner:** An **undercollateralized, covenant-enforced credit facility** on
Creditcoin: covenants over the borrower's Ethereum conduct are enforced by
anyone, trustlessly, via Attestcoin proofs, and the consequences execute
on-chain.

## 1. Problem and thesis

TradFi credit is governed by covenants — enforceable promises about borrower
conduct. DeFi replaced them with overcollateralization because chains cannot
see conduct. Attestcoin makes Ethereum conduct *provable on Creditcoin*, so
covenants become executable code. Recourse is a lending facility where the
covenant, its enforcement, and its consequences are all on-chain.

Positioning vs the field: 8 of 14 current entries are "prove a payment happened
→ release funds." Recourse inverts the shape: adversaries prove *violations* to
trigger consequences. The proof changes lender risk, borrower terms, and
capital allocation — not merely escrow state.

Honest claim discipline (submission language): this is secured risk mitigation
via penalty bond + draw freeze + permanent default record — NOT legal recovery
beyond assets the contract holds. Verified past conduct cannot force future
repayment (Attestcoin is read-only this season); we say so explicitly.

## 2. Actors, economics, and the facility state machine

Actors: **Lender** funds the facility vault (demo: 1,000 tCTC). **Borrower**
posts a **penalty bond** (demo: 200 tCTC), commits named Ethereum positions,
draws, repays. **Hunter** (anyone) submits violation proofs.

**Interest (immutable, simple):** a fixed fee in basis points charged per draw
(demo: 200 bps), added to outstanding debt at draw time and accruing to the
**lender** as their return. No accrual model, no origination fee, no protocol
treasury — v1 has exactly one fee. (An earlier draft also specified an
origination fee; it was cut because it required a treasury and a fee-recipient
decision that contradicted the lender-earns-fees rule, for no demo value.)

**State machine (exact):**

```
Created ──(lender funds + borrower bonds + both consent)──> Active
Active ──(debt repaid in full, maturity not passed)────────> Repaid
Active ──(adjudicator reports first breach)────────────────> Breached
Active ──(maturity passes with debt outstanding)───────────> Defaulted
Created ──(either party exits before activation)───────────> Cancelled
```

- **Created:** configuration assembled (facility size, bond size, rate, fees,
  maturity, covenant set with all parameters). Both lender and borrower must
  consent to the *complete* configuration; all terms freeze at activation.
- **Active:** borrower draws via **two-stage draws** (front-running defense,
  audit finding 3): `requestDraw(amount)` → fixed challenge delay (demo: 10
  Creditcoin blocks ≈ 2.5 min) → `executeDraw()` succeeds only if the facility
  is still Active. Attestation lag + draw delay is the lender's documented
  detection window. Repayment allowed any time; overpayment refunded.
- **Breached:** single guarded transition (idempotent, finding 8). Only the
  transaction moving Active → Breached pays the hunter and performs slash
  accounting; later proof submissions revert. Undrawn capacity freezes.
  **Slash accounting (finding 5):** bond splits 80/20. The lender's 80%
  (160 tCTC) is applied **dollar-for-dollar against outstanding debt, capped by
  that debt**; any excess bond is returned to the borrower at closure. The
  hunter's 20% (40 tCTC) is the explicit breach penalty. No lender windfall:
  a borrower who repays after breach owes debt minus the applied slash.
- **Repaid / Defaulted / Breached — closure and withdrawals.** All three are
  terminal states for *credit* purposes (no further draws, ever), but repayment
  stays open in `Breached` and `Defaulted` so the borrower can still clear the
  debt and the record. Two claim paths, each callable once the facility is in
  any terminal state:
  - `lenderWithdraw` pays the lender everything the contract holds on their
    behalf: undrawn principal + repayments received + any slash applied against
    debt. Over the life of a facility the lender nets their principal plus the
    draw fees actually charged, and never more.
  - `claimBorrowerRefund` pays the borrower their bond remainder: in `Repaid`
    the whole bond; after a breach, only `lenderShare - debtReduction` (zero
    whenever the debt was at least the lender's 80% share).
- **Cancelled:** before activation either party may `cancel`, which refunds
  whatever each has deposited. No fees, no penalties.
- Authorization: only the configured borrower draws/repays; only the configured
  lender withdraws; only the adjudicator reports breaches; addresses fixed at
  activation. Checks-effects-interactions around all native-token transfers.
  Invariants (tested): total facility assets conserved; bond distributed at
  most once; the contract can never owe more than it holds.

**Worked example (the demo numbers, so the arithmetic is unambiguous).** Lender
funds 1,000; borrower bonds 200; contract holds 1,200. Borrower draws 400 at
200 bps, so debt = 408 and the contract holds 800. Breach: hunter is paid 40
(20% of bond); the lender's 160 (80%) reduces debt to 248; excess bond is
`160 - 160 = 0`. Contract now holds 760 = 600 undrawn + 160 slash. Borrower
repays 248; contract holds 1,008; lender withdraws 1,008 = 1,000 principal +
8 draw fee. The borrower's net cost is 48 — the 8 fee plus the 40 hunter
penalty — and the 160 is never paid twice.

## 3. Covenant types (exactly three; no DSL)

All predicates are **monotonic** (violation conclusively provable from a finite
set of receipts; never claims to prove absence). All covenant windows are
expressed in **source-chain block heights** — `startSourceBlock` /
`endSourceBlock` (finding 1) — because receipts carry no wall-clock time.
Every covenant stores: chainKey, the exact **protocol contract address that
must be `log.address`** (finding 6 — event signatures alone authenticate
nothing), the committed borrower address/position, and its window. All frozen
at activation.

1. **Cumulative treasury outflow (HERO).** "No more than `cap` base units of
   ERC-20 `T` may leave committed treasury `A` within
   [startSourceBlock, endSourceBlock]." Exact semantics (finding 9): count
   every Transfer log in a proven receipt where `log.address == T`,
   `from == A`, `to != A` (self-transfers excluded; burns count; inbound never
   nets); sum with checked arithmetic across all submitted receipts into the
   facility's accumulator; breach strictly when `accumulated > cap`. Hunter
   submits up to 10 proven transactions under one shared continuity proof; no
   single transfer needs to exceed the cap. Status, logs, tx-index replay keys,
   and batch continuity are all load-bearing in one adjudication.
2. **Prohibited new borrowing.** Violation = one proven successful tx whose
   receipt contains an Aave V3 `Borrow` event **emitted by the committed Aave
   V3 Pool contract address** with `onBehalfOf == A`, within the window.
   (Sepolia Aave V3 Pool for the live-made evidence.)
3. **Premature LP reduction.** **Uniswap V3 only** (finding 7 — V2 Burn cannot
   attribute ownership): violation = one proven successful tx with a
   `DecreaseLiquidity` event **emitted by the committed NonfungiblePositionManager
   address** for the committed `tokenId`, before `endSourceBlock`.

Roadmap-only (README, not built): proof-of-compliance deadlines; hunter
commit/reveal (see §4 MEV note).

## 4. Architecture

```
contracts/
  RecourseFacility.sol      — state machine of §2: vault, bond, two-stage draws,
                              repayment, slash accounting, withdrawals
  AttestcoinAdjudicator.sol — proof intake: verifySingle/verifyBatch via injected
                              INativeQueryVerifier; EvmV1Decoder decoding;
                              replay keys; dispatch to covenant evaluators
  covenants/
    OutflowCapCovenant.sol  — accumulator predicate (hero)
    NewBorrowCovenant.sol   — event-match predicate
    LpLockCovenant.sol      — event-match + window predicate
scripts/ (TypeScript, ethers v6 + @gluwa/usc-sdk)
  prove.ts                  — fetch single/batch proofs, pre-warm fixtures
  submit.ts                 — hunter CLI
  demo-setup.ts             — deploy, fund, open facility, register covenants
web/                        — static dashboard reading contracts directly:
                              facility health, covenant registry, breach
                              evidence with decoded receipts
docs/                       — this spec, README, integration summary for judges
test/fixtures/              — captured real proof payloads + capture script
```

Key decisions:

- **Injected verifier.** The precompile is runtime-native and DOES NOT exist on
  local forks. `AttestcoinAdjudicator` takes `INativeQueryVerifier` as a
  constructor param; unit tests inject `MockVerifier`; live CC3 integration
  tests use `0x0000000000000000000000000000000000000FD2`.
- **Replay scoping (finding 4):** key = `(facilityId, covenantId, queryId)`
  where queryId = `keccak256(chainKey, blockHeight, txIndex)`. A receipt is
  marked processed **only on successful semantic evaluation** by that covenant;
  receipts irrelevant to the targeted covenant revert (never consumed). One
  transaction may therefore be evaluated against multiple covenants.
- **Status is load-bearing:** every evaluator requires `receiptStatus == 1`.
  The precompile does not check this; we do, and the submission docs say so.
- **Hunter MEV, disclosed:** proofs are public; a pending hunter tx can be
  copied and outbid. v1 ships WITHOUT commit/reveal and discloses
  proof-stealing/MEV as a known limitation (finding 11's fallback), keeping
  scope solo-sized. Commit/reveal is documented roadmap.
- **Follow, don't copy:** contracts follow the USCBase/USCMinter pattern from
  `gluwa/usc-testnet-bridge-examples` (MIT), reimplemented for our state
  machine, with attribution. Decoding via `@gluwa/usc-contracts` v0.2.0.

## 5. Verified technical foundation (live smoke-tested 2026-08-24, keyless)

- CC3 Testnet: `https://rpc.cc3-testnet.creditcoin.network`, chainId **102031**.
- Prover API: `https://prover.cc3-testnet.creditcoin.network`
  (`/api/v1/proof-by-tx/{chainKey}/{txHash}`, `/api/v1/attested-height/{chainKey}`).
- Source chains live: chainKey **1** = Sepolia (attested ~11,558,200), chainKey
  **3** = Ethereum mainnet (attested ~25,826,220). Historical mainnet
  transactions are provable.
- Single proof ~1s (attested block, cached); `verifySingle` via keyless
  `eth_call` → `true` in ~0.3s; receipt (with Transfer topics) confirmed inside
  txBytes; `computeTransactionIndex` works.
- Batch: 3 real mainnet USDC transfers from 3 different blocks verified in ONE
  `verifyBatch` under one shared continuity proof — via both `getBatchProof`
  (nested map blockHeight → txIndex → entry) and per-tx proofs + `mergeProofs`.
  **Gotcha: heights ascending before merging**, else revert "Continuity chain
  doesn't cover maximum query height."
- Attestation lag ~8 min for new blocks → all demo evidence is pre-attested and
  pre-warmed via `getProof` (cached ≈ 1s).
- Gas: estimation against the precompile can fail spuriously (pallet-evm
  quirk). The examples' fallback formula covers verification only — the full
  `submitBatch` (decode + accumulate + slash) costs more (finding 14):
  **measure gas of the complete deployed flow during integration testing, set a
  tested explicit ceiling with margin, and keep a 2–3-receipt backup batch that
  still crosses the cap.**
- Toolchain: Foundry forge 1.7.1 installed and working (add `~/.foundry/bin`
  to PATH per shell). Node v24, ethers v6, `@gluwa/usc-sdk` v0.18.0.
- Local DNS flaky for new hostnames on this network; scripts include an
  env-guarded DoH fallback (`RECOURSE_DOH_FALLBACK=1`, default OFF).

## 6. Demo evidence plan (Build Task 0 — locked before contracts, finding 13)

Day one of build produces `docs/demo-evidence.md` locking, for the hero
covenant: chainKey, treasury address, token, covenant window
[startSourceBlock, endSourceBlock], the exact tx hashes (≤10, each transfer
under the cap, cumulative over it), amounts, expected queryIds, expected total,
and continuity-proof span. Acceptance: `prove.ts` pre-warms all of them and a
scripted `verifyBatch` eth_call returns true.

**Evidence honesty (finding 1):** historical mainnet evidence predates any
facility we open during the hackathon. The demo therefore either (a) opens the
facility with a covenant window covering the historical range and labels the
run "historical simulation over real mainnet data," or (b) uses Sepolia
evidence we create AFTER activation (covenants 2–3 path). The video says which
one is on screen. We never imply historical conduct occurred after funding.

## 7. Testing strategy

- **Unit (forge, MockVerifier, no network):** every state transition of §2;
  each evaluator against captured-real + synthetic fixtures. Mandatory cases
  (finding 18): reverted receipt rejected; replayed query rejected (and
  duplicate queryIds *within one batch*); wrong token/address ignored; boundary
  exactly-at-cap vs over-cap; batch partial relevance; post-breach submission
  reverts; same receipt evaluated by two covenants; zero-debt breach;
  overpayment refund; draw request before/after breach; failed native transfer
  handling. Invariants: asset conservation; bond distributed at most once.
- **Integration (live CC3):** deploy, run the full pipeline on real evidence,
  assert breach + balance movements + measured gas. Run before demo recording
  and before submission.

## 8. Demo runbook (90 s, finding 17)

Starts from a **pre-deployed, funded, bonded, drawn facility** (those txs shown
via explorer links) — the only live action is the hunter's batch submission.

1. (0–15s) Facility on dashboard: 1,000 tCTC funded, 200 bond, 400 drawn,
   covenant: ≤ 50,000 USDC (base units) out of treasury A in window W.
2. (15–35s) Hunter submits the locked batch of real mainnet transactions —
   each individually under the cap.
3. (35–60s) On-chain adjudication: batch verified against the BlockProver
   precompile, receipts decoded, statuses checked, replay keys recorded,
   outflows summed — aggregate crosses the cap.
4. (60–80s) Breach: undrawn 600 freezes; bond slashes 160 against debt / 40 to
   hunter; dashboard shows the ruling + immutable mainnet evidence.
5. (80–90s) The claim: covenants, enforced by proof, not trust.

Backups: a second funded facility standing by + an uninterrupted pre-recorded
run.

## 9. Schedule (solo; hard freezes per finding 15)

- **Aug 25:** Build Task 0 (evidence lock) + repo scaffold + facility state
  machine with unit tests.
- **Aug 26–27:** adjudicator + hero covenant green on fixtures; deploy to CC3;
  **hero live end-to-end transaction on testnet.**
- **Aug 28:** **HERO FEATURE FREEZE.** Covenants 2–3 begin only now (they are
  additive single-proof evaluators).
- **Aug 29–30:** covenants 2–3 + dashboard. **Aug 30: CONTRACT FREEZE.**
- **Aug 31–Sept 2:** defects, docs, README, integration summary, measured-gas
  ceilings, rehearsals; Codex code audit round.
- **Sept 3–4:** demo video + deck (PDF).
- **Sept 5:** owner review; submission only with explicit owner approval.

First cut under pressure: hunter leaderboard, then covenant 3, then covenant 2.
The hero facility alone is a complete submission.

**Owner critical path:**
1. DoraHacks "Register as Hacker" (not yet done).
2. CC3 Testnet faucet tCTC to ONE owner address by ~Aug 26 (we split to
   lender/borrower/hunter ourselves). Sepolia ETH only if covenant-2/3 live
   evidence is wanted; the mainnet hero path needs no Ethereum funds.
3. Sept 5: submission-form fields (team info, video URL, deck PDF URL) and
   final approval.

## 10. CEIP commercialization note (documentation-only, finding 16)

Target segment: DAO treasuries and trading firms borrowing working capital
against *conduct* instead of posting 150% collateral. Creditcoin is the
settlement venue because adjudication must be cheap, fast (~15 s
verification), and oracle-free. Parameters are negotiated bilaterally
(lender sets covenant menu; borrower consents; both freeze at activation).
Revenue in v1 is the draw fee (bps per draw), which accrues to the lender as
their return; a protocol cut of that fee is the production revenue line and is
deliberately not implemented here. Lender loss model: penalty bond first-loss against debt,
then unsecured exposure priced into the rate. Production path requires:
Attestcoin writability (auto-repayment sweeps), more source chains, hunter
commit/reveal, and covenant templates audited per protocol integrated.

## 11. Explicit non-goals (do not build)

Covenant DSL; flagged-address surveillance; automated Ethereum indexers;
multi-lender marketplace; credit scoring; governance/dispute resolution;
dynamic interest accrual; Ethereum write-back; source chains beyond
Sepolia/mainnet; insurance; hunter commit/reveal (disclosed limitation);
NFT/badge gamification; production liquidation machinery.

## 12. Naming

"Covenant" is taken (covenantFi live on Monad, verified 2026-08-24). Name:
**Recourse** (backup: **Clause**); no DeFi collisions found for either
(searched 2026-08-24).
