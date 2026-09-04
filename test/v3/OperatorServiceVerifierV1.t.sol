// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {OperatorServiceVerifierV1} from "../../contracts/v3/OperatorServiceVerifierV1.sol";

contract ServiceAttestor is IERC1271 {
    bytes32 private expectedDigest;
    bytes32 private expectedSignatureHash;

    function setExpected(bytes32 digest, bytes calldata signature) external {
        expectedDigest = digest;
        expectedSignatureHash = keccak256(signature);
    }

    function isValidSignature(bytes32 digest, bytes memory signature) external view returns (bytes4) {
        if (digest == expectedDigest && keccak256(signature) == expectedSignatureHash) {
            return IERC1271.isValidSignature.selector;
        }
        return bytes4(0xffffffff);
    }
}

contract RevertingServiceAttestor is IERC1271 {
    function isValidSignature(bytes32, bytes memory) external pure returns (bytes4) {
        revert();
    }
}

contract OperatorServiceVerifierV1Test is Test {
    struct ServiceReceipt {
        bytes32 agreementId;
        uint8 serviceKind;
        address operator;
        address sponsor;
        uint64 acceptedAt;
        uint64 deliveryDeadline;
        bytes32 requirementsDigest;
        bytes32 deliveryDigest;
    }

    uint256 private constant ATTESTOR_KEY = 0xA11CE;
    bytes32 private constant AGREEMENT = keccak256("agreement");
    bytes32 private constant REQUIREMENTS = keccak256("requirements");
    bytes32 private constant DELIVERY = keccak256("delivery");
    address private constant OPERATOR = address(0xA1);
    address private constant SPONSOR = address(0xB2);

    address private attestor;
    OperatorServiceVerifierV1 private verifier;

    function setUp() public {
        attestor = vm.addr(ATTESTOR_KEY);
        verifier = new OperatorServiceVerifierV1(attestor);
    }

    function test_validEoaReceiptVerifies() public view {
        ServiceReceipt memory receipt = _receipt();
        bytes memory evidence = _sign(receipt);

        assertTrue(_verify(verifier, receipt, evidence));
    }

    function test_receiptCannotBeReplayedForAnotherAgreement() public view {
        ServiceReceipt memory receipt = _receipt();
        bytes memory evidence = _sign(receipt);
        receipt.agreementId = keccak256("second agreement");

        assertFalse(_verify(verifier, receipt, evidence));
    }

    function test_receiptBindsEveryServiceField() public view {
        ServiceReceipt memory receipt = _receipt();
        bytes memory evidence = _sign(receipt);

        receipt.serviceKind += 1;
        assertFalse(_verify(verifier, receipt, evidence));
        receipt = _receipt();
        receipt.operator = address(0xA2);
        assertFalse(_verify(verifier, receipt, evidence));
        receipt = _receipt();
        receipt.sponsor = address(0xB3);
        assertFalse(_verify(verifier, receipt, evidence));
        receipt = _receipt();
        receipt.acceptedAt += 1;
        assertFalse(_verify(verifier, receipt, evidence));
        receipt = _receipt();
        receipt.deliveryDeadline += 1;
        assertFalse(_verify(verifier, receipt, evidence));
        receipt = _receipt();
        receipt.requirementsDigest = keccak256("other requirements");
        assertFalse(_verify(verifier, receipt, evidence));
        receipt = _receipt();
        receipt.deliveryDigest = keccak256("other delivery");
        assertFalse(_verify(verifier, receipt, evidence));
    }

    function test_receiptIsDomainSeparatedByVerifier() public {
        ServiceReceipt memory receipt = _receipt();
        bytes memory evidence = _sign(receipt);
        OperatorServiceVerifierV1 otherVerifier = new OperatorServiceVerifierV1(attestor);

        assertFalse(_verify(otherVerifier, receipt, evidence));
    }

    function test_malformedEoaEvidenceReturnsFalse() public view {
        ServiceReceipt memory receipt = _receipt();

        assertFalse(_verify(verifier, receipt, hex""));
        assertFalse(_verify(verifier, receipt, hex"1234"));
        assertFalse(_verify(verifier, receipt, new bytes(65)));
    }

    function test_validErc1271ReceiptVerifies() public {
        ServiceAttestor contractAttestor = new ServiceAttestor();
        OperatorServiceVerifierV1 contractVerifier = new OperatorServiceVerifierV1(address(contractAttestor));
        ServiceReceipt memory receipt = _receipt();
        bytes memory evidence = hex"1234";
        contractAttestor.setExpected(_digest(contractVerifier, receipt), evidence);

        assertTrue(_verify(contractVerifier, receipt, evidence));
        assertFalse(_verify(contractVerifier, receipt, hex"5678"));
    }

    function test_revertingErc1271AttestorReturnsFalse() public {
        RevertingServiceAttestor revertingAttestor = new RevertingServiceAttestor();
        OperatorServiceVerifierV1 revertingVerifier = new OperatorServiceVerifierV1(address(revertingAttestor));

        assertFalse(_verify(revertingVerifier, _receipt(), hex"1234"));
    }

    function test_constructorRejectsZeroAttestor() public {
        vm.expectRevert(OperatorServiceVerifierV1.ZeroAddress.selector);
        new OperatorServiceVerifierV1(address(0));
    }

    function _receipt() private pure returns (ServiceReceipt memory) {
        return ServiceReceipt({
            agreementId: AGREEMENT,
            serviceKind: 1,
            operator: OPERATOR,
            sponsor: SPONSOR,
            acceptedAt: 100,
            deliveryDeadline: 200,
            requirementsDigest: REQUIREMENTS,
            deliveryDigest: DELIVERY
        });
    }

    function _sign(ServiceReceipt memory receipt) private view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ATTESTOR_KEY, _digest(verifier, receipt));
        return abi.encodePacked(r, s, v);
    }

    function _digest(OperatorServiceVerifierV1 target, ServiceReceipt memory receipt) private view returns (bytes32) {
        return target.receiptDigestOf(
            receipt.agreementId,
            receipt.serviceKind,
            receipt.operator,
            receipt.sponsor,
            receipt.acceptedAt,
            receipt.deliveryDeadline,
            receipt.requirementsDigest,
            receipt.deliveryDigest
        );
    }

    function _verify(OperatorServiceVerifierV1 target, ServiceReceipt memory receipt, bytes memory evidence)
        private
        view
        returns (bool)
    {
        return target.verifyService(
            receipt.agreementId,
            receipt.serviceKind,
            receipt.operator,
            receipt.sponsor,
            receipt.acceptedAt,
            receipt.deliveryDeadline,
            receipt.requirementsDigest,
            receipt.deliveryDigest,
            evidence
        );
    }
}
