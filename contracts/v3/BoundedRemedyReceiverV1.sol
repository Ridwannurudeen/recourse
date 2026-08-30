// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IRemedyTargetV1} from "./interfaces/IRemedyTargetV1.sol";

contract BoundedRemedyReceiverV1 is ReentrancyGuard {
    struct Authorization {
        uint64 sourceChain;
        address sourceCoordinator;
        bytes32 intentId;
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
    error MessageAlreadyProcessed();
    error NotGuardian();
    error NotTransport();
    error ZeroAddress();

    event RemedyAuthorized(bytes32 indexed authorizationId, bytes32 indexed intentId);
    event RemedyExecuted(
        bytes32 indexed authorizationId, bytes32 indexed messageId, bytes32 indexed intentId, bytes32 resultDigest
    );

    address public immutable transport;
    address public immutable guardian;

    mapping(bytes32 authorizationId => Authorization authorization) private authorizations;
    mapping(bytes32 messageId => bool processed) public messageProcessed;

    constructor(address transport_, address guardian_) {
        if (transport_ == address(0) || guardian_ == address(0)) revert ZeroAddress();
        transport = transport_;
        guardian = guardian_;
    }

    function authorize(Authorization calldata authorization) external returns (bytes32 authorizationId) {
        if (msg.sender != guardian) revert NotGuardian();
        if (
            authorization.sourceChain == 0 || authorization.sourceCoordinator == address(0)
                || authorization.intentId == bytes32(0) || authorization.target == address(0)
                || authorization.actionKind == bytes32(0) || authorization.actionDataHash == bytes32(0)
                || authorization.expiry <= block.timestamp || authorization.consumed
        ) revert InvalidAuthorization();
        authorizationId = authorizationIdOf(
            authorization.sourceChain,
            authorization.sourceCoordinator,
            authorization.intentId,
            authorization.target,
            authorization.actionKind,
            authorization.actionDataHash,
            authorization.expiry
        );
        if (authorizations[authorizationId].intentId != bytes32(0)) revert AuthorizationAlreadyExists();
        authorizations[authorizationId] = authorization;
        emit RemedyAuthorized(authorizationId, authorization.intentId);
    }

    function receiveMessage(bytes32 messageId, uint64 sourceChain, address sourceCoordinator, bytes calldata payload)
        external
        nonReentrant
        returns (bytes32 resultDigest)
    {
        if (msg.sender != transport) revert NotTransport();
        if (messageId == bytes32(0)) revert InvalidMessageId();
        if (messageProcessed[messageId]) revert MessageAlreadyProcessed();
        (bytes32 intentId, address target, bytes32 actionKind, bytes memory actionData, uint64 expiry) =
            abi.decode(payload, (bytes32, address, bytes32, bytes, uint64));
        bytes32 authorizationId = authorizationIdOf(
            sourceChain, sourceCoordinator, intentId, target, actionKind, keccak256(actionData), expiry
        );
        Authorization storage authorization = authorizations[authorizationId];
        if (authorization.intentId == bytes32(0)) revert InvalidAuthorization();
        if (authorization.consumed) revert AuthorizationConsumed();
        if (block.timestamp >= authorization.expiry) revert AuthorizationExpired();

        authorization.consumed = true;
        messageProcessed[messageId] = true;
        resultDigest = IRemedyTargetV1(target).executeRemedy(actionKind, actionData);
        if (resultDigest == bytes32(0)) revert InvalidResult();
        emit RemedyExecuted(authorizationId, messageId, intentId, resultDigest);
    }

    function authorizationAt(bytes32 authorizationId) external view returns (Authorization memory) {
        return authorizations[authorizationId];
    }

    function authorizationIdOf(
        uint64 sourceChain,
        address sourceCoordinator,
        bytes32 intentId,
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
                target,
                actionKind,
                actionDataHash,
                expiry
            )
        );
    }
}
