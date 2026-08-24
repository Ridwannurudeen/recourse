# Recourse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an undercollateralized, covenant-enforced credit facility on Creditcoin where anyone can prove a borrower's Ethereum covenant violation via the Attestcoin Protocol and trigger on-chain consequences.

**Architecture:** Three contract layers. `RecourseFacility` holds the credit state machine (lender vault, borrower penalty bond, two-stage draws, repayment, freeze/slash). `AttestcoinAdjudicator` is the only contract that talks to the Attestcoin BlockProver precompile — it verifies proofs, decodes receipts, enforces replay protection, and dispatches to covenant evaluators. Each covenant evaluator is a small predicate contract. TypeScript scripts drive proof generation and submission; a static dashboard reads contract state directly.

**Tech Stack:** Solidity 0.8.30 (Foundry, `via_ir = true`), `@gluwa/usc-contracts` 0.2.0 (`EvmV1Decoder`, `INativeQueryVerifier`), `@gluwa/usc-sdk` 0.18.0, ethers v6, Node 24.

**Spec:** [`docs/superpowers/specs/2026-08-24-recourse-design.md`](../specs/2026-08-24-recourse-design.md) — read it before Task 1. This plan implements that spec; where they disagree, the spec wins and you should flag the conflict.

---

## Global Constraints

Every task inherits these. All values were verified live on 2026-08-24 — do not "correct" them from memory or from the public docs, which are stale in places.

**Toolchain**
- Solidity `0.8.30`. `foundry.toml` already committed and verified working.
- **`via_ir = true` is mandatory.** `@gluwa/usc-contracts` 0.2.0 fails with "Stack too deep" without it. (The upstream examples repo says `via_ir = false`; that is for their older 0.1.2 and is wrong for us.)
- `libs = ["node_modules"]`; import as `@gluwa/usc-contracts/contracts/write-ability/common/<File>.sol`.
- Foundry `forge 1.7.1`. Add `~/.foundry/bin` to PATH in every new shell: `export PATH="$HOME/.foundry/bin:$PATH"`.
- `forge-std` is installed under `lib/` and `lib/` is gitignored. If missing, run `forge install foundry-rs/forge-std`.

**Network (CC3 Testnet)**
- RPC `https://rpc.cc3-testnet.creditcoin.network`, EVM chainId `102031`.
- BlockProver precompile `0x0000000000000000000000000000000000000FD2`.
- ChainInfo precompile `0x0000000000000000000000000000000000000fd3`.
- Prover API `https://prover.cc3-testnet.creditcoin.network`.
- EVM explorer `https://creditcoin-testnet.blockscout.com/`.
- Source chains: Ethereum Sepolia `chainKey = 1`, Ethereum **mainnet** `chainKey = 3`.
- Deployer `0xB9262d47B4d6d569A7C5230B3BF7De1080dD6e49` funded with 10,000 tCTC. Role keys live in `.env` (gitignored). **Never commit, print, or paste private keys.**

**Attestcoin behaviour — verified, and where the traps are**
- The precompile **does not check transaction success**. Every evaluator MUST require `receiptStatus == 1` itself. Accepting a reverted transaction as evidence is a fatal bug.
- Replay protection is entirely the dApp's job.
- `INativeQueryVerifier.verify(...)` is `view`; `verifyAndEmit(...)` is state-changing and emits `TransactionVerified`. **Use the `view` `verify` overload** — we emit our own domain events.
- Batch proofs: use the SDK's `getBatchProof(hashes)`. It **does** support non-contiguous blocks.
- **`mergeProofs` requires strictly contiguous blocks** and throws `Proofs are not contiguous` otherwise. Do not build the batch path on it.
- Verified batch spans: 5, 20, 30, 40 and 55 blocks all returned `verifyBatch = true`; a 60-block span failed. The binding limit appears to be total calldata, not span alone. **Keep the evidence window ≤ 30 blocks and total calldata under ~15 KB.**
- Attestation lag is ~8 minutes. Only blocks at or below the current attested height are provable. All demo evidence must be pre-attested and pre-warmed.
- Gas estimation against the precompile fails spuriously (a pallet-evm quirk). On estimation failure fall back to `21000 + 5000 * continuityRoots + 20000`, and apply a 35% buffer when estimation succeeds. That formula covers *verification only* — measure real end-to-end `submitBatch` gas in Task 5.

**Exact library surfaces (copied from source — do not guess)**

```solidity
// @gluwa/usc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol
interface INativeQueryVerifier {
    struct MerkleProofEntry { bytes32 hash; bool isLeft; }
    struct MerkleProof { bytes32 root; MerkleProofEntry[] siblings; }
    struct ContinuityProof { bytes32 lowerEndpointDigest; bytes32[] roots; }

    function verify(uint64 chainKey, uint64 height, bytes calldata encodedTransaction,
        MerkleProof calldata merkleProof, ContinuityProof calldata continuityProof)
        external view returns (bool);

    function verify(uint64 chainKey, uint64[] calldata heights, bytes[] calldata encodedTransactions,
        MerkleProof[] calldata merkleProofs, ContinuityProof calldata sharedContinuityProof)
        external view returns (bool);

    function calculateTxIndex(MerkleProof calldata merkleProof) external view returns (uint64);
}

// @gluwa/usc-contracts/contracts/write-ability/common/EvmV1Decoder.sol  (library, internal fns)
struct LogEntry { address address_; bytes32[] topics; bytes data; }
struct ReceiptFields { uint8 receiptStatus; uint64 receiptGasUsed; LogEntry[] receiptLogs; bytes receiptLogsBloom; }
struct CommonTxFields { uint64 nonce; uint64 gasLimit; address from; bool toIsNull; address to; uint256 value; bytes data; }

function decodeReceiptFields(bytes memory encodedTx) internal pure returns (ReceiptFields memory);
function decodeCommonTxFields(bytes memory encodedTx) internal pure returns (CommonTxFields memory);
function getLogsByEventSignature(ReceiptFields memory receipt, bytes32 eventSignature) internal pure returns (LogEntry[] memory);
function getTransactionType(bytes memory encodedTx) internal pure returns (uint8);
function isValidTransactionType(uint8 txType) internal pure returns (bool);
```

