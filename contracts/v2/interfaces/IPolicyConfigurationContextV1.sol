// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IPolicyConfigurationContextV1 {
    function lenderOf(address facility) external view returns (address);

    function isPolicyRegistered(address facility, uint256 policyId) external view returns (bool);
}
