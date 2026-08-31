// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IRemedyCoordinatorV1 {
    enum IntentStatus {
        None,
        Recorded,
        Published,
        Acknowledged,
        Cured,
        Expired,
        Failed
    }

    struct IntentRequest {
        address facility;
        uint256 policyId;
        bytes32 adverseEvidenceDigest;
        uint64 destinationChain;
        address receiver;
        address target;
        bytes32 actionKind;
        bytes32 actionDataHash;
        uint64 expiry;
    }

    function recordIntent(IntentRequest calldata request) external returns (bytes32 intentId);
    function recordReplacement(bytes32 predecessorIntentId, uint64 expiry) external returns (bytes32 intentId);
    function recordCure(bytes32 intentId, bytes32 cureEvidenceDigest) external;
    function intentStatus(bytes32 intentId) external view returns (IntentStatus);
    function intentExecutionId(bytes32 intentId) external view returns (bytes32);
    function intentActionDataHash(bytes32 intentId) external view returns (bytes32);
}
