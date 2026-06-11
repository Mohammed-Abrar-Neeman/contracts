# Requirements Document

## Introduction

This document specifies the requirements for the GSDC UI Developer Guide — a comprehensive reference document that enables frontend/UI developers to integrate with the GSDC Settlement Diamond smart contract system. The guide covers the complete settlement lifecycle (quote → execution → dispute), all admin operations, exact function signatures, parameter specifications, event subscriptions, error handling, and visual flowcharts. The target audience is UI developers building the Partner Platform (Track A dashboard) and any future API consumers who need to understand what to call, when, and in what order.

## Glossary

- **Diamond**: The EIP-2535 Diamond proxy contract that delegates calls to 13 facets sharing a single storage layout via `LibSettlement`
- **Facet**: A Solidity contract whose functions are exposed through the Diamond proxy via `delegatecall`
- **Settlement_Diamond**: The deployed Diamond proxy address through which all settlement operations are invoked
- **GSDC_Token**: The ERC-20 token contract with EIP-3009 `transferWithAuthorization` extension used as the settlement currency
- **Orchestrator**: The backend service (Settlement State Machine) authorized to call settlement execution, float reservation, and event emission functions
- **Admin**: The privileged address that manages corridors, partners, margins, oracle signers, and emergency pause — distinct from Orchestrator
- **LP_Source**: The liquidity provider funding a settlement (e.g., LP-BR collecting BRL and holding GSDC float)
- **LP_Dest**: The liquidity provider receiving the delivery leg of a settlement (e.g., LP-HK delivering CNH)
- **Corridor**: A configured settlement route identified by a `bytes32` corridorId (e.g., `keccak256("BRL_CNH")`) with min/max bounds, margin rates, and UTC time windows
- **MarginWallet**: A per-partner contract that accumulates GSDC margin fees; only the registered owner can withdraw
- **EIP_3009_Authorization**: A signed `transferWithAuthorization` message from LP_Source granting the Diamond permission to debit `totalDebit` GSDC in a single atomic transaction
- **Oracle_Quote**: An EIP-712 signed price quote from the DON oracle containing corridor, delivery amount, margin bps, and validity window
- **TimeLock**: A 48-hour (production) delay mechanism protecting admin parameter changes from immediate effect
- **Settlement_State**: One of four states — PENDING(0), EXECUTING(1), SETTLED(2), FAILED(3)
- **Float_Reservation**: A pre-settlement hold on a partner's GSDC balance ensuring sufficient funds exist before execution
- **UI_Developer**: A frontend or full-stack developer building interfaces that interact with the Settlement Diamond contract

## Requirements

### Requirement 1: Settlement Lifecycle Documentation

**User Story:** As a UI_Developer, I want a complete settlement lifecycle reference, so that I can build UIs that correctly orchestrate the quote-to-settlement flow.

#### Acceptance Criteria

1. THE Guide SHALL document the six sequential steps of the settlement lifecycle: corridor configuration (TimeLockControllerFacet), partner registration (ComplianceGateFacet), float reservation (FloatManagerFacet), oracle quote signing (QuoteVerifierFacet), EIP-3009 authorization signing (off-chain by lpSource), and settlement execution (SettlementExecutorFacet)
2. WHEN describing each lifecycle step, THE Guide SHALL specify the exact facet name and function selector that the UI or Orchestrator calls, including parameters and their types
3. THE Guide SHALL document the four settlement states (PENDING=0, EXECUTING=1, SETTLED=2, FAILED=3) and the valid state transitions: PENDING → EXECUTING (on executeSettlement entry), EXECUTING → SETTLED (on successful 4-leg fan-out completion)
4. THE Guide SHALL include a Mermaid sequence diagram showing the complete settlement flow from quote request through atomic 4-leg fan-out to final SETTLED state, labelling each participant (UI, Orchestrator, Diamond, lpSource, lpDest)
5. THE Guide SHALL document that `executeSettlement` atomically performs: quote verification → EIP-3009 redemption of totalDebit from lpSource → delivery transfer to lpDest → lpSource margin transfer to lpSource's marginWallet → TGS treasury margin transfer to tgsTreasuryMarginWallet → lpDest margin transfer to lpDest's marginWallet → float release
6. THE Guide SHALL document each revert condition that `executeSettlement` can produce (SettlementAlreadyExecuted, CorridorNotActive, AmountBelowMinimum, AmountAboveMaximum, OutsideSettlementWindow, PartnerNotAuthorised, QuoteCorridorMismatch, DeliveryAmountMismatch, InvalidAuthorizationSig) including the trigger condition and the observable UI behaviour for each
7. THE Guide SHALL document the corridor settlement window constraint, specifying that settlements are rejected outside the corridor's configured UTC time window (defined as seconds-from-midnight start and end, supporting wrap-around windows such as 22:00–04:00), and that the UI must communicate window availability to the operator

### Requirement 2: Function Signature Reference — SettlementExecutorFacet

**User Story:** As a UI_Developer, I want exact function signatures and parameter definitions for settlement execution, so that I can construct correct transaction calldata.

#### Acceptance Criteria

