// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { IEIP3009 } from "./interfaces/IEIP3009.sol";

/// @title EIP3009Extension
/// @notice [SPEC §1] Adds EIP-3009 transferWithAuthorization to ERC-20.
/// @dev Implements the Circle USDC reference verbatim. Additive only — no
///      existing ERC-20 surface modified. Domain name="GSDC", version="1"
///      matches USDC for x402 ecosystem compatibility.
abstract contract EIP3009Extension is ERC20, EIP712, IEIP3009 {
    /// @dev TYPEHASH from spec §1.2 verbatim.
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        keccak256(
            "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
        );

    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");

    /// @dev mapping(authorizer => mapping(nonce => used)).
    mapping(address => mapping(bytes32 => bool)) private _authorizationStates;

    error AuthorizationAlreadyUsed(address authorizer, bytes32 nonce);
    error AuthorizationNotYetValid(uint256 validAfter, uint256 currentTime);
    error AuthorizationExpired(uint256 validBefore, uint256 currentTime);
    error InvalidSignature();
    error SignerMismatch(address recovered, address expected);

    function authorizationState(address authorizer, bytes32 nonce) external view override returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external override {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid(validAfter, block.timestamp);
        if (block.timestamp >= validBefore) revert AuthorizationExpired(validBefore, block.timestamp);
        if (_authorizationStates[from][nonce]) revert AuthorizationAlreadyUsed(from, nonce);

        bytes32 structHash = keccak256(
            abi.encode(
                TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
                from, to, value, validAfter, validBefore, nonce
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, v, r, s);
        if (recovered == address(0)) revert InvalidSignature();
        if (recovered != from) revert SignerMismatch(recovered, from);

        // Checks-effects-interactions: mark used BEFORE transfer.
        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    function cancelAuthorization(
        address authorizer,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external override {
        if (_authorizationStates[authorizer][nonce]) revert AuthorizationAlreadyUsed(authorizer, nonce);

        bytes32 structHash = keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce));
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, v, r, s);
        if (recovered == address(0)) revert InvalidSignature();
        if (recovered != authorizer) revert SignerMismatch(recovered, authorizer);

        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }
}
