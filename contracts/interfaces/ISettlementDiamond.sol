// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// [AD] L4.interfaces.ISettlementDiamond — see docs/architecture/views/15-onchain-view.md and 50-storage-slot-registry.md

import { LibSettlement } from "../libraries/LibSettlement.sol";

/// @title ISettlementDiamond
/// @notice Aggregated external interface across all 9 facets. Convenience
///         entry point for the orchestrator's DiamondClient (B-5+).
/// @dev    [SPEC §2.1] — selectors of every external/public facet method.
///         Backend imports this ABI and the per-facet ABIs, then dispatches
///         through the Diamond proxy.
interface ISettlementDiamond {
    // ─── QuoteVerifierFacet ────────────────────────────────────────────
    /// @notice Off-chain oracle quote envelope. Field order MUST match
    ///         `QuoteVerifierFacet.ORACLE_QUOTE_TYPEHASH`.
    struct OracleQuote {
        bytes32 quoteId;
        bytes32 corridorId;
        uint256 deliveryAmount;
        uint256 totalDebit;
        uint256 lpSourceMarginBps;
        uint256 tgsTreasuryMarginBps;
        uint256 lpDestMarginBps;
        uint256 validAfter;
        uint256 validBefore;
        string  midRate;
        // [B-14 C8] Orchestrator override attestation, bound to signature.
        bool    isOverridden;
    }
    /// @notice Verify a single-signer EIP-712 oracle quote and decode it.
    /// @return Decoded `OracleQuote` once verification succeeds.
    function verifyAndDecodeQuote(bytes calldata encodedQuote, bytes calldata signature)
        external view returns (OracleQuote memory);
    /// @notice [B-16 β-2] Queue a rotation of the single-signer oracle key.
    ///         Apply via `executeChange` after the time-lock delay.
    function queueOracleSignerChange(address newSigner) external returns (bytes32 changeId);

    // ─── FloatManagerFacet ─────────────────────────────────────────────
    /// @notice Read a partner's `(available, reserved)` GSDC float pair.
    function getAvailableFloat(address partner) external view returns (uint256 available, uint256 reserved);
    /// @notice Reserve `amount` of partner float for a settlement (orchestrator-only).
    function reserveFloat(address partner, bytes32 settlementId, uint256 amount) external;
    /// @notice Release a previously held reservation (orchestrator-only, idempotent).
    function releaseFloatReservation(address partner, bytes32 settlementId) external;
    /// @notice Read the reservation amount currently bound to a settlement.
    function getSettlementReservation(bytes32 settlementId) external view returns (uint256);

    // ─── SettlementExecutorFacet ───────────────────────────────────────
    /// @notice Atomic 4-leg settlement (single-signer oracle path).
    /// @dev    Orchestrator-only. See `SettlementExecutorFacet.executeSettlement`.
    function executeSettlement(
        bytes32 settlementId,
        bytes32 quoteId,
        bytes32 corridorId,
        address lpSource,
        address lpDest,
        uint256 deliveryAmount,
        bytes calldata encodedQuote,
        bytes calldata oracleSignature,
        bytes calldata authorizationSig
    ) external;
    /// @notice Read the persisted settlement snapshot.
    function getSettlement(bytes32 settlementId) external view returns (LibSettlement.Settlement memory);

    // ─── ComplianceGateFacet ───────────────────────────────────────────
    /// @notice Revert-on-fail guard used before a settlement is broadcast.
    /// @return Always returns `true`; reverts otherwise.
    function checkCompliance(address partner, bytes32 corridorId) external view returns (bool);
    /// @notice Admin-only one-shot partner registration.
    function registerPartner(
        address partner,
        address floatWallet,
        address marginWallet,
        bytes32 kycHash,
        bytes32[] calldata corridorIds
    ) external;
    /// @notice Admin-only suspension — clears the partner's `active` flag.
    function suspendPartner(address partner) external;
    /// @notice Admin-only re-activation of a suspended partner.
    function reactivatePartner(address partner) external;
    /// @notice Admin-only addition of a single corridor to a partner's set.
    function addPartnerCorridor(address partner, bytes32 corridorId) external;

