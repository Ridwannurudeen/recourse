# Recourse — Design Specification

**Date:** 2026-08-24
**Event:** BUIDL CTC 2026 Fall (DoraHacks), deadline 2026-09-06 23:59 ET
**Track:** DeFi
**Tagline:** Credit with consequences.
**One-liner:** Credit lines on Creditcoin governed by cryptographically enforced
covenants over the borrower's Ethereum conduct — breaches are proven by anyone,
trustlessly, via the Attestcoin Protocol, and consequences execute on-chain.

## 1. Problem and thesis

TradFi credit is governed by covenants — enforceable promises about borrower
conduct (no new debt, no asset stripping, keep positions intact). DeFi replaced
all of that with overcollateralization because chains cannot see conduct.
Attestcoin makes Ethereum conduct *provable on Creditcoin*, so covenants become
executable code instead of legal text. Recourse is a lending facility where the
covenant, the enforcement, and the consequences are all on-chain.

Positioning vs the field: 8 of 14 current entries are "prove a payment happened →
release funds." Recourse inverts the shape: adversaries prove *violations* to
trigger consequences. The proof changes lender risk, borrower terms, and capital
allocation — not merely escrow state.

## 2. Actors and economics (all on Creditcoin, CC3 Testnet)

- **Lender** funds a facility vault (demo: 1,000 tCTC) and earns interest.
- **Borrower** posts a **first-loss bond** (demo: 200 tCTC), commits named
  Ethereum positions to covenants, draws up to the facility limit, repays with
  interest. The line is NOT fully collateralized by the bond — that is the point
  (covenants substitute for collateral).
- **Hunter** (anyone) submits Attestcoin proofs of covenant violations.

**Breach consequences:** undrawn capacity freezes; the bond is slashed 80% to
the lender reserve, 20% to the hunter. Facility marked breached; borrower's
outstanding debt remains owed (repayment on Creditcoin).

Deliberate limitation, stated honestly in the submission: verified past conduct
cannot force future repayment (Attestcoin is read-only this season). The bond +
freeze + on-Creditcoin repayment obligation is the recourse mechanism; that is
why the bond is first-loss and sized relative to the line.

## 3. Covenant types (exactly three; no DSL)

All predicates are **monotonic**: a violation is conclusively provable from a
finite set of receipts. The system never claims to prove absence of activity.

1. **Cumulative treasury outflow (HERO).** "No more than N units of ERC-20 T may
   leave committed treasury address A during the covenant epoch." Hunter submits
   up to 10 proven transactions (one shared continuity proof); the adjudicator
   decodes each receipt's Transfer logs (`from == A`, token contract == T, status
   == 1), accumulates proven outflow in facility state, and triggers breach when
   the accumulated proven total crosses N. No single transfer needs to exceed N —
   the aggregation is the demonstration of depth (status, logs, tx index, replay
   keys, batch continuity all load-bearing in one adjudication).
2. **Prohibited new borrowing.** "Committed address A takes no new Aave loan
   after facility opening." Violation = one proven successful tx whose receipt
   contains an Aave V3 `Borrow` event with `onBehalfOf == A` (Sepolia Aave for
   live demo; predicate keyed by event signature + committed address).
3. **Premature LP reduction.** "Committed address A does not reduce liquidity
   position P before Creditcoin timestamp D." Violation = one proven successful
   tx with the pool's burn/decrease event for A before D (Uniswap V2 `Burn` or
   V3 `DecreaseLiquidity` signature on a committed pool/NFT id).

Covenants 2 and 3 are single-proof predicates (simple path); covenant 1 is the
multi-proof accumulator (hero path). Accepted-but-cut: proof-of-compliance
deadlines (borrower must submit evidence of required operations by a deadline;
missed deadline = breach). Documented in README as roadmap — build only if the
schedule runs ahead.

## 4. Architecture

