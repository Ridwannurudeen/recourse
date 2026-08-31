// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RecourseFacilityV2} from "../v2/RecourseFacilityV2.sol";
import {FacilityStatus} from "../v2/types/RecourseTypesV2.sol";

contract RecourseFacilityV3 is RecourseFacilityV2 {
    event DefaultLossSettled(uint256 lenderRecovery, uint256 borrowerExcess, uint256 remainingDebt);

    constructor(
        IERC20 asset_,
        address kernel_,
        address lender_,
        address borrower_,
        uint256 facilityLimit_,
        uint256 bondRequired_,
        uint16 drawFeeBps_,
        uint64 maturityBlock_,
        uint32 drawDelayBlocks_
    )
        RecourseFacilityV2(
            asset_,
            kernel_,
            lender_,
            borrower_,
            facilityLimit_,
            bondRequired_,
            drawFeeBps_,
            maturityBlock_,
            drawDelayBlocks_
        )
    {}

    function settleDefaultLoss() external nonReentrant {
        if (msg.sender != lender) revert NotLender();
        if (status != FacilityStatus.Defaulted) {
            if (status != FacilityStatus.Terminated) revert WrongState(FacilityStatus.Defaulted, status);
            if (block.number <= maturityBlock) revert DrawNotReady(uint256(maturityBlock) + 1);
        }
        uint256 bond = bondPosted;
        if (bond == 0) revert ZeroAmount();

        uint256 lenderRecovery = bond > outstandingDebt ? outstandingDebt : bond;
        uint256 borrowerExcess = bond - lenderRecovery;
        bondPosted = 0;
        outstandingDebt -= lenderRecovery;
        lenderClaimable += lenderRecovery;
        borrowerClaimable += borrowerExcess;

        emit DefaultLossSettled(lenderRecovery, borrowerExcess, outstandingDebt);
    }
}
