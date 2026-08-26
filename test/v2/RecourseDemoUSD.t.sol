// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {RecourseDemoUSD} from "../../contracts/v2/testnet/RecourseDemoUSD.sol";

contract RecourseDemoUSDTest is Test {
    function test_fixedSixDecimalAllocationsAreMintedOnlyAtDeployment() public {
        address lender = address(0xA1);
        address borrower = address(0xB2);
        address hunter = address(0xC3);
        RecourseDemoUSD token = new RecourseDemoUSD(lender, borrower, hunter);

        assertEq(token.name(), "Recourse Demo USD");
        assertEq(token.symbol(), "rUSD");
        assertEq(token.decimals(), 6);
        assertEq(token.balanceOf(lender), 5_000_000e6);
        assertEq(token.balanceOf(borrower), 1_000_000e6);
        assertEq(token.balanceOf(hunter), 100_000e6);
        assertEq(token.totalSupply(), 6_100_000e6);
    }
}
