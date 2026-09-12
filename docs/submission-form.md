# DoraHacks submission form — prepared content

Everything the BUIDL CTC 2026 Fall form asks for, ready to paste. Nothing here is
submitted automatically; the owner submits.

**Deadline:** 2026-09-13 23:59 ET (extended). Internal cut-off: Sept 12.

---

## Project Name

Recourse

## Project Sector

DeFi

## One-line vision (the BUIDL card)

Covenant-enforced credit on Creditcoin: a proven Ethereum event freezes undrawn credit, applies the bond against debt, and pays the hunter. An unattended operator did it under a covenant committed 260 seconds earlier — against a public third-party contract, so it shows prospective adjudication, not a borrower breach.

## Project Description

Recourse turns proven Ethereum conduct into enforceable credit covenants on Creditcoin's CC3 testnet.
The proof does not release an escrow. It changes credit risk.

In its documented V1 operator run, an unattended watcher detected a real 147.41949 USDC mainnet
outflow from Uniswap v4's shared PoolManager, an unrelated public third-party contract chosen for continuous activity,
built an Attestcoin proof, and submitted it without a human step, triggering a breach that froze undrawn credit, applied the borrower's bond against debt,
and paid the hunter. The covenant was committed 260 seconds before the source block existed; this demonstrates
prospective adjudication mechanics, not a borrower covenant violation. A separate historical five-transfer batch
demonstrates retrospective cumulative verification using an unrelated third-party wallet, with the window configured
after the source blocks were mined, while the newer V3 core is deployed with an activated
test-token facility and funded proof job but has not yet adjudicated a proof.
The operator market is deployed and empty; the portfolio allocation used project wallets and test tokens.
Attestcoin's documentation states that [writability](https://docs.attestcoin.org/attestcoin-protocol/attestcoin-writability) "is undergoing 3rd party testing and audits" and is not yet released on Creditcoin testnet, so cross-chain write-back is unavailable to every entrant at this stage, not a gap specific to Recourse.

