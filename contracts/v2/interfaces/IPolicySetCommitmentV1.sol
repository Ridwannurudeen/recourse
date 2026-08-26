// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IPolicySetCommitmentV1 {
    function policySetCommitment(address facility) external view returns (bytes32);
}
