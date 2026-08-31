// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FacilityStatus} from "../../contracts/v2/types/RecourseTypesV2.sol";
import {CappedPilotFactoryV1} from "../../contracts/v3/CappedPilotFactoryV1.sol";
import {PortfolioMandateV1} from "../../contracts/v3/PortfolioMandateV1.sol";
import {PortfolioPoolV1} from "../../contracts/v3/PortfolioPoolV1.sol";
import {RecourseFacilityV3} from "../../contracts/v3/RecourseFacilityV3.sol";

contract PortfolioPoolInvariantToken is ERC20 {
    constructor() ERC20("Portfolio Invariant USD", "piUSD") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }
}

contract PortfolioPoolInvariantKernel {
    bytes32 public constant COMMITMENT = keccak256("portfolio-invariant-policy");

    function policySetCommitment(address) external pure returns (bytes32) {
        return COMMITMENT;
    }
}

contract PortfolioPoolInvariantMandate {
    IERC20 public immutable asset;
    address public immutable factory;
    address public immutable kernel;

    constructor(IERC20 asset_, address factory_, address kernel_) {
        asset = asset_;
        factory = factory_;
        kernel = kernel_;
    }

    function evaluate(address, bytes32) external pure returns (PortfolioMandateV1.EligibilityCode) {
        return PortfolioMandateV1.EligibilityCode.Eligible;
    }
}

contract PortfolioPoolV1Handler {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address public constant INVESTOR_A = address(0xA11CE);
    address public constant INVESTOR_B = address(0xB0B);
    address public constant BORROWER = address(0xCAFE);
    address public constant GUARDIAN = address(0xD00D);

    PortfolioPoolInvariantToken public immutable token;
    PortfolioPoolV1 public immutable pool;
    RecourseFacilityV3 public immutable facility;

    constructor() {
        token = new PortfolioPoolInvariantToken();
        PortfolioPoolInvariantKernel kernel = new PortfolioPoolInvariantKernel();
        pool = new PortfolioPoolV1(token, address(this), 1_000, 0, 0, 1, uint64(block.timestamp + 1 days), 5);
        CappedPilotFactoryV1 factory = new CappedPilotFactoryV1(
            token, address(kernel), address(pool), BORROWER, GUARDIAN, 1_000, 1_000, 2_000, 0, 20, 0, 1
        );
        PortfolioPoolInvariantMandate mandate =
            new PortfolioPoolInvariantMandate(token, address(factory), address(kernel));
        pool.setMandate(PortfolioMandateV1(address(mandate)));
        facility = RecourseFacilityV3(pool.createFacility(1_000, 200, 0, 20, 0));
        pool.registerCandidate(address(facility), keccak256("invariant-deployment"));
        pool.registerInvestor(INVESTOR_A);
        pool.registerInvestor(INVESTOR_B);
        pool.openFunding();

        token.mint(INVESTOR_A, 600);
        token.mint(INVESTOR_B, 400);
        vm.startPrank(INVESTOR_A);
        token.approve(address(pool), 600);
        pool.deposit(600);
        vm.stopPrank();
        vm.startPrank(INVESTOR_B);
        token.approve(address(pool), 400);
        pool.deposit(400);
        vm.stopPrank();
        pool.activate();

        token.mint(BORROWER, 200);
        vm.startPrank(BORROWER);
        token.approve(address(facility), type(uint256).max);
        facility.postBond(200);
        vm.stopPrank();
        pool.allocate(address(facility), 1_000);
        vm.startPrank(BORROWER);
        facility.activate(kernel.COMMITMENT());
        facility.requestDraw(800);
        facility.executeDraw();
        vm.stopPrank();
    }

    function repay(uint256 seed) external {
        FacilityStatus facilityStatus = facility.status();
        if (
            facilityStatus != FacilityStatus.Active && facilityStatus != FacilityStatus.Defaulted
                && facilityStatus != FacilityStatus.Terminated
        ) return;
        uint256 debt = facility.outstandingDebt();
        uint256 borrowerBalance = token.balanceOf(BORROWER);
        uint256 maximum = debt < borrowerBalance ? debt : borrowerBalance;
        if (maximum == 0) return;
        vm.prank(BORROWER);
        facility.repay(1 + seed % maximum);
    }

    function settle() external {
        PortfolioPoolV1.Allocation memory allocation = pool.allocationOf(address(facility));
        if (allocation.settled) return;
        uint256 settlementBlock = uint256(facility.maturityBlock()) + pool.recoveryDelayBlocks() + 1;
        if (block.number < settlementBlock) vm.roll(settlementBlock);
        pool.settleAllocation(address(facility));
    }

    function harvest() external {
        PortfolioPoolV1.PoolStatus poolStatus = pool.status();
        if (poolStatus != PortfolioPoolV1.PoolStatus.Active && poolStatus != PortfolioPoolV1.PoolStatus.Finalized) {
            return;
        }
        if (facility.lenderClaimable() != 0) pool.harvest(address(facility));
    }

    function finalize() external {
        if (pool.status() != PortfolioPoolV1.PoolStatus.Active) return;
        if (!pool.allocationOf(address(facility)).settled) return;
        pool.finalize();
    }

    function claim(uint256 seed) external {
        if (pool.status() != PortfolioPoolV1.PoolStatus.Finalized) return;
        address investor = seed % 2 == 0 ? INVESTOR_A : INVESTOR_B;
        if (pool.claimable(investor) == 0) return;
        vm.prank(investor);
        pool.claim();
    }

    function claimBorrowerRefund() external {
        if (facility.borrowerClaimable() == 0) return;
        vm.prank(BORROWER);
        facility.claimBorrowerRefund();
    }
}

contract PortfolioPoolV1InvariantTest is Test {
    PortfolioPoolV1Handler private handler;
    PortfolioPoolInvariantToken private token;
    PortfolioPoolV1 private pool;
    RecourseFacilityV3 private facility;

    function setUp() public {
        handler = new PortfolioPoolV1Handler();
        token = handler.token();
        pool = handler.pool();
        facility = handler.facility();
        targetContract(address(handler));
    }

    function invariant_assetsAreConservedAndPoolClaimsAreExactlySolvent() public view {
        uint256 accounted = token.balanceOf(address(pool)) + token.balanceOf(address(facility))
            + token.balanceOf(handler.INVESTOR_A()) + token.balanceOf(handler.INVESTOR_B())
            + token.balanceOf(handler.BORROWER());
        assertEq(accounted, 1_200);

        uint256 outstandingClaims = pool.totalDistributed() - pool.totalClaimed();
        assertGe(token.balanceOf(address(pool)), outstandingClaims);
        if (pool.status() == PortfolioPoolV1.PoolStatus.Finalized) {
            assertEq(token.balanceOf(address(pool)), outstandingClaims);
        }
        assertEq(pool.claimable(handler.INVESTOR_A()) + pool.claimable(handler.INVESTOR_B()), outstandingClaims);
    }

    function invariant_recoveryAndLossLedgersRemainBounded() public view {
        PortfolioPoolV1.Allocation memory allocation = pool.allocationOf(address(facility));
        assertEq(allocation.principal, pool.totalAllocatedPrincipal());
        assertEq(allocation.recovered, pool.totalRecovered());
        assertEq(allocation.realizedLoss, pool.totalRealizedLoss());
        assertLe(allocation.realizedLoss, allocation.principal);
        assertEq(token.balanceOf(address(pool)) + pool.totalClaimed(), pool.totalRecovered());
    }
}
