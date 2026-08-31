// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IPolicyConfigurationContextV1} from "../../contracts/v2/interfaces/IPolicyConfigurationContextV1.sol";
import {BoundedRemedyReceiverV1} from "../../contracts/v3/BoundedRemedyReceiverV1.sol";
import {RemedyCoordinatorV1} from "../../contracts/v3/RemedyCoordinatorV1.sol";
import {IRemedyCoordinatorV1} from "../../contracts/v3/interfaces/IRemedyCoordinatorV1.sol";
import {IRemedyTargetV1} from "../../contracts/v3/interfaces/IRemedyTargetV1.sol";
import {IRemedyTransportV1} from "../../contracts/v3/interfaces/IRemedyTransportV1.sol";

contract RemedyContextMock is IPolicyConfigurationContextV1 {
    address public lender;
    bool public registered = true;
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
}

contract RemedyTransportMock is IRemedyTransportV1 {
    bool public acknowledgementReverts;
    bool public shouldRevert;
    bool public returnZero;
    uint256 public publishCalls;
    bytes32 public lastMessageId;
    bytes public lastPayload;
    mapping(bytes32 messageId => bool acknowledged) public acknowledgements;

    function configure(bool reverts, bool zero) external {
        shouldRevert = reverts;
        returnZero = zero;
    }

    function setAcknowledged(bytes32 messageId, bool value) external {
        acknowledgements[messageId] = value;
    }

    function setAcknowledgementReverts(bool value) external {
        acknowledgementReverts = value;
    }

    function publish(bytes32 intentId, uint64, address, bytes calldata payload, uint64)
        external
        returns (bytes32 messageId)
    {
        if (shouldRevert) revert("transport failure");
        ++publishCalls;
        lastPayload = payload;
        if (returnZero) return bytes32(0);
        messageId = keccak256(abi.encode(msg.sender, intentId, payload, publishCalls));
        lastMessageId = messageId;
    }

    function isAcknowledged(bytes32 messageId) external view returns (bool) {
        if (acknowledgementReverts) revert("acknowledgement unavailable");
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

contract RemedyTargetMock is IRemedyTargetV1 {
    bytes32 public expectedKind;
    bytes32 public expectedDataHash;
    bytes32 public result = keccak256("executed");
    uint256 public calls;
    RemedyTransportMock public callbackTransport;
    BoundedRemedyReceiverV1 public callbackReceiver;
    bytes32 public callbackMessageId;
    uint64 public callbackSourceChain;
    address public callbackSourceCoordinator;
    bytes public callbackPayload;
    bool public callbackAttempted;
    bool public callbackSucceeded;

    function configure(bytes32 kind, bytes calldata data, bytes32 result_) external {
        expectedKind = kind;
        expectedDataHash = keccak256(data);
        result = result_;
    }

    function configureCallback(
        RemedyTransportMock transport,
        BoundedRemedyReceiverV1 receiver,
        bytes32 messageId,
        uint64 sourceChain,
        address sourceCoordinator,
        bytes calldata payload
    ) external {
        callbackTransport = transport;
        callbackReceiver = receiver;
        callbackMessageId = messageId;
        callbackSourceChain = sourceChain;
        callbackSourceCoordinator = sourceCoordinator;
        callbackPayload = payload;
    }

    function executeRemedy(bytes32, bytes32 actionKind, bytes calldata actionData) external returns (bytes32) {
        require(actionKind == expectedKind && keccak256(actionData) == expectedDataHash, "wrong action");
        ++calls;
        if (address(callbackTransport) != address(0)) {
            callbackAttempted = true;
            try callbackTransport.deliver(
                callbackReceiver, callbackMessageId, callbackSourceChain, callbackSourceCoordinator, callbackPayload
            ) returns (
                bytes32
            ) {
                callbackSucceeded = true;
            } catch (bytes memory reason) {
                require(reason.length != 0, "missing callback error");
            }
        }
        return result;
    }
}

contract RemedyLifecycleV1Test is Test {
    address private constant LENDER = address(0xA1);
    address private constant FACILITY = address(0xB2);
    address private constant GUARDIAN = address(0xC3);
    uint256 private constant POLICY_ID = 7;
    uint64 private constant SOURCE_CHAIN = 3;
    uint64 private constant DESTINATION_CHAIN = 102031;
    bytes32 private constant ACTION_KIND = keccak256("repay-v1");
    bytes private constant ACTION_DATA = abi.encode(address(0xD4), uint256(100));

    RemedyContextMock private context;
    RemedyTransportMock private transport;
    RemedyCoordinatorV1 private coordinator;
    BoundedRemedyReceiverV1 private receiver;
    RemedyTargetMock private target;

    function setUp() public {
        context = new RemedyContextMock();
        context.setLender(LENDER);
        context.setEvaluator(address(this));
        transport = new RemedyTransportMock();
        coordinator = new RemedyCoordinatorV1(context, transport);
        receiver = new BoundedRemedyReceiverV1(address(transport), GUARDIAN);
        target = new RemedyTargetMock();
        target.configure(ACTION_KIND, ACTION_DATA, keccak256("executed"));
        vm.prank(LENDER);
        coordinator.authorizePolicy(FACILITY, POLICY_ID, address(this));
    }

    function test_recordPublishAcknowledgeAndCureAreDistinctStates() public {
        bytes32 intentId = coordinator.recordIntent(_request());
        assertEq(uint256(coordinator.intentStatus(intentId)), uint256(IRemedyCoordinatorV1.IntentStatus.Recorded));
        coordinator.publishIntent(intentId, ACTION_DATA);
        assertEq(uint256(coordinator.intentStatus(intentId)), uint256(IRemedyCoordinatorV1.IntentStatus.Published));

        vm.expectRevert(RemedyCoordinatorV1.AcknowledgementMissing.selector);
        coordinator.syncAcknowledgement(intentId);
        transport.setAcknowledged(transport.lastMessageId(), true);
        coordinator.syncAcknowledgement(intentId);
        assertEq(uint256(coordinator.intentStatus(intentId)), uint256(IRemedyCoordinatorV1.IntentStatus.Acknowledged));

        bytes32 cureEvidence = keccak256("verified cure event");
        coordinator.recordCure(intentId, cureEvidence);
        assertEq(uint256(coordinator.intentStatus(intentId)), uint256(IRemedyCoordinatorV1.IntentStatus.Cured));
        assertEq(coordinator.intentOf(intentId).cureEvidenceDigest, cureEvidence);
    }

    function test_transportFailureAndZeroMessageDoNotConsumeRetry() public {
        bytes32 intentId = coordinator.recordIntent(_request());
        transport.configure(true, false);
        vm.expectRevert(bytes("transport failure"));
        coordinator.publishIntent(intentId, ACTION_DATA);
        assertEq(uint256(coordinator.intentStatus(intentId)), uint256(IRemedyCoordinatorV1.IntentStatus.Recorded));

        transport.configure(false, true);
        vm.expectRevert(RemedyCoordinatorV1.InvalidMessageId.selector);
        coordinator.publishIntent(intentId, ACTION_DATA);
        transport.configure(false, false);
        coordinator.publishIntent(intentId, ACTION_DATA);
        assertEq(uint256(coordinator.intentStatus(intentId)), uint256(IRemedyCoordinatorV1.IntentStatus.Published));
    }

    function test_recordedIntentCanBePermissionlesslyExpired() public {
        IRemedyCoordinatorV1.IntentRequest memory request = _request();
        request.expiry = uint64(block.timestamp + 10);
        bytes32 intentId = coordinator.recordIntent(request);

        vm.expectRevert(RemedyCoordinatorV1.IntentStillLive.selector);
        vm.prank(address(0xBAD));
        coordinator.timeoutIntent(intentId);

        vm.warp(request.expiry);
        vm.prank(address(0xBAD));
        coordinator.timeoutIntent(intentId);
        assertEq(uint256(coordinator.intentStatus(intentId)), uint256(IRemedyCoordinatorV1.IntentStatus.Expired));

        vm.expectRevert(
            abi.encodeWithSelector(
                RemedyCoordinatorV1.WrongStatus.selector,
                IRemedyCoordinatorV1.IntentStatus.Recorded,
                IRemedyCoordinatorV1.IntentStatus.Expired
            )
        );
        coordinator.publishIntent(intentId, ACTION_DATA);
    }

    function test_publishedIntentWithoutAcknowledgementExpiresPermissionlessly() public {
        IRemedyCoordinatorV1.IntentRequest memory request = _request();
        request.expiry = uint64(block.timestamp + 10);
        bytes32 intentId = coordinator.recordIntent(request);
        coordinator.publishIntent(intentId, ACTION_DATA);

        vm.warp(request.expiry);
        vm.prank(address(0xBAD));
        coordinator.timeoutIntent(intentId);
        assertEq(uint256(coordinator.intentStatus(intentId)), uint256(IRemedyCoordinatorV1.IntentStatus.Expired));
    }

    function test_publishedExpiryDoesNotDependOnAcknowledgementAdapterAvailability() public {
        IRemedyCoordinatorV1.IntentRequest memory request = _request();
        request.expiry = uint64(block.timestamp + 10);
        bytes32 intentId = coordinator.recordIntent(request);
        coordinator.publishIntent(intentId, ACTION_DATA);
        transport.setAcknowledgementReverts(true);

        vm.warp(request.expiry);
        vm.prank(address(0xBAD));
        coordinator.timeoutIntent(intentId);
        assertEq(uint256(coordinator.intentStatus(intentId)), uint256(IRemedyCoordinatorV1.IntentStatus.Expired));
    }

    function test_missingAcknowledgementHasBoundedAuthorizedRetriesAndPermissionlessFailure() public {
        bytes32 intentId = coordinator.recordIntent(_request());
        coordinator.publishIntent(intentId, ACTION_DATA);
        bytes32 firstMessage = coordinator.messageAt(intentId, 0);

        vm.warp(block.timestamp + coordinator.PUBLISH_RETRY_DELAY());
        vm.expectRevert(RemedyCoordinatorV1.RetryNotAuthorized.selector);
        vm.prank(address(0xBAD));
        coordinator.publishIntent(intentId, ACTION_DATA);

        coordinator.publishIntent(intentId, ACTION_DATA);
        vm.warp(block.timestamp + coordinator.PUBLISH_RETRY_DELAY());
        coordinator.publishIntent(intentId, ACTION_DATA);
        assertEq(coordinator.messageCount(intentId), coordinator.MAXIMUM_PUBLISH_ATTEMPTS());
        assertNotEq(firstMessage, coordinator.messageAt(intentId, 1));
        assertNotEq(coordinator.messageAt(intentId, 1), coordinator.messageAt(intentId, 2));

        vm.expectRevert(RemedyCoordinatorV1.PublishAttemptsExhausted.selector);
        coordinator.publishIntent(intentId, ACTION_DATA);
        vm.expectRevert(RemedyCoordinatorV1.IntentStillLive.selector);
        vm.prank(address(0xBAD));
        coordinator.timeoutIntent(intentId);

        vm.warp(block.timestamp + coordinator.PUBLISH_RETRY_DELAY());
        vm.prank(address(0xBAD));
        coordinator.timeoutIntent(intentId);
        assertEq(uint256(coordinator.intentStatus(intentId)), uint256(IRemedyCoordinatorV1.IntentStatus.Failed));
    }

    function test_acknowledgementOfEarlierAttemptCannotBeOrphanedByRetry() public {
        bytes32 intentId = coordinator.recordIntent(_request());
        coordinator.publishIntent(intentId, ACTION_DATA);
        bytes32 firstMessage = coordinator.messageAt(intentId, 0);
        vm.warp(block.timestamp + coordinator.PUBLISH_RETRY_DELAY());
        coordinator.publishIntent(intentId, ACTION_DATA);

        transport.setAcknowledged(firstMessage, true);
        coordinator.syncAcknowledgement(intentId);
        assertEq(coordinator.intentOf(intentId).messageId, firstMessage);
        assertEq(uint256(coordinator.intentStatus(intentId)), uint256(IRemedyCoordinatorV1.IntentStatus.Acknowledged));
    }

    function test_policyAuthorizationAndAdverseReplayAreExact() public {
        IRemedyCoordinatorV1.IntentRequest memory request = _request();
        vm.expectRevert(RemedyCoordinatorV1.NotPolicy.selector);
        vm.prank(address(0xBAD));
        coordinator.recordIntent(request);
        coordinator.recordIntent(request);
        vm.expectRevert(RemedyCoordinatorV1.AdverseEvidenceAlreadyUsed.selector);
        coordinator.recordIntent(request);

        vm.expectRevert(RemedyCoordinatorV1.PolicyAlreadyAuthorized.selector);
        vm.prank(LENDER);
        coordinator.authorizePolicy(FACILITY, POLICY_ID, address(0xE5));
    }

    function test_unregisteredPolicyCannotBeAuthorizedAndReplayIsPolicyScoped() public {
        uint256 secondPolicyId = POLICY_ID + 1;
        context.setRegistered(false);
        vm.expectRevert(RemedyCoordinatorV1.PolicyNotRegistered.selector);
        vm.prank(LENDER);
        coordinator.authorizePolicy(FACILITY, secondPolicyId, address(this));

        context.setRegistered(true);
        vm.prank(LENDER);
        coordinator.authorizePolicy(FACILITY, secondPolicyId, address(this));
        IRemedyCoordinatorV1.IntentRequest memory request = _request();
        coordinator.recordIntent(request);
        request.policyId = secondPolicyId;
        bytes32 secondIntent = coordinator.recordIntent(request);
        assertNotEq(secondIntent, bytes32(0));
    }

    function test_registeredPolicyIdCannotAuthorizeWrongEvaluator() public {
        context.setEvaluator(address(0xBAD));
        vm.expectRevert(RemedyCoordinatorV1.PolicyEvaluatorMismatch.selector);
        vm.prank(LENDER);
        coordinator.authorizePolicy(FACILITY, POLICY_ID + 1, address(this));
    }

    function test_sameAdverseEvidenceCanBeUsedByDifferentFacilityDomain() public {
        address secondFacility = address(0xFACA);
        vm.prank(LENDER);
        coordinator.authorizePolicy(secondFacility, POLICY_ID, address(this));
        IRemedyCoordinatorV1.IntentRequest memory first = _request();
        coordinator.recordIntent(first);
        first.facility = secondFacility;
        assertNotEq(coordinator.recordIntent(first), bytes32(0));
    }

    function test_wrongActionDataAndInvalidCureCannotAdvanceLifecycle() public {
        bytes32 intentId = coordinator.recordIntent(_request());
        vm.expectRevert(RemedyCoordinatorV1.InvalidPayload.selector);
        coordinator.publishIntent(intentId, hex"ffff");
        coordinator.publishIntent(intentId, ACTION_DATA);
        transport.setAcknowledged(transport.lastMessageId(), true);
        coordinator.syncAcknowledgement(intentId);

        vm.expectRevert(RemedyCoordinatorV1.InvalidCureEvidence.selector);
        coordinator.recordCure(intentId, keccak256("adverse"));
        vm.expectRevert(RemedyCoordinatorV1.NotPolicy.selector);
        vm.prank(address(0xBAD));
        coordinator.recordCure(intentId, keccak256("cure"));
    }

    function test_receiverExecutesOnlyExactPreauthorizedMessageOnce() public {
        bytes32 intentId = coordinator.recordIntent(_request());
        bytes memory payload = _payload(intentId);
        _authorize(intentId);
        bytes32 messageId = keccak256("message");

        bytes32 result = transport.deliver(receiver, messageId, SOURCE_CHAIN, address(coordinator), payload);
        assertEq(result, keccak256("executed"));
        assertEq(target.calls(), 1);
        assertTrue(receiver.messageProcessed(messageId));

        vm.expectRevert(BoundedRemedyReceiverV1.MessageAlreadyProcessed.selector);
        transport.deliver(receiver, messageId, SOURCE_CHAIN, address(coordinator), payload);
        assertEq(
            transport.deliver(receiver, keccak256("other-message"), SOURCE_CHAIN, address(coordinator), payload),
            keccak256("executed")
        );
        assertEq(target.calls(), 1);
    }

    function test_receiverRejectsSpoofedTransportSourceAndPayload() public {
        bytes32 intentId = coordinator.recordIntent(_request());
        bytes memory payload = _payload(intentId);
        _authorize(intentId);

        vm.expectRevert(BoundedRemedyReceiverV1.NotTransport.selector);
        receiver.receiveMessage(keccak256("message"), SOURCE_CHAIN, address(coordinator), payload);
        vm.expectRevert(BoundedRemedyReceiverV1.InvalidMessageId.selector);
        transport.deliver(receiver, bytes32(0), SOURCE_CHAIN, address(coordinator), payload);
        vm.expectRevert(BoundedRemedyReceiverV1.InvalidAuthorization.selector);
        transport.deliver(receiver, keccak256("message"), SOURCE_CHAIN + 1, address(coordinator), payload);

        bytes memory altered = abi.encode(
            intentId,
            coordinator.intentExecutionId(intentId),
            address(target),
            ACTION_KIND,
            abi.encode(address(0xBAD), uint256(100)),
            uint64(block.timestamp + 1 days)
        );
        vm.expectRevert(BoundedRemedyReceiverV1.InvalidAuthorization.selector);
        transport.deliver(receiver, keccak256("message"), SOURCE_CHAIN, address(coordinator), altered);
    }

    function test_failedTargetExecutionRollsBackConsumptionAndCanRetry() public {
        bytes32 intentId = coordinator.recordIntent(_request());
        bytes memory payload = _payload(intentId);
        bytes32 authorizationId = _authorize(intentId);
        bytes32 messageId = keccak256("message");
        target.configure(ACTION_KIND, ACTION_DATA, bytes32(0));

        vm.expectRevert(BoundedRemedyReceiverV1.InvalidResult.selector);
        transport.deliver(receiver, messageId, SOURCE_CHAIN, address(coordinator), payload);
        assertFalse(receiver.authorizationAt(authorizationId).consumed);
        assertFalse(receiver.messageProcessed(messageId));

        target.configure(ACTION_KIND, ACTION_DATA, keccak256("retry succeeded"));
        assertEq(
            transport.deliver(receiver, messageId, SOURCE_CHAIN, address(coordinator), payload),
            keccak256("retry succeeded")
        );
    }

    function test_delayedAcknowledgementCannotExecuteReplacementActionTwice() public {
        IRemedyCoordinatorV1.IntentRequest memory firstRequest = _request();
        firstRequest.expiry = uint64(block.timestamp + 10);
        bytes32 firstIntent = coordinator.recordIntent(firstRequest);
        coordinator.publishIntent(firstIntent, ACTION_DATA);

        BoundedRemedyReceiverV1.Authorization memory firstAuthorization =
            _authorization(firstIntent, firstRequest.expiry);
        vm.prank(GUARDIAN);
        receiver.authorize(firstAuthorization);
        bytes memory firstPayload = abi.encode(
            firstIntent,
            coordinator.intentExecutionId(firstIntent),
            address(target),
            ACTION_KIND,
            ACTION_DATA,
            firstRequest.expiry
        );
        transport.deliver(receiver, transport.lastMessageId(), SOURCE_CHAIN, address(coordinator), firstPayload);
        assertEq(target.calls(), 1);

        vm.warp(firstRequest.expiry);
        coordinator.timeoutIntent(firstIntent);

        uint64 replacementExpiry = uint64(block.timestamp + 1 days);
        bytes32 replacementIntent = coordinator.recordReplacement(firstIntent, replacementExpiry);
        assertEq(coordinator.intentExecutionId(replacementIntent), coordinator.intentExecutionId(firstIntent));
        BoundedRemedyReceiverV1.Authorization memory replacementAuthorization =
            _authorization(replacementIntent, replacementExpiry);
        vm.prank(GUARDIAN);
        receiver.authorize(replacementAuthorization);
        bytes memory replacementPayload = abi.encode(
            replacementIntent,
            coordinator.intentExecutionId(replacementIntent),
            address(target),
            ACTION_KIND,
            ACTION_DATA,
            replacementExpiry
        );

        assertEq(
            transport.deliver(
                receiver, keccak256("replacement message"), SOURCE_CHAIN, address(coordinator), replacementPayload
            ),
            keccak256("executed")
        );
        assertEq(target.calls(), 1);
    }

    function test_onlyAuthorizedPolicyCanReplaceItsLatestTerminalIntent() public {
        IRemedyCoordinatorV1.IntentRequest memory firstRequest = _request();
        firstRequest.expiry = uint64(block.timestamp + 10);
        bytes32 firstIntent = coordinator.recordIntent(firstRequest);
        vm.warp(firstRequest.expiry);
        coordinator.timeoutIntent(firstIntent);

        uint64 replacementExpiry = uint64(block.timestamp + 1 days);
        vm.expectRevert(RemedyCoordinatorV1.NotPolicy.selector);
        vm.prank(address(0xBAD));
        coordinator.recordReplacement(firstIntent, replacementExpiry);

        bytes32 replacementIntent = coordinator.recordReplacement(firstIntent, replacementExpiry);
        RemedyCoordinatorV1.Intent memory first = coordinator.intentOf(firstIntent);
        RemedyCoordinatorV1.Intent memory replacement = coordinator.intentOf(replacementIntent);
        assertEq(replacement.predecessorIntentId, firstIntent);
        assertEq(replacement.adverseEvidenceDigest, first.adverseEvidenceDigest);
        assertEq(replacement.executionId, first.executionId);
        assertEq(replacement.target, first.target);
        assertEq(replacement.actionDataHash, first.actionDataHash);

        vm.expectRevert(RemedyCoordinatorV1.InvalidIntent.selector);
        coordinator.recordReplacement(firstIntent, replacementExpiry + 1);
        vm.expectRevert(RemedyCoordinatorV1.InvalidIntent.selector);
        coordinator.recordReplacement(replacementIntent, replacementExpiry + 1);
    }

    function test_curedIntentStartsNewExecutionDomain() public {
        bytes32 firstIntent = coordinator.recordIntent(_request());
        coordinator.publishIntent(firstIntent, ACTION_DATA);
        transport.setAcknowledged(transport.lastMessageId(), true);
        coordinator.syncAcknowledgement(firstIntent);
        coordinator.recordCure(firstIntent, keccak256("first cure"));

        IRemedyCoordinatorV1.IntentRequest memory nextRequest = _request();
        nextRequest.adverseEvidenceDigest = keccak256("next adverse");
        bytes32 nextIntent = coordinator.recordIntent(nextRequest);

        assertNotEq(coordinator.intentExecutionId(nextIntent), coordinator.intentExecutionId(firstIntent));
        assertEq(coordinator.intentExecutionId(nextIntent), nextIntent);
    }

    function test_reusedExecutionRejectsDifferentActionCommitment() public {
        bytes32 intentId = coordinator.recordIntent(_request());
        bytes32 executionId = coordinator.intentExecutionId(intentId);
        _authorize(intentId);
        transport.deliver(receiver, keccak256("first"), SOURCE_CHAIN, address(coordinator), _payload(intentId));

        bytes memory alteredActionData = abi.encode(address(0xBAD), uint256(100));
        bytes32 secondIntent = keccak256("second-intent");
        uint64 expiry = uint64(block.timestamp + 1 days);
        BoundedRemedyReceiverV1.Authorization memory authorization = BoundedRemedyReceiverV1.Authorization({
            sourceChain: SOURCE_CHAIN,
            sourceCoordinator: address(coordinator),
            intentId: secondIntent,
            executionId: executionId,
            target: address(target),
            actionKind: ACTION_KIND,
            actionDataHash: keccak256(alteredActionData),
            expiry: expiry,
            consumed: false
        });
        vm.prank(GUARDIAN);
        receiver.authorize(authorization);

        vm.expectRevert(BoundedRemedyReceiverV1.InvalidAuthorization.selector);
        transport.deliver(
            receiver,
            keccak256("altered"),
            SOURCE_CHAIN,
            address(coordinator),
            abi.encode(secondIntent, executionId, address(target), ACTION_KIND, alteredActionData, expiry)
        );
        assertEq(target.calls(), 1);
    }

    function test_receiverExpiryAndReentrancyAreRejected() public {
        bytes32 intentId = coordinator.recordIntent(_request());
        bytes memory payload = _payload(intentId);
        _authorize(intentId);
        bytes32 outerMessage = keccak256("outer");
        target.configureCallback(transport, receiver, keccak256("inner"), SOURCE_CHAIN, address(coordinator), payload);
        transport.deliver(receiver, outerMessage, SOURCE_CHAIN, address(coordinator), payload);
        assertTrue(target.callbackAttempted());
        assertFalse(target.callbackSucceeded());
        assertEq(target.calls(), 1);

        bytes32 secondIntent = keccak256("second-intent");
        bytes32 secondExecution = keccak256("second-execution");
        uint64 expiry = uint64(block.timestamp + 10);
        BoundedRemedyReceiverV1.Authorization memory authorization = BoundedRemedyReceiverV1.Authorization({
            sourceChain: SOURCE_CHAIN,
            sourceCoordinator: address(coordinator),
            intentId: secondIntent,
            executionId: secondExecution,
            target: address(target),
            actionKind: ACTION_KIND,
            actionDataHash: keccak256(ACTION_DATA),
            expiry: expiry,
            consumed: false
        });
        vm.prank(GUARDIAN);
        receiver.authorize(authorization);
        vm.warp(expiry);
        vm.expectRevert(BoundedRemedyReceiverV1.AuthorizationExpired.selector);
        transport.deliver(
            receiver,
            keccak256("expired"),
            SOURCE_CHAIN,
            address(coordinator),
            abi.encode(secondIntent, secondExecution, address(target), ACTION_KIND, ACTION_DATA, expiry)
        );
    }

    function _request() private view returns (IRemedyCoordinatorV1.IntentRequest memory) {
        return IRemedyCoordinatorV1.IntentRequest({
            facility: FACILITY,
            policyId: POLICY_ID,
            adverseEvidenceDigest: keccak256("adverse"),
            destinationChain: DESTINATION_CHAIN,
            receiver: address(receiver),
            target: address(target),
            actionKind: ACTION_KIND,
            actionDataHash: keccak256(ACTION_DATA),
            expiry: uint64(block.timestamp + 1 days)
        });
    }

    function _payload(bytes32 intentId) private view returns (bytes memory) {
        return abi.encode(
            intentId,
            coordinator.intentExecutionId(intentId),
            address(target),
            ACTION_KIND,
            ACTION_DATA,
            uint64(block.timestamp + 1 days)
        );
    }

    function _authorize(bytes32 intentId) private returns (bytes32) {
        BoundedRemedyReceiverV1.Authorization memory authorization =
            _authorization(intentId, uint64(block.timestamp + 1 days));
        vm.prank(GUARDIAN);
        return receiver.authorize(authorization);
    }

    function _authorization(bytes32 intentId, uint64 expiry)
        private
        view
        returns (BoundedRemedyReceiverV1.Authorization memory)
    {
        return BoundedRemedyReceiverV1.Authorization({
            sourceChain: SOURCE_CHAIN,
            sourceCoordinator: address(coordinator),
            intentId: intentId,
            executionId: coordinator.intentExecutionId(intentId),
            target: address(target),
            actionKind: ACTION_KIND,
            actionDataHash: keccak256(ACTION_DATA),
            expiry: expiry,
            consumed: false
        });
    }
}
