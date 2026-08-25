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

contract OutflowCapCovenant is ICovenant {
    error CovenantAlreadyConfigured();
    error CovenantNotConfigured();

    bytes32 internal constant TRANSFER_SIG = keccak256("Transfer(address,address,uint256)");

    struct Configuration {
        uint64 chainKey;
        address token;
        address treasury;
        uint64 startSourceBlock;
        uint64 endSourceBlock;
        uint256 capBaseUnits;
        bool configured;
    }

    IRecourseFacility public immutable facility;

    mapping(uint256 facilityId => Configuration configuration) private configurations;
    mapping(uint256 facilityId => uint256 amount) public accumulated;
    mapping(uint256 facilityId => mapping(bytes32 queryId => bool processed)) private processedQueries;

    constructor(IRecourseFacility facility_) {
        facility = facility_;
    }

    function configure(
        uint256 facilityId,
        uint64 chainKey,
        address token,
        address treasury,
        uint64 startSourceBlock,
        uint64 endSourceBlock,
        uint256 capBaseUnits
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
            token: token,
            treasury: treasury,
            startSourceBlock: startSourceBlock,
            endSourceBlock: endSourceBlock,
            capBaseUnits: capBaseUnits,
            configured: true
        });
    }

    function evaluate(uint256 facilityId, ProvenTx[] calldata proven) external returns (bool breached) {
        if (msg.sender != facility.adjudicator()) revert NotAdjudicator();

        Configuration memory configuration = configurations[facilityId];
        if (!configuration.configured) revert CovenantNotConfigured();

        bool relevant;
        uint256 batchOutflow;
        uint256 transactionCount = proven.length;

        for (uint256 i; i < transactionCount; ++i) {
            ProvenTx calldata provenTx = proven[i];
            if (
                provenTx.chainKey != configuration.chainKey || provenTx.blockHeight < configuration.startSourceBlock
                    || provenTx.blockHeight > configuration.endSourceBlock
            ) continue;

            bytes32 queryId = keccak256(abi.encodePacked(provenTx.chainKey, provenTx.blockHeight, provenTx.txIndex));
            if (processedQueries[facilityId][queryId]) revert ProofAlreadyUsed(queryId);

            EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(provenTx.encodedTransaction);
            if (receipt.receiptStatus != 1) revert TransactionReverted();

            bool transactionRelevant;
            uint256 logCount = receipt.receiptLogs.length;
            for (uint256 j; j < logCount; ++j) {
                EvmV1Decoder.LogEntry memory logEntry = receipt.receiptLogs[j];
                if (
                    logEntry.address_ != configuration.token || logEntry.topics.length != 3
                        || logEntry.data.length != 32 || logEntry.topics[0] != TRANSFER_SIG
                ) continue;

                address from = address(uint160(uint256(logEntry.topics[1])));
                address to = address(uint160(uint256(logEntry.topics[2])));
                if (from != configuration.treasury || to == configuration.treasury) continue;

                transactionRelevant = true;
                relevant = true;
                uint256 value = abi.decode(logEntry.data, (uint256));
                if (value > type(uint256).max - batchOutflow) return true;
                batchOutflow += value;
            }

            if (transactionRelevant) processedQueries[facilityId][queryId] = true;
        }

        if (!relevant) revert IrrelevantEvidence();

        uint256 previous = accumulated[facilityId];
        if (batchOutflow > type(uint256).max - previous) return true;
        uint256 total = previous + batchOutflow;
        accumulated[facilityId] = total;
        return total > configuration.capBaseUnits;
    }

    function covenantKind() external pure returns (string memory) {
        return "outflow-cap";
    }
}
