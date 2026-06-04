// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title LibSettlement — Diamond storage struct shared across all 9 facets.
/// @notice [SPEC §2.2] verbatim from Sandip's Smart Contract Spec v1.
/// @dev Storage slot is keccak256("gsdc.settlement.storage.v1"). Do not
///      collide with the LibDiamond standard slot (different keccak).
library LibSettlement {
    bytes32 constant SETTLEMENT_STORAGE_POSITION = keccak256("gsdc.settlement.storage.v1");

    struct PartnerConfig {
        address floatWallet;
        address marginWallet;
        bool    active;
        bytes32 kycHash;
        uint16  corridorCount;
        mapping(bytes32 => bool) authorisedCorridors;
    }

    struct CorridorConfig {
        bool    active;
        uint256 minDeliveryAmount;
        uint256 maxDeliveryAmount;
        uint16  lpSourceMarginBps;
        uint16  tgsTreasuryMarginBps;
        uint16  lpDestMarginBps;
        uint32  settlementWindowStart; // seconds from midnight UTC
        uint32  settlementWindowEnd;
    }

    struct Settlement {
        bytes32 settlementId;
        bytes32 quoteId;
        bytes32 corridorId;
        address lpSource;
        address lpDest;
        uint256 deliveryAmount;
        uint256 totalDebit;
        uint256 lpSourceMargin;
        uint256 tgsTreasuryMargin;
        uint256 lpDestMargin;
        uint8   status; // 0=PENDING 1=EXECUTING 2=SETTLED 3=FAILED
        uint256 createdAt;
        uint256 settledAt;
    }

    struct DiamondStorage {
        mapping(address => PartnerConfig) partners;
        mapping(bytes32 => CorridorConfig) corridors;
        mapping(bytes32 => Settlement) settlements;
        mapping(address => uint256) floatReservations;     // partnerWallet => total reserved
        mapping(bytes32 => uint256) settlementReservations; // settlementId => amount
        address gsdcToken;
        address tgsTreasuryWallet;
        address tgsTreasuryMarginWallet;
        address admin;
        address pendingAdmin;
        address oracleSigner;
        uint32  maxQuoteTTL;
        uint32  timeLockDelay;
        mapping(bytes32 => uint256) pendingChanges; // changeId => executeAfter
        mapping(bytes32 => bytes)   pendingChangePayloads;
        mapping(address => mapping(bytes32 => bool)) usedNonces;
        // [B-12 §3] DON+DAO multi-signer oracle whitelist + threshold.
        // Backwards-compat: `oracleSigner` (singular, above) STILL used by
        // verifyAndDecodeQuote() (B-7 single-signer path). The new
        // verifyAndDecodeAggregatedQuote() reads `oracleSigners[]` +
        // `oracleThreshold`. ORACLE_MODE env var on the orchestrator
        // selects which path executeSettlement uses. Storage layout is
        // append-only — no existing slot moves.
        address[] oracleSigners;
        uint256 oracleThreshold;
        // [B-14 C3] Separate orchestrator role from admin. Append-only
        // so existing slot ordering is unchanged. Kimi CRIT-5: before
        // B-14 the comment at enforceOrchestrator() promised this split
        // but enforceOrchestrator() actually checked ds.admin. Now they
        // are genuinely distinct addresses, settable via the admin-only
        // setter on TimeLockControllerFacet.setOrchestrator.
        address orchestrator;
        // [B-16 β-1/2] audit: NEW-001 / NEW-010 / closes CRIT-5
        // Kind discriminator for queued changes. Recorded at queue
        // time, read at execute time so the dispatcher knows how to
        // decode the payload. Absent (zero-bytes32) for changes
        // queued before B-16-β — those are treated as legacy-margin
        // for backwards compatibility (see [B-16 β-1 SHIM] comment in
        // TimeLockControllerFacet.executeChange).
        //
        // Storage is append-only; the new mapping slot lives after
        // `orchestrator` so no existing slot moves.
        mapping(bytes32 => bytes32) pendingChangeKinds; // changeId => keccak256(kind)
        // [B-14 C4] Meta-time-lock for timeLockDelay rotation.
        // Append-only — both fields live after `pendingChangeKinds`.
        // `pendingTimeLockDelayReadyAt == 0` means "no delay change queued".
        uint32  pendingTimeLockDelay;
        uint256 pendingTimeLockDelayReadyAt;
    }

    function diamondStorage() internal pure returns (DiamondStorage storage ds) {
        bytes32 position = SETTLEMENT_STORAGE_POSITION;
        // solhint-disable-next-line no-inline-assembly
        assembly { ds.slot := position }
    }

    /// @dev Internal modifier helper — facets read this rather than copying logic.
    function enforceAdmin() internal view {
        require(msg.sender == diamondStorage().admin, "LibSettlement: not admin");
    }

    /// @dev [B-14 C3] Settlement Orchestrator backend signs all reserve /
    ///      release / execute calls. Distinct from admin. For dev-fixture
    ///      + test setups, the same EOA can be passed as both admin and
    ///      orchestrator in DiamondInit (backwards-compat with B-4..B-13
    ///      test fixtures). Production deployments set them to distinct
    ///      addresses so an admin-key compromise cannot itself submit
    ///      settlements, and an orchestrator-key compromise cannot rotate
    ///      governance.
    function enforceOrchestrator() internal view {
        require(msg.sender == diamondStorage().orchestrator, "LibSettlement: not orchestrator");
    }
}
