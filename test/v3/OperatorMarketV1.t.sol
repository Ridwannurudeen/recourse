// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {OperatorMarketV1} from "../../contracts/v3/OperatorMarketV1.sol";
import {IOperatorServiceVerifierV1} from "../../contracts/v3/interfaces/IOperatorServiceVerifierV1.sol";

contract MarketToken is ERC20 {
    constructor() ERC20("Market USD", "MUSD") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }
}

contract ReentrantMarketToken is ERC20 {
    OperatorMarketV1 public market;
    uint256 public quoteId;
    address public sponsor;
    bool public attack;

    constructor() ERC20("Reentrant Market USD", "RMUSD") {}

    function configure(OperatorMarketV1 market_, address sponsor_) external {
        market = market_;
        sponsor = sponsor_;
        _approve(address(this), address(market_), type(uint256).max);
    }

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    function postQuote(bytes32 requirements, uint256 price, uint256 bond) external {
        quoteId = market.postQuote(
            OperatorMarketV1.ServiceKind.ProofConstruction,
            sponsor,
            requirements,
            price,
            bond,
            uint64(block.timestamp + 1 days),
            1 days
        );
    }

    function arm() external {
        attack = true;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (attack && from == sponsor) {
            attack = false;
            market.cancelQuote(quoteId);
        }
        return super.transferFrom(from, to, amount);
    }
}

contract MarketVerifier is IOperatorServiceVerifierV1 {
    bool public result = true;
    bytes32 public expectedAgreement;
    uint8 public expectedServiceKind;
    address public expectedOperator;
    address public expectedSponsor;
    uint64 public expectedAcceptedAt;
    uint64 public expectedDeliveryDeadline;
    bytes32 public expectedRequirements;
    bytes32 public expectedDelivery;
    bytes32 public expectedEvidenceHash;
    OperatorMarketV1 public callbackMarket;
    uint256 public callbackQuoteId;
    bool public callbackAttempted;
    bool public callbackSucceeded;
    bytes32 public callbackErrorHash;

    function setResult(bool value) external {
        result = value;
    }

    function setExpected(
        bytes32 agreement,
        uint8 serviceKind,
        address operator,
        address sponsor,
        uint64 acceptedAt,
        uint64 deliveryDeadline,
        bytes32 requirements,
        bytes32 delivery,
        bytes calldata evidence
    ) external {
        expectedAgreement = agreement;
        expectedServiceKind = serviceKind;
        expectedOperator = operator;
        expectedSponsor = sponsor;
        expectedAcceptedAt = acceptedAt;
        expectedDeliveryDeadline = deliveryDeadline;
        expectedRequirements = requirements;
        expectedDelivery = delivery;
        expectedEvidenceHash = keccak256(evidence);
    }

    function setCallback(OperatorMarketV1 market, uint256 quoteId) external {
        callbackMarket = market;
        callbackQuoteId = quoteId;
    }

    function verifyService(
        bytes32 agreementId,
        uint8 serviceKind,
        address operator,
        address sponsor,
        uint64 acceptedAt,
        uint64 deliveryDeadline,
        bytes32 requirementsDigest,
        bytes32 deliveryDigest,
        bytes calldata evidence
    ) external returns (bool) {
        if (address(callbackMarket) != address(0)) {
            callbackAttempted = true;
            try callbackMarket.settle(callbackQuoteId, deliveryDigest, evidence) {
                callbackSucceeded = true;
            } catch (bytes memory reason) {
                callbackErrorHash = keccak256(reason);
            }
        }
        return result && agreementId == expectedAgreement && serviceKind == expectedServiceKind
            && operator == expectedOperator && sponsor == expectedSponsor && acceptedAt == expectedAcceptedAt
            && deliveryDeadline == expectedDeliveryDeadline && requirementsDigest == expectedRequirements
            && deliveryDigest == expectedDelivery && keccak256(evidence) == expectedEvidenceHash;
    }
}

