// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IOperatorServiceVerifierV1 {
    function verifyService(
        bytes32 agreementId,
        uint8 serviceKind,
        address operator,
        address sponsor,
        uint64 acceptedAt,
        uint64 deliveryDeadline,
        bytes32 requirementsDigest,
        bytes32 deliveryDigest,
        bytes calldata evidence
    ) external returns (bool);
}
