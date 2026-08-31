// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {MockVerifier} from "./MockVerifier.sol";
import {INativeQueryVerifier} from "@gluwa/usc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";

contract MockVerifierTest is Test {
    MockVerifier verifier;

    function setUp() public {
        verifier = new MockVerifier();
    }

    function test_defaultsToVerifyingTrue() public view {
        INativeQueryVerifier.MerkleProof memory m;
        INativeQueryVerifier.ContinuityProof memory c;
        assertTrue(verifier.verify(3, 100, hex"00", m, c));
    }

    function test_canBeSetToFail() public {
        verifier.setVerifyResult(false);
        INativeQueryVerifier.MerkleProof memory m;
        INativeQueryVerifier.ContinuityProof memory c;
        assertFalse(verifier.verify(3, 100, hex"00", m, c));
    }

    function test_reportsConfiguredTxIndex() public {
        verifier.setTxIndex(7);
        INativeQueryVerifier.MerkleProof memory m;
        assertEq(verifier.calculateTxIndex(m), 7);
    }
}
