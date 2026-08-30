// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PolicyKernelV1} from "../../contracts/v2/PolicyKernelV1.sol";
import {PolicyRegistryV1} from "../../contracts/v2/PolicyRegistryV1.sol";
import {EventHistoryPolicyV1} from "../../contracts/v2/policies/EventHistoryPolicyV1.sol";
import {IPolicyFacilityV1} from "../../contracts/v2/interfaces/IPolicyFacilityV1.sol";
import {
    ActionAdapterDeclaration,
    AuditArtifact,
    AuditScope,
    DeploymentRecord,
    PackageRelease,
    RuntimeVariant
} from "../../contracts/v2/interfaces/IPolicyRegistryV1.sol";
import {
    EvidenceKind,
    FacilityStatus,
    ObservationKind,
    PolicyEffect,
    PolicyOutcome
} from "../../contracts/v2/types/RecourseTypesV2.sol";
import {MockVerifier} from "../mocks/MockVerifier.sol";

contract RegistryPolicyFacility is IPolicyFacilityV1 {
    address public immutable kernel;
    address public immutable lender;
    address public immutable borrower;
    IERC20 public asset;
    FacilityStatus public status;
    bool public incidentPaused;

    constructor(address kernel_, address lender_, address borrower_) {
        kernel = kernel_;
        lender = lender_;
        borrower = borrower_;
    }

    function applyPolicyEffect(uint256, PolicyEffect calldata, uint64) external {}
}

contract CounterfeitRegistryKernel {
    address private immutable evaluator;
    bytes32 private immutable configurationHash;
    bytes private manifestBytes;

    constructor(address evaluator_, bytes32 configurationHash_, bytes memory manifestBytes_) {
        evaluator = evaluator_;
        configurationHash = configurationHash_;
        manifestBytes = manifestBytes_;
    }

    function policyOf(address, uint256)
        external
        view
        returns (address registeredEvaluator, bytes32 configHash, bytes memory manifest)
    {
        return (evaluator, configurationHash, manifestBytes);
    }
}

