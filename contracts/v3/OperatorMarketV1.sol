// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IOperatorServiceVerifierV1} from "./interfaces/IOperatorServiceVerifierV1.sol";

contract OperatorMarketV1 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum ServiceKind {
        Monitoring,
        ProofConstruction,
        Submission,
        Delivery
    }

    enum QuoteStatus {
        Open,
        Accepted,
        Settled,
        Cancelled,
        Expired
    }

    struct Quote {
        address operator;
        address intendedSponsor;
        address sponsor;
        ServiceKind serviceKind;
        QuoteStatus status;
        uint64 quoteExpiry;
        uint64 serviceDuration;
        uint64 acceptedAt;
        uint64 deliveryDeadline;
        uint256 price;
        uint256 operatorBond;
        bytes32 requirementsDigest;
        bytes32 deliveryDigest;
    }

    error InvalidAmount();
    error InvalidDigest();
    error InvalidExpiry();
    error NoRuntimeCode();
    error NotOperator();
    error NotSponsor();
    error ServiceNotVerified();
    error TransferAmountMismatch();
    error WrongStatus(QuoteStatus expected, QuoteStatus actual);
    error ZeroAddress();

    event QuoteAccepted(uint256 indexed quoteId, address indexed sponsor);
    event QuoteCancelled(uint256 indexed quoteId);
    event QuoteExpired(uint256 indexed quoteId, address indexed sponsor);
    event QuotePosted(
        uint256 indexed quoteId,
        address indexed operator,
        ServiceKind indexed serviceKind,
        address intendedSponsor,
        bytes32 requirementsDigest,
        uint256 price,
        uint256 operatorBond,
        uint64 quoteExpiry,
        uint64 serviceDuration
    );
    event ServiceSettled(uint256 indexed quoteId, bytes32 indexed agreementId, bytes32 indexed deliveryDigest);
    event Withdrawn(address indexed account, uint256 amount);

    IERC20 public immutable token;
    IOperatorServiceVerifierV1 public immutable verifier;
    uint256 public immutable minimumOperatorBond;
    uint64 public immutable maximumQuoteDuration;
    uint64 public immutable maximumServiceDuration;

    Quote[] private quotes;
    mapping(address account => uint256 amount) public claimable;

    constructor(
        IERC20 token_,
        IOperatorServiceVerifierV1 verifier_,
        uint256 minimumOperatorBond_,
        uint64 maximumQuoteDuration_,
        uint64 maximumServiceDuration_
    ) {
        if (address(token_) == address(0) || address(verifier_) == address(0)) {
            revert ZeroAddress();
        }
        if (address(token_).code.length == 0 || address(verifier_).code.length == 0) revert NoRuntimeCode();
        if (minimumOperatorBond_ == 0) revert InvalidAmount();
        if (maximumQuoteDuration_ == 0 || maximumServiceDuration_ == 0) revert InvalidExpiry();
        token = token_;
        verifier = verifier_;
        minimumOperatorBond = minimumOperatorBond_;
        maximumQuoteDuration = maximumQuoteDuration_;
        maximumServiceDuration = maximumServiceDuration_;
    }

    function postQuote(
        ServiceKind serviceKind,
        address intendedSponsor,
        bytes32 requirementsDigest,
        uint256 price,
        uint256 operatorBond,
        uint64 quoteExpiry,
        uint64 serviceDuration
    ) external nonReentrant returns (uint256 quoteId) {
        if (intendedSponsor == msg.sender) revert NotSponsor();
        if (requirementsDigest == bytes32(0)) revert InvalidDigest();
        if (price == 0 || operatorBond < minimumOperatorBond) revert InvalidAmount();
        if (quoteExpiry <= block.timestamp || uint256(quoteExpiry) > block.timestamp + maximumQuoteDuration) {
            revert InvalidExpiry();
        }
        if (serviceDuration == 0 || serviceDuration > maximumServiceDuration) {
            revert InvalidExpiry();
        }
        _pull(msg.sender, operatorBond);
        quoteId = quotes.length;
        quotes.push(
            Quote({
                operator: msg.sender,
                intendedSponsor: intendedSponsor,
                sponsor: address(0),
                serviceKind: serviceKind,
                status: QuoteStatus.Open,
                quoteExpiry: quoteExpiry,
                serviceDuration: serviceDuration,
                acceptedAt: 0,
                deliveryDeadline: 0,
                price: price,
                operatorBond: operatorBond,
                requirementsDigest: requirementsDigest,
                deliveryDigest: bytes32(0)
            })
        );
        emit QuotePosted(
            quoteId,
            msg.sender,
            serviceKind,
            intendedSponsor,
            requirementsDigest,
            price,
            operatorBond,
            quoteExpiry,
            serviceDuration
        );
    }

    function acceptQuote(uint256 quoteId) external nonReentrant returns (bytes32 agreementId) {
        Quote storage quote = quotes[quoteId];
        _requireStatus(quote, QuoteStatus.Open);
        if (block.timestamp >= quote.quoteExpiry) revert InvalidExpiry();
        if (
            msg.sender == quote.operator || (quote.intendedSponsor != address(0) && msg.sender != quote.intendedSponsor)
        ) revert NotSponsor();
        if (block.timestamp > type(uint64).max - quote.serviceDuration) revert InvalidExpiry();
        _pull(msg.sender, quote.price);
        uint64 acceptedAt = uint64(block.timestamp);
        quote.sponsor = msg.sender;
        quote.status = QuoteStatus.Accepted;
        quote.acceptedAt = acceptedAt;
        quote.deliveryDeadline = acceptedAt + quote.serviceDuration;
        agreementId = agreementIdOf(quoteId, msg.sender);
        emit QuoteAccepted(quoteId, msg.sender);
    }

    function settle(uint256 quoteId, bytes32 deliveryDigest, bytes calldata evidence) external nonReentrant {
        Quote storage quote = quotes[quoteId];
        _requireStatus(quote, QuoteStatus.Accepted);
        if (block.timestamp >= quote.deliveryDeadline) revert InvalidExpiry();
        if (deliveryDigest == bytes32(0)) revert InvalidDigest();
        bytes32 agreementId = agreementIdOf(quoteId, quote.sponsor);
        if (!verifier.verifyService(
                agreementId,
                uint8(quote.serviceKind),
                quote.operator,
                quote.sponsor,
                quote.acceptedAt,
                quote.deliveryDeadline,
                quote.requirementsDigest,
                deliveryDigest,
                evidence
            )) {
            revert ServiceNotVerified();
        }

        quote.deliveryDigest = deliveryDigest;
        quote.status = QuoteStatus.Settled;
        claimable[quote.operator] += quote.price + quote.operatorBond;
        emit ServiceSettled(quoteId, agreementId, deliveryDigest);
    }

    function cancelQuote(uint256 quoteId) external nonReentrant {
        Quote storage quote = quotes[quoteId];
        _requireStatus(quote, QuoteStatus.Open);
        if (msg.sender != quote.operator) revert NotOperator();
        quote.status = QuoteStatus.Cancelled;
        claimable[quote.operator] += quote.operatorBond;
        emit QuoteCancelled(quoteId);
    }

    function expireQuote(uint256 quoteId) external nonReentrant {
        Quote storage quote = quotes[quoteId];
        if (quote.status == QuoteStatus.Open) {
            if (block.timestamp < quote.quoteExpiry) revert InvalidExpiry();
            quote.status = QuoteStatus.Expired;
            claimable[quote.operator] += quote.operatorBond;
            emit QuoteExpired(quoteId, address(0));
            return;
        }
        _requireStatus(quote, QuoteStatus.Accepted);
        if (block.timestamp < quote.deliveryDeadline) revert InvalidExpiry();
        quote.status = QuoteStatus.Expired;
        claimable[quote.sponsor] += quote.price + quote.operatorBond;
        emit QuoteExpired(quoteId, quote.sponsor);
    }

    function withdraw() external nonReentrant {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert InvalidAmount();
        claimable[msg.sender] = 0;
        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function quoteCount() external view returns (uint256) {
        return quotes.length;
    }

    function quoteAt(uint256 quoteId) external view returns (Quote memory) {
        return quotes[quoteId];
    }

    function agreementIdOf(uint256 quoteId, address sponsor) public view returns (bytes32) {
        Quote storage quote = quotes[quoteId];
        return keccak256(
            abi.encode(
                address(this),
                block.chainid,
                quoteId,
                quote.operator,
                quote.intendedSponsor,
                sponsor,
                quote.serviceKind,
                quote.requirementsDigest,
                quote.price,
                quote.operatorBond,
                quote.quoteExpiry,
                quote.serviceDuration,
                quote.acceptedAt,
                quote.deliveryDeadline
            )
        );
    }

    function _pull(address from, uint256 amount) private {
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        if (token.balanceOf(address(this)) - beforeBalance != amount) revert TransferAmountMismatch();
    }

    function _requireStatus(Quote storage quote, QuoteStatus expected) private view {
        if (quote.status != expected) revert WrongStatus(expected, quote.status);
    }
}