1. THE Guide SHALL document the `executeSettlement(bytes32 settlementId, bytes32 quoteId, bytes32 corridorId, address lpSource, address lpDest, uint256 deliveryAmount, bytes encodedQuote, bytes oracleSignature, bytes authorizationSig)` function with type, size, and semantic description for each parameter
2. THE Guide SHALL document the `executeSettlementAggregated` variant with its full parameter list — identical to `executeSettlement` except `bytes oracleSignature` is replaced by `bytes[] oracleSignatures` and an additional `bytes32 reportsRoot` parameter is appended — specifying that the array must contain at least `oracleThreshold` distinct DON-signer signatures and that `reportsRoot` is the Merkle root over per-signer DON report hashes
3. THE Guide SHALL document that `authorizationSig` is exactly 97 bytes laid out as: `validBefore(32 bytes) || r(32 bytes) || s(32 bytes) || v(1 byte)`, and that the contract reverts with `InvalidAuthorizationSig` if the length is not exactly 97 bytes
4. THE Guide SHALL document that `settlementId` doubles as the EIP-3009 nonce, binding the authorization to a specific settlement to prevent cross-settlement replay
5. THE Guide SHALL document the `getSettlement(bytes32 settlementId)` view function and the `Settlement` struct it returns with its 13 fields: `settlementId`, `quoteId`, `corridorId`, `lpSource`, `lpDest`, `deliveryAmount`, `totalDebit`, `lpSourceMargin`, `tgsTreasuryMargin`, `lpDestMargin`, `status`, `createdAt`, and `settledAt`
6. THE Guide SHALL specify that only the Orchestrator address (distinct from the admin address) may call `executeSettlement` and `executeSettlementAggregated`, and that calls from any other address revert
7. THE Guide SHALL document the `status` field enum values returned by `getSettlement`: 0 = PENDING (never executed), 1 = EXECUTING (in-progress), 2 = SETTLED (completed successfully), 3 = FAILED
8. THE Guide SHALL document all revert error signatures the facet can produce: `SystemPaused`, `SettlementAlreadyExecuted(bytes32)`, `CorridorNotActive(bytes32)`, `PartnerNotAuthorised(address, bytes32)`, `OutsideSettlementWindow(bytes32)`, `AmountBelowMinimum(uint256, uint256)`, `AmountAboveMaximum(uint256, uint256)`, `QuoteCorridorMismatch`, `DeliveryAmountMismatch(uint256, uint256)`, and `InvalidAuthorizationSig`
9. THE Guide SHALL document the `SettlementExecuted` event signature with its 10 fields and indexed parameters (`settlementId`, `corridorId`, `lpSource`) so that UI developers can subscribe to and filter settlement completion events

### Requirement 3: Function Signature Reference — QuoteVerifierFacet

**User Story:** As a UI_Developer, I want exact function signatures for quote verification, so that I can validate oracle quotes off-chain before submitting settlements.

#### Acceptance Criteria

1. THE Guide SHALL document the `verifyAndDecodeQuote(bytes calldata encodedQuote, bytes calldata signature) external view returns (OracleQuote memory)` function, specifying that `OracleQuote` is a struct of 11 fields in this order: `quoteId` (bytes32), `corridorId` (bytes32), `deliveryAmount` (uint256), `totalDebit` (uint256), `lpSourceMarginBps` (uint256), `tgsTreasuryMarginBps` (uint256), `lpDestMarginBps` (uint256), `validAfter` (uint256), `validBefore` (uint256), `midRate` (string), `isOverridden` (bool), and that `midRate` being a dynamic type is hashed as `keccak256(bytes(midRate))` when computing the EIP-712 struct hash
2. THE Guide SHALL document the `verifyAndDecodeAggregatedQuote(bytes calldata encodedQuote, bytes[] calldata signatures, bytes32 reportsRoot) external view returns (OracleQuote memory)` function, specifying that it requires at least `oracleThreshold` unique signatures from the `oracleSigners[]` whitelist and that each signature must recover to a distinct whitelisted address
3. THE Guide SHALL document the EIP-712 domain separator parameters: name=`"GSDCOracle"`, version=`"1"`, chainId=`block.chainid` (read dynamically at call time), verifyingContract=`address(this)` (the Diamond proxy address, since the facet executes via delegatecall), and that the read-only helper `quoteDomainSeparator() external view returns (bytes32)` exposes the computed domain separator for off-chain callers
4. THE Guide SHALL document both typehashes by presenting their full encoding strings: `ORACLE_QUOTE_TYPEHASH` = keccak256 of `"OracleQuote(bytes32 quoteId,bytes32 corridorId,uint256 deliveryAmount,uint256 totalDebit,uint256 lpSourceMarginBps,uint256 tgsTreasuryMarginBps,uint256 lpDestMarginBps,uint256 validAfter,uint256 validBefore,string midRate,bool isOverridden)"`, and `ORACLE_QUOTE_AGGREGATED_TYPEHASH` = the same fields plus `bytes32 reportsRoot` inserted before `isOverridden`
5. THE Guide SHALL document the `queueOracleSignerChange(address newSigner) external returns (bytes32 changeId)` admin-only function, specifying that it emits `ChangeQueued(changeId, executeAfter)` where `executeAfter = block.timestamp + timeLockDelay`, and that the rotation is applied only when `TimeLockControllerFacet.executeChange(changeId)` is called after the delay elapses
6. THE Guide SHALL document that both verification functions reject quotes with: `QuoteNotYetValid(quoteId, validAfter)` when `block.timestamp <= validAfter`, `QuoteExpired(quoteId, validBefore)` when `block.timestamp >= validBefore`, and `QuoteTTLExceeded(quoteId, ttl, maxTTL)` when `maxQuoteTTL > 0` and `(validBefore - validAfter) > maxQuoteTTL`; and that `verifyAndDecodeAggregatedQuote` additionally reverts with `BelowThreshold(provided, required)` when fewer than `oracleThreshold` signatures are supplied, `DuplicateSigner(signer)` when two signatures recover to the same address, or `InvalidOracleSignature()` when a recovered address is not in the `oracleSigners[]` whitelist

