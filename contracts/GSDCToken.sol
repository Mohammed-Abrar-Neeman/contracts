// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { EIP3009Extension } from "./EIP3009Extension.sol";

/// @title GSDCToken — Sepolia mock GSDC with EIP-3009 [SPEC §1.4]
/// @notice Real mainnet GSDC ERC-20 stays untouched (CertiKit audited
///         Dec 2025). This Sepolia mock combines OpenZeppelin v5 ERC-20
///         + EIP-3009 extension for end-to-end testing.
/// @dev Mintable by owner only (orchestrator/admin) for float top-ups
///      during testing. Mainnet token mint authority is governed
///      separately by the audited contract.
contract GSDCToken is EIP3009Extension, Ownable {
    constructor(address initialOwner)
        ERC20("GSDC", "GSDC")
        EIP712("GSDC", "1")
        Ownable(initialOwner)
    {}

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyOwner {
        _burn(from, amount);
    }
}