Note the field name is `address_` (trailing underscore) and `MerkleProofEntry.hash` (not `hash_`).

**Event signatures:** always derive them, never paste a hash literal. In Solidity use
`keccak256("Transfer(address,address,uint256)")`; in JavaScript use ethers'
`id("Transfer(address,address,uint256)")`.

**Testing rules**
- The precompile is native runtime code with **no bytecode**. It does not exist on Anvil or any local fork. All unit tests inject `MockVerifier`. Only the live CC3 integration scripts touch the real precompile.
- TDD throughout: write the failing test, run it and see it fail, implement minimally, run it and see it pass, commit.
- Never weaken a test to make it pass. If a test is wrong, say so explicitly and fix it deliberately.

**Process**
- Commit after every task. Conventional commit messages. No attribution footers of any kind.
- If a task's premise turns out to be wrong, STOP and report rather than improvising a different design.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `contracts/types/RecourseTypes.sol` | Shared enums, structs, custom errors |
| `contracts/interfaces/ICovenant.sol` | Evaluator interface every covenant implements |
| `contracts/interfaces/IRecourseFacility.sol` | Facility surface the adjudicator calls |
| `contracts/RecourseFacility.sol` | Credit state machine: vault, bond, draws, repayment, freeze, slash |
| `contracts/AttestcoinAdjudicator.sol` | Proof verification, decoding, replay keys, covenant dispatch |
| `contracts/covenants/OutflowCapCovenant.sol` | Hero predicate: cumulative ERC-20 outflow cap |
| `contracts/covenants/NewBorrowCovenant.sol` | Aave V3 `Borrow` by committed address |
| `contracts/covenants/LpLockCovenant.sol` | Uniswap V3 `DecreaseLiquidity` before unlock |
| `test/mocks/MockVerifier.sol` | Stand-in for the precompile in unit tests |
| `test/RecourseFacility.t.sol` | Facility state-machine tests |
| `test/AttestcoinAdjudicator.t.sol` | Verification, replay, dispatch tests |
| `test/covenants/*.t.sol` | Per-covenant predicate tests |
| `scripts/lib/net.mjs` | DoH fallback resolver (already committed) |
| `scripts/lib/proofs.mjs` | Proof fetch/pre-warm helpers over `@gluwa/usc-sdk` |
| `scripts/evidence.mjs` | Task 0: discover and lock the demo evidence set |
| `scripts/deploy.mjs` | Deploy all contracts to CC3, write `deployments.json` |
| `scripts/demo-setup.mjs` | Fund roles, open facility, register covenants, draw |
| `scripts/submit.mjs` | Hunter CLI: fetch batch proof, submit, report outcome |
| `docs/demo-evidence.json` | The locked evidence set (Task 0 output) |
| `web/index.html`, `web/app.js` | Static dashboard |

---

### Task 0: Lock the demo evidence set

Nothing downstream is real until this exists. The hero demo needs one mainnet address with several outbound USDC transfers inside a ≤30-block window, where no single transfer exceeds the cap but the cumulative total does.

**Files:**
- Create: `scripts/lib/proofs.mjs`
- Create: `scripts/evidence.mjs`
- Create: `docs/demo-evidence.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `docs/demo-evidence.json` with shape
  `{ chainKey: 3, token, treasury, startSourceBlock, endSourceBlock, capBaseUnits, expectedTotalBaseUnits, txs: [{ hash, block, valueBaseUnits, to }] }`.
  `scripts/lib/proofs.mjs` exports `getProvider()`, `getSourceProvider(chainKey)`, `getAttestedHeight(chainKey)`, `fetchBatchProof(chainKey, hashes)` returning `{ heights, txBytes, merkleProofs, continuityProof }`, and `prewarm(chainKey, hashes)`.

- [ ] **Step 1: Write `scripts/lib/proofs.mjs`**

```javascript
import 'dotenv/config';
import { JsonRpcProvider } from 'ethers';
import pkg from '@gluwa/usc-sdk';
import { installDohFallback } from './net.mjs';

const { chainInfo, proofProvider } = pkg;
installDohFallback();

export function getProvider() {
  return new JsonRpcProvider(process.env.CREDITCOIN_RPC_URL);
}

export function getSourceProvider(chainKey) {
  const url = Number(chainKey) === 3 ? process.env.ETH_MAINNET_RPC_URL : process.env.SEPOLIA_RPC_URL;
  return new JsonRpcProvider(url);
}

export async function getAttestedHeight(chainKey) {
  const info = new chainInfo.PrecompileChainInfoProvider(getProvider());
  const latest = await info.getLatestAttestedHeightAndHash(Number(chainKey));
  return Number(latest.height);
}