### Requirement 4: Function Signature Reference — FloatManagerFacet

**User Story:** As a UI_Developer, I want exact function signatures for float management, so that I can build float balance displays and reservation workflows.

#### Acceptance Criteria

1. THE Guide SHALL document `getAvailableFloat(address partner)` returning `(uint256 available, uint256 reserved)` where `available = balanceOf(partner) - reserved` when `balanceOf(partner) >= reserved`, and `available = 0` when `balanceOf(partner) < reserved`
2. THE Guide SHALL document `reserveFloat(address partner, bytes32 settlementId, uint256 amount)` as Orchestrator-only, specifying that it reverts with `ReservationAlreadyExists(settlementId)` if the settlementId already has a non-zero reservation, reverts with `InsufficientFloat(partner, available, required)` if the requested amount exceeds the partner's available float, and reverts with `SystemPaused()` if the system is paused
3. THE Guide SHALL document `releaseFloatReservation(address partner, bytes32 settlementId)` as Orchestrator-only and idempotent, specifying that calling it on an already-released or non-existent reservation performs no state change and returns 0 without reverting
4. THE Guide SHALL document `getSettlementReservation(bytes32 settlementId)` returning `uint256` representing the reserved amount for a given settlement, returning 0 if no reservation exists for the provided settlementId
5. THE Guide SHALL document that `reserveFloat` checks the requested amount against the partner's live GSDC token balance (via `balanceOf`) at reservation time and reverts with `InsufficientFloat` if `balanceOf(partner) - existingReservations < amount`
6. WHEN `reserveFloat` succeeds, THE Guide SHALL document that the contract emits a `FloatReserved(address indexed partner, bytes32 indexed settlementId, uint256 amount)` event, and WHEN `releaseFloatReservation` releases a non-zero reservation, the contract emits a `FloatReleased(address indexed partner, bytes32 indexed settlementId, uint256 amount)` event

### Requirement 5: Function Signature Reference — ComplianceGateFacet

**User Story:** As a UI_Developer, I want exact function signatures for compliance operations, so that I can build partner management and compliance-check UIs.

#### Acceptance Criteria

1. THE Guide SHALL document `checkCompliance(address partner, bytes32 corridorId)` as a view function that checks in order: (a) reverts with `PartnerSuspended_(partner)` if partner's active flag is false, (b) reverts with `PartnerNotAuthorised(partner, corridorId)` if partner's kycHash is `bytes32(0)`, (c) reverts with `PartnerNotAuthorised(partner, corridorId)` if the corridor is not in the partner's authorised set, and returns `true` if all checks pass
2. THE Guide SHALL document `registerPartner(address partner, address floatWallet, address marginWallet, bytes32 kycHash, bytes32[] corridorIds)` as Admin-only, specifying it reverts with `PartnerAlreadyRegistered(partner)` if the partner's kycHash is already non-zero, sets the partner's active flag to true on success, performs idempotent corridor assignment for each entry in `corridorIds`, and emits `PartnerRegistered(address indexed partner, bytes32 kycHash)`
3. THE Guide SHALL document `suspendPartner(address partner)` as Admin-only, specifying it sets the partner's active flag to false and emits `PartnerSuspended(address indexed partner)`, and `reactivatePartner(address partner)` as Admin-only, specifying it sets the partner's active flag to true and emits `PartnerReactivated(address indexed partner)`
4. THE Guide SHALL document `addPartnerCorridor(address partner, bytes32 corridorId)` as Admin-only, noting it is idempotent (no revert if corridor already authorized) and emits `PartnerCorridorAdded(address indexed partner, bytes32 indexed corridorId)` only when the corridor was not previously authorized for that partner

### Requirement 6: Function Signature Reference — TimeLockControllerFacet

**User Story:** As a UI_Developer, I want exact function signatures for time-locked admin operations, so that I can build governance UIs with proper queue-wait-execute flows.

#### Acceptance Criteria

