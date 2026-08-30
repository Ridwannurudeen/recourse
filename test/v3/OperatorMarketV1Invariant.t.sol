// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {OperatorMarketV1} from "../../contracts/v3/OperatorMarketV1.sol";
import {IOperatorServiceVerifierV1} from "../../contracts/v3/interfaces/IOperatorServiceVerifierV1.sol";

contract OperatorInvariantToken is ERC20 {
    constructor() ERC20("Operator Invariant USD", "oiUSD") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }
}

contract OperatorInvariantVerifier is IOperatorServiceVerifierV1 {
    function verifyService(bytes32, address, bytes32, bytes32, bytes calldata) external pure returns (bool) {
        return true;
    }
}

contract OperatorMarketV1Handler {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant ACTOR_BALANCE = 1e30;
    uint256 private constant MAXIMUM_QUOTES = 32;

    OperatorInvariantToken public immutable token;
    OperatorMarketV1 public immutable market;
    address[6] private actors;

    constructor() {
        token = new OperatorInvariantToken();
        OperatorInvariantVerifier verifier = new OperatorInvariantVerifier();
        market = new OperatorMarketV1(token, verifier, 10, 7 days, 7 days);
        for (uint256 i; i < actors.length; ++i) {
            address actor = address(SafeCast.toUint160(0x100 + i));
            actors[i] = actor;
            token.mint(actor, ACTOR_BALANCE);
            vm.prank(actor);
            token.approve(address(market), type(uint256).max);
        }
    }

    function post(uint256 seed) external {
        uint256 quoteCount = market.quoteCount();
        if (quoteCount >= MAXIMUM_QUOTES) return;
        address operator = actors[seed % actors.length];
        uint256 price = 1 + (seed >> 8) % 1_000;
        uint256 bond = 10 + (seed >> 24) % 1_000;
        uint64 expiry = SafeCast.toUint64(block.timestamp + 1 + (seed >> 40) % 7 days);
        uint64 serviceDuration = SafeCast.toUint64(1 + (seed >> 64) % 7 days);
        OperatorMarketV1.ServiceKind serviceKind = _serviceKind(seed >> 96);
        bytes32 requirementsDigest = keccak256(abi.encode(seed, quoteCount));
        vm.prank(operator);
        market.postQuote(serviceKind, requirementsDigest, price, bond, expiry, serviceDuration);
    }

    function accept(uint256 seed) external {
        uint256 count = market.quoteCount();
        if (count == 0) return;
        uint256 quoteId = seed % count;
        OperatorMarketV1.Quote memory quote = market.quoteAt(quoteId);
        if (quote.status != OperatorMarketV1.QuoteStatus.Open || block.timestamp >= quote.quoteExpiry) return;
        address sponsor = actors[(seed >> 16) % actors.length];
        if (sponsor == quote.operator) sponsor = actors[((seed >> 16) + 1) % actors.length];
        vm.prank(sponsor);
        market.acceptQuote(quoteId);
    }

    function cancel(uint256 seed) external {
        uint256 count = market.quoteCount();
        if (count == 0) return;
        uint256 quoteId = seed % count;
        OperatorMarketV1.Quote memory quote = market.quoteAt(quoteId);
        if (quote.status != OperatorMarketV1.QuoteStatus.Open) return;
        vm.prank(quote.operator);
        market.cancelQuote(quoteId);
    }

    function settle(uint256 seed) external {
        uint256 count = market.quoteCount();
        if (count == 0) return;
        uint256 quoteId = seed % count;
        OperatorMarketV1.Quote memory quote = market.quoteAt(quoteId);
        if (quote.status != OperatorMarketV1.QuoteStatus.Accepted || block.timestamp >= quote.deliveryDeadline) return;
        bytes32 deliveryDigest = keccak256(abi.encode(quoteId, quote.requirementsDigest));
        vm.prank(actors[(seed >> 16) % actors.length]);
        market.settle(quoteId, deliveryDigest, abi.encode(seed));
    }

    function advanceAndExpire(uint256 seed) external {
        uint256 count = market.quoteCount();
        if (count == 0) return;
        vm.warp(block.timestamp + 1 + (seed >> 32) % 2 days);
        uint256 quoteId = seed % count;
        OperatorMarketV1.Quote memory quote = market.quoteAt(quoteId);
        bool openExpired = quote.status == OperatorMarketV1.QuoteStatus.Open && block.timestamp >= quote.quoteExpiry;
        bool acceptedExpired =
            quote.status == OperatorMarketV1.QuoteStatus.Accepted && block.timestamp >= quote.deliveryDeadline;
        if (openExpired || acceptedExpired) market.expireQuote(quoteId);
    }

    function withdraw(uint256 seed) external {
        address actor = actors[seed % actors.length];
        if (market.claimable(actor) == 0) return;
        vm.prank(actor);
        market.withdraw();
    }

    function actorAt(uint256 index) external view returns (address) {
        return actors[index];
    }

    function actorCount() external pure returns (uint256) {
        return 6;
    }

    function _serviceKind(uint256 seed) private pure returns (OperatorMarketV1.ServiceKind) {
        uint256 selected = seed % 4;
        if (selected == 0) return OperatorMarketV1.ServiceKind.Monitoring;
        if (selected == 1) return OperatorMarketV1.ServiceKind.ProofConstruction;
        if (selected == 2) return OperatorMarketV1.ServiceKind.Submission;
        return OperatorMarketV1.ServiceKind.Delivery;
    }
}

contract OperatorMarketV1InvariantTest is Test {
    OperatorMarketV1Handler private handler;
    OperatorMarketV1 private market;
    OperatorInvariantToken private token;

    function setUp() public {
        handler = new OperatorMarketV1Handler();
        market = handler.market();
        token = handler.token();
        targetContract(address(handler));
    }

    function invariant_marketBalanceExactlyCoversEscrowAndClaims() public view {
        uint256 obligations;
        uint256 quoteCount = market.quoteCount();
        for (uint256 i; i < quoteCount; ++i) {
            OperatorMarketV1.Quote memory quote = market.quoteAt(i);
            if (quote.status == OperatorMarketV1.QuoteStatus.Open) obligations += quote.operatorBond;
            if (quote.status == OperatorMarketV1.QuoteStatus.Accepted) {
                obligations += quote.operatorBond + quote.price;
            }
        }
        uint256 actorCount = handler.actorCount();
        for (uint256 i; i < actorCount; ++i) {
            obligations += market.claimable(handler.actorAt(i));
        }
        assertEq(token.balanceOf(address(market)), obligations);
    }

    function test_handlerCanCreateEscrowedQuote() public {
        handler.post(1);
        assertEq(market.quoteCount(), 1);
        assertEq(token.balanceOf(address(market)), market.quoteAt(0).operatorBond);
    }
}
