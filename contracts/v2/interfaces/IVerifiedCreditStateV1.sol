// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CreditObservation, ObservationKind} from "../types/RecourseTypesV2.sol";

interface IVerifiedCreditStateV1 {
    event ObservationRecorded(
        address indexed facility,
        address indexed borrower,
        uint256 indexed observationId,
        uint256 policyId,
        ObservationKind kind,
        bytes32 evidenceDigest
    );

    function kernel() external view returns (address);

    function recordObservation(address facility, uint256 policyId, CreditObservation calldata observation)
        external
        returns (uint256 observationId);

    function observationCount(address facility, address borrower) external view returns (uint256);

    function observationAt(address facility, address borrower, uint256 observationId)
        external
        view
        returns (uint256 policyId, CreditObservation memory observation);

    function latestObservation(address facility, address borrower, ObservationKind kind)
        external
        view
        returns (bool exists, uint256 policyId, CreditObservation memory observation);

    function isFresh(address facility, address borrower, ObservationKind kind) external view returns (bool);
}
