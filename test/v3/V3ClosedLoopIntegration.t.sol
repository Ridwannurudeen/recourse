// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/write-ability/common/EvmV1Decoder.sol";
import {INativeQueryVerifier} from "@gluwa/usc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {RecourseFacilityV2} from "../../contracts/v2/RecourseFacilityV2.sol";
import {ObservationKind, PolicyEffect, PolicyOutcome} from "../../contracts/v2/types/RecourseTypesV2.sol";
import {BoundedRemedyReceiverV1} from "../../contracts/v3/BoundedRemedyReceiverV1.sol";
import {ClosedLoopPolicyV1} from "../../contracts/v3/ClosedLoopPolicyV1.sol";
import {PolicyKernelV2} from "../../contracts/v3/PolicyKernelV2.sol";
import {RemedyCoordinatorV1} from "../../contracts/v3/RemedyCoordinatorV1.sol";
import {IRemedyCoordinatorV1} from "../../contracts/v3/interfaces/IRemedyCoordinatorV1.sol";
import {IRemedyTargetV1} from "../../contracts/v3/interfaces/IRemedyTargetV1.sol";
import {IRemedyTransportV1} from "../../contracts/v3/interfaces/IRemedyTransportV1.sol";
import {MockVerifier} from "../mocks/MockVerifier.sol";

contract V3IntegrationToken is ERC20 {
    constructor() ERC20("Integration USD", "IUSD") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }
}

contract V3IntegrationTransport is IRemedyTransportV1 {
    uint256 public publishCalls;
    bytes32 public lastMessageId;
    mapping(bytes32 messageId => bool acknowledged) public acknowledgements;

    function setAcknowledged(bytes32 messageId, bool value) external {
        acknowledgements[messageId] = value;
    }

    function publish(bytes32 intentId, uint64, address, bytes calldata payload, uint64)
        external
        returns (bytes32 messageId)
    {
        messageId = keccak256(abi.encode(intentId, keccak256(payload), ++publishCalls));
        lastMessageId = messageId;
    }

    function isAcknowledged(bytes32 messageId) external view returns (bool) {
        return acknowledgements[messageId];
    }

    function deliver(
        BoundedRemedyReceiverV1 receiver,
        bytes32 messageId,
        uint64 sourceChain,
        address sourceCoordinator,
        bytes calldata payload
    ) external returns (bytes32) {
        return receiver.receiveMessage(messageId, sourceChain, sourceCoordinator, payload);
    }
}

contract V3IntegrationTarget is IRemedyTargetV1 {
    event RemedyCompleted(address indexed subject, bytes32 indexed executionId, uint256 value, bytes32 actionDataHash);

    address public immutable subject;
    bytes32 public immutable expectedKind;
    bytes32 public immutable expectedDataHash;
    uint256 public calls;

    constructor(address subject_, bytes32 expectedKind_, bytes memory expectedData) {
        subject = subject_;
        expectedKind = expectedKind_;
        expectedDataHash = keccak256(expectedData);
    }

    function executeRemedy(bytes32 executionId, bytes32 actionKind, bytes calldata actionData)
        external
        returns (bytes32)
    {
        require(actionKind == expectedKind && keccak256(actionData) == expectedDataHash, "wrong action");
        ++calls;
        (, uint256 value) = abi.decode(actionData, (address, uint256));
        emit RemedyCompleted(subject, executionId, value, keccak256(actionData));
        return keccak256(abi.encode(actionKind, actionData));
    }
}

