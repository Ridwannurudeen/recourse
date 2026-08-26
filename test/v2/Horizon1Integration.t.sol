// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/write-ability/common/EvmV1Decoder.sol";
import {INativeQueryVerifier} from "@gluwa/usc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {PolicyKernelV1} from "../../contracts/v2/PolicyKernelV1.sol";
import {ProofJobsV1} from "../../contracts/v2/ProofJobsV1.sol";
import {RecourseFacilityFactoryV2} from "../../contracts/v2/RecourseFacilityFactoryV2.sol";
import {RecourseFacilityV2} from "../../contracts/v2/RecourseFacilityV2.sol";
import {VerifiedCreditStateV1} from "../../contracts/v2/VerifiedCreditStateV1.sol";
import {EventHistoryPolicyV1} from "../../contracts/v2/policies/EventHistoryPolicyV1.sol";
import {
    CreditObservation,
    EvidenceKind,
    ObservationKind,
    PolicyEffect,
    PolicyOutcome
} from "../../contracts/v2/types/RecourseTypesV2.sol";
import {MockVerifier} from "../mocks/MockVerifier.sol";

contract HorizonStablecoin is ERC20 {
    constructor() ERC20("Horizon USD", "HUSD") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }
}

contract Horizon1IntegrationTest is Test {
    uint256 private constant UNIT = 1e6;
    uint256 private constant POLICY_ID = 1;
    uint64 private constant CHAIN_KEY = 3;
    uint64 private constant SOURCE_BLOCK = 25_826_525;
    address private constant LENDER = address(0xA1);
    address private constant BORROWER = address(0xB2);
    address private constant HUNTER = address(0xC3);
    address private constant LIABILITY_EMITTER = address(0xA4A4);
    bytes32 private constant LIABILITY_EVENT = keccak256("LiabilityIncreased(address,uint256)");

    HorizonStablecoin private token;
    MockVerifier private verifier;
    PolicyKernelV1 private kernel;
    RecourseFacilityFactoryV2 private factory;
    RecourseFacilityV2 private facility;
    EventHistoryPolicyV1 private policy;
    ProofJobsV1 private jobs;

    function setUp() public {
        token = new HorizonStablecoin();
        verifier = new MockVerifier();
        kernel = new PolicyKernelV1(verifier);
        factory = new RecourseFacilityFactoryV2(address(this));
        facility = RecourseFacilityV2(
            factory.createFacility(
                token,
                address(kernel),
                LENDER,
                BORROWER,
                1_000 * UNIT,
                200 * UNIT,
                200,
                uint64(block.number + 100_000),
                10
            )
        );
        policy = new EventHistoryPolicyV1(kernel);
        jobs = new ProofJobsV1(kernel);
        kernel.setProofJobs(address(jobs));

        token.mint(LENDER, 2_000 * UNIT);
        token.mint(BORROWER, 500 * UNIT);
        token.mint(HUNTER, 10 * UNIT);
        vm.prank(LENDER);
        token.approve(address(facility), type(uint256).max);
        vm.prank(BORROWER);
        token.approve(address(facility), type(uint256).max);
        vm.prank(HUNTER);
        token.approve(address(jobs), type(uint256).max);
    }

    function test_factoryToPermissionlessProofToRestrictedCreditState() public {
        EventHistoryPolicyV1.Configuration memory configuration = _configuration();
        vm.prank(LENDER);
        policy.configure(address(facility), POLICY_ID, configuration);
        vm.prank(LENDER);
        kernel.registerPolicy(address(facility), POLICY_ID, policy);

        bytes memory manifestBytes = policy.manifest(address(facility), POLICY_ID);
        (, bytes32 storedConfigHash, bytes memory storedManifest) = kernel.policyOf(address(facility), POLICY_ID);
        assertEq(storedManifest, manifestBytes);
        assertEq(storedConfigHash, keccak256(manifestBytes));

        vm.prank(LENDER);
        facility.fundAsLender(1_000 * UNIT);
        vm.prank(BORROWER);
        facility.postBond(200 * UNIT);
        bytes32 policySetCommitment = kernel.policySetCommitment(address(facility));
        vm.prank(BORROWER);
        facility.activate(policySetCommitment);

        vm.prank(LENDER);
        token.approve(address(jobs), type(uint256).max);
        ProofJobsV1.JobParams memory params = ProofJobsV1.JobParams({
            token: token,
            facility: address(facility),
            policyId: POLICY_ID,
            requirementsDigest: storedConfigHash,
            expiry: uint64(block.timestamp + 1 days),
            revealWindowBlocks: 10,
            maxSuccessfulProofs: 1,
            proofReimbursement: 5 * UNIT,
            outcomeReward: 20 * UNIT,
            commitBond: 2 * UNIT,
            rewardOutcomeThreshold: 2
        });
        vm.prank(LENDER);
        uint256 jobId = jobs.createJob(params);

        bytes memory proof = _proof(_liabilityReceipt(75 * UNIT));
        bytes32 evidenceDigest = keccak256(proof);
        bytes32 salt = keccak256("hunter salt");
        bytes32 commitment = jobs.computeCommitment(jobId, HUNTER, evidenceDigest, salt);
        vm.prank(HUNTER);
        jobs.commitEvidence(jobId, commitment);
        vm.roll(block.number + 1);
        vm.prank(HUNTER);
        jobs.revealEvidence(jobId, evidenceDigest, salt, proof);

        assertEq(uint256(facility.policyOutcome()), uint256(PolicyOutcome.Restricted));
        assertEq(facility.availableCredit(), 500 * UNIT);
        assertEq(facility.futureDrawFeeBps(), 350);
        assertEq(jobs.claimable(address(token), HUNTER), 27 * UNIT);

        VerifiedCreditStateV1 creditState = kernel.creditState();
        assertEq(creditState.observationCount(address(facility), BORROWER), 1);
        (uint256 policyId, CreditObservation memory observation) =
            creditState.observationAt(address(facility), BORROWER, 0);
        assertEq(policyId, POLICY_ID);
        assertEq(observation.sourceChain, CHAIN_KEY);
        assertEq(observation.sourceBlock, SOURCE_BLOCK);
        assertEq(observation.subject, BORROWER);
        assertEq(observation.emitter, LIABILITY_EMITTER);
        assertEq(observation.observedValue, 75 * UNIT);
        assertTrue(creditState.isFresh(address(facility), BORROWER, ObservationKind.Liability));
    }

    function _configuration() private pure returns (EventHistoryPolicyV1.Configuration memory) {
        return EventHistoryPolicyV1.Configuration({
            sourceChain: CHAIN_KEY,
            emitter: LIABILITY_EMITTER,
            eventSignature: LIABILITY_EVENT,
            subject: BORROWER,
            startSourceBlock: SOURCE_BLOCK,
            endSourceBlock: SOURCE_BLOCK,
            topicCount: 2,
            subjectTopicIndex: 1,
            dataLength: 32,
            observedValueOffset: 0,
            observationKind: ObservationKind.Liability,
            evidenceKind: EvidenceKind.EventDelta,
            freshnessPeriod: 1 days,
            effect: PolicyEffect({
                outcome: PolicyOutcome.Restricted,
                creditLimitBps: 5_000,
                futureDrawFeeBps: 350,
                freezePendingDraw: true,
                requireFreshEvidence: false,
                terminate: false
            })
        });
    }

    function _proof(bytes memory encodedTransaction) private pure returns (bytes memory) {
        INativeQueryVerifier.MerkleProof memory merkleProof;
        INativeQueryVerifier.ContinuityProof memory continuityProof;
        return abi.encode(CHAIN_KEY, SOURCE_BLOCK, encodedTransaction, merkleProof, continuityProof);
    }

    function _liabilityReceipt(uint256 amount) private pure returns (bytes memory) {
        bytes32[] memory topics = new bytes32[](2);
        topics[0] = LIABILITY_EVENT;
        topics[1] = bytes32(uint256(uint160(BORROWER)));
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](1);
        logs[0] = EvmV1Decoder.LogEntryTuple({address_: LIABILITY_EMITTER, topics: topics, data: abi.encode(amount)});
        bytes[] memory chunks = new bytes[](3);
        chunks[2] = abi.encode(uint8(1), uint64(90_000), logs, bytes(""));
        return abi.encode(uint8(2), chunks);
    }
}
