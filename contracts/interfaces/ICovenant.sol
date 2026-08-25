// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ProvenTx} from "../types/RecourseTypes.sol";

interface ICovenant {
    /// @notice Evaluate proven transactions against this covenant for a facility.
    /// @dev MUST revert with IrrelevantEvidence if no submitted tx is relevant, so that
    ///      irrelevant proofs are never consumed by replay protection.
    /// @return breached True when this evaluation crosses the covenant's breach condition.
    function evaluate(uint256 facilityId, ProvenTx[] calldata proven) external returns (bool breached);

    function configHash(uint256 facilityId) external view returns (bytes32);

    function covenantKind() external pure returns (string memory);
}

interface ICovenantRegistry {
    function isCovenantRegistered(uint256 facilityId, address covenant) external view returns (bool);
}
