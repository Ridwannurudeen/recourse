// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/write-ability/common/EvmV1Decoder.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IPolicyEvaluatorV1} from "../../contracts/v2/interfaces/IPolicyEvaluatorV1.sol";
import {ProofJobsV1} from "../../contracts/v2/ProofJobsV1.sol";
import {RecourseFacilityV2} from "../../contracts/v2/RecourseFacilityV2.sol";
import {
    ActionAdapterDeclaration,
    DeploymentRecord,
    IPolicyRegistryV1,
    PackageRelease
} from "../../contracts/v2/interfaces/IPolicyRegistryV1.sol";
import {
    EvidenceKind,
    FacilityStatus,
    ObservationKind,
    PolicyEffect,
    PolicyOutcome,
    PolicyResult,
    ProvenTransaction
} from "../../contracts/v2/types/RecourseTypesV2.sol";
import {CappedPilotFactoryV1} from "../../contracts/v3/CappedPilotFactoryV1.sol";
import {ClosedLoopPolicyV1} from "../../contracts/v3/ClosedLoopPolicyV1.sol";
import {MultiChainEventPolicyV1} from "../../contracts/v3/MultiChainEventPolicyV1.sol";
import {PolicyKernelV2} from "../../contracts/v3/PolicyKernelV2.sol";
import {IPortfolioFactoryV1, PortfolioMandateV1} from "../../contracts/v3/PortfolioMandateV1.sol";
import {IPortfolioPoolRemedyCoordinatorV1, PortfolioPoolV1} from "../../contracts/v3/PortfolioPoolV1.sol";
import {RecourseFacilityV3} from "../../contracts/v3/RecourseFacilityV3.sol";
import {RemedyCoordinatorV1} from "../../contracts/v3/RemedyCoordinatorV1.sol";
import {IRemedyCoordinatorV1} from "../../contracts/v3/interfaces/IRemedyCoordinatorV1.sol";
import {IRemedyTransportV1} from "../../contracts/v3/interfaces/IRemedyTransportV1.sol";
import {MockVerifier} from "../mocks/MockVerifier.sol";

contract PortfolioPoolToken is ERC20 {
    constructor() ERC20("Portfolio USD", "pUSD") {}

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }
}

contract PortfolioPoolRegistryMock {
    PackageRelease private release;
    DeploymentRecord private deployment;
    bool private evidenceDeclared;
    ActionAdapterDeclaration[] private adapters;

    function configure(
        PackageRelease calldata release_,
        DeploymentRecord calldata deployment_,
        ActionAdapterDeclaration calldata adapter_
    ) external {
        release = release_;
        deployment = deployment_;
        evidenceDeclared = true;
        adapters.push(adapter_);
    }

    function setEvidenceDeclared(bool value) external {
        evidenceDeclared = value;
    }

    function packageRelease(bytes32) external view returns (PackageRelease memory) {
        return release;
    }

    function deploymentRecord(bytes32) external view returns (DeploymentRecord memory) {
        return deployment;
    }

    function declaresEvidenceKind(bytes32, EvidenceKind) external view returns (bool) {
        return evidenceDeclared;
    }

    function actionAdapterCount(bytes32) external view returns (uint256) {
        return adapters.length;
    }

    function actionAdapterAt(bytes32, uint256 index) external view returns (ActionAdapterDeclaration memory) {
        return adapters[index];
    }
}

contract PortfolioPoolRemedyCoordinatorMock {
    mapping(address facility => mapping(uint256 policyId => address policy)) public authorizedPolicy;
    mapping(address facility => mapping(uint256 policyId => bytes32 intentId)) public latestPolicyIntent;
    mapping(bytes32 intentId => address lender) private intentLender;
    mapping(bytes32 intentId => uint256 count) public publishCount;
    address public lastPublisher;

    function authorizePolicy(address facility, uint256 policyId, address policy) external {
        authorizedPolicy[facility][policyId] = policy;
        bytes32 intentId = keccak256(abi.encode(facility, policyId, policy));
        latestPolicyIntent[facility][policyId] = intentId;
        intentLender[intentId] = msg.sender;
    }

    function recordReplacement(address facility, uint256 policyId, bytes32 intentId) external {
        require(msg.sender == authorizedPolicy[facility][policyId]);
        latestPolicyIntent[facility][policyId] = intentId;
        intentLender[intentId] = intentLender[keccak256(abi.encode(facility, policyId, msg.sender))];
    }

    function publishIntent(bytes32 intentId, bytes calldata actionData) external returns (bytes32 messageId) {
        require(intentLender[intentId] != address(0));
        if (publishCount[intentId] != 0) require(msg.sender == intentLender[intentId]);
        ++publishCount[intentId];
        lastPublisher = msg.sender;
        messageId = keccak256(abi.encode(intentId, actionData, publishCount[intentId]));
    }
}

