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
import {MultiChainEventPolicyV1} from "../../contracts/v3/MultiChainEventPolicyV1.sol";
import {PolicyKernelV2} from "../../contracts/v3/PolicyKernelV2.sol";
import {MockVerifier} from "../mocks/MockVerifier.sol";

contract KernelV2FacilityMock is IPolicyFacilityV1 {
    address public immutable lender;
    address public immutable borrower;
    IERC20 public asset = IERC20(address(0x99));
    FacilityStatus public status;
    bool public incidentPaused;
    uint256 public applyCalls;
    PolicyOutcome public lastOutcome;

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

    function applyPolicyEffect(uint256, PolicyEffect calldata effect, uint64) external {
        ++applyCalls;
        lastOutcome = effect.outcome;
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
        assertEq(uint256(kernel.sourceOrderingOf(address(facility), POLICY_ID)), 0);
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

    function test_laterWeakMultiChainEvidenceCannotCensorEarlierSevereEvidence() public {
        KernelV2FacilityMock multiFacility = new KernelV2FacilityMock(LENDER, BORROWER);
        MultiChainEventPolicyV1 multiPolicy = new MultiChainEventPolicyV1(kernel);
        MultiChainEventPolicyV1.Rule[] memory rules = new MultiChainEventPolicyV1.Rule[](2);
        rules[0] = _multiChainRule(address(0xA11CE), 1);
        rules[1] = _multiChainRule(address(0xBEEF), 4);
        MultiChainEventPolicyV1.Configuration memory configuration = MultiChainEventPolicyV1.Configuration({
            subject: BORROWER,
            freshnessPeriod: 1 days,
            watchThreshold: 1,
            restrictedThreshold: 2,
            marginThreshold: 3,
            breachThreshold: 4,
            watchEffect: _effect(PolicyOutcome.Watch, 9_000, false),
            restrictedEffect: _effect(PolicyOutcome.Restricted, 7_000, false),
            marginEffect: _effect(PolicyOutcome.MarginCalled, 4_000, false),
            breachEffect: _effect(PolicyOutcome.Breached, 0, true),
            rules: rules
        });
        vm.startPrank(LENDER);
        multiPolicy.configure(address(multiFacility), POLICY_ID, configuration);
        kernel.registerPolicy(address(multiFacility), POLICY_ID, multiPolicy);
        vm.stopPrank();
        multiFacility.setStatus(FacilityStatus.Active);

        INativeQueryVerifier.MerkleProof memory laterProof;
        laterProof.root = keccak256("later-weak");
        verifier.setTxIndexForRoot(laterProof.root, 2);
        INativeQueryVerifier.MerkleProof memory earlierProof;
        earlierProof.root = keccak256("earlier-severe");
        verifier.setTxIndexForRoot(earlierProof.root, 1);
        INativeQueryVerifier.ContinuityProof memory continuity;

        kernel.submitSingle(
            address(multiFacility), POLICY_ID, CHAIN_A, 100, _eventTransaction(address(0xA11CE)), laterProof, continuity
        );
        kernel.submitSingle(
            address(multiFacility),
            POLICY_ID,
            CHAIN_A,
            100,
            _eventTransaction(address(0xBEEF)),
            earlierProof,
            continuity
        );

        assertTrue(kernel.isProcessed(address(multiFacility), POLICY_ID, kernel.queryId(CHAIN_A, 100, 2)));
        assertTrue(kernel.isProcessed(address(multiFacility), POLICY_ID, kernel.queryId(CHAIN_A, 100, 1)));
        assertEq(multiPolicy.riskScore(address(multiFacility), POLICY_ID), 5);
        assertEq(uint256(kernel.sourceOrderingOf(address(multiFacility), POLICY_ID)), 1);
        assertEq(uint256(multiFacility.lastOutcome()), uint256(PolicyOutcome.Breached));
        (bool recorded, uint64 height, uint64 index) =
            kernel.latestSourcePosition(address(multiFacility), POLICY_ID, CHAIN_A);
        assertTrue(recorded);
        assertEq(height, 100);
        assertEq(index, 2);

        uint64[] memory batchHeights = new uint64[](1);
        batchHeights[0] = 101;
        bytes[] memory batchTransactions = new bytes[](1);
        batchTransactions[0] = _eventTransaction(address(0xA11CE));
        INativeQueryVerifier.MerkleProof[] memory batchProofs = new INativeQueryVerifier.MerkleProof[](1);
        vm.expectRevert(PolicyKernelV2.InvalidBatch.selector);
        kernel.submitBatch(
            address(multiFacility), POLICY_ID, CHAIN_A, batchHeights, batchTransactions, batchProofs, continuity
        );

        vm.expectRevert(
            abi.encodeWithSelector(PolicyKernelV2.ProofAlreadyUsed.selector, kernel.queryId(CHAIN_A, 100, 1))
        );
        kernel.submitSingle(
            address(multiFacility),
            POLICY_ID,
            CHAIN_A,
            100,
            _eventTransaction(address(0xBEEF)),
            earlierProof,
            continuity
        );
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

    function _eventTransaction(address emitter) private pure returns (bytes memory) {
        bytes32[] memory topics = new bytes32[](2);
        topics[0] = keccak256("RiskIncreased(address,uint256)");
        topics[1] = bytes32(uint256(uint160(BORROWER)));
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](1);
        logs[0] = EvmV1Decoder.LogEntryTuple({address_: emitter, topics: topics, data: abi.encode(uint256(1))});
        bytes[] memory chunks = new bytes[](3);
        chunks[2] = abi.encode(uint8(1), uint64(1), logs, bytes(""));
        return abi.encode(uint8(2), chunks);
    }

    function _multiChainRule(address emitter, uint32 weight)
        private
        pure
        returns (MultiChainEventPolicyV1.Rule memory)
    {
        return MultiChainEventPolicyV1.Rule({
            sourceChain: CHAIN_A,
            emitter: emitter,
            eventSignature: keccak256("RiskIncreased(address,uint256)"),
            startSourceBlock: 1,
            endSourceBlock: type(uint64).max,
            topicCount: 2,
            subjectTopicIndex: 1,
            dataLength: 32,
            observedValueOffset: 0,
            observationKind: ObservationKind.Behaviour,
            riskWeight: weight
        });
    }

    function _effect(PolicyOutcome outcome, uint16 creditLimitBps, bool terminate)
        private
        pure
        returns (PolicyEffect memory)
    {
        return PolicyEffect({
            outcome: outcome,
            creditLimitBps: creditLimitBps,
            futureDrawFeeBps: 0,
            freezePendingDraw: terminate,
            requireFreshEvidence: terminate,
            terminate: terminate
        });
    }

    function _encodedProof(uint64 chainKey, uint64 height) private pure returns (bytes memory) {
        INativeQueryVerifier.MerkleProof memory merkle;
        INativeQueryVerifier.ContinuityProof memory continuity;
        return abi.encode(chainKey, height, _transaction(), merkle, continuity);
    }
}
