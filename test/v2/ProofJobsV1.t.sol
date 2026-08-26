// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IProofJobsKernelV1} from "../../contracts/v2/interfaces/IProofJobsKernelV1.sol";
import {ProofJobsV1} from "../../contracts/v2/ProofJobsV1.sol";

contract ProofJobsToken is ERC20 {
    constructor() ERC20("Proof Jobs USD", "PJUSD") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }
}

contract MockProofJobsKernel is IProofJobsKernelV1 {
    mapping(address facility => bool paused) public override incidentPaused;

    bool public accepted = true;
    uint8 public outcomeLevel;
    bool public shouldRevert;
    uint256 public calls;
    address public lastFacility;
    uint256 public lastPolicyId;
    bytes32 public lastRequirementsDigest;
    bytes public lastProof;
    address public lastHunter;

    function setResult(bool accepted_, uint8 outcomeLevel_) external {
        accepted = accepted_;
        outcomeLevel = outcomeLevel_;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function setPaused(address facility, bool value) external {
        incidentPaused[facility] = value;
    }

    function evaluateProofJob(
        address facility,
        uint256 policyId,
        bytes32 requirementsDigest,
        bytes calldata proof,
        address hunter
    ) external override returns (bool, uint8) {
        if (shouldRevert) revert("kernel failure");
        calls++;
        lastFacility = facility;
        lastPolicyId = policyId;
        lastRequirementsDigest = requirementsDigest;
        lastProof = proof;
        lastHunter = hunter;
        return (accepted, outcomeLevel);
    }
}

    contract ProofJobsV1Test is Test {
        ProofJobsV1 internal jobs;
        ProofJobsToken internal token;
        MockProofJobsKernel internal kernel;

        address internal constant SPONSOR = address(0x5100);
        address internal constant HUNTER = address(0xB0B);
        address internal constant SECOND_HUNTER = address(0xCA7);
        address internal constant FACILITY = address(0xFAC1);
        uint256 internal constant POLICY_ID = 7;
        bytes32 internal constant REQUIREMENTS = keccak256("typed requirements");
        uint256 internal constant REIMBURSEMENT = 25e6;
        uint256 internal constant OUTCOME_REWARD = 100e6;
        uint256 internal constant COMMIT_BOND = 10e6;
        uint32 internal constant MAX_ATTEMPTS = 2;
        uint64 internal constant REVEAL_WINDOW = 5;
        uint8 internal constant REWARD_THRESHOLD = 3;

        function setUp() public {
            kernel = new MockProofJobsKernel();
            jobs = new ProofJobsV1(kernel);
            token = new ProofJobsToken();
            token.mint(SPONSOR, 1_000e6);
            token.mint(HUNTER, 100e6);
            token.mint(SECOND_HUNTER, 100e6);

            vm.prank(SPONSOR);
            token.approve(address(jobs), type(uint256).max);
            vm.prank(HUNTER);
            token.approve(address(jobs), type(uint256).max);
            vm.prank(SECOND_HUNTER);
            token.approve(address(jobs), type(uint256).max);
        }

        function test_createJobPrefundsTypedEscrow() public {
            uint256 jobId = _createJob();
            ProofJobsV1.Job memory job = jobs.getJob(jobId);

            assertEq(job.sponsor, SPONSOR);
            assertEq(address(job.token), address(token));
            assertEq(job.facility, FACILITY);
            assertEq(job.policyId, POLICY_ID);
            assertEq(job.requirementsDigest, REQUIREMENTS);
            assertEq(job.proofReimbursement, REIMBURSEMENT);
            assertEq(job.outcomeReward, OUTCOME_REWARD);
            assertEq(job.commitBond, COMMIT_BOND);
            assertEq(job.maxSuccessfulProofs, MAX_ATTEMPTS);
            assertEq(job.revealWindowBlocks, REVEAL_WINDOW);
            assertEq(job.rewardOutcomeThreshold, REWARD_THRESHOLD);
            assertEq(job.escrowRemaining, REIMBURSEMENT * MAX_ATTEMPTS + OUTCOME_REWARD);
            assertEq(token.balanceOf(address(jobs)), job.escrowRemaining);
        }

        function test_createJobRevertsWhileFacilityIncidentPaused() public {
            kernel.setPaused(FACILITY, true);

            vm.prank(SPONSOR);
            vm.expectRevert(ProofJobsV1.FacilityIncidentPaused.selector);
            jobs.createJob(_params());
        }

        function test_multipleHuntersCanCommitAndRevealNeedsOneLaterBlock() public {
            uint256 jobId = _createJob();
            bytes32 digest = keccak256(hex"1234");
            bytes32 salt = keccak256("salt");
            bytes32 secondSalt = keccak256("second salt");
            _commit(jobId, HUNTER, digest, salt);
            _commit(jobId, SECOND_HUNTER, digest, secondSalt);

            vm.prank(HUNTER);
            vm.expectRevert(ProofJobsV1.RevealTooEarly.selector);
            jobs.revealEvidence(jobId, digest, salt, hex"1234");

            vm.roll(block.number + 1);
            vm.prank(HUNTER);
            jobs.revealEvidence(jobId, digest, salt, hex"1234");

            ProofJobsV1.Commitment memory secondCommit = jobs.getCommitment(jobId, SECOND_HUNTER);
            assertEq(secondCommit.bond, COMMIT_BOND);
            assertEq(kernel.lastHunter(), HUNTER);
        }

        function test_revealBindsJobHunterDigestAndSaltBeforeCallingKernel() public {
            uint256 jobId = _createJob();
            bytes32 digest = keccak256(hex"1234");
            bytes32 salt = keccak256("salt");
            _commit(jobId, HUNTER, digest, salt);
            vm.roll(block.number + 1);

            vm.prank(HUNTER);
            vm.expectRevert(ProofJobsV1.CommitmentMismatch.selector);
            jobs.revealEvidence(jobId, keccak256("other evidence"), salt, hex"1234");

            assertEq(kernel.calls(), 0);
            assertEq(jobs.getCommitment(jobId, HUNTER).bond, COMMIT_BOND);
        }

        function test_revealRejectsProofThatDoesNotMatchCommittedEvidenceDigest() public {
            uint256 jobId = _createJob();
            bytes32 digest = keccak256(hex"1234");
            bytes32 salt = keccak256("salt");
            _commit(jobId, HUNTER, digest, salt);
            vm.roll(block.number + 1);

            vm.prank(HUNTER);
            vm.expectRevert(ProofJobsV1.EvidenceDigestMismatch.selector);
            jobs.revealEvidence(jobId, digest, salt, hex"5678");

            assertEq(kernel.calls(), 0);
            assertEq(jobs.getCommitment(jobId, HUNTER).bond, COMMIT_BOND);
        }

        function test_irrelevantProofDoesNotConsumeCommitOrAttempt() public {
            uint256 jobId = _createJob();
            bytes32 digest = keccak256(hex"1234");
            bytes32 salt = keccak256("salt");
            _commit(jobId, HUNTER, digest, salt);
            vm.roll(block.number + 1);
            kernel.setResult(false, 4);

            vm.prank(HUNTER);
            vm.expectRevert(ProofJobsV1.ProofRejected.selector);
            jobs.revealEvidence(jobId, digest, salt, hex"1234");

            assertEq(jobs.getCommitment(jobId, HUNTER).bond, COMMIT_BOND);
            assertEq(jobs.getJob(jobId).successfulProofs, 0);
        }

        function test_kernelFailureDoesNotConsumeCommitOrAttempt() public {
            uint256 jobId = _createJob();
            bytes32 digest = keccak256(hex"1234");
            bytes32 salt = keccak256("salt");
            _commit(jobId, HUNTER, digest, salt);
            vm.roll(block.number + 1);
            kernel.setShouldRevert(true);

            vm.prank(HUNTER);
            vm.expectRevert(bytes("kernel failure"));
            jobs.revealEvidence(jobId, digest, salt, hex"1234");

            assertEq(jobs.getCommitment(jobId, HUNTER).bond, COMMIT_BOND);
            assertEq(jobs.getJob(jobId).successfulProofs, 0);
        }

        function test_successfulProofReturnsBondAndReimbursementThroughPullClaim() public {
            uint256 jobId = _createJob();
            bytes32 digest = keccak256(hex"1234");
            bytes32 salt = keccak256("salt");
            _commit(jobId, HUNTER, digest, salt);
            vm.roll(block.number + 1);
            kernel.setResult(true, 1);

            uint256 balanceBefore = token.balanceOf(HUNTER);
            vm.prank(HUNTER);
            jobs.revealEvidence(jobId, digest, salt, hex"1234");

            assertEq(token.balanceOf(HUNTER), balanceBefore);
            assertEq(jobs.claimable(address(token), HUNTER), COMMIT_BOND + REIMBURSEMENT);
            assertEq(jobs.getJob(jobId).successfulProofs, 1);
            assertEq(kernel.lastFacility(), FACILITY);
            assertEq(kernel.lastPolicyId(), POLICY_ID);
            assertEq(kernel.lastRequirementsDigest(), REQUIREMENTS);
            assertEq(kernel.lastProof(), hex"1234");

            vm.prank(HUNTER);
            jobs.claim(token);
            assertEq(token.balanceOf(HUNTER), balanceBefore + COMMIT_BOND + REIMBURSEMENT);
            assertEq(jobs.claimable(address(token), HUNTER), 0);
        }

        function test_outcomeRewardOnlyPaidAtExplicitSeverityThreshold() public {
            uint256 jobId = _createJob();
            bytes32 digest = keccak256(hex"1234");
            bytes32 salt = keccak256("salt");
            _commit(jobId, HUNTER, digest, salt);
            vm.roll(block.number + 1);
            kernel.setResult(true, REWARD_THRESHOLD);

            vm.prank(HUNTER);
            jobs.revealEvidence(jobId, digest, salt, hex"1234");

            ProofJobsV1.Job memory job = jobs.getJob(jobId);
            assertEq(uint256(job.state), uint256(ProofJobsV1.JobState.OutcomeReached));
            assertEq(jobs.claimable(address(token), HUNTER), COMMIT_BOND + REIMBURSEMENT + OUTCOME_REWARD);
            assertEq(jobs.claimable(address(token), SPONSOR), REIMBURSEMENT);
        }

        function test_attemptExhaustionRefundsUnusedOutcomeRewardToSponsor() public {
            uint256 jobId = _createJob();
            kernel.setResult(true, REWARD_THRESHOLD - 1);

            _successfulReveal(jobId, HUNTER, keccak256(hex"1234"), keccak256("salt one"));
            _successfulReveal(jobId, HUNTER, keccak256(hex"1234"), keccak256("salt two"));

            ProofJobsV1.Job memory job = jobs.getJob(jobId);
            assertEq(uint256(job.state), uint256(ProofJobsV1.JobState.AttemptsExhausted));
            assertEq(jobs.claimable(address(token), SPONSOR), OUTCOME_REWARD);
            assertEq(jobs.claimable(address(token), HUNTER), 2 * (COMMIT_BOND + REIMBURSEMENT));
        }

        function test_permissionlessSlashAfterNonRevealCreditsSponsor() public {
            uint256 jobId = _createJob();
            bytes32 digest = keccak256(hex"1234");
            bytes32 salt = keccak256("salt");
            _commit(jobId, HUNTER, digest, salt);

            vm.roll(block.number + REVEAL_WINDOW + 1);
            vm.prank(SECOND_HUNTER);
            jobs.slashExpiredCommit(jobId, HUNTER);

            assertEq(jobs.getCommitment(jobId, HUNTER).bond, 0);
            assertEq(jobs.claimable(address(token), SPONSOR), COMMIT_BOND);
        }

        function test_slashBeforeRevealDeadlineReverts() public {
            uint256 jobId = _createJob();
            bytes32 digest = keccak256(hex"1234");
            bytes32 salt = keccak256("salt");
            _commit(jobId, HUNTER, digest, salt);

            vm.roll(block.number + REVEAL_WINDOW);
            vm.expectRevert(ProofJobsV1.CommitStillRevealable.selector);
            jobs.slashExpiredCommit(jobId, HUNTER);
        }

        function test_expiryRefundsRemainingEscrowAndUnrevealedBondIsSlashable() public {
            uint256 jobId = _createJob();
            bytes32 digest = keccak256(hex"1234");
            bytes32 salt = keccak256("salt");
            _commit(jobId, HUNTER, digest, salt);
            ProofJobsV1.Job memory beforeExpiry = jobs.getJob(jobId);

            vm.warp(beforeExpiry.expiry + 1);
            jobs.finalizeExpired(jobId);
            jobs.slashExpiredCommit(jobId, HUNTER);

            ProofJobsV1.Job memory job = jobs.getJob(jobId);
            assertEq(uint256(job.state), uint256(ProofJobsV1.JobState.Expired));
            assertEq(
                jobs.claimable(address(token), SPONSOR), REIMBURSEMENT * MAX_ATTEMPTS + OUTCOME_REWARD + COMMIT_BOND
            );
        }

        function test_otherHunterCanRecoverBondWhenOutcomeFinalizesJob() public {
            uint256 jobId = _createJob();
            bytes32 digest = keccak256(hex"1234");
            bytes32 salt = keccak256("salt");
            bytes32 secondSalt = keccak256("second salt");
            _commit(jobId, HUNTER, digest, salt);
            _commit(jobId, SECOND_HUNTER, digest, secondSalt);
            vm.roll(block.number + 1);
            kernel.setResult(true, REWARD_THRESHOLD);

            vm.prank(HUNTER);
            jobs.revealEvidence(jobId, digest, salt, hex"1234");
            vm.prank(SECOND_HUNTER);
            jobs.releaseCommit(jobId);

            assertEq(jobs.getCommitment(jobId, SECOND_HUNTER).bond, 0);
            assertEq(jobs.claimable(address(token), SECOND_HUNTER), COMMIT_BOND);
        }

        function test_claimAccumulatesAcrossJobsAndCannotBeRepeated() public {
            uint256 first = _createJob();
            uint256 second = _createJob();
            kernel.setResult(true, 0);
            _successfulReveal(first, HUNTER, keccak256(hex"1234"), keccak256("salt one"));
            _successfulReveal(second, HUNTER, keccak256(hex"1234"), keccak256("salt two"));

            uint256 beforeClaim = token.balanceOf(HUNTER);
            vm.prank(HUNTER);
            jobs.claim(token);
            assertEq(token.balanceOf(HUNTER), beforeClaim + 2 * (COMMIT_BOND + REIMBURSEMENT));

            vm.prank(HUNTER);
            vm.expectRevert(ProofJobsV1.NothingToClaim.selector);
            jobs.claim(token);
        }

        function _createJob() internal returns (uint256 jobId) {
            vm.prank(SPONSOR);
            jobId = jobs.createJob(_params());
        }

        function _params() internal view returns (ProofJobsV1.JobParams memory) {
            return ProofJobsV1.JobParams({
                token: token,
                facility: FACILITY,
                policyId: POLICY_ID,
                requirementsDigest: REQUIREMENTS,
                expiry: uint64(block.timestamp + 1 days),
                revealWindowBlocks: REVEAL_WINDOW,
                maxSuccessfulProofs: MAX_ATTEMPTS,
                proofReimbursement: REIMBURSEMENT,
                outcomeReward: OUTCOME_REWARD,
                commitBond: COMMIT_BOND,
                rewardOutcomeThreshold: REWARD_THRESHOLD
            });
        }

        function _commit(uint256 jobId, address hunter, bytes32 digest, bytes32 salt) internal {
            bytes32 commitment = jobs.computeCommitment(jobId, hunter, digest, salt);
            vm.prank(hunter);
            jobs.commitEvidence(jobId, commitment);
        }

        function _successfulReveal(uint256 jobId, address hunter, bytes32 digest, bytes32 salt) internal {
            _commit(jobId, hunter, digest, salt);
            vm.roll(block.number + 1);
            vm.prank(hunter);
            jobs.revealEvidence(jobId, digest, salt, hex"1234");
        }
    }
