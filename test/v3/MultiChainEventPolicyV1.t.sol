// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/write-ability/common/EvmV1Decoder.sol";
import {IPolicyConfigurationContextV1} from "../../contracts/v2/interfaces/IPolicyConfigurationContextV1.sol";
import {IPolicyEvaluatorV1} from "../../contracts/v2/interfaces/IPolicyEvaluatorV1.sol";
import {
    ObservationKind,
    PolicyEffect,
    PolicyOutcome,
    PolicyResult,
    ProvenTransaction
} from "../../contracts/v2/types/RecourseTypesV2.sol";
import {MultiChainEventPolicyV1} from "../../contracts/v3/MultiChainEventPolicyV1.sol";

contract MultiChainContextMock is IPolicyConfigurationContextV1 {
    address public lender;
    bool public registered;

    function setLender(address value) external {
        lender = value;
    }

    function lenderOf(address) external view returns (address) {
        return lender;
    }

    function isPolicyRegistered(address, uint256) external view returns (bool) {
        return registered;
    }

    function evaluate(
        IPolicyEvaluatorV1 policy,
        address facility,
        uint256 policyId,
        ProvenTransaction[] calldata proven
    ) external returns (PolicyResult memory) {
        return policy.evaluate(facility, policyId, proven);
    }
}

