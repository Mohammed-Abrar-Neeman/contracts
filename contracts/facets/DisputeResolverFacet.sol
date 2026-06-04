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

    function disputeSettlement(bytes32 settlementId, string calldata reason) external {
        LibSettlement.DiamondStorage storage ds = LibSettlement.diamondStorage();
        if (ds.settlements[settlementId].status == 0) revert SettlementNotFound(settlementId);
        // [GAP] Dispute lifecycle (refund logic, re-route, partner consensus) is
        // out of scope for B-4. We log the dispute event so the orchestrator
        // and audit log can react, but on-chain refund logic ships in B-13.
        emit SettlementDisputed(settlementId, msg.sender, reason);
    }
}
