// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { LibSettlement } from "../libraries/LibSettlement.sol";

/// @title DisputeResolverFacet [SPEC §2.1]
/// @notice Recovery path for failed settlements. Minimal scaffolding for B-4.
///         Real dispute workflow (refund + re-route) lands in B-13 alongside
///         operator dispute UI.
contract DisputeResolverFacet {
    event SettlementDisputed(bytes32 indexed settlementId, address indexed disputant, string reason);

    error SettlementNotFound(bytes32 settlementId);
    error UnauthorisedDisputant(address caller);

    function disputeSettlement(bytes32 settlementId, string calldata reason) external {
        LibSettlement.DiamondStorage storage ds = LibSettlement.diamondStorage();
        LibSettlement.Settlement storage stored = ds.settlements[settlementId];
        if (stored.status == 0) revert SettlementNotFound(settlementId);
        // Req-43: only the two LPs or the orchestrator may dispute
        if (
            msg.sender != stored.lpSource &&
            msg.sender != stored.lpDest &&
            msg.sender != ds.orchestrator
        ) revert UnauthorisedDisputant(msg.sender);
        emit SettlementDisputed(settlementId, msg.sender, reason);
    }
}