1. THE Guide SHALL document the queue-execute pattern: `queueMarginUpdate(bytes32 corridorId, uint16 lpSourceBps, uint16 tgsTreasuryBps, uint16 lpDestBps) → bytes32 changeId` → wait `timeLockDelay` (default 48 hours) → `executeChange(bytes32 changeId)` with the four supported change kinds (margin, orchestrator, oracleSigner, oracleSigners), noting that both queue functions and `executeChange` are Admin-only
2. THE Guide SHALL document `configureCorridor(bytes32 corridorId, bool active, uint256 minAmount, uint256 maxAmount, uint32 windowStart, uint32 windowEnd)` as Admin-only with immediate effect (no time-lock), emitting `CorridorConfigured(corridorId, active)`
3. THE Guide SHALL document `queueOrchestratorChange(address newOrchestrator) → bytes32 changeId` as Admin-only, reverting with `ZeroOrchestrator` if address(0) is supplied, and emitting `ChangeQueued(changeId, executeAfter)` on success
4. THE Guide SHALL document `queueTimeLockDelayChange(uint32 newDelay)` and `executeTimeLockDelayChange()` as the Admin-only meta-time-lock pair for rotating the delay value itself, where `executeTimeLockDelayChange` reverts with `DelayChangeNotFound` if no change is pending or `DelayChangeNotReady(readyAt)` if the current delay has not yet elapsed
5. THE Guide SHALL document the two-step admin transfer: `transferAdmin(address newAdmin)` called by the current Admin (reverting with `ZeroAdmin` if address(0)) followed by `acceptAdmin()` called by the nominee (reverting with `NotPendingAdmin` if caller is not the nominated address)
6. THE Guide SHALL document `cancelChange(bytes32 changeId)` as Admin-only cancellation that reverts with `ChangeNotFound(changeId)` if the changeId has no pending entry, and `getPendingChange(bytes32 changeId) → uint256 readyAt` returning the timestamp at which the change becomes executable (0 if not found)
7. THE Guide SHALL document that `executeChange` reverts with `ChangeNotFound(changeId)` if the changeId is unknown, `ChangeNotReady(changeId, readyAt)` if the delay has not elapsed, and `MarginBpsSumExceedsMax(sum)` if the sum of `lpSourceBps + tgsTreasuryBps + lpDestBps` exceeds 10,000 for margin-kind changes

### Requirement 7: Function Signature Reference — DisputeResolverFacet

**User Story:** As a UI_Developer, I want exact function signatures for the dispute workflow, so that I can build dispute submission UIs for LPs.

#### Acceptance Criteria

1. THE Guide SHALL document `disputeSettlement(bytes32 settlementId, string calldata reason)` specifying that only LP_Source, LP_Dest, or the Orchestrator may call it, and that the `reason` parameter has no on-chain length enforcement but the UI should limit input to 1024 characters to bound gas costs and off-chain indexing payload size
2. IF the settlement status is 0 (never executed), THEN THE DisputeResolverFacet SHALL revert with `SettlementNotFound(bytes32 settlementId)`; THE Guide SHALL document that this check executes before the authorization check, so `SettlementNotFound` always surfaces before `UnauthorisedDisputant`
3. IF the caller is not the settlement's `lpSource`, `lpDest`, or the `DiamondStorage.orchestrator`, THEN THE DisputeResolverFacet SHALL revert with `UnauthorisedDisputant(address caller)`; THE Guide SHALL document the full error selector including the `address` parameter type for ABI decoding
4. WHEN `disputeSettlement` is called by an authorized caller on a settlement with status != 0 (status 1 EXECUTING, status 2 SETTLED, or status 3 FAILED), THE DisputeResolverFacet SHALL emit `SettlementDisputed(bytes32 indexed settlementId, address indexed disputant, string reason)` without reverting, enabling off-chain indexers to filter by `settlementId` or `disputant`

### Requirement 8: Function Signature Reference — MintBurnAuthorityFacet

**User Story:** As a UI_Developer, I want exact function signatures for GSDC mint/burn operations, so that I can build admin float management UIs.

#### Acceptance Criteria

1. THE Guide SHALL document `mintFloat(address to, uint256 amount)` as Admin-only with no return value, specifying it calls `GSDCToken.mint` and emits `FloatMinted(address indexed to, uint256 amount, address indexed actor)` where `actor` is the calling admin address
2. THE Guide SHALL document `burnFloat(address from, uint256 amount)` as Admin-only with no return value, specifying it calls `GSDCToken.burn` and emits `FloatBurned(address indexed from, uint256 amount, address indexed actor)` where `actor` is the calling admin address
3. IF `mintFloat` or `burnFloat` is called when the Diamond does not hold GSDCToken ownership (via `transferOwnership`), THEN THE Guide SHALL document that the call reverts with OZ `OwnableUnauthorizedAccount(caller)` propagated from the token contract
4. IF `mintFloat` is called with `to == address(0)`, THEN THE Guide SHALL document that the call reverts with OZ `ERC20InvalidReceiver(address(0))` propagated from the token contract; IF `burnFloat` is called with `from == address(0)`, THEN THE Guide SHALL document that the call reverts with OZ `ERC20InvalidSender(address(0))`
5. THE Guide SHALL document that `amount` is an unrestricted `uint256` with no facet-level minimum or maximum enforced, and that `amount == 0` is accepted without revert

### Requirement 9: Function Signature Reference — PausableFacet

