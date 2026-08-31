// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IOutbox} from "@gluwa/usc-contracts/contracts/write-ability/abstract/IOutbox.sol";
import {IMessageReceiver} from "@gluwa/usc-contracts/contracts/write-ability/abstract/IMessageReceiver.sol";
import {BoundedRemedyReceiverV1} from "../../contracts/v3/BoundedRemedyReceiverV1.sol";
import {UscRemedyDispatcherV1} from "../../contracts/v3/UscRemedyDispatcherV1.sol";
import {UscRemedyTransportV1} from "../../contracts/v3/UscRemedyTransportV1.sol";
import {IRemedyTargetV1} from "../../contracts/v3/interfaces/IRemedyTargetV1.sol";

contract UscRemedyTokenMock is ERC20 {
    constructor() ERC20("Attestcoin", "ATTEST") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }
}

contract UscRemedyOutboxMock {
    IERC20 public immutable token;
    uint32 public immutable chainKey;
    uint256 public coreFee;
    uint64 public sequence;
    bytes public lastPayload;
    mapping(bytes32 messageId => bool acknowledged) public acknowledgements;

    constructor(IERC20 token_, uint32 chainKey_, uint256 coreFee_) {
        token = token_;
        chainKey = chainKey_;
        coreFee = coreFee_;
    }

    function setCoreFee(uint256 value) external {
        coreFee = value;
    }

    function setAcknowledged(bytes32 messageId, bool value) external {
        acknowledgements[messageId] = value;
    }

    function publishMessage(bool canAck, bytes calldata payload) external returns (bytes32 messageId) {
        require(canAck, "ack required");
        require(token.allowance(msg.sender, address(this)) == coreFee, "allowance not exact");
        if (coreFee != 0) require(token.transferFrom(msg.sender, address(this), coreFee), "fee transfer failed");
        lastPayload = payload;
        messageId = keccak256(abi.encode(address(this), msg.sender, ++sequence, keccak256(payload)));
    }

    function isAcknowledged(bytes32 messageId) external view returns (bool) {
        return acknowledgements[messageId];
    }
}

contract UscRemedyReentrantCoordinatorOutboxMock {
    uint32 public immutable chainKey;
    uint256 public constant coreFee = 0;
    UscRemedyTransportV1 public transport;
    bool private entered;

    constructor(uint32 chainKey_) {
        chainKey = chainKey_;
    }

    function setTransport(UscRemedyTransportV1 transport_) external {
        transport = transport_;
    }

    function attack(bytes32 intentId, address receiver, bytes calldata payload, uint64 expiry)
        external
        returns (bytes32)
    {
        return transport.publish(intentId, chainKey, receiver, payload, expiry);
    }

    function publishMessage(bool, bytes calldata envelope) external returns (bytes32 messageId) {
        if (!entered) {
            entered = true;
            (address receiver,, bytes memory remedyPayload) = abi.decode(envelope, (address, address, bytes));
            (bytes32 intentId,,,,, uint64 expiry) =
                abi.decode(remedyPayload, (bytes32, bytes32, address, bytes32, bytes, uint64));
            transport.publish(intentId, chainKey, receiver, remedyPayload, expiry);
        }
        messageId = keccak256(envelope);
    }

    function isAcknowledged(bytes32) external pure returns (bool) {
        return false;
    }
}

contract UscRemedyTargetMock is IRemedyTargetV1 {
    bool public fail;
    uint256 public calls;
    bytes32 public expectedKind;
    bytes32 public expectedDataHash;

    function configure(bytes32 kind, bytes calldata actionData, bool fail_) external {
        expectedKind = kind;
        expectedDataHash = keccak256(actionData);
        fail = fail_;
    }

    function executeRemedy(bytes32, bytes32 actionKind, bytes calldata actionData)
        external
        returns (bytes32 resultDigest)
    {
        require(!fail, "target unavailable");
        require(actionKind == expectedKind && keccak256(actionData) == expectedDataHash, "wrong remedy");
        ++calls;
        return keccak256(abi.encode(actionKind, actionData));
    }
}

