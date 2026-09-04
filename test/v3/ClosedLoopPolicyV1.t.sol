// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/write-ability/common/EvmV1Decoder.sol";
import {IPolicyConfigurationContextV1} from "../../contracts/v2/interfaces/IPolicyConfigurationContextV1.sol";
import {IPolicyEvaluatorV1} from "../../contracts/v2/interfaces/IPolicyEvaluatorV1.sol";
import {
    ObservationKind,
    PolicyEffect,
    PolicyOutcome,
    PolicyResult,
    ProvenTransaction
} from "../../contracts/v2/types/RecourseTypesV2.sol";
import {ClosedLoopPolicyV1} from "../../contracts/v3/ClosedLoopPolicyV1.sol";
import {RemedyCoordinatorV1} from "../../contracts/v3/RemedyCoordinatorV1.sol";
import {IRemedyCoordinatorV1} from "../../contracts/v3/interfaces/IRemedyCoordinatorV1.sol";
import {IRemedyTransportV1} from "../../contracts/v3/interfaces/IRemedyTransportV1.sol";

contract ClosedLoopContextMock is IPolicyConfigurationContextV1 {
    address public lender;
    bool public registered;
    address public evaluator;

    function setLender(address value) external {
        lender = value;
    }

    function setRegistered(bool value) external {
        registered = value;
    }

    function setEvaluator(address value) external {
        evaluator = value;
    }

    function lenderOf(address) external view returns (address) {
        return lender;
    }

    function isPolicyRegistered(address, uint256) external view returns (bool) {
        return registered;
    }

    function policyOf(address, uint256) external view returns (address, bytes32, bytes memory) {
        return (evaluator, keccak256("config"), bytes("manifest"));
    }

    function evaluate(
        IPolicyEvaluatorV1 policy,
        address facility,
        uint256 policyId,
        ProvenTransaction[] calldata proven
    ) external returns (PolicyResult memory) {
        return policy.evaluate(facility, policyId, proven);
    }
}

contract ClosedLoopTransportMock is IRemedyTransportV1 {
    bytes32 public messageId = keccak256("message");
    bool public acknowledged;
    uint256 public publishCalls;

    function setAcknowledged(bool value) external {
        acknowledged = value;
    }

    function publish(bytes32 intentId, uint64, address, bytes calldata, uint64) external returns (bytes32) {
        ++publishCalls;
        messageId = keccak256(abi.encode(intentId, publishCalls));
        return messageId;
    }

    function isAcknowledged(bytes32) external view returns (bool) {
        return acknowledged;
    }
}