function builder(chainKey) {
  return new proofProvider.service.ProofBuilder(Number(chainKey), process.env.PROOF_BUILDER_URL);
}

// getBatchProof returns merkleProofs as a nested map: blockHeight -> txIndex -> entry.
// It supports non-contiguous blocks. Do NOT use mergeProofs, which requires contiguity.
export async function fetchBatchProof(chainKey, hashes) {
  const result = await builder(chainKey).getBatchProof(hashes);
  if (!result.success) throw new Error(`getBatchProof failed: ${result.error}`);
  const data = result.data;
  const heights = [], txBytes = [], merkleProofs = [];
  const outer = data.merkleProofs instanceof Map
    ? data.merkleProofs.entries() : Object.entries(data.merkleProofs);
  for (const [height, inner] of outer) {
    const entries = inner instanceof Map ? inner.entries() : Object.entries(inner);
    for (const [, entry] of entries) {
      heights.push(Number(height));
      txBytes.push(entry.txBytes);
      merkleProofs.push(entry.merkleProof);
    }
  }
  return { heights, txBytes, merkleProofs, continuityProof: data.continuityProof };
}

export async function prewarm(chainKey, hashes) {
  const b = builder(chainKey);
  for (const hash of hashes) {
    const r = await b.getProof(hash);
    if (!r.success) throw new Error(`prewarm failed for ${hash}: ${r.error}`);
  }
}
```

- [ ] **Step 2: Write `scripts/evidence.mjs`**

Scan single blocks (range queries are rejected by the public RPC as archive requests) below the attested height, group outbound USDC transfers by sender, and pick a sender with at least 4 distinct transactions inside a ≤30-block window. Exclude self-transfers. Choose `capBaseUnits` strictly between the largest single transfer and the cumulative total.

```javascript
import 'dotenv/config';
import { Interface, formatUnits, id } from 'ethers';
import { writeFileSync } from 'node:fs';
import { getSourceProvider, getAttestedHeight, fetchBatchProof } from './lib/proofs.mjs';

const CHAIN_KEY = 3;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const TRANSFER = id('Transfer(address,address,uint256)');
const WINDOW = 30;
const iface = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);

const eth = getSourceProvider(CHAIN_KEY);
const attested = await getAttestedHeight(CHAIN_KEY);
const to = attested - 5;
const from = to - WINDOW;

const bySender = new Map();
for (let b = from; b <= to; b++) {
  const logs = await eth.getLogs({ fromBlock: b, toBlock: b, address: USDC, topics: [TRANSFER] });
  for (const log of logs) {
    const parsed = iface.parseLog({ topics: log.topics, data: log.data });
    const sender = parsed.args.from.toLowerCase();
    if (parsed.args.to.toLowerCase() === sender) continue;
    if (!bySender.has(sender)) bySender.set(sender, new Map());
    const seen = bySender.get(sender);
    if (!seen.has(log.transactionHash)) {
      seen.set(log.transactionHash, {
        hash: log.transactionHash, block: log.blockNumber,
        valueBaseUnits: parsed.args.value.toString(), to: parsed.args.to,
      });
    }
  }
}

const candidates = [...bySender.entries()]
  .map(([treasury, seen]) => ({ treasury, txs: [...seen.values()].sort((a, b) => a.block - b.block) }))
  .filter((c) => c.txs.length >= 4)
  .sort((a, b) => b.txs.length - a.txs.length);

if (candidates.length === 0) {
  throw new Error('No treasury with >=4 outbound txs in window. Raise WINDOW to 60 and retry.');
}

const chosen = candidates[0];
const txs = chosen.txs.slice(0, 8);
const total = txs.reduce((s, t) => s + BigInt(t.valueBaseUnits), 0n);
const largest = txs.reduce((m, t) => (BigInt(t.valueBaseUnits) > m ? BigInt(t.valueBaseUnits) : m), 0n);
if (largest >= total) throw new Error('Largest single transfer is not below the cumulative total.');
const cap = largest + (total - largest) / 2n; // strictly between largest and total

const evidence = {
  chainKey: CHAIN_KEY, token: USDC, treasury: chosen.treasury,
  startSourceBlock: txs[0].block, endSourceBlock: txs[txs.length - 1].block,
  capBaseUnits: cap.toString(), expectedTotalBaseUnits: total.toString(), txs,
};

const proof = await fetchBatchProof(CHAIN_KEY, txs.map((t) => t.hash));
const calldataBytes = proof.continuityProof.roots.length * 32
  + proof.txBytes.reduce((s, b) => s + (b.length - 2) / 2, 0);
console.log(`treasury ${chosen.treasury}`);
console.log(`  txs=${txs.length} blocks ${evidence.startSourceBlock}..${evidence.endSourceBlock}`);
console.log(`  largest=${formatUnits(largest, 6)} cap=${formatUnits(cap, 6)} total=${formatUnits(total, 6)} USDC`);
console.log(`  continuityRoots=${proof.continuityProof.roots.length} calldata=${(calldataBytes / 1024).toFixed(1)}KB`);
if (calldataBytes > 15360) throw new Error('Calldata exceeds the ~15KB safe budget. Narrow the window.');

