// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/write-ability/common/EvmV1Decoder.sol";
import {INativeQueryVerifier} from "@gluwa/usc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";
import {ICovenant} from "./interfaces/ICovenant.sol";
import {IRecourseFacility} from "./interfaces/IRecourseFacility.sol";
import {
    FacilityState,
    NotLender,
    ProofAlreadyUsed,
    ProvenTx,
    TransactionReverted,
    VerificationFailed,
    WrongState,
    ZeroAmount
} from "./types/RecourseTypes.sol";

contract AttestcoinAdjudicator is ReentrancyGuard {
    error CovenantAlreadyRegistered();
    error CovenantNotRegistered();

    event EvidenceAccepted(
        uint256 indexed facilityId, uint256 indexed covenantId, bytes32 indexed queryId, address submitter
    );
    event BreachReported(uint256 indexed facilityId, uint256 indexed covenantId, address indexed submitter);

    INativeQueryVerifier public immutable verifier;
    IRecourseFacility public immutable facility;

    mapping(uint256 facilityId => mapping(uint256 covenantId => ICovenant covenant)) private covenants;
    mapping(uint256 facilityId => mapping(uint256 covenantId => mapping(bytes32 queryId => bool processed))) private
        processedQueries;

    constructor(INativeQueryVerifier verifier_, IRecourseFacility facility_) {
        verifier = verifier_;
        facility = facility_;
    }

    function registerCovenant(uint256 facilityId, uint256 covenantId, ICovenant covenant) external {
        IRecourseFacility.Facility memory facilityData = facility.facilityOf(facilityId);
        if (msg.sender != facilityData.lender) revert NotLender();
        if (facilityData.state != FacilityState.Created) {
            revert WrongState(FacilityState.Created, facilityData.state);
        }
        if (address(covenant) == address(0)) revert ZeroAmount();
        if (address(covenants[facilityId][covenantId]) != address(0)) revert CovenantAlreadyRegistered();

        covenants[facilityId][covenantId] = covenant;
    }

    function covenantOf(uint256 facilityId, uint256 covenantId) external view returns (ICovenant) {
        return covenants[facilityId][covenantId];
    }

    function submitBatch(
        uint256 facilityId,
        uint256 covenantId,
        uint64 chainKey,
        uint64[] calldata heights,
        bytes[] calldata encodedTransactions,
        INativeQueryVerifier.MerkleProof[] calldata merkleProofs,
        INativeQueryVerifier.ContinuityProof calldata sharedContinuityProof
    ) external nonReentrant {
        if (!verifier.verify(chainKey, heights, encodedTransactions, merkleProofs, sharedContinuityProof)) {
            revert VerificationFailed();
        }

        ICovenant covenant = _activeCovenant(facilityId, covenantId);
        uint256 length = encodedTransactions.length;
        ProvenTx[] memory proven = new ProvenTx[](length);
        bytes32[] memory queryIds = new bytes32[](length);

        for (uint256 i; i < length; ++i) {
            EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransactions[i]);
            if (receipt.receiptStatus != 1) revert TransactionReverted();

            uint64 txIndex = verifier.calculateTxIndex(merkleProofs[i]);
            bytes32 qid = queryId(chainKey, heights[i], txIndex);
            if (processedQueries[facilityId][covenantId][qid]) revert ProofAlreadyUsed(qid);
            for (uint256 j; j < i; ++j) {
                if (queryIds[j] == qid) revert ProofAlreadyUsed(qid);
            }

            queryIds[i] = qid;
            proven[i] = ProvenTx({
                chainKey: chainKey,
                blockHeight: heights[i],
                txIndex: txIndex,
                encodedTransaction: encodedTransactions[i]
            });
        }

        bool breached = covenant.evaluate(facilityId, proven);

        for (uint256 i; i < length; ++i) {
            processedQueries[facilityId][covenantId][queryIds[i]] = true;
            emit EvidenceAccepted(facilityId, covenantId, queryIds[i], msg.sender);
        }

        if (breached) {
            facility.reportBreach(facilityId, msg.sender);
            emit BreachReported(facilityId, covenantId, msg.sender);
        }
    }

    function submitSingle(
        uint256 facilityId,
        uint256 covenantId,
        uint64 chainKey,
        uint64 height,
        bytes calldata encodedTransaction,
        INativeQueryVerifier.MerkleProof calldata merkleProof,
        INativeQueryVerifier.ContinuityProof calldata continuityProof
    ) external nonReentrant {
        if (!verifier.verify(chainKey, height, encodedTransaction, merkleProof, continuityProof)) {
            revert VerificationFailed();
        }

        ICovenant covenant = _activeCovenant(facilityId, covenantId);
        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
        if (receipt.receiptStatus != 1) revert TransactionReverted();

        uint64 txIndex = verifier.calculateTxIndex(merkleProof);
        bytes32 qid = queryId(chainKey, height, txIndex);
        if (processedQueries[facilityId][covenantId][qid]) revert ProofAlreadyUsed(qid);

        ProvenTx[] memory proven = new ProvenTx[](1);
        proven[0] = ProvenTx({
            chainKey: chainKey, blockHeight: height, txIndex: txIndex, encodedTransaction: encodedTransaction
        });
        bool breached = covenant.evaluate(facilityId, proven);

        processedQueries[facilityId][covenantId][qid] = true;
        emit EvidenceAccepted(facilityId, covenantId, qid, msg.sender);

        if (breached) {
            facility.reportBreach(facilityId, msg.sender);
            emit BreachReported(facilityId, covenantId, msg.sender);
        }
    }

    function queryId(uint64 chainKey, uint64 blockHeight, uint64 txIndex) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(chainKey, blockHeight, txIndex));
    }

    function isProcessed(uint256 facilityId, uint256 covenantId, bytes32 qid) external view returns (bool) {
        return processedQueries[facilityId][covenantId][qid];
    }

    function _activeCovenant(uint256 facilityId, uint256 covenantId) private view returns (ICovenant covenant) {
        covenant = covenants[facilityId][covenantId];
        if (address(covenant) == address(0)) revert CovenantNotRegistered();

        FacilityState actual = facility.state(facilityId);
        if (actual != FacilityState.Active) revert WrongState(FacilityState.Active, actual);
    }
}
