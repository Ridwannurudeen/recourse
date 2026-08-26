// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {FacilityStatus, PolicyEffect} from "../types/RecourseTypesV2.sol";

interface IPolicyFacilityV1 {
    function lender() external view returns (address);
    function borrower() external view returns (address);
    function status() external view returns (FacilityStatus);
    function incidentPaused() external view returns (bool);
    function applyPolicyEffect(PolicyEffect calldata effect, uint64 evidenceExpiry) external;
}
