// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IOperatorServiceVerifierV1} from "./interfaces/IOperatorServiceVerifierV1.sol";

contract OperatorServiceVerifierV1 is EIP712, IOperatorServiceVerifierV1 {

    bytes32 public constant SERVICE_RECEIPT_TYPEHASH = keccak256(
        "ServiceReceipt(bytes32 agreementId,uint8 serviceKind,address operator,address sponsor,uint64 acceptedAt,uint64 deliveryDeadline,bytes32 requirementsDigest,bytes32 deliveryDigest)"
    );

    error ZeroAddress();

    address public immutable attestor;

    constructor(address attestor_) EIP712("Recourse Operator Service", "1") {
        if (attestor_ == address(0)) revert ZeroAddress();
        attestor = attestor_;
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
    ) external view returns (bool) {
        bytes32 digest = receiptDigestOf(
            agreementId,
            serviceKind,
            operator,
            sponsor,
            acceptedAt,
            deliveryDeadline,
            requirementsDigest,
            deliveryDigest
        );
        if (attestor.code.length == 0) {
            (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, evidence);
            return err == ECDSA.RecoverError.NoError && recovered == attestor;
        }
        (bool ok, bytes memory returned) =
            attestor.staticcall(abi.encodeCall(IERC1271.isValidSignature, (digest, evidence)));
        return ok && returned.length == 32 && abi.decode(returned, (bytes4)) == IERC1271.isValidSignature.selector;
    }

    function receiptDigestOf(
        bytes32 agreementId,
        uint8 serviceKind,
        address operator,
        address sponsor,
        uint64 acceptedAt,
        uint64 deliveryDeadline,
        bytes32 requirementsDigest,
        bytes32 deliveryDigest
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SERVICE_RECEIPT_TYPEHASH,
                    agreementId,
                    serviceKind,
                    operator,
                    sponsor,
                    acceptedAt,
                    deliveryDeadline,
                    requirementsDigest,
                    deliveryDigest
                )
            )
        );
    }
}