writeFileSync('docs/demo-evidence.json', JSON.stringify(evidence, null, 2));
console.log('Wrote docs/demo-evidence.json');
```

- [ ] **Step 3: Run it**

Run: `node scripts/evidence.mjs`
Expected: prints a treasury with ≥4 transactions, `largest < cap < total`, continuity roots and calldata under 15 KB, and writes `docs/demo-evidence.json`.
If it throws "No treasury with >=4 outbound txs", raise `WINDOW` to 60 and rerun; if calldata then exceeds budget, keep only the 4 largest transactions that still satisfy `largest < cap < total`.

- [ ] **Step 4: Commit**

```bash
git add scripts/lib/proofs.mjs scripts/evidence.mjs docs/demo-evidence.json
git commit -m "feat: lock demo evidence set from real mainnet USDC transfers"
```

---

### Task 1: Shared types, covenant interface, and MockVerifier

**Files:**
- Create: `contracts/types/RecourseTypes.sol`
- Create: `contracts/interfaces/ICovenant.sol`
- Create: `test/mocks/MockVerifier.sol`
- Test: `test/mocks/MockVerifier.t.sol`

**Interfaces:**
- Consumes: `INativeQueryVerifier`, `EvmV1Decoder` from `@gluwa/usc-contracts`.
- Produces:
  - `enum FacilityState { Created, Active, Repaid, Breached, Defaulted, Cancelled }`
  - `struct ProvenTx { uint64 chainKey; uint64 blockHeight; uint64 txIndex; bytes encodedTransaction; }`
  - `interface ICovenant { function evaluate(uint256 facilityId, ProvenTx[] calldata proven) external returns (bool breached); function covenantKind() external pure returns (string memory); }`
  - `MockVerifier` with `setVerifyResult(bool)`, `setTxIndex(uint64)`, plus the full `INativeQueryVerifier` surface.

- [ ] **Step 1: Write `contracts/types/RecourseTypes.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

enum FacilityState { Created, Active, Repaid, Breached, Defaulted, Cancelled }

/// @notice A source-chain transaction whose inclusion has already been verified.
struct ProvenTx {
    uint64 chainKey;
    uint64 blockHeight;
    uint64 txIndex;
    bytes encodedTransaction;
}

error NotBorrower();
error NotLender();
error NotAdjudicator();
error WrongState(FacilityState expected, FacilityState actual);
error ProofAlreadyUsed(bytes32 queryId);
error VerificationFailed();
error TransactionReverted();
error IrrelevantEvidence();
error DrawNotReady(uint256 readyAtBlock);
error ExceedsFacility(uint256 requested, uint256 available);
error ZeroAmount();
error TransferFailed();
```

- [ ] **Step 2: Write `contracts/interfaces/ICovenant.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ProvenTx} from "../types/RecourseTypes.sol";

interface ICovenant {
    /// @notice Evaluate proven transactions against this covenant for a facility.
    /// @dev MUST revert with IrrelevantEvidence if no submitted tx is relevant, so that
    ///      irrelevant proofs are never consumed by replay protection.
    /// @return breached True when this evaluation crosses the covenant's breach condition.
    function evaluate(uint256 facilityId, ProvenTx[] calldata proven) external returns (bool breached);

    function covenantKind() external pure returns (string memory);
}
```

- [ ] **Step 3: Write `test/mocks/MockVerifier.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {INativeQueryVerifier} from "@gluwa/usc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";

/// @dev The real precompile is native runtime code with no bytecode and cannot exist
///      on a local chain. Unit tests inject this instead.
contract MockVerifier is INativeQueryVerifier {
    bool public result = true;
    uint64 public txIndex;
    uint256 public verifyCalls;

    function setVerifyResult(bool value) external { result = value; }
    function setTxIndex(uint64 value) external { txIndex = value; }

    function verify(uint64, uint64, bytes calldata, MerkleProof calldata, ContinuityProof calldata)
        external view returns (bool) { return result; }

    function verify(uint64, uint64[] calldata, bytes[] calldata, MerkleProof[] calldata, ContinuityProof calldata)
        external view returns (bool) { return result; }

    function verifyAndEmit(uint64, uint64, bytes calldata, MerkleProof calldata, ContinuityProof calldata)
        external returns (bool) { verifyCalls++; return result; }

    function verifyAndEmit(uint64, uint64[] calldata, bytes[] calldata, MerkleProof[] calldata, ContinuityProof calldata)
        external returns (bool) { verifyCalls++; return result; }

    function calculateTxIndex(MerkleProof calldata) external view returns (uint64) { return txIndex; }
}
```

- [ ] **Step 4: Write the failing test `test/mocks/MockVerifier.t.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {MockVerifier} from "./MockVerifier.sol";
import {INativeQueryVerifier} from "@gluwa/usc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";

