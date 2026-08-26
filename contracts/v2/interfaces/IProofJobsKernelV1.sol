// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IProofJobsKernelV1 {
    function incidentPaused(address facility) external view returns (bool);

    function canPublishJob(
        address facility,
        address sponsor,
        address token,
        uint256 policyId,
        bytes32 requirementsDigest
    ) external view returns (bool);

    function evaluateProofJob(
        address facility,
        uint256 policyId,
        bytes32 requirementsDigest,
        bytes calldata proof,
        address hunter
    ) external returns (bool accepted, uint8 outcomeLevel);
}
