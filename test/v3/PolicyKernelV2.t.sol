// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/write-ability/common/EvmV1Decoder.sol";
import {INativeQueryVerifier} from "@gluwa/usc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ProofJobsV1} from "../../contracts/v2/ProofJobsV1.sol";
import {IPolicyEvaluatorV1} from "../../contracts/v2/interfaces/IPolicyEvaluatorV1.sol";
import {IPolicyFacilityV1} from "../../contracts/v2/interfaces/IPolicyFacilityV1.sol";
import {
    EvidenceKind,
    FacilityStatus,
    ObservationKind,
    PolicyEffect,
    PolicyOutcome,
    PolicyResult,
    ProvenTransaction
} from "../../contracts/v2/types/RecourseTypesV2.sol";
import {PolicyKernelV2} from "../../contracts/v3/PolicyKernelV2.sol";
import {MockVerifier} from "../mocks/MockVerifier.sol";

contract KernelV2FacilityMock is IPolicyFacilityV1 {
    address public immutable lender;
    address public immutable borrower;
    IERC20 public asset = IERC20(address(0x99));
    FacilityStatus public status;
    bool public incidentPaused;
    uint256 public applyCalls;

    constructor(address lender_, address borrower_) {
        lender = lender_;
        borrower = borrower_;
    }

    function setStatus(FacilityStatus value) external {
        status = value;
    }

    function setAsset(IERC20 value) external {
        asset = value;
    }

    function applyPolicyEffect(uint256, PolicyEffect calldata, uint64) external {
        ++applyCalls;
    }
}

contract KernelV2Token is ERC20 {
    constructor() ERC20("Kernel V2 USD", "KV2") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }
}

contract KernelV2EvaluatorMock is IPolicyEvaluatorV1 {
    address public immutable subject;

    constructor(address subject_) {
        subject = subject_;
    }

    function evaluate(address, uint256, ProvenTransaction[] calldata proven)
        external
        view
        returns (PolicyResult memory)
    {
        ProvenTransaction calldata source = proven[proven.length - 1];
        return PolicyResult({
            effect: PolicyEffect({
                outcome: PolicyOutcome.Watch,
                creditLimitBps: 9_000,
                futureDrawFeeBps: 100,
                freezePendingDraw: false,
                requireFreshEvidence: false,
                terminate: false
            }),
            observationKind: ObservationKind.Behaviour,
            evidenceKind: EvidenceKind.EventDelta,
            sourceBlock: source.blockHeight,
            transactionIndex: source.txIndex,
            subject: subject,
            emitter: address(0x88),
            observedValue: 1,
            freshnessPeriod: 1 days
        });
    }

    function configHash(address, uint256) external pure returns (bytes32) {
        return keccak256("v2-manifest");
    }

    function manifest(address, uint256) external pure returns (bytes memory) {
        return bytes("v2-manifest");
    }

    function policyKind() external pure returns (string memory) {
        return "kernel-v2-test";
    }
}

