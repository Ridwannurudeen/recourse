// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/write-ability/common/EvmV1Decoder.sol";
import {INativeQueryVerifier} from "@gluwa/usc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";
import {IPolicyConfigurationContextV1} from "./interfaces/IPolicyConfigurationContextV1.sol";
import {IPolicyEvaluatorV1} from "./interfaces/IPolicyEvaluatorV1.sol";
import {IPolicyFacilityV1} from "./interfaces/IPolicyFacilityV1.sol";
import {VerifiedCreditStateV1} from "./VerifiedCreditStateV1.sol";
import {
    CreditObservation,
    FacilityStatus,
    PolicyOutcome,
    PolicyResult,
    ProvenTransaction
} from "./types/RecourseTypesV2.sol";

contract PolicyKernelV1 is ReentrancyGuard, IPolicyConfigurationContextV1 {
    error FacilityNotCreated();
    error FacilityNotActive();
    error InvalidManifest();
    error InvalidObservation();
    error InvalidPolicyEffect();
    error IrrelevantEvidence();
    error NotLender();
    error PolicyAlreadyRegistered();
    error PolicyNotRegistered();
    error ProofAlreadyUsed(bytes32 queryId);
    error TransactionReverted();
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

    mapping(address facility => mapping(uint256 policyId => PolicyRegistration registration)) private policies;
    mapping(address facility => bytes32 commitment) public policySetCommitment;
    mapping(address facility => mapping(uint256 policyId => mapping(bytes32 queryId => bool processed))) private
        processedQueries;

    constructor(INativeQueryVerifier verifier_) {
        if (address(verifier_) == address(0)) revert ZeroAddress();
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
        _validateResult(facility, result, height, txIndex);

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

        emit EvidenceAccepted(facility, policyId, qid, msg.sender, result.effect.outcome);
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

    function _validateResult(address facility, PolicyResult memory result, uint64 height, uint64 txIndex) private view {
        if (
            result.subject != IPolicyFacilityV1(facility).borrower() || result.emitter == address(0)
                || result.sourceBlock != height || result.transactionIndex != txIndex || result.freshnessPeriod == 0
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
}
