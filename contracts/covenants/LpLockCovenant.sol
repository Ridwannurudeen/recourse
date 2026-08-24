// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/write-ability/common/EvmV1Decoder.sol";
import {ICovenant} from "../interfaces/ICovenant.sol";
import {IRecourseFacility} from "../interfaces/IRecourseFacility.sol";
import {
    FacilityState,
    IrrelevantEvidence,
    NotAdjudicator,
    NotLender,
    ProofAlreadyUsed,
    ProvenTx,
    TransactionReverted,
    WrongState
} from "../types/RecourseTypes.sol";

contract LpLockCovenant is ICovenant {
    error CovenantAlreadyConfigured();
    error CovenantNotConfigured();

    // Uniswap V3 INonfungiblePositionManager ABI (official repository, commit 0682387):
    // https://github.com/Uniswap/v3-periphery/blob/0682387198a24c7cd63566a2c58398533860a5d1/contracts/interfaces/INonfungiblePositionManager.sol#L30-L36
    // Canonical signature: DecreaseLiquidity(uint256,uint128,uint256,uint256)
    bytes32 internal constant DECREASE_LIQUIDITY_SIG = keccak256("DecreaseLiquidity(uint256,uint128,uint256,uint256)");

    struct Configuration {
        uint64 chainKey;
        address positionManager;
        uint256 tokenId;
        uint64 startSourceBlock;
        uint64 endSourceBlock;
        bool configured;
    }

    IRecourseFacility public immutable facility;

    mapping(uint256 facilityId => Configuration configuration) private configurations;
    mapping(uint256 facilityId => mapping(bytes32 queryId => bool processed)) private processedQueries;

    constructor(IRecourseFacility facility_) {
        facility = facility_;
    }

    function configure(
        uint256 facilityId,
        uint64 chainKey,
        address positionManager,
        uint256 tokenId,
        uint64 startSourceBlock,
        uint64 endSourceBlock
    ) external {
        IRecourseFacility.Facility memory facilityData = facility.facilityOf(facilityId);
        if (msg.sender != facilityData.lender) revert NotLender();
        if (facilityData.state != FacilityState.Created) {
            revert WrongState(FacilityState.Created, facilityData.state);
        }

        Configuration storage configuration = configurations[facilityId];
        if (configuration.configured) revert CovenantAlreadyConfigured();

        configurations[facilityId] = Configuration({
            chainKey: chainKey,
            positionManager: positionManager,
            tokenId: tokenId,
            startSourceBlock: startSourceBlock,
            endSourceBlock: endSourceBlock,
            configured: true
        });
    }

    function evaluate(uint256 facilityId, ProvenTx[] calldata proven) external returns (bool breached) {
        if (msg.sender != facility.adjudicator()) revert NotAdjudicator();

        Configuration memory configuration = configurations[facilityId];
        if (!configuration.configured) revert CovenantNotConfigured();

        bool relevant;
        uint256 transactionCount = proven.length;

        for (uint256 i; i < transactionCount; ++i) {
            ProvenTx calldata provenTx = proven[i];
            if (
                provenTx.chainKey != configuration.chainKey || provenTx.blockHeight < configuration.startSourceBlock
                    || provenTx.blockHeight >= configuration.endSourceBlock
            ) continue;

            bytes32 queryId = keccak256(abi.encodePacked(provenTx.chainKey, provenTx.blockHeight, provenTx.txIndex));
            if (processedQueries[facilityId][queryId]) revert ProofAlreadyUsed(queryId);

            EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(provenTx.encodedTransaction);
            if (receipt.receiptStatus != 1) revert TransactionReverted();

            uint256 logCount = receipt.receiptLogs.length;
            for (uint256 j; j < logCount; ++j) {
                EvmV1Decoder.LogEntry memory logEntry = receipt.receiptLogs[j];
                if (
                    logEntry.address_ != configuration.positionManager || logEntry.topics.length != 2
                        || logEntry.data.length != 96 || logEntry.topics[0] != DECREASE_LIQUIDITY_SIG
                ) continue;

                if (uint256(logEntry.topics[1]) != configuration.tokenId) continue;

                relevant = true;
                processedQueries[facilityId][queryId] = true;
                break;
            }
        }

        if (!relevant) revert IrrelevantEvidence();
        return true;
    }

    function covenantKind() external pure returns (string memory) {
        return "lp-lock";
    }
}
