// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IMessageReceiver} from "@gluwa/usc-contracts/contracts/write-ability/abstract/IMessageReceiver.sol";
import {BoundedRemedyReceiverV1} from "./BoundedRemedyReceiverV1.sol";

contract UscRemedyDispatcherV1 is IMessageReceiver {
    error ImmutableInbox();
    error InvalidEnvelope();
    error MessageAlreadyProcessed();
    error WrongReceiver();
    error WrongSourceAdapter();
    error WrongSourceChain();
    error WrongSourceCoordinator();
    error ZeroAddress();

    event RemedyDispatched(bytes32 indexed messageId, address indexed receiver, bytes32 resultDigest);

    address public immutable trustedInbox;
    uint64 public immutable trustedSourceChain;
    address public immutable trustedSourceAdapter;
    address public immutable trustedSourceCoordinator;
    address public immutable destinationReceiver;

    mapping(bytes32 messageId => bool processed) public messageProcessed;

    constructor(
        address trustedInbox_,
        uint64 trustedSourceChain_,
        address trustedSourceAdapter_,
        address trustedSourceCoordinator_,
        address destinationReceiver_
    ) {
        if (
            trustedInbox_ == address(0) || trustedSourceAdapter_ == address(0)
                || trustedSourceCoordinator_ == address(0) || destinationReceiver_ == address(0)
        ) revert ZeroAddress();
        if (trustedSourceChain_ == 0) revert WrongSourceChain();

        trustedInbox = trustedInbox_;
        trustedSourceChain = trustedSourceChain_;
        trustedSourceAdapter = trustedSourceAdapter_;
        trustedSourceCoordinator = trustedSourceCoordinator_;
        destinationReceiver = destinationReceiver_;
    }

    function receiveMessage(bytes32 messageId, uint256 sourceChainId, address emitterAddress, bytes calldata payload)
        external
        override
    {
        if (msg.sender != trustedInbox) revert UnauthorizedInbox(msg.sender);
        if (sourceChainId != trustedSourceChain) revert WrongSourceChain();
        if (emitterAddress != trustedSourceAdapter) revert WrongSourceAdapter();
        if (messageProcessed[messageId]) revert MessageAlreadyProcessed();

        (address receiver, address sourceCoordinator, bytes memory remedyPayload) =
            abi.decode(payload, (address, address, bytes));
        if (keccak256(payload) != keccak256(abi.encode(receiver, sourceCoordinator, remedyPayload))) {
            revert InvalidEnvelope();
        }
        if (receiver != destinationReceiver) revert WrongReceiver();
        if (sourceCoordinator != trustedSourceCoordinator) revert WrongSourceCoordinator();

        messageProcessed[messageId] = true;
        bytes32 resultDigest = BoundedRemedyReceiverV1(receiver)
            .receiveMessage(messageId, trustedSourceChain, sourceCoordinator, remedyPayload);
        emit RemedyDispatched(messageId, receiver, resultDigest);
    }

    function setTrustedInbox(address, bool) external pure override {
        revert ImmutableInbox();
    }

    function isTrustedInbox(address inbox) external view override returns (bool) {
        return inbox == trustedInbox;
    }
}
