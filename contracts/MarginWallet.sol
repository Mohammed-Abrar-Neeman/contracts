// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MarginWallet [SPEC §3.1] — verbatim from Sandip's spec
/// @notice One per partner. Holds GSDC for fee accumulation. Only the registered
///         owner can withdraw. Diamond is the only address that can write.
/// @dev    All three immutables are constructor-set. To swap the Diamond
///         (per Spec §4.1 step 4 deployment order), redeploy this contract
///         with the new Diamond address.
contract MarginWallet is ReentrancyGuard {
    IERC20 public immutable gsdc;
    address public immutable owner;
    address public immutable settlementDiamond;

    event MarginDeposited(uint256 amount, bytes32 indexed settlementId);
    event MarginWithdrawn(address indexed to, uint256 amount);

    error NotSettlementDiamond();
    error NotOwner();
    error InsufficientBalance(uint256 available, uint256 requested);
    error ZeroAddress();
    error ZeroAmount();
    error TransferFailed();

    constructor(address _gsdc, address _owner, address _settlementDiamond) {
        if (_gsdc == address(0) || _owner == address(0) || _settlementDiamond == address(0)) {
            revert ZeroAddress();
        }
        gsdc = IERC20(_gsdc);
        owner = _owner;
        settlementDiamond = _settlementDiamond;
    }

    /// @notice Called by Settlement Diamond during atomic settlement.
    /// @dev    Diamond has already transferred `amount` GSDC into this contract
    ///         via ERC-20 transferFrom; this function records the deposit.
    function deposit(uint256 amount, bytes32 settlementId) external nonReentrant {
        if (msg.sender != settlementDiamond) revert NotSettlementDiamond();
        if (amount == 0) revert ZeroAmount();
        emit MarginDeposited(amount, settlementId);
    }

    /// @notice Withdraw accumulated GSDC margin to any address.
    /// @dev    Owner-only.
    function withdraw(address to, uint256 amount) external nonReentrant {
        if (msg.sender != owner) revert NotOwner();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 bal = gsdc.balanceOf(address(this));
        if (amount > bal) revert InsufficientBalance(bal, amount);
        bool ok = gsdc.transfer(to, amount);
        if (!ok) revert TransferFailed();
        emit MarginWithdrawn(to, amount);
    }

    function balance() external view returns (uint256) {
        return gsdc.balanceOf(address(this));
    }
}
