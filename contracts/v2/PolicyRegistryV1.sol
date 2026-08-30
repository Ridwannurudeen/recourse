// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {
    IPolicyRegistryV1,
    ActionAdapterDeclaration,
    AuditArtifact,
    AuditScope,
    DeploymentRecord,
    PackageRelease,
    RuntimeVariant
} from "./interfaces/IPolicyRegistryV1.sol";
import {EvidenceKind} from "./types/RecourseTypesV2.sol";

interface IPolicyKernelRegistryView {
    function policyOf(address facility, uint256 policyId)
        external
        view
        returns (address evaluator, bytes32 configHash, bytes memory manifestBytes);
}

interface IPolicyFacilityRegistryView {
    function kernel() external view returns (address);
}

contract PolicyRegistryV1 is IPolicyRegistryV1 {
    uint256 public constant MAX_PACKAGE_NAME_BYTES = 64;
    uint256 public constant MAX_VERSION_BYTES = 32;
    uint256 public constant MAX_EVIDENCE_KINDS = 3;
    uint256 public constant MAX_ACTION_ADAPTERS = 32;
    uint256 public constant MAX_METADATA_URI_BYTES = 256;
    uint256 public constant MAX_AUDIT_URI_BYTES = 256;

    error ActionAdapterLimitExceeded();
    error AuditArtifactAlreadyPublished();
    error AuditArtifactURITooLong();
    error ConstructorArgumentsHashMismatch();
    error DuplicateActionAdapterDeclaration();
    error DuplicateEvidenceKind();
    error EmptyPackageName();
    error EmptyVersion();
    error EvidenceKindLimitExceeded();
    error FacilityKernelMismatch();
    error InvalidActionAdapterDeclaration();
    error InvalidAuditArtifact();
    error InvalidBuildArtifactHash();
    error InvalidConstructorArgumentsHash();
    error InvalidFacility();
    error InvalidRegisteredConfiguration();
    error MetadataURITooLong();
    error NoEvidenceKinds();
    error NoRuntimeCode();
    error NotReleaseIssuer();
    error PackageNameTooLong();
    error PolicyNotRegistered();
    error DeploymentAlreadyRecorded();
    error DeploymentNotFound();
    error ReleaseAlreadyPublished();
    error ReleaseNotFound();
    error RuntimeVariantAlreadyApproved();
    error RuntimeVariantMismatch();
    error RuntimeVariantNotApproved();
    error TimestampOverflow();
    error VersionTooLong();
    error ZeroMetadataHash();

    event PackageReleasePublished(
        bytes32 indexed releaseId,
        address indexed issuer,
        address indexed referenceImplementation,
        bytes32 buildArtifactHash,
        bytes32 referenceRuntimeCodeHash,
        bytes32 referenceVariantId,
        bytes32 releaseContentHash
    );
    event RuntimeVariantApproved(
        bytes32 indexed runtimeVariantId,
        bytes32 indexed releaseId,
        address indexed implementation,
        bytes32 runtimeCodeHash,
        bytes32 constructorArgumentsHash
    );
    event AuditArtifactPublished(
        bytes32 indexed artifactId,
        AuditScope indexed scope,
        bytes32 indexed scopeId,
        address auditor,
        bytes32 scopeHash,
        bytes32 artifactHash,
        string artifactURI
    );
    event PolicyDeploymentRecorded(
        bytes32 indexed deploymentId,
        bytes32 indexed releaseId,
        address indexed kernel,
        address facility,
        uint256 policyId,
        address evaluator,
        bytes32 runtimeVariantId,
        bytes32 configHash
    );

    mapping(bytes32 releaseId => PackageRelease release) private releases;
    mapping(bytes32 releaseId => EvidenceKind[] evidenceKinds) private releaseEvidenceKinds;
    mapping(bytes32 releaseId => mapping(EvidenceKind evidenceKind => bool declared)) private evidenceDeclarations;
    mapping(bytes32 releaseId => ActionAdapterDeclaration[] adapters) private releaseActionAdapters;
    mapping(bytes32 releaseId => mapping(bytes32 declarationId => bool declared)) private actionAdapterDeclarations;
    mapping(bytes32 runtimeVariantId => RuntimeVariant variant) private runtimeVariants;
    mapping(bytes32 releaseId => bytes32[] runtimeVariantIds) private releaseRuntimeVariants;
    mapping(bytes32 artifactId => AuditArtifact artifact) private auditArtifacts;
    mapping(AuditScope scope => mapping(bytes32 scopeId => bytes32[] artifactIds)) private scopeAuditArtifacts;
    mapping(bytes32 deploymentId => DeploymentRecord deployment) private deployments;
    mapping(bytes32 releaseId => bytes32[] deploymentIds) private releaseDeployments;

    function publishRelease(
        string calldata packageName,
        string calldata version,
        address referenceImplementation,
        bytes32 buildArtifactHash,
        bytes32 referenceConstructorArgumentsHash,
        bytes32 metadataHash,
        EvidenceKind[] calldata evidenceKinds,
        ActionAdapterDeclaration[] calldata actionAdapters
    ) external returns (bytes32 releaseId) {
        _validateReleaseIdentity(
            packageName,
            version,
            referenceImplementation,
            buildArtifactHash,
            referenceConstructorArgumentsHash,
            metadataHash
        );
        _validateDeclarationCounts(evidenceKinds.length, actionAdapters.length);

        releaseId = releaseIdOf(msg.sender, packageName, version);
        if (releases[releaseId].exists) revert ReleaseAlreadyPublished();

        bytes32 referenceRuntimeCodeHash = referenceImplementation.codehash;
        bytes32 referenceVariantId =
            runtimeVariantIdOf(releaseId, referenceRuntimeCodeHash, referenceConstructorArgumentsHash);
        bytes32 declarationsHash = keccak256(abi.encode(evidenceKinds, actionAdapters));
        bytes32 releaseContentHash = keccak256(
            abi.encode(
                releaseId,
                referenceImplementation,
                buildArtifactHash,
                referenceVariantId,
                metadataHash,
                declarationsHash
            )
        );
        uint64 releasedAt = _timestamp64();
        PackageRelease storage release = releases[releaseId];
        release.issuer = msg.sender;
        release.packageName = packageName;
        release.version = version;
        release.referenceImplementation = referenceImplementation;
        release.buildArtifactHash = buildArtifactHash;
        release.referenceRuntimeCodeHash = referenceRuntimeCodeHash;
        release.referenceVariantId = referenceVariantId;
        release.metadataHash = metadataHash;
        release.releaseContentHash = releaseContentHash;
        release.releasedAt = releasedAt;
        release.exists = true;

        _storeEvidenceDeclarations(releaseId, evidenceKinds);
        _storeActionAdapterDeclarations(releaseId, actionAdapters);

        _storeRuntimeVariant(
            referenceVariantId,
            releaseId,
            referenceImplementation,
            referenceRuntimeCodeHash,
            referenceConstructorArgumentsHash,
            releasedAt
        );

        emit PackageReleasePublished(
            releaseId,
            msg.sender,
            referenceImplementation,
            buildArtifactHash,
            referenceRuntimeCodeHash,
            referenceVariantId,
            releaseContentHash
        );
    }

    function approveRuntimeVariant(bytes32 releaseId, address implementation, bytes32 constructorArgumentsHash)
        external
        returns (bytes32 runtimeVariantId)
    {
        PackageRelease storage release = _release(releaseId);
        if (msg.sender != release.issuer) revert NotReleaseIssuer();
        if (implementation.code.length == 0) revert NoRuntimeCode();
        if (constructorArgumentsHash == bytes32(0)) revert InvalidConstructorArgumentsHash();

        bytes32 runtimeCodeHash = implementation.codehash;
        runtimeVariantId = runtimeVariantIdOf(releaseId, runtimeCodeHash, constructorArgumentsHash);
        if (runtimeVariants[runtimeVariantId].exists) revert RuntimeVariantAlreadyApproved();
        _storeRuntimeVariant(
            runtimeVariantId, releaseId, implementation, runtimeCodeHash, constructorArgumentsHash, _timestamp64()
        );
    }

    function publishAuditArtifact(AuditScope scope, bytes32 scopeId, bytes32 artifactHash, string calldata artifactURI)
        external
        returns (bytes32 artifactId)
    {
        uint256 artifactURILength = bytes(artifactURI).length;
        if (artifactHash == bytes32(0) || artifactURILength == 0) revert InvalidAuditArtifact();
        if (artifactURILength > MAX_AUDIT_URI_BYTES) revert AuditArtifactURITooLong();

        bytes32 releaseId;
        bytes32 deploymentId;
        bytes32 scopeHash;
        if (scope == AuditScope.Release) {
            PackageRelease storage release = _release(scopeId);
            releaseId = scopeId;
            scopeHash = _releaseAuditScopeHash(scopeId, release);
        } else {
            DeploymentRecord storage deployment = _deployment(scopeId);
            releaseId = deployment.releaseId;
            deploymentId = scopeId;
            scopeHash = _deploymentAuditScopeHash(scopeId, deployment);
        }

        artifactId = keccak256(abi.encode(scope, scopeId, scopeHash, msg.sender, artifactHash));
        if (auditArtifacts[artifactId].exists) revert AuditArtifactAlreadyPublished();
        auditArtifacts[artifactId] = AuditArtifact({
            scope: scope,
            releaseId: releaseId,
            deploymentId: deploymentId,
            scopeHash: scopeHash,
            auditor: msg.sender,
            artifactHash: artifactHash,
            artifactURI: artifactURI,
            publishedAt: _timestamp64(),
            exists: true
        });
        scopeAuditArtifacts[scope][scopeId].push(artifactId);

        emit AuditArtifactPublished(artifactId, scope, scopeId, msg.sender, scopeHash, artifactHash, artifactURI);
    }

    function recordDeployment(
        bytes32 releaseId,
        address kernel,
        address facility,
        uint256 policyId,
        bytes32 runtimeVariantId
    ) external returns (bytes32 deploymentId) {
        PackageRelease storage release = _release(releaseId);
        if (msg.sender != release.issuer) revert NotReleaseIssuer();
        if (kernel.code.length == 0) revert PolicyNotRegistered();
        if (facility.code.length == 0) revert InvalidFacility();
        if (IPolicyFacilityRegistryView(facility).kernel() != kernel) revert FacilityKernelMismatch();

        (address evaluator, bytes32 configHash, bytes memory manifestBytes) =
            IPolicyKernelRegistryView(kernel).policyOf(facility, policyId);
        if (evaluator.code.length == 0) revert PolicyNotRegistered();

        RuntimeVariant storage variant = runtimeVariants[runtimeVariantId];
        if (!variant.exists || variant.releaseId != releaseId) revert RuntimeVariantNotApproved();
        bytes32 runtimeCodeHash = evaluator.codehash;
        if (variant.runtimeCodeHash != runtimeCodeHash) revert RuntimeVariantMismatch();
        if (variant.constructorArgumentsHash != keccak256(abi.encode(kernel))) {
            revert ConstructorArgumentsHashMismatch();
        }

        bytes32 manifestHash = keccak256(manifestBytes);
        if (configHash == bytes32(0) || manifestBytes.length == 0 || manifestHash != configHash) {
            revert InvalidRegisteredConfiguration();
        }

        uint256 chainId = block.chainid;
        deploymentId = keccak256(
            abi.encode(
                chainId,
                address(this),
                releaseId,
                kernel,
                facility,
                policyId,
                evaluator,
                runtimeVariantId,
                runtimeCodeHash,
                variant.constructorArgumentsHash,
                configHash,
                manifestHash
            )
        );
        if (deployments[deploymentId].exists) revert DeploymentAlreadyRecorded();
        deployments[deploymentId] = DeploymentRecord({
            releaseId: releaseId,
            chainId: chainId,
            kernel: kernel,
            facility: facility,
            policyId: policyId,
            evaluator: evaluator,
            runtimeVariantId: runtimeVariantId,
            runtimeCodeHash: runtimeCodeHash,
            constructorArgumentsHash: variant.constructorArgumentsHash,
            configHash: configHash,
            manifestHash: manifestHash,
            attester: msg.sender,
            recordedAt: _timestamp64(),
            exists: true
        });
        releaseDeployments[releaseId].push(deploymentId);

        emit PolicyDeploymentRecorded(
            deploymentId, releaseId, kernel, facility, policyId, evaluator, runtimeVariantId, configHash
        );
    }

    function releaseIdOf(address issuer, string calldata packageName, string calldata version)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(issuer, packageName, version));
    }

    function runtimeVariantIdOf(bytes32 releaseId, bytes32 runtimeCodeHash, bytes32 constructorArgumentsHash)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(releaseId, runtimeCodeHash, constructorArgumentsHash));
    }

    function packageRelease(bytes32 releaseId) external view returns (PackageRelease memory) {
        return releases[releaseId];
    }

    function runtimeVariant(bytes32 runtimeVariantId) external view returns (RuntimeVariant memory) {
        return runtimeVariants[runtimeVariantId];
    }

    function runtimeVariantCount(bytes32 releaseId) external view returns (uint256) {
        return releaseRuntimeVariants[releaseId].length;
    }

    function runtimeVariantAt(bytes32 releaseId, uint256 index) external view returns (bytes32) {
        return releaseRuntimeVariants[releaseId][index];
    }

    function evidenceKindCount(bytes32 releaseId) external view returns (uint256) {
        return releaseEvidenceKinds[releaseId].length;
    }

    function evidenceKindAt(bytes32 releaseId, uint256 index) external view returns (EvidenceKind) {
        return releaseEvidenceKinds[releaseId][index];
    }

    function declaresEvidenceKind(bytes32 releaseId, EvidenceKind evidenceKind) external view returns (bool) {
        return evidenceDeclarations[releaseId][evidenceKind];
    }

    function actionAdapterCount(bytes32 releaseId) external view returns (uint256) {
        return releaseActionAdapters[releaseId].length;
    }

    function actionAdapterAt(bytes32 releaseId, uint256 index) external view returns (ActionAdapterDeclaration memory) {
        return releaseActionAdapters[releaseId][index];
    }

    function auditArtifact(bytes32 artifactId) external view returns (AuditArtifact memory) {
        return auditArtifacts[artifactId];
    }

    function auditScopeHash(AuditScope scope, bytes32 scopeId) external view returns (bytes32) {
        if (scope == AuditScope.Release) return _releaseAuditScopeHash(scopeId, _release(scopeId));
        return _deploymentAuditScopeHash(scopeId, _deployment(scopeId));
    }

    function auditArtifactCount(AuditScope scope, bytes32 scopeId) external view returns (uint256) {
        return scopeAuditArtifacts[scope][scopeId].length;
    }

    function auditArtifactAt(AuditScope scope, bytes32 scopeId, uint256 index) external view returns (bytes32) {
        return scopeAuditArtifacts[scope][scopeId][index];
    }

    function deploymentRecord(bytes32 deploymentId) external view returns (DeploymentRecord memory) {
        return deployments[deploymentId];
    }

    function deploymentCount(bytes32 releaseId) external view returns (uint256) {
        return releaseDeployments[releaseId].length;
    }

    function deploymentAt(bytes32 releaseId, uint256 index) external view returns (bytes32) {
        return releaseDeployments[releaseId][index];
    }

    function _validateReleaseIdentity(
        string calldata packageName,
        string calldata version,
        address referenceImplementation,
        bytes32 buildArtifactHash,
        bytes32 referenceConstructorArgumentsHash,
        bytes32 metadataHash
    ) private view {
        uint256 packageNameLength = bytes(packageName).length;
        if (packageNameLength == 0) revert EmptyPackageName();
        if (packageNameLength > MAX_PACKAGE_NAME_BYTES) revert PackageNameTooLong();
        uint256 versionLength = bytes(version).length;
        if (versionLength == 0) revert EmptyVersion();
        if (versionLength > MAX_VERSION_BYTES) revert VersionTooLong();
        if (referenceImplementation.code.length == 0) revert NoRuntimeCode();
        if (buildArtifactHash == bytes32(0)) revert InvalidBuildArtifactHash();
        if (referenceConstructorArgumentsHash == bytes32(0)) revert InvalidConstructorArgumentsHash();
        if (metadataHash == bytes32(0)) revert ZeroMetadataHash();
    }

    function _validateDeclarationCounts(uint256 evidenceKindLength, uint256 adapterLength) private pure {
        if (evidenceKindLength == 0) revert NoEvidenceKinds();
        if (evidenceKindLength > MAX_EVIDENCE_KINDS) revert EvidenceKindLimitExceeded();
        if (adapterLength > MAX_ACTION_ADAPTERS) revert ActionAdapterLimitExceeded();
    }

    function _storeEvidenceDeclarations(bytes32 releaseId, EvidenceKind[] calldata evidenceKinds) private {
        uint256 evidenceKindLength = evidenceKinds.length;
        for (uint256 i; i < evidenceKindLength; ++i) {
            EvidenceKind evidenceKind = evidenceKinds[i];
            if (evidenceDeclarations[releaseId][evidenceKind]) revert DuplicateEvidenceKind();
            evidenceDeclarations[releaseId][evidenceKind] = true;
            releaseEvidenceKinds[releaseId].push(evidenceKind);
        }
    }

    function _storeActionAdapterDeclarations(bytes32 releaseId, ActionAdapterDeclaration[] calldata actionAdapters)
        private
    {
        uint256 adapterLength = actionAdapters.length;
        for (uint256 i; i < adapterLength; ++i) {
            ActionAdapterDeclaration calldata adapter = actionAdapters[i];
            uint256 metadataURILength = bytes(adapter.metadataURI).length;
            if (adapter.adapterKind == bytes32(0) || adapter.specificationHash == bytes32(0) || metadataURILength == 0)
            {
                revert InvalidActionAdapterDeclaration();
            }
            if (metadataURILength > MAX_METADATA_URI_BYTES) revert MetadataURITooLong();
            bytes32 declarationId =
                keccak256(abi.encode(adapter.adapterKind, adapter.specificationHash, adapter.metadataURI));
            if (actionAdapterDeclarations[releaseId][declarationId]) revert DuplicateActionAdapterDeclaration();
            actionAdapterDeclarations[releaseId][declarationId] = true;
            releaseActionAdapters[releaseId].push(adapter);
        }
    }

    function _storeRuntimeVariant(
        bytes32 runtimeVariantId,
        bytes32 releaseId,
        address implementation,
        bytes32 runtimeCodeHash,
        bytes32 constructorArgumentsHash,
        uint64 approvedAt
    ) private {
        runtimeVariants[runtimeVariantId] = RuntimeVariant({
            releaseId: releaseId,
            implementation: implementation,
            runtimeCodeHash: runtimeCodeHash,
            constructorArgumentsHash: constructorArgumentsHash,
            approvedAt: approvedAt,
            exists: true
        });
        releaseRuntimeVariants[releaseId].push(runtimeVariantId);
        emit RuntimeVariantApproved(
            runtimeVariantId, releaseId, implementation, runtimeCodeHash, constructorArgumentsHash
        );
    }

    function _releaseAuditScopeHash(bytes32 releaseId, PackageRelease storage release) private view returns (bytes32) {
        PackageRelease memory releaseSnapshot = release;
        return keccak256(abi.encode(block.chainid, address(this), AuditScope.Release, releaseId, releaseSnapshot));
    }

    function _deploymentAuditScopeHash(bytes32 deploymentId, DeploymentRecord storage deployment)
        private
        view
        returns (bytes32)
    {
        DeploymentRecord memory deploymentSnapshot = deployment;
        return
            keccak256(abi.encode(block.chainid, address(this), AuditScope.Deployment, deploymentId, deploymentSnapshot));
    }

    function _release(bytes32 releaseId) private view returns (PackageRelease storage release) {
        release = releases[releaseId];
        if (!release.exists) revert ReleaseNotFound();
    }

    function _deployment(bytes32 deploymentId) private view returns (DeploymentRecord storage deployment) {
        deployment = deployments[deploymentId];
        if (!deployment.exists) revert DeploymentNotFound();
    }

    function _timestamp64() private view returns (uint64) {
        if (block.timestamp > type(uint64).max) revert TimestampOverflow();
        return uint64(block.timestamp);
    }
}