contract MockVerifierTest is Test {
    MockVerifier verifier;

    function setUp() public { verifier = new MockVerifier(); }

    function test_defaultsToVerifyingTrue() public view {
        INativeQueryVerifier.MerkleProof memory m;
        INativeQueryVerifier.ContinuityProof memory c;
        assertTrue(verifier.verify(3, 100, hex"00", m, c));
    }

    function test_canBeSetToFail() public {
        verifier.setVerifyResult(false);
        INativeQueryVerifier.MerkleProof memory m;
        INativeQueryVerifier.ContinuityProof memory c;
        assertFalse(verifier.verify(3, 100, hex"00", m, c));
    }

    function test_reportsConfiguredTxIndex() public {
        verifier.setTxIndex(7);
        INativeQueryVerifier.MerkleProof memory m;
        assertEq(verifier.calculateTxIndex(m), 7);
    }
}
```

- [ ] **Step 5: Run the tests**

Run: `export PATH="$HOME/.foundry/bin:$PATH" && forge test --match-path test/mocks/MockVerifier.t.sol -vv`
Expected: 3 passing tests. If compilation fails on the `verify` overloads, confirm the signatures match the Global Constraints block exactly.

- [ ] **Step 6: Commit**

```bash
git add contracts/types contracts/interfaces test/mocks
git commit -m "feat: shared types, covenant interface, and mock verifier"
```

---

### Task 2: RecourseFacility state machine

The credit product, with no Attestcoin knowledge at all. Fully testable without any proof machinery.

**Files:**
- Create: `contracts/interfaces/IRecourseFacility.sol`
- Create: `contracts/RecourseFacility.sol`
- Test: `test/RecourseFacility.t.sol`

**Interfaces:**
- Consumes: `FacilityState` and the custom errors from Task 1.
- Produces:
  - `function openFacility(address lender, address borrower, uint256 facilityLimit, uint256 bondRequired, uint16 drawFeeBps, uint16 originationFeeBps, uint64 maturityBlock, uint32 drawDelayBlocks) external returns (uint256 facilityId)`
  - `function fundAsLender(uint256 facilityId) external payable`
  - `function postBond(uint256 facilityId) external payable`
  - `function activate(uint256 facilityId) external`
  - `function requestDraw(uint256 facilityId, uint256 amount) external`
  - `function executeDraw(uint256 facilityId) external`
  - `function repay(uint256 facilityId) external payable`
  - `function reportBreach(uint256 facilityId, address hunter) external` — adjudicator only
  - `function markDefaulted(uint256 facilityId) external`
  - `function setAdjudicator(address adjudicator) external` — owner, one-time
  - Views: `state(uint256)`, `outstandingDebt(uint256)`, `availableCredit(uint256)`, `facilityOf(uint256)`

Economics (spec §2): bond splits 80% lender / 20% hunter on breach. **The lender's 80% is applied against outstanding debt and capped by it**; any excess returns to the borrower at closure. The draw fee is added to debt at draw time; the origination fee is charged at activation.

- [ ] **Step 1: Write the failing tests `test/RecourseFacility.t.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {RecourseFacility} from "../contracts/RecourseFacility.sol";
import {FacilityState} from "../contracts/types/RecourseTypes.sol";

