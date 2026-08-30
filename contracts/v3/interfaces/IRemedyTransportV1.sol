// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IRemedyTransportV1 {
    function publish(bytes32 intentId, uint64 destinationChain, address receiver, bytes calldata payload, uint64 expiry)
        external
        returns (bytes32 messageId);

    function isAcknowledged(bytes32 messageId) external view returns (bool);
}
