// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {INativeQueryVerifier} from "@gluwa/usc-contracts/contracts/write-ability/common/INativeQueryVerifier.sol";

/// @dev The real precompile is native runtime code with no bytecode and cannot exist
///      on a local chain. Unit tests inject this instead.
contract MockVerifier is INativeQueryVerifier {
    bool public result = true;
    uint64 public txIndex;
    uint256 public verifyCalls;
    mapping(bytes32 root => uint64 index) private txIndexByRoot;
    mapping(bytes32 root => bool configured) private hasTxIndexForRoot;

    function setVerifyResult(bool value) external {
        result = value;
    }

    function setTxIndex(uint64 value) external {
        txIndex = value;
    }

    function setTxIndexForRoot(bytes32 root, uint64 value) external {
        txIndexByRoot[root] = value;
        hasTxIndexForRoot[root] = true;
    }

    function verify(uint64, uint64, bytes calldata, MerkleProof calldata, ContinuityProof calldata)
        external
        view
        returns (bool)
    {
        return result;
    }

    function verify(uint64, uint64[] calldata, bytes[] calldata, MerkleProof[] calldata, ContinuityProof calldata)
        external
        view
        returns (bool)
    {
        return result;
    }

    function verifyAndEmit(uint64, uint64, bytes calldata, MerkleProof calldata, ContinuityProof calldata)
        external
        returns (bool)
    {
        verifyCalls++;
        return result;
    }

    function verifyAndEmit(
        uint64,
        uint64[] calldata,
        bytes[] calldata,
        MerkleProof[] calldata,
        ContinuityProof calldata
    ) external returns (bool) {
        verifyCalls++;
        return result;
    }

    function calculateTxIndex(MerkleProof calldata merkleProof) external view returns (uint64) {
        if (hasTxIndexForRoot[merkleProof.root]) return txIndexByRoot[merkleProof.root];
        return txIndex;
    }
}
