// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { LibSettlement } from "../libraries/LibSettlement.sol";

/// @title MarginSplitterFacet [SPEC §2.8]
/// @notice Pure margin calculation. Withdrawals happen on the per-partner
///         MarginWallet contract directly — partners call `MarginWallet.withdraw()`
///         using their EOA. This facet exposes the calc helper used by
///         SettlementExecutorFacet.
contract MarginSplitterFacet {
    error CorridorNotConfigured(bytes32 corridorId);

    function calculateMargins(bytes32 corridorId, uint256 deliveryAmount)
        external view returns (uint256 lpSourceMargin, uint256 tgsTreasuryMargin, uint256 lpDestMargin)
    {
        LibSettlement.CorridorConfig storage c = LibSettlement.diamondStorage().corridors[corridorId];
        if (!c.active) revert CorridorNotConfigured(corridorId);
        // bps over 10_000.
        lpSourceMargin = (deliveryAmount * c.lpSourceMarginBps) / 10_000;
        tgsTreasuryMargin = (deliveryAmount * c.tgsTreasuryMarginBps) / 10_000;
        lpDestMargin = (deliveryAmount * c.lpDestMarginBps) / 10_000;
    }
}