contract RecourseFacilityTest is Test {
    RecourseFacility facility;
    address lender = address(0xA1);
    address borrower = address(0xB2);
    address hunter = address(0xC3);
    address adjudicator = address(0xD4);
    uint256 id;

    function setUp() public {
        facility = new RecourseFacility();
        facility.setAdjudicator(adjudicator);
        vm.deal(lender, 2000 ether);
        vm.deal(borrower, 2000 ether);
        id = facility.openFacility(lender, borrower, 1000 ether, 200 ether, 200, 50, uint64(block.number + 100000), 10);
    }

    function _activate() internal {
        vm.prank(lender); facility.fundAsLender{value: 1000 ether}(id);
        vm.prank(borrower); facility.postBond{value: 200 ether}(id);
        vm.prank(borrower); facility.activate(id);
    }

    function _draw(uint256 amount) internal {
        vm.prank(borrower); facility.requestDraw(id, amount);
        vm.roll(block.number + 10);
        vm.prank(borrower); facility.executeDraw(id);
    }

    function test_activationRequiresBothSides() public {
        vm.prank(lender); facility.fundAsLender{value: 1000 ether}(id);
        vm.prank(borrower);
        vm.expectRevert();
        facility.activate(id);
    }

    function test_drawRequiresDelayToElapse() public {
        _activate();
        vm.prank(borrower); facility.requestDraw(id, 400 ether);
        vm.prank(borrower);
        vm.expectRevert();
        facility.executeDraw(id);
        vm.roll(block.number + 10);
        vm.prank(borrower); facility.executeDraw(id);
        assertEq(facility.availableCredit(id), 600 ether);
    }

    function test_drawBeyondLimitReverts() public {
        _activate();
        vm.prank(borrower);
        vm.expectRevert();
        facility.requestDraw(id, 1001 ether);
    }

    function test_breachFreezesUndrawnCapacityAndPaysHunter() public {
        _activate();
        _draw(400 ether);
        uint256 hunterBefore = hunter.balance;
        vm.prank(adjudicator); facility.reportBreach(id, hunter);
        assertEq(uint256(facility.state(id)), uint256(FacilityState.Breached));
        assertEq(hunter.balance - hunterBefore, 40 ether);
        assertEq(facility.availableCredit(id), 0);
    }

    function test_slashIsAppliedAgainstDebtNotAsWindfall() public {
        _activate();
        _draw(400 ether);
        uint256 debtBefore = facility.outstandingDebt(id);
        vm.prank(adjudicator); facility.reportBreach(id, hunter);
        assertEq(facility.outstandingDebt(id), debtBefore - 160 ether);
    }

    function test_drawBlockedAfterBreach() public {
        _activate();
        vm.prank(adjudicator); facility.reportBreach(id, hunter);
        vm.prank(borrower);
        vm.expectRevert();
        facility.requestDraw(id, 100 ether);
    }

    function test_doubleBreachReverts() public {
        _activate();
        vm.prank(adjudicator); facility.reportBreach(id, hunter);
        vm.prank(adjudicator);
        vm.expectRevert();
        facility.reportBreach(id, hunter);
    }

    function test_onlyAdjudicatorCanReportBreach() public {
        _activate();
        vm.prank(borrower);
        vm.expectRevert();
        facility.reportBreach(id, hunter);
    }

    function test_repayInFullClosesFacility() public {
        _activate();
        _draw(400 ether);
        uint256 debt = facility.outstandingDebt(id);
        vm.prank(borrower); facility.repay{value: debt}(id);
        assertEq(uint256(facility.state(id)), uint256(FacilityState.Repaid));
        assertEq(facility.outstandingDebt(id), 0);
    }

    function test_overpaymentIsRefunded() public {
        _activate();
        _draw(400 ether);
        uint256 debt = facility.outstandingDebt(id);
        uint256 balanceBefore = borrower.balance;
        vm.prank(borrower); facility.repay{value: debt + 5 ether}(id);
        assertEq(borrower.balance, balanceBefore - debt);
    }

    function test_breachWithZeroDebtDoesNotOverpayLender() public {
        _activate();
        vm.prank(adjudicator); facility.reportBreach(id, hunter);
        assertEq(facility.outstandingDebt(id), 0);
    }

    function test_maturityWithDebtAllowsDefault() public {
        _activate();
        _draw(400 ether);
        vm.roll(block.number + 100001);
        facility.markDefaulted(id);
        assertEq(uint256(facility.state(id)), uint256(FacilityState.Defaulted));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `forge test --match-path test/RecourseFacility.t.sol -vv`
Expected: compilation failure — `RecourseFacility` does not exist yet.

- [ ] **Step 3: Implement `contracts/RecourseFacility.sol`**

Implement the state machine above and in spec §2. Requirements:
- Checks-effects-interactions on every native transfer; use `(bool ok, ) = to.call{value: amount}("")` and revert `TransferFailed()` when it fails.
- `requestDraw` stores `(amount, readyAtBlock = block.number + drawDelayBlocks)` and requires `Active` plus `amount <= availableCredit`; `executeDraw` requires `Active`, `block.number >= readyAtBlock`, and clears the request.
- `reportBreach` requires `Active` and `msg.sender == adjudicator`; it is the sole `Active → Breached` transition and reverts if already breached.
- Emit an event for every transition: `FacilityOpened`, `FacilityActivated`, `DrawRequested`, `DrawExecuted`, `Repaid`, `Breached`, `Defaulted`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `forge test --match-path test/RecourseFacility.t.sol -vv`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add contracts/RecourseFacility.sol contracts/interfaces/IRecourseFacility.sol test/RecourseFacility.t.sol
git commit -m "feat: recourse facility credit state machine"
```

---

### Task 3: AttestcoinAdjudicator

The only contract that touches the precompile.

**Files:**
- Create: `contracts/AttestcoinAdjudicator.sol`
- Test: `test/AttestcoinAdjudicator.t.sol`

**Interfaces:**
- Consumes: `INativeQueryVerifier`, `EvmV1Decoder`, `ICovenant`, `IRecourseFacility`, `ProvenTx`.
- Produces:
  - `constructor(INativeQueryVerifier verifier, IRecourseFacility facility)`
  - `function registerCovenant(uint256 facilityId, uint256 covenantId, ICovenant covenant) external`
  - `function submitBatch(uint256 facilityId, uint256 covenantId, uint64 chainKey, uint64[] calldata heights, bytes[] calldata encodedTransactions, INativeQueryVerifier.MerkleProof[] calldata merkleProofs, INativeQueryVerifier.ContinuityProof calldata sharedContinuityProof) external`
  - `function submitSingle(uint256 facilityId, uint256 covenantId, uint64 chainKey, uint64 height, bytes calldata encodedTransaction, INativeQueryVerifier.MerkleProof calldata merkleProof, INativeQueryVerifier.ContinuityProof calldata continuityProof) external`
  - `function queryId(uint64 chainKey, uint64 blockHeight, uint64 txIndex) public pure returns (bytes32)`
  - `function isProcessed(uint256 facilityId, uint256 covenantId, bytes32 qid) external view returns (bool)`

Behaviour, in this exact order:
1. Call `verifier.verify(...)` (the `view` overload) for the whole batch. Revert `VerificationFailed()` if false.
2. For each transaction: decode the receipt; require `receiptStatus == 1` else revert `TransactionReverted()`; derive `txIndex` via `calculateTxIndex`; compute `queryId = keccak256(abi.encodePacked(chainKey, blockHeight, txIndex))`; revert `ProofAlreadyUsed` if already processed for `(facilityId, covenantId)`, including duplicates within the same batch.
3. Build `ProvenTx[]` and call `covenant.evaluate(facilityId, proven)`.
4. **Only after `evaluate` returns without reverting**, mark each `queryId` processed. This is the finding-4 fix: irrelevant evidence reverts and is never consumed.
5. If `evaluate` returned `true`, call `facility.reportBreach(facilityId, msg.sender)`.

- [ ] **Step 1: Write the failing tests `test/AttestcoinAdjudicator.t.sol`**

Write a `StubCovenant` configurable to return true, return false, or revert `IrrelevantEvidence`. Cover: verification failure reverts; a receipt with `receiptStatus == 0` reverts `TransactionReverted`; a replayed query reverts; duplicate query ids *within one batch* revert; irrelevant evidence reverts and leaves `isProcessed == false`; a breach result calls through to the facility and moves it to `Breached`; a non-breaching evaluation still marks the queries processed; submissions after breach revert.

For `encodedTransaction` fixtures, build minimal payloads with `abi.encode` matching the decoder's chunk layout, or load a real captured payload from `docs/demo-evidence.json` via `vm.readFile`. Prefer at least one real payload so the decode path is exercised against production data.

- [ ] **Step 2: Run tests to verify they fail**

Run: `forge test --match-path test/AttestcoinAdjudicator.t.sol -vv`
Expected: compilation failure — `AttestcoinAdjudicator` does not exist.

- [ ] **Step 3: Implement `contracts/AttestcoinAdjudicator.sol`**

Follow the behaviour list exactly. Use the `view` `verify` overload, not `verifyAndEmit`. Keep replay state as `mapping(uint256 => mapping(uint256 => mapping(bytes32 => bool)))` keyed facility → covenant → queryId. Emit `EvidenceAccepted(facilityId, covenantId, qid, submitter)` per transaction and `BreachReported(facilityId, covenantId, submitter)` on breach.

- [ ] **Step 4: Run tests to verify they pass**

Run: `forge test --match-path test/AttestcoinAdjudicator.t.sol -vv`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add contracts/AttestcoinAdjudicator.sol test/AttestcoinAdjudicator.t.sol
git commit -m "feat: attestcoin adjudicator with replay-safe proof intake"
```

---

### Task 4: OutflowCapCovenant (hero predicate)

**Files:**
- Create: `contracts/covenants/OutflowCapCovenant.sol`
- Test: `test/covenants/OutflowCapCovenant.t.sol`

**Interfaces:**
- Consumes: `ICovenant`, `ProvenTx`, `EvmV1Decoder`.
- Produces: `function configure(uint256 facilityId, uint64 chainKey, address token, address treasury, uint64 startSourceBlock, uint64 endSourceBlock, uint256 capBaseUnits) external` and `function accumulated(uint256 facilityId) external view returns (uint256)`.

Semantics (spec §3, audit finding 9):
- A log qualifies when `log.address_ == token`, `topics[0] == keccak256("Transfer(address,address,uint256)")`, `from == treasury`, and `to != treasury`.
- `from` is `address(uint160(uint256(topics[1])))`; `to` is `address(uint160(uint256(topics[2])))`; value is `abi.decode(log.data, (uint256))`.
- Require `topics.length == 3` and `data.length == 32` before decoding.
- Sum **all** qualifying logs in a receipt, with checked arithmetic.
- Only count transactions whose `blockHeight` is within `[startSourceBlock, endSourceBlock]` and whose `chainKey` matches.
- Revert `IrrelevantEvidence()` when the batch contains no qualifying log at all.
- Breach strictly when `accumulated > capBaseUnits`.
- Only the adjudicator may call `evaluate`.

- [ ] **Step 1: Write the failing tests**

Cover: a single transfer under the cap does not breach; cumulative crossing breaches; exactly-at-cap does NOT breach (strict `>`); self-transfer excluded; wrong token ignored; wrong sender ignored; out-of-window block ignored; wrong chainKey ignored; a batch with zero qualifying logs reverts `IrrelevantEvidence`; multiple qualifying logs inside one receipt are all counted.

- [ ] **Step 2: Run tests to verify they fail**

Run: `forge test --match-path test/covenants/OutflowCapCovenant.t.sol -vv`
Expected: compilation failure.

- [ ] **Step 3: Implement the covenant**

Derive the signature in-contract:

```solidity
bytes32 internal constant TRANSFER_SIG = keccak256("Transfer(address,address,uint256)");
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `forge test --match-path test/covenants/OutflowCapCovenant.t.sol -vv`
Expected: all tests pass.

- [ ] **Step 5: Run the whole suite and commit**

```bash
forge test
git add contracts/covenants/OutflowCapCovenant.sol test/covenants/OutflowCapCovenant.t.sol
git commit -m "feat: cumulative outflow cap covenant"
```

---

### Task 5: Deploy to CC3 Testnet and prove the hero path live

The checkpoint that matters. Until a real mainnet batch triggers a real breach on CC3, nothing is proven.

**Files:**
- Create: `scripts/deploy.mjs`, `scripts/demo-setup.mjs`, `scripts/submit.mjs`
- Create: `deployments.json` (generated)

**Interfaces:**
- Consumes: `docs/demo-evidence.json`, `scripts/lib/proofs.mjs`, compiled artifacts under `out/`.
- Produces: `deployments.json` = `{ facility, adjudicator, outflowCovenant, facilityId, blockNumber }`.

- [ ] **Step 1: Write `scripts/deploy.mjs`**

Read artifacts from `out/<Name>.sol/<Name>.json`, deploy `RecourseFacility`, then `AttestcoinAdjudicator` (constructor takes the real precompile address from `BLOCK_PROVER_PRECOMPILE` and the facility address), then `OutflowCapCovenant`. Call `setAdjudicator`. Write `deployments.json`. Apply the gas fallback from Global Constraints on estimation failure.

- [ ] **Step 2: Deploy**

Run: `node scripts/deploy.mjs`
Expected: three addresses printed and `deployments.json` written. Confirm each on `https://creditcoin-testnet.blockscout.com/`.

- [ ] **Step 3: Write and run `scripts/demo-setup.mjs`**

Fund lender/borrower/hunter from the deployer; open the facility using the evidence set's `treasury`, `token`, block window and `capBaseUnits`; register the covenant; fund; bond; activate; request a 400 tCTC draw, wait out the draw delay, and execute it.

Run: `node scripts/demo-setup.mjs`
Expected: facility reaches `Active` with a 400 tCTC draw executed.

- [ ] **Step 4: Write and run `scripts/submit.mjs`**

Pre-warm proofs for every hash in the evidence set, fetch the batch proof via `fetchBatchProof`, call `submitBatch`, then print resulting state, gas used, hunter payout and debt change.

Run: `node scripts/submit.mjs`
Expected: transaction succeeds; facility state becomes `Breached`; the hunter receives 20% of the bond; outstanding debt drops by the capped 80%. **Record the exact gas used** — the spec requires this number for the demo gas ceiling.

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy.mjs scripts/demo-setup.mjs scripts/submit.mjs deployments.json
git commit -m "feat: deploy to CC3 testnet and prove hero path end to end"
```

**HERO FEATURE FREEZE (spec: Aug 28).** Do not start Task 6 until this task passes on live testnet.

---

### Task 6: Covenants 2 and 3

Additive single-proof evaluators. Same `ICovenant` interface, same adjudicator, no changes to Tasks 2–5.

**Files:**
- Create: `contracts/covenants/NewBorrowCovenant.sol`, `test/covenants/NewBorrowCovenant.t.sol`
- Create: `contracts/covenants/LpLockCovenant.sol`, `test/covenants/LpLockCovenant.t.sol`

Both MUST store and enforce the **exact emitting contract address** (audit finding 6): a covenant matches only when `log.address_` equals the configured protocol contract, because any contract can emit any event signature. Covenant 2 matches Aave V3 `Borrow` with the committed `onBehalfOf`. Covenant 3 matches Uniswap V3 `NonfungiblePositionManager.DecreaseLiquidity` for the committed `tokenId` and requires the block to be before `endSourceBlock`.

Derive both event signatures with `keccak256("...")` from the real protocol ABIs — look them up, do not trust memory, and record the source of each in a comment.

- [ ] **Step 1: Write failing tests for both covenants**

Cover for each: wrong emitter rejected; wrong subject (address / tokenId) rejected; out-of-window rejected; reverted receipt rejected; irrelevant batch reverts `IrrelevantEvidence`; happy path breaches.

- [ ] **Step 2: Run to verify they fail**

Run: `forge test --match-path "test/covenants/*" -vv`

- [ ] **Step 3: Implement both covenants**

- [ ] **Step 4: Run the full suite**

Run: `forge test`
Expected: everything green.

- [ ] **Step 5: Commit**

```bash
git add contracts/covenants test/covenants
git commit -m "feat: new-borrow and lp-lock covenants"
```

**CONTRACT FREEZE (spec: Aug 30).** No contract changes after this task except defect fixes.

---

### Task 7: Dashboard

**Files:**
- Create: `web/index.html`, `web/app.js`, `web/style.css`

Read-only, static, no build step, no framework, no external CDN (vendor ethers locally). Loads `deployments.json` and reads contract state directly over the CC3 RPC. Shows: facility state badge; limit / drawn / available / outstanding debt; bond; the covenant's treasury, token, block window and cap; accumulated proven outflow versus cap as a progress bar; and after breach, the proven transactions with Etherscan links plus the hunter's payout.

Legible in both light and dark. No wallet connection — the demo drives state through scripts.

- [ ] **Step 1: Build the page against `deployments.json`**
- [ ] **Step 2: Verify it renders live testnet state correctly, before and after breach**
- [ ] **Step 3: Commit**

```bash
git add web
git commit -m "feat: read-only facility dashboard"
```

---

### Task 8: Submission materials

**Files:**
- Modify: `README.md`
- Create: `docs/attestcoin-integration.md`

- [ ] **Step 1: Write `docs/attestcoin-integration.md`**

This is what judges read for the "depth of Attestcoin utilization" score. State precisely which parts of the protocol are load-bearing and why: batch verification through the BlockProver precompile under one shared continuity proof; on-chain receipt decoding; **explicit `receiptStatus == 1` checking, because the precompile does not validate transaction success**; transaction-index-derived replay keys; and the fact that aggregating several individually-innocuous transfers into one breach is only possible because all of that is verified on-chain. Include the real mainnet transaction hashes and the measured gas from Task 5.

- [ ] **Step 2: Update `README.md`**

Add deployed addresses with explorer links, a quickstart that reproduces the demo, and an honest-limitations section: read-only season with no write-back, hunter MEV disclosed and not solved, historical mainnet evidence labelled as a simulation over real data. List the roadmap items (writability-based auto-repayment, hunter commit/reveal, proof-of-compliance deadlines).

- [ ] **Step 3: Commit**

```bash
git add README.md docs/attestcoin-integration.md
git commit -m "docs: attestcoin integration summary and submission readme"
```

---

## Post-build: audit

After Task 8, run a full audit pass over the whole repository — contracts, scripts, tests and docs — with particular attention to: receipt-status enforcement on every path; replay-key scoping and the ordering of consumption versus evaluation; native-transfer safety and reentrancy; asset-conservation invariants; and anywhere a covenant could be satisfied by a forged or irrelevant log. Fix findings by severity, re-run `forge test`, and re-run the live hero path before recording the demo.
