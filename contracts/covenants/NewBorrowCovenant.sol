// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/write-ability/common/EvmV1Decoder.sol";
import {ICovenant, ICovenantRegistry} from "../interfaces/ICovenant.sol";
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

contract NewBorrowCovenant is ICovenant {
    error CovenantAlreadyConfigured();
    error CovenantAlreadyRegistered();
    error CovenantNotConfigured();

    // Aave V3 IPool ABI (official repository, commit 782f519):
    // https://github.com/aave/aave-v3-core/blob/782f51917056a53a2c228701058a6c3fb233684a/contracts/interfaces/IPool.sol#L74-L82
    // Canonical signature: Borrow(address,address,address,uint256,uint8,uint256,uint16)
    bytes32 internal constant BORROW_SIG = keccak256("Borrow(address,address,address,uint256,uint8,uint256,uint16)");

    struct Configuration {
        uint64 chainKey;
        address aavePool;
        address borrower;
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
        address aavePool,
        address borrower,
        uint64 startSourceBlock,
        uint64 endSourceBlock
    ) external {
        IRecourseFacility.Facility memory facilityData = facility.facilityOf(facilityId);
        if (msg.sender != facilityData.lender) revert NotLender();
        if (facilityData.state != FacilityState.Created) {
            revert WrongState(FacilityState.Created, facilityData.state);
        }
        if (ICovenantRegistry(facility.adjudicator()).isCovenantRegistered(facilityId, address(this))) {
            revert CovenantAlreadyRegistered();
        }

        Configuration storage configuration = configurations[facilityId];
        if (configuration.configured) revert CovenantAlreadyConfigured();

        configurations[facilityId] = Configuration({
            chainKey: chainKey,
            aavePool: aavePool,
            borrower: borrower,
            startSourceBlock: startSourceBlock,
            endSourceBlock: endSourceBlock,
            configured: true
        });
    }

    function configHash(uint256 facilityId) external view returns (bytes32) {
        Configuration memory configuration = configurations[facilityId];
        if (!configuration.configured) return bytes32(0);
        return keccak256(
            abi.encode(
                configuration.chainKey,
                configuration.aavePool,
                configuration.borrower,
                configuration.startSourceBlock,
                configuration.endSourceBlock
            )
        );
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
                    || provenTx.blockHeight > configuration.endSourceBlock
            ) continue;

            bytes32 queryId = keccak256(abi.encodePacked(provenTx.chainKey, provenTx.blockHeight, provenTx.txIndex));
            if (processedQueries[facilityId][queryId]) revert ProofAlreadyUsed(queryId);

            EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(provenTx.encodedTransaction);
            if (receipt.receiptStatus != 1) revert TransactionReverted();

            uint256 logCount = receipt.receiptLogs.length;
            for (uint256 j; j < logCount; ++j) {
                EvmV1Decoder.LogEntry memory logEntry = receipt.receiptLogs[j];
                if (
                    logEntry.address_ != configuration.aavePool || logEntry.topics.length != 4
                        || logEntry.data.length != 128 || logEntry.topics[0] != BORROW_SIG
                ) continue;

                address onBehalfOf = address(uint160(uint256(logEntry.topics[2])));
                if (onBehalfOf != configuration.borrower) continue;

                relevant = true;
                processedQueries[facilityId][queryId] = true;
                break;
            }
        }

        if (!relevant) revert IrrelevantEvidence();
        return true;
    }

    function covenantKind() external pure returns (string memory) {
        return "new-borrow";
    }
}