contract OperatorMarketV1Test is Test {
    address private constant OPERATOR = address(0xA1);
    address private constant SPONSOR = address(0xB2);
    address private constant STRANGER = address(0xC3);
    uint256 private constant PRICE = 100;
    uint256 private constant BOND = 40;
    bytes32 private constant REQUIREMENTS = keccak256("objective");
    bytes32 private constant DELIVERY = keccak256("delivery");
    bytes private constant EVIDENCE = hex"1234";

    MarketToken private token;
    MarketVerifier private verifier;
    OperatorMarketV1 private market;

    function setUp() public {
        token = new MarketToken();
        verifier = new MarketVerifier();
        market = new OperatorMarketV1(token, verifier, BOND, 7 days, 7 days);
        token.mint(OPERATOR, 1_000);
        token.mint(SPONSOR, 1_000);
        token.mint(STRANGER, 1_000);
        vm.prank(OPERATOR);
        token.approve(address(market), type(uint256).max);
        vm.prank(SPONSOR);
        token.approve(address(market), type(uint256).max);
        vm.prank(STRANGER);
        token.approve(address(market), type(uint256).max);
    }

    function test_adapterVerifiedSettlementPaysPriceAndReturnsBond() public {
        uint256 quoteId = _post();
        vm.prank(SPONSOR);
        bytes32 agreementId = market.acceptQuote(quoteId);
        assertEq(agreementId, market.agreementIdOf(quoteId, SPONSOR));
        _expectVerified(quoteId);

        vm.prank(OPERATOR);
        market.settle(quoteId, DELIVERY, EVIDENCE);

        OperatorMarketV1.Quote memory quote = market.quoteAt(quoteId);
        assertEq(uint256(quote.status), uint256(OperatorMarketV1.QuoteStatus.Settled));
        assertEq(quote.deliveryDigest, DELIVERY);
        assertEq(market.claimable(OPERATOR), PRICE + BOND);
        vm.prank(OPERATOR);
        market.withdraw();
        assertEq(token.balanceOf(OPERATOR), 1_000 + PRICE);
        assertEq(token.balanceOf(address(market)), 0);
    }

    function test_sponsorCannotReplaceObjectiveVerifier() public {
        uint256 quoteId = _accepted();
        verifier.setResult(false);
        vm.expectRevert(OperatorMarketV1.ServiceNotVerified.selector);
        vm.prank(SPONSOR);
        market.settle(quoteId, DELIVERY, EVIDENCE);
    }

    function test_thirdPartyCanSettleVerifiedServiceButPaymentCannotBeRedirected() public {
        uint256 quoteId = _accepted();
        _expectVerified(quoteId);

        vm.prank(STRANGER);
        market.settle(quoteId, DELIVERY, EVIDENCE);
        assertEq(market.claimable(OPERATOR), PRICE + BOND);
        assertEq(market.claimable(STRANGER), 0);
        assertEq(market.claimable(SPONSOR), 0);
    }

    function test_exactObjectiveDeliveryAndEvidenceMustMatchAdapter() public {
        uint256 quoteId = _accepted();
        _expectVerified(quoteId);

        vm.expectRevert(OperatorMarketV1.ServiceNotVerified.selector);
        vm.prank(OPERATOR);
        market.settle(quoteId, keccak256("wrong"), EVIDENCE);
        vm.expectRevert(OperatorMarketV1.ServiceNotVerified.selector);
        vm.prank(OPERATOR);
        market.settle(quoteId, DELIVERY, hex"ffff");
    }

    function test_sameDeliveryDigestCanBeVerifiedForDistinctAgreements() public {
        uint256 first = _accepted();
        _expectVerified(first);
        vm.prank(OPERATOR);
        market.settle(first, DELIVERY, EVIDENCE);

        uint256 second = _accepted();
        _expectVerified(second);
        vm.prank(OPERATOR);
        market.settle(second, DELIVERY, EVIDENCE);
        assertEq(market.claimable(OPERATOR), 2 * (PRICE + BOND));
    }

    function test_operatorCanCancelOnlyOpenQuoteAndRecoverBond() public {
        uint256 quoteId = _post();
        vm.expectRevert(OperatorMarketV1.NotOperator.selector);
        vm.prank(STRANGER);
        market.cancelQuote(quoteId);
        vm.prank(OPERATOR);
        market.cancelQuote(quoteId);
        assertEq(market.claimable(OPERATOR), BOND);

        vm.expectRevert(
            abi.encodeWithSelector(
                OperatorMarketV1.WrongStatus.selector,
                OperatorMarketV1.QuoteStatus.Open,
                OperatorMarketV1.QuoteStatus.Cancelled
            )
        );
        vm.prank(OPERATOR);
        market.cancelQuote(quoteId);
    }

    function test_openExpiryReturnsBondWhileAcceptedExpiryCompensatesSponsor() public {
        uint256 openQuote = _post();
        vm.warp(block.timestamp + 2 days);
        market.expireQuote(openQuote);
        assertEq(market.claimable(OPERATOR), BOND);

        uint256 acceptedQuote = _accepted();
        OperatorMarketV1.Quote memory accepted = market.quoteAt(acceptedQuote);
        vm.warp(accepted.deliveryDeadline);
        market.expireQuote(acceptedQuote);
        assertEq(market.claimable(SPONSOR), PRICE + BOND);
    }

    function test_invalidAndSelfMatchedQuotesAreRejectedWithoutMovingFunds() public {
        vm.expectRevert(OperatorMarketV1.InvalidDigest.selector);
        vm.prank(OPERATOR);
        market.postQuote(
            OperatorMarketV1.ServiceKind.Monitoring,
            SPONSOR,
            bytes32(0),
            PRICE,
            BOND,
            uint64(block.timestamp + 1),
            1 days
        );

        vm.expectRevert(OperatorMarketV1.InvalidAmount.selector);
        vm.prank(OPERATOR);
        market.postQuote(
            OperatorMarketV1.ServiceKind.Delivery,
            SPONSOR,
            REQUIREMENTS,
            PRICE,
            BOND - 1,
            uint64(block.timestamp + 1),
            1 days
        );

        vm.expectRevert(OperatorMarketV1.NotSponsor.selector);
        vm.prank(OPERATOR);
        market.postQuote(
            OperatorMarketV1.ServiceKind.Delivery,
            OPERATOR,
            REQUIREMENTS,
            PRICE,
            BOND,
            uint64(block.timestamp + 1),
            1 days
        );

        uint256 quoteId = _post();
        vm.expectRevert(OperatorMarketV1.NotSponsor.selector);
        vm.prank(OPERATOR);
        market.acceptQuote(quoteId);
    }

    function test_verifierCallbackCannotReenterSettlement() public {
        uint256 quoteId = _accepted();
        _expectVerified(quoteId);
        verifier.setCallback(market, quoteId);

        vm.prank(OPERATOR);
        market.settle(quoteId, DELIVERY, EVIDENCE);
        assertTrue(verifier.callbackAttempted());
        assertFalse(verifier.callbackSucceeded());
        assertNotEq(verifier.callbackErrorHash(), bytes32(0));
        assertEq(market.claimable(OPERATOR), PRICE + BOND);
    }

    function test_zeroIntendedSponsorCannotExposeOperatorBondToAcceptanceExpiryTheft() public {
        vm.expectRevert(OperatorMarketV1.ZeroAddress.selector);
        _postFor(address(0));

        assertEq(market.quoteCount(), 0);
        assertEq(token.balanceOf(OPERATOR), 1_000);
        assertEq(token.balanceOf(address(market)), 0);
    }

    function test_onlyIntendedSponsorCanAcceptQuote() public {
        uint256 targetedQuote = _post();
        vm.expectRevert(OperatorMarketV1.NotSponsor.selector);
        vm.prank(STRANGER);
        market.acceptQuote(targetedQuote);

        OperatorMarketV1.Quote memory targeted = market.quoteAt(targetedQuote);
        assertEq(targeted.sponsor, address(0));
        assertEq(uint256(targeted.status), uint256(OperatorMarketV1.QuoteStatus.Open));
        assertEq(token.balanceOf(STRANGER), 1_000);
    }

    function test_agreementIdBindsTargetSponsorAndAcceptedWindow() public {
        uint256 quoteId = _post();
        vm.warp(block.timestamp + 10);
        vm.prank(SPONSOR);
        bytes32 agreementId = market.acceptQuote(quoteId);
        OperatorMarketV1.Quote memory quote = market.quoteAt(quoteId);

        assertEq(quote.acceptedAt, block.timestamp);
        assertEq(quote.deliveryDeadline, block.timestamp + quote.serviceDuration);
        assertEq(
            agreementId,
            keccak256(
                abi.encode(
                    address(market),
                    block.chainid,
                    quoteId,
                    OPERATOR,
                    SPONSOR,
                    SPONSOR,
                    OperatorMarketV1.ServiceKind.ProofConstruction,
                    REQUIREMENTS,
                    PRICE,
                    BOND,
                    quote.quoteExpiry,
                    quote.serviceDuration,
                    quote.acceptedAt,
                    quote.deliveryDeadline
                )
            )
        );
    }

    function test_constructorRejectsCollaboratorsWithoutRuntimeCode() public {
        vm.expectRevert(OperatorMarketV1.NoRuntimeCode.selector);
        new OperatorMarketV1(IERC20(STRANGER), verifier, BOND, 7 days, 7 days);

        vm.expectRevert(OperatorMarketV1.NoRuntimeCode.selector);
        new OperatorMarketV1(token, IOperatorServiceVerifierV1(STRANGER), BOND, 7 days, 7 days);
    }

    function test_paymentTokenCannotReenterCancellationDuringAcceptance() public {
        ReentrantMarketToken reentrantToken = new ReentrantMarketToken();
        OperatorMarketV1 reentrantMarket = new OperatorMarketV1(reentrantToken, verifier, BOND, 7 days, 7 days);
        reentrantToken.configure(reentrantMarket, SPONSOR);
        reentrantToken.mint(address(reentrantToken), BOND);
        reentrantToken.mint(SPONSOR, PRICE);
        reentrantToken.postQuote(REQUIREMENTS, PRICE, BOND);
        vm.prank(SPONSOR);
        reentrantToken.approve(address(reentrantMarket), PRICE);
        reentrantToken.arm();
        uint256 reentrantQuoteId = reentrantToken.quoteId();

        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vm.prank(SPONSOR);
        reentrantMarket.acceptQuote(reentrantQuoteId);

        OperatorMarketV1.Quote memory quote = reentrantMarket.quoteAt(reentrantQuoteId);
        assertEq(uint256(quote.status), uint256(OperatorMarketV1.QuoteStatus.Open));
        assertEq(reentrantMarket.claimable(address(reentrantToken)), 0);
        assertEq(reentrantToken.balanceOf(address(reentrantMarket)), BOND);
    }

    function test_lateAcceptanceStillReceivesFullServiceWindow() public {
        uint256 quoteId = _post();
        OperatorMarketV1.Quote memory posted = market.quoteAt(quoteId);
        vm.warp(posted.quoteExpiry - 1);
        vm.prank(SPONSOR);
        market.acceptQuote(quoteId);

        OperatorMarketV1.Quote memory accepted = market.quoteAt(quoteId);
        assertEq(accepted.acceptedAt, block.timestamp);
        assertEq(accepted.deliveryDeadline, block.timestamp + 1 days);
        vm.warp(posted.quoteExpiry);
        vm.expectRevert(OperatorMarketV1.InvalidExpiry.selector);
        market.expireQuote(quoteId);

        vm.warp(accepted.deliveryDeadline);
        market.expireQuote(quoteId);
        assertEq(market.claimable(SPONSOR), PRICE + BOND);
    }

    function test_quoteExpiryIsExclusiveAcceptanceBoundary() public {
        uint256 beforeBoundary = _post();
        uint256 atBoundary = _post();
        OperatorMarketV1.Quote memory posted = market.quoteAt(atBoundary);

        vm.warp(posted.quoteExpiry - 1);
        vm.prank(SPONSOR);
        market.acceptQuote(beforeBoundary);
        assertEq(uint256(market.quoteAt(beforeBoundary).status), uint256(OperatorMarketV1.QuoteStatus.Accepted));

        vm.warp(posted.quoteExpiry);
        vm.expectRevert(OperatorMarketV1.InvalidExpiry.selector);
        vm.prank(SPONSOR);
        market.acceptQuote(atBoundary);
        assertEq(uint256(market.quoteAt(atBoundary).status), uint256(OperatorMarketV1.QuoteStatus.Open));
    }

    function test_deliveryDeadlineIsExclusiveSettlementBoundary() public {
        uint256 beforeBoundary = _accepted();
        uint256 atBoundary = _accepted();
        OperatorMarketV1.Quote memory quote = market.quoteAt(atBoundary);
        assertEq(market.quoteAt(beforeBoundary).deliveryDeadline, quote.deliveryDeadline);

        _expectVerified(beforeBoundary);
        vm.warp(quote.deliveryDeadline - 1);
        market.settle(beforeBoundary, DELIVERY, EVIDENCE);
        assertEq(uint256(market.quoteAt(beforeBoundary).status), uint256(OperatorMarketV1.QuoteStatus.Settled));

        _expectVerified(atBoundary);
        vm.warp(quote.deliveryDeadline);
        vm.expectRevert(OperatorMarketV1.InvalidExpiry.selector);
        market.settle(atBoundary, DELIVERY, EVIDENCE);
        assertEq(uint256(market.quoteAt(atBoundary).status), uint256(OperatorMarketV1.QuoteStatus.Accepted));
    }

    function test_quoteIndexedEntryPointsRejectOutOfRangeIds() public {
        uint256 missingQuoteId = market.quoteCount();

        vm.expectRevert();
        market.acceptQuote(missingQuoteId);
        vm.expectRevert();
        market.settle(missingQuoteId, DELIVERY, EVIDENCE);
        vm.expectRevert();
        market.cancelQuote(missingQuoteId);
        vm.expectRevert();
        market.expireQuote(missingQuoteId);
        vm.expectRevert();
        market.quoteAt(missingQuoteId);
        vm.expectRevert();
        market.agreementIdOf(missingQuoteId, SPONSOR);
    }

    function _post() private returns (uint256) {
        return _postFor(SPONSOR);
    }

    function _postFor(address intendedSponsor) private returns (uint256) {
        vm.prank(OPERATOR);
        return market.postQuote(
            OperatorMarketV1.ServiceKind.ProofConstruction,
            intendedSponsor,
            REQUIREMENTS,
            PRICE,
            BOND,
            uint64(block.timestamp + 1 days),
            1 days
        );
    }

    function _accepted() private returns (uint256 quoteId) {
        quoteId = _post();
        vm.prank(SPONSOR);
        market.acceptQuote(quoteId);
    }

    function _expectVerified(uint256 quoteId) private {
        OperatorMarketV1.Quote memory quote = market.quoteAt(quoteId);
        verifier.setExpected(
            market.agreementIdOf(quoteId, quote.sponsor),
            uint8(quote.serviceKind),
            quote.operator,
            quote.sponsor,
            quote.acceptedAt,
            quote.deliveryDeadline,
            quote.requirementsDigest,
            DELIVERY,
            EVIDENCE
        );
    }
}