contract V3ClosedLoopIntegrationTest is Test {
    address private constant LENDER = address(0xA1);
    address private constant BORROWER = address(0xB2);
    address private constant GUARDIAN = address(0xB3);
    address private constant ADVERSE_EMITTER = address(0xC3);
    uint256 private constant POLICY_ID = 7;
    uint64 private constant CHAIN_KEY = 3;
    uint64 private constant REMEDY_SOURCE_CHAIN = 102031;
    bytes32 private constant ADVERSE_SIG = keccak256("LiabilityIncreased(address,uint256)");
    uint64 private constant CURE_CHAIN_KEY = 1;
    bytes32 private constant CURE_SIG = keccak256("RemedyExecutionConfirmed(address,bytes32,bytes32,bytes32,bytes32)");
    bytes32 private constant ACTION_KIND = keccak256("repay-v1");
    bytes private constant ACTION_DATA = abi.encode(address(0xE5), uint256(100));

    V3IntegrationToken private token;
    MockVerifier private verifier;
    PolicyKernelV2 private kernel;
    RecourseFacilityV2 private facility;
    V3IntegrationTransport private transport;
    RemedyCoordinatorV1 private coordinator;
    ClosedLoopPolicyV1 private policy;
    BoundedRemedyReceiverV1 private receiver;
    V3IntegrationTarget private target;

    function setUp() public {
        token = new V3IntegrationToken();
        verifier = new MockVerifier();
        kernel = new PolicyKernelV2(verifier);
        facility = new RecourseFacilityV2(
            token, address(kernel), LENDER, BORROWER, 1_000, 200, 100, uint64(block.number + 10_000), 0
        );
        transport = new V3IntegrationTransport();
        receiver = new BoundedRemedyReceiverV1(address(transport), GUARDIAN);
        target = new V3IntegrationTarget(BORROWER, ACTION_KIND, ACTION_DATA);
        coordinator = new RemedyCoordinatorV1(kernel, transport);
        policy = new ClosedLoopPolicyV1(kernel, coordinator);

        vm.prank(LENDER);
        policy.configure(address(facility), POLICY_ID, _configuration());
        vm.prank(LENDER);
        kernel.registerPolicy(address(facility), POLICY_ID, policy);
        vm.prank(LENDER);
        coordinator.authorizePolicy(address(facility), POLICY_ID, address(policy));

        token.mint(LENDER, 1_000);
        token.mint(BORROWER, 200);
        vm.prank(LENDER);
        token.approve(address(facility), type(uint256).max);
        vm.prank(BORROWER);
        token.approve(address(facility), type(uint256).max);
        vm.prank(LENDER);
        facility.fundAsLender(1_000);
        vm.prank(BORROWER);
        facility.postBond(200);
        bytes32 policySetCommitment = kernel.policySetCommitment(address(facility));
        vm.prank(BORROWER);
        facility.activate(policySetCommitment);
    }

    function test_verifiedAdverseTransportAcknowledgementAndVerifiedCureCloseTheFacilityLoop() public {
        _submit(CHAIN_KEY, 100, _adverseReceipt(75));
        bytes32 intentId = policy.latestIntent(address(facility), POLICY_ID);
        assertEq(uint256(facility.policyOutcome()), uint256(PolicyOutcome.Restricted));
        assertEq(facility.creditLimitBps(), 5_000);
        assertEq(uint256(coordinator.intentStatus(intentId)), uint256(IRemedyCoordinatorV1.IntentStatus.Recorded));

        coordinator.publishIntent(intentId, ACTION_DATA);
        RemedyCoordinatorV1.Intent memory intent = coordinator.intentOf(intentId);
        _authorize(intentId, intent.executionId, intent.expiry);
        vm.recordLogs();
        transport.deliver(
            receiver,
            transport.lastMessageId(),
            REMEDY_SOURCE_CHAIN,
            address(coordinator),
            _remedyPayload(intentId, intent.executionId, intent.expiry)
        );
        (bytes32[] memory executionTopics, bytes memory executionData) =
            _confirmedExecutionLog(vm.getRecordedLogs(), intentId, intent.executionId);
        transport.setAcknowledged(transport.lastMessageId(), true);
        coordinator.syncAcknowledgement(intentId);
        assertEq(uint256(facility.policyOutcome()), uint256(PolicyOutcome.Restricted));

        _submit(CURE_CHAIN_KEY, 500, _receipt(address(receiver), executionTopics, executionData));
        assertEq(uint256(coordinator.intentStatus(intentId)), uint256(IRemedyCoordinatorV1.IntentStatus.Cured));
        assertEq(uint256(facility.policyOutcome()), uint256(PolicyOutcome.Cured));
        assertEq(facility.creditLimitBps(), 10_000);
        assertEq(target.calls(), 1);

        vm.warp(block.timestamp + 365 days);
        assertEq(facility.availableCredit(), 1_000);
    }

    function test_delayedOldExecutionReplacementAcknowledgementAndStableCureCloseLoopOnce() public {
        _submit(CHAIN_KEY, 100, _adverseReceipt(75));
        bytes32 firstIntent = policy.latestIntent(address(facility), POLICY_ID);
        RemedyCoordinatorV1.Intent memory first = coordinator.intentOf(firstIntent);
        coordinator.publishIntent(firstIntent, ACTION_DATA);
        _authorize(firstIntent, first.executionId, first.expiry);
        transport.deliver(
            receiver,
            transport.lastMessageId(),
            REMEDY_SOURCE_CHAIN,
            address(coordinator),
            _remedyPayload(firstIntent, first.executionId, first.expiry)
        );
        assertEq(target.calls(), 1);

        vm.warp(first.expiry);
        coordinator.timeoutIntent(firstIntent);
        vm.prank(LENDER);
        bytes32 replacementIntent = policy.replaceRemedyIntent(address(facility), POLICY_ID);
        RemedyCoordinatorV1.Intent memory replacement = coordinator.intentOf(replacementIntent);
        assertNotEq(replacementIntent, firstIntent);
        assertEq(replacement.executionId, first.executionId);

        _authorize(replacementIntent, replacement.executionId, replacement.expiry);
        coordinator.publishIntent(replacementIntent, ACTION_DATA);
        bytes32 replacementMessage = transport.lastMessageId();
        vm.recordLogs();
        assertEq(
            transport.deliver(
                receiver,
                replacementMessage,
                REMEDY_SOURCE_CHAIN,
                address(coordinator),
                _remedyPayload(replacementIntent, replacement.executionId, replacement.expiry)
            ),
            keccak256(abi.encode(ACTION_KIND, ACTION_DATA))
        );
        (bytes32[] memory executionTopics, bytes memory executionData) =
            _confirmedExecutionLog(vm.getRecordedLogs(), replacementIntent, replacement.executionId);
        assertEq(target.calls(), 1);

        transport.setAcknowledged(replacementMessage, true);
        coordinator.syncAcknowledgement(replacementIntent);
        _submit(CURE_CHAIN_KEY, 501, _receipt(address(receiver), executionTopics, executionData));

        assertEq(uint256(coordinator.intentStatus(replacementIntent)), uint256(IRemedyCoordinatorV1.IntentStatus.Cured));
        assertEq(uint256(facility.policyOutcome()), uint256(PolicyOutcome.Cured));
        assertEq(target.calls(), 1);
    }

    function test_genuinelyNewAdverseIncidentGetsFreshExecutionAndCallsTargetAgain() public {
        _submit(CHAIN_KEY, 100, _adverseReceipt(75));
        bytes32 firstIntent = policy.latestIntent(address(facility), POLICY_ID);
        RemedyCoordinatorV1.Intent memory first = coordinator.intentOf(firstIntent);
        coordinator.publishIntent(firstIntent, ACTION_DATA);
        _authorize(firstIntent, first.executionId, first.expiry);
        transport.deliver(
            receiver,
            transport.lastMessageId(),
            REMEDY_SOURCE_CHAIN,
            address(coordinator),
            _remedyPayload(firstIntent, first.executionId, first.expiry)
        );
        assertEq(target.calls(), 1);

        vm.warp(first.expiry);
        coordinator.timeoutIntent(firstIntent);
        _submit(CHAIN_KEY, 101, _adverseReceipt(80));
        bytes32 nextIntent = policy.latestIntent(address(facility), POLICY_ID);
        RemedyCoordinatorV1.Intent memory next = coordinator.intentOf(nextIntent);
        assertNotEq(next.executionId, first.executionId);

        coordinator.publishIntent(nextIntent, ACTION_DATA);
        _authorize(nextIntent, next.executionId, next.expiry);
        transport.deliver(
            receiver,
            transport.lastMessageId(),
            REMEDY_SOURCE_CHAIN,
            address(coordinator),
            _remedyPayload(nextIntent, next.executionId, next.expiry)
        );
        assertEq(target.calls(), 2);
    }

    function _submit(uint64 chainKey, uint64 height, bytes memory transaction) private {
        INativeQueryVerifier.MerkleProof memory merkle;
        INativeQueryVerifier.ContinuityProof memory continuity;
        kernel.submitSingle(address(facility), POLICY_ID, chainKey, height, transaction, merkle, continuity);
    }

    function _configuration() private view returns (ClosedLoopPolicyV1.Configuration memory) {
        ClosedLoopPolicyV1.EventRule memory adverse = ClosedLoopPolicyV1.EventRule({
            sourceChain: CHAIN_KEY,
            emitter: ADVERSE_EMITTER,
            eventSignature: ADVERSE_SIG,
            subject: BORROWER,
            startSourceBlock: 100,
            endSourceBlock: 200,
            topicCount: 2,
            subjectTopicIndex: 1,
            dataLength: 32,
            observedValueOffset: 0
        });
        ClosedLoopPolicyV1.EventRule memory cure = ClosedLoopPolicyV1.EventRule({
            sourceChain: CURE_CHAIN_KEY,
            emitter: address(receiver),
            eventSignature: CURE_SIG,
            subject: address(target),
            startSourceBlock: 500,
            endSourceBlock: type(uint64).max,
            topicCount: 4,
            subjectTopicIndex: 1,
            dataLength: 64,
            observedValueOffset: 0
        });
        return ClosedLoopPolicyV1.Configuration({
            adverseRule: adverse,
            cureRule: ClosedLoopPolicyV1.CureRule({
                eventRule: cure, intentTopicIndex: 2, executionTopicIndex: 3, actionDigestOffset: 32
            }),
            observationKind: ObservationKind.Liability,
            freshnessPeriod: type(uint64).max,
            remedyDuration: 2 days,
            destinationChain: CURE_CHAIN_KEY,
            receiver: address(receiver),
            target: address(target),
            actionKind: ACTION_KIND,
            actionDataHash: keccak256(ACTION_DATA),
            adverseEffect: PolicyEffect({
                outcome: PolicyOutcome.Restricted,
                creditLimitBps: 5_000,
                futureDrawFeeBps: 300,
                freezePendingDraw: true,
                requireFreshEvidence: false,
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

    function _adverseReceipt(uint256 value) private pure returns (bytes memory) {
        bytes32[] memory topics = new bytes32[](2);
        topics[0] = ADVERSE_SIG;
        topics[1] = bytes32(uint256(uint160(BORROWER)));
        return _receipt(ADVERSE_EMITTER, topics, abi.encode(value));
    }

    function _authorize(bytes32 intentId, bytes32 executionId, uint64 expiry) private {
        BoundedRemedyReceiverV1.Authorization memory authorization = BoundedRemedyReceiverV1.Authorization({
            sourceChain: REMEDY_SOURCE_CHAIN,
            sourceCoordinator: address(coordinator),
            intentId: intentId,
            executionId: executionId,
            target: address(target),
            actionKind: ACTION_KIND,
            actionDataHash: keccak256(ACTION_DATA),
            expiry: expiry,
            consumed: false
        });
        vm.prank(GUARDIAN);
        receiver.authorize(authorization);
    }

    function _remedyPayload(bytes32 intentId, bytes32 executionId, uint64 expiry) private view returns (bytes memory) {
        return abi.encode(intentId, executionId, address(target), ACTION_KIND, ACTION_DATA, expiry);
    }

    function _confirmedExecutionLog(Vm.Log[] memory logs, bytes32 intentId, bytes32 executionId)
        private
        returns (bytes32[] memory topics, bytes memory data)
    {
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory entry = logs[i];
            if (
                entry.emitter != address(receiver) || entry.topics.length != 4 || entry.topics[0] != CURE_SIG
                    || entry.topics[1] != bytes32(uint256(uint160(address(target)))) || entry.topics[2] != intentId
                    || entry.topics[3] != executionId
            ) continue;
            assertEq(entry.data, abi.encode(keccak256(abi.encode(ACTION_KIND, ACTION_DATA)), keccak256(ACTION_DATA)));
            return (entry.topics, entry.data);
        }
        fail();
    }

    function _receipt(address emitter, bytes32[] memory topics, bytes memory data) private pure returns (bytes memory) {
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](1);
        logs[0] = EvmV1Decoder.LogEntryTuple({address_: emitter, topics: topics, data: data});
        bytes[] memory chunks = new bytes[](3);
        chunks[2] = abi.encode(uint8(1), uint64(1), logs, bytes(""));
        return abi.encode(uint8(2), chunks);
    }
}