**User Story:** As a UI_Developer, I want exact function signatures for the emergency pause system, so that I can build system status indicators and admin emergency controls.

#### Acceptance Criteria

1. THE Guide SHALL document `pause()` as Admin-only, emitting `Paused(address indexed actor, uint256 pausedAt)` and reverting with `AlreadyPaused` if already paused
2. THE Guide SHALL document `unpause()` as Admin-only, emitting `Unpaused(address indexed actor, uint256 unpausedAt)` and reverting with `NotPaused` if not paused
3. THE Guide SHALL document `isPaused()` as a view function returning the current pause state
4. THE Guide SHALL document that `executeSettlement`, `executeSettlementAggregated`, and `reserveFloat` all revert with `SystemPaused` when the system is paused

### Requirement 10: Function Signature Reference — EventEmitterFacet

**User Story:** As a UI_Developer, I want exact function signatures for the event emission system, so that I can understand what audit events are available for UI display.

#### Acceptance Criteria

1. THE Guide SHALL document `emitSettlementBroadcast(bytes32 settlementId, bytes32 corridorId, bytes payload)` as Orchestrator-only
2. THE Guide SHALL document `emitComplianceCheck(bytes32 settlementId, string checkName, bool passed, bool requiresReview)` as Orchestrator-only
3. THE Guide SHALL document `emitAuditTrail(bytes32 settlementId, string eventType, bytes payload)` as Orchestrator-only
4. THE Guide SHALL document the three event signatures: `SettlementBroadcast`, `ComplianceCheckEmitted`, and `AuditTrailEmitted` with their indexed parameters for filtering

### Requirement 11: Function Signature Reference — OracleGovernanceFacet

**User Story:** As a UI_Developer, I want exact function signatures for oracle governance, so that I can build DON signer management UIs.

#### Acceptance Criteria

1. THE Guide SHALL document `queueOracleSignersChange(address[] signers, uint256 threshold)` as Admin-only, specifying validation rules: threshold >= 1, signers.length <= 10, signers.length >= threshold, no zero addresses, no duplicates
2. THE Guide SHALL document `getOracleSigners()` returning the current `address[]` whitelist
3. THE Guide SHALL document `getOracleThreshold()` returning the current quorum threshold
4. THE Guide SHALL document `isOracleSigner(address signer)` returning a boolean membership check

### Requirement 12: Function Signature Reference — MarginSplitterFacet

**User Story:** As a UI_Developer, I want exact function signatures for margin calculation, so that I can display fee breakdowns before settlement execution.

#### Acceptance Criteria

1. THE Guide SHALL document `calculateMargins(bytes32 corridorId, uint256 deliveryAmount)` returning `(uint256 lpSourceMargin, uint256 tgsTreasuryMargin, uint256 lpDestMargin)` computed as `(deliveryAmount * bps) / 10_000`
2. THE Guide SHALL document that the function reverts with `CorridorNotConfigured` if the corridor is not active
3. THE Guide SHALL document that `totalDebit = deliveryAmount + lpSourceMargin + tgsTreasuryMargin + lpDestMargin`

### Requirement 13: EIP-3009 Authorization Signing Guide

**User Story:** As a UI_Developer, I want a step-by-step guide for constructing EIP-3009 transfer authorizations, so that I can build the LP source signature flow in the UI.

#### Acceptance Criteria

1. THE Guide SHALL document the EIP-712 domain for GSDCToken: name="GSDC", version="1", chainId=the chain ID of the network where GSDCToken is deployed (e.g. 11155111 for Sepolia), verifyingContract=the deployed GSDCToken contract address
2. THE Guide SHALL document the `TransferWithAuthorization` typehash with fields: from (address), to (address), value (uint256), validAfter (uint256), validBefore (uint256), nonce (bytes32)
3. THE Guide SHALL document that the `nonce` field MUST equal the `settlementId` to bind the authorization to a specific settlement, because `_redeemAuthorization` passes `settlementId` as the nonce parameter to `transferWithAuthorization`
4. THE Guide SHALL document that `validAfter` MUST be set to exactly 0 (because `_redeemAuthorization` hardcodes `validAfter = 0` when calling `transferWithAuthorization`, so the signed struct hash must use 0 to match the on-chain digest reconstruction), and `validBefore` MUST be set to a Unix timestamp strictly greater than the expected `block.timestamp` at execution time (because the token reverts when `block.timestamp >= validBefore`)
5. THE Guide SHALL document the 97-byte signature packing format: bytes 0–31 contain `uint256(validBefore)`, bytes 32–63 contain `bytes32(r)`, bytes 64–95 contain `bytes32(s)`, and byte 96 contains `uint8(v)`, packed as `abi.encodePacked(uint256(validBefore), bytes32(r), bytes32(s), uint8(v))`
6. THE Guide SHALL document that `from` MUST equal the `lpSource` address, `to` MUST equal the Diamond proxy address (the contract passes `address(this)` as the `to` parameter), and `value` MUST equal `totalDebit` where `totalDebit = deliveryAmount + (deliveryAmount * lpSourceMarginBps / 10000) + (deliveryAmount * tgsTreasuryMarginBps / 10000) + (deliveryAmount * lpDestMarginBps / 10000)`
7. THE Guide SHALL document that the EIP-3009 authorization MUST be signed by the private key that controls the `from`/`lpSource` address, because the GSDCToken contract recovers the signer via ECDSA and reverts with `SignerMismatch` if the recovered address does not equal `from`

