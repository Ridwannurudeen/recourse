// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/write-ability/common/EvmV1Decoder.sol";
import {NewBorrowCovenant} from "../../contracts/covenants/NewBorrowCovenant.sol";
import {RecourseFacility} from "../../contracts/RecourseFacility.sol";
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

contract NewBorrowCovenantTest is Test {
    uint64 private constant CHAIN_KEY = 1;
    uint64 private constant START_BLOCK = 11_558_200;
    uint64 private constant END_BLOCK = 11_558_300;
    address private constant AAVE_POOL = 0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951;
    address private constant BORROWER_POSITION = address(0xB0);

    RecourseFacility private facility;
    NewBorrowCovenant private covenant;
    address private lender = address(0xA1);
    address private borrower = address(0xB2);
    address private outsider = address(0xC3);
    uint256 private facilityId;

    function setUp() public {
        facility = new RecourseFacility();
        facility.setAdjudicator(address(this));
        covenant = new NewBorrowCovenant(facility);
        vm.deal(lender, 1000 ether);
        vm.deal(borrower, 200 ether);
        facilityId =
            facility.openFacility(lender, borrower, 1000 ether, 200 ether, 200, uint64(block.number + 100_000), 10);
    }

    function test_happyPathBreaches() public {
        _configureAndActivate();

        bool breached =
            covenant.evaluate(facilityId, _singleProven(CHAIN_KEY, START_BLOCK, AAVE_POOL, BORROWER_POSITION, 0));

        assertTrue(breached);
    }

    function test_forgedBorrowEventFromWrongEmitterIsRejected() public {
        _configureAndActivate();

        vm.expectRevert(IrrelevantEvidence.selector);
        covenant.evaluate(facilityId, _singleProven(CHAIN_KEY, START_BLOCK, address(0xF0A6E), BORROWER_POSITION, 0));
    }

    function test_wrongOnBehalfOfIsRejected() public {
        _configureAndActivate();

        vm.expectRevert(IrrelevantEvidence.selector);
        covenant.evaluate(facilityId, _singleProven(CHAIN_KEY, START_BLOCK, AAVE_POOL, outsider, 0));
    }

    function test_outOfWindowIsRejected() public {
        _configureAndActivate();
        ProvenTx[] memory proven = new ProvenTx[](2);
        proven[0] = _proven(CHAIN_KEY, START_BLOCK - 1, 0, _receipt(1, _logs(_borrow(AAVE_POOL, BORROWER_POSITION))));
        proven[1] = _proven(CHAIN_KEY, END_BLOCK + 1, 1, _receipt(1, _logs(_borrow(AAVE_POOL, BORROWER_POSITION))));

        vm.expectRevert(IrrelevantEvidence.selector);
        covenant.evaluate(facilityId, proven);
    }

    function test_windowEndpointsAreIncluded() public {
        _configureAndActivate();
        ProvenTx[] memory proven = new ProvenTx[](2);
        proven[0] = _proven(CHAIN_KEY, START_BLOCK, 0, _receipt(1, _logs(_borrow(AAVE_POOL, BORROWER_POSITION))));
        proven[1] = _proven(CHAIN_KEY, END_BLOCK, 1, _receipt(1, _logs(_borrow(AAVE_POOL, BORROWER_POSITION))));

        assertTrue(covenant.evaluate(facilityId, proven));
    }

    function test_wrongChainKeyIsRejected() public {
        _configureAndActivate();

        vm.expectRevert(IrrelevantEvidence.selector);
        covenant.evaluate(facilityId, _singleProven(CHAIN_KEY + 1, START_BLOCK, AAVE_POOL, BORROWER_POSITION, 0));
    }

    function test_revertedReceiptIsRejected() public {
        _configureAndActivate();
        ProvenTx[] memory proven =
            _provenArray(_proven(CHAIN_KEY, START_BLOCK, 0, _receipt(0, _logs(_borrow(AAVE_POOL, BORROWER_POSITION)))));

        vm.expectRevert(TransactionReverted.selector);
        covenant.evaluate(facilityId, proven);
    }

    function test_irrelevantBatchRevertsWithoutConsumingEvidence() public {
        _configureAndActivate();
        ProvenTx[] memory irrelevant = _singleProven(CHAIN_KEY, START_BLOCK, AAVE_POOL, outsider, 7);

        vm.expectRevert(IrrelevantEvidence.selector);
        covenant.evaluate(facilityId, irrelevant);

        assertTrue(
            covenant.evaluate(facilityId, _singleProven(CHAIN_KEY, START_BLOCK, AAVE_POOL, BORROWER_POSITION, 7))
        );
    }

    function test_replayIsRejected() public {
        _configureAndActivate();
        ProvenTx[] memory proven = _singleProven(CHAIN_KEY, START_BLOCK, AAVE_POOL, BORROWER_POSITION, 4);
        covenant.evaluate(facilityId, proven);

        bytes32 queryId = keccak256(abi.encodePacked(CHAIN_KEY, START_BLOCK, uint64(4)));
        vm.expectRevert(abi.encodeWithSelector(ProofAlreadyUsed.selector, queryId));
        covenant.evaluate(facilityId, proven);
    }

    function test_duplicateQueryWithinBatchIsRejected() public {
        _configureAndActivate();
        ProvenTx[] memory proven = new ProvenTx[](2);
        proven[0] = _proven(CHAIN_KEY, START_BLOCK, 9, _receipt(1, _logs(_borrow(AAVE_POOL, BORROWER_POSITION))));
        proven[1] = _proven(CHAIN_KEY, START_BLOCK, 9, _receipt(1, _logs(_borrow(AAVE_POOL, BORROWER_POSITION))));

        bytes32 queryId = keccak256(abi.encodePacked(CHAIN_KEY, START_BLOCK, uint64(9)));
        vm.expectRevert(abi.encodeWithSelector(ProofAlreadyUsed.selector, queryId));
        covenant.evaluate(facilityId, proven);
    }

    function test_malformedLogsAreSkipped() public {
        _configureAndActivate();
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](3);
        logs[0] = _malformedBorrow(AAVE_POOL, BORROWER_POSITION, 3, new bytes(128));
        logs[1] = _malformedBorrow(AAVE_POOL, BORROWER_POSITION, 4, hex"01");
        logs[2] = _borrow(AAVE_POOL, BORROWER_POSITION);

        assertTrue(covenant.evaluate(facilityId, _provenArray(_proven(CHAIN_KEY, START_BLOCK, 0, _receipt(1, logs)))));
    }

    function test_configureByNonLenderReverts() public {
        vm.expectRevert(NotLender.selector);
        vm.prank(outsider);
        covenant.configure(facilityId, CHAIN_KEY, AAVE_POOL, BORROWER_POSITION, START_BLOCK, END_BLOCK);
    }

    function test_configureAfterActivationReverts() public {
        _activate();

        vm.expectRevert(abi.encodeWithSelector(WrongState.selector, FacilityState.Created, FacilityState.Active));
        vm.prank(lender);
        covenant.configure(facilityId, CHAIN_KEY, AAVE_POOL, BORROWER_POSITION, START_BLOCK, END_BLOCK);
    }

    function test_configureCannotOverwrite() public {
        vm.startPrank(lender);
        covenant.configure(facilityId, CHAIN_KEY, AAVE_POOL, BORROWER_POSITION, START_BLOCK, END_BLOCK);
        vm.expectRevert(NewBorrowCovenant.CovenantAlreadyConfigured.selector);
        covenant.configure(facilityId, CHAIN_KEY, AAVE_POOL, outsider, START_BLOCK, END_BLOCK);
        vm.stopPrank();
    }

    function test_onlyFacilityAdjudicatorCanEvaluate() public {
        _configureAndActivate();

        vm.expectRevert(NotAdjudicator.selector);
        vm.prank(outsider);
        covenant.evaluate(facilityId, _singleProven(CHAIN_KEY, START_BLOCK, AAVE_POOL, BORROWER_POSITION, 0));
    }

    function test_covenantKind() public view {
        assertEq(covenant.covenantKind(), "new-borrow");
    }

    function _configureAndActivate() private {
        vm.prank(lender);
        covenant.configure(facilityId, CHAIN_KEY, AAVE_POOL, BORROWER_POSITION, START_BLOCK, END_BLOCK);
        _activate();
    }

    function _activate() private {
        vm.prank(lender);
        facility.fundAsLender{value: 1000 ether}(facilityId);
        vm.prank(borrower);
        facility.postBond{value: 200 ether}(facilityId);
        vm.prank(borrower);
        facility.activate(facilityId);
    }

    function _singleProven(uint64 chainKey, uint64 height, address emitter, address onBehalfOf, uint64 txIndex)
        private
        pure
        returns (ProvenTx[] memory)
    {
        return _provenArray(_proven(chainKey, height, txIndex, _receipt(1, _logs(_borrow(emitter, onBehalfOf)))));
    }

    function _provenArray(ProvenTx memory provenTx) private pure returns (ProvenTx[] memory proven) {
        proven = new ProvenTx[](1);
        proven[0] = provenTx;
    }

    function _proven(uint64 chainKey, uint64 height, uint64 txIndex, bytes memory encodedTransaction)
        private
        pure
        returns (ProvenTx memory)
    {
        return ProvenTx({
            chainKey: chainKey, blockHeight: height, txIndex: txIndex, encodedTransaction: encodedTransaction
        });
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

    function _borrow(address emitter, address onBehalfOf) private pure returns (EvmV1Decoder.LogEntryTuple memory) {
        return _malformedBorrow(
            emitter, onBehalfOf, 4, abi.encode(address(0xCA11), uint256(1 ether), uint8(2), uint256(3e25))
        );
    }

    function _malformedBorrow(address emitter, address onBehalfOf, uint256 topicCount, bytes memory data)
        private
        pure
        returns (EvmV1Decoder.LogEntryTuple memory)
    {
        bytes32[] memory topics = new bytes32[](topicCount);
        if (topicCount > 0) {
            topics[0] = keccak256("Borrow(address,address,address,uint256,uint8,uint256,uint16)");
        }
        if (topicCount > 1) topics[1] = bytes32(uint256(uint160(address(0xA55E7))));
        if (topicCount > 2) topics[2] = bytes32(uint256(uint160(onBehalfOf)));
        if (topicCount > 3) topics[3] = bytes32(uint256(uint16(0)));
        return EvmV1Decoder.LogEntryTuple({address_: emitter, topics: topics, data: data});
    }
}
