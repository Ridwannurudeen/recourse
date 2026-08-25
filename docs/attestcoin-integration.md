# Attestcoin integration

Recourse depends on Attestcoin for adjudication, not for a peripheral trigger. Its central covenant is cumulative: no individual transfer violates the facility's terms, so the breach exists only if several Ethereum receipts can be verified, decoded, indexed, replay-protected, and added together inside one Creditcoin transaction. Replacing any of those steps with an assertion from the borrower or a trusted oracle removes the security property the credit consequence relies on.

## The adjudicated evidence

The live CC3 facility committed Ethereum mainnet USDC, treasury `0xbaa67174531f0c031f91a373f6788c7e821af2c5`, and source blocks 25,826,525 through 25,826,559. The five receipts are successful Ethereum transactions with one USDC `Transfer` log each:

| Ethereum transaction | Block | Proven outflow |
| --- | ---: | ---: |
| [`0xa44c5e3f…e2f5dcaa`](https://etherscan.io/tx/0xa44c5e3f40201583bfa3329b8b4da1851c34f4dbabcc723743c4ca82e2f5dcaa) | 25,826,525 | 8.58 USDC |
| [`0x2456f121…c13b0d8b`](https://etherscan.io/tx/0x2456f121b5402fb3cd42ea45714f4072965b6ef1b85a05f0e3a67e78c13b0d8b) | 25,826,526 | 31.24 USDC |
| [`0x1c9a4bf9…8218addc`](https://etherscan.io/tx/0x1c9a4bf94a28bd8b7da9e676e2259b05a0cce7815c757b1fa77ef8588218addc) | 25,826,544 | 190.30 USDC |
| [`0xbddccb82…117fdc9`](https://etherscan.io/tx/0xbddccb82e91cf16def50c3bad6003b4b6e7e68f8d2c35541d0890bdcc117fdc9) | 25,826,548 | 14.58 USDC |
| [`0xb2289468…7855465`](https://etherscan.io/tx/0xb22894683c336ffd74ad115b705babd9e60bb1df40444f160eb6248067855465) | 25,826,559 | 30.09 USDC |
| **Cumulative** | **35-block inclusive span** | **274.79 USDC** |

The operative inequality is:

```text
largest single transfer        covenant cap        verified cumulative outflow
       190.30 USDC       <       232.545 USDC       <       274.79 USDC
```

There is no single offending receipt. The violation is the verified aggregate.

## One batch, one continuity proof, one adjudication

The hunter submits five block heights, five encoded transactions, five Merkle proofs, and one shared continuity proof to `AttestcoinAdjudicator.submitBatch`. The adjudicator makes one call to the BlockProver precompile's batch `verify` overload before it interprets any receipt or changes replay state.

The five transactions occupy five distinct, non-contiguous blocks across the 35-block span. We exercised both proof-building paths and found a more precise rule than “batch supports gaps, merge requires adjacency”:

- `getBatchProof` builds the batch directly for non-contiguous transaction blocks.
- `mergeProofs` succeeds when each proof's covered block range reaches the next proof's start block. A proof starting at height `H` covers `[H, H + roots.length - 1]`; literal adjacency is not required.
- On 2026-08-25, the individual proofs for blocks 25,826,525 / 526 / 544 / 548 / 559 had 76 / 75 / 57 / 53 / 42 roots. Every range ended at the common checkpoint, block 25,826,600, so they overlapped and merged into one 76-root continuity proof.
- We also reproduced the failure mode near the attested head: a proof can have only one root, and a later block outside that covered range makes `mergeProofs` throw `Proofs are not contiguous`.

The live breach therefore verified five separated Ethereum blocks under one shared chain of continuity and applied one atomic credit consequence.

## Receipt contents are evaluated on-chain

Inclusion alone does not say what a transaction did. After batch verification, `EvmV1Decoder.decodeReceiptFields` extracts the receipt status and logs from each proven `encodedTransaction` inside the adjudicator and covenant contracts.

`OutflowCapCovenant` accepts a log only when all of these proven fields match its one-time facility configuration:

- the source chain and inclusive block window;
- the emitting contract, Ethereum mainnet USDC at `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`;
- exactly three topics with `Transfer(address,address,uint256)` as topic 0;
- the committed treasury as indexed sender and a different indexed recipient;
- exactly 32 bytes of event data, decoded as the transfer amount.

Checking the emitter is essential: any contract can emit an event with the `Transfer` signature. Recourse reads the topics and amount directly from bytes whose inclusion and continuity were already established by Attestcoin.

## Successful inclusion is not successful execution

Every evaluation path explicitly requires `receiptStatus == 1`. The adjudicator checks it after proof verification in both `submitBatch` and `submitSingle`; each covenant checks it again before evaluating logs.

This is deliberate. Creditcoin's upstream documentation warns:

> “The block prover precompile does not validate if a transaction was successful or not. ... a dApp's ASC MUST check the ‘status’ field.”

Source: [Attestcoin Smart Contracts](https://docs.creditcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-smart-contracts.md).

A reverted attempt is not a breach. The precompile proves that the transaction is in the confirmed source chain; Recourse separately proves from the receipt that its effects were committed. The test suite includes reverted-receipt cases for the adjudicator and all three covenant evaluators.

## Transaction indices make evidence replay-safe

A transaction hash is not passed into the contract and cannot safely serve as an asserted identifier. Instead, the BlockProver's `calculateTxIndex` derives the transaction index from the verified Merkle path. The adjudicator then computes:

```solidity
keccak256(abi.encodePacked(chainKey, blockHeight, txIndex))
```

That query ID is stored under both `facilityId` and `covenantId`. The same source transaction may legitimately be evaluated for different facilities or different covenant predicates, while a replay against the same facility and covenant is rejected. Duplicate query IDs inside a single batch are rejected before evaluation.

The outflow covenant keeps a second replay map scoped by facility and the same derived query ID. This prevents one relevant receipt from being counted again if the same covenant contract is registered under an aliased covenant ID. The adjudicator's namespace gives composability; the covenant-local key preserves accounting identity.

## The aggregation argument

Attestcoin is load-bearing because the predicate depends on a sequence, not a single event. One adjudication establishes all of the following on-chain:

1. each transaction was included in the confirmed Ethereum source chain;
2. the separated blocks share valid continuity;
3. every receipt reports successful execution;
4. the logs came from USDC and encode transfers out of the committed treasury;
5. every receipt has a proof-derived transaction index and has not already been counted;
6. the sum, 274.79 USDC, is greater than the 232.545 USDC cap.

A centralized oracle could report the same facts. It could also collude with the borrower, omit a transfer, replay a favourable subset, or report a fabricated aggregate. A penalty bond, draw freeze, and permanent default state backed by such an oracle would not be credible recourse. Here, the contract derives the aggregate and the consequence from the verified receipt bytes in one transaction. Trustlessness is part of the credit control, not an attachment to it.

## Measured deployment and cost

| Item | Live CC3 value |
| --- | --- |
| Facility | [`0x144048E22e822269814D592aeaC34734c603dCA7`](https://creditcoin-testnet.blockscout.com/address/0x144048E22e822269814D592aeaC34734c603dCA7) |
| Adjudicator | [`0x6abB74F57c99986Ff205d4EF396Dd6d61d2659eB`](https://creditcoin-testnet.blockscout.com/address/0x6abB74F57c99986Ff205d4EF396Dd6d61d2659eB) |
| Outflow covenant | [`0x873C1344B850bB80c758E191D1DCA31CE86030Ef`](https://creditcoin-testnet.blockscout.com/address/0x873C1344B850bB80c758E191D1DCA31CE86030Ef) |
| New-borrow covenant | [`0x5f1DCF18622663a046a55Ad86c61dd339E1e5dE4`](https://creditcoin-testnet.blockscout.com/address/0x5f1DCF18622663a046a55Ad86c61dd339E1e5dE4) |
| LP-lock covenant | [`0x2826913E2917d905F7658AAa81288f3C4b98A53d`](https://creditcoin-testnet.blockscout.com/address/0x2826913E2917d905F7658AAa81288f3C4b98A53d) |
| Breach transaction | [`0x7c180209…7e5d5b6`](https://creditcoin-testnet.blockscout.com/tx/0x7c180209bedaa64b4e1acff02d2822e8c76b0db98f105b7b75e3b95ac7e5d5b6) |
| Breach block | **5,371,462** |
| Result | Success, seven events |
| Measured gas | **699,409** |

The proof size is time-dependent. The fixed evidence set had 76 continuity roots when observed on 2026-08-25. At 76 roots the batch contained 8,320 bytes of encoded receipt data, measured 10,752 bytes by the repository's `roots × 32 + txBytes` proof-plus-receipt approximation, and produced 15,044 bytes of full ABI calldata.

The repository's verification-only fallback formula is:

```text
21,000 + 5,000 × continuity roots + 20,000
```

At 76 roots it predicts 421,000 gas. The complete adjudication used 699,409 gas, a 1.66× ratio: verification is not the whole transaction. Receipt decoding, replay writes, cumulative accounting, facility breach accounting, and seven emitted events account for work outside the formula.

The operational consequence is specific:

- the proof for identical historical evidence grows as the common upper checkpoint advances;
- verification gas therefore rises with time, and any measured ratio must name its root count;
- gas should be re-measured shortly before recording a demo; a 1,500,000 ceiling is safe for this batch shape at the 76-root observation;
- if an old proof outgrows the budget, lock fresher evidence rather than increasing limits indefinitely.

This behaviour was measured against the live proof service; it is not an estimate of a static proof format.