### Requirement 14: EIP-712 Oracle Quote Signing Guide

**User Story:** As a UI_Developer, I want a step-by-step guide for constructing and verifying oracle quotes, so that I can build quote display and verification UIs.

#### Acceptance Criteria

1. THE Guide SHALL document the `OracleQuote` struct ABI encoding order: (bytes32 quoteId, bytes32 corridorId, uint256 deliveryAmount, uint256 totalDebit, uint256 lpSourceMarginBps, uint256 tgsTreasuryMarginBps, uint256 lpDestMarginBps, uint256 validAfter, uint256 validBefore, string midRate, bool isOverridden)
2. THE Guide SHALL document the EIP-712 struct hash construction including `keccak256(bytes(midRate))` for the string field
3. THE Guide SHALL document that `totalDebit` in the quote MUST equal `deliveryAmount + sum_of_margins` and that the contract verifies `deliveryAmount` in the quote matches the parameter passed to `executeSettlement`
4. THE Guide SHALL document the `maxQuoteTTL` enforcement: `validBefore - validAfter` must not exceed the configured TTL (default 300 seconds)
5. WHEN describing the multi-signer path, THE Guide SHALL document that signatures must be from distinct whitelisted oracle signers and the count must meet or exceed `oracleThreshold`

### Requirement 15: Event Subscription Reference

**User Story:** As a UI_Developer, I want a complete list of events with their indexed parameters, so that I can build real-time dashboards and notification systems.

#### Acceptance Criteria

1. THE Guide SHALL document all events emitted by the Settlement Diamond organized by facet, including event signature, indexed parameters, and when each event fires
2. THE Guide SHALL document `SettlementExecuted` event fields (10 parameters: settlementId, corridorId, lpSource indexed; lpDest, deliveryAmount, totalDebit, lpSourceMargin, tgsTreasuryMargin, lpDestMargin, settledAt non-indexed)
3. THE Guide SHALL document governance events: `ChangeQueued(bytes32 indexed changeId, uint256 executeAfter)`, `ChangeExecuted(bytes32 indexed changeId)`, `ChangeCancelled(bytes32 indexed changeId)`
4. THE Guide SHALL document partner lifecycle events: `PartnerRegistered`, `PartnerSuspended`, `PartnerReactivated`, `PartnerCorridorAdded`
5. THE Guide SHALL document float events: `FloatReserved(address indexed partner, bytes32 indexed settlementId, uint256 amount)`, `FloatReleased`
6. THE Guide SHALL document that the `OracleSignersUpdated` event is emitted from `TimeLockControllerFacet.executeChange` (not from the originating governance facet) and has the same topic hash across all three facet declarations

### Requirement 16: Error Reference and Handling Guide

**User Story:** As a UI_Developer, I want a complete error reference, so that I can build meaningful error messages and recovery flows in the UI.

#### Acceptance Criteria

1. THE Guide SHALL document all custom errors from SettlementExecutorFacet: `SystemPaused`, `SettlementAlreadyExecuted(bytes32)`, `SettlementNotFound(bytes32)`, `CorridorNotActive(bytes32)`, `PartnerNotAuthorised(address, bytes32)`, `OutsideSettlementWindow(bytes32)`, `AmountBelowMinimum(uint256, uint256)`, `AmountAboveMaximum(uint256, uint256)`, `QuoteCorridorMismatch`, `DeliveryAmountMismatch(uint256, uint256)`, `InvalidAuthorizationSig`
2. THE Guide SHALL document all custom errors from QuoteVerifierFacet: `InvalidOracleSignature`, `QuoteExpired(bytes32, uint256)`, `QuoteNotYetValid(bytes32, uint256)`, `BelowThreshold(uint256, uint256)`, `DuplicateSigner(address)`, `QuoteTTLExceeded(bytes32, uint256, uint256)`
3. THE Guide SHALL document the EIP-3009 errors from GSDCToken: `AuthorizationAlreadyUsed(address, bytes32)`, `AuthorizationNotYetValid(uint256, uint256)`, `AuthorizationExpired(uint256, uint256)`, `InvalidSignature`, `SignerMismatch(address, address)`
4. THE Guide SHALL document the check order in `executeSettlement` (duplicate check → corridor active → min/max bounds → window → partner auth → quote verify → EIP-3009 redemption → transfers) so the UI can predict which error surfaces first
5. IF a settlement transaction reverts, THEN THE Guide SHALL specify how to decode the custom error selector from the revert data to identify the specific failure reason

### Requirement 17: Access Control Matrix

**User Story:** As a UI_Developer, I want a clear access control matrix, so that I can correctly gate UI operations by the connected wallet's role.

#### Acceptance Criteria

