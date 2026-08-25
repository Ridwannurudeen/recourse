// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/write-ability/common/EvmV1Decoder.sol";
import {INativeQueryVerifier} from "@gluwa/usc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";
import {AttestcoinAdjudicator} from "../../contracts/AttestcoinAdjudicator.sol";
import {OutflowCapCovenant} from "../../contracts/covenants/OutflowCapCovenant.sol";
import {RecourseFacility} from "../../contracts/RecourseFacility.sol";
import {MockVerifier} from "../mocks/MockVerifier.sol";
import {
    FacilityState,
    IrrelevantEvidence,
    NotAdjudicator,
    NotLender,
    ProofAlreadyUsed,
    ProvenTx,
    TransactionReverted,
    WrongState
} from "../../contracts/types/RecourseTypes.sol";

contract OutflowCapCovenantTest is Test {
    uint64 private constant CHAIN_KEY = 3;
    uint64 private constant START_BLOCK = 25_826_525;
    uint64 private constant END_BLOCK = 25_826_559;
    address private constant TOKEN = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address private constant TREASURY = 0xBaA67174531f0C031f91a373F6788c7e821AF2C5;
    address private constant RECIPIENT = address(0xD4);

    RecourseFacility private facility;
    OutflowCapCovenant private covenant;
    address private lender = address(0xA1);
    address private borrower = address(0xB2);
    address private outsider = address(0xC3);
    uint256 private facilityId;

    function setUp() public {
        facility = new RecourseFacility();
        facility.setAdjudicator(address(this));
        covenant = new OutflowCapCovenant(facility);
        vm.deal(lender, 1000 ether);
        vm.deal(borrower, 200 ether);
        facilityId =
            facility.openFacility(lender, borrower, 1000 ether, 200 ether, 200, uint64(block.number + 100_000), 10);
    }

    function test_singleTransferUnderCapDoesNotBreach() public {
        _configureAndActivate(100);

        bool breached =
            covenant.evaluate(facilityId, _singleProven(CHAIN_KEY, START_BLOCK, TOKEN, TREASURY, RECIPIENT, 40));

        assertFalse(breached);
        assertEq(covenant.accumulated(facilityId), 40);
    }

    function test_cumulativeCrossingBreachesWhenEveryTransferIsUnderCap() public {
        _configureAndActivate(100);
        ProvenTx[] memory proven = new ProvenTx[](3);
        proven[0] = _proven(CHAIN_KEY, START_BLOCK, _receipt(1, _logs(_transfer(TOKEN, TREASURY, RECIPIENT, 40))));
        proven[1] = _proven(CHAIN_KEY, START_BLOCK + 1, _receipt(1, _logs(_transfer(TOKEN, TREASURY, RECIPIENT, 35))));
        proven[2] = _proven(CHAIN_KEY, START_BLOCK + 2, _receipt(1, _logs(_transfer(TOKEN, TREASURY, RECIPIENT, 30))));

        bool breached = covenant.evaluate(facilityId, proven);

        assertTrue(breached);
        assertEq(covenant.accumulated(facilityId), 105);
    }

    function test_exactlyAtCapDoesNotBreach() public {
        _configureAndActivate(100);

        bool breached =
            covenant.evaluate(facilityId, _singleProven(CHAIN_KEY, START_BLOCK, TOKEN, TREASURY, RECIPIENT, 100));

        assertFalse(breached);
        assertEq(covenant.accumulated(facilityId), 100);
    }

    function test_selfTransferIsExcluded() public {
        _configureAndActivate(100);
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](2);
        logs[0] = _transfer(TOKEN, TREASURY, TREASURY, 90);
        logs[1] = _transfer(TOKEN, TREASURY, RECIPIENT, 20);

        bool breached = covenant.evaluate(facilityId, _singleProven(CHAIN_KEY, START_BLOCK, _receipt(1, logs)));

        assertFalse(breached);
        assertEq(covenant.accumulated(facilityId), 20);
    }

    function test_wrongTokenIsIgnored() public {
        _configureAndActivate(100);
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](2);
        logs[0] = _transfer(address(0xBAD), TREASURY, RECIPIENT, 90);
        logs[1] = _transfer(TOKEN, TREASURY, RECIPIENT, 20);

        covenant.evaluate(facilityId, _singleProven(CHAIN_KEY, START_BLOCK, _receipt(1, logs)));

        assertEq(covenant.accumulated(facilityId), 20);
    }

    function test_wrongSenderIsIgnored() public {
        _configureAndActivate(100);
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](2);
        logs[0] = _transfer(TOKEN, outsider, RECIPIENT, 90);
        logs[1] = _transfer(TOKEN, TREASURY, RECIPIENT, 20);

        covenant.evaluate(facilityId, _singleProven(CHAIN_KEY, START_BLOCK, _receipt(1, logs)));

        assertEq(covenant.accumulated(facilityId), 20);
    }

    function test_wrongEventSignatureIsIgnored() public {
        _configureAndActivate(100);
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](2);
        logs[0] = _transfer(TOKEN, TREASURY, RECIPIENT, 90);
        logs[0].topics[0] = keccak256("Approval(address,address,uint256)");
        logs[1] = _transfer(TOKEN, TREASURY, RECIPIENT, 20);

        covenant.evaluate(facilityId, _singleProven(CHAIN_KEY, START_BLOCK, _receipt(1, logs)));

        assertEq(covenant.accumulated(facilityId), 20);
    }

    function test_fourTopicLogIsIgnored() public {
        _configureAndActivate(100);
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](2);
        logs[0] = _malformedTransfer(TOKEN, 4, abi.encode(uint256(90)));
        logs[1] = _transfer(TOKEN, TREASURY, RECIPIENT, 20);

        covenant.evaluate(facilityId, _singleProven(CHAIN_KEY, START_BLOCK, _receipt(1, logs)));

        assertEq(covenant.accumulated(facilityId), 20);
    }

    function test_blockOutsideInclusiveWindowIsIgnored() public {
        _configureAndActivate(100);
        ProvenTx[] memory proven = new ProvenTx[](3);
        proven[0] = _proven(CHAIN_KEY, START_BLOCK - 1, _receipt(1, _logs(_transfer(TOKEN, TREASURY, RECIPIENT, 90))));
        proven[1] = _proven(CHAIN_KEY, END_BLOCK + 1, _receipt(1, _logs(_transfer(TOKEN, TREASURY, RECIPIENT, 90))));
        proven[2] = _proven(CHAIN_KEY, START_BLOCK, _receipt(1, _logs(_transfer(TOKEN, TREASURY, RECIPIENT, 20))));

        covenant.evaluate(facilityId, proven);

        assertEq(covenant.accumulated(facilityId), 20);
    }

    function test_windowEndpointsAreIncluded() public {
        _configureAndActivate(100);
        ProvenTx[] memory proven = new ProvenTx[](2);
        proven[0] = _proven(CHAIN_KEY, START_BLOCK, _receipt(1, _logs(_transfer(TOKEN, TREASURY, RECIPIENT, 20))));
        proven[1] = _proven(CHAIN_KEY, END_BLOCK, _receipt(1, _logs(_transfer(TOKEN, TREASURY, RECIPIENT, 30))));

        covenant.evaluate(facilityId, proven);

        assertEq(covenant.accumulated(facilityId), 50);
    }

    function test_wrongChainKeyIsIgnored() public {
        _configureAndActivate(100);
        ProvenTx[] memory proven = new ProvenTx[](2);
        proven[0] = _proven(CHAIN_KEY + 1, START_BLOCK, _receipt(1, _logs(_transfer(TOKEN, TREASURY, RECIPIENT, 90))));
        proven[1] = _proven(CHAIN_KEY, START_BLOCK, _receipt(1, _logs(_transfer(TOKEN, TREASURY, RECIPIENT, 20))));

        covenant.evaluate(facilityId, proven);

        assertEq(covenant.accumulated(facilityId), 20);
    }

    function test_malformedLogsAreSkippedWithoutRevertingTheReceipt() public {
        _configureAndActivate(100);
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](3);
        logs[0] = _malformedTransfer(TOKEN, 2, abi.encode(uint256(90)));
        logs[1] = _malformedTransfer(TOKEN, 3, hex"01");
        logs[2] = _transfer(TOKEN, TREASURY, RECIPIENT, 20);

        covenant.evaluate(facilityId, _singleProven(CHAIN_KEY, START_BLOCK, _receipt(1, logs)));

        assertEq(covenant.accumulated(facilityId), 20);
    }

    function test_batchWithZeroQualifyingLogsReverts() public {
        _configureAndActivate(100);

        vm.expectRevert(IrrelevantEvidence.selector);
        covenant.evaluate(facilityId, _singleProven(CHAIN_KEY, START_BLOCK, address(0xBAD), TREASURY, RECIPIENT, 20));
        assertEq(covenant.accumulated(facilityId), 0);
    }

    function test_zeroValueTransferIsStillQualifyingEvidence() public {
        _configureAndActivate(100);

        bool breached =
            covenant.evaluate(facilityId, _singleProven(CHAIN_KEY, START_BLOCK, TOKEN, TREASURY, RECIPIENT, 0));

        assertFalse(breached);
        assertEq(covenant.accumulated(facilityId), 0);
    }

    function test_multipleQualifyingLogsInOneReceiptAreAllCounted() public {
        _configureAndActivate(100);
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](3);
        logs[0] = _transfer(TOKEN, TREASURY, RECIPIENT, 20);
        logs[1] = _transfer(TOKEN, TREASURY, address(0xE5), 30);
        logs[2] = _transfer(TOKEN, TREASURY, address(0xF6), 40);

        bool breached = covenant.evaluate(facilityId, _singleProven(CHAIN_KEY, START_BLOCK, _receipt(1, logs)));

        assertFalse(breached);
        assertEq(covenant.accumulated(facilityId), 90);
    }

    function test_accumulationPersistsAndBreachesOnSecondSubmission() public {
        _configureAndActivate(100);
        bool firstBreached =
            covenant.evaluate(facilityId, _singleProven(CHAIN_KEY, START_BLOCK, TOKEN, TREASURY, RECIPIENT, 60));

        bool secondBreached =
            covenant.evaluate(facilityId, _singleProven(CHAIN_KEY, START_BLOCK + 1, TOKEN, TREASURY, RECIPIENT, 50));

        assertFalse(firstBreached);
        assertTrue(secondBreached);
        assertEq(covenant.accumulated(facilityId), 110);
    }

    function test_exactUintMaxBatchDoesNotBreach() public {
        _configureAndActivate(type(uint256).max);
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](2);
        logs[0] = _transfer(TOKEN, TREASURY, RECIPIENT, type(uint256).max - 1);
        logs[1] = _transfer(TOKEN, TREASURY, address(0xE5), 1);

        bool breached = covenant.evaluate(facilityId, _singleProven(CHAIN_KEY, START_BLOCK, _receipt(1, logs)));

        assertFalse(breached);
        assertEq(covenant.accumulated(facilityId), type(uint256).max);
    }

    function test_batchOverflowReturnsBreach() public {
        _configureAndActivate(type(uint256).max);
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](2);
        logs[0] = _transfer(TOKEN, TREASURY, RECIPIENT, type(uint256).max);
        logs[1] = _transfer(TOKEN, TREASURY, address(0xE5), 1);

        assertTrue(covenant.evaluate(facilityId, _singleProven(CHAIN_KEY, START_BLOCK, _receipt(1, logs))));
    }

    function test_accumulatorOverflowAcrossSubmissionsReturnsBreach() public {
        _configureAndActivate(type(uint256).max);
        assertFalse(
            covenant.evaluate(
                facilityId, _singleProven(CHAIN_KEY, START_BLOCK, TOKEN, TREASURY, RECIPIENT, type(uint256).max)
            )
        );

        assertTrue(
            covenant.evaluate(facilityId, _singleProven(CHAIN_KEY, START_BLOCK + 1, TOKEN, TREASURY, RECIPIENT, 1))
        );
        assertEq(covenant.accumulated(facilityId), type(uint256).max);
    }

    function test_sameReceiptUnderAliasedCovenantIdsIsCountedOnce() public {
        MockVerifier verifier = new MockVerifier();
        RecourseFacility replayFacility = new RecourseFacility();
        AttestcoinAdjudicator adjudicator = new AttestcoinAdjudicator(verifier, replayFacility);
        replayFacility.setAdjudicator(address(adjudicator));
        OutflowCapCovenant replayCovenant = new OutflowCapCovenant(replayFacility);
        uint256 replayFacilityId = replayFacility.openFacility(
            lender, borrower, 1000 ether, 200 ether, 200, uint64(block.number + 100_000), 10
        );

        vm.startPrank(lender);
        replayCovenant.configure(replayFacilityId, CHAIN_KEY, TOKEN, TREASURY, START_BLOCK, END_BLOCK, 100);
        adjudicator.registerCovenant(replayFacilityId, 1, replayCovenant);
        adjudicator.registerCovenant(replayFacilityId, 2, replayCovenant);
        replayFacility.fundAsLender{value: 1000 ether}(replayFacilityId);
        vm.stopPrank();
        vm.prank(borrower);
        replayFacility.postBond{value: 200 ether}(replayFacilityId);
        bytes32 expectedCovenantSet = adjudicator.covenantSetCommitment(replayFacilityId);
        vm.prank(borrower);
        replayFacility.activate(replayFacilityId, expectedCovenantSet);

        bytes memory encodedTransaction = _receipt(1, _logs(_transfer(TOKEN, TREASURY, RECIPIENT, 60)));
        INativeQueryVerifier.MerkleProof memory merkleProof;
        INativeQueryVerifier.ContinuityProof memory continuityProof;
        adjudicator.submitSingle(
            replayFacilityId, 1, CHAIN_KEY, START_BLOCK, encodedTransaction, merkleProof, continuityProof
        );

        bytes32 queryId = adjudicator.queryId(CHAIN_KEY, START_BLOCK, 0);
        vm.expectRevert(abi.encodeWithSelector(ProofAlreadyUsed.selector, queryId));
        adjudicator.submitSingle(
            replayFacilityId, 2, CHAIN_KEY, START_BLOCK, encodedTransaction, merkleProof, continuityProof
        );

        assertEq(replayCovenant.accumulated(replayFacilityId), 60);
        assertEq(uint256(replayFacility.state(replayFacilityId)), uint256(FacilityState.Active));
    }

    function test_realMainnetFixtureCountsProductionEncodedTransfer() public {
        _configureAndActivate(232_545_000);
        bytes memory encodedTransaction =
            vm.parseBytes(vm.trim(vm.readFile("test/fixtures/mainnet-encoded-transaction.hex")));

        bool breached = covenant.evaluate(facilityId, _provenArray(_proven(CHAIN_KEY, START_BLOCK, encodedTransaction)));

        assertFalse(breached);
        assertEq(covenant.accumulated(facilityId), 8_580_000);
    }

    function test_revertedReceiptIsRejected() public {
        _configureAndActivate(100);

        vm.expectRevert(TransactionReverted.selector);
        covenant.evaluate(
            facilityId, _singleProvenWithStatus(0, CHAIN_KEY, START_BLOCK, TOKEN, TREASURY, RECIPIENT, 20)
        );
    }

    function test_configureByNonLenderReverts() public {
        vm.expectRevert(NotLender.selector);
        vm.prank(outsider);
        covenant.configure(facilityId, CHAIN_KEY, TOKEN, TREASURY, START_BLOCK, END_BLOCK, 100);
    }

    function test_configureAfterActivationReverts() public {
        _activate();

        vm.expectRevert(abi.encodeWithSelector(WrongState.selector, FacilityState.Created, FacilityState.Active));
        vm.prank(lender);
        covenant.configure(facilityId, CHAIN_KEY, TOKEN, TREASURY, START_BLOCK, END_BLOCK, 100);
    }

    function test_configureCannotOverwrite() public {
        vm.startPrank(lender);
        covenant.configure(facilityId, CHAIN_KEY, TOKEN, TREASURY, START_BLOCK, END_BLOCK, 100);
        vm.expectRevert(OutflowCapCovenant.CovenantAlreadyConfigured.selector);
        covenant.configure(facilityId, CHAIN_KEY, TOKEN, TREASURY, START_BLOCK, END_BLOCK, 200);
        vm.stopPrank();
    }

    function test_onlyFacilityAdjudicatorCanEvaluate() public {
        _configureAndActivate(100);

        vm.expectRevert(NotAdjudicator.selector);
        vm.prank(outsider);
        covenant.evaluate(facilityId, _singleProven(CHAIN_KEY, START_BLOCK, TOKEN, TREASURY, RECIPIENT, 20));
    }

    function test_covenantKind() public view {
        assertEq(covenant.covenantKind(), "outflow-cap");
    }

    function _configureAndActivate(uint256 cap) private {
        vm.prank(lender);
        covenant.configure(facilityId, CHAIN_KEY, TOKEN, TREASURY, START_BLOCK, END_BLOCK, cap);
        _activate();
    }

    function _activate() private {
        vm.prank(lender);
        facility.fundAsLender{value: 1000 ether}(facilityId);
        vm.prank(borrower);
        facility.postBond{value: 200 ether}(facilityId);
        vm.prank(borrower);
        facility.activate(facilityId, bytes32(0));
    }

    function covenantSetCommitment(uint256) external pure returns (bytes32) {
        return bytes32(0);
    }

    function _singleProven(uint64 chainKey, uint64 height, address token, address from, address to, uint256 value)
        private
        pure
        returns (ProvenTx[] memory)
    {
        return _singleProvenWithStatus(1, chainKey, height, token, from, to, value);
    }

    function _singleProven(uint64 chainKey, uint64 height, bytes memory encodedTransaction)
        private
        pure
        returns (ProvenTx[] memory)
    {
        return _provenArray(_proven(chainKey, height, encodedTransaction));
    }

    function _singleProvenWithStatus(
        uint8 receiptStatus,
        uint64 chainKey,
        uint64 height,
        address token,
        address from,
        address to,
        uint256 value
    ) private pure returns (ProvenTx[] memory) {
        return _provenArray(
            _proven(chainKey, height, _receipt(receiptStatus, _logs(_transfer(token, from, to, value))))
        );
    }

    function _provenArray(ProvenTx memory provenTx) private pure returns (ProvenTx[] memory proven) {
        proven = new ProvenTx[](1);
        proven[0] = provenTx;
    }

    function _proven(uint64 chainKey, uint64 height, bytes memory encodedTransaction)
        private
        pure
        returns (ProvenTx memory)
    {
        return ProvenTx({chainKey: chainKey, blockHeight: height, txIndex: 0, encodedTransaction: encodedTransaction});
    }

    function _receipt(uint8 status, EvmV1Decoder.LogEntryTuple[] memory logs) private pure returns (bytes memory) {
        bytes[] memory chunks = new bytes[](3);
        chunks[2] = abi.encode(status, uint64(1), logs, bytes(""));
        return abi.encode(uint8(2), chunks);
    }

    function _logs(EvmV1Decoder.LogEntryTuple memory log)
        private
        pure
        returns (EvmV1Decoder.LogEntryTuple[] memory logs)
    {
        logs = new EvmV1Decoder.LogEntryTuple[](1);
        logs[0] = log;
    }

    function _transfer(address token, address from, address to, uint256 value)
        private
        pure
        returns (EvmV1Decoder.LogEntryTuple memory)
    {
        bytes32[] memory topics = new bytes32[](3);
        topics[0] = keccak256("Transfer(address,address,uint256)");
        topics[1] = bytes32(uint256(uint160(from)));
        topics[2] = bytes32(uint256(uint160(to)));
        return EvmV1Decoder.LogEntryTuple({address_: token, topics: topics, data: abi.encode(value)});
    }

    function _malformedTransfer(address token, uint256 topicCount, bytes memory data)
        private
        pure
        returns (EvmV1Decoder.LogEntryTuple memory)
    {
        bytes32[] memory topics = new bytes32[](topicCount);
        if (topicCount > 0) topics[0] = keccak256("Transfer(address,address,uint256)");
        if (topicCount > 1) topics[1] = bytes32(uint256(uint160(TREASURY)));
        if (topicCount > 2) topics[2] = bytes32(uint256(uint160(RECIPIENT)));
        return EvmV1Decoder.LogEntryTuple({address_: token, topics: topics, data: data});
    }
}
