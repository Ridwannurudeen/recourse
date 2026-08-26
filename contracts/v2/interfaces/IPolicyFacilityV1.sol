// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FacilityStatus, PolicyEffect} from "../types/RecourseTypesV2.sol";

interface IPolicyFacilityV1 {
    function lender() external view returns (address);
    function borrower() external view returns (address);
    function asset() external view returns (IERC20);
    function status() external view returns (FacilityStatus);
    function incidentPaused() external view returns (bool);
    function applyPolicyEffect(uint256 policyId, PolicyEffect calldata effect, uint64 evidenceExpiry) external;
}