contract MultiChainEventPolicyV1Test is Test {
    event RiskAccumulated(
        address indexed facility,
        uint256 indexed policyId,
        uint256 indexed ruleIndex,
        uint32 priorScore,
        uint32 newScore
    );

    address private constant LENDER = address(0xA1);
    address private constant FACILITY = address(0xB2);
    address private constant SUBJECT = address(0xC3);
    address private constant EMITTER_A = address(0xD4);
    address private constant EMITTER_B = address(0xE5);
    address private constant EMITTER_C = address(0xF6);
    uint256 private constant POLICY_ID = 7;
    uint64 private constant CHAIN_A = 3;
    uint64 private constant CHAIN_B = 102031;
    bytes32 private constant EVENT_SIG = keccak256("RiskIncreased(address,uint256)");

    MultiChainContextMock private context;
    MultiChainEventPolicyV1 private policy;

    function setUp() public {
        context = new MultiChainContextMock();
        context.setLender(LENDER);
        policy = new MultiChainEventPolicyV1(context);
        vm.prank(LENDER);
        policy.configure(FACILITY, POLICY_ID, _configuration());
    }

    function test_crossChainEventsAccumulateThroughConservativeRiskTiers() public {
        PolicyResult memory result = _evaluate(_proven(CHAIN_A, 101, _singleLog(EMITTER_A, 5)));
        assertEq(uint256(result.effect.outcome), uint256(PolicyOutcome.Watch));
        assertEq(policy.riskScore(FACILITY, POLICY_ID), 10);

        result = _evaluate(_proven(CHAIN_B, 50, _singleLog(EMITTER_B, 7)));
        assertEq(uint256(result.effect.outcome), uint256(PolicyOutcome.Restricted));
        assertEq(policy.riskScore(FACILITY, POLICY_ID), 25);

        result = _evaluate(_proven(CHAIN_A, 102, _singleLog(EMITTER_A, 9)));
        assertEq(uint256(result.effect.outcome), uint256(PolicyOutcome.MarginCalled));
        assertEq(policy.riskScore(FACILITY, POLICY_ID), 35);

        result = _evaluate(_proven(CHAIN_B, 51, _singleLog(EMITTER_B, 11)));
        assertEq(uint256(result.effect.outcome), uint256(PolicyOutcome.Breached));
        assertEq(policy.riskScore(FACILITY, POLICY_ID), 50);
        assertEq(result.observedValue, 11);
    }

    function test_multipleExactLogsForOneRuleAccumulateValueAndRisk() public {
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](2);
        logs[0] = _log(EMITTER_A, 4);
        logs[1] = _log(EMITTER_A, 6);
        PolicyResult memory result = _evaluate(_proven(CHAIN_A, 101, logs));
        assertEq(policy.riskScore(FACILITY, POLICY_ID), 20);
        assertEq(result.observedValue, 10);
        assertEq(uint256(result.effect.outcome), uint256(PolicyOutcome.Restricted));
    }

    function test_transactionMatchingMultipleRulesAccumulatesAllRiskWithoutBypass() public {
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](2);
        logs[0] = _log(EMITTER_A, 4);
        logs[1] = _log(EMITTER_C, 6);
        vm.expectEmit(true, true, true, true, address(policy));
        emit RiskAccumulated(FACILITY, POLICY_ID, 0, 0, 10);
        vm.expectEmit(true, true, true, true, address(policy));
        emit RiskAccumulated(FACILITY, POLICY_ID, 2, 10, 20);
        PolicyResult memory result = _evaluate(_proven(CHAIN_A, 101, logs));

        assertEq(policy.riskScore(FACILITY, POLICY_ID), 20);
        assertEq(result.observedValue, 10);
        assertEq(uint256(result.effect.outcome), uint256(PolicyOutcome.Restricted));
        assertEq(result.emitter, address(policy));
        assertEq(uint256(result.observationKind), uint256(ObservationKind.Behaviour));
    }

    function test_chainEmitterSubjectShapeAndWindowMustMatchExactly() public {
        vm.expectRevert(MultiChainEventPolicyV1.IrrelevantEvidence.selector);
        _evaluate(_proven(CHAIN_B, 50, _singleLog(EMITTER_A, 5)));

        EvmV1Decoder.LogEntryTuple[] memory wrongSubject = _singleLog(EMITTER_A, 5);
        wrongSubject[0].topics[1] = bytes32(uint256(uint160(address(0xBAD))));
        vm.expectRevert(MultiChainEventPolicyV1.IrrelevantEvidence.selector);
        _evaluate(_proven(CHAIN_A, 101, wrongSubject));

        vm.expectRevert(MultiChainEventPolicyV1.IrrelevantEvidence.selector);
        _evaluate(_proven(CHAIN_A, 99, _singleLog(EMITTER_A, 5)));
    }

    function test_manifestRoundTripsEveryRuleAndPolicyIdentity() public view {
        MultiChainEventPolicyV1.Configuration memory configuration = policy.configurationOf(FACILITY, POLICY_ID);
        assertEq(configuration.rules.length, 3);
        assertEq(configuration.rules[1].sourceChain, CHAIN_B);
        assertEq(configuration.rules[1].emitter, EMITTER_B);
        assertEq(policy.configHash(FACILITY, POLICY_ID), keccak256(abi.encode(configuration)));
        assertEq(policy.manifest(FACILITY, POLICY_ID), abi.encode(configuration));
        assertEq(policy.policyKind(), "multi-chain-event-v1");
    }

    function test_duplicateRulesAndNonConservativeEffectsAreRejected() public {
        MultiChainEventPolicyV1.Configuration memory configuration = _configuration();
        configuration.rules[1] = configuration.rules[0];
        vm.expectRevert(MultiChainEventPolicyV1.InvalidConfiguration.selector);
        vm.prank(LENDER);
        policy.configure(FACILITY, POLICY_ID + 1, configuration);

        configuration = _configuration();
        configuration.marginEffect.creditLimitBps = configuration.restrictedEffect.creditLimitBps + 1;
        vm.expectRevert(MultiChainEventPolicyV1.InvalidConfiguration.selector);
        vm.prank(LENDER);
        policy.configure(FACILITY, POLICY_ID + 1, configuration);
    }

    function test_overlappingMatchingPredicatesAreRejectedEvenWhenRiskMetadataDiffers() public {
        MultiChainEventPolicyV1.Configuration memory configuration = _configuration();
        configuration.rules[1] = configuration.rules[0];
        configuration.rules[1].riskWeight = configuration.rules[0].riskWeight + 1;
        configuration.rules[1].observationKind = ObservationKind.Liability;
        vm.expectRevert(MultiChainEventPolicyV1.InvalidConfiguration.selector);
        vm.prank(LENDER);
        policy.configure(FACILITY, POLICY_ID + 1, configuration);

        configuration = _configuration();
        configuration.rules[1] = configuration.rules[0];
        configuration.rules[1].startSourceBlock = configuration.rules[0].endSourceBlock;
        configuration.rules[1].endSourceBlock = configuration.rules[0].endSourceBlock + 100;
        vm.expectRevert(MultiChainEventPolicyV1.InvalidConfiguration.selector);
        vm.prank(LENDER);
        policy.configure(FACILITY, POLICY_ID + 1, configuration);
    }

    function _evaluate(ProvenTransaction[] memory proven) private returns (PolicyResult memory) {
        return context.evaluate(policy, FACILITY, POLICY_ID, proven);
    }

    function _configuration() private pure returns (MultiChainEventPolicyV1.Configuration memory configuration) {
        configuration.subject = SUBJECT;
        configuration.freshnessPeriod = 1 days;
        configuration.watchThreshold = 10;
        configuration.restrictedThreshold = 20;
        configuration.marginThreshold = 30;
        configuration.breachThreshold = 40;
        configuration.watchEffect = _effect(PolicyOutcome.Watch, 9_000, 100, false, false, false);
        configuration.restrictedEffect = _effect(PolicyOutcome.Restricted, 7_000, 200, true, false, false);
        configuration.marginEffect = _effect(PolicyOutcome.MarginCalled, 4_000, 300, true, true, false);
        configuration.breachEffect = _effect(PolicyOutcome.Breached, 0, 500, true, true, true);
        configuration.rules = new MultiChainEventPolicyV1.Rule[](3);
        configuration.rules[0] = _rule(CHAIN_A, EMITTER_A, 10);
        configuration.rules[1] = _rule(CHAIN_B, EMITTER_B, 15);
        configuration.rules[2] = _rule(CHAIN_A, EMITTER_C, 10);
        configuration.rules[2].observationKind = ObservationKind.Liability;
    }

    function _rule(uint64 chainKey, address emitter, uint32 weight)
        private
        pure
        returns (MultiChainEventPolicyV1.Rule memory)
    {
        return MultiChainEventPolicyV1.Rule({
            sourceChain: chainKey,
            emitter: emitter,
            eventSignature: EVENT_SIG,
            startSourceBlock: chainKey == CHAIN_A ? 100 : 50,
            endSourceBlock: chainKey == CHAIN_A ? 200 : 150,
            topicCount: 2,
            subjectTopicIndex: 1,
            dataLength: 32,
            observedValueOffset: 0,
            observationKind: ObservationKind.Behaviour,
            riskWeight: weight
        });
    }

    function _effect(PolicyOutcome outcome, uint16 limit, uint16 fee, bool freeze, bool fresh, bool terminate)
        private
        pure
        returns (PolicyEffect memory)
    {
        return PolicyEffect({
            outcome: outcome,
            creditLimitBps: limit,
            futureDrawFeeBps: fee,
            freezePendingDraw: freeze,
            requireFreshEvidence: fresh,
            terminate: terminate
        });
    }

    function _proven(uint64 chainKey, uint64 height, EvmV1Decoder.LogEntryTuple[] memory logs)
        private
        pure
        returns (ProvenTransaction[] memory proven)
    {
        bytes[] memory chunks = new bytes[](3);
        chunks[2] = abi.encode(uint8(1), uint64(1), logs, bytes(""));
        proven = new ProvenTransaction[](1);
        proven[0] = ProvenTransaction({
            chainKey: chainKey, blockHeight: height, txIndex: 3, encodedTransaction: abi.encode(uint8(2), chunks)
        });
    }

    function _singleLog(address emitter, uint256 value)
        private
        pure
        returns (EvmV1Decoder.LogEntryTuple[] memory logs)
    {
        logs = new EvmV1Decoder.LogEntryTuple[](1);
        logs[0] = _log(emitter, value);
    }

    function _log(address emitter, uint256 value) private pure returns (EvmV1Decoder.LogEntryTuple memory) {
        bytes32[] memory topics = new bytes32[](2);
        topics[0] = EVENT_SIG;
        topics[1] = bytes32(uint256(uint160(SUBJECT)));
        return EvmV1Decoder.LogEntryTuple({address_: emitter, topics: topics, data: abi.encode(value)});
    }
}
