// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {PolicyResult, ProvenTransaction} from "../types/RecourseTypesV2.sol";

interface IPolicyEvaluatorV1 {
    function evaluate(address facility, uint256 policyId, ProvenTransaction[] calldata proven)
        external
        returns (PolicyResult memory result);

    function configHash(address facility, uint256 policyId) external view returns (bytes32);
    function manifest(address facility, uint256 policyId) external view returns (bytes memory);
    function policyKind() external pure returns (string memory);
}
