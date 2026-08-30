// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/write-ability/common/EvmV1Decoder.sol";
import {IPolicyConfigurationContextV1} from "../v2/interfaces/IPolicyConfigurationContextV1.sol";
import {IPolicyEvaluatorV1} from "../v2/interfaces/IPolicyEvaluatorV1.sol";
import {
    EvidenceKind,
    ObservationKind,
    PolicyEffect,
    PolicyOutcome,
    PolicyResult,
    ProvenTransaction
} from "../v2/types/RecourseTypesV2.sol";
import {IRemedyCoordinatorV1} from "./interfaces/IRemedyCoordinatorV1.sol";

contract ClosedLoopPolicyV1 is IPolicyEvaluatorV1 {
    struct EventRule {
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
    }

    struct CureRule {
        EventRule eventRule;
        uint8 intentTopicIndex;
        uint16 actionDigestOffset;
    }

    struct Configuration {
        EventRule adverseRule;
        CureRule cureRule;
        ObservationKind observationKind;
        uint64 freshnessPeriod;
        uint64 remedyDuration;
        uint64 destinationChain;
        address receiver;
        address target;
        bytes32 actionKind;
        bytes32 actionDataHash;
        PolicyEffect adverseEffect;
        PolicyEffect cureEffect;
    }

    error AmbiguousEvidence();
    error InvalidConfiguration();
    error IrrelevantEvidence();
    error NotKernel();
    error NotLender();
    error PolicyAlreadyConfigured();
    error PolicyAlreadyRegistered();
    error PolicyNotConfigured();
    error RemedyNotAcknowledged();
    error RemedyPending();
    error TransactionReverted();
    error WrongTransactionCount();
    error ZeroAddress();

    event PolicyConfigured(address indexed facility, uint256 indexed policyId, bytes32 indexed configurationHash);
    event RemedyIntentLinked(address indexed facility, uint256 indexed policyId, bytes32 indexed intentId);

    IPolicyConfigurationContextV1 public immutable context;
    IRemedyCoordinatorV1 public immutable coordinator;

    mapping(address facility => mapping(uint256 policyId => Configuration configuration)) private configurations;
    mapping(address facility => mapping(uint256 policyId => bool configured)) private configuredPolicies;
    mapping(address facility => mapping(uint256 policyId => bytes32 intentId)) public latestIntent;

    constructor(IPolicyConfigurationContextV1 context_, IRemedyCoordinatorV1 coordinator_) {
        if (address(context_) == address(0) || address(coordinator_) == address(0)) revert ZeroAddress();
        context = context_;
        coordinator = coordinator_;
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
        returns (PolicyResult memory result)
    {
        if (msg.sender != address(context)) revert NotKernel();
        if (!configuredPolicies[facility][policyId]) revert PolicyNotConfigured();
        if (proven.length != 1) revert WrongTransactionCount();
        ProvenTransaction calldata transaction = proven[0];
        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(transaction.encodedTransaction);
        if (receipt.receiptStatus != 1) revert TransactionReverted();

        Configuration memory configuration = configurations[facility][policyId];
        (bool adverse, uint256 adverseValue) = _matchBasic(transaction, receipt, configuration.adverseRule);
        bytes32 currentIntent = latestIntent[facility][policyId];
        (bool cure, uint256 cureValue) = _matchCure(transaction, receipt, configuration.cureRule, currentIntent);
        if (adverse && cure) revert AmbiguousEvidence();
        if (!adverse && !cure) revert IrrelevantEvidence();

        bytes32 evidenceDigest = keccak256(
            abi.encode(
                transaction.chainKey, transaction.blockHeight, transaction.txIndex, transaction.encodedTransaction
            )
        );
        if (adverse) {
            if (currentIntent != bytes32(0)) {
                IRemedyCoordinatorV1.IntentStatus status = coordinator.intentStatus(currentIntent);
                if (
                    status != IRemedyCoordinatorV1.IntentStatus.Cured
                        && status != IRemedyCoordinatorV1.IntentStatus.Expired
                        && status != IRemedyCoordinatorV1.IntentStatus.Failed
                ) revert RemedyPending();
            }
            if (block.timestamp > type(uint64).max - configuration.remedyDuration) revert InvalidConfiguration();
            IRemedyCoordinatorV1.IntentRequest memory request = IRemedyCoordinatorV1.IntentRequest({
                facility: facility,
                policyId: policyId,
                adverseEvidenceDigest: evidenceDigest,
                destinationChain: configuration.destinationChain,
                receiver: configuration.receiver,
                target: configuration.target,
                actionKind: configuration.actionKind,
                actionDataHash: configuration.actionDataHash,
                expiry: uint64(block.timestamp) + configuration.remedyDuration
            });
            bytes32 intentId = coordinator.recordIntent(request);
            latestIntent[facility][policyId] = intentId;
            emit RemedyIntentLinked(facility, policyId, intentId);
            return _result(transaction, configuration, configuration.adverseEffect, adverseValue, true);
        }

        if (
            currentIntent == bytes32(0)
                || coordinator.intentStatus(currentIntent) != IRemedyCoordinatorV1.IntentStatus.Acknowledged
        ) revert RemedyNotAcknowledged();
        coordinator.recordCure(currentIntent, evidenceDigest);
        return _result(transaction, configuration, configuration.cureEffect, cureValue, false);
    }

    function configurationOf(address facility, uint256 policyId) external view returns (Configuration memory) {
        return configurations[facility][policyId];
    }

    function isConfigured(address facility, uint256 policyId) external view returns (bool) {
        return configuredPolicies[facility][policyId];
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
        return "closed-loop-v1";
    }

    function _matchBasic(
        ProvenTransaction calldata transaction,
        EvmV1Decoder.ReceiptFields memory receipt,
        EventRule memory rule
    ) private pure returns (bool matched, uint256 observedValue) {
        if (
            transaction.chainKey != rule.sourceChain || transaction.blockHeight < rule.startSourceBlock
                || transaction.blockHeight > rule.endSourceBlock
        ) return (false, 0);
        uint256 logCount = receipt.receiptLogs.length;
        for (uint256 i; i < logCount; ++i) {
            EvmV1Decoder.LogEntry memory entry = receipt.receiptLogs[i];
            if (!_matchesShape(entry, rule)) continue;
            matched = true;
            observedValue += _wordAt(entry.data, rule.observedValueOffset);
        }
    }

    function _matchCure(
        ProvenTransaction calldata transaction,
        EvmV1Decoder.ReceiptFields memory receipt,
        CureRule memory rule,
        bytes32 intentId
    ) private view returns (bool matched, uint256 observedValue) {
        if (intentId == bytes32(0)) return (false, 0);
        EventRule memory base = rule.eventRule;
        if (
            transaction.chainKey != base.sourceChain || transaction.blockHeight < base.startSourceBlock
                || transaction.blockHeight > base.endSourceBlock
        ) return (false, 0);
        bytes32 expectedActionDataHash = coordinator.intentActionDataHash(intentId);
        uint256 logCount = receipt.receiptLogs.length;
        for (uint256 i; i < logCount; ++i) {
            EvmV1Decoder.LogEntry memory entry = receipt.receiptLogs[i];
            if (!_matchesShape(entry, base) || entry.topics[rule.intentTopicIndex] != intentId) continue;
            if (bytes32(_wordAt(entry.data, rule.actionDigestOffset)) != expectedActionDataHash) continue;
            matched = true;
            observedValue += _wordAt(entry.data, base.observedValueOffset);
        }
    }

    function _matchesShape(EvmV1Decoder.LogEntry memory entry, EventRule memory rule) private pure returns (bool) {
        if (
            entry.address_ != rule.emitter || entry.topics.length != rule.topicCount
                || entry.topics[0] != rule.eventSignature || entry.data.length != rule.dataLength
        ) return false;
        bytes32 subjectTopic = entry.topics[rule.subjectTopicIndex];
        return uint256(subjectTopic) >> 160 == 0 && address(uint160(uint256(subjectTopic))) == rule.subject;
    }

    function _result(
        ProvenTransaction calldata transaction,
        Configuration memory configuration,
        PolicyEffect memory effect,
        uint256 observedValue,
        bool adverse
    ) private pure returns (PolicyResult memory) {
        EventRule memory rule = adverse ? configuration.adverseRule : configuration.cureRule.eventRule;
        return PolicyResult({
            effect: effect,
            observationKind: configuration.observationKind,
            evidenceKind: adverse ? EvidenceKind.EventDelta : EvidenceKind.EventTransition,
            sourceBlock: transaction.blockHeight,
            transactionIndex: transaction.txIndex,
            subject: rule.subject,
            emitter: rule.emitter,
            observedValue: observedValue,
            freshnessPeriod: configuration.freshnessPeriod
        });
    }

    function _valid(Configuration calldata configuration) private pure returns (bool) {
        EventRule calldata adverse = configuration.adverseRule;
        CureRule calldata cure = configuration.cureRule;
        return _validRule(adverse) && _validRule(cure.eventRule) && !_predicatesOverlap(adverse, cure.eventRule)
            && cure.intentTopicIndex > 0 && cure.intentTopicIndex < cure.eventRule.topicCount
            && cure.intentTopicIndex != cure.eventRule.subjectTopicIndex && cure.actionDigestOffset % 32 == 0
            && uint256(cure.actionDigestOffset) + 32 <= cure.eventRule.dataLength
            && cure.actionDigestOffset != cure.eventRule.observedValueOffset && configuration.freshnessPeriod > 0
            && configuration.remedyDuration > 0 && configuration.destinationChain > 0
            && configuration.receiver != address(0) && configuration.target != address(0)
            && configuration.actionKind != bytes32(0) && configuration.actionDataHash != bytes32(0)
            && _validAdverseEffect(configuration.adverseEffect) && _validCureEffect(configuration.cureEffect);
    }

    function _validRule(EventRule calldata rule) private pure returns (bool) {
        return rule.sourceChain > 0 && rule.emitter != address(0) && rule.eventSignature != bytes32(0)
            && rule.subject != address(0) && rule.startSourceBlock <= rule.endSourceBlock && rule.topicCount > 1
            && rule.topicCount <= 4 && rule.subjectTopicIndex > 0 && rule.subjectTopicIndex < rule.topicCount
            && rule.dataLength > 0 && rule.dataLength % 32 == 0 && rule.observedValueOffset % 32 == 0
            && uint256(rule.observedValueOffset) + 32 <= rule.dataLength;
    }

    function _predicatesOverlap(EventRule calldata adverse, EventRule calldata cure) private pure returns (bool) {
        return adverse.sourceChain == cure.sourceChain && adverse.emitter == cure.emitter
            && adverse.eventSignature == cure.eventSignature && adverse.subject == cure.subject
            && adverse.topicCount == cure.topicCount && adverse.subjectTopicIndex == cure.subjectTopicIndex
            && adverse.dataLength == cure.dataLength && adverse.startSourceBlock <= cure.endSourceBlock
            && cure.startSourceBlock <= adverse.endSourceBlock;
    }

    function _validAdverseEffect(PolicyEffect calldata effect) private pure returns (bool) {
        return effect.outcome != PolicyOutcome.Eligible && effect.outcome != PolicyOutcome.Cured
            && effect.creditLimitBps <= 10_000 && effect.futureDrawFeeBps <= 10_000;
    }

    function _validCureEffect(PolicyEffect calldata effect) private pure returns (bool) {
        return effect.outcome == PolicyOutcome.Cured && effect.creditLimitBps <= 10_000
            && effect.futureDrawFeeBps <= 10_000 && !effect.terminate;
    }

    function _wordAt(bytes memory data, uint256 offset) private pure returns (uint256 value) {
        assembly ("memory-safe") {
            value := mload(add(add(data, 32), offset))
        }
    }
}
