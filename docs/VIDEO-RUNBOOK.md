# Recourse — demo video runbook (target 3:30, hard cap 4:00)

Record at 1080p, one continuous screen capture with voice-over. Every claim below is backed by a URL you show on
screen; do not say anything the screen does not prove. Read the addresses from the committed manifests, not from
memory: `deployments.json` (v1), `deployments-horizon1.json`, `deployments-v3-current.json`, `activation-v3-current.json`,
`deployments-v3-operator-service-verifier-current.json`, `deployments-v3-operator-market-current.json`,
`deployments-v3-portfolio-core-current.json`, `allocation-v3-portfolio-current.json`.

## 0:00–0:25 — The problem (README open, "The problem" section)
"Credit runs on covenants: promises about what a borrower will and won't do after they draw. DeFi threw those
away and replaced them with over-collateralisation, because one chain can't see what a borrower does on another.
Recourse puts covenants back, enforced by cryptographic proof instead of trust."

## 0:25–0:55 — What Attestcoin lets us prove (docs/attestcoin-integration.md open)
"Attestcoin proves that an Ethereum transaction was included, and gives us its receipt and logs on Creditcoin.
It deliberately does NOT tell us whether the transaction succeeded, so Recourse checks the receipt status itself,
binds the emitting contract address, derives replay-safe transaction indices, and verifies batch continuity.
Those four checks are what make a cumulative covenant possible: no single transfer breaches the cap, only their
verified sum does."

## 0:55–1:45 — The real autonomous catch (Blockscout, facility 2 breach transaction)
Open the breach transaction 0x96bf3081… on creditcoin-testnet.blockscout.com (the hash is in
`docs/attestcoin-integration.md`, "Two deployed generations"). Show: status success, the emitting facility, the
events. Then show the mainnet treasury outflow it proved (Etherscan link from the integration note).
"This facility's policy window was configured on Creditcoin BEFORE the qualifying Ethereum block was mined. The
unattended operator watched mainnet, saw a real treasury push 147 USDC past a 100 USDC cap, waited for
attestation, built the proof and submitted the breach with no human step. Debt was reduced by the slashed bond,
undrawn credit froze, and the hunter was paid. That is a genuine cross-chain enforcement on real mainnet conduct."

## 1:45–2:40 — What is live today (Blockscout, the fresh V3 core + activated facility + the pool allocation)
Show the six V3 core addresses from `deployments-v3-current.json` (kernel, verified credit state, registry, capped
factory, multi-chain policy, proof jobs) — click the kernel, show verified runtime code. Then open the pilot facility
`0x00B50626C4AA42d22ca01AAEa8649f253aEc5B1e`: status Active, 100,000 rUSD funded, 20,000 rUSD bond, policy id 1,
proof job 1. Then open the portfolio pool `0x7dd538A9ab77a4d2953b28f3bCe710145a0eC8C2`
(`deployments-v3-portfolio-core-current.json`) and the facility it created,
`0x0C874e56AD2dC9789A63a9Bc63c08a5F6D3C82C8` (`allocation-v3-portfolio-current.json`): status Active, lender = the
pool, 100,000 rUSD funded, 20,000 rUSD bond.
"Today the hardened V3 generation is deployed from the audited commit, with every runtime hash verified, and a
capped pilot facility is active on it: a lender funded 100,000 demo-dollars, the borrower posted a 20,000 bond and
committed a live Ethereum source window that opens in the future, so any qualifying outflow during judging can be
proven and adjudicated by anyone through the permissionless proof-job market. Beside it, a portfolio pool holding
100,000 project-operated test dollars allocated the whole amount to a facility it created itself, under a mandate that
pins the same policy set the pilot runs; the operator market and its receipt verifier are deployed, with no operators
yet and a single project-operated attestor."

## 2:40–3:05 — Honest limits (docs/ROADMAP.md, items 5–10 headings)
"What this is not: it is testnet software with an internal review, not an independent audit. Cross-chain remedies
wait on Attestcoin writability, which is not live. The pool allocation you saw was funded and borrowed by project
wallets with test tokens: it proves the allocation path, not lender demand or external capital. The operator market
has no operators and one project-run attestor. The SDK is published for interface discovery, not as a frozen
dependency."

## 3:05–3:30 — Close (README top)
"Recourse is the credit-policy layer on Creditcoin: verified conduct in, enforceable consequences out. The repo,
the manifests, and every transaction shown here are public. Thank you."

## Checklist before upload
- [ ] Every address/hash on screen came from a committed manifest or the integration note
- [ ] No "audited", "production", "customer", or "partner" wording
- [ ] Upload unlisted to YouTube; paste the URL into the DoraHacks form field "Prototype Demo Video URL"
