// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/write-ability/common/EvmV1Decoder.sol";
import {IPolicyConfigurationContextV1} from "../interfaces/IPolicyConfigurationContextV1.sol";
import {IPolicyEvaluatorV1} from "../interfaces/IPolicyEvaluatorV1.sol";
import {
    EvidenceKind,
    ObservationKind,
    PolicyEffect,
    PolicyOutcome,
    PolicyResult,
    ProvenTransaction
} from "../types/RecourseTypesV2.sol";

contract EventHistoryPolicyV1 is IPolicyEvaluatorV1 {
    error InvalidConfiguration();
    error IrrelevantEvidence();
    error NotKernel();
    error NotLender();
    error PolicyAlreadyConfigured();
    error PolicyAlreadyRegistered();
    error PolicyNotConfigured();
    error TransactionReverted();
    error WrongTransactionCount();
    error ZeroContext();

    struct Configuration {
        uint64 sourceChain;
        address emitter;
        bytes32 eventSignature;
        address subject;
        uint64 startSourceBlock;
        uint64 endSourceBlock;
        uint8 topicCount;
        uint8 subjectTopicIndex;
        uint16 dataLength;
        uint16 observedValueOffset;
        ObservationKind observationKind;
        EvidenceKind evidenceKind;
        uint64 freshnessPeriod;
        PolicyEffect effect;
    }

    event PolicyConfigured(address indexed facility, uint256 indexed policyId, bytes32 indexed configurationHash);

    IPolicyConfigurationContextV1 public immutable context;

    mapping(address facility => mapping(uint256 policyId => Configuration configuration)) private configurations;
    mapping(address facility => mapping(uint256 policyId => bool configured)) private configuredPolicies;

    constructor(IPolicyConfigurationContextV1 context_) {
        if (address(context_) == address(0)) revert ZeroContext();
        context = context_;
    }

    function configure(address facility, uint256 policyId, Configuration calldata configuration) external {
        if (msg.sender != context.lenderOf(facility)) revert NotLender();
        if (context.isPolicyRegistered(facility, policyId)) revert PolicyAlreadyRegistered();
        if (configuredPolicies[facility][policyId]) revert PolicyAlreadyConfigured();
        if (!_valid(configuration)) revert InvalidConfiguration();

        configurations[facility][policyId] = configuration;
        configuredPolicies[facility][policyId] = true;
        emit PolicyConfigured(facility, policyId, keccak256(abi.encode(configuration)));
    }

    function evaluate(address facility, uint256 policyId, ProvenTransaction[] calldata proven)
        external
        view
        returns (PolicyResult memory result)
    {
        if (msg.sender != address(context)) revert NotKernel();
        if (!configuredPolicies[facility][policyId]) revert PolicyNotConfigured();
        if (proven.length != 1) revert WrongTransactionCount();

        Configuration memory configuration = configurations[facility][policyId];
        ProvenTransaction calldata provenTransaction = proven[0];
        if (
            provenTransaction.chainKey != configuration.sourceChain
                || provenTransaction.blockHeight < configuration.startSourceBlock
                || provenTransaction.blockHeight > configuration.endSourceBlock
        ) revert IrrelevantEvidence();

        EvmV1Decoder.ReceiptFields memory receipt =
            EvmV1Decoder.decodeReceiptFields(provenTransaction.encodedTransaction);
        if (receipt.receiptStatus != 1) revert TransactionReverted();

        bool relevant;
        uint256 observedValue;
        uint256 logCount = receipt.receiptLogs.length;
        for (uint256 i; i < logCount; ++i) {
            EvmV1Decoder.LogEntry memory logEntry = receipt.receiptLogs[i];
            if (
                logEntry.address_ != configuration.emitter || logEntry.topics.length != configuration.topicCount
                    || logEntry.topics[0] != configuration.eventSignature
                    || logEntry.data.length != configuration.dataLength
            ) continue;

            bytes32 subjectTopic = logEntry.topics[configuration.subjectTopicIndex];
            if (uint256(subjectTopic) >> 160 != 0 || address(uint160(uint256(subjectTopic))) != configuration.subject) {
                continue;
            }

            relevant = true;
            observedValue = _saturatingAdd(observedValue, _wordAt(logEntry.data, configuration.observedValueOffset));
        }

        if (!relevant) revert IrrelevantEvidence();
        return PolicyResult({
            effect: configuration.effect,
            observationKind: configuration.observationKind,
            evidenceKind: configuration.evidenceKind,
            sourceBlock: provenTransaction.blockHeight,
            transactionIndex: provenTransaction.txIndex,
            subject: configuration.subject,
            emitter: configuration.emitter,
            observedValue: observedValue,
            freshnessPeriod: configuration.freshnessPeriod
        });
    }

    function isConfigured(address facility, uint256 policyId) external view returns (bool) {
        return configuredPolicies[facility][policyId];
    }

    function configurationOf(address facility, uint256 policyId)
        external
        view
        returns (Configuration memory configuration)
    {
        return configurations[facility][policyId];
    }

    function configHash(address facility, uint256 policyId) external view returns (bytes32) {
        if (!configuredPolicies[facility][policyId]) return bytes32(0);
        return keccak256(abi.encode(configurations[facility][policyId]));
    }

    function manifest(address facility, uint256 policyId) external view returns (bytes memory) {
        if (!configuredPolicies[facility][policyId]) return bytes("");
        return abi.encode(configurations[facility][policyId]);
    }

    function policyKind() external pure returns (string memory) {
        return "event-history-v1";
    }

    function _valid(Configuration calldata configuration) private pure returns (bool) {
        return configuration.sourceChain != 0 && configuration.emitter != address(0)
            && configuration.eventSignature != bytes32(0) && configuration.subject != address(0)
            && configuration.startSourceBlock <= configuration.endSourceBlock && configuration.topicCount > 1
            && configuration.topicCount <= 4 && configuration.subjectTopicIndex > 0
            && configuration.subjectTopicIndex < configuration.topicCount && configuration.dataLength > 0
            && configuration.dataLength % 32 == 0 && configuration.observedValueOffset % 32 == 0
            && uint256(configuration.observedValueOffset) + 32 <= configuration.dataLength
            && configuration.evidenceKind != EvidenceKind.TransactionControl && configuration.freshnessPeriod > 0
            && configuration.effect.outcome != PolicyOutcome.Eligible
            && configuration.effect.outcome != PolicyOutcome.Cured && configuration.effect.creditLimitBps <= 10_000
            && configuration.effect.futureDrawFeeBps <= 10_000;
    }

    function _saturatingAdd(uint256 first, uint256 second) private pure returns (uint256) {
        if (second > type(uint256).max - first) return type(uint256).max;
        return first + second;
    }

    function _wordAt(bytes memory data, uint256 offset) private pure returns (uint256 value) {
        assembly ("memory-safe") {
            value := mload(add(add(data, 32), offset))
        }
    }
}
