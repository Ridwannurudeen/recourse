# DoraHacks submission form — prepared content

Everything the BUIDL CTC 2026 Fall form asks for, ready to paste. Nothing here is
submitted automatically; the owner submits.

**Deadline:** 2026-09-13 23:59 ET (extended). Internal cut-off: Sept 12.

---

## Project Name

Recourse

## Project Sector

DeFi

## Project Description

Recourse is an undercollateralized credit facility on Creditcoin where the loan covenants
are enforced by cryptographic proof instead of trust.

Traditional credit is governed by covenants — enforceable promises about borrower conduct
("don't strip the treasury", "don't take on new debt", "keep the position intact"). DeFi
threw that away and replaced it with overcollateralization, because a blockchain cannot see
what a borrower does anywhere else.

The Attestcoin Protocol makes Ethereum conduct provable on Creditcoin, so covenants become
executable code. A lender funds a facility; a borrower posts a penalty bond, commits named
Ethereum positions to covenants, and draws credit against them. Then anyone — permissionlessly
— can prove a violation by submitting an Attestcoin proof of the offending Ethereum
transaction. The contract verifies it against the BlockProver precompile, decodes the receipt,
and executes the consequences on-chain: undrawn capacity freezes, the bond is slashed against
outstanding debt, and the hunter who caught it is paid.

Up to 80% of the bond reduces outstanding debt, capped by that debt; the unused share returns
to the borrower, and 20% rewards the hunter.

The hero covenant is a cumulative one. No single proven transfer breaches the cap — only
their verified sum does. Catching that requires transaction status, event logs, transaction
indices and batch continuity to all be verified on-chain inside a single adjudication.

The proof does not release an escrow. It changes credit risk.

The original and Horizon 1 generations are live on CC3 alongside the hardened V3 core.
The team-audited v1 contracts enforce the original
covenant facility, including a real autonomous mainnet catch: its policy window was
configured on CC3 before the qualifying Ethereum block was mined, then the unattended
operator detected the USDC outflow, built the Attestcoin proof, and submitted the breach.
Horizon 1 adds a graded policy kernel, event-derived Verified Credit State, a permissionless
commit/reveal proof-job market, and an ERC-20 facility factory. Seven Horizon 1 contracts are
deployed on CC3 around an Active demonstration facility denominated in a fixed-supply testnet
token. The contracts have not been independently audited.

The hardened V3 core is now deployed and qualified on CC3 Testnet: the current
[core manifest](../deployments-v3-current.json) records six contracts from reviewed
source commit `90d8b05af38940ffeb55d974401641a327176b9e`, with all six runtime code
hashes verified. The historical `deployments-v3.json` core remains inactive and superseded.
The [activation manifest](../activation-v3-current.json) records capped facility
`0x00B50626C4AA42d22ca01AAEa8649f253aEc5B1e` as Active, policy 1, registry release
`0xad31a01779b7c8c8651e1fecbb15b6d177c25dbd637c99d7496c2c2a0b7d221a`, and proof job 1.
Its Ethereum source window is 25,944,522–26,024,522, maturity is CC3 block 5,554,121,
and proof-job expiry is Unix timestamp 1792497600. This is a fixed-supply demo-token
testnet demonstration with no draw recorded. There is no design partner, live pilot
with a counterparty, independent audit, or production asset or custody decision.
Items 5–6 remain blocked on Attestcoin writability. SDK 0.1.0 is published for interface
discovery and testnet integration; interfaces are not frozen and no external integration exists.
Item 9's operator market remains undeployed: no deployment path produces its required
`operator-service-verifier-v1` prerequisite manifest, and the verifier's attestor is a
governance decision. Item 10's portfolio pool is deliberately undeployed at a design gate:
its mandate requires a nonzero action-adapter kind declared by the facility's registry
release, but the activated release declares none while items 5–6 await Attestcoin writability.
A pool deployed today could not allocate to this facility (`MissingActionAdapter`).

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

Live on CC3 Testnet, adjudicated against real Ethereum mainnet transactions. The breach
succeeded at CC3 block 5,371,462 and used 699,409 gas.

Full technical detail: `docs/attestcoin-integration.md` in the repository.

## GitHub Repository URL

https://github.com/Ridwannurudeen/recourse

## Project Deck or Whitepaper (PDF URL)

*(owner action)*

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
- [ ] Deck / whitepaper PDF — owner action
