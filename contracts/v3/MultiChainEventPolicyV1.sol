// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/write-ability/common/EvmV1Decoder.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
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

contract MultiChainEventPolicyV1 is IPolicyEvaluatorV1 {
    uint256 public constant MAXIMUM_RULES = 16;

    struct Rule {
        uint64 sourceChain;
        address emitter;
        bytes32 eventSignature;
        uint64 startSourceBlock;
        uint64 endSourceBlock;
        uint8 topicCount;
        uint8 subjectTopicIndex;
        uint16 dataLength;
        uint16 observedValueOffset;
        ObservationKind observationKind;
        uint32 riskWeight;
    }

    struct Configuration {
        address subject;
        uint64 freshnessPeriod;
        uint32 watchThreshold;
        uint32 restrictedThreshold;
        uint32 marginThreshold;
        uint32 breachThreshold;
        PolicyEffect watchEffect;
        PolicyEffect restrictedEffect;
        PolicyEffect marginEffect;
        PolicyEffect breachEffect;
        Rule[] rules;
    }

    error InvalidConfiguration();
    error IrrelevantEvidence();
    error NotKernel();
    error NotLender();
    error PolicyAlreadyConfigured();
    error PolicyAlreadyRegistered();
    error PolicyNotConfigured();
    error TransactionReverted();
    error WrongTransactionCount();
    error ZeroAddress();

    event PolicyConfigured(address indexed facility, uint256 indexed policyId, bytes32 indexed configurationHash);
    event RiskAccumulated(
        address indexed facility,
        uint256 indexed policyId,
        uint256 indexed ruleIndex,
        uint32 priorScore,
        uint32 newScore
    );

    IPolicyConfigurationContextV1 public immutable context;

    mapping(address facility => mapping(uint256 policyId => Configuration configuration)) private configurations;
    mapping(address facility => mapping(uint256 policyId => bool configured)) private configuredPolicies;
    mapping(address facility => mapping(uint256 policyId => uint32 score)) public riskScore;

    constructor(IPolicyConfigurationContextV1 context_) {
        if (address(context_) == address(0)) revert ZeroAddress();
        context = context_;
    }

    function configure(address facility, uint256 policyId, Configuration calldata configuration) external {
        if (msg.sender != context.lenderOf(facility)) revert NotLender();
        if (context.isPolicyRegistered(facility, policyId)) revert PolicyAlreadyRegistered();
        if (configuredPolicies[facility][policyId]) revert PolicyAlreadyConfigured();
        if (!_valid(configuration)) revert InvalidConfiguration();

        Configuration storage stored = configurations[facility][policyId];
        stored.subject = configuration.subject;
        stored.freshnessPeriod = configuration.freshnessPeriod;
        stored.watchThreshold = configuration.watchThreshold;
        stored.restrictedThreshold = configuration.restrictedThreshold;
        stored.marginThreshold = configuration.marginThreshold;
        stored.breachThreshold = configuration.breachThreshold;
        stored.watchEffect = configuration.watchEffect;
        stored.restrictedEffect = configuration.restrictedEffect;
        stored.marginEffect = configuration.marginEffect;
        stored.breachEffect = configuration.breachEffect;
        uint256 ruleCount = configuration.rules.length;
        for (uint256 i; i < ruleCount; ++i) {
            stored.rules.push(configuration.rules[i]);
        }
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
        Configuration storage configuration = configurations[facility][policyId];

        uint256 firstMatchedRule = type(uint256).max;
        uint256 matchedRuleCount;
        uint256 observedValue;
        uint32 newScore = riskScore[facility][policyId];
        uint256 ruleCount = configuration.rules.length;
        for (uint256 i; i < ruleCount; ++i) {
            (uint256 count, uint256 value) = _match(transaction, receipt, configuration.subject, configuration.rules[i]);
            if (count == 0) continue;
            if (firstMatchedRule == type(uint256).max) firstMatchedRule = i;
            ++matchedRuleCount;
            observedValue = _saturatingAdd(observedValue, value);

            uint32 priorScore = newScore;
            newScore = _saturatingRiskAdd(priorScore, configuration.rules[i].riskWeight, count);
            emit RiskAccumulated(facility, policyId, i, priorScore, newScore);
        }
        if (firstMatchedRule == type(uint256).max) revert IrrelevantEvidence();

        riskScore[facility][policyId] = newScore;
        Rule storage firstRule = configuration.rules[firstMatchedRule];
        bool aggregate = matchedRuleCount > 1;

        return PolicyResult({
            effect: _effect(configuration, newScore),
            observationKind: aggregate ? ObservationKind.Behaviour : firstRule.observationKind,
            evidenceKind: EvidenceKind.EventDelta,
            sourceBlock: transaction.blockHeight,
            transactionIndex: transaction.txIndex,
            subject: configuration.subject,
            emitter: aggregate ? address(this) : firstRule.emitter,
            observedValue: observedValue,
            freshnessPeriod: configuration.freshnessPeriod
        });
    }

    function configurationOf(address facility, uint256 policyId) public view returns (Configuration memory output) {
        Configuration storage stored = configurations[facility][policyId];
        output.subject = stored.subject;
        output.freshnessPeriod = stored.freshnessPeriod;
        output.watchThreshold = stored.watchThreshold;
        output.restrictedThreshold = stored.restrictedThreshold;
        output.marginThreshold = stored.marginThreshold;
        output.breachThreshold = stored.breachThreshold;
        output.watchEffect = stored.watchEffect;
        output.restrictedEffect = stored.restrictedEffect;
        output.marginEffect = stored.marginEffect;
        output.breachEffect = stored.breachEffect;
        uint256 ruleCount = stored.rules.length;
        output.rules = new Rule[](ruleCount);
        for (uint256 i; i < ruleCount; ++i) {
            output.rules[i] = stored.rules[i];
        }
    }

    function isConfigured(address facility, uint256 policyId) external view returns (bool) {
        return configuredPolicies[facility][policyId];
    }

    function configHash(address facility, uint256 policyId) external view returns (bytes32) {
        if (!configuredPolicies[facility][policyId]) return bytes32(0);
        return keccak256(abi.encode(configurationOf(facility, policyId)));
    }

    function manifest(address facility, uint256 policyId) external view returns (bytes memory) {
        if (!configuredPolicies[facility][policyId]) return bytes("");
        return abi.encode(configurationOf(facility, policyId));
    }

    function policyKind() external pure returns (string memory) {
        return "multi-chain-event-v1";
    }

    function _match(
        ProvenTransaction calldata transaction,
        EvmV1Decoder.ReceiptFields memory receipt,
        address subject,
        Rule storage rule
    ) private view returns (uint256 count, uint256 observedValue) {
        if (
            transaction.chainKey != rule.sourceChain || transaction.blockHeight < rule.startSourceBlock
                || transaction.blockHeight > rule.endSourceBlock
        ) return (0, 0);
        uint256 logCount = receipt.receiptLogs.length;
        for (uint256 i; i < logCount; ++i) {
            EvmV1Decoder.LogEntry memory entry = receipt.receiptLogs[i];
            if (
                entry.address_ != rule.emitter || entry.topics.length != rule.topicCount
                    || entry.topics[0] != rule.eventSignature || entry.data.length != rule.dataLength
            ) continue;
            bytes32 subjectTopic = entry.topics[rule.subjectTopicIndex];
            if (uint256(subjectTopic) >> 160 != 0 || address(uint160(uint256(subjectTopic))) != subject) continue;
            ++count;
            observedValue = _saturatingAdd(observedValue, _wordAt(entry.data, rule.observedValueOffset));
        }
    }

    function _effect(Configuration storage configuration, uint32 score) private view returns (PolicyEffect memory) {
        if (score >= configuration.breachThreshold) return configuration.breachEffect;
        if (score >= configuration.marginThreshold) return configuration.marginEffect;
        if (score >= configuration.restrictedThreshold) return configuration.restrictedEffect;
        return configuration.watchEffect;
    }

    function _valid(Configuration calldata configuration) private pure returns (bool) {
        uint256 ruleCount = configuration.rules.length;
        if (
            configuration.subject == address(0) || configuration.freshnessPeriod == 0 || ruleCount == 0
                || ruleCount > MAXIMUM_RULES || configuration.watchThreshold == 0
                || configuration.watchThreshold >= configuration.restrictedThreshold
                || configuration.restrictedThreshold >= configuration.marginThreshold
                || configuration.marginThreshold >= configuration.breachThreshold || !_validEffects(configuration)
        ) return false;
        for (uint256 i; i < ruleCount; ++i) {
            Rule calldata rule = configuration.rules[i];
            if (!_validRule(rule) || rule.riskWeight < configuration.watchThreshold) return false;
            for (uint256 j; j < i; ++j) {
                if (_predicatesOverlap(configuration.rules[j], rule)) return false;
            }
        }
        return true;
    }

    function _validRule(Rule calldata rule) private pure returns (bool) {
        return rule.sourceChain > 0 && rule.emitter != address(0) && rule.eventSignature != bytes32(0)
            && rule.startSourceBlock <= rule.endSourceBlock && rule.topicCount > 1 && rule.topicCount <= 4
            && rule.subjectTopicIndex > 0 && rule.subjectTopicIndex < rule.topicCount && rule.dataLength > 0
            && rule.dataLength % 32 == 0 && rule.observedValueOffset % 32 == 0
            && uint256(rule.observedValueOffset) + 32 <= rule.dataLength && rule.riskWeight > 0;
    }

    function _validEffects(Configuration calldata configuration) private pure returns (bool) {
        PolicyEffect calldata watchEffect = configuration.watchEffect;
        PolicyEffect calldata restrictedEffect = configuration.restrictedEffect;
        PolicyEffect calldata marginEffect = configuration.marginEffect;
        PolicyEffect calldata breachEffect = configuration.breachEffect;
        return watchEffect.outcome == PolicyOutcome.Watch && restrictedEffect.outcome == PolicyOutcome.Restricted
            && marginEffect.outcome == PolicyOutcome.MarginCalled && breachEffect.outcome == PolicyOutcome.Breached
            && watchEffect.creditLimitBps <= 10_000 && restrictedEffect.creditLimitBps <= watchEffect.creditLimitBps
            && marginEffect.creditLimitBps <= restrictedEffect.creditLimitBps
            && breachEffect.creditLimitBps <= marginEffect.creditLimitBps
            && watchEffect.futureDrawFeeBps <= restrictedEffect.futureDrawFeeBps
            && restrictedEffect.futureDrawFeeBps <= marginEffect.futureDrawFeeBps
            && marginEffect.futureDrawFeeBps <= breachEffect.futureDrawFeeBps && breachEffect.futureDrawFeeBps <= 10_000
            && !watchEffect.terminate && !restrictedEffect.terminate
            && (!watchEffect.freezePendingDraw || restrictedEffect.freezePendingDraw)
            && (!restrictedEffect.freezePendingDraw || marginEffect.freezePendingDraw)
            && (!marginEffect.freezePendingDraw || breachEffect.freezePendingDraw)
            && (!watchEffect.requireFreshEvidence || restrictedEffect.requireFreshEvidence)
            && (!restrictedEffect.requireFreshEvidence || marginEffect.requireFreshEvidence)
            && (!marginEffect.requireFreshEvidence || breachEffect.requireFreshEvidence)
            && (!marginEffect.terminate || breachEffect.terminate);
    }

    function _predicatesOverlap(Rule calldata first, Rule calldata second) private pure returns (bool) {
        return first.sourceChain == second.sourceChain && first.emitter == second.emitter
            && first.eventSignature == second.eventSignature && first.topicCount == second.topicCount
            && first.subjectTopicIndex == second.subjectTopicIndex && first.dataLength == second.dataLength
            && first.startSourceBlock <= second.endSourceBlock && second.startSourceBlock <= first.endSourceBlock;
    }

    function _saturatingRiskAdd(uint32 score, uint32 weight, uint256 count) private pure returns (uint32) {
        uint256 remaining = type(uint32).max - uint256(score);
        if (count > remaining / weight) return type(uint32).max;
        return SafeCast.toUint32(uint256(score) + uint256(weight) * count);
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
