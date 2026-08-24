# Recourse

**Credit with consequences.**

An undercollateralized, covenant-enforced credit facility on Creditcoin. Covenants
over the borrower's Ethereum conduct are enforced by anyone, trustlessly, using the
Attestcoin Protocol — and the consequences execute on-chain.

Built for [BUIDL CTC 2026 Fall](https://dorahacks.io/hackathon/buidl-ctc-2026-fall/detail)
(DeFi track).

## The idea

Traditional credit is governed by *covenants* — enforceable promises about borrower
conduct ("no new debt", "don't strip the treasury", "keep the position intact").
DeFi threw all of that away and replaced it with overcollateralization, because a
blockchain cannot see what a borrower does somewhere else.

Attestcoin makes Ethereum conduct provable on Creditcoin. So covenants stop being
legal text and become executable code:

- A **lender** funds a facility; a **borrower** posts a penalty bond, commits named
  Ethereum positions to covenants, and draws credit against them.
- Any **hunter** can prove a covenant violation by submitting an Attestcoin proof of
  the offending Ethereum transaction.
- The contract verifies the proof against the BlockProver precompile, decodes the
  receipt, and executes the consequences: undrawn capacity freezes, the bond is
  slashed against outstanding debt, and the hunter is paid.

The proof does not release an escrow. It changes credit risk.

## Status

Design complete and audited. Implementation in progress.
See [the design spec](docs/superpowers/specs/2026-08-24-recourse-design.md).

## Setup

```bash
npm install
```

Copy the environment template into `.env` (gitignored) and fill it in. Required keys:

| Variable | Purpose |
| --- | --- |
| `MNEMONIC` | HD seed for the four dev roles |
| `DEPLOYER_ADDRESS` / `DEPLOYER_PRIVATE_KEY` | Deploys contracts, holds faucet funds |
| `LENDER_ADDRESS` / `LENDER_PRIVATE_KEY` | Funds the facility vault |
| `BORROWER_ADDRESS` / `BORROWER_PRIVATE_KEY` | Posts bond, draws, repays |
| `HUNTER_ADDRESS` / `HUNTER_PRIVATE_KEY` | Submits violation proofs |
| `CREDITCOIN_RPC_URL` | `https://rpc.cc3-testnet.creditcoin.network` |
| `CREDITCOIN_CHAIN_ID` | `102031` |
| `PROOF_BUILDER_URL` | `https://prover.cc3-testnet.creditcoin.network` |
| `BLOCK_PROVER_PRECOMPILE` | `0x0000000000000000000000000000000000000FD2` |
| `CHAIN_INFO_PRECOMPILE` | `0x0000000000000000000000000000000000000fd3` |
| `SOURCE_CHAIN_KEY_SEPOLIA` / `SOURCE_CHAIN_KEY_MAINNET` | `1` / `3` |
| `ETH_MAINNET_RPC_URL` / `SEPOLIA_RPC_URL` | Source-chain reads |
| `RECOURSE_DOH_FALLBACK` | `1` only if local DNS cannot resolve creditcoin hosts |

Generate fresh dev wallets at any time:

```bash
npm run wallets:new
```

Check balances on CC3 Testnet:

```bash
npm run balances
```

## Funding (testnet)

CC3 Testnet tCTC comes from a Discord bot — there is no web faucet. Join the
[Creditcoin Discord](https://discord.gg/creditcoin), open the `token-faucet`
channel, and run:

```
/faucet address:<DEPLOYER_ADDRESS>
```

Only the deployer needs funding; the other roles are funded from it by the setup
script.

## Network reference (verified live 2026-08-24)

| | |
| --- | --- |
| EVM chain ID | 102031 |
| RPC | https://rpc.cc3-testnet.creditcoin.network |
| EVM explorer | https://creditcoin-testnet.blockscout.com/ |
| Prover API | https://prover.cc3-testnet.creditcoin.network |
| Attestcoin dashboard | https://dashboard.cc3-testnet.creditcoin.network/ |
| Source chains | Ethereum Sepolia (chainKey 1), Ethereum mainnet (chainKey 3) |

## Attribution

Contract patterns follow the official Attestcoin examples in
[gluwa/usc-testnet-bridge-examples](https://github.com/gluwa/usc-testnet-bridge-examples)
(MIT), reimplemented for this project's state machine. Receipt decoding uses
[`@gluwa/usc-contracts`](https://www.npmjs.com/package/@gluwa/usc-contracts).

## License

MIT
