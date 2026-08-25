# Recourse

Recourse is an undercollateralized credit facility on Creditcoin where cryptographic proofs enforce covenants over a borrower's Ethereum conduct. A proven violation freezes undrawn credit, applies the borrower's penalty bond against debt, and pays the permissionless hunter who submitted the evidence.

The proof does not release an escrow. It changes credit risk.

## The problem

Traditional credit is governed by covenants: enforceable promises not to strip a treasury, take on new debt, or unwind a pledged position. DeFi replaced those controls with overcollateralization because one chain cannot see what a borrower does on another.

Attestcoin makes Ethereum conduct provable on Creditcoin. Recourse turns those proven facts into consequences held and executed by the credit facility itself.

## How it works

1. A lender funds a facility. The borrower posts a penalty bond, accepts named covenants, and draws credit.
2. Any hunter submits one or more Attestcoin proofs of relevant Ethereum transactions.
3. `AttestcoinAdjudicator` verifies inclusion and continuity through the BlockProver precompile, decodes the proven receipts on-chain, requires successful transaction status, and derives replay keys from transaction indices.
4. A covenant evaluates the proven logs. The hero `OutflowCapCovenant` aggregates qualifying USDC transfers; no single transfer crosses the cap, but their verified sum does.
5. On breach, the facility freezes undrawn capacity, applies up to 80% of the bond against outstanding debt, capped by that debt; the unused share returns to the borrower, and 20% rewards the hunter.

The live hero adjudication used five real Ethereum mainnet transfers in five distinct blocks across a 35-block span. The largest was 190.30 USDC, below the 232.545 USDC cap; together they totalled 274.79 USDC. See [the Attestcoin integration note](docs/attestcoin-integration.md) for the proof mechanics and evidence.

## Live deployment

CC3 Testnet, chain ID `102031`:

| Component              | Address                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Facility               | [`0x144048E22e822269814D592aeaC34734c603dCA7`](https://creditcoin-testnet.blockscout.com/address/0x144048E22e822269814D592aeaC34734c603dCA7) |
| Attestcoin adjudicator | [`0x6abB74F57c99986Ff205d4EF396Dd6d61d2659eB`](https://creditcoin-testnet.blockscout.com/address/0x6abB74F57c99986Ff205d4EF396Dd6d61d2659eB) |
| Outflow-cap covenant   | [`0x873C1344B850bB80c758E191D1DCA31CE86030Ef`](https://creditcoin-testnet.blockscout.com/address/0x873C1344B850bB80c758E191D1DCA31CE86030Ef) |
| New-borrow covenant    | [`0x5f1DCF18622663a046a55Ad86c61dd339E1e5dE4`](https://creditcoin-testnet.blockscout.com/address/0x5f1DCF18622663a046a55Ad86c61dd339E1e5dE4) |
| LP-lock covenant       | [`0x2826913E2917d905F7658AAa81288f3C4b98A53d`](https://creditcoin-testnet.blockscout.com/address/0x2826913E2917d905F7658AAa81288f3C4b98A53d) |
| Facility ID            | `1`                                                                                                                                          |
| Breach adjudication    | [`0x7c180209…7e5d5b6`](https://creditcoin-testnet.blockscout.com/tx/0x7c180209bedaa64b4e1acff02d2822e8c76b0db98f105b7b75e3b95ac7e5d5b6)      |
| Breach block           | `5,371,462`                                                                                                                                  |

The breach transaction succeeded, emitted seven events, and used 699,409 gas.

## Quickstart

The checked-in `deployments.json` points to the already-breached live facility. To reproduce the full demo with a fresh facility, use fresh development wallets and CC3 testnet funds.

```bash
git submodule update --init --recursive
npm install
forge build
forge test
npm run wallets:new
```

Create a local `.env` file, which is gitignored, with the generated role addresses and private keys plus:

```dotenv
CREDITCOIN_RPC_URL=https://rpc.cc3-testnet.creditcoin.network
PROOF_BUILDER_URL=https://prover.cc3-testnet.creditcoin.network
BLOCK_PROVER_PRECOMPILE=0x0000000000000000000000000000000000000FD2
ETH_MAINNET_RPC_URL=<ethereum-mainnet-rpc>
DEPLOYER_ADDRESS=<address>
DEPLOYER_PRIVATE_KEY=<private-key>
LENDER_ADDRESS=<address>
LENDER_PRIVATE_KEY=<private-key>
BORROWER_ADDRESS=<address>
BORROWER_PRIVATE_KEY=<private-key>
HUNTER_ADDRESS=<address>
HUNTER_PRIVATE_KEY=<private-key>
```

Fund only the deployer with CC3 testnet tCTC through the `token-faucet` channel in the [Creditcoin Discord](https://discord.gg/creditcoin). The setup script funds the other roles. Then run:

```bash
node scripts/deploy.mjs
node scripts/demo-setup.mjs
node scripts/submit.mjs
```

The final command pre-warms and fetches the five locked proofs, submits one batch, and checks the resulting `Breached` state, 274.79 USDC accumulation, debt reduction, zero available credit, and 40 tCTC hunter payout. Deployment rewrites `deployments.json`, so preserve the checked-in live record before running a fresh deployment.

To run the static application:

```bash
python -m http.server 8000
```

Open `http://localhost:8000/web/`. There is no build step. The application discovers facilities from live `FacilityOpened` events and remains fully readable without a wallet. Connect an injected EVM wallet such as MetaMask to add or switch to CC3 Testnet and operate facilities through wallet-owned signatures; browser code never reads a private key.

The application exposes the complete deployed surface:

- lenders can open, fund, configure and register ordered covenants, cancel before activation, and withdraw claims;
- borrowers can post the bond, activate the exact live covenant-set commitment, request and execute delayed draws, repay, cancel before activation, and claim refunds;
- permissionless hunters can build Attestcoin batches directly from Ethereum transaction hashes, inspect the exact calldata and gas policy, and submit through their wallet;
- every write is shown in a transaction-review dialog and preflighted with a read-only contract call before the wallet is asked to sign.

The configure â†’ register â†’ activate order is explicit in the interface because it is a contract-enforced security boundary. Configuration parameters are verified against the on-chain hash. Parameters created in this browser are retained locally after confirmation; because the deployed covenant contracts expose only their hashes and emit no parameter event, another browser can verify checked-in public metadata but cannot reconstruct arbitrary private configuration values.

## Architecture

```text
Ethereum mainnet receipts
        │
        │ Proof Builder: Merkle proofs + shared continuity proof
        ▼
AttestcoinAdjudicator on Creditcoin
        ├── BlockProver.verify(...) proves inclusion and continuity
        ├── EvmV1Decoder reads status and receipt logs
        └── replay keys bind chain + block + transaction index
                       │
                       ▼
              Covenant evaluators
        ├── cumulative treasury outflow cap
        ├── new Aave borrow
        └── Uniswap V3 liquidity decrease
                       │ breach
                       ▼
              RecourseFacility
        freeze capacity │ slash bond │ record debt │ pay hunter
```

- `RecourseFacility.sol` owns the credit state machine, lender vault, borrower bond, draws, repayment, and breach accounting.
- `AttestcoinAdjudicator.sol` is the only contract that calls the BlockProver precompile. It verifies first, decodes receipts, rejects reverted transactions, enforces facility-and-covenant-scoped replay protection, and dispatches proven transactions.
- Each contract in `contracts/covenants/` is a small, separately configured predicate. It validates the source chain, window, emitting contract, indexed subjects, and event data relevant to that covenant.
- `scripts/` handles deployment, facility setup, proof retrieval, and unattended submission. `web/` is the zero-build wallet application and walletless facility monitor.

The borrower's activation commits to an ordered hash covering both the identity and configuration of every registered covenant. Registration is limited to the pre-activation `Created` state, and each covenant rejects reconfiguration after registration, so neither the covenant set nor anything the borrower agreed to can change afterwards.

## Testing

`forge test` passes 134 tests across seven suites. The suite covers every facility transition, proof verification ordering, reverted receipts, replay and duplicate-query handling, forged or irrelevant logs, exact cap boundaries, native-transfer failures, reentrancy, and real encoded mainnet receipt fixtures.

The stateful invariant suite completed 256 runs and 128,000 calls with zero reverts. It asserts asset conservation and claim solvency. A separate regression test asserts that the bond can be claimed at most once.

## Honest limitations

- **No cross-chain write-back.** Attestcoin writability is not live on testnet, so Recourse cannot reach back to Ethereum. The bond, draw freeze, permanent default state, and on-Creditcoin repayment obligation are the recourse. This project does not claim legal or cross-chain recovery.
- **Hunter MEV.** Proofs are public. A pending hunter submission can be copied and outbid. This is disclosed and unsolved in this version; commit/reveal is on the roadmap.
- **Historical simulation.** The hero demo uses real historical Ethereum mainnet evidence that necessarily predates the facility. It is a historical simulation over real data, and the demo must be described that way; it is not evidence of post-funding borrower conduct.
- **Fixed predicates.** The implementation contains three hardcoded covenant predicates, not a general covenant DSL.
- **Hash-only configuration recovery.** The deployed covenants expose a configuration hash, not their original parameters, and emit no configuration event. The application verifies checked-in or browser-local metadata against that hash and labels parameters unavailable when it cannot do so.
- **Browser proof source.** Browser-built hunter batches currently support Ethereum mainnet (`chainKey = 3`). The application cross-checks the Proof Builder response against an independent public Ethereum RPC and the CC3 verifier-derived transaction index before review.
- **Plaintext development wallets.** `npm run wallets:new` writes throwaway testnet keys to a plaintext, gitignored file. The file is not encrypted, although none of these keys appear in git history.
- **Native-transfer compatibility.** Each participant address must be able to receive native transfers. A contract address that rejects them can block its own withdrawal.
- **Testnet and unaudited.** Recourse is deployed only on CC3 Testnet and has not received an independent security audit beyond the project's own adversarial review and test suite.

## Roadmap

- [ ] Use Attestcoin writability for repayment sweeps when testnet support is live.
- [ ] Add commit/reveal submissions to reduce proof-copying MEV.
- [ ] Add proof-of-compliance deadlines, where failure to prove continued compliance triggers a facility consequence.
- [ ] Add audited covenant templates for each integrated protocol.
- [ ] Support additional Attestcoin source chains.

## Attribution

The Attestcoin integration follows the patterns in Creditcoin's [Attestcoin smart-contract documentation](https://docs.creditcoin.org/attestcoin-protocol/dapp-builder-infrastructure/attestcoin-smart-contracts) and the MIT-licensed [`gluwa/usc-testnet-bridge-examples`](https://github.com/gluwa/usc-testnet-bridge-examples). Receipt decoding and verifier interfaces come from [`@gluwa/usc-contracts`](https://www.npmjs.com/package/@gluwa/usc-contracts); proof construction uses [`@gluwa/usc-sdk`](https://www.npmjs.com/package/@gluwa/usc-sdk). Facility safeguards use OpenZeppelin Contracts. Runtime dependencies are permissively licensed, and their required notices are retained in the installed packages.

## Licence

MIT, as declared in `package.json` and the Solidity source headers.