What is uncommon in this field is the combination: an operator that acted unattended, a published npm SDK
([`recourse-protocol-sdk@0.1.1`](https://www.npmjs.com/package/recourse-protocol-sdk)), deployed coordination
contracts — policy kernel, proof-job market, operator market and portfolio pool — and a machine-checkable
evidence artefact. `npm run judge:verify` re-checks every public on-chain claim in roughly 30 to 45 seconds:
46 PASS, 0 FAIL, 3 UNVERIFIED on 2026-09-12. From a fresh clone run `npm ci --omit=dev` first; no Foundry,
submodules or `.env` is needed. Tests, authorship and unattended operation stay UNVERIFIED because a public
RPC cannot establish them.

The prospective adjudication: [`0x96bf3081…f7528192`](https://creditcoin-testnet.blockscout.com/tx/0x96bf3081614a76c8df459eaeffe50975556883dd0e39d622758ca468f7528192) on CC3, proving [`0xc8481d8a…bf55f79`](https://etherscan.io/tx/0xc8481d8afbc2d439df53a6756fea1c61b0c2253703e53f4b5416d45fdbf55f79) on Ethereum mainnet.

Traditional credit is governed by covenants: enforceable promises not to strip a treasury, take on
new debt, or unwind a pledged position. DeFi replaced those controls with overcollateralization
because one chain cannot see what a borrower does on another. Attestcoin makes Ethereum conduct
provable on Creditcoin, so covenants become executable code.

**Verify every claim in five minutes.** Every address and hash below is public; nothing needs a key or a wallet.

| What | Where |
| --- | --- |
| Prospective adjudication (V1 generation): the covenant was committed 4 minutes 20 seconds (260 seconds) before the source block existed; a real Ethereum mainnet outflow of 147.41949 USDC from Uniswap v4's shared PoolManager, an unrelated third-party address, was detected by the unattended operator, proven through the BlockProver precompile and adjudicated as a breach with no human step in that run. This demonstrates prospective adjudication, not a borrower covenant violation | [`0x96bf3081…f7528192`](https://creditcoin-testnet.blockscout.com/tx/0x96bf3081614a76c8df459eaeffe50975556883dd0e39d622758ca468f7528192) · CC3 block 5,371,828 · 459,396 gas · two precompile calls |
| Retrospective verification demonstration (V1 generation): the window was configured after the source blocks were already mined, using an unrelated third-party wallet; five real Ethereum mainnet transfers in five blocks, one continuity proof, six precompile calls, and an adjudicated breach on the verified sum exceeding the cap where no single transfer does | [`0x7c180209…7e5d5b6`](https://creditcoin-testnet.blockscout.com/tx/0x7c180209bedaa64b4e1acff02d2822e8c76b0db98f105b7b75e3b95ac7e5d5b6) · CC3 block 5,371,462 · 699,409 gas |
| The mainnet transaction the prospective adjudication proved | [`0xc8481d8a…bf55f79`](https://etherscan.io/tx/0xc8481d8afbc2d439df53a6756fea1c61b0c2253703e53f4b5416d45fdbf55f79) · Ethereum block 25,832,534, position 146 · 147.41949 USDC leaving Uniswap v4's shared PoolManager, the unrelated public third-party contract monitored under the precommitted covenant; no relationship to the borrower is established |
| The five mainnet source transactions behind the retrospective cumulative verification | [integration note, adjudicated evidence](https://github.com/Ridwannurudeen/recourse/blob/main/docs/attestcoin-integration.md#the-adjudicated-evidence) |
| Hardened V3 core: six contracts from reviewed commit `90d8b05`, runtime hashes verified, source verified on Blockscout; activated, no proof adjudicated yet | [`deployments-v3-current.json`](https://github.com/Ridwannurudeen/recourse/blob/main/deployments-v3-current.json) · [PolicyKernelV2](https://creditcoin-testnet.blockscout.com/address/0x69d1715F117f79aB5E190d48666510B8A39Af6dB) |
| Capped pilot facility, Active, proof job 1 funded, Ethereum source window 25,944,522–26,024,522 | [`activation-v3-current.json`](https://github.com/Ridwannurudeen/recourse/blob/main/activation-v3-current.json) · [facility](https://creditcoin-testnet.blockscout.com/address/0x00B50626C4AA42d22ca01AAEa8649f253aEc5B1e) |
| Portfolio pool allocation of 100,000 rUSD to a pool-created facility, project-funded test tokens on both sides | [`allocation-v3-portfolio-current.json`](https://github.com/Ridwannurudeen/recourse/blob/main/allocation-v3-portfolio-current.json) · [facility](https://creditcoin-testnet.blockscout.com/address/0x0C874e56AD2dC9789A63a9Bc63c08a5F6D3C82C8) |
| Operator market and receipt verifier, deployed and empty, one project-operated attestor | [`deployments-v3-operator-market-current.json`](https://github.com/Ridwannurudeen/recourse/blob/main/deployments-v3-operator-market-current.json) · [`deployments-v3-operator-service-verifier-current.json`](https://github.com/Ridwannurudeen/recourse/blob/main/deployments-v3-operator-service-verifier-current.json) |
| Live read-only V3 and portfolio observatories, every read anchored at a finalized CC3 block (the site root is a static evidence page; the V1 wallet application is at `/v1.html`) | <https://recourse.gudman.xyz/v3.html> · <https://recourse.gudman.xyz/portfolio.html> |
| Tests | `forge test` → 392 · `node --test test/*.test.mjs` → 411 (410 pass, 1 skipped) · `npm --prefix sdk test` → 44 |
| SDK | [`recourse-protocol-sdk@0.1.1`](https://www.npmjs.com/package/recourse-protocol-sdk) |
| Deck | [`docs/RECOURSE-DECK.pdf`](https://github.com/Ridwannurudeen/recourse/blob/main/docs/RECOURSE-DECK.pdf) |

22 of the 25 Recourse contracts on CC3 are source-verified on Blockscout, including all six current V3 core contracts, both V3 facilities and the five V1 contracts that executed both adjudications, so the explorer decodes their events without trusting this repository. The three still unverified are Horizon 1's kernel, demonstration facility and credit state.

**What the consequence is**

The Attestcoin Protocol makes Ethereum conduct provable on Creditcoin, so covenants become
executable code. A lender funds a facility; a borrower posts a penalty bond, commits named
Ethereum positions to covenants, and draws credit against them. Then anyone — permissionlessly
— can prove a violation by submitting an Attestcoin proof of the offending Ethereum
transaction. The contract verifies it against the BlockProver precompile, decodes the receipt,
and executes the consequences on-chain: undrawn capacity freezes, the bond is slashed against
outstanding debt, and the hunter who caught it is paid.

Up to 80% of the bond reduces outstanding debt, capped by that debt; the unused share returns
to the borrower, and 20% rewards the hunter.

The hero covenant is a cumulative one, demonstrated retrospectively. No single proven transfer breaches the cap — only
their verified sum does. Verifying that requires transaction status, event logs, transaction
indices and batch continuity to all be verified on-chain inside a single adjudication.

The proof does not release an escrow. It changes credit risk.

**What is live, and what it is not**

The original and Horizon 1 generations are live on CC3 alongside the hardened V3 core.
The internally reviewed v1 contracts enforce the original
covenant facility, including prospective adjudication of an outflow from the unrelated third-party PoolManager: its policy window was
configured on CC3 before the qualifying Ethereum block was mined, then the unattended
operator detected the USDC outflow, built the Attestcoin proof, and submitted the breach. This does not establish borrower conduct.
Horizon 1 adds a graded policy kernel, event-derived Verified Credit State, a permissionless
commit/reveal proof-job market, and an ERC-20 facility factory. Seven Horizon 1 contracts are
deployed on CC3 around an Active demonstration facility denominated in a fixed-supply testnet
token. The contracts have not been independently audited.

The hardened V3 core is now deployed and qualified on CC3 Testnet: the current
[core manifest](https://github.com/Ridwannurudeen/recourse/blob/main/deployments-v3-current.json) records six contracts from reviewed
source commit `90d8b05af38940ffeb55d974401641a327176b9e`, with all six runtime code
hashes verified. The historical `deployments-v3.json` core remains inactive and superseded.
The [activation manifest](https://github.com/Ridwannurudeen/recourse/blob/main/activation-v3-current.json) records capped facility
`0x00B50626C4AA42d22ca01AAEa8649f253aEc5B1e` as Active, policy 1, registry release
`0xad31a01779b7c8c8651e1fecbb15b6d177c25dbd637c99d7496c2c2a0b7d221a`, and proof job 1.
Its Ethereum source window is 25,944,522–26,024,522, maturity is CC3 block 5,554,121,
and proof-job expiry is Unix timestamp 1792497600. This is a fixed-supply demo-token
testnet demonstration with no draw recorded. There is no design partner, live pilot
with a counterparty, independent audit, or production asset or custody decision.
Items 5–6 remain blocked on Attestcoin writability. SDK 0.1.1 is published for interface
discovery and testnet integration; interfaces are not frozen and no external integration exists.
The [verifier manifest](https://github.com/Ridwannurudeen/recourse/blob/main/deployments-v3-operator-service-verifier-current.json) records
OperatorServiceVerifierV1 `0x44B3e639722650902a11EB26151cBaB039f67a23`;
the [market manifest](https://github.com/Ridwannurudeen/recourse/blob/main/deployments-v3-operator-market-current.json) records
OperatorMarketV1 `0x649A73302861fcDf641Aa4cBe5e7eD58d0363337`, deployed and empty.
One dedicated project-operated EOA attestor serves the verifier; no operators, quotes,
sponsors, settlements, or independent attestation are demonstrated.
The [portfolio core manifest](https://github.com/Ridwannurudeen/recourse/blob/main/deployments-v3-portfolio-core-current.json) records
PortfolioPoolV1 `0x7dd538A9ab77a4d2953b28f3bCe710145a0eC8C2`, its dedicated
CappedPilotFactoryV1 `0xA5997C4c212eE27B774a7dBa1E5081a9355A16c0`, and
PortfolioMandateV1 `0x49306adA3decC50D08D11B403A120cd6FD5501D3`, deployed and
qualified initially in Configuring state against the activated release and evidence policy.
The mandate requires no action adapter in zero-kind mode; nonzero kinds retain exact
matching. The subsequent [allocation manifest](https://github.com/Ridwannurudeen/recourse/blob/main/allocation-v3-portfolio-current.json)
records a project-funded testnet pool allocation of 100,000 rUSD to newly created
pool-owned facility `0x0C874e56AD2dC9789A63a9Bc63c08a5F6D3C82C8`, backed by a
20,000 rUSD borrower bond and issuer-attested policy deployment. The borrower then
activated the facility; the pool and facility were verified Active at block 5,460,383.
Investor and borrower are project wallets using project-operated test tokens.
The read-only V3 and portfolio observatories at <https://recourse.gudman.xyz/v3.html> and
<https://recourse.gudman.xyz/portfolio.html> read this state live from CC3 at a finalized block and
link every manifest quoted here; the site root is a static evidence page and the V1 wallet application is at `/v1.html`. This
shows the allocation path, not lender demand, external capital, servicing performance,
profitability, production readiness, completed cures, or audited loss accounting.

## Attestcoin Protocol Integration Summary

Recourse uses Attestcoin as the evidence and adjudication layer for its deployed generations.

A hunter submits several real Ethereum mainnet transactions in one batch, sharing a single
continuity proof. The adjudicator calls the BlockProver precompile's `verify` to establish
inclusion and continuity, then decodes each receipt on-chain with `EvmV1Decoder`. Four things
are load-bearing:

1. **Receipt status.** The precompile explicitly does not validate whether a transaction
   succeeded, so every evaluator requires `receiptStatus == 1` itself. A reverted attempt is
   not a breach.
2. **Event logs.** The covenant reads `Transfer` topics and data straight from the proven
   bytes, and requires the emitting contract address to match the committed token — an event
   signature alone is forgeable by any contract.
3. **Transaction indices.** `calculateTxIndex` feeds a replay key of
   `keccak256(chainKey, blockHeight, txIndex)`, scoped per facility and per covenant, with a
   second covenant-local key preventing the same evidence being counted twice through an
   aliased registration.
4. **Batch continuity.** Five transactions in five distinct blocks across a 35-block span
   verify under one shared continuity proof in a single call. Proof size is not static:
   every proof runs up to a common moving checkpoint, so roots grow as the chain advances
   past fixed historical evidence. When observed on 2026-08-25, the five transactions had
   76 roots, measured 10,752 bytes by the repository's proof-plus-receipt approximation,
   and produced 15,044 bytes of full ABI calldata.

The cumulative predicate is what makes this depth necessary rather than decorative. A
centralized oracle could report the same facts, but a bonded credit consequence backed by an
oracle that can collude with the borrower is worth nothing. The trustlessness is the product.

Horizon 1 generalizes that path. The kernel verifies and decodes proven Ethereum receipts,
maps accepted event evidence to graded outcomes from Watch through Breached, applies the
most conservative result across policies, and records the observation in Verified Credit
State. Permissionless operators compete for escrowed proof jobs through hunter-bound
commit/reveal, so evidence is reserved before disclosure and rewarded only after on-chain
evaluation. The ERC-20 factory makes the same machinery reusable across token-denominated
facilities.

The shipped interfaces also define the boundary precisely: Attestcoin proves transaction
inclusion and encoded transaction, receipt, and log data. It does not expose account,
balance, storage, `eth_call`-result, or source-block-timestamp proofs. Horizon 1 therefore
records proven event deltas and transitions rather than verified current balances; proof
time is CC3 acceptance time, and asset valuation remains external.

Live on CC3 Testnet, adjudicated against real Ethereum mainnet transactions. The cumulative
retrospective adjudication succeeded at CC3 block 5,371,462 and used 699,409 gas; the unattended prospective adjudication succeeded at
block 5,371,828 and used 459,396 gas (transaction `0x96bf3081614a76c8df459eaeffe50975556883dd0e39d622758ca468f7528192`).

Full technical detail: `docs/attestcoin-integration.md` in the repository.

## GitHub Repository URL

https://github.com/Ridwannurudeen/recourse

## Project Deck or Whitepaper (PDF URL)

https://github.com/Ridwannurudeen/recourse/blob/main/docs/RECOURSE-DECK.pdf
The owner reviews `docs/RECOURSE-DECK.pdf` before pasting the URL into the form.

## Prototype Demo Video URL

*(owner action)*

## Project Logo

Optional. Not currently produced.

---

## Team Information

Solo entry. Owner must supply: First & Last Name, Email, Short Bio, Role within the team,
Country of Residence, Country of Citizenship. Telegram / X / LinkedIn / Resume are optional.

---

## Eligibility declarations

The form requires confirming: no criminal record, no pending criminal cases, not a resident
of a sanctioned country, not a sanctioned individual, and legally permitted to participate.
Owner confirms these personally.

## Project requirements checklist

- [x] Original work created during the hackathon
- [x] Deployed on a testnet (CC3 Testnet, chainId 102031)
- [x] Integrates the Attestcoin Protocol as a core feature
- [x] Does not infringe third-party IP (permissively licensed dependencies, required notices retained)
- [x] Public GitHub repository with README
- [ ] Demo video — owner action
- [x] Deck / whitepaper PDF — docs/RECOURSE-DECK.pdf (owner reviews before pasting the URL)
