// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {EvidenceKind} from "../types/RecourseTypesV2.sol";

enum AuditScope {
    Release,
    Deployment
}

struct ActionAdapterDeclaration {
    bytes32 adapterKind;
    bytes32 specificationHash;
    string metadataURI;
}

struct PackageRelease {
    address issuer;
    string packageName;
    string version;
    address referenceImplementation;
    bytes32 buildArtifactHash;
    bytes32 referenceRuntimeCodeHash;
    bytes32 referenceVariantId;
    bytes32 metadataHash;
    bytes32 releaseContentHash;
    uint64 releasedAt;
    bool exists;
}

struct RuntimeVariant {
    bytes32 releaseId;
    address implementation;
    bytes32 runtimeCodeHash;
    bytes32 constructorArgumentsHash;
    uint64 approvedAt;
    bool exists;
}

struct AuditArtifact {
    AuditScope scope;
    bytes32 releaseId;
    bytes32 deploymentId;
    bytes32 scopeHash;
    address auditor;
    bytes32 artifactHash;
    string artifactURI;
    uint64 publishedAt;
    bool exists;
}

struct DeploymentRecord {
    bytes32 releaseId;
    uint256 chainId;
    address kernel;
    address facility;
    uint256 policyId;
    address evaluator;
    bytes32 runtimeVariantId;
    bytes32 runtimeCodeHash;
    bytes32 constructorArgumentsHash;
    bytes32 configHash;
    bytes32 manifestHash;
    address attester;
    uint64 recordedAt;
    bool exists;
}

interface IPolicyRegistryV1 {
    function publishRelease(
        string calldata packageName,
        string calldata version,
        address referenceImplementation,
        bytes32 buildArtifactHash,
        bytes32 referenceConstructorArgumentsHash,
        bytes32 metadataHash,
        EvidenceKind[] calldata evidenceKinds,
        ActionAdapterDeclaration[] calldata actionAdapters
    ) external returns (bytes32 releaseId);

    function approveRuntimeVariant(bytes32 releaseId, address implementation, bytes32 constructorArgumentsHash)
        external
        returns (bytes32 runtimeVariantId);

    function publishAuditArtifact(AuditScope scope, bytes32 scopeId, bytes32 artifactHash, string calldata artifactURI)
        external
        returns (bytes32 artifactId);

    function recordDeployment(
        bytes32 releaseId,
        address kernel,
        address facility,
        uint256 policyId,
        bytes32 runtimeVariantId
    ) external returns (bytes32 deploymentId);

    function releaseIdOf(address issuer, string calldata packageName, string calldata version)
        external
        pure
        returns (bytes32);

    function runtimeVariantIdOf(bytes32 releaseId, bytes32 runtimeCodeHash, bytes32 constructorArgumentsHash)
        external
        pure
        returns (bytes32);

    function packageRelease(bytes32 releaseId) external view returns (PackageRelease memory);
    function runtimeVariant(bytes32 runtimeVariantId) external view returns (RuntimeVariant memory);
    function runtimeVariantCount(bytes32 releaseId) external view returns (uint256);
    function runtimeVariantAt(bytes32 releaseId, uint256 index) external view returns (bytes32);
    function evidenceKindCount(bytes32 releaseId) external view returns (uint256);
    function evidenceKindAt(bytes32 releaseId, uint256 index) external view returns (EvidenceKind);
    function declaresEvidenceKind(bytes32 releaseId, EvidenceKind evidenceKind) external view returns (bool);
    function actionAdapterCount(bytes32 releaseId) external view returns (uint256);
    function actionAdapterAt(bytes32 releaseId, uint256 index) external view returns (ActionAdapterDeclaration memory);
    function auditArtifact(bytes32 artifactId) external view returns (AuditArtifact memory);
    function auditScopeHash(AuditScope scope, bytes32 scopeId) external view returns (bytes32);
    function auditArtifactCount(AuditScope scope, bytes32 scopeId) external view returns (uint256);
    function auditArtifactAt(AuditScope scope, bytes32 scopeId, uint256 index) external view returns (bytes32);
    function deploymentRecord(bytes32 deploymentId) external view returns (DeploymentRecord memory);
    function deploymentCount(bytes32 releaseId) external view returns (uint256);
    function deploymentAt(bytes32 releaseId, uint256 index) external view returns (bytes32);
}