1. THE Guide SHALL document a matrix mapping each external function across all facets to its required caller role: Admin, Orchestrator, LP_Source, LP_Dest, Pending_Admin, or Public (any address), where Admin-gated functions include `queueMarginUpdate`, `queueOrchestratorChange`, `queueTimeLockDelayChange`, `executeTimeLockDelayChange`, `executeChange`, `cancelChange`, `configureCorridor`, `registerPartner`, `suspendPartner`, `reactivatePartner`, `addPartnerCorridor`, `mintFloat`, `burnFloat`, `pause`, `unpause`, `queueOracleSignerChange`, `queueOracleSignersChange`, and `transferAdmin`; Orchestrator-gated functions include `executeSettlement`, `executeSettlementAggregated`, `reserveFloat`, `releaseFloatReservation`, `emitSettlementBroadcast`, `emitComplianceCheck`, and `emitAuditTrail`; and Pending_Admin-gated function is `acceptAdmin`
2. THE Guide SHALL document that Admin uses a two-step rotation via `transferAdmin` (admin-only nomination) followed by `acceptAdmin` (pending-admin-only claim) without a time-lock delay, and that Orchestrator is rotatable via `queueOrchestratorChange` subject to the configured time-lock delay, with both roles initially set during DiamondInit
3. THE Guide SHALL document that all view functions (`getAvailableFloat`, `getSettlement`, `calculateMargins`, `isPaused`, `checkCompliance`, `getOracleSigners`, `getOracleThreshold`, `isOracleSigner`, `getSettlementReservation`, `getPendingChange`) are callable by any address without restriction and do not require transaction signing beyond gas payment
4. THE Guide SHALL document that `disputeSettlement` is callable only by the settlement's `lpSource`, `lpDest`, or the Orchestrator address, and that any other caller causes a revert with `UnauthorisedDisputant(caller)`
5. IF any address not matching the required role for a gated function calls that function, THEN THE Diamond_System SHALL revert with `"LibSettlement: not admin"` for Admin-gated functions, `"LibSettlement: not orchestrator"` for Orchestrator-gated functions, `NotPendingAdmin()` for `acceptAdmin`, and `UnauthorisedDisputant(caller)` for `disputeSettlement`

### Requirement 18: MarginWallet Interaction Guide

**User Story:** As a UI_Developer, I want documentation on MarginWallet interactions, so that I can build partner margin balance and withdrawal UIs.

#### Acceptance Criteria

1. THE Guide SHALL document that MarginWallet is a standalone contract (not a Diamond facet) deployed per-partner with three immutables: `gsdc` (token address), `owner` (partner address), `settlementDiamond` (Diamond proxy address)
2. THE Guide SHALL document `withdraw(address to, uint256 amount)` as owner-only, specifying it reverts with `NotOwner`, `ZeroAddress`, `ZeroAmount`, or `InsufficientBalance(uint256, uint256)`
3. THE Guide SHALL document `balance()` as a view function returning the MarginWallet's current GSDC token balance
4. THE Guide SHALL document that margin deposits happen automatically during settlement execution (Diamond transfers GSDC directly to the MarginWallet address) and the `MarginDeposited` event is NOT emitted by the Diamond but by the MarginWallet's `deposit` function (which the current flow does not call — deposits are raw ERC-20 transfers)

### Requirement 19: Diamond Architecture Overview

**User Story:** As a UI_Developer, I want a clear explanation of the Diamond proxy pattern, so that I can understand why all calls go to a single address and how to resolve function selectors.

#### Acceptance Criteria

1. THE Guide SHALL document that all 13 facets are accessed through a single Diamond proxy address via `delegatecall`, meaning the UI always sends transactions to one contract address
2. THE Guide SHALL document the `DiamondLoupeFacet` introspection functions: `facetAddresses()`, `facetFunctionSelectors(address)`, `facetAddress(bytes4)`, and `supportsInterface(bytes4)`
3. THE Guide SHALL document that `ISettlementDiamond` is the aggregated ABI interface containing all external function signatures across all facets
4. THE Guide SHALL document the `DiamondInit` initialization parameters: admin, orchestrator, oracleSigner, gsdcToken, tgsTreasuryWallet, tgsTreasuryMarginWallet, maxQuoteTTL, timeLockDelay

### Requirement 20: Settlement Window and Corridor Configuration Guide

**User Story:** As a UI_Developer, I want documentation on corridor configuration and settlement windows, so that I can display corridor status and predict settlement eligibility.

#### Acceptance Criteria

1. THE Guide SHALL document that `settlementWindowStart` and `settlementWindowEnd` are UTC seconds-from-midnight (0–86399) and that wrap-around windows (e.g., start=79200 end=14400 for 22:00→04:00 UTC) are supported
2. THE Guide SHALL document the corridor config fields: active (bool), minDeliveryAmount (uint256), maxDeliveryAmount (uint256, 0=unbounded), settlementWindowStart (uint32), settlementWindowEnd (uint32), lpSourceMarginBps (uint16), tgsTreasuryMarginBps (uint16), lpDestMarginBps (uint16)
3. THE Guide SHALL document that margin bps are set via the time-locked `queueMarginUpdate` → `executeChange` flow, while corridor activation and bounds are set immediately via `configureCorridor`
4. THE Guide SHALL document the formula for determining if current time is within the window: `if (start <= end) { inWindow = sec >= start && sec <= end } else { inWindow = sec >= start || sec <= end }`

