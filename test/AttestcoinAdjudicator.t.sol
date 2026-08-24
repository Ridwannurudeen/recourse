// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/write-ability/common/EvmV1Decoder.sol";
import {INativeQueryVerifier} from "@gluwa/usc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";
import {AttestcoinAdjudicator} from "../contracts/AttestcoinAdjudicator.sol";
import {RecourseFacility} from "../contracts/RecourseFacility.sol";
import {OutflowCapCovenant} from "../contracts/covenants/OutflowCapCovenant.sol";
import {ICovenant} from "../contracts/interfaces/ICovenant.sol";
import {
    FacilityState,
    IrrelevantEvidence,
    NotLender,
    ProofAlreadyUsed,
    ProvenTx,
    TransactionReverted,
    VerificationFailed,
    WrongState,
    ZeroAmount
} from "../contracts/types/RecourseTypes.sol";
import {MockVerifier} from "./mocks/MockVerifier.sol";

contract StubCovenant is ICovenant {
    enum Result {
        False,
        True,
        RevertIrrelevant
    }

    Result public result;

    function setResult(Result value) external {
        result = value;
    }

    function evaluate(uint256, ProvenTx[] calldata) external view returns (bool breached) {
        if (result == Result.RevertIrrelevant) revert IrrelevantEvidence();
        return result == Result.True;
    }

    function covenantKind() external pure returns (string memory) {
        return "stub";
    }
}

contract ReentrantCovenant is ICovenant {
    AttestcoinAdjudicator public immutable adjudicator;
    uint256 public facilityId;
    uint256 public covenantId;
    uint64 public chainKey;
    uint64 public height;
    bytes public encodedTransaction;

    constructor(AttestcoinAdjudicator adjudicator_) {
        adjudicator = adjudicator_;
    }

    function configure(
        uint256 facilityId_,
        uint256 covenantId_,
        uint64 chainKey_,
        uint64 height_,
        bytes calldata encodedTransaction_
    ) external {
        facilityId = facilityId_;
        covenantId = covenantId_;
        chainKey = chainKey_;
        height = height_;
        encodedTransaction = encodedTransaction_;
    }

    function evaluate(uint256, ProvenTx[] calldata) external returns (bool) {
        INativeQueryVerifier.MerkleProof memory merkleProof;
        INativeQueryVerifier.ContinuityProof memory continuityProof;
        adjudicator.submitSingle(
            facilityId, covenantId, chainKey, height, encodedTransaction, merkleProof, continuityProof
        );
        return false;
    }

    function covenantKind() external pure returns (string memory) {
        return "reentrant";
    }
}

