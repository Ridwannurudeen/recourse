// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

enum PolicyOutcome {
    Eligible,
    Watch,
    Restricted,
    MarginCalled,
    Breached,
    Cured
}

enum ObservationKind {
    Ownership,
    Collateral,
    Position,
    Liability,
    Behaviour
}

enum EvidenceKind {
    TransactionControl,
    EventDelta,
    EventTransition
}

enum FacilityStatus {
    Created,
    Active,
    Repaid,
    Defaulted,
    Cancelled,
    Terminated
}

struct ProvenTransaction {
    uint64 chainKey;
    uint64 blockHeight;
    uint64 txIndex;
    bytes encodedTransaction;
}

struct PolicyEffect {
    PolicyOutcome outcome;
    uint16 creditLimitBps;
    uint16 futureDrawFeeBps;
    bool freezePendingDraw;
    bool requireFreshEvidence;
    bool terminate;
}

struct CreditObservation {
    ObservationKind kind;
    EvidenceKind evidenceKind;
    uint64 sourceChain;
    uint64 sourceBlock;
    uint64 transactionIndex;
    address subject;
    address emitter;
    uint256 observedValue;
    uint64 proofTime;
    uint64 expiry;
    bytes32 evidenceDigest;
    bytes32 policyEffectHash;
}

struct PolicyResult {
    PolicyEffect effect;
    ObservationKind observationKind;
    EvidenceKind evidenceKind;
    uint64 sourceBlock;
    uint64 transactionIndex;
    address subject;
    address emitter;
    uint256 observedValue;
    uint64 freshnessPeriod;
}
