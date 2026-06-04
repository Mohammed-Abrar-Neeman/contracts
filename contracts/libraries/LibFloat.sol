// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { LibSettlement } from "./LibSettlement.sol";

/// @title LibFloat — float arithmetic helpers
/// @notice [SPEC §2.3] Pure helpers for float reservation accounting.
///         No storage of its own; reads/writes Diamond storage via LibSettlement.
library LibFloat {
    error InsufficientFloat(address partner, uint256 available, uint256 required);

    /// @notice Read live float = ERC20 balance(partner) - reservations[partner].
    /// @dev Caller passes the live balance because libraries cannot import IERC20
    ///      callsites cheaply; facets fetch balance and forward.
    function availableFor(address partner, uint256 liveBalance) internal view returns (uint256) {
        uint256 reserved = LibSettlement.diamondStorage().floatReservations[partner];
        return liveBalance >= reserved ? liveBalance - reserved : 0;
    }

    /// @notice Atomic reserve — reverts if insufficient float available.
    function reserve(
        address partner,
        bytes32 settlementId,
        uint256 amount,
        uint256 liveBalance
    ) internal {
        LibSettlement.DiamondStorage storage ds = LibSettlement.diamondStorage();
        uint256 available = availableFor(partner, liveBalance);
        if (available < amount) revert InsufficientFloat(partner, available, amount);
        ds.floatReservations[partner] += amount;
        ds.settlementReservations[settlementId] = amount;
    }

    /// @notice Idempotent release — no-op if already released.
    function release(address partner, bytes32 settlementId) internal returns (uint256 released) {
        LibSettlement.DiamondStorage storage ds = LibSettlement.diamondStorage();
        released = ds.settlementReservations[settlementId];
        if (released == 0) return 0;
        // Defensive guard: never underflow even on mis-bookkept storage.
        ds.floatReservations[partner] = ds.floatReservations[partner] >= released
            ? ds.floatReservations[partner] - released
            : 0;
        delete ds.settlementReservations[settlementId];
    }
}
