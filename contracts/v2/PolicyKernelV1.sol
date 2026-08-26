// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/write-ability/common/EvmV1Decoder.sol";
import {INativeQueryVerifier} from "@gluwa/usc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";
import {IPolicyConfigurationContextV1} from "./interfaces/IPolicyConfigurationContextV1.sol";
import {IPolicyEvaluatorV1} from "./interfaces/IPolicyEvaluatorV1.sol";
import {IPolicyFacilityV1} from "./interfaces/IPolicyFacilityV1.sol";
import {IProofJobsKernelV1} from "./interfaces/IProofJobsKernelV1.sol";
import {VerifiedCreditStateV1} from "./VerifiedCreditStateV1.sol";
import {
    CreditObservation,
    FacilityStatus,
    PolicyOutcome,
    PolicyResult,
    ProvenTransaction
} from "./types/RecourseTypesV2.sol";

contract PolicyKernelV1 is ReentrancyGuard, IPolicyConfigurationContextV1, IProofJobsKernelV1 {
    error FacilityNotCreated();
    error FacilityNotActive();
    error InvalidManifest();
    error InvalidBatch();
    error InvalidObservation();
    error InvalidPolicyEffect();
    error IrrelevantEvidence();
    error NotLender();
    error NotOwner();
    error NotProofJobs();
    error PolicyAlreadyRegistered();
    error PolicyNotRegistered();
    error ProofJobsAlreadySet();
    error ProofAlreadyUsed(bytes32 queryId);
    error TransactionReverted();
    error RequirementsMismatch();
    error VerificationFailed();
    error ZeroAddress();

    event PolicyRegistered(
        address indexed facility,
        uint256 indexed policyId,
        address indexed evaluator,
        bytes32 configHash,
        bytes manifest
    );
    event EvidenceAccepted(
        address indexed facility,
        uint256 indexed policyId,
        bytes32 indexed queryId,
        address submitter,
        PolicyOutcome outcome
    );

    struct PolicyRegistration {
        IPolicyEvaluatorV1 evaluator;
        bytes32 configHash;
        bytes manifest;
    }

    INativeQueryVerifier public immutable verifier;
    VerifiedCreditStateV1 public immutable creditState;
    address public immutable owner;
    address public proofJobs;

    mapping(address facility => mapping(uint256 policyId => PolicyRegistration registration)) private policies;
    mapping(address facility => bytes32 commitment) public policySetCommitment;
    mapping(address facility => mapping(uint256 policyId => mapping(bytes32 queryId => bool processed))) private
        processedQueries;

    constructor(INativeQueryVerifier verifier_) {
        if (address(verifier_) == address(0)) revert ZeroAddress();
        owner = msg.sender;
        verifier = verifier_;
        creditState = new VerifiedCreditStateV1(address(this));
    }

    function registerPolicy(address facility, uint256 policyId, IPolicyEvaluatorV1 evaluator) external {
        IPolicyFacilityV1 facilityContract = IPolicyFacilityV1(facility);
        if (facilityContract.status() != FacilityStatus.Created) revert FacilityNotCreated();
        if (msg.sender != facilityContract.lender()) revert NotLender();
        if (address(evaluator) == address(0)) revert ZeroAddress();
        if (address(policies[facility][policyId].evaluator) != address(0)) revert PolicyAlreadyRegistered();

        bytes memory manifestBytes = evaluator.manifest(facility, policyId);
        bytes32 configurationHash = evaluator.configHash(facility, policyId);
        if (manifestBytes.length == 0 || configurationHash == bytes32(0)) revert InvalidManifest();
        if (keccak256(manifestBytes) != configurationHash) revert InvalidManifest();

        policies[facility][policyId] = PolicyRegistration({
            evaluator: evaluator, configHash: configurationHash, manifest: manifestBytes
        });
        policySetCommitment[facility] =
            keccak256(abi.encode(policySetCommitment[facility], policyId, address(evaluator), configurationHash));

        emit PolicyRegistered(facility, policyId, address(evaluator), configurationHash, manifestBytes);
    }

    function submitSingle(
        address facility,
        uint256 policyId,
        uint64 chainKey,
        uint64 height,
        bytes calldata encodedTransaction,
        INativeQueryVerifier.MerkleProof calldata merkleProof,
        INativeQueryVerifier.ContinuityProof calldata continuityProof
    ) external nonReentrant returns (PolicyOutcome outcome) {
        return _submitSingle(
            facility,
            policyId,
            chainKey,
            height,
            encodedTransaction,
            merkleProof,
            continuityProof,
            msg.sender
        );
    }

    function submitBatch(
        address facility,
        uint256 policyId,
        uint64 chainKey,
        uint64[] calldata heights,
        bytes[] calldata encodedTransactions,
        INativeQueryVerifier.MerkleProof[] calldata merkleProofs,
        INativeQueryVerifier.ContinuityProof calldata sharedContinuityProof
    ) external nonReentrant returns (PolicyOutcome outcome) {
        uint256 length = heights.length;
        if (length == 0 || encodedTransactions.length != length || merkleProofs.length != length) {
            revert InvalidBatch();
        }
        if (!verifier.verify(chainKey, heights, encodedTransactions, merkleProofs, sharedContinuityProof)) {
            revert VerificationFailed();
        }

        PolicyRegistration storage registration = _activePolicy(facility, policyId);
        ProvenTransaction[] memory proven = new ProvenTransaction[](length);
        bytes32[] memory queryIds = new bytes32[](length);
        for (uint256 i; i < length; ++i) {
            EvmV1Decoder.ReceiptFields memory receipt =
                EvmV1Decoder.decodeReceiptFields(encodedTransactions[i]);
            if (receipt.receiptStatus != 1) revert TransactionReverted();

            uint64 txIndex = verifier.calculateTxIndex(merkleProofs[i]);
            bytes32 qid = queryId(chainKey, heights[i], txIndex);
            if (processedQueries[facility][policyId][qid]) revert ProofAlreadyUsed(qid);
            for (uint256 j; j < i; ++j) {
                if (queryIds[j] == qid) revert ProofAlreadyUsed(qid);
            }
            queryIds[i] = qid;
            proven[i] = ProvenTransaction({
                chainKey: chainKey,
                blockHeight: heights[i],
                txIndex: txIndex,
                encodedTransaction: encodedTransactions[i]
            });
        }

        PolicyResult memory result = registration.evaluator.evaluate(facility, policyId, proven);
        _validateResultBase(facility, result);
        bool sourceFound;
        for (uint256 i; i < length; ++i) {
            if (result.sourceBlock == proven[i].blockHeight && result.transactionIndex == proven[i].txIndex) {
                sourceFound = true;
                break;
            }
        }
        if (!sourceFound) revert InvalidObservation();

        uint64 proofTime = _timestamp64();
        uint64 expiry = _expiry(proofTime, result.freshnessPeriod);
        CreditObservation memory observation = CreditObservation({
            kind: result.observationKind,
            evidenceKind: result.evidenceKind,
            sourceChain: chainKey,
            sourceBlock: result.sourceBlock,
            transactionIndex: result.transactionIndex,
            subject: result.subject,
            emitter: result.emitter,
            observedValue: result.observedValue,
            proofTime: proofTime,
            expiry: expiry,
            evidenceDigest: keccak256(abi.encode(chainKey, heights, queryIds, encodedTransactions)),
            policyEffectHash: keccak256(abi.encode(result.effect))
        });

        for (uint256 i; i < length; ++i) {
            processedQueries[facility][policyId][queryIds[i]] = true;
            emit EvidenceAccepted(facility, policyId, queryIds[i], msg.sender, result.effect.outcome);
        }
        creditState.recordObservation(facility, policyId, observation);
        IPolicyFacilityV1(facility).applyPolicyEffect(result.effect, expiry);
        return result.effect.outcome;
    }

    function setProofJobs(address proofJobs_) external {
        if (msg.sender != owner) revert NotOwner();
        if (proofJobs != address(0)) revert ProofJobsAlreadySet();
        if (proofJobs_ == address(0)) revert ZeroAddress();
        proofJobs = proofJobs_;
    }

    function incidentPaused(address facility) external view override returns (bool) {
        return IPolicyFacilityV1(facility).incidentPaused();
    }

    function canPublishJob(address facility, address sponsor, address token) external view override returns (bool) {
        IPolicyFacilityV1 facilityContract = IPolicyFacilityV1(facility);
        return sponsor == facilityContract.lender() && token == address(facilityContract.asset());
    }

    function evaluateProofJob(
        address facility,
        uint256 policyId,
        bytes32 requirementsDigest,
        bytes calldata proof,
        address hunter
    ) external override nonReentrant returns (bool accepted, uint8 outcomeLevel) {
        if (msg.sender != proofJobs) revert NotProofJobs();
        PolicyRegistration storage registration = policies[facility][policyId];
        if (address(registration.evaluator) == address(0)) revert PolicyNotRegistered();
        if (requirementsDigest != registration.configHash) revert RequirementsMismatch();

        (
            uint64 chainKey,
            uint64 height,
            bytes memory encodedTransaction,
            INativeQueryVerifier.MerkleProof memory merkleProof,
            INativeQueryVerifier.ContinuityProof memory continuityProof
        ) = abi.decode(
            proof,
            (uint64, uint64, bytes, INativeQueryVerifier.MerkleProof, INativeQueryVerifier.ContinuityProof)
        );
        PolicyOutcome outcome = _submitSingle(
            facility,
            policyId,
            chainKey,
            height,
            encodedTransaction,
            merkleProof,
            continuityProof,
            hunter
        );
        return (true, _severity(outcome));
    }

    function _submitSingle(
        address facility,
        uint256 policyId,
        uint64 chainKey,
        uint64 height,
        bytes memory encodedTransaction,
        INativeQueryVerifier.MerkleProof memory merkleProof,
        INativeQueryVerifier.ContinuityProof memory continuityProof,
        address submitter
    ) private returns (PolicyOutcome outcome) {
        if (!verifier.verify(chainKey, height, encodedTransaction, merkleProof, continuityProof)) {
            revert VerificationFailed();
        }

        PolicyRegistration storage registration = _activePolicy(facility, policyId);
        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
        if (receipt.receiptStatus != 1) revert TransactionReverted();

        uint64 txIndex = verifier.calculateTxIndex(merkleProof);
        bytes32 qid = queryId(chainKey, height, txIndex);
        if (processedQueries[facility][policyId][qid]) revert ProofAlreadyUsed(qid);

        ProvenTransaction[] memory proven = new ProvenTransaction[](1);
        proven[0] = ProvenTransaction({
            chainKey: chainKey,
            blockHeight: height,
            txIndex: txIndex,
            encodedTransaction: encodedTransaction
        });
        PolicyResult memory result = registration.evaluator.evaluate(facility, policyId, proven);
        _validateResultBase(facility, result);
        if (result.sourceBlock != height || result.transactionIndex != txIndex) revert InvalidObservation();

        uint64 proofTime = _timestamp64();
        uint64 expiry = _expiry(proofTime, result.freshnessPeriod);
        CreditObservation memory observation = CreditObservation({
            kind: result.observationKind,
            evidenceKind: result.evidenceKind,
            sourceChain: chainKey,
            sourceBlock: result.sourceBlock,
            transactionIndex: result.transactionIndex,
            subject: result.subject,
            emitter: result.emitter,
            observedValue: result.observedValue,
            proofTime: proofTime,
            expiry: expiry,
            evidenceDigest: keccak256(abi.encode(chainKey, height, txIndex, encodedTransaction)),
            policyEffectHash: keccak256(abi.encode(result.effect))
        });

        processedQueries[facility][policyId][qid] = true;
        creditState.recordObservation(facility, policyId, observation);
        IPolicyFacilityV1(facility).applyPolicyEffect(result.effect, expiry);

        emit EvidenceAccepted(facility, policyId, qid, submitter, result.effect.outcome);
        return result.effect.outcome;
    }

    function policyOf(address facility, uint256 policyId)
        external
        view
        returns (address evaluator, bytes32 configHash, bytes memory manifestBytes)
    {
        PolicyRegistration storage registration = policies[facility][policyId];
        return (address(registration.evaluator), registration.configHash, registration.manifest);
    }

    function lenderOf(address facility) external view returns (address) {
        return IPolicyFacilityV1(facility).lender();
    }

    function isPolicyRegistered(address facility, uint256 policyId) external view returns (bool) {
        return address(policies[facility][policyId].evaluator) != address(0);
    }

    function queryId(uint64 chainKey, uint64 blockHeight, uint64 txIndex) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(chainKey, blockHeight, txIndex));
    }

    function isProcessed(address facility, uint256 policyId, bytes32 qid) external view returns (bool) {
        return processedQueries[facility][policyId][qid];
    }

    function _activePolicy(address facility, uint256 policyId)
        private
        view
        returns (PolicyRegistration storage registration)
    {
        registration = policies[facility][policyId];
        if (address(registration.evaluator) == address(0)) revert PolicyNotRegistered();
        if (IPolicyFacilityV1(facility).status() != FacilityStatus.Active) revert FacilityNotActive();
    }

    function _validateResultBase(address facility, PolicyResult memory result) private view {
        if (
            result.subject != IPolicyFacilityV1(facility).borrower() || result.emitter == address(0)
                || result.freshnessPeriod == 0
        ) revert InvalidObservation();
        if (result.effect.creditLimitBps > 10_000 || result.effect.futureDrawFeeBps > 10_000) {
            revert InvalidPolicyEffect();
        }
    }

    function _timestamp64() private view returns (uint64) {
        if (block.timestamp > type(uint64).max) revert InvalidObservation();
        return uint64(block.timestamp);
    }

    function _expiry(uint64 proofTime, uint64 freshnessPeriod) private pure returns (uint64) {
        if (freshnessPeriod > type(uint64).max - proofTime) revert InvalidObservation();
        return proofTime + freshnessPeriod;
    }

    function _severity(PolicyOutcome outcome) private pure returns (uint8) {
        if (outcome == PolicyOutcome.Watch) return 1;
        if (outcome == PolicyOutcome.Restricted) return 2;
        if (outcome == PolicyOutcome.MarginCalled) return 3;
        if (outcome == PolicyOutcome.Breached) return 4;
        return 0;
    }
}
