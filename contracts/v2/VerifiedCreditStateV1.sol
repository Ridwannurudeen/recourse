// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IVerifiedCreditStateV1} from "./interfaces/IVerifiedCreditStateV1.sol";
import {CreditObservation, ObservationKind} from "./types/RecourseTypesV2.sol";

contract VerifiedCreditStateV1 is IVerifiedCreditStateV1 {
    error InvalidExpiry();
    error NotKernel();
    error ZeroFacility();
    error ZeroKernel();
    error ZeroSubject();

    struct StoredObservation {
        uint256 policyId;
        CreditObservation observation;
    }

    address public immutable override kernel;

    mapping(address facility => mapping(address borrower => StoredObservation[] observations)) private observations;
    mapping(
        address facility
            => mapping(address borrower => mapping(ObservationKind kind => uint256 observationIndexPlusOne))
    ) private latestObservationIndex;

    constructor(address kernel_) {
        if (kernel_ == address(0)) revert ZeroKernel();
        kernel = kernel_;
    }

    function recordObservation(address facility, uint256 policyId, CreditObservation calldata observation)
        external
        returns (uint256 observationId)
    {
        if (msg.sender != kernel) revert NotKernel();
        if (facility == address(0)) revert ZeroFacility();
        if (observation.subject == address(0)) revert ZeroSubject();
        if (observation.expiry <= observation.proofTime) revert InvalidExpiry();

        StoredObservation[] storage borrowerObservations = observations[facility][observation.subject];
        observationId = borrowerObservations.length;
        borrowerObservations.push(StoredObservation({policyId: policyId, observation: observation}));
        latestObservationIndex[facility][observation.subject][observation.kind] = observationId + 1;

        emit ObservationRecorded(
            facility, observation.subject, observationId, policyId, observation.kind, observation.evidenceDigest
        );
    }

    function observationCount(address facility, address borrower) external view returns (uint256) {
        return observations[facility][borrower].length;
    }

    function observationAt(address facility, address borrower, uint256 observationId)
        external
        view
        returns (uint256 policyId, CreditObservation memory observation)
    {
        StoredObservation storage stored = observations[facility][borrower][observationId];
        return (stored.policyId, stored.observation);
    }

    function latestObservation(address facility, address borrower, ObservationKind kind)
        external
        view
        returns (bool exists, uint256 policyId, CreditObservation memory observation)
    {
        uint256 observationIndexPlusOne = latestObservationIndex[facility][borrower][kind];
        if (observationIndexPlusOne == 0) return (false, 0, observation);

        StoredObservation storage stored = observations[facility][borrower][observationIndexPlusOne - 1];
        return (true, stored.policyId, stored.observation);
    }

    function isFresh(address facility, address borrower, ObservationKind kind) external view returns (bool) {
        uint256 observationIndexPlusOne = latestObservationIndex[facility][borrower][kind];
        if (observationIndexPlusOne == 0) return false;
        return block.timestamp < observations[facility][borrower][observationIndexPlusOne - 1].observation.expiry;
    }
}
