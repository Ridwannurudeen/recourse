// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/write-ability/common/EvmV1Decoder.sol";
import {INativeQueryVerifier} from "@gluwa/usc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {RecourseFacilityV2} from "../../contracts/v2/RecourseFacilityV2.sol";
import {ObservationKind, PolicyEffect, PolicyOutcome} from "../../contracts/v2/types/RecourseTypesV2.sol";
import {ClosedLoopPolicyV1} from "../../contracts/v3/ClosedLoopPolicyV1.sol";
import {PolicyKernelV2} from "../../contracts/v3/PolicyKernelV2.sol";
import {RemedyCoordinatorV1} from "../../contracts/v3/RemedyCoordinatorV1.sol";
import {IRemedyCoordinatorV1} from "../../contracts/v3/interfaces/IRemedyCoordinatorV1.sol";
import {IRemedyTransportV1} from "../../contracts/v3/interfaces/IRemedyTransportV1.sol";
import {MockVerifier} from "../mocks/MockVerifier.sol";

contract V3IntegrationToken is ERC20 {
    constructor() ERC20("Integration USD", "IUSD") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }
}

contract V3IntegrationTransport is IRemedyTransportV1 {
    bytes32 public constant MESSAGE_ID = keccak256("integration-message");
    bool public acknowledged;

    function setAcknowledged(bool value) external {
        acknowledged = value;
    }

    function publish(bytes32, uint64, address, bytes calldata, uint64) external pure returns (bytes32) {
        return MESSAGE_ID;
    }

    function isAcknowledged(bytes32 messageId) external view returns (bool) {
        return messageId == MESSAGE_ID && acknowledged;
    }
}