```
contracts/
  RecourseFacility.sol      — vault, bond, draws, repayment, freeze/slash state machine
  AttestcoinAdjudicator.sol — proof intake: verifyBatch/verifySingle via injected
                              INativeQueryVerifier; decodes via EvmV1Decoder;
                              replay keys; dispatches to covenant evaluators
  covenants/
    OutflowCapCovenant.sol  — accumulator predicate (hero)
    NewBorrowCovenant.sol   — event-match predicate
    LpLockCovenant.sol      — event-match + deadline predicate
scripts/                    — TypeScript (ethers v6 + @gluwa/usc-sdk):
  prove.ts                  — fetch single/batch proofs, pre-warm fixtures
  submit.ts                 — hunter CLI: submit proofs to adjudicator
  demo-setup.ts             — deploy, fund, open facility, register covenants
web/                        — minimal dashboard (static, ethers in browser):
  facility health, covenant registry, breach evidence with decoded receipts,
  hunter leaderboard
docs/                       — this spec, README, integration summary for judges
```

Key design decisions:

- **Injected verifier.** `AttestcoinAdjudicator` takes the `INativeQueryVerifier`
  address as a constructor parameter. The precompile is runtime-native code and
  DOES NOT EXIST on local forks — unit tests inject a `MockVerifier`; only live
  CC3 integration tests touch the real one at
  `0x0000000000000000000000000000000000000FD2`.
- **Replay protection** per canonical pattern: queryId =
  `keccak256(chainKey, blockHeight, txIndex)` with txIndex derived from the
  merkle proof (`calculateTxIndex`); `mapping(bytes32 => bool) processedQueries`
  scoped per facility.
- **Status is load-bearing:** every evaluator requires `receiptStatus == 1`
  before counting a violation (a reverted attempt is not a breach). The
  precompile does not check status — we do, explicitly, and the submission
  documentation calls this out.
- **Follow, don't copy:** contracts follow the USCBase/USCMinter pattern from
  `gluwa/usc-testnet-bridge-examples` (MIT), reimplemented for our state machine
  with attribution in README. Decoding via `@gluwa/usc-contracts` v0.2.0
  (`EvmV1Decoder`: `decodeReceiptFields`, `getLogsByEventSignature`).

## 5. Verified technical foundation (live smoke-tested 2026-08-24, keyless)

- CC3 Testnet: `https://rpc.cc3-testnet.creditcoin.network`, chainId **102031**.
- Prover API: `https://prover.cc3-testnet.creditcoin.network`
  (`/api/v1/proof-by-tx/{chainKey}/{txHash}`, `/api/v1/attested-height/{chainKey}`).
- Source chains live: chainKey **1** = Sepolia (attested ~11,558,200), chainKey
  **3** = Ethereum mainnet (attested ~25,826,220). Real historical mainnet
  transactions are provable.
- Single proof: obtained in ~1s (cached attested block), `verifySingle` via
  keyless `eth_call` → `true` in ~0.3s. Proven payload confirmed to bundle the
  receipt (Transfer topics present in txBytes); `computeTransactionIndex` works.
- Batch: 3 real mainnet USDC transfers from 3 different blocks verified in ONE
  `verifyBatch` call under one shared continuity proof — via both
  `getBatchProof` (nested map: blockHeight → txIndex → entry) and per-tx proofs
  + `mergeProofs`. **Gotcha: heights must be sorted ascending before merging**,
  else the precompile reverts "Continuity chain doesn't cover maximum query
  height."
- Attestation lag is ~8 minutes for new blocks; demo therefore uses
  **pre-attested historical evidence, pre-warmed via `getProof`** (cached
  responses return in ~1s). No live-attestation waits on stage.
- Gas estimation against the precompile can fail spuriously (pallet-evm quirk);
  use the examples' fallback formula: `21000 + 5000·continuityBlocks + 20000`,
  with a 35% buffer when estimation succeeds.
