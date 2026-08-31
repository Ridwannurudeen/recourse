// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IRemedyTargetV1 {
    function executeRemedy(bytes32 executionId, bytes32 actionKind, bytes calldata actionData)
        external
        returns (bytes32 resultDigest);
}
