// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {RecourseFacilityV3} from "./RecourseFacilityV3.sol";

contract CappedPilotFactoryV1 {
    error CreationPaused();
    error FacilityCountExceeded();
    error FacilityLimitExceeded();
    error InvalidBond();
    error InvalidDrawFee();
    error InvalidMaturity();
    error InvalidParameters();
    error NotGuardian();
    error NotLender();
    error TotalLimitExceeded();
    error ZeroAddress();

    event CreationPauseSet(bool paused);
    event PilotFacilityCreated(address indexed facility, uint256 facilityLimit, uint256 bondRequired);

    IERC20 public immutable asset;
    address public immutable kernel;
    address public immutable lender;
    address public immutable borrower;
    address public immutable guardian;
    uint256 public immutable maximumFacilityLimit;
    uint256 public immutable maximumTotalLimit;
    uint16 public immutable minimumBondBps;
    uint16 public immutable maximumDrawFeeBps;
    uint64 public immutable maximumMaturityBlocks;
    uint32 public immutable maximumDrawDelayBlocks;
    uint16 public immutable maximumFacilityCount;

    bool public creationPaused;
    uint256 public totalFacilityLimit;
    address[] private facilities;
    mapping(address facility => bool created) public isFacility;

    constructor(
        IERC20 asset_,
        address kernel_,
        address lender_,
        address borrower_,
        address guardian_,
        uint256 maximumFacilityLimit_,
        uint256 maximumTotalLimit_,
        uint16 minimumBondBps_,
        uint16 maximumDrawFeeBps_,
        uint64 maximumMaturityBlocks_,
        uint32 maximumDrawDelayBlocks_,
        uint16 maximumFacilityCount_
    ) {
        if (
            address(asset_) == address(0) || kernel_ == address(0) || lender_ == address(0) || borrower_ == address(0)
                || guardian_ == address(0)
        ) revert ZeroAddress();
        if (
            lender_ == borrower_ || maximumFacilityLimit_ == 0 || maximumTotalLimit_ < maximumFacilityLimit_
                || minimumBondBps_ == 0 || minimumBondBps_ > 10_000 || maximumDrawFeeBps_ > 10_000
                || maximumMaturityBlocks_ == 0 || maximumFacilityCount_ == 0
        ) revert InvalidParameters();

        asset = asset_;
        kernel = kernel_;
        lender = lender_;
        borrower = borrower_;
        guardian = guardian_;
        maximumFacilityLimit = maximumFacilityLimit_;
        maximumTotalLimit = maximumTotalLimit_;
        minimumBondBps = minimumBondBps_;
        maximumDrawFeeBps = maximumDrawFeeBps_;
        maximumMaturityBlocks = maximumMaturityBlocks_;
        maximumDrawDelayBlocks = maximumDrawDelayBlocks_;
        maximumFacilityCount = maximumFacilityCount_;
    }

    function setCreationPaused(bool paused) external {
        if (msg.sender != guardian) revert NotGuardian();
        creationPaused = paused;
        emit CreationPauseSet(paused);
    }

    function createFacility(
        uint256 facilityLimit,
        uint256 bondRequired,
        uint16 drawFeeBps,
        uint64 maturityBlock,
        uint32 drawDelayBlocks
    ) external returns (address facility) {
        if (msg.sender != lender) revert NotLender();
        if (creationPaused) revert CreationPaused();
        if (facilities.length >= maximumFacilityCount) revert FacilityCountExceeded();
        if (facilityLimit == 0 || facilityLimit > maximumFacilityLimit) revert FacilityLimitExceeded();
        if (totalFacilityLimit + facilityLimit > maximumTotalLimit) revert TotalLimitExceeded();
        if (bondRequired < Math.mulDiv(facilityLimit, minimumBondBps, 10_000, Math.Rounding.Ceil)) {
            revert InvalidBond();
        }
        if (drawFeeBps > maximumDrawFeeBps) revert InvalidDrawFee();
        if (
            maturityBlock <= block.number || uint256(maturityBlock) > block.number + maximumMaturityBlocks
                || drawDelayBlocks > maximumDrawDelayBlocks
        ) revert InvalidMaturity();

        facility = address(
            new RecourseFacilityV3(
                asset, kernel, lender, borrower, facilityLimit, bondRequired, drawFeeBps, maturityBlock, drawDelayBlocks
            )
        );
        totalFacilityLimit += facilityLimit;
        facilities.push(facility);
        isFacility[facility] = true;
        emit PilotFacilityCreated(facility, facilityLimit, bondRequired);
    }

    function facilityCount() external view returns (uint256) {
        return facilities.length;
    }

    function facilityAt(uint256 index) external view returns (address) {
        return facilities[index];
    }
}