### Requirement 21: Code Flow Diagrams

**User Story:** As a UI_Developer, I want visual diagrams of the key code flows, so that I can quickly understand the interaction sequences without reading raw Solidity.

#### Acceptance Criteria

1. THE Guide SHALL include a Mermaid sequence diagram for the happy-path settlement flow showing the following participants and message sequence: UI → Orchestrator → FloatManagerFacet.reserveFloat → Oracle → QuoteVerifierFacet.verifyAndDecodeQuote → LP_Source signs EIP-3009 → SettlementExecutorFacet.executeSettlement → 4-leg transfer fan-out (delivery to lpDest, lpSource margin wallet, TGS treasury margin wallet, lpDest margin wallet), and the diagram SHALL render without syntax errors when processed by a Mermaid v10+ renderer
2. THE Guide SHALL include a Mermaid flowchart showing the internal check order within `executeSettlement`: orchestrator enforcement → pause check → duplicate check → corridor active → min/max → window → partner auth (lpSource and lpDest) → quote verify → EIP-3009 redeem → transfers (4 legs) → float release → status set to SETTLED → emit SettlementExecuted event, and each node label SHALL use the function or variable name from `SettlementExecutorFacet.sol`
3. THE Guide SHALL include a Mermaid sequence diagram for the admin governance flow showing: Admin → TimeLockControllerFacet.queueMarginUpdate → ChangeQueued event emitted → time passes (timeLockDelay seconds, default 48 h production / 60 s test) → Admin → TimeLockControllerFacet.executeChange → corridor margin BPS values updated → ChangeExecuted event emitted, and SHALL show an alternative branch where `executeChange` is called before the delay elapses resulting in a `ChangeNotReady` revert
4. THE Guide SHALL include a Mermaid state diagram showing settlement states with their numeric status values: PENDING(0) as the default/initial state → EXECUTING(1) as a transient intra-transaction state → SETTLED(2) as the terminal success state, with FAILED(3) shown as an unreachable terminal state annotated as removed during CertiK audit (recoverFailedSettlement function removed), and the diagram SHALL indicate that the PENDING → EXECUTING → SETTLED transition occurs atomically within a single transaction
5. THE Guide SHALL ensure all four Mermaid diagrams use participant and node names consistent with the Glossary terms and Solidity contract/function names defined in this specification (e.g., SettlementExecutorFacet, FloatManagerFacet, QuoteVerifierFacet, TimeLockControllerFacet, LibFloat.release)

### Requirement 22: Security Considerations for UI Developers

**User Story:** As a UI_Developer, I want a security reference, so that I can avoid common integration pitfalls and build secure transaction flows.

#### Acceptance Criteria

1. THE Guide SHALL document that EIP-3009 nonces (settlementId) are single-use and cannot be reused across settlements
2. THE Guide SHALL document that the UI must never expose oracle signer private keys or EIP-3009 authorization signatures in client-side code
3. THE Guide SHALL document the ReentrancyGuard protection on `executeSettlement` and `executeSettlementAggregated`
4. THE Guide SHALL document that the two-step admin transfer prevents accidental admin lock-out (nominee must actively call `acceptAdmin`)
5. THE Guide SHALL document that `cancelAuthorization` on GSDCToken allows LP_Source to revoke an unused EIP-3009 authorization before settlement executes
6. THE Guide SHALL document that the system pause (`PausableFacet.pause()`) blocks settlement execution and float reservations but does not block view functions or MarginWallet withdrawals

### Requirement 23: Integration Code Examples

**User Story:** As a UI_Developer, I want working code examples using ethers.js, so that I can copy and adapt them for my integration.

#### Acceptance Criteria

1. THE Guide SHALL include an ethers.js v6 code example showing how to call `getAvailableFloat` and display the result
2. THE Guide SHALL include an ethers.js v6 code example showing how to construct and sign an EIP-3009 authorization using `wallet.signTypedData`
3. THE Guide SHALL include an ethers.js v6 code example showing how to call `executeSettlement` with all required parameters
4. THE Guide SHALL include an ethers.js v6 code example showing how to listen for the `SettlementExecuted` event and parse its fields
5. THE Guide SHALL include an ethers.js v6 code example showing how to decode a custom error revert reason from a failed transaction

### Requirement 24: GSDCToken Reference

**User Story:** As a UI_Developer, I want documentation on the GSDC token contract interface, so that I can build token balance displays and understand the authorization model.

#### Acceptance Criteria

1. THE Guide SHALL document that GSDCToken is a standard ERC-20 (name="GSDC", symbol="GSDC") with EIP-3009 extension and EIP-712 domain (name="GSDC", version="1")
2. THE Guide SHALL document `transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)` as the function called internally by the Diamond during settlement
3. THE Guide SHALL document `authorizationState(address authorizer, bytes32 nonce)` as a view function the UI can call to check if a specific authorization has already been consumed
4. THE Guide SHALL document `cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)` for revoking unused authorizations
5. THE Guide SHALL document that `mint` and `burn` are restricted to the token owner (the Diamond contract) and are invoked indirectly via `MintBurnAuthorityFacet`
