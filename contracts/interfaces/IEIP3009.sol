// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IEIP3009
/// @notice EIP-3009: Transfer With Authorization. [SPEC §1.1]
/// @dev Added to existing GSDC ERC-20. Real mainnet GSDC stays untouched
///      (CertiKit audited Dec 2025); this Sepolia mock implements the
///      same surface for local + testnet end-to-end testing.
interface IEIP3009 {
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    /// @notice Returns whether an authorization nonce has been used / cancelled.
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);

    /// @notice Execute a transfer with a signed EIP-712 authorization.
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
    ) external;

    /// @notice Cancel an unused authorization. Caller proves ownership via signature.
    function cancelAuthorization(
        address authorizer,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}
