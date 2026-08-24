// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {INativeQueryVerifier} from "@gluwa/usc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";

/// @dev The real precompile is native runtime code with no bytecode and cannot exist
///      on a local chain. Unit tests inject this instead.
contract MockVerifier is INativeQueryVerifier {
    bool public result = true;
    uint64 public txIndex;
    uint256 public verifyCalls;

    function setVerifyResult(bool value) external { result = value; }
    function setTxIndex(uint64 value) external { txIndex = value; }

    function verify(uint64, uint64, bytes calldata, MerkleProof calldata, ContinuityProof calldata)
        external view returns (bool) { return result; }

    function verify(uint64, uint64[] calldata, bytes[] calldata, MerkleProof[] calldata, ContinuityProof calldata)
        external view returns (bool) { return result; }

    function verifyAndEmit(uint64, uint64, bytes calldata, MerkleProof calldata, ContinuityProof calldata)
        external returns (bool) { verifyCalls++; return result; }

    function verifyAndEmit(uint64, uint64[] calldata, bytes[] calldata, MerkleProof[] calldata, ContinuityProof calldata)
        external returns (bool) { verifyCalls++; return result; }

    function calculateTxIndex(MerkleProof calldata) external view returns (uint64) { return txIndex; }
}
