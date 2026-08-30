// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {
    ActionAdapterDeclaration,
    DeploymentRecord,
    IPolicyRegistryV1,
    PackageRelease
} from "../v2/interfaces/IPolicyRegistryV1.sol";
import {EvidenceKind, FacilityStatus} from "../v2/types/RecourseTypesV2.sol";

interface IPortfolioFactoryV1 {
    function isFacility(address facility) external view returns (bool);
}

interface IPortfolioFacilityV1 {
    function asset() external view returns (IERC20);
    function kernel() external view returns (address);
    function facilityLimit() external view returns (uint256);
    function bondRequired() external view returns (uint256);
    function initialDrawFeeBps() external view returns (uint16);
    function maturityBlock() external view returns (uint64);
    function status() external view returns (FacilityStatus);
}

interface IPortfolioKernelV1 {
    function policySetCommitment(address facility) external view returns (bytes32);
}

contract PortfolioMandateV1 {
    enum EligibilityCode {
        Eligible,
        UnknownFacility,
        WrongAsset,
        WrongKernel,
        InvalidStatus,
        FacilityLimitExceeded,
        BondBelowMinimum,
        DrawFeeExceeded,
        InvalidMaturity,
        PolicySetMismatch,
        UnknownRelease,
        InvalidDeployment,
        MissingEvidenceKind,
        MissingActionAdapter
    }

    error InvalidMandate();
    error ZeroAddress();

    IPortfolioFactoryV1 public immutable factory;
    IPolicyRegistryV1 public immutable registry;
    IERC20 public immutable asset;
    address public immutable kernel;
    bytes32 public immutable requiredReleaseId;
    bytes32 public immutable requiredPolicySetCommitment;
    EvidenceKind public immutable requiredEvidenceKind;
    bytes32 public immutable requiredActionAdapterKind;
    uint256 public immutable maximumFacilityLimit;
    uint16 public immutable minimumBondBps;
    uint16 public immutable maximumDrawFeeBps;
    uint64 public immutable maximumRemainingMaturityBlocks;

    constructor(
        IPortfolioFactoryV1 factory_,
        IPolicyRegistryV1 registry_,
        IERC20 asset_,
        address kernel_,
        bytes32 requiredReleaseId_,
        bytes32 requiredPolicySetCommitment_,
        EvidenceKind requiredEvidenceKind_,
        bytes32 requiredActionAdapterKind_,
        uint256 maximumFacilityLimit_,
        uint16 minimumBondBps_,
        uint16 maximumDrawFeeBps_,
        uint64 maximumRemainingMaturityBlocks_
    ) {
        if (
            address(factory_) == address(0) || address(registry_) == address(0) || address(asset_) == address(0)
                || kernel_ == address(0)
        ) revert ZeroAddress();
        if (
            requiredReleaseId_ == bytes32(0) || requiredPolicySetCommitment_ == bytes32(0)
                || requiredActionAdapterKind_ == bytes32(0) || maximumFacilityLimit_ == 0 || minimumBondBps_ == 0
                || minimumBondBps_ > 10_000 || maximumDrawFeeBps_ > 10_000 || maximumRemainingMaturityBlocks_ == 0
        ) revert InvalidMandate();
        factory = factory_;
        registry = registry_;
        asset = asset_;
        kernel = kernel_;
        requiredReleaseId = requiredReleaseId_;
        requiredPolicySetCommitment = requiredPolicySetCommitment_;
        requiredEvidenceKind = requiredEvidenceKind_;
        requiredActionAdapterKind = requiredActionAdapterKind_;
        maximumFacilityLimit = maximumFacilityLimit_;
        minimumBondBps = minimumBondBps_;
        maximumDrawFeeBps = maximumDrawFeeBps_;
        maximumRemainingMaturityBlocks = maximumRemainingMaturityBlocks_;
    }

    function evaluate(address facility, bytes32 deploymentId) external view returns (EligibilityCode) {
        if (!factory.isFacility(facility)) return EligibilityCode.UnknownFacility;
        IPortfolioFacilityV1 candidate = IPortfolioFacilityV1(facility);
        if (address(candidate.asset()) != address(asset)) return EligibilityCode.WrongAsset;
        if (candidate.kernel() != kernel) return EligibilityCode.WrongKernel;
        FacilityStatus currentStatus = candidate.status();
        if (currentStatus != FacilityStatus.Created && currentStatus != FacilityStatus.Active) {
            return EligibilityCode.InvalidStatus;
        }
        uint256 limit = candidate.facilityLimit();
        if (limit == 0 || limit > maximumFacilityLimit) return EligibilityCode.FacilityLimitExceeded;
        uint256 minimumBond = Math.mulDiv(limit, minimumBondBps, 10_000, Math.Rounding.Ceil);
        if (candidate.bondRequired() < minimumBond) return EligibilityCode.BondBelowMinimum;
        if (candidate.initialDrawFeeBps() > maximumDrawFeeBps) return EligibilityCode.DrawFeeExceeded;
        uint64 maturity = candidate.maturityBlock();
        if (maturity <= block.number || uint256(maturity) > block.number + maximumRemainingMaturityBlocks) {
            return EligibilityCode.InvalidMaturity;
        }
        if (IPortfolioKernelV1(kernel).policySetCommitment(facility) != requiredPolicySetCommitment) {
            return EligibilityCode.PolicySetMismatch;
        }

        PackageRelease memory release = registry.packageRelease(requiredReleaseId);
        if (!release.exists) return EligibilityCode.UnknownRelease;
        DeploymentRecord memory deployment = registry.deploymentRecord(deploymentId);
        if (
            !deployment.exists || deployment.releaseId != requiredReleaseId || deployment.chainId != block.chainid
                || deployment.kernel != kernel || deployment.facility != facility || deployment.evaluator == address(0)
                || deployment.configHash == bytes32(0) || deployment.manifestHash == bytes32(0)
        ) return EligibilityCode.InvalidDeployment;
        if (!registry.declaresEvidenceKind(requiredReleaseId, requiredEvidenceKind)) {
            return EligibilityCode.MissingEvidenceKind;
        }

        uint256 adapterCount = registry.actionAdapterCount(requiredReleaseId);
        for (uint256 i; i < adapterCount; ++i) {
            ActionAdapterDeclaration memory declaration = registry.actionAdapterAt(requiredReleaseId, i);
            if (declaration.adapterKind == requiredActionAdapterKind) return EligibilityCode.Eligible;
        }
        return EligibilityCode.MissingActionAdapter;
    }
}