contract PolicyKernelV2Test is Test {
    address private constant LENDER = address(0xA1);
    address private constant BORROWER = address(0xB2);
    uint256 private constant POLICY_ID = 7;
    uint64 private constant CHAIN_A = 3;
    uint64 private constant CHAIN_B = 102031;

    MockVerifier private verifier;
    PolicyKernelV2 private kernel;
    KernelV2FacilityMock private facility;
    KernelV2EvaluatorMock private evaluator;

    function setUp() public {
        verifier = new MockVerifier();
        kernel = new PolicyKernelV2(verifier);
        facility = new KernelV2FacilityMock(LENDER, BORROWER);
        evaluator = new KernelV2EvaluatorMock(BORROWER);
        vm.prank(LENDER);
        kernel.registerPolicy(address(facility), POLICY_ID, evaluator);
        facility.setStatus(FacilityStatus.Active);
    }

    function test_lowerSourcePositionOnDifferentChainIsAcceptedAndTrackedIndependently() public {
        _submit(CHAIN_A, 200);
        _submit(CHAIN_B, 100);

        (bool aRecorded, uint64 aHeight, uint64 aIndex) =
            kernel.latestSourcePosition(address(facility), POLICY_ID, CHAIN_A);
        (bool bRecorded, uint64 bHeight, uint64 bIndex) =
            kernel.latestSourcePosition(address(facility), POLICY_ID, CHAIN_B);
        assertTrue(aRecorded);
        assertTrue(bRecorded);
        assertEq(aHeight, 200);
        assertEq(bHeight, 100);
        assertEq(aIndex, 0);
        assertEq(bIndex, 0);
        assertEq(facility.applyCalls(), 2);
    }

    function test_stalePositionStillRevertsWithinSameChainWithoutConsumption() public {
        _submit(CHAIN_A, 200);
        bytes32 olderQuery = kernel.queryId(CHAIN_A, 199, 0);
        vm.expectRevert(PolicyKernelV2.StaleSourcePosition.selector);
        _submit(CHAIN_A, 199);
        assertFalse(kernel.isProcessed(address(facility), POLICY_ID, olderQuery));
    }

    function test_queryReplayIdentityIncludesChainKey() public {
        _submit(CHAIN_A, 200);
        _submit(CHAIN_B, 200);
        assertTrue(kernel.isProcessed(address(facility), POLICY_ID, kernel.queryId(CHAIN_A, 200, 0)));
        assertTrue(kernel.isProcessed(address(facility), POLICY_ID, kernel.queryId(CHAIN_B, 200, 0)));
        assertNotEq(kernel.queryId(CHAIN_A, 200, 0), kernel.queryId(CHAIN_B, 200, 0));
    }

    function test_batchUsesChainScopedOrdering() public {
        _submit(CHAIN_A, 300);
        uint64[] memory heights = new uint64[](2);
        heights[0] = 100;
        heights[1] = 101;
        bytes[] memory encoded = new bytes[](2);
        encoded[0] = _transaction();
        encoded[1] = _transaction();
        INativeQueryVerifier.MerkleProof[] memory proofs = new INativeQueryVerifier.MerkleProof[](2);
        bytes32 secondRoot = keccak256("second-root");
        proofs[1].root = secondRoot;
        verifier.setTxIndexForRoot(secondRoot, 1);
        INativeQueryVerifier.ContinuityProof memory continuity;

        kernel.submitBatch(address(facility), POLICY_ID, CHAIN_B, heights, encoded, proofs, continuity);
        (bool recorded, uint64 height, uint64 index) =
            kernel.latestSourcePosition(address(facility), POLICY_ID, CHAIN_B);
        assertTrue(recorded);
        assertEq(height, 101);
        assertEq(index, 1);
    }

    function test_batchRejectsDescendingSourcePositionsWithoutConsumption() public {
        uint64[] memory heights = new uint64[](2);
        heights[0] = 200;
        heights[1] = 100;
        bytes[] memory encoded = new bytes[](2);
        encoded[0] = _transaction();
        encoded[1] = _transaction();
        INativeQueryVerifier.MerkleProof[] memory proofs = new INativeQueryVerifier.MerkleProof[](2);
        bytes32 firstRoot = keccak256("first-root");
        proofs[0].root = firstRoot;
        verifier.setTxIndexForRoot(firstRoot, 1);
        INativeQueryVerifier.ContinuityProof memory continuity;

        vm.expectRevert(PolicyKernelV2.StaleSourcePosition.selector);
        kernel.submitBatch(address(facility), POLICY_ID, CHAIN_A, heights, encoded, proofs, continuity);

        assertFalse(kernel.isProcessed(address(facility), POLICY_ID, kernel.queryId(CHAIN_A, 200, 1)));
        assertFalse(kernel.isProcessed(address(facility), POLICY_ID, kernel.queryId(CHAIN_A, 100, 0)));
    }

    function test_proofJobReleasesBondWhenCommittedEvidenceBecomesStale() public {
        address olderHunter = address(0xC3);
        address newerHunter = address(0xD4);
        KernelV2Token token = new KernelV2Token();
        facility.setAsset(token);
        ProofJobsV1 jobs = new ProofJobsV1(kernel);
        kernel.setProofJobs(address(jobs));
        assertTrue(kernel.safeStaleProofRelease());

        token.mint(LENDER, 100);
        token.mint(olderHunter, 10);
        token.mint(newerHunter, 10);
        vm.prank(LENDER);
        token.approve(address(jobs), type(uint256).max);
        vm.prank(olderHunter);
        token.approve(address(jobs), type(uint256).max);
        vm.prank(newerHunter);
        token.approve(address(jobs), type(uint256).max);

        bytes32 requirements = evaluator.configHash(address(facility), POLICY_ID);
        ProofJobsV1.JobParams memory params = ProofJobsV1.JobParams({
            token: token,
            facility: address(facility),
            policyId: POLICY_ID,
            requirementsDigest: requirements,
            expiry: uint64(block.timestamp + 1 days),
            revealWindowBlocks: 10,
            maxSuccessfulProofs: 2,
            proofReimbursement: 5,
            outcomeReward: 10,
            commitBond: 2,
            rewardOutcomeThreshold: 4
        });
        vm.prank(LENDER);
        uint256 jobId = jobs.createJob(params);

        bytes memory olderProof = _encodedProof(CHAIN_A, 100);
        bytes memory newerProof = _encodedProof(CHAIN_A, 200);
        bytes32 olderDigest = keccak256(olderProof);
        bytes32 newerDigest = keccak256(newerProof);
        bytes32 olderSalt = keccak256("older");
        bytes32 newerSalt = keccak256("newer");
        bytes32 olderCommitment = jobs.computeCommitment(jobId, olderHunter, olderDigest, olderSalt);
        bytes32 newerCommitment = jobs.computeCommitment(jobId, newerHunter, newerDigest, newerSalt);
        vm.prank(olderHunter);
        jobs.commitEvidence(jobId, olderDigest, olderCommitment);
        vm.prank(newerHunter);
        jobs.commitEvidence(jobId, newerDigest, newerCommitment);
        vm.roll(block.number + 1);

        vm.prank(newerHunter);
        jobs.revealEvidence(jobId, newerDigest, newerSalt, newerProof);
        vm.prank(olderHunter);
        jobs.revealEvidence(jobId, olderDigest, olderSalt, olderProof);

        assertEq(jobs.claimable(address(token), newerHunter), 7);
        assertEq(jobs.claimable(address(token), olderHunter), 2);
        assertEq(jobs.getJob(jobId).successfulProofs, 1);
        assertEq(facility.applyCalls(), 1);
        assertEq(kernel.creditState().observationCount(address(facility), BORROWER), 1);
        assertFalse(kernel.isProcessed(address(facility), POLICY_ID, kernel.queryId(CHAIN_A, 100, 0)));
        assertEq(jobs.getCommitment(jobId, olderHunter).bond, 0);
    }

    function _submit(uint64 chainKey, uint64 height) private {
        INativeQueryVerifier.MerkleProof memory merkle;
        INativeQueryVerifier.ContinuityProof memory continuity;
        kernel.submitSingle(address(facility), POLICY_ID, chainKey, height, _transaction(), merkle, continuity);
    }

    function _transaction() private pure returns (bytes memory) {
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](0);
        bytes[] memory chunks = new bytes[](3);
        chunks[2] = abi.encode(uint8(1), uint64(1), logs, bytes(""));
        return abi.encode(uint8(2), chunks);
    }

    function _encodedProof(uint64 chainKey, uint64 height) private pure returns (bytes memory) {
        INativeQueryVerifier.MerkleProof memory merkle;
        INativeQueryVerifier.ContinuityProof memory continuity;
        return abi.encode(chainKey, height, _transaction(), merkle, continuity);
    }
}