contract AttestcoinAdjudicatorTest is Test {
    uint256 private constant COVENANT_ID = 1;
    uint256 private constant REENTRANT_COVENANT_ID = 2;
    uint256 private constant SECOND_COVENANT_ID = 3;
    uint256 private constant OUTFLOW_COVENANT_ID = 4;
    uint64 private constant CHAIN_KEY = 3;
    uint64 private constant HEIGHT = 25_826_525;

    RecourseFacility facility;
    MockVerifier verifier;
    AttestcoinAdjudicator adjudicator;
    StubCovenant covenant;
    StubCovenant secondCovenant;
    ReentrantCovenant reentrantCovenant;
    OutflowCapCovenant outflowCovenant;

    address lender = address(0xA1);
    address borrower = address(0xB2);
    address hunter = address(0xC3);
    uint256 facilityId;

    function setUp() public {
        facility = new RecourseFacility();
        verifier = new MockVerifier();
        adjudicator = new AttestcoinAdjudicator(verifier, facility);
        covenant = new StubCovenant();
        secondCovenant = new StubCovenant();
        reentrantCovenant = new ReentrantCovenant(adjudicator);
        outflowCovenant = new OutflowCapCovenant(facility);
        facility.setAdjudicator(address(adjudicator));

        vm.deal(lender, 2000 ether);
        vm.deal(borrower, 2000 ether);
        facilityId = _openFacility();
        vm.startPrank(lender);
        adjudicator.registerCovenant(facilityId, COVENANT_ID, covenant);
        adjudicator.registerCovenant(facilityId, REENTRANT_COVENANT_ID, reentrantCovenant);
        adjudicator.registerCovenant(facilityId, SECOND_COVENANT_ID, secondCovenant);
        adjudicator.registerCovenant(facilityId, OUTFLOW_COVENANT_ID, outflowCovenant);
        outflowCovenant.configure(facilityId, CHAIN_KEY, address(0x1000), address(0x2000), HEIGHT, HEIGHT + 2, 100);
        vm.stopPrank();
        _activate(facilityId);
    }

    function test_verificationFailureRevertsBeforeRegistrationCheck() public {
        verifier.setVerifyResult(false);
        vm.expectRevert(VerificationFailed.selector);
        _submitSingle(999, HEIGHT, _encodedTransaction(1));
    }

    function test_revertedReceiptReverts() public {
        vm.expectRevert(TransactionReverted.selector);
        _submitSingle(COVENANT_ID, HEIGHT, _encodedTransaction(0));
    }

    function test_batchRejectsAnyRevertedReceiptAndConsumesNothing() public {
        uint64[] memory heights = new uint64[](2);
        heights[0] = HEIGHT;
        heights[1] = HEIGHT + 1;
        bytes[] memory encodedTransactions = new bytes[](2);
        encodedTransactions[0] = _encodedTransaction(1);
        encodedTransactions[1] = _encodedTransaction(0);
        INativeQueryVerifier.MerkleProof[] memory merkleProofs = new INativeQueryVerifier.MerkleProof[](2);

        vm.expectRevert(TransactionReverted.selector);
        _submitBatch(COVENANT_ID, heights, encodedTransactions, merkleProofs);
        assertFalse(adjudicator.isProcessed(facilityId, COVENANT_ID, adjudicator.queryId(CHAIN_KEY, HEIGHT, 0)));
        assertFalse(adjudicator.isProcessed(facilityId, COVENANT_ID, adjudicator.queryId(CHAIN_KEY, HEIGHT + 1, 0)));
    }

    function test_usesViewVerifierOverload() public {
        _submitSingle(COVENANT_ID, HEIGHT, _encodedTransaction(1));
        assertEq(verifier.verifyCalls(), 0);
    }

    function test_batchUsesViewVerifierOverload() public {
        uint64[] memory heights = new uint64[](1);
        heights[0] = HEIGHT;
        bytes[] memory encodedTransactions = new bytes[](1);
        encodedTransactions[0] = _encodedTransaction(1);
        INativeQueryVerifier.MerkleProof[] memory merkleProofs = new INativeQueryVerifier.MerkleProof[](1);

        _submitBatch(COVENANT_ID, heights, encodedTransactions, merkleProofs);
        assertEq(verifier.verifyCalls(), 0);
    }

    function test_queryIdUsesPackedChainHeightAndTxIndex() public view {
        assertEq(adjudicator.queryId(CHAIN_KEY, HEIGHT, 7), keccak256(abi.encodePacked(CHAIN_KEY, HEIGHT, uint64(7))));
    }

    function test_queryIdUsesVerifierCalculatedTxIndex() public {
        verifier.setTxIndex(7);
        _submitSingle(COVENANT_ID, HEIGHT, _encodedTransaction(1));
        assertTrue(adjudicator.isProcessed(facilityId, COVENANT_ID, adjudicator.queryId(CHAIN_KEY, HEIGHT, 7)));
        assertFalse(adjudicator.isProcessed(facilityId, COVENANT_ID, adjudicator.queryId(CHAIN_KEY, HEIGHT, 0)));
    }

    function test_replayedQueryAcrossSubmissionsReverts() public {
        bytes memory encodedTransaction = _encodedTransaction(1);
        _submitSingle(COVENANT_ID, HEIGHT, encodedTransaction);

        bytes32 qid = adjudicator.queryId(CHAIN_KEY, HEIGHT, 0);
        assertTrue(adjudicator.isProcessed(facilityId, COVENANT_ID, qid));
        vm.expectRevert(abi.encodeWithSelector(ProofAlreadyUsed.selector, qid));
        _submitSingle(COVENANT_ID, HEIGHT, encodedTransaction);
    }

    function test_replayScopeIncludesFacilityAndCovenant() public {
        bytes memory encodedTransaction = _encodedTransaction(1);
        bytes32 qid = adjudicator.queryId(CHAIN_KEY, HEIGHT, 0);
        _submitSingle(COVENANT_ID, HEIGHT, encodedTransaction);
        _submitSingle(SECOND_COVENANT_ID, HEIGHT, encodedTransaction);

        uint256 otherFacilityId = _openFacility();
        vm.prank(lender);
        adjudicator.registerCovenant(otherFacilityId, COVENANT_ID, covenant);
        _activate(otherFacilityId);
        _submitSingleForFacility(otherFacilityId, COVENANT_ID, HEIGHT, encodedTransaction);

        assertTrue(adjudicator.isProcessed(facilityId, COVENANT_ID, qid));
        assertTrue(adjudicator.isProcessed(facilityId, SECOND_COVENANT_ID, qid));
        assertTrue(adjudicator.isProcessed(otherFacilityId, COVENANT_ID, qid));
    }

    function test_duplicateQueryInsideBatchReverts() public {
        uint64[] memory heights = new uint64[](2);
        heights[0] = HEIGHT;
        heights[1] = HEIGHT;
        bytes[] memory encodedTransactions = new bytes[](2);
        encodedTransactions[0] = _encodedTransaction(1);
        encodedTransactions[1] = _encodedTransaction(1);
        INativeQueryVerifier.MerkleProof[] memory merkleProofs = new INativeQueryVerifier.MerkleProof[](2);

        bytes32 qid = adjudicator.queryId(CHAIN_KEY, HEIGHT, 0);
        vm.expectRevert(abi.encodeWithSelector(ProofAlreadyUsed.selector, qid));
        _submitBatch(COVENANT_ID, heights, encodedTransactions, merkleProofs);
        assertFalse(adjudicator.isProcessed(facilityId, COVENANT_ID, qid));
    }

    function test_batchUsesEachProofToCalculateItsTransactionIndex() public {
        bytes32 firstRoot = bytes32(uint256(1));
        bytes32 secondRoot = bytes32(uint256(2));
        verifier.setTxIndexForRoot(firstRoot, 7);
        verifier.setTxIndexForRoot(secondRoot, 8);

        uint64[] memory heights = new uint64[](2);
        heights[0] = HEIGHT;
        heights[1] = HEIGHT;
        bytes[] memory encodedTransactions = new bytes[](2);
        encodedTransactions[0] = _encodedTransaction(1);
        encodedTransactions[1] = _encodedTransaction(1);
        INativeQueryVerifier.MerkleProof[] memory merkleProofs = new INativeQueryVerifier.MerkleProof[](2);
        merkleProofs[0].root = firstRoot;
        merkleProofs[1].root = secondRoot;

        _submitBatch(COVENANT_ID, heights, encodedTransactions, merkleProofs);
        assertTrue(adjudicator.isProcessed(facilityId, COVENANT_ID, adjudicator.queryId(CHAIN_KEY, HEIGHT, 7)));
        assertTrue(adjudicator.isProcessed(facilityId, COVENANT_ID, adjudicator.queryId(CHAIN_KEY, HEIGHT, 8)));
    }

    function test_irrelevantBatchConsumesNoQueries() public {
        covenant.setResult(StubCovenant.Result.RevertIrrelevant);
        uint64[] memory heights = new uint64[](2);
        heights[0] = HEIGHT;
        heights[1] = HEIGHT + 1;
        bytes[] memory encodedTransactions = new bytes[](2);
        encodedTransactions[0] = _encodedTransaction(1);
        encodedTransactions[1] = _encodedTransaction(1);
        INativeQueryVerifier.MerkleProof[] memory merkleProofs = new INativeQueryVerifier.MerkleProof[](2);

        vm.expectRevert(IrrelevantEvidence.selector);
        _submitBatch(COVENANT_ID, heights, encodedTransactions, merkleProofs);

        assertFalse(adjudicator.isProcessed(facilityId, COVENANT_ID, adjudicator.queryId(CHAIN_KEY, HEIGHT, 0)));
        assertFalse(adjudicator.isProcessed(facilityId, COVENANT_ID, adjudicator.queryId(CHAIN_KEY, HEIGHT + 1, 0)));
    }

    function test_nonBreachingEvaluationMarksQueriesProcessed() public {
        _submitSingle(COVENANT_ID, HEIGHT, _encodedTransaction(1));
        assertTrue(adjudicator.isProcessed(facilityId, COVENANT_ID, adjudicator.queryId(CHAIN_KEY, HEIGHT, 0)));
        assertEq(uint256(facility.state(facilityId)), uint256(FacilityState.Active));
    }

    function test_breachingEvaluationBreachesFacilityAndPaysHunter() public {
        covenant.setResult(StubCovenant.Result.True);
        uint256 hunterBefore = hunter.balance;
        _submitSingle(COVENANT_ID, HEIGHT, _encodedTransaction(1));

        assertEq(uint256(facility.state(facilityId)), uint256(FacilityState.Breached));
        assertEq(hunter.balance - hunterBefore, 40 ether);
        assertTrue(adjudicator.isProcessed(facilityId, COVENANT_ID, adjudicator.queryId(CHAIN_KEY, HEIGHT, 0)));
    }

    function test_nonBreachingSubmissionAfterBreachConsumesNothing() public {
        covenant.setResult(StubCovenant.Result.True);
        _submitSingle(COVENANT_ID, HEIGHT, _encodedTransaction(1));
        covenant.setResult(StubCovenant.Result.False);

        bytes32 nextQid = adjudicator.queryId(CHAIN_KEY, HEIGHT + 1, 0);
        vm.expectRevert(abi.encodeWithSelector(WrongState.selector, FacilityState.Active, FacilityState.Breached));
        _submitSingle(COVENANT_ID, HEIGHT + 1, _encodedTransaction(1));
        assertFalse(adjudicator.isProcessed(facilityId, COVENANT_ID, nextQid));
    }

    function test_unregisteredCovenantSubmissionConsumesNothing() public {
        bytes32 qid = adjudicator.queryId(CHAIN_KEY, HEIGHT, 0);
        vm.expectRevert(AttestcoinAdjudicator.CovenantNotRegistered.selector);
        _submitSingle(999, HEIGHT, _encodedTransaction(1));
        assertFalse(adjudicator.isProcessed(facilityId, 999, qid));
    }

    function test_reentrantSubmissionIsBlockedAndConsumesNothing() public {
        bytes memory encodedTransaction = _encodedTransaction(1);
        reentrantCovenant.configure(facilityId, REENTRANT_COVENANT_ID, CHAIN_KEY, HEIGHT, encodedTransaction);

        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        _submitSingle(REENTRANT_COVENANT_ID, HEIGHT, encodedTransaction);
        assertFalse(
            adjudicator.isProcessed(facilityId, REENTRANT_COVENANT_ID, adjudicator.queryId(CHAIN_KEY, HEIGHT, 0))
        );
    }

    function test_reentrantBatchSubmissionIsBlockedAndConsumesNothing() public {
        bytes memory encodedTransaction = _encodedTransaction(1);
        reentrantCovenant.configure(facilityId, REENTRANT_COVENANT_ID, CHAIN_KEY, HEIGHT, encodedTransaction);
        uint64[] memory heights = new uint64[](1);
        heights[0] = HEIGHT;
        bytes[] memory encodedTransactions = new bytes[](1);
        encodedTransactions[0] = encodedTransaction;
        INativeQueryVerifier.MerkleProof[] memory merkleProofs = new INativeQueryVerifier.MerkleProof[](1);

        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        _submitBatch(REENTRANT_COVENANT_ID, heights, encodedTransactions, merkleProofs);
        assertFalse(
            adjudicator.isProcessed(facilityId, REENTRANT_COVENANT_ID, adjudicator.queryId(CHAIN_KEY, HEIGHT, 0))
        );
    }

    function test_onlyLenderCanRegisterCovenant() public {
        uint256 otherFacilityId = _openFacility();
        vm.expectRevert(NotLender.selector);
        vm.prank(borrower);
        adjudicator.registerCovenant(otherFacilityId, 10, covenant);
    }

    function test_registrationAfterActivationReverts() public {
        vm.expectRevert(abi.encodeWithSelector(WrongState.selector, FacilityState.Created, FacilityState.Active));
        vm.prank(lender);
        adjudicator.registerCovenant(facilityId, 10, covenant);
    }

    function test_registrationCannotOverwrite() public {
        uint256 otherFacilityId = _openFacility();
        vm.startPrank(lender);
        adjudicator.registerCovenant(otherFacilityId, 10, covenant);
        vm.expectRevert(AttestcoinAdjudicator.CovenantAlreadyRegistered.selector);
        adjudicator.registerCovenant(otherFacilityId, 10, reentrantCovenant);
        vm.stopPrank();
    }

    function test_zeroAddressCovenantReverts() public {
        uint256 otherFacilityId = _openFacility();
        vm.expectRevert(ZeroAmount.selector);
        vm.prank(lender);
        adjudicator.registerCovenant(otherFacilityId, 10, ICovenant(address(0)));
    }

    function test_covenantOfReturnsRegistration() public view {
        assertEq(address(adjudicator.covenantOf(facilityId, COVENANT_ID)), address(covenant));
    }

    function test_realMainnetEncodedTransactionDecodesAndIsAccepted() public {
        bytes memory encodedTransaction =
            vm.parseBytes(vm.trim(vm.readFile("test/fixtures/mainnet-encoded-transaction.hex")));
        assertEq(encodedTransaction.length, 1664);

        _submitSingle(COVENANT_ID, HEIGHT, encodedTransaction);
        assertTrue(adjudicator.isProcessed(facilityId, COVENANT_ID, adjudicator.queryId(CHAIN_KEY, HEIGHT, 0)));
    }

    function test_outflowBatchCumulativeCrossingBreachesFacility() public {
        uint64[] memory heights = new uint64[](3);
        heights[0] = HEIGHT;
        heights[1] = HEIGHT + 1;
        heights[2] = HEIGHT + 2;
        bytes[] memory encodedTransactions = new bytes[](3);
        encodedTransactions[0] = _encodedTransferTransaction(40, address(0x3000));
        encodedTransactions[1] = _encodedTransferTransaction(35, address(0x4000));
        encodedTransactions[2] = _encodedTransferTransaction(30, address(0x5000));
        INativeQueryVerifier.MerkleProof[] memory merkleProofs = new INativeQueryVerifier.MerkleProof[](3);

        _submitBatch(OUTFLOW_COVENANT_ID, heights, encodedTransactions, merkleProofs);

        assertEq(outflowCovenant.accumulated(facilityId), 105);
        assertEq(uint256(facility.state(facilityId)), uint256(FacilityState.Breached));
        assertTrue(adjudicator.isProcessed(facilityId, OUTFLOW_COVENANT_ID, adjudicator.queryId(CHAIN_KEY, HEIGHT, 0)));
        assertTrue(
            adjudicator.isProcessed(facilityId, OUTFLOW_COVENANT_ID, adjudicator.queryId(CHAIN_KEY, HEIGHT + 1, 0))
        );
        assertTrue(
            adjudicator.isProcessed(facilityId, OUTFLOW_COVENANT_ID, adjudicator.queryId(CHAIN_KEY, HEIGHT + 2, 0))
        );
    }

    function _openFacility() internal returns (uint256) {
        return facility.openFacility(lender, borrower, 1000 ether, 200 ether, 200, uint64(block.number + 100_000), 10);
    }

    function _activate(uint256 id) internal {
        vm.prank(lender);
        facility.fundAsLender{value: 1000 ether}(id);
        vm.prank(borrower);
        facility.postBond{value: 200 ether}(id);
        vm.prank(borrower);
        facility.activate(id);
    }

    function _submitSingle(uint256 covenantId, uint64 height, bytes memory encodedTransaction) internal {
        _submitSingleForFacility(facilityId, covenantId, height, encodedTransaction);
    }

    function _submitSingleForFacility(uint256 id, uint256 covenantId, uint64 height, bytes memory encodedTransaction)
        internal
    {
        INativeQueryVerifier.MerkleProof memory merkleProof;
        INativeQueryVerifier.ContinuityProof memory continuityProof;
        vm.prank(hunter);
        adjudicator.submitSingle(id, covenantId, CHAIN_KEY, height, encodedTransaction, merkleProof, continuityProof);
    }

    function _submitBatch(
        uint256 covenantId,
        uint64[] memory heights,
        bytes[] memory encodedTransactions,
        INativeQueryVerifier.MerkleProof[] memory merkleProofs
    ) internal {
        INativeQueryVerifier.ContinuityProof memory continuityProof;
        vm.prank(hunter);
        adjudicator.submitBatch(
            facilityId, covenantId, CHAIN_KEY, heights, encodedTransactions, merkleProofs, continuityProof
        );
    }

    function _encodedTransaction(uint8 receiptStatus) internal pure returns (bytes memory) {
        bytes[] memory chunks = new bytes[](3);
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](0);
        chunks[2] = abi.encode(receiptStatus, uint64(1), logs, bytes(""));
        return abi.encode(uint8(2), chunks);
    }

    function _encodedTransferTransaction(uint256 value, address to) internal pure returns (bytes memory) {
        bytes32[] memory topics = new bytes32[](3);
        topics[0] = keccak256("Transfer(address,address,uint256)");
        topics[1] = bytes32(uint256(uint160(address(0x2000))));
        topics[2] = bytes32(uint256(uint160(to)));

        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](1);
        logs[0] = EvmV1Decoder.LogEntryTuple({address_: address(0x1000), topics: topics, data: abi.encode(value)});
        bytes[] memory chunks = new bytes[](3);
        chunks[2] = abi.encode(uint8(1), uint64(1), logs, bytes(""));
        return abi.encode(uint8(2), chunks);
    }
}
