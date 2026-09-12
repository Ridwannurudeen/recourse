# Recourse — demo video runbook (target 3:20, hard cap 4:00)

Record at 1080p, one continuous screen capture with voice-over. Every claim below is backed by a URL you show on
screen; do not say anything the screen does not prove. Read every address and hash from the committed manifests and
the README's "Verify every claim in five minutes" table, never from memory. Say "V1" and "V3" out loud where the
script does: both adjudications ran on the V1 generation; the V3 core is deployed and activated but has not adjudicated a
proof yet.

## 0:00–0:40 — Open on the catch (Blockscout, the autonomous-catch transaction)
Open `https://creditcoin-testnet.blockscout.com/tx/0x96bf3081614a76c8df459eaeffe50975556883dd0e39d622758ca468f7528192`.
Show: status success, block 5,371,828, the adjudicator `0x6abB74F57c99986Ff205d4EF396Dd6d61d2659eB` (source-verified,
so the events decode), the breach event, the debt reduction and the hunter reward.
"This is a Recourse V1 facility on Creditcoin's CC3 testnet responding to Ethereum mainnet evidence. The monitored
address is Uniswap v4's shared PoolManager, an unrelated public third-party contract chosen because it is continuously
active. An unattended operator detected a real 147.41949 USDC outflow, waited for Attestcoin attestation, built the proof
and submitted this transaction with no human step. Undrawn credit froze, the bond was applied against debt, and the hunter was paid."

## 0:40–1:00 — The source event (Etherscan)
Open `https://etherscan.io/tx/0xc8481d8afbc2d439df53a6756fea1c61b0c2253703e53f4b5416d45fdbf55f79` (Ethereum block 25,832,534, position 146: the 147.41949 USDC transfer).
"This is the mainnet transaction that was proved. The covenant was committed on CC3 4 minutes 20 seconds before this
Ethereum block existed. PoolManager has no established relationship to the borrower. This demonstrates prospective
adjudication mechanics, not a borrower's covenant breach."

## 1:00–1:45 — The cumulative batch (Blockscout, the batch transaction)
Open `https://creditcoin-testnet.blockscout.com/tx/0x7c180209bedaa64b4e1acff02d2822e8c76b0db98f105b7b75e3b95ac7e5d5b6` (block 5,371,462, 699,409 gas). Then show the five source
transactions in `docs/attestcoin-integration.md`, "The adjudicated evidence".
"This is retrospective verification using an unrelated third-party wallet: the window was configured after the source blocks were mined.
Five real mainnet transfers in five blocks. The largest is 190.30 USDC, under the 232.545 cap; their verified sum is
274.79. No single transfer breaches; only the sum does. One continuity proof covers all five. The contract checks that
each receipt succeeded, that USDC itself emitted the event, derives a replay-safe index for each, and evaluates the sum
on chain. That is the depth Attestcoin makes possible."

## 1:45–2:35 — What is live today (the V3 observatory)
Open `https://recourse.gudman.xyz/v3.html`, then `https://recourse.gudman.xyz/portfolio.html`. Show the finalized
anchor, the six source-verified core contracts, the Active pilot facility with proof job 1 funded, and the portfolio
allocation.
"The hardened V3 generation is deployed from an internally reviewed commit, every runtime hash and every source is
verified, and a capped pilot facility is active with a funded proof job over the committed Ethereum source window
25,944,522 to 26,024,522. A portfolio pool allocated 100,000 test-token rUSD to a facility it created. V3 has not yet
adjudicated a proof; the adjudications you saw ran on V1."

## 2:35–3:00 — Honest limits (README, "Honest limitations")
"This is testnet software with an internal review, not an independent audit. There is no write-back to Ethereum until
Attestcoin writability ships. The pool is funded with project-operated test tokens on both sides. The operator market
is deployed and empty. The SDK is published for interface discovery, not as a frozen dependency."

## 3:00–3:20 — Close (README, "Verify every claim in five minutes")
"The evidence tables at the top of the README link the transactions, contracts, and command
to reproduce the checks. Recourse: verified conduct in, enforceable consequences out. Thank you."

## Checklist before upload
- [ ] Every address and hash on screen came from a committed manifest, the README table, or the integration note
- [ ] "V1" said for both adjudications; "V3 has not yet adjudicated a proof" said once
- [ ] PoolManager identified as an unrelated public third-party contract chosen for continuous activity; precommitment and prospective adjudication mechanics stated without claiming a borrower covenant breach
- [ ] Cumulative batch identified as retrospective verification using an unrelated third-party wallet, with its window configured after the source blocks were mined
- [ ] No "audited", "production", "customer", or "partner" wording
- [ ] Upload unlisted to YouTube; paste the URL into the DoraHacks form field "Prototype Demo Video URL"