- Toolchain: Foundry forge 1.7.1 installed and working on this machine
  (`~/.foundry/bin` must be added to PATH per shell). Node v24, ethers v6,
  `@gluwa/usc-sdk` v0.18.0.
- Local DNS on this network is flaky for new hostnames; scripts include an
  **env-guarded** DoH fallback resolver (`RECOURSE_DOH_FALLBACK=1`) — default
  OFF so behavior is standard on other machines.

## 6. Testing strategy

- **Unit (forge):** all facility state transitions; each evaluator against
  crafted encodedTransaction fixtures (real captured payloads from the smoke
  tests, plus synthetic edge cases: reverted receipt rejected, replayed query
  rejected, wrong token/address ignored, boundary at exactly N, batch summing).
  MockVerifier injected; no network.
- **Integration (live CC3, scripted):** deploy to CC3 Testnet, run the full
  proof pipeline against real mainnet/Sepolia evidence, assert breach fires and
  balances move. Run before demo recording and before submission.
- **Fixtures:** captured real proofs stored under `test/fixtures/` with a
  capture script so they are reproducible.

## 7. Demo (90 seconds, all evidence pre-warmed, real mainnet data)

1. (0–12s) Lender funds 1,000 tCTC facility; borrower posts 200 tCTC bond,
   commits a real Ethereum treasury address, draws 400 tCTC.
2. (12–25s) Covenant shown: ≤ 50,000 USDC may leave the treasury this epoch.
3. (25–45s) Hunter submits a batch of real mainnet transactions — each
   individually under the cap.
4. (45–62s) On-chain: batch verified against the BlockProver precompile,
   receipts decoded, statuses checked, replay keys recorded, outflows summed —
   the aggregate crosses the cap.
5. (62–78s) Breach: 600 tCTC undrawn capacity freezes; bond slashes 160/40
   lender/hunter.
6. (78–90s) Dashboard shows the ruling with the immutable mainnet evidence and
   the hunter on the leaderboard.

## 8. Schedule (hard-stop Sept 5 for owner approval + submission)

- **Aug 25–26:** contracts + unit tests green (facility, adjudicator, hero
  covenant). Aug 26 checkpoint: hero predicate adjudicating captured fixtures.
- **Aug 27–28:** covenants 2–3, hunter/prove scripts, deploy to CC3 Testnet,
  live integration test green. **Core on live testnet by Aug 28.**
- **Aug 29–31:** dashboard, polish, leaderboard, edge-case tests, docs
  (README, Attestcoin integration summary for the submission form).
- **Sept 1–2:** full-run rehearsals on live testnet; Codex audit round; fixes.
- **Sept 3–4:** demo video + deck (PDF).
- **Sept 5:** owner review, submission with explicit owner approval.

**Owner critical path (only the owner can do these):**
1. DoraHacks "Register as Hacker" on the event page (not yet done).
2. CC3 Testnet faucet tCTC to ONE owner-controlled address by ~Aug 27
   (deployment gas + demo balances; we split to lender/borrower/hunter
   addresses ourselves). Sepolia ETH only if covenant-2 live-demo txs are
   wanted; the mainnet-evidence path needs no Ethereum funds.
3. Submission-form fields: team/bio/country info, video URL, deck PDF URL.

## 9. Explicit non-goals (cut list — do not build)

Covenant DSL; flagged-address/wallet-surveillance predicates; automated Ethereum
scanning or indexers; multi-lender marketplace; credit scoring; governance or
dispute resolution; dynamic interest models; Ethereum write-back; source chains
beyond Sepolia/mainnet; insurance products; NFT/badge gamification beyond the
hunter leaderboard; production liquidation machinery.

## 10. Naming

"Covenant" is taken — covenantFi is a live DeFi credit protocol on Monad
(verified 2026-08-24). Name: **Recourse** (recourse lending = the lender's claim
beyond collateral — exactly this mechanism). Backup: **Clause**. No DeFi
collisions found for either (searched 2026-08-24).