contract UscRemedyTransportV1Test is Test {
    address private constant COORDINATOR = address(0xC001);
    address private constant GUARDIAN = address(0xA11CE);
    address private constant INBOX = address(0x1B0);
    uint64 private constant SOURCE_CHAIN = 102031;
    uint32 private constant DESTINATION_CHAIN = 1;
    uint256 private constant CORE_FEE = 17 ether;
    bytes32 private constant INTENT_ID = keccak256("intent");
    bytes32 private constant EXECUTION_ID = keccak256("execution");
    bytes32 private constant ACTION_KIND = keccak256("repay-v1");
    bytes private constant ACTION_DATA = abi.encode(address(0xB0B), uint256(250));

    UscRemedyTokenMock private token;
    UscRemedyOutboxMock private outbox;
    BoundedRemedyReceiverV1 private receiver;
    UscRemedyDispatcherV1 private dispatcher;
    UscRemedyTransportV1 private transport;
    UscRemedyTargetMock private target;

    function setUp() public {
        token = new UscRemedyTokenMock();
        outbox = new UscRemedyOutboxMock(token, DESTINATION_CHAIN, CORE_FEE);
        target = new UscRemedyTargetMock();
        target.configure(ACTION_KIND, ACTION_DATA, false);

        uint64 nonce = vm.getNonce(address(this));
        address predictedDispatcher = vm.computeCreateAddress(address(this), nonce + 1);
        address predictedTransport = vm.computeCreateAddress(address(this), nonce + 2);
        receiver = new BoundedRemedyReceiverV1(predictedDispatcher, GUARDIAN);
        dispatcher = new UscRemedyDispatcherV1(INBOX, SOURCE_CHAIN, predictedTransport, COORDINATOR, address(receiver));
        transport = new UscRemedyTransportV1(
            COORDINATOR, IOutbox(address(outbox)), token, DESTINATION_CHAIN, address(receiver), CORE_FEE
        );
        assertEq(address(dispatcher), predictedDispatcher);
        assertEq(address(transport), predictedTransport);
        token.mint(address(transport), 100 ether);
    }

    function test_publishRequiresExactCoordinatorRouteReceiverAndExpiry() public {
        uint64 expiry = uint64(block.timestamp + 1 days);
        bytes memory payload = _remedyPayload(expiry);

        vm.expectRevert(UscRemedyTransportV1.NotCoordinator.selector);
        transport.publish(INTENT_ID, DESTINATION_CHAIN, address(receiver), payload, expiry);

        vm.startPrank(COORDINATOR);
        vm.expectRevert(UscRemedyTransportV1.WrongDestinationChain.selector);
        transport.publish(INTENT_ID, DESTINATION_CHAIN + 1, address(receiver), payload, expiry);
        vm.expectRevert(UscRemedyTransportV1.WrongReceiver.selector);
        transport.publish(INTENT_ID, DESTINATION_CHAIN, address(0xBAD), payload, expiry);
        vm.expectRevert(UscRemedyTransportV1.InvalidExpiry.selector);
        transport.publish(INTENT_ID, DESTINATION_CHAIN, address(receiver), payload, uint64(block.timestamp));
        vm.expectRevert(UscRemedyTransportV1.InvalidPayload.selector);
        transport.publish(INTENT_ID, DESTINATION_CHAIN, address(receiver), _remedyPayload(expiry + 1), expiry);
        vm.expectRevert(UscRemedyTransportV1.InvalidPayload.selector);
        transport.publish(keccak256("other"), DESTINATION_CHAIN, address(receiver), payload, expiry);
        vm.stopPrank();
    }

    function test_constructorRejectsOutboxForDifferentDestinationRoute() public {
        UscRemedyOutboxMock wrongRoute = new UscRemedyOutboxMock(token, DESTINATION_CHAIN + 1, CORE_FEE);
        vm.expectRevert(UscRemedyTransportV1.RouteChainMismatch.selector);
        new UscRemedyTransportV1(
            COORDINATOR, IOutbox(address(wrongRoute)), token, DESTINATION_CHAIN, address(receiver), CORE_FEE
        );
    }

    function test_constructorRejectsZeroMaximumCoreFee() public {
        vm.expectRevert(UscRemedyTransportV1.InvalidMaximumCoreFee.selector);
        new UscRemedyTransportV1(COORDINATOR, IOutbox(address(outbox)), token, DESTINATION_CHAIN, address(receiver), 0);
    }

    function test_publishAllowsCoreFeeEqualToOrBelowMaximumAndResetsAllowance() public {
        uint64 expiry = uint64(block.timestamp + 1 days);
        uint256 initialBalance = token.balanceOf(address(transport));
        vm.prank(COORDINATOR);
        bytes32 messageId =
            transport.publish(INTENT_ID, DESTINATION_CHAIN, address(receiver), _remedyPayload(expiry), expiry);

        assertNotEq(messageId, bytes32(0));
        assertEq(token.balanceOf(address(transport)), initialBalance - CORE_FEE);
        assertEq(token.balanceOf(address(outbox)), CORE_FEE);
        assertEq(token.allowance(address(transport), address(outbox)), 0);
        (address selectedReceiver, address sourceCoordinator, bytes memory remedyPayload) =
            abi.decode(outbox.lastPayload(), (address, address, bytes));
        assertEq(selectedReceiver, address(receiver));
        assertEq(sourceCoordinator, COORDINATOR);
        assertEq(remedyPayload, _remedyPayload(expiry));

        outbox.setCoreFee(3 ether);
        vm.prank(COORDINATOR);
        transport.publish(INTENT_ID, DESTINATION_CHAIN, address(receiver), _remedyPayload(expiry), expiry);
        assertEq(token.balanceOf(address(outbox)), CORE_FEE + 3 ether);
        assertEq(token.allowance(address(transport), address(outbox)), 0);
    }

    function test_publishRejectsCoreFeeAboveMaximumBeforeApprovalOrPublish() public {
        uint64 expiry = uint64(block.timestamp + 1 days);
        uint256 excessiveFee = CORE_FEE + 1;
        uint256 initialBalance = token.balanceOf(address(transport));
        outbox.setCoreFee(excessiveFee);

        vm.expectRevert(
            abi.encodeWithSelector(UscRemedyTransportV1.CoreFeeExceedsMaximum.selector, excessiveFee, CORE_FEE)
        );
        vm.prank(COORDINATOR);
        transport.publish(INTENT_ID, DESTINATION_CHAIN, address(receiver), _remedyPayload(expiry), expiry);

        assertEq(token.balanceOf(address(transport)), initialBalance);
        assertEq(token.balanceOf(address(outbox)), 0);
        assertEq(token.allowance(address(transport), address(outbox)), 0);
        assertEq(outbox.sequence(), 0);
    }

    function test_publishRejectsOutboxReentrancy() public {
        UscRemedyReentrantCoordinatorOutboxMock reentrant =
            new UscRemedyReentrantCoordinatorOutboxMock(DESTINATION_CHAIN);
        UscRemedyTransportV1 reentrantTransport = new UscRemedyTransportV1(
            address(reentrant), IOutbox(address(reentrant)), token, DESTINATION_CHAIN, address(receiver), 1
        );
        reentrant.setTransport(reentrantTransport);
        uint64 expiry = uint64(block.timestamp + 1 days);

        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        reentrant.attack(INTENT_ID, address(receiver), _remedyPayload(expiry), expiry);
    }

    function test_acknowledgementIsProxiedFromBoundOutbox() public {
        uint64 expiry = uint64(block.timestamp + 1 days);
        vm.prank(COORDINATOR);
        bytes32 messageId =
            transport.publish(INTENT_ID, DESTINATION_CHAIN, address(receiver), _remedyPayload(expiry), expiry);
        assertFalse(transport.isAcknowledged(messageId));
        outbox.setAcknowledged(messageId, true);
        assertTrue(transport.isAcknowledged(messageId));
    }

    function test_dispatcherRejectsSpoofedInboxSourceChainAdapterAndEnvelope() public {
        uint64 expiry = uint64(block.timestamp + 1 days);
        bytes32 messageId = keccak256("message");
        bytes memory envelope = abi.encode(address(receiver), COORDINATOR, _remedyPayload(expiry));

        vm.expectRevert(abi.encodeWithSelector(IMessageReceiver.UnauthorizedInbox.selector, address(this)));
        dispatcher.receiveMessage(messageId, SOURCE_CHAIN, address(transport), envelope);
        vm.startPrank(INBOX);
        vm.expectRevert(UscRemedyDispatcherV1.WrongSourceChain.selector);
        dispatcher.receiveMessage(messageId, SOURCE_CHAIN + 1, address(transport), envelope);
        vm.expectRevert(UscRemedyDispatcherV1.WrongSourceAdapter.selector);
        dispatcher.receiveMessage(messageId, SOURCE_CHAIN, address(0xBAD), envelope);
        vm.expectRevert(UscRemedyDispatcherV1.WrongReceiver.selector);
        dispatcher.receiveMessage(
            messageId, SOURCE_CHAIN, address(transport), abi.encode(address(0xBAD), COORDINATOR, _remedyPayload(expiry))
        );
        vm.expectRevert(UscRemedyDispatcherV1.WrongSourceCoordinator.selector);
        dispatcher.receiveMessage(
            messageId,
            SOURCE_CHAIN,
            address(transport),
            abi.encode(address(receiver), address(0xBAD), _remedyPayload(expiry))
        );
        vm.stopPrank();
    }

    function test_dispatcherRejectsMalformedEnvelopeWithoutConsumingMessage() public {
        bytes32 messageId = keccak256("malformed");
        vm.expectRevert();
        vm.prank(INBOX);
        dispatcher.receiveMessage(messageId, SOURCE_CHAIN, address(transport), hex"1234");
        assertFalse(dispatcher.messageProcessed(messageId));
    }

    function test_dispatcherRejectsZeroMessageIdWithoutConsumingIt() public {
        uint64 expiry = uint64(block.timestamp + 1 days);
        _authorize(expiry);

        vm.expectRevert(BoundedRemedyReceiverV1.InvalidMessageId.selector);
        vm.prank(INBOX);
        dispatcher.receiveMessage(
            bytes32(0),
            SOURCE_CHAIN,
            address(transport),
            abi.encode(address(receiver), COORDINATOR, _remedyPayload(expiry))
        );
        assertFalse(dispatcher.messageProcessed(bytes32(0)));
        assertFalse(receiver.messageProcessed(bytes32(0)));
    }

    function test_receiverRejectsTrailingPayloadBytesWithoutConsumingMessage() public {
        uint64 expiry = uint64(block.timestamp + 1 days);
        bytes32 messageId = keccak256("trailing-remedy-payload");
        _authorize(expiry);
        bytes memory nonCanonicalPayload = bytes.concat(_remedyPayload(expiry), hex"00");

        vm.expectRevert(BoundedRemedyReceiverV1.InvalidPayload.selector);
        vm.prank(INBOX);
        dispatcher.receiveMessage(
            messageId, SOURCE_CHAIN, address(transport), abi.encode(address(receiver), COORDINATOR, nonCanonicalPayload)
        );
        assertFalse(dispatcher.messageProcessed(messageId));
        assertFalse(receiver.messageProcessed(messageId));
        assertEq(target.calls(), 0);
    }

    function test_receiverFailureRollsBackDispatcherReplayGuardAndCanRetry() public {
        uint64 expiry = uint64(block.timestamp + 1 days);
        bytes32 messageId = keccak256("retry");
        bytes memory remedyPayload = _remedyPayload(expiry);
        _authorize(expiry);
        target.configure(ACTION_KIND, ACTION_DATA, true);

        vm.expectRevert(bytes("target unavailable"));
        vm.prank(INBOX);
        dispatcher.receiveMessage(
            messageId, SOURCE_CHAIN, address(transport), abi.encode(address(receiver), COORDINATOR, remedyPayload)
        );
        assertFalse(dispatcher.messageProcessed(messageId));
        assertFalse(receiver.messageProcessed(messageId));

        target.configure(ACTION_KIND, ACTION_DATA, false);
        vm.prank(INBOX);
        dispatcher.receiveMessage(
            messageId, SOURCE_CHAIN, address(transport), abi.encode(address(receiver), COORDINATOR, remedyPayload)
        );
        assertTrue(dispatcher.messageProcessed(messageId));
        assertTrue(receiver.messageProcessed(messageId));
        assertEq(target.calls(), 1);
    }

    function test_successfulBoundedExecutionCannotReplay() public {
        uint64 expiry = uint64(block.timestamp + 1 days);
        bytes32 messageId = keccak256("success");
        _authorize(expiry);
        bytes memory envelope = abi.encode(address(receiver), COORDINATOR, _remedyPayload(expiry));

        vm.prank(INBOX);
        dispatcher.receiveMessage(messageId, SOURCE_CHAIN, address(transport), envelope);
        assertEq(target.calls(), 1);
        assertTrue(dispatcher.messageProcessed(messageId));
        assertTrue(receiver.messageProcessed(messageId));

        vm.expectRevert(UscRemedyDispatcherV1.MessageAlreadyProcessed.selector);
        vm.prank(INBOX);
        dispatcher.receiveMessage(messageId, SOURCE_CHAIN, address(transport), envelope);
        vm.expectRevert(UscRemedyDispatcherV1.ImmutableInbox.selector);
        dispatcher.setTrustedInbox(address(0xBAD), true);
        assertTrue(dispatcher.isTrustedInbox(INBOX));
        assertFalse(dispatcher.isTrustedInbox(address(0xBAD)));
    }

    function _authorize(uint64 expiry) private {
        BoundedRemedyReceiverV1.Authorization memory authorization = BoundedRemedyReceiverV1.Authorization({
            sourceChain: SOURCE_CHAIN,
            sourceCoordinator: COORDINATOR,
            intentId: INTENT_ID,
            executionId: EXECUTION_ID,
            target: address(target),
            actionKind: ACTION_KIND,
            actionDataHash: keccak256(ACTION_DATA),
            expiry: expiry,
            consumed: false
        });
        vm.prank(GUARDIAN);
        receiver.authorize(authorization);
    }

    function _remedyPayload(uint64 expiry) private view returns (bytes memory) {
        return abi.encode(INTENT_ID, EXECUTION_ID, address(target), ACTION_KIND, ACTION_DATA, expiry);
    }
}
