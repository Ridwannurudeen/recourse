// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IOperatorServiceVerifierV1 {
    /// @notice Verifies evidence for one accepted operator service agreement.
    /// @dev Implementations MUST bind `agreementId` to the evidence so the same evidence cannot verify a distinct
    ///      agreement, and MUST return false rather than revert when evidence is malformed or cannot be verified.
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
