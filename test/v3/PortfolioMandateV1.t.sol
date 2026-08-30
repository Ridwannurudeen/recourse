// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    ActionAdapterDeclaration,
    DeploymentRecord,
    IPolicyRegistryV1,
    PackageRelease
} from "../../contracts/v2/interfaces/IPolicyRegistryV1.sol";
import {EvidenceKind, FacilityStatus} from "../../contracts/v2/types/RecourseTypesV2.sol";
import {IPortfolioFactoryV1, PortfolioMandateV1} from "../../contracts/v3/PortfolioMandateV1.sol";

contract MandateFactoryMock {
    mapping(address facility => bool created) public isFacility;

    function setFacility(address facility, bool created) external {
        isFacility[facility] = created;
    }
}

contract MandateKernelMock {
    mapping(address facility => bytes32 commitment) public policySetCommitment;

    function setCommitment(address facility, bytes32 commitment) external {
        policySetCommitment[facility] = commitment;
    }
}

contract MandateFacilityMock {
    IERC20 public asset;
    address public kernel;
    uint256 public facilityLimit;
    uint256 public bondRequired;
    uint16 public initialDrawFeeBps;
    uint64 public maturityBlock;
    FacilityStatus public status;

    function configure(
        IERC20 asset_,
        address kernel_,
        uint256 facilityLimit_,
        uint256 bondRequired_,
        uint16 drawFeeBps_,
        uint64 maturityBlock_,
        FacilityStatus status_
    ) external {
        asset = asset_;
        kernel = kernel_;
        facilityLimit = facilityLimit_;
        bondRequired = bondRequired_;
        initialDrawFeeBps = drawFeeBps_;
        maturityBlock = maturityBlock_;
        status = status_;
    }
}

contract MandateRegistryMock {
    PackageRelease private release;
    DeploymentRecord private deployment;
    bool private evidenceDeclared;
    ActionAdapterDeclaration[] private adapters;

    function setRelease(PackageRelease calldata value) external {
        release = value;
    }

    function setDeployment(DeploymentRecord calldata value) external {
        deployment = value;
    }

    function setEvidenceDeclared(bool value) external {
        evidenceDeclared = value;
    }

    function clearAdapters() external {
        delete adapters;
    }

    function addAdapter(ActionAdapterDeclaration calldata value) external {
        adapters.push(value);
    }

    function packageRelease(bytes32) external view returns (PackageRelease memory) {
        return release;
    }

    function deploymentRecord(bytes32) external view returns (DeploymentRecord memory) {
        return deployment;
    }

    function declaresEvidenceKind(bytes32, EvidenceKind) external view returns (bool) {
        return evidenceDeclared;
    }

    function actionAdapterCount(bytes32) external view returns (uint256) {
        return adapters.length;
    }

    function actionAdapterAt(bytes32, uint256 index) external view returns (ActionAdapterDeclaration memory) {
        return adapters[index];
    }
}

