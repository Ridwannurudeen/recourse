// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IOutbox} from "@gluwa/usc-contracts/contracts/write-ability/abstract/IOutbox.sol";
import {IRemedyTransportV1} from "./interfaces/IRemedyTransportV1.sol";

contract UscRemedyTransportV1 is IRemedyTransportV1, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error CoreFeeExceedsMaximum(uint256 coreFee, uint256 maximumCoreFee);
    error InvalidExpiry();
    error InvalidMaximumCoreFee();
    error InvalidMessageId();
    error InvalidPayload();
    error InvalidRouteChain();
    error NotCoordinator();
    error RouteChainMismatch();
    error WrongDestinationChain();
    error WrongReceiver();
    error ZeroAddress();

    address public immutable coordinator;
    IOutbox public immutable outbox;
    IERC20 public immutable attestToken;
    uint64 public immutable destinationChain;
    address public immutable destinationReceiver;
    uint256 public immutable maximumCoreFee;

    constructor(
        address coordinator_,
        IOutbox outbox_,
        IERC20 attestToken_,
        uint64 destinationChain_,
        address destinationReceiver_,
        uint256 maximumCoreFee_
    ) {
        if (
            coordinator_ == address(0) || address(outbox_) == address(0) || address(attestToken_) == address(0)
                || destinationReceiver_ == address(0)
        ) revert ZeroAddress();
        if (destinationChain_ == 0 || destinationChain_ > type(uint32).max) revert InvalidRouteChain();
        if (maximumCoreFee_ == 0) revert InvalidMaximumCoreFee();
        if (uint64(outbox_.chainKey()) != destinationChain_) revert RouteChainMismatch();

        coordinator = coordinator_;
        outbox = outbox_;
        attestToken = attestToken_;
        destinationChain = destinationChain_;
        destinationReceiver = destinationReceiver_;
        maximumCoreFee = maximumCoreFee_;
    }

    function publish(
        bytes32 intentId,
        uint64 destinationChain_,
        address receiver,
        bytes calldata payload,
        uint64 expiry
    ) external nonReentrant returns (bytes32 messageId) {
        if (msg.sender != coordinator) revert NotCoordinator();
        if (destinationChain_ != destinationChain) revert WrongDestinationChain();
        if (receiver != destinationReceiver) revert WrongReceiver();
        if (expiry <= block.timestamp) revert InvalidExpiry();

        (
            bytes32 payloadIntentId,
            bytes32 executionId,
            address target,
            bytes32 actionKind,
            bytes memory actionData,
            uint64 payloadExpiry
        ) = abi.decode(payload, (bytes32, bytes32, address, bytes32, bytes, uint64));
        if (
            intentId == bytes32(0) || executionId == bytes32(0) || payloadIntentId != intentId
                || payloadExpiry != expiry
                || keccak256(payload)
                    != keccak256(
                        abi.encode(payloadIntentId, executionId, target, actionKind, actionData, payloadExpiry)
                    )
        ) revert InvalidPayload();

        bytes memory envelope = abi.encode(receiver, coordinator, payload);
        uint256 fee = outbox.coreFee();
        if (fee > maximumCoreFee) revert CoreFeeExceedsMaximum(fee, maximumCoreFee);
        attestToken.forceApprove(address(outbox), fee);
        messageId = outbox.publishMessage(true, envelope);
        if (messageId == bytes32(0)) revert InvalidMessageId();
        attestToken.forceApprove(address(outbox), 0);
    }

    function isAcknowledged(bytes32 messageId) external view returns (bool) {
        return outbox.isAcknowledged(messageId);
    }
}
