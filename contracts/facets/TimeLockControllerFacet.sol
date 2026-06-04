// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// [AD] L4.facet.TimeLockControllerFacet — see docs/architecture/views/15-onchain-view.md and 50-storage-slot-registry.md

import { LibSettlement } from "../libraries/LibSettlement.sol";

/// @title TimeLockControllerFacet [SPEC §2.7] — unified queue/execute dispatcher.
/// @notice Time-locks admin parameter changes. Default delay 48 hours in prod.
/// @dev    B-16-β: every queued change carries a `kind` discriminator so the
///         executor knows how to decode the payload. Four kinds supported:
///         "margin", "orchestrator", "oracleSigner", "oracleSigners". Plus
///         a sibling meta-time-lock for `timeLockDelay` rotation.
contract TimeLockControllerFacet {
    // ─── Errors ──────────────────────────────────────────────────────
    error ChangeNotReady(bytes32 changeId, uint256 readyAt);
    error ChangeNotFound(bytes32 changeId);
    error ZeroOrchestrator();
    error MarginBpsSumExceedsMax(uint256 sum);
    error UnknownKind(bytes32 kind);
    error DelayChangeNotReady(uint256 readyAt);
    error DelayChangeNotFound();

    // ─── Events ──────────────────────────────────────────────────────
    event ChangeQueued(bytes32 indexed changeId, uint256 executeAfter);
    event ChangeExecuted(bytes32 indexed changeId);
    event ChangeCancelled(bytes32 indexed changeId);
    event TimeLockDelayQueued(uint32 newDelay, uint256 executeAfter);
    event TimeLockDelayExecuted(uint32 newDelay);
    event CorridorConfigured(bytes32 indexed corridorId, bool active);
    event OrchestratorChanged(address indexed newOrchestrator);
    /// @notice [B-14 B7] Unified oracle-signer rotation event. Same topic
    ///         hash is declared on QuoteVerifierFacet + OracleGovernanceFacet
    ///         so off-chain indexers see one canonical signature across both
    ///         singular and multi rotation paths.
    event OracleSignersUpdated(
        address indexed actor,
        address[] oldSigners,
        address[] newSigners,
        uint256 oldThreshold,
        uint256 newThreshold,
        bytes32 indexed eventId
    );

    // ─── Kind discriminator constants ───────────────────────────────
    bytes32 internal constant KIND_MARGIN          = keccak256("margin");
    bytes32 internal constant KIND_ORCHESTRATOR    = keccak256("orchestrator");
    bytes32 internal constant KIND_ORACLE_SIGNER   = keccak256("oracleSigner");
    bytes32 internal constant KIND_ORACLE_SIGNERS  = keccak256("oracleSigners");

    // ─── Queue functions ────────────────────────────────────────────

    /// @notice Queue a margin-bps update for a corridor.
    function queueMarginUpdate(
        bytes32 corridorId,
        uint16 lpSourceBps,
        uint16 tgsTreasuryBps,
        uint16 lpDestBps
    ) external returns (bytes32 changeId) {
        LibSettlement.enforceAdmin();
        LibSettlement.DiamondStorage storage ds = LibSettlement.diamondStorage();
        bytes memory payload = abi.encode(corridorId, lpSourceBps, tgsTreasuryBps, lpDestBps);
        changeId = keccak256(abi.encode("margin", payload, block.timestamp, block.number));
        uint256 readyAt = block.timestamp + ds.timeLockDelay;
        ds.pendingChanges[changeId] = readyAt;
        ds.pendingChangePayloads[changeId] = payload;
        ds.pendingChangeKinds[changeId] = KIND_MARGIN;
        emit ChangeQueued(changeId, readyAt);
    }

    /// @notice [B-14 C3 + B-16 β-1] Queue a rotation of the orchestrator role.
    function queueOrchestratorChange(address newOrchestrator) external returns (bytes32 changeId) {
        LibSettlement.enforceAdmin();
        if (newOrchestrator == address(0)) revert ZeroOrchestrator();
        LibSettlement.DiamondStorage storage ds = LibSettlement.diamondStorage();
        bytes memory payload = abi.encode(newOrchestrator);
        changeId = keccak256(abi.encode("orchestrator", payload, block.timestamp, block.number));
        uint256 readyAt = block.timestamp + ds.timeLockDelay;
        ds.pendingChanges[changeId] = readyAt;
        ds.pendingChangePayloads[changeId] = payload;
        ds.pendingChangeKinds[changeId] = KIND_ORCHESTRATOR;
        emit ChangeQueued(changeId, readyAt);
    }

    /// @notice [B-14 C4] Meta-time-lock: queue a `timeLockDelay` rotation
    ///         gated by the CURRENT delay (so lowering the delay still
    ///         requires the old delay to elapse first).
    function queueTimeLockDelayChange(uint32 newDelay) external {
        LibSettlement.enforceAdmin();
        LibSettlement.DiamondStorage storage ds = LibSettlement.diamondStorage();
        uint256 readyAt = block.timestamp + ds.timeLockDelay;
        ds.pendingTimeLockDelay = newDelay;
        ds.pendingTimeLockDelayReadyAt = readyAt;
        emit TimeLockDelayQueued(newDelay, readyAt);
    }

    /// @notice [B-14 C4] Apply a queued `timeLockDelay` rotation.
    function executeTimeLockDelayChange() external {
        LibSettlement.enforceAdmin();
        LibSettlement.DiamondStorage storage ds = LibSettlement.diamondStorage();
        uint256 readyAt = ds.pendingTimeLockDelayReadyAt;
        if (readyAt == 0) revert DelayChangeNotFound();
        if (block.timestamp < readyAt) revert DelayChangeNotReady(readyAt);
        uint32 newDelay = ds.pendingTimeLockDelay;
        ds.timeLockDelay = newDelay;
        ds.pendingTimeLockDelay = 0;
        ds.pendingTimeLockDelayReadyAt = 0;
        emit TimeLockDelayExecuted(newDelay);
    }

    // ─── Dispatcher ─────────────────────────────────────────────────

    /// @notice Apply a queued change once its delay has elapsed.
    /// @dev    [B-14 C7] Admin-gated as defence-in-depth. Reads the kind
    ///         discriminator and dispatches to the matching branch.
    function executeChange(bytes32 changeId) external {
        LibSettlement.enforceAdmin();
        LibSettlement.DiamondStorage storage ds = LibSettlement.diamondStorage();
        uint256 readyAt = ds.pendingChanges[changeId];
        if (readyAt == 0) revert ChangeNotFound(changeId);
        if (block.timestamp < readyAt) revert ChangeNotReady(changeId, readyAt);

        bytes32 kind = ds.pendingChangeKinds[changeId];
        bytes memory payload = ds.pendingChangePayloads[changeId];

        if (kind == KIND_MARGIN || kind == bytes32(0)) {
            // Legacy-margin compat: changes queued before B-16-β have
            // kind == 0; treat them as margin updates.
            (bytes32 corridorId, uint16 lpSourceBps, uint16 tgsTreasuryBps, uint16 lpDestBps) =
                abi.decode(payload, (bytes32, uint16, uint16, uint16));
            uint256 sum = uint256(lpSourceBps) + uint256(tgsTreasuryBps) + uint256(lpDestBps);
            if (sum > 10_000) revert MarginBpsSumExceedsMax(sum);
            LibSettlement.CorridorConfig storage c = ds.corridors[corridorId];
            c.lpSourceMarginBps = lpSourceBps;
            c.tgsTreasuryMarginBps = tgsTreasuryBps;
            c.lpDestMarginBps = lpDestBps;
        } else if (kind == KIND_ORCHESTRATOR) {
            address newOrch = abi.decode(payload, (address));
            ds.orchestrator = newOrch;
            emit OrchestratorChanged(newOrch);
        } else if (kind == KIND_ORACLE_SIGNER) {
            address newSigner = abi.decode(payload, (address));
            address[] memory oldSigners = new address[](1);
            oldSigners[0] = ds.oracleSigner;
            address[] memory newSigners = new address[](1);
            newSigners[0] = newSigner;
            uint256 thr = ds.oracleThreshold;
            ds.oracleSigner = newSigner;
            emit OracleSignersUpdated(msg.sender, oldSigners, newSigners, thr, thr, changeId);
        } else if (kind == KIND_ORACLE_SIGNERS) {
            (address[] memory newSigners, uint256 newThreshold) =
                abi.decode(payload, (address[], uint256));
            address[] memory oldSigners = ds.oracleSigners;
            uint256 oldThreshold = ds.oracleThreshold;
            delete ds.oracleSigners;
            for (uint256 i = 0; i < newSigners.length; i++) {
                ds.oracleSigners.push(newSigners[i]);
            }
            ds.oracleThreshold = newThreshold;
            emit OracleSignersUpdated(msg.sender, oldSigners, newSigners, oldThreshold, newThreshold, changeId);
        } else {
            revert UnknownKind(kind);
        }

        delete ds.pendingChanges[changeId];
        delete ds.pendingChangePayloads[changeId];
        delete ds.pendingChangeKinds[changeId];
        emit ChangeExecuted(changeId);
    }

    /// @notice Admin-only cancellation of a queued change before it executes.
    function cancelChange(bytes32 changeId) external {
        LibSettlement.enforceAdmin();
        LibSettlement.DiamondStorage storage ds = LibSettlement.diamondStorage();
        if (ds.pendingChanges[changeId] == 0) revert ChangeNotFound(changeId);
        delete ds.pendingChanges[changeId];
        delete ds.pendingChangePayloads[changeId];
        delete ds.pendingChangeKinds[changeId];
        emit ChangeCancelled(changeId);
    }

    /// @notice Admin-only corridor lifecycle config.
    function configureCorridor(
        bytes32 corridorId,
        bool active,
        uint256 minAmount,
        uint256 maxAmount,
        uint32 windowStart,
        uint32 windowEnd
    ) external {
        LibSettlement.enforceAdmin();
        LibSettlement.CorridorConfig storage c = LibSettlement.diamondStorage().corridors[corridorId];
        c.active = active;
        c.minDeliveryAmount = minAmount;
        c.maxDeliveryAmount = maxAmount;
        c.settlementWindowStart = windowStart;
        c.settlementWindowEnd = windowEnd;
        emit CorridorConfigured(corridorId, active);
    }

    /// @notice Inspect when a queued change becomes executable.
    function getPendingChange(bytes32 changeId) external view returns (uint256 readyAt) {
        return LibSettlement.diamondStorage().pendingChanges[changeId];
    }
}