    // ─── MarginSplitterFacet ───────────────────────────────────────────
    /// @notice Compute `(lpSource, tgsTreasury, lpDest)` margin slices in
    ///         GSDC base units for `deliveryAmount` on `corridorId`.
    function calculateMargins(bytes32 corridorId, uint256 deliveryAmount)
        external view returns (uint256 lpSourceMargin, uint256 tgsTreasuryMargin, uint256 lpDestMargin);

    // ─── TimeLockControllerFacet ───────────────────────────────────────
    /// @notice Queue a margin-bps update; executable after `timeLockDelay`.
    /// @return changeId Handle to pass to `executeChange` / `cancelChange`.
    function queueMarginUpdate(
        bytes32 corridorId,
        uint16 lpSourceBps,
        uint16 tgsTreasuryBps,
        uint16 lpDestBps
    ) external returns (bytes32 changeId);
    /// @notice Apply a queued change once its delay has elapsed (permissionless).
    function executeChange(bytes32 changeId) external;
    /// @notice Admin-only cancellation of a queued change before execution.
    function cancelChange(bytes32 changeId) external;
    /// @notice [B-14 C4] Queue a `timeLockDelay` rotation (meta-time-lock).
    function queueTimeLockDelayChange(uint32 newDelay) external;
    /// @notice [B-14 C4] Apply a queued `timeLockDelay` rotation.
    function executeTimeLockDelayChange() external;
    /// @notice [B-14 C3] Queue a rotation of the orchestrator role.
    function queueOrchestratorChange(address newOrchestrator) external returns (bytes32 changeId);
    /// @notice [B-16 β-2] Queue a multi-signer DON whitelist rotation.
    function queueOracleSignersChange(address[] calldata signers, uint256 threshold)
        external returns (bytes32 changeId);

    // ─── DisputeResolverFacet ──────────────────────────────────────────
    /// @notice Open a dispute against a previously executed settlement.
    function disputeSettlement(bytes32 settlementId, string calldata reason) external;

    // ─── MintBurnAuthorityFacet ────────────────────────────────────────
    /// @notice Admin-only mint of GSDC into a recipient (float top-up).
    function mintFloat(address to, uint256 amount) external;
    /// @notice Admin-only burn of GSDC from a wallet (recovery).
    function burnFloat(address from, uint256 amount) external;

    // ─── SettlementExecutorFacet (aggregated path) ─────────────────────
    function executeSettlementAggregated(
        bytes32 settlementId,
        bytes32 quoteId,
        bytes32 corridorId,
        address lpSource,
        address lpDest,
        uint256 deliveryAmount,
        bytes calldata encodedQuote,
        bytes[] calldata oracleSignatures,
        bytes32 reportsRoot,
        bytes calldata authorizationSig
    ) external;

    // ─── PausableFacet ─────────────────────────────────────────────────
    function pause() external;
    function unpause() external;
    function isPaused() external view returns (bool);

    // ─── TimeLockControllerFacet — two-step admin transfer ─────────────
    function transferAdmin(address newAdmin) external;
    function acceptAdmin() external;

    // ─── TimeLockControllerFacet — corridor lifecycle ──────────────────
    function configureCorridor(
        bytes32 corridorId,
        bool active,
        uint256 minAmount,
        uint256 maxAmount,
        uint32 windowStart,
        uint32 windowEnd
    ) external;
    function getPendingChange(bytes32 changeId) external view returns (uint256 readyAt);

    // ─── QuoteVerifierFacet (aggregated path) ──────────────────────────
    function verifyAndDecodeAggregatedQuote(
        bytes calldata encodedQuote,
        bytes[] calldata signatures,
        bytes32 reportsRoot
    ) external view returns (OracleQuote memory);

    // ─── DiamondLoupeFacet — ERC-165 ───────────────────────────────────
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}