contract PolicyRegistryV1Test is Test {
    bytes32 private constant EVENT_SIGNATURE = keccak256("Borrow(address,address,uint256,uint256)");
    bytes32 private constant BUILD_ARTIFACT_HASH = keccak256("event-history-v1-solc-0.8.30-build");
    bytes32 private constant METADATA_HASH = keccak256("event-history-package-metadata");
    bytes32 private constant ADAPTER_KIND = keccak256("freeze-vault");
    bytes32 private constant ADAPTER_SPECIFICATION_HASH = keccak256("freeze-vault-v1-specification");
    bytes32 private constant AUDIT_ARTIFACT_HASH = keccak256("audit-report-bytes");
    address private constant LENDER = address(0x1EAD);
    address private constant BORROWER = address(0xB0B);
    address private constant PACKAGE_ISSUER = address(0x1550);
    address private constant AUDIT_ISSUER = address(0xA0D17);
    address private constant EMITTER = address(0xA4A4);
    uint256 private constant POLICY_ID = 9;

    PolicyRegistryV1 private registry;
    PolicyKernelV1 private kernel;
    RegistryPolicyFacility private facility;
    EventHistoryPolicyV1 private policy;

    function setUp() public {
        registry = new PolicyRegistryV1();
        kernel = new PolicyKernelV1(new MockVerifier());
        facility = new RegistryPolicyFacility(address(kernel), LENDER, BORROWER);
        policy = new EventHistoryPolicyV1(kernel);
    }

    function test_releaseBindsReusableBuildReferenceRuntimeAndMetadataDeclarations() public {
        bytes32 releaseId = _publishRelease();
        PackageRelease memory release = registry.packageRelease(releaseId);
        bytes32 constructorArgumentsHash = _constructorArgumentsHash(kernel);
        bytes32 expectedVariantId =
            registry.runtimeVariantIdOf(releaseId, address(policy).codehash, constructorArgumentsHash);

        assertEq(release.issuer, PACKAGE_ISSUER);
        assertEq(release.packageName, "event-history");
        assertEq(release.version, "1.0.0");
        assertEq(release.referenceImplementation, address(policy));
        assertEq(release.buildArtifactHash, BUILD_ARTIFACT_HASH);
        assertEq(release.referenceRuntimeCodeHash, address(policy).codehash);
        assertEq(release.referenceVariantId, expectedVariantId);
        assertEq(release.metadataHash, METADATA_HASH);
        assertTrue(release.releaseContentHash != bytes32(0));
        assertEq(release.releasedAt, block.timestamp);
        assertTrue(release.exists);
        assertEq(registry.releaseIdOf(PACKAGE_ISSUER, "event-history", "1.0.0"), releaseId);

        RuntimeVariant memory variant = registry.runtimeVariant(expectedVariantId);
        assertEq(variant.releaseId, releaseId);
        assertEq(variant.implementation, address(policy));
        assertEq(variant.runtimeCodeHash, address(policy).codehash);
        assertEq(variant.constructorArgumentsHash, constructorArgumentsHash);
        assertTrue(variant.exists);
        assertEq(registry.runtimeVariantCount(releaseId), 1);
        assertEq(registry.runtimeVariantAt(releaseId, 0), expectedVariantId);

        assertEq(registry.evidenceKindCount(releaseId), 2);
        assertEq(uint256(registry.evidenceKindAt(releaseId, 0)), uint256(EvidenceKind.EventDelta));
        assertEq(uint256(registry.evidenceKindAt(releaseId, 1)), uint256(EvidenceKind.EventTransition));
        assertTrue(registry.declaresEvidenceKind(releaseId, EvidenceKind.EventDelta));
        assertFalse(registry.declaresEvidenceKind(releaseId, EvidenceKind.TransactionControl));

        assertEq(registry.actionAdapterCount(releaseId), 1);
        ActionAdapterDeclaration memory adapter = registry.actionAdapterAt(releaseId, 0);
        assertEq(adapter.adapterKind, ADAPTER_KIND);
        assertEq(adapter.specificationHash, ADAPTER_SPECIFICATION_HASH);
        assertEq(adapter.metadataURI, "ipfs://freeze-vault-v1-metadata-only");

        vm.expectRevert(PolicyRegistryV1.ReleaseAlreadyPublished.selector);
        vm.prank(PACKAGE_ISSUER);
        registry.publishRelease(
            "event-history",
            "1.0.0",
            address(registry),
            keccak256("changed-build"),
            keccak256("changed-constructor"),
            keccak256("changed-metadata"),
            _evidenceKinds(),
            _adapters()
        );
    }

    function test_sameNameAndVersionRemainDistinctAcrossIssuersAndVersions() public {
        bytes32 first = _publishRelease();

        vm.prank(address(0xBEEF));
        bytes32 otherIssuer = registry.publishRelease(
            "event-history",
            "1.0.0",
            address(policy),
            BUILD_ARTIFACT_HASH,
            _constructorArgumentsHash(kernel),
            METADATA_HASH,
            _evidenceKinds(),
            _adapters()
        );
        vm.prank(PACKAGE_ISSUER);
        bytes32 otherVersion = registry.publishRelease(
            "event-history",
            "1.0.1",
            address(policy),
            BUILD_ARTIFACT_HASH,
            _constructorArgumentsHash(kernel),
            METADATA_HASH,
            _evidenceKinds(),
            _adapters()
        );

        assertTrue(first != otherIssuer);
        assertTrue(first != otherVersion);
        assertEq(registry.releaseCount(), 3);
        assertEq(registry.releaseAt(0), first);
        assertEq(registry.releaseAt(1), otherIssuer);
        assertEq(registry.releaseAt(2), otherVersion);
    }

    function test_releaseCatalogStartsEmptyAndUsesNativeBoundsChecks() public {
        assertEq(registry.releaseCount(), 0);
        vm.expectRevert();
        registry.releaseAt(0);
    }

    function test_releaseRejectsInvalidBuildRuntimeAndDuplicateEvidenceDeclarations() public {
        vm.expectRevert(PolicyRegistryV1.NoRuntimeCode.selector);
        vm.prank(PACKAGE_ISSUER);
        registry.publishRelease(
            "event-history",
            "1.0.0",
            address(0x1234),
            BUILD_ARTIFACT_HASH,
            _constructorArgumentsHash(kernel),
            METADATA_HASH,
            _evidenceKinds(),
            _adapters()
        );

        vm.expectRevert(PolicyRegistryV1.InvalidBuildArtifactHash.selector);
        vm.prank(PACKAGE_ISSUER);
        registry.publishRelease(
            "event-history",
            "1.0.0",
            address(policy),
            bytes32(0),
            _constructorArgumentsHash(kernel),
            METADATA_HASH,
            _evidenceKinds(),
            _adapters()
        );

        EvidenceKind[] memory duplicates = new EvidenceKind[](2);
        duplicates[0] = EvidenceKind.EventDelta;
        duplicates[1] = EvidenceKind.EventDelta;
        vm.expectRevert(PolicyRegistryV1.DuplicateEvidenceKind.selector);
        vm.prank(PACKAGE_ISSUER);
        registry.publishRelease(
            "event-history",
            "1.0.0",
            address(policy),
            BUILD_ARTIFACT_HASH,
            _constructorArgumentsHash(kernel),
            METADATA_HASH,
            duplicates,
            _adapters()
        );
    }

    function test_actionAdaptersAreBoundedMetadataDeclarationsWithConstantTimeDuplicateChecks() public {
        ActionAdapterDeclaration[] memory adapters = _adapters();
        adapters[0].specificationHash = bytes32(0);

        vm.expectRevert(PolicyRegistryV1.InvalidActionAdapterDeclaration.selector);
        vm.prank(PACKAGE_ISSUER);
        registry.publishRelease(
            "event-history",
            "1.0.0",
            address(policy),
            BUILD_ARTIFACT_HASH,
            _constructorArgumentsHash(kernel),
            METADATA_HASH,
            _evidenceKinds(),
            adapters
        );

        adapters = new ActionAdapterDeclaration[](2);
        adapters[0] = _adapters()[0];
        adapters[1] = _adapters()[0];
        vm.expectRevert(PolicyRegistryV1.DuplicateActionAdapterDeclaration.selector);
        vm.prank(PACKAGE_ISSUER);
        registry.publishRelease(
            "event-history",
            "1.0.0",
            address(policy),
            BUILD_ARTIFACT_HASH,
            _constructorArgumentsHash(kernel),
            METADATA_HASH,
            _evidenceKinds(),
            adapters
        );
    }

    function test_releaseAndAuditMetadataBoundsRejectOversizedInputs() public {
        string memory oversizedPackageName = string(new bytes(registry.MAX_PACKAGE_NAME_BYTES() + 1));
        vm.expectRevert(PolicyRegistryV1.PackageNameTooLong.selector);
        vm.prank(PACKAGE_ISSUER);
        registry.publishRelease(
            oversizedPackageName,
            "1.0.0",
            address(policy),
            BUILD_ARTIFACT_HASH,
            _constructorArgumentsHash(kernel),
            METADATA_HASH,
            _evidenceKinds(),
            _adapters()
        );

        string memory oversizedVersion = string(new bytes(registry.MAX_VERSION_BYTES() + 1));
        vm.expectRevert(PolicyRegistryV1.VersionTooLong.selector);
        vm.prank(PACKAGE_ISSUER);
        registry.publishRelease(
            "event-history",
            oversizedVersion,
            address(policy),
            BUILD_ARTIFACT_HASH,
            _constructorArgumentsHash(kernel),
            METADATA_HASH,
            _evidenceKinds(),
            _adapters()
        );

        EvidenceKind[] memory tooManyEvidenceKinds = new EvidenceKind[](registry.MAX_EVIDENCE_KINDS() + 1);
        vm.expectRevert(PolicyRegistryV1.EvidenceKindLimitExceeded.selector);
        vm.prank(PACKAGE_ISSUER);
        registry.publishRelease(
            "event-history",
            "1.0.0",
            address(policy),
            BUILD_ARTIFACT_HASH,
            _constructorArgumentsHash(kernel),
            METADATA_HASH,
            tooManyEvidenceKinds,
            _adapters()
        );

        ActionAdapterDeclaration[] memory adapters = new ActionAdapterDeclaration[](registry.MAX_ACTION_ADAPTERS() + 1);
        vm.expectRevert(PolicyRegistryV1.ActionAdapterLimitExceeded.selector);
        vm.prank(PACKAGE_ISSUER);
        registry.publishRelease(
            "event-history",
            "1.0.0",
            address(policy),
            BUILD_ARTIFACT_HASH,
            _constructorArgumentsHash(kernel),
            METADATA_HASH,
            _evidenceKinds(),
            adapters
        );

        adapters = _adapters();
        adapters[0].metadataURI = string(new bytes(registry.MAX_METADATA_URI_BYTES() + 1));
        vm.expectRevert(PolicyRegistryV1.MetadataURITooLong.selector);
        vm.prank(PACKAGE_ISSUER);
        registry.publishRelease(
            "event-history",
            "1.0.0",
            address(policy),
            BUILD_ARTIFACT_HASH,
            _constructorArgumentsHash(kernel),
            METADATA_HASH,
            _evidenceKinds(),
            adapters
        );

        bytes32 releaseId = _publishRelease();
        string memory oversizedAuditURI = string(new bytes(registry.MAX_AUDIT_URI_BYTES() + 1));
        vm.expectRevert(PolicyRegistryV1.AuditArtifactURITooLong.selector);
        registry.publishAuditArtifact(AuditScope.Release, releaseId, AUDIT_ARTIFACT_HASH, oversizedAuditURI);
    }

    function test_onlyReleaseIssuerMayRecordAndRealIssuerBindsExactRegistration() public {
        bytes32 releaseId = _publishRelease();
        bytes32 configHash = _configureAndRegister(kernel, facility, policy, POLICY_ID);
        bytes32 runtimeVariantId = registry.packageRelease(releaseId).referenceVariantId;

        vm.expectRevert(PolicyRegistryV1.NotReleaseIssuer.selector);
        vm.prank(address(0xBEEF));
        registry.recordDeployment(releaseId, address(kernel), address(facility), POLICY_ID, runtimeVariantId);

        vm.prank(PACKAGE_ISSUER);
        bytes32 deploymentId =
            registry.recordDeployment(releaseId, address(kernel), address(facility), POLICY_ID, runtimeVariantId);
        DeploymentRecord memory deployment = registry.deploymentRecord(deploymentId);

        assertEq(deployment.releaseId, releaseId);
        assertEq(deployment.chainId, block.chainid);
        assertEq(deployment.kernel, address(kernel));
        assertEq(deployment.facility, address(facility));
        assertEq(deployment.policyId, POLICY_ID);
        assertEq(deployment.evaluator, address(policy));
        assertEq(deployment.runtimeVariantId, runtimeVariantId);
        assertEq(deployment.runtimeCodeHash, address(policy).codehash);
        assertEq(deployment.constructorArgumentsHash, _constructorArgumentsHash(kernel));
        assertEq(deployment.configHash, configHash);
        assertEq(deployment.manifestHash, configHash);
        assertEq(deployment.attester, PACKAGE_ISSUER);
        assertEq(deployment.recordedAt, block.timestamp);
        assertTrue(deployment.exists);
        assertEq(registry.deploymentCount(releaseId), 1);
        assertEq(registry.deploymentAt(releaseId, 0), deploymentId);

        vm.expectRevert(PolicyRegistryV1.DeploymentAlreadyRecorded.selector);
        vm.prank(PACKAGE_ISSUER);
        registry.recordDeployment(releaseId, address(kernel), address(facility), POLICY_ID, runtimeVariantId);
    }

    function test_counterfeitKernelCannotRecordAnEoaFacility() public {
        bytes32 releaseId = _publishRelease();
        bytes32 configHash = _configureAndRegister(kernel, facility, policy, POLICY_ID);
        (address evaluator,, bytes memory manifestBytes) = kernel.policyOf(address(facility), POLICY_ID);
        CounterfeitRegistryKernel counterfeit = new CounterfeitRegistryKernel(evaluator, configHash, manifestBytes);
        bytes32 runtimeVariantId = registry.packageRelease(releaseId).referenceVariantId;

        vm.expectRevert(PolicyRegistryV1.InvalidFacility.selector);
        vm.prank(PACKAGE_ISSUER);
        registry.recordDeployment(releaseId, address(counterfeit), address(0xDEAD), POLICY_ID, runtimeVariantId);
    }

    function test_facilityMustReportTheSuppliedKernel() public {
        bytes32 releaseId = _publishRelease();
        bytes32 configHash = _configureAndRegister(kernel, facility, policy, POLICY_ID);
        (address evaluator,, bytes memory manifestBytes) = kernel.policyOf(address(facility), POLICY_ID);
        CounterfeitRegistryKernel counterfeit = new CounterfeitRegistryKernel(evaluator, configHash, manifestBytes);
        bytes32 runtimeVariantId = registry.packageRelease(releaseId).referenceVariantId;

        vm.expectRevert(PolicyRegistryV1.FacilityKernelMismatch.selector);
        vm.prank(PACKAGE_ISSUER);
        registry.recordDeployment(releaseId, address(counterfeit), address(facility), POLICY_ID, runtimeVariantId);
    }

    function test_twoImmutableRuntimeVariantsShareOneReusableBuildRelease() public {
        bytes32 releaseId = _publishRelease();
        _configureAndRegister(kernel, facility, policy, POLICY_ID);

        PolicyKernelV1 secondKernel = new PolicyKernelV1(new MockVerifier());
        RegistryPolicyFacility secondFacility = new RegistryPolicyFacility(address(secondKernel), LENDER, BORROWER);
        EventHistoryPolicyV1 secondPolicy = new EventHistoryPolicyV1(secondKernel);
        _configureAndRegister(secondKernel, secondFacility, secondPolicy, POLICY_ID);

        assertTrue(address(policy).codehash != address(secondPolicy).codehash);
        bytes32 secondConstructorArgumentsHash = _constructorArgumentsHash(secondKernel);
        vm.expectRevert(PolicyRegistryV1.NotReleaseIssuer.selector);
        vm.prank(address(0xBEEF));
        registry.approveRuntimeVariant(releaseId, address(secondPolicy), secondConstructorArgumentsHash);

        vm.prank(PACKAGE_ISSUER);
        bytes32 secondVariantId =
            registry.approveRuntimeVariant(releaseId, address(secondPolicy), secondConstructorArgumentsHash);
        vm.expectRevert(PolicyRegistryV1.RuntimeVariantAlreadyApproved.selector);
        vm.prank(PACKAGE_ISSUER);
        registry.approveRuntimeVariant(releaseId, address(secondPolicy), secondConstructorArgumentsHash);
        bytes32 referenceVariantId = registry.packageRelease(releaseId).referenceVariantId;

        vm.prank(PACKAGE_ISSUER);
        bytes32 firstDeploymentId =
            registry.recordDeployment(releaseId, address(kernel), address(facility), POLICY_ID, referenceVariantId);
        vm.prank(PACKAGE_ISSUER);
        bytes32 secondDeploymentId = registry.recordDeployment(
            releaseId, address(secondKernel), address(secondFacility), POLICY_ID, secondVariantId
        );

        assertEq(registry.runtimeVariantCount(releaseId), 2);
        assertEq(registry.runtimeVariantAt(releaseId, 1), secondVariantId);
        assertTrue(firstDeploymentId != secondDeploymentId);
        DeploymentRecord memory secondDeployment = registry.deploymentRecord(secondDeploymentId);
        assertEq(secondDeployment.releaseId, releaseId);
        assertEq(secondDeployment.runtimeVariantId, secondVariantId);
        assertEq(secondDeployment.runtimeCodeHash, address(secondPolicy).codehash);
        assertEq(secondDeployment.constructorArgumentsHash, secondConstructorArgumentsHash);
    }

    function test_approvedRuntimeWithWrongConstructorArgumentsRejectsDeployment() public {
        bytes32 releaseId = _publishRelease();
        PolicyKernelV1 secondKernel = new PolicyKernelV1(new MockVerifier());
        RegistryPolicyFacility secondFacility = new RegistryPolicyFacility(address(secondKernel), LENDER, BORROWER);
        EventHistoryPolicyV1 secondPolicy = new EventHistoryPolicyV1(secondKernel);
        _configureAndRegister(secondKernel, secondFacility, secondPolicy, POLICY_ID);

        bytes32 wrongConstructorArgumentsHash = keccak256("wrong-constructor-arguments");
        vm.prank(PACKAGE_ISSUER);
        bytes32 variantId =
            registry.approveRuntimeVariant(releaseId, address(secondPolicy), wrongConstructorArgumentsHash);

        vm.expectRevert(PolicyRegistryV1.ConstructorArgumentsHashMismatch.selector);
        vm.prank(PACKAGE_ISSUER);
        registry.recordDeployment(releaseId, address(secondKernel), address(secondFacility), POLICY_ID, variantId);
    }

    function test_undeclaredRuntimeVariantRejects() public {
        bytes32 releaseId = _publishRelease();
        PolicyKernelV1 secondKernel = new PolicyKernelV1(new MockVerifier());
        RegistryPolicyFacility secondFacility = new RegistryPolicyFacility(address(secondKernel), LENDER, BORROWER);
        EventHistoryPolicyV1 secondPolicy = new EventHistoryPolicyV1(secondKernel);
        _configureAndRegister(secondKernel, secondFacility, secondPolicy, POLICY_ID);
        bytes32 undeclaredVariantId = registry.runtimeVariantIdOf(
            releaseId, address(secondPolicy).codehash, _constructorArgumentsHash(secondKernel)
        );

        vm.expectRevert(PolicyRegistryV1.RuntimeVariantNotApproved.selector);
        vm.prank(PACKAGE_ISSUER);
        registry.recordDeployment(
            releaseId, address(secondKernel), address(secondFacility), POLICY_ID, undeclaredVariantId
        );
    }

    function test_releaseAndDeploymentAuditScopesAreDistinctAndExact() public {
        bytes32 releaseId = _publishRelease();
        PackageRelease memory release = registry.packageRelease(releaseId);
        bytes32 expectedReleaseScopeHash =
            keccak256(abi.encode(block.chainid, address(registry), AuditScope.Release, releaseId, release));
        assertEq(registry.auditScopeHash(AuditScope.Release, releaseId), expectedReleaseScopeHash);

        vm.prank(AUDIT_ISSUER);
        bytes32 releaseArtifactId = registry.publishAuditArtifact(
            AuditScope.Release, releaseId, AUDIT_ARTIFACT_HASH, "ipfs://release-audit-report"
        );

        _configureAndRegister(kernel, facility, policy, POLICY_ID);
        vm.prank(PACKAGE_ISSUER);
        bytes32 deploymentId = registry.recordDeployment(
            releaseId, address(kernel), address(facility), POLICY_ID, release.referenceVariantId
        );
        DeploymentRecord memory deployment = registry.deploymentRecord(deploymentId);
        bytes32 expectedDeploymentScopeHash =
            keccak256(abi.encode(block.chainid, address(registry), AuditScope.Deployment, deploymentId, deployment));
        assertEq(registry.auditScopeHash(AuditScope.Deployment, deploymentId), expectedDeploymentScopeHash);

        vm.prank(AUDIT_ISSUER);
        bytes32 deploymentArtifactId = registry.publishAuditArtifact(
            AuditScope.Deployment, deploymentId, AUDIT_ARTIFACT_HASH, "ipfs://deployment-audit-report"
        );

        AuditArtifact memory releaseArtifact = registry.auditArtifact(releaseArtifactId);
        assertEq(uint256(releaseArtifact.scope), uint256(AuditScope.Release));
        assertEq(releaseArtifact.releaseId, releaseId);
        assertEq(releaseArtifact.deploymentId, bytes32(0));
        assertEq(releaseArtifact.scopeHash, expectedReleaseScopeHash);
        assertEq(releaseArtifact.auditor, AUDIT_ISSUER);

        AuditArtifact memory deploymentArtifact = registry.auditArtifact(deploymentArtifactId);
        assertEq(uint256(deploymentArtifact.scope), uint256(AuditScope.Deployment));
        assertEq(deploymentArtifact.releaseId, releaseId);
        assertEq(deploymentArtifact.deploymentId, deploymentId);
        assertEq(deploymentArtifact.scopeHash, expectedDeploymentScopeHash);
        assertEq(deploymentArtifact.auditor, AUDIT_ISSUER);
        assertTrue(releaseArtifactId != deploymentArtifactId);
        assertEq(registry.auditArtifactCount(AuditScope.Release, releaseId), 1);
        assertEq(registry.auditArtifactAt(AuditScope.Release, releaseId, 0), releaseArtifactId);
        assertEq(registry.auditArtifactCount(AuditScope.Deployment, deploymentId), 1);
        assertEq(registry.auditArtifactAt(AuditScope.Deployment, deploymentId, 0), deploymentArtifactId);

        vm.expectRevert(PolicyRegistryV1.AuditArtifactAlreadyPublished.selector);
        vm.prank(AUDIT_ISSUER);
        registry.publishAuditArtifact(
            AuditScope.Deployment, deploymentId, AUDIT_ARTIFACT_HASH, "ipfs://relocated-report"
        );

        vm.expectRevert(PolicyRegistryV1.DeploymentNotFound.selector);
        registry.publishAuditArtifact(
            AuditScope.Deployment, keccak256("missing"), AUDIT_ARTIFACT_HASH, "ipfs://missing-deployment"
        );
    }

    function _publishRelease() private returns (bytes32 releaseId) {
        vm.prank(PACKAGE_ISSUER);
        return registry.publishRelease(
            "event-history",
            "1.0.0",
            address(policy),
            BUILD_ARTIFACT_HASH,
            _constructorArgumentsHash(kernel),
            METADATA_HASH,
            _evidenceKinds(),
            _adapters()
        );
    }

    function _configureAndRegister(
        PolicyKernelV1 policyKernel,
        RegistryPolicyFacility policyFacility,
        EventHistoryPolicyV1 policyEvaluator,
        uint256 policyId
    ) private returns (bytes32 configHash) {
        EventHistoryPolicyV1.Configuration memory configuration = _configuration();
        vm.prank(LENDER);
        policyEvaluator.configure(address(policyFacility), policyId, configuration);
        vm.prank(LENDER);
        policyKernel.registerPolicy(address(policyFacility), policyId, policyEvaluator);
        return keccak256(abi.encode(configuration));
    }

    function _configuration() private pure returns (EventHistoryPolicyV1.Configuration memory) {
        return EventHistoryPolicyV1.Configuration({
            sourceChain: 3,
            emitter: EMITTER,
            eventSignature: EVENT_SIGNATURE,
            subject: BORROWER,
            startSourceBlock: 25_826_500,
            endSourceBlock: 25_826_600,
            topicCount: 3,
            subjectTopicIndex: 2,
            dataLength: 64,
            observedValueOffset: 32,
            observationKind: ObservationKind.Liability,
            evidenceKind: EvidenceKind.EventDelta,
            freshnessPeriod: 1 days,
            effect: PolicyEffect({
                outcome: PolicyOutcome.Restricted,
                creditLimitBps: 6_000,
                futureDrawFeeBps: 250,
                freezePendingDraw: true,
                requireFreshEvidence: true,
                terminate: false
            })
        });
    }

    function _constructorArgumentsHash(PolicyKernelV1 policyKernel) private pure returns (bytes32) {
        return keccak256(abi.encode(address(policyKernel)));
    }

    function _evidenceKinds() private pure returns (EvidenceKind[] memory evidenceKinds) {
        evidenceKinds = new EvidenceKind[](2);
        evidenceKinds[0] = EvidenceKind.EventDelta;
        evidenceKinds[1] = EvidenceKind.EventTransition;
    }

    function _adapters() private pure returns (ActionAdapterDeclaration[] memory adapters) {
        adapters = new ActionAdapterDeclaration[](1);
        adapters[0] = ActionAdapterDeclaration({
            adapterKind: ADAPTER_KIND,
            specificationHash: ADAPTER_SPECIFICATION_HASH,
            metadataURI: "ipfs://freeze-vault-v1-metadata-only"
        });
    }
}
