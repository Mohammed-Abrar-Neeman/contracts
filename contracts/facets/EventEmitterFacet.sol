// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// [AD] L4.facet.EventEmitterFacet — see docs/architecture/views/15-onchain-view.md and 50-storage-slot-registry.md

/// @title EventEmitterFacet [SPEC §2.1]
/// @notice Centralised event definitions for indexer compatibility.
/// @dev    Events are emitted from the facets that own the action. This
///         facet is registered on the Diamond as a topic-source aggregator
///         so external indexers (TheGraph, Dune) get one ABI to subscribe to.
///         Emits also fire here when admin manually rebroadcasts a settlement
///         event (e.g. for indexer re-sync).
import { LibSettlement } from "../libraries/LibSettlement.sol";

contract EventEmitterFacet {
    /// @notice Re-emitted broadcast of a settlement payload, used by the
    ///         orchestrator to push extra context (full quote envelope etc.)
    ///         that does not fit on `SettlementExecuted`.
    event SettlementBroadcast(
        bytes32 indexed settlementId,
        bytes32 indexed corridorId,
        bytes payload
    );
    /// @notice Compliance-check outcome stream consumed by the operator
    ///         console and audit log. `requiresReview` flags a soft fail
    ///         that the compliance team must triage.
    event ComplianceCheckEmitted(
        bytes32 indexed settlementId,
        string  indexed checkName,
        bool    passed,
        bool    requiresReview
    );
    /// @notice Generic audit-trail message bound to a settlement. `eventType`
    ///         is the human-readable category (e.g. "QUOTE_REQUESTED",
    ///         "PARTNER_NOTIFIED") and `payload` is the serialised body.
    event AuditTrailEmitted(
        bytes32 indexed settlementId,
        string  indexed eventType,
        bytes payload
    );

    /// @notice Re-broadcast a settlement payload for indexer re-sync.
    /// @dev    [GAP] Open broadcast surface for B-4. Restrict to admin in B-5.
    function emitSettlementBroadcast(
        bytes32 settlementId,
        bytes32 corridorId,
        bytes calldata payload
    ) external {
        LibSettlement.enforceOrchestrator();
        emit SettlementBroadcast(settlementId, corridorId, payload);
    }

    /// @notice Append a compliance check outcome to the on-chain audit stream.
    /// @param settlementId   Id the check is attached to.
    /// @param checkName      Short identifier of the check (e.g. "OFAC").
    /// @param passed         True iff the check passed.
    /// @param requiresReview True iff a human must triage even on pass.
    function emitComplianceCheck(
        bytes32 settlementId,
        string calldata checkName,
        bool passed,
        bool requiresReview
    ) external {
        LibSettlement.enforceOrchestrator();
        emit ComplianceCheckEmitted(settlementId, checkName, passed, requiresReview);
    }

    /// @notice Append a generic audit-trail entry for a settlement.
    /// @param settlementId Id the entry is attached to.
    /// @param eventType    Category label (indexed for easy filtering).
    /// @param payload      Opaque serialised body for off-chain consumers.
    function emitAuditTrail(
        bytes32 settlementId,
        string calldata eventType,
        bytes calldata payload
    ) external {
        LibSettlement.enforceOrchestrator();
        emit AuditTrailEmitted(settlementId, eventType, payload);
    }
}
