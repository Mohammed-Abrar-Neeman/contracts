// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// [AD] L4.lib.LibPausable — B-16-β PausableFacet storage helper.
//
// Storage-isolated under its own diamond slot
// (`keccak256("gsdc.pausable.storage")`) so adding/removing PausableFacet
// can never collide with LibSettlement state.

library LibPausable {
    bytes32 internal constant PAUSABLE_STORAGE_POSITION = keccak256("gsdc.pausable.storage");

    struct PausableStorage {
        bool paused;
        address pausedBy;
        uint256 pausedAt;
    }

    function pausableStorage() internal pure returns (PausableStorage storage ps) {
        bytes32 position = PAUSABLE_STORAGE_POSITION;
        // solhint-disable-next-line no-inline-assembly
        assembly { ps.slot := position }
    }

    function paused() internal view returns (bool) {
        return pausableStorage().paused;
    }
}
