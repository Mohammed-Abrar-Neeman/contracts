// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// [AD] L4.facet.PausableFacet — B-16-β scaffold.
//
// Standalone scaffold not yet wired into the helpers.ts facetNames
// array — wired in once the per-facet whenNotPaused gates are added in
// the follow-up B-16-γ tranche. Compiles cleanly today so the
// migration is a single-line cut.

import { LibSettlement } from "../libraries/LibSettlement.sol";
import { LibPausable } from "../libraries/LibPausable.sol";

contract PausableFacet {
    error AlreadyPaused();
    error NotPaused();

    event Paused(address indexed actor, uint256 pausedAt);
    event Unpaused(address indexed actor, uint256 unpausedAt);

    /// @notice Admin-only emergency pause. Per-facet `whenNotPaused`
    ///         gates are added in B-16-γ.
    function pause() external {
        LibSettlement.enforceAdmin();
        LibPausable.PausableStorage storage ps = LibPausable.pausableStorage();
        if (ps.paused) revert AlreadyPaused();
        ps.paused = true;
        ps.pausedBy = msg.sender;
        ps.pausedAt = block.timestamp;
        emit Paused(msg.sender, block.timestamp);
    }

    /// @notice Admin-only resume.
    function unpause() external {
        LibSettlement.enforceAdmin();
        LibPausable.PausableStorage storage ps = LibPausable.pausableStorage();
        if (!ps.paused) revert NotPaused();
        ps.paused = false;
        ps.pausedBy = address(0);
        ps.pausedAt = 0;
        emit Unpaused(msg.sender, block.timestamp);
    }

    function isPaused() external view returns (bool) {
        return LibPausable.paused();
    }
}
