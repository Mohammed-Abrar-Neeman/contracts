// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library LibReentrancyGuard {
    bytes32 constant REENTRANCY_STORAGE_POSITION =
        keccak256("gsdc.reentrancy.guard.v1");

    uint256 constant NOT_ENTERED = 1;
    uint256 constant ENTERED = 2;

    struct ReentrancyStorage {
        uint256 status;
    }

    function reentrancyStorage()
        internal pure returns (ReentrancyStorage storage rs)
    {
        bytes32 pos = REENTRANCY_STORAGE_POSITION;
        assembly { rs.slot := pos }
    }

    /// @dev Call at function entry. Reverts with OZ-compatible selector if re-entered.
    ///      status == 0 (unwritten) is treated as NOT_ENTERED for fresh Diamond storage.
    function nonReentrantBefore() internal {
        ReentrancyStorage storage rs = reentrancyStorage();
        if (rs.status == ENTERED) {
            // Revert with OZ ReentrancyGuard selector: ReentrancyGuardReentrantCall()
            // selector = bytes4(keccak256("ReentrancyGuardReentrantCall()")) = 0x3ee5aeb5
            assembly {
                mstore(0x00, 0x3ee5aeb500000000000000000000000000000000000000000000000000000000)
                revert(0x00, 0x04)
            }
        }
        rs.status = ENTERED;
    }

    /// @dev Call at function exit (including after any external calls).
    function nonReentrantAfter() internal {
        reentrancyStorage().status = NOT_ENTERED;
    }
}
