// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {FacilityState} from "../types/RecourseTypes.sol";

interface IRecourseFacility {
    struct Facility {
        address lender;
        address borrower;
        uint256 facilityLimit;
        uint256 bondRequired;
        uint16 drawFeeBps;
        uint64 maturityBlock;
        uint32 drawDelayBlocks;
        FacilityState state;
        uint256 lenderFunded;
        uint256 bondPosted;
        uint256 drawnPrincipal;
        uint256 outstandingDebt;
        uint256 pendingDrawAmount;
        uint256 drawReadyAtBlock;
    }

    event FacilityOpened(uint256 indexed facilityId, address indexed lender, address indexed borrower);
    event FacilityActivated(uint256 indexed facilityId);
    event DrawRequested(uint256 indexed facilityId, uint256 amount, uint256 readyAtBlock);
    event DrawExecuted(uint256 indexed facilityId, uint256 amount, uint256 fee);
    event Repaid(uint256 indexed facilityId, uint256 amount, uint256 outstandingDebt);
    event Breached(uint256 indexed facilityId, address indexed hunter, uint256 debtReduction, uint256 hunterReward);
    event Defaulted(uint256 indexed facilityId);

    function openFacility(
        address lender,
        address borrower,
        uint256 facilityLimit,
        uint256 bondRequired,
        uint16 drawFeeBps,
        uint64 maturityBlock,
        uint32 drawDelayBlocks
    ) external returns (uint256 facilityId);

    function fundAsLender(uint256 facilityId) external payable;
    function postBond(uint256 facilityId) external payable;
    function activate(uint256 facilityId) external;
    function requestDraw(uint256 facilityId, uint256 amount) external;
    function executeDraw(uint256 facilityId) external;
    function repay(uint256 facilityId) external payable;
    function reportBreach(uint256 facilityId, address hunter) external;
    function markDefaulted(uint256 facilityId) external;
    function cancel(uint256 facilityId) external;
    function lenderWithdraw(uint256 facilityId) external;
    function claimBorrowerRefund(uint256 facilityId) external;
    function setAdjudicator(address adjudicator) external;

    function state(uint256 facilityId) external view returns (FacilityState);
    function outstandingDebt(uint256 facilityId) external view returns (uint256);
    function availableCredit(uint256 facilityId) external view returns (uint256);
    function lenderClaimable(uint256 facilityId) external view returns (uint256);
    function borrowerClaimable(uint256 facilityId) external view returns (uint256);
    function facilityOf(uint256 facilityId) external view returns (Facility memory);
}
