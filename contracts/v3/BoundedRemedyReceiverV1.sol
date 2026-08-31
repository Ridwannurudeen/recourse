// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IRemedyTargetV1} from "./interfaces/IRemedyTargetV1.sol";

contract BoundedRemedyReceiverV1 is ReentrancyGuard {
    struct Authorization {
        uint64 sourceChain;
        address sourceCoordinator;
        bytes32 intentId;
        bytes32 executionId;
        address target;
        bytes32 actionKind;
        bytes32 actionDataHash;
        uint64 expiry;
        bool consumed;
    }

    error AuthorizationAlreadyExists();
    error AuthorizationConsumed();
    error AuthorizationExpired();
    error InvalidAuthorization();
    error InvalidResult();
    error InvalidMessageId();
    error InvalidPayload();
    error MessageAlreadyProcessed();
    error NotGuardian();
    error NotTransport();
    error ZeroAddress();

    event RemedyAuthorized(bytes32 indexed authorizationId, bytes32 indexed intentId, bytes32 indexed executionId);
    event RemedyExecuted(
        bytes32 indexed authorizationId,
        bytes32 indexed messageId,
        bytes32 indexed intentId,
        bytes32 executionId,
        bytes32 resultDigest
    );
    event RemedyExecutionReused(
        bytes32 indexed authorizationId,
        bytes32 indexed messageId,
        bytes32 indexed intentId,
        bytes32 executionId,
        bytes32 resultDigest
    );
    event RemedyExecutionConfirmed(
        address indexed target,
        bytes32 indexed intentId,
        bytes32 indexed executionId,
        bytes32 resultDigest,
        bytes32 actionDataHash
    );

    address public immutable transport;
    address public immutable guardian;

    mapping(bytes32 authorizationId => Authorization authorization) private authorizations;
    mapping(bytes32 messageId => bool processed) public messageProcessed;
    mapping(bytes32 executionId => bytes32 commitment) public executionCommitment;
    mapping(bytes32 executionId => bytes32 resultDigest) public executionResultDigest;

    constructor(address transport_, address guardian_) {
        if (transport_ == address(0) || guardian_ == address(0)) revert ZeroAddress();
        transport = transport_;
        guardian = guardian_;
    }

    function authorize(Authorization calldata authorization) external returns (bytes32 authorizationId) {
        if (msg.sender != guardian) revert NotGuardian();
        if (
            authorization.sourceChain == 0 || authorization.sourceCoordinator == address(0)
                || authorization.intentId == bytes32(0) || authorization.executionId == bytes32(0)
                || authorization.target == address(0) || authorization.actionKind == bytes32(0)
                || authorization.actionDataHash == bytes32(0) || authorization.expiry <= block.timestamp
                || authorization.consumed
        ) revert InvalidAuthorization();
        authorizationId = authorizationIdOf(
            authorization.sourceChain,
            authorization.sourceCoordinator,
            authorization.intentId,
            authorization.executionId,
            authorization.target,
            authorization.actionKind,
            authorization.actionDataHash,
            authorization.expiry
        );
        if (authorizations[authorizationId].intentId != bytes32(0)) revert AuthorizationAlreadyExists();
        authorizations[authorizationId] = authorization;
        emit RemedyAuthorized(authorizationId, authorization.intentId, authorization.executionId);
    }

    function receiveMessage(bytes32 messageId, uint64 sourceChain, address sourceCoordinator, bytes calldata payload)
        external
        nonReentrant
        returns (bytes32 resultDigest)
    {
        if (msg.sender != transport) revert NotTransport();
        if (messageId == bytes32(0)) revert InvalidMessageId();
        if (messageProcessed[messageId]) revert MessageAlreadyProcessed();
        (
            bytes32 intentId,
            bytes32 executionId,
            address target,
            bytes32 actionKind,
            bytes memory actionData,
            uint64 expiry
        ) = abi.decode(payload, (bytes32, bytes32, address, bytes32, bytes, uint64));
        if (keccak256(payload) != keccak256(abi.encode(intentId, executionId, target, actionKind, actionData, expiry)))
        {
            revert InvalidPayload();
        }
        bytes32 authorizationId = authorizationIdOf(
            sourceChain, sourceCoordinator, intentId, executionId, target, actionKind, keccak256(actionData), expiry
        );
        Authorization storage authorization = authorizations[authorizationId];
        if (authorization.intentId == bytes32(0)) revert InvalidAuthorization();
        bytes32 actionCommitment = keccak256(abi.encode(target, actionKind, keccak256(actionData)));
        resultDigest = executionResultDigest[executionId];
        if (resultDigest != bytes32(0)) {
            if (executionCommitment[executionId] != actionCommitment) revert InvalidAuthorization();
            authorization.consumed = true;
            messageProcessed[messageId] = true;
            emit RemedyExecutionReused(authorizationId, messageId, intentId, executionId, resultDigest);
            emit RemedyExecutionConfirmed(target, intentId, executionId, resultDigest, keccak256(actionData));
            return resultDigest;
        }
        if (authorization.consumed) revert AuthorizationConsumed();
        if (block.timestamp >= authorization.expiry) revert AuthorizationExpired();

        authorization.consumed = true;
        messageProcessed[messageId] = true;
        resultDigest = IRemedyTargetV1(target).executeRemedy(executionId, actionKind, actionData);
        if (resultDigest == bytes32(0)) revert InvalidResult();
        executionCommitment[executionId] = actionCommitment;
        executionResultDigest[executionId] = resultDigest;
        emit RemedyExecuted(authorizationId, messageId, intentId, executionId, resultDigest);
        emit RemedyExecutionConfirmed(target, intentId, executionId, resultDigest, keccak256(actionData));
    }

    function authorizationAt(bytes32 authorizationId) external view returns (Authorization memory) {
        return authorizations[authorizationId];
    }

    function authorizationIdOf(
        uint64 sourceChain,
        address sourceCoordinator,
        bytes32 intentId,
        bytes32 executionId,
        address target,
        bytes32 actionKind,
        bytes32 actionDataHash,
        uint64 expiry
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                address(this),
                block.chainid,
                sourceChain,
                sourceCoordinator,
                intentId,
                executionId,
                target,
                actionKind,
                actionDataHash,
                expiry
            )
        );
    }
}
