// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/write-ability/common/EvmV1Decoder.sol";
import {EventHistoryPolicyV1} from "../../contracts/v2/policies/EventHistoryPolicyV1.sol";
import {IPolicyConfigurationContextV1} from "../../contracts/v2/interfaces/IPolicyConfigurationContextV1.sol";
import {
    EvidenceKind,
    ObservationKind,
    PolicyEffect,
    PolicyOutcome,
    PolicyResult,
    ProvenTransaction
} from "../../contracts/v2/types/RecourseTypesV2.sol";

contract MockPolicyConfigurationContext is IPolicyConfigurationContextV1 {
    mapping(address facility => address lender) private lenders;
    mapping(address facility => mapping(uint256 policyId => bool registered)) private registrations;

    function setLender(address facility, address lender) external {
        lenders[facility] = lender;
    }

    function setRegistered(address facility, uint256 policyId, bool registered) external {
        registrations[facility][policyId] = registered;
    }

    function lenderOf(address facility) external view returns (address) {
        return lenders[facility];
    }

    function isPolicyRegistered(address facility, uint256 policyId) external view returns (bool) {
        return registrations[facility][policyId];
    }

    function evaluate(
        EventHistoryPolicyV1 policy,
        address facility,
        uint256 policyId,
        ProvenTransaction[] memory proven
    ) external view returns (PolicyResult memory) {
        return policy.evaluate(facility, policyId, proven);
    }
}

