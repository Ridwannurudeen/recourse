// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface ISourceOrderingPolicyV1 {
    enum SourceOrdering {
        StrictlyIncreasing,
        UniqueOnly
    }

    function sourceOrdering() external pure returns (SourceOrdering);
}
