// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {
    CreditObservation,
    EvidenceKind,
    ObservationKind,
    PolicyEffect,
    PolicyOutcome
} from "../../contracts/v2/types/RecourseTypesV2.sol";

contract RecourseTypesV2Test is Test {
    function test_policyEffectAndObservationRoundTrip() public pure {
        PolicyEffect memory effect = PolicyEffect({
            outcome: PolicyOutcome.Restricted,
            creditLimitBps: 4_000,
            futureDrawFeeBps: 350,
            freezePendingDraw: true,
            requireFreshEvidence: true,
            terminate: false
        });
        CreditObservation memory observation = CreditObservation({
            kind: ObservationKind.Liability,
            evidenceKind: EvidenceKind.EventDelta,
            sourceChain: 3,
            sourceBlock: 25_826_525,
            transactionIndex: 7,
            subject: address(0xB0B),
            emitter: address(0xA4A4),
            observedValue: 50_000_000,
            proofTime: 100,
            expiry: 200,
            evidenceDigest: keccak256("evidence"),
            policyEffectHash: keccak256(abi.encode(effect))
        });

        bytes memory encoded = abi.encode(effect, observation);
        (PolicyEffect memory decodedEffect, CreditObservation memory decodedObservation) =
            abi.decode(encoded, (PolicyEffect, CreditObservation));

        assertEq(uint256(decodedEffect.outcome), uint256(PolicyOutcome.Restricted));
        assertEq(decodedEffect.creditLimitBps, 4_000);
        assertEq(uint256(decodedObservation.kind), uint256(ObservationKind.Liability));
        assertEq(uint256(decodedObservation.evidenceKind), uint256(EvidenceKind.EventDelta));
        assertEq(decodedObservation.sourceBlock, 25_826_525);
        assertEq(decodedObservation.transactionIndex, 7);
        assertEq(decodedObservation.emitter, address(0xA4A4));
        assertEq(decodedObservation.observedValue, 50_000_000);
        assertEq(decodedObservation.expiry, 200);
        assertEq(decodedObservation.policyEffectHash, keccak256(abi.encode(effect)));
    }
}