contract PortfolioPoolRemedyPolicyMock is IPolicyEvaluatorV1 {
    address public immutable context;
    address public immutable lender;
    PortfolioPoolRemedyCoordinatorMock public immutable coordinator;
    mapping(address facility => mapping(uint256 policyId => bytes32 intentId)) public latestIntent;
    mapping(address facility => mapping(uint256 policyId => bool configured)) private configuredPolicies;
    uint256 private replacementNonce;

    constructor(address context_, address lender_, PortfolioPoolRemedyCoordinatorMock coordinator_) {
        context = context_;
        lender = lender_;
        coordinator = coordinator_;
    }

    function configure(address facility, uint256 policyId) external {
        require(msg.sender == lender);
        require(!configuredPolicies[facility][policyId]);
        configuredPolicies[facility][policyId] = true;
        latestIntent[facility][policyId] = keccak256(abi.encode(facility, policyId, address(this)));
    }

    function replaceRemedyIntent(address facility, uint256 policyId) external returns (bytes32 intentId) {
        require(msg.sender == lender);
        require(configuredPolicies[facility][policyId]);
        intentId = keccak256(abi.encode(latestIntent[facility][policyId], ++replacementNonce));
        latestIntent[facility][policyId] = intentId;
        coordinator.recordReplacement(facility, policyId, intentId);
    }

    function evaluate(address facility, uint256 policyId, ProvenTransaction[] calldata proven)
        external
        view
        returns (PolicyResult memory result)
    {
        require(msg.sender == context);
        require(configuredPolicies[facility][policyId]);
        require(proven.length == 1);
        ProvenTransaction calldata transaction = proven[0];
        result = PolicyResult({
            effect: PolicyEffect({
                outcome: PolicyOutcome.Watch,
                creditLimitBps: 9_000,
                futureDrawFeeBps: 0,
                freezePendingDraw: false,
                requireFreshEvidence: false,
                terminate: false
            }),
            observationKind: ObservationKind.Behaviour,
            evidenceKind: EvidenceKind.EventDelta,
            sourceBlock: transaction.blockHeight,
            transactionIndex: transaction.txIndex,
            subject: address(0xB2),
            emitter: address(this),
            observedValue: 1,
            freshnessPeriod: 1 days
        });
    }

    function configHash(address facility, uint256 policyId) external view returns (bytes32) {
        if (!configuredPolicies[facility][policyId]) return bytes32(0);
        return keccak256(abi.encode(lender, address(coordinator)));
    }

    function manifest(address facility, uint256 policyId) external view returns (bytes memory) {
        if (!configuredPolicies[facility][policyId]) return bytes("");
        return abi.encode(lender, address(coordinator));
    }

    function policyKind() external pure returns (string memory) {
        return "portfolio-remedy-test";
    }
}

contract PortfolioPoolRemedyTransportMock is IRemedyTransportV1 {
    uint256 public publishCalls;

    function publish(bytes32 intentId, uint64, address, bytes calldata payload, uint64)
        external
        returns (bytes32 messageId)
    {
        messageId = keccak256(abi.encode(intentId, keccak256(payload), ++publishCalls));
    }

    function isAcknowledged(bytes32) external pure returns (bool) {
        return false;
    }
}

