// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/write-ability/common/EvmV1Decoder.sol";
import {INativeQueryVerifier} from "@gluwa/usc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PolicyKernelV1} from "../../contracts/v2/PolicyKernelV1.sol";
import {VerifiedCreditStateV1} from "../../contracts/v2/VerifiedCreditStateV1.sol";
import {IPolicyEvaluatorV1} from "../../contracts/v2/interfaces/IPolicyEvaluatorV1.sol";
import {IPolicyFacilityV1} from "../../contracts/v2/interfaces/IPolicyFacilityV1.sol";
import {
    CreditObservation,
    EvidenceKind,
    FacilityStatus,
    ObservationKind,
    PolicyEffect,
    PolicyOutcome,
    PolicyResult,
    ProvenTransaction
} from "../../contracts/v2/types/RecourseTypesV2.sol";
import {MockVerifier} from "../mocks/MockVerifier.sol";

contract MockPolicyFacility is IPolicyFacilityV1 {
    address public immutable lender;
    address public immutable borrower;
    IERC20 public asset;
    FacilityStatus public status;
    bool public incidentPaused;
    PolicyEffect public lastEffect;
    uint64 public lastEvidenceExpiry;
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

    function setIncidentPaused(bool value) external {
        incidentPaused = value;
    }

    function applyPolicyEffect(uint256, PolicyEffect calldata effect, uint64 evidenceExpiry) external {
        lastEffect = effect;
        lastEvidenceExpiry = evidenceExpiry;
        ++applyCalls;
    }
}

contract MockPolicyEvaluator is IPolicyEvaluatorV1 {
    bytes private manifestBytes;
    PolicyResult private configuredResult;
    bool public irrelevant;

    constructor(bytes memory manifest_) {
        manifestBytes = manifest_;
    }

    function setResult(PolicyResult calldata result) external {
        configuredResult = result;
    }

    function setIrrelevant(bool value) external {
        irrelevant = value;
    }

    function evaluate(address, uint256, ProvenTransaction[] calldata)
        external
        view
        returns (PolicyResult memory result)
    {
        if (irrelevant) revert PolicyKernelV1.IrrelevantEvidence();
        return configuredResult;
    }

    function configHash(address, uint256) external view returns (bytes32) {
        return keccak256(manifestBytes);
    }

    function manifest(address, uint256) external view returns (bytes memory) {
        return manifestBytes;
    }

    function policyKind() external pure returns (string memory) {
        return "mock";
    }
}

