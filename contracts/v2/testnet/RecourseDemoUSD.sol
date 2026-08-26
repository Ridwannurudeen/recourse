// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract RecourseDemoUSD is ERC20 {
    error ZeroAddress();

    constructor(address lender, address borrower, address hunter) ERC20("Recourse Demo USD", "rUSD") {
        if (lender == address(0) || borrower == address(0) || hunter == address(0)) revert ZeroAddress();
        _mint(lender, 5_000_000e6);
        _mint(borrower, 1_000_000e6);
        _mint(hunter, 100_000e6);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}
