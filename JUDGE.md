# For judges: the walletless evidence route

Nothing on this page needs a key, a wallet, or an RPC endpoint of your own. Every link is public. Generations are
labelled: both catches ran on the **V1** contracts; the **V3** core is deployed and activated and has not yet
adjudicated a proof. Chain: Creditcoin CC3 Testnet, chain id 102031; evidence chain: Ethereum mainnet, chain id 1.

## 1. The two V1 catches, real mainnet evidence adjudicated on CC3

| What | Where |
| --- | --- |
| Autonomous catch, submitted unattended by the operator wallet `0xa61B1518691dF7655226fF944b6f3Eade4E4B228` | [`0x96bf3081…f7528192`](https://creditcoin-testnet.blockscout.com/tx/0x96bf3081614a76c8df459eaeffe50975556883dd0e39d622758ca468f7528192) · block 5,371,828 · 459,396 gas · two precompile calls |
| The mainnet transaction it proved | [`0xc8481d8a…bf55f79`](https://etherscan.io/tx/0xc8481d8afbc2d439df53a6756fea1c61b0c2253703e53f4b5416d45fdbf55f79) · Ethereum block 25,832,534, position 146 · 147.41949 USDC leaving the committed treasury |
| Cumulative batch: five mainnet transfers, one continuity proof, breach on the verified sum | [`0x7c180209…7e5d5b6`](https://creditcoin-testnet.blockscout.com/tx/0x7c180209bedaa64b4e1acff02d2822e8c76b0db98f105b7b75e3b95ac7e5d5b6) · block 5,371,462 · 699,409 gas |
| The five source transfers (blocks, amounts, cap) | [docs/attestcoin-integration.md, "The adjudicated evidence"](docs/attestcoin-integration.md#the-adjudicated-evidence) |
| The V1 contracts, all source-verified so Blockscout decodes their events | [adjudicator](https://creditcoin-testnet.blockscout.com/address/0x6abB74F57c99986Ff205d4EF396Dd6d61d2659eB) · [facility](https://creditcoin-testnet.blockscout.com/address/0x144048E22e822269814D592aeaC34734c603dCA7) · [outflow-cap covenant](https://creditcoin-testnet.blockscout.com/address/0x873C1344B850bB80c758E191D1DCA31CE86030Ef) |

The consequences recorded in those receipts are testnet credit consequences (undrawn credit frozen, bond applied against
debt in tCTC, hunter paid). No USDC moved on Ethereum as a result; Attestcoin has no write-back today.

## 2. The V3 generation: deployed, activated, not yet adjudicated

| What | Where |
| --- | --- |
| Six core contracts from reviewed commit `90d8b05`, runtime hashes verified, source verified | [`deployments-v3-current.json`](deployments-v3-current.json) · [PolicyKernelV2](https://creditcoin-testnet.blockscout.com/address/0x69d1715F117f79aB5E190d48666510B8A39Af6dB) |
| Capped pilot facility, Active, proof job 1 funded, committed Ethereum source window 25,944,522–26,024,522 | [`activation-v3-current.json`](activation-v3-current.json) · [facility](https://creditcoin-testnet.blockscout.com/address/0x00B50626C4AA42d22ca01AAEa8649f253aEc5B1e) |
| Portfolio pool allocation of 100,000 rUSD to a pool-created facility, 20,000 rUSD bond, project-funded test tokens | [`allocation-v3-portfolio-current.json`](allocation-v3-portfolio-current.json) · [facility](https://creditcoin-testnet.blockscout.com/address/0x0C874e56AD2dC9789A63a9Bc63c08a5F6D3C82C8) |
| Operator market and receipt verifier, deployed and empty, one project-operated attestor | [`deployments-v3-operator-market-current.json`](deployments-v3-operator-market-current.json) · [`deployments-v3-operator-service-verifier-current.json`](deployments-v3-operator-service-verifier-current.json) |
| Read-only observatories, every read anchored at a finalized CC3 block | <https://recourse.gudman.xyz/v3.html> · <https://recourse.gudman.xyz/portfolio.html> (the site root is the V1 wallet application) |

## 3. Reproduce locally

| What | Where |
| --- | --- |
| One-command re-check of the on-chain claims | `npm run judge:verify` (public endpoints only; tests, authorship and unattended operation are reported UNVERIFIED because an RPC cannot establish them) |

Measured 2026-09-12 on `main`; these are dated local results, not chain assertions.

```bash
forge test                          # 392 passed
DOTENV_CONFIG_PATH=NUL node --test test/*.test.mjs   # 411 tests: 410 pass, 1 skipped (Windows symlink privilege)
npm --prefix sdk test               # 44 passed, then a strict declaration compile
```

The SDK is published as [`recourse-protocol-sdk@0.1.1`](https://www.npmjs.com/package/recourse-protocol-sdk). The
proof mechanics, the four load-bearing checks and the measured proof sizes are in
[docs/attestcoin-integration.md](docs/attestcoin-integration.md); the internal review is
[docs/SECURITY-REVIEW-2026-09.md](docs/SECURITY-REVIEW-2026-09.md).

## 4. What is not claimed

No independent audit, no production readiness, no lender demand or external capital, no cross-chain write-back, no
completed cure or audited loss accounting, and no V3 adjudication yet. The README's "Honest limitations" section is
the authoritative list.