contract PortfolioMandateV1Test is Test {
    bytes32 private constant RELEASE_ID = keccak256("release");
    bytes32 private constant DEPLOYMENT_ID = keccak256("deployment");
    bytes32 private constant ADAPTER_KIND = keccak256("bounded-remedy-v1");
    bytes32 private constant POLICY_SET = keccak256("policy-set");
    IERC20 private constant ASSET = IERC20(address(0xA1));

    MandateFactoryMock private factory;
    MandateKernelMock private kernel;
    MandateFacilityMock private facility;
    MandateRegistryMock private registry;
    PortfolioMandateV1 private mandate;

    function setUp() public {
        factory = new MandateFactoryMock();
        kernel = new MandateKernelMock();
        facility = new MandateFacilityMock();
        registry = new MandateRegistryMock();
        mandate = new PortfolioMandateV1(
            IPortfolioFactoryV1(address(factory)),
            IPolicyRegistryV1(address(registry)),
            ASSET,
            address(kernel),
            RELEASE_ID,
            POLICY_SET,
            EvidenceKind.EventDelta,
            ADAPTER_KIND,
            1_000,
            2_000,
            300,
            1_000
        );
        _configureEligible();
    }

    function test_exactProvenanceRiskAndRegistryMandateIsEligible() public view {
        assertEq(uint256(mandate.evaluate(address(facility), DEPLOYMENT_ID)), 0);
    }

    function test_rejectsUnknownFactoryFacilityBeforeTrustingCandidateCalls() public {
        factory.setFacility(address(facility), false);
        _assertCode(PortfolioMandateV1.EligibilityCode.UnknownFacility);
    }

    function test_rejectsAssetKernelStatusAndEconomicBoundViolations() public {
        facility.configure(
            IERC20(address(0xBAD)),
            address(kernel),
            1_000,
            200,
            300,
            uint64(block.number + 1_000),
            FacilityStatus.Active
        );
        _assertCode(PortfolioMandateV1.EligibilityCode.WrongAsset);

        _resetFacility(address(0xBAD), 1_000, 200, 300, 1_000, FacilityStatus.Active);
        _assertCode(PortfolioMandateV1.EligibilityCode.WrongKernel);
        _resetFacility(address(kernel), 1_000, 200, 300, 1_000, FacilityStatus.Defaulted);
        _assertCode(PortfolioMandateV1.EligibilityCode.InvalidStatus);
        _resetFacility(address(kernel), 1_001, 201, 300, 1_000, FacilityStatus.Active);
        _assertCode(PortfolioMandateV1.EligibilityCode.FacilityLimitExceeded);
        _resetFacility(address(kernel), 1_000, 199, 300, 1_000, FacilityStatus.Active);
        _assertCode(PortfolioMandateV1.EligibilityCode.BondBelowMinimum);
        _resetFacility(address(kernel), 1_000, 200, 301, 1_000, FacilityStatus.Active);
        _assertCode(PortfolioMandateV1.EligibilityCode.DrawFeeExceeded);
        _resetFacility(address(kernel), 1_000, 200, 300, 1_001, FacilityStatus.Active);
        _assertCode(PortfolioMandateV1.EligibilityCode.InvalidMaturity);
    }

    function test_rejectsPolicySetMismatchAndUnregisteredRelease() public {
        kernel.setCommitment(address(facility), bytes32(0));
        _assertCode(PortfolioMandateV1.EligibilityCode.PolicySetMismatch);
        kernel.setCommitment(address(facility), keccak256("unapproved-policy-set"));
        _assertCode(PortfolioMandateV1.EligibilityCode.PolicySetMismatch);
        kernel.setCommitment(address(facility), POLICY_SET);
        PackageRelease memory release;
        registry.setRelease(release);
        _assertCode(PortfolioMandateV1.EligibilityCode.UnknownRelease);
    }

    function test_rejectsDeploymentThatDoesNotBindChainKernelFacilityAndRelease() public {
        DeploymentRecord memory deployment = _deployment();
        deployment.chainId = block.chainid + 1;
        registry.setDeployment(deployment);
        _assertCode(PortfolioMandateV1.EligibilityCode.InvalidDeployment);

        deployment = _deployment();
        deployment.manifestHash = bytes32(0);
        registry.setDeployment(deployment);
        _assertCode(PortfolioMandateV1.EligibilityCode.InvalidDeployment);
    }

    function test_rejectsMissingEvidenceAndActionAdapterDeclarations() public {
        registry.setEvidenceDeclared(false);
        _assertCode(PortfolioMandateV1.EligibilityCode.MissingEvidenceKind);
        registry.setEvidenceDeclared(true);
        registry.clearAdapters();
        _assertCode(PortfolioMandateV1.EligibilityCode.MissingActionAdapter);
        registry.addAdapter(ActionAdapterDeclaration(keccak256("other"), keccak256("spec"), "ipfs://other"));
        _assertCode(PortfolioMandateV1.EligibilityCode.MissingActionAdapter);
    }

    function _configureEligible() private {
        factory.setFacility(address(facility), true);
        _resetFacility(address(kernel), 1_000, 200, 300, 1_000, FacilityStatus.Active);
        kernel.setCommitment(address(facility), POLICY_SET);
        PackageRelease memory release;
        release.issuer = address(this);
        release.releaseContentHash = keccak256("content");
        release.exists = true;
        registry.setRelease(release);
        registry.setDeployment(_deployment());
        registry.setEvidenceDeclared(true);
        registry.addAdapter(ActionAdapterDeclaration(ADAPTER_KIND, keccak256("spec"), "ipfs://adapter"));
    }

    function _deployment() private view returns (DeploymentRecord memory deployment) {
        deployment.releaseId = RELEASE_ID;
        deployment.chainId = block.chainid;
        deployment.kernel = address(kernel);
        deployment.facility = address(facility);
        deployment.policyId = 1;
        deployment.evaluator = address(0xE1);
        deployment.configHash = keccak256("config");
        deployment.manifestHash = keccak256("manifest");
        deployment.exists = true;
    }

    function _resetFacility(
        address kernelAddress,
        uint256 limit,
        uint256 bond,
        uint16 fee,
        uint64 maturityDelta,
        FacilityStatus facilityStatus
    ) private {
        facility.configure(ASSET, kernelAddress, limit, bond, fee, uint64(block.number) + maturityDelta, facilityStatus);
    }

    function _assertCode(PortfolioMandateV1.EligibilityCode expected) private view {
        assertEq(uint256(mandate.evaluate(address(facility), DEPLOYMENT_ID)), uint256(expected));
    }
}