contract PolicyKernelV1Test is Test {
    uint64 private constant CHAIN_KEY = 3;
    uint64 private constant HEIGHT = 25_826_525;
    uint256 private constant POLICY_ID = 7;
    address private constant LENDER = address(0xA1);
    address private constant BORROWER = address(0xB2);
    address private constant HUNTER = address(0xC3);

    MockVerifier private verifier;
    PolicyKernelV1 private kernel;
    MockPolicyFacility private facility;
    MockPolicyEvaluator private evaluator;

    function setUp() public {
        verifier = new MockVerifier();
        kernel = new PolicyKernelV1(verifier);
        facility = new MockPolicyFacility(LENDER, BORROWER);
        evaluator = new MockPolicyEvaluator(abi.encode("liability-event", uint256(1)));
        evaluator.setResult(_result());
    }

    function test_registrationCommitsIdentityConfigurationAndRecoverableManifest() public {
        bytes memory manifestBytes = evaluator.manifest(address(facility), POLICY_ID);
        bytes32 configHash = keccak256(manifestBytes);
        vm.prank(LENDER);
        kernel.registerPolicy(address(facility), POLICY_ID, evaluator);

        bytes32 expected = keccak256(abi.encode(bytes32(0), POLICY_ID, address(evaluator), configHash));
        assertEq(kernel.policySetCommitment(address(facility)), expected);
        (address storedEvaluator, bytes32 storedHash, bytes memory storedManifest) =
            kernel.policyOf(address(facility), POLICY_ID);
        assertEq(storedEvaluator, address(evaluator));
        assertEq(storedHash, configHash);
        assertEq(storedManifest, manifestBytes);
    }

    function test_onlyLenderCanRegisterAndOnlyWhileCreated() public {
        vm.expectRevert(PolicyKernelV1.NotLender.selector);
        kernel.registerPolicy(address(facility), POLICY_ID, evaluator);

        facility.setStatus(FacilityStatus.Active);
        vm.expectRevert(PolicyKernelV1.FacilityNotCreated.selector);
        vm.prank(LENDER);
        kernel.registerPolicy(address(facility), POLICY_ID, evaluator);
    }

    function test_registrationRejectsDuplicatePolicyId() public {
        _registerAndActivate();
        facility.setStatus(FacilityStatus.Created);
        vm.expectRevert(PolicyKernelV1.PolicyAlreadyRegistered.selector);
        vm.prank(LENDER);
        kernel.registerPolicy(address(facility), POLICY_ID, evaluator);
    }

    function test_successfulEvaluationRecordsCreditStateAppliesEffectAndConsumesReplay() public {
        _registerAndActivate();
        vm.warp(1_000);
        _submit(HEIGHT, _encodedTransaction(1));

        bytes32 query = kernel.queryId(CHAIN_KEY, HEIGHT, 0);
        assertTrue(kernel.isProcessed(address(facility), POLICY_ID, query));
        assertEq(facility.applyCalls(), 1);
        assertEq(facility.lastEvidenceExpiry(), 1_600);

        VerifiedCreditStateV1 creditState = kernel.creditState();
        assertEq(creditState.observationCount(address(facility), BORROWER), 1);
        (uint256 policyId, CreditObservation memory observation) =
            creditState.observationAt(address(facility), BORROWER, 0);
        assertEq(policyId, POLICY_ID);
        assertEq(observation.sourceChain, CHAIN_KEY);
        assertEq(observation.sourceBlock, HEIGHT);
        assertEq(observation.transactionIndex, 0);
        assertEq(observation.proofTime, 1_000);
        assertEq(observation.expiry, 1_600);
        assertEq(observation.policyEffectHash, keccak256(abi.encode(_result().effect)));
    }

    function test_verifierFailureAndRevertedReceiptConsumeNothing() public {
        _registerAndActivate();
        bytes32 query = kernel.queryId(CHAIN_KEY, HEIGHT, 0);

        verifier.setVerifyResult(false);
        vm.expectRevert(PolicyKernelV1.VerificationFailed.selector);
        _submit(HEIGHT, _encodedTransaction(1));
        assertFalse(kernel.isProcessed(address(facility), POLICY_ID, query));

        verifier.setVerifyResult(true);
        vm.expectRevert(PolicyKernelV1.TransactionReverted.selector);
        _submit(HEIGHT, _encodedTransaction(0));
        assertFalse(kernel.isProcessed(address(facility), POLICY_ID, query));
    }

    function test_irrelevantEvaluationConsumesNothing() public {
        _registerAndActivate();
        evaluator.setIrrelevant(true);
        bytes32 query = kernel.queryId(CHAIN_KEY, HEIGHT, 0);
        vm.expectRevert(PolicyKernelV1.IrrelevantEvidence.selector);
        _submit(HEIGHT, _encodedTransaction(1));
        assertFalse(kernel.isProcessed(address(facility), POLICY_ID, query));
    }

    function test_replayIsScopedByFacilityAndPolicy() public {
        _registerAndActivate();
        _submit(HEIGHT, _encodedTransaction(1));
        bytes32 query = kernel.queryId(CHAIN_KEY, HEIGHT, 0);
        vm.expectRevert(abi.encodeWithSelector(PolicyKernelV1.ProofAlreadyUsed.selector, query));
        _submit(HEIGHT, _encodedTransaction(1));

        MockPolicyEvaluator secondEvaluator = new MockPolicyEvaluator("second");
        secondEvaluator.setResult(_result());
        facility.setStatus(FacilityStatus.Created);
        vm.prank(LENDER);
        kernel.registerPolicy(address(facility), POLICY_ID + 1, secondEvaluator);
        facility.setStatus(FacilityStatus.Active);
        _submitPolicy(POLICY_ID + 1, HEIGHT, _encodedTransaction(1));

        MockPolicyFacility secondFacility = new MockPolicyFacility(LENDER, BORROWER);
        vm.prank(LENDER);
        kernel.registerPolicy(address(secondFacility), POLICY_ID, evaluator);
        secondFacility.setStatus(FacilityStatus.Active);
        _submitFacility(address(secondFacility), POLICY_ID, HEIGHT, _encodedTransaction(1));
    }

    function test_proofJobAdapterRequiresAuthorizedMarketAndMatchingRequirements() public {
        _registerAndActivate();
        bytes32 requirementsDigest = evaluator.configHash(address(facility), POLICY_ID);
        bytes memory proof = _encodedProof(HEIGHT, _encodedTransaction(1));

        vm.expectRevert(PolicyKernelV1.NotProofJobs.selector);
        kernel.evaluateProofJob(address(facility), POLICY_ID, requirementsDigest, proof, HUNTER);

        kernel.setProofJobs(address(this));
        (bool accepted, uint8 outcomeLevel) =
            kernel.evaluateProofJob(address(facility), POLICY_ID, requirementsDigest, proof, HUNTER);
        assertTrue(accepted);
        assertEq(outcomeLevel, 2);
    }

    function test_proofJobAdapterRejectsWrongRequirementsDigest() public {
        _registerAndActivate();
        kernel.setProofJobs(address(this));
        vm.expectRevert(PolicyKernelV1.RequirementsMismatch.selector);
        kernel.evaluateProofJob(
            address(facility), POLICY_ID, keccak256("wrong"), _encodedProof(HEIGHT, _encodedTransaction(1)), HUNTER
        );
    }

    function test_proofJobsCanOnlyBeConfiguredOnceByOwner() public {
        vm.expectRevert(PolicyKernelV1.NotOwner.selector);
        vm.prank(HUNTER);
        kernel.setProofJobs(HUNTER);

        kernel.setProofJobs(address(this));
        vm.expectRevert(PolicyKernelV1.ProofJobsAlreadySet.selector);
        kernel.setProofJobs(HUNTER);
    }

    function test_directSubmissionIsDisabledAfterProofJobsIsConfigured() public {
        _registerAndActivate();
        kernel.setProofJobs(address(this));
        vm.expectRevert(PolicyKernelV1.UseProofJobs.selector);
        _submit(HEIGHT, _encodedTransaction(1));
    }

    function test_proofJobReturnsDuplicateWithoutRevertingAfterVerifiedReplay() public {
        _registerAndActivate();
        bytes32 requirementsDigest = evaluator.configHash(address(facility), POLICY_ID);
        bytes memory proof = _encodedProof(HEIGHT, _encodedTransaction(1));
        _submit(HEIGHT, _encodedTransaction(1));
        kernel.setProofJobs(address(this));

        (bool accepted, uint8 outcomeLevel) =
            kernel.evaluateProofJob(address(facility), POLICY_ID, requirementsDigest, proof, HUNTER);
        assertFalse(accepted);
        assertEq(outcomeLevel, 0);
    }

    function test_jobPublicationIsBoundToFacilityLenderAndDenomination() public {
        address token = address(0x20);
        facility.setAsset(IERC20(token));
        vm.prank(LENDER);
        kernel.registerPolicy(address(facility), POLICY_ID, evaluator);
        bytes32 requirementsDigest = evaluator.configHash(address(facility), POLICY_ID);
        assertFalse(kernel.canPublishJob(address(facility), LENDER, token, POLICY_ID, requirementsDigest));

        facility.setStatus(FacilityStatus.Active);
        assertTrue(kernel.canPublishJob(address(facility), LENDER, token, POLICY_ID, requirementsDigest));
        assertFalse(kernel.canPublishJob(address(facility), HUNTER, token, POLICY_ID, requirementsDigest));
        assertFalse(kernel.canPublishJob(address(facility), LENDER, address(0x21), POLICY_ID, requirementsDigest));
        assertFalse(kernel.canPublishJob(address(facility), LENDER, token, POLICY_ID + 1, requirementsDigest));
        assertFalse(kernel.canPublishJob(address(facility), LENDER, token, POLICY_ID, keccak256("wrong")));
    }

    function test_batchUsesEachProofIndexAndConsumesOnlyAfterSuccessfulEvaluation() public {
        _registerAndActivate();
        bytes32 firstRoot = bytes32(uint256(11));
        bytes32 secondRoot = bytes32(uint256(22));
        verifier.setTxIndexForRoot(firstRoot, 4);
        verifier.setTxIndexForRoot(secondRoot, 5);

        PolicyResult memory result = _result();
        result.sourceBlock = HEIGHT + 1;
        result.transactionIndex = 5;
        evaluator.setResult(result);

        uint64[] memory heights = new uint64[](2);
        heights[0] = HEIGHT;
        heights[1] = HEIGHT + 1;
        bytes[] memory encodedTransactions = new bytes[](2);
        encodedTransactions[0] = _encodedTransaction(1);
        encodedTransactions[1] = _encodedTransaction(1);
        INativeQueryVerifier.MerkleProof[] memory proofs = new INativeQueryVerifier.MerkleProof[](2);
        proofs[0].root = firstRoot;
        proofs[1].root = secondRoot;
        INativeQueryVerifier.ContinuityProof memory continuityProof;

        vm.prank(HUNTER);
        kernel.submitBatch(
            address(facility), POLICY_ID, CHAIN_KEY, heights, encodedTransactions, proofs, continuityProof
        );

        assertTrue(kernel.isProcessed(address(facility), POLICY_ID, kernel.queryId(CHAIN_KEY, HEIGHT, 4)));
        assertTrue(kernel.isProcessed(address(facility), POLICY_ID, kernel.queryId(CHAIN_KEY, HEIGHT + 1, 5)));
        assertEq(facility.applyCalls(), 1);
    }

    function test_batchRejectsDuplicateAndRevertedReceiptWithoutConsumption() public {
        _registerAndActivate();
        uint64[] memory heights = new uint64[](2);
        heights[0] = HEIGHT;
        heights[1] = HEIGHT;
        bytes[] memory encodedTransactions = new bytes[](2);
        encodedTransactions[0] = _encodedTransaction(1);
        encodedTransactions[1] = _encodedTransaction(1);
        INativeQueryVerifier.MerkleProof[] memory proofs = new INativeQueryVerifier.MerkleProof[](2);
        INativeQueryVerifier.ContinuityProof memory continuityProof;
        bytes32 query = kernel.queryId(CHAIN_KEY, HEIGHT, 0);

        vm.expectRevert(abi.encodeWithSelector(PolicyKernelV1.ProofAlreadyUsed.selector, query));
        kernel.submitBatch(
            address(facility), POLICY_ID, CHAIN_KEY, heights, encodedTransactions, proofs, continuityProof
        );
        assertFalse(kernel.isProcessed(address(facility), POLICY_ID, query));

        heights[1] = HEIGHT + 1;
        encodedTransactions[1] = _encodedTransaction(0);
        vm.expectRevert(PolicyKernelV1.TransactionReverted.selector);
        kernel.submitBatch(
            address(facility), POLICY_ID, CHAIN_KEY, heights, encodedTransactions, proofs, continuityProof
        );
        assertFalse(kernel.isProcessed(address(facility), POLICY_ID, query));
    }

    function test_sourcePositionMustAdvanceWithinEachPolicy() public {
        _registerAndActivate();
        PolicyResult memory newer = _result();
        newer.sourceBlock = HEIGHT + 1;
        evaluator.setResult(newer);
        _submit(HEIGHT + 1, _encodedTransaction(1));

        evaluator.setResult(_result());
        bytes32 olderQuery = kernel.queryId(CHAIN_KEY, HEIGHT, 0);
        vm.expectRevert(PolicyKernelV1.StaleSourcePosition.selector);
        _submit(HEIGHT, _encodedTransaction(1));
        assertFalse(kernel.isProcessed(address(facility), POLICY_ID, olderQuery));
    }

    function _registerAndActivate() private {
        vm.prank(LENDER);
        kernel.registerPolicy(address(facility), POLICY_ID, evaluator);
        facility.setStatus(FacilityStatus.Active);
    }

    function _submit(uint64 height, bytes memory encodedTransaction) private {
        _submitPolicy(POLICY_ID, height, encodedTransaction);
    }

    function _submitPolicy(uint256 policyId, uint64 height, bytes memory encodedTransaction) private {
        _submitFacility(address(facility), policyId, height, encodedTransaction);
    }

    function _submitFacility(address facilityAddress, uint256 policyId, uint64 height, bytes memory encodedTransaction)
        private
    {
        INativeQueryVerifier.MerkleProof memory merkleProof;
        INativeQueryVerifier.ContinuityProof memory continuityProof;
        vm.prank(HUNTER);
        kernel.submitSingle(
            facilityAddress,
            policyId,
            CHAIN_KEY,
            height,
            encodedTransaction,
            merkleProof,
            continuityProof
        );
    }

    function _result() private pure returns (PolicyResult memory) {
        return PolicyResult({
            effect: PolicyEffect({
                outcome: PolicyOutcome.Restricted,
                creditLimitBps: 5_000,
                futureDrawFeeBps: 300,
                freezePendingDraw: true,
                requireFreshEvidence: true,
                terminate: false
            }),
            observationKind: ObservationKind.Liability,
            evidenceKind: EvidenceKind.EventDelta,
            sourceBlock: HEIGHT,
            transactionIndex: 0,
            subject: BORROWER,
            emitter: address(0xA4A4),
            observedValue: 50_000_000,
            freshnessPeriod: 600
        });
    }

    function _encodedTransaction(uint8 receiptStatus) private pure returns (bytes memory) {
        bytes[] memory chunks = new bytes[](3);
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](0);
        chunks[2] = abi.encode(receiptStatus, uint64(1), logs, bytes(""));
        return abi.encode(uint8(2), chunks);
    }

    function _encodedProof(uint64 height, bytes memory encodedTransaction) private pure returns (bytes memory) {
        INativeQueryVerifier.MerkleProof memory merkleProof;
        INativeQueryVerifier.ContinuityProof memory continuityProof;
        return abi.encode(CHAIN_KEY, height, encodedTransaction, merkleProof, continuityProof);
    }
}
