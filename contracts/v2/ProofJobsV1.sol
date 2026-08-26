// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IProofJobsKernelV1} from "./interfaces/IProofJobsKernelV1.sol";

contract ProofJobsV1 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum JobState {
        Open,
        OutcomeReached,
        AttemptsExhausted,
        Expired
    }

    struct JobParams {
        IERC20 token;
        address facility;
        uint256 policyId;
        bytes32 requirementsDigest;
        uint64 expiry;
        uint64 revealWindowBlocks;
        uint32 maxSuccessfulProofs;
        uint256 proofReimbursement;
        uint256 outcomeReward;
        uint256 commitBond;
        uint8 rewardOutcomeThreshold;
    }

    struct Job {
        address sponsor;
        IERC20 token;
        address facility;
        uint256 policyId;
        bytes32 requirementsDigest;
        uint64 expiry;
        uint64 revealWindowBlocks;
        uint32 maxSuccessfulProofs;
        uint32 successfulProofs;
        uint256 proofReimbursement;
        uint256 outcomeReward;
        uint256 commitBond;
        uint256 escrowRemaining;
        uint8 rewardOutcomeThreshold;
        JobState state;
    }

    struct Commitment {
        bytes32 digest;
        uint64 committedBlock;
        uint64 revealDeadlineBlock;
        uint256 bond;
    }

    error ZeroAddress();
    error InvalidJobConfiguration();
    error FacilityIncidentPaused();
    error UnauthorizedJobPublisher();
    error UnsupportedTokenTransfer();
    error JobNotFound();
    error JobNotOpen();
    error JobExpired();
    error JobNotExpired();
    error ActiveCommitment();
    error CommitmentNotFound();
    error CommitmentMismatch();
    error EvidenceDigestMismatch();
    error RevealTooEarly();
    error RevealWindowElapsed();
    error ProofRejected();
    error CommitStillRevealable();
    error CommitCannotBeReleased();
    error NothingToClaim();

    event JobCreated(
        uint256 indexed jobId,
        address indexed sponsor,
        address indexed facility,
        uint256 policyId,
        bytes32 requirementsDigest,
        uint256 escrow
    );
    event EvidenceCommitted(
        uint256 indexed jobId, address indexed hunter, bytes32 indexed commitment, uint64 revealDeadlineBlock
    );
    event ProofAccepted(uint256 indexed jobId, address indexed hunter, uint8 outcomeLevel, uint32 successfulProofs);
    event JobFinalized(uint256 indexed jobId, JobState state, uint256 sponsorRefund);
    event CommitmentSlashed(uint256 indexed jobId, address indexed hunter, uint256 bond);
    event CommitmentReleased(uint256 indexed jobId, address indexed hunter, uint256 bond);
    event Claimed(address indexed token, address indexed account, uint256 amount);

    IProofJobsKernelV1 public immutable kernel;
    uint256 public nextJobId = 1;

    mapping(uint256 jobId => Job job) private _jobs;
    mapping(uint256 jobId => mapping(address hunter => Commitment commitment)) private _commitments;
    mapping(address token => mapping(address account => uint256 amount)) public claimable;

    constructor(IProofJobsKernelV1 kernel_) {
        if (address(kernel_) == address(0)) revert ZeroAddress();
        kernel = kernel_;
    }

    function createJob(JobParams calldata params) external nonReentrant returns (uint256 jobId) {
        if (address(params.token) == address(0) || params.facility == address(0)) revert ZeroAddress();
        if (
            params.requirementsDigest == bytes32(0) || params.expiry <= block.timestamp
                || params.revealWindowBlocks == 0 || params.maxSuccessfulProofs == 0 || params.proofReimbursement == 0
                || params.outcomeReward == 0 || params.commitBond == 0 || params.rewardOutcomeThreshold > 4
        ) revert InvalidJobConfiguration();
        if (!kernel.canPublishJob(params.facility, msg.sender, address(params.token))) {
            revert UnauthorizedJobPublisher();
        }
        if (kernel.incidentPaused(params.facility)) revert FacilityIncidentPaused();

        uint256 escrow = params.proofReimbursement * params.maxSuccessfulProofs + params.outcomeReward;
        jobId = nextJobId++;
        _jobs[jobId] = Job({
            sponsor: msg.sender,
            token: params.token,
            facility: params.facility,
            policyId: params.policyId,
            requirementsDigest: params.requirementsDigest,
            expiry: params.expiry,
            revealWindowBlocks: params.revealWindowBlocks,
            maxSuccessfulProofs: params.maxSuccessfulProofs,
            successfulProofs: 0,
            proofReimbursement: params.proofReimbursement,
            outcomeReward: params.outcomeReward,
            commitBond: params.commitBond,
            escrowRemaining: escrow,
            rewardOutcomeThreshold: params.rewardOutcomeThreshold,
            state: JobState.Open
        });

        uint256 balanceBefore = params.token.balanceOf(address(this));
        params.token.safeTransferFrom(msg.sender, address(this), escrow);
        if (params.token.balanceOf(address(this)) - balanceBefore != escrow) revert UnsupportedTokenTransfer();

        emit JobCreated(jobId, msg.sender, params.facility, params.policyId, params.requirementsDigest, escrow);
    }

    function commitEvidence(uint256 jobId, bytes32 commitment) external nonReentrant {
        Job storage job = _openJob(jobId);
        if (block.timestamp >= job.expiry) revert JobExpired();
        if (commitment == bytes32(0)) revert InvalidJobConfiguration();
        if (_commitments[jobId][msg.sender].bond != 0) revert ActiveCommitment();

        uint64 committedBlock = uint64(block.number);
        uint64 revealDeadlineBlock = committedBlock + job.revealWindowBlocks;
        _commitments[jobId][msg.sender] = Commitment({
            digest: commitment,
            committedBlock: committedBlock,
            revealDeadlineBlock: revealDeadlineBlock,
            bond: job.commitBond
        });

        uint256 balanceBefore = job.token.balanceOf(address(this));
        job.token.safeTransferFrom(msg.sender, address(this), job.commitBond);
        if (job.token.balanceOf(address(this)) - balanceBefore != job.commitBond) revert UnsupportedTokenTransfer();

        emit EvidenceCommitted(jobId, msg.sender, commitment, revealDeadlineBlock);
    }

    function revealEvidence(uint256 jobId, bytes32 evidenceDigest, bytes32 salt, bytes calldata proof)
        external
        nonReentrant
    {
        Job storage job = _openJob(jobId);
        if (block.timestamp >= job.expiry) revert JobExpired();
        Commitment memory commitment = _commitments[jobId][msg.sender];
        if (commitment.bond == 0) revert CommitmentNotFound();
        if (block.number <= commitment.committedBlock) revert RevealTooEarly();
        if (block.number > commitment.revealDeadlineBlock) revert RevealWindowElapsed();
        if (commitment.digest != computeCommitment(jobId, msg.sender, evidenceDigest, salt)) {
            revert CommitmentMismatch();
        }
        if (evidenceDigest != keccak256(proof)) revert EvidenceDigestMismatch();

        (bool accepted, uint8 outcomeLevel) =
            kernel.evaluateProofJob(job.facility, job.policyId, job.requirementsDigest, proof, msg.sender);
        if (!accepted) revert ProofRejected();

        delete _commitments[jobId][msg.sender];
        job.successfulProofs++;
        job.escrowRemaining -= job.proofReimbursement;
        claimable[address(job.token)][msg.sender] += commitment.bond + job.proofReimbursement;

        emit ProofAccepted(jobId, msg.sender, outcomeLevel, job.successfulProofs);

        if (outcomeLevel >= job.rewardOutcomeThreshold) {
            job.escrowRemaining -= job.outcomeReward;
            claimable[address(job.token)][msg.sender] += job.outcomeReward;
            _finalize(jobId, job, JobState.OutcomeReached);
        } else if (job.successfulProofs == job.maxSuccessfulProofs) {
            _finalize(jobId, job, JobState.AttemptsExhausted);
        }
    }

    function slashExpiredCommit(uint256 jobId, address hunter) external nonReentrant {
        Job storage job = _job(jobId);
        Commitment memory commitment = _commitments[jobId][hunter];
        if (commitment.bond == 0) revert CommitmentNotFound();
        if (
            job.state != JobState.Expired && block.timestamp < job.expiry
                && block.number <= commitment.revealDeadlineBlock
        ) revert CommitStillRevealable();
        if (job.state == JobState.OutcomeReached || job.state == JobState.AttemptsExhausted) {
            revert CommitCannotBeReleased();
        }

        delete _commitments[jobId][hunter];
        claimable[address(job.token)][job.sponsor] += commitment.bond;
        emit CommitmentSlashed(jobId, hunter, commitment.bond);
    }

    function releaseCommit(uint256 jobId) external nonReentrant {
        Job storage job = _job(jobId);
        if (job.state != JobState.OutcomeReached && job.state != JobState.AttemptsExhausted) {
            revert CommitCannotBeReleased();
        }
        Commitment memory commitment = _commitments[jobId][msg.sender];
        if (commitment.bond == 0) revert CommitmentNotFound();

        delete _commitments[jobId][msg.sender];
        claimable[address(job.token)][msg.sender] += commitment.bond;
        emit CommitmentReleased(jobId, msg.sender, commitment.bond);
    }

    function finalizeExpired(uint256 jobId) external nonReentrant {
        Job storage job = _openJob(jobId);
        if (block.timestamp < job.expiry) revert JobNotExpired();
        _finalize(jobId, job, JobState.Expired);
    }

    function claim(IERC20 token) external nonReentrant {
        uint256 amount = claimable[address(token)][msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[address(token)][msg.sender] = 0;
        token.safeTransfer(msg.sender, amount);
        emit Claimed(address(token), msg.sender, amount);
    }

    function computeCommitment(uint256 jobId, address hunter, bytes32 evidenceDigest, bytes32 salt)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(jobId, hunter, evidenceDigest, salt));
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }

    function getCommitment(uint256 jobId, address hunter) external view returns (Commitment memory) {
        return _commitments[jobId][hunter];
    }

    function _job(uint256 jobId) private view returns (Job storage job) {
        job = _jobs[jobId];
        if (job.sponsor == address(0)) revert JobNotFound();
    }

    function _openJob(uint256 jobId) private view returns (Job storage job) {
        job = _job(jobId);
        if (job.state != JobState.Open) revert JobNotOpen();
    }

    function _finalize(uint256 jobId, Job storage job, JobState state) private {
        job.state = state;
        uint256 sponsorRefund = job.escrowRemaining;
        job.escrowRemaining = 0;
        claimable[address(job.token)][job.sponsor] += sponsorRefund;
        emit JobFinalized(jobId, state, sponsorRefund);
    }
}
