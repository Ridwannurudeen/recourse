// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPolicyConfigurationContextV1} from "../v2/interfaces/IPolicyConfigurationContextV1.sol";
import {IRemedyCoordinatorV1} from "./interfaces/IRemedyCoordinatorV1.sol";
import {IRemedyTransportV1} from "./interfaces/IRemedyTransportV1.sol";

interface IPolicyEvaluatorLookupV1 {
    function policyOf(address facility, uint256 policyId)
        external
        view
        returns (address evaluator, bytes32 configHash, bytes memory manifestBytes);
}

contract RemedyCoordinatorV1 is IRemedyCoordinatorV1, ReentrancyGuard {
    uint8 public constant MAXIMUM_PUBLISH_ATTEMPTS = 3;
    uint64 public constant PUBLISH_RETRY_DELAY = 1 hours;

    struct Intent {
        address facility;
        uint256 policyId;
        bytes32 adverseEvidenceDigest;
        bytes32 cureEvidenceDigest;
        uint64 destinationChain;
        address receiver;
        address target;
        bytes32 actionKind;
        bytes32 actionDataHash;
        uint64 expiry;
        uint64 lastPublishedAt;
        uint8 publishAttempts;
        IntentStatus status;
        bytes32 messageId;
    }

    error AcknowledgementAvailable();
    error AcknowledgementMissing();
    error AdverseEvidenceAlreadyUsed();
    error DuplicateMessageId();
    error InvalidCureEvidence();
    error InvalidIntent();
    error InvalidMessageIndex();
    error InvalidMessageId();
    error InvalidPayload();
    error IntentStillLive();
    error NotLender();
    error NotPolicy();
    error PolicyAlreadyAuthorized();
    error PolicyEvaluatorMismatch();
    error PolicyNotRegistered();
    error PublishAttemptsExhausted();
    error RetryNotAuthorized();
    error RetryTooSoon();
    error WrongStatus(IntentStatus expected, IntentStatus actual);
    error ZeroAddress();

    event IntentAcknowledged(bytes32 indexed intentId, bytes32 indexed messageId);
    event IntentCured(bytes32 indexed intentId, bytes32 indexed cureEvidenceDigest);
    event IntentPublished(bytes32 indexed intentId, bytes32 indexed messageId);
    event IntentRecorded(
        bytes32 indexed intentId,
        address indexed facility,
        uint256 indexed policyId,
        bytes32 adverseEvidenceDigest,
        bytes32 actionDataHash
    );
    event PolicyAuthorized(address indexed facility, uint256 indexed policyId, address indexed policy);
    event IntentTerminated(bytes32 indexed intentId, IntentStatus indexed status);

    IPolicyConfigurationContextV1 public immutable context;
    IRemedyTransportV1 public immutable transport;

    mapping(address facility => mapping(uint256 policyId => address policy)) public authorizedPolicy;
    mapping(address facility => mapping(uint256 policyId => mapping(bytes32 adverseEvidenceDigest => bool used))) public
        adverseEvidenceUsed;
    mapping(bytes32 intentId => Intent intent) private intents;
    mapping(bytes32 intentId => mapping(uint8 attempt => bytes32 messageId)) private intentMessages;

    constructor(IPolicyConfigurationContextV1 context_, IRemedyTransportV1 transport_) {
        if (address(context_) == address(0) || address(transport_) == address(0)) revert ZeroAddress();
        context = context_;
        transport = transport_;
    }

    function authorizePolicy(address facility, uint256 policyId, address policy) external {
        if (msg.sender != context.lenderOf(facility)) revert NotLender();
        if (policy == address(0)) revert ZeroAddress();
        if (authorizedPolicy[facility][policyId] != address(0)) revert PolicyAlreadyAuthorized();
        if (!context.isPolicyRegistered(facility, policyId)) revert PolicyNotRegistered();
        (address registeredEvaluator,,) = IPolicyEvaluatorLookupV1(address(context)).policyOf(facility, policyId);
        if (registeredEvaluator != policy) revert PolicyEvaluatorMismatch();
        authorizedPolicy[facility][policyId] = policy;
        emit PolicyAuthorized(facility, policyId, policy);
    }

    function recordIntent(IntentRequest calldata request) external returns (bytes32 intentId) {
        if (msg.sender != authorizedPolicy[request.facility][request.policyId]) revert NotPolicy();
        if (
            request.facility == address(0) || request.receiver == address(0) || request.target == address(0)
                || request.adverseEvidenceDigest == bytes32(0) || request.actionKind == bytes32(0)
                || request.actionDataHash == bytes32(0) || request.destinationChain == 0
                || request.expiry <= block.timestamp
        ) revert InvalidIntent();
        if (adverseEvidenceUsed[request.facility][request.policyId][request.adverseEvidenceDigest]) {
            revert AdverseEvidenceAlreadyUsed();
        }

        intentId = keccak256(abi.encode(address(this), block.chainid, request, msg.sender));
        if (intents[intentId].status != IntentStatus.None) revert InvalidIntent();
        adverseEvidenceUsed[request.facility][request.policyId][request.adverseEvidenceDigest] = true;
        intents[intentId] = Intent({
            facility: request.facility,
            policyId: request.policyId,
            adverseEvidenceDigest: request.adverseEvidenceDigest,
            cureEvidenceDigest: bytes32(0),
            destinationChain: request.destinationChain,
            receiver: request.receiver,
            target: request.target,
            actionKind: request.actionKind,
            actionDataHash: request.actionDataHash,
            expiry: request.expiry,
            lastPublishedAt: 0,
            publishAttempts: 0,
            status: IntentStatus.Recorded,
            messageId: bytes32(0)
        });
        emit IntentRecorded(
            intentId, request.facility, request.policyId, request.adverseEvidenceDigest, request.actionDataHash
        );
    }

    function publishIntent(bytes32 intentId, bytes calldata actionData)
        external
        nonReentrant
        returns (bytes32 messageId)
    {
        Intent storage intent = intents[intentId];
        if (intent.status == IntentStatus.Published) {
            if (
                msg.sender != authorizedPolicy[intent.facility][intent.policyId]
                    && msg.sender != context.lenderOf(intent.facility)
            ) revert RetryNotAuthorized();
            if (intent.publishAttempts >= MAXIMUM_PUBLISH_ATTEMPTS) revert PublishAttemptsExhausted();
            if (block.timestamp < uint256(intent.lastPublishedAt) + PUBLISH_RETRY_DELAY) revert RetryTooSoon();
            if (_acknowledgedMessage(intentId, intent.publishAttempts) != bytes32(0)) {
                revert AcknowledgementAvailable();
            }
        } else {
            _requireStatus(intent, IntentStatus.Recorded);
        }
        if (block.timestamp >= intent.expiry) revert InvalidIntent();
        if (keccak256(actionData) != intent.actionDataHash) revert InvalidPayload();
        bytes memory payload = abi.encode(intentId, intent.target, intent.actionKind, actionData, intent.expiry);
        messageId = transport.publish(intentId, intent.destinationChain, intent.receiver, payload, intent.expiry);
        if (messageId == bytes32(0)) revert InvalidMessageId();
        uint8 attempt = intent.publishAttempts;
        for (uint8 i; i < attempt; ++i) {
            if (intentMessages[intentId][i] == messageId) revert DuplicateMessageId();
        }
        intentMessages[intentId][attempt] = messageId;
        intent.publishAttempts = attempt + 1;
        intent.lastPublishedAt = uint64(block.timestamp);
        intent.messageId = messageId;
        intent.status = IntentStatus.Published;
        emit IntentPublished(intentId, messageId);
    }

    function syncAcknowledgement(bytes32 intentId) external nonReentrant {
        Intent storage intent = intents[intentId];
        _requireStatus(intent, IntentStatus.Published);
        bytes32 messageId = _acknowledgedMessage(intentId, intent.publishAttempts);
        if (messageId == bytes32(0)) revert AcknowledgementMissing();
        intent.messageId = messageId;
        intent.status = IntentStatus.Acknowledged;
        emit IntentAcknowledged(intentId, messageId);
    }

    function timeoutIntent(bytes32 intentId) external nonReentrant {
        Intent storage intent = intents[intentId];
        if (intent.status == IntentStatus.Recorded) {
            if (block.timestamp < intent.expiry) revert IntentStillLive();
            intent.status = IntentStatus.Expired;
        } else if (intent.status == IntentStatus.Published) {
            if (block.timestamp >= intent.expiry) {
                intent.status = IntentStatus.Expired;
            } else {
                if (_acknowledgedMessage(intentId, intent.publishAttempts) != bytes32(0)) {
                    revert AcknowledgementAvailable();
                }
                if (
                    intent.publishAttempts < MAXIMUM_PUBLISH_ATTEMPTS
                        || block.timestamp < uint256(intent.lastPublishedAt) + PUBLISH_RETRY_DELAY
                ) revert IntentStillLive();
                intent.status = IntentStatus.Failed;
            }
        } else {
            revert IntentStillLive();
        }
        emit IntentTerminated(intentId, intent.status);
    }

    function recordCure(bytes32 intentId, bytes32 cureEvidenceDigest) external {
        Intent storage intent = intents[intentId];
        if (msg.sender != authorizedPolicy[intent.facility][intent.policyId]) revert NotPolicy();
        _requireStatus(intent, IntentStatus.Acknowledged);
        if (cureEvidenceDigest == bytes32(0) || cureEvidenceDigest == intent.adverseEvidenceDigest) {
            revert InvalidCureEvidence();
        }
        intent.cureEvidenceDigest = cureEvidenceDigest;
        intent.status = IntentStatus.Cured;
        emit IntentCured(intentId, cureEvidenceDigest);
    }

    function intentStatus(bytes32 intentId) external view returns (IntentStatus) {
        return intents[intentId].status;
    }

    function intentActionDataHash(bytes32 intentId) external view returns (bytes32) {
        return intents[intentId].actionDataHash;
    }

    function intentOf(bytes32 intentId) external view returns (Intent memory) {
        return intents[intentId];
    }

    function messageCount(bytes32 intentId) external view returns (uint8) {
        return intents[intentId].publishAttempts;
    }

    function messageAt(bytes32 intentId, uint8 attempt) external view returns (bytes32) {
        if (attempt >= intents[intentId].publishAttempts) revert InvalidMessageIndex();
        return intentMessages[intentId][attempt];
    }

    function _acknowledgedMessage(bytes32 intentId, uint8 attemptCount) private view returns (bytes32 messageId) {
        for (uint8 i; i < attemptCount; ++i) {
            messageId = intentMessages[intentId][i];
            if (transport.isAcknowledged(messageId)) return messageId;
        }
        return bytes32(0);
    }

    function _requireStatus(Intent storage intent, IntentStatus expected) private view {
        if (intent.status != expected) revert WrongStatus(expected, intent.status);
    }
}