contract PortfolioPoolV1Test is Test {
    address private constant MANAGER = address(0xA1);
    address private constant BORROWER = address(0xB2);
    address private constant GUARDIAN = address(0xC3);
    address private constant INVESTOR_A = address(0xD4);
    address private constant INVESTOR_B = address(0xE5);
    uint256 private constant POLICY_ID = 7;
    uint256 private constant REMEDY_POLICY_ID = 8;
    uint256 private constant CLOSED_LOOP_POLICY_ID = 10;
    address private constant ADVERSE_EMITTER = address(0xD00D);
    address private constant REMEDY_RECEIVER = address(0xCAFE);
    address private constant REMEDY_TARGET = address(0xBEEF);
    bytes32 private constant ADVERSE_SIG = keccak256("LiabilityIncreased(address,uint256)");
    bytes32 private constant CURE_SIG = keccak256("RemedyExecutionConfirmed(address,bytes32,bytes32,bytes32,bytes32)");
    bytes32 private constant ACTION_KIND = keccak256("repay-v1");
    bytes private constant ACTION_DATA = abi.encode(address(0xCAFE), uint256(100));
    bytes32 private constant RELEASE_ID = keccak256("portfolio-release");
    bytes32 private constant DEPLOYMENT_ID = keccak256("portfolio-deployment");
    bytes32 private constant ADAPTER_KIND = keccak256("bounded-remedy-v1");

    PortfolioPoolToken private token;
    PolicyKernelV2 private kernel;
    ProofJobsV1 private proofJobs;
    PortfolioPoolV1 private pool;
    CappedPilotFactoryV1 private factory;
    MultiChainEventPolicyV1 private policy;
    PortfolioPoolRemedyCoordinatorMock private remedyCoordinator;
    PortfolioPoolRemedyPolicyMock private remedyPolicy;
    PortfolioPoolRemedyTransportMock private actualTransport;
    RemedyCoordinatorV1 private actualCoordinator;
    ClosedLoopPolicyV1 private actualPolicy;
    PortfolioPoolRegistryMock private registry;
    PortfolioMandateV1 private mandate;
    RecourseFacilityV3 private facility;

    function setUp() public {
        token = new PortfolioPoolToken();
        kernel = new PolicyKernelV2(new MockVerifier());
        proofJobs = new ProofJobsV1(kernel);
        kernel.setProofJobs(address(proofJobs));
        pool = new PortfolioPoolV1(token, MANAGER, 1_000, 100, 1 days, 1, uint64(block.timestamp + 7 days), 10);
        factory = new CappedPilotFactoryV1(
            token, address(kernel), address(pool), BORROWER, GUARDIAN, 1_000, 1_000, 2_000, 0, 100, 0, 1
        );
        policy = new MultiChainEventPolicyV1(kernel);
        remedyCoordinator = new PortfolioPoolRemedyCoordinatorMock();
        remedyPolicy = new PortfolioPoolRemedyPolicyMock(address(kernel), address(pool), remedyCoordinator);
        actualTransport = new PortfolioPoolRemedyTransportMock();
        actualCoordinator = new RemedyCoordinatorV1(kernel, actualTransport);
        actualPolicy = new ClosedLoopPolicyV1(kernel, actualCoordinator);
        registry = new PortfolioPoolRegistryMock();

        MultiChainEventPolicyV1.Configuration memory configuration = _configuration();
        bytes32 configurationHash = keccak256(abi.encode(configuration));
        bytes32 policySet = keccak256(abi.encode(bytes32(0), POLICY_ID, address(policy), configurationHash, uint8(1)));
        bytes32 remedyConfigurationHash = keccak256(abi.encode(address(pool), address(remedyCoordinator)));
        policySet = keccak256(
            abi.encode(policySet, REMEDY_POLICY_ID, address(remedyPolicy), remedyConfigurationHash, uint8(0))
        );
        ClosedLoopPolicyV1.Configuration memory closedLoopConfiguration = _closedLoopConfiguration();
        bytes32 closedLoopConfigurationHash = keccak256(abi.encode(closedLoopConfiguration));
        policySet = keccak256(
            abi.encode(policySet, CLOSED_LOOP_POLICY_ID, address(actualPolicy), closedLoopConfigurationHash, uint8(0))
        );
        mandate = new PortfolioMandateV1(
            IPortfolioFactoryV1(address(factory)),
            IPolicyRegistryV1(address(registry)),
            token,
            address(kernel),
            RELEASE_ID,
            policySet,
            EvidenceKind.EventDelta,
            ADAPTER_KIND,
            1_000,
            2_000,
            0,
            1_000
        );

        vm.startPrank(MANAGER);
        pool.setMandate(mandate);
        pool.setProofJobsVenue(proofJobs);
        facility = RecourseFacilityV3(pool.createFacility(1_000, 200, 0, uint64(block.number + 100), 0));
        pool.configureAndRegisterPolicy(
            address(facility),
            POLICY_ID,
            IPolicyEvaluatorV1(address(policy)),
            abi.encodeCall(MultiChainEventPolicyV1.configure, (address(facility), POLICY_ID, configuration))
        );
        pool.configureAndRegisterPolicy(
            address(facility),
            REMEDY_POLICY_ID,
            IPolicyEvaluatorV1(address(remedyPolicy)),
            abi.encodeCall(PortfolioPoolRemedyPolicyMock.configure, (address(facility), REMEDY_POLICY_ID))
        );
        pool.authorizeRemedyPolicy(
            address(facility), REMEDY_POLICY_ID, IPortfolioPoolRemedyCoordinatorV1(address(remedyCoordinator))
        );
        pool.configureAndRegisterPolicy(
            address(facility),
            CLOSED_LOOP_POLICY_ID,
            IPolicyEvaluatorV1(address(actualPolicy)),
            abi.encodeCall(
                ClosedLoopPolicyV1.configure, (address(facility), CLOSED_LOOP_POLICY_ID, closedLoopConfiguration)
            )
        );
        pool.authorizeRemedyPolicy(
            address(facility), CLOSED_LOOP_POLICY_ID, IPortfolioPoolRemedyCoordinatorV1(address(actualCoordinator))
        );
        pool.registerInvestor(INVESTOR_A);
        pool.registerInvestor(INVESTOR_B);
        vm.stopPrank();

        assertEq(kernel.policySetCommitment(address(facility)), policySet);
        _configureRegistry(configurationHash);
        vm.prank(MANAGER);
        pool.registerCandidate(address(facility), DEPLOYMENT_ID);
    }

    function test_deploymentOrderBindsPoolAsLenderBeforeFunding() public view {
        assertEq(factory.lender(), address(pool));
        assertEq(facility.lender(), address(pool));
        assertEq(address(pool.mandate()), address(mandate));
        assertEq(pool.createdFacilityCount(), 1);
        assertEq(pool.candidateCount(), 1);
        assertEq(pool.candidateAt(0), address(facility));
        assertEq(uint256(pool.status()), uint256(PortfolioPoolV1.PoolStatus.Configuring));
    }

    function test_fullRecoveryFlowsThroughExactMandateAndPullClaims() public {
        _fundAllocateAndActivate();
        _draw(800);
        vm.prank(BORROWER);
        facility.repay(800);

        pool.settleAllocation(address(facility));
        assertEq(pool.totalRecovered(), 1_000);
        assertEq(pool.totalRealizedLoss(), 0);
        pool.finalize();
        assertEq(pool.claimable(INVESTOR_A), 600);
        assertEq(pool.claimable(INVESTOR_B), 400);

        vm.prank(INVESTOR_A);
        pool.claim();
        vm.prank(INVESTOR_B);
        pool.claim();
        assertEq(token.balanceOf(INVESTOR_A), 600);
        assertEq(token.balanceOf(INVESTOR_B), 400);
        assertEq(token.balanceOf(address(pool)), 0);
    }

    function test_poolManagerCanPublishRetryAndReplaceTheBoundRemedyIntent() public {
        _fundAllocateAndActivate();
        bytes memory actionData = abi.encode(address(0xCAFE), uint256(100));

        vm.startPrank(MANAGER);
        (bool firstPublished, bytes memory firstResult) = address(pool)
            .call(
                abi.encodeWithSignature(
                    "publishRemedyIntent(address,uint256,bytes)", address(facility), REMEDY_POLICY_ID, actionData
                )
            );
        assertTrue(firstPublished);
        bytes32 firstMessageId = abi.decode(firstResult, (bytes32));
        (bool retried, bytes memory retryResult) = address(pool)
            .call(
                abi.encodeWithSignature(
                    "publishRemedyIntent(address,uint256,bytes)", address(facility), REMEDY_POLICY_ID, actionData
                )
            );
        assertTrue(retried);
        bytes32 retryMessageId = abi.decode(retryResult, (bytes32));
        (bool replaced, bytes memory replacementResult) = address(pool)
            .call(abi.encodeWithSignature("replaceRemedyIntent(address,uint256)", address(facility), REMEDY_POLICY_ID));
        assertTrue(replaced);
        bytes32 replacementIntentId = abi.decode(replacementResult, (bytes32));
        vm.stopPrank();

        assertNotEq(firstMessageId, retryMessageId);
        assertEq(remedyCoordinator.lastPublisher(), address(pool));
        assertEq(
            remedyCoordinator.publishCount(
                keccak256(abi.encode(address(facility), REMEDY_POLICY_ID, address(remedyPolicy)))
            ),
            2
        );
        assertEq(remedyPolicy.latestIntent(address(facility), REMEDY_POLICY_ID), replacementIntentId);
        assertEq(remedyCoordinator.latestPolicyIntent(address(facility), REMEDY_POLICY_ID), replacementIntentId);
    }

    function test_realClosedLoopCanRetryToFailureAndReplaceThroughPoolWithoutChangingExecution() public {
        _fundAllocateAndActivate();
        vm.prank(address(kernel));
        actualPolicy.evaluate(address(facility), CLOSED_LOOP_POLICY_ID, _closedLoopAdverseProven());
        bytes32 firstIntentId = actualPolicy.latestIntent(address(facility), CLOSED_LOOP_POLICY_ID);
        RemedyCoordinatorV1.Intent memory firstIntent = actualCoordinator.intentOf(firstIntentId);

        vm.prank(MANAGER);
        pool.publishRemedyIntent(address(facility), CLOSED_LOOP_POLICY_ID, ACTION_DATA);
        vm.roll(facility.maturityBlock() + 1);
        facility.markDefaulted();
        pool.settleAllocation(address(facility));
        pool.finalize();
        assertEq(uint256(pool.status()), uint256(PortfolioPoolV1.PoolStatus.Finalized));
        vm.warp(block.timestamp + actualCoordinator.PUBLISH_RETRY_DELAY());
        vm.prank(MANAGER);
        pool.publishRemedyIntent(address(facility), CLOSED_LOOP_POLICY_ID, ACTION_DATA);
        vm.warp(block.timestamp + actualCoordinator.PUBLISH_RETRY_DELAY());
        vm.prank(MANAGER);
        pool.publishRemedyIntent(address(facility), CLOSED_LOOP_POLICY_ID, ACTION_DATA);
        vm.warp(block.timestamp + actualCoordinator.PUBLISH_RETRY_DELAY());
        actualCoordinator.timeoutIntent(firstIntentId);
        assertEq(
            uint256(actualCoordinator.intentStatus(firstIntentId)), uint256(IRemedyCoordinatorV1.IntentStatus.Failed)
        );

        vm.prank(MANAGER);
        bytes32 replacementIntentId = pool.replaceRemedyIntent(address(facility), CLOSED_LOOP_POLICY_ID);
        RemedyCoordinatorV1.Intent memory replacement = actualCoordinator.intentOf(replacementIntentId);

        assertEq(replacement.predecessorIntentId, firstIntentId);
        assertEq(replacement.adverseEvidenceDigest, firstIntent.adverseEvidenceDigest);
        assertEq(replacement.actionDataHash, firstIntent.actionDataHash);
        assertEq(replacement.executionId, firstIntent.executionId);
        assertEq(uint256(replacement.status), uint256(IRemedyCoordinatorV1.IntentStatus.Recorded));
        assertEq(actualPolicy.latestIntent(address(facility), CLOSED_LOOP_POLICY_ID), replacementIntentId);
    }

    function test_remedyForwardersRequireManagerAndServiceableAllocatedPool() public {
        bytes memory actionData = abi.encode(address(0xCAFE), uint256(100));

        vm.expectRevert(
            abi.encodeWithSelector(
                PortfolioPoolV1.WrongStatus.selector,
                PortfolioPoolV1.PoolStatus.Active,
                PortfolioPoolV1.PoolStatus.Configuring
            )
        );
        vm.prank(MANAGER);
        pool.publishRemedyIntent(address(facility), REMEDY_POLICY_ID, actionData);
        vm.expectRevert(
            abi.encodeWithSelector(
                PortfolioPoolV1.WrongStatus.selector,
                PortfolioPoolV1.PoolStatus.Active,
                PortfolioPoolV1.PoolStatus.Configuring
            )
        );
        vm.prank(MANAGER);
        pool.replaceRemedyIntent(address(facility), REMEDY_POLICY_ID);

        _fundAllocateAndActivate();
        vm.expectRevert(PortfolioPoolV1.NotManager.selector);
        pool.publishRemedyIntent(address(facility), REMEDY_POLICY_ID, actionData);
        vm.expectRevert(PortfolioPoolV1.NotManager.selector);
        pool.replaceRemedyIntent(address(facility), REMEDY_POLICY_ID);
    }

    function test_remedyBindingRejectsWrongCoordinatorAndRemapping() public {
        PortfolioPoolRemedyCoordinatorMock wrongCoordinator = new PortfolioPoolRemedyCoordinatorMock();
        uint256 secondPolicyId = REMEDY_POLICY_ID + 1;

        vm.startPrank(MANAGER);
        pool.configureAndRegisterPolicy(
            address(facility),
            secondPolicyId,
            IPolicyEvaluatorV1(address(remedyPolicy)),
            abi.encodeCall(PortfolioPoolRemedyPolicyMock.configure, (address(facility), secondPolicyId))
        );
        vm.expectRevert(PortfolioPoolV1.InvalidPolicyCall.selector);
        pool.authorizeRemedyPolicy(
            address(facility), secondPolicyId, IPortfolioPoolRemedyCoordinatorV1(address(wrongCoordinator))
        );
        vm.expectRevert(PortfolioPoolV1.InvalidPolicyCall.selector);
        pool.authorizeRemedyPolicy(
            address(facility), REMEDY_POLICY_ID, IPortfolioPoolRemedyCoordinatorV1(address(remedyCoordinator))
        );
        vm.stopPrank();

        assertEq(pool.remedyCoordinator(address(facility), secondPolicyId), address(0));
        assertEq(pool.remedyCoordinator(address(facility), REMEDY_POLICY_ID), address(remedyCoordinator));
        assertEq(pool.remedyPolicyEvaluator(address(facility), REMEDY_POLICY_ID), address(remedyPolicy));
    }

    function test_defaultLossWaitsForGraceAndLateRecoveryRemainsProRata() public {
        _fundAllocateAndActivate();
        _draw(800);
        vm.roll(facility.maturityBlock() + 1);

        vm.expectRevert(PortfolioPoolV1.RecoveryPending.selector);
        pool.settleAllocation(address(facility));
        facility.markDefaulted();
        vm.expectRevert(bytes4(keccak256("NotLender()")));
        vm.prank(address(0xBAD));
        facility.settleDefaultLoss();
        vm.roll(facility.maturityBlock() + pool.recoveryDelayBlocks() + 1);
        pool.settleAllocation(address(facility));

        PortfolioPoolV1.Allocation memory allocation = pool.allocationOf(address(facility));
        assertEq(allocation.principal, 1_000);
        assertEq(allocation.recovered, 400);
        assertEq(allocation.realizedLoss, 600);
        assertEq(pool.totalRealizedLoss(), 600);
        pool.finalize();

        vm.prank(INVESTOR_A);
        pool.claim();
        vm.prank(INVESTOR_B);
        pool.claim();
        assertEq(token.balanceOf(INVESTOR_A), 240);
        assertEq(token.balanceOf(INVESTOR_B), 160);

        vm.prank(BORROWER);
        facility.repay(100);
        pool.harvest(address(facility));
        assertEq(pool.totalRealizedLoss(), 500);
        assertEq(pool.claimable(INVESTOR_A), 60);
        assertEq(pool.claimable(INVESTOR_B), 40);
        vm.prank(INVESTOR_A);
        pool.claim();
        vm.prank(INVESTOR_B);
        pool.claim();
        assertEq(token.balanceOf(INVESTOR_A), 300);
        assertEq(token.balanceOf(INVESTOR_B), 200);
        assertEq(token.balanceOf(address(pool)), 0);
    }

    function test_fundingWithdrawalsAndTransfersLockAtActivation() public {
        vm.prank(MANAGER);
        pool.openFunding();
        token.mint(INVESTOR_A, 100);
        vm.startPrank(INVESTOR_A);
        token.approve(address(pool), 100);
        pool.deposit(100);
        pool.transfer(INVESTOR_B, 40);
        vm.stopPrank();
        vm.prank(INVESTOR_B);
        pool.withdrawFunding(40);
        assertEq(token.balanceOf(INVESTOR_B), 40);
        assertEq(pool.totalSupply(), 60);

        vm.prank(MANAGER);
        pool.activate();
        vm.expectRevert(PortfolioPoolV1.SharesLocked.selector);
        vm.prank(INVESTOR_A);
        pool.transfer(INVESTOR_B, 1);
    }

    function test_allocationRechecksMandateImmediatelyBeforeMovingAssets() public {
        _fundPool();
        _postBond();
        registry.setEvidenceDeclared(false);
        vm.expectRevert(
            abi.encodeWithSelector(
                PortfolioPoolV1.IneligibleFacility.selector, PortfolioMandateV1.EligibilityCode.MissingEvidenceKind
            )
        );
        vm.prank(MANAGER);
        pool.allocate(address(facility), 1_000);
        assertEq(token.balanceOf(address(pool)), 1_000);
        assertEq(facility.lenderFunded(), 0);
    }

    function test_allocationRequiresFullBondAndFullFacilityLimit() public {
        _fundPool();
        vm.expectRevert(PortfolioPoolV1.InvalidFacility.selector);
        vm.prank(MANAGER);
        pool.allocate(address(facility), 1_000);

        _postBond();
        vm.expectRevert(PortfolioPoolV1.InvalidAmount.selector);
        vm.prank(MANAGER);
        pool.allocate(address(facility), 999);
        assertEq(token.balanceOf(address(pool)), 1_000);
        assertEq(facility.lenderFunded(), 0);

        vm.prank(MANAGER);
        pool.allocate(address(facility), 1_000);
        assertEq(facility.lenderFunded(), 1_000);
    }

    function test_allocationCannotStartAfterFundingDeadline() public {
        _fundPool();
        _postBond();
        vm.warp(pool.fundingDeadline());

        vm.expectRevert(PortfolioPoolV1.FundingExpired.selector);
        vm.prank(MANAGER);
        pool.allocate(address(facility), 1_000);
        assertEq(token.balanceOf(address(pool)), 1_000);
        assertEq(facility.lenderFunded(), 0);
    }

    function test_nonManagerCannotConfigureOrAllocateCapital() public {
        vm.expectRevert(PortfolioPoolV1.NotManager.selector);
        pool.openFunding();
        _fundPool();
        vm.expectRevert(PortfolioPoolV1.NotManager.selector);
        pool.allocate(address(facility), 1_000);
    }

    function test_unregisteredAccountsCannotConsumeFundingOrTransferSlots() public {
        address stranger = address(0xBAD);
        vm.prank(MANAGER);
        pool.openFunding();
        token.mint(stranger, 1);
        vm.startPrank(stranger);
        token.approve(address(pool), 1);
        vm.expectRevert(PortfolioPoolV1.InvestorNotRegistered.selector);
        pool.deposit(1);
        vm.stopPrank();

        token.mint(INVESTOR_A, 1);
        vm.startPrank(INVESTOR_A);
        token.approve(address(pool), 1);
        pool.deposit(1);
        vm.expectRevert(PortfolioPoolV1.InvestorNotRegistered.selector);
        pool.transfer(stranger, 1);
        vm.stopPrank();
        assertEq(pool.investorCount(), 2);
    }

    function test_poolCanSponsorExactBoundedProofJobAndRecoverRefundPermissionlessly() public {
        _fundAllocateAndActivate();
        token.mint(address(pool), 10);
        ProofJobsV1.JobParams memory params = _jobParams(4, 3, 1);

        vm.prank(MANAGER);
        uint256 jobId = pool.createProofJob(params);
        assertTrue(pool.isPoolProofJob(jobId));
        assertEq(pool.totalServiceEscrowed(), 7);
        assertEq(token.balanceOf(address(proofJobs)), 7);
        assertEq(proofJobs.getJob(jobId).sponsor, address(pool));

        vm.warp(params.expiry);
        proofJobs.finalizeExpired(jobId);
        vm.prank(INVESTOR_A);
        pool.recoverProofJobFunds();
        assertEq(pool.totalServiceRecovered(), 7);
        assertEq(token.balanceOf(address(proofJobs)), 0);
        assertEq(token.balanceOf(address(pool)), 10);
    }

    function test_borrowerDrawPauseBlocksFurtherDrawsWithoutBlockingEvidenceAdmission() public {
        _fundAllocateAndActivate();
        _draw(1_000);
        vm.prank(BORROWER);
        facility.setDrawPaused(true);

        vm.expectRevert(RecourseFacilityV2.DrawPaused.selector);
        vm.prank(BORROWER);
        facility.requestDraw(1);

        token.mint(address(pool), 10);
        ProofJobsV1.JobParams memory params = _jobParams(4, 3, 1);
        vm.prank(MANAGER);
        uint256 jobId = pool.createProofJob(params);

        assertTrue(facility.borrowerDrawPaused());
        assertTrue(pool.isPoolProofJob(jobId));
        assertEq(proofJobs.getJob(jobId).facility, address(facility));
    }

    function test_proofJobMustMatchPolicyAndGrossServiceBudget() public {
        _fundAllocateAndActivate();
        token.mint(address(pool), 200);
        ProofJobsV1.JobParams memory params = _jobParams(4, 3, 1);
        params.requirementsDigest = keccak256("wrong-policy");
        vm.expectRevert(PortfolioPoolV1.InvalidConfiguration.selector);
        vm.prank(MANAGER);
        pool.createProofJob(params);

        params = _jobParams(100, 1, 1);
        vm.expectRevert(PortfolioPoolV1.ServiceBudgetExceeded.selector);
        vm.prank(MANAGER);
        pool.createProofJob(params);
    }

    function test_proofJobExpiryCannotExceedFrozenMaximumDuration() public {
        _fundAllocateAndActivate();
        token.mint(address(pool), 10);
        ProofJobsV1.JobParams memory params = _jobParams(4, 3, 1);
        params.expiry = uint64(block.timestamp + 1 days + 1);

        assertEq(pool.maximumServiceJobDuration(), 1 days);
        vm.expectRevert(PortfolioPoolV1.InvalidConfiguration.selector);
        vm.prank(MANAGER);
        pool.createProofJob(params);
    }

    function test_proRataRoundingAssignsEveryAssetUnitWithoutDust() public {
        vm.prank(MANAGER);
        pool.openFunding();
        token.mint(INVESTOR_A, 1);
        token.mint(INVESTOR_B, 2);
        vm.startPrank(INVESTOR_A);
        token.approve(address(pool), 1);
        pool.deposit(1);
        vm.stopPrank();
        vm.startPrank(INVESTOR_B);
        token.approve(address(pool), 2);
        pool.deposit(2);
        vm.stopPrank();
        vm.prank(MANAGER);
        pool.activate();
        vm.prank(MANAGER);
        pool.finalize();
        vm.prank(INVESTOR_A);
        pool.claim();
        vm.prank(INVESTOR_B);
        pool.claim();

        token.mint(address(pool), 1);
        pool.distributeAvailable();
        assertEq(pool.claimable(INVESTOR_A), 0);
        assertEq(pool.claimable(INVESTOR_B), 1);
        vm.prank(INVESTOR_B);
        pool.claim();
        assertEq(pool.totalDistributed(), 4);
        assertEq(pool.totalClaimed(), 4);
        assertEq(token.balanceOf(address(pool)), 0);
    }

    function test_cashOnlyPoolCanFinalizePermissionlesslyAfterFundingDeadline() public {
        vm.prank(MANAGER);
        pool.openFunding();
        token.mint(INVESTOR_A, 10);
        vm.startPrank(INVESTOR_A);
        token.approve(address(pool), 10);
        pool.deposit(10);
        vm.stopPrank();
        vm.prank(MANAGER);
        pool.activate();

        vm.expectRevert(PortfolioPoolV1.NotManager.selector);
        vm.prank(INVESTOR_A);
        pool.finalize();
        vm.warp(pool.fundingDeadline());
        vm.prank(INVESTOR_A);
        pool.finalize();
        assertEq(pool.claimable(INVESTOR_A), 10);
    }

    function _fundAllocateAndActivate() private {
        _fundPool();
        _postBond();
        vm.prank(MANAGER);
        pool.allocate(address(facility), 1_000);
        bytes32 commitment = kernel.policySetCommitment(address(facility));
        vm.prank(BORROWER);
        facility.activate(commitment);
    }

    function _postBond() private {
        token.mint(BORROWER, 200);
        vm.startPrank(BORROWER);
        token.approve(address(facility), type(uint256).max);
        facility.postBond(200);
        vm.stopPrank();
    }

    function _fundPool() private {
        vm.prank(MANAGER);
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
        vm.prank(MANAGER);
        pool.activate();
    }

    function _draw(uint256 amount) private {
        vm.startPrank(BORROWER);
        facility.requestDraw(amount);
        facility.executeDraw();
        vm.stopPrank();
    }

    function _configureRegistry(bytes32 configurationHash) private {
        PackageRelease memory release;
        release.issuer = address(this);
        release.releaseContentHash = keccak256("release-content");
        release.exists = true;
        DeploymentRecord memory deployment;
        deployment.releaseId = RELEASE_ID;
        deployment.chainId = block.chainid;
        deployment.kernel = address(kernel);
        deployment.facility = address(facility);
        deployment.policyId = POLICY_ID;
        deployment.evaluator = address(policy);
        deployment.configHash = configurationHash;
        deployment.manifestHash = configurationHash;
        deployment.exists = true;
        registry.configure(
            release,
            deployment,
            ActionAdapterDeclaration(ADAPTER_KIND, keccak256("adapter-spec"), "ipfs://portfolio-adapter")
        );
    }

    function _jobParams(uint256 reimbursement, uint256 reward, uint32 attempts)
        private
        view
        returns (ProofJobsV1.JobParams memory)
    {
        return ProofJobsV1.JobParams({
            token: token,
            facility: address(facility),
            policyId: POLICY_ID,
            requirementsDigest: policy.configHash(address(facility), POLICY_ID),
            expiry: uint64(block.timestamp + 1 days),
            revealWindowBlocks: 10,
            maxSuccessfulProofs: attempts,
            proofReimbursement: reimbursement,
            outcomeReward: reward,
            commitBond: 1,
            rewardOutcomeThreshold: 4
        });
    }

    function _configuration() private pure returns (MultiChainEventPolicyV1.Configuration memory configuration) {
        MultiChainEventPolicyV1.Rule[] memory rules = new MultiChainEventPolicyV1.Rule[](1);
        rules[0] = MultiChainEventPolicyV1.Rule({
            sourceChain: 3,
            emitter: address(0xF6),
            eventSignature: keccak256("LiabilityIncreased(address,uint256)"),
            startSourceBlock: 1,
            endSourceBlock: type(uint64).max,
            topicCount: 2,
            subjectTopicIndex: 1,
            dataLength: 32,
            observedValueOffset: 0,
            observationKind: ObservationKind.Liability,
            riskWeight: 1
        });
        configuration = MultiChainEventPolicyV1.Configuration({
            subject: BORROWER,
            freshnessPeriod: 1 days,
            watchThreshold: 1,
            restrictedThreshold: 2,
            marginThreshold: 3,
            breachThreshold: 4,
            watchEffect: _effect(PolicyOutcome.Watch, 9_000, false),
            restrictedEffect: _effect(PolicyOutcome.Restricted, 8_000, false),
            marginEffect: _effect(PolicyOutcome.MarginCalled, 7_000, false),
            breachEffect: _effect(PolicyOutcome.Breached, 0, true),
            rules: rules
        });
    }

    function _closedLoopConfiguration() private pure returns (ClosedLoopPolicyV1.Configuration memory) {
        ClosedLoopPolicyV1.EventRule memory adverseRule = ClosedLoopPolicyV1.EventRule({
            sourceChain: 3,
            emitter: ADVERSE_EMITTER,
            eventSignature: ADVERSE_SIG,
            subject: BORROWER,
            startSourceBlock: 1,
            endSourceBlock: type(uint64).max,
            topicCount: 2,
            subjectTopicIndex: 1,
            dataLength: 32,
            observedValueOffset: 0
        });
        ClosedLoopPolicyV1.EventRule memory cureEventRule = ClosedLoopPolicyV1.EventRule({
            sourceChain: 1,
            emitter: REMEDY_RECEIVER,
            eventSignature: CURE_SIG,
            subject: REMEDY_TARGET,
            startSourceBlock: 1,
            endSourceBlock: type(uint64).max,
            topicCount: 4,
            subjectTopicIndex: 1,
            dataLength: 64,
            observedValueOffset: 0
        });
        return ClosedLoopPolicyV1.Configuration({
            adverseRule: adverseRule,
            cureRule: ClosedLoopPolicyV1.CureRule({
                eventRule: cureEventRule, intentTopicIndex: 2, executionTopicIndex: 3, actionDigestOffset: 32
            }),
            observationKind: ObservationKind.Liability,
            freshnessPeriod: type(uint64).max,
            remedyDuration: 1 days,
            destinationChain: 1,
            receiver: REMEDY_RECEIVER,
            target: REMEDY_TARGET,
            actionKind: ACTION_KIND,
            actionDataHash: keccak256(ACTION_DATA),
            adverseEffect: _effect(PolicyOutcome.Restricted, 5_000, false),
            cureEffect: _effect(PolicyOutcome.Cured, 10_000, false)
        });
    }

    function _closedLoopAdverseProven() private pure returns (ProvenTransaction[] memory proven) {
        bytes32[] memory topics = new bytes32[](2);
        topics[0] = ADVERSE_SIG;
        topics[1] = bytes32(uint256(uint160(BORROWER)));
        EvmV1Decoder.LogEntryTuple[] memory logs = new EvmV1Decoder.LogEntryTuple[](1);
        logs[0] = EvmV1Decoder.LogEntryTuple({address_: ADVERSE_EMITTER, topics: topics, data: abi.encode(uint256(75))});
        bytes[] memory chunks = new bytes[](3);
        chunks[2] = abi.encode(uint8(1), uint64(1), logs, bytes(""));
        proven = new ProvenTransaction[](1);
        proven[0] = ProvenTransaction({
            chainKey: 3, blockHeight: 2, txIndex: 1, encodedTransaction: abi.encode(uint8(2), chunks)
        });
    }

    function _effect(PolicyOutcome outcome, uint16 creditLimitBps, bool terminate)
        private
        pure
        returns (PolicyEffect memory)
    {
        return PolicyEffect({
            outcome: outcome,
            creditLimitBps: creditLimitBps,
            futureDrawFeeBps: 0,
            freezePendingDraw: terminate,
            requireFreshEvidence: false,
            terminate: terminate
        });
    }
}
