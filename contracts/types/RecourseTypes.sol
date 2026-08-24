// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

enum FacilityState { Created, Active, Repaid, Breached, Defaulted, Cancelled }

/// @notice A source-chain transaction whose inclusion has already been verified.
struct ProvenTx {
    uint64 chainKey;
    uint64 blockHeight;
    uint64 txIndex;
    bytes encodedTransaction;
}

error NotBorrower();
error NotLender();
error NotAdjudicator();
error WrongState(FacilityState expected, FacilityState actual);
error ProofAlreadyUsed(bytes32 queryId);
error VerificationFailed();
error TransactionReverted();
error IrrelevantEvidence();
error DrawNotReady(uint256 readyAtBlock);
error ExceedsFacility(uint256 requested, uint256 available);
error ZeroAmount();
error TransferFailed();
