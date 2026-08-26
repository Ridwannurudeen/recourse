// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RecourseFacilityV2} from "./RecourseFacilityV2.sol";

contract RecourseFacilityFactoryV2 {
    error CreationPaused();
    error NotGuardian();
    error ZeroAddress();

    event CreationPauseSet(bool paused);
    event FacilityCreated(
        address indexed facility, address indexed lender, address indexed borrower, IERC20 asset, address kernel
    );

    address public immutable guardian;
    bool public creationPaused;
    address[] private facilities;
    mapping(address facility => bool created) public isFacility;

    constructor(address guardian_) {
        if (guardian_ == address(0)) revert ZeroAddress();
        guardian = guardian_;
    }

    function setCreationPaused(bool paused) external {
        if (msg.sender != guardian) revert NotGuardian();
        creationPaused = paused;
        emit CreationPauseSet(paused);
    }

    function createFacility(
        IERC20 asset,
        address kernel,
        address lender,
        address borrower,
        uint256 facilityLimit,
        uint256 bondRequired,
        uint16 drawFeeBps,
        uint64 maturityBlock,
        uint32 drawDelayBlocks
    ) external returns (address facility) {
        if (creationPaused) revert CreationPaused();
        facility = address(
            new RecourseFacilityV2(
                asset, kernel, lender, borrower, facilityLimit, bondRequired, drawFeeBps, maturityBlock, drawDelayBlocks
            )
        );
        facilities.push(facility);
        isFacility[facility] = true;
        emit FacilityCreated(facility, lender, borrower, asset, kernel);
    }

    function facilityCount() external view returns (uint256) {
        return facilities.length;
    }

    function facilityAt(uint256 index) external view returns (address) {
        return facilities[index];
    }
}
