// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/write-ability/common/EvmV1Decoder.sol";
import {LpLockCovenant} from "../../contracts/covenants/LpLockCovenant.sol";
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

contract LpLockCovenantTest is Test {
    uint64 private constant CHAIN_KEY = 3;
    uint64 private constant START_BLOCK = 23_000_000;
    uint64 private constant END_BLOCK = 23_010_000;
    address private constant POSITION_MANAGER = 0xC36442b4a4522E871399CD717aBDD847Ab11FE88;
    uint256 private constant TOKEN_ID = 42;

    RecourseFacility private facility;
    LpLockCovenant private covenant;
    address private lender = address(0xA1);
    address private borrower = address(0xB2);
    address private outsider = address(0xC3);
    uint256 private facilityId;

    function setUp() public {
        facility = new RecourseFacility();
        facility.setAdjudicator(address(this));
        covenant = new LpLockCovenant(facility);
        vm.deal(lender, 1000 ether);
        vm.deal(borrower, 200 ether);
        facilityId =
            facility.openFacility(lender, borrower, 1000 ether, 200 ether, 200, uint64(block.number + 100_000), 10);
    }

    function test_happyPathBreaches() public {
        _configureAndActivate();

        assertTrue(covenant.evaluate(facilityId, _singleProven(CHAIN_KEY, START_BLOCK, POSITION_MANAGER, TOKEN_ID, 0)));
    }

    function test_forgedDecreaseLiquidityEventFromWrongEmitterIsRejected() public {
        _configureAndActivate();

        vm.expectRevert(IrrelevantEvidence.selector);
        covenant.evaluate(facilityId, _singleProven(CHAIN_KEY, START_BLOCK, address(0xF0A6E), TOKEN_ID, 0));
    }

    function test_wrongTokenIdIsRejected() public {
        _configureAndActivate();

        vm.expectRevert(IrrelevantEvidence.selector);
        covenant.evaluate(facilityId, _singleProven(CHAIN_KEY, START_BLOCK, POSITION_MANAGER, TOKEN_ID + 1, 0));
    }

    function test_outOfWindowIsRejected() public {
        _configureAndActivate();
        ProvenTx[] memory proven = new ProvenTx[](2);
        proven[0] =
            _proven(CHAIN_KEY, START_BLOCK - 1, 0, _receipt(1, _logs(_decreaseLiquidity(POSITION_MANAGER, TOKEN_ID))));
        proven[1] = _proven(CHAIN_KEY, END_BLOCK, 1, _receipt(1, _logs(_decreaseLiquidity(POSITION_MANAGER, TOKEN_ID))));

        vm.expectRevert(IrrelevantEvidence.selector);
        covenant.evaluate(facilityId, proven);
    }

    function test_startBlockIsIncludedAndEndBlockIsExcluded() public {
        _configureAndActivate();

        assertTrue(covenant.evaluate(facilityId, _singleProven(CHAIN_KEY, START_BLOCK, POSITION_MANAGER, TOKEN_ID, 0)));
    }

    function test_wrongChainKeyIsRejected() public {
        _configureAndActivate();

        vm.expectRevert(IrrelevantEvidence.selector);
        covenant.evaluate(facilityId, _singleProven(CHAIN_KEY + 1, START_BLOCK, POSITION_MANAGER, TOKEN_ID, 0));
    }

    function test_revertedReceiptIsRejected() public {
        _configureAndActivate();
        ProvenTx[] memory proven = _provenArray(
            _proven(CHAIN_KEY, START_BLOCK, 0, _receipt(0, _logs(_decreaseLiquidity(POSITION_MANAGER, TOKEN_ID))))
        );

        vm.expectRevert(TransactionReverted.selector);
        covenant.evaluate(facilityId, proven);
    }

    function test_irrelevantBatchRevertsWithoutConsumingEvidence() public {
        _configureAndActivate();
        ProvenTx[] memory irrelevant = _singleProven(CHAIN_KEY, START_BLOCK, POSITION_MANAGER, TOKEN_ID + 1, 7);

        vm.expectRevert(IrrelevantEvidence.selector);
        covenant.evaluate(facilityId, irrelevant);

        assertTrue(covenant.evaluate(facilityId, _singleProven(CHAIN_KEY, START_BLOCK, POSITION_MANAGER, TOKEN_ID, 7)));
    }

    function test_replayIsRejected() public {
        _configureAndActivate();
        ProvenTx[] memory proven = _singleProven(CHAIN_KEY, START_BLOCK, POSITION_MANAGER, TOKEN_ID, 4);
        covenant.evaluate(facilityId, proven);

        bytes32 queryId = keccak256(abi.encodePacked(CHAIN_KEY, START_BLOCK, uint64(4)));
        vm.expectRevert(abi.encodeWithSelector(ProofAlreadyUsed.selector, queryId));
        covenant.evaluate(facilityId, proven);
    }

    function test_duplicateQueryWithinBatchIsRejected() public {
        _configureAndActivate();
        ProvenTx[] memory proven = new ProvenTx[](2);
        proven[0] =
            _proven(CHAIN_KEY, START_BLOCK, 9, _receipt(1, _logs(_decreaseLiquidity(POSITION_MANAGER, TOKEN_ID))));
        proven[1] =
            _proven(CHAIN_KEY, START_BLOCK, 9, _receipt(1, _logs(_decreaseLiquidity(POSITION_MANAGER, TOKEN_ID))));

        bytes32 queryId = keccak256(abi.encodePacked(CHAIN_KEY, START_BLOCK, uint64(9)));
        vm.expectRevert(abi.encodeWithSelector(ProofAlreadyUsed.selector, queryId));
        covenant.evaluate(facilityId, proven);
    }

    function test_malformedLogsAreSkipped() public {
        _configureAndActivate();
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](3);
        logs[0] = _malformedDecreaseLiquidity(POSITION_MANAGER, TOKEN_ID, 1, new bytes(96));
        logs[1] = _malformedDecreaseLiquidity(POSITION_MANAGER, TOKEN_ID, 2, hex"01");
        logs[2] = _decreaseLiquidity(POSITION_MANAGER, TOKEN_ID);

        assertTrue(covenant.evaluate(facilityId, _provenArray(_proven(CHAIN_KEY, START_BLOCK, 0, _receipt(1, logs)))));
    }

    function test_configureByNonLenderReverts() public {
        vm.expectRevert(NotLender.selector);
        vm.prank(outsider);
        covenant.configure(facilityId, CHAIN_KEY, POSITION_MANAGER, TOKEN_ID, START_BLOCK, END_BLOCK);
    }

    function test_configureAfterActivationReverts() public {
        _activate();

        vm.expectRevert(abi.encodeWithSelector(WrongState.selector, FacilityState.Created, FacilityState.Active));
        vm.prank(lender);
        covenant.configure(facilityId, CHAIN_KEY, POSITION_MANAGER, TOKEN_ID, START_BLOCK, END_BLOCK);
    }

    function test_configureCannotOverwrite() public {
        vm.startPrank(lender);
        covenant.configure(facilityId, CHAIN_KEY, POSITION_MANAGER, TOKEN_ID, START_BLOCK, END_BLOCK);
        vm.expectRevert(LpLockCovenant.CovenantAlreadyConfigured.selector);
        covenant.configure(facilityId, CHAIN_KEY, POSITION_MANAGER, TOKEN_ID + 1, START_BLOCK, END_BLOCK);
        vm.stopPrank();
    }

    function test_onlyFacilityAdjudicatorCanEvaluate() public {
        _configureAndActivate();

        vm.expectRevert(NotAdjudicator.selector);
        vm.prank(outsider);
        covenant.evaluate(facilityId, _singleProven(CHAIN_KEY, START_BLOCK, POSITION_MANAGER, TOKEN_ID, 0));
    }

    function test_covenantKind() public view {
        assertEq(covenant.covenantKind(), "lp-lock");
    }

    function _configureAndActivate() private {
        vm.prank(lender);
        covenant.configure(facilityId, CHAIN_KEY, POSITION_MANAGER, TOKEN_ID, START_BLOCK, END_BLOCK);
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

    function _singleProven(uint64 chainKey, uint64 height, address emitter, uint256 tokenId, uint64 txIndex)
        private
        pure
        returns (ProvenTx[] memory)
    {
        return _provenArray(
            _proven(chainKey, height, txIndex, _receipt(1, _logs(_decreaseLiquidity(emitter, tokenId))))
        );
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

    function _decreaseLiquidity(address emitter, uint256 tokenId)
        private
        pure
        returns (EvmV1Decoder.LogEntryTuple memory)
    {
        return _malformedDecreaseLiquidity(
            emitter, tokenId, 2, abi.encode(uint128(1), uint256(2 ether), uint256(3 ether))
        );
    }

    function _malformedDecreaseLiquidity(address emitter, uint256 tokenId, uint256 topicCount, bytes memory data)
        private
        pure
        returns (EvmV1Decoder.LogEntryTuple memory)
    {
        bytes32[] memory topics = new bytes32[](topicCount);
        if (topicCount > 0) {
            topics[0] = keccak256("DecreaseLiquidity(uint256,uint128,uint256,uint256)");
        }
        if (topicCount > 1) topics[1] = bytes32(tokenId);
        return EvmV1Decoder.LogEntryTuple({address_: emitter, topics: topics, data: data});
    }
}