contract V3ClosedLoopIntegrationTest is Test {
    address private constant LENDER = address(0xA1);
    address private constant BORROWER = address(0xB2);
    address private constant ADVERSE_EMITTER = address(0xC3);
    address private constant CURE_EMITTER = address(0xD4);
    uint256 private constant POLICY_ID = 7;
    uint64 private constant CHAIN_KEY = 3;
    bytes32 private constant ADVERSE_SIG = keccak256("LiabilityIncreased(address,uint256)");
    bytes32 private constant CURE_SIG = keccak256("RemedyCompleted(address,bytes32,uint256,bytes32)");
    bytes32 private constant ACTION_KIND = keccak256("repay-v1");
    bytes private constant ACTION_DATA = abi.encode(address(0xE5), uint256(100));

    V3IntegrationToken private token;
    MockVerifier private verifier;
    PolicyKernelV2 private kernel;
    RecourseFacilityV2 private facility;
    V3IntegrationTransport private transport;
    RemedyCoordinatorV1 private coordinator;
    ClosedLoopPolicyV1 private policy;

    function setUp() public {
        token = new V3IntegrationToken();
        verifier = new MockVerifier();
        kernel = new PolicyKernelV2(verifier);
        facility = new RecourseFacilityV2(
            token, address(kernel), LENDER, BORROWER, 1_000, 200, 100, uint64(block.number + 10_000), 0
        );
        transport = new V3IntegrationTransport();
        coordinator = new RemedyCoordinatorV1(kernel, transport);
        policy = new ClosedLoopPolicyV1(kernel, coordinator);

        vm.prank(LENDER);
        policy.configure(address(facility), POLICY_ID, _configuration());
        vm.prank(LENDER);
        kernel.registerPolicy(address(facility), POLICY_ID, policy);
        vm.prank(LENDER);
        coordinator.authorizePolicy(address(facility), POLICY_ID, address(policy));

        token.mint(LENDER, 1_000);
        token.mint(BORROWER, 200);
        vm.prank(LENDER);
        token.approve(address(facility), type(uint256).max);
        vm.prank(BORROWER);
        token.approve(address(facility), type(uint256).max);
        vm.prank(LENDER);
        facility.fundAsLender(1_000);
        vm.prank(BORROWER);
        facility.postBond(200);
        bytes32 policySetCommitment = kernel.policySetCommitment(address(facility));
        vm.prank(BORROWER);
        facility.activate(policySetCommitment);
    }

    function test_verifiedAdverseTransportAcknowledgementAndVerifiedCureCloseTheFacilityLoop() public {
        _submit(100, _adverseReceipt(75));
        bytes32 intentId = policy.latestIntent(address(facility), POLICY_ID);
        assertEq(uint256(facility.policyOutcome()), uint256(PolicyOutcome.Restricted));
        assertEq(facility.creditLimitBps(), 5_000);
        assertEq(uint256(coordinator.intentStatus(intentId)), uint256(IRemedyCoordinatorV1.IntentStatus.Recorded));

        coordinator.publishIntent(intentId, ACTION_DATA);
        transport.setAcknowledged(true);
        coordinator.syncAcknowledgement(intentId);
        assertEq(uint256(facility.policyOutcome()), uint256(PolicyOutcome.Restricted));

        _submit(101, _cureReceipt(intentId, 100));
        assertEq(uint256(coordinator.intentStatus(intentId)), uint256(IRemedyCoordinatorV1.IntentStatus.Cured));
        assertEq(uint256(facility.policyOutcome()), uint256(PolicyOutcome.Cured));
        assertEq(facility.creditLimitBps(), 10_000);
    }

    function _submit(uint64 height, bytes memory transaction) private {
        INativeQueryVerifier.MerkleProof memory merkle;
        INativeQueryVerifier.ContinuityProof memory continuity;
        kernel.submitSingle(address(facility), POLICY_ID, CHAIN_KEY, height, transaction, merkle, continuity);
    }

    function _configuration() private pure returns (ClosedLoopPolicyV1.Configuration memory) {
        ClosedLoopPolicyV1.EventRule memory adverse = ClosedLoopPolicyV1.EventRule({
            sourceChain: CHAIN_KEY,
            emitter: ADVERSE_EMITTER,
            eventSignature: ADVERSE_SIG,
            subject: BORROWER,
            startSourceBlock: 100,
            endSourceBlock: 200,
            topicCount: 2,
            subjectTopicIndex: 1,
            dataLength: 32,
            observedValueOffset: 0
        });
        ClosedLoopPolicyV1.EventRule memory cure = ClosedLoopPolicyV1.EventRule({
            sourceChain: CHAIN_KEY,
            emitter: CURE_EMITTER,
            eventSignature: CURE_SIG,
            subject: BORROWER,
            startSourceBlock: 100,
            endSourceBlock: 200,
            topicCount: 3,
            subjectTopicIndex: 1,
            dataLength: 64,
            observedValueOffset: 0
        });
        return ClosedLoopPolicyV1.Configuration({
            adverseRule: adverse,
            cureRule: ClosedLoopPolicyV1.CureRule({eventRule: cure, intentTopicIndex: 2, actionDigestOffset: 32}),
            observationKind: ObservationKind.Liability,
            freshnessPeriod: 1 days,
            remedyDuration: 2 days,
            destinationChain: 102031,
            receiver: address(0xF6),
            target: address(0xA7),
            actionKind: ACTION_KIND,
            actionDataHash: keccak256(ACTION_DATA),
            adverseEffect: PolicyEffect({
                outcome: PolicyOutcome.Restricted,
                creditLimitBps: 5_000,
                futureDrawFeeBps: 300,
                freezePendingDraw: true,
                requireFreshEvidence: false,
                terminate: false
            }),
            cureEffect: PolicyEffect({
                outcome: PolicyOutcome.Cured,
                creditLimitBps: 10_000,
                futureDrawFeeBps: 100,
                freezePendingDraw: false,
                requireFreshEvidence: false,
                terminate: false
            })
        });
    }

    function _adverseReceipt(uint256 value) private pure returns (bytes memory) {
        bytes32[] memory topics = new bytes32[](2);
        topics[0] = ADVERSE_SIG;
        topics[1] = bytes32(uint256(uint160(BORROWER)));
        return _receipt(ADVERSE_EMITTER, topics, abi.encode(value));
    }

    function _cureReceipt(bytes32 intentId, uint256 value) private pure returns (bytes memory) {
        bytes32[] memory topics = new bytes32[](3);
        topics[0] = CURE_SIG;
        topics[1] = bytes32(uint256(uint160(BORROWER)));
        topics[2] = intentId;
        return _receipt(CURE_EMITTER, topics, abi.encode(value, keccak256(ACTION_DATA)));
    }

    function _receipt(address emitter, bytes32[] memory topics, bytes memory data) private pure returns (bytes memory) {
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](1);
        logs[0] = EvmV1Decoder.LogEntryTuple({address_: emitter, topics: topics, data: data});
        bytes[] memory chunks = new bytes[](3);
        chunks[2] = abi.encode(uint8(1), uint64(1), logs, bytes(""));
        return abi.encode(uint8(2), chunks);
    }
}