contract EventHistoryPolicyV1Test is Test {
    bytes32 private constant EVENT_SIG = keccak256("Borrow(address,address,uint256,uint256)");
    address private constant FACILITY = address(0xFACA);
    address private constant LENDER = address(0x1EAD);
    address private constant SUBJECT = address(0xB0B);
    address private constant EMITTER = address(0xA4A4);
    uint256 private constant POLICY_ID = 9;
    uint64 private constant START_BLOCK = 25_826_500;
    uint64 private constant END_BLOCK = 25_826_600;

    MockPolicyConfigurationContext private context;
    EventHistoryPolicyV1 private policy;

    function setUp() public {
        context = new MockPolicyConfigurationContext();
        context.setLender(FACILITY, LENDER);
        policy = new EventHistoryPolicyV1(context);
    }

    function test_constructorRejectsZeroContext() public {
        vm.expectRevert(EventHistoryPolicyV1.ZeroContext.selector);
        new EventHistoryPolicyV1(IPolicyConfigurationContextV1(address(0)));
    }

    function test_onlyFacilityLenderCanConfigure() public {
        vm.expectRevert(EventHistoryPolicyV1.NotLender.selector);
        policy.configure(FACILITY, POLICY_ID, _configuration());

        vm.prank(LENDER);
        policy.configure(FACILITY, POLICY_ID, _configuration());
        assertTrue(policy.isConfigured(FACILITY, POLICY_ID));
    }

    function test_configurationIsOneTimeAndMustPrecedeExactKernelRegistration() public {
        vm.prank(LENDER);
        policy.configure(FACILITY, POLICY_ID, _configuration());

        vm.expectRevert(EventHistoryPolicyV1.PolicyAlreadyConfigured.selector);
        vm.prank(LENDER);
        policy.configure(FACILITY, POLICY_ID, _configuration());

        context.setRegistered(FACILITY, POLICY_ID + 1, true);
        vm.prank(LENDER);
        policy.configure(FACILITY, POLICY_ID + 2, _configuration());

        context.setRegistered(FACILITY, POLICY_ID + 3, true);
        vm.expectRevert(EventHistoryPolicyV1.PolicyAlreadyRegistered.selector);
        vm.prank(LENDER);
        policy.configure(FACILITY, POLICY_ID + 3, _configuration());
    }

    function test_publicConfigurationManifestAndHashRecoverEveryField() public {
        EventHistoryPolicyV1.Configuration memory expected = _configuration();
        vm.prank(LENDER);
        policy.configure(FACILITY, POLICY_ID, expected);

        EventHistoryPolicyV1.Configuration memory actual = policy.configurationOf(FACILITY, POLICY_ID);
        assertEq(keccak256(abi.encode(actual)), keccak256(abi.encode(expected)));
        assertEq(policy.manifest(FACILITY, POLICY_ID), abi.encode(expected));
        assertEq(policy.configHash(FACILITY, POLICY_ID), keccak256(abi.encode(expected)));
        assertEq(policy.policyKind(), "event-history-v1");
    }

    function test_unconfiguredManifestAndHashAreEmpty() public view {
        assertEq(policy.manifest(FACILITY, POLICY_ID), bytes(""));
        assertEq(policy.configHash(FACILITY, POLICY_ID), bytes32(0));
    }

    function test_rejectsInvalidConfigurationShapes() public {
        EventHistoryPolicyV1.Configuration memory configuration = _configuration();
        configuration.subjectTopicIndex = 0;
        _expectInvalidConfiguration(configuration);

        configuration = _configuration();
        configuration.topicCount = 5;
        _expectInvalidConfiguration(configuration);

        configuration = _configuration();
        configuration.dataLength = 33;
        _expectInvalidConfiguration(configuration);

        configuration = _configuration();
        configuration.observedValueOffset = 64;
        _expectInvalidConfiguration(configuration);

        configuration = _configuration();
        configuration.startSourceBlock = END_BLOCK + 1;
        _expectInvalidConfiguration(configuration);

        configuration = _configuration();
        configuration.evidenceKind = EvidenceKind.TransactionControl;
        _expectInvalidConfiguration(configuration);

        configuration = _configuration();
        configuration.effect.creditLimitBps = 10_001;
        _expectInvalidConfiguration(configuration);
    }

    function test_onlyKernelContextCanEvaluate() public {
        _configure();
        ProvenTransaction[] memory proven = _singleProven(START_BLOCK, _receipt(1, _matchingLogs(25)));

        vm.expectRevert(EventHistoryPolicyV1.NotKernel.selector);
        policy.evaluate(FACILITY, POLICY_ID, proven);
    }

    function test_evaluatesEmitterSignatureSubjectShapeChainAndWindowBoundEvent() public {
        _configure();
        EvmV1Decoder.LogEntryTuple[] memory logs = _matchingLogs(25);
        EvmV1Decoder.LogEntryTuple[] memory secondLogs = _matchingLogs(75);
        EvmV1Decoder.LogEntryTuple[] memory combined = new EvmV1Decoder.LogEntryTuple[](2);
        combined[0] = logs[0];
        combined[1] = secondLogs[0];
        ProvenTransaction[] memory proven = _singleProven(START_BLOCK + 4, _receipt(1, combined));

        PolicyResult memory result = context.evaluate(policy, FACILITY, POLICY_ID, proven);

        assertEq(uint256(result.effect.outcome), uint256(PolicyOutcome.Restricted));
        assertEq(result.effect.creditLimitBps, 6_000);
        assertEq(uint256(result.observationKind), uint256(ObservationKind.Liability));
        assertEq(uint256(result.evidenceKind), uint256(EvidenceKind.EventDelta));
        assertEq(result.sourceBlock, START_BLOCK + 4);
        assertEq(result.transactionIndex, 3);
        assertEq(result.subject, SUBJECT);
        assertEq(result.emitter, EMITTER);
        assertEq(result.observedValue, 100);
        assertEq(result.freshnessPeriod, 1 days);
    }

    function test_revertedReceiptIsRejectedBeforeLogsAreUsed() public {
        _configure();
        ProvenTransaction[] memory proven = _singleProven(START_BLOCK, _receipt(0, _matchingLogs(25)));

        vm.expectRevert(EventHistoryPolicyV1.TransactionReverted.selector);
        context.evaluate(policy, FACILITY, POLICY_ID, proven);
    }

    function test_requiresOneTransactionPerLocationBoundObservation() public {
        _configure();
        ProvenTransaction[] memory proven = new ProvenTransaction[](2);

        vm.expectRevert(EventHistoryPolicyV1.WrongTransactionCount.selector);
        context.evaluate(policy, FACILITY, POLICY_ID, proven);
    }

    function test_irrelevantEvidenceDoesNotProduceAnObservation() public {
        _configure();

        _expectIrrelevant(_singleProven(START_BLOCK - 1, _receipt(1, _matchingLogs(25))));

        ProvenTransaction[] memory wrongChain = _singleProven(START_BLOCK, _receipt(1, _matchingLogs(25)));
        wrongChain[0].chainKey = 2;
        _expectIrrelevant(wrongChain);

        EvmV1Decoder.LogEntryTuple[] memory logs = _matchingLogs(25);
        logs[0].address_ = address(0xBAD);
        _expectIrrelevant(_singleProven(START_BLOCK, _receipt(1, logs)));

        logs = _matchingLogs(25);
        logs[0].topics[0] = keccak256("Other(uint256)");
        _expectIrrelevant(_singleProven(START_BLOCK, _receipt(1, logs)));

        logs = _matchingLogs(25);
        logs[0].topics[2] = bytes32(uint256(uint160(address(0xBAD))));
        _expectIrrelevant(_singleProven(START_BLOCK, _receipt(1, logs)));

        logs = _matchingLogs(25);
        logs[0].data = abi.encode(uint256(25));
        _expectIrrelevant(_singleProven(START_BLOCK, _receipt(1, logs)));
    }

    function _configure() private {
        vm.prank(LENDER);
        policy.configure(FACILITY, POLICY_ID, _configuration());
    }

    function _configuration() private pure returns (EventHistoryPolicyV1.Configuration memory) {
        return EventHistoryPolicyV1.Configuration({
            sourceChain: 3,
            emitter: EMITTER,
            eventSignature: EVENT_SIG,
            subject: SUBJECT,
            startSourceBlock: START_BLOCK,
            endSourceBlock: END_BLOCK,
            topicCount: 3,
            subjectTopicIndex: 2,
            dataLength: 64,
            observedValueOffset: 32,
            observationKind: ObservationKind.Liability,
            evidenceKind: EvidenceKind.EventDelta,
            freshnessPeriod: 1 days,
            effect: PolicyEffect({
                outcome: PolicyOutcome.Restricted,
                creditLimitBps: 6_000,
                futureDrawFeeBps: 250,
                freezePendingDraw: true,
                requireFreshEvidence: true,
                terminate: false
            })
        });
    }

    function _expectInvalidConfiguration(EventHistoryPolicyV1.Configuration memory configuration) private {
        vm.expectRevert(EventHistoryPolicyV1.InvalidConfiguration.selector);
        vm.prank(LENDER);
        policy.configure(FACILITY, POLICY_ID, configuration);
    }

    function _expectIrrelevant(ProvenTransaction[] memory proven) private {
        vm.expectRevert(EventHistoryPolicyV1.IrrelevantEvidence.selector);
        context.evaluate(policy, FACILITY, POLICY_ID, proven);
    }

    function _singleProven(uint64 blockHeight, bytes memory encodedTransaction)
        private
        pure
        returns (ProvenTransaction[] memory proven)
    {
        proven = new ProvenTransaction[](1);
        proven[0] = ProvenTransaction({
            chainKey: 3, blockHeight: blockHeight, txIndex: 3, encodedTransaction: encodedTransaction
        });
    }

    function _matchingLogs(uint256 value) private pure returns (EvmV1Decoder.LogEntryTuple[] memory logs) {
        bytes32[] memory topics = new bytes32[](3);
        topics[0] = EVENT_SIG;
        topics[1] = bytes32(uint256(17));
        topics[2] = bytes32(uint256(uint160(SUBJECT)));
        logs = new EvmV1Decoder.LogEntryTuple[](1);
        logs[0] = EvmV1Decoder.LogEntryTuple({address_: EMITTER, topics: topics, data: abi.encode(uint256(999), value)});
    }

    function _receipt(uint8 status, EvmV1Decoder.LogEntryTuple[] memory logs) private pure returns (bytes memory) {
        bytes[] memory chunks = new bytes[](3);
        chunks[2] = abi.encode(status, uint64(1), logs, bytes(""));
        return abi.encode(uint8(2), chunks);
    }
}