contract ClosedLoopPolicyV1Test is Test {
    address private constant LENDER = address(0xA1);
    address private constant FACILITY = address(0xB2);
    address private constant SUBJECT = address(0xC3);
    address private constant ADVERSE_EMITTER = address(0xD4);
    address private constant RECEIVER = address(0xF6);
    address private constant TARGET = address(0xA7);
    uint256 private constant POLICY_ID = 7;
    uint64 private constant CHAIN_KEY = 3;
    uint64 private constant START_BLOCK = 100;
    uint64 private constant END_BLOCK = 200;
    bytes32 private constant ADVERSE_SIG = keccak256("LiabilityIncreased(address,uint256)");
    bytes32 private constant CURE_SIG = keccak256("RemedyExecutionConfirmed(address,bytes32,bytes32,bytes32,bytes32)");
    bytes32 private constant ACTION_KIND = keccak256("repay-v1");
    bytes private constant ACTION_DATA = abi.encode(address(0x88), uint256(100));

    ClosedLoopContextMock private context;
    ClosedLoopTransportMock private transport;
    RemedyCoordinatorV1 private coordinator;
    ClosedLoopPolicyV1 private policy;

    function setUp() public {
        context = new ClosedLoopContextMock();
        context.setLender(LENDER);
        transport = new ClosedLoopTransportMock();
        coordinator = new RemedyCoordinatorV1(context, transport);
        policy = new ClosedLoopPolicyV1(context, coordinator);
        vm.prank(LENDER);
        policy.configure(FACILITY, POLICY_ID, _configuration());
        context.setEvaluator(address(policy));
        context.setRegistered(true);
        vm.prank(LENDER);
        coordinator.authorizePolicy(FACILITY, POLICY_ID, address(policy));
    }

    function test_adverseProofRecordsLinkedIntentAndAppliesOnlyAdverseEffect() public {
        PolicyResult memory result = _evaluate(_adverseProven(75));
        bytes32 intentId = policy.latestIntent(FACILITY, POLICY_ID);

        assertNotEq(intentId, bytes32(0));
        assertEq(uint256(result.effect.outcome), uint256(PolicyOutcome.Restricted));
        assertEq(result.observedValue, 75);
        assertEq(uint256(coordinator.intentStatus(intentId)), uint256(IRemedyCoordinatorV1.IntentStatus.Recorded));
    }

    function test_matchingLogValuesSaturateInsteadOfBlockingAdverseEvidence() public {
        bytes32[] memory topics = new bytes32[](2);
        topics[0] = ADVERSE_SIG;
        topics[1] = bytes32(uint256(uint160(SUBJECT)));
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](2);
        logs[0] = EvmV1Decoder.LogEntryTuple({
            address_: ADVERSE_EMITTER, topics: topics, data: abi.encode(type(uint256).max)
        });
        logs[1] = EvmV1Decoder.LogEntryTuple({address_: ADVERSE_EMITTER, topics: topics, data: abi.encode(uint256(1))});
        bytes[] memory chunks = new bytes[](3);
        chunks[2] = abi.encode(uint8(1), uint64(1), logs, bytes(""));

        PolicyResult memory result = _evaluate(_proven(abi.encode(uint8(2), chunks)));

        assertEq(result.observedValue, type(uint256).max);
        assertNotEq(policy.latestIntent(FACILITY, POLICY_ID), bytes32(0));
    }

    function test_acknowledgementAloneIsNotCureAndExactCureProofClosesLoop() public {
        _evaluate(_adverseProven(75));
        bytes32 intentId = policy.latestIntent(FACILITY, POLICY_ID);
        coordinator.publishIntent(intentId, ACTION_DATA);
        transport.setAcknowledged(true);
        coordinator.syncAcknowledgement(intentId);
        assertEq(uint256(coordinator.intentStatus(intentId)), uint256(IRemedyCoordinatorV1.IntentStatus.Acknowledged));

        PolicyResult memory result =
            _evaluate(_cureProven(intentId, coordinator.intentExecutionId(intentId), keccak256(ACTION_DATA), 100));
        assertEq(uint256(result.effect.outcome), uint256(PolicyOutcome.Cured));
        assertEq(result.observedValue, 100);
        assertEq(uint256(coordinator.intentStatus(intentId)), uint256(IRemedyCoordinatorV1.IntentStatus.Cured));
    }

    function test_duplicateCanonicalConfirmationsReportTheStableExecutionResultOnce() public {
        _evaluate(_adverseProven(75));
        bytes32 intentId = policy.latestIntent(FACILITY, POLICY_ID);
        bytes32 executionId = coordinator.intentExecutionId(intentId);
        coordinator.publishIntent(intentId, ACTION_DATA);
        transport.setAcknowledged(true);
        coordinator.syncAcknowledgement(intentId);

        bytes32[] memory topics = new bytes32[](4);
        topics[0] = CURE_SIG;
        topics[1] = bytes32(uint256(uint160(TARGET)));
        topics[2] = intentId;
        topics[3] = executionId;
        bytes memory data = abi.encode(bytes32(uint256(100)), keccak256(ACTION_DATA));
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](2);
        logs[0] = EvmV1Decoder.LogEntryTuple({address_: RECEIVER, topics: topics, data: data});
        logs[1] = EvmV1Decoder.LogEntryTuple({address_: RECEIVER, topics: topics, data: data});
        bytes[] memory chunks = new bytes[](3);
        chunks[2] = abi.encode(uint8(1), uint64(1), logs, bytes(""));

        PolicyResult memory result = _evaluate(_proven(abi.encode(uint8(2), chunks)));

        assertEq(result.observedValue, 100);
        assertEq(uint256(coordinator.intentStatus(intentId)), uint256(IRemedyCoordinatorV1.IntentStatus.Cured));
    }

    function test_cureProofCannotApplyBeforeTransportAcknowledgement() public {
        _evaluate(_adverseProven(75));
        bytes32 intentId = policy.latestIntent(FACILITY, POLICY_ID);
        bytes32 executionId = coordinator.intentExecutionId(intentId);
        vm.expectRevert(ClosedLoopPolicyV1.RemedyNotAcknowledged.selector);
        _evaluate(_cureProven(intentId, executionId, keccak256(ACTION_DATA), 100));
    }

    function test_cureMustBindExactExecutionAndActionDigest() public {
        _evaluate(_adverseProven(75));
        bytes32 intentId = policy.latestIntent(FACILITY, POLICY_ID);
        bytes32 executionId = coordinator.intentExecutionId(intentId);
        coordinator.publishIntent(intentId, ACTION_DATA);
        transport.setAcknowledged(true);
        coordinator.syncAcknowledgement(intentId);

        vm.expectRevert(ClosedLoopPolicyV1.IrrelevantEvidence.selector);
        _evaluate(_cureProven(keccak256("wrong intent"), executionId, keccak256(ACTION_DATA), 100));
        vm.expectRevert(ClosedLoopPolicyV1.IrrelevantEvidence.selector);
        _evaluate(_cureProven(intentId, keccak256("wrong execution"), keccak256(ACTION_DATA), 100));
        vm.expectRevert(ClosedLoopPolicyV1.IrrelevantEvidence.selector);
        _evaluate(_cureProven(intentId, executionId, keccak256("wrong action"), 100));
    }

    function test_secondAdverseCannotOverwritePendingRemedy() public {
        _evaluate(_adverseProven(75));
        vm.expectRevert(ClosedLoopPolicyV1.RemedyPending.selector);
        _evaluate(_adverseProven(80));
    }

    function test_newAdverseAfterExpiredIntentStartsFreshExecutionDomain() public {
        _evaluate(_adverseProven(75));
        bytes32 expiredIntent = policy.latestIntent(FACILITY, POLICY_ID);
        vm.warp(coordinator.intentOf(expiredIntent).expiry);
        vm.prank(address(0xBAD));
        coordinator.timeoutIntent(expiredIntent);

        _evaluate(_adverseProven(80));
        bytes32 replacementIntent = policy.latestIntent(FACILITY, POLICY_ID);
        assertNotEq(replacementIntent, expiredIntent);
        assertNotEq(coordinator.intentExecutionId(replacementIntent), coordinator.intentExecutionId(expiredIntent));
        assertEq(uint256(coordinator.intentStatus(expiredIntent)), uint256(IRemedyCoordinatorV1.IntentStatus.Expired));
        assertEq(
            uint256(coordinator.intentStatus(replacementIntent)), uint256(IRemedyCoordinatorV1.IntentStatus.Recorded)
        );
    }

    function test_newAdverseAfterFailedIntentStartsFreshExecutionDomain() public {
        _evaluate(_adverseProven(75));
        bytes32 failedIntent = policy.latestIntent(FACILITY, POLICY_ID);
        coordinator.publishIntent(failedIntent, ACTION_DATA);
        vm.warp(block.timestamp + coordinator.PUBLISH_RETRY_DELAY());
        vm.prank(LENDER);
        coordinator.publishIntent(failedIntent, ACTION_DATA);
        vm.warp(block.timestamp + coordinator.PUBLISH_RETRY_DELAY());
        vm.prank(LENDER);
        coordinator.publishIntent(failedIntent, ACTION_DATA);
        vm.warp(block.timestamp + coordinator.PUBLISH_RETRY_DELAY());
        vm.prank(address(0xBAD));
        coordinator.timeoutIntent(failedIntent);

        _evaluate(_adverseProven(80));
        bytes32 replacementIntent = policy.latestIntent(FACILITY, POLICY_ID);
        assertNotEq(replacementIntent, failedIntent);
        assertNotEq(coordinator.intentExecutionId(replacementIntent), coordinator.intentExecutionId(failedIntent));
        assertEq(uint256(coordinator.intentStatus(failedIntent)), uint256(IRemedyCoordinatorV1.IntentStatus.Failed));
        assertEq(
            uint256(coordinator.intentStatus(replacementIntent)), uint256(IRemedyCoordinatorV1.IntentStatus.Recorded)
        );
    }

    function test_expiredIntentCanBeExplicitlyReplacedWithinTheSameAdverseEpisode() public {
        _evaluate(_adverseProven(75));
        bytes32 expiredIntent = policy.latestIntent(FACILITY, POLICY_ID);
        vm.warp(coordinator.intentOf(expiredIntent).expiry);
        coordinator.timeoutIntent(expiredIntent);

        vm.expectRevert(ClosedLoopPolicyV1.NotLender.selector);
        vm.prank(address(0xBAD));
        policy.replaceRemedyIntent(FACILITY, POLICY_ID);
        vm.prank(LENDER);
        bytes32 replacementIntent = policy.replaceRemedyIntent(FACILITY, POLICY_ID);
        RemedyCoordinatorV1.Intent memory expired = coordinator.intentOf(expiredIntent);
        RemedyCoordinatorV1.Intent memory replacement = coordinator.intentOf(replacementIntent);

        assertEq(policy.latestIntent(FACILITY, POLICY_ID), replacementIntent);
        assertEq(replacement.predecessorIntentId, expiredIntent);
        assertEq(replacement.adverseEvidenceDigest, expired.adverseEvidenceDigest);
        assertEq(replacement.executionId, expired.executionId);
        assertEq(uint256(replacement.status), uint256(IRemedyCoordinatorV1.IntentStatus.Recorded));
    }

    function test_liveIntentCannotBeExplicitlyReplaced() public {
        _evaluate(_adverseProven(75));
        vm.expectRevert(ClosedLoopPolicyV1.RemedyNotReplaceable.selector);
        vm.prank(LENDER);
        policy.replaceRemedyIntent(FACILITY, POLICY_ID);
    }

    function test_uncurableAcknowledgedIntentStopsWedgingThePolicyAfterTheCureWindow() public {
        _evaluate(_adverseProven(75));
        bytes32 intentId = policy.latestIntent(FACILITY, POLICY_ID);
        coordinator.publishIntent(intentId, ACTION_DATA);
        transport.setAcknowledged(true);
        coordinator.syncAcknowledgement(intentId);

        vm.expectRevert(ClosedLoopPolicyV1.RemedyPending.selector);
        _evaluate(_adverseProven(80));
        vm.expectRevert(ClosedLoopPolicyV1.RemedyNotReplaceable.selector);
        vm.prank(LENDER);
        policy.replaceRemedyIntent(FACILITY, POLICY_ID);

        vm.warp(uint256(coordinator.intentOf(intentId).acknowledgedAt) + coordinator.CURE_WINDOW());
        vm.prank(address(0xBAD));
        coordinator.timeoutIntent(intentId);
        assertEq(uint256(coordinator.intentStatus(intentId)), uint256(IRemedyCoordinatorV1.IntentStatus.Expired));

        vm.prank(LENDER);
        bytes32 replacementIntent = policy.replaceRemedyIntent(FACILITY, POLICY_ID);
        assertEq(policy.latestIntent(FACILITY, POLICY_ID), replacementIntent);
        assertEq(coordinator.intentExecutionId(replacementIntent), coordinator.intentExecutionId(intentId));
        assertEq(
            uint256(coordinator.intentStatus(replacementIntent)), uint256(IRemedyCoordinatorV1.IntentStatus.Recorded)
        );
    }

    function test_overlappingAdverseAndCurePredicatesAreRejectedAtTouchingWindowBoundary() public {
        ClosedLoopPolicyV1.Configuration memory configuration = _configuration();
        configuration.adverseRule.emitter = configuration.cureRule.eventRule.emitter;
        configuration.adverseRule.eventSignature = configuration.cureRule.eventRule.eventSignature;
        configuration.adverseRule.subject = configuration.cureRule.eventRule.subject;
        configuration.adverseRule.topicCount = configuration.cureRule.eventRule.topicCount;
        configuration.adverseRule.dataLength = configuration.cureRule.eventRule.dataLength;
        configuration.adverseRule.endSourceBlock = 150;
        configuration.cureRule.eventRule.startSourceBlock = 150;
        configuration.cureRule.eventRule.endSourceBlock = 200;

        context.setRegistered(false);
        vm.expectRevert(ClosedLoopPolicyV1.InvalidConfiguration.selector);
        vm.prank(LENDER);
        policy.configure(FACILITY, POLICY_ID + 1, configuration);
    }

    function test_identicalAdverseAndCurePredicatesCanUseDisjointWindows() public {
        ClosedLoopPolicyV1.Configuration memory configuration = _configuration();
        configuration.adverseRule.emitter = configuration.cureRule.eventRule.emitter;
        configuration.adverseRule.eventSignature = configuration.cureRule.eventRule.eventSignature;
        configuration.adverseRule.subject = configuration.cureRule.eventRule.subject;
        configuration.adverseRule.topicCount = configuration.cureRule.eventRule.topicCount;
        configuration.adverseRule.dataLength = configuration.cureRule.eventRule.dataLength;
        configuration.adverseRule.endSourceBlock = 149;
        configuration.cureRule.eventRule.startSourceBlock = 150;
        configuration.cureRule.eventRule.endSourceBlock = 200;

        context.setRegistered(false);
        vm.prank(LENDER);
        policy.configure(FACILITY, POLICY_ID + 1, configuration);
        assertTrue(policy.isConfigured(FACILITY, POLICY_ID + 1));
    }

    function test_terminatingAdverseEffectIsRejectedBecauseItCannotBeCured() public {
        ClosedLoopPolicyV1.Configuration memory configuration = _configuration();
        configuration.adverseEffect.terminate = true;

        context.setRegistered(false);
        vm.expectRevert(ClosedLoopPolicyV1.InvalidConfiguration.selector);
        vm.prank(LENDER);
        policy.configure(FACILITY, POLICY_ID + 1, configuration);
    }

    function test_configurationAndEventShapeAreStrict() public {
        assertEq(policy.configHash(FACILITY, POLICY_ID), keccak256(policy.manifest(FACILITY, POLICY_ID)));
        assertEq(policy.policyKind(), "closed-loop-v1");

        ProvenTransaction[] memory wrongChain = _adverseProven(75);
        wrongChain[0].chainKey = CHAIN_KEY + 1;
        vm.expectRevert(ClosedLoopPolicyV1.IrrelevantEvidence.selector);
        _evaluate(wrongChain);

        ProvenTransaction[] memory wrongWindow = _adverseProven(75);
        wrongWindow[0].blockHeight = END_BLOCK + 1;
        vm.expectRevert(ClosedLoopPolicyV1.IrrelevantEvidence.selector);
        _evaluate(wrongWindow);
    }

    function _evaluate(ProvenTransaction[] memory proven) private returns (PolicyResult memory) {
        return context.evaluate(policy, FACILITY, POLICY_ID, proven);
    }

    function _configuration() private pure returns (ClosedLoopPolicyV1.Configuration memory) {
        ClosedLoopPolicyV1.EventRule memory adverse = ClosedLoopPolicyV1.EventRule({
            sourceChain: CHAIN_KEY,
            emitter: ADVERSE_EMITTER,
            eventSignature: ADVERSE_SIG,
            subject: SUBJECT,
            startSourceBlock: START_BLOCK,
            endSourceBlock: END_BLOCK,
            topicCount: 2,
            subjectTopicIndex: 1,
            dataLength: 32,
            observedValueOffset: 0
        });
        ClosedLoopPolicyV1.EventRule memory cureEvent = ClosedLoopPolicyV1.EventRule({
            sourceChain: CHAIN_KEY,
            emitter: RECEIVER,
            eventSignature: CURE_SIG,
            subject: TARGET,
            startSourceBlock: START_BLOCK,
            endSourceBlock: END_BLOCK,
            topicCount: 4,
            subjectTopicIndex: 1,
            dataLength: 64,
            observedValueOffset: 0
        });
        return ClosedLoopPolicyV1.Configuration({
            adverseRule: adverse,
            cureRule: ClosedLoopPolicyV1.CureRule({
                eventRule: cureEvent, intentTopicIndex: 2, executionTopicIndex: 3, actionDigestOffset: 32
            }),
            observationKind: ObservationKind.Liability,
            freshnessPeriod: 1 days,
            remedyDuration: 2 days,
            destinationChain: CHAIN_KEY,
            receiver: RECEIVER,
            target: TARGET,
            actionKind: ACTION_KIND,
            actionDataHash: keccak256(ACTION_DATA),
            adverseEffect: PolicyEffect({
                outcome: PolicyOutcome.Restricted,
                creditLimitBps: 5_000,
                futureDrawFeeBps: 300,
                freezePendingDraw: true,
                requireFreshEvidence: true,
                terminate: false
            }),
            cureEffect: PolicyEffect({
                outcome: PolicyOutcome.Cured,
                creditLimitBps: 10_000,
                futureDrawFeeBps: 100,
                freezePendingDraw: false,
                requireFreshEvidence: false,
                terminate: false
            })
        });
    }

    function _adverseProven(uint256 value) private pure returns (ProvenTransaction[] memory proven) {
        bytes32[] memory topics = new bytes32[](2);
        topics[0] = ADVERSE_SIG;
        topics[1] = bytes32(uint256(uint160(SUBJECT)));
        proven = _proven(_receipt(ADVERSE_EMITTER, topics, abi.encode(value)));
    }

    function _cureProven(bytes32 intentId, bytes32 executionId, bytes32 actionDigest, uint256 value)
        private
        pure
        returns (ProvenTransaction[] memory proven)
    {
        bytes32[] memory topics = new bytes32[](4);
        topics[0] = CURE_SIG;
        topics[1] = bytes32(uint256(uint160(TARGET)));
        topics[2] = intentId;
        topics[3] = executionId;
        proven = _proven(_receipt(RECEIVER, topics, abi.encode(bytes32(value), actionDigest)));
    }

    function _proven(bytes memory encodedTransaction) private pure returns (ProvenTransaction[] memory proven) {
        proven = new ProvenTransaction[](1);
        proven[0] = ProvenTransaction({
            chainKey: CHAIN_KEY, blockHeight: START_BLOCK + 1, txIndex: 3, encodedTransaction: encodedTransaction
        });
    }

    function _receipt(address emitter, bytes32[] memory topics, bytes memory data) private pure returns (bytes memory) {
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](1);
        logs[0] = EvmV1Decoder.LogEntryTuple({address_: emitter, topics: topics, data: data});
        bytes[] memory chunks = new bytes[](3);
        chunks[2] = abi.encode(uint8(1), uint64(1), logs, bytes(""));
        return abi.encode(uint8(2), chunks);
    }
}
