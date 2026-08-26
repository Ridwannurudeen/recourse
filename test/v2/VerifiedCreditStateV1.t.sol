// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {VerifiedCreditStateV1} from "../../contracts/v2/VerifiedCreditStateV1.sol";
import {IVerifiedCreditStateV1} from "../../contracts/v2/interfaces/IVerifiedCreditStateV1.sol";
import {
    CreditObservation,
    EvidenceKind,
    ObservationKind,
    PolicyEffect,
    PolicyOutcome
} from "../../contracts/v2/types/RecourseTypesV2.sol";

contract VerifiedCreditStateV1Test is Test {
    address private constant FACILITY = address(0xFACA);
    address private constant BORROWER = address(0xB0B);
    address private constant EMITTER = address(0xA4A4);
    address private constant OUTSIDER = address(0xBAD);
    uint256 private constant POLICY_ID = 7;

    VerifiedCreditStateV1 private creditState;

    function setUp() public {
        creditState = new VerifiedCreditStateV1(address(this));
        vm.warp(1_000);
    }

    function test_constructorRejectsZeroKernel() public {
        vm.expectRevert(VerifiedCreditStateV1.ZeroKernel.selector);
        new VerifiedCreditStateV1(address(0));
    }

    function test_onlyKernelCanRecord() public {
        vm.expectRevert(VerifiedCreditStateV1.NotKernel.selector);
        vm.prank(OUTSIDER);
        creditState.recordObservation(FACILITY, POLICY_ID, _observation(ObservationKind.Liability, 1_000, 1_100, 50));
    }

    function test_recordsOrderedObservationsWithExactPublicGetters() public {
        CreditObservation memory first = _observation(ObservationKind.Liability, 1_000, 1_100, 50);
        CreditObservation memory second = _observation(ObservationKind.Behaviour, 1_001, 1_201, 75);

        vm.expectEmit(true, true, true, true, address(creditState));
        emit IVerifiedCreditStateV1.ObservationRecorded(
            FACILITY, BORROWER, 0, POLICY_ID, ObservationKind.Liability, first.evidenceDigest
        );
        uint256 firstId = creditState.recordObservation(FACILITY, POLICY_ID, first);
        uint256 secondId = creditState.recordObservation(FACILITY, POLICY_ID + 1, second);

        assertEq(firstId, 0);
        assertEq(secondId, 1);
        assertEq(creditState.observationCount(FACILITY, BORROWER), 2);

        (uint256 firstPolicyId, CreditObservation memory storedFirst) =
            creditState.observationAt(FACILITY, BORROWER, firstId);
        (uint256 secondPolicyId, CreditObservation memory storedSecond) =
            creditState.observationAt(FACILITY, BORROWER, secondId);
        assertEq(firstPolicyId, POLICY_ID);
        assertEq(secondPolicyId, POLICY_ID + 1);
        _assertObservationEq(storedFirst, first);
        _assertObservationEq(storedSecond, second);
    }

    function test_latestObservationIsIndexedPerFacilityBorrowerAndKind() public {
        CreditObservation memory oldLiability = _observation(ObservationKind.Liability, 1_000, 1_050, 50);
        CreditObservation memory behaviour = _observation(ObservationKind.Behaviour, 1_001, 1_200, 75);
        CreditObservation memory newLiability = _observation(ObservationKind.Liability, 1_002, 1_300, 125);

        creditState.recordObservation(FACILITY, POLICY_ID, oldLiability);
        creditState.recordObservation(FACILITY, POLICY_ID + 1, behaviour);
        creditState.recordObservation(FACILITY, POLICY_ID + 2, newLiability);

        (bool exists, uint256 policyId, CreditObservation memory latest) =
            creditState.latestObservation(FACILITY, BORROWER, ObservationKind.Liability);
        assertTrue(exists);
        assertEq(policyId, POLICY_ID + 2);
        _assertObservationEq(latest, newLiability);

        (bool otherBorrowerExists,,) =
            creditState.latestObservation(FACILITY, address(0xCAFE), ObservationKind.Liability);
        (bool otherFacilityExists,,) =
            creditState.latestObservation(address(0xDEAD), BORROWER, ObservationKind.Liability);
        (bool absentKindExists,,) = creditState.latestObservation(FACILITY, BORROWER, ObservationKind.Collateral);
        assertFalse(otherBorrowerExists);
        assertFalse(otherFacilityExists);
        assertFalse(absentKindExists);
    }

    function test_freshnessExpiresAtTheCc3ExpiryBoundary() public {
        creditState.recordObservation(FACILITY, POLICY_ID, _observation(ObservationKind.Ownership, 1_000, 1_100, 1));

        vm.warp(1_099);
        assertTrue(creditState.isFresh(FACILITY, BORROWER, ObservationKind.Ownership));
        vm.warp(1_100);
        assertFalse(creditState.isFresh(FACILITY, BORROWER, ObservationKind.Ownership));
    }

    function test_newObservationRefreshesAnExpiredKind() public {
        creditState.recordObservation(FACILITY, POLICY_ID, _observation(ObservationKind.Position, 900, 1_000, 10));
        assertFalse(creditState.isFresh(FACILITY, BORROWER, ObservationKind.Position));

        creditState.recordObservation(FACILITY, POLICY_ID + 1, _observation(ObservationKind.Position, 1_000, 1_200, 20));
        assertTrue(creditState.isFresh(FACILITY, BORROWER, ObservationKind.Position));
    }

    function test_rejectsInvalidObservationIdentityAndFreshness() public {
        CreditObservation memory observation = _observation(ObservationKind.Collateral, 1_000, 1_100, 50);

        vm.expectRevert(VerifiedCreditStateV1.ZeroFacility.selector);
        creditState.recordObservation(address(0), POLICY_ID, observation);

        observation.subject = address(0);
        vm.expectRevert(VerifiedCreditStateV1.ZeroSubject.selector);
        creditState.recordObservation(FACILITY, POLICY_ID, observation);

        observation = _observation(ObservationKind.Collateral, 1_001, 1_000, 50);
        vm.expectRevert(VerifiedCreditStateV1.InvalidExpiry.selector);
        creditState.recordObservation(FACILITY, POLICY_ID, observation);
    }

    function _observation(ObservationKind kind, uint64 proofTime, uint64 expiry, uint256 observedValue)
        private
        pure
        returns (CreditObservation memory)
    {
        PolicyEffect memory effect = PolicyEffect({
            outcome: PolicyOutcome.Watch,
            creditLimitBps: 9_000,
            futureDrawFeeBps: 100,
            freezePendingDraw: false,
            requireFreshEvidence: true,
            terminate: false
        });
        return CreditObservation({
            kind: kind,
            evidenceKind: EvidenceKind.EventDelta,
            sourceChain: 3,
            sourceBlock: 25_826_525 + uint64(observedValue),
            transactionIndex: 2,
            subject: BORROWER,
            emitter: EMITTER,
            observedValue: observedValue,
            proofTime: proofTime,
            expiry: expiry,
            evidenceDigest: keccak256(abi.encode(kind, observedValue)),
            policyEffectHash: keccak256(abi.encode(effect))
        });
    }

    function _assertObservationEq(CreditObservation memory actual, CreditObservation memory expected) private pure {
        assertEq(keccak256(abi.encode(actual)), keccak256(abi.encode(expected)));
    }
}
